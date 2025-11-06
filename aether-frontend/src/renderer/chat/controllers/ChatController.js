'use strict';

/**
 * @.architecture
 * 
 * Incoming: IPC 'chat:assistant-stream', 'chat:request-complete', 'chat:ensure-visible', EventBus 'artifact:stream' (from MessageManager via WebSocket) --- {ipc_stream_chunk | artifact_types.*, json}
 * Processing: Coordinate 6 modules (ChatWindow, DragResizeManager, MessageManager, FileManager, SidebarManager, ThinkingBubble), setup IPC/event listeners, manage chat lifecycle, enrich artifacts with chatId from messageManager.messageState.currentChatId, forward to artifacts window via IPC --- {5 jobs: JOB_DELEGATE_TO_MODULE, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_INITIALIZE, JOB_ROUTE_BY_TYPE}
 * Outgoing: MessageManager/SidebarManager/FileManager (module delegation), window.aether.artifacts.streamReady() (artifact routing with chatId) --- {method_calls | ipc_artifact_stream, javascript_api | json}
 * 
 * 
 * @module renderer/chat/controllers/ChatController
 * 
 * ChatController - Chat Window Orchestrator
 * ============================================================================
 * Coordinates all chat window modules and manages chat application state.
 * 
 * Responsibilities:
 * - Initialize core dependencies (Endpoint, EventBus, IPC)
 * - Coordinate modules (MessageManager, ChatWindow, FileManager, Sidebar)
 * - Manage chat lifecycle and state
 * - Handle message streaming and display
 * - Coordinate with artifacts window
 * - Manage file attachments
 * 
 * Architecture:
 * - Uses dependency injection for all services
 * - Event-driven communication between modules
 * - Clean separation of concerns
 * - Production-ready error handling and cleanup
 */

const Endpoint = require('../../../core/communication/Endpoint');
const { EventTypes, EventPriority } = require('../../../core/events/EventTypes');
const { freeze } = Object;

class ChatController {
  constructor(options = {}) {
    if (!options.container) {
      throw new Error('[ChatController] DI container required');
    }

    if (!options.eventBus) {
      throw new Error('[ChatController] EventBus required');
    }

    if (!options.config) {
      throw new Error('[ChatController] Config required');
    }

    this.container = options.container;
    this.eventBus = options.eventBus;
    this.config = options.config;
    this.ipc = options.ipc;

    // Modules (will be initialized)
    this.modules = {};
    
    // State
    this.initialized = false;
    this.backendConnected = false;
    this.currentChatId = null;
    this.isDetachedWindow = this._detectDetachedMode();
    this.isProcessing = false;
    this.currentStreamingMessageId = null;
    
    // IPC listeners for cleanup
    this._ipcListeners = [];
    this._eventListeners = [];

    // Bind methods
    this._handleAssistantStream = this._handleAssistantStream.bind(this);
    this._handleRequestComplete = this._handleRequestComplete.bind(this);
    this._handleEnsureVisible = this._handleEnsureVisible.bind(this);
    this._handleArtifactStream = this._handleArtifactStream.bind(this);
    this._handleBackendOnline = this._handleBackendOnline.bind(this);
    this._handleBackendOffline = this._handleBackendOffline.bind(this);
  }

  /**
   * Initialize chat controller
   */
  async init() {
    console.log('🎯 ChatController: Initializing...');

    try {
      // Phase 1: Core initialization
      await this._initializeCore();

      // Phase 2: Register services in DI container
      await this._registerServices();

      // Phase 3: Initialize modules
      await this._initializeModules();

      // Phase 4: Setup event listeners
      await this._setupEventListeners();

      // Phase 5: Setup IPC listeners
      await this._setupIpcListeners();

      // Phase 6: Initialize global state
      await this._initializeGlobalState();

      // Phase 7: Load existing messages
      await this._loadExistingMessages();

      this.initialized = true;

      console.log('✅ ChatController: Initialization complete');
      this.eventBus.emit(EventTypes.SYSTEM.READY, { 
        controller: 'ChatController',
        timestamp: Date.now(),
        isDetachedWindow: this.isDetachedWindow
      }, { priority: EventPriority.HIGH });

    } catch (error) {
      console.error('❌ ChatController: Initialization failed:', error);
      this.eventBus.emit(EventTypes.SYSTEM.ERROR, { 
        error,
        phase: 'initialization',
        fatal: true,
        controller: 'ChatController'
      });
      throw error;
    }
  }

