'use strict';

const { createRendererLogger } = require('../../../shared/utils/logger');
const { shouldProcessChunk, parseStreamChunk } = require('../../../shared/messaging/streamUtils');
const { EventTypes } = require('../../../../core/events/EventTypes');

const streamLogger = createRendererLogger('StreamHandler');

/**
 * @.architecture
 * 
 * Incoming: MessageManager.processChunk IPC payloads --- {Dict, json}
 * Processing: Deduplicate assistant chunks, parse hidden tags, update DOM, delegate persistence to domain services --- {6 jobs: JOB_DEDUPLICATE_CHUNK, JOB_ACCUMULATE_TEXT, JOB_PARSE_THINK_TAGS, JOB_UPDATE_DOM_ELEMENT, JOB_DELEGATE_TO_MODULE, JOB_FINALIZE_STREAM}
 * Outgoing: MessageView updates, MessageState.saveMessage calls, EventBus 'stream:finalized' --- {Dict, json}
 * 
 * 
 * @module renderer/chat/modules/messaging/StreamHandler
 */

class StreamHandler {
  constructor(options = {}) {
    this.messageView = options.messageView || null;
    this.messageState = options.messageState || null;
    this.eventBus = options.eventBus || null;
    this.sessionAPI = options.sessionAPI || null;
    this.userMessageId = options.userMessageId || null; // Parent user message ID for linking
    this.userMessageCorrelationId = options.userMessageCorrelationId || null; // Backend correlation ID (UUID)
    this.log = streamLogger.child({ scope: 'instance' });

    // State
    this.currentRequestId = null;
    this.currentMessageId = null;
    this.accumulatedText = '';
    this.thinkingText = '';
    this.isInThinkingTag = false;
    this._thinkingParseState = { depth: 0, carry: '' };

    // Deduplication - CRITICAL: Use simple content comparison instead of hash keys
    this._lastChunkContent = '';
    this._lastChunkTimestamp = 0;

    // Tracking for artifact linking
    this.persistedMessageIds = new Map(); // requestId -> messageId
    this.reservedSequences = new Map(); // requestId -> sequence_in_chat

    // CRITICAL: Reject late chunks for finalized requests (prevents post-finalize corruption)
    this._finalizedRequestIds = new Map(); // requestId -> timestamp
    this._finalizedRequestTtlMs = 5 * 60 * 1000; // 5 minutes
    this._maxFinalizedRequests = 256;
    
    // CRITICAL: Finalization guard to prevent race conditions
    this._isFinalizingStream = false;
    this._pendingFinalization = null;

    // CRITICAL: Serialize processChunk calls (tests + real-world async reentrancy)
    // Prevents state corruption when processChunk is invoked concurrently (Promise.all / bursts).
    this._serialQueue = Promise.resolve();

    // PERFORMANCE: RAF-coalesced view updates
    // Streaming chunks arrive faster than frame rate. Instead of calling
    // messageView.updateMessage() on every chunk (triggering markdown re-parse,
    // DOMPurify sanitize, and full innerHTML rebuild each time), we schedule
    // at most one DOM update per animation frame. Multiple chunks between frames
    // are coalesced into a single render of the latest accumulated text.
    this._viewUpdateRafId = null;

    // Lifecycle
    this._isDisposed = false;
    this._eventBusCleanups = [];

    this.log.debug('StreamHandler constructed');
  }

  /**
   * Initialize stream handler
   */
  init() {
    if (this._isDisposed) return;

    // ARCHITECTURAL FIX: Listen for reserved timeline sequences from backend
    // These events anchor the assistant message in the timeline when trails exist
    if (this.eventBus) {
      const cleanup = this.eventBus.on(EventTypes.TRAIL.AGENT_MESSAGE_SEQUENCE, (payload) => {
        const { backend_id, sequence_in_chat } = payload;
        if (backend_id) {
          this.reservedSequences.set(backend_id, sequence_in_chat);
          
          // If container already exists, update it immediately
          if (backend_id === this.currentRequestId && this.currentMessageId && this.messageView) {
            const element = this.messageView.contentElement?.querySelector(`[data-message-id="${this.currentMessageId}"]`);
            if (element) {
              element.dataset.sequence = sequence_in_chat;
              this.log.info('Updated existing assistant container with reserved sequence', { 
                requestId: backend_id, 
                sequence: sequence_in_chat 
              });
            }
          }
        }
      });
      if (typeof cleanup === 'function') {
        this._eventBusCleanups.push(cleanup);
      }
    }
    
    this.log.info('StreamHandler initialized');
  }

