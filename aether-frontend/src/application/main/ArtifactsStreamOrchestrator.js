'use strict';

/**
Incoming: core/communication/GuruConnection.js::on('lmc'|'message'|'trail.artifact_linked') --- {websocket.stream_chunk, json}
Processing: Orchestrate artifact stream processing via domain services, route to transport --- {3 jobs: JOB_DELEGATE_TO_MODULE, JOB_ROUTE_BY_TYPE, JOB_SEND_IPC}
Outgoing: infrastructure/artifacts/ArtifactTransport::sendToArtifacts --- {ipc.chat_stream_event, json}

ARCHITECTURAL NOTE: Thin orchestration layer. Business logic delegated to domain services.
*/

const { ArtifactMessageRouter } = require('../../domain/artifacts/services/ArtifactMessageRouter');
const { TrailMetadataRegistry } = require('../../domain/artifacts/services/TrailMetadataRegistry');
const { ExecutionContextTracker } = require('../../domain/artifacts/services/ExecutionContextTracker');
const { ArtifactTransport } = require('../../infrastructure/artifacts/ArtifactTransport');
const { normalizeArtifactStreamPayload } = require('../../renderer/shared/contracts/artifactStream');
const { createRendererLogger } = require('../../renderer/shared/utils/logger');
const _log = createRendererLogger('ArtifactsStreamOrchestrator');

/**
 * ArtifactsStreamOrchestrator
 * 
 * Thin orchestration layer for artifact streaming.
 * Wires domain services and infrastructure for clean separation of concerns.
 * 
 * ARCHITECTURE:
 * - Application layer (orchestration, minimal logic)
 * - Delegates to domain services: router, tracker, registry
 * - Uses infrastructure: transport
 * - < 300 lines (vs 1044 lines in old handler)
 * 
 * RESPONSIBILITIES:
 * - Listen to GuruConnection events
 * - Delegate routing → ArtifactMessageRouter
 * - Delegate state → ExecutionContextTracker + TrailMetadataRegistry
 * - Delegate transport → ArtifactTransport
 * - Normalize payloads via contracts
 * 
 * @module application/main/ArtifactsStreamOrchestrator
 */
class ArtifactsStreamOrchestrator {
  constructor(options = {}) {
    // Dependencies
    this.guru = options.guruConnection || null;
    this.ipc = options.ipc || null;
    
    // Configuration
    this.enableLogging = options.enableLogging !== undefined ? options.enableLogging : false;
    
    // Validation
    if (!this.guru) {
      throw new Error('[ArtifactsStreamOrchestrator] guruConnection required');
    }
    
    if (!this.ipc) {
      throw new Error('[ArtifactsStreamOrchestrator] ipc required');
    }
    
    // Initialize domain services
    this._router = new ArtifactMessageRouter({ enableLogging: this.enableLogging });
    this._trailRegistry = new TrailMetadataRegistry({ enableLogging: this.enableLogging });
    this._contextTracker = new ExecutionContextTracker({ enableLogging: this.enableLogging });
    
    // Initialize infrastructure
    this._transport = new ArtifactTransport({ 
      ipc: this.ipc, 
      enableLogging: this.enableLogging 
    });
    
    // Buffers for chunks arriving before trail.artifact_linked
    this._pendingChunks = new Map();
    
    // Event listeners
    this._lmcListener = null;
    this._messageListener = null;
    this._trailListener = null;
  }

  /**
   * Start listening to GuruConnection events
   */
  start() {
    if (this._lmcListener) {
      throw new Error('[ArtifactsStreamOrchestrator] Already started');
    }

    // Listen for LMC artifact messages
    this._lmcListener = (msg) => this._handleLmcMessage(msg);
    this.guru.on('lmc', this._lmcListener);

    // Listen for assistant messages to track streaming context
    this._messageListener = (msg) => this._handleAssistantMessage(msg);
    this.guru.on('message', this._messageListener);

    // Listen for trail.artifact_linked events from backend
    this._trailListener = (payload) => this._handleTrailArtifactLinked(payload);
    this.guru.on('trail.artifact_linked', this._trailListener);

    if (this.enableLogging) {
      _log.debug('[ArtifactsStreamOrchestrator] Started listening to LMC, message, and trail events');
    }
  }

