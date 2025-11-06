'use strict';

/**
 * @.architecture
 * 
 * Incoming: main-renderer.js (bootstrap call), EventBus (backend online/offline events), IPC (widget mode change) --- {boot_request | event_types.CONNECTION.*, method_call | event}
 * Processing: 7-phase initialization (core, services, modules, events, IPC, state, capabilities), coordinate Visualizer/HandsFreeMic/UIManager/EventHandler modules, query backend health/model capabilities, set assistant status, handle backend connectivity changes --- {9 jobs: JOB_INITIALIZE, JOB_INITIALIZE, JOB_DELEGATE_TO_MODULE, JOB_HTTP_REQUEST, JOB_EMIT_EVENT, JOB_UPDATE_STATE, JOB_GET_STATE, JOB_VALIDATE_SCHEMA, JOB_DISPOSE}
 * Outgoing: Initialize Endpoint → GuruConnection → Backend, EventBus (SYSTEM.READY/ERROR, CONNECTION.*, UI.WIDGET_MODE_CHANGED) --- {event_types.*, event}
 * 
 * 
 * @module renderer/main/controllers/MainController
 * 
 * MainController - Main Window Orchestrator
 * ============================================================================
 * Coordinates all main window modules and manages global application state.
 * 
 * Responsibilities:
 * - Initialize core dependencies (Endpoint, EventBus)
 * - Coordinate modules (Visualizer, HandsFreeMic, UIManager, EventHandler)
 * - Manage application lifecycle
 * - Handle backend connectivity
 * - Coordinate cross-window communication
 * 
 * Architecture:
 * - Uses dependency injection for all services
 * - Event-driven communication between modules
 * - Clean separation of concerns
 */

const Endpoint = require('../../../core/communication/Endpoint');
const { EventTypes, EventPriority } = require('../../../core/events/EventTypes');
const { freeze } = Object;

class MainController {
  constructor(options = {}) {
    if (!options.container) {
      throw new Error('[MainController] DI container required');
    }

    if (!options.eventBus) {
      throw new Error('[MainController] EventBus required');
    }

    if (!options.config) {
      throw new Error('[MainController] Config required');
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
    this.currentModel = null;
    this.currentModelSupportsReasoning = false;
    
    // IPC listeners for cleanup
    this._ipcListeners = [];
    this._eventListeners = [];

    // Bind methods
    this._handleBackendOnline = this._handleBackendOnline.bind(this);
    this._handleBackendOffline = this._handleBackendOffline.bind(this);
  }

  /**
   * Initialize main controller
   */
  async init() {
    console.log('🎯 MainController: Initializing...');

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

      // Phase 7: Detect model capabilities
      await this._detectModelCapabilities();

      this.initialized = true;

      console.log('✅ MainController: Initialization complete');
      this.eventBus.emit(EventTypes.SYSTEM.READY, { 
        controller: 'MainController',
        timestamp: Date.now()
      }, { priority: EventPriority.HIGH });

    } catch (error) {
      console.error('❌ MainController: Initialization failed:', error);
      this.eventBus.emit(EventTypes.SYSTEM.ERROR, { 
        error,
        phase: 'initialization',
        fatal: true
      });
      throw error;
    }
  }

  /**
   * Dispose controller and cleanup resources
   */
  dispose() {
    console.log('🛑 MainController: Disposing...');

    // Dispose modules in reverse order
    const moduleNames = Object.keys(this.modules).reverse();
    for (const name of moduleNames) {
      try {
        if (this.modules[name] && typeof this.modules[name].dispose === 'function') {
          this.modules[name].dispose();
        }
      } catch (error) {
        console.error(`[MainController] Failed to dispose ${name}:`, error);
      }
    }

    // Remove IPC listeners
    for (const cleanup of this._ipcListeners) {
      try {
        cleanup();
      } catch (error) {
        console.error('[MainController] Failed to cleanup IPC listener:', error);
      }
    }

    // Remove event listeners
    for (const cleanup of this._eventListeners) {
      try {
        cleanup();
      } catch (error) {
        console.error('[MainController] Failed to cleanup event listener:', error);
      }
    }

    console.log('✅ MainController: Disposed');
  }

