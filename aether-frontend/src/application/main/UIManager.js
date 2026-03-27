'use strict';

/**
 * @.architecture
 * 
 * Incoming: MainOrchestrator (initialization), guru/endpoint instances (constructor injection), DOM elements --- {method_calls | dom_elements, javascript_api | HTMLElement}
 * Processing: Delegate to 7 submodules (ConnectionMonitor/ModelManager/ProfileManager/SettingsManager/UIStateManager/ServiceStatusMonitor/ArtifactsStreamOrchestrator), initialize all managers, start/stop monitors, gather UI elements, setup event listeners, load initial data, coordinate main window UI (visualizer, connection status, model info) --- {7 jobs: JOB_DELEGATE_TO_MODULE, JOB_DISPOSE, JOB_INITIALIZE, JOB_ROUTE_BY_TYPE, JOB_SEND_IPC, JOB_START, JOB_UPDATE_STATE}
 * Outgoing: ConnectionMonitor.start/stop(), ModelManager/ProfileManager/SettingsManager methods (orchestration delegation), DOM updates (main window UI) --- {method_calls | dom_updates, javascript_api | HTMLElement}
 * 
 * 
 * @module application/main/UIManager
 */

const ConnectionMonitor = require('./modules/connection/ConnectionMonitor');
const ModelManager = require('./modules/models/ModelManager');
const ProfileManager = require('./modules/profiles/ProfileManager');
const SettingsManager = require('./modules/settings/SettingsManager');
const UIStateManager = require('./modules/ui/UIStateManager');
const ServiceStatusMonitor = require('./modules/services/ServiceStatusMonitor');
const ArtifactsStreamOrchestrator = require('./ArtifactsStreamOrchestrator');
const { EventTypes } = require('../../core/events/EventTypes');
const { createRendererLogger } = require('../../renderer/shared/utils/logger');

class UIManager {
  constructor(options = {}) {
    this.log = createRendererLogger('UIManager');

    // Dependencies
    this.endpoint = options.endpoint || null;
    this.guru = options.guruConnection || null;
    this.eventBus = options.eventBus || null;
    this.ipc = options.ipc || null;
    
    // Configuration
    this.enableLogging = options.enableLogging !== undefined ? options.enableLogging : false;
    
    // Validate required dependencies
    if (!this.endpoint) {
      throw new Error('[UIManager] endpoint required');
    }
    
    if (!this.guru) {
      throw new Error('[UIManager] guruConnection required');
    }
    
    if (!this.eventBus) {
      throw new Error('[UIManager] eventBus required');
    }
    
    // Initialize submodules
    this._initializeModules();
    
    // UI elements (will be gathered after DOM ready)
    this.elements = {};
    
    // State
    this.initialized = false;
    
    // Event listener cleanup functions (EventBus)
    this._eventListeners = [];

    // DOM listener tracking (element/event/handler tuples)
    this._domListeners = [];
  }

  /**
   * Track a DOM event listener for cleanup in dispose().
   * @param {Element} element
   * @param {string} event
   * @param {Function} handler
   * @private
   */
  _trackDomListener(element, event, handler) {
    element.addEventListener(event, handler);
    this._domListeners.push({ element, event, handler });
  }

  /**
   * Initialize all submodules
   * @private
   */
  _initializeModules() {
    try {
      // Connection Monitor
      this.connectionMonitor = new ConnectionMonitor({
        guruConnection: this.guru,
        eventBus: this.eventBus,
        checkInterval: 2000,
        enableLogging: this.enableLogging
      });

      // Model Manager
      this.modelManager = new ModelManager({
        endpoint: this.endpoint,
        eventBus: this.eventBus,
        enableLogging: this.enableLogging
      });

      // Profile Manager
      this.profileManager = new ProfileManager({
        endpoint: this.endpoint,
        eventBus: this.eventBus,
        enableLogging: this.enableLogging
      });

      // Settings Manager
      this.settingsManager = new SettingsManager({
        endpoint: this.endpoint,
        eventBus: this.eventBus,
        enableLogging: this.enableLogging
      });

      // UI State Manager
      this.uiStateManager = new UIStateManager({
        eventBus: this.eventBus,
        enableLogging: this.enableLogging
      });

      // Service Status Monitor
      this.serviceMonitor = new ServiceStatusMonitor({
        endpoint: this.endpoint,
        eventBus: this.eventBus,
        checkInterval: 4000,
        timeout: 2500,
        enableLogging: this.enableLogging
      });

      // Artifacts Stream Orchestrator (refactored clean architecture)
      this.artifactsOrchestrator = new ArtifactsStreamOrchestrator({
        enableLogging: true,
        ipc: this.ipc,
        guruConnection: this.guru
      });

      if (this.enableLogging) {
        this.log.info('[UIManager] All submodules initialized');
      }
    } catch (error) {
      this.log.error('[UIManager] Error initializing submodules:', error);
      throw error;
    }
  }

