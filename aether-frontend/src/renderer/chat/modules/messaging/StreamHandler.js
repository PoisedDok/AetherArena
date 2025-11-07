'use strict';

/**
 * @.architecture
 * 
 * Incoming: MessageManager.processChunk() (IPC chunk data) --- {stream_types.ipc_stream_chunk, json}
 * Processing: Deduplicate chunks, detect new streams, parse <think> tags, accumulate text, update DOM, persist to PostgreSQL, link artifacts to message, generate session IDs, emit events --- {14 jobs: JOB_ACCUMULATE_TEXT, JOB_DEDUPLICATE_CHUNK, JOB_DELEGATE_TO_MODULE, JOB_DETECT_NEW_STREAM, JOB_DISPOSE, JOB_EMIT_EVENT, JOB_FINALIZE_STREAM, JOB_GENERATE_SESSION_ID, JOB_GET_STATE, JOB_PARSE_THINK_TAGS, JOB_SAVE_TO_DB, JOB_TRACK_ENTITY, JOB_UPDATE_DOM_ELEMENT, JOB_UPDATE_STATE}
 * Outgoing: messageView.updateMessage() → MessageView.js (DOM), messageState.saveMessage() → MessageState.js (PostgreSQL) --- {dom_types.chat_entry_element | database_types.message_record, json}
 * 
 * 
 * @module renderer/chat/modules/messaging/StreamHandler
 */

const { sessionManager } = require('../../../../core/session/SessionManager');

class StreamHandler {
  constructor(options = {}) {
    this.messageView = options.messageView || null;
    this.messageState = options.messageState || null;
    this.eventBus = options.eventBus || null;
    this.userMessageId = options.userMessageId || null; // Parent user message ID for linking

    // State
    this.currentRequestId = null;
    this.currentMessageId = null;
    this.accumulatedText = '';
    this.thinkingText = '';
    this.isInThinkingTag = false;

    // Deduplication
    this._seenChunkKeys = new Set();
    this._lastChunkTimestamp = 0;

    // Tracking for artifact linking
    this.persistedMessageIds = new Map(); // requestId -> messageId
    
    // CRITICAL: Finalization guard to prevent race conditions
    this._isFinalizingStream = false;
    this._pendingFinalization = null;

    console.log('[StreamHandler] Constructed');
  }

  /**
   * Initialize stream handler
   */
  init() {
    console.log('[StreamHandler] Initialized');
  }

