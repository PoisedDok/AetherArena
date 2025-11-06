'use strict';

/**
 * @.architecture
 * 
 * Incoming: Event 'message' from GuruConnection.js (WebSocket messages) --- {assistant_message | system_message | server_message, json}
 * Processing: WebSocket-to-IPC relay transforming WS payloads to IPC format, route by role (assistant/server), delegate to 7 submodules (ConnectionMonitor/ModelManager/ProfileManager/SettingsManager/UIStateManager/ServiceStatusMonitor/ArtifactsStreamHandler), initialize all managers, start/stop monitors, gather UI elements, setup event listeners, load initial data --- {7 jobs: JOB_DELEGATE_TO_MODULE, JOB_DISPOSE, JOB_INITIALIZE, JOB_ROUTE_BY_TYPE, JOB_SEND_IPC, JOB_START, JOB_TRANSFORM_TO_CHUNK}
 * Outgoing: IPC 'chat:assistant-stream' → Chat Window MessageManager.js, IPC 'chat:server-message' → Chat Window --- {ipc_stream_chunk, json}
 * 
 * 
 * @module application/main/UIManager
 */

const ConnectionMonitor = require('./ConnectionMonitor');
const ModelManager = require('./ModelManager');
const ProfileManager = require('./ProfileManager');
const SettingsManager = require('./SettingsManager');
const UIStateManager = require('./UIStateManager');
const ServiceStatusMonitor = require('./ServiceStatusMonitor');
const ArtifactsStreamHandler = require('./ArtifactsStreamHandler');
const { EventTypes } = require('../../core/events/EventTypes');