  /**
   * Initialize UI Manager
   * @returns {Promise<void>}
   */
  async init() {
    try {
      if (this.initialized) {
        this.log.warn('[UIManager] Already initialized');
        return;
      }

      this.log.info('UIManager: Initializing...');

      // Phase 1: Gather UI elements
      this._gatherUIElements();

      // Phase 2: Setup event listeners
      this._setupEventListeners();

      // Phase 3: Setup settings modal
      this._setupSettingsModal();

      // Phase 4: Setup artifacts controls
      this._setupArtifactsControls();

      // Phase 5: Setup status updates
      this._setupStatusUpdates();

      // Phase 6: Setup WebSocket-to-IPC relay (CRITICAL for message flow)
      this._setupWebSocketToIPCRelay();
      
      // Phase 7: Start monitors
      this.connectionMonitor.start();
      this.artifactsOrchestrator.start();

      // Phase 7: Register services for monitoring
      this._registerServices();

      // Phase 8: Load initial data (parallelized for speed)
      // This MUST happen before updating backend info to ensure models/profiles are ready
      await Promise.all([
        this._loadInitialData(),
        this._updateBackendInfo() // Also update backend info here
      ]);

      this.initialized = true;

      this.log.info('UIManager: Initialization complete');
    } catch (error) {
      this.log.error('UIManager: Initialization failed:', error);
      // Ensure we don't leave the UI in a broken state - could emit an error event here
      this.uiStateManager?.showStatus(`Initialization failed: ${error.message}`, 'error', 10000);
      throw error;
    }
  }

  /**
   * Gather UI elements
   * @private
   */
  _gatherUIElements() {
    this.elements = {
      // Settings modal
      settingsButton: document.getElementById('settings-button'),
      settingsModal: document.getElementById('settings-modal'),
      settingsSaveBtn: document.getElementById('settings-save'),
      settingsCancelBtn: document.getElementById('settings-cancel'),
      settingsStatus: document.getElementById('settings-status'),
      
      // Artifacts
      codePanelToggle: document.getElementById('code-panel-toggle'),
      
      // Connection chips
      chipREST: document.getElementById('chip-rest'),
      chipWS: document.getElementById('chip-ws'),
      chipLLM: document.getElementById('chip-llm'),
      chipWake: document.getElementById('chip-wakeword'),
      chipSTT: document.getElementById('chip-stt'),
      chipTTS: document.getElementById('chip-tts'),
      btnPing: document.getElementById('btn-ping-backend'),
      btnReconnect: document.getElementById('btn-reconnect-ws'),
      
      // Status
      systemStatusEl: document.getElementById('system-status'),
      connectionStatusEl: document.getElementById('connection-status'),
      backendInfoEl: document.getElementById('backend-info'),
      serviceGridEl: document.getElementById('service-status-grid'),
      
      // Tabs
      tabs: Array.from(document.querySelectorAll('.settings-tab')),
      sections: {
        assistant: document.getElementById('tab-assistant'),
        connections: document.getElementById('tab-connections'),
        documents: document.getElementById('tab-documents'),
        apikeys: document.getElementById('tab-apikeys'),
        advanced: document.getElementById('tab-advanced')
      }
    };

    if (this.enableLogging) {
      this.log.info('[UIManager] Gathered', Object.keys(this.elements).length, 'UI elements');
    }
  }

