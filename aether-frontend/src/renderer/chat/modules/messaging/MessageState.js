'use strict';

/**
 * @.architecture
 * 
 * Incoming: StreamHandler.js, MessageManager.js --- {message_types.*, json}
 * Processing: Validate message, ensure chat exists in PostgreSQL, migrate local IDs to UUIDs, persist via Storage API --- {5 jobs: JOB_GET_STATE, JOB_SAVE_TO_DB, JOB_LOAD_FROM_DB, JOB_UPDATE_STATE, JOB_EMIT_EVENT}
 * Outgoing: window.storageAPI → IPC → Main Process → Backend → PostgreSQL --- {database_types.message_record, json}
 * 
 * 
 * @module renderer/chat/modules/messaging/MessageState
 */

class MessageState {
  constructor(options = {}) {
    this.eventBus = options.eventBus || null;
    this.ipcBridge = options.ipcBridge || null;

    // State
    this.currentChatId = null;
    this.messages = [];

    // Storage API reference
    this.storageAPI = null;

    // Initialize storage API
    this._initStorageAPI();

    console.log('[MessageState] Constructed');
  }

  _initStorageAPI() {
    if (typeof window !== 'undefined' && window.storageAPI) {
      this.storageAPI = window.storageAPI;
      console.log('[MessageState] Storage API available');
    } else {
      console.warn('[MessageState] Storage API not available - persistence disabled');
    }
  }

  async init(chatId = null) {
    console.log('[MessageState] Initializing...');

    if (!this.storageAPI) {
      console.warn('[MessageState] Cannot initialize - no storage API');
      return;
    }

    try {
      if (chatId) {
        await this.loadChat(chatId);
      } else {
        await this.ensureDefaultChat();
      }

      console.log('[MessageState] Initialization complete');
    } catch (error) {
      console.error('[MessageState] Initialization failed:', error);
      throw error;
    }
  }

  async ensureDefaultChat() {
    if (!this.storageAPI) return;

    try {
      const chats = await this.storageAPI.loadChats();

      if (chats && chats.length > 0) {
        const recentChat = chats[0];
        await this.loadChat(recentChat.id);
      } else {
        await this.createChat('New Chat');
      }
    } catch (error) {
      console.error('[MessageState] Failed to ensure default chat:', error);
      this.currentChatId = this._generateLocalChatId();
      this.messages = [];
    }
  }

  async createChat(title = 'New Chat') {
    console.log(`[MessageState] Creating new chat: "${title}"`);

    if (!this.storageAPI) {
      this.currentChatId = this._generateLocalChatId();
      this.messages = [];
      console.log(`[MessageState] Created local chat: ${this.currentChatId}`);
      return this.currentChatId;
    }

    try {
      const chat = await this.storageAPI.createChat(title);
      this.currentChatId = chat.id;
      this.messages = [];

      console.log(`[MessageState] Chat created: ${chat.id}`);

      if (this.eventBus) {
        this.eventBus.emit('chat:created', {
          chatId: chat.id,
          title: title
        });
      }

      // Notify artifacts window of new chat using proper API
      if (window.aether && window.aether.artifacts && typeof window.aether.artifacts.switchChat === 'function') {
        window.aether.artifacts.switchChat(chat.id);
      } else if (this.ipcBridge) {
        this.ipcBridge.send('artifacts:switch-chat', chat.id);
      }

      return chat.id;
    } catch (error) {
      console.error('[MessageState] Failed to create chat:', error);
      throw error;
    }
  }

  async loadChat(chatId) {
    console.log(`[MessageState] Loading chat: ${chatId}`);

    if (!chatId) {
      console.warn('[MessageState] No chat ID provided');
      return;
    }

    if (!this.storageAPI) {
      console.warn('[MessageState] Cannot load chat - no storage API');
      return;
    }

    try {
      const chat = await this.storageAPI.loadChat(chatId);

      if (!chat) {
        console.warn(`[MessageState] Chat not found: ${chatId}`);
        return;
      }

      this.currentChatId = chat.id;
      this.messages = this._normalizeMessages(chat.messages || []);

      console.log(`[MessageState] Loaded ${this.messages.length} messages`);

      if (this.eventBus) {
        this.eventBus.emit('chat:loaded', {
          chatId: chat.id,
          messageCount: this.messages.length
        });
      }

      return chat;
    } catch (error) {
      console.error('[MessageState] Failed to load chat:', error);
      throw error;
    }
  }

  async switchChat(chatId) {
    console.log(`[MessageState] Switching to chat: ${chatId}`);

    if (chatId === this.currentChatId) {
      console.log('[MessageState] Already on requested chat');
      return;
    }

    try {
      await this.loadChat(chatId);

      if (this.eventBus) {
        this.eventBus.emit('chat:switched', { chatId });
      }

      if (this.ipcBridge) {
        this.ipcBridge.send('chat:switch', { chatId });
      }
    } catch (error) {
      console.error('[MessageState] Failed to switch chat:', error);
      throw error;
    }
  }