  /**
   * Process incoming stream chunk
   * @param {Object} data - Stream chunk data
   * @param {string} data.request_id - Request ID (snake_case - backend contract)
   * @param {string} data.chunk - Text chunk
   * @param {boolean} [data.done] - Whether stream is complete
   * @param {string} [data.type] - Chunk type
   * @returns {Promise<boolean>} Whether chunk was processed
   */
  async processChunk(data) {
    return this._enqueueSerial(() => this._processChunkInternal(data));
  }

  async _processChunkInternal(data) {
    if (this._isDisposed) return false;

    if (!data || typeof data !== 'object') {
      throw new Error('[StreamHandler] CONTRACT VIOLATION: processChunk data must be a non-null object');
    }

    // CONTRACT: Backend MUST send request_id (snake_case) - backend always sends this
    // Backend NO LONGER sends 'id' field - removed for clean architecture
    if (!data.request_id || typeof data.request_id !== 'string') {
      throw new Error(`[StreamHandler] CONTRACT VIOLATION: Backend must provide request_id (snake_case). Received: ${JSON.stringify(Object.keys(data))}`);
    }
    const requestId = data.request_id;

    // CRITICAL: Reject late chunks for finalized streams (fixes post-finalize mutation)
    this._pruneFinalizedRequests();
    if (this._finalizedRequestIds.has(requestId)) {
      this.log.trace('Rejecting chunk for finalized request', { requestId, type: data.type });
      return false;
    }

    const hasChunk =
      typeof data.chunk === 'string' ? data.chunk.length > 0 : data.chunk !== null && data.chunk !== undefined;

    // Allow done=true finalization signals even when chunk is empty/missing.
    if (!hasChunk) {
      if (data.done) {
        if (requestId !== this.currentRequestId) {
          await this._resetForNewRequest(requestId);
        }
        await this._finalizeStreamAndClose(requestId);
        return true;
      }

      this.log.trace('Received non-text stream payload', {
        requestId,
        type: data.type,
        keys: Object.keys(data)
      });
      return false;
    }

    // CONTRACT: chunk must be a string for all chunk types (artifact/text).
    // Fail-fast prevents silent coercion (e.g. numbers/objects turning into strings).
    if (typeof data.chunk !== 'string') {
      throw new Error('[StreamHandler] CONTRACT VIOLATION: chunk must be a string');
    }

    // CRITICAL: Check for request ID change FIRST (before deduplication)
    // This ensures _seenChunkKeys is cleared for new requests before checking duplicates
    if (requestId !== this.currentRequestId) {
      this.log.debug('New streaming request detected', {
        previousRequestId: this.currentRequestId,
        requestId
      });
      await this._resetForNewRequest(requestId);
    }

    const dedupe = shouldProcessChunk({
      content: data.chunk,
      lastContent: this._lastChunkContent,
      lastTimestamp: this._lastChunkTimestamp,
    });

    this._lastChunkContent = dedupe.lastContent;
    this._lastChunkTimestamp = dedupe.lastTimestamp;

    if (!dedupe.process) {
      return false;
    }

    // Artifact payloads are NOT text and must be routed to the artifacts pipeline
    if (data.type === 'artifact') {
      await this._processArtifactChunk({
        requestId,
        raw: data.chunk,
        format: data.format || null,
      });
      return true;
    }

    if (data.chunk && data.chunk.length > 0) {
      this.log.trace('Raw stream chunk received', {
        length: data.chunk.length,
        preview: data.chunk.substring(0, 200)
      });
    }

    const processed = parseStreamChunk({
      chunk: data.chunk,
      state: this._thinkingParseState,
    });

    this._thinkingParseState = processed.state || { depth: 0, carry: '' };
    this.isInThinkingTag = !!processed.isInThinkingTag;

    if (processed.visible) {
      // ARCHITECTURAL FIX: Lazy container creation
      // Create message container ONLY when first visible text arrives
      // Prevents orphaned empty containers when agent immediately executes code
      if (!this.currentMessageId) {
        throw new Error('[StreamHandler] ARCHITECTURAL VIOLATION: currentMessageId must be set before processing text');
      }
      
      // Check if container exists in DOM
      const containerExists = this.messageView && 
        this.messageView.contentElement && 
        this.messageView.contentElement.querySelector(`[data-message-id="${this.currentMessageId}"]`);
      
      if (!containerExists && this.messageView) {
        // ARCHITECTURAL FIX: Use reserved sequence if available
        const reservedSeq = this.reservedSequences.get(this.currentRequestId);
        
        // Create container NOW (first visible text)
        const messageData = {
          id: this.currentMessageId,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          backend_id: this.currentRequestId // ARCHITECTURAL FIX: Pass backend_id for DOM attribute
        };
        
        // Apply reserved sequence to initial rendering
        if (reservedSeq !== undefined) {
          messageData.sequence_in_chat = reservedSeq;
        }
        
        this.messageView.renderMessage(messageData);
        
        this.log.debug('Created assistant message container (lazy - first text)', {
          messageId: this.currentMessageId,
          requestId: this.currentRequestId,
          sequence: reservedSeq
        });
      }
      
      // Append to accumulated text
      const prevLength = this.accumulatedText.length;
      this.accumulatedText += processed.visible;
      
      // Debug accumulation
      this.log.trace('Accumulated streaming text', {
        previousLength: prevLength,
        chunkLength: processed.visible.length,
        totalLength: this.accumulatedText.length,
        preview: this.accumulatedText.substring(0, 300)
      });

      // Schedule RAF-coalesced view update (prevents main thread saturation during streaming)
      this._scheduleViewUpdate();

      // Emit chunk event (required for concurrency/race tests and UI observers)
      if (this.eventBus) {
        const chatId = this.messageState?.getCurrentChatId?.() || null;
        this.eventBus.emit(EventTypes.CHAT.STREAM_CHUNK, {
          requestId: this.currentRequestId,
          chatId,
          messageId: this.currentMessageId,
          chunk: processed.visible,
          contentLength: this.accumulatedText.length,
        });
      }
    }

    if (processed.thinking) {
      // Accumulate thinking text
      this.thinkingText += processed.thinking;

      // Emit thinking event
      if (this.eventBus) {
        this.eventBus.emit('stream:thinking', {
          content: processed.thinking,
          requestId: this.currentRequestId
        });
      }
    }

    // Handle stream completion - CRITICAL: Await to prevent race conditions
    if (data.done) {
      await this._finalizeStreamAndClose(requestId);
    }

    return true;
  }

