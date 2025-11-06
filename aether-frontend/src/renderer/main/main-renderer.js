'use strict';

/**
 * @.architecture
 * 
 * Incoming: window.aether (from main-preload.js), IPC 'widget-mode-changed' | 'chat:assistant-stream' | 'chat:request-complete' --- {ipc_types.* | method_calls, json | javascript_api}
 * Processing: Bootstrap main window, initialize THREE.js Visualizer, AudioManager, GuruConnection (WebSocket to backend), handle widget/normal mode, update telemetry (CPU/mem/FPS/mic/status/latency/nodes), handle settings modal, handle double-click/drag/zoom, route IPC events --- {10 jobs: JOB_INITIALIZE, JOB_DELEGATE_TO_MODULE, JOB_UPDATE_STATE, JOB_RENDER_MARKDOWN, JOB_ROUTE_BY_TYPE, JOB_UPDATE_STATE, JOB_ROUTE_BY_TYPE, JOB_ROUTE_BY_TYPE, JOB_EMIT_EVENT, JOB_ROUTE_BY_TYPE}
 * Outgoing: Visualizer.render() (THREE.js canvas), AudioManager.capture/play, IPC send, DOM updates (telemetry/settings/UI state) --- {dom_types.* | ipc_types.*, HTMLElement | json}
 * 
 * 
 * @module renderer/main/main-renderer
 * 
 * Main Window Renderer - Production Edition
 * ============================================================================
 * Complete renderer with full Three.js visualizer, audio management, 
 * telemetry updates, and all interactive controls.
 * Browser-only, CSP-compliant, secure architecture.
 */

console.log('🚀 Main Renderer: Starting...');

// ============================================================================
// Validation & Dependency Checks
// ============================================================================

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
console.log('📦 Aether versions:', window.aether.versions);

// ============================================================================
// Import Module Dependencies
// ============================================================================

// Import THREE.js and expose globally for Visualizer
const THREE = require('three');
window.THREE = THREE;

// These will be bundled by esbuild
const NeuralNetworkVisualizer = require('./modules/visualizer/Visualizer');
const AudioManager = require('./modules/audio/AudioManager');
const GuruConnection = require('../../core/communication/GuruConnection');

// ============================================================================
// Minimal Endpoint Mock for Browser Context
// ============================================================================

class Endpoint {
  constructor(aetherAPI) {
    this.aether = aetherAPI;
    this.connection = {
      send: (data) => {
        // Use IPC to send to backend
        if (this.aether && this.aether.ipc) {
          this.aether.ipc.send('audio-stream', data);
        }
      }
    };
  }
}

