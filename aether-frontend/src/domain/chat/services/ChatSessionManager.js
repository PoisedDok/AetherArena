'use strict';

/**
 * @.architecture
 * Domain Service - Manages chat session lifecycle (create, switch, delete, load)
 * 
 * Incoming: ChatOrchestrator.createNewChat/switchChat/deleteChat() (method calls) --- {chat_id | chat_title, string}
 * Processing: Validate chat IDs, load chat data via ChatRepository, load messages/artifacts, register with TraceabilityService, manage current session state, emit lifecycle events --- {7 jobs: JOB_VALIDATE_SCHEMA, JOB_LOAD_FROM_DB, JOB_UPDATE_STATE, JOB_EMIT_EVENT, JOB_TRACK_ENTITY, JOB_DELEGATE_TO_MODULE, JOB_SAVE_TO_DB}
 * Outgoing: ChatRepository.findById/create/delete/findAll(), MessageRepository.findByChatId(), ArtifactRepository.findByChatId(), TraceabilityService.loadForChat/registerMessage/registerArtifact(), EventBus.emit() --- {Chat | Message[] | Artifact[], domain_models}
 * 
 * CONTRACTS:
 * - chatRepository: REQUIRED (ChatRepository instance)
 * - artifactRepository: REQUIRED (ArtifactRepository instance)
 * - traceabilityService: OPTIONAL (for linking)
 * - eventBus: REQUIRED (for lifecycle events)
 * - Fail-fast on missing dependencies or invalid IDs
 * - NO fallbacks, strict validation
 * 
 * @module domain/chat/services/ChatSessionManager
 */

const { createDomainLogger } = require('../../../core/utils/logger');
const { Chat } = require('../models/Chat');

const chatSessionLogger = createDomainLogger('ChatSessionManager');

class ChatSessionManager {
  constructor(options = {}) {
    this.chatRepository = options.chatRepository;
    this.artifactRepository = options.artifactRepository;
    this.traceabilityService = options.traceabilityService; // Optional
    this.eventBus = options.eventBus;
    this.errorTracker = options.errorTracker;
    this.logger = options.logger || chatSessionLogger.child({ scope: 'instance' });
    
    // Validate required dependencies - FAIL FAST
    if (!this.chatRepository) throw new Error('[ChatSessionManager] ChatRepository is required');
    if (!this.artifactRepository) throw new Error('[ChatSessionManager] ArtifactRepository is required');
    if (!this.eventBus) throw new Error('[ChatSessionManager] EventBus is required');
    
    // Current session state
    this.currentChatId = null;
    
    this.logger.info('ChatSessionManager initialized');
  }
  
  /**
   * Create new chat
   * 
   * @param {string} title - Chat title (default: 'New Chat')
   * @returns {Promise<Object>} Created chat
   */
  async createChat(title = 'New Chat') {
    // STRICT CONTRACT VALIDATION
    if (title && typeof title !== 'string') {
      throw new Error('[ChatSessionManager] title must be a string');
    }
    
    try {
      this.logger.info(`Creating new chat: "${title}"`);
      
      // Create Chat model
      const chat = Chat.create(title);
      
      // Persist via repository
      const newChat = await this.chatRepository.create(chat);
      
      this.logger.info(`Chat created: ${newChat.id}`);
      
      // Emit creation event
      this.eventBus.emit('chat:created', { chatId: newChat.id, title: newChat.title });
      
      return newChat;
    } catch (error) {
      this.logger.error(`Failed to create chat:`, error);
      
      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'ChatSessionManager.createChat');
      }
      
