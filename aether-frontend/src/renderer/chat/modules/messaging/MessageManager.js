'use strict';

/**
 * @.architecture
 * 
 * Incoming: IPC 'chat:assistant-stream', 'chat:request-complete' (from ChatController.js) --- {stream_types.ipc_stream_chunk, json}
 * Processing: Coordinate 7 submodules (SecuritySanitizer, MarkdownRenderer, MessageView, MessageState, SendController, StopController, StreamHandler), route IPC to StreamHandler, handle user input --- {8 jobs: JOB_DELEGATE_TO_MODULE, JOB_DISPOSE, JOB_EMIT_EVENT, JOB_GENERATE_SESSION_ID, JOB_GET_STATE, JOB_INITIALIZE, JOB_ROUTE_BY_TYPE, JOB_UPDATE_STATE}
 * Outgoing: streamHandler.processChunk() → StreamHandler.js, sendController.send() → Endpoint.js --- {message_types.user_message | method_call, json}
 * 
 * 
 * @module renderer/chat/modules/messaging/MessageManager
 */

const SecuritySanitizer = require('./SecuritySanitizer');
const MarkdownRenderer = require('./MarkdownRenderer');
const MessageView = require('./MessageView');
const MessageState = require('./MessageState');
const SendController = require('./SendController');
const StopController = require('./StopController');
const StreamHandler = require('./StreamHandler');
const { sessionManager, ID_TYPES } = require('../../../../core/session/SessionManager');

class MessageManager {
  constructor(options = {}) {
    // Dependencies
    this.chatWindow = options.chatWindow || null;
    this.eventBus = options.eventBus || null;
    this.ipcBridge = options.ipcBridge || null;
    this.endpoint = options.endpoint || null;

    // Modules
    this.securitySanitizer = null;
    this.markdownRenderer = null;
    this.messageView = null;
    this.messageState = null;
    this.sendController = null;
    this.stopController = null;
    this.streamHandler = null;

    // DOM references (populated on init)
    this.inputElement = null;
    this.sendButton = null;
    this.contentElement = null;

    // State
    this.isProcessing = false;
    this.isStopMode = false;

    // IPC listeners tracking
    this._ipcListeners = [];

    console.log('[MessageManager] Constructed');
  }

  /**
   * Initialize message manager
   * Creates modules and sets up event listeners
   */
  async init() {
    console.log('[MessageManager] Initializing...');

    try {
      // Get DOM elements from ChatWindow
      if (!this.chatWindow) {
        throw new Error('ChatWindow required for initialization');
      }

      const elements = this.chatWindow.getElements();
      this.inputElement = elements.input;
      this.sendButton = elements.sendBtn;
      this.contentElement = elements.content;

      if (!this.inputElement || !this.sendButton || !this.contentElement) {
        throw new Error('Required DOM elements not found');
      }

      // Initialize modules
      await this._initializeModules();

      // Setup event listeners
      this._setupEventListeners();

      // Setup IPC listeners
      this._setupIPCListeners();

      // Setup WebSocket listeners
      this._setupWebSocketListeners();

      console.log('[MessageManager] Initialization complete');
    } catch (error) {
      console.error('[MessageManager] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Initialize all messaging modules
   * @private
   */
  async _initializeModules() {
    console.log('[MessageManager] Initializing modules...');

    // 1. SecuritySanitizer (no dependencies)
    this.securitySanitizer = new SecuritySanitizer();

    // 2. MarkdownRenderer (depends on SecuritySanitizer)
    this.markdownRenderer = new MarkdownRenderer({
      securitySanitizer: this.securitySanitizer
    });

    // 3. MessageView (depends on MarkdownRenderer)
    this.messageView = new MessageView({
      markdownRenderer: this.markdownRenderer,
      securitySanitizer: this.securitySanitizer,
      eventBus: this.eventBus
    });
    this.messageView.init(this.contentElement);

    // 4. MessageState (PostgreSQL persistence)
    this.messageState = new MessageState({
      eventBus: this.eventBus,
      ipcBridge: this.ipcBridge
    });
    await this.messageState.init();

    // 5. SendController (message sending)
    this.sendController = new SendController({
      endpoint: this.endpoint,
      ipcBridge: this.ipcBridge,
      eventBus: this.eventBus
    });
    this.sendController.init();

    // 6. StopController (request cancellation)
    this.stopController = new StopController({
      endpoint: this.endpoint,
      ipcBridge: this.ipcBridge,
      eventBus: this.eventBus,
      sendController: this.sendController
    });
    this.stopController.init();

    // 7. StreamHandler (streaming processing)
    this.streamHandler = new StreamHandler({
      messageView: this.messageView,
      messageState: this.messageState,
      eventBus: this.eventBus
    });
    this.streamHandler.init();

    console.log('[MessageManager] ✅ All modules initialized');
  }

  /**
   * Setup event listeners for user input
   * @private
   */
  _setupEventListeners() {
    // Send button click
    if (this.sendButton) {
      this.sendButton.addEventListener('click', () => this._handleSend());
    }

    // Enter key in input
    if (this.inputElement) {
      this.inputElement.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this._handleSend();
        }
      });

      // Auto-resize textarea
      this.inputElement.addEventListener('input', () => {
        this._autoResizeInput();
      });
    }

    console.log('[MessageManager] Event listeners setup');
  }