  /**
   * Reset state for new request
   * CRITICAL: Awaits previous finalization to prevent race conditions
   * @private
   * @param {string} requestId - New request ID
   */
  async _resetForNewRequest(requestId) {
    // Flush pending RAF view update for the previous request before resetting state.
    this._flushViewUpdate();

    // CRITICAL: Wait for previous stream finalization to complete
    // This prevents state corruption from overlapping finalizations
    if (this.currentRequestId && this.currentMessageId) {
      const previousRequestId = this.currentRequestId;
      this.log.trace('Awaiting previous stream finalization before resetting state');
      await this._finalizeStream();
      this._markRequestFinalized(previousRequestId);
    }

    // Reset state
    this.currentRequestId = requestId;
    this.currentMessageId = await this._generateMessageId();
    this.persistedMessageIds.set(requestId, this.currentMessageId);
    this.accumulatedText = '';
    this.thinkingText = '';
    this.isInThinkingTag = false;
    this._thinkingParseState = { depth: 0, carry: '' };

    // Clear deduplication for new request
    this._lastChunkContent = '';
    this._lastChunkTimestamp = 0;

    // ARCHITECTURAL FIX: DO NOT create message container immediately
    // Only create when first visible text arrives (lazy creation)
    // Prevents orphaned empty containers when agent immediately executes code
    // Container will be created in processChunk when processed.visible exists

    // Hide typing indicator — stream has started, agent is now producing output
    if (this.messageView) {
      this.messageView.hideTypingIndicator();
    }

    // Notify observers that a new stream started (required by multiple UI modules)
    if (this.eventBus) {
      const chatId = this.messageState?.getCurrentChatId?.() || null;
      this.eventBus.emit(EventTypes.CHAT.STREAM_STARTED, {
        requestId,
        chatId,
        messageId: this.currentMessageId,
        parentMessageId: this.userMessageId || null,
      });
    }

    this.log.debug('Reset stream handler for new request (lazy container creation)', {
      requestId,
      messageId: this.currentMessageId,
      userMessageId: this.userMessageId
    });
  }

