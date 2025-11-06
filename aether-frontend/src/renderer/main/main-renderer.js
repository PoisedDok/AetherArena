'use strict';

/**
 * @.architecture
 * 
 * Incoming: window.aether (from main-preload.js), IPC 'widget-mode-changed' | 'chat:assistant-stream' | 'chat:request-complete' --- {ipc_types.* | method_calls, json | javascript_api}
 * Processing: Bootstrap main window, initialize THREE.js Visualizer, HandsFreeMicManager, GuruConnection (WebSocket to backend), handle widget/normal mode, update telemetry (CPU/mem/FPS/mic/status/latency/nodes), handle settings modal, handle double-click/drag/zoom, route IPC events --- {10 jobs: JOB_INITIALIZE, JOB_DELEGATE_TO_MODULE, JOB_UPDATE_STATE, JOB_RENDER_MARKDOWN, JOB_ROUTE_BY_TYPE, JOB_UPDATE_STATE, JOB_ROUTE_BY_TYPE, JOB_ROUTE_BY_TYPE, JOB_EMIT_EVENT, JOB_ROUTE_BY_TYPE}
 * Outgoing: Visualizer.render() (THREE.js canvas), HandsFreeMicManager (continuous STT), IPC send, DOM updates (telemetry/settings/UI state) --- {dom_types.* | ipc_types.*, HTMLElement | json}
 * 
 * 
 * @module renderer/main/main-renderer
 * 
 * Main Window Renderer - Production Edition
 * ============================================================================
 * Complete renderer with full Three.js visualizer, hands-free voice control, 
 * telemetry updates, and all interactive controls.
 * Browser-only, CSP-compliant, secure architecture.
 */

console.log('🚀 Main Renderer: Starting...');

if (!window.aether) {
  console.error('❌ Main Renderer: Preload API not available');
  document.body.innerHTML = `
    <div style="padding: 40px; text-align: center; font-family: system-ui;">
      <h1 style="color: #ff4444;">Security Error</h1>
      <p>Preload API not available. Check main-preload.js configuration.</p>
    </div>
  `;
  throw new Error('Preload API not found');
}

console.log('✅ Main Renderer: Preload API available');

// ============================================================================
// Import Module Dependencies
// ============================================================================

const THREE = require('three');
window.THREE = THREE;

const NeuralNetworkVisualizer = require('./modules/visualizer/Visualizer');
const HandsFreeMicManager = require('./modules/audio/HandsFreeMicManager');
const GuruConnection = require('../../core/communication/GuruConnection');
const Endpoint = require('../../core/communication/Endpoint');
const SettingsManager = require('./modules/settings/SettingsManager');

class MainApp {
  constructor() {
    this.isWidgetMode = false;
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.initialX = 0;
    this.initialY = 0;
    
    this.elements = {};
    this.cleanupFunctions = [];
    
    this.visualizer = null;
    this.handsFreeMicManager = null;
    this.guru = null;
    this.endpoint = null;
    this.settingsManager = null;
    
    this.telemetryInterval = null;
    this.systemTimeInterval = null;
  }
  
  async initialize() {
    console.log('🏗️  Initializing main application...');
    
    try {
      this.cacheElements();
      this.initializeDependencies();
      this.initializeVisualizer();
      this.initializeHandsFreeMic();
      this.setupControls();
      this.setupEventListeners();
      this.setupIPCListeners();
      this.startTelemetryUpdates();
      this.initializeUI();
      
      console.log('✅ Main application initialized');
    } catch (error) {
      console.error('❌ Initialization failed:', error);
      this.showError('Failed to initialize application: ' + error.message);
    }
  }
  
