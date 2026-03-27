/**
Incoming: ipc.artifacts:stream (backend-validated artifact payloads) --- {ipc.chat_stream_event, json}
Processing: Normalize backend payloads, update session cache, emit lifecycle events --- {4 jobs: JOB_EMIT_EVENT, JOB_FILTER_DATA, JOB_ROUTE_BY_TYPE, JOB_UPDATE_STATE}
Outgoing: ArtifactsController.loadArtifact(), EventTypes.ARTIFACTS.ARTIFACT_ADDED --- {state.chat_session, json}

ARCHITECTURAL NOTE: Backend owns ALL validation. Frontend normalizes structure only.
*/

'use strict';

const { EventTypes } = require('../../../../core/events/EventTypes');
const {
  normalizeArtifactStreamPayload,
  resolvePhaseKindFromPayload,
  getArtifactVariantKey,
  MAX_ARTIFACT_SIZE
} = require('../../../shared/contracts/artifactStream');

class ArtifactStreamService {
  constructor({ eventBus, logger }) {
    if (!eventBus) throw new Error('[ArtifactStreamService] EventBus required');
    this.eventBus = eventBus;
    this.log = logger || console;
    this.controller = null;
    this._logThrottle = new Map();
    this._persistedArtifacts = new Map(); // Track which artifact_ids have been persisted (key: artifact_id, value: timestamp)
  }

  setController(controller) {
    this.controller = controller;
  }