  /**
   * Setup IPC listeners for streaming
   * @private
   */
  _setupIPCListeners() {
    if (!this.ipcBridge) {
      console.warn('[MessageManager] No IPC bridge - streaming disabled');
      return;
    }

    // Listen for assistant streams
    // CRITICAL: Make async and await processChunk to prevent race conditions
    const onAssistantStream = async (_, data) => {
      console.log('[MessageManager] Received assistant stream chunk');
      await this.streamHandler.processChunk(data);
    };

    // Listen for stream completion
    // CRITICAL: Make async and await forceFinalize
    const onRequestComplete = async (_, data) => {
      console.log('[MessageManager] Request complete:', data);
      this.setProcessing(false);
      this.setStopMode(false);
      await this.streamHandler.forceFinalize();
    };

    this.ipcBridge.on('chat:assistant-stream', onAssistantStream);
    this.ipcBridge.on('chat:request-complete', onRequestComplete);

    // Track for cleanup
    this._ipcListeners.push({ 
      channel: 'chat:assistant-stream', 
      handler: onAssistantStream 
    });
    this._ipcListeners.push({ 
      channel: 'chat:request-complete', 
      handler: onRequestComplete 
    });

    console.log('[MessageManager] IPC listeners setup');
  }

  /**
   * Setup WebSocket listeners for direct endpoint communication
   * @private
   * 
   * NOTE: Chat window has DIRECT WebSocket access via window.endpoint/window.guru.
   * The endpoint is created in ChatController._initializeCore() and made globally available.
   * We listen to GuruConnection 'message' events for assistant responses.
   */
  _setupWebSocketListeners() {
    if (!this.endpoint || !this.endpoint.connection) {
      console.warn('[MessageManager] No endpoint connection - WebSocket streaming disabled');
      return;
    }

    // Listen for WebSocket messages from GuruConnection
    this.endpoint.connection.on('message', (payload) => {
      this._handleWebSocketMessage(payload);
    });

    console.log('[MessageManager] WebSocket listeners enabled (direct connection)');
  }

  /**
   * Handle incoming WebSocket message
   * @private
   * @param {Object} payload - WebSocket message payload
   */
  _handleWebSocketMessage(payload) {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    const { role, type, content, start, end, id } = payload;

    // Handle assistant message streams
    if (role === 'assistant' && type === 'message') {
      // Start marker
      if (start) {
        console.log(`[MessageManager] Stream started: ${id}`);
        this.streamHandler.processChunk({
          id,
          chunk: '',
          start: true
        });
        return;
      }

      // End marker
      if (end) {
        console.log(`[MessageManager] Stream ended: ${id}`);
        this.streamHandler.processChunk({
          id,
          chunk: '',
          done: true
        });
        this.setProcessing(false);
        this.setStopMode(false);
        return;
      }

      // Content delta
      if (content) {
        this.streamHandler.processChunk({
          id,
          chunk: content
        });
      }
    }

    // Handle completion signal
    if (role === 'server' && type === 'completion') {
      console.log(`[MessageManager] Request complete: ${id}`);
      this.setProcessing(false);
      this.setStopMode(false);
      this.streamHandler.forceFinalize();
    }

    // Handle stop confirmation
    if (role === 'server' && type === 'stopped') {
      console.log(`[MessageManager] Request stopped: ${id}`);
      this.setProcessing(false);
      this.setStopMode(false);
      this.streamHandler.forceFinalize();
    }

    // Handle errors
    if (type === 'error') {
      console.error('[MessageManager] Backend error:', payload);
      this.setProcessing(false);
      this.setStopMode(false);
    }
  }