  /**
   * Finalize stream and persist message
   * CRITICAL: Guards against concurrent finalization calls
   * @private
   */
  async _finalizeStream() {
    // CRITICAL: Prevent concurrent finalization
    if (this._isFinalizingStream) {
      this.log.trace('Finalization already in progress, waiting for completion');
      if (this._pendingFinalization) {
        await this._pendingFinalization;
      }
      return;
    }

    this.log.debug('Finalizing stream');

    if (!this.currentMessageId) {
      this.log.warn('Nothing to finalize - missing message ID');
      return;
    }

    // Set finalization guard — must stay true until the outer await resolves.
    // BUG FIX: Previously, _isFinalizingStream and _pendingFinalization were cleared
    // inside the IIFE's finally block. Because the IIFE body is synchronous, its
    // finally ran BEFORE the outer assignment `this._pendingFinalization = (async () => ...)()`
    // completed, making _pendingFinalization = null dead code (overwritten by the Promise)
    // and _isFinalizingStream = false too early (concurrent callers bypassed the guard).
    // Fix: clear guards in an outer try/finally AFTER the await.
    this._isFinalizingStream = true;
    this._pendingFinalization = (async () => {
      // Allow empty accumulatedText — assistant messages can be empty
      // when only artifacts are produced (still need to persist for linking)
      try {
        // ARCHITECTURAL FIX: Backend is sole persistence authority
        // Frontend only renders temporarily — messages loaded from backend on chat switch
        if (this.messageState) {
          const assistantMessage = {
            id: this.currentMessageId,
            role: 'assistant',
            content: this.accumulatedText || '',
            timestamp: Date.now(),
            correlation_id: this.userMessageCorrelationId || this.userMessageId
          };
          this.messageState.messages.push(assistantMessage);
        }

        // Emit finalization event
        if (this.eventBus) {
          this.eventBus.emit('stream:finalized', {
            messageId: this.currentMessageId,
            requestId: this.currentRequestId,
            contentLength: this.accumulatedText.length,
            thinkingLength: this.thinkingText.length
          });
        }

        this.log.info('Stream finalized', {
          messageId: this.currentMessageId,
          requestId: this.currentRequestId,
          contentLength: this.accumulatedText.length
        });
      } catch (error) {
        this.log.error('Stream finalization failed', { error });
      }
    })();

    // Wait for finalization, then clear guards — outer finally guarantees cleanup
    try {
      await this._pendingFinalization;
    } finally {
      this._isFinalizingStream = false;
      this._pendingFinalization = null;
    }
  }

  /**
   * Generate assistant message ID using SessionManager
   * @private
   * @returns {string}
   */
  async _generateMessageId() {
    if (!this.sessionAPI || typeof this.sessionAPI.nextAssistantMessageId !== 'function') {
      throw new Error('[StreamHandler] sessionAPI.nextAssistantMessageId is required');
    }
    // Generate deterministic assistant message ID linked to user message if available
    return this.sessionAPI.nextAssistantMessageId({
      parentId: this.userMessageId,
      chatId: this.messageState?.getCurrentChatId?.() || null
    });
  }