  /**
   * Setup event listeners
   * @private
   */
  _setupEventListeners() {
    // Connection status changes
    const cleanupConnectionStatus = this.eventBus.on(EventTypes.CONNECTION.STATUS_CHANGED, (data) => {
      if (this.enableLogging) {
        this.log.info('[UIManager] Connection status changed:', data.connected ? 'ONLINE' : 'OFFLINE');
      }
    });
    this._eventListeners.push(cleanupConnectionStatus);

    // Service status changes
    const cleanupServiceStatus = this.eventBus.on(EventTypes.SERVICE.STATUS_UPDATED, (data) => {
      this._updateServiceCardUI(data.serviceName, data.status);
    });
    this._eventListeners.push(cleanupServiceStatus);

    // Model changes
    const cleanupModelChanged = this.eventBus.on(EventTypes.MODEL.CHANGED, async (data) => {
      if (this.enableLogging) {
        this.log.info('[UIManager] Model changed:', data.model);
      }
      
      // Probe capabilities for new model
      await this.modelManager.probeCapabilities(data.model);
    });
    this._eventListeners.push(cleanupModelChanged);

    // NOTE: Settings saved notification is handled directly in _saveSettings() method.
    // Do NOT add a duplicate listener here -- it causes multiple toasts.

    if (this.enableLogging) {
      this.log.info('[UIManager] Event listeners setup complete');
    }
  }
  /**
   * Setup settings modal
   * @private
   */
  _setupSettingsModal() {
    // Open button
    if (this.elements.settingsButton) {
      this._trackDomListener(this.elements.settingsButton, 'click', () => {
        this.uiStateManager.openSettings();
      });
    }

    // Close button
    if (this.elements.settingsCancelBtn) {
      this._trackDomListener(this.elements.settingsCancelBtn, 'click', () => {
        this.uiStateManager.closeSettings();
      });
    }

    // Save button
    if (this.elements.settingsSaveBtn) {
      this._trackDomListener(this.elements.settingsSaveBtn, 'click', async () => {
        await this._saveSettings();
      });
    }

    // Tab switching
    this.elements.tabs?.forEach(tab => {
      this._trackDomListener(tab, 'click', () => {
        const tabName = tab.dataset.tab;
        if (tabName) {
          this.uiStateManager.setActiveTab(tabName);
        }
      });
    });

    if (this.enableLogging) {
      this.log.info('[UIManager] Settings modal setup complete');
    }
  }

  /**
   * Setup artifacts controls
   * @private
   */
  _setupArtifactsControls() {
    if (this.elements.codePanelToggle) {
      this._trackDomListener(this.elements.codePanelToggle, 'click', () => {
        // This is now handled by MainApp's artifactsToggle event listener
        // which opens the ArtifactsLibraryModal
        this.log.info('[UIManager] Artifacts toggle clicked - handled by MainApp');
      });
    }

    if (this.enableLogging) {
      this.log.info('[UIManager] Artifacts controls setup complete');
    }
  }

  /**
   * Setup status updates
   * @private
   */
  _setupStatusUpdates() {
    // Ping backend button
    if (this.elements.btnPing) {
      this._trackDomListener(this.elements.btnPing, 'click', async () => {
        try {
          const health = await this.endpoint.getHealth();
          this.uiStateManager.showStatus(`Backend responded: ${JSON.stringify(health)}`, 'success', 5000);
        } catch (error) {
          this.uiStateManager.showStatus(`Backend error: ${error.message}`, 'error', 5000);
        }
      });
    }

    // Reconnect WebSocket button
    if (this.elements.btnReconnect) {
      this._trackDomListener(this.elements.btnReconnect, 'click', () => {
        if (this.guru && typeof this.guru.reconnect === 'function') {
          this.guru.reconnect();
          this.uiStateManager.showStatus('Reconnecting...', 'info', 3000);
        }
      });
    }

    if (this.enableLogging) {
      this.log.info('[UIManager] Status updates setup complete');
    }
  }

  /**
   * Register services for monitoring
   * @private
   */
  _registerServices() {
    // Register Aether backend
    this.serviceMonitor.registerService('aether-backend', {
      name: 'Aether Backend',
      url: this.endpoint.apiBaseUrl,
      useEndpoint: true
    });

    // Start monitoring
    this.serviceMonitor.start();

    if (this.enableLogging) {
      this.log.info('[UIManager] Services registered for monitoring');
    }
  }

  /**
   * Load initial data
   * @private
   */
  async _loadInitialData() {
    try {
      // Load settings
      await this.settingsManager.loadSettings();

      // Refresh model list
      const apiBase = this.settingsManager.getSetting('llm.api_base') || '';
      await this.modelManager.refreshModelList(apiBase);

      // Refresh profile list
      await this.profileManager.refreshProfileList();

      if (this.enableLogging) {
        this.log.info('[UIManager] Initial data loaded');
      }
    } catch (error) {
      // BackendUnavailableError is expected when skipHealthCheck=true — downgrade to debug.
      if (error.isBackendUnavailableError) {
        this.log.debug('[UIManager] Initial data skipped (backend unavailable)');
      } else {
        this.log.error('[UIManager] Error loading initial data:', error);
      }
    }
  }