  /**
   * Dispose controller and cleanup resources
   */
  dispose() {
    console.log('🛑 ChatController: Disposing...');

    // Dispose modules in reverse initialization order
    const moduleNames = Object.keys(this.modules).reverse();
    for (const name of moduleNames) {
      try {
        if (this.modules[name] && typeof this.modules[name].dispose === 'function') {
          console.log(`[ChatController] Disposing ${name}...`);
          this.modules[name].dispose();
        }
      } catch (error) {
        console.error(`[ChatController] Failed to dispose ${name}:`, error);
      }
    }

    // Clear module references
    this.modules = {};

    // Remove IPC listeners
    for (const cleanup of this._ipcListeners) {
      try {
        cleanup();
      } catch (error) {
        console.error('[ChatController] Failed to cleanup IPC listener:', error);
      }
    }
    this._ipcListeners = [];

    // Remove event listeners
    for (const cleanup of this._eventListeners) {
      try {
        cleanup();
      } catch (error) {
        console.error('[ChatController] Failed to cleanup event listener:', error);
      }
    }
    this._eventListeners = [];

    console.log('✅ ChatController: Disposed');
  }

  /**
   * Send message to chat
   * @param {string} content - Message content
   * @param {Object} options - Send options
   */
  async sendMessage(content, options = {}) {
    if (!this.modules.messageManager) {
      throw new Error('[ChatController] MessageManager not initialized');
    }

    if (!content || typeof content !== 'string') {
      throw new Error('[ChatController] Invalid message content');
    }

    try {
      this.isProcessing = true;
      this.eventBus.emit(EventTypes.CHAT.MESSAGE_SENDING, { content, options });

      await this.modules.messageManager.send(content, options);

      this.eventBus.emit(EventTypes.CHAT.MESSAGE_SENT, { content, options });
    } catch (error) {
      console.error('[ChatController] Send message failed:', error);
      this.eventBus.emit(EventTypes.CHAT.MESSAGE_ERROR, { error, content });
      throw error;
    }
  }

  /**
   * Stop current message processing
   */
  stopProcessing() {
    if (!this.isProcessing) {
      return;
    }

    try {
      this.eventBus.emit(EventTypes.CHAT.STOP_REQUESTED, { 
        timestamp: Date.now(),
        messageId: this.currentStreamingMessageId
      });

      // Send stop via IPC
      if (window.aether && window.aether.chat && window.aether.chat.stop) {
        window.aether.chat.stop();
      }

      this.isProcessing = false;
      this.currentStreamingMessageId = null;

      console.log('[ChatController] Processing stopped');
    } catch (error) {
      console.error('[ChatController] Stop processing failed:', error);
    }
  }

  /**
   * Get controller statistics
   * @returns {Object}
   */
  getStats() {
    return freeze({
      initialized: this.initialized,
      backendConnected: this.backendConnected,
      currentChatId: this.currentChatId,
      isDetachedWindow: this.isDetachedWindow,
      isProcessing: this.isProcessing,
      modules: Object.keys(this.modules),
      endpoint: this.modules.endpoint ? this.modules.endpoint.getStats() : null,
      messageCount: this.modules.messageManager ? this.modules.messageManager.messages.length : 0
    });
  }

  // ============================================================================
  // Private Initialization Methods
  // ============================================================================

  /**
   * Detect if we're in detached window mode
   * @private
   * @returns {boolean}
   */
  _detectDetachedMode() {
    if (typeof window === 'undefined') return false;

    const isInChatHtml = window.location.pathname.includes('chat.html') || 
                        window.location.pathname.endsWith('chat.html');
    
    const hasDetachedFlag = window.DETACHED_CHAT === true;
    
    const hasDetachedAPI = window.aether && window.aether.isDetachedWindow === true;

    return isInChatHtml || hasDetachedFlag || hasDetachedAPI;
  }