  handleStream(rawData) {
    // ═══════════════════════════════════════════════════════════════════════
    // STEP-019: ArtifactStreamService processes stream in artifacts window
    // ═══════════════════════════════════════════════════════════════════════
    const c = this.controller;
    this.log.debug('[STEP A1] ArtifactStreamService.handleStream ENTRY', { hasController: !!c });
    if (!c) {
      throw new Error('[ArtifactStreamService] CONTRACT VIOLATION: Controller not attached');
    }
    try {      
      this.log.debug('[STEP A2] Normalizing backend-validated payload');
      // ARCHITECTURAL FIX: Preserve raw type BEFORE normalization.
      // The stream contract normalizes console→output, html→output, etc.
      // We need the original type to prevent persisting intermediate artifacts
      // (e.g. computer:console) that would pollute execution groups.
      const rawType = (rawData.type || '').toLowerCase();
      const normalized = normalizeArtifactStreamPayload(rawData);
      
      // CONTRACT: normalizeArtifactStreamPayload validates chatId - no fallback allowed
      if (!normalized.chatId) {
        throw new Error(`[ArtifactStreamService] CONTRACT VIOLATION: Normalized payload missing chatId. artifact_id=${normalized.artifact_id}, requestId=${normalized.requestId}`);
      }
      
      // CONTRACT: normalizeArtifactStreamPayload already validates required fields
      this.log.debug('[STEP A3] ✅ Normalized payload', { id: normalized.id, type: normalized.type, role: normalized.role });

      // CONTRACT: requestId already validated by normalizer (throws if missing)
      const requestId = normalized.requestId;
      
      // CONTRACT: artifact_id already validated by normalizer (throws if missing)
      const artifactId = normalized.artifact_id;
      
      // CONTRACT: role already validated by normalizer (throws if missing/invalid)
      const variantKey = getArtifactVariantKey(normalized.role.toLowerCase(), normalized.type);
      
      // Initialize throttle if not exists
      if (!this._logThrottle.has(artifactId)) {
        this._logThrottle.set(artifactId, { lastLog: 0, chunkCount: 0 });
      }
      const throttle = this._logThrottle.get(artifactId);
      const phaseKind = resolvePhaseKindFromPayload(normalized);
      this.log.debug('[STEP A4] 🔑 IDs resolved', { artifactId, requestId, variantKey, backendProvided: true });

      if (normalized.start) {
        this.log.debug('[STEP A5] 🚀 START marker detected');
        this.log.debug('[ArtifactStreamService] Stream started', {
          requestId,
          artifactId,
          role: normalized.role,
          type: normalized.type,
          format: normalized.format,
          phase: phaseKind || 'n/a'
        });
        throttle.chunkCount = 0;
        throttle.lastLog = Date.now();

        // UX FIX: Eagerly switch to Output tab when computer execution starts to provide
        // immediate visual feedback, rather than waiting for the first actual output chunk
        // which might take several seconds if the kernel is booting.
        if (normalized.role === 'computer') {
          c.switchTab('output');
        }
      }

      this.eventBus.emit(EventTypes.ARTIFACTS.STREAM_RECEIVED, { data: normalized });

      // CRITICAL FIX: Skip START markers without content OR without artifactId
      // These are protocol markers, not real artifacts, and create phantom "NO_ID" entries
      if (normalized.start && !normalized.end && !normalized.content) {
        this.log.debug('[ArtifactStreamService] Skipping START marker (no content, no artifact yet)', { artifactId, type: normalized.type });
        return;
      }
      
      // FAIL FAST: Validate artifactId before cache access
      if (!artifactId || typeof artifactId !== 'string' || artifactId.trim().length === 0) {
        this.log.error('[ArtifactStreamService] Invalid artifactId - skipping', { 
          artifactId, 
          requestId,
          role: normalized.role,
          type: normalized.type 
        });
        return;
      }

      let artifact = c.artifactCache.get(artifactId);
      if (!artifact) {
        artifact = this._createArtifactRecord(normalized, requestId, artifactId, variantKey, rawType);
        c.artifactCache.set(artifactId, artifact);
        c.hasContent = true;
      } else {
        // Artifact exists in cache - update metadata if changed
        // NOTE: Artifacts are mutable (ArtifactEnricher no longer freezes them)
        // CONTRACT: Ensure required grouping/persistence fields are present (no silent fallbacks)
        if ((!artifact.executionGroup || typeof artifact.executionGroup !== 'string') && normalized.executionGroup) {
          artifact.executionGroup = normalized.executionGroup;
        }
        if ((!artifact.request_id || typeof artifact.request_id !== 'string') && requestId) {
          artifact.request_id = requestId;
        }
        if ((!artifact.filename || typeof artifact.filename !== 'string') && normalized) {
          artifact.filename = this._generateFilename(normalized);
        }
        if (normalized.chatId && artifact.chatId !== normalized.chatId) {
          artifact.chatId = normalized.chatId;
        }
        if (normalized.correlationId && artifact.correlationId !== normalized.correlationId) {
          artifact.correlationId = normalized.correlationId;
        }
        // CRITICAL: Preserve trail linkage fields when they arrive after initial chunks.
        // Backend may emit trail.artifact_linked slightly after first artifact chunks, so we must
        // update the cached record to satisfy backend persistence contract for output artifacts.
        if (!artifact.node_id && normalized.node_id) {
          artifact.node_id = normalized.node_id;
        }
        if (!artifact.subgroup_id && normalized.subgroup_id) {
          artifact.subgroup_id = normalized.subgroup_id;
        }
      }

      
      if (normalized.content) {
        // CRITICAL FIX: Do NOT accumulate role:"computer" code chunks
        // These are execution echoes from open-interpreter that duplicate the assistant's code
        // Only accumulate if roles match OR if this is the first content
        const isComputerCodeEcho = normalized.role === 'computer' && normalized.type === 'code' && artifact.role === 'assistant';
        
        
        if (isComputerCodeEcho) {
          this.log.debug('Skipping role:computer code echo to prevent duplication', { artifactId: artifactId.substring(0, 40) });
          // DO NOT accumulate, DO NOT increment chunk count, DO NOT render
          return;
        }
        
        artifact.content += normalized.content;
        artifact.chunkCount += 1;
        throttle.chunkCount += 1;
        
        // Update cache after mutation (cache returns mutable objects, safe to mutate directly)
        c.artifactCache.set(artifactId, artifact);

        const now = Date.now();
        if (now - throttle.lastLog > 1000) {
          this.log.trace('[ArtifactStreamService] Streaming progress', {
            artifactId,
            chunks: artifact.chunkCount,
            characters: artifact.content.length
          });
          throttle.lastLog = now;
        }

        // Handle assistant code streaming (write phase)
        if (artifact.role === 'assistant' && artifact.type === 'code') {
          
          if (artifact.chunkCount === 1) {
            // First chunk: switch tab and load artifact structure
            c.switchTab('code');
            c.loadArtifact(artifact, {
              autoSwitch: false,  // Tab already switched above
              forceAutoSwitch: false,
              origin: 'stream-start'
            });
          } else {
            // Subsequent chunks: update code viewer in place (no re-load)
            if (c.modules.codeViewer) {
              // CONTRACT: Language or format must be provided - no fallback
              const language = artifact.language || artifact.format;
              if (!language) {
                throw new Error(`[ArtifactStreamService] CONTRACT VIOLATION: Artifact missing language and format. artifactId=${artifactId}`);
              }
              
              c.modules.codeViewer.loadCode(
                artifact.content,
                language,
                artifact.filename,
                artifactId  // CRITICAL: Pass artifactId for deduplication
              );
            }
          }
        }
        // Handle computer execution output streaming (execute/output phase)
        // CRITICAL: Skip assistant-only messages (internal notifications) from UI display
        else if (artifact.role === 'computer' && ['console', 'output', 'html'].includes(artifact.type)) {
          // Filter out assistant-only notifications (e.g., "✅ HTML rendered successfully")
          // These are internal messages (recipient: "assistant") meant for agent context, not user display
          const isAssistantOnlyNotification = normalized.recipient === 'assistant';
          
          if (!isAssistantOnlyNotification) {
            // HTML RENDER-THROUGH: When _HTMLPassthrough sends "[HTML executed successfully]",
            // the actual HTML source lives in the code artifact (same executionGroup).
            // Render the HTML page in the Output tab instead of the status text.
            // Backend intentionally does NOT echo HTML to avoid LLM infinite correction loops,
            // so the frontend resolves the code artifact and renders it here.
            const htmlCodeContent = this._resolveHtmlRenderContent(c, artifact);
            
            if (htmlCodeContent) {
              // Render HTML directly into output viewer.
              // Bypass loadArtifact to preserve the original status message in cache
              // (needed for persistence and session history — the DB stores the status,
              // not the duplicated HTML source which already exists as the code artifact).
              c.switchTab('output');
              c.hasContent = true;
              c.currentArtifact = artifact;
              if (c.modules.outputViewer) {
                c.modules.outputViewer.loadOutput(htmlCodeContent, 'html', artifactId);
              }
            } else if (artifact.chunkCount === 1) {
              // First chunk - switch to output tab and load artifact (non-HTML output)
              c.switchTab('output');
              c.loadArtifact(artifact, {
                autoSwitch: false,  // Tab already switched above
                forceAutoSwitch: false,
                forceOutput: true,
                origin: 'stream-execution'
              });
              
            } else {
              // Subsequent chunks - update output viewer directly
              if (c.modules.outputViewer) {
                
                c.modules.outputViewer.loadOutput(
                  artifact.content,
                  artifact.format,
                  artifactId  // CRITICAL: Pass artifactId for deduplication
                );
              }
            }
          } else {
            this.log.debug('[ArtifactStreamService] Skipping assistant-only notification from UI', {
              artifactId,
              type: artifact.type,
              format: artifact.format,
              recipient: normalized.recipient
            });
          }
        }
      }

      this._trackBackendIndex(c, artifact, variantKey);
      this._logThrottle.set(artifactId, throttle);

      if (normalized.end) {
        this.log.debug('[ArtifactStreamService] Stream complete', {
          artifactId,
          chunks: artifact.chunkCount,
          characters: artifact.content.length,
          role: artifact.role,
          type: artifact.type,
          variantKey
        });
        this._logThrottle.delete(artifactId);

        // DO NOT reload artifacts here - they were already loaded on first chunk
        // This prevents duplication in code tab and unnecessary re-renders
        
        // Mark artifact as finalized
        artifact.finalized = true;
        artifact.end = true;

        if (c.sessionStore) {
          c.sessionStore.addArtifact({ ...artifact });
        }

        // ARCHITECTURAL FIX: Determine if artifact is user-visible (code + output only).
        // Backend sends: assistant:code → computer:console → computer:output
        // The stream contract normalizes console→output, so we use rawType to distinguish.
        // Only assistant:code and computer:output (NOT console) are user-visible.
        const isConsoleArtifact = artifact.rawType === 'console';
        const shouldNotifyFiles = !isConsoleArtifact && (
          (artifact.role === 'assistant' && artifact.type === 'code') ||
          (artifact.role === 'computer' && artifact.type === 'output')
        );

        if (shouldNotifyFiles) {
          this.eventBus.emit(EventTypes.ARTIFACTS.ARTIFACT_FINALIZED, {
            artifact,
            chatId: artifact.chatId,
            variantKey
          });
        }

        // ARCHITECTURAL FIX: Only persist user-visible artifacts (code + output).
        // Console artifacts are intermediate execution logs; persisting them causes
        // execution groups to have 3+ files instead of the expected 2 (code + output).
        const persistKey = artifact.id;
        if (shouldNotifyFiles && !this._persistedArtifacts.has(persistKey)) {
          this._persistedArtifacts.set(persistKey, Date.now());
          this._persistArtifact(c, artifact).catch(error => {
            this.log.error('[ArtifactStreamService] Persistence failed', { artifactId, error });
            this._persistedArtifacts.delete(persistKey); // Allow retry on failure
          });
        } else if (isConsoleArtifact) {
          this.log.debug('[ArtifactStreamService] Skipping console artifact persistence', {
            artifactId,
            rawType: artifact.rawType,
            executionGroup: artifact.executionGroup
          });
        }
      }
    } catch (error) {
      this.log.error('[ArtifactStreamService] Stream pipeline error', { error });
      throw error; // Fail fast - propagate errors
    }
  }

