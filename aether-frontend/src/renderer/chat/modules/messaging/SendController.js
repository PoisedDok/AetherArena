'use strict';

/**
 * @.architecture
 *
 * Incoming: DOM '#chat-input' submit events, sessionBridge.nextUserMessageId() --- {event.dom | state.chat_session, Event | object}
 * Processing: Normalize content, validate limits, emit lifecycle telemetry, dispatch IPC send --- {4 jobs: JOB_EMIT_EVENT, JOB_SEND_IPC, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA}
 * Outgoing: IPC 'chat:send' payloads, EventBus EventTypes.CHAT.MESSAGE_SENT --- {ipc.chat_stream_event | event.custom, json | json}
 *
 * @module renderer/chat/modules/messaging/SendController
 */

const { InputValidator } = require('../../../shared/security/inputValidator');
const sessionBridge = require('../../../shared/adapters/session');
const { EventTypes } = require('../../../../core/events/EventTypes');
const { createRendererLogger } = require('../../../shared/utils/logger');

const MAX_MESSAGE_LENGTH = 8000;
const CONTENT_PREVIEW_LENGTH = 160;
const SECURITY_CONSTRAINTS = Object.freeze({
  minLength: 1,
  maxLength: MAX_MESSAGE_LENGTH,
  // ARCHITECTURAL FIX: Removed noSqlInjection and noCommandInjection
  // SQL injection prevention belongs in BACKEND with parameterized queries
  // Command injection is irrelevant for chat messages
  // Users should be able to discuss SQL, send code examples, use brackets, etc.
  noXss: true // Keep XSS check for UI safety only
});

const sendLogger = createRendererLogger('SendController');

class SendController {
  constructor(options = {}) {
    this.ipc = options.ipc || null;
    this.eventBus = options.eventBus || null;

    // State
    this.pendingRequestId = null;
    this.isSending = false;

    this.validator = new InputValidator({ maxStringLength: MAX_MESSAGE_LENGTH });
    this.log = sendLogger.child({ scope: 'instance' });
    this.metrics = {
      total: 0,
      failures: 0
    };

    // Lifecycle
    this._isDisposed = false;

    this.log.debug('constructed');
  }

  /**
   * Initialize send controller
   */
  init() {
    if (this._isDisposed) return;
    this.log.info('initialized');
  }

  /**
   * Send a message
   * @param {string} content - Message content
   * @param {Object} options - Send options
   * @param {string} [options.correlationId] - Correlation ID for tracing
   * @param {string} [options.chatId] - Chat ID for message context
   * @returns {Promise<string|null>} Request ID if successful
   */
  async send(content, options = {}) {
    if (this._isDisposed) {
      throw new Error('[SendController] Cannot send after dispose');
    }

    let normalizedContent;
    const correlationId = await this._resolveCorrelationId(options.correlationId);
    const chatId = options.chatId || null;
    const metadata = (
      options.metadata &&
      typeof options.metadata === 'object' &&
      !Array.isArray(options.metadata)
    )
      ? { ...options.metadata }
      : null;

    if (this.isSending) {
      this.log.warn('send aborted - already sending', { correlationId });
      return null;
    }

    try {
      normalizedContent = this.preflightValidate(content);
    } catch (validationError) {
      this.metrics.failures += 1;
      this._emitChatEvent(EventTypes.CHAT.MESSAGE_ERROR, {
        correlationId,
        requestId: null,
        error: validationError.message,
        timestamp: Date.now()
      });
      throw validationError;
    }

    if (!this._canUseIPC()) {
      this.metrics.failures += 1;
      const error = new Error('No IPC communication channel available');
      this.log.error('send aborted - no channel', { correlationId });
      this._emitChatEvent(EventTypes.CHAT.MESSAGE_ERROR, {
        correlationId,
        requestId: null,
        error: error.message,
        timestamp: Date.now()
      });
      throw error;
    }

    this.isSending = true;
    this.metrics.total += 1;

    // CONTRACT: Generate requestId before sending - required for handleChatSend
    const requestId = correlationId || this._generateRequestId();

    const lifecyclePayload = this._buildEventPayload({
      correlationId,
      requestId,
      channel: 'ipc',
      content: normalizedContent
    });
    this._emitChatEvent(EventTypes.CHAT.MESSAGE_SENDING, lifecyclePayload);

    try {
      await this._sendViaIPC(normalizedContent, correlationId, chatId, requestId, metadata);

      this.pendingRequestId = requestId;

      const successPayload = this._buildEventPayload({
        correlationId,
        requestId,
        channel: 'ipc',
        content: normalizedContent
      });

      this._emitChatEvent(EventTypes.CHAT.MESSAGE_SENT, successPayload);
      this.log.info('message sent', {
        correlationId,
        requestId,
        chatId: chatId ? chatId.substring(0, 8) : 'none',
        channel: successPayload.channel,
        length: normalizedContent.length
      });
      return requestId;
    } catch (error) {
      this.metrics.failures += 1;
      this.log.error('send failed', {
        correlationId,
        error: error.message
      });
      this._emitChatEvent(EventTypes.CHAT.MESSAGE_ERROR, {
        correlationId,
        requestId: this.pendingRequestId,
          error: error.message,
          timestamp: Date.now()
        });
      throw error;
    } finally {
      this.isSending = false;
    }
  }