class UIManager {
  constructor(options = {}) {
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
    
    // Event listener cleanup functions
    this._eventListeners = [];
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

      // Artifacts Stream Handler
      this.artifactsHandler = new ArtifactsStreamHandler({
        ipc: this.ipc,
        eventBus: this.eventBus,
        guruConnection: this.guru,
        enableLogging: this.enableLogging
      });

      if (this.enableLogging) {
        console.log('[UIManager] All submodules initialized');
      }
    } catch (error) {
      console.error('[UIManager] Error initializing submodules:', error);
      throw error;
    }
  }

  /**
   * Initialize UI Manager
   * @returns {Promise<void>}
   */
  async init() {
    if (this.initialized) {
      console.warn('[UIManager] Already initialized');
      return;
    }

    console.log('🎨 UIManager: Initializing...');

    try {
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
      this.artifactsHandler.start();

      // Phase 7: Register services for monitoring
      this._registerServices();

      // Phase 8: Load initial data
      await this._loadInitialData();

      // Phase 9: Update backend info
      await this._updateBackendInfo();

      this.initialized = true;

      console.log('✅ UIManager: Initialization complete');
    } catch (error) {
      console.error('❌ UIManager: Initialization failed:', error);
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
        documents: document.getElementById('tab-documents')
      }
    };

    // Register elements with UI state manager
    this.uiStateManager.registerElements(this.elements);

    if (this.enableLogging) {
      console.log('[UIManager] Gathered', Object.keys(this.elements).length, 'UI elements');
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
        console.log('[UIManager] Connection status changed:', data.connected ? 'ONLINE' : 'OFFLINE');
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
        console.log('[UIManager] Model changed:', data.model);
      }
      
      // Probe capabilities for new model
      await this.modelManager.probeCapabilities(data.model);
    });
    this._eventListeners.push(cleanupModelChanged);

    // Settings saved
    const cleanupSettingsSaved = this.eventBus.on(EventTypes.UI.SETTINGS_SAVED, (data) => {
      this.uiStateManager.showStatus('Settings saved successfully!', 'success', 3000);
    });
    this._eventListeners.push(cleanupSettingsSaved);

    if (this.enableLogging) {
      console.log('[UIManager] Event listeners setup complete');
    }
  }

  /**
   * Setup settings modal
   * @private
   */
  _setupSettingsModal() {
    // Open button
    if (this.elements.settingsButton) {
      this.elements.settingsButton.addEventListener('click', () => {
        this.uiStateManager.openSettings();
      });
    }

    // Close button
    if (this.elements.settingsCancelBtn) {
      this.elements.settingsCancelBtn.addEventListener('click', () => {
        this.uiStateManager.closeSettings();
      });
    }

    // Save button
    if (this.elements.settingsSaveBtn) {
      this.elements.settingsSaveBtn.addEventListener('click', async () => {
        await this._saveSettings();
      });
    }

    // Tab switching
    this.elements.tabs?.forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        if (tabName) {
          this.uiStateManager.setActiveTab(tabName);
        }
      });
    });

    if (this.enableLogging) {
      console.log('[UIManager] Settings modal setup complete');
    }
  }

  /**
   * Setup artifacts controls
   * @private
   */
  _setupArtifactsControls() {
    if (this.elements.codePanelToggle) {
      this.elements.codePanelToggle.addEventListener('click', () => {
        if (this.ipc) {
          this.ipc.send('artifacts:toggle');
        }
      });
    }

    if (this.enableLogging) {
      console.log('[UIManager] Artifacts controls setup complete');
    }
  }

  /**
   * Setup status updates
   * @private
   */
  _setupStatusUpdates() {
    // Ping backend button
    if (this.elements.btnPing) {
      this.elements.btnPing.addEventListener('click', async () => {
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
      this.elements.btnReconnect.addEventListener('click', () => {
        if (this.guru && typeof this.guru.reconnect === 'function') {
          this.guru.reconnect();
          this.uiStateManager.showStatus('Reconnecting...', 'info', 3000);
        }
      });
    }

    if (this.enableLogging) {
      console.log('[UIManager] Status updates setup complete');
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
      console.log('[UIManager] Services registered for monitoring');
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
        console.log('[UIManager] Initial data loaded');
      }
    } catch (error) {
      console.error('[UIManager] Error loading initial data:', error);
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
        this.elements.backendInfoEl.style.color = 'rgba(255, 255, 255, 0.9)';
      }

      if (health.model) {
        this.modelManager.setCurrentModel(health.model);
      }

      if (this.enableLogging) {
        console.log('[UIManager] Backend info updated:', health);
      }
    } catch (error) {
      if (this.elements.backendInfoEl) {
        this.elements.backendInfoEl.innerHTML = '<strong>WAITING FOR BACKEND…</strong>';
        this.elements.backendInfoEl.style.color = '#facc15';
      }
      
      if (this.enableLogging) {
        console.warn('[UIManager] Backend info update failed:', error);
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
      console.error('[UIManager] Error saving settings:', error);
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
      console.log(`[UIManager] Service ${serviceName} status: ${status}`);
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
        artifactsHandler: this.artifactsHandler.getStats()
      }
    });
  }

  /**
   * Setup WebSocket-to-IPC message relay
   * Critical component for forwarding streaming messages to chat window
   * @private
   */
  _setupWebSocketToIPCRelay() {
    if (!this.guru) {
      console.error('[UIManager] Cannot setup WS-to-IPC relay: guru not available');
      return;
    }
    
    if (!this.ipc) {
      console.warn('[UIManager] Cannot setup WS-to-IPC relay: IPC not available');
      return;
    }
    
    // Forward all WebSocket 'message' events to chat window via IPC
    this.guru.on('message', (payload) => {
      try {
        // Assistant streaming messages
        if (payload.role === 'assistant' && payload.type === 'message') {
          const chunk = {
            chunk: payload.content || '',
            id: payload.id || null,  // This is now frontend_id (restored from backend echo)
            backend_id: payload._backend_id || null,  // Preserved backend ID
            start: payload.start || false,
            done: payload.end || false,
            type: payload.type
          };
          
          // LOG RELAY: Data passing through main → chat window
          console.log('[UIManager] 🔄 RELAY: Main → Chat window:', {
            frontend_id: chunk.id,
            backend_id: chunk.backend_id,
            contentLength: chunk.chunk.length,
            start: chunk.start,
            done: chunk.done
          });
          
          // Forward to chat window
          this.ipc.send('chat:assistant-stream', chunk);
        }
        
        // Server messages (completion, stopped, errors)
        if (payload.role === 'server') {
          console.log('[UIManager] 🔄 RELAY: Server message → Chat window:', {
            type: payload.type,
            id: payload.id
          });
          this.ipc.send('chat:server-message', payload);
        }
      } catch (error) {
        console.error('[UIManager] Error relaying message to IPC:', error);
      }
    });
    
    console.log('[UIManager] ✅ WebSocket-to-IPC relay established');
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    console.log('🛑 UIManager: Disposing...');

    // Stop monitors
    this.connectionMonitor?.stop();
    this.serviceMonitor?.stop();
    this.artifactsHandler?.stop();

    // Dispose submodules
    this.connectionMonitor?.dispose();
    this.modelManager?.dispose();
    this.profileManager?.dispose();
    this.settingsManager?.dispose();
    this.uiStateManager?.dispose();
    this.serviceMonitor?.dispose();
    this.artifactsHandler?.dispose();

    // Remove event listeners
    this._eventListeners.forEach(cleanup => {
      try {
        cleanup();
      } catch (error) {
        console.error('[UIManager] Error cleaning up listener:', error);
      }
    });
    this._eventListeners = [];

    console.log('✅ UIManager: Disposed');
  }
}

// Export
module.exports = UIManager;

if (typeof window !== 'undefined') {
  window.UIManager = UIManager;
  console.log('📦 UIManager loaded');
}

