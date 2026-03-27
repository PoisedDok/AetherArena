/**
 * @.architecture
 *
 * Incoming: DI container (config, endpoint, eventBus), preload IPC bridge --- {Dict, javascript_api}
 * Processing: Initialize main window subsystems (visualizer, mic manager, settings UI), manage telemetry + IPC handlers --- {5 jobs: JOB_INITIALIZE, JOB_DELEGATE_TO_MODULE, JOB_UPDATE_STATE, JOB_EMIT_EVENT, JOB_ROUTE_BY_TYPE}
 * Outgoing: DOM updates, IPC calls to preload bridge, eventBus emissions --- {dom.main_window, HTMLElement}
 */

'use strict';

const THREE = require('three');

const NeuralNetworkVisualizer = require('../modules/visualizer/Visualizer');
const Endpoint = require('../../../core/communication/Endpoint');
const SettingsManager = require('../../../application/main/modules/settings/SettingsManager');
const UIManager = require('../../../application/main/UIManager');
const { AudioServices } = require('../../../application/audio/AudioServices');
const { getAether } = require('../../shared/bridge/AetherBridge');
const { EventTypes } = require('../../../core/events/EventTypes');
const ChatLibraryModal = require('../modules/chat-library/ChatLibraryModal');
const ArtifactsLibraryModal = require('../modules/artifacts-library/ArtifactsLibraryModal');
const MCPManagementModal = require('../modules/mcp-management/MCPManagementModal');
const MemoryBrowserModal = require('../modules/memory-browser/MemoryBrowserModal');
const AgentsModal = require('../modules/agents/AgentsModal');
const JobHistoryModal = require('../modules/jobs/JobHistoryModal');
const FileIndexingManager = require('../modules/settings/FileIndexingManager');
const BrowserHistoryManager = require('../modules/settings/BrowserHistoryManager');
const OnboardingModal = require('../modules/onboarding/OnboardingModal');
const ShutdownOrchestrator = require('../modules/shutdown/ShutdownOrchestrator');
const Toast = require('../../shared/components/Toast');
const { createRendererLogger } = require('../../shared/utils/logger');
const GuruConnectionBridge = require('./coordinators/GuruConnectionBridge');
const HandsfreeUIController = require('./coordinators/HandsfreeUIController');
const ControlPanelController = require('./coordinators/ControlPanelController');
const MenuBadgeController = require('./coordinators/MenuBadgeController');
const TelemetryController = require('./coordinators/TelemetryController');
const EventBusBridge = require('./coordinators/EventBusBridge');
const SettingsTabController = require('./coordinators/SettingsTabController');
const PanelDock = require('../modules/panel-dock/PanelDock');
const BaseModal = require('../../shared/modals/BaseModal');


class MainApp {
  constructor(options = {}) {
    this.log = createRendererLogger('MainApp');
    this.isWidgetMode = false;
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.initialX = 0;
    this.initialY = 0;

    this._isDisposed = false;
    this._chatRevealSignalled = false;
    this._welcomeCompleteSignalled = false;
    this.elements = {};
    this.cleanupFunctions = [];

    this.visualizer = null;
    this.guru = null;
    this.endpoint = options.endpoint || null;
    this.settingsManagerFactory = options.settingsManagerFactory || SettingsManager;
    this.settingsManager = options.settingsManager || null;
    this.audioServices = options.audioServices || new AudioServices();
    this.aether = options.aether || getAether();

    // Coordinators (lazy-initialized during boot sequence)
    this._guruBridge = null;
    this._handsfreeUI = null;
    this._controlPanel = null;
    this._settingsTab = null;
    this._menuBadges = null;
    this._telemetry = null;
    this._eventBusBridge = null;

    this.config = options.config || {};
    this.eventBus = options.eventBus || null;
    this.ipc = options.ipc || (this.aether ? this.aether.ipc : null);
    this.uiManager = null;
    
    // Panel Dock (hover-reveal minimized window indicators)
    this.panelDock = null;
    
    // Modals
    this.chatLibraryModal = null;
    this.artifactsLibraryModal = null;
    this.mcpManagementModal = null;
    this.memoryBrowserModal = null;
    this.agentsModal = null;
    this.jobHistoryModal = null;
    this.onboardingModal = null;
  }

