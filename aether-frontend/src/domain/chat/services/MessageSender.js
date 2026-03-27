'use strict';

/**
 * @.architecture
 * 
 * Incoming: Application layer send requests --- {message_content, string}
 * Processing: Validate message, persist user message via repository, prepare WebSocket payload, track request lifecycle --- {5 jobs: JOB_VALIDATE_SCHEMA, JOB_SAVE_TO_DB, JOB_GENERATE_SESSION_ID, JOB_TRACK_ENTITY, JOB_UPDATE_STATE}
 * Outgoing: Persisted message model, WebSocket payload --- {Message | payload_object, object}
 * 
 * @module domain/chat/services/MessageSender
 */

const { Message } = require('../models/Message');
const { createLogger } = require('../../../core/utils/logger');

/**
 * MessageSender - Pure Domain Service for Sending Chat Messages
 * ==============================================================
 * 
 * SINGLE RESPONSIBILITY: Coordinate message sending workflow
 * 
 * ARCHITECTURE:
 * - Domain layer (NO I/O, delegates to repositories)
 * - Pure business logic for message preparation
 * - Fail-fast contract enforcement
 * 
 * CONTRACTS:
 * - message REQUIRED as non-empty string
 * - chatId REQUIRED (no fallbacks)
 * - requestId REQUIRED (correlation tracking)
 * - Repository injection REQUIRED
 * 
 * RESPONSIBILITIES:
 * - Validate message content
 * - Create user message model
 * - Persist via repository
 * - Prepare WebSocket payload
 * - Return persisted message + payload
 * 
 * NOT RESPONSIBLE FOR:
 * - WebSocket sending (application/infrastructure layer)
 * - UI updates (renderer layer)
 * - State management (application layer)
 * - Request lifecycle (application layer)
 */
class MessageSender {
  constructor(dependencies = {}) {
    this.messageRepository = dependencies.messageRepository || null;
    this.enableLogging = dependencies.enableLogging || false;
    this.logger = dependencies.logger || createLogger({ component: 'MessageSender' });
    
    // STRICT CONTRACT ENFORCEMENT
    if (!this.messageRepository) {
      throw new Error(
        '[MessageSender] CONTRACT VIOLATION: messageRepository REQUIRED. ' +
        'Provide MessageRepository instance via dependencies.'
      );
    }
  }

  // Default logger removed -- createLogger({ component }) used in constructor fallback

  /**
   * Send user message
   * 
   * CONTRACT: All parameters REQUIRED, NO fallbacks
   * 
   * @param {string} message - Message content (REQUIRED, non-empty)
   * @param {string} chatId - Chat identifier (REQUIRED)
   * @param {string} requestId - Request correlation ID (REQUIRED)
   * @param {Object} options - Optional parameters (files, metadata, etc.)
   * @returns {Promise<Object>} { persistedMessage, payload }
   * @throws {Error} If contracts violated or persistence fails
   */
  async sendMessage(message, chatId, requestId, options = {}) {
    // STRICT CONTRACT ENFORCEMENT
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      throw new Error(
        '[MessageSender] CONTRACT VIOLATION: message REQUIRED as non-empty string. ' +
        `Received: ${typeof message} "${message}"`
      );
    }

    if (!chatId || typeof chatId !== 'string') {
      throw new Error(
        '[MessageSender] CONTRACT VIOLATION: chatId REQUIRED as non-empty string. ' +
        `Received: ${typeof chatId} "${chatId}"`
      );
    }

    if (!requestId || typeof requestId !== 'string') {
      throw new Error(
        '[MessageSender] CONTRACT VIOLATION: requestId REQUIRED as non-empty string. ' +
        `Received: ${typeof requestId} "${requestId}"`
      );
    }

    try {
      this.logger.debug(`Sending message for chat ${chatId}, request ${requestId}`);

      // Create user message model
      const userMessage = Message.createUser(message, chatId);
      userMessage.correlationId = requestId;
      
      // Apply optional metadata
      if (options.metadata) {
        userMessage.metadata = { ...userMessage.metadata, ...options.metadata };
      }
      
      if (options.files && Array.isArray(options.files) && options.files.length > 0) {
        userMessage.metadata.attachments = options.files;
      }

      // Persist user message via repository
      const persistedMessage = await this.messageRepository.save(userMessage, chatId);
      
      this.logger.debug(`User message persisted: ${persistedMessage.id}`);

      // Prepare WebSocket payload (backend contract)
      const payload = this._prepareWebSocketPayload(message, requestId, options);

      return {
        persistedMessage,
        payload
      };
    } catch (error) {
      this.logger.error(`Failed to send message: ${error.message}`);
      throw new Error(`[MessageSender] Send failed: ${error.message}`);
    }
  }

  /**
   * Prepare WebSocket payload for backend
   * PRIVATE: Internal payload construction
   * 
   * @param {string} message - Message content
   * @param {string} requestId - Request ID
   * @param {Object} options - Optional parameters
   * @returns {Object} WebSocket payload
   * @private
   */
  _prepareWebSocketPayload(message, requestId, options = {}) {
    // Backend WebSocket contract
    const payload = {
      role: 'user',
      type: 'message',
      id: requestId,
      content: message
    };

    // Add files if present
    if (options.files && Array.isArray(options.files) && options.files.length > 0) {
      payload.files = options.files;
    }

    // Preserve hidden context metadata for backend persistence/hydration.
    if (options.metadata && typeof options.metadata === 'object' && !Array.isArray(options.metadata)) {
      payload.metadata = { ...options.metadata };
    }

    // Merge additional options (timeout, priority, etc.)
    // Filter out options handled explicitly above.
    const { metadata, ...backendOptions } = options;
    Object.assign(payload, backendOptions);

    return payload;
  }

  /**
   * Validate message before sending
   * Can be called independently for pre-send validation
   * 
   * @param {string} message - Message content
   * @throws {Error} If message invalid
   */
  validateMessage(message) {
    if (!message || typeof message !== 'string') {
      throw new Error(
        '[MessageSender] Invalid message: must be non-empty string'
      );
    }

    const trimmed = message.trim();
    if (trimmed.length === 0) {
      throw new Error(
        '[MessageSender] Invalid message: cannot be empty or whitespace only'
      );
    }

    // Additional validation rules can be added here
    // e.g., max length, prohibited content, etc.
  }

  /**
   * Get statistics
   * 
   * @returns {Object} Service statistics
   */
  getStats() {
    return {
      hasRepository: Boolean(this.messageRepository),
      enableLogging: this.enableLogging
    };
  }
}

module.exports = { MessageSender };
