'use strict';

/**
 * @.architecture
 *
 * Incoming: Chat creation/load/switch requests from orchestrator --- {chat_request, object}
 * Processing: Delegate to MessageState, update UI, notify backend --- {4 jobs: JOB_DELEGATE_TO_MODULE, JOB_EMIT_EVENT, JOB_NOTIFY_BACKEND, JOB_UPDATE_UI}
 * Outgoing: MessageState method calls, EventBus events, backend context reset --- {method_call|event|ipc, void}
 *
 * @module renderer/chat/modules/messaging/lifecycle/ChatLifecycleManager
 */

const { createRendererLogger } = require('../../../../shared/utils/logger');
const { getAether } = require('../../../../shared/bridge/AetherBridge');
const sessionBridge = require('../../../../shared/adapters/session');

const lifecycleLogger = createRendererLogger('ChatLifecycleManager');

/**
 * ChatLifecycleManager - Chat Creation & Switching
 * =================================================
 * 
 * SINGLE RESPONSIBILITY: Manage chat lifecycle operations
 * 
 * RESPONSIBILITIES:
 * - Create new chats
 * - Load existing chats
 * - Switch between chats
 * - Notify backend of context changes
 * - Coordinate UI updates
 * 
 * CONTRACTS:
 * - Delegates persistence to MessageState
 * - Emits lifecycle events via EventBus
 * - NO direct DOM manipulation
 * 
 * @module renderer/chat/modules/messaging/lifecycle/ChatLifecycleManager
 */
class ChatLifecycleManager {
  constructor(options = {}) {
    this.messageState = options.messageState || null;
    this.messageView = options.messageView || null;
    this.eventBus = options.eventBus || null;
    this.ipc = options.ipc || null;
    this.trailOrchestrator = options.trailOrchestrator || null;
    this.log = lifecycleLogger.child({ scope: 'chat-lifecycle-manager' });
    this.aether = options.aether || getAether();
    this._activeLoad = null;
    this._isDisposed = false;

    if (!this.messageState) {
      throw new Error('[ChatLifecycleManager] messageState is REQUIRED');
    }

    if (!this.messageView) {
      throw new Error('[ChatLifecycleManager] messageView is REQUIRED');
    }

    this.log.info('ChatLifecycleManager initialized');
  }

  /**
   * Create new chat
   * @param {string} [title] - Chat title
   * @param {Object} [options] - Options for creating the chat
   * @param {Array} [options.seedMessages] - Array of messages to immediately insert
   * @returns {Promise<string>} Chat ID
   */
  async createChat(title = 'New Chat', options = {}) {
    if (this._isDisposed) {
      this.log.warn('createChat called on disposed ChatLifecycleManager', { title });
      return null;
    }
    this.log.info('Creating new chat', { title, hasSeedMessages: !!options.seedMessages });

    try {
      // Create chat via MessageState
      const chatId = await this.messageState.createChat(title);

      // LIFECYCLE GUARD: Abort if disposed during async createChat
      if (this._isDisposed) {
        this.log.warn('createChat aborted: disposed during messageState.createChat', { title });
        return null;
      }

      // Emit title change event
      if (this.eventBus) {
        this.eventBus.emit('chat:title-changed', { title });
      }

      // Trail state will be restored after DOM is ready (see line 147)

      // Clear message view
      this.messageView.clear();

      // Seed initial messages if provided
      if (options.seedMessages && Array.isArray(options.seedMessages)) {
        for (const msg of options.seedMessages) {
          msg.chatId = chatId; // Ensure the message belongs to this chat
          const savedMsg = await this.messageState.saveMessage(msg);
          if (savedMsg && this.messageView) {
            this.messageView.renderMessage(savedMsg);
          }
        }
      }

      // Set active session
      await sessionBridge.setActiveChat(chatId);

      // LIFECYCLE GUARD: Abort if disposed during async setActiveChat
      if (this._isDisposed) {
        this.log.warn('createChat aborted: disposed during setActiveChat', { title, chatId });
        return null;
      }

      this.log.info('Created and activated chat session', { chatId });

      // Notify backend of context switch
      await this._notifyBackendContextSwitch(chatId);

      // LIFECYCLE GUARD: Abort if disposed during async backend notification
      if (this._isDisposed) {
        this.log.warn('createChat aborted: disposed during backend notification', { title, chatId });
        return null;
      }

      return chatId;
    } catch (error) {
      this.log.error('Failed to create chat', { title, error });
      throw error;
    }
  }