  /**
   * Initialize core dependencies
   * @private
   */
  async _initializeCore() {
    console.log('📦 ChatController: Initializing core...');

    // Get or create Endpoint singleton (may already exist from main window)
    let endpoint;
    
    if (this.container.has('endpoint')) {
      endpoint = this.container.resolve('endpoint');
    } else {
      endpoint = new Endpoint({
        API_BASE_URL: this.config.API_BASE_URL,
        WS_URL: this.config.WS_URL,
        NODE_ENV: this.config.NODE_ENV
      });

      this.container.register('endpoint', () => endpoint, { singleton: true });
    }

    // Store in modules
    this.modules.endpoint = endpoint;

    // Make globally available (for debugging and legacy compatibility)
    window.endpoint = endpoint;
    window.guru = endpoint.connection;

    // Generate chat ID
    this.currentChatId = this._generateChatId();

    console.log('✅ ChatController: Core initialized');
  }

  /**
   * Register services in DI container
   * @private
   */
  async _registerServices() {
    console.log('📦 ChatController: Registering services...');

    // Services are already registered by chat renderer bootstrap
    // Additional services can be registered here if needed

    console.log('✅ ChatController: Services registered');
  }

  /**
   * Initialize modules in dependency order
   * @private
   */
  async _initializeModules() {
    console.log('📦 ChatController: Initializing modules...');

    // 1. ChatWindow (window lifecycle and DOM)
    try {
      const ChatWindow = require('../modules/window/ChatWindow');
      this.modules.chatWindow = new ChatWindow({
        controller: this,
        eventBus: this.eventBus,
        container: document.body
      });
      await this.modules.chatWindow.init();
      console.log('✅ ChatWindow initialized');
    } catch (error) {
      console.error('❌ ChatWindow initialization failed:', error);
      throw error;
    }

    // 2. DragResizeManager (window drag/resize)
    try {
      const DragResizeManager = require('../modules/window/DragResizeManager');
      this.modules.dragResizeManager = new DragResizeManager({
        chatWindow: this.modules.chatWindow,
        eventBus: this.eventBus
      });
      await this.modules.dragResizeManager.init({
        isDetached: this.isDetachedWindow
      });
      console.log('✅ DragResizeManager initialized');
    } catch (error) {
      console.error('❌ DragResizeManager initialization failed:', error);
      throw error;
    }

    // 3. MessageManager (message handling)
    try {
      const MessageManager = require('../modules/messaging/MessageManager');
      this.modules.messageManager = new MessageManager({
        chatWindow: this.modules.chatWindow,
        eventBus: this.eventBus,
        ipcBridge: this.ipc,
        endpoint: window.endpoint || null
      });
      await this.modules.messageManager.init();
      console.log('✅ MessageManager initialized');
    } catch (error) {
      console.error('❌ MessageManager initialization failed:', error);
      throw error;
    }

    // 4. FileManager (file attachments)
    try {
      const FileManager = require('../modules/files/FileManager');
      this.modules.fileManager = new FileManager({
        chatWindow: this.modules.chatWindow,
        eventBus: this.eventBus,
        ipcBridge: this.ipc,
        endpoint: window.endpoint || null
      });
      await this.modules.fileManager.init();
      console.log('✅ FileManager initialized');
    } catch (error) {
      console.error('❌ FileManager initialization failed:', error);
      throw error;
    }

    // 5. SidebarManager (chat list sidebar)
    try {
      const SidebarManager = require('../modules/sidebar/SidebarManager');
      this.modules.sidebarManager = new SidebarManager({
        chatWindow: this.modules.chatWindow,
        messageManager: this.modules.messageManager,
        eventBus: this.eventBus
      });
      await this.modules.sidebarManager.init();
      console.log('✅ SidebarManager initialized');
    } catch (error) {
      console.error('❌ SidebarManager initialization failed:', error);
      throw error;
    }

    // 6. ThinkingBubble (thinking indicator)
    try {
      const ThinkingBubble = require('../modules/thinking/ThinkingBubble');
      // Create container for thinking bubble in chat content
      const thinkingContainer = document.createElement('div');
      thinkingContainer.className = 'aether-thinking-container';
      thinkingContainer.style.cssText = 'width: 100%; padding: 0;';
      
      // Find chat content area and append thinking container
      const chatContent = this.modules.chatWindow.elements.content;
      if (chatContent) {
        chatContent.appendChild(thinkingContainer);
      }
      
      this.modules.thinkingBubble = new ThinkingBubble({
        parentElement: thinkingContainer,
        initialState: 'collapsed'
      });
      this.modules.thinkingBubble.init();
      console.log('✅ ThinkingBubble initialized');
    } catch (error) {
      console.error('❌ ThinkingBubble initialization failed:', error);
      throw error;
    }

    console.log('✅ ChatController: Modules initialized');
  }

