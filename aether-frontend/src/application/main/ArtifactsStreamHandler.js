'use strict';

/**
 * @.architecture
 * 
 * Incoming: Event 'lmc' from GuruConnection.js (artifact-type WebSocket messages: role=assistant|computer, type=code|console, format=html|python|etc) --- {artifact_types.* (code|console|html|image|video), json}
 * Processing: Classify artifact by role/type/format, generate SessionManager IDs for artifacts (nextCodeArtifactId/nextHtmlArtifactId/nextOutputArtifactId), track parent-child linkage (code → output), detect semantic HTML via heuristics, emit to EventBus and IPC, cleanup resources --- {9 jobs: JOB_DISPOSE, JOB_EMIT_EVENT, JOB_GENERATE_ARTIFACT_ID, JOB_GET_STATE, JOB_ROUTE_BY_TYPE, JOB_SEND_IPC, JOB_START, JOB_STOP, JOB_TRACK_ENTITY}
 * Outgoing: IPC 'artifacts:stream' → Artifacts Window renderer.js, EventBus ARTIFACTS.STREAM --- {artifact_types.* (code_artifact|output_artifact|html_artifact), json}
 * 
 * 
 * @module application/main/ArtifactsStreamHandler
 */

const { EventTypes } = require('../../core/events/EventTypes');
const { sessionManager, ID_TYPES } = require('../../core/session/SessionManager');

class ArtifactsStreamHandler {
  constructor(options = {}) {
    // Dependencies
    this.ipc = options.ipc || null;
    this.eventBus = options.eventBus || null;
    this.guru = options.guruConnection || null;
    
    // Configuration
    this.enableLogging = options.enableLogging !== undefined ? options.enableLogging : false;
    
    // State
    this._lmcListener = null;
    this._messageListener = null;  // Track assistant message events
    this._currentStreamingMessageId = null;  // Track current assistant message ID during streaming
    this._lastCodeArtifactId = null;  // Track last code artifact for output linking
    this._artifactRegistry = new Map();  // Track all artifacts: id → metadata
    
    // Validation
    if (!this.guru) {
      throw new Error('[ArtifactsStreamHandler] guruConnection required');
    }
    
    if (!this.eventBus) {
      throw new Error('[ArtifactsStreamHandler] eventBus required');
    }
  }

  /**
   * Initialize and start listening
   */
  start() {
    if (this._lmcListener) {
      console.warn('[ArtifactsStreamHandler] Already started');
      return;
    }

    // Listen for LMC artifact messages
    this._lmcListener = (msg) => this._handleLmcMessage(msg);
    this.guru.on('lmc', this._lmcListener);

    // Listen for assistant messages to track current streaming message ID
    this._messageListener = (msg) => this._handleAssistantMessage(msg);
    this.guru.on('message', this._messageListener);

    if (this.enableLogging) {
      console.log('[ArtifactsStreamHandler] Started listening to LMC and message events');
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
      } catch (error) {
        console.error('[ArtifactsStreamHandler] Error stopping listeners:', error);
      }

      if (this.enableLogging) {
        console.log('[ArtifactsStreamHandler] Stopped');
      }
    }
    
