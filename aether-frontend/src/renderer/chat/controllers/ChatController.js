'use strict';

/**
 * @.architecture
 *
 * Incoming: IPC 'chat:assistant-stream' | 'chat:request-complete', EventBus 'artifact:stream' | 'chat-reference:attach-requested-from-input', DOM lifecycle events --- {ipc.chat_stream_event | event.custom | event.dom, json | json | Event}
 * Processing: Coordinate chat window modules, relay IPC into EventBus, route artifacts with chat context, attach chat summaries as JSON files --- {7 jobs: JOB_DELEGATE_TO_MODULE, JOB_EMIT_EVENT, JOB_INITIALIZE, JOB_ROUTE_BY_TYPE, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA, JOB_TRANSFORM_DATA}
 * Outgoing: EventBus EventTypes.CHAT.ASSISTANT_STREAM | 'chat-reference:chats-selected', artifacts.streamReady(), FileManager (summary files), EventBus EventTypes.SYSTEM.READY --- {event.custom | event.custom | ipc.artifacts_stream | File[] | event.custom, json | json | json | json | json}
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

const {
  EventTypes,
  EventPriority
} = require('../../../core/events/EventTypes');
const { createRendererLogger } = require('../../shared/utils/logger');
const { getAether } = require('../../shared/bridge/AetherBridge');
const { resolveStorageAPI } = require('../../../shared/utils/storage-resolver');
const sessionBridge = require('../../shared/adapters/session');
const { freeze } = Object;

// Controller modules
const BackendHealthMonitor = require('./modules/BackendHealthMonitor');
const STTInputManager = require('./modules/STTInputManager');
const StreamProcessor = require('./modules/StreamProcessor');
const SessionMapRestorer = require('./modules/SessionMapRestorer');
const ProactiveContextHandler = require('./modules/ProactiveContextHandler');
const ChatSummaryAttacher = require('./modules/ChatSummaryAttacher');
const MessageDeletionHandler = require('./modules/MessageDeletionHandler');
const EventCoordinator = require('./coordination/EventCoordinator');

// Application services
const { TrailRestorationService } = require('../../../application/chat/TrailRestorationService');
const { ContextService } = require('../../../application/chat/ContextService');

const controllerLogger = createRendererLogger('ChatController');

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
    this.endpoint = this.container.resolve('endpoint');
    if (!this.endpoint) {
      throw new Error('[ChatController] Endpoint required in DI container');
    }
    
    this.eventBus = options.eventBus;
    this.config = options.config;
    this.aether = options.aether || getAether();
    this.ipc = options.ipc || (this.aether?.ipc ?? null);
    this.log = controllerLogger.child({ scope: 'instance' });
    this.storageAPI = resolveStorageAPI({ storageAPI: options.storageAPI });

    // Modules (will be initialized)
    this.modules = {};
    
    // State
    this.initialized = false;
    this.backendConnected = false;
    this.currentChatId = null;
    this.isDetachedWindow = this._detectDetachedMode();
    this.isProcessing = false;
    
    // Proactive context queue (for messages received before initialization)
    this._pendingProactiveContext = null;
    
    // IPC listeners for cleanup
    this._ipcListeners = [];
    this._eventListeners = [];

    // Coordinator modules (will be initialized)
    this.artifactCoordinator = null;
    this.healthMonitor = null;
    this.sttManager = null;
    this.eventCoordinator = null;
    
    // Stream processing module
    this.streamProcessor = new StreamProcessor({
      eventBus: this.eventBus,
      aether: this.aether,
      getChatWindow: () => this.modules.chatWindow || null,
      onProcessingComplete: () => { this.isProcessing = false; }
    });
    
    // Session map restoration module
    this.sessionMapRestorer = new SessionMapRestorer();
    
    // Proactive context handler module
    this.proactiveContextHandler = new ProactiveContextHandler({
      eventBus: this.eventBus
    });
    
    // Chat summary attachment module
    this.chatSummaryAttacher = new ChatSummaryAttacher({
      aether: this.aether
    });
    
    // Message deletion handler module
    this.messageDeletionHandler = new MessageDeletionHandler();
    
    // Application services
    this.trailRestorationService = null;
    this.contextService = null;
    
    // BroadcastChannel for sidebar refresh (handsfree mode)
    this.sidebarRefreshChannel = null;
    this._setupSidebarRefreshChannel();

    // Bind methods
    this._handleAssistantStream = this._handleAssistantStream.bind(this);
    this._handleRequestComplete = this._handleRequestComplete.bind(this);
    this._handleEnsureVisible = this._handleEnsureVisible.bind(this);
    this._handleArtifactStream = this._handleArtifactStream.bind(this);
    this._handleBackendOnline = this._handleBackendOnline.bind(this);
    this._handleBackendOffline = this._handleBackendOffline.bind(this);
    this._handleTrailNodeClicked = this._handleTrailNodeClicked.bind(this);
    
    this.log.debug('ChatController constructed', {
      isDetachedWindow: this.isDetachedWindow
    });
  }
  
  /**
   * Setup BroadcastChannel for sidebar refresh (handsfree mode)
   * @private
   */
  _setupSidebarRefreshChannel() {
    try {
      // Create BroadcastChannel for cross-window communication
      this.sidebarRefreshChannel = new BroadcastChannel('sidebar-refresh');
      
      // Also expose on window for MainApp access
      if (typeof window !== 'undefined') {
        window.sidebarRefreshChannel = this.sidebarRefreshChannel;
      }
      
      // Handle messages from main window (handsfree STT events)
      this.sidebarRefreshChannel.onmessage = (event) => {
        if (event.data && event.data.type === 'chat_message_added') {
          const chatId = event.data.chat_id;
          if (chatId && this.modules.sidebarManager) {
            // Increment message count for the chat
            this.modules.sidebarManager.incrementChatCount(chatId);
            this.log.debug('Sidebar count incremented for handsfree message', { chatId });
          }
        }
      };
      
      this.log.debug('BroadcastChannel initialized for sidebar refresh');
    } catch (error) {
      this.log.warn('Failed to initialize BroadcastChannel', { error });
    }
  }
  /**
   * Initialize chat controller
   */
  async init() {
    this.log.info('Initializing ChatController');

    try {
      // Phase 1: Core initialization
      await this._initializeCore();

      // Phase 2: Register services in DI container
      await this._registerServices();

      // Phase 3: Initialize modules (includes EventCoordinator with all EventBus listeners)
      await this._initializeModules();

      // Phase 4: Setup IPC listeners
      await this._setupIpcListeners();

      // Phase 5: Initialize global state
      await this._initializeGlobalState();

      // Phase 6: Load existing messages
      await this._loadExistingMessages();

      this.initialized = true;

      this.log.info('ChatController initialization complete');
      this.eventBus.emit(EventTypes.SYSTEM.READY, { 
        controller: 'ChatController',
        timestamp: Date.now(),
        isDetachedWindow: this.isDetachedWindow
      }, { priority: EventPriority.HIGH });
      
      // Process any pending proactive context that arrived before initialization
      if (this._pendingProactiveContext) {
        this.log.info('Processing pending proactive context');
        await this._handleProactiveContext(this._pendingProactiveContext);
        this._pendingProactiveContext = null;
      }

    } catch (error) {
      this.log.error('ChatController initialization failed', { error });
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
    this.log.info('Disposing ChatController');

    // Dispose coordinator modules
    if (this.eventCoordinator) {
      // Note: EventCoordinator listeners are already in _eventListeners,
      // so cleanup() is not called here to avoid double-cleanup.
      // We only null the reference.
      this.eventCoordinator = null;
    }

    if (this.trailRestorationService) {
      if (typeof this.trailRestorationService.dispose === 'function') {
        this.trailRestorationService.dispose();
      }
      this.trailRestorationService = null;
    }

    if (this.contextService) {
      if (typeof this.contextService.dispose === 'function') {
        this.contextService.dispose();
      }
      this.contextService = null;
    }

    if (this.healthMonitor) {
      this.healthMonitor.dispose();
      this.healthMonitor = null;
    }

    if (this.sttManager) {
      this.sttManager.dispose();
      this.sttManager = null;
    }

    if (this.streamProcessor) {
      this.streamProcessor.dispose();
      this.streamProcessor = null;
    }

    if (this.sessionMapRestorer) {
      this.sessionMapRestorer.dispose();
      this.sessionMapRestorer = null;
    }

    if (this.proactiveContextHandler) {
      this.proactiveContextHandler.dispose();
      this.proactiveContextHandler = null;
    }

    if (this.chatSummaryAttacher) {
      this.chatSummaryAttacher.dispose();
      this.chatSummaryAttacher = null;
    }

    if (this.messageDeletionHandler) {
      this.messageDeletionHandler.dispose();
      this.messageDeletionHandler = null;
    }

    // Dispose modules in reverse initialization order
    const moduleNames = Object.keys(this.modules).reverse();
    for (const name of moduleNames) {
      try {
        if (this.modules[name] && typeof this.modules[name].dispose === 'function') {
          this.log.debug('Disposing module', { module: name });
          this.modules[name].dispose();
        }
      } catch (error) {
        this.log.error('Failed to dispose module', { module: name, error });
      }
    }

    // Clear module references
    this.modules = {};

    // Remove IPC listeners
    for (const cleanup of this._ipcListeners) {
      try {
        cleanup();
      } catch (error) {
        this.log.error('Failed to cleanup IPC listener', { error });
      }
    }
    this._ipcListeners = [];

    // Remove event listeners
    for (const cleanup of this._eventListeners) {
      try {
        cleanup();
      } catch (error) {
        this.log.error('Failed to cleanup event listener', { error });
      }
    }
    this._eventListeners = [];
    
    // Close BroadcastChannel
    if (this.sidebarRefreshChannel) {
      try {
        const channelRef = this.sidebarRefreshChannel;
        this.sidebarRefreshChannel.close();
        this.sidebarRefreshChannel = null;
        if (typeof window !== 'undefined' && window.sidebarRefreshChannel === channelRef) {
          window.sidebarRefreshChannel = null;
        }
      } catch (error) {
        this.log.error('Failed to close BroadcastChannel', { error });
      }
    }

    this.log.debug('ChatController disposed');
  }

  /**
   * Send message to chat
   * @param {string} content - Message content
   * @param {Object} options - Send options
   */
  async sendMessage(content, options = {}) {
    if (!this.modules.messageOrchestrator) {
      throw new Error('[ChatController] MessageOrchestrator not initialized');
    }

    if (!content || typeof content !== 'string') {
      throw new Error('[ChatController] Invalid message content');
    }

    // UX GUARD: Prevent sending when backend is offline instead of failing silently
    if (!this.backendConnected) {
      const offlineError = new Error('Backend is not connected. Please wait for the connection to be restored.');
      offlineError.userFacing = true;
      this.log.warn('sendMessage blocked: backend offline');
      this.eventBus.emit(EventTypes.CHAT.MESSAGE_ERROR, { error: offlineError, content });
      throw offlineError;
    }

    try {
      this.isProcessing = true;
      this.eventBus.emit(EventTypes.CHAT.MESSAGE_SENDING, { content, options });

      await this.modules.messageOrchestrator.sendMessage(content, options);

      this.eventBus.emit(EventTypes.CHAT.MESSAGE_SENT, { content, options });
    } catch (error) {
      this.log.error('Send message failed', { error });
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
      const messageId = this.streamProcessor ? this.streamProcessor.currentStreamingMessageId : null;

      this.eventBus.emit(EventTypes.CHAT.STOP_REQUESTED, { 
        timestamp: Date.now(),
        messageId
      });

      // Send stop via IPC (include requestId when available)
      if (this.aether?.chat?.stop) {
        this.aether.chat.stop(messageId || null);
      }

      this.isProcessing = false;
      if (this.streamProcessor) {
        this.streamProcessor.resetStreamState();
      }

      this.log.debug('Processing stopped');
    } catch (error) {
      this.log.error('Stop processing failed', { error });
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
      messageCount: this.modules.messageOrchestrator ? this.modules.messageOrchestrator.messageState?.messages.length || 0 : 0
    });
  }

  /**
   * Set backend connected state (called by EventCoordinator)
   * @param {boolean} value
   */
  setBackendConnected(value) {
    this.backendConnected = value;
  }

  /**
   * Set current chat ID (called by EventCoordinator on chat:loaded / chat:switched)
   * @param {string} chatId
   */
  setCurrentChatId(chatId) {
    if (chatId && chatId !== this.currentChatId) {
      this.log.info('Updating currentChatId', {
        oldChatId: this.currentChatId,
        newChatId: chatId
      });
      this.currentChatId = chatId;
    }
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
    
    const hasDetachedAPI = this.aether?.isDetachedWindow === true;

    return isInChatHtml || hasDetachedFlag || hasDetachedAPI;
  }

  /**
   * Initialize core dependencies
   * @private
   */
  async _initializeCore() {
    this.log.debug('Initializing core dependencies');

    // Generate chat ID for renderer context
    this.currentChatId = this._generateChatId();
    this.log.debug('Core dependencies ready', { currentChatId: this.currentChatId });

    try {
      await sessionBridge.setActiveChat(this.currentChatId);
    } catch (error) {
      this.log.warn('Unable to set active session during initialization', { error: error?.message });
    }
  }

  /**
   * Register services in DI container
   * @private
   */
  async _registerServices() {
    this.log.debug('Registering additional services');

    // Services are already registered by chat renderer bootstrap
    // Additional services can be registered here if needed

    this.log.trace('Service registration complete');
  }

  /**
   * Initialize modules in dependency order
   * @private
   */
  async _initializeModules() {
    this.log.debug('Initializing module stack');

    // Resolve once for the whole method scope
    const storageAPI = this.storageAPI;
    
    // CONTRACT: API base URL must come from central config (no localhost fallbacks).
    const apiBaseUrl = this.config?.API_BASE_URL;
    if (!apiBaseUrl || typeof apiBaseUrl !== 'string' || apiBaseUrl.trim().length === 0) {
      throw new Error('[ChatController] CONTRACT VIOLATION: config.API_BASE_URL is required (no defaults). Configure backend base URL via central config/env/PortManager discovery.');
    }

    // 1. ChatWindow (window lifecycle and DOM)
    try {
      const ChatWindow = require('../modules/window/ChatWindow');
      this.modules.chatWindow = new ChatWindow({
        controller: this,
        eventBus: this.eventBus,
        container: document.body,
        endpoint: this.endpoint
      });
      await this.modules.chatWindow.init();
      this.log.debug('ChatWindow initialized');
    } catch (error) {
      this.log.error('ChatWindow initialization failed', { error });
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
      this.log.debug('DragResizeManager initialized', { isDetached: this.isDetachedWindow });
    } catch (error) {
      this.log.error('DragResizeManager initialization failed', { error });
      throw error;
    }

    // 3. FileManager (file attachments) - MUST initialize before MessageOrchestrator
    try {
      const FileManager = require('../modules/files/FileManager');
      this.modules.fileManager = new FileManager({
        chatWindow: this.modules.chatWindow,
        eventBus: this.eventBus,
        ipc: this.ipc,
        endpoint: this.endpoint // ARCHITECTURAL FIX: Inject endpoint directly
      });
      await this.modules.fileManager.init();
      this.log.debug('FileManager initialized');
    } catch (error) {
      this.log.error('FileManager initialization failed', { error });
      throw error;
    }

    // 4. MessageOrchestrator (message handling - modular architecture)
    // ARCHITECTURAL FIX: Inject FileManager reference for attachment coordination
    try {
      const MessageOrchestrator = require('../modules/messaging/MessageOrchestrator');

      this.modules.messageOrchestrator = new MessageOrchestrator({
        chatWindow: this.modules.chatWindow,
        eventBus: this.eventBus,
        ipc: this.ipc,
        storageAPI,
        fileManager: this.modules.fileManager,
        config: this.config,
        endpoint: this.endpoint
      });
      await this.modules.messageOrchestrator.init();
      this.log.debug('MessageOrchestrator initialized');
    } catch (error) {
      this.log.error('MessageOrchestrator initialization failed', { error });
      throw error;
    }

    // 5. Coordinator Modules
    try {
      this.healthMonitor = new BackendHealthMonitor({
        storageAPI,
        eventBus: this.eventBus
      });
      this.log.debug('BackendHealthMonitor initialized');
    } catch (error) {
      this.log.error('BackendHealthMonitor initialization failed', { error });
      throw error;
    }

    try {
      this.sttManager = new STTInputManager({
        inputElement: null // Will be set after ChatWindow init
      });
      // Set input element reference
      const elements = this.modules.chatWindow.getElements();
      if (elements.input) {
        this.sttManager.setInputElement(elements.input);
      }
      this.log.debug('STTInputManager initialized');
    } catch (error) {
      this.log.error('STTInputManager initialization failed', { error });
      throw error;
    }
    
    // Initialize TrailRestorationService (application layer)
    try {
      this.trailRestorationService = new TrailRestorationService({
        eventBus: this.eventBus,
        enableLogging: this.config.NODE_ENV === 'development',
        apiClient: this.endpoint?.api
      });
      this.log.debug('TrailRestorationService initialized');
    } catch (error) {
      this.log.error('TrailRestorationService initialization failed', { error });
      throw error;
    }
    
    // Initialize ContextService (application layer)
    try {
      this.contextService = new ContextService({
        eventBus: this.eventBus,
        enableLogging: this.config.NODE_ENV === 'development',
        apiClient: this.endpoint?.api
      });
      this.log.debug('ContextService initialized');
    } catch (error) {
      this.log.error('ContextService initialization failed', { error });
      throw error;
    }
    
    // Initialize EventCoordinator (centralized event management)
    try {
      this.eventCoordinator = new EventCoordinator({
        eventBus: this.eventBus,
        trailRestorationService: this.trailRestorationService,
        modules: this.modules,
        chatController: this
      });
      const cleanupFunctions = this.eventCoordinator.registerAll();
      this._eventListeners.push(...cleanupFunctions);
      this.log.debug('EventCoordinator initialized', { listenerCount: cleanupFunctions.length });
    } catch (error) {
      this.log.error('EventCoordinator initialization failed', { error });
      throw error;
    }

    // 6. SidebarManager (chat list sidebar)
    try {
      const SidebarManager = require('../modules/sidebar/SidebarManager');

      this.modules.sidebarManager = new SidebarManager({
        chatWindow: this.modules.chatWindow,
        messageOrchestrator: this.modules.messageOrchestrator,
        eventBus: this.eventBus,
        chatService: this.modules.messageOrchestrator?.messageState?.chatService,
        endpoint: this.endpoint
      });
      await this.modules.sidebarManager.init();
      this.log.debug('SidebarManager initialized');
    } catch (error) {
      this.log.error('SidebarManager initialization failed', { error });
      throw error;
    }

    // 7. ThinkingBubble (thinking indicator)
    try {
      const ThinkingBubble = require('../modules/thinking/ThinkingBubble');
      const thinkingContainer = document.createElement('div');
      thinkingContainer.className = 'aether-thinking-container';
      thinkingContainer.style.cssText = 'width: 100%; padding: 0;';
      
      const chatContent = this.modules.chatWindow.elements.content;
      if (chatContent) {
        chatContent.appendChild(thinkingContainer);
      }
      
      this.modules.thinkingBubble = new ThinkingBubble({
        parentElement: thinkingContainer,
        initialState: 'collapsed'
      });
      this.modules.thinkingBubble.init();
      this.log.debug('ThinkingBubble initialized');
    } catch (error) {
      this.log.error('ThinkingBubble initialization failed', { error });
      throw error;
    }

    // 9. TrailEventRouter (pure event-driven trail rendering)
    try {
      const TrailEventRouter = require('../modules/trail/TrailEventRouter');
      this.modules.trailEventRouter = new TrailEventRouter({
        orchestrator: this.modules.messageOrchestrator.trailOrchestrator,
        eventBus: this.eventBus
      });
      this.log.info('TrailEventRouter initialized - pure event-driven trail rendering enabled');
    } catch (error) {
      this.log.error('TrailEventRouter initialization failed', { error });
      throw error;
    }

    this.log.debug('Module initialization complete');
  }

  /**
   * Attach chat summaries as file attachments (delegates to ChatSummaryAttacher)
   * @private
   */
  async _attachChatSummariesAsFiles(selectedChats) {
    await this.chatSummaryAttacher.attach(selectedChats, this.modules.fileManager);
  }

  /**
   * Setup IPC listeners
   * @private
   */
  async _setupIpcListeners() {
    this.log.trace('Registering IPC listeners');

    const chatAPI = this.aether?.chat;
    if (!chatAPI) {
      throw new Error('[ChatController] CONTRACT VIOLATION: aether.chat is required');
    }

    // Listen for assistant stream
    const cleanupAssistantStream = chatAPI.onAssistantStream((payload) => {
      this._handleAssistantStream(payload);
    });
    this._ipcListeners.push(cleanupAssistantStream);

    // Listen for request complete
    const cleanupRequestComplete = chatAPI.onRequestComplete((data) => {
      this._handleRequestComplete(data);
    });
    this._ipcListeners.push(cleanupRequestComplete);

    // Listen for ensure visible
    const cleanupEnsureVisible = chatAPI.onEnsureVisible(() => {
      this._handleEnsureVisible();
    });
    this._ipcListeners.push(cleanupEnsureVisible);
    
    // Listen for new chat requests
    const cleanupNewRequested = chatAPI.onNewRequested(() => {
      this._handleNewChatRequest();
    });
    this._ipcListeners.push(cleanupNewRequested);
    
    // Listen for load specific chat (from main window library)
    const cleanupLoadSpecific = chatAPI.onLoadSpecific((data) => {
      this._handleLoadSpecificChat(data);
    });
    this._ipcListeners.push(cleanupLoadSpecific);
    
    // Listen for proactive context (from main window proactive notifications)
    const cleanupProactiveContext = chatAPI.onProactiveContext((data) => {
      this._handleProactiveContext(data);
    });
    this._ipcListeners.push(cleanupProactiveContext);

    // STT stream (hands-free voice input)
    const cleanupSttStream = chatAPI.onSttStream((data) => {
      this._handleSttStream(data);
    });
    this._ipcListeners.push(cleanupSttStream);

    // REMOVED: ChatController should NOT listen to artifacts:stream
    // That channel is ONLY for the Artifacts Window (ArtifactsController)
    // Chat window listens to different channels for its own needs

    this.log.trace('IPC listeners registered');
  }

  /**
   * Initialize global state
   * @private
   */
  async _initializeGlobalState() {
    this.log.debug('Initializing global state');

    // Check backend health and emit appropriate event
    const isHealthy = await this.healthMonitor.checkAndEmit();
    this.backendConnected = isHealthy;

    if (isHealthy) {
      this.log.info('Backend health check succeeded');
    } else {
      this.log.warn('Backend health check failed');
    }

    // Set initial input state based on connection
    if (this.modules.messageOrchestrator && this.modules.messageOrchestrator.inputUI) {
      if (typeof this.modules.messageOrchestrator.inputUI.setConnectedState === 'function') {
        this.modules.messageOrchestrator.inputUI.setConnectedState(this.backendConnected);
      }
    }

    this.log.debug('Global state initialized');
  }

  /**
   * Load existing messages from storage
   * @private
   */
  async _loadExistingMessages() {
    this.log.debug('Loading existing messages');

    try {
      const messageState = this.modules.messageOrchestrator.messageState;
      const hasChatService = !!messageState.chatService;
      const hasStorage = !!messageState.storageAPI;

      if (!hasChatService && !hasStorage) {
        this.log.warn('No chat persistence available, creating local chat');
        const newChatId = await this.modules.messageOrchestrator.createChat('New Chat');
        this.currentChatId = newChatId;
        return;
      }

      let chats = [];
      if (hasChatService) {
        chats = await messageState.chatService.loadAllChats();
      } else if (hasStorage) {
        chats = await messageState.storageAPI.loadChats();
      }
      
      // ARCHITECTURAL FIX: Centralize initial chat load in ChatController
      // MessageState init runs without auto-load; ChatLifecycleManager handles render + restoration
      if (chats && chats.length > 0) {
        const mostRecent = hasChatService
          ? chats.reduce((latest, chat) => {
              const time = chat.updatedAt || chat.updated_at || chat.createdAt || chat.created_at || 0;
              if (!latest) return chat;
              const latestTime = latest.updatedAt || latest.updated_at || latest.createdAt || latest.created_at || 0;
              return time > latestTime ? chat : latest;
            }, null)
          : chats[0];

        const chatId =
          mostRecent && typeof mostRecent.toJSON === 'function'
            ? mostRecent.toJSON().id
            : mostRecent?.id;

        if (chatId) {
          await this.modules.messageOrchestrator.loadChat(chatId, { reason: 'startup' });
          this.currentChatId = chatId;
          this.log.info('Most recent chat loaded during startup', { chatId });
        } else {
          this.log.warn('Most recent chat missing ID, creating new chat');
          const newChatId = await this.modules.messageOrchestrator.createChat('New Chat');
          this.currentChatId = newChatId;
        }
      } else {
        this.log.info('No existing chats found, creating new chat');
        const newChatId = await this.modules.messageOrchestrator.createChat('New Chat');
        this.currentChatId = newChatId;
      }

      this.log.info('Active chat session established', { chatId: this.currentChatId });
    } catch (error) {
      this.log.error('Failed to load existing messages', { error });
      
      // Fallback: Create new chat on error
      try {
        const newChatId = await this.modules.messageOrchestrator.createChat('New Chat');
        this.currentChatId = newChatId;
        this.log.warn('Created fallback chat after load error', { chatId: this.currentChatId });
      } catch (fallbackError) {
        this.log.error('Failed to create fallback chat', { error: fallbackError });
        // Last resort: Set the chatId that was generated in _initializeCore
        this.log.warn('Using generated chat ID from core initialization as fallback', { chatId: this.currentChatId });
      }
    }
  }

  /**
   * Generate unique chat ID
   * @private
   * @returns {string}
   */
  _generateChatId() {
    if (typeof crypto === 'undefined' || !crypto.randomUUID) {
      throw new Error('[ChatController] CONTRACT VIOLATION: crypto.randomUUID is required for chat ID generation.');
    }
    return crypto.randomUUID();
  }

  /**
   * Handle assistant stream chunk (delegates to StreamProcessor)
   * @private
   */
  _handleAssistantStream(payload) {
    this.streamProcessor.handleAssistantStream(payload);
  }

  /**
   * Handle request complete (delegates to StreamProcessor)
   * @private
   */
  _handleRequestComplete(data) {
    this.streamProcessor.handleRequestComplete(data);
  }

  /**
   * Handle ensure visible event (delegates to StreamProcessor)
   * @private
   */
  _handleEnsureVisible() {
    this.streamProcessor.handleEnsureVisible();
  }
  
  /**
   * Handle new chat request (from main window library or IPC)
   * @private
   */
  async _handleNewChatRequest() {
    try {
      this.log.info('New chat requested');
      if (this.modules.messageOrchestrator) {
        const createdChatId = await this.modules.messageOrchestrator.createChat('New Chat');
        this.log.debug('New chat created', { createdChatId });
        
        await this.modules.messageOrchestrator.loadChat(createdChatId);
        this.log.debug('Switched to new chat', { createdChatId });
        
        if (this.modules.sidebarManager) {
          await this.modules.sidebarManager.refreshChatList();
        }
        
        this.log.info('New chat workflow complete - all signals triggered', { createdChatId });
      }
    } catch (error) {
      this.log.error('Failed to create new chat', { error });
    }
  }

  /**
   * Handle load specific chat (from main window library)
   * @private
   */
  async _handleLoadSpecificChat(data) {
    try {
      if (!data?.chatId) {
        this.log.warn('Load specific chat called without chatId');
        return;
      }
      
      this.log.info('Loading specific chat', { chatId: data.chatId });
      
      // Use sidebar manager to switch chat
      if (this.modules.sidebarManager && typeof this.modules.sidebarManager._switchToChat === 'function') {
        await this.modules.sidebarManager._switchToChat(data.chatId);
      } else {
        this.log.error('SidebarManager not available or _switchToChat method missing');
      }
    } catch (error) {
      this.log.error('Failed to load specific chat', { error, chatId: data?.chatId });
    }
  }
  
  /**
   * Handle proactive context (delegates to ProactiveContextHandler)
   * @private
   */
  async _handleProactiveContext(data) {
    try {
      await this.proactiveContextHandler.handle(data, {
        initialized: this.initialized,
        modules: this.modules,
        onQueue: (queuedData) => { this._pendingProactiveContext = queuedData; }
      });
    } catch (error) {
      // CRITICAL FIX: Prevent unhandled promise rejections at IPC boundary
      this.log.error('Failed to handle proactive context', { error });
    }
  }

  /**
   * Handle artifact stream (delegates to StreamProcessor)
   * @private
   */
  _handleArtifactStream(data) {
    this.streamProcessor.handleArtifactStream(data);
  }

  /**
   * Handle trail node click (delegates to StreamProcessor)
   * @private
   */
  _handleTrailNodeClicked(data) {
    this.streamProcessor.handleTrailNodeClicked(data);
  }

  /**
   * Handle STT stream (hands-free voice input)
   * Delegates to STTInputManager
   * @private
   */
  _handleSttStream(data) {
    try {
      if (this.sttManager) {
        this.sttManager.handleStream(data);
      } else {
        this.log.error('STTInputManager not initialized');
      }
    } catch (error) {
      this.log.error('STT stream delegation error', { error });
    }
  }

  /**
   * Restore chat from session map (delegates to SessionMapRestorer)
   * Called by EventCoordinator.
   * @private
   */
  _restoreFromSessionMap(chatId, sessionMap) {
    const orchestrator = this.modules.messageOrchestrator?.trailOrchestrator;
    this.sessionMapRestorer.restore(chatId, sessionMap, orchestrator);
  }

  /**
   * Handle message deletion (delegates to MessageDeletionHandler)
   * @private
   */
  _handleMessageDeleted(data) {
    this.messageDeletionHandler.handleMessageDeleted(data, {
      messageView: this.modules.messageOrchestrator?.messageView,
      messageState: this.modules.messageOrchestrator?.messageState,
      chatWindow: this.modules.chatWindow
    });
  }

  /**
   * Handle artifact deletion (delegates to MessageDeletionHandler)
   * @private
   */
  _handleArtifactDeleted(data) {
    this.messageDeletionHandler.handleArtifactDeleted(data);
  }

  /**
   * Handle message error event (e.g. from backend disconnected)
   * @private
   */
  _handleMessageError(data) {
    this.log.error('Message error handled in ChatController', data);
    const orchestrator = this.modules.messageOrchestrator;
    if (orchestrator) {
      const messageId = data.requestId || data.correlationId;
      if (orchestrator.messageState && typeof orchestrator.messageState.markMessageFailed === 'function') {
        orchestrator.messageState.markMessageFailed(messageId, data.error);
      }
      if (orchestrator.messageView && typeof orchestrator.messageView.updateMessageStatus === 'function') {
        orchestrator.messageView.updateMessageStatus(messageId, 'error', data.error);
      }
    }
  }

  /**
   * Handle backend online event
   * @private
   */
  _handleBackendOnline(data) {
    this.log.info('Backend reported online', data);
    this.backendConnected = true;
    
    // Enable inputs when online
    if (this.modules.messageOrchestrator && this.modules.messageOrchestrator.inputUI) {
      if (typeof this.modules.messageOrchestrator.inputUI.setConnectedState === 'function') {
        this.modules.messageOrchestrator.inputUI.setConnectedState(true);
      }
    }
  }

  /**
   * Handle backend offline event
   * @private
   */
  _handleBackendOffline(data) {
    this.log.warn('Backend reported offline', data);
    this.backendConnected = false;
    
    // Disable inputs and show warning banner when offline
    if (this.modules.messageOrchestrator && this.modules.messageOrchestrator.inputUI) {
      if (typeof this.modules.messageOrchestrator.inputUI.setConnectedState === 'function') {
        this.modules.messageOrchestrator.inputUI.setConnectedState(false);
      }
    }
  }
}

// Export
module.exports = ChatController;

if (typeof window !== 'undefined') {
  window.ChatController = ChatController;
  controllerLogger.debug('ChatController module loaded');
}
