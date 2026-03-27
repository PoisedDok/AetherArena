'use strict';

/**
 * @.architecture
 * Incoming: Endpoint facade, ChatWindow, HandsfreeCoordinator, AudioManager --- {method_call, javascript_api}
 * Processing: Validate and dispatch WebSocket messages (text, image, audio), delegate event subscriptions --- {3 jobs: JOB_VALIDATE_SCHEMA, JOB_WS_SEND, JOB_EMIT_EVENT}
 * Outgoing: GuruConnection.send(), GuruConnection.streamAudio(), GuruConnection.on/off --- {websocket_message, json|binary}
 *
 * @module core/communication/api/MessagingApi
 */

const BaseApi = require('./BaseApi');

class MessagingApi extends BaseApi {
  /**
   * Send user message via WebSocket.
   * @param {string} text - Message text (REQUIRED, max 100KB)
   * @param {string} id - Frontend-generated message ID (REQUIRED)
   * @param {string} [chatId] - Chat ID for message context
   * @param {string} [correlationId] - Correlation ID for frontend-backend UUID linkage
   * @param {Object|null} [metadata] - Optional hidden message metadata
   * @returns {string} Frontend ID
   */
  sendUserMessage(text, id, chatId = null, correlationId = null, metadata = null) {
    // Validate content
    if (!text || typeof text !== 'string') {
      throw new Error('[Endpoint] Message content must be a non-empty string');
    }

    if (text.trim().length === 0) {
      throw new Error('[Endpoint] Message content cannot be empty');
    }

    // Size validation (100KB limit)
    const maxSize = 100000;
    if (text.length > maxSize) {
      throw new Error(`[Endpoint] Message exceeds maximum size of ${maxSize} characters`);
    }

    // CONTRACT: Frontend ID is REQUIRED - no fallbacks
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      throw new Error('[Endpoint] CONTRACT VIOLATION: Frontend message ID is required. Caller must provide valid SessionManager-generated ID.');
    }

    const message = {
      role: 'user',
      type: 'message',
      content: text,
      id,
      frontend_id: id,
      correlation_id: correlationId,
      chat_id: chatId,
      timestamp: Date.now()
    };
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      message.metadata = metadata;
    }

    // LOG EXIT POINT: Data leaving frontend
    this._log.debug('sending user message to backend', {
      frontend_id: id,
      correlation_id: correlationId,
      chat_id: chatId ? chatId.substring(0, 8) : 'none',
      contentLength: text.length,
      messageType: 'user_message',
      connected: this._connection?.ws?.readyState === 1, // WebSocket.OPEN = 1
      timestamp: message.timestamp
    });
    this._connection.send(message);

    return id;
  }

  /**
   * Send user message with image via WebSocket.
   * @param {string} [text=''] - Message text
   * @param {string} imageBase64 - Base64 encoded image (without data URI prefix)
   * @param {string} id - Frontend-generated message ID (REQUIRED)
   * @param {string} [chatId] - Chat ID for message context
   * @param {string} [correlationId] - Correlation ID
   * @returns {string} Frontend ID
   */
  sendUserMessageWithImage(text = '', imageBase64, id, chatId = null, correlationId = null) {
    if (!imageBase64) {
      return this.sendUserMessage(text, id, chatId, correlationId);
    }

    // Validate image
    if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
      throw new Error('[Endpoint] Image must be a non-empty base64 string');
    }

    // Size validation (10MB image limit)
    const maxImageSize = 10 * 1024 * 1024;
    if (imageBase64.length > maxImageSize) {
      throw new Error(`[Endpoint] Image exceeds maximum size of ${maxImageSize} bytes`);
    }

    // Validate text if provided
    if (text && typeof text !== 'string') {
      throw new Error('[Endpoint] Message text must be a string');
    }

    // Size validation for text (100KB limit)
    if (text && text.length > 100000) {
      throw new Error('[Endpoint] Message text exceeds maximum size of 100KB');
    }

    // CONTRACT: Frontend ID is REQUIRED - no fallbacks
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      throw new Error('[Endpoint] CONTRACT VIOLATION: Frontend message ID is required. Caller must provide valid SessionManager-generated ID.');
    }

    const message = {
      role: 'user',
      type: 'message',
      content: text,
      image: imageBase64,
      id,
      frontend_id: id,
      correlation_id: correlationId,
      chat_id: chatId,
      timestamp: Date.now()
    };

    // LOG EXIT POINT: Data with image leaving frontend
    this._log.debug('sending user message with image to backend', {
      frontend_id: id,
      correlation_id: correlationId,
      chat_id: chatId ? chatId.substring(0, 8) : 'none',
      contentLength: text.length,
      hasImage: true,
      imageSize: imageBase64.length,
      messageType: 'user_message_with_image',
      timestamp: message.timestamp
    });

    this._connection.send(message);

    return id;
  }

  /**
   * Stream audio data via WebSocket.
   * @param {ArrayBuffer} arrayBuffer - Audio data
   */
  streamAudio(arrayBuffer) {
    this._connection.streamAudio(arrayBuffer);
  }

  /**
   * Subscribe to WebSocket events.
   * @param {string} event - Event name
   * @param {Function} handler - Event handler
   */
  on(event, handler) {
    this._connection.on(event, handler);
  }

  /**
   * Unsubscribe from WebSocket events.
   * @param {string} event - Event name
   * @param {Function} handler - Event handler
   */
  off(event, handler) {
    this._connection.off(event, handler);
  }
}

module.exports = MessagingApi;