  /**
   * Setup event listeners
   * @private
   */
  async _setupEventListeners() {
    console.log('📦 ChatController: Setting up event listeners...');

    // Backend online/offline
    const cleanupBackendOnline = this.eventBus.on(
      EventTypes.CONNECTION.BACKEND_ONLINE,
      this._handleBackendOnline,
      { priority: EventPriority.HIGH }
    );
    this._eventListeners.push(cleanupBackendOnline);

    const cleanupBackendOffline = this.eventBus.on(
      EventTypes.CONNECTION.BACKEND_OFFLINE,
      this._handleBackendOffline,
      { priority: EventPriority.HIGH }
    );
    this._eventListeners.push(cleanupBackendOffline);

    // New Chat button
    const cleanupNewChat = this.eventBus.on('chat:new-requested', async () => {
      try {
        console.log('[ChatController] New chat requested');
        await this.modules.messageManager.createChat('New Chat');
        await this.modules.sidebarManager.refreshChatList();
      } catch (error) {
        console.error('[ChatController] Failed to create new chat:', error);
      }
    });
    this._eventListeners.push(cleanupNewChat);

    // Clear Chat button
    const cleanupClearChat = this.eventBus.on('chat:clear-requested', () => {
      try {
        console.log('[ChatController] Clear chat requested');
        this.modules.messageManager.clearMessages();
      } catch (error) {
        console.error('[ChatController] Failed to clear chat:', error);
      }
    });
    this._eventListeners.push(cleanupClearChat);

    // Artifact stream from MessageManager (WebSocket artifacts)
    const cleanupArtifactStream = this.eventBus.on('artifact:stream', (payload) => {
      try {
        console.log('[ChatController] Artifact from WebSocket - forwarding to artifacts window');
        this._handleArtifactStream(payload);
      } catch (error) {
        console.error('[ChatController] Failed to handle artifact stream:', error);
      }
    });
    this._eventListeners.push(cleanupArtifactStream);

    console.log('✅ ChatController: Event listeners setup');
  }

  /**
   * Setup IPC listeners
   * @private
   */
  async _setupIpcListeners() {
    console.log('📦 ChatController: Setting up IPC listeners...');

    // Listen for assistant stream
    const cleanupAssistantStream = window.aether.chat.onAssistantStream((chunk, metadata) => {
      this._handleAssistantStream(chunk, metadata);
    });
    this._ipcListeners.push(cleanupAssistantStream);

    // Listen for request complete
    const cleanupRequestComplete = window.aether.chat.onRequestComplete((data) => {
      this._handleRequestComplete(data);
    });
    this._ipcListeners.push(cleanupRequestComplete);

    // Listen for ensure visible
    const cleanupEnsureVisible = window.aether.chat.onEnsureVisible(() => {
      this._handleEnsureVisible();
    });
    this._ipcListeners.push(cleanupEnsureVisible);

    // Listen for artifact stream (Stage 1) and forward enriched to artifacts window (Stage 2)
    const cleanupArtifactStream = window.aether.artifacts.onStream((data) => {
      this._handleArtifactStream(data);
    });
    this._ipcListeners.push(cleanupArtifactStream);

    // Listen for STT stream (hands-free voice input)
    const cleanupSttStream = window.aether.chat.onSttStream((data) => {
      this._handleSttStream(data);
    });
    this._ipcListeners.push(cleanupSttStream);

    console.log('✅ ChatController: IPC listeners setup');
  }