  /**
   * Get current streaming message ID
   * @returns {string|null}
   */
  getCurrentMessageId() {
    return this.currentMessageId;
  }

  /**
   * Get current request ID
   * @returns {string|null}
   */
  getCurrentRequestId() {
    return this.currentRequestId;
  }

  /**
   * Get accumulated text
   * @returns {string}
   */
  getAccumulatedText() {
    return this.accumulatedText;
  }

  /**
   * Get thinking text
   * @returns {string}
   */
  getThinkingText() {
    return this.thinkingText;
  }

  /**
   * Check if currently streaming
   * @returns {boolean}
   */
  isStreaming() {
    return !!this.currentRequestId;
  }

  /**
   * Force finalize current stream
   */
  async forceFinalize() {
    if (this._isDisposed) return;
    if (this.isStreaming()) {
      await this.finalizeStream(this.currentRequestId);
    }
  }

  /**
   * Public finalization API (used by tests and control-layer)
   * - Idempotent per requestId
   * - Rejects late chunks for finalized requests
   * @param {string} requestId
   */
  async finalizeStream(requestId) {
    if (this._isDisposed) return;
    return this._enqueueSerial(() => this._finalizeStreamAndClose(requestId));
  }

  async _finalizeStreamAndClose(requestId) {
    if (!requestId || typeof requestId !== 'string') {
      throw new Error('[StreamHandler] CONTRACT VIOLATION: finalizeStream(requestId) requires a string requestId');
    }

    this._pruneFinalizedRequests();
    if (this._finalizedRequestIds.has(requestId)) {
      return;
    }

    if (requestId !== this.currentRequestId) {
      // Nothing to finalize in this handler instance, but still mark so late chunks are rejected.
      this._markRequestFinalized(requestId);
      return;
    }

    // Flush pending RAF view update before finalization clears state.
    // Ensures DOM shows final accumulated text before stream-end events fire.
    this._flushViewUpdate();

    await this._finalizeStream();
    
    try {
      if (this.eventBus) {
        const chatId = this.messageState?.getCurrentChatId?.() || null;
        this.eventBus.emit(EventTypes.CHAT.MESSAGE_RECEIVED, {
          chatId,
          requestId,
          messageId: this.currentMessageId,
          contentLength: this.accumulatedText.length,
        });
        this.eventBus.emit(EventTypes.CHAT.STREAM_ENDED, {
          chatId,
          requestId,
          messageId: this.currentMessageId,
        });
      }
    } finally {
      // CRITICAL FIX: Guarantee state clearance even if event handlers throw
      this._markRequestFinalized(requestId);
      this._clearState();
    }
  }

  /**
   * Route artifact chunks into the artifacts pipeline.
   * @private
   */
  async _processArtifactChunk({ requestId, raw, format }) {
    let payload = raw;
    if (format === 'json' || (typeof raw === 'string' && raw.trim().startsWith('{'))) {
      try {
        payload = JSON.parse(raw);
      } catch (error) {
        this.log.error('Failed to parse artifact JSON chunk', { requestId, error });
        payload = raw;
      }
    }

    if (!this.eventBus) {
      return;
    }

    // Generic artifact stream event
    this.eventBus.emit(EventTypes.ARTIFACTS.STREAM_RECEIVED, {
      requestId,
      payload,
    });

    // Typed artifact events (best-effort)
    const type = payload && typeof payload === 'object' ? payload.type : null;
    if (type === 'code') {
      this.eventBus.emit(EventTypes.ARTIFACTS.CODE_RECEIVED, { requestId, artifact: payload });
    } else if (type === 'output') {
      this.eventBus.emit(EventTypes.ARTIFACTS.OUTPUT_RECEIVED, { requestId, artifact: payload });
    } else if (type === 'html') {
      this.eventBus.emit(EventTypes.ARTIFACTS.HTML_RECEIVED, { requestId, artifact: payload });
    } else if (type === 'media') {
      this.eventBus.emit(EventTypes.ARTIFACTS.MEDIA_RECEIVED, { requestId, artifact: payload });
    }
  }

  // ===========================================================================
  // RAF-Coalesced View Updates
  // ===========================================================================

