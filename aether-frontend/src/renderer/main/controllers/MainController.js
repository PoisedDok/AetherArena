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
const { getAether } = require('../../shared/bridge/AetherBridge');
const { createRendererLogger } = require('../../shared/utils/logger');
const { freeze } = Object;

class MainController {
  constructor(options = {}) {
    this.log = createRendererLogger('MainController');
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
    this.aether = options.aether || getAether();

    // Modules (will be initialized)
    this.modules = {};
    
    // State
    this.initialized = false;
    this.backendConnected = false;
    this.currentModel = null;
    this.currentModelSupportsReasoning = false;
    
    this._isDisposed = false;

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
    this.log.debug('MainController: Initializing...');

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

      this.log.debug('MainController: Initialization complete');
      this.eventBus.emit(EventTypes.SYSTEM.READY, { 
        controller: 'MainController',
        timestamp: Date.now()
      }, { priority: EventPriority.HIGH });

    } catch (error) {
      this.log.error('MainController: Initialization failed:', error);
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
    if (this._isDisposed) return;
    this._isDisposed = true;
    this.log.debug('MainController: Disposing...');

    // Dispose modules in reverse order
    const moduleNames = Object.keys(this.modules).reverse();
    for (const name of moduleNames) {
      const instance = this.modules[name];
      if (!instance) continue;
      try {
        if (typeof instance.dispose === 'function') {
          instance.dispose();
        } else if (typeof instance.cleanup === 'function') {
          instance.cleanup();
        } else if (typeof instance.destroy === 'function') {
          instance.destroy();
        }
      } catch (error) {
        this.log.error(`[MainController] Failed to dispose ${name}:`, error);
      }
    }

    // Remove IPC listeners
    for (const cleanup of this._ipcListeners) {
      try {
        cleanup();
      } catch (error) {
        this.log.error('[MainController] Failed to cleanup IPC listener:', error);
      }
    }

    // Remove event listeners
    for (const cleanup of this._eventListeners) {
      try {
        cleanup();
      } catch (error) {
        this.log.error('[MainController] Failed to cleanup event listener:', error);
      }
    }

    this.log.debug('MainController: Disposed');

    if (typeof window !== 'undefined') {
      window.mainController = null;
      window.logToMain = null;
    }
  }

