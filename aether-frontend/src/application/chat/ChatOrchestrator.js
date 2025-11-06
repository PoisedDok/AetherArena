'use strict';

/**
 * @.architecture
 * 
 * Incoming: EventBus.on('backend:stream-*') (WebSocket stream events), IpcBridge.on('chat:*') (IPC commands from main process), storageAPI methods (PostgreSQL queries), container.resolve() (DI service resolution) --- {event_types.stream_chunk | ipc_message | database_types.* | method_calls, json}
 * Processing: Initialize RequestLifecycleManager and domain services, coordinate message lifecycle (send→stream→buffer→persist), accumulate stream chunks in buffer, delegate to UI modules (messageManager/streamAdapter/fileManager), manage chat CRUD via PostgreSQL storageAPI, emit events to EventBus, send IPC to artifacts window, cleanup and dispose resources --- {10 jobs: JOB_ACCUMULATE_TEXT, JOB_DELEGATE_TO_MODULE, JOB_DISPOSE, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_INITIALIZE, JOB_LOAD_FROM_DB, JOB_SAVE_TO_DB, JOB_SEND_IPC, JOB_UPDATE_STATE}
 * Outgoing: GuruConnection.send() (backend WebSocket), storageAPI.saveMessage/loadChat/createChat/deleteChat (PostgreSQL), IpcBridge.send('artifacts:*') (artifacts window), messageManager.displayMessage/applyChatMessages (DOM updates), streamAdapter.applyChunk (streaming UI), EventBus.emit() (internal events) --- {websocket_message | database_types.message_record | ipc_message | method_call | custom_event, json}
 * 
 * 
 * @module application/chat/ChatOrchestrator
 * 
 * ChatOrchestrator - Chat window application orchestrator
 * ============================================================================
 * Coordinates all chat window services and modules:
 * - MessageManager (message display and handling)
 * - StreamAdapter (streaming chunk processing)
 * - MessageState (PostgreSQL persistence)
 * - SidebarManager (chat history sidebar)
 * - FileManager (file attachments)
 * - ArtifactActivityIndicator (artifact status display)
 * - TraceabilityService (message-artifact linking)
 * 
 * Orchestrates:
 * - Message lifecycle (send → stream → persist)
 * - Streaming coordination (chunks → thinking → display)
 * - Chat switching (load from PostgreSQL)
 * - Artifact routing (two-stage: chat → artifacts window)
 * - File uploads
 * - Stop/cancel operations
 * 
 * Architecture: Application layer tying domain services to the chat renderer.
 */

const { freeze } = Object;

class ChatOrchestrator {
  constructor(options = {}) {
    this.enableLogging = options.enableLogging || false;
    
    // Core dependencies
    this.container = options.container || null; // DI container
    this.eventBus = options.eventBus || null;
    this.config = options.config || {};
    
    // Communication layer
    this.guruConnection = options.guruConnection || null;
    this.endpoint = options.endpoint || null;
    this.ipcBridge = options.ipcBridge || null;
    this.storageAPI = options.storageAPI || null;
    
    // Infrastructure services
    this.performanceMonitor = options.performanceMonitor || null;
    this.metricsCollector = options.metricsCollector || null;
    this.errorTracker = options.errorTracker || null;
    
    // Chat services (domain layer)
    this.messageService = null;
    this.chatService = null;
    this.artifactService = null;
    this.traceabilityService = null;
    
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
    this.streamBuffer = [];
    
    if (this.enableLogging) {
      console.log('[ChatOrchestrator] Created');
    }
  }