  preflightValidate(content) {
    const normalizedContent = this._normalizeContent(content);
    this._validateContent(normalizedContent);
    return normalizedContent;
  }

  /**
   * Send via IPC (detached windows)
   * CONTRACT: requestId is REQUIRED - must be provided by caller.
   * @private
   * @param {string} content - Message content
   * @param {string} correlationId - Correlation ID
   * @param {string} chatId - Chat ID for message context
   * @param {string} requestId - Request ID (REQUIRED)
   * @param {Object|null} metadata - Optional message metadata
   * @returns {Promise<string>} Request ID
   */
  async _sendViaIPC(content, correlationId, chatId, requestId, metadata = null) {
    // CONTRACT: requestId is REQUIRED - no generation here
    if (!requestId || typeof requestId !== 'string' || requestId.trim().length === 0) {
      throw new Error('[SendController] CONTRACT VIOLATION: requestId is required for IPC send');
    }

    try {
      const payload = {
        message: content,
        requestId,
        correlationId,
        chatId
      };
      if (metadata) {
        payload.metadata = metadata;
      }

      // Use injected IPC bridge (REQUIRED)
      if (!this.ipc || typeof this.ipc.send !== 'function') {
        throw new Error('[SendController] IPC bridge is REQUIRED - no fallbacks');
      }

      this.ipc.send('chat:send', payload);

      this.log.debug('sent via ipc bridge', { requestId, correlationId, chatId: chatId ? chatId.substring(0, 8) : 'none' });
      return requestId;
    } catch (error) {
      this.log.error('ipc send failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Check if IPC is available
   * @private
   * @returns {boolean}
   */
  _canUseIPC() {
    return Boolean(this.ipc && typeof this.ipc.send === 'function');
  }

  /**
   * Generate request ID
   * @private
   * @returns {string}
   */
  _generateRequestId() {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  _normalizeContent(content) {
    if (typeof content !== 'string') {
      return '';
    }
    return content.trim();
  }

  _validateContent(content) {
    this.validator.validateString(content, SECURITY_CONSTRAINTS);
  }

  async _resolveCorrelationId(providedId) {
    if (providedId && typeof providedId === 'string') {
      return providedId;
    }

    // CRITICAL FIX: Generate a pure UUID for backend message linkage
    // Backend expects correlation_id to be a valid UUID, NOT a composite ID
    return this._generateUUID();
  }
  
  /**
   * Generate a pure UUID v4 for backend correlation
   * @private
   * @returns {string} UUID v4
   */
  _generateUUID() {
    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  _emitChatEvent(eventType, payload) {
    if (!this.eventBus) {
      return;
    }
    this.eventBus.emit(eventType, payload);
  }

  _buildEventPayload({ correlationId, requestId, channel, content }) {
    const timestamp = Date.now();
    const preview = content.length > CONTENT_PREVIEW_LENGTH
      ? `${content.slice(0, CONTENT_PREVIEW_LENGTH)}...`
      : content;

    return {
      correlationId,
      requestId,
      channel,
      content: preview,
      contentLength: content.length,
      timestamp
    };
  }
  /**
   * Get pending request ID
   * @returns {string|null}
   */
  getPendingRequestId() {
    return this.pendingRequestId;
  }

  /**
   * Clear pending request ID
   */
  clearPendingRequestId() {
    this.pendingRequestId = null;
  }

  /**
   * Check if currently sending
   * @returns {boolean}
   */
  isSendingMessage() {
    return this.isSending;
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;

    this.log.info('disposing SendController');

    this.pendingRequestId = null;
    this.isSending = false;
    this.ipc = null;
    this.eventBus = null;
    this.validator = null;

    this.log.debug('SendController disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SendController;
}

if (typeof window !== 'undefined') {
  window.SendController = SendController;
  sendLogger.child({ scope: 'global' }).debug('SendController module loaded');
}
