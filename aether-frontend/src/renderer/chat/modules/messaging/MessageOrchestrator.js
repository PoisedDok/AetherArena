'use strict';

/**
 * @.architecture
 *
 * Incoming: EventBus ASSISTANT_STREAM events, user input events, IPC request-complete, FileManager attachment state --- {websocket.stream | event.dom | ipc.control | file_state, json|Event|boolean}
 * Processing: Thin coordination - check for file attachments, render user message with attachments in UI BEFORE FileManager clears queue, delegate backend sending to FileManager/SendController, route stream events to handlers, NO business logic --- {5 jobs: JOB_COORDINATE, JOB_ROUTE_BY_TYPE, JOB_VALIDATE_SCHEMA, JOB_UPDATE_STATE, JOB_EMIT_EVENT}
 * Outgoing: MessageView.renderMessageWithAttachments() for UI display, FileManager.sendFiles() for backend processing (vision/docling), SendController.send() for text-only messages, state updates --- {method_call | state_update, void}
 *
 * @module renderer/chat/modules/messaging/MessageOrchestrator
 */

const { EventTypes } = require('../../../../core/events/EventTypes');
const { createRendererLogger } = require('../../../shared/utils/logger');
const sessionBridge = require('../../../shared/adapters/session');

// Routing
const MessageEventRouter = require('./routing/MessageEventRouter');
const ArtifactRoutingManager = require('./routing/ArtifactRoutingManager');
const ArtifactEnrichmentManager = require('./routing/ArtifactEnrichmentManager');

// Queue
const MessageQueueProcessor = require('./queue/MessageQueueProcessor');

// Handlers
const AssistantMessageHandler = require('./handlers/AssistantMessageHandler');
const TrailEventHandler = require('./handlers/TrailEventHandler');
const ControlMessageHandler = require('./handlers/ControlMessageHandler');

// UI
const InputUIController = require('./ui/InputUIController');
const StatusBarManager = require('./ui/StatusBarManager');
const ScrollManager = require('./ui/ScrollManager');

// Transport & Events
const IPCTransportManager = require('./transport/IPCTransportManager');
const EventEmissionManager = require('./events/EventEmissionManager');

// Lifecycle
const ChatLifecycleManager = require('./lifecycle/ChatLifecycleManager');

// Existing modules (kept as-is for now)
const MessageView = require('./MessageView');
const MessageState = require('./MessageState');
const SendController = require('./SendController');
const StopController = require('./StopController');
const StreamHandler = require('./StreamHandler');
const SecuritySanitizer = require('../../../shared/security/SecuritySanitizer');
const MarkdownRenderer = require('../../../shared/messaging/MarkdownRenderer');
const TrailStyleManager = require('../trail/TrailStyleManager');
const TrailContainerOrchestrator = require('../trail/TrailContainerOrchestrator');

const Toast = require('../../../shared/components/Toast');

const orchestratorLogger = createRendererLogger('MessageOrchestrator');

/**
 * MessageOrchestrator - Module Coordination Layer
 * ================================================
 * 
 * SINGLE RESPONSIBILITY: Coordinate specialized messaging modules
 * 
 * ARCHITECTURE PRINCIPLES (from TrailContainerOrchestrator pattern):
 * - THIN: < 300 lines, pure delegation
 * - NO business logic
 * - NO state management (delegates to MessageState)
 * - NO rendering (delegates to MessageView)
 * - NO routing (delegates to MessageEventRouter)
 * 
 * FLOW:
 * WebSocket Event → MessageQueueProcessor → MessageEventRouter → Handler Modules
 * User Input → InputUIController → SendController → Backend
 * 
 * @module renderer/chat/modules/messaging/MessageOrchestrator
 */