  /**
   * Initialize orchestrator and all services
   * @returns {Promise<void>}
   */
  async init() {
    if (this.isInitialized) {
      console.warn('[ChatOrchestrator] Already initialized');
      return;
    }
    
    if (this.enableLogging) {
      console.log('[ChatOrchestrator] Initializing...');
    }
    
    try {
      // Initialize in dependency order
      await this._initializeRequestLifecycle();
      await this._initializeServices();
      await this._setupEventListeners();
      await this._loadCurrentChat();
      
      this.isInitialized = true;
      
      if (this.enableLogging) {
        console.log('[ChatOrchestrator] Initialized successfully');
      }
      
      // Emit initialization event
      if (this.eventBus) {
        this.eventBus.emit('chat:orchestrator:initialized');
      }
    } catch (error) {
      console.error('[ChatOrchestrator] Initialization failed:', error);
      
      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'ChatOrchestrator.init');
      }
      
      throw error;
    }
  }

  /**
   * Send user message
   * @param {string} message - User message
   * @param {Object} options - Send options
   * @returns {Promise<Object>} Request context
   */
  async sendMessage(message, options = {}) {
    this._ensureInitialized();
    
    if (!message || typeof message !== 'string') {
      throw new Error('Invalid message');
    }
    
    if (!this.state.backendConnected) {
      throw new Error('Backend not connected');
    }
    
    // Ensure we have a chat
    if (!this.state.currentChatId) {
      await this.createNewChat();
    }
    
    // Start request lifecycle
    const request = this.requestLifecycle.startRequest({
      type: 'user-message',
      timeout: options.timeout || 120000,
      metadata: {
        chatId: this.state.currentChatId,
        message: message.substring(0, 100), // First 100 chars for logging
        files: options.files || []
      },
      onCancel: () => {
        this._handleStreamCancel();
      },
      onTimeout: () => {
        this._handleStreamTimeout();
      }
    });
    
    try {
      // Track with performance monitor
      if (this.performanceMonitor) {
        this.performanceMonitor.start(`sendMessage:${request.id}`);
      }
      
      // Save user message to PostgreSQL first
      const savedUserMsg = await this.storageAPI.saveMessage(this.state.currentChatId, {
        role: 'user',
        content: message,
        correlation_id: request.id
      });
      
      // Display user message in UI
      if (this.messageManager) {
        this.messageManager.displayMessage({
          id: savedUserMsg.id,
          role: 'user',
          content: message,
          timestamp: Date.now()
        });
      }
      
      // Send to backend via guru connection
      const payload = {
        role: 'user',
        type: 'message',
        id: request.id,
        content: message,
        files: options.files || [],
        ...options
      };
      
      await this.guruConnection.send(payload);
      
      // Update state
      this.state.isStreaming = true;
      this.state.currentRequestId = request.id;
      
      if (this.enableLogging) {
        console.log('[ChatOrchestrator] Message sent:', request.id);
      }
      
      // Emit event
      if (this.eventBus) {
        this.eventBus.emit('chat:message:sent', { requestId: request.id, chatId: this.state.currentChatId });
      }
      
      // Return request context for tracking
      return request;
    } catch (error) {
      request.fail(error);
      throw error;
    } finally {
      if (this.performanceMonitor) {
        this.performanceMonitor.end(`sendMessage:${request.id}`);
      }
    }
  }

  /**
   * Handle incoming stream chunk
   * @param {Object} chunk - Stream chunk data
   */
  handleStreamChunk(chunk) {
    this._ensureInitialized();
    
    if (!this.state.isStreaming) {
      console.warn('[ChatOrchestrator] Received chunk but not streaming:', chunk);
      return;
    }
    
    try {
      // Buffer chunk
      this.streamBuffer.push(chunk);
      
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
        this._handleStreamEnd(chunk);
      }
    } catch (error) {
      console.error('[ChatOrchestrator] Failed to handle stream chunk:', error);
      
      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'ChatOrchestrator.handleStreamChunk');
      }
    }
  }

  /**
   * Stop current streaming request
   * @returns {Promise<void>}
   */
  async stopStreaming() {
    this._ensureInitialized();
    
    if (!this.state.isStreaming) {
      if (this.enableLogging) {
        console.log('[ChatOrchestrator] No active stream to stop');
      }
      return;
    }
    
    // Cancel request
    if (this.state.currentRequestId) {
      this.requestLifecycle.cancelRequest(this.state.currentRequestId);
    }
    
    // Send stop signal to backend
    try {
      await this.guruConnection.send({
        type: 'stop-request',
        id: this.state.currentRequestId
      });
    } catch (error) {
      console.error('[ChatOrchestrator] Failed to send stop signal:', error);
    }
    
    // Cleanup stream state
    this._cleanupStream();
    
    if (this.enableLogging) {
      console.log('[ChatOrchestrator] Stream stopped');
    }
  }

  /**
   * Switch to different chat
   * @param {string} chatId - Chat ID
   * @returns {Promise<void>}
   */
  async switchChat(chatId) {
    this._ensureInitialized();
    
    if (this.state.currentChatId === chatId) {
      if (this.enableLogging) {
        console.log('[ChatOrchestrator] Already on chat:', chatId);
      }
      return;
    }
    
    // Stop any active streaming
    if (this.state.isStreaming) {
      await this.stopStreaming();
    }
    
    try {
      // Load chat from PostgreSQL
      const chat = await this.storageAPI.loadChat(chatId);
      
      // Update state
      this.state.currentChatId = chatId;
      
      // Apply to UI via MessageManager
      if (this.messageManager && this.messageManager.applyChatMessages) {
        this.messageManager.applyChatMessages(chat.messages || []);
      }
      
      // Load artifacts for this chat
      const artifacts = await this.storageAPI.loadArtifacts(chatId);
      
      // Notify artifacts window
      if (this.ipcBridge) {
        this.ipcBridge.send('artifacts:chat-switched', {
          chatId,
          artifacts
        });
      }
      
      if (this.enableLogging) {
        console.log('[ChatOrchestrator] Switched to chat:', chatId);
      }
      
      // Emit event
      if (this.eventBus) {
        this.eventBus.emit('chat:switched', { chatId, messageCount: chat.messages?.length || 0 });
      }
    } catch (error) {
      console.error('[ChatOrchestrator] Failed to switch chat:', error);
      throw error;
    }
  }

  /**
   * Create new chat
   * @param {string} title - Chat title
   * @returns {Promise<Object>} New chat
   */
  async createNewChat(title = 'New Chat') {
    this._ensureInitialized();
    
    try {
      // Create in PostgreSQL
      const newChat = await this.storageAPI.createChat(title);
      
      // Switch to new chat
      await this.switchChat(newChat.id);
      
      if (this.enableLogging) {
        console.log('[ChatOrchestrator] Created new chat:', newChat.id);
      }
      
      // Emit event
      if (this.eventBus) {
        this.eventBus.emit('chat:created', { chatId: newChat.id });
      }
      
      return newChat;
    } catch (error) {
      console.error('[ChatOrchestrator] Failed to create chat:', error);
      throw error;
    }
  }

  /**
   * Delete chat
   * @param {string} chatId - Chat ID
   * @returns {Promise<void>}
   */
  async deleteChat(chatId) {
    this._ensureInitialized();
    
    try {
      // Delete from PostgreSQL
      await this.storageAPI.deleteChat(chatId);
      
      // If current chat, switch to another or create new
      if (this.state.currentChatId === chatId) {
        const chats = await this.storageAPI.loadChats();
        
        if (chats.length > 0) {
          await this.switchChat(chats[0].id);
        } else {
          await this.createNewChat();
        }
      }
      
      if (this.enableLogging) {
        console.log('[ChatOrchestrator] Deleted chat:', chatId);
      }
      
      // Emit event
      if (this.eventBus) {
        this.eventBus.emit('chat:deleted', { chatId });
      }
    } catch (error) {
      console.error('[ChatOrchestrator] Failed to delete chat:', error);
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
    
    if (!file) {
      throw new Error('No file provided');
    }
    
    try {
      // Use FileManager to upload
      if (!this.fileManager) {
        throw new Error('FileManager not available');
      }
      
      const result = await this.fileManager.uploadFile(file);
      
      if (this.enableLogging) {
        console.log('[ChatOrchestrator] File uploaded:', result.filename);
      }
      
      // Emit event
      if (this.eventBus) {
        this.eventBus.emit('chat:file:uploaded', result);
      }
      
      return result;
    } catch (error) {
      console.error('[ChatOrchestrator] Failed to upload file:', error);
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
      streamBufferSize: this.streamBuffer.length
    });
  }

  /**
   * Cleanup and destroy
   */
  destroy() {
    if (this.isDestroyed) return;
    
    if (this.enableLogging) {
      console.log('[ChatOrchestrator] Destroying...');
    }
    
    // Stop streaming
    if (this.state.isStreaming) {
      this.stopStreaming().catch(e => console.error('Failed to stop streaming:', e));
    }
    
    // Cancel all requests
    if (this.requestLifecycle) {
      this.requestLifecycle.destroy();
    }
    
    // Cleanup event listeners
    if (this.eventBus) {
      this.eventBus.removeAllListeners('chat:*');
    }
    
    // Cleanup IPC
    if (this.ipcBridge) {
      this.ipcBridge.removeAllListeners('chat:*');
    }
    
    this.isDestroyed = true;
    this.isInitialized = false;
    
    if (this.enableLogging) {
      console.log('[ChatOrchestrator] Destroyed');
    }
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Initialize request lifecycle manager
   * @private
   */
  async _initializeRequestLifecycle() {
    const { RequestLifecycleManager } = require('../shared/RequestLifecycleManager');
    
    this.requestLifecycle = new RequestLifecycleManager({
      name: 'ChatOrchestrator',
      enableLogging: this.enableLogging,
      defaultTimeout: 120000,
      maxConcurrentRequests: 5,
      performanceMonitor: this.performanceMonitor
    });
  }

  /**
   * Initialize domain services
   * @private
   */
  async _initializeServices() {
    if (!this.container) return;
    
    try {
      // Domain services from src/domain
      this.messageService = this.container.resolve('MessageService');
      this.chatService = this.container.resolve('ChatService');
      this.artifactService = this.container.resolve('ArtifactService');
      this.traceabilityService = this.container.resolve('TraceabilityService');
      
      if (this.enableLogging) {
        console.log('[ChatOrchestrator] Domain services initialized');
      }
    } catch (error) {
      console.warn('[ChatOrchestrator] Some domain services not available:', error);
    }
  }

  /**
   * Setup event listeners
   * @private
   */
  async _setupEventListeners() {
    // EventBus listeners
    if (this.eventBus) {
      this.eventBus.on('backend:stream-chunk', (chunk) => {
        this.handleStreamChunk(chunk);
      });
      
      this.eventBus.on('backend:stream-complete', (data) => {
        if (this.requestLifecycle.isActive(data.requestId)) {
          this.requestLifecycle.completeRequest(data.requestId, data);
        }
      });
      
      this.eventBus.on('backend:stream-error', (data) => {
        if (this.requestLifecycle.isActive(data.requestId)) {
          this.requestLifecycle.failRequest(data.requestId, data.error);
        }
      });
    }
    
    // IPC listeners
    if (this.ipcBridge) {
      this.ipcBridge.on('chat:send-message', (message) => {
        this.sendMessage(message).catch(error => {
          console.error('[ChatOrchestrator] Failed to send message:', error);
        });
      });
      
      this.ipcBridge.on('chat:stop-streaming', () => {
        this.stopStreaming().catch(error => {
          console.error('[ChatOrchestrator] Failed to stop streaming:', error);
        });
      });
      
      this.ipcBridge.on('chat:switch-chat', (chatId) => {
        this.switchChat(chatId).catch(error => {
          console.error('[ChatOrchestrator] Failed to switch chat:', error);
        });
      });
      
      this.ipcBridge.on('chat:create-chat', () => {
        this.createNewChat().catch(error => {
          console.error('[ChatOrchestrator] Failed to create chat:', error);
        });
      });
      
      this.ipcBridge.on('chat:delete-chat', (chatId) => {
        this.deleteChat(chatId).catch(error => {
          console.error('[ChatOrchestrator] Failed to delete chat:', error);
        });
      });
    }
    
    if (this.enableLogging) {
      console.log('[ChatOrchestrator] Event listeners setup');
    }
  }

  /**
   * Load current chat
   * @private
   */
  async _loadCurrentChat() {
    try {
      // Load most recent chat from PostgreSQL
      const chats = await this.storageAPI.loadChats();
      
      if (chats.length > 0) {
        await this.switchChat(chats[0].id);
      } else {
        // Create first chat
        await this.createNewChat();
      }
      
      if (this.enableLogging) {
        console.log('[ChatOrchestrator] Current chat loaded');
      }
    } catch (error) {
      console.error('[ChatOrchestrator] Failed to load current chat:', error);
    }
  }

  /**
   * Handle stream end
   * @private
   */
  async _handleStreamEnd(chunk) {
    try {
      // Combine all buffered chunks
      const fullContent = this.streamBuffer
        .map(c => c.content || '')
        .join('');
      
      // Save assistant message to PostgreSQL
      const savedAssistantMsg = await this.storageAPI.saveMessage(this.state.currentChatId, {
        role: 'assistant',
        content: fullContent,
        llm_model: chunk.model || null,
        llm_provider: chunk.provider || null,
        tokens_used: chunk.tokens || null,
        correlation_id: this.state.currentRequestId
      });
      
      // Link artifacts to this message
      if (this.traceabilityService) {
        await this.traceabilityService.linkArtifactsToMessage(
          this.state.currentRequestId,
          savedAssistantMsg.id
        );
      }
      
      // Complete request
      if (this.state.currentRequestId) {
        this.requestLifecycle.completeRequest(this.state.currentRequestId, {
          messageId: savedAssistantMsg.id
        });
      }
      
      // Cleanup
      this._cleanupStream();
      
      if (this.enableLogging) {
        console.log('[ChatOrchestrator] Stream ended, message saved:', savedAssistantMsg.id);
      }
    } catch (error) {
      console.error('[ChatOrchestrator] Failed to handle stream end:', error);
      
      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'ChatOrchestrator._handleStreamEnd');
      }
    }
  }

  /**
   * Handle stream cancel
   * @private
   */
  _handleStreamCancel() {
    if (this.enableLogging) {
      console.log('[ChatOrchestrator] Stream cancelled');
    }
    
    this._cleanupStream();
    
    // Emit event
    if (this.eventBus) {
      this.eventBus.emit('chat:stream:cancelled');
    }
  }

  /**
   * Handle stream timeout
   * @private
   */
  _handleStreamTimeout() {
    console.warn('[ChatOrchestrator] Stream timed out');
    
    this._cleanupStream();
    
    // Emit event
    if (this.eventBus) {
      this.eventBus.emit('chat:stream:timeout');
    }
  }

  /**
   * Cleanup stream state
   * @private
   */
  _cleanupStream() {
    this.state.isStreaming = false;
    this.state.currentRequestId = null;
    this.streamBuffer = [];
  }

  /**
   * Ensure orchestrator is initialized
   * @private
   */
  _ensureInitialized() {
    if (!this.isInitialized) {
      throw new Error('ChatOrchestrator not initialized. Call init() first.');
    }
    
    if (this.isDestroyed) {
      throw new Error('ChatOrchestrator has been destroyed');
    }
  }
}

// Export
module.exports = { ChatOrchestrator };

if (typeof window !== 'undefined') {
  window.ChatOrchestrator = ChatOrchestrator;
  console.log('📦 ChatOrchestrator loaded');
}