  /**
   * Handle send button/enter key
   * @private
   */
  async _handleSend() {
    // If in stop mode, stop the request
    if (this.isStopMode) {
      await this.stop();
      return;
    }

    // Get input value
    const content = this.inputElement.value.trim();

    if (!content) {
      console.log('[MessageManager] Empty input, ignoring');
      return;
    }

    // Send message
    await this.sendMessage(content);
  }

  /**
   * Send a message
   * @param {string} content - Message content
   * @param {Object} options - Send options
   * @returns {Promise<void>}
   */
  async sendMessage(content, options = {}) {
    console.log('[MessageManager] Sending message:', content.substring(0, 50));

    try {
      // Add user message to view and state
      const userMessage = {
        id: this._generateMessageId(),
        role: 'user',
        content: content,
        timestamp: new Date().toISOString()
      };

      this.messageView.renderMessage(userMessage);
      await this.messageState.saveMessage(userMessage);

      // Set user message ID in StreamHandler for proper parent-child linking
      if (this.streamHandler) {
        this.streamHandler.userMessageId = userMessage.id;
      }

      // Clear input
      if (this.inputElement) {
        this.inputElement.value = '';
        this._autoResizeInput();
      }

      // Set processing state
      this.setProcessing(true);
      this.setStopMode(true);

      // Send via SendController
      const requestId = await this.sendController.send(content, {
        correlationId: userMessage.id
      });

      console.log(`[MessageManager] Message sent with requestId: ${requestId}`);
    } catch (error) {
      console.error('[MessageManager] Failed to send message:', error);
      this.setProcessing(false);
      this.setStopMode(false);
    }
  }

  /**
   * Stop current request
   * @returns {Promise<void>}
   */
  async stop() {
    console.log('[MessageManager] Stopping request...');

    try {
      await this.stopController.stop();
      this.setProcessing(false);
      this.setStopMode(false);

      // Finalize any active stream
      if (this.streamHandler.isStreaming()) {
        await this.streamHandler.forceFinalize();
      }
    } catch (error) {
      console.error('[MessageManager] Failed to stop:', error);
    }
  }

  /**
   * Add a message (programmatically)
   * @param {string} content - Message content
   * @param {string} role - Message role (user|assistant|system)
   * @param {Object} options - Additional options
   */
  async addMessage(content, role = 'system', options = {}) {
    console.log(`[MessageManager] Adding ${role} message`);

    const message = {
      id: options.id || this._generateMessageId(),
      role,
      content,
      timestamp: options.timestamp || new Date().toISOString()
    };

    // Render to view
    this.messageView.renderMessage(message);

    // Save to state (unless it's a streaming assistant message)
    if (role !== 'assistant' || options.persist) {
      await this.messageState.saveMessage(message);
    }

    return message;
  }

  /**
   * Clear all messages
   */
  clearMessages() {
    console.log('[MessageManager] Clearing messages');
    this.messageView.clear();
    this.messageState.clearMessages();
  }

  async loadChat(chatId) {
    console.log(`[MessageManager] Loading chat: ${chatId}`);

    try {
      await this.messageState.loadChat(chatId);
      this.messageView.clear();
      
      // Set active session in SessionManager
      sessionManager.setActiveChat(chatId);

      const messages = this.messageState.getMessages();
      
      if (messages.length === 0) {
        this.messageView.showEmptyState();
      } else {
        for (const message of messages) {
          this.messageView.renderMessage(message);
        }
      }

      console.log(`[MessageManager] Loaded ${messages.length} messages`);
    } catch (error) {
      console.error('[MessageManager] Failed to load chat:', error);
    }
  }

