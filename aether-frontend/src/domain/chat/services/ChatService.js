/**
 * @.architecture
 * 
 * Incoming: ChatOrchestrator.createChat(), SidebarManager.loadChats(), MessageManager.createChat() (method calls requesting chat operations) --- {method_call, javascript_api}
 * Processing: Validate via ChatValidator, create Chat model instances, persist to ChatRepository (PostgreSQL), query active/archived chats, update titles, mark archived, load messages via MessageRepository, apply metadata --- {8 jobs: JOB_DELEGATE_TO_MODULE, JOB_DELETE_FROM_DB, JOB_GET_STATE, JOB_INITIALIZE, JOB_LOAD_FROM_DB, JOB_SAVE_TO_DB, JOB_UPDATE_DB, JOB_VALIDATE_SCHEMA}
 * Outgoing: ChatRepository.create/update/findAll() (persistence), MessageRepository.findByChatId() (query), return Chat model instances --- {object, javascript_api}
 * 
 * 
 * @module domain/chat/services/ChatService
 */

const { Chat } = require('../models/Chat');
const { ChatValidator } = require('../validators/ChatValidator');
const { ChatRepository } = require('../repositories/ChatRepository');
const { MessageRepository } = require('../repositories/MessageRepository');

class ChatService {
  constructor(dependencies = {}) {
    this.validator = dependencies.validator || new ChatValidator();
    this.chatRepository = dependencies.chatRepository || new ChatRepository(dependencies);
    this.messageRepository = dependencies.messageRepository || new MessageRepository(dependencies);
    this.logger = dependencies.logger || console;
  }

  /**
   * Create new chat
   */
  async createChat(title = 'New Chat', options = {}) {
    // Validate title
    this.validator.validateTitleOrThrow(title);
    
    const chat = Chat.create(title);
    
    // Apply options
    if (options.metadata) {
      Object.keys(options.metadata).forEach(key => {
        chat.setMetadata(key, options.metadata[key]);
      });
    }
    
    if (options.sessionId) {
      chat.sessionId = options.sessionId;
    }
    
    try {
      return await this.chatRepository.create(chat);
    } catch (error) {
      this.logger.error('[ChatService] Failed to create chat:', error);
      throw error;
    }
  }

  /**
   * Load chat by ID
   */
  async loadChat(chatId) {
    try {
      return await this.chatRepository.findById(chatId);
    } catch (error) {
      this.logger.error(`[ChatService] Failed to load chat ${chatId}:`, error);
      throw error;
    }
  }

  /**
   * Load all chats
   */
  async loadAllChats() {
    try {
      return await this.chatRepository.findAll();
    } catch (error) {
      this.logger.error('[ChatService] Failed to load all chats:', error);
      throw error;
    }
  }

  /**
   * Load active chats
   */
  async loadActiveChats() {
    try {
      return await this.chatRepository.findActive();
    } catch (error) {
      this.logger.error('[ChatService] Failed to load active chats:', error);
      throw error;
    }
  }

  /**
   * Load most recent chat
   */
  async loadMostRecentChat() {
    try {
      return await this.chatRepository.findMostRecent();
    } catch (error) {
      this.logger.error('[ChatService] Failed to load most recent chat:', error);
      throw error;
    }
  }

  /**
   * Update chat title
   */
  async updateChatTitle(chatId, title) {
    // Validate title
    this.validator.validateTitleOrThrow(title);
    
    try {
      return await this.chatRepository.updateTitle(chatId, title);
    } catch (error) {
      this.logger.error(`[ChatService] Failed to update chat ${chatId}:`, error);
      throw error;
    }
  }

  /**
   * Delete chat
   */
  async deleteChat(chatId) {
    try {
      return await this.chatRepository.delete(chatId);
    } catch (error) {
      this.logger.error(`[ChatService] Failed to delete chat ${chatId}:`, error);
      throw error;
    }
  }