  /**
   * Process incoming stream chunk
   * @param {Object} data - Stream chunk data
   * @param {string} data.id - Request ID
   * @param {string} data.chunk - Text chunk
   * @param {boolean} [data.done] - Whether stream is complete
   * @param {string} [data.type] - Chunk type
   * @returns {Promise<boolean>} Whether chunk was processed
   */
  async processChunk(data) {
    if (!data || !data.chunk) {
      return false;
    }

    // Deduplicate chunks
    if (!this._shouldProcessChunk(data)) {
      return false;
    }

    // Check for request ID change (new response)
    if (data.id && data.id !== this.currentRequestId) {
      console.log(`[StreamHandler] New request detected: ${this.currentRequestId} → ${data.id}`);
      await this._resetForNewRequest(data.id);
    }

    // Process chunk text
    const processed = this._processChunkText(data.chunk);

    if (processed.visible) {
      // Append to accumulated text
      const prevLength = this.accumulatedText.length;
      this.accumulatedText += processed.visible;
      
      // 🐛 SUPER DEBUGGER: Log accumulation
      console.log(`[StreamHandler] 🐛 ACCUMULATING: prev=${prevLength} + new=${processed.visible.length} = total=${this.accumulatedText.length}`);
      console.log(`[StreamHandler] 🐛 ACCUMULATED TEXT: "${this.accumulatedText.substring(0, 300)}${this.accumulatedText.length > 300 ? '...' : ''}"`);

      // Update message view
      if (this.messageView && this.currentMessageId) {
        this.messageView.updateMessage(this.currentMessageId, this.accumulatedText);
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
      await this._finalizeStream();
    }

    return true;
  }

  /**
   * Process chunk text and extract visible/thinking content
   * @private
   * @param {string} chunk - Raw chunk text
   * @returns {Object} { visible, thinking }
   */
  _processChunkText(chunk) {
    const result = { visible: '', thinking: '' };

    // 🐛 SUPER DEBUGGER: Log raw chunk data
    if (chunk && chunk.length > 0) {
      console.log(`[StreamHandler] 🐛 RAW CHUNK: "${chunk.substring(0, 200)}${chunk.length > 200 ? '...' : ''}" (${chunk.length} chars)`);
    }

    let remaining = chunk;
    let currentPos = 0;

    while (currentPos < remaining.length) {
      if (this.isInThinkingTag) {
        // Inside thinking tag - look for closing tag
        const closeIdx = remaining.indexOf('</think>', currentPos);
        
        if (closeIdx !== -1) {
          // Found closing tag
          const thinkContent = remaining.substring(currentPos, closeIdx);
          result.thinking += thinkContent;
          this.isInThinkingTag = false;
          currentPos = closeIdx + '</think>'.length;
          console.log(`[StreamHandler] 🐛 THINKING END: "${thinkContent.substring(0, 100)}${thinkContent.length > 100 ? '...' : ''}"`);
        } else {
          // No closing tag yet - all remaining is thinking
          const thinkContent = remaining.substring(currentPos);
          result.thinking += thinkContent;
          console.log(`[StreamHandler] 🐛 THINKING CONTINUE: "${thinkContent.substring(0, 100)}${thinkContent.length > 100 ? '...' : ''}"`);
          break;
        }
      } else {
        // Outside thinking tag - look for opening tag
        const openIdx = remaining.indexOf('<think>', currentPos);
        
        if (openIdx !== -1) {
          // Found opening tag
          const visibleContent = remaining.substring(currentPos, openIdx);
          result.visible += visibleContent;
          this.isInThinkingTag = true;
          currentPos = openIdx + '<think>'.length;
          console.log(`[StreamHandler] 🐛 VISIBLE BEFORE THINK: "${visibleContent}"`);
          console.log(`[StreamHandler] 🐛 THINKING START`);
        } else {
          // No opening tag - all remaining is visible
          const visibleContent = remaining.substring(currentPos);
          result.visible += visibleContent;
          console.log(`[StreamHandler] 🐛 VISIBLE CONTENT: "${visibleContent}"`);
          break;
        }
      }
    }

    // 🐛 SUPER DEBUGGER: Log final result
    if (result.visible || result.thinking) {
      console.log(`[StreamHandler] 🐛 PROCESSED RESULT: visible="${result.visible.substring(0, 100)}${result.visible.length > 100 ? '...' : ''}" thinking="${result.thinking.substring(0, 50)}${result.thinking.length > 50 ? '...' : ''}"`);
    }

    return result;
  }

  /**
   * Check if chunk should be processed (deduplication)
   * OPTIMIZED: Prevents duplicate processing with minimal false positives
   * @private
   * @param {Object} data - Chunk data
   * @returns {boolean}
   */
  _shouldProcessChunk(data) {
    // Generate chunk key for deduplication using hash-like key
    // Include first 30 chars, last 20 chars, and length for better uniqueness
    const content = data.chunk || '';
    const prefix = content.substring(0, 30);
    const suffix = content.length > 50 ? content.substring(content.length - 20) : '';
    const chunkKey = `${data.id || 'unknown'}_${prefix}_${suffix}_${content.length}`;

    // Check timing first (prevent rapid duplicates within 50ms)
    const now = Date.now();
    const timeDiff = now - this._lastChunkTimestamp;
    
    // If chunk received within 50ms and we've seen the EXACT same key, skip silently
    // This handles legitimate WebSocket message duplication at network layer
    if (timeDiff < 50 && this._seenChunkKeys.has(chunkKey)) {
      return false;
    }

    // Check if already processed (outside rapid timing window)
    if (this._seenChunkKeys.has(chunkKey)) {
      // Only log warning if duplicate is far outside timing window (> 500ms)
      // This indicates a logic error, not network duplication
      if (timeDiff >= 500) {
        console.warn('[StreamHandler] Unexpected duplicate chunk detected (potential logic error)');
      }
      return false;
    }

    // Mark as seen
    this._seenChunkKeys.add(chunkKey);
    this._lastChunkTimestamp = now;

    // Clean up old seen chunks (keep last 500 for memory efficiency)
    if (this._seenChunkKeys.size > 500) {
      const keysArray = Array.from(this._seenChunkKeys);
      this._seenChunkKeys = new Set(keysArray.slice(-250));
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
    // CRITICAL: Wait for previous stream finalization to complete
    // This prevents state corruption from overlapping finalizations
    if (this.currentRequestId && this.currentMessageId) {
      console.log(`[StreamHandler] Awaiting previous stream finalization before reset...`);
      await this._finalizeStream();
    }

    // Reset state
    this.currentRequestId = requestId;
    this.currentMessageId = this._generateMessageId();
    this.accumulatedText = '';
    this.thinkingText = '';
    this.isInThinkingTag = false;

    // Clear deduplication for new request
    this._seenChunkKeys.clear();

    // Create new message in view
    if (this.messageView) {
      this.messageView.renderMessage({
        id: this.currentMessageId,
        role: 'assistant',
        content: '',
        timestamp: new Date().toISOString()
      });
    }

    console.log(`[StreamHandler] Reset for new request: ${requestId} (messageId: ${this.currentMessageId}, parent: ${this.userMessageId})`);
  }

  /**
   * Finalize stream and persist message
   * CRITICAL: Guards against concurrent finalization calls
   * @private
   */
  async _finalizeStream() {
    // CRITICAL: Prevent concurrent finalization
    if (this._isFinalizingStream) {
      console.log('[StreamHandler] Finalization already in progress, waiting...');
      if (this._pendingFinalization) {
        await this._pendingFinalization;
      }
      return;
    }

    console.log('[StreamHandler] Finalizing stream...');

    if (!this.currentMessageId) {
      console.warn('[StreamHandler] Nothing to finalize - no message ID');
      return;
    }

    // Set finalization guard and create promise for other callers to wait on
    this._isFinalizingStream = true;
    this._pendingFinalization = (async () => {
      // CRITICAL FIX: Allow empty accumulatedText
      // Assistant messages can be empty when only artifacts are produced
      // We still need to persist for artifact linking

      try {
      // Persist message to PostgreSQL
      if (this.messageState) {
        const savedMessage = await this.messageState.saveMessage({
          id: this.currentMessageId,
          role: 'assistant',
          content: this.accumulatedText || '', // Ensure string (can be empty)
          timestamp: new Date().toISOString(),
          correlation_id: this.currentRequestId
        });

        if (savedMessage && savedMessage.id !== this.currentMessageId) {
          // PostgreSQL assigned a new ID
          console.log(`[StreamHandler] Message ID updated: ${this.currentMessageId} → ${savedMessage.id}`);

          // Update view with new ID
          if (this.messageView) {
            const element = this.messageView.getMessageElement(this.currentMessageId);
            if (element) {
              element.dataset.messageId = savedMessage.id;
              this.messageView.messageElements.delete(this.currentMessageId);
              this.messageView.messageElements.set(savedMessage.id, element);
            }
          }

          // Track for artifact linking
          if (this.currentRequestId) {
            this.persistedMessageIds.set(this.currentRequestId, savedMessage.id);
          }

          // Update artifacts with correct message ID
          await this._updateArtifactMessageId(savedMessage.id);

          this.currentMessageId = savedMessage.id;
        }
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

      console.log(`[StreamHandler] Stream finalized: ${this.currentMessageId}`);
      } catch (error) {
        console.error('[StreamHandler] Finalization failed:', error);
      } finally {
        // CRITICAL: Clear finalization guard
        this._isFinalizingStream = false;
        this._pendingFinalization = null;
      }
    })();

    // Wait for finalization to complete
    await this._pendingFinalization;
  }

  /**
   * Update artifacts with persisted message ID
   * CRITICAL: Links artifacts to message after PostgreSQL persistence
   * @private
   * @param {string} messageId - PostgreSQL message UUID
   */
  async _updateArtifactMessageId(messageId) {
    if (!messageId) {
      console.warn('[StreamHandler] Cannot update artifacts - no message ID');
      return;
    }

    try {
      // Get storageAPI from global window context
      const storageAPI = (typeof window !== 'undefined' && window.storageAPI) || null;
      
      if (!storageAPI || typeof storageAPI.updateArtifactMessageId !== 'function') {
        console.warn('[StreamHandler] storageAPI.updateArtifactMessageId not available');
        return;
      }

      // Get current chat ID from MessageState
      const chatId = this.messageState?.currentChatId;
      if (!chatId) {
        console.warn('[StreamHandler] No current chat ID - artifacts may not link properly');
        return;
      }

      // Link artifacts to this message using artifact_id (request ID serves as artifact identifier)
      // Backend updates artifacts matching this artifact_id with the new message_id
      const artifactId = this.currentRequestId || messageId; // Request ID serves as artifact identifier
      console.log(`[StreamHandler] Linking artifacts: chat=${chatId.slice(0,8)}, message=${messageId.slice(0,8)}`);
      
      const result = await storageAPI.updateArtifactMessageId(artifactId, messageId, chatId);
      
      if (result && result.updated_count > 0) {
        console.log(`[StreamHandler] ✅ Linked ${result.updated_count} artifact(s) to message ${messageId.slice(0,8)}`);
      } else {
        console.log(`[StreamHandler] No artifacts to link for message ${messageId.slice(0,8)}`);
      }
    } catch (error) {
      console.error('[StreamHandler] Failed to update artifact message IDs:', error);
    }
  }

  /**
   * Generate assistant message ID using SessionManager
   * @private
   * @returns {string}
   */
  _generateMessageId() {
    // Use SessionManager for deterministic, traceable IDs
    // Link to user message if available
    return sessionManager.nextAssistantMessageId(this.userMessageId);
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
    if (this.isStreaming()) {
      await this._finalizeStream();
      this._clearState();
    }
  }

  /**
   * Clear state
   * @private
   */
  _clearState() {
    this.currentRequestId = null;
    this.currentMessageId = null;
    this.accumulatedText = '';
    this.thinkingText = '';
    this.isInThinkingTag = false;
    this._seenChunkKeys.clear();
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    console.log('[StreamHandler] Disposing...');

    this._clearState();
    this.persistedMessageIds.clear();
    this.messageView = null;
    this.messageState = null;
    this.eventBus = null;

    console.log('[StreamHandler] Disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StreamHandler;
}

if (typeof window !== 'undefined') {
  window.StreamHandler = StreamHandler;
  console.log('📦 StreamHandler loaded');
}