class MessageOrchestrator {
  constructor(options = {}) {
    this.chatWindow = options.chatWindow || null;
    this.eventBus = options.eventBus || null;
    this.ipc = options.ipc || null;
    this.storageAPI = options.storageAPI || null;
    this.fileManager = options.fileManager || null;
    this.config = options.config || {};
    this.endpoint = options.endpoint || null;
    this.log = orchestratorLogger.child({ scope: 'message-orchestrator' });

    if (!this.chatWindow) {
      throw new Error('[MessageOrchestrator] chatWindow is REQUIRED');
    }

    if (!this.eventBus) {
      throw new Error('[MessageOrchestrator] eventBus is REQUIRED');
    }

    if (!this.ipc) {
      throw new Error('[MessageOrchestrator] ipc is REQUIRED');
    }

    // State
    this.isProcessing = false;
    this.isStopMode = false;

    // Lifecycle
    this._isDisposed = false;

    // Listener tracking
    this._eventListeners = [];
    this._ipcListeners = [];

    this.log.debug('MessageOrchestrator constructed');
  }

  /**
   * Initialize orchestrator and all modules
   */
  async init() {
    if (this._isDisposed) return;
    this.log.info('Initializing MessageOrchestrator');

    try {
      // Get DOM elements from ChatWindow
      const elements = this.chatWindow.getElements();
      this.inputElement = elements.input;
      this.sendButton = elements.sendBtn;
      this.contentElement = elements.content;
      this.statusElement = elements.status || null;

      if (!this.inputElement || !this.sendButton || !this.contentElement) {
        throw new Error('Required DOM elements not found');
      }

      // Initialize all specialized modules
      await this._initializeModules();

      // Setup event listeners
      this._setupEventListeners();

      this.log.info('MessageOrchestrator initialization complete');
    } catch (error) {
      this.log.error('MessageOrchestrator initialization failed', { error });
      throw error;
    }
  }

  /**
   * Initialize all messaging modules
   * @private
   */
  async _initializeModules() {
    this.log.debug('Initializing messaging modules');

    // =========================================================================
    // CORE DEPENDENCIES
    // =========================================================================

    this.securitySanitizer = new SecuritySanitizer();
    this.markdownRenderer = new MarkdownRenderer({ securitySanitizer: this.securitySanitizer });

    // =========================================================================
    // VIEW & STATE
    // =========================================================================

    // Initialize MessageState first (so MessageView can reference it)
    this.messageState = new MessageState({
      eventBus: this.eventBus,
      ipc: this.ipc,
      storageAPI: this.storageAPI,
    });
    await this.messageState.init({ autoLoad: false });

    this.messageView = new MessageView({
      markdownRenderer: this.markdownRenderer,
      securitySanitizer: this.securitySanitizer,
      eventBus: this.eventBus,
      messageState: this.messageState  // CRITICAL FIX: Pass messageState for chatId access
    });
    this.messageView.init(this.contentElement);

    // =========================================================================
    // CONTROLLERS (Existing)
    // =========================================================================

    this.sendController = new SendController({
      ipc: this.ipc,
      eventBus: this.eventBus
    });
    this.sendController.init();

    this.stopController = new StopController({
      ipc: this.ipc,
      eventBus: this.eventBus,
      sendController: this.sendController,
      endpoint: this.endpoint
    });
    this.stopController.init();

    this.streamHandler = new StreamHandler({
      messageView: this.messageView,
      messageState: this.messageState,
      eventBus: this.eventBus,
      sessionAPI: sessionBridge
    });
    this.streamHandler.init();

    // =========================================================================
    // NEW MODULAR ARCHITECTURE
    // =========================================================================

    // UI Controllers
    this.inputUI = new InputUIController({ inputElement: this.inputElement });
    this.inputUI.setupListeners();

    this.statusBar = new StatusBarManager({ statusElement: this.statusElement });
    this.scrollManager = new ScrollManager({ 
      contentElement: this.contentElement,
      eventBus: this.eventBus
    });

    // Transport & Events
    this.ipcTransport = new IPCTransportManager({ ipc: this.ipc });
    this.eventEmitter = new EventEmissionManager({ eventBus: this.eventBus });

    // Routing & Enrichment
    this.enrichmentManager = new ArtifactEnrichmentManager();
    this.artifactRouter = new ArtifactRoutingManager({
      eventBus: this.eventBus,
      enrichmentManager: this.enrichmentManager
    });

    // Handlers
    this.assistantHandler = new AssistantMessageHandler({ streamHandler: this.streamHandler });
    
    this.trailHandler = new TrailEventHandler({
      eventBus: this.eventBus,
      enrichmentManager: this.enrichmentManager,
      artifactRoutingManager: this.artifactRouter
    });

    this.controlHandler = new ControlMessageHandler({
      streamHandler: this.streamHandler,
      messageState: this.messageState,
      messageView: this.messageView,
      onProcessingChange: (processing) => this.setProcessing(processing),
      onStopModeChange: (enabled) => this.setStopMode(enabled)
    });

    // Router
    this.router = new MessageEventRouter({
      artifactHandler: this.artifactRouter,
      messageHandler: this.assistantHandler,
      trailHandler: this.trailHandler,
      controlHandler: this.controlHandler,
      eventBus: this.eventBus  // For proactive notifications
    });

    // Queue Processor
    this.queueProcessor = new MessageQueueProcessor({ router: this.router });

    // Trail Orchestrator
    const trailStyleManager = new TrailStyleManager();
    trailStyleManager.inject();

    this.trailOrchestrator = new TrailContainerOrchestrator({
      container: this.contentElement,
      eventBus: this.eventBus,
      apiBaseUrl: this.config.API_BASE_URL,
      enableLogging: false
    });

    // Chat Lifecycle
    this.chatLifecycle = new ChatLifecycleManager({
      messageState: this.messageState,
      messageView: this.messageView,
      eventBus: this.eventBus,
      ipc: this.ipc,
      trailOrchestrator: this.trailOrchestrator
    });

    this.log.debug('All messaging modules initialized');
  }