  /**
   * Archive chat
   */
  async archiveChat(chatId) {
    try {
      const chat = await this.loadChat(chatId);
      chat.archive();
      // Note: Would need backend support to persist archive status
      return chat;
    } catch (error) {
      this.logger.error(`[ChatService] Failed to archive chat ${chatId}:`, error);
      throw error;
    }
  }

  /**
   * Get or create default chat
   */
  async getOrCreateDefaultChat() {
    try {
      // Try to get most recent chat
      let chat = await this.loadMostRecentChat();
      
      if (!chat) {
        // Create new chat if none exists
        chat = await this.createChat('New Chat');
      }
      
      return chat;
    } catch (error) {
      this.logger.error('[ChatService] Failed to get or create default chat:', error);
      throw error;
    }
  }

  /**
   * Load chat with messages
   */
  async loadChatWithMessages(chatId) {
    try {
      const chat = await this.chatRepository.findById(chatId);
      
      // Messages are already loaded by findById
      return chat;
    } catch (error) {
      this.logger.error(`[ChatService] Failed to load chat with messages ${chatId}:`, error);
      throw error;
    }
  }

  /**
   * Get chat statistics
   */
  async getChatStatistics(chatId) {
    try {
      const chat = await this.loadChat(chatId);
      const messageStats = await this.messageRepository.getStatistics(chatId);
      
      return {
        id: chat.id,
        title: chat.title,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
        age: chat.getAge(),
        timeSinceUpdate: chat.getTimeSinceUpdate(),
        messageCount: chat.getMessageCount(),
        totalTokens: chat.getTotalTokens(),
        isActive: chat.isActive,
        isArchived: chat.isArchived,
        artifactCount: chat.artifactIds.length,
        ...messageStats
      };
    } catch (error) {
      this.logger.error(`[ChatService] Failed to get chat statistics ${chatId}:`, error);
      throw error;
    }
  }

  /**
   * Search chats by title
   */
  async searchByTitle(query) {
    if (!query || typeof query !== 'string') {
      throw new Error('Search query must be a non-empty string');
    }
    
    try {
      const allChats = await this.loadAllChats();
      const lowerQuery = query.toLowerCase();
      
      return allChats.filter(chat => 
        chat.title.toLowerCase().includes(lowerQuery)
      );
    } catch (error) {
      this.logger.error('[ChatService] Failed to search chats:', error);
      throw error;
    }
  }

  /**
   * Get chat count
   */
  async getChatCount() {
    try {
      return await this.chatRepository.count();
    } catch (error) {
      this.logger.error('[ChatService] Failed to get chat count:', error);
      throw error;
    }
  }

  /**
   * Check if chat exists
   */
  async chatExists(chatId) {
    try {
      return await this.chatRepository.exists(chatId);
    } catch (error) {
      return false;
    }
  }

  /**
   * Generate smart title from messages
   */
  generateSmartTitle(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return 'New Chat';
    }
    
    // Find first user message
    const firstUserMessage = messages.find(m => m.isUser());
    
    if (!firstUserMessage) {
      return 'New Chat';
    }
    
    // Extract first sentence or first 50 characters
    let title = firstUserMessage.content.trim();
    
    // Get first sentence
    const sentenceEnd = title.search(/[.!?]\s/);
    if (sentenceEnd > 0) {
      title = title.substring(0, sentenceEnd + 1);
    }
    
    // Limit length
    if (title.length > 50) {
      title = title.substring(0, 47) + '...';
    }
    
    return title;
  }

  /**
   * Auto-update chat title from messages
   */
  async autoUpdateTitle(chatId) {
    try {
      const chat = await this.loadChat(chatId);
      
      // Only auto-update if title is still default
      if (chat.title !== 'New Chat' || chat.getMessageCount() === 0) {
        return chat;
      }
      
      const smartTitle = this.generateSmartTitle(chat.messages);
      
      if (smartTitle !== 'New Chat') {
        return await this.updateChatTitle(chatId, smartTitle);
      }
      
      return chat;
    } catch (error) {
      this.logger.error(`[ChatService] Failed to auto-update title for chat ${chatId}:`, error);
      throw error;
    }
  }
}

module.exports = { ChatService };

