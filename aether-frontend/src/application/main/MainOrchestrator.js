'use strict';

/**
 * @.architecture
 * 
 * Incoming: GuruConnection.on('message') (WebSocket events), IpcBridge.on('main:*') (IPC commands), container.resolve() (DI injections) --- {websocket_stream_chunk | ipc_message | method_calls, json}
 * Processing: Initialize RequestLifecycleManager, coordinate submodules (UIManager/AudioManager/Visualizer/ConnectionMonitor/ModelManager/ProfileManager/SettingsManager), route messages/requests, manage application state --- {8 jobs: JOB_INITIALIZE, JOB_ROUTE_BY_TYPE, JOB_DELEGATE_TO_MODULE, JOB_UPDATE_STATE, JOB_GET_STATE, JOB_EMIT_EVENT, JOB_TRACK_ENTITY, JOB_GENERATE_SESSION_ID}
 * Outgoing: GuruConnection.send() → Backend WebSocket, IpcBridge.send() → Chat/Artifacts windows, EventBus.emit() → internal subscribers --- {websocket_stream_chunk | ipc_message | custom_event, json}
 * 
 * 
 * @module application/main/MainOrchestrator
 * 
 * MainOrchestrator - Main window application orchestrator
 * ============================================================================
 * Coordinates all main window services and modules:
 * - UIManager (UI state and controls)
 * - AudioManager (TTS and audio streaming)
 * - Visualizer (neural network visualization)
 * - EventHandler (IPC, keyboard, window events)
 * - ConnectionMonitor (backend connection status)
 * - ModelManager (LLM model selection)
 * - ProfileManager (user profiles)
 * - SettingsManager (application settings)
 * 
 * Architecture: Application layer tying domain services to the main renderer.
 */

const { freeze } = Object;

class MainOrchestrator {
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
    
    // Infrastructure services
    this.performanceMonitor = options.performanceMonitor || null;
    this.metricsCollector = options.metricsCollector || null;
    this.errorTracker = options.errorTracker || null;
    
    // Application services (from src/application/main)
    this.uiManager = null;
    this.audioManager = null;
    this.visualizer = null;
    this.eventHandler = null;
    this.connectionMonitor = null;
    this.modelManager = null;
    this.profileManager = null;
    this.settingsManager = null;
    this.uiStateManager = null;
    
    // Lifecycle management
    this.requestLifecycle = null;
    this.isInitialized = false;
    this.isDestroyed = false;
    
    // State
    this.state = {
      backendConnected: false,
      currentProfile: null,
      currentModel: null,
      audioEnabled: false,
      visualizerActive: false
    };
    
