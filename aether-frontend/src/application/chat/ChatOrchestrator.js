'use strict';

/**
 * @.architecture
 * Incoming: EventBus.on('backend:stream-*'), IpcBridge.on('chat:*'), container.resolve('MessageService'|'ChatService'|'ArtifactService'|'TraceabilityService') --- {event_types.stream_chunk | ipc_message | method_call, json}
 * Processing: Initialize domain services (StreamBuffer, MessageSender, StreamLifecycleManager, ConnectionStateTracker, ChatSessionManager), coordinate chat/message/stream state via repositories, route IPC to artifacts window, emit frontend events, manage backend connection --- {10 jobs: JOB_ACCUMULATE_TEXT, JOB_DELEGATE_TO_MODULE, JOB_DISPOSE, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_INITIALIZE, JOB_LOAD_FROM_DB, JOB_SAVE_TO_DB, JOB_SEND_IPC, JOB_UPDATE_STATE}
 * Outgoing: GuruConnection.send(), Repository methods (ChatRepository, MessageRepository, ArtifactRepository), IpcBridge.send('artifacts:*'), messageManager.displayMessage, streamAdapter.applyChunk, EventBus.emit('chat:*') --- {websocket_message | domain_models | ipc_message | custom_event | dom_update, json}
 */

const { freeze } = Object;
const { createRendererLogger } = require('../../renderer/shared/utils/logger');
const { JobTraceManager } = require('../shared/JobTraceManager');
const { ChatRepository } = require('../../domain/chat/repositories/ChatRepository');
const { MessageRepository } = require('../../domain/chat/repositories/MessageRepository');
const { ArtifactRepository } = require('../../domain/artifacts/repositories/ArtifactRepository');
const { StreamLifecycleManager } = require('../../domain/chat/services/StreamLifecycleManager');
const { ConnectionStateTracker } = require('../../domain/chat/services/ConnectionStateTracker');
const { ChatSessionManager } = require('../../domain/chat/services/ChatSessionManager');
const { MessageSender } = require('../../domain/chat/services/MessageSender');
const { StreamBuffer } = require('../../domain/chat/services/StreamBuffer');

const _log = createRendererLogger('ChatOrchestrator');

class ChatOrchestrator {
  constructor(options = {}) {
    this.enableLogging = options.enableLogging || false;

    this.jobTracer = null;
    this.jobTraceDefaults = { orchestrator: 'ChatOrchestrator' };
    this._jobTracerInitialized = false;
    this._jobTracerOptions = { jobTracer: options.jobTracer || null };
    
    // Core dependencies
    this.container = options.container || null; // DI container
    this.eventBus = options.eventBus || null;
    this.config = options.config || {};
    
    // Communication layer
    this.guruConnection = options.guruConnection || null;
    this.endpoint = options.endpoint || null;
    this.ipcBridge = options.ipcBridge || null;
    this.storageAPI = options.storageAPI || null;
    
    // Repositories (domain data access layer)
    this.chatRepository = options.chatRepository || new ChatRepository({ storageAPI: this.storageAPI });
    this.messageRepository = options.messageRepository || new MessageRepository({ storageAPI: this.storageAPI });
    this.artifactRepository = options.artifactRepository || new ArtifactRepository({ storageAPI: this.storageAPI });
    
    // Infrastructure services
    this.performanceMonitor = options.performanceMonitor || null;
    this.metricsCollector = options.metricsCollector || null;
    this.errorTracker = options.errorTracker || null;

    this._setupJobTracer();
    
    // Chat services (domain layer)
    this.messageService = null;
    this.chatService = null;
    this.artifactService = null;
    this.traceabilityService = null;
    
    // Domain services (initialized after dependencies are ready)
    this.streamBuffer = null;
    this.streamLifecycleManager = null;
    this.connectionStateTracker = null;
    this.chatSessionManager = null;
    this.messageSender = null;
    
    // UI modules (renderer layer - injected)
    this.messageManager = options.messageManager || null;
    this.streamAdapter = options.streamAdapter || null;
    this.sidebarManager = options.sidebarManager || null;
    this.fileManager = options.fileManager || null;
    this.artifactIndicator = options.artifactIndicator || null;
    
    // Lifecycle management
    this.requestLifecycle = null;
    this.isInitialized = false;
    this.isDestroyed = false;
    
    // State
    this.state = {
      currentChatId: null,
      isStreaming: false,
      currentRequestId: null,
      backendConnected: false,
      artifactsWindowOpen: false
    };
    
    // Stream tracking
    this.currentStream = null;
    this.streamBuffer = null; // Initialized as StreamBuffer service in _initializeDomainServices
    
    // Handler tracking for proper cleanup (prevents listener leaks)
    this._eventBusHandlers = [];
    this._ipcBridgeHandlers = [];
    
    if (this.enableLogging) {
      _log.debug('[ChatOrchestrator] Created');
    }
  }

