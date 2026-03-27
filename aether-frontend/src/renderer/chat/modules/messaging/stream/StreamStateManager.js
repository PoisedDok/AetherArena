'use strict';

/**
 * @.architecture
 *
 * Incoming: Stream chunks, thinking tag state --- {chunk_text | tag_state, string|boolean}
 * Processing: Accumulate text, track thinking tags, separate visible/thinking content --- {3 jobs: JOB_ACCUMULATE_TEXT, JOB_PARSE_TAGS, JOB_SEPARATE_CONTENT}
 * Outgoing: Accumulated text, thinking text, tag state --- {stream_state, object}
 *
 * @module renderer/chat/modules/messaging/stream/StreamStateManager
 */

const { createRendererLogger } = require('../../../../shared/utils/logger');

const stateLogger = createRendererLogger('StreamStateManager');

/**
 * StreamStateManager - Stream Accumulation State
 * ===============================================
 * 
 * SINGLE RESPONSIBILITY: Manage stream text accumulation
 * 
 * RESPONSIBILITIES:
 * - Accumulate visible text
 * - Track thinking text separately
 * - Manage thinking tag state
 * - Provide state queries
 * 
 * CONTRACTS:
 * - NO DOM manipulation
 * - NO persistence
 * - Pure state management
 * 
 * @module renderer/chat/modules/messaging/stream/StreamStateManager
 */
class StreamStateManager {
  constructor(options = {}) {
    this.log = stateLogger.child({ scope: 'stream-state-manager' });

    // Stream state
    this.requestId = null;
    this.messageId = null;
    this.accumulatedText = '';
    this.thinkingText = '';
    this.isInThinkingTag = false;

    // Deduplication state
    this.lastChunkContent = '';
    this.lastChunkTimestamp = 0;

    this.log.info('StreamStateManager initialized');
  }

  /**
   * Start new stream
   * @param {string} requestId - Request ID
   * @param {string} messageId - Message ID
   */
  startStream(requestId, messageId) {
    this.requestId = requestId;
    this.messageId = messageId;
    this.accumulatedText = '';
    this.thinkingText = '';
    this.isInThinkingTag = false;
    this.lastChunkContent = '';
    this.lastChunkTimestamp = 0;

    this.log.debug('Stream started', { requestId, messageId });
  }

  /**
   * Append visible text
   * @param {string} text - Text to append
   */
  appendText(text) {
    if (!text) return;
    this.accumulatedText += text;
  }

  /**
   * Append thinking text
   * @param {string} text - Thinking text to append
   */
  appendThinking(text) {
    if (!text) return;
    this.thinkingText += text;
  }

  /**
   * Set thinking tag state
   * @param {boolean} isInTag - Whether currently in thinking tag
   */
  setThinkingTagState(isInTag) {
    this.isInThinkingTag = isInTag;
  }

  /**
   * Update deduplication state
   * @param {string} content - Last processed content
   * @param {number} timestamp - Last processed timestamp
   */
  updateDeduplicationState(content, timestamp) {
    this.lastChunkContent = content;
    this.lastChunkTimestamp = timestamp;
  }

  /**
   * Get current accumulated text
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
   * Get request ID
   * @returns {string|null}
   */
  getRequestId() {
    return this.requestId;
  }

  /**
   * Get message ID
   * @returns {string|null}
   */
  getMessageId() {
    return this.messageId;
  }

  /**
   * Check if thinking tag is open
   * @returns {boolean}
   */
  isThinkingTagOpen() {
    return this.isInThinkingTag;
  }

  /**
   * Get deduplication state
   * @returns {Object}
   */
  getDeduplicationState() {
    return {
      lastContent: this.lastChunkContent,
      lastTimestamp: this.lastChunkTimestamp
    };
  }

  /**
   * Check if currently streaming
   * @returns {boolean}
   */
  isStreaming() {
    return Boolean(this.requestId);
  }

  /**
   * Clear all state
   */
  clear() {
    this.requestId = null;
    this.messageId = null;
    this.accumulatedText = '';
    this.thinkingText = '';
    this.isInThinkingTag = false;
    this.lastChunkContent = '';
    this.lastChunkTimestamp = 0;

    this.log.trace('Stream state cleared');
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    this.clear();
    this.log.info('StreamStateManager disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StreamStateManager;
}

if (typeof window !== 'undefined') {
  window.StreamStateManager = StreamStateManager;
}