  /**
   * Initialize global state
   * @private
   */
  async _initializeGlobalState() {
    console.log('📦 ChatController: Initializing global state...');

    // Get backend health
    try {
      const health = await this.modules.endpoint.getHealth();
      console.log('[ChatController] Backend health:', health);
      
      this.backendConnected = true;
      this.eventBus.emit(EventTypes.CONNECTION.BACKEND_ONLINE, { health });

    } catch (error) {
      console.warn('[ChatController] Backend health check failed:', error);
      this.backendConnected = false;
      this.eventBus.emit(EventTypes.CONNECTION.BACKEND_OFFLINE, { error });
    }

    // Make controller globally accessible
    window.chatController = this;

    // Setup global log function
    window.logToMain = (...args) => {
      try {
        const message = args.map(a => 
          typeof a === 'object' ? JSON.stringify(a) : String(a)
        ).join(' ');
        
        window.aether.log.send(message);
      } catch (error) {
        console.error('[ChatController] Failed to log to main:', error);
      }
    };

    console.log('✅ ChatController: Global state initialized');
  }

  /**
   * Load existing messages from storage
   * @private
   */
  async _loadExistingMessages() {
    console.log('📦 ChatController: Loading existing messages...');

    try {
      // Check if storage API is available
      if (!this.modules.messageManager.messageState.storageAPI) {
        console.warn('[ChatController] Storage API not available, creating local chat');
        const newChatId = await this.modules.messageManager.createChat('New Chat');
        this.currentChatId = newChatId;
        return;
      }

      // Try to load chats from backend
      const chats = await this.modules.messageManager.messageState.storageAPI.loadChats();
      
      if (chats && chats.length > 0) {
        // Load the most recent chat (storageAPI returns sorted by updated_at desc)
        const mostRecent = chats[0];
        console.log(`[ChatController] Loading most recent chat: ${mostRecent.id}`);
        await this.modules.messageManager.loadChat(mostRecent.id);
        this.currentChatId = mostRecent.id;
      } else {
        // No existing chats - create a new one and activate it
        console.log('[ChatController] No existing chats, creating new chat');
        const newChatId = await this.modules.messageManager.createChat('New Chat');
        this.currentChatId = newChatId;
      }

      console.log(`✅ ChatController: Active chat session: ${this.currentChatId}`);
    } catch (error) {
      console.error('[ChatController] Failed to load existing messages:', error);
      
      // Fallback: Create new chat on error
      try {
        const newChatId = await this.modules.messageManager.createChat('New Chat');
        this.currentChatId = newChatId;
        console.log(`✅ ChatController: Created fallback chat: ${this.currentChatId}`);
      } catch (fallbackError) {
        console.error('[ChatController] Failed to create fallback chat:', fallbackError);
        // Last resort: Set the chatId that was generated in _initializeCore
        console.warn('[ChatController] Using fallback chat ID from _initializeCore');
      }
    }
  }