    // Clear state
    this._currentStreamingMessageId = null;
  }

  /**
   * Handle assistant message to track current streaming message ID
   * @private
   */
  _handleAssistantMessage(msg) {
    // Only track assistant messages
    if (msg.role !== 'assistant' || msg.type !== 'message') {
      return;
    }
    
    // Start marker - capture message ID
    if (msg.start && msg.id) {
      this._currentStreamingMessageId = msg.id;
      if (this.enableLogging) {
        console.log('[ArtifactsStreamHandler] Stream started - tracking message ID:', msg.id);
      }
    }
    
    // End marker - clear message ID
    if (msg.end) {
      if (this.enableLogging) {
        console.log('[ArtifactsStreamHandler] Stream ended - clearing message ID:', this._currentStreamingMessageId);
      }
      this._currentStreamingMessageId = null;
      this._lastCodeArtifactId = null;  // Clear code artifact tracking on stream end
    }
  }

  /**
   * Handle LMC message
   * @private
   */
  _handleLmcMessage(msg) {
    try {
      // LOG ENTRY POINT: Artifact data arriving
      console.log('[ArtifactsStreamHandler] 📥 ENTRY POINT: Artifact from backend:', {
        backend_id: msg.id,
        frontend_id: msg.frontend_id || null,
        role: msg.role,
        type: msg.type,
        format: msg.format,
        hasContent: !!msg.content
      });
      
      // Assistant code blocks
      if (msg.role === 'assistant' && msg.type === 'code') {
        this._handleAssistantCode(msg);
        return;
      }

      // Ignore non-user-targeted computer messages
      if (msg.role === 'computer' && msg.recipient && msg.recipient !== 'user') {
        return;
      }

      // Computer console output
      if (msg.role === 'computer' && msg.type === 'console') {
        this._handleComputerConsole(msg);
        return;
      }

      // Computer HTML code blocks
      if (msg.role === 'computer' && msg.type === 'code' && msg.format === 'html') {
        this._handleComputerHtml(msg);
        return;
      }

      // Media payloads (images/videos)
      this._handleMediaPayload(msg);
    } catch (error) {
      console.error('[ArtifactsStreamHandler] Error handling LMC message:', error);
    }
  }

  /**
   * Handle assistant code blocks
   * @private
   */
  _handleAssistantCode(msg) {
    const lang = msg.format || 'python';
    const messageId = this._getCurrentMessageId();
    
    // Generate SessionManager ID for artifact tracking
    const artifactId = sessionManager.nextCodeArtifactId(messageId);

    const streamData = {
      id: artifactId,  // Use SessionManager ID for traceability
      backendId: msg.id || null,  // Preserve backend ID for correlation
      kind: 'code',
      content: msg.content || '',
      start: !!msg.start,
      end: !!msg.end,
      format: lang,
      messageId,
      parentId: messageId  // Explicit parent linkage
    };
    
    // Track code artifact for output linking
    if (!msg.start) {  // Only track non-start markers (actual code)
      this._lastCodeArtifactId = artifactId;
      this._artifactRegistry.set(artifactId, {
        kind: 'code',
        messageId,
        parentId: messageId,
        timestamp: Date.now()
      });
    }

    this._sendToArtifacts(streamData);
    this._emitArtifactEvent(streamData, 'code');
  }

  /**
   * Handle computer console output
   * @private
   */
  _handleComputerConsole(msg) {
    const text = typeof msg.content === 'string' ? msg.content : '';
    
    // Detect if output should be rendered as HTML
    const forceHtml = this._shouldRenderAsHtml(text, msg.format);
    const messageId = this._getCurrentMessageId();
    
    // Determine parent artifact ID (code that generated this output)
    // In a proper flow, this should be the most recent code artifact
    const parentCodeId = this._getLastCodeArtifactId();
    
    // Generate SessionManager ID based on type
    const artifactId = (msg.format === 'html' || forceHtml) 
      ? sessionManager.nextHtmlArtifactId(parentCodeId || messageId)
      : sessionManager.nextOutputArtifactId(parentCodeId || messageId);

    const streamData = {
      id: artifactId,  // Use SessionManager ID for traceability
      backendId: msg.id || null,  // Preserve backend ID for correlation
      kind: (msg.format === 'html' || forceHtml) ? 'html' : 'output',
      content: msg.content || '',
      start: !!msg.start,
      end: !!msg.end,
      format: (msg.format === 'html' || forceHtml) ? 'html' : (msg.format || 'output'),
      messageId,
      parentId: parentCodeId || messageId  // Link to parent code or message
    };

    this._sendToArtifacts(streamData);
    this._emitArtifactEvent(streamData, 'output');
  }

  /**
   * Handle computer HTML code blocks
   * @private
   */
  _handleComputerHtml(msg) {
    const messageId = this._getCurrentMessageId();
    
    // Generate SessionManager ID for HTML artifact
    const artifactId = sessionManager.nextHtmlArtifactId(messageId);

    const streamData = {
      id: artifactId,  // Use SessionManager ID for traceability
      backendId: msg.id || null,  // Preserve backend ID for correlation
      kind: 'html',
      content: msg.content || '',
      start: !!msg.start,
      end: !!msg.end,
      format: 'html',
      messageId,
      parentId: messageId  // Explicit parent linkage
    };

    this._sendToArtifacts(streamData);
    this._emitArtifactEvent(streamData, 'html');
  }

  /**
   * Handle media payloads (images/videos)
   * @private
   */
  _handleMediaPayload(msg) {
    try {
      const payload = this._extractMediaPayload(msg);
      
      if (payload && (Array.isArray(payload.videos) || Array.isArray(payload.images))) {
        const messageId = this._getCurrentMessageId();

        const streamData = {
          id: msg.id || null,
          kind: 'output',
          content: payload,
          start: !!msg.start,
          end: !!msg.end,
          format: 'auto',
          messageId
        };

        this._sendToArtifacts(streamData);
        this._emitArtifactEvent(streamData, 'media');
      }
    } catch (error) {
      // Silent fail for media extraction
    }
  }

  /**
   * Check if content should be rendered as HTML
   * @private
   */
  _shouldRenderAsHtml(text, currentFormat) {
    if (currentFormat === 'html') return true;

    // Heuristics for semantic search HTML
    const looksSemanticHtml = text.includes('<div') && 
        (text.includes('semantic-search-header') || text.includes('tool-card'));
    
    const looksSemanticEmoji = /(🔍|🔎).*Semantic Search Results|🎯.*Best Matches|Semantic\s+Search\s+Results/i.test(text);
    
    const looksSemanticCodeFence = /```[\s\S]*?(semantic-search-header|tool-card)[\s\S]*?```/i.test(text) ||
        /```\s*html[\s\S]*?Semantic\s+Search\s+Results[\s\S]*?```/i.test(text);

    return looksSemanticHtml || looksSemanticEmoji || looksSemanticCodeFence;
  }

  /**
   * Extract media payload from message
   * @private
   */
  _extractMediaPayload(msg) {
    const text = typeof msg.content === 'string' ? String(msg.content).trim() : '';
    const rawObj = (msg && typeof msg.content === 'object') ? msg.content : null;

    // Quick heuristic
    const maybeMediaString = text && (
        text.includes('"videos"') || text.includes("'videos'") ||
        text.includes('"images"') || text.includes("'images'")
    );

    if (!maybeMediaString && !rawObj) return null;

    // Parse JSON-like content
    const parseJsonLike = (s) => {
      try { 
        return JSON.parse(s); 
      } catch (_) {
        try {
          const fixed = s
              .replace(/\bTrue\b/g, 'true')
              .replace(/\bFalse\b/g, 'false')
              .replace(/\bNone\b/g, 'null')
              .replace(/'([^']*)'\s*:/g, '"$1":')
              .replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, ': "$1"');
          return JSON.parse(fixed);
        } catch (_) { 
          return null; 
        }
      }
    };

    const classifyArray = (arr) => {
      const looksVideo = (o) => o && typeof o === 'object' && (
          o.iframe_src || 
          (o.url && /(youtube|youtu\.be|vimeo|dailymotion|\.mp4|\.webm)/i.test(String(o.url)))
      );
      const looksImage = (o) => o && typeof o === 'object' && (
          o.img_src || o.image || o.thumbnail || o.thumbnail_src ||
          (o.url && /\.(png|jpe?g|gif|webp|svg)$/i.test(String(o.url)))
      );
      
      const v = arr.filter(looksVideo).length;
      const i = arr.filter(looksImage).length;
      
      if (v || i) return v >= i ? { videos: arr } : { images: arr };
      return null;
    };

    let payload = null;

    if (rawObj) {
      payload = rawObj;
    } else if (maybeMediaString && (text.startsWith('{') || text.startsWith('['))) {
      // Strip code fence if present
      let candidate = text;
      const fence = candidate.match(/^```(?:json|js|javascript)?\n([\s\S]*?)\n```\s*$/i);
      if (fence) candidate = fence[1].trim();
      
      const parsed = parseJsonLike(candidate);
      if (parsed) {
        if (Array.isArray(parsed)) {
          payload = classifyArray(parsed) || null;
        } else {
          payload = parsed;
        }
      }
    }

    return payload;
  }

  /**
   * Send data to artifacts window via IPC
   * @private
   */
  _sendToArtifacts(streamData) {
    if (!this.ipc) return;

    try {
      // LOG EXIT POINT: Artifact leaving main → artifacts window
      console.log('[ArtifactsStreamHandler] 🚀 EXIT POINT: Sending to artifacts window:', {
        frontend_id: streamData.id,
        backend_id: streamData.backendId,
        kind: streamData.kind,
        format: streamData.format,
        parentId: streamData.parentId,
        messageId: streamData.messageId
      });
      
      this.ipc.send('artifacts:stream', streamData);
    } catch (error) {
      console.error('[ArtifactsStreamHandler] Error sending to artifacts:', error);
    }
  }

  /**
   * Emit artifact event
   * @private
   */
  _emitArtifactEvent(streamData, type) {
    if (typeof window !== 'undefined') {
      try {
        if (this.enableLogging) {
          console.log(`[ArtifactsStreamHandler] Emitting artifact-stream event (${type}):`, streamData);
        }

        window.dispatchEvent(new CustomEvent('artifact-stream', {
          detail: streamData,
          bubbles: true
        }));

        // Also emit through event bus
        this.eventBus.emit(EventTypes.ARTIFACTS.STREAM, {
          type,
          data: streamData,
          timestamp: Date.now()
        });
      } catch (error) {
        console.error('[ArtifactsStreamHandler] Error emitting event:', error);
      }
    }
  }

  /**
   * Get current streaming message ID
   * @private
   * @returns {string | null} Current assistant message ID being streamed
   */
  _getCurrentMessageId() {
    // Return the tracked streaming message ID (set when stream starts)
    // This is much more efficient than searching through session sequences
    if (this._currentStreamingMessageId) {
      return this._currentStreamingMessageId;
    }
    
    // Fallback: Try to get from active session if not tracked
    // This handles edge cases where artifacts arrive before start marker
    const activeSession = sessionManager.getActiveSession();
    if (!activeSession) {
      console.warn('[ArtifactsStreamHandler] No active session and no tracked message ID');
      return null;
    }
    
    const stats = activeSession.getStats();
    if (stats.currentSequence === 0) {
      return null;
    }
    
    // Use session's last sequence + type to construct ID
    // This assumes the last entity created is the assistant message
    const lastSeq = stats.currentSequence;
    const seqStr = String(lastSeq).padStart(6, '0');
    const candidateId = `${activeSession.chatId}_${seqStr}_AM`;
    
    // Verify it exists in metadata
    const metadata = activeSession.getMetadata(candidateId);
    if (metadata && metadata.type === ID_TYPES.ASSISTANT_MESSAGE) {
      return candidateId;
    }
    
    console.warn('[ArtifactsStreamHandler] Could not determine current message ID');
    return null;
  }
  
  /**
   * Get last code artifact ID for output linking
   * @private
   * @returns {string|null}
   */
  _getLastCodeArtifactId() {
    return this._lastCodeArtifactId;
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    return Object.freeze({
      isActive: !!this._lmcListener,
      hasIpc: !!this.ipc,
      hasGuru: !!this.guru
    });
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    this.stop();
    this.ipc = null;
    this.guru = null;
    this.eventBus = null;

    if (this.enableLogging) {
      console.log('[ArtifactsStreamHandler] Disposed');
    }
  }
}

// Export
module.exports = ArtifactsStreamHandler;

if (typeof window !== 'undefined') {
  window.ArtifactsStreamHandler = ArtifactsStreamHandler;
  console.log('📦 ArtifactsStreamHandler loaded');
}

