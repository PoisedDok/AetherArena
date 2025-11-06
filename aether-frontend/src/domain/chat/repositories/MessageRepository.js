/**
 * @.architecture
 * 
 * Incoming: ChatService.saveMessage(), MessageManager.saveMessage() (method calls with Message models) --- {object, javascript_api}
 * Processing: Initialize storageAPI (window.storageAPI or require), transform Message models to PostgreSQL rows, call storageAPI methods (loadMessages/saveMessage/updateMessage/deleteMessage), transform PostgreSQL rows back to Message model instances via Message.fromPostgresRow(), update message properties with PostgreSQL-generated IDs --- {6 jobs: JOB_DELEGATE_TO_MODULE, JOB_GET_STATE, JOB_INITIALIZE, JOB_LOAD_FROM_DB, JOB_SAVE_TO_DB, JOB_SEND_IPC}
 * Outgoing: storageAPI.loadMessages/saveMessage/updateMessage() (IPC to main process → PostgreSQL), return Message model instances --- {database_types.message_record, json}
 * 
 * 
 * @module domain/chat/repositories/MessageRepository
 */

const { Message } = require('../models/Message');

class MessageRepository {
  constructor(dependencies = {}) {
    this.storageAPI = dependencies.storageAPI || null;
    this.logger = dependencies.logger || console;
    
    // Initialize storage API
    this._initializeStorageAPI();
  }

  /**
   * Initialize storage API (browser or Node.js environment)
   */
  _initializeStorageAPI() {
    if (this.storageAPI) {
      return; // Already provided
    }

    // Try window.storageAPI first (browser)
    if (typeof window !== 'undefined' && window.storageAPI) {
      this.storageAPI = window.storageAPI;
      return;
    }

    // Try require (Node.js/Electron)
    try {
      this.storageAPI = require('../../../infrastructure/api/storage');
    } catch (e) {
      this.logger.warn('[MessageRepository] Storage API not available:', e.message);
    }
  }

  /**
   * Ensure storage API is available
   */
  _ensureStorageAPI() {
    if (!this.storageAPI) {
      throw new Error('Storage API not available');
    }
  }

  /**
   * Load all messages for a chat
   */
  async findByChatId(chatId) {
    this._ensureStorageAPI();
    
    if (!chatId || typeof chatId !== 'string') {
      throw new Error('Chat ID must be a non-empty string');
    }

    try {
      const messages = await this.storageAPI.loadMessages(chatId);
      return messages.map(msgData => Message.fromPostgresRow(msgData));
    } catch (error) {
      this.logger.error(`[MessageRepository] Failed to load messages for chat ${chatId}:`, error);
      throw error;
    }
  }

  /**
   * Save message to chat
   */
  async save(message, chatId = null) {
    this._ensureStorageAPI();
    
    if (!(message instanceof Message)) {
      throw new Error('Must provide Message instance');
    }

    const targetChatId = chatId || message.chatId;
    
    if (!targetChatId || typeof targetChatId !== 'string') {
      throw new Error('Chat ID must be provided');
    }

    try {
      const messageData = await this.storageAPI.saveMessage(targetChatId, {
        role: message.role,
        content: message.content,
        llm_model: message.llmModel,
        llm_provider: message.llmProvider,
        tokens_used: message.tokensUsed,
        correlation_id: message.correlationId
      });
      
      // Return new message instance with PostgreSQL-generated ID
      // Maintains immutability - caller's original message is unchanged
      return message.clone({
        id: messageData.id,
        chatId: targetChatId,
        createdAt: messageData.timestamp || messageData.created_at
      });
    } catch (error) {
      this.logger.error(`[MessageRepository] Failed to save message to chat ${targetChatId}:`, error);
      throw error;
    }
  }

  /**
   * Save multiple messages in batch
   */
  async saveBatch(messages, chatId) {
    this._ensureStorageAPI();
    
    if (!Array.isArray(messages)) {
      throw new Error('Messages must be an array');
    }

    if (!chatId || typeof chatId !== 'string') {
      throw new Error('Chat ID must be a non-empty string');
    }

    try {
      // Execute all saves in parallel for performance
      const savedMessages = await Promise.all(
        messages.map(message => this.save(message, chatId))
      );
      
      return savedMessages;
    } catch (error) {
      this.logger.error(`[MessageRepository] Failed to save message batch to chat ${chatId}:`, error);
      throw error;
    }
  }