  /**
   * Initialize orchestrator and all services
   * @returns {Promise<void>}
   */
  async init() {
    try {
      if (this.isInitialized) {
        _log.warn('[ChatOrchestrator] Already initialized');
        return;
      }

      if (this.enableLogging) {
        _log.debug('[ChatOrchestrator] Initializing...');
      }

      await this._initializeRequestLifecycle();
      await this._initializeServices();
      await this._initializeDomainServices();
      await this._setupEventListeners();

      // Set initialized BEFORE loading chat -- _loadCurrentChat uses switchChat
      // which calls _ensureInitialized(). Without this, chat loading always fails.
      this.isInitialized = true;

      await this._loadCurrentChat();

      if (this.enableLogging) {
        _log.debug('[ChatOrchestrator] Initialized successfully');
      }

      if (this.eventBus) {
        this.eventBus.emit('chat:orchestrator:initialized');
      }
    } catch (error) {
      _log.error('[ChatOrchestrator] Initialization failed:', error);

      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'ChatOrchestrator.init');
      }

      throw error;
    }
  }

  /**
   * Send user message - delegates to MessageSender domain service
   * @param {string} message - User message
   * @param {Object} options - Send options
   * @returns {Promise<Object>} Request context
   */
  async sendMessage(message, options = {}) {
    this._ensureInitialized();
    
    let request = null;
    
    try {
      // Precondition checks
      if (!this.state.backendConnected) {
        throw new Error('Backend not connected');
      }

      if (!this.guruConnection || typeof this.guruConnection.send !== 'function') {
        throw new Error('GuruConnection not available');
      }
      
      // Ensure we have a chat
      if (!this.state.currentChatId) {
        await this.createNewChat();
      }
      
      // Start request lifecycle
      request = this.requestLifecycle.startRequest({
        type: 'user-message',
        timeout: options.timeout || 120000,
        metadata: {
          chatId: this.state.currentChatId,
          message: message.substring(0, 100),
          files: options.files || []
        },
        onCancel: () => {
          this.streamLifecycleManager.cancelStream({ requestId: request.id });
          this._cleanupStream();
        },
        onTimeout: () => {
          this.streamLifecycleManager.timeoutStream({ requestId: request.id });
          this._cleanupStream();
        }
      });
      
      if (this.performanceMonitor) {
        this.performanceMonitor.start(`sendMessage:${request.id}`);
      }
      
      // Delegate to MessageSender domain service (validates, persists, prepares payload)
      const { persistedMessage, payload } = await this.messageSender.sendMessage(
        message,
        this.state.currentChatId,
        request.id,
        options
      );
      
      // Register with traceability service
      if (this.traceabilityService) {
        this.traceabilityService.registerMessage({
          id: persistedMessage.id,
        chatId: this.state.currentChatId,
          role: 'user',
          correlationId: request.id,
          timestamp: persistedMessage.timestamp || persistedMessage.createdAt || Date.now(),
          artifactIds: []
        });
      }
      
      // UI update - display message
      if (this.messageManager) {
        this.messageManager.displayMessage({
          id: persistedMessage.id,
          role: 'user',
          content: message,
          timestamp: Date.now()
        });
      }
      
      // Send WebSocket payload
      await this.guruConnection.send(payload);
      
      // Update orchestrator state
      this.state.isStreaming = true;
      this.state.currentRequestId = request.id;
      
      if (this.enableLogging) {
        _log.debug('[ChatOrchestrator] Message sent:', request.id);
      }
      
      // Emit event
      if (this.eventBus) {
        this.eventBus.emit('chat:message:sent', { 
          requestId: request.id, 
          chatId: this.state.currentChatId 
        });
      }
      
      return request;
    } catch (error) {
      if (request && typeof request.fail === 'function') {
        request.fail(error);
      }
      
      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'ChatOrchestrator.sendMessage');
      }
      
      throw error;
    } finally {
      if (this.performanceMonitor && request) {
        this.performanceMonitor.end(`sendMessage:${request.id}`);
      }
    }
  }

  /**
   * Handle incoming stream chunk
   * @param {Object} chunk - Stream chunk data
   */
  async handleStreamChunk(chunk) {
    this._ensureInitialized();
    
    if (!this.state.isStreaming) {
      _log.warn('[ChatOrchestrator] Received chunk but not streaming:', chunk);
      return;
    }
    
    try {
      const requestId = this.state.currentRequestId;
      
      // Ensure stream buffer is started
      if (!this.streamBuffer.isStreamActive(requestId)) {
        this.streamBuffer.startStream(requestId, { chatId: this.state.currentChatId });
      }
      
      // Buffer chunk using StreamBuffer domain service
      this.streamBuffer.addChunk(requestId, chunk);
      
      // Pass to StreamAdapter for UI rendering
      if (this.streamAdapter) {
        this.streamAdapter.applyChunk(chunk);
      }
      
      // Track metrics
      if (this.metricsCollector) {
        this.metricsCollector.recordCustom('chat:stream-chunk', chunk.content ? chunk.content.length : 0);
      }
      
      // Check for end signal
      if (chunk.end) {
        await this._finalizeCurrentStream(chunk);
      }
    } catch (error) {
      _log.error('[ChatOrchestrator] Failed to handle stream chunk:', error);
      
      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'ChatOrchestrator.handleStreamChunk');
      }
    }
  }
  
  /**
   * Finalize current stream using StreamLifecycleManager
   * @private
   */
  async _finalizeCurrentStream(endChunk) {
    try {
      await this.streamLifecycleManager.finalizeStream({
        chatId: this.state.currentChatId,
        requestId: this.state.currentRequestId,
        streamBuffer: this.streamBuffer,
        endChunk
      });
      
      // Cleanup local state
      this._cleanupStream();
    } catch (error) {
      _log.error('[ChatOrchestrator] Failed to finalize stream:', error);
      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'ChatOrchestrator._finalizeCurrentStream');
      }
      throw error;
    }
  }

  /**
   * Stop current streaming request
   * @returns {Promise<void>}
   */
  async stopStreaming() {
    this._ensureInitialized();
    this._traceJob('JOB_UPDATE_STATE', {
      stage: 'stopStreaming:enter',
      requestId: this.state.currentRequestId || null
    });
    
    try {
      if (!this.state.isStreaming) {
        if (this.enableLogging) {
          _log.debug('[ChatOrchestrator] No active stream to stop');
        }
        this._traceJob('JOB_GET_STATE', { stage: 'stopStreaming:no-op' });
        return;
      }

      if (this.state.currentRequestId) {
        this.requestLifecycle.cancelRequest(this.state.currentRequestId);
      }

      if (this.guruConnection && typeof this.guruConnection.send === 'function') {
        await this.guruConnection.send({
          type: 'stop',
          id: this.state.currentRequestId
        });
        this._traceJob('JOB_SEND_IPC', {
          stage: 'stopStreaming:notify-backend',
          requestId: this.state.currentRequestId || null
        });
      }

      if (this.enableLogging) {
        _log.debug('[ChatOrchestrator] Stream stopped');
      }
    } catch (error) {
      _log.error('[ChatOrchestrator] Failed to stop streaming:', error);
      this._traceJob('JOB_UPDATE_STATE', {
        stage: 'stopStreaming:error',
        requestId: this.state.currentRequestId || null,
        error: error.message
      });
      
      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'ChatOrchestrator.stopStreaming');
      }
      
      throw error;
    } finally {
      this._cleanupStream();
    }
  }

  /**
   * Switch to different chat - delegates to ChatSessionManager
   * @param {string} chatId - Chat ID
   * @returns {Promise<void>}
   */
  async switchChat(chatId) {
    this._ensureInitialized();
    
    try {
      // Check if already on this chat
      if (this.state.currentChatId === chatId) {
        if (this.enableLogging) {
          _log.debug('[ChatOrchestrator] Already on chat:', chatId);
        }
        return;
      }

      // Stop any active streaming
      if (this.state.isStreaming) {
        await this.stopStreaming();
      }

      // Delegate to ChatSessionManager for domain logic
      const { chat, artifacts } = await this.chatSessionManager.switchToChat(chatId);
      
      // Update orchestrator state
      this.state.currentChatId = chatId;
      
      // Update UI - render messages
      if (this.messageManager && this.messageManager.applyChatMessages) {
        this.messageManager.applyChatMessages(chat.messages || []);
      }

      // Notify artifacts window via IPC
      if (this.ipcBridge && typeof this.ipcBridge.send === 'function') {
        this.ipcBridge.send('artifacts:chat-switched', {
          chatId,
          artifacts
        });
      }

      if (this.enableLogging) {
        _log.debug('[ChatOrchestrator] Switched to chat:', chatId);
      }
    } catch (error) {
      _log.error('[ChatOrchestrator] Failed to switch chat:', error);
      
      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'ChatOrchestrator.switchChat');
      }
      
      throw error;
    }
  }

  /**
   * Create new chat - delegates to ChatSessionManager
   * @param {string} title - Chat title
   * @returns {Promise<Object>} New chat
   */
  async createNewChat(title = 'New Chat') {
    this._ensureInitialized();
    
    try {
      // Delegate to ChatSessionManager for domain logic
      const newChat = await this.chatSessionManager.createChat(title);
      
      // Switch to the new chat (handles UI updates)
      await this.switchChat(newChat.id);

      if (this.enableLogging) {
        _log.debug('[ChatOrchestrator] Created new chat:', newChat.id);
      }

      return newChat;
    } catch (error) {
      _log.error('[ChatOrchestrator] Failed to create chat:', error);

      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'ChatOrchestrator.createNewChat');
      }

      throw error;
    }
  }

  /**
   * Delete chat - delegates to ChatSessionManager
   * @param {string} chatId - Chat ID
   * @returns {Promise<void>}
   */
  async deleteChat(chatId) {
    this._ensureInitialized();
    
    try {
      // Delegate to ChatSessionManager for domain logic
      await this.chatSessionManager.deleteChat(chatId);

      // If we deleted the current chat, switch to a fallback
      if (this.state.currentChatId === chatId) {
        const fallback = await this.chatSessionManager.getFallbackChat(chatId);
        if (fallback && fallback.chat) {
          await this.switchChat(fallback.chat.id);
        } else {
          // No fallback available, clear the state
          this.state.currentChatId = null;
          if (this.messageManager && typeof this.messageManager.clearChat === 'function') {
            await this.messageManager.clearChat();
          }
          if (this.ipcBridge && typeof this.ipcBridge.send === 'function') {
            this.ipcBridge.send('artifacts:chat-switched', {
              chatId: null,
              artifacts: []
            });
          }
        }
      }

      if (this.enableLogging) {
        _log.debug('[ChatOrchestrator] Deleted chat:', chatId);
      }
    } catch (error) {
      _log.error('[ChatOrchestrator] Failed to delete chat:', error);

      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'ChatOrchestrator.deleteChat');
      }

      throw error;
    }
  }

  /**
   * Upload file
   * @param {File} file - File to upload
   * @returns {Promise<Object>} Upload result
   */
  async uploadFile(file) {
    this._ensureInitialized();
    
    try {
      if (!file) {
        throw new Error('No file provided');
      }

      if (!this.fileManager) {
        throw new Error('FileManager not available');
      }

      const result = await this.fileManager.uploadFile(file);

      if (this.enableLogging) {
        _log.debug('[ChatOrchestrator] File uploaded:', result.filename);
      }

      if (this.eventBus) {
        this.eventBus.emit('chat:file:uploaded', result);
      }

      return result;
    } catch (error) {
      _log.error('[ChatOrchestrator] Failed to upload file:', error);

      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'ChatOrchestrator.uploadFile');
      }

      throw error;
    }
  }

  /**
   * Get current state
   * @returns {Object}
   */
  getState() {
    return freeze({ ...this.state });
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    return freeze({
      initialized: this.isInitialized,
      currentChatId: this.state.currentChatId,
      isStreaming: this.state.isStreaming,
      backendConnected: this.state.backendConnected,
      activeRequests: this.requestLifecycle ? this.requestLifecycle.getStats().active : 0,
      requestStats: this.requestLifecycle ? this.requestLifecycle.getStats() : null,
      activeStreams: this.streamBuffer ? this.streamBuffer.getActiveStreams().length : 0
    });
  }

  /**
   * Cleanup and destroy
   */
  destroy() {
    if (this.isDestroyed) return;

    this._traceJob('JOB_DISPOSE', { stage: 'destroy:enter' });
    
    if (this.enableLogging) {
      _log.debug('[ChatOrchestrator] Destroying...');
    }
    
    // Stop streaming
    if (this.state.isStreaming) {
      this.stopStreaming().catch(e => _log.error('Failed to stop streaming:', e));
    }
    
    // Cancel all requests
    if (this.requestLifecycle) {
      this.requestLifecycle.destroy();
    }
    
    // Cleanup event listeners (individual .off() prevents leaking backend:* handlers)
    if (this.eventBus) {
      for (const { event, handler } of this._eventBusHandlers) {
        this.eventBus.off(event, handler);
      }
    }
    this._eventBusHandlers = [];
    
    // Cleanup IPC handlers
    if (this.ipcBridge) {
      for (const { event, handler } of this._ipcBridgeHandlers) {
        this.ipcBridge.off(event, handler);
      }
    }
    this._ipcBridgeHandlers = [];

    // Cleanup connection listeners
    if (this.connectionStateTracker) {
      this.connectionStateTracker.cleanupListeners();
    }
    
    this.isDestroyed = true;
    this.isInitialized = false;
    this._traceJob('JOB_DISPOSE', { stage: 'destroy:complete' });
    
    if (this.enableLogging) {
      _log.debug('[ChatOrchestrator] Destroyed');
    }
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  _setupJobTracer() {
    if (this._jobTracerInitialized) {
      return;
    }

    try {
      if (this._jobTracerOptions && this._jobTracerOptions.jobTracer) {
        this.jobTracer = this._jobTracerOptions.jobTracer;
      } else {
        this.jobTracer = new JobTraceManager({
          enableLogging: this.enableLogging,
          eventBus: this.eventBus,
          historyLimit: 1500
        });
      }
    } catch (traceError) {
      this.jobTracer = null;
      if (this.enableLogging) {
        _log.warn('[ChatOrchestrator] Job tracer unavailable:', traceError);
      }
      if (this.errorTracker && typeof this.errorTracker.captureException === 'function') {
        this.errorTracker.captureException(traceError, 'ChatOrchestrator._setupJobTracer');
      }
    } finally {
      this._jobTracerInitialized = true;
    }
  }

  _traceJob(jobType, context = {}) {
    if (!this.jobTracer || typeof this.jobTracer.record !== 'function') {
      return;
    }

    try {
      this.jobTracer.record(jobType, {
        ...this.jobTraceDefaults,
        ...context
      });
    } catch (traceError) {
      if (this.enableLogging) {
        _log.warn('[ChatOrchestrator] Job tracing failed:', traceError);
      }
      if (this.errorTracker && typeof this.errorTracker.captureException === 'function') {
        this.errorTracker.captureException(traceError, 'ChatOrchestrator._traceJob');
      }
    }
  }

  /**
   * Handle connection state changes from ConnectionStateTracker
   * @private
   */
  _handleConnectionStateChange(isConnected, reason, error) {
    const normalized = Boolean(isConnected);
    const previous = this.state.backendConnected;

    if (previous === normalized) {
      return;
    }

    this.state.backendConnected = normalized;
    this._traceJob('JOB_UPDATE_STATE', {
      stage: 'connection:update',
      connected: normalized,
      reason: reason || null,
      error: error ? error.message : null
    });

    // Notify IPC bridge
    if (this.ipcBridge && typeof this.ipcBridge.send === 'function') {
      try {
        this.ipcBridge.send('chat:backend-status', {
          connected: normalized,
          reason: reason || null
        });
      } catch (ipcError) {
        _log.warn('[ChatOrchestrator] Failed to publish backend status via IPC:', ipcError);
      }
    }
  }

  /**
   * Initialize request lifecycle manager
   * @private
   */
  async _initializeRequestLifecycle() {
    try {
      const { RequestLifecycleManager } = require('../shared/RequestLifecycleManager');

      this.requestLifecycle = new RequestLifecycleManager({
        name: 'ChatOrchestrator',
        enableLogging: this.enableLogging,
        defaultTimeout: 120000,
        maxConcurrentRequests: 5,
        performanceMonitor: this.performanceMonitor
      });
      this._traceJob('JOB_INITIALIZE', { stage: 'requestLifecycle:initialized' });
    } catch (error) {
      _log.error('[ChatOrchestrator] Failed to initialize request lifecycle:', error);
      this._traceJob('JOB_INITIALIZE', { stage: 'requestLifecycle:error', error: error.message });

      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'ChatOrchestrator._initializeRequestLifecycle');
      }

      throw error;
    }
  }

  /**
   * Initialize domain services from DI container
   * @private
   */
  async _initializeServices() {
    if (!this.container) {
      this._traceJob('JOB_INITIALIZE', { stage: 'services:skipped', reason: 'container-missing' });
      return;
    }
    
    try {
      // Domain services from src/domain
      this.messageService = this.container.resolve('MessageService');
      this.chatService = this.container.resolve('ChatService');
      this.artifactService = this.container.resolve('ArtifactService');
      this.traceabilityService = this.container.resolve('TraceabilityService');
      
      this._traceJob('JOB_INITIALIZE', {
        stage: 'services:initialized',
        messageService: Boolean(this.messageService),
        chatService: Boolean(this.chatService),
        artifactService: Boolean(this.artifactService),
        traceabilityService: Boolean(this.traceabilityService)
      });
      
      if (this.enableLogging) {
        _log.debug('[ChatOrchestrator] Domain services initialized');
      }
    } catch (error) {
      _log.warn('[ChatOrchestrator] Some domain services not available:', error);
      this._traceJob('JOB_INITIALIZE', {
        stage: 'services:error',
        error: error.message
      });
    }
  }
  
  /**
   * Initialize domain service instances
   * @private
   */
  async _initializeDomainServices() {
    try {
      // StreamBuffer - handles stream chunk buffering
      this.streamBuffer = new StreamBuffer({
        enableLogging: this.enableLogging,
        logger: this.enableLogging ? console : null
      });
      
      // StreamLifecycleManager - handles stream finalization
      this.streamLifecycleManager = new StreamLifecycleManager({
        messageRepository: this.messageRepository,
        traceabilityService: this.traceabilityService,
        requestLifecycle: this.requestLifecycle,
        eventBus: this.eventBus,
        errorTracker: this.errorTracker,
        logger: this.enableLogging ? console : null
      });
      
      // ConnectionStateTracker - manages WebSocket connection state
      this.connectionStateTracker = new ConnectionStateTracker({
        guruConnection: this.guruConnection,
        onConnectionChange: (isConnected, reason, error) => {
          this._handleConnectionStateChange(isConnected, reason, error);
        },
        logger: this.enableLogging ? console : null
      });
      
      // ChatSessionManager - handles chat lifecycle (create, switch, delete)
      this.chatSessionManager = new ChatSessionManager({
        chatRepository: this.chatRepository,
        artifactRepository: this.artifactRepository,
        traceabilityService: this.traceabilityService,
        eventBus: this.eventBus,
        errorTracker: this.errorTracker,
        logger: this.enableLogging ? console : null
      });
      
      // MessageSender - handles message sending workflow
      this.messageSender = new MessageSender({
        messageRepository: this.messageRepository,
        enableLogging: this.enableLogging,
        logger: this.enableLogging ? console : null
      });
      
      // Setup connection listeners
      this.connectionStateTracker.setupListeners();
      
      this._traceJob('JOB_INITIALIZE', {
        stage: 'domainServices:initialized',
        hasStreamBuffer: Boolean(this.streamBuffer),
        hasStreamLifecycleManager: Boolean(this.streamLifecycleManager),
        hasConnectionStateTracker: Boolean(this.connectionStateTracker),
        hasChatSessionManager: Boolean(this.chatSessionManager),
        hasMessageSender: Boolean(this.messageSender)
      });
      
      if (this.enableLogging) {
        _log.debug('[ChatOrchestrator] Domain service instances initialized');
      }
    } catch (error) {
      _log.error('[ChatOrchestrator] Failed to initialize domain services:', error);
      this._traceJob('JOB_INITIALIZE', {
        stage: 'domainServices:error',
        error: error.message
      });
      
      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'ChatOrchestrator._initializeDomainServices');
      }
      
      throw error;
    }
  }

  /**
   * Setup event listeners
   * @private
   */
  async _setupEventListeners() {
    try {
      if (this.eventBus) {
        const onStreamChunk = (chunk) => {
          this.handleStreamChunk(chunk);
        };
        const onStreamComplete = (data) => {
          if (this.requestLifecycle && this.requestLifecycle.isActive(data.requestId)) {
            this.requestLifecycle.completeRequest(data.requestId, data);
          }
        };
        const onStreamError = (data) => {
          if (this.requestLifecycle && this.requestLifecycle.isActive(data.requestId)) {
            this.requestLifecycle.failRequest(data.requestId, data.error);
          }
        };

        this.eventBus.on('backend:stream-chunk', onStreamChunk);
        this.eventBus.on('backend:stream-complete', onStreamComplete);
        this.eventBus.on('backend:stream-error', onStreamError);

        this._eventBusHandlers.push(
          { event: 'backend:stream-chunk', handler: onStreamChunk },
          { event: 'backend:stream-complete', handler: onStreamComplete },
          { event: 'backend:stream-error', handler: onStreamError }
        );
      }

      if (this.ipcBridge) {
        const onSendMessage = (message) => {
          this.sendMessage(message).catch(error => {
            _log.error('[ChatOrchestrator] Failed to send message:', error);
          });
        };
        const onStopStreaming = () => {
          this.stopStreaming().catch(error => {
            _log.error('[ChatOrchestrator] Failed to stop streaming:', error);
          });
        };
        const onSwitchChat = (chatId) => {
          this.switchChat(chatId).catch(error => {
            _log.error('[ChatOrchestrator] Failed to switch chat:', error);
          });
        };
        const onCreateChat = () => {
          this.createNewChat().catch(error => {
            _log.error('[ChatOrchestrator] Failed to create chat:', error);
          });
        };
        const onDeleteChat = (chatId) => {
          this.deleteChat(chatId).catch(error => {
            _log.error('[ChatOrchestrator] Failed to delete chat:', error);
          });
        };

        this.ipcBridge.on('chat:send-message', onSendMessage);
        this.ipcBridge.on('chat:stop-streaming', onStopStreaming);
        this.ipcBridge.on('chat:switch-chat', onSwitchChat);
        this.ipcBridge.on('chat:create-chat', onCreateChat);
        this.ipcBridge.on('chat:delete-chat', onDeleteChat);

        this._ipcBridgeHandlers.push(
          { event: 'chat:send-message', handler: onSendMessage },
          { event: 'chat:stop-streaming', handler: onStopStreaming },
          { event: 'chat:switch-chat', handler: onSwitchChat },
          { event: 'chat:create-chat', handler: onCreateChat },
          { event: 'chat:delete-chat', handler: onDeleteChat }
        );
      }

      this._traceJob('JOB_INITIALIZE', {
        stage: 'listeners:initialized',
        eventBus: Boolean(this.eventBus),
        ipcBridge: Boolean(this.ipcBridge)
      });

      if (this.enableLogging) {
        _log.debug('[ChatOrchestrator] Event listeners setup');
      }
    } catch (error) {
      _log.error('[ChatOrchestrator] Failed to setup event listeners:', error);
      this._traceJob('JOB_INITIALIZE', {
        stage: 'listeners:error',
        error: error.message
      });

      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'ChatOrchestrator._setupEventListeners');
      }

      throw error;
    }
  }

  /**
   * Load current chat - delegates to ChatSessionManager
   * @private
   */
  async _loadCurrentChat() {
    try {
      // Delegate to ChatSessionManager for domain logic
      const { chat } = await this.chatSessionManager.loadCurrentChat();
      
      // Switch to the loaded chat (handles UI updates)
      await this.switchChat(chat.id);
      
      if (this.enableLogging) {
        _log.debug('[ChatOrchestrator] Current chat loaded');
      }
    } catch (error) {
      _log.error('[ChatOrchestrator] Failed to load current chat:', error);
      this._traceJob('JOB_LOAD_FROM_DB', {
        stage: 'loadCurrentChat:error',
        error: error.message
      });
    }
  }

  /**
   * Cleanup stream state
   * @private
   */
  _cleanupStream() {
    // Clear stream buffer if we have an active request
    if (this.state.currentRequestId && this.streamBuffer) {
        try {
        this.streamBuffer.clearStream(this.state.currentRequestId);
    } catch (error) {
        // Silently handle if stream doesn't exist
    if (this.enableLogging) {
          _log.warn('[ChatOrchestrator] Stream cleanup warning:', error.message);
        }
    }
  }

    this.state.isStreaming = false;
    this.state.currentRequestId = null;
  }

  /**
   * Ensure orchestrator is initialized
   * @private
   */
  _ensureInitialized() {
    if (this.isDestroyed) {
      throw new Error('ChatOrchestrator has been destroyed');
    }

    if (!this.isInitialized) {
      throw new Error('ChatOrchestrator not initialized. Call init() first.');
    }
  }
}

// Export
module.exports = { ChatOrchestrator };

if (typeof window !== 'undefined') {
  window.ChatOrchestrator = ChatOrchestrator;
  _log.debug('ChatOrchestrator loaded');
}
