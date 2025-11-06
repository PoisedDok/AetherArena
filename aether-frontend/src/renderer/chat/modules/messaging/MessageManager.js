'use strict';

/**
 * @.architecture
 * 
 * Incoming: GuruConnection.on('message') via endpoint.connection (WebSocket from backend), IPC 'chat:request-complete' (from ChatController.js) --- {stream_types.websocket_stream_chunk, json}
 * Processing: Coordinate 8 submodules (SecuritySanitizer, MarkdownRenderer, MessageView, MessageState, SendController, StopController, StreamHandler, TrailContainerManager), route WebSocket streams to StreamHandler, visualize execution pipeline in TRAIL containers, handle user input, route artifacts to ChatController --- {8 jobs: JOB_DELEGATE_TO_MODULE, JOB_DISPOSE, JOB_EMIT_EVENT, JOB_GENERATE_SESSION_ID, JOB_GET_STATE, JOB_INITIALIZE, JOB_ROUTE_BY_TYPE, JOB_UPDATE_STATE}
 * Outgoing: streamHandler.processChunk() → StreamHandler.js, sendController.send() → Endpoint.js, trailContainerManager.createTrail() → DOM, eventBus.emit('artifact:stream') → ChatController --- {message_types.user_message | artifact_stream | method_call, json}
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
const TrailContainerManager = require('../trail/TrailContainerManager');
const TrailDOMRenderer = require('../trail/TrailDOMRenderer');
const TrailStyleManager = require('../trail/TrailStyleManager');

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
    this.trailContainerManager = null;

    // DOM references (populated on init)
    this.inputElement = null;
    this.sendButton = null;
    this.contentElement = null;

    // State
    this.isProcessing = false;
    this.isStopMode = false;

    // IPC listeners tracking
    this._ipcListeners = [];
    
    // Throttled logging for artifact streaming
    this._artifactLogThrottle = {
      lastLog: 0,
      interval: 1000, // Log at most once per second
      updateCount: 0
    };

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

    // 8. TrailContainerManager (execution pipeline visualization)
    // Create style manager and inject CSS
    const trailStyleManager = new TrailStyleManager();
    trailStyleManager.inject(); // FIXED: Correct method name is inject()
    
    // Create DOM renderer
    const trailDOMRenderer = new TrailDOMRenderer({
      styleManager: trailStyleManager,
      eventBus: this.eventBus,
      enableLogging: false
    });
    
    // Create trail container manager
    this.trailContainerManager = new TrailContainerManager({
      container: this.contentElement, // Chat content container
      renderer: trailDOMRenderer,
      eventBus: this.eventBus,
      enableLogging: false
    });

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
   * Setup IPC listeners
   * @private
   * 
   * Chat uses direct WebSocket connection for streaming.
   * IPC is only used for completion signals and control messages.
   */
  _setupIPCListeners() {
    if (!this.ipcBridge) {
      console.warn('[MessageManager] No IPC bridge available');
      return;
    }

    const onRequestComplete = async (_, data) => {
      console.log('[MessageManager] Request complete:', data);
      this.setProcessing(false);
      this.setStopMode(false);
      await this.streamHandler.forceFinalize();
    };

    this.ipcBridge.on('chat:request-complete', onRequestComplete);
    this._ipcListeners.push({ 
      channel: 'chat:request-complete', 
      handler: onRequestComplete 
    });

    console.log('[MessageManager] IPC listeners setup');
  }

  /**
   * Setup WebSocket listeners for streaming
   * @private
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
    try {
      if (!payload || typeof payload !== 'object') {
        return;
      }

      const { role, type, content, start, end, id, format } = payload;

    // =========================================================================
    // ARTIFACT ROUTING - Forward to artifacts window via ChatController
    // =========================================================================
    
    // Handle code artifacts (assistant writes code)
    if (role === 'assistant' && type === 'code') {
      this._logArtifact('code', format || 'unknown', start, end);
      this._routeArtifactToChatController(payload);
      return;
    }

    // Handle console output (computer execution results)
    if (role === 'computer' && (type === 'console' || type === 'output')) {
      this._logArtifact('console', type, start, end);
      this._routeArtifactToChatController(payload);
      return;
    }

    // Handle HTML artifacts (rendered output)
    if (role === 'computer' && type === 'code' && format === 'html') {
      this._logArtifact('html', format, start, end);
      this._routeArtifactToChatController(payload);
      return;
    }

    // =========================================================================
    // MESSAGE STREAMING - Process text messages in StreamHandler
    // =========================================================================
    
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

    // =========================================================================
    // SERVER CONTROL MESSAGES
    // =========================================================================
    
    // Handle completion signal
    if (role === 'server' && type === 'completion') {
      console.log(`[MessageManager] Request complete: ${id}`);
      this.setProcessing(false);
      this.setStopMode(false);
      this.streamHandler.forceFinalize();
      
      // Finalize trail when ALL artifacts complete
      if (this.trailContainerManager && this.trailContainerManager.activeTrailContainer) {
        setTimeout(() => {
          console.log('[MessageManager] 🏁 Finalizing trail after completion signal');
          this.trailContainerManager.finalizeCurrentTrail();
        }, 500); // Small delay to ensure smooth animation
      }
    }

    // Handle stop confirmation
    if (role === 'server' && type === 'stopped') {
      console.log(`[MessageManager] Request stopped: ${id}`);
      this.setProcessing(false);
      this.setStopMode(false);
      this.streamHandler.forceFinalize();
      
      // Finalize trail on stop as well
      if (this.trailContainerManager && this.trailContainerManager.activeTrailContainer) {
        setTimeout(() => {
          console.log('[MessageManager] 🛑 Finalizing trail after stop signal');
          this.trailContainerManager.finalizeCurrentTrail();
        }, 500);
      }
    }

    // Handle errors
    if (type === 'error') {
      console.error('[MessageManager] Backend error:', payload);
      this.setProcessing(false);
      this.setStopMode(false);
    }
    } catch (error) {
      console.error('[MessageManager] Error handling WebSocket message:', error, payload);
    }
  }

  /**
   * Route artifact to ChatController for forwarding to artifacts window
   * AND update TRAIL container visualization
   * @private
   * @param {Object} payload - Artifact payload
   */
  _routeArtifactToChatController(payload) {
    // Route to artifacts window via ChatController
    if (this.eventBus) {
      this.eventBus.emit('artifact:stream', payload);
    } else {
      console.warn('[MessageManager] No eventBus - cannot route artifact');
    }
    
    // Update TRAIL container with execution phases
    this._updateTrailWithArtifact(payload);
  }
  
  /**
   * Update TRAIL container with artifact execution data
   * Maps artifacts to execution phases: write → process → execute → output
   * 
   * TRAIL LIFECYCLE TRACING:
   * 1. Assistant writes code → 'write' phase (role=assistant, type=code)
   * 2. System processes → 'process' phase (automatic)
   * 3. Computer executes → 'execute' phase (role=computer, type=console)
   * 4. Computer returns output → 'output' phase (role=computer, type=code)
   * 5. Server sends completion → Trail finalized (role=server, type=completion)
   * 
   * @private
   * @param {Object} payload - Artifact payload
   */
  _updateTrailWithArtifact(payload) {
    if (!this.trailContainerManager) {
      return;
    }
    
    const { id, role, type, format, start, end, content } = payload;
    
    // Determine phase based on artifact type and role
    let phase = null;
    let status = 'pending';
    
    if (role === 'assistant' && type === 'code') {
      phase = 'write'; // Assistant writing code
      status = start ? 'active' : (end ? 'complete' : 'active');
      if (start) console.log(`[MessageManager] 🎬 TRAIL PHASE: write started - ID: ${id}`);
      if (end) console.log(`[MessageManager] ✅ TRAIL PHASE: write completed - ID: ${id}`);
    } else if (role === 'computer' && type === 'console') {
      phase = 'execute'; // Computer executing code
      status = start ? 'active' : (end ? 'complete' : 'active');
      if (start) console.log(`[MessageManager] 🎬 TRAIL PHASE: execute started - ID: ${id}`);
      if (end) console.log(`[MessageManager] ✅ TRAIL PHASE: execute completed - ID: ${id}`);
    } else if (role === 'computer' && type === 'code') {
      phase = 'output'; // Computer returning output/HTML
      status = start ? 'active' : (end ? 'complete' : 'active');
      if (start) console.log(`[MessageManager] 🎬 TRAIL PHASE: output started - ID: ${id}`);
      if (end) console.log(`[MessageManager] ✅ TRAIL PHASE: output completed - ID: ${id}`);
    }
    
    if (!phase) {
      return; // Not a trail-tracked artifact
    }
    
    // Create or update execution in trail
    const execution = {
      id: id,
      phases: [
        {
          kind: 'write',  // Changed from 'name' to 'kind' to match TrailDOMRenderer expectation
          status: phase === 'write' ? status : (phase === 'execute' || phase === 'output' ? 'complete' : 'pending'),
          artifactId: phase === 'write' ? id : null,
          artifactType: phase === 'write' ? format : null,
          startTime: phase === 'write' && start ? Date.now() : undefined,
          endTime: phase === 'write' && end ? Date.now() : undefined
        },
        {
          kind: 'process',
          status: phase === 'execute' || phase === 'output' ? 'complete' : 'pending',
          artifactId: null,
          artifactType: null
        },
        {
          kind: 'execute',
          status: phase === 'execute' ? status : (phase === 'output' ? 'complete' : 'pending'),
          artifactId: phase === 'execute' ? id : null,
          artifactType: 'console',
          startTime: phase === 'execute' && start ? Date.now() : undefined,
          endTime: phase === 'execute' && end ? Date.now() : undefined
        },
        {
          kind: 'output',
          status: phase === 'output' ? status : 'pending',
          artifactId: phase === 'output' ? id : null,
          artifactType: phase === 'output' ? format : null,
          startTime: phase === 'output' && start ? Date.now() : undefined,
          endTime: phase === 'output' && end ? Date.now() : undefined
        }
      ]
    };
    
    this.trailContainerManager.addExecutionToTrail(execution);
    
    // DON'T finalize here - wait for server completion signal
    // Trail finalization happens in _handleWebSocketMessage when role='server', type='completion'
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

  async sendMessage(content, options = {}) {
    console.log('[MessageManager] Sending message:', content.substring(0, 50));

    try {
      const tempId = this._generateMessageId();
      const userMessage = {
        id: tempId,
        role: 'user',
        content: content,
        timestamp: new Date().toISOString()
      };

      this.messageView.renderMessage(userMessage);
      
      const savedMessage = await this.messageState.saveMessage(userMessage);

      if (savedMessage && savedMessage.id !== tempId) {
        console.log(`[MessageManager] User message ID updated: ${tempId} → ${savedMessage.id}`);
        
        const element = this.messageView.getMessageElement(tempId);
        if (element) {
          element.dataset.messageId = savedMessage.id;
          
          this.messageView.messageElements.delete(tempId);
          this.messageView.messageElements.set(savedMessage.id, element);
        }
        
        userMessage.id = savedMessage.id;
      }

      if (this.streamHandler) {
        this.streamHandler.userMessageId = userMessage.id;
      }

      if (this.inputElement) {
        this.inputElement.value = '';
        this._autoResizeInput();
      }

      this.setProcessing(true);
      this.setStopMode(true);

      const requestId = await this.sendController.send(content, {
        correlationId: userMessage.id
      });

      this._updateChatTitleIfNeeded(content);

      console.log(`[MessageManager] Message sent with requestId: ${requestId}`);
    } catch (error) {
      console.error('[MessageManager] Failed to send message:', error);
      this.setProcessing(false);
      this.setStopMode(false);
    }
  }

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
      const chat = await this.messageState.loadChat(chatId);
      
      if (chat && chat.title && this.eventBus) {
        this.eventBus.emit('chat:title-changed', { title: chat.title });
      }
      
      if (this.trailContainerManager) {
        this.trailContainerManager.switchChat(chatId);
        this.trailContainerManager.setCurrentChat(chatId);
        console.log('[MessageManager] Trail state switched for new chat');
      }
      
      this.messageView.clear();
      
      sessionManager.setActiveChat(chatId);
      console.log(`[MessageManager] Set active session: ${chatId}`);
      
      await this._notifyBackendContextSwitch(chatId);

      if (window.ipcBridge && typeof window.ipcBridge.send === 'function') {
        window.ipcBridge.send('artifacts:switch-chat', chatId);
        console.log('[MessageManager] Notified artifacts window of chat switch');
      }

      const messages = this.messageState.getMessages();
      
      if (messages.length === 0) {
        this.messageView.showEmptyState();
      } else {
        for (const message of messages) {
          this.messageView.renderMessage(message);
        }
      }
      
      if (this.trailContainerManager) {
        this.trailContainerManager.restoreTrailState(chatId);
        console.log('[MessageManager] Trail state restored for chat');
      }

      console.log(`[MessageManager] Loaded ${messages.length} messages, session active: ${chatId.slice(0,8)}`);
    } catch (error) {
      console.error('[MessageManager] Failed to load chat:', error);
    }
  }

  async createChat(title = 'New Chat') {
    console.log(`[MessageManager] Creating new chat: ${title}`);

    try {
      const chatId = await this.messageState.createChat(title);
      
      if (this.eventBus) {
        this.eventBus.emit('chat:title-changed', { title });
      }
      
      if (this.trailContainerManager) {
        this.trailContainerManager.switchChat(chatId);
        this.trailContainerManager.setCurrentChat(chatId);
        this.trailContainerManager.resetNumbering();
        console.log('[MessageManager] Trail state switched for new chat');
      }
      
      this.clearMessages();
      
      sessionManager.setActiveChat(chatId);
      console.log(`[MessageManager] Created and activated session: ${chatId.slice(0,8)}`);
      
      await this._notifyBackendContextSwitch(chatId);
      
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
   * Notify backend to reset context when switching/creating chats
   * @private
   * @param {string} chatId - Chat ID
   */
  async _notifyBackendContextSwitch(chatId) {
    if (!this.sendController || !this.sendController.endpoint) {
      console.warn('[MessageManager] Cannot notify backend - no endpoint available');
      return;
    }
    
    try {
      // Send context reset message to backend via GuruConnection
      const resetMessage = {
        role: 'user',
        type: 'context_reset',
        chat_id: chatId,
        timestamp: Date.now()
      };
      
      console.log(`[MessageManager] 🔄 Notifying backend of context switch: ${chatId.slice(0,8)}`);
      
      // Send via GuruConnection (correct property is 'connection', not 'guruConnection')
      if (this.sendController.endpoint.connection) {
        this.sendController.endpoint.connection.send(resetMessage);
        console.log(`[MessageManager] ✅ Context reset sent to backend for chat ${chatId.slice(0,8)}`);
      } else {
        console.warn('[MessageManager] ⚠️  No WebSocket connection available for context reset');
      }
    } catch (error) {
      console.error('[MessageManager] Failed to notify backend of context switch:', error);
      // Non-fatal - continue anyway
    }
  }
  
  /**
   * Log artifact detection with throttling
   * @private
   * @param {string} artifactType - Type of artifact
   * @param {string} format - Format/subtype
   * @param {boolean} start - Is start marker
   * @param {boolean} end - Is end marker
   */
  _logArtifact(artifactType, format, start, end) {
    const now = Date.now();
    const throttle = this._artifactLogThrottle;
    
    throttle.updateCount++;
    
    // Always log start/end markers
    if (start) {
      console.log(`[MessageManager] 📦 ▶ ${artifactType.toUpperCase()} artifact started (${format})`);
      throttle.lastLog = now;
      return;
    }
    
    if (end) {
      console.log(`[MessageManager] 📦 ✓ ${artifactType.toUpperCase()} artifact completed (${format}) | ${throttle.updateCount} chunks`);
      throttle.updateCount = 0;
      throttle.lastLog = now;
      return;
    }
    
    // Throttle intermediate updates
    if (now - throttle.lastLog >= throttle.interval) {
      console.log(`[MessageManager] 📦 ${artifactType.toUpperCase()} streaming | ${throttle.updateCount} chunks | ${format}`);
      throttle.lastLog = now;
      throttle.updateCount = 0;
    }
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