  /**
   * Schedule a view update on the next animation frame.
   * If an update is already scheduled, this is a no-op — the RAF callback
   * will render the latest accumulatedText when it fires.
   * @private
   */
  _scheduleViewUpdate() {
    if (this._viewUpdateRafId !== null) return;
    this._viewUpdateRafId = requestAnimationFrame(() => {
      this._viewUpdateRafId = null;
      this._applyViewUpdate();
    });
  }

  /**
   * Apply the pending view update synchronously.
   * Re-queries the DOM entry to avoid stale references.
   * @private
   */
  _applyViewUpdate() {
    if (this.messageView && this.currentMessageId) {
      this.messageView.updateMessage(this.currentMessageId, this.accumulatedText);
    }
  }

  /**
   * Flush any pending RAF-scheduled view update synchronously.
   * Called before state transitions (finalization, request reset) to ensure
   * the DOM reflects the final accumulated text before state is cleared.
   * Also used by tests to force synchronous DOM updates.
   */
  _flushViewUpdate() {
    if (this._viewUpdateRafId !== null) {
      cancelAnimationFrame(this._viewUpdateRafId);
      this._viewUpdateRafId = null;
      this._applyViewUpdate();
    }
  }

  _markRequestFinalized(requestId) {
    if (!requestId || typeof requestId !== 'string') return;
    this._finalizedRequestIds.set(requestId, Date.now());
    this._pruneFinalizedRequests();
  }

  _pruneFinalizedRequests() {
    const now = Date.now();
    for (const [id, ts] of this._finalizedRequestIds.entries()) {
      if (!ts || now - ts > this._finalizedRequestTtlMs) {
        this._finalizedRequestIds.delete(id);
      }
    }
    while (this._finalizedRequestIds.size > this._maxFinalizedRequests) {
      const oldest = this._finalizedRequestIds.keys().next().value;
      if (!oldest) break;
      this._finalizedRequestIds.delete(oldest);
    }
  }

  _enqueueSerial(taskFn) {
    const run = typeof taskFn === 'function' ? taskFn : async () => taskFn;
    const next = this._serialQueue.then(run, run);
    this._serialQueue = next.catch(() => {});
    return next;
  }

  /**
   * Clear state
   * @private
   */
  _clearState() {
    // Cancel any pending RAF view update (defensive — normally flushed before this)
    if (this._viewUpdateRafId !== null) {
      cancelAnimationFrame(this._viewUpdateRafId);
      this._viewUpdateRafId = null;
    }

    this.currentRequestId = null;
    this.currentMessageId = null;
    this.accumulatedText = '';
    this.thinkingText = '';
    this.isInThinkingTag = false;
    this._thinkingParseState = { depth: 0, carry: '' };
    // CRITICAL FIX: Use correct deduplication state variable
    this._lastChunkContent = '';
    this._lastChunkTimestamp = 0;
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;

    this.log.info('Disposing StreamHandler');

    // 1. Clean EventBus subscriptions (SH-2 fix)
    for (const cleanup of this._eventBusCleanups) {
      if (typeof cleanup === 'function') cleanup();
    }
    this._eventBusCleanups = [];

    // 2. Cancel pending RAF view update (do NOT flush — view may already be disposed)
    if (this._viewUpdateRafId !== null) {
      cancelAnimationFrame(this._viewUpdateRafId);
      this._viewUpdateRafId = null;
    }

    // 3. Reset finalization guards (SH-6 fix)
    this._isFinalizingStream = false;
    this._pendingFinalization = null;

    // 4. Clear state
    this._clearState();
    this.persistedMessageIds.clear();
    this.reservedSequences.clear();
    this._finalizedRequestIds.clear();

    // 5. Null all references (SH-5 fix: sessionAPI was missing)
    this.messageView = null;
    this.messageState = null;
    this.eventBus = null;
    this.sessionAPI = null;

    this.log.debug('StreamHandler disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StreamHandler;
}

if (typeof window !== 'undefined') {
  window.StreamHandler = StreamHandler;
  streamLogger.debug('StreamHandler module loaded');
}