  _createArtifactRecord(normalized, requestId, artifactId, variantKey, rawType = null) {
    // CONTRACT: Backend MUST provide executionGroup for artifact grouping
    if (!normalized.executionGroup || typeof normalized.executionGroup !== 'string') {
      throw new Error(`[ArtifactStreamService] CONTRACT VIOLATION: executionGroup is required. artifactId=${artifactId}, requestId=${requestId}`);
    }
    
    // CONTRACT: normalized.artifact_id is already validated by normalizeArtifactStreamPayload
    const canonicalArtifactId = normalized.artifact_id;
    
    // Generate filename for persistence
    const filename = this._generateFilename(normalized);
    
    // ARCHITECTURAL FIX: Preserve the raw (pre-normalization) type.
    // The stream contract normalizes console→output, html→output, etc.
    // We need the original type to decide:
    //   1. Whether to persist (console = no, output = yes)
    //   2. How to classify in the Files tab
    const originalType = rawType || normalized.type;
    
    return {
      id: canonicalArtifactId,
      request_id: requestId, // Canonical identifier
      artifactId: canonicalArtifactId,
      executionGroup: normalized.executionGroup,
      role: normalized.role,
      type: normalized.type,
      rawType: originalType, // Pre-normalization type for filtering
      format: normalized.format,
      language: normalized.language,
      content: '',
      chatId: normalized.chatId,
      messageId: normalized.messageId,
      parentId: normalized.parentId,
      correlationId: normalized.correlationId,
      timestamp: normalized.timestamp,
      chunkCount: 0,
      variantKey: variantKey,
      filename: filename,
      // CONTRACT: Trail linkage fields - require explicit values (null if not provided)
      node_id: normalized.node_id || null,
      subgroup_id: normalized.subgroup_id || null,
      metadata: {
        ...normalized.metadata,
        request_id: requestId, // Canonical identifier
        frontend_id: artifactId,
        artifact_id: canonicalArtifactId,
        variant_key: variantKey,
        raw_type: originalType // Preserve for DB round-trip filtering
      }
    };
  }