  /**
   * Clear current chat
   */
  async clearChat() {
    if (this._isDisposed) return;
    this.log.info('Clearing active chat session');

    try {
      this.messageView.clear();
      this.messageView.showEmptyState();
      
      // Clear message state
      if (this.messageState) {
        this.messageState.currentChatId = null;
        this.messageState.messages = [];
        this.messageState.activeStreamId = null;
      }

      // Notify backend
      if (this.ipc && typeof this.ipc.send === 'function') {
        this.ipc.send('chat:send', {
          message: '',
          chatId: 'none',
          metadata: {
            type: 'context_reset',
            chatId: 'none',
            timestamp: Date.now()
          }
        });
      }

      this._notifyArtifactsOfChatSwitch(null);

      // Reset UI title
      if (this.eventBus) {
        this.eventBus.emit('chat:title-changed', { title: 'New Chat' });
      }

    } catch (error) {
      this.log.error('Failed to clear chat', { error });
    }
  }

  /**
   * Load existing chat
   * @param {string} chatId - Chat ID to load
   * @param {Object} [options]
   * @param {boolean} [options.force=false] - Force reload even if active
   * @param {string} [options.reason='unknown'] - Caller context for logging
   * @returns {Promise<void>}
   */
  async loadChat(chatId, options = {}) {
    if (this._isDisposed) {
      this.log.warn('loadChat called on disposed ChatLifecycleManager', { chatId });
      return;
    }
    const { force = false, reason = 'unknown' } = options || {};
    this.log.info('Loading chat session', { chatId, force, reason });

    try {
      const currentChatId = this.messageState?.getCurrentChatId
        ? this.messageState.getCurrentChatId()
        : this.messageState?.currentChatId;
      const hasRenderedMessages = !!(
        this.messageView?.messageElements &&
        this.messageView.messageElements.size > 0
      );

      if (!force && chatId && currentChatId === chatId && hasRenderedMessages) {
        this.log.info('Chat already active; skipping reload', { chatId, reason });
        return;
      }

      if (this._activeLoad && this._activeLoad.chatId === chatId) {
        this.log.warn('Chat load already in progress; skipping duplicate request', { chatId, reason });
        return this._activeLoad.promise;
      }

      const loadPromise = (async () => {
        // Show loading immediately
        this.messageView.showLoadingState();

        // Load chat via MessageState
        const chat = await this.messageState.loadChat(chatId);

        // LIFECYCLE GUARD: Abort if disposed during async loadChat
        if (this._isDisposed) {
          this.log.warn('loadChat aborted: disposed during messageState.loadChat', { chatId });
          return;
        }

        // Emit title change event
        if (chat && chat.title && this.eventBus) {
          this.eventBus.emit('chat:title-changed', { title: chat.title });
        }

        // Trail state will be restored after DOM is ready (see setTimeout below)

        // Clear and rebuild message view
        this.messageView.hideLoadingState();
        this.messageView.clear();

        // Set active session
        await sessionBridge.setActiveChat(chatId);

        // LIFECYCLE GUARD: Abort if disposed during async setActiveChat
        if (this._isDisposed) {
          this.log.warn('loadChat aborted: disposed during setActiveChat', { chatId });
          return;
        }

        this.log.debug('Active session set', { chatId });

        // Notify backend of context switch
        await this._notifyBackendContextSwitch(chatId);

        // LIFECYCLE GUARD: Abort if disposed during backend notification
        if (this._isDisposed) {
          this.log.warn('loadChat aborted: disposed during backend context switch', { chatId });
          return;
        }

        // Notify artifacts window of chat switch
        this._notifyArtifactsOfChatSwitch(chatId);

        // Get messages from state
        const messages = this.messageState.getMessages();

        // Show empty state or render messages (async batched)
        if (messages.length === 0) {
          this.messageView.showEmptyState();
        } else {
          // Use async rendering if available, fallback to sync
          if (typeof this.messageView.renderMessages === 'function') {
            await this.messageView.renderMessages(messages);
          } else {
            for (const message of messages) {
              this.messageView.renderMessage(message);
            }
          }
        }

        // LIFECYCLE GUARD: Abort if disposed during message rendering
        if (this._isDisposed) {
          this.log.warn('loadChat aborted: disposed during message rendering', { chatId });
          return;
        }

        // CRITICAL: Wait for next tick to ensure DOM is ready before restoring trails
        await new Promise(resolve => setTimeout(resolve, 0));

        // Request complete session map restoration via EventBus
        // Application layer will fetch session map and emit SESSION_MAP_LOADED event
        // This provides unified restoration of messages, artifacts, and trails
        if (this.eventBus) {
          this.log.info('Requesting session map restoration', { chatId });
          this.eventBus.emit('session:restoration:requested', { chatId });
        } else {
          this.log.warn('EventBus not available - cannot request session restoration');
        }

        this.log.info('Chat loaded', { chatId, messageCount: messages.length });
      })();

      this._activeLoad = { chatId, promise: loadPromise };
      await loadPromise;
    } catch (error) {
      this.log.error('Failed to load chat', { chatId, error });
    } finally {
      if (this._activeLoad?.chatId === chatId) {
        this._activeLoad = null;
      }
    }
  }