    if (this.enableLogging) {
      console.log('[MainOrchestrator] Created');
    }
  }

  /**
   * Initialize orchestrator and all services
   * @returns {Promise<void>}
   */
  async init() {
    if (this.isInitialized) {
      console.warn('[MainOrchestrator] Already initialized');
      return;
    }
    
    if (this.enableLogging) {
      console.log('[MainOrchestrator] Initializing...');
    }
    
    try {
      // Initialize in dependency order
      await this._initializeRequestLifecycle();
      await this._initializeConnectionMonitor();
      await this._initializeManagers();
      await this._initializeUIServices();
      await this._setupEventListeners();
      await this._loadInitialState();
      
      this.isInitialized = true;
      
      if (this.enableLogging) {
        console.log('[MainOrchestrator] Initialized successfully');
      }
      
      // Emit initialization event
      if (this.eventBus) {
        this.eventBus.emit('main:orchestrator:initialized');
      }
    } catch (error) {
      console.error('[MainOrchestrator] Initialization failed:', error);
      
      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'MainOrchestrator.init');
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
    
    // Start request lifecycle
    const request = this.requestLifecycle.startRequest({
      type: 'user-message',
      timeout: options.timeout || 120000,
      metadata: {
        message: message.substring(0, 100), // First 100 chars for logging
        model: this.state.currentModel,
        profile: this.state.currentProfile
      },
      onCancel: () => {
        if (this.enableLogging) {
          console.log('[MainOrchestrator] Message request cancelled');
        }
      },
      onTimeout: () => {
        console.warn('[MainOrchestrator] Message request timed out');
      }
    });
    
    try {
      // Track with performance monitor
      if (this.performanceMonitor) {
        this.performanceMonitor.start(`sendMessage:${request.id}`);
      }
      
      // Send via guru connection
      const payload = {
        role: 'user',
        type: 'message',
        id: request.id,
        content: message,
        model: this.state.currentModel,
        profile: this.state.currentProfile,
        ...options
      };
      
      this.guruConnection.send(payload);
      
      if (this.enableLogging) {
        console.log('[MainOrchestrator] Message sent:', request.id);
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
   * Stop current request
   * @returns {Promise<void>}
   */
  async stopCurrentRequest() {
    this._ensureInitialized();
    
    // Get active requests
    const activeRequests = this.requestLifecycle.getActiveRequests();
    
    if (activeRequests.length === 0) {
      if (this.enableLogging) {
        console.log('[MainOrchestrator] No active requests to stop');
      }
      return;
    }
    
    // Cancel all active requests
    for (const request of activeRequests) {
      this.requestLifecycle.cancelRequest(request.id);
    }
    
    // Send stop signal to backend
    try {
      this.guruConnection.send({
        type: 'stop',
        id: activeRequests[0]?.id
      });
    } catch (error) {
      console.error('[MainOrchestrator] Failed to send stop signal:', error);
    }
    
    if (this.enableLogging) {
      console.log('[MainOrchestrator] Stopped all requests');
    }
  }

  /**
   * Update model selection
   * @param {string} modelId - Model ID
   * @returns {Promise<void>}
   */
  async updateModel(modelId) {
    this._ensureInitialized();
    
    if (!this.modelManager) {
      throw new Error('ModelManager not available');
    }
    
    await this.modelManager.selectModel(modelId);
    this.state.currentModel = modelId;
    
    if (this.enableLogging) {
      console.log('[MainOrchestrator] Model updated:', modelId);
    }
    
    // Emit event
    if (this.eventBus) {
      this.eventBus.emit('main:model:changed', { modelId });
    }
  }

  /**
   * Update profile selection
   * @param {string} profileId - Profile ID
   * @returns {Promise<void>}
   */
  async updateProfile(profileId) {
    this._ensureInitialized();
    
    if (!this.profileManager) {
      throw new Error('ProfileManager not available');
    }
    
    await this.profileManager.selectProfile(profileId);
    this.state.currentProfile = profileId;
    
    if (this.enableLogging) {
      console.log('[MainOrchestrator] Profile updated:', profileId);
    }
    
    // Emit event
    if (this.eventBus) {
      this.eventBus.emit('main:profile:changed', { profileId });
    }
  }

  /**
   * Toggle audio
   * @param {boolean} enabled - Enable/disable audio
   */
  toggleAudio(enabled) {
    this._ensureInitialized();
    
    if (!this.audioManager) {
      throw new Error('AudioManager not available');
    }
    
    if (enabled) {
      this.audioManager.enable();
    } else {
      this.audioManager.disable();
    }
    
    this.state.audioEnabled = enabled;
    
    if (this.enableLogging) {
      console.log('[MainOrchestrator] Audio toggled:', enabled);
    }
    
    // Emit event
    if (this.eventBus) {
      this.eventBus.emit('main:audio:toggled', { enabled });
    }
  }

  /**
   * Toggle visualizer
   * @param {boolean} active - Activate/deactivate visualizer
   */
  toggleVisualizer(active) {
    this._ensureInitialized();
    
    if (!this.visualizer) {
      throw new Error('Visualizer not available');
    }
    
    if (active) {
      this.visualizer.start();
    } else {
      this.visualizer.stop();
    }
    
    this.state.visualizerActive = active;
    
    if (this.enableLogging) {
      console.log('[MainOrchestrator] Visualizer toggled:', active);
    }
    
    // Emit event
    if (this.eventBus) {
      this.eventBus.emit('main:visualizer:toggled', { active });
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
      backendConnected: this.state.backendConnected,
      currentModel: this.state.currentModel,
      currentProfile: this.state.currentProfile,
      audioEnabled: this.state.audioEnabled,
      visualizerActive: this.state.visualizerActive,
      activeRequests: this.requestLifecycle ? this.requestLifecycle.getStats().active : 0,
      requestStats: this.requestLifecycle ? this.requestLifecycle.getStats() : null
    });
  }

  /**
   * Cleanup and destroy
   */
  destroy() {
    if (this.isDestroyed) return;
    
    if (this.enableLogging) {
      console.log('[MainOrchestrator] Destroying...');
    }
    
    // Stop all services
    if (this.visualizer) this.visualizer.stop();
    if (this.audioManager) this.audioManager.disable();
    
    // Cancel all requests
    if (this.requestLifecycle) {
      this.requestLifecycle.destroy();
    }
    
    // Cleanup event listeners
    if (this.eventBus) {
      this.eventBus.removeAllListeners('main:*');
    }
    
    this.isDestroyed = true;
    this.isInitialized = false;
    
    if (this.enableLogging) {
      console.log('[MainOrchestrator] Destroyed');
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
      name: 'MainOrchestrator',
      enableLogging: this.enableLogging,
      defaultTimeout: 120000,
      maxConcurrentRequests: 10,
      performanceMonitor: this.performanceMonitor
    });
  }

  /**
   * Initialize connection monitor
   * @private
   */
  async _initializeConnectionMonitor() {
    if (!this.container) return;
    
    try {
      this.connectionMonitor = this.container.resolve('ConnectionMonitor');
      
      // Listen for connection changes
      this.connectionMonitor.on('connected', () => {
        this.state.backendConnected = true;
        if (this.eventBus) {
          this.eventBus.emit('main:backend:connected');
        }
      });
      
      this.connectionMonitor.on('disconnected', () => {
        this.state.backendConnected = false;
        if (this.eventBus) {
          this.eventBus.emit('main:backend:disconnected');
        }
      });
    } catch (error) {
      console.warn('[MainOrchestrator] ConnectionMonitor not available:', error);
    }
  }

  /**
   * Initialize managers
   * @private
   */
  async _initializeManagers() {
    if (!this.container) return;
    
    try {
      this.modelManager = this.container.resolve('ModelManager');
      this.profileManager = this.container.resolve('ProfileManager');
      this.settingsManager = this.container.resolve('SettingsManager');
      
      if (this.enableLogging) {
        console.log('[MainOrchestrator] Managers initialized');
      }
    } catch (error) {
      console.warn('[MainOrchestrator] Some managers not available:', error);
    }
  }

  /**
   * Initialize UI services
   * @private
   */
  async _initializeUIServices() {
    if (!this.container) return;
    
    try {
      this.uiManager = this.container.resolve('UIManager');
      this.uiStateManager = this.container.resolve('UIStateManager');
      this.audioManager = this.container.resolve('AudioManager');
      this.visualizer = this.container.resolve('Visualizer');
      
      if (this.enableLogging) {
        console.log('[MainOrchestrator] UI services initialized');
      }
    } catch (error) {
      console.warn('[MainOrchestrator] Some UI services not available:', error);
    }
  }

  /**
   * Setup event listeners
   * @private
   */
  async _setupEventListeners() {
    if (!this.eventBus) return;
    
    // Backend events
    this.eventBus.on('backend:message-complete', (data) => {
      if (this.requestLifecycle.isActive(data.requestId)) {
        this.requestLifecycle.completeRequest(data.requestId, data);
      }
    });
    
    this.eventBus.on('backend:message-error', (data) => {
      if (this.requestLifecycle.isActive(data.requestId)) {
        this.requestLifecycle.failRequest(data.requestId, data.error);
      }
    });
    
    // IPC events
    if (this.ipcBridge) {
      this.ipcBridge.on('main:send-message', (message) => {
        this.sendMessage(message).catch(error => {
          console.error('[MainOrchestrator] Failed to send message:', error);
        });
      });
      
      this.ipcBridge.on('main:stop-request', () => {
        this.stopCurrentRequest().catch(error => {
          console.error('[MainOrchestrator] Failed to stop request:', error);
        });
      });
    }
    
    if (this.enableLogging) {
      console.log('[MainOrchestrator] Event listeners setup');
    }
  }

  /**
   * Load initial state
   * @private
   */
  async _loadInitialState() {
    try {
      // Load current model
      if (this.modelManager) {
        this.state.currentModel = await this.modelManager.getCurrentModel();
      }
      
      // Load current profile
      if (this.profileManager) {
        this.state.currentProfile = await this.profileManager.getCurrentProfile();
      }
      
      // Check backend connection
      if (this.connectionMonitor) {
        this.state.backendConnected = this.connectionMonitor.isConnected();
      }
      
      if (this.enableLogging) {
        console.log('[MainOrchestrator] Initial state loaded:', this.state);
      }
    } catch (error) {
      console.error('[MainOrchestrator] Failed to load initial state:', error);
    }
  }

  /**
   * Ensure orchestrator is initialized
   * @private
   */
  _ensureInitialized() {
    if (!this.isInitialized) {
      throw new Error('MainOrchestrator not initialized. Call init() first.');
    }
    
    if (this.isDestroyed) {
      throw new Error('MainOrchestrator has been destroyed');
    }
  }
}

// Export
module.exports = { MainOrchestrator };

if (typeof window !== 'undefined') {
  window.MainOrchestrator = MainOrchestrator;
  console.log('📦 MainOrchestrator loaded');
}

