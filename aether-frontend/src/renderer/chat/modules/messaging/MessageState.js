'use strict';

const { createRendererLogger } = require('../../../shared/utils/logger');
const { ChatServices } = require('../../../../application/chat/ChatServices');

const stateLogger = createRendererLogger('MessageState');

/**
 * @.architecture
 * 
 * Incoming: StreamHandler updates, MessageManager persistence requests --- {Dict, json}
 * Processing: Manage active chat context, delegate persistence to ChatService/MessageService, normalize local state, emit lifecycle events --- {4 jobs: JOB_DELEGATE_TO_MODULE, JOB_GET_STATE, JOB_UPDATE_STATE, JOB_EMIT_EVENT}
 * Outgoing: ChatService/MessageService (domain layer), EventBus chat lifecycle events --- {Dict, json}
 * 
 * 
 * @module renderer/chat/modules/messaging/MessageState
 */

class MessageState {
  constructor(options = {}) {
    this.eventBus = options.eventBus || null;
    this.ipc = options.ipc || null;
    this.log = stateLogger.child({ scope: 'instance' });

    // State
    this.currentChatId = null;
    this.messages = [];

    const storageAPI = options.storageAPI || (options.aether ? options.aether.storage : null);
    const services = options.chatServices || new ChatServices({
      storageAPI,
      logger: this.log,
      chatService: options.chatService,
      messageService: options.messageService,
    });

    this.chatService = services.chatService;
    this.messageService = services.messageService;
    this._createDomainMessage = services.createDomainMessage.bind(services);
    this.artifactsAPI = options.artifactsAPI || (options.aether ? options.aether.artifacts : null);

    // Lifecycle
    this._isDisposed = false;

    this.log.debug('MessageState constructed');
  }

  async init(options = {}) {
    if (this._isDisposed) return;
    this.log.info('Initializing MessageState');

    try {
      const resolved = typeof options === 'string' ? { chatId: options } : options;
      const { chatId = null, autoLoad = true } = resolved || {};

      if (autoLoad) {
        if (chatId) {
          await this.loadChat(chatId);
        } else {
          await this.ensureDefaultChat();
        }
      } else {
        this.currentChatId = null;
        this.messages = [];
        this.log.debug('MessageState auto-load disabled; awaiting controller-driven chat load');
      }

      this.log.info('MessageState initialization complete');
    } catch (error) {
      this.log.error('MessageState initialization failed', { error });
      throw error;
    }
  }

  async ensureDefaultChat() {
    if (this._isDisposed) return null;
    try {
      const chat = await this.chatService.getOrCreateDefaultChat();
      if (chat?.id) {
        await this.loadChat(chat.id);
        return chat.id;
      }
      this.currentChatId = this._generateLocalChatId();
      this.messages = [];
      return this.currentChatId;
    } catch (error) {
      this.log.error('Failed to ensure default chat', { error });
      this.currentChatId = this._generateLocalChatId();
      this.messages = [];
      return this.currentChatId;
    }
  }

  async createChat(title = 'New Chat') {
    if (this._isDisposed) return null;
    this.log.info('Creating new chat in MessageState', { title });

    try {
      const chat = await this.chatService.createChat(title);
      this.currentChatId = chat.id;
      this.messages = [];

      this.log.info('Chat created', { chatId: chat.id });

      if (this.eventBus) {
        this._emitChatCreated(chat.id, title);
      }

      this._notifyArtifactsOfChatSwitch(chat.id);

      return chat.id;
    } catch (error) {
      this.log.error('Failed to create chat via storage API', { error });
      throw error;
    }
  }

  async loadChat(chatId) {
    if (this._isDisposed) return;
    this.log.info('Loading chat', { chatId });

    if (!chatId) {
      this.log.warn('No chat ID provided to loadChat');
      return;
    }

    try {
      const chat = await this.chatService.loadChatWithMessages(chatId);

      if (!chat) {
        this.log.warn('Chat not found', { chatId });
        return;
      }

      await this._applyLoadedChat(chat);

      return chat;
    } catch (error) {
      this.log.error('Failed to load chat', { chatId, error });
      throw error;
    }
  }

  async switchChat(chatId) {
    if (this._isDisposed) return;
    this.log.info('Switching to chat', { chatId });

    if (chatId === this.currentChatId) {
      this.log.debug('Already on requested chat', { chatId });
      return;
    }

    try {
      await this.loadChat(chatId);

      if (this.eventBus) {
        this.eventBus.emit('chat:switched', { chatId });
      }

      if (this.ipc) {
        this.ipc.send('chat:switch-to-chat', { chatId });
      }
    } catch (error) {
      this.log.error('Failed to switch chat', { chatId, error });
      throw error;
    }
  }