  /**
   * Set assistant status
   * @param {string} status - Status (idle|listening|thinking|speaking|error)
   */
  setAssistantStatus(status) {
    if (this.modules.endpoint && this.modules.endpoint.connection) {
      this.modules.endpoint.connection.state.assistant = status;
    }

    this.eventBus.emit(EventTypes.SYSTEM.STATUS_CHANGED, { status });

    // Update UI
    const statusEl = document.getElementById('system-status');
    if (statusEl) {
      statusEl.textContent = status.toUpperCase();
      statusEl.className = `status-indicator status-${status}`;
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
      currentModel: this.currentModel,
      modules: Object.keys(this.modules),
      endpoint: this.modules.endpoint ? this.modules.endpoint.getStats() : null
    });
  }

  // ============================================================================
  // Private Initialization Methods
  // ============================================================================

  /**
   * Initialize core dependencies
   * @private
   */
  async _initializeCore() {
    console.log('📦 MainController: Initializing core...');

    // Create Endpoint singleton
    const endpoint = new Endpoint({
      API_BASE_URL: this.config.API_BASE_URL,
      WS_URL: this.config.WS_URL,
      NODE_ENV: this.config.NODE_ENV
    });

    // Register in container
    this.container.register('endpoint', () => endpoint, { singleton: true });

    // Store in modules
    this.modules.endpoint = endpoint;

    // Make globally available (for debugging and legacy compatibility)
    window.endpoint = endpoint;
    window.guru = endpoint.connection;

    // Initialize guru state
    if (!window.guru.state) {
      window.guru.state = { assistant: 'waiting', audioLevel: 0 };
    }

    // Set initial widget mode
    window.isWidgetMode = false;

    console.log('✅ MainController: Core initialized');
  }

  /**
   * Register services in DI container
   * @private
   */
  async _registerServices() {
    console.log('📦 MainController: Registering services...');

    // Services are already registered by main-renderer.js
    // This method can be used to register additional services if needed

    console.log('✅ MainController: Services registered');
  }

  /**
   * Initialize modules in dependency order
   * @private
   */
  async _initializeModules() {
    console.log('📦 MainController: Initializing modules...');

    // Module initialization will be implemented in subsequent steps
    // Module initialization handled in main-renderer.js:
    // 1. Visualizer (THREE.js neural network)
    // 2. HandsFreeMicManager (continuous voice recording with STT streaming)
    // 3. SettingsManager (UI settings management)
    // All modules directly initialized in main-renderer for simplicity

    console.log('✅ MainController: Modules initialized (delegated to main-renderer)');
  }

  /**
   * Setup event listeners
   * @private
   */
  async _setupEventListeners() {
    console.log('📦 MainController: Setting up event listeners...');

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

    console.log('✅ MainController: Event listeners setup');
  }

  /**
   * Setup IPC listeners
   * @private
   */
  async _setupIpcListeners() {
    console.log('📦 MainController: Setting up IPC listeners...');

    // Widget mode change
    const cleanupWidgetMode = window.aether.window.onWidgetModeChange((isWidget) => {
      console.log('[MainController] Widget mode changed:', isWidget);
      window.isWidgetMode = isWidget;
      this.eventBus.emit(EventTypes.UI.WIDGET_MODE_CHANGED, { isWidget });
    });
    this._ipcListeners.push(cleanupWidgetMode);

    console.log('✅ MainController: IPC listeners setup');
  }

  /**
   * Initialize global state
   * @private
   */
  async _initializeGlobalState() {
    console.log('📦 MainController: Initializing global state...');

    // Set initial status
    this.setAssistantStatus('waiting');

    // Get backend health
    try {
      const health = await this.modules.endpoint.getHealth();
      console.log('[MainController] Backend health:', health);
      
      this.backendConnected = true;
      this.currentModel = health.model || null;
      
      this._updateBackendDisplay(health);
      
      this.eventBus.emit(EventTypes.CONNECTION.BACKEND_ONLINE, { health });

    } catch (error) {
      console.warn('[MainController] Backend health check failed:', error);
      this.backendConnected = false;
      this._updateBackendDisplay(null, true);
      this.eventBus.emit(EventTypes.CONNECTION.BACKEND_OFFLINE, { error });
    }

    // Make controller globally accessible
    window.mainController = this;

    // Setup global log function
    window.logToMain = (...args) => {
      try {
        const message = args.map(a => 
          typeof a === 'object' ? JSON.stringify(a) : String(a)
        ).join(' ');
        
        window.aether.log.send(message);
      } catch (error) {
        console.error('[MainController] Failed to log to main:', error);
      }
    };

    console.log('✅ MainController: Global state initialized');
  }

  /**
   * Detect model capabilities (vision, reasoning, etc.)
   * @private
   */
  async _detectModelCapabilities() {
    if (!this.currentModel) {
      return;
    }

    console.log(`📦 MainController: Detecting capabilities for ${this.currentModel}...`);

    try {
      const capabilities = await this.modules.endpoint.getModelCapabilities(this.currentModel);
      
      this.currentModelSupportsReasoning = capabilities.supportsReasoning || false;
      
      console.log('[MainController] Model capabilities:', capabilities);
      
      this.eventBus.emit(EventTypes.MODEL.CAPABILITIES_UPDATED, { 
        model: this.currentModel,
        capabilities
      });

    } catch (error) {
      console.warn('[MainController] Failed to detect model capabilities:', error);
    }
  }

  /**
   * Update backend display
   * @private
   */
  _updateBackendDisplay(health, isError = false) {
    const backendInfoEl = document.getElementById('backend-info');
    if (!backendInfoEl) return;

    if (isError) {
      backendInfoEl.innerHTML = '<strong>WAITING FOR BACKEND…</strong>';
      backendInfoEl.style.color = '#facc15';
    } else if (health && health.model) {
      backendInfoEl.innerHTML = `<strong>MODEL:</strong> ${health.model.toUpperCase()}`;
      backendInfoEl.style.color = 'rgba(255, 255, 255, 0.9)';
    } else {
      backendInfoEl.innerHTML = '<strong>BACKEND ONLINE</strong>';
      backendInfoEl.style.color = 'rgba(255, 255, 255, 0.9)';
    }

    backendInfoEl.style.display = 'block';
    backendInfoEl.style.visibility = 'visible';
    backendInfoEl.style.fontWeight = 'bold';
  }

  /**
   * Handle backend online event
   * @private
   */
  _handleBackendOnline(data) {
    console.log('[MainController] Backend online:', data);
    this.backendConnected = true;
    this.setAssistantStatus('idle');
    
    if (data.health) {
      this._updateBackendDisplay(data.health);
    }
  }

  /**
   * Handle backend offline event
   * @private
   */
  _handleBackendOffline(data) {
    console.log('[MainController] Backend offline:', data);
    this.backendConnected = false;
    this.setAssistantStatus('waiting');
    this._updateBackendDisplay(null, true);
  }
}

// Export
module.exports = MainController;

if (typeof window !== 'undefined') {
  window.MainController = MainController;
  console.log('📦 MainController loaded');
}