  /**
   * Stop listening
   */
  stop() {
    if (this.guru) {
      try {
        if (this._lmcListener) {
          this.guru.off('lmc', this._lmcListener);
          this._lmcListener = null;
        }
        if (this._messageListener) {
          this.guru.off('message', this._messageListener);
          this._messageListener = null;
        }
        if (this._trailListener) {
          this.guru.off('trail.artifact_linked', this._trailListener);
          this._trailListener = null;
        }
      } catch (error) {
        _log.error('[ArtifactsStreamOrchestrator] Error stopping listeners:', error);
      }

      if (this.enableLogging) {
        _log.debug('[ArtifactsStreamOrchestrator] Stopped');
      }
    }
    
    // Clear domain state
    this._contextTracker.clear();
    this._trailRegistry.clear();
    this._pendingChunks.clear();
  }

  /**
   * Handle trail.artifact_linked events from backend
   * Delegate to TrailMetadataRegistry
   * @private
   */
  _handleTrailArtifactLinked(payload) {
    try {
      this._trailRegistry.register(payload);
      
      // ARCHITECTURAL FIX: Flush buffered chunks for this artifact
      const artifactId = payload.artifact_id;
      if (this._pendingChunks.has(artifactId)) {
        const buffered = this._pendingChunks.get(artifactId);
        this._pendingChunks.delete(artifactId);
        
        if (this.enableLogging) {
          _log.debug(`[ArtifactsStreamOrchestrator] Flushing ${buffered.length} buffered chunks for ${artifactId.substring(0, 40)}`);
        }
        
        for (const chunk of buffered) {
          this._enrichAndSend(chunk);
        }
      }
    } catch (error) {
      _log.error('[ArtifactsStreamOrchestrator] Trail linkage registration failed:', error);
      throw error;
    }
  }

  /**
   * Handle assistant message events
   * Delegate to ExecutionContextTracker
   * @private
   */
  _handleAssistantMessage(msg) {
    // Only track assistant messages
    if (msg.role !== 'assistant' || msg.type !== 'message') {
      return;
    }

    try {
      this._contextTracker.trackMessageStart(msg);
      this._contextTracker.trackMessageEnd(msg);
    } catch (error) {
      _log.error('[ArtifactsStreamOrchestrator] Message tracking failed:', error);
      throw error;
    }
  }

  /**
   * Handle LMC message
   * Route via ArtifactMessageRouter, process based on route
   * @private
   */
  _handleLmcMessage(msg) {
    try {
      // Route message via domain router
      const { route, message, metadata } = this._router.route(msg);
      
      if (this.enableLogging) {
        _log.debug('[ArtifactsStreamOrchestrator] Routed message', { route, type: msg.type, role: msg.role });
      }
      
      // Handle based on route
      switch (route) {
        case 'assistant_code':
          this._processAssistantCode(message);
          break;
        case 'computer_output':
          this._processComputerOutput(message, metadata);
          break;
        case 'media':
          this._processMediaPayload(message, metadata);
          break;
        case 'filtered':
          // Silently skip filtered messages
          break;
        case 'unknown':
          if (this.enableLogging) {
            _log.debug('[ArtifactsStreamOrchestrator] Unknown message type', { 
              role: msg.role, 
              type: msg.type 
            });
          }
          break;
        default:
          _log.warn('[ArtifactsStreamOrchestrator] Unhandled route:', route);
      }
    } catch (error) {
      _log.error('[ArtifactsStreamOrchestrator] Error handling LMC message:', error);
      throw error;
    }
  }

  /**
   * Process assistant code block
   * @private
   */
  _processAssistantCode(msg) {
    // Skip start markers without artifact_id (trail linkage arrives after)
    if (msg.start && !msg.end && !msg.artifact_id) {
      if (this.enableLogging) {
        _log.debug('[ArtifactsStreamOrchestrator] Skipping code start marker');
      }
      return;
    }
    
    // Resolve context from tracker
    const chatId = this._resolveChatId(msg);
    const messageId = this._resolveMessageId(msg);
    
    // Extract fields with contract enforcement
    const backendId = this._resolveBackendId(msg);
    const artifactId = this._resolveArtifactId(msg);
    const format = this._resolveFormat(msg);
    const executionGroup = this._resolveExecutionGroup(msg);
    const timestamp = this._resolveTimestamp(msg);
    const content = typeof msg.content === 'string' ? msg.content : '';
    
    // Create normalized payload
    const normalized = this._createNormalizedPayload({
      artifact_id: artifactId,
      request_id: backendId,
      role: 'assistant',
      type: 'code',
      format,
      language: msg.language || format,
      content,
      chat_id: chatId,
      message_id: messageId,
      parent_id: messageId,
      correlation_id: msg.correlation_id || null,
      execution_group: executionGroup,
      start: Boolean(msg.start),
      end: Boolean(msg.end),
      timestamp,
      metadata: {
        ...(msg.metadata || {}),
        source: 'assistant-code'
      }
    });
    
    // Track code artifact for output linking
    if (!normalized.start) {
      this._contextTracker.trackCodeArtifact(normalized);
    }
    
    // Record in tracker
    this._contextTracker.recordArtifact(normalized, { kind: 'code' });
    
    // Enrich with trail metadata and send
    this._enrichAndSend(normalized);
  }