  async saveMessage(message) {
    if (this._isDisposed) return null;
    this.log.debug('Saving message', {
      role: message?.role,
      contentLength: message?.content?.length,
      chatId: this.currentChatId
    });

    if (!message || !message.role || !message.content) {
      this.log.warn('Invalid message object', { message });
      return null;
    }

    if (!this.currentChatId) {
      this.log.warn('No chat ID - cannot save message');
      return null;
    }

    try {
      await this.ensureChatExists();
      const domainMessage = this._toDomainMessage(message);
      domainMessage.chatId = this.currentChatId;
      const saved = await this.messageService.saveMessage(domainMessage, this.currentChatId);
      const normalized = this._normalizeMessage(saved.toJSON());
      this.messages.push(normalized);
      this._emitMessageSaved(normalized.id);
      return normalized;
    } catch (error) {
      this.log.error('Failed to persist message via domain service', { error });
      const localMessage = this._createLocalMessage(message);
      this.messages.push(localMessage);
      return localMessage;
    }
  }

  async updateMessage(messageId, updates) {
    if (this._isDisposed) return;
    this.log.debug('Updating message', { messageId });

    const message = this.messages.find(m => m.id === messageId);
    if (message) {
      Object.assign(message, updates);
      this.log.debug('Message updated locally', { messageId });
    }
  }

  async markMessageFailed(requestId, errorMsg) {
    if (this._isDisposed) return;
    this.log.error('Marking message as failed', { requestId, errorMsg });
    
    // Find the message by correlation_id or id
    const message = this.messages.find(m => m.correlation_id === requestId || m.id === requestId);
    if (message) {
      message.status = 'error';
      message.error = errorMsg;
      
      // Note: We do not persist the error state to the backend because
      // the backend has no concept of this message yet (it failed to send).
      // This is a purely client-side transient state.
    } else {
      this.log.warn('Failed message not found in state', { requestId });
    }
  }

  async removeMessageSequence(messageId) {
    if (this._isDisposed) return;
    this.log.debug('Removing message sequence from state', { messageId });

    const userIndex = this.messages.findIndex(m => m.id === messageId && m.role === 'user');
    if (userIndex !== -1) {
      // Find next user message to know how many to delete
      let assistantIndex = -1;
      for (let i = userIndex + 1; i < this.messages.length; i++) {
         if (this.messages[i].role === 'assistant') {
             assistantIndex = i;
             break;
         } else if (this.messages[i].role === 'user') {
             break;
         }
      }

      const deleteCount = assistantIndex !== -1 ? (assistantIndex - userIndex) + 1 : 1;
      this.messages.splice(userIndex, deleteCount);
      
      this.log.debug('Message sequence removed from state', { messageId, removedCount: deleteCount });
      return true;
    }
    return false;
  }

  async updateChatTitle(title) {
    if (this._isDisposed || !this.currentChatId) return;

    try {
      await this.chatService.updateChatTitle(this.currentChatId, title);
      this.log.debug('Chat title updated', { chatId: this.currentChatId, title });
    } catch (error) {
      this.log.error('Failed to update chat title', { chatId: this.currentChatId, error });
    }
  }

  async ensureChatExists() {
    if (this._isDisposed) return false;
    if (!this.currentChatId) {
      this.log.warn('No chat ID to ensure');
      return false;
    }

    try {
      const exists = await this.chatService.chatExists(this.currentChatId);
      if (exists) {
        return true;
      }

      this.log.info('Creating persisted chat for local session', { chatId: this.currentChatId });
      const title = this._deriveTitleFromMessages();
      const chat = await this.chatService.createChat(title);

      const oldId = this.currentChatId;
      this.currentChatId = chat.id;

      if (this.eventBus) {
        this.eventBus.emit('chat:migrated', {
          oldId,
          newId: chat.id
        });
      }

      this._notifyArtifactsOfChatSwitch(chat.id);
      return true;
    } catch (error) {
      this.log.error('Failed to ensure chat exists', { chatId: this.currentChatId, error });
      return false;
    }
  }

  async getChats() {
    if (this._isDisposed) return [];
    try {
      const chats = await this.chatService.loadAllChats();
      return chats || [];
    } catch (error) {
      this.log.error('Failed to get chats', { error });
      return [];
    }
  }

  _normalizeMessages(messages) {
    if (!Array.isArray(messages)) return [];
    return messages
      .map(msg => this._normalizeMessage(msg))
      .filter(Boolean);
  }