  /**
   * Set assistant status
   * @param {string} status - Status (idle|listening|thinking|speaking|error)
   */
  setAssistantStatus(status) {
    if (this.modules.endpoint && this.modules.endpoint.connection && this.modules.endpoint.connection.state) {
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
    this.log.debug('MainController: Initializing core...');

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

    this.modules.endpoint = endpoint;

    this.log.debug('MainController: Core initialized');
  }

  /**
   * Register services in DI container
   * @private
   */
  async _registerServices() {
    this.log.debug('MainController: Registering services...');

    // Services are already registered by main-renderer.js
    // This method can be used to register additional services if needed
    
    // NOTE: HandsfreeCoordinator init deferred to MainApp
    // AudioManager is created by MainApp, not available here yet
    // MainApp will initialize HandsfreeCoordinator after AudioManager is ready

    this.log.debug('MainController: Services registered');
  }

  /**
   * Initialize modules in dependency order
   * @private
   */
  async _initializeModules() {
    this.log.debug('MainController: Initializing modules...');

    if (this.container.has('mainApp')) {
      const mainApp = this.container.resolve('mainApp');
      this.modules.mainApp = mainApp;
      if (mainApp && typeof mainApp.initialize === 'function') {
        await mainApp.initialize();
      }
    }
    
    // Initialize HandsfreeCoordinator if available
    if (this.modules.handsfreeCoordinator && typeof this.modules.handsfreeCoordinator.initialize === 'function') {
      try {
        this.modules.handsfreeCoordinator.initialize();
        this.log.debug('HandsfreeCoordinator initialized');
      } catch (error) {
        this.log.error('Failed to initialize HandsfreeCoordinator:', error);
      }
    }

    this.log.debug('MainController: Modules initialized');
  }

  /**
   * Setup event listeners
   * @private
   */
  async _setupEventListeners() {
    this.log.debug('MainController: Setting up event listeners...');

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

    // Structural Error Boundary: Prevent zombie UI lock down on unhandled promise rejections / IPC drops
    const unhandledRejectionListener = (event) => {
      this.log.error('MainController: Unhandled Promise Rejection (Possible IPC deadlock):', event.reason);
      this.eventBus.emit(EventTypes.SYSTEM.ERROR, { 
        error: event.reason,
        phase: 'runtime',
        fatal: true
      });
      // Optionally trigger a safe recovery view here
      this.setAssistantStatus('error');
      this._updateBackendDisplay(null, true);
    };
    window.addEventListener('unhandledrejection', unhandledRejectionListener);
    this._eventListeners.push(() => window.removeEventListener('unhandledrejection', unhandledRejectionListener));

    this.log.debug('MainController: Event listeners setup');
  }

  /**
   * Setup IPC listeners
   * @private
   */
  async _setupIpcListeners() {
    this.log.debug('MainController: Setting up IPC listeners...');

    // Widget mode change — guard against null aether/window (optional chaining returns undefined)
    const cleanupWidgetMode = this.aether?.window?.onWidgetModeChange((isWidget) => {
      this.log.debug('[MainController] Widget mode changed:', isWidget);
      this.eventBus.emit(EventTypes.UI.WIDGET_MODE_CHANGED, { isWidget });
    });
    if (typeof cleanupWidgetMode === 'function') {
      this._ipcListeners.push(cleanupWidgetMode);
    }

    this.log.debug('MainController: IPC listeners setup');
  }

  /**
   * Initialize global state
   * @private
   */
  async _initializeGlobalState() {
    this.log.debug('MainController: Initializing global state...');

    // Set initial status
    this.setAssistantStatus('waiting');

    // Get backend health
    try {
      const health = await this.modules.endpoint.getHealth();
      this.log.debug('[MainController] Backend health:', health);
      
      this.backendConnected = true;
      this.currentModel = health.model || null;
      
      this._updateBackendDisplay(health);
      
      this.eventBus.emit(EventTypes.CONNECTION.BACKEND_ONLINE, { health });

    } catch (error) {
      this.log.warn('[MainController] Backend health check failed:', error);
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
        
        if (this.aether?.log?.send) {
          this.aether.log.send(message);
        }
      } catch (error) {
        this.log.error('[MainController] Failed to log to main:', error);
      }
    };

    this.log.debug('MainController: Global state initialized');
  }

  /**
   * Detect model capabilities (vision, reasoning, etc.)
   * @private
   */
  async _detectModelCapabilities() {
    if (!this.currentModel) {
      return;
    }

    this.log.debug(`MainController: Detecting capabilities for ${this.currentModel}...`);

    try {
      const capabilities = await this.modules.endpoint.getModelCapabilities(this.currentModel);
      
      this.currentModelSupportsReasoning = capabilities.supportsReasoning || false;
      
      this.log.debug('[MainController] Model capabilities:', capabilities);
      
      this.eventBus.emit(EventTypes.MODEL.CAPABILITIES_UPDATED, { 
        model: this.currentModel,
        capabilities
      });

    } catch (error) {
      this.log.warn('[MainController] Failed to detect model capabilities:', error);
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
      backendInfoEl.style.color = 'var(--color-warning)';
    } else if (health && health.model) {
      backendInfoEl.innerHTML = `<strong>MODEL:</strong> ${health.model.toUpperCase()}`;
      backendInfoEl.style.color = 'var(--color-text-primary)';
    } else {
      backendInfoEl.innerHTML = '<strong>BACKEND ONLINE</strong>';
      backendInfoEl.style.color = 'var(--color-text-primary)';
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
    this.log.debug('[MainController] Backend online:', data);
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
    this.log.debug('[MainController] Backend offline:', data);
    this.backendConnected = false;
    this.setAssistantStatus('waiting');
    this._updateBackendDisplay(null, true);
  }
}

// Export
module.exports = MainController;

if (typeof window !== 'undefined') {
  window.MainController = MainController;
}