  /**
   * Generate unique chat ID
   * @private
   * @returns {string}
   */
  _generateChatId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    return `chat_${timestamp}_${random}`;
  }

  /**
   * Handle assistant stream chunk
   * @private
   */
  _handleAssistantStream(chunk, metadata) {
    try {
      // Track streaming message ID
      if (metadata && metadata.messageId) {
        this.currentStreamingMessageId = metadata.messageId;
      }

      // Emit event for modules to handle
      this.eventBus.emit(EventTypes.CHAT.ASSISTANT_STREAM, {
        chunk,
        metadata,
        messageId: this.currentStreamingMessageId
      });

      // Forward to MessageManager when implemented
      // if (this.modules.messageManager) {
      //   this.modules.messageManager.handleStream(chunk, metadata);
      // }

    } catch (error) {
      console.error('[ChatController] Handle assistant stream failed:', error);
    }
  }

  /**
   * Handle request complete
   * @private
   */
  _handleRequestComplete(data) {
    try {
      this.isProcessing = false;
      this.currentStreamingMessageId = null;

      this.eventBus.emit(EventTypes.CHAT.REQUEST_COMPLETE, {
        ...data,
        timestamp: Date.now()
      });

      console.log('[ChatController] Request complete:', data);

    } catch (error) {
      console.error('[ChatController] Handle request complete failed:', error);
    }
  }

  /**
   * Handle ensure visible event
   * @private
   */
  _handleEnsureVisible() {
    try {
      // Make chat window visible
      if (this.modules.chatWindow && typeof this.modules.chatWindow.show === 'function') {
        this.modules.chatWindow.show();
      }

      // Emit chat window opened event
      if (this.eventBus && EventTypes.CHAT && EventTypes.CHAT.WINDOW_OPENED) {
        this.eventBus.emit(EventTypes.CHAT.WINDOW_OPENED, {
          window: 'chat',
          timestamp: Date.now()
        });
      }

      console.log('[ChatController] Ensure visible');

    } catch (error) {
      console.error('[ChatController] Handle ensure visible failed:', error);
    }
  }

  /**
   * Handle artifact stream (Stage 1)
   * Enriches with chatId and forwards to artifacts window (Stage 2)
   * Uses throttled logging to prevent console spam
   * @private
   */
  _handleArtifactStream(data) {
    try {
      // Only log START/END markers, not every chunk
      if (data.start) {
        console.log(`[ChatController] 🚀 Artifact stream started: ${data.type}/${data.format}`);
      }
      
      // CRITICAL FIX: MessageState is a sub-module of MessageManager
      const chatId = this.modules.messageManager?.messageState?.currentChatId;
      if (!chatId) {
        console.warn('[ChatController] ⚠️  No current chat ID - cannot route artifact');
        return;
      }

      // Enrich with chatId
      const enrichedData = {
        ...data,
        chatId: chatId,
        timestamp: Date.now()
      };
      
      // Forward to artifacts window (Stage 2) - NO per-chunk logging
      window.aether.artifacts.streamReady(enrichedData);
      
      // Only log END markers
      if (data.end) {
        console.log(`[ChatController] ✅ Artifact stream complete, forwarded to artifacts window`);
      }

    } catch (error) {
      console.error('[ChatController] ❌ Artifact stream error:', error);
    }
  }

  /**
   * Handle STT stream (hands-free voice input)
   * @private
   */
  _handleSttStream(data) {
    try {
      const { text, isFinal, source } = data;
      
      if (!text) return;
      
      const chatWindow = this.modules.chatWindow;
      if (!chatWindow) {
        console.warn('[ChatController] Chat window module not available');
        return;
      }
      
      const inputEl = document.getElementById('chat-input');
      if (!inputEl) {
        console.warn('[ChatController] Chat input element not found');
        return;
      }
      
      if (isFinal) {
        const currentText = inputEl.value.trim();
        inputEl.value = currentText ? `${currentText} ${text}` : text;
        
        console.log('[ChatController] STT Final:', text);
      } else {
        const baseText = inputEl.getAttribute('data-stt-base') || '';
        inputEl.value = baseText + text;
        inputEl.setAttribute('data-stt-base', baseText);
        
        console.log('[ChatController] STT Partial:', text);
      }
      
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      
    } catch (error) {
      console.error('[ChatController] ❌ STT stream error:', error);
    }
  }

  /**
   * Handle backend online event
   * @private
   */
  _handleBackendOnline(data) {
    console.log('[ChatController] Backend online:', data);
    this.backendConnected = true;
  }

  /**
   * Handle backend offline event
   * @private
   */
  _handleBackendOffline(data) {
    console.log('[ChatController] Backend offline:', data);
    this.backendConnected = false;
  }
}

// Export
module.exports = ChatController;

if (typeof window !== 'undefined') {
  window.ChatController = ChatController;
  console.log('📦 ChatController loaded');
}