  /**
   * Process computer output
   * @private
   */
  _processComputerOutput(msg, metadata) {
    // Skip start markers without artifact_id
    if (msg.start && !msg.end && !msg.artifact_id) {
      if (this.enableLogging) {
        _log.debug('[ArtifactsStreamOrchestrator] Skipping output start marker');
      }
      return;
    }
    
    // Resolve context
    const chatId = this._resolveChatId(msg);
    const messageId = this._resolveMessageId(msg);
    const parentCodeId = this._contextTracker.getLastCodeArtifactId();
    
    // Extract fields
    const backendId = this._resolveBackendId(msg);
    const artifactId = this._resolveArtifactId(msg);
    const executionGroup = this._resolveExecutionGroup(msg);
    const timestamp = this._resolveTimestamp(msg);
    const content = typeof msg.content === 'string' ? msg.content : '';
    
    // Determine format (with HTML detection from router)
    const baseFormat = this._resolveFormat(msg);
    const format = (baseFormat === 'html' || metadata.forceHtml) ? 'html' : baseFormat;
    
    // Create normalized payload
    const normalized = this._createNormalizedPayload({
      artifact_id: artifactId,
      request_id: backendId,
      role: 'computer',
      type: 'output',
      format,
      content,
      chat_id: chatId,
      message_id: messageId,
      parent_id: parentCodeId || messageId,
      correlation_id: msg.correlation_id || null,
      execution_group: executionGroup,
      start: Boolean(msg.start),
      end: Boolean(msg.end),
      timestamp,
      metadata: {
        ...(msg.metadata || {}),
        parentArtifactId: parentCodeId || null,
        source: 'computer-output'
      }
    });
    
    // Record in tracker
    this._contextTracker.recordArtifact(normalized, { kind: 'output' });
    
    // Enrich with trail metadata and send
    this._enrichAndSend(normalized);
  }

  /**
   * Process media payload
   * @private
   */
  _processMediaPayload(msg, metadata) {
    // Skip start markers without artifact_id
    if (msg.start && !msg.end && !msg.artifact_id) {
      if (this.enableLogging) {
        _log.debug('[ArtifactsStreamOrchestrator] Skipping media start marker');
      }
      return;
    }
    
    // Resolve context
    const chatId = this._resolveChatId(msg);
    const messageId = this._resolveMessageId(msg);
    
    // Extract fields
    const backendId = this._resolveBackendId(msg);
    const artifactId = this._resolveArtifactId(msg);
    const executionGroup = this._resolveExecutionGroup(msg);
    const timestamp = this._resolveTimestamp(msg);
    
    // Create normalized payload
    const normalized = this._createNormalizedPayload({
      artifact_id: artifactId,
      request_id: backendId,
      role: 'computer',
      type: 'output',
      format: 'auto',
      content: JSON.stringify(metadata.mediaPayload),
      chat_id: chatId,
      message_id: messageId,
      parent_id: messageId,
      correlation_id: msg.correlation_id || null,
      execution_group: executionGroup,
      start: Boolean(msg.start),
      end: Boolean(msg.end),
      timestamp,
      metadata: {
        ...(msg.metadata || {}),
        source: 'computer-media'
      }
    });
    
    // Record in tracker
    this._contextTracker.recordArtifact(normalized, { kind: 'output' });
    
    // Enrich with trail metadata and send
    this._enrichAndSend(normalized);
  }

