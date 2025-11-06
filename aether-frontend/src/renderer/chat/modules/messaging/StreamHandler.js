'use strict';

/**
 * @.architecture
 * 
 * Incoming: MessageManager.processChunk() (IPC chunk data) --- {ipc_stream_chunk, json}
 * Processing: Deduplicate chunks, detect new streams, parse <think> tags, accumulate text, update DOM, persist to PostgreSQL, link artifacts to message, generate session IDs, emit events --- {9 jobs: JOB_ACCUMULATE_TEXT, JOB_DEDUPLICATE_CHUNK, JOB_EMIT_EVENT, JOB_GENERATE_SESSION_ID, JOB_GET_STATE, JOB_SAVE_TO_DB, JOB_TRACK_ENTITY, JOB_UPDATE_DOM_ELEMENT, JOB_UPDATE_STATE}
 * Outgoing: messageView.updateMessage() → MessageView.js (DOM), messageState.saveMessage() → MessageState.js (PostgreSQL) --- {dom_types.chat_entry_element | database_types.message_record, HTMLElement | json}
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
   * @returns {boolean} Whether chunk was processed
   */
  processChunk(data) {
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
      this._resetForNewRequest(data.id);
    }

    // Process chunk text
    const processed = this._processChunkText(data.chunk);

    if (processed.visible) {
      // Append to accumulated text
      this.accumulatedText += processed.visible;

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

    // Handle stream completion
    if (data.done) {
      this._finalizeStream();
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

    let remaining = chunk;
    let currentPos = 0;

    while (currentPos < remaining.length) {
      if (this.isInThinkingTag) {
        // Inside thinking tag - look for closing tag
        const closeIdx = remaining.indexOf('</think>', currentPos);
        
        if (closeIdx !== -1) {
          // Found closing tag
          result.thinking += remaining.substring(currentPos, closeIdx);
          this.isInThinkingTag = false;
          currentPos = closeIdx + '</think>'.length;
        } else {
          // No closing tag yet - all remaining is thinking
          result.thinking += remaining.substring(currentPos);
          break;
        }
      } else {
        // Outside thinking tag - look for opening tag
        const openIdx = remaining.indexOf('<think>', currentPos);
        
        if (openIdx !== -1) {
          // Found opening tag
          result.visible += remaining.substring(currentPos, openIdx);
          this.isInThinkingTag = true;
          currentPos = openIdx + '<think>'.length;
        } else {
          // No opening tag - all remaining is visible
          result.visible += remaining.substring(currentPos);
          break;
        }
      }
    }

    return result;
  }

  /**
   * Check if chunk should be processed (deduplication)
   * @private
   * @param {Object} data - Chunk data
   * @returns {boolean}
   */
  _shouldProcessChunk(data) {
    // Generate chunk key for deduplication
    const chunkKey = `${data.id || 'unknown'}_${data.chunk.substring(0, 50)}_${data.chunk.length}`;

    // Check timing first (prevent rapid duplicates)
    const now = Date.now();
    const timeDiff = now - this._lastChunkTimestamp;
    
    // If chunk received within 10ms and we've seen it, skip silently (no warning)
    if (timeDiff < 10 && this._seenChunkKeys.has(chunkKey)) {
      return false;
    }

    // Check if already processed (outside timing window)
    if (this._seenChunkKeys.has(chunkKey)) {
      // Only log warning if duplicate is outside timing window
      if (timeDiff >= 100) {
        console.warn('[StreamHandler] Unexpected duplicate chunk detected');
      }
      return false;
    }

    // Mark as seen
    this._seenChunkKeys.add(chunkKey);
    this._lastChunkTimestamp = now;

    // Clean up old seen chunks (keep last 1000)
    if (this._seenChunkKeys.size > 1000) {
      const keysArray = Array.from(this._seenChunkKeys);
      this._seenChunkKeys = new Set(keysArray.slice(-500));
    }

    return true;
  }

  /**
   * Reset state for new request
   * @private
   * @param {string} requestId - New request ID
   */
  _resetForNewRequest(requestId) {
    // Finalize previous stream if any
    if (this.currentRequestId && this.currentMessageId) {
      this._finalizeStream();
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
   * @private
   */
  async _finalizeStream() {
    console.log('[StreamHandler] Finalizing stream...');

    if (!this.currentMessageId) {
      console.warn('[StreamHandler] Nothing to finalize - no message ID');
      return;
    }

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
    }
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