  /**
   * Update backend info display
   * @private
   */
  async _updateBackendInfo() {
    try {
      const health = await this.endpoint.getHealth();
      
      if (this.elements.backendInfoEl && health.model) {
        this.elements.backendInfoEl.innerHTML = `<strong>MODEL:</strong> ${health.model.toUpperCase()}`;
        this.elements.backendInfoEl.style.color = 'var(--color-text-primary)';
      }

      if (health.model) {
        this.modelManager.setCurrentModel(health.model);
      }

      if (this.enableLogging) {
        this.log.info('[UIManager] Backend info updated:', health);
      }
    } catch (error) {
      if (this.elements.backendInfoEl) {
        this.elements.backendInfoEl.innerHTML = '<strong>WAITING FOR BACKEND…</strong>';
        this.elements.backendInfoEl.style.color = 'var(--color-warning)';
      }
      
      if (this.enableLogging) {
        this.log.warn('[UIManager] Backend info update failed:', error);
      }
    }
  }

  /**
   * Save settings
   * @private
   */
  async _saveSettings() {
    try {
      // Gather settings from form (implementation depends on form structure)
      const settings = this.settingsManager.getSettings();

      // Validate
      const validation = this.settingsManager.validateSettings(settings);
      if (!validation.valid) {
        this.uiStateManager.showStatus(`Validation failed: ${validation.errors.join(', ')}`, 'error', 5000);
        return;
      }

      // Save
      const result = await this.settingsManager.saveSettings(settings);

      if (result.success) {
        this.uiStateManager.showStatus('Settings saved successfully!', 'success', 3000);
      } else {
        this.uiStateManager.showStatus(`Save failed: ${result.error}`, 'error', 5000);
      }
    } catch (error) {
      this.log.error('[UIManager] Error saving settings:', error);
      this.uiStateManager.showStatus(`Error: ${error.message}`, 'error', 5000);
    }
  }

  /**
   * Update service card UI
   * @private
   */
  _updateServiceCardUI(serviceName, status) {
    // Implementation depends on service card structure
    if (this.enableLogging) {
      this.log.info(`[UIManager] Service ${serviceName} status: ${status}`);
    }
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    return Object.freeze({
      initialized: this.initialized,
      modules: {
        connectionMonitor: this.connectionMonitor.getStats(),
        modelManager: this.modelManager.getStats(),
        profileManager: this.profileManager.getStats(),
        settingsManager: this.settingsManager.getStats(),
        uiStateManager: this.uiStateManager.getStats(),
        serviceMonitor: this.serviceMonitor.getStats(),
        artifactsOrchestrator: this.artifactsOrchestrator.getStats()
      }
    });
  }

  /**
   * Setup WebSocket-to-IPC relay
   * @private
   * 
   * Chat window uses direct WebSocket connection.
   * Main window only handles visualizer and connection status.
   */
  _setupWebSocketToIPCRelay() {
    if (!this.guru || !this.ipc) {
      this.log.warn('[UIManager] WS-to-IPC relay unavailable');
      return;
    }
    
    this.log.info('[UIManager] Main window initialized');
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    this.log.info('UIManager: Disposing...');

    // Stop monitors
    this.connectionMonitor?.stop();
    this.serviceMonitor?.stop();
    this.artifactsOrchestrator?.stop();

    // Dispose submodules
    this.connectionMonitor?.dispose();
    this.modelManager?.dispose();
    this.profileManager?.dispose();
    this.settingsManager?.dispose();
    this.uiStateManager?.dispose();
    this.serviceMonitor?.dispose();
    this.artifactsOrchestrator?.dispose();

    // Remove EventBus listeners
    this._eventListeners.forEach(cleanup => {
      try {
        cleanup();
      } catch (error) {
        this.log.error('[UIManager] Error cleaning up EventBus listener:', error);
      }
    });
    this._eventListeners = [];

    // Remove DOM listeners
    for (const { element, event, handler } of this._domListeners) {
      try {
        element?.removeEventListener(event, handler);
      } catch (error) {
        this.log.error('[UIManager] Error cleaning up DOM listener:', error);
      }
    }
    this._domListeners = [];

    // Release element references
    this.elements = {};

    this.log.info('UIManager: Disposed');
  }
}

// Export
module.exports = UIManager;

if (typeof window !== 'undefined') {
  window.UIManager = UIManager;
}
