'use strict';

/**
 * @.architecture
 * 
 * Incoming: GuruConnection.on('message') (WebSocket events), IpcBridge.on('main:*') (IPC commands), container.resolve() (DI injections) --- {websocket_stream_chunk | ipc_message | method_calls, json}
 * Processing: Initialize RequestLifecycleManager, coordinate submodules (UIManager/AudioManager/Visualizer/ConnectionMonitor/ModelManager/ProfileManager/SettingsManager), route messages/requests, manage application state --- {7 jobs: JOB_DELEGATE_TO_MODULE, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_INITIALIZE, JOB_ROUTE_BY_TYPE, JOB_TRACK_ENTITY, JOB_UPDATE_STATE}
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
const { createRendererLogger } = require('../../renderer/shared/utils/logger');
const _log = createRendererLogger('MainOrchestrator');

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
    
    // Event handler references for cleanup
    this._onConnected = null;
    this._onDisconnected = null;
    this._onBackendMessageComplete = null;
    this._onBackendMessageError = null;
    this._onIpcSendMessage = null;
    this._onIpcStopRequest = null;
    
    // State
    this.state = {
      backendConnected: false,
      currentProfile: null,
      currentModel: null,
      audioEnabled: false,
      visualizerActive: false
    };
    
    if (this.enableLogging) {
      _log.debug('[MainOrchestrator] Created');
    }
  }

  /**
   * Initialize orchestrator and all services
   * @returns {Promise<void>}
   */
  async init() {
    try {
      if (this.isInitialized) {
        _log.warn('[MainOrchestrator] Already initialized');
        return;
      }

      if (this.enableLogging) {
        _log.debug('[MainOrchestrator] Initializing...');
      }

      await this._initializeRequestLifecycle();
      await this._initializeConnectionMonitor();
      await this._initializeManagers();
      await this._initializeUIServices();
      await this._setupEventListeners();
      await this._loadInitialState();

      this.isInitialized = true;

      if (this.enableLogging) {
        _log.debug('[MainOrchestrator] Initialized successfully');
      }

      if (this.eventBus) {
        this.eventBus.emit('main:orchestrator:initialized');
      }
    } catch (error) {
      _log.error('[MainOrchestrator] Initialization failed:', error);

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
    
    let request = null;
    let monitorKey = null;
    let monitorStarted = false;
    
    try {
      if (!message || typeof message !== 'string') {
        throw new Error('Invalid message');
      }

      if (!this.state.backendConnected) {
        throw new Error('Backend not connected');
      }

      request = this.requestLifecycle.startRequest({
        type: 'user-message',
        timeout: options.timeout || 120000,
        metadata: {
          message: message.substring(0, 100),
          model: this.state.currentModel,
          profile: this.state.currentProfile
        },
        onCancel: () => {
          if (this.enableLogging) {
            _log.debug('[MainOrchestrator] Message request cancelled');
          }
        },
        onTimeout: () => {
          _log.warn('[MainOrchestrator] Message request timed out');
        }
      });

      monitorKey = `sendMessage:${request.id}`;

      if (this.performanceMonitor) {
        this.performanceMonitor.start(monitorKey);
        monitorStarted = true;
      }

      const payload = {
        role: 'user',
        type: 'message',
        id: request.id,
        content: message,
        model: this.state.currentModel,
        profile: this.state.currentProfile,
        ...options
      };

      await this.guruConnection.send(payload);

      if (this.enableLogging) {
        _log.debug('[MainOrchestrator] Message sent:', request.id);
      }

      return request;
    } catch (error) {
      if (request && typeof request.fail === 'function') {
        request.fail(error);
      }

      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'MainOrchestrator.sendMessage');
      }

      throw error;
    } finally {
      if (this.performanceMonitor && monitorStarted && monitorKey) {
        this.performanceMonitor.end(monitorKey);
      }
    }
  }

  /**
   * Stop current request
   * @returns {Promise<void>}
   */
  async stopCurrentRequest() {
    this._ensureInitialized();
    
    try {
      const activeRequests = this.requestLifecycle.getActiveRequests();

      if (activeRequests.length === 0) {
        if (this.enableLogging) {
          _log.debug('[MainOrchestrator] No active requests to stop');
        }
        return;
      }

      for (const request of activeRequests) {
        this.requestLifecycle.cancelRequest(request.id);
      }

      await this.guruConnection.send({
        type: 'stop',
        id: activeRequests[0]?.id
      });

      if (this.enableLogging) {
        _log.debug('[MainOrchestrator] Stopped all requests');
      }
    } catch (error) {
      _log.error('[MainOrchestrator] Failed to stop current request:', error);

      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'MainOrchestrator.stopCurrentRequest');
      }

      throw error;
    }
  }

  /**
   * Update model selection
   * @param {string} modelId - Model ID
   * @returns {Promise<void>}
   */
  async updateModel(modelId) {
    this._ensureInitialized();
    
    try {
      if (!this.modelManager) {
        throw new Error('ModelManager not available');
      }

      await this.modelManager.selectModel(modelId);
      this.state.currentModel = modelId;

      if (this.enableLogging) {
        _log.debug('[MainOrchestrator] Model updated:', modelId);
      }

      if (this.eventBus) {
        this.eventBus.emit('main:model:changed', { modelId });
      }
    } catch (error) {
      _log.error('[MainOrchestrator] Failed to update model:', error);

      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'MainOrchestrator.updateModel');
      }

      throw error;
    }
  }

  /**
   * Update profile selection
   * @param {string} profileId - Profile ID
   * @returns {Promise<void>}
   */
  async updateProfile(profileId) {
    this._ensureInitialized();
    
    try {
      if (!this.profileManager) {
        throw new Error('ProfileManager not available');
      }

      await this.profileManager.selectProfile(profileId);
      this.state.currentProfile = profileId;

      if (this.enableLogging) {
        _log.debug('[MainOrchestrator] Profile updated:', profileId);
      }

      if (this.eventBus) {
        this.eventBus.emit('main:profile:changed', { profileId });
      }
    } catch (error) {
      _log.error('[MainOrchestrator] Failed to update profile:', error);

      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'MainOrchestrator.updateProfile');
      }

      throw error;
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
      _log.debug('[MainOrchestrator] Audio toggled:', enabled);
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
      _log.debug('[MainOrchestrator] Visualizer toggled:', active);
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
      _log.debug('[MainOrchestrator] Destroying...');
    }
    
    // Stop all services
    if (this.visualizer) this.visualizer.stop();
    if (this.audioManager) this.audioManager.disable();
    
    // Cancel all requests
    if (this.requestLifecycle) {
      this.requestLifecycle.destroy();
    }
    
    // Cleanup eventBus listeners (both backend:* and main:*)
    if (this.eventBus) {
      if (this._onBackendMessageComplete) {
        this.eventBus.off('backend:message-complete', this._onBackendMessageComplete);
      }
      if (this._onBackendMessageError) {
        this.eventBus.off('backend:message-error', this._onBackendMessageError);
      }
      this.eventBus.removeAllListeners('main:*');
    }
    
    // Cleanup ipcBridge listeners
    if (this.ipcBridge) {
      if (this._onIpcSendMessage) {
        this.ipcBridge.off('main:send-message', this._onIpcSendMessage);
      }
      if (this._onIpcStopRequest) {
        this.ipcBridge.off('main:stop-request', this._onIpcStopRequest);
      }
    }
    
    // Cleanup connectionMonitor listeners and stop its polling interval
    if (this.connectionMonitor) {
      if (this._onConnected) {
        this.connectionMonitor.off('connected', this._onConnected);
      }
      if (this._onDisconnected) {
        this.connectionMonitor.off('disconnected', this._onDisconnected);
      }
      if (typeof this.connectionMonitor.dispose === 'function') {
        this.connectionMonitor.dispose();
      }
      this.connectionMonitor = null;
    }
    
    this.isDestroyed = true;
    this.isInitialized = false;
    
    if (this.enableLogging) {
      _log.debug('[MainOrchestrator] Destroyed');
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
    try {
      const { RequestLifecycleManager } = require('../shared/RequestLifecycleManager');

      this.requestLifecycle = new RequestLifecycleManager({
        name: 'MainOrchestrator',
        enableLogging: this.enableLogging,
        defaultTimeout: 120000,
        maxConcurrentRequests: 10,
        performanceMonitor: this.performanceMonitor
      });
    } catch (error) {
      _log.error('[MainOrchestrator] Failed to initialize request lifecycle:', error);

      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'MainOrchestrator._initializeRequestLifecycle');
      }

      throw error;
    }
  }

  /**
   * Initialize connection monitor
   * @private
   */
  async _initializeConnectionMonitor() {
    if (!this.container) return;
    
    try {
      this.connectionMonitor = this.container.resolve('ConnectionMonitor');
      
      // Store handler references for cleanup in destroy()
      this._onConnected = () => {
        this.state.backendConnected = true;
        if (this.eventBus) {
          this.eventBus.emit('main:backend:connected');
        }
      };
      
      this._onDisconnected = () => {
        this.state.backendConnected = false;
        if (this.eventBus) {
          this.eventBus.emit('main:backend:disconnected');
        }
      };
      
      this.connectionMonitor.on('connected', this._onConnected);
      this.connectionMonitor.on('disconnected', this._onDisconnected);
    } catch (error) {
      _log.warn('[MainOrchestrator] ConnectionMonitor not available:', error);
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
        _log.debug('[MainOrchestrator] Managers initialized');
      }
    } catch (error) {
      _log.warn('[MainOrchestrator] Some managers not available:', error);
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
        _log.debug('[MainOrchestrator] UI services initialized');
      }
    } catch (error) {
      _log.warn('[MainOrchestrator] Some UI services not available:', error);
    }
  }

  /**
   * Setup event listeners
   * @private
   */
  async _setupEventListeners() {
    try {
      if (!this.eventBus) return;

      // Store handler references for cleanup in destroy()
      this._onBackendMessageComplete = (data) => {
        if (this.requestLifecycle && this.requestLifecycle.isActive(data.requestId)) {
          this.requestLifecycle.completeRequest(data.requestId, data);
        }
      };

      this._onBackendMessageError = (data) => {
        if (this.requestLifecycle && this.requestLifecycle.isActive(data.requestId)) {
          this.requestLifecycle.failRequest(data.requestId, data.error);
        }
      };

      this.eventBus.on('backend:message-complete', this._onBackendMessageComplete);
      this.eventBus.on('backend:message-error', this._onBackendMessageError);

      if (this.ipcBridge) {
        this._onIpcSendMessage = (message) => {
          this.sendMessage(message).catch(error => {
            _log.error('[MainOrchestrator] Failed to send message:', error);
          });
        };

        this._onIpcStopRequest = () => {
          this.stopCurrentRequest().catch(error => {
            _log.error('[MainOrchestrator] Failed to stop request:', error);
          });
        };

        this.ipcBridge.on('main:send-message', this._onIpcSendMessage);
        this.ipcBridge.on('main:stop-request', this._onIpcStopRequest);
      }

      if (this.enableLogging) {
        _log.debug('[MainOrchestrator] Event listeners setup');
      }
    } catch (error) {
      _log.error('[MainOrchestrator] Failed to setup event listeners:', error);

      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'MainOrchestrator._setupEventListeners');
      }

      throw error;
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
        _log.debug('[MainOrchestrator] Initial state loaded:', this.state);
      }
    } catch (error) {
      _log.error('[MainOrchestrator] Failed to load initial state:', error);
    }
  }

  /**
   * Ensure orchestrator is initialized
   * @private
   */
  _ensureInitialized() {
    if (this.isDestroyed) {
      throw new Error('MainOrchestrator has been destroyed');
    }

    if (!this.isInitialized) {
      throw new Error('MainOrchestrator not initialized. Call init() first.');
    }
  }
}

// Export
module.exports = { MainOrchestrator };

if (typeof window !== 'undefined') {
  window.MainOrchestrator = MainOrchestrator;
  _log.debug('MainOrchestrator loaded');
}