      throw error;
    }
  }
  
  /**
   * Switch to different chat
   * 
   * @param {string} chatId - Chat ID (REQUIRED)
   * @returns {Promise<Object>} Chat data with messages and artifacts
   */
  async switchToChat(chatId) {
    // STRICT CONTRACT VALIDATION - NO FALLBACKS
    if (!chatId || typeof chatId !== 'string') {
      throw new Error('[ChatSessionManager] chatId is required (string)');
    }
    
    try {
      this.logger.info(`Switching to chat: ${chatId}`);
      
      // Load chat with messages
      const chat = await this.chatRepository.findById(chatId);
      if (!chat) {
        throw new Error(`Chat ${chatId} not found`);
      }
      
      // Load artifacts for this chat
      const artifacts = await this.artifactRepository.findByChatId(chatId);
      
      // Register with traceability service if available
      if (this.traceabilityService) {
        try {
          await this.traceabilityService.loadForChat(chatId);
          
          // Register all messages
          if (Array.isArray(chat.messages)) {
            chat.messages.forEach((message) => {
              this.traceabilityService.registerMessage({
                id: message.id,
                chatId,
                role: message.role,
                correlationId: message.correlationId || message.correlation_id,
                timestamp: message.timestamp || message.createdAt || message.created_at || Date.now(),
                artifactIds: message.artifactIds || message.artifact_ids || []
              });
            });
          }
          
          // Register all artifacts
          artifacts.forEach((artifact) => {
            this.traceabilityService.registerArtifact({
              id: artifact.id,
              type: artifact.type,
              format: artifact.format || artifact.language || 'text',
              sourceMessageId: artifact.sourceMessageId || artifact.messageId || artifact.message_id,
              correlationId: artifact.correlationId || artifact.correlation_id || artifact.requestId,
              chatId,
              timestamp: artifact.timestamp || artifact.createdAt || artifact.created_at || Date.now(),
              status: artifact.status || 'active'
            });
          });
        } catch (traceError) {
          this.logger.warn(`Traceability initialization failed for chat ${chatId}:`, traceError);
        }
      }
      
      // Update current session
      this.currentChatId = chatId;
      
      this.logger.info(`Switched to chat ${chatId}: ${chat.messages?.length || 0} messages, ${artifacts.length} artifacts`);
      
      // Emit switch event
      this.eventBus.emit('chat:switched', {
        chatId,
        messageCount: chat.messages?.length || 0,
        artifactCount: artifacts.length
      });
      
      return {
        chat,
        artifacts
      };
    } catch (error) {
      this.logger.error(`Failed to switch to chat ${chatId}:`, error);
      
      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'ChatSessionManager.switchToChat', { chatId });
      }
      
      throw error;
    }
  }
  
  /**
   * Delete chat
   * 
   * @param {string} chatId - Chat ID (REQUIRED)
   * @returns {Promise<void>}
   */
  async deleteChat(chatId) {
    // STRICT CONTRACT VALIDATION
    if (!chatId || typeof chatId !== 'string') {
      throw new Error('[ChatSessionManager] chatId is required (string)');
    }
    
    try {
      this.logger.info(`Deleting chat: ${chatId}`);
      
      // Delete via repository
      await this.chatRepository.delete(chatId);
      
      // If this was the current chat, clear it
      if (this.currentChatId === chatId) {
        this.currentChatId = null;
      }
      
      this.logger.info(`Chat deleted: ${chatId}`);
      
      // Emit deletion event
      this.eventBus.emit('chat:deleted', { chatId });
    } catch (error) {
      this.logger.error(`Failed to delete chat ${chatId}:`, error);
      
      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'ChatSessionManager.deleteChat', { chatId });
      }
      
      throw error;
    }
  }
  
  /**
   * Load most recent chat or create first chat
   * 
   * @returns {Promise<Object>} Chat data
   */
  async loadCurrentChat() {
    try {
      this.logger.info('Loading current chat');
      
      // Load all chats
      const chats = await this.chatRepository.findAll();
      
      if (chats.length > 0) {
        // Switch to most recent
        return await this.switchToChat(chats[0].id);
      } else {
        // Create first chat
        const newChat = await this.createChat('New Chat');
        return await this.switchToChat(newChat.id);
      }
    } catch (error) {
      this.logger.error('Failed to load current chat:', error);
      
      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'ChatSessionManager.loadCurrentChat');
      }
      
      throw error;
    }
  }
  
  /**
   * Get fallback chat after deletion
   * 
   * @param {string} deletedChatId - ID of deleted chat
   * @returns {Promise<Object>} Fallback chat data
   */
  async getFallbackChat(deletedChatId) {
    try {
      const chats = await this.chatRepository.findAll();
      
      if (chats.length > 0) {
        // Switch to first available chat
        return await this.switchToChat(chats[0].id);
      } else {
        // Do not create new chat automatically
        return null;
      }
    } catch (error) {
      this.logger.error('Failed to get fallback chat:', error);
      throw error;
    }
  }
  
  /**
   * Get current chat ID
   * 
   * @returns {string|null} Current chat ID
   */
  getCurrentChatId() {
    return this.currentChatId;
  }
  
  /**
   * Check if chat is current
   * 
   * @param {string} chatId - Chat ID
   * @returns {boolean} True if chat is current
   */
  isCurrentChat(chatId) {
    return this.currentChatId === chatId;
  }
  
  /**
   * Get all chats
   * 
   * @returns {Promise<Array>} All chats
   */
  async getAllChats() {
    try {
      this.logger.info('Loading all chats');
      
      // Delegate to repository
      const chats = await this.chatRepository.findAll();
      
      this.logger.info(`Loaded ${chats.length} chats`);
      return chats;
    } catch (error) {
      this.logger.error('Failed to load all chats:', error);
      
      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'ChatSessionManager.getAllChats');
      }
      
      throw error;
    }
  }
  
  /**
   * Update chat title
   * 
   * @param {string} chatId - Chat ID (REQUIRED)
   * @param {string} title - New title (REQUIRED)
   * @returns {Promise<Object>} Updated chat
   */
  async updateChatTitle(chatId, title) {
    // STRICT CONTRACT VALIDATION
    if (!chatId || typeof chatId !== 'string') {
      throw new Error('[ChatSessionManager] chatId is required (string)');
    }
    
    if (!title || typeof title !== 'string') {
      throw new Error('[ChatSessionManager] title is required (string)');
    }
    
    try {
      this.logger.info(`Updating chat title: ${chatId} → "${title}"`);
      
      // Delegate to repository
      const updatedChat = await this.chatRepository.updateTitle(chatId, title);
      
      this.logger.info(`Chat title updated: ${chatId}`);
      
      // Emit event
      this.eventBus.emit('chat:title-updated', { chatId, title });
      
      return updatedChat;
    } catch (error) {
      this.logger.error(`Failed to update chat title for ${chatId}:`, error);
      
      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'ChatSessionManager.updateChatTitle', { chatId, title });
      }
      
      throw error;
    }
  }
  
  /**
   * Get service statistics
   * 
   * @returns {Object} Service statistics
   */
  getStats() {
    return {
      currentChatId: this.currentChatId,
      hasChatRepository: Boolean(this.chatRepository),
      hasArtifactRepository: Boolean(this.artifactRepository),
      hasTraceabilityService: Boolean(this.traceabilityService),
      hasEventBus: Boolean(this.eventBus),
      hasErrorTracker: Boolean(this.errorTracker)
    };
  }
}

module.exports = { ChatSessionManager };