  cacheElements() {
    this.elements = {
      root: document.getElementById('root'),
      widgetContainer: document.querySelector('.widget-container'),
      normalContainer: document.querySelector('.normal-container'),
      canvas: document.getElementById('scene-canvas'),
      menuTrigger: document.getElementById('menu-trigger'),
      controlPanel: document.getElementById('control-panel'),
      micToggle: document.getElementById('mic-toggle'),
      chatToggle: document.getElementById('chat-toggle'),
      settingsButton: document.getElementById('settings-button'),
      artifactsToggle: document.getElementById('code-panel-toggle'),
      cpuUsage: document.getElementById('cpu-usage'),
      memoryUsage: document.getElementById('memory-usage'),
      fpsCounter: document.getElementById('fps-counter'),
      micPercentage: document.getElementById('mic-percentage'),
      micLevelFill: document.getElementById('mic-level-fill'),
      systemStatus: document.getElementById('system-status'),
      networkLatency: document.getElementById('network-latency'),
      nodeCount: document.getElementById('node-count'),
      systemTime: document.getElementById('system-time'),
      modelStatusDot: document.getElementById('model-status-dot'),
      modelName: document.getElementById('model-name'),
      settingsModal: document.getElementById('settings-modal'),
      settingsSave: document.getElementById('settings-save'),
      settingsCancel: document.getElementById('settings-cancel'),
    };
    
    if (!this.elements.root) {
      throw new Error('Root element not found');
    }
  }
  
  initializeDependencies() {
    const wsUrl = `ws://localhost:${window.aether.ports?.backend || 8765}/`;
    this.guru = new GuruConnection({
      url: wsUrl,
      reconnectDelay: 2000,
      pingInterval: 30000,
      healthInterval: 5000,
      enableLogging: false
    });
    window.guru = this.guru;
    
    // Initialize Endpoint with proper config
    const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    this.endpoint = new Endpoint({
      NODE_ENV: isDev ? 'development' : 'production',
      API_BASE_URL: 'http://localhost:8765',
      WS_URL: wsUrl
    });
    
    // Make endpoint globally available
    window.endpoint = this.endpoint;
    
    // Initialize Settings Manager
    this.settingsManager = new SettingsManager(this.endpoint);
    window.settingsManager = this.settingsManager;
    
    console.log('✅ Core dependencies initialized (WebSocket:', wsUrl, ')');
  }
  
  initializeVisualizer() {
    if (!this.elements.canvas) {
      console.warn('⚠️  Canvas element not found, skipping visualizer');
      return;
    }
    
    try {
      this.visualizer = new NeuralNetworkVisualizer();
      console.log('✅ Visualizer initialized');
    } catch (error) {
      console.error('❌ Failed to initialize visualizer:', error);
    }
  }
  
  initializeHandsFreeMic() {
    if (!this.endpoint || !this.guru) {
      console.warn('⚠️  Dependencies not ready, skipping hands-free mic');
      return;
    }
    
    try {
      this.handsFreeMicManager = new HandsFreeMicManager(this.endpoint, this.guru);
      this.handsFreeMicManager.init();
      console.log('✅ Hands-free mic manager initialized');
    } catch (error) {
      console.error('❌ Failed to initialize hands-free mic:', error);
    }
  }
  