  /**
   * Create a new chat
   * @param {string} title - Chat title
   */
  async createChat(title = 'New Chat') {
    console.log(`[MessageManager] Creating new chat: ${title}`);

    try {
      const chatId = await this.messageState.createChat(title);
      this.clearMessages();
      
      // Set active session in SessionManager
      sessionManager.setActiveChat(chatId);
      
      return chatId;
    } catch (error) {
      console.error('[MessageManager] Failed to create chat:', error);
      throw error;
    }
  }

  /**
   * Set processing state
   * @param {boolean} processing
   */
  setProcessing(processing) {
    this.isProcessing = processing;

    // Emit event
    if (this.eventBus) {
      this.eventBus.emit('message:processing', { processing });
    }
  }

  /**
   * Set stop mode (stop button visible)
   * @param {boolean} enabled
   */
  setStopMode(enabled) {
    this.isStopMode = enabled;

    if (this.sendButton) {
      if (enabled) {
        this.sendButton.classList.add('stop-mode');
        this.sendButton.innerHTML = '⏹';
        this.sendButton.title = 'Stop generation';
      } else {
        this.sendButton.classList.remove('stop-mode');
        this.sendButton.innerHTML = '▶';
        this.sendButton.title = 'Send message';
      }
    }

    // Emit event
    if (this.eventBus) {
      this.eventBus.emit('message:stop-mode', { enabled });
    }
  }

  /**
   * Auto-resize input textarea
   * @private
   */
  _autoResizeInput() {
    if (!this.inputElement) return;

    this.inputElement.style.height = 'auto';
    this.inputElement.style.height = `${Math.min(this.inputElement.scrollHeight, 150)}px`;
  }

  /**
   * Generate message ID using SessionManager
   * @private
   * @returns {string}
   */
  _generateMessageId() {
    // Use SessionManager for deterministic, traceable IDs
    return sessionManager.nextUserMessageId();
  }
  
  /**
   * Generate assistant message ID
   * @private
   * @param {string} userMessageId - Parent user message ID
   * @returns {string}
   */
  _generateAssistantMessageId(userMessageId = null) {
    return sessionManager.nextAssistantMessageId(userMessageId);
  }

  /**
   * Get stats
   * @returns {Object}
   */
  getStats() {
    return Object.freeze({
      messageCount: this.messageView ? this.messageView.getMessageCount() : 0,
      isProcessing: this.isProcessing,
      isStopMode: this.isStopMode,
      isStreaming: this.streamHandler ? this.streamHandler.isStreaming() : false,
      currentChatId: this.messageState ? this.messageState.getCurrentChatId() : null
    });
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    console.log('[MessageManager] Disposing...');

    // Remove IPC listeners
    for (const { channel, handler } of this._ipcListeners) {
      try {
        if (this.ipcBridge) {
          this.ipcBridge.off(channel, handler);
        }
      } catch (error) {
        console.warn(`[MessageManager] Failed to remove IPC listener ${channel}:`, error);
      }
    }
    this._ipcListeners = [];

    // Dispose modules
    if (this.streamHandler) this.streamHandler.dispose();
    if (this.stopController) this.stopController.dispose();
    if (this.sendController) this.sendController.dispose();
    if (this.messageState) this.messageState.dispose();
    if (this.messageView) this.messageView.dispose();
    if (this.markdownRenderer) this.markdownRenderer.dispose();
    if (this.securitySanitizer) this.securitySanitizer.dispose();

    // Clear references
    this.securitySanitizer = null;
    this.markdownRenderer = null;
    this.messageView = null;
    this.messageState = null;
    this.sendController = null;
    this.stopController = null;
    this.streamHandler = null;
    this.chatWindow = null;
    this.eventBus = null;
    this.ipcBridge = null;
    this.endpoint = null;
    this.inputElement = null;
    this.sendButton = null;
    this.contentElement = null;

    console.log('[MessageManager] Disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MessageManager;
}

if (typeof window !== 'undefined') {
  window.MessageManager = MessageManager;
  console.log('📦 MessageManager loaded');
}