  /**
   * Find messages by role
   */
  async findByRole(chatId, role) {
    if (!role || typeof role !== 'string') {
      throw new Error('Role must be a non-empty string');
    }

    try {
      const allMessages = await this.findByChatId(chatId);
      return allMessages.filter(msg => msg.role === role);
    } catch (error) {
      this.logger.error(`[MessageRepository] Failed to find messages by role ${role}:`, error);
      throw error;
    }
  }

  /**
   * Find user messages for a chat
   */
  async findUserMessages(chatId) {
    return this.findByRole(chatId, 'user');
  }

  /**
   * Find assistant messages for a chat
   */
  async findAssistantMessages(chatId) {
    return this.findByRole(chatId, 'assistant');
  }

  /**
   * Find messages by correlation ID
   */
  async findByCorrelationId(chatId, correlationId) {
    if (!correlationId || typeof correlationId !== 'string') {
      throw new Error('Correlation ID must be a non-empty string');
    }

    try {
      const allMessages = await this.findByChatId(chatId);
      return allMessages.filter(msg => msg.correlationId === correlationId);
    } catch (error) {
      this.logger.error(`[MessageRepository] Failed to find messages by correlation ${correlationId}:`, error);
      throw error;
    }
  }

  /**
   * Find messages with artifacts
   */
  async findWithArtifacts(chatId) {
    try {
      const allMessages = await this.findByChatId(chatId);
      return allMessages.filter(msg => msg.artifactIds && msg.artifactIds.length > 0);
    } catch (error) {
      this.logger.error(`[MessageRepository] Failed to find messages with artifacts:`, error);
      throw error;
    }
  }

  /**
   * Find messages by timestamp range
   */
  async findByTimeRange(chatId, startTime, endTime) {
    if (typeof startTime !== 'number' || typeof endTime !== 'number') {
      throw new Error('Start and end times must be numbers');
    }

    if (startTime > endTime) {
      throw new Error('Start time cannot be after end time');
    }

    try {
      const allMessages = await this.findByChatId(chatId);
      return allMessages.filter(msg => 
        msg.timestamp >= startTime && msg.timestamp <= endTime
      );
    } catch (error) {
      this.logger.error(`[MessageRepository] Failed to find messages by time range:`, error);
      throw error;
    }
  }

  /**
   * Find recent messages (last N messages)
   */
  async findRecent(chatId, limit = 20) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('Limit must be a positive integer');
    }

    try {
      const allMessages = await this.findByChatId(chatId);
      return allMessages.slice(-limit);
    } catch (error) {
      this.logger.error(`[MessageRepository] Failed to find recent messages:`, error);
      throw error;
    }
  }

  /**
   * Count messages in a chat
   */
  async count(chatId) {
    try {
      const messages = await this.findByChatId(chatId);
      return messages.length;
    } catch (error) {
      this.logger.error(`[MessageRepository] Failed to count messages:`, error);
      throw error;
    }
  }

  /**
   * Count messages by role
   */
  async countByRole(chatId, role) {
    try {
      const messages = await this.findByRole(chatId, role);
      return messages.length;
    } catch (error) {
      this.logger.error(`[MessageRepository] Failed to count messages by role:`, error);
      throw error;
    }
  }

  /**
   * Get total tokens used in a chat
   */
  async getTotalTokens(chatId) {
    try {
      const messages = await this.findByChatId(chatId);
      return messages.reduce((sum, msg) => sum + (msg.tokensUsed || 0), 0);
    } catch (error) {
      this.logger.error(`[MessageRepository] Failed to get total tokens:`, error);
      throw error;
    }
  }

  /**
   * Get message statistics for a chat
   */
  async getStatistics(chatId) {
    try {
      const messages = await this.findByChatId(chatId);
      
      return {
        total: messages.length,
        user: messages.filter(m => m.isUser()).length,
        assistant: messages.filter(m => m.isAssistant()).length,
        system: messages.filter(m => m.isSystem()).length,
        totalTokens: messages.reduce((sum, m) => sum + (m.tokensUsed || 0), 0),
        withArtifacts: messages.filter(m => m.artifactIds && m.artifactIds.length > 0).length
      };
    } catch (error) {
      this.logger.error(`[MessageRepository] Failed to get statistics:`, error);
      throw error;
    }
  }
}

module.exports = { MessageRepository };