  async initialize() {
    this.log.debug('Initializing main application...');

    try {
      // ================================================================
      // PHASE A: UI-only initialization (NO API calls)
      // These operations are safe without a running backend.
      // ================================================================
      this.cacheElements();
      this.initializeDependencies();
      this.initializeVisualizer();
      
      // Initialize modals EARLY (DOM construction only, no API)
      this.initializeModals();

      // ================================================================
      // PHASE B: Onboarding gate
      // Check if onboarding is needed BEFORE any API-dependent work.
      // On first run, the backend isn't ready yet. The OnboardingModal
      // handles the "Prerequisites" step (Docker check, backend health
      // polling) with proper visual feedback.
      // If onboarding is needed, we WAIT here until it completes.
      // ================================================================
      await this._runOnboardingGate();
      if (this._isDisposed) return;

      // ================================================================
      // PHASE B.5: Connect WebSocket NOW that backend is ready
      // WebSocket was deferred during Phase A to avoid error spam
      // while the backend cold-starts (30-60 seconds).
      // ================================================================
      if (this.guru && typeof this.guru.connect === 'function') {
        this.log.debug('[MainApp] Onboarding gate passed, connecting WebSocket...');
        this.guru.connect();
        
        // Wait for WebSocket to establish before proceeding to Phase C
        // No magic timeouts - wait for actual health/connect event
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            this.log.warn('[MainApp] WebSocket connect timed out after 5000ms');
            resolve(); // Proceed anyway, fallback logic exists
          }, 5000);
          
          if (this.guru.ws && this.guru.ws.readyState === 1) {
            clearTimeout(timeout);
            resolve();
            return;
          }
          
          const onConnect = () => {
            clearTimeout(timeout);
            if (typeof this.guru.off === 'function') {
              this.guru.off('connect', onConnect);
            }
            resolve();
          };
          if (typeof this.guru.on === 'function') {
            this.guru.on('connect', onConnect);
          } else {
            clearTimeout(timeout);
            resolve();
          }
        });
      }

      // ================================================================
      // PHASE C: API-dependent initialization (backend is now ready)
      // ================================================================
      await this._loadUiSettings();
      if (this._isDisposed) return;
      
      // Initialize UIManager (Brain)
      await this.initializeUIManager();
      if (this._isDisposed) return;
      
      this.setupControls();
      this._initSettingsTabController();
      this.setupEventListeners();

      // Delegate EventBus-to-UI bridging to EventBusBridge coordinator
      this._eventBusBridge = new EventBusBridge({
        eventBus: this.eventBus,
        elements: {
          settingsStatus: this.elements.settingsStatus,
          connectionStatus: this.elements.connectionStatus,
        },
        aether: this.aether,
        endpoint: this.endpoint,
        guru: this.guru,
        callbacks: {
          openSettings: () => this.openSettings(),
          closeSettings: () => this.closeSettings(),
          switchSettingsTab: (tab) => this.switchSettingsTab(tab),
        },
      });
      this._eventBusBridge.bind();

      this.setupIPCListeners();

      // Initialize Panel Dock (hover-reveal minimized window indicators)
      // Must be after setupIPCListeners so widget mode is wired, and after
      // cacheElements so DOM is ready. Async: queries initial visibility state.
      this.panelDock = new PanelDock();
      await this.panelDock.initialize(this.aether);
      if (this._isDisposed) return;

      this.startTelemetryUpdates();
      this.initializeUI();
      await this.initializeMenuBadges();
      if (this._isDisposed) return;
      
      // Delegate all handsfree/audio UI to HandsfreeUIController
      this._handsfreeUI = new HandsfreeUIController({
        audioServices: this.audioServices,
        eventBus: this.eventBus,
        endpoint: this.endpoint,
        config: this.config,
        micToggle: this.elements.micToggle,
        micWaveform: this.elements.micWaveform,
      });
      await this._handsfreeUI.initialize();
      if (this._isDisposed) return;
      // Expose references for cross-module access
      this.audioManager = this._handsfreeUI.audioManager;
      this.handsfreeCoordinator = this._handsfreeUI.handsfreeCoordinator;
      this.handsfreeConversationDisplay = this._handsfreeUI.handsfreeConversationDisplay;

      // EXPOSE GLOBALLY for cross-module access
      window.MainApp = this;

      // Startup welcome: deferred 1.5 seconds so the visualizer has settled
      // and the orb animation is visible before the text appears below it.
      this._welcomeStartupTimerId = setTimeout(() => {
        this._welcomeStartupTimerId = null;
        if (!this._isDisposed) this._triggerWelcome();
      }, 1500);

      this.log.debug('Main application initialized');
    } catch (error) {
      this.log.error('Initialization failed:', error);
      this.showError('Failed to initialize application: ' + error.message);
    }
  }

  async initializeUIManager() {
    try {
      if (!this.endpoint || !this.guru || !this.eventBus) {
        this.log.warn('Dependencies not ready for UIManager');
        return;
      }

      this.uiManager = new UIManager({
        endpoint: this.endpoint,
        guruConnection: this.guru,
        eventBus: this.eventBus,
        ipc: this.ipc,
        enableLogging: this.config.NODE_ENV === 'development'
      });

      await this.uiManager.init();
      if (this._isDisposed) return;
      this.log.debug('UIManager (Brain) initialized and linked');
    } catch (error) {
      this.log.error('Failed to initialize UIManager:', error);
      // Don't crash MainApp if UIManager fails, but warn loudly
    }
  }

  initializeModals() {
    try {
      if (!this.endpoint) {
        this.log.warn('Endpoint not ready for modals');
        return;
      }

      // Create modals container directly in renderer process (no contextBridge crossing)
      // This avoids "object could not be cloned" errors from structured clone algorithm
      if (!this.aetherModals) {
        this.aetherModals = {
          _modals: {},
          set(key, value) { this._modals[key] = value; },
          get(key) { return this._modals[key]; },
          has(key) { return key in this._modals; },
          getAll() { return { ...this._modals }; }
        };
      }

      // Initialize Chat Library Modal (constructor creates DOM)
      this.chatLibraryModal = new ChatLibraryModal({
        endpoint: this.endpoint,
        chatWindow: this.aether?.chat,
        eventBus: this.eventBus
      });

      // Initialize Artifacts Library Modal (constructor creates DOM)
      this.artifactsLibraryModal = new ArtifactsLibraryModal({
        endpoint: this.endpoint,
        artifactsWindow: this.aether?.artifacts,
        eventBus: this.eventBus
      });

      // Initialize MCP Management Modal (constructor creates DOM)
      this.mcpManagementModal = new MCPManagementModal({
        endpoint: this.endpoint,
        eventBus: this.eventBus
      });

      // Initialize Memory Browser Modal (Phase 9E, ticket #182)
      this.memoryBrowserModal = new MemoryBrowserModal({
        eventBus: this.eventBus,
        onConfigureAgent: () => {
          if (this.agentsModal) {
            this.agentsModal.show();
          }
        }
      });

      // Initialize Agents Modal (system agent configuration)
      this.agentsModal = new AgentsModal({
        endpoint: this.endpoint,
        eventBus: this.eventBus,
        aetherModals: this.aetherModals,
        onOpenMemoryBrowser: () => {
          if (this.memoryBrowserModal) this.memoryBrowserModal.open();
        }
      });

      // Initialize Job History Modal (agent jobs list)
      this.jobHistoryModal = new JobHistoryModal({
        endpoint: this.endpoint,
        eventBus: this.eventBus,
        aetherModals: this.aetherModals
      });

      // Initialize Onboarding Modal
      this.onboardingModal = new OnboardingModal({
        endpoint: this.endpoint,
        eventBus: this.eventBus
      });

      // Store modal instances (no cloning needed - same process)
      this.aetherModals.set('chatLibrary', this.chatLibraryModal);
      this.aetherModals.set('artifactsLibrary', this.artifactsLibraryModal);
      this.aetherModals.set('mcpManagement', this.mcpManagementModal);
      this.aetherModals.set('memoryBrowser', this.memoryBrowserModal);
      this.aetherModals.set('agentsModal', this.agentsModal);
      this.aetherModals.set('jobHistory', this.jobHistoryModal);


      this.log.debug('Modals initialized');
    } catch (error) {
      this.log.error('Failed to initialize modals:', error);
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
      micWaveform: document.getElementById('mic-waveform'),
      chatToggle: document.getElementById('chat-toggle'),
      settingsButton: document.getElementById('settings-button'),
      artifactsToggle: document.getElementById('code-panel-toggle'),
      mcpToggle: document.getElementById('mcp-toggle'),
      memoryToggle: document.getElementById('memory-toggle'),
      agentsToggle: document.getElementById('agents-toggle'),
      researchDashboardToggle: document.getElementById('research-dashboard-toggle'),
      indexBrowserToggle: document.getElementById('index-browser-toggle'),
      jobsToggle: document.getElementById('jobs-toggle'),
      appRestart: document.getElementById('app-restart'),
      appQuit: document.getElementById('app-quit'),
      indexBadge: document.getElementById('index-badge'),
      jobsBadge: document.getElementById('jobs-badge'),
      cpuUsage: document.getElementById('cpu-usage'),
      memoryUsage: document.getElementById('memory-usage'),
      fpsCounter: document.getElementById('fps-counter'),
      /* mic-percentage and mic-level-fill removed — audio stat was redundant */
      systemStatus: document.getElementById('system-status'),
      systemTime: document.getElementById('system-time'),
      modelStatusDot: document.getElementById('model-status-dot'),
      modelName: document.getElementById('model-name'),
      settingsModal: document.getElementById('settings-modal'),
      settingsSave: document.getElementById('settings-save'),
      settingsCancel: document.getElementById('settings-cancel'),
      settingsStatus: document.getElementById('settings-status'),
      connectionStatus: document.getElementById('connection-status'),
      interactionLayer: document.getElementById('widget-interaction-layer'),
    };

    if (!this.elements.root) {
      throw new Error('Root element not found');
    }
  }

  initializeDependencies() {
    if (!this.endpoint) {
      const baseUrl = this.config.API_BASE_URL;
      const wsUrl = this.config.WS_URL || (baseUrl ? baseUrl.replace(/^http/, 'ws') : null);

      if (!baseUrl || !wsUrl) {
        throw new Error('[MainApp] Missing renderer configuration for endpoint initialization');
      }

      this.endpoint = new Endpoint({
        NODE_ENV: this.config.NODE_ENV || 'production',
        API_BASE_URL: baseUrl,
        WS_URL: wsUrl,
        // CRITICAL: Defer WebSocket connection until AFTER backend is ready.
        // During Phase A init, the backend may not be listening yet (takes 30-60s).
        // Without deferral, GuruConnection spams reconnect errors for the entire
        // startup duration, polluting logs and confusing users.
        // connect() is called explicitly after _runOnboardingGate() resolves.
        deferConnect: true,
      });
    }

    this.guru = this.endpoint.connection;
    if (this.guru) {
      const initialState = {
        assistant: 'waiting',
        audioLevel: 0,
      };
      this.guru.state = {
        ...(this.guru.state || {}),
        ...initialState,
      };

      // Delegate all WebSocket/guru concerns to GuruConnectionBridge
      this._guruBridge = new GuruConnectionBridge({
        guru: this.guru,
        endpoint: this.endpoint,
        eventBus: this.eventBus,
        ipc: this.ipc,
        aether: this.aether,
      });
      this._guruBridge.initialize();
    }

    // Initialize LLM Provider Settings
    if (!this.llmProviderSettings) {
      const LLMProviderSettings = require('../modules/settings/LLMProviderSettings');
      this.llmProviderSettings = new LLMProviderSettings({
        endpoint: this.endpoint
      });
    }

    if (!this.settingsManager && this.settingsManagerFactory) {
      this.settingsManager = new this.settingsManagerFactory({
        endpoint: this.endpoint,
        eventBus: this.eventBus,
        llmProviderSettings: this.llmProviderSettings,
        enableLogging: this.config.NODE_ENV === 'development'
      });
    }

    // Initialize File Indexing Manager
    if (!this.fileIndexingManager) {
      this.fileIndexingManager = new FileIndexingManager({
        endpoint: this.endpoint,
        aether: this.aether,
      });
    }

    // Initialize Proactive Daemon Manager
    if (!this.proactiveDaemonManager) {
      const ProactiveDaemonManager = require('../modules/settings/ProactiveDaemonManager');
      this.proactiveDaemonManager = new ProactiveDaemonManager({
        endpoint: this.endpoint,
        eventBus: this.eventBus,
        aether: this.aether,
      });
    }
    
    // Initialize Browser History Manager
    if (!this.browserHistoryManager) {
      this.browserHistoryManager = new BrowserHistoryManager({
        endpoint: this.endpoint,
        aether: this.aether,
      });
    }

    this.log.debug('Core dependencies initialized (WebSocket:', this.config.WS_URL || 'unknown', ')');
  }

  initializeVisualizer() {
    if (!this.elements.canvas) {
      this.log.warn('Canvas element not found, skipping visualizer');
      return;
    }

    try {
      // Visualizer style mode: read from localStorage cache (instant, synchronous).
      // _applyUiSettings() persists backend's visualizer_mode to localStorage on every
      // settings load/save, so subsequent startups pick it up without waiting for the API.
      // Modes control visual style WITHIN the NeuralNetworkVisualizer:
      //   'cosmos'  — premium orb (IcosahedronGeometry + GLSL shaders, simplex noise, Fresnel, bloom) [default]
      //   'neural'  — techy node+connection mesh
      //   'organic' — tighter sphere, fewer connections, smoother motion
      let mode = 'cosmos';
      try { mode = localStorage.getItem('aether_visualizer_mode') || 'cosmos'; } catch (e) {
      this.log.debug('Failed to get visualizer mode from localStorage', { error: e?.message || String(e) });
    }

      this.visualizer = new NeuralNetworkVisualizer({ mode, eventBus: this.eventBus });
      this.log.debug(`Visualizer initialized (mode: ${mode})`);
    } catch (error) {
      this.log.error('Failed to initialize visualizer:', error);
    }
  }

  setupControls() {
    // Delegate all control panel wiring to ControlPanelController
    this._controlPanel = new ControlPanelController({
      elements: this.elements,
      endpoint: this.endpoint,
      settingsManager: this.settingsManager,
      callbacks: {
        openChatLibrary: () => {
          if (this.chatLibraryModal) this.chatLibraryModal.open();
          else this.aether?.chat?.open();
        },
        openSettings: () => this.openSettings(),
        closeSettings: () => this.closeSettings(),
        switchSettingsTab: (tab) => this.switchSettingsTab(tab),
        openArtifactsLibrary: () => {
          if (this.artifactsLibraryModal) this.artifactsLibraryModal.open();
          else this.aether?.artifacts?.open();
        },
        openMcpManagement: () => { if (this.mcpManagementModal) this.mcpManagementModal.open(); },
        openMemoryBrowser: () => { if (this.memoryBrowserModal) this.memoryBrowserModal.open(); },
        openAgents: () => { if (this.agentsModal) this.agentsModal.show(); },
        openResearchDashboard: () => this.openResearchDashboard(),
        openIndexBrowser: () => this.openIndexBrowser(),
        openJobs: () => { if (this.jobHistoryModal) this.jobHistoryModal.show(); },
        initiateShutdown: (mode) => this._initiateShutdown(mode),
      },
    });
    this._controlPanel.initialize();
  }

  toggleControlPanel() {
    if (this._controlPanel) this._controlPanel.toggle();
  }

  closeControlPanel() {
    if (this._controlPanel) this._controlPanel.close();
  }

  /**
   * Close all active modals managed by the app.
   */
  closeAllModals() {
    BaseModal.closeAll();
  }

  /**
   * Open the Index Browser window, optionally selecting a specific index
   * @param {string} [indexName] - Name of the index to select automatically
   */
  openIndexBrowser(indexName = null) {
    if (!this.aether || !this.aether.ipc) {
      this.log.error('[MainApp] IPC not available');
      return;
    }
    
    // Close control panel if open
    this.closeControlPanel();
    
    // Send IPC to main process to create window and auto-minimize
    this.aether.ipc.send('window:open-index-browser', indexName);
  }

  /**
   * Open the Research Dashboard window
   */
  openResearchDashboard() {
    if (!this.aether || !this.aether.ipc) {
      this.log.error('[MainApp] IPC not available');
      return;
    }
    
    // Close control panel if open
    this.closeControlPanel();
    
    // Send IPC to main process to create window and auto-minimize
    this.aether.ipc.send('window:open-research');
  }

  setupEventListeners() {
    // MEMORY FIX: Ensure _domListeners exists and track all DOM listeners
    if (!this._domListeners) this._domListeners = [];
    
    const addTrackedListener = (element, event, handler, options) => {
      if (!element) return;
      element.addEventListener(event, handler, options);
      this._domListeners.push({ element, event, handler, options });
    };

    if (this.eventBus) {
      const listener = (data) => {
        if (data && data.settings && data.settings.ui) {
          this._applyUiSettings(data.settings.ui);
        }
      };
      
      if (typeof this.eventBus.on === 'function' && typeof EventTypes !== 'undefined' && EventTypes.SETTINGS) {
        const unsubscribe = this.eventBus.on(EventTypes.SETTINGS.LLM_UPDATED, listener);
        if (typeof unsubscribe === 'function') {
          this.cleanupFunctions.push(unsubscribe);
        }
      }
    }
    
    // Handsfree EventBus subscriptions delegated to HandsfreeUIController

    // ── Double-left-click: toggles widget mode (both directions) ──
    // Attached to document to ensure it works even if specific containers
    // are hidden (e.g. in widget mode) or if a modal overlay is present.
    const dblClickHandler = (e) => {
      // Don't toggle if the user is double-clicking an interactive element
      const target = e.target;
      if (target && (
        target.closest('button') ||
        target.closest('input') ||
        target.closest('select') ||
        target.closest('textarea') ||
        target.closest('.se-result') ||
        target.closest('.chat-message')
      )) {
        return;
      }

      e.stopPropagation();
      this.aether?.window?.onDoubleClick();
    };
    addTrackedListener(document, 'dblclick', dblClickHandler);

    // Deactivate the early document-level dblclick handler now that
    // element-specific handlers are wired with stopPropagation.
    if (typeof window !== 'undefined') {
      window.__mainAppDblClickReady = true;
      if (typeof window.__deactivateEarlyDblClick === 'function') {
        window.__deactivateEarlyDblClick();
      }
    }

    // ── Double-right-click: toggle chat window ──
    // Detected via two rapid `contextmenu` events within 400ms.
    // Attached on: interactionLayer (widget), root (normal), canvas (normal orb bg).
    let lastRightClickTime = 0;
    const contextMenuHandler = (e) => {
      e.preventDefault(); // suppress native context menu always
      const now = Date.now();
      if (now - lastRightClickTime < 400) {
        // Double right-click detected → toggle chat
        this.aether?.window?.toggleChat();
        lastRightClickTime = 0; // reset to prevent triple-fire
      } else {
        lastRightClickTime = now;
      }
    };
    if (this.elements.root) {
      addTrackedListener(this.elements.root, 'contextmenu', contextMenuHandler);
    }
    if (this.elements.canvas) {
      addTrackedListener(this.elements.canvas, 'contextmenu', contextMenuHandler);
    }
    if (this.elements.interactionLayer) {
      addTrackedListener(this.elements.interactionLayer, 'contextmenu', contextMenuHandler);
    }

    // ── Drag: widget mode window repositioning ──
    // In widget mode the interaction layer is the event surface (canvas is
    // pointer-events:none). Mouse-move/up stay on document for capture safety.
    if (this.elements.interactionLayer) {
      const mousedownHandler = (e) => {
        if (this.isWidgetMode) {
          this.startDrag(e);
        }
      };
      addTrackedListener(this.elements.interactionLayer, 'mousedown', mousedownHandler);
    }

    // Move/up handlers on document (unchanged — must stay global for drag capture)
    {
      const mousemoveHandler = (e) => {
        if (this.isDragging) {
          this.drag(e);
        }
      };
      addTrackedListener(document, 'mousemove', mousemoveHandler);

      const mouseupHandler = () => {
        if (this.isDragging) {
          this.endDrag();
        }
      };
      addTrackedListener(document, 'mouseup', mouseupHandler);
    }

    const wheelHandler = (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        this.aether?.window?.onWheel(e.deltaY, true);
      }
    };
    addTrackedListener(document, 'wheel', wheelHandler, { passive: false });

    const keydownHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.aether?.window?.toggleWidgetMode();
      }

      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        if (this.agentsModal) {
          this.agentsModal.show();
        }
      }

      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        this.openIndexBrowser();
      }

      if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        this.aether?.window?.zoomIn();
      }

      if (e.ctrlKey && e.key === '-') {
        e.preventDefault();
        this.aether?.window?.zoomOut();
      }

      // NOTE: Alt+T (cosmos demo toggle) is registered as an Electron global
      // shortcut in ShortcutManager.js → arrives via IPC 'demo:toggle'.
      // Renderer keydown does NOT work for Alt+key on macOS (Option remaps chars).
    };
    addTrackedListener(document, 'keydown', keydownHandler);
  }

  setupIPCListeners() {
    // Track whether a widget mode IPC has arrived since listener registration.
    // Used by the state sync below to avoid overriding a more-recent IPC state
    // with a stale invoke response (race condition: invoke response can arrive
    // AFTER an exit-widget-mode IPC if the user double-clicked during the flight).
    let widgetModeIPCReceived = false;

    const widgetModeCleanup = this.aether?.window?.onWidgetModeChange((isWidget) => {
      widgetModeIPCReceived = true;
      this.isWidgetMode = isWidget;
      this.updateUI();

      if (isWidget) {
        // Automatically close all open modals when entering widget mode.
        // This prevents broken/truncated modal overlays from obscuring the orb.
        this.closeAllModals();
      }

      if (this.visualizer && typeof this.visualizer.setWidgetMode === 'function') {
        this.visualizer.setWidgetMode(isWidget);
      }

      // Forward widget mode to panel dock for layout adaptation
      if (this.panelDock && typeof this.panelDock.setWidgetMode === 'function') {
        this.panelDock.setWidgetMode(isWidget);
      }
    });

    if (widgetModeCleanup) this.cleanupFunctions.push(widgetModeCleanup);

    // ── Widget mode state sync ──────────────────────────────────────
    // If the window entered widget mode during the startup splash (before
    // the onWidgetModeChange listener above was registered), the renderer
    // missed the enter-widget-mode IPC. Query the authoritative state
    // from the main process and sync if needed. This is a one-shot async
    // query that does not block initialization.
    //
    // RACE GUARD: If any widget mode IPC arrived between sending the query
    // and receiving the response, the IPC-provided state is more recent.
    // The sync result is stale — discard it.
    if (this.aether?.window?.getWidgetMode) {
      this.aether.window.getWidgetMode().then((isWidget) => {
        if (this._isDisposed) return;
        // If an IPC already arrived, its state is authoritative — skip stale sync.
        if (widgetModeIPCReceived) return;
        if (isWidget && !this.isWidgetMode) {
          this.log.debug('[MainApp] Widget mode state sync: main says widget, renderer says normal. Syncing.');
          this.isWidgetMode = true;
          this.updateUI();
          if (this.visualizer && typeof this.visualizer.setWidgetMode === 'function') {
            this.visualizer.setWidgetMode(true);
          }
          if (this.panelDock && typeof this.panelDock.setWidgetMode === 'function') {
            this.panelDock.setWidgetMode(true);
          }
        }
      }).catch((err) => {
        this.log.warn('[MainApp] Widget mode state sync failed (non-fatal):', err?.message || err);
      });
    }

    // NOTE: Assistant stream and request-complete state transitions are handled
    // directly by GuruConnectionBridge from the WebSocket. No IPC round-trip needed.
    // IPC Router sends chat:assistant-stream/chat:request-complete only to the
    // chat window, so main window listeners would never fire anyway.

    // Delegate chat:send and chat:stop IPC to GuruConnectionBridge
    const ipcBridge = this.ipc || this.aether?.ipc;
    if (ipcBridge && typeof ipcBridge.on === 'function') {
      const openAgentsCleanup = ipcBridge.on('window:open-agents', () => {
        if (this.agentsModal) this.agentsModal.show();
      });
      this.cleanupFunctions.push(openAgentsCleanup);

      if (this._guruBridge) {
        const chatSendCleanup = ipcBridge.on('chat:send', (payload) => {
          this._guruBridge.handleChatSend(payload);
        });
        this.cleanupFunctions.push(chatSendCleanup);

        const chatStopCleanup = ipcBridge.on('chat:stop', (payload) => {
          this._guruBridge.handleChatStop(payload);
        });
        this.cleanupFunctions.push(chatStopCleanup);
      }

      // Alt+T arrives as IPC from ShortcutManager (main process global shortcut)
      const demoToggleCleanup = ipcBridge.on('demo:toggle', () => {
        if (this._demoRunning) {
          this._stopDemo();
          this.eventBus?.emit(EventTypes.WELCOME.DISMISS);
        } else {
          this._triggerWelcome();
        }
      });
      this.cleanupFunctions.push(demoToggleCleanup);
    }
  }

  startTelemetryUpdates() {
    // Delegate all telemetry to TelemetryController
    this._telemetry = new TelemetryController({
      aether: this.aether,
      guru: this.guru,
      visualizer: this.visualizer,
      endpoint: this.endpoint,
      elements: this.elements,
    });
    this._telemetry.start();
  }

  updateModelIndicator() {
    if (this._telemetry) this._telemetry.updateModelIndicator();
  }

  setModelStatus(status, modelName) {
    if (this._telemetry) this._telemetry.setModelStatus(status, modelName);
  }

  initializeUI() {
    this.updateUI();
    this.updateModelIndicator();
  }

  async _loadUiSettings() {
    // Bootstrap defaults: must include visualizer_mode so _applyUiSettings can
    // persist to localStorage and hot-swap even when the backend is unreachable.
    const defaults = { effects_mode: 'full', visualizer_mode: 'cosmos' };

    if (!this.endpoint) {
      // Non-fatal: allow renderer to boot and show connection overlay while backend is unavailable.
      this.log.warn('[MainApp] Endpoint not initialized for UI settings; using defaults');
      this._applyUiSettings(defaults);
      return;
    }

    try {
      const settings = await this.endpoint.getSettings();
      if (this._isDisposed) return;
      if (settings && typeof settings === 'object' && settings.ui) {
        this._applyUiSettings(settings.ui);
        return;
      }
      throw new Error('Missing ui settings from backend');
    } catch (error) {
      // Non-fatal: backend may be offline at startup; continue with bootstrap defaults.
      this.log.warn('[MainApp] Failed to load ui settings; using defaults', error?.message || error);
      this._applyUiSettings(defaults);
    }
  }

  _applyUiSettings(ui) {
    if (typeof document === 'undefined') {
      return;
    }
    const effectsMode = ui?.effects_mode === 'reduced' ? 'reduced' : 'full';
    document.documentElement.setAttribute('data-effects', effectsMode);

    if (this.visualizer && typeof this.visualizer.pause === 'function' && typeof this.visualizer.resume === 'function') {
      if (effectsMode === 'reduced') {
        this.visualizer.pause();
      } else {
        this.visualizer.resume();
      }
    }

    // Persist visualizer_mode to localStorage (instant cache for next startup).
    // Also hot-swap the visualizer if the mode changed (no restart required).
    const vizMode = ui?.visualizer_mode;
    if (vizMode) {
        try { localStorage.setItem('aether_visualizer_mode', vizMode); } catch (e) {
          this.log.debug('Failed to save visualizer mode to localStorage', { error: e?.message || String(e) });
        }

      // Hot-swap: destroy old visualizer and recreate with new mode
      if (this.visualizer && this.visualizer.mode !== vizMode) {
        try {
          this.visualizer.destroy();
          this.visualizer = new NeuralNetworkVisualizer({ mode: vizMode });
          // Honour current effects mode on the fresh instance
          if (effectsMode === 'reduced') {
            this.visualizer.pause();
          }
          this.log.debug(`[MainApp] Visualizer hot-swapped to mode: ${vizMode}`);
        } catch (swapErr) {
          this.log.error('[MainApp] Visualizer hot-swap failed:', swapErr);
        }
      }
    }
  }

  /**
   * Launch the cosmos demo: time-aware greeting text + visualizer state showcase.
   * Cycles through AI states so the orb morphs, changes color, and shows off.
   * Purely frontend — no backend dependency. Safe to call when offline.
   */
  _triggerWelcome() {
    if (!this.eventBus) return;

    // Stop any existing demo before starting a new one
    this._stopDemo();

    // --- 1. Text greeting (includes product identity) ---
    const hour = new Date().getHours();
    let timeGreet;
    if (hour >= 5 && hour < 12) {
      timeGreet = 'Good morning';
    } else if (hour >= 12 && hour < 17) {
      timeGreet = 'Good afternoon';
    } else {
      timeGreet = 'Good evening';
    }
    
    let greetingName = '';
    try {
      const userProfile = this.settingsManager?.getSetting('user_profile');
      if (userProfile && (userProfile.name || userProfile.username)) {
        greetingName = `, ${userProfile.name || userProfile.username}`;
      }
    } catch (err) {
      this.log.warn('[MainApp] Could not fetch user profile for greeting', err);
    }
    
    const greeting = `${timeGreet}${greetingName}. Welcome to AetherArena.`;
    this.eventBus.emit(EventTypes.WELCOME.START, { message: greeting });

    // --- 2. Model warmup: fire immediately so the backend has the full
    //     welcome duration (~11s) to warm caches, establish connections,
    //     and pre-load the selected inference model. By the time the user
    //     starts typing, the pipeline is hot. ---
    if (this.aether?.ipc?.send) {
      this.aether.ipc.send('model:warmup', {});
      this.log.debug('[MainApp] Sent model:warmup signal');
    }

    // --- 3. Visual demo: cycle visualizer through showcase states ---
    // Each entry: [state, delayMs from demo start].
    // The visualizer's built-in lerp (~0.04/frame) creates smooth transitions.
    // Compressed to ~11s so the orb cycles efficiently — the remaining states
    // play out in widget mode after the main window minimizes at ~2.5s.
    const demoSequence = [
      ['listening',  1000],   // Blue, compressed — "absorbing"
      ['thinking',   3500],   // Teal, churning, most wavy — "processing"
      ['speaking',   7000],   // Amber, elongated — "responding"
      ['idle',       10000],  // Calm periwinkle — "ready"
    ];

    this._demoTimerIds = [];
    this._demoRunning = true;

    const emitState = (state) => {
      if (!this._demoRunning || this._isDisposed) return;
      this.eventBus.emit(EventTypes.VISUALIZER.STATE_CHANGED, {
        state,
        source: 'demo',
      });
    };

    for (const [state, delay] of demoSequence) {
      const id = setTimeout(() => emitState(state), delay);
      this._demoTimerIds.push(id);
    }

    // --- 4. Early chat reveal: minimize main window + show chat at 2.5s.
    //     ONLY sends IPC — does NOT dismiss the welcome text overlay.
    //     The greeting and orb continue playing; the main window just shrinks
    //     to widget and the chat appears alongside it. ---
    const earlyRevealId = setTimeout(() => {
      this._signalChatReveal();
    }, 2500);
    this._demoTimerIds.push(earlyRevealId);

    // --- 5. End demo after full 11s sequence ---
    //     Now dismiss welcome text + emit COMPLETE. Chat reveal is a no-op
    //     (already sent at 2.5s). Welcome text fades cleanly in widget.
    const endId = setTimeout(() => {
      this._demoRunning = false;
      this._demoTimerIds = null;
      this._signalWelcomeComplete();
    }, 11000);
    this._demoTimerIds.push(endId);
  }

  /**
   * Stop the visual demo cycle. Clears all pending state-change timers
   * and returns the visualizer to idle. If the demo was actively running,
   * signals welcome-complete so the chat window is revealed even on
   * early cancellation (e.g. Alt+T toggle).
   */
  _stopDemo() {
    if (this._demoTimerIds) {
      for (const id of this._demoTimerIds) clearTimeout(id);
      this._demoTimerIds = null;
    }
    const wasRunning = this._demoRunning;
    if (wasRunning && this.eventBus) {
      this.eventBus.emit(EventTypes.VISUALIZER.STATE_CHANGED, {
        state: 'idle',
        source: 'demo-stop',
      });
    }
    this._demoRunning = false;

    // If the demo was actively running, signal completion so
    // main process enters widget mode + reveals chat window.
    if (wasRunning) {
      this._signalWelcomeComplete();
    }
  }

  /**
   * Tell main process to minimize main window + reveal chat window.
   * Does NOT dismiss the welcome text — the greeting and demo orb continue
   * running so the transition is seamless (window shrinks with content intact).
   * Idempotent — guarded by _chatRevealSignalled flag.
   * @private
   */
  _signalChatReveal() {
    if (this._chatRevealSignalled || this._isDisposed) return;
    this._chatRevealSignalled = true;

    if (this.aether?.ipc?.send) {
      this.aether.ipc.send('startup:welcome-complete', {});
      this.log.debug('[MainApp] Sent startup:welcome-complete (chat reveal)');
    }
  }

  /**
   * Dismiss welcome text overlay + emit WELCOME.COMPLETE event.
   * Also ensures chat is revealed (calls _signalChatReveal as safety net).
   * Idempotent — guarded by _welcomeCompleteSignalled flag.
   * @private
   */
  _signalWelcomeComplete() {
    if (this._welcomeCompleteSignalled || this._isDisposed) return;
    this._welcomeCompleteSignalled = true;

    // Ensure chat is revealed (no-op if already sent at 2.5s)
    this._signalChatReveal();

    // Now dismiss welcome text overlay and signal full completion
    if (this.eventBus) {
      this.eventBus.emit(EventTypes.WELCOME.DISMISS);
      this.eventBus.emit(EventTypes.WELCOME.COMPLETE);
    }
  }

  async initializeMenuBadges() {
    this._menuBadges = new MenuBadgeController({
      endpoint: this.endpoint,
      elements: {
        indexBadge: this.elements.indexBadge,
        jobsBadge: this.elements.jobsBadge,
      },
    });
    await this._menuBadges.initialize();
  }

  updateUI() {
    if (this.elements.widgetContainer) {
      const hideWidget = !this.isWidgetMode;
      this.elements.widgetContainer.classList.toggle('is-hidden', hideWidget);
    }

    if (this.elements.normalContainer) {
      const hideNormal = this.isWidgetMode;
      this.elements.normalContainer.classList.toggle('is-hidden', hideNormal);
    }

    document.body.classList.toggle('widget-mode', this.isWidgetMode);
    document.body.classList.toggle('normal-mode', !this.isWidgetMode);
  }

  // ── Settings Tab (delegated to SettingsTabController coordinator) ──

  async openSettings() {
    if (this._settingsTab) return this._settingsTab.open();
  }

  closeSettings() {
    if (this._settingsTab) this._settingsTab.close();
  }

  switchSettingsTab(tabName) {
    if (this._settingsTab) this._settingsTab.switchTab(tabName);
  }

  async saveSettings() {
    if (this._settingsTab) return this._settingsTab.save();
  }

  /** @private Initialize the SettingsTabController coordinator */
  _initSettingsTabController() {
    this._settingsTab = new SettingsTabController({
      settingsModal: this.elements.settingsModal,
      settingsManager: this.settingsManager,
      llmProviderSettings: this.llmProviderSettings,
      fileIndexingManager: this.fileIndexingManager,
      proactiveDaemonManager: this.proactiveDaemonManager,
      browserHistoryManager: this.browserHistoryManager,
      applyUiSettings: (ui) => this._applyUiSettings(ui),
      endpoint: this.endpoint,
    });
  }

  /**
   * Begin JS-based widget drag.
   * Uses screen coordinates (stable as window moves) and sends IPC
   * to main process which snapshots window position and applies deltas.
   */
  startDrag(e) {
    this.isDragging = true;
    document.body.classList.add('cursor-move');
    try {
      this.aether?.window?.dragStart(e.screenX, e.screenY);
    } catch (err) {
      this.log.error('[MainApp] dragStart IPC failed', err);
    }
  }

  drag(e) {
    try {
      this.aether?.window?.dragMove(e.screenX, e.screenY);
    } catch (err) {
      // IPC errors must not crash the event pipeline —
      // an uncaught throw here blocks subsequent mouse events (dblclick).
      this.log.error('[MainApp] dragMove IPC failed', err);
    }
  }

  endDrag() {
    this.isDragging = false;
    document.body.classList.remove('cursor-move');
    try {
      this.aether?.window?.dragEnd();
    } catch (err) {
      this.log.error('[MainApp] dragEnd IPC failed', err);
    }
  }

  showError(message) {
    if (this.elements.root) {
      this.elements.root.innerHTML = '<div class="error-screen"><h2>Error</h2><p class="error-message"></p></div>';
      const msgEl = this.elements.root.querySelector('.error-message');
      if (msgEl) msgEl.textContent = String(message || 'Unknown error');
    }
  }

  cleanup() {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this.log.debug('Cleaning up main application...');

    // Stop demo state cycle (clears all pending state-change timers)
    this._stopDemo();

    // Clear pending welcome startup timer
    if (this._welcomeStartupTimerId) {
      clearTimeout(this._welcomeStartupTimerId);
      this._welcomeStartupTimerId = null;
    }

    // Dispose all coordinators
    if (this._settingsTab) {
      this._settingsTab.dispose();
      this._settingsTab = null;
    }
    if (this._eventBusBridge) {
      this._eventBusBridge.dispose();
      this._eventBusBridge = null;
    }
    if (this._controlPanel) {
      this._controlPanel.dispose();
      this._controlPanel = null;
    }
    if (this.panelDock) {
      this.panelDock.dispose();
      this.panelDock = null;
    }

    // Clean up remaining DOM listeners (setupEventListeners)
    if (this._domListeners && Array.isArray(this._domListeners)) {
      for (const { element, event, handler, options } of this._domListeners) {
        try {
          if (element) element.removeEventListener(event, handler, options);
        } catch (error) {
          this.log.error('[MainApp] Failed to remove DOM listener:', error);
        }
      }
      this._domListeners = [];
    }

    if (this._telemetry) {
      this._telemetry.dispose();
      this._telemetry = null;
    }
    if (this._menuBadges) {
      this._menuBadges.dispose();
      this._menuBadges = null;
    }

    if (this.visualizer && typeof this.visualizer.destroy === 'function') {
      this.visualizer.destroy();
      this.visualizer = null;
    }

    if (this._handsfreeUI) {
      this._handsfreeUI.dispose();
      this._handsfreeUI = null;
    }
    
    if (this.audioManager && typeof this.audioManager.dispose === 'function') {
      this.audioManager.dispose();
    }
    this.audioManager = null;
    
    if (this.handsfreeCoordinator && typeof this.handsfreeCoordinator.dispose === 'function') {
      this.handsfreeCoordinator.dispose();
    }
    this.handsfreeCoordinator = null;
    
    if (this.handsfreeConversationDisplay && typeof this.handsfreeConversationDisplay.dispose === 'function') {
      this.handsfreeConversationDisplay.dispose();
    }
    this.handsfreeConversationDisplay = null;
    
    if (this.audioServices && typeof this.audioServices.dispose === 'function') {
      this.audioServices.dispose();
    }
    this.audioServices = null;

    // Clean up modals
    if (this.chatLibraryModal && typeof this.chatLibraryModal.shutdown === 'function') {
      this.chatLibraryModal.shutdown();
      this.chatLibraryModal = null;
    }
    if (this.artifactsLibraryModal && typeof this.artifactsLibraryModal.shutdown === 'function') {
      this.artifactsLibraryModal.shutdown();
      this.artifactsLibraryModal = null;
    }
    if (this.mcpManagementModal && typeof this.mcpManagementModal.shutdown === 'function') {
      this.mcpManagementModal.shutdown();
      this.mcpManagementModal = null;
    }
    if (this.memoryBrowserModal && typeof this.memoryBrowserModal.shutdown === 'function') {
      this.memoryBrowserModal.shutdown();
      this.memoryBrowserModal = null;
    }
    if (this.agentsModal && typeof this.agentsModal.shutdown === 'function') {
      this.agentsModal.shutdown();
      this.agentsModal = null;
    }
    if (this.indexBrowserModal && typeof this.indexBrowserModal.shutdown === 'function') {
      this.indexBrowserModal.shutdown();
      this.indexBrowserModal = null;
    }
    if (this.jobHistoryModal && typeof this.jobHistoryModal.shutdown === 'function') {
      this.jobHistoryModal.shutdown();
      this.jobHistoryModal = null;
    }
    if (this.onboardingModal && typeof this.onboardingModal.shutdown === 'function') {
      this.onboardingModal.shutdown();
      this.onboardingModal = null;
    }
    
    // Clean up FileIndexingManager
    if (this.fileIndexingManager && typeof this.fileIndexingManager.destroy === 'function') {
      this.fileIndexingManager.destroy();
      this.fileIndexingManager = null;
    }

    // Clean up ProactiveDaemonManager
    if (this.proactiveDaemonManager && typeof this.proactiveDaemonManager.dispose === 'function') {
      this.proactiveDaemonManager.dispose();
      this.proactiveDaemonManager = null;
    }

    // Clean up BrowserHistoryManager
    if (this.browserHistoryManager && typeof this.browserHistoryManager.destroy === 'function') {
      this.browserHistoryManager.destroy();
      this.browserHistoryManager = null;
    }

    // Dispose UIManager (stops ServiceStatusMonitor, ConnectionMonitor polling intervals)
    if (this.uiManager && typeof this.uiManager.dispose === 'function') {
      this.uiManager.dispose();
      this.uiManager = null;
    }

    for (const cleanup of this.cleanupFunctions) {
      try {
        cleanup();
      } catch (error) {
        this.log.error('Cleanup error:', error);
      }
    }

    this.cleanupFunctions = [];

    // Dispose GuruConnectionBridge (removes all guru listeners)
    if (this._guruBridge) {
      this._guruBridge.dispose();
      this._guruBridge = null;
    }
  }


  /**
   * Onboarding gate: blocks initialization until onboarding completes.
   * On first run, the backend isn't ready yet. The OnboardingModal
   * shows the Prerequisites step with Docker/backend health polling.
   * Returns a Promise that resolves when:
   *   - Onboarding is not needed (backend was reachable and preference exists), OR
   *   - Onboarding completed (user finished all steps)
   * @private
   */
  async _runOnboardingGate() {
    if (!this.onboardingModal) return;

    // DEV MODE: Skip onboarding entirely when backend health check is skipped.
    // Without a running backend, OnboardingModal.isNeeded() always returns true
    // (the API call fails → catch returns true), which would block the app forever.
    // Production never sets SKIP_HEALTH_CHECK, so this bypass is dev-only.
    const snapshot = this.aether?.config?.getSnapshot?.() || null;
    if (snapshot?.dev?.skipHealthCheck === true) {
      this.log.debug('[MainApp] Skipping onboarding gate (dev.skipHealthCheck=true)');
      if (this.aether?.ipc?.send) {
        this.aether.ipc.send('startup:animation-complete', {});
      }
      return;
    }

    // Fast check: localStorage (instant, no API required)
    const needed = await OnboardingModal.isNeeded(this.endpoint);
    if (!needed) {
      this.log.debug('[MainApp] Onboarding already complete (localStorage or API confirmed)');
      if (this.aether?.ipc?.send) {
        this.aether.ipc.send('startup:animation-complete', {});
      }
      return;
    }

    // Onboarding IS needed. Show modal and BLOCK until explicit completion signal.
    this.log.debug('[MainApp] Onboarding required. Showing modal and waiting...');

    if (!this.eventBus || typeof this.eventBus.on !== 'function') {
      throw new Error('[MainApp] EventBus unavailable for onboarding gate');
    }

    return new Promise((resolve) => {
      // In premium v2, onboarding ends with a mandatory app restart.
      // Therefore, this promise is designed to hang intentionally.
      // It effectively blocks any further initialization (websocket, etc)
      // until the IPC 'app:relaunch' kills the process.
      this.onboardingModal.show();
      
      // FOR TESTS ONLY: Resolve the promise if EventBus signals completion
      if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') {
        if (typeof EventTypes !== 'undefined' && EventTypes.ONBOARDING) {
          this.eventBus.on(EventTypes.ONBOARDING.FINISHED, resolve);
        } else {
          this.eventBus.on('onboarding:finished', resolve);
        }
      }
    });
  }

  /**
   * @deprecated Use _runOnboardingGate() instead. Kept for backward compatibility.
   */
  async checkOnboarding() {
    // No-op: onboarding is now handled as a gate in initialize()
  }

  // ── Graceful Shutdown / Restart ─────────────────────────────

  /**
   * Initiate graceful shutdown with progress dialog.
   * @param {'quit'|'restart'} mode
   * @private
   */
  _initiateShutdown(mode) {
    if (this._shutdownOrchestrator) return; // Already running

    this._shutdownOrchestrator = new ShutdownOrchestrator({
      endpoint: this.endpoint,
      guruConnection: window.guruConnection || null,
    });

    this._shutdownOrchestrator.execute(mode);
  }

}

module.exports = MainApp;