// ============================================================================
// Main Application Class
// ============================================================================

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
    
    // Core modules
    this.visualizer = null;
    this.audioManager = null;
    this.guru = null;
    this.endpoint = null;
    
    // Telemetry
    this.telemetryInterval = null;
    this.systemTimeInterval = null;
  }
  
  /**
   * Initialize application
   */
  async initialize() {
    console.log('🏗️  Initializing main application...');
    
    try {
      // Cache DOM elements
      this.cacheElements();
      
      // Initialize core dependencies
      this.initializeDependencies();
      
      // Initialize modules
      this.initializeVisualizer();
      this.initializeAudioManager();
      
      // Setup UI controls
      this.setupControls();
      
      // Setup event listeners
      this.setupEventListeners();
      
      // Setup IPC listeners
      this.setupIPCListeners();
      
      // Start telemetry updates
      this.startTelemetryUpdates();
      
      // Initialize UI state
      this.initializeUI();
      
      console.log('✅ Main application initialized');
    } catch (error) {
      console.error('❌ Initialization failed:', error);
      this.showError('Failed to initialize application: ' + error.message);
    }
  }
  
  /**
   * Cache DOM elements
   */
  cacheElements() {
    this.elements = {
      root: document.getElementById('root'),
      widgetContainer: document.querySelector('.widget-container'),
      normalContainer: document.querySelector('.normal-container'),
      canvas: document.getElementById('scene-canvas'),
      
      // Controls
      micButton: document.getElementById('mic-button'),
      chatToggle: document.getElementById('chat-toggle'),
      settingsButton: document.getElementById('settings-button'),
      artifactsToggle: document.getElementById('code-panel-toggle'),
      
      // Telemetry
      cpuUsage: document.getElementById('cpu-usage'),
      memoryUsage: document.getElementById('memory-usage'),
      fpsCounter: document.getElementById('fps-counter'),
      micPercentage: document.getElementById('mic-percentage'),
      micLevelFill: document.getElementById('mic-level-fill'),
      systemStatus: document.getElementById('system-status'),
      networkLatency: document.getElementById('network-latency'),
      nodeCount: document.getElementById('node-count'),
      systemTime: document.getElementById('system-time'),
      connectionStatus: document.getElementById('connection-status'),
      backendInfo: document.getElementById('backend-info'),
      
      // Settings modal
      settingsModal: document.getElementById('settings-modal'),
      settingsSave: document.getElementById('settings-save'),
      settingsCancel: document.getElementById('settings-cancel'),
    };
    
    if (!this.elements.root) {
      throw new Error('Root element not found');
    }
  }
  
  /**
   * Initialize core dependencies
   */
  initializeDependencies() {
    // Create real guru connection to backend
    // Backend runs on port 8765 by default
    const wsUrl = `ws://localhost:${window.aether.ports?.backend || 8765}/`;
    this.guru = new GuruConnection({
      url: wsUrl,
      reconnectDelay: 2000,
      pingInterval: 30000,
      healthInterval: 5000,
      enableLogging: false
    });
    window.guru = this.guru; // Expose for visualizer and audio manager
    
    // Create endpoint
    this.endpoint = new Endpoint(window.aether);
    
    console.log('✅ Core dependencies initialized (WebSocket:', wsUrl, ')');
  }
  
  /**
   * Initialize Three.js visualizer
   */
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
  
  /**
   * Initialize audio manager
   */
  initializeAudioManager() {
    if (!this.endpoint || !this.guru) {
      console.warn('⚠️  Dependencies not ready, skipping audio manager');
      return;
    }
    
    try {
      this.audioManager = new AudioManager(this.endpoint, this.guru);
      console.log('✅ Audio manager initialized');
    } catch (error) {
      console.error('❌ Failed to initialize audio manager:', error);
    }
  }
  
  /**
   * Setup UI controls
   */
  setupControls() {
    // Chat toggle
    if (this.elements.chatToggle) {
      this.elements.chatToggle.addEventListener('click', () => {
        window.aether.chat.open();
      });
    }
    
    // Settings button
    if (this.elements.settingsButton) {
      this.elements.settingsButton.addEventListener('click', () => {
        this.openSettings();
      });
    }
    
    // Settings modal
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
    
    // Settings tabs
    const settingsTabs = document.querySelectorAll('.settings-tab');
    settingsTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const targetTab = tab.dataset.tab;
        this.switchSettingsTab(targetTab);
      });
    });
    
    // Artifacts toggle
    if (this.elements.artifactsToggle) {
      this.elements.artifactsToggle.addEventListener('click', () => {
        window.aether.artifacts.open();
      });
    }
    
    console.log('✅ Controls setup complete');
  }
  
  /**
   * Setup DOM event listeners
   */
  setupEventListeners() {
    // Double-click to exit widget mode
    if (this.elements.root) {
      this.elements.root.addEventListener('dblclick', () => {
        console.log('🖱️  Double-click detected');
        window.aether.window.onDoubleClick();
      });
    }
    
    // Widget dragging
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
    
    // Mouse wheel zoom (Ctrl+Wheel)
    document.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        window.aether.window.onWheel(e.deltaY, true);
      }
    }, { passive: false });
    
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Escape to enter widget mode
      if (e.key === 'Escape') {
        e.preventDefault();
        window.aether.window.toggleWidgetMode();
      }
      
      // Ctrl+Plus to zoom in
      if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        window.aether.window.zoomIn();
      }
      
      // Ctrl+Minus to zoom out
      if (e.ctrlKey && e.key === '-') {
        e.preventDefault();
        window.aether.window.zoomOut();
      }
    });
  }
  
  /**
   * Setup IPC event listeners
   */
  setupIPCListeners() {
    // Widget mode changes
    const widgetModeCleanup = window.aether.window.onWidgetModeChange((isWidget) => {
      console.log('🔄 Widget mode changed:', isWidget);
      this.isWidgetMode = isWidget;
      this.updateUI();
      
      // Notify visualizer of widget mode
      if (this.visualizer && typeof this.visualizer.setWidgetMode === 'function') {
        this.visualizer.setWidgetMode(isWidget);
      }
    });
    
    this.cleanupFunctions.push(widgetModeCleanup);
    
    // Chat assistant stream
    const chatStreamCleanup = window.aether.chat.onAssistantStream((chunk, metadata) => {
      console.log('💬 Assistant stream:', { chunk: chunk.substring(0, 50), metadata });
      this.handleAssistantStream(chunk, metadata);
    });
    
    this.cleanupFunctions.push(chatStreamCleanup);
    
    // Request complete
    const requestCompleteCleanup = window.aether.chat.onRequestComplete((metadata) => {
      console.log('✅ Request complete:', metadata);
      this.handleRequestComplete(metadata);
    });
    
    this.cleanupFunctions.push(requestCompleteCleanup);
  }
  
  /**
   * Start telemetry updates
   */
  startTelemetryUpdates() {
    // Update telemetry every 250ms
    this.telemetryInterval = setInterval(() => {
      this.updateTelemetry();
    }, 250);
    
    // Update system time every second
    this.systemTimeInterval = setInterval(() => {
      this.updateSystemTime();
    }, 1000);
    
    // Initial update
    this.updateTelemetry();
    this.updateSystemTime();
    
    console.log('✅ Telemetry updates started');
  }
  
  /**
   * Update telemetry displays
   */
  updateTelemetry() {
    // CPU usage (simulated - would come from backend)
    if (this.elements.cpuUsage) {
      const cpu = Math.round(Math.random() * 30 + 10); // Simulated
      this.elements.cpuUsage.textContent = `${cpu}%`;
    }
    
    // Memory usage (simulated - would come from backend)
    if (this.elements.memoryUsage) {
      const mem = Math.round(Math.random() * 200 + 100); // Simulated
      this.elements.memoryUsage.textContent = `${mem} MB`;
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
      
      // Update status indicator class
      this.elements.systemStatus.className = 'status-indicator';
      this.elements.systemStatus.classList.add(`status-${this.guru.state.assistant || 'idle'}`);
    }
    
    // Network latency (would come from backend)
    if (this.elements.networkLatency) {
      const latency = Math.round(Math.random() * 20 + 15); // Simulated
      this.elements.networkLatency.textContent = `${latency}ms`;
    }
    
    // Node count from visualizer
    if (this.elements.nodeCount && this.visualizer && this.visualizer.neuralNetwork) {
      const nodeCount = this.visualizer.neuralNetwork.nodes?.length || 0;
      this.elements.nodeCount.textContent = `${nodeCount}`;
    }
  }
  
  /**
   * Update system time
   */
  updateSystemTime() {
    if (this.elements.systemTime) {
      const now = new Date();
      const hours = String(now.getHours()).padStart(2, '0');
      const minutes = String(now.getMinutes()).padStart(2, '0');
      const seconds = String(now.getSeconds()).padStart(2, '0');
      this.elements.systemTime.textContent = `${hours}:${minutes}:${seconds}`;
    }
  }
  
  /**
   * Initialize UI state
   */
  initializeUI() {
    this.updateUI();
  }
  
  /**
   * Update UI based on mode
   */
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
      // Default to assistant tab
      this.switchSettingsTab('assistant');
      
      // Load settings from backend
      await this.loadSettings();
    }
  }
  
  /**
   * Load settings from backend
   */
  async loadSettings() {
    try {
      console.log('📥 Loading settings from backend...');
      
      // Show loading status
      const statusEl = document.getElementById('settings-status');
      if (statusEl) {
        statusEl.textContent = 'Loading...';
      }
      
      // Get endpoint
      const endpoint = window.endpoint;
      if (!endpoint) {
        throw new Error('Endpoint not available');
      }
      
      // Try TOML settings first, fall back to regular settings
      let settings;
      let source = 'toml';
      try {
        settings = await endpoint.getSettings();
      } catch (tomlError) {
        console.warn('⚠️  TOML settings failed, using regular settings:', tomlError.message);
        settings = await endpoint.getSettings();
        source = 'json';
      }
      
      console.log('✅ Settings loaded from backend:', settings);
      
      // Populate form fields
      await this.populateSettingsForm(settings);
      
      // Update status
      if (statusEl) {
        statusEl.textContent = `Loaded from ${source.toUpperCase()}`;
        setTimeout(() => {
          statusEl.textContent = '';
        }, 2000);
      }
    } catch (error) {
      console.error('❌ Failed to load settings:', error);
      const statusEl = document.getElementById('settings-status');
      if (statusEl) {
        statusEl.textContent = 'Load failed';
        statusEl.style.color = '#ff6b6b';
        setTimeout(() => {
          statusEl.textContent = '';
          statusEl.style.color = '';
        }, 3000);
      }
    }
  }
  
  /**
   * Populate settings form
   */
  async populateSettingsForm(settings) {
    console.log('📝 Populating settings form...');
    
    // LLM Settings
    if (settings.llm) {
      const providerEl = document.getElementById('llm-provider');
      const apiBaseEl = document.getElementById('llm-api-base');
      const modelEl = document.getElementById('llm-model');
      
      if (providerEl && settings.llm.provider) {
        providerEl.value = settings.llm.provider;
      }
      if (apiBaseEl && settings.llm.api_base) {
        apiBaseEl.value = settings.llm.api_base;
      }
      
      // Load models if API base is available
      if (settings.llm.api_base && modelEl) {
        try {
          const endpoint = window.endpoint;
          const models = await endpoint.getModels(settings.llm.api_base);
          
          // Clear and populate model dropdown
          modelEl.innerHTML = '<option value="">Select a model...</option>';
          if (models && models.length > 0) {
            models.forEach(model => {
              const option = document.createElement('option');
              option.value = model.id || model;
              option.textContent = model.id || model;
              modelEl.appendChild(option);
            });
            
            // Select current model
            if (settings.llm.model) {
              modelEl.value = settings.llm.model;
            }
          }
          
          // Update help text
          const modelHelp = document.getElementById('llm-model-help');
          if (modelHelp) {
            modelHelp.textContent = `${models.length} models available`;
          }
        } catch (error) {
          console.error('Failed to load models:', error);
          const modelHelp = document.getElementById('llm-model-help');
          if (modelHelp) {
            modelHelp.textContent = 'Failed to load models';
            modelHelp.style.color = '#ff6b6b';
          }
        }
      }
    }
    
    // Profile Settings
    if (settings.interpreter && settings.interpreter.profile) {
      const profileEl = document.getElementById('oi-profile');
      if (profileEl) {
        try {
          const endpoint = window.endpoint;
          const profiles = await endpoint.getProfiles();
          
          // Clear and populate profile dropdown
          profileEl.innerHTML = '<option value="">Select a profile...</option>';
          if (profiles && profiles.length > 0) {
            profiles.forEach(profile => {
              const option = document.createElement('option');
              option.value = profile;
              option.textContent = profile;
              profileEl.appendChild(option);
            });
            
            // Select current profile
            profileEl.value = settings.interpreter.profile;
          }
          
          // Update help text
          const profileHelp = document.getElementById('oi-profile-help');
          if (profileHelp) {
            profileHelp.textContent = `${profiles.length} profiles available`;
          }
        } catch (error) {
          console.error('Failed to load profiles:', error);
        }
      }
    }
    
    console.log('✅ Settings form populated');
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
  }
  
  /**
   * Save settings
   */
  async saveSettings() {
    try {
      console.log('💾 Saving settings...');
      
      // Show saving status
      const statusEl = document.getElementById('settings-status');
      if (statusEl) {
        statusEl.textContent = 'Saving...';
      }
      
      // Collect settings from form
      const settings = this.collectSettingsFromForm();
      console.log('📦 Collected settings:', settings);
      
      // Get endpoint
      const endpoint = window.endpoint;
      if (!endpoint) {
        throw new Error('Endpoint not available');
      }
      
      // Save to backend
      try {
        await endpoint.setSettings(settings);
        console.log('✅ Settings saved successfully');
        
        // Update status
        if (statusEl) {
          statusEl.textContent = 'Saved successfully';
          statusEl.style.color = '#00ff7f';
          setTimeout(() => {
            this.closeSettings();
          }, 1000);
        }
      } catch (tomlError) {
        console.warn('⚠️  TOML save failed, trying regular settings:', tomlError.message);
        await endpoint.setSettings(settings);
        console.log('✅ Settings saved to JSON');
        
        if (statusEl) {
          statusEl.textContent = 'Saved successfully';
          statusEl.style.color = '#00ff7f';
          setTimeout(() => {
            this.closeSettings();
          }, 1000);
        }
      }
    } catch (error) {
      console.error('❌ Failed to save settings:', error);
      const statusEl = document.getElementById('settings-status');
      if (statusEl) {
        statusEl.textContent = 'Save failed';
        statusEl.style.color = '#ff6b6b';
        setTimeout(() => {
          statusEl.textContent = '';
          statusEl.style.color = '';
        }, 3000);
      }
    }
  }
  
  /**
   * Collect settings from form
   */
  collectSettingsFromForm() {
    const settings = {};
    
    // LLM Settings
    const providerEl = document.getElementById('llm-provider');
    const apiBaseEl = document.getElementById('llm-api-base');
    const modelEl = document.getElementById('llm-model');
    
    if (providerEl || apiBaseEl || modelEl) {
      settings.llm = {};
      
      if (providerEl && providerEl.value) {
        settings.llm.provider = providerEl.value;
      }
      if (apiBaseEl && apiBaseEl.value) {
        settings.llm.api_base = apiBaseEl.value;
      }
      if (modelEl && modelEl.value) {
        settings.llm.model = modelEl.value;
      }
    }
    
    // Profile Settings
    const profileEl = document.getElementById('oi-profile');
    if (profileEl && profileEl.value) {
      if (!settings.interpreter) {
        settings.interpreter = {};
      }
      settings.interpreter.profile = profileEl.value;
    }
    
    return settings;
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
    
    // Cleanup visualizer
    if (this.visualizer && typeof this.visualizer.destroy === 'function') {
      this.visualizer.destroy();
      this.visualizer = null;
    }
    
    // Cleanup audio manager
    if (this.audioManager && typeof this.audioManager.dispose === 'function') {
      this.audioManager.dispose();
      this.audioManager = null;
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