  _generateFilename(artifact) {
    // Generate filename based on artifact role and type
    const format = artifact.format || artifact.language || 'txt';
    const role = artifact.role?.toLowerCase() || 'artifact';
    const type = artifact.type?.toLowerCase() || 'output';
    
    if (role === 'assistant' && type === 'code') {
      return `code.${format}`;
    } else if (role === 'computer' && type === 'console') {
      return 'console.log';
    } else if (role === 'computer' && type === 'output') {
      return `output.${format}`;
    } else if (type === 'html') {
      return 'output.html';
    } else {
      return `${type}.${format}`;
    }
  }

  _trackBackendIndex(controller, artifact, variantKeyOverride = null) {
    // _getRequestIdFromArtifact throws on missing/invalid requestId (never returns falsy)
    const requestId = this._getRequestIdFromArtifact(artifact);
    const variantKey = variantKeyOverride || getArtifactVariantKey(this._artifactRole(artifact), artifact.type);
    
    // Use ArtifactIndexService instead of direct Map access
    controller.artifactIndexService.track(requestId, variantKey, artifact.id);
  }

  async _persistArtifact(controller, artifact) {
    if (!artifact || !artifact.chatId) {
      return;
    }
    
    // CLEAN ARCHITECTURE: Delegate to controller → domain service
    if (!controller || typeof controller.persistArtifact !== 'function') {
      this.log.warn('[ArtifactStreamService] Controller.persistArtifact not available');
      return;
    }
    
    const contentLength = typeof artifact.content === 'string' ? artifact.content.length : 0;
    if (contentLength > MAX_ARTIFACT_SIZE) {
      return null;
    }
    
    // CONTRACT: Output artifacts MUST have trail linkage before persistence.
    // Backend enforces this invariant to keep trail UX consistent and avoid orphaned outputs.
    if (artifact.type === 'output' && (!artifact.node_id || !artifact.subgroup_id)) {
      throw new Error(
        `[ArtifactStreamService] CONTRACT VIOLATION: Refusing to persist output artifact without trail linkage. ` +
        `artifactId=${artifact.id}, hasNodeId=${!!artifact.node_id}, hasSubgroupId=${!!artifact.subgroup_id}`
      );
    }
    
    // CRITICAL: Backend enforces CHECK constraint: content must be NULL or non-empty after trim
    // Empty strings violate constraint and cause 500 errors
    const sanitizedContent = typeof artifact.content === 'string' && artifact.content.trim().length > 0
      ? artifact.content
      : null;
    
    // CONTRACT: Required fields must be present
    if (!artifact.filename || typeof artifact.filename !== 'string') {
      throw new Error(`[ArtifactStreamService] CONTRACT VIOLATION: artifact.filename is required. artifactId=${artifact.id}`);
    }
    
    if (!artifact.artifactId || typeof artifact.artifactId !== 'string') {
      throw new Error(`[ArtifactStreamService] CONTRACT VIOLATION: artifact.artifactId is required. artifactId=${artifact.id}`);
    }
    
    const language = artifact.language || artifact.format;
    if (!language) {
      throw new Error(`[ArtifactStreamService] CONTRACT VIOLATION: artifact.language or format is required. artifactId=${artifact.id}`);
    }
    
    // ARCHITECTURE: Build PostgreSQL-format payload (snake_case to match backend API contract)
    // Backend expects: artifact_id, message_id, chat_id, subgroup_id, node_id, execution_group
    const payload = {
      type: artifact.type,
      filename: artifact.filename,
      content: sanitizedContent,  // Ensure content is NULL if empty to satisfy DB constraint
      language: language,
      artifact_id: artifact.artifactId,
      message_id: artifact.messageId,
      chat_id: artifact.chatId,  // STRICT: Use snake_case to match backend contract
      // CONTRACT: Trail schema linkage - require explicit values (null if not provided)
      subgroup_id: artifact.subgroup_id || null,
      node_id: artifact.node_id || null,
      // ARCHITECTURAL FIX: Send execution_group as top-level field (stored in dedicated DB column)
      execution_group: artifact.executionGroup || null,
      metadata: {
        role: artifact.role,
        request_id: artifact.request_id, // Canonical identifier
        frontend_id: artifact.id,
        artifact_id: artifact.artifactId,
        execution_group: artifact.executionGroup,
        raw_type: artifact.rawType || artifact.type, // Preserve pre-normalization type
        format: artifact.format,
        chunk_count: artifact.chunkCount,
        timestamp: artifact.timestamp,
        size_bytes: contentLength,
        truncated: artifact.metadata && typeof artifact.metadata.truncated === 'boolean' ? artifact.metadata.truncated : false
      }
    };    
    
    try {      
      // CLEAN ARCHITECTURE: Delegate to controller → domain service → repository
      // Payload is now 100% snake_case, matching backend ArtifactCreate schema
      const result = await controller.persistArtifact(payload);      
      this.log.debug('[ArtifactStreamService] Artifact persisted via controller', { artifactId: result?.id, chatId: artifact.chatId });
      return result;
    } catch (error) {
      this.log.error('[ArtifactStreamService] Backend persistence failed', { error, artifactId: artifact.id });
      throw error;
    }
  }