  _normalizeMessage(message) {
    if (!message) {
      throw new Error('[MessageState] CONTRACT VIOLATION: Message must be non-null');
    }

    if (typeof message.toJSON === 'function') {
      const plain = message.toJSON();
      // CONTRACT: Backend sends snake_case fields - use them directly
      if (!plain.id || typeof plain.id !== 'string') {
        throw new Error('[MessageState] CONTRACT VIOLATION: Message must have id');
      }
      if (!plain.timestamp || (typeof plain.timestamp !== 'number' && typeof plain.timestamp !== 'string')) {
        throw new Error('[MessageState] CONTRACT VIOLATION: Message must have timestamp');
      }
      return {
        id: plain.id,
        role: plain.role,
        content: plain.content || '',
        timestamp: typeof plain.timestamp === 'string' ? Date.parse(plain.timestamp) : plain.timestamp,
        correlation_id: plain.correlation_id || null, // Backend sends correlation_id (snake_case)
        metadata: plain.metadata || {},
      };
    }

    // CONTRACT: Backend sends snake_case fields - use them directly
    if (!message.id || typeof message.id !== 'string') {
      throw new Error('[MessageState] CONTRACT VIOLATION: Message must have id');
    }
    if (!message.timestamp || (typeof message.timestamp !== 'number' && typeof message.timestamp !== 'string')) {
      throw new Error('[MessageState] CONTRACT VIOLATION: Message must have timestamp');
    }
    return {
      id: message.id,
      role: message.role,
      content: message.content || '',
      timestamp: typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : message.timestamp,
      correlation_id: message.correlation_id || null, // Backend sends correlation_id (snake_case)
      metadata: message.metadata || {},
    };
  }

  async _applyLoadedChat(chat, options = {}) {
    if (!chat) return;

    const plain = typeof chat.toJSON === 'function' ? chat.toJSON() : chat;
    this.currentChatId = plain.id;
    this.messages = this._normalizeMessages(plain.messages || chat.messages || []);

    this.log.info('Chat loaded', {
      chatId: plain.id,
      messageCount: this.messages.length,
    });

    if (options.emitLoaded !== false) {
      this._emitChatLoaded(plain.id, this.messages.length);
      
      // ARCHITECTURAL FIX: Emit 'chat:switched' event to trigger context modal, icons, and other feature refreshes
      // This matches the domain layer ChatSessionManager.switchToChat() pattern
      // Ensures new chat button and chat switch both trigger the same event chain
      if (this.eventBus) {
        this.eventBus.emit('chat:switched', {
          chatId: plain.id,
          messageCount: this.messages.length,
          artifactCount: 0 // Will be populated by artifact loading
        });
      }
    }

    this._notifyArtifactsOfChatSwitch(plain.id);
  }

  _createLocalMessage(message) {
    return {
      ...message,
      id: message.id || this._generateMessageId(),
      timestamp: message.timestamp || Date.now(),
    };
  }

  _toDomainMessage(message) {
    if (!this._createDomainMessage) {
      throw new Error('[MessageState] Domain message factory not available');
    }
    return this._createDomainMessage(message, this.currentChatId);
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

  _emitChatCreated(chatId, title) {
    if (!this.eventBus) {
      return;
    }
    this.eventBus.emit('chat:created', {
      chatId,
      title,
    });
  }

  _emitChatLoaded(chatId, messageCount) {
    if (!this.eventBus) {
      return;
    }
    this.eventBus.emit('chat:loaded', {
      chatId,
      messageCount,
    });
  }

  _emitMessageSaved(messageId) {
    if (!this.eventBus) {
      return;
    }
    this.eventBus.emit('message:saved', {
      chatId: this.currentChatId,
      messageId,
    });
  }

  _notifyArtifactsOfChatSwitch(chatId) {
    if (this.artifactsAPI && typeof this.artifactsAPI.switchChat === 'function') {
      this.artifactsAPI.switchChat(chatId);
    } else if (this.ipc) {
      this.ipc.send('artifacts:switch-chat', chatId);
    }
  }

  _generateLocalChatId() {
    if (typeof crypto === 'undefined' || !crypto.randomUUID) {
      throw new Error('[MessageState] CONTRACT VIOLATION: crypto.randomUUID is required for chat ID generation.');
    }
    return crypto.randomUUID();
  }

  _generateMessageId() {
    this.log.error('SessionBridge integration missing - message ID generation REQUIRED');
    throw new Error('SessionBridge is REQUIRED for message ID generation - no fallbacks');
  }

  getMessages() {
    return [...this.messages];
  }

  getCurrentChatId() {
    return this.currentChatId;
  }

  clearMessages() {
    this.messages = [];
    this.log.debug('Messages cleared');
  }

  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this.log.info('Disposing MessageState');

    this.messages = [];
    this.currentChatId = null;
    this.eventBus = null;
    this.ipc = null;

    // MS-2: Null domain service references to enable GC
    this.chatService = null;
    this.messageService = null;
    this._createDomainMessage = null;
    this.artifactsAPI = null;

    this.log.debug('MessageState disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MessageState;
}

if (typeof window !== 'undefined') {
  window.MessageState = MessageState;
  stateLogger.debug('MessageState module loaded');
}
