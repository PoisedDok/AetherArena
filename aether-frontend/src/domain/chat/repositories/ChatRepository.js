/**
 * @.architecture
 * 
 * Incoming: ChatService.createChat/loadChat/updateChat() (method calls with Chat models) --- {object, javascript_api}
 * Processing: Initialize storageAPI (window.storageAPI or require), transform Chat models to PostgreSQL rows, call storageAPI methods (load/save/update/delete) via IPC, transform PostgreSQL rows back to Chat model instances via Chat.fromPostgresRow(), update chat properties --- {8 jobs: JOB_DELEGATE_TO_MODULE, JOB_DELETE_FROM_DB, JOB_GET_STATE, JOB_INITIALIZE, JOB_LOAD_FROM_DB, JOB_SAVE_TO_DB, JOB_SEND_IPC, JOB_UPDATE_DB}
 * Outgoing: storageAPI.loadChats/saveChat/updateChat() (IPC to main process → PostgreSQL), return Chat model instances --- {database_types.chat_record, json}
 * 
 * 
 * @module domain/chat/repositories/ChatRepository
 */

const { Chat } = require('../models/Chat');
const { Message } = require('../models/Message');

class ChatRepository {
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
      this.logger.warn('[ChatRepository] Storage API not available:', e.message);
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
   * Load all chats
   */
  async findAll() {
    this._ensureStorageAPI();
    
    try {
      const chats = await this.storageAPI.loadChats();
      return chats.map(chatData => Chat.fromPostgresRow(chatData));
    } catch (error) {
      this.logger.error('[ChatRepository] Failed to load chats:', error);
      throw error;
    }
  }

  /**
   * Load chat by ID with messages
   */
  async findById(chatId) {
    this._ensureStorageAPI();
    
    if (!chatId || typeof chatId !== 'string') {
      throw new Error('Chat ID must be a non-empty string');
    }

    try {
      const chatData = await this.storageAPI.loadChat(chatId);
      
      // Convert messages to Message instances
      const messages = Array.isArray(chatData.messages)
        ? chatData.messages.map(m => Message.fromPostgresRow(m))
        : [];
      
      return Chat.fromPostgresRow(chatData, messages);
    } catch (error) {
      this.logger.error(`[ChatRepository] Failed to load chat ${chatId}:`, error);
      throw error;
    }
  }

  /**
   * Create new chat
   */
  async create(chat) {
    this._ensureStorageAPI();
    
    if (!(chat instanceof Chat)) {
      throw new Error('Must provide Chat instance');
    }

    try {
      const chatData = await this.storageAPI.createChat(chat.title);
      
      // CRITICAL FIX: Return NEW chat instance instead of mutating input
      // Prevents unexpected side effects and maintains immutability
      return chat.clone({
        id: chatData.id,
        createdAt: chatData.created_at,
        updatedAt: chatData.updated_at
      });
    } catch (error) {
      this.logger.error('[ChatRepository] Failed to create chat:', error);
      throw error;
    }
  }

  /**
   * Update chat title
   */
  async updateTitle(chatId, title) {
    this._ensureStorageAPI();
    
    if (!chatId || typeof chatId !== 'string') {
      throw new Error('Chat ID must be a non-empty string');
    }

    if (!title || typeof title !== 'string') {
      throw new Error('Title must be a non-empty string');
    }

    try {
      const chatData = await this.storageAPI.updateChatTitle(chatId, title);
      return Chat.fromPostgresRow(chatData);
    } catch (error) {
      this.logger.error(`[ChatRepository] Failed to update chat ${chatId}:`, error);
      throw error;
    }
  }

  /**
   * Delete chat by ID
   */
  async delete(chatId) {
    this._ensureStorageAPI();
    
    if (!chatId || typeof chatId !== 'string') {
      throw new Error('Chat ID must be a non-empty string');
    }

    try {
      const result = await this.storageAPI.deleteChat(chatId);
      return result;
    } catch (error) {
      this.logger.error(`[ChatRepository] Failed to delete chat ${chatId}:`, error);
      throw error;
    }
  }

  /**
   * Find chat by session ID (if stored in metadata)
   */
  async findBySessionId(sessionId) {
    this._ensureStorageAPI();
    
    if (!sessionId || typeof sessionId !== 'string') {
      throw new Error('Session ID must be a non-empty string');
    }

    try {
      const allChats = await this.findAll();
      return allChats.find(chat => chat.sessionId === sessionId) || null;
    } catch (error) {
      this.logger.error(`[ChatRepository] Failed to find chat by session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Find active chats (not archived)
   */
  async findActive() {
    try {
      const allChats = await this.findAll();
      return allChats.filter(chat => chat.isActive && !chat.isArchived);
    } catch (error) {
      this.logger.error('[ChatRepository] Failed to find active chats:', error);
      throw error;
    }
  }

  /**
   * Find archived chats
   */
  async findArchived() {
    try {
      const allChats = await this.findAll();
      return allChats.filter(chat => chat.isArchived);
    } catch (error) {
      this.logger.error('[ChatRepository] Failed to find archived chats:', error);
      throw error;
    }
  }

  /**
   * Find most recent chat
   */
  async findMostRecent() {
    try {
      const allChats = await this.findAll();
      
      if (allChats.length === 0) {
        return null;
      }
      
      // Chats are already sorted by updated_at DESC from backend
      return allChats[0];
    } catch (error) {
      this.logger.error('[ChatRepository] Failed to find most recent chat:', error);
      throw error;
    }
  }

  /**
   * Count total chats
   */
  async count() {
    try {
      const allChats = await this.findAll();
      return allChats.length;
    } catch (error) {
      this.logger.error('[ChatRepository] Failed to count chats:', error);
      throw error;
    }
  }

  /**
   * Check if chat exists
   */
  async exists(chatId) {
    if (!chatId || typeof chatId !== 'string') {
      return false;
    }

    try {
      await this.findById(chatId);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Save chat (create or update)
   */
  async save(chat) {
    if (!(chat instanceof Chat)) {
      throw new Error('Must provide Chat instance');
    }

    if (!chat.id) {
      // Create new chat
      return this.create(chat);
    } else {
      // Update existing chat title
      return this.updateTitle(chat.id, chat.title);
    }
  }
}

module.exports = { ChatRepository };