  /**
   * Resolve HTML content for render-through.
   *
   * When the backend's _HTMLPassthrough sends "[HTML executed successfully]"
   * as the computer output, the actual HTML source is in the corresponding
   * assistant:code:html artifact (same executionGroup).
   *
   * Returns the HTML source string for rendering, or null if:
   *   - The output content is not the HTML execution status
   *   - No matching HTML code artifact exists in the cache
   *   - The code artifact has no content
   *
   * @private
   * @param {Object} controller - ArtifactsController instance (has artifactCache)
   * @param {Object} outputArtifact - The computer output artifact being processed
   * @returns {string|null} HTML source to render, or null
   */
  _resolveHtmlRenderContent(controller, outputArtifact) {
    const content = (outputArtifact.content || '').trim();
    if (content !== '[HTML executed successfully]') {
      return null;
    }

    const executionGroup = outputArtifact.executionGroup;
    if (!executionGroup) {
      this.log.warn('[ArtifactStreamService] HTML status without executionGroup — cannot resolve code artifact', {
        artifactId: outputArtifact.id
      });
      return null;
    }

    // Search artifact cache for the HTML code artifact in the same execution group
    for (const [, cached] of controller.artifactCache) {
      if (
        cached.role === 'assistant' &&
        cached.type === 'code' &&
        (cached.format === 'html' || cached.language === 'html') &&
        cached.executionGroup === executionGroup &&
        cached.content && cached.content.trim().length > 0
      ) {
        this.log.info('[ArtifactStreamService] HTML render-through: resolved code artifact for Output tab', {
          codeArtifactId: cached.id,
          outputArtifactId: outputArtifact.id,
          executionGroup,
          htmlLength: cached.content.length
        });
        return cached.content;
      }
    }

    this.log.warn('[ArtifactStreamService] HTML status received but no matching code artifact found', {
      artifactId: outputArtifact.id,
      executionGroup
    });
    return null;
  }

  _getRequestIdFromArtifact(artifact) {
    if (!artifact) {
      throw new Error('[ArtifactStreamService] CONTRACT VIOLATION: artifact is required');
    }
    const requestId = artifact.request_id || artifact.metadata?.request_id;
    if (!requestId || typeof requestId !== 'string') {
      throw new Error(`[ArtifactStreamService] CONTRACT VIOLATION: artifact.request_id is required. artifactId=${artifact.id || artifact.artifactId || 'unknown'}`);
    }
    return requestId;
  }

  _artifactRole(artifact) {
    if (!artifact) {
      throw new Error('[ArtifactStreamService] CONTRACT VIOLATION: artifact is required');
    }
    const role = artifact.role || artifact.metadata?.role;
    if (!role || typeof role !== 'string') {
      throw new Error(`[ArtifactStreamService] CONTRACT VIOLATION: artifact.role is required. artifactId=${artifact.id || artifact.artifactId || 'unknown'}`);
    }
    return role.toLowerCase();
  }
}

module.exports = ArtifactStreamService;