  /**
   * Setup event listeners for user input
   * @private
   */
  _setupEventListeners() {
    // MEMORY FIX: Track DOM listeners for proper cleanup
    const sendButtonHandler = () => this._handleSend();
    this.sendButton.addEventListener('click', sendButtonHandler);
    this._eventListeners.push({
      type: 'dom',
      element: this.sendButton,
      event: 'click',
      handler: sendButtonHandler
    });

    // Enter key in input
    const inputKeydownHandler = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._handleSend();
      }
    };
    this.inputElement.addEventListener('keydown', inputKeydownHandler);
    this._eventListeners.push({
      type: 'dom',
      element: this.inputElement,
      event: 'keydown',
      handler: inputKeydownHandler
    });

    // EventBus: WebSocket assistant stream
    const cleanupAssistantStream = this.eventBus.on(
      EventTypes.CHAT.ASSISTANT_STREAM,
      (payload) => {
        if (!payload || typeof payload !== 'object') {
          this.log.warn('Ignoring assistant stream payload without structured data');
          return;
        }
        this.queueProcessor.enqueue(payload);
      }
    );

    if (typeof cleanupAssistantStream === 'function') {
      this._eventListeners.push(cleanupAssistantStream);
    }

    // IPC: Request completion
    const onRequestComplete = async (_, data) => {
      this.log.debug('Request complete via IPC', data);
      this.setProcessing(false);
      this.setStopMode(false);
      await this.streamHandler.forceFinalize();
    };

    const cleanup = this.ipc.on('chat:request-complete', onRequestComplete);
    this._ipcListeners.push(cleanup);

    // IPC: Request failed (synchronous or asynchronous failure from main process)
    const onMessageFailed = async (_, data) => {
      this.log.error('Message failed via IPC', data);
      this.setProcessing(false);
      this.setStopMode(false);
      
      if (this.eventBus) {
        this.eventBus.emit(EventTypes.CHAT.MESSAGE_ERROR, {
          requestId: data.requestId || data.id || data.request_id || data.correlation_id,
          error: data.error || 'Unknown error occurred',
          timestamp: Date.now()
        });
      }
    };
    
    const cleanupFailed = this.ipc.on('chat:message:failed', onMessageFailed);
    this._ipcListeners.push(cleanupFailed);

    // EventBus: Message retry
    const cleanupRetry = this.eventBus.on('chat:message-retry-requested', async (payload) => {
      if (!payload || !payload.messageId) return;
      this.log.info('Message retry requested', { messageId: payload.messageId });
      
      if (!this.messageState) return;
      
      const message = this.messageState.messages.find(m => m.id === payload.messageId || m.correlation_id === payload.messageId);
      if (!message || message.role !== 'user') {
        this.log.warn('Cannot retry non-user or missing message', { payload });
        return;
      }
      
      try {
        // Reset status
        message.status = 'pending';
        delete message.error;
        
        this.setProcessing(true);
        this.setStopMode(true);
        
        const correlationId = message.correlation_id || this._generateCorrelationId();
        const chatId = this.messageState.currentChatId;
        
        // Setup stream handler for the retry
        if (this.streamHandler) {
          this.streamHandler.userMessageId = message.id;
          this.streamHandler.userMessageCorrelationId = correlationId;
        }
        
        // Re-send through pipeline
        await this.sendController.send(message.content || '', {
          correlationId,
          chatId
        });
        
        this.log.info('Retry dispatched successfully');
      } catch (err) {
        this.log.error('Failed to retry message', { error: err.message });
        if (this.messageView && typeof this.messageView.updateMessageStatus === 'function') {
          this.messageView.updateMessageStatus(payload.messageId, 'error', err.message);
        }
        this.setProcessing(false);
        this.setStopMode(false);
      }
    });
    this._eventListeners.push(cleanupRetry);

    // EventBus: Title update requested (from ChatWindow double-click)
    const cleanupTitleUpdate = this.eventBus.on(
      'chat:title-update-requested',
      async (payload) => {
        if (!payload || !payload.chatId || !payload.title) {
          this.log.warn('Invalid title update payload', { payload });
          return;
        }
        
        try {
          this.log.debug('Title update requested', { chatId: payload.chatId, title: payload.title });
          
          // CRITICAL FIX: Use this.messageState instead of this.stateManager
          if (!this.messageState) {
            this.log.error('MessageState not initialized', { payload });
            return;
          }
          
          await this.messageState.updateChatTitle(payload.title);
          
          // Emit success event for UI updates
          this.eventBus.emit('chat:title-updated', {
            chatId: payload.chatId,
            title: payload.title
          });
          
          this.log.info('Chat title updated successfully', { chatId: payload.chatId, title: payload.title });
        } catch (error) {
          this.log.error('Failed to update chat title', { error, payload });
        }
      }
    );
    
    if (typeof cleanupTitleUpdate === 'function') {
      this._eventListeners.push(cleanupTitleUpdate);
    }

    this.log.trace('Event listeners registered');
  }

  /**
   * Handle send button/enter key
   * @private
   */
  async _handleSend() {
    if (this._isDisposed) return;
    // If in stop mode, stop the request
    if (this.isStopMode) {
      await this.stop();
      return;
    }

    // Get input value
    const content = this.inputUI.getValue();

    // ARCHITECTURAL FIX: Check for file attachments
    // Must render UI AND send through proper message pipeline
    if (this.fileManager && this.fileManager.hasAttachments()) {
      this.log.info('Detected file attachments, rendering and sending');
      
      let tempId;
      try {
        // 1. Generate message ID (UI) and correlation ID (backend linkage)
        tempId = await this._generateMessageId();
        const correlationId = this._generateCorrelationId();
        
        // 2. Create user message object
        const userMessage = {
          id: tempId,
          role: 'user',
          content: content || '',
          timestamp: Date.now(),
          correlation_id: correlationId
        };
        
        // 3. Capture attachment data BEFORE FileManager clears
        const attachmentData = {
          imageBase64: this.fileManager.getAttachedImage(),
          files: this.fileManager.getFileQueue()
        };
        
        // 4. Render message with attachments in UI
        this.messageView.renderMessageWithAttachments(userMessage, attachmentData);
        
        // 5. Force smooth scroll to bottom for new user message
        if (this.eventBus) {
          this.eventBus.emit('scroll:request-bottom', { behavior: 'smooth', force: true });
        }
        
        // 6. Add to local state
        this.messageState.messages.push(userMessage);
        
        // 6. Set stream handler context
        if (this.streamHandler) {
          this.streamHandler.userMessageId = userMessage.id;
          this.streamHandler.userMessageCorrelationId = userMessage.correlation_id;
        }
        
        // 7. Clear input
        this.inputUI.clear();
        
        // 8. Set processing state
        this.setProcessing(true);
        this.setStopMode(true);
        
        // 9. Send through proper message pipeline with correlation_id
        // CRITICAL: Pass chat ID explicitly to avoid stale controller.currentChatId
        const chatId = this.messageState.currentChatId;
        
        // Process files first (uploads artifacts to backend with correct chat ID)
        // CRITICAL: Pass correlationId for message-artifact linkage (backend UUID)
        await this.fileManager.sendFiles(content || '', chatId, correlationId);
        
      // Send user message as-is (don't modify with attachment data)
      // Backend will detect artifacts with is_chat_summary=true and inject into agent context
      const normalizedContent = content || 'Attached file';
      
      // Send the chat message through normal pipeline (for backend persistence)
      const requestId = await this.sendController.send(normalizedContent, {
        correlationId,
        chatId: chatId
      });
      
      this._updateChatTitleIfNeeded(normalizedContent);
      this.statusBar.clear();
      
      this.log.info('File attachments rendered and sent successfully', {
        requestId,
        chatId: this.messageState.currentChatId ? this.messageState.currentChatId.substring(0, 8) : 'none'
      });
      return;
    } catch (error) {
      this.log.error('Failed to send file attachments', { error });
      
      // CRITICAL FIX: Prevent orphaned UI state on send failure
      // Remove message from DOM and state, restore text so user doesn't lose work
      if (this.messageView && typeof tempId !== 'undefined') {
        this.messageView.removeMessageSequence(tempId);
      }
      if (this.messageState && this.messageState.messages) {
        this.messageState.messages = this.messageState.messages.filter(m => m.id !== tempId);
      }
      if (content) {
        this.inputUI.inputElement.value = content;
        this.inputUI.autoResize();
      }
      // Attachments are cleared by fileManager during send, so we warn the user to re-attach them
      this.log.warn('Send failed: user must re-attach files', { messageId: tempId });

      this.setProcessing(false);
      this.setStopMode(false);
      const errorMsg = `Failed to send attachments: ${error.message}`;
      this.statusBar.showError(errorMsg);
      Toast.error(errorMsg);
      return;
    }
  }

  if (!content) {
      this.log.debug('Ignoring empty message submission');
      return;
    }

    // Send message
    await this.sendMessage(content);
  }

  /**
   * Send message
   * @param {string} content - Message content
   * @param {Object} options - Send options
   */
  async sendMessage(content, options = {}) {
    if (this._isDisposed) return;
    this.log.info('Sending user message', { preview: content.substring(0, 50) });

    const trimmedContent = content.trim();

    if (!trimmedContent) {
      this.log.debug('Ignoring empty message submission');
      return;
    }

    let normalizedContent = trimmedContent;

    // Preflight validation
    if (this.sendController && typeof this.sendController.preflightValidate === 'function') {
      try {
        normalizedContent = this.sendController.preflightValidate(trimmedContent);
      } catch (error) {
        if (error?.isValidationError) {
          this._handleSendValidationError(error);
          return;
        }

        this.log.error('Send preflight failed', { error });
        const errorMsg = error?.message || 'Unable to validate message.';
        this.statusBar.showError(errorMsg);
        Toast.error(errorMsg);
        return;
      }
    }

    this.inputUI.clearValidation();

    let tempId;
    try {
      tempId = await this._generateMessageId();
      const correlationId = this._generateCorrelationId();
      const userMessage = {
        id: tempId,
        role: 'user',
        content: normalizedContent,
        timestamp: Date.now(),
        correlation_id: correlationId // CRITICAL: Backend linkage uses UUID correlation_id
      };

      this.messageView.renderMessage(userMessage);

      // Force smooth scroll to bottom for new user message
      if (this.eventBus) {
        this.eventBus.emit('scroll:request-bottom', { behavior: 'smooth', force: true });
      }

      // ARCHITECTURAL FIX: Backend is sole persistence authority
      // After WS refactor, backend persists ALL messages in stream_orchestrator
      // Frontend only renders temporarily - messages loaded from backend on chat switch
      // Removed: Frontend message persistence (caused duplicates)
      
      // Keep message in local state for current session rendering
      this.messageState.messages.push(userMessage);

      if (this.streamHandler) {
        this.streamHandler.userMessageId = userMessage.id;
        this.streamHandler.userMessageCorrelationId = userMessage.correlation_id;
      }

      this.inputUI.clear();

      this.setProcessing(true);
      this.setStopMode(true);

      const requestId = await this.sendController.send(normalizedContent, {
        correlationId,
        chatId: this.messageState.currentChatId
      });

      this._updateChatTitleIfNeeded(normalizedContent);

      this.statusBar.clear();
      this.log.info('Message sent to backend', {
        requestId,
        chatId: this.messageState.currentChatId ? this.messageState.currentChatId.substring(0, 8) : 'none'
      });
    } catch (error) {
      this.log.error('Failed to send message', { error });
      
      // CRITICAL FIX: Prevent orphaned UI state on send failure
      // Remove message from DOM and state, restore text so user doesn't lose work
      if (this.messageView && tempId) {
        this.messageView.removeMessageSequence(tempId);
      }
      if (this.messageState && this.messageState.messages) {
        this.messageState.messages = this.messageState.messages.filter(m => m.id !== tempId);
      }
      if (content) {
        this.inputUI.inputElement.value = content;
        this.inputUI.autoResize();
      }

      this.setProcessing(false);
      this.setStopMode(false);

      if (error?.isValidationError) {
        this._handleSendValidationError(error);
      } else {
        const errorMsg = error?.message || 'Failed to send message.';
        this.statusBar.showError(errorMsg);
        Toast.error(errorMsg);
      }
    }
  }

  /**
   * Stop current request
   */
  async stop() {
    if (this._isDisposed) return;
    this.log.info('Stopping active request');

    try {
      await this.stopController.stop();
    } catch (error) {
      this.log.error('Failed to stop active request via controller', { error });
    } finally {
      // CRITICAL FIX: Always release UI locks even if IPC stop request fails
      this.setProcessing(false);
      this.setStopMode(false);

      if (this.streamHandler && this.streamHandler.isStreaming()) {
        await this.streamHandler.forceFinalize();
      }
    }
  }

  /**
   * Load chat
   * @param {string} chatId - Chat ID
   */
  async loadChat(chatId, options = {}) {
    if (this._isDisposed) return;
    await this.chatLifecycle.loadChat(chatId, options);
  }

  /**
   * Create chat
   * @param {string} title - Chat title
   * @param {Object} [options] - Options for creating the chat
   * @returns {Promise<string>} Chat ID
   */
  async createChat(title = 'New Chat', options = {}) {
    if (this._isDisposed) return null;
    return await this.chatLifecycle.createChat(title, options);
  }

  /**
   * Clear active chat
   */
  async clearChat() {
    if (this._isDisposed) return;
    if (this.chatLifecycle && typeof this.chatLifecycle.clearChat === 'function') {
      await this.chatLifecycle.clearChat();
    }
  }

  /**
   * Set processing state
   * Shows/hides typing indicator for premium visual feedback.
   * @param {boolean} processing
   */
  setProcessing(processing) {
    this.isProcessing = processing;
    this.eventEmitter.emitProcessingState(processing);

    // Typing indicator: show when processing starts, hide when it ends
    if (this.messageView) {
      if (processing) {
        this.messageView.showTypingIndicator();
      } else {
        this.messageView.hideTypingIndicator();
      }
    }
  }

  /**
   * Set stop mode
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

    this.eventEmitter.emitStopModeState(enabled);
  }

  /**
   * Handle send validation error
   * @private
   * @param {Error} error - Validation error
   */
  _handleSendValidationError(error) {
    const message = error?.message || 'Message blocked by security policy.';
    this.log.warn('Message blocked by validation', { reason: message });
    this.inputUI.markError(message);
    this.statusBar.showError(message);
    this.setProcessing(false);
    this.setStopMode(false);
    this.inputUI.focus();
  }

  /**
   * Update chat title if first message
   * @private
   * @param {string} content - Message content
   */
  _updateChatTitleIfNeeded(content) {
    const messages = this.messageState.getMessages();
    if (messages.length === 1) {
      const title = content.substring(0, 50).trim();
      if (this.eventBus) {
        this.eventBus.emit('chat:title-changed', { title });
      }
      this.messageState.updateChatTitle(title);
    }
  }

  /**
   * Generate message ID using SessionManager
   * @private
   * @returns {Promise<string>}
   */
  async _generateMessageId() {
    const chatId = this.messageState?.getCurrentChatId?.() || null;
    try {
      return await sessionBridge.nextUserMessageId({ chatId });
    } catch (error) {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
      }
      return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    }
  }

  _generateCorrelationId() {
    if (typeof crypto === 'undefined' || !crypto.randomUUID) {
      throw new Error('[MessageOrchestrator] CONTRACT VIOLATION: crypto.randomUUID is required for correlation ID generation.');
    }
    return crypto.randomUUID();
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
    if (this._isDisposed) return;
    this._isDisposed = true;
    this.log.info('Disposing MessageOrchestrator');

    // Remove listeners
    for (const cleanup of this._ipcListeners) {
      try {
        if (typeof cleanup === 'function') cleanup();
      } catch (error) {
        this.log.warn('Failed to remove IPC listener', { error });
      }
    }
    this._ipcListeners = [];

    for (const item of this._eventListeners) {
      try {
        if (typeof item === 'function') {
          // EventBus cleanup function
          item();
        } else if (item.type === 'dom' && item.element && item.event && item.handler) {
          // MEMORY FIX: DOM listener cleanup
          item.element.removeEventListener(item.event, item.handler);
        }
      } catch (error) {
        this.log.warn('Failed to remove listener', { error });
      }
    }
    this._eventListeners = [];

    // Dispose all modules
    if (this.queueProcessor) this.queueProcessor.dispose();
    if (this.router) this.router.dispose();
    if (this.assistantHandler) this.assistantHandler.dispose();
    if (this.trailHandler) this.trailHandler.dispose();
    if (this.controlHandler) this.controlHandler.dispose();
    if (this.artifactRouter) this.artifactRouter.dispose();
    if (this.enrichmentManager) this.enrichmentManager.dispose();
    if (this.chatLifecycle) this.chatLifecycle.dispose();
    if (this.inputUI) this.inputUI.dispose();
    if (this.statusBar) this.statusBar.dispose();
    if (this.scrollManager) this.scrollManager.dispose();
    if (this.ipcTransport) this.ipcTransport.dispose();
    if (this.eventEmitter) this.eventEmitter.dispose();
    if (this.streamHandler) this.streamHandler.dispose();
    if (this.stopController) this.stopController.dispose();
    if (this.sendController) this.sendController.dispose();
    if (this.messageState) this.messageState.dispose();
    if (this.messageView) this.messageView.dispose();
    if (this.markdownRenderer) this.markdownRenderer.dispose();
    if (this.securitySanitizer) this.securitySanitizer.dispose();
    // MO-2: TrailContainerOrchestrator uses destroy(), not dispose()
    if (this.trailOrchestrator) this.trailOrchestrator.destroy();

    this.log.debug('MessageOrchestrator disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MessageOrchestrator;
}

if (typeof window !== 'undefined') {
  window.MessageOrchestrator = MessageOrchestrator;
}