  /**
   * Enrich payload with trail metadata and send via transport
   * CONTRACT: Trail metadata OPTIONAL for assistant:code, REQUIRED for computer:console/output
   * @private
   */
  _enrichAndSend(payload) {
    // Determine if trail linkage is required based on artifact type
    const requiresTrailLinkage = (payload.role === 'computer' && (payload.type === 'console' || payload.type === 'output'));
    
    // ARCHITECTURAL FIX: Buffer chunks if trail metadata is missing
    if (requiresTrailLinkage && !this._trailRegistry.has(payload.artifact_id)) {
      if (this.enableLogging) {
        _log.warn(
          `[ArtifactsStreamOrchestrator] MISSING METADATA: artifact_id=${payload.artifact_id ? payload.artifact_id.substring(0, 40) : 'undefined'}. ` +
          `Buffering chunk pending trail.artifact_linked.`
        );
      }
      
      if (!this._pendingChunks.has(payload.artifact_id)) {
        this._pendingChunks.set(payload.artifact_id, []);
      }
      this._pendingChunks.get(payload.artifact_id).push(payload);
      return;
    }
    
    // Enrich with trail metadata from registry if available
    if (this._trailRegistry.has(payload.artifact_id)) {
      const trailMetadata = this._trailRegistry.get(payload.artifact_id);
      payload.node_id = trailMetadata.node_id;
      payload.subgroup_id = trailMetadata.subgroup_id;
    }
    
    // Send via transport
    this._transport.sendToArtifacts(payload);
  }

  /**
   * Create normalized payload via contract validator
   * @private
   */
  _createNormalizedPayload(payload) {
    return normalizeArtifactStreamPayload(payload);
  }

  // ============================================================================
  // Field Resolution Helpers (Contract Enforcement)
  // ============================================================================

  _resolveChatId(msg) {
    // CONTRACT: Backend MUST send chat_id (snake_case) - no fallbacks
    if (!msg.chat_id || typeof msg.chat_id !== 'string' || msg.chat_id.trim().length === 0) {
      throw new Error(
        `[ArtifactsStreamOrchestrator] CONTRACT VIOLATION: chat_id required. ` +
        `backendId=${msg.request_id || 'unknown'}`
      );
    }
    return msg.chat_id.trim();
  }

  _resolveMessageId(msg) {
    // CONTRACT: Backend MUST send message_id (snake_case) - no fallbacks
    if (!msg.message_id || typeof msg.message_id !== 'string' || msg.message_id.trim().length === 0) {
      throw new Error(
        `[ArtifactsStreamOrchestrator] CONTRACT VIOLATION: message_id required. ` +
        `backendId=${msg.request_id || 'unknown'}, chatId=${msg.chat_id || 'unknown'}`
      );
    }
    return msg.message_id.trim();
  }

  _resolveBackendId(msg) {
    const backendId = msg.request_id;
    if (!backendId || typeof backendId !== 'string') {
      throw new Error(`[ArtifactsStreamOrchestrator] CONTRACT VIOLATION: request_id required`);
    }
    return backendId;
  }

  _resolveArtifactId(msg) {
    const artifactId = msg.artifact_id;
    if (!artifactId || typeof artifactId !== 'string') {
      throw new Error(`[ArtifactsStreamOrchestrator] CONTRACT VIOLATION: artifact_id required`);
    }
    return artifactId;
  }

  _resolveFormat(msg) {
    const format = msg.format || msg.language;
    if (!format || typeof format !== 'string') {
      throw new Error(`[ArtifactsStreamOrchestrator] CONTRACT VIOLATION: format required`);
    }
    return format;
  }

  _resolveExecutionGroup(msg) {
    const executionGroup = msg.execution_group;
    if (!executionGroup || typeof executionGroup !== 'string') {
      throw new Error(`[ArtifactsStreamOrchestrator] CONTRACT VIOLATION: execution_group required`);
    }
    return executionGroup;
  }

  _resolveTimestamp(msg) {
    if (!msg.timestamp) {
      throw new Error(`[ArtifactsStreamOrchestrator] CONTRACT VIOLATION: timestamp required`);
    }
    return typeof msg.timestamp === 'string' 
      ? (isNaN(Date.parse(msg.timestamp)) ? Date.now() : Date.parse(msg.timestamp))
      : msg.timestamp;
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    return {
      isActive: !!this._lmcListener,
      router: { enabled: true },
      trailRegistry: this._trailRegistry.getStats(),
      contextTracker: this._contextTracker.getStats(),
      transport: this._transport.getStats()
    };
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    this.stop();
    this.guru = null;
    this.ipc = null;

    if (this.enableLogging) {
      _log.debug('[ArtifactsStreamOrchestrator] Disposed');
    }
  }
}

module.exports = ArtifactsStreamOrchestrator;