  async saveMessage(message) {
    console.log('[MessageState] Saving message:', {
      role: message?.role,
      contentLength: message?.content?.length,
      chatId: this.currentChatId
    });

    if (!message || !message.role || !message.content) {
      console.warn('[MessageState] Invalid message object:', message);
      return null;
    }

    if (!this.currentChatId) {
      console.warn('[MessageState] No chat ID - cannot save message');
      return null;
    }

    if (!this.storageAPI) {
      console.warn('[MessageState] No storage API - message not persisted');
      const localMessage = {
        ...message,
        id: message.id || this._generateMessageId(),
        timestamp: message.timestamp || new Date().toISOString()
      };
      this.messages.push(localMessage);
      return localMessage;
    }

    try {
      await this.ensureChatExists();

      const messageToSave = {
        role: message.role,
        content: message.content,
        timestamp: message.timestamp || new Date().toISOString(),
        correlation_id: message.correlation_id || null
      };

      const savedMessage = await this.storageAPI.saveMessage(
        this.currentChatId,
        messageToSave
      );

      if (savedMessage) {
        this.messages.push(savedMessage);
        console.log(`[MessageState] Message saved: ${savedMessage.id}`);

        if (this.eventBus) {
          this.eventBus.emit('message:saved', {
            chatId: this.currentChatId,
            messageId: savedMessage.id
          });
        }

        return savedMessage;
      }

      return null;
    } catch (error) {
      console.error('[MessageState] Failed to save message:', error);
      const fallbackMessage = {
        ...message,
        id: message.id || this._generateMessageId(),
        timestamp: message.timestamp || new Date().toISOString()
      };
      this.messages.push(fallbackMessage);
      return fallbackMessage;
    }
  }

  async updateMessage(messageId, updates) {
    console.log(`[MessageState] Updating message: ${messageId}`);

    if (!this.storageAPI) {
      const message = this.messages.find(m => m.id === messageId);
      if (message) {
        Object.assign(message, updates);
      }
      return;
    }

    try {
      await this.storageAPI.updateMessage(messageId, updates);
      
      const message = this.messages.find(m => m.id === messageId);
      if (message) {
        Object.assign(message, updates);
      }

      console.log(`[MessageState] Message updated: ${messageId}`);
    } catch (error) {
      console.error('[MessageState] Failed to update message:', error);
    }
  }

  async updateChatTitle(title) {
    if (!this.currentChatId || !this.storageAPI) return;

    try {
      await this.storageAPI.updateChatTitle(this.currentChatId, title);
      console.log(`[MessageState] Chat title updated: "${title}"`);
    } catch (error) {
      console.error('[MessageState] Failed to update chat title:', error);
    }
  }

  async ensureChatExists() {
    if (!this.currentChatId) {
      console.warn('[MessageState] No chat ID to ensure');
      return false;
    }

    if (!this.storageAPI) {
      console.warn('[MessageState] No storage API - cannot ensure chat exists');
      return false;
    }

    const isLocalId = this.currentChatId.startsWith('chat_');

    if (!isLocalId) {
      return true;
    }

    try {
      console.log(`[MessageState] Migrating local chat to PostgreSQL: ${this.currentChatId}`);

      const title = this._deriveTitleFromMessages();
      const chat = await this.storageAPI.createChat(title);

      const oldId = this.currentChatId;
      this.currentChatId = chat.id;

      console.log(`[MessageState] Chat migrated: ${oldId} → ${chat.id}`);

      if (this.eventBus) {
        this.eventBus.emit('chat:migrated', {
          oldId,
          newId: chat.id
        });
      }

      return true;
    } catch (error) {
      console.error('[MessageState] Failed to ensure chat exists:', error);
      return false;
    }
  }

  async getChats() {
    if (!this.storageAPI) {
      return [];
    }

    try {
      const chats = await this.storageAPI.loadChats();
      return chats || [];
    } catch (error) {
      console.error('[MessageState] Failed to get chats:', error);
      return [];
    }
  }

  _normalizeMessages(messages) {
    if (!Array.isArray(messages)) return [];

    return messages.map(msg => ({
      id: msg.id,
      role: msg.role,
      content: msg.content || '',
      timestamp: msg.timestamp || msg.created_at || new Date().toISOString(),
      correlation_id: msg.correlation_id || null
    }));
  }

  _deriveTitleFromMessages() {
    if (this.messages.length === 0) {
      return 'New Chat';
    }

    const firstUserMessage = this.messages.find(m => m.role === 'user');
    if (firstUserMessage) {
      const title = firstUserMessage.content.substring(0, 50).trim();
      return title || 'New Chat';
    }

    return 'New Chat';
  }

  _generateLocalChatId() {
    return `chat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  _generateMessageId() {
    console.error('[MessageState] FALLBACK ID GENERATED - SessionManager not properly integrated!');
    return `FALLBACK_msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  getMessages() {
    return [...this.messages];
  }

  getCurrentChatId() {
    return this.currentChatId;
  }

  clearMessages() {
    this.messages = [];
    console.log('[MessageState] Messages cleared');
  }

  dispose() {
    console.log('[MessageState] Disposing...');

    this.messages = [];
    this.currentChatId = null;
    this.storageAPI = null;
    this.eventBus = null;
    this.ipcBridge = null;

    console.log('[MessageState] Disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MessageState;
}

if (typeof window !== 'undefined') {
  window.MessageState = MessageState;
  console.log('📦 MessageState loaded');
}