  setupControls() {
    if (this.elements.menuTrigger) {
      this.elements.menuTrigger.addEventListener('click', () => {
        this.toggleControlPanel();
      });
    }
    
    if (this.elements.chatToggle) {
      this.elements.chatToggle.addEventListener('click', () => {
        window.aether.chat.open();
        this.closeControlPanel();
      });
    }
    
    if (this.elements.settingsButton) {
      this.elements.settingsButton.addEventListener('click', () => {
        this.openSettings();
        this.closeControlPanel();
      });
    }
    
    if (this.elements.settingsCancel) {
      this.elements.settingsCancel.addEventListener('click', () => {
        this.closeSettings();
      });
    }
    
    if (this.elements.settingsSave) {
      this.elements.settingsSave.addEventListener('click', () => {
        this.saveSettings();
      });
    }
    
    const settingsTabs = document.querySelectorAll('.settings-tab');
    settingsTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const targetTab = tab.dataset.tab;
        this.switchSettingsTab(targetTab);
      });
    });
    
    // API Base change listener - reload models when API base changes
    const apiBaseEl = document.getElementById('llm-api-base');
    if (apiBaseEl) {
      apiBaseEl.addEventListener('blur', () => {
        if (this.settingsManager) {
          this.settingsManager.onApiBaseChange();
        }
      });
    }
    
    if (this.elements.artifactsToggle) {
      this.elements.artifactsToggle.addEventListener('click', () => {
        window.aether.artifacts.open();
        this.closeControlPanel();
      });
    }
    
    document.addEventListener('click', (e) => {
      if (this.elements.controlPanel && 
          this.elements.controlPanel.classList.contains('active') &&
          !this.elements.controlPanel.contains(e.target) &&
          !this.elements.menuTrigger.contains(e.target)) {
        this.closeControlPanel();
      }
    });
    
    console.log('✅ Controls setup complete');
  }
  
  toggleControlPanel() {
    if (this.elements.controlPanel && this.elements.menuTrigger) {
      this.elements.controlPanel.classList.toggle('active');
      this.elements.menuTrigger.classList.toggle('active');
    }
  }
  
  closeControlPanel() {
    if (this.elements.controlPanel && this.elements.menuTrigger) {
      this.elements.controlPanel.classList.remove('active');
      this.elements.menuTrigger.classList.remove('active');
    }
  }
  
  setupEventListeners() {
    if (this.elements.root) {
      this.elements.root.addEventListener('dblclick', () => {
        window.aether.window.onDoubleClick();
      });
    }
    
    if (this.elements.widgetContainer) {
      this.elements.widgetContainer.addEventListener('mousedown', (e) => {
        if (this.isWidgetMode) {
          this.startDrag(e);
        }
      });
      
      document.addEventListener('mousemove', (e) => {
        if (this.isDragging) {
          this.drag(e);
        }
      });
      
      document.addEventListener('mouseup', () => {
        if (this.isDragging) {
          this.endDrag();
        }
      });
    }
    
    document.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        window.aether.window.onWheel(e.deltaY, true);
      }
    }, { passive: false });
    
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        window.aether.window.toggleWidgetMode();
      }
      
      if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        window.aether.window.zoomIn();
      }
      
      if (e.ctrlKey && e.key === '-') {
        e.preventDefault();
        window.aether.window.zoomOut();
      }
    });
  }
  
  setupIPCListeners() {
    const widgetModeCleanup = window.aether.window.onWidgetModeChange((isWidget) => {
      this.isWidgetMode = isWidget;
      this.updateUI();
      
      if (this.visualizer && typeof this.visualizer.setWidgetMode === 'function') {
        this.visualizer.setWidgetMode(isWidget);
      }
    });
    
    this.cleanupFunctions.push(widgetModeCleanup);
    
    const chatStreamCleanup = window.aether.chat.onAssistantStream((chunk, metadata) => {
      this.handleAssistantStream(chunk, metadata);
    });
    
    this.cleanupFunctions.push(chatStreamCleanup);
    
    const requestCompleteCleanup = window.aether.chat.onRequestComplete((metadata) => {
      this.handleRequestComplete(metadata);
    });
    
    this.cleanupFunctions.push(requestCompleteCleanup);
  }
  
  startTelemetryUpdates() {
    // Update telemetry every 250ms
    this.telemetryInterval = setInterval(() => {
      this.updateTelemetry();
    }, 250);
    
    // Update system time every second
    this.systemTimeInterval = setInterval(() => {
      this.updateSystemTime();
    }, 1000);
    
    // Update model indicator every 5 seconds
    this.modelIndicatorInterval = setInterval(() => {
      this.updateModelIndicator();
    }, 5000);
    
    // Initial updates
    this.updateTelemetry();
    this.updateSystemTime();
    this.updateModelIndicator();
    
    console.log('✅ Telemetry updates started');
  }
  
  async updateTelemetry() {
    // Get real system stats
    const stats = await window.aether.system.getStats();
    
    if (stats) {
      // CPU usage (real)
      if (this.elements.cpuUsage) {
        this.elements.cpuUsage.textContent = `${stats.cpu.percent}%`;
      }
      
      // Memory usage (real, convert to MB)
      if (this.elements.memoryUsage) {
        const memMB = Math.round(stats.process.memory / (1024 * 1024));
        this.elements.memoryUsage.textContent = `${memMB} MB`;
      }
    }
    
    // FPS from visualizer
    if (this.elements.fpsCounter && this.visualizer) {
      const fps = this.visualizer.fpsValues.length
        ? Math.round(this.visualizer.fpsValues.reduce((a, b) => a + b) / this.visualizer.fpsValues.length)
        : 60;
      this.elements.fpsCounter.textContent = `${fps}`;
    }
    
    // Mic percentage from audio level
    if (this.elements.micPercentage && this.guru) {
      const micLevel = Math.round((this.guru.state.audioLevel || 0) * 100);
      this.elements.micPercentage.textContent = `${micLevel}%`;
    }
    
    // System status from guru state
    if (this.elements.systemStatus && this.guru) {
      const status = (this.guru.state.assistant || 'idle').toUpperCase();
      this.elements.systemStatus.textContent = status;
      
      this.elements.systemStatus.className = 'stat-value status-badge';
      this.elements.systemStatus.classList.add(`status-${this.guru.state.assistant || 'idle'}`);
    }
    
    // Network latency from WebSocket ping
    if (this.elements.networkLatency && this.guru && this.guru.lastPingTime !== undefined) {
      this.elements.networkLatency.textContent = `${this.guru.lastPingTime}ms`;
    }
    
    // Node count from visualizer
    if (this.elements.nodeCount && this.visualizer && this.visualizer.neuralNetwork) {
      const nodeCount = this.visualizer.neuralNetwork.nodes?.length || 0;
      this.elements.nodeCount.textContent = `${nodeCount}`;
    }
  }
  
  updateSystemTime() {
    if (this.elements.systemTime) {
      const now = new Date();
      const hours = String(now.getHours()).padStart(2, '0');
      const minutes = String(now.getMinutes()).padStart(2, '0');
      const seconds = String(now.getSeconds()).padStart(2, '0');
      this.elements.systemTime.textContent = `${hours}:${minutes}:${seconds}`;
    }
  }
  
  initializeUI() {
    this.updateUI();
    this.updateModelIndicator();
  }
  
  async updateModelIndicator() {
    try {
      const endpoint = window.endpoint;
      if (!endpoint) {
        this.setModelStatus('offline', 'No Connection');
        return;
      }
      
      const health = await endpoint.getHealth();
      
      if (health && health.model) {
        this.setModelStatus('online', health.model);
      } else {
        this.setModelStatus('online', 'Connected');
      }
    } catch (error) {
      this.setModelStatus('offline', 'Offline');
    }
  }
  
  setModelStatus(status, modelName) {
    if (this.elements.modelStatusDot) {
      this.elements.modelStatusDot.className = 'model-status-dot';
      this.elements.modelStatusDot.classList.add(status);
    }
    
    if (this.elements.modelName && modelName) {
      this.elements.modelName.textContent = modelName;
    }
  }
  
  updateUI() {
    if (this.elements.widgetContainer) {
      this.elements.widgetContainer.style.display = this.isWidgetMode ? 'flex' : 'none';
    }
    
    if (this.elements.normalContainer) {
      this.elements.normalContainer.style.display = this.isWidgetMode ? 'none' : 'flex';
    }
    
    document.body.classList.toggle('widget-mode', this.isWidgetMode);
    document.body.classList.toggle('normal-mode', !this.isWidgetMode);
  }
  
  /**
   * Open settings modal
   */
  async openSettings() {
    if (this.elements.settingsModal) {
      this.elements.settingsModal.classList.remove('hidden');
      this.switchSettingsTab('assistant');
      
      // Load settings using SettingsManager
      if (this.settingsManager) {
        try {
          await this.settingsManager.loadSettings();
        } catch (error) {
          console.error('[MainApp] Failed to load settings:', error);
        }
      }
    }
  }
  
  /**
   * Close settings modal
   */
  closeSettings() {
    if (this.elements.settingsModal) {
      this.elements.settingsModal.classList.add('hidden');
    }
  }
  
  /**
   * Switch settings tab
   */
  switchSettingsTab(tabName) {
    // Remove active class from all tabs
    const allTabs = document.querySelectorAll('.settings-tab');
    allTabs.forEach(tab => tab.classList.remove('active'));
    
    // Remove active class from all sections
    const allSections = document.querySelectorAll('.settings-section');
    allSections.forEach(section => section.classList.remove('active'));
    
    // Add active class to selected tab and section
    const selectedTab = document.querySelector(`.settings-tab[data-tab="${tabName}"]`);
    const selectedSection = document.getElementById(`tab-${tabName}`);
    
    if (selectedTab) selectedTab.classList.add('active');
    if (selectedSection) selectedSection.classList.add('active');

    // Load services status when switching to connections tab
    if (tabName === 'connections' && this.settingsManager) {
      this.settingsManager.loadServicesStatus().catch(err => {
        console.error('[MainApp] Failed to load services status:', err);
      });
    }

    // Refresh integrations display when switching to integrations tab
    if (tabName === 'integrations' && this.currentSettings && this.currentSettings.integrations) {
      const integrations = this.currentSettings.integrations;
      const perplexicaEl = document.getElementById('integration-perplexica');
      const searxngEl = document.getElementById('integration-searxng');
      const doclingEl = document.getElementById('integration-docling');
      const mcpEl = document.getElementById('integration-mcp');

      if (perplexicaEl) perplexicaEl.checked = integrations.perplexica_enabled || false;
      if (searxngEl) searxngEl.checked = integrations.searxng_enabled || false;
      if (doclingEl) doclingEl.checked = integrations.docling_enabled || false;
      if (mcpEl) mcpEl.checked = integrations.mcp_enabled || false;
    }
  }
  
  /**
   * Save settings
   */
  async saveSettings() {
    if (this.settingsManager) {
      try {
        await this.settingsManager.saveSettings();
        setTimeout(() => this.closeSettings(), 1000);
      } catch (error) {
        console.error('[MainApp] Failed to save settings:', error);
      }
    }
  }
  
  /**
   * Handle assistant stream
   */
  handleAssistantStream(chunk, metadata) {
    // Update guru state
    if (this.guru) {
      this.guru.updateState({ assistant: 'speaking' });
    }
  }
  
  /**
   * Handle request complete
   */
  handleRequestComplete(metadata) {
    // Update guru state
    if (this.guru) {
      this.guru.updateState({ assistant: 'idle' });
    }
  }
  
  /**
   * Start dragging widget
   */
  startDrag(e) {
    this.isDragging = true;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    
    this.initialX = 0;
    this.initialY = 0;
    
    document.body.style.cursor = 'move';
  }
  
  /**
   * Drag widget
   */
  drag(e) {
    const deltaX = e.clientX - this.dragStartX;
    const deltaY = e.clientY - this.dragStartY;
    
    const newX = this.initialX + deltaX;
    const newY = this.initialY + deltaY;
    
    window.aether.window.updatePosition(newX, newY);
  }
  
  /**
   * End dragging
   */
  endDrag() {
    this.isDragging = false;
    document.body.style.cursor = '';
  }
  
  /**
   * Show error
   */
  showError(message) {
    if (this.elements.root) {
      this.elements.root.innerHTML = `
        <div style="padding: 40px; text-align: center;">
          <h2 style="color: #ff4444;">Error</h2>
          <p>${message}</p>
        </div>
      `;
    }
  }
  
  /**
   * Cleanup
   */
  cleanup() {
    console.log('🧹 Cleaning up main application...');
    
    // Stop telemetry
    if (this.telemetryInterval) {
      clearInterval(this.telemetryInterval);
      this.telemetryInterval = null;
    }
    
    if (this.systemTimeInterval) {
      clearInterval(this.systemTimeInterval);
      this.systemTimeInterval = null;
    }
    
    if (this.modelIndicatorInterval) {
      clearInterval(this.modelIndicatorInterval);
      this.modelIndicatorInterval = null;
    }
    
    // Cleanup visualizer
    if (this.visualizer && typeof this.visualizer.destroy === 'function') {
      this.visualizer.destroy();
      this.visualizer = null;
    }
    
    // Cleanup hands-free mic manager
    if (this.handsFreeMicManager && typeof this.handsFreeMicManager.dispose === 'function') {
      this.handsFreeMicManager.dispose();
      this.handsFreeMicManager = null;
    }
    
    // Call all cleanup functions
    for (const cleanup of this.cleanupFunctions) {
      try {
        cleanup();
      } catch (error) {
        console.error('Cleanup error:', error);
      }
    }
    
    this.cleanupFunctions = [];
  }
}

// ============================================================================
// Application Entry Point
// ============================================================================

let app = null;

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeApp);
} else {
  initializeApp();
}

function initializeApp() {
  try {
    app = new MainApp();
    app.initialize();
    
    // Expose for debugging
    window.__mainApp = app;
  } catch (error) {
    console.error('❌ Fatal error:', error);
  }
}

// Cleanup on unload
window.addEventListener('beforeunload', () => {
  if (app) {
    app.cleanup();
  }
});

console.log('✅ Main renderer script loaded');