  /**
   * Notify backend to reset context when switching/creating chats
   * @private
   * @param {string} chatId - Chat ID
   */
  async _notifyBackendContextSwitch(chatId) {
    try {
      this.log.trace('Notifying backend of context switch', { chatId });

      if (!this.ipc || typeof this.ipc.send !== 'function') {
        this.log.error('IPC bridge REQUIRED for context reset', { chatId });
        throw new Error('IPC bridge is REQUIRED - no fallbacks');
      }

      // CONTRACT: context_reset is a control message - NO requestId required
      // Backend schema (ContextResetMessage) only requires: role, type, chat_id, timestamp (optional)
      // Backend handler doesn't use or expect requestId
      this.ipc.send('chat:send', {
        message: '',
        chatId,
        metadata: {
          type: 'context_reset',
          chatId,
          timestamp: Date.now()
        }
      });
      this.log.trace('Context reset sent via IPC bridge', { chatId });
    } catch (error) {
      this.log.error('Failed to notify backend of context switch', { chatId, error });
      throw error; // Fatal - context reset is REQUIRED
    }
  }

  /**
   * Notify artifacts window of chat switch
   * @private
   * @param {string} chatId - Chat ID
   */
  _notifyArtifactsOfChatSwitch(chatId) {
    if (this.aether?.artifacts && typeof this.aether.artifacts.switchChat === 'function') {
      this.aether.artifacts.switchChat(chatId);
      this.log.trace('Notified artifacts renderer of chat switch', { chatId });
    } else if (this.ipc && typeof this.ipc.send === 'function') {
      this.ipc.send('artifacts:switch-chat', chatId);
      this.log.trace('Notified artifacts window via IPC', { chatId });
    }
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    if (this._isDisposed) return;

    // 1. Set disposed flag FIRST — in-flight async operations check this flag
    //    before accessing references. Setting it after nulling refs creates a
    //    race: async resume sees _isDisposed=false, proceeds, hits null refs.
    this._isDisposed = true;

    // 2. Clear in-flight load (prevents orphaned promise from operating on null refs)
    this._activeLoad = null;

    // 3. Release references (safe now — async guards will abort before reaching these)
    this.messageState = null;
    this.messageView = null;
    this.eventBus = null;
    this.ipc = null;
    this.trailOrchestrator = null;

    this.log.info('ChatLifecycleManager disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ChatLifecycleManager;
}

if (typeof window !== 'undefined') {
  window.ChatLifecycleManager = ChatLifecycleManager;
}
