/**
 * @.architecture
 * Incoming: ChatService.createChat|ChatService.loadChat|ChatService.updateChat --- {state.chat_session, object}
 * Processing: Initialize storage bridge, transform/persist chat aggregates, hydrate message collections --- {8 jobs: JOB_DELEGATE_TO_MODULE, JOB_DELETE_FROM_DB, JOB_GET_STATE, JOB_INITIALIZE, JOB_LOAD_FROM_DB, JOB_SAVE_TO_DB, JOB_SEND_IPC, JOB_UPDATE_DB}
 * Outgoing: storageAPI.createChat|storageAPI.loadChat|storageAPI.updateChatTitle --- {database_types.chat_record, json}
 * @module domain/chat/repositories/ChatRepository
 */

const { Chat } = require('../models/Chat');
const { Message } = require('../models/Message');
const { resolveStorageAPI } = require('../../../shared/utils/storage-resolver');

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
    const resolved = resolveStorageAPI({ storageAPI: this.storageAPI });

    if (resolved) {
      this.storageAPI = resolved;
      return;
    }

    this.logger.warn('[ChatRepository] Storage API not available. Provide storageAPI via dependencies or ensure preload exposes aether.storage.');
  }

  /**
   * Ensure storage API is available
   */
  _ensureStorageAPI() {
    if (!this.storageAPI) {
      this._initializeStorageAPI();
    }
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
      if (!Array.isArray(chats)) {
        this.logger.warn('[ChatRepository] loadChats returned non-array result');
        return [];
      }

      return chats
        .filter(chatData => chatData && typeof chatData === 'object')
        .map(chatData => Chat.fromPostgresRow(chatData));
    } catch (error) {
      this.logger.error('[ChatRepository] Failed to load chats:', error);
      throw error;
    }
  }

  /**
   * Load chat by ID with messages
   */
  async findById(chatId) {
    try {
      this._ensureStorageAPI();

      if (typeof chatId !== 'string' || chatId.trim().length === 0) {
        throw new Error('Chat ID must be a non-empty string');
      }

      const chatData = await this.storageAPI.loadChat(chatId);
      if (!chatData || typeof chatData !== 'object') {
        this.logger.warn(`[ChatRepository] Chat ${chatId} not found or invalid payload`);
        return null;
      }

      const rawMessages = Array.isArray(chatData.messages)
        ? chatData.messages.filter(m => m && typeof m === 'object')
        : [];

      const messages = rawMessages.map((messageData) => {
        try {
          return Message.fromPostgresRow(messageData);
        } catch (parseError) {
          this.logger.warn(
            `[ChatRepository] Skipping malformed message for chat ${chatId}:`,
            parseError
          );
          return null;
        }
      }).filter(Boolean);

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
    try {
      this._ensureStorageAPI();

      if (!(chat instanceof Chat)) {
        throw new Error('Must provide Chat instance');
      }

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
    try {
      this._ensureStorageAPI();

      if (!chatId || typeof chatId !== 'string') {
        throw new Error('Chat ID must be a non-empty string');
      }

      if (!title || typeof title !== 'string') {
        throw new Error('Title must be a non-empty string');
      }

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
    try {
      this._ensureStorageAPI();

      if (!chatId || typeof chatId !== 'string') {
        throw new Error('Chat ID must be a non-empty string');
      }

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
    try {
      this._ensureStorageAPI();

      if (!sessionId || typeof sessionId !== 'string') {
        throw new Error('Session ID must be a non-empty string');
      }

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
    try {
      if (typeof chatId !== 'string' || chatId.trim().length === 0) {
        return false;
      }

      const chat = await this.findById(chatId);
      return Boolean(chat);
    } catch (error) {
      return false;
    }
  }

  /**
   * Save chat (create or update)
   */
  async save(chat) {
    try {
      if (!(chat instanceof Chat)) {
        throw new Error('Must provide Chat instance');
      }

      if (!chat.id) {
        return this.create(chat);
      }

      return this.updateTitle(chat.id, chat.title);
    } catch (error) {
      this.logger.error('[ChatRepository] Failed to save chat:', error);
      throw error;
    }
  }
}

module.exports = { ChatRepository };
