'use strict';

/**
 * @.architecture
 * 
 * Incoming: IPC 'artifacts:stream', 'artifacts:load-code', 'artifacts:load-output', 'artifacts:switch-tab' (from artifacts-preload.js) --- {artifact_types.code | artifact_types.output | artifact_types.html, json}
 * Processing: Coordinate 6 modules (ArtifactsWindow, TabManager, CodeViewer, OutputViewer, SafeCodeExecutor, FileManager), route artifacts to viewers by type, execute code in sandbox, manage tab state, track artifacts in-memory Map, emit lifecycle events, dispose resources --- {9 jobs: JOB_CLEAR_STATE, JOB_DELEGATE_TO_MODULE, JOB_DISPOSE, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_INITIALIZE, JOB_ROUTE_BY_TYPE, JOB_TRACK_ENTITY, JOB_UPDATE_STATE}
 * Outgoing: TabManager.setActiveTab(), CodeViewer.loadCode(), OutputViewer.loadOutput() (module delegation) --- {method_calls, javascript_api}
 * 
 * 
 * @module renderer/artifacts/controllers/ArtifactsController
 */

const Endpoint = require('../../../core/communication/Endpoint');
const { EventTypes, EventPriority } = require('../../../core/events/EventTypes');
const { freeze } = Object;

class ArtifactsController {
  constructor(options = {}) {
    if (!options.container) {
      throw new Error('[ArtifactsController] DI container required');
    }

    if (!options.eventBus) {
      throw new Error('[ArtifactsController] EventBus required');
    }

    if (!options.config) {
      throw new Error('[ArtifactsController] Config required');
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
    this.currentTab = 'output'; // 'code' or 'output'
    this.currentChatId = null;
    this.currentArtifact = null;
    this.hasContent = false;
    this.artifacts = new Map(); // artifactId -> artifact data
    
    // IPC listeners for cleanup
    this._ipcListeners = [];
    this._eventListeners = [];
    
    // Log throttling - prevent per-chunk console spam
    this._logThrottle = new Map(); // artifactId -> { lastLog, chunkCount }

    // Bind methods
    this._handleStream = this._handleStream.bind(this);
    this._handleLoadCode = this._handleLoadCode.bind(this);
    this._handleLoadOutput = this._handleLoadOutput.bind(this);
    this._handleSwitchTab = this._handleSwitchTab.bind(this);
    this._handleSwitchChat = this._handleSwitchChat.bind(this);
    this._handleFocus = this._handleFocus.bind(this);
    this._handleEnsureVisible = this._handleEnsureVisible.bind(this);
    this._handleSetMode = this._handleSetMode.bind(this);
  }

  /**
   * Initialize artifacts controller
   */
  async init() {
    console.log('🎯 ArtifactsController: Initializing...');

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

      this.initialized = true;

      console.log('✅ ArtifactsController: Initialization complete');
      this.eventBus.emit(EventTypes.SYSTEM.READY, { 
        controller: 'ArtifactsController',
        timestamp: Date.now()
      }, { priority: EventPriority.HIGH });

    } catch (error) {
      console.error('❌ ArtifactsController: Initialization failed:', error);
      this.eventBus.emit(EventTypes.SYSTEM.ERROR, { 
        error,
        phase: 'initialization',
        fatal: true,
        controller: 'ArtifactsController'
      });
      throw error;
    }
  }

  /**
   * Dispose controller and cleanup resources
   */
  dispose() {
    console.log('🛑 ArtifactsController: Disposing...');

    // Dispose modules in reverse order
    const moduleNames = Object.keys(this.modules).reverse();
    for (const name of moduleNames) {
      try {
        if (this.modules[name] && typeof this.modules[name].dispose === 'function') {
          this.modules[name].dispose();
        }
      } catch (error) {
        console.error(`[ArtifactsController] Failed to dispose ${name}:`, error);
      }
    }

    // Remove IPC listeners
    for (const cleanup of this._ipcListeners) {
      try {
        cleanup();
      } catch (error) {
        console.error('[ArtifactsController] Failed to cleanup IPC listener:', error);
      }
    }

    // Remove event listeners
    for (const cleanup of this._eventListeners) {
      try {
        cleanup();
      } catch (error) {
        console.error('[ArtifactsController] Failed to cleanup event listener:', error);
      }
    }

    // Clear artifacts
    this.artifacts.clear();

    console.log('✅ ArtifactsController: Disposed');
  }

  /**
   * Switch to a tab
   * @param {string} tab - Tab name ('code', 'output', or 'files')
   */
  switchTab(tab) {
    if (tab !== 'code' && tab !== 'output' && tab !== 'files') {
      throw new Error(`[ArtifactsController] Invalid tab: ${tab}`);
    }

    this.currentTab = tab;
    this.eventBus.emit(EventTypes.ARTIFACTS.TAB_CHANGED, { tab });

    // Update UI with TabManager
    if (this.modules.tabManager) {
      this.modules.tabManager.setActiveTab(tab);
    }

    console.log(`[ArtifactsController] Switched to tab: ${tab}`);
  }

  /**
   * Load artifact into viewer
   * @param {Object} artifact - Artifact data
   */
  loadArtifact(artifact) {
    if (!artifact || !artifact.id) {
      throw new Error('[ArtifactsController] Invalid artifact');
    }

    // Store artifact
    this.artifacts.set(artifact.id, artifact);
    this.currentArtifact = artifact;
    this.hasContent = true;

    console.log('[ArtifactsController] Loading artifact:', {
      id: artifact.id,
      type: artifact.type,
      format: artifact.format,
      contentLen: artifact.content ? artifact.content.length : 0
    });

    // Determine which view to use based on artifact type/format
    // Code artifacts: Python, JavaScript, etc. from assistant
    // Output artifacts: HTML, console output, execution results
    const isCodeArtifact = artifact.type === 'code' && artifact.format !== 'html';
    
    if (isCodeArtifact) {
      console.log('[ArtifactsController] Routing to CODE viewer');
      this.switchTab('code');
      // Load into code viewer
      if (this.modules.codeViewer) {
        this.modules.codeViewer.loadCode(
          artifact.content, 
          artifact.language || artifact.format || 'text', 
          artifact.filename || 'untitled'
        );
      }
    } else {
      console.log('[ArtifactsController] Routing to OUTPUT viewer');
      this.switchTab('output');
      // Load into output viewer
      if (this.modules.outputViewer) {
        const format = artifact.format || 'text';
        console.log('[ArtifactsController] Calling outputViewer.loadOutput:', format);
        this.modules.outputViewer.loadOutput(artifact.content, format);
      }
    }

    // Report state to main process
    this._reportWindowState();

    this.eventBus.emit(EventTypes.ARTIFACTS.LOADED, { artifact });
    console.log(`[ArtifactsController] ✅ Artifact loaded: ${artifact.id}`);
  }

  /**
   * Execute code
   * @param {string} code - Code to execute
   * @param {string} language - Programming language
   * @returns {Promise<Object>} Execution result
   */
  async executeCode(code, language) {
    if (!code) {
      throw new Error('[ArtifactsController] No code to execute');
    }

    this.eventBus.emit(EventTypes.ARTIFACTS.EXECUTION_STARTED, { language });

    try {
      // Only JavaScript is supported currently
      if (language !== 'javascript' && language !== 'js') {
        throw new Error(`Unsupported language: ${language}. Only JavaScript is supported.`);
      }

      // Execute with SafeCodeExecutor
      const result = await this.modules.codeExecutor.executeJavaScript(code);

      this.eventBus.emit(EventTypes.ARTIFACTS.EXECUTION_COMPLETE, { result });
      return result;

    } catch (error) {
      console.error('[ArtifactsController] Execution failed:', error);
      this.eventBus.emit(EventTypes.ARTIFACTS.EXECUTION_ERROR, { error });
      throw error;
    }
  }

  /**
   * Export file
   * @param {string} content - File content
   * @param {string} filename - File name
   * @param {string} extension - File extension
   */
  async exportFile(content, filename, extension) {
    try {
      this.eventBus.emit(EventTypes.ARTIFACTS.FILE_EXPORT_STARTED, { filename, extension });

      // Use IPC to export file
      if (window.aether && window.aether.artifacts && window.aether.artifacts.exportFile) {
        await window.aether.artifacts.exportFile(content, filename, extension);
      }

      this.eventBus.emit(EventTypes.ARTIFACTS.FILE_EXPORTED, { filename, extension });
      console.log(`[ArtifactsController] Exported file: ${filename}.${extension}`);

    } catch (error) {
      console.error('[ArtifactsController] Export failed:', error);
      this.eventBus.emit(EventTypes.ARTIFACTS.FILE_EXPORT_ERROR, { error, filename });
      throw error;
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
      currentTab: this.currentTab,
      currentChatId: this.currentChatId,
      hasContent: this.hasContent,
      artifactCount: this.artifacts.size,
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
    console.log('📦 ArtifactsController: Initializing core...');

    // Get or create Endpoint singleton (may already exist from main/chat window)
    let endpoint = this.container.resolve('endpoint');
    
    if (!endpoint) {
      endpoint = new Endpoint({
        API_BASE_URL: this.config.API_BASE_URL,
        WS_URL: this.config.WS_URL,
        NODE_ENV: this.config.NODE_ENV
      });

      this.container.register('endpoint', () => endpoint, { singleton: true });
    }

    // Store in modules
    this.modules.endpoint = endpoint;

    // Make globally available (for debugging and legacy compatibility)
    window.endpoint = endpoint;

    console.log('✅ ArtifactsController: Core initialized');
  }

  /**
   * Register services in DI container
   * @private
   */
  async _registerServices() {
    console.log('📦 ArtifactsController: Registering services...');

    // Services are already registered by artifacts renderer bootstrap
    // Additional services can be registered here if needed

    console.log('✅ ArtifactsController: Services registered');
  }

  /**
   * Initialize modules in dependency order
   * @private
   */
  async _initializeModules() {
    console.log('📦 ArtifactsController: Initializing modules...');

    // Import modules
    const ArtifactsWindow = require('../modules/window/ArtifactsWindow');
    const TabManager = require('../modules/tabs/TabManager');
    const CodeViewer = require('../modules/code/CodeViewer');
    const OutputViewer = require('../modules/output/OutputViewer');
    const SafeCodeExecutor = require('../modules/execution/SafeCodeExecutor');
    const FileManager = require('../modules/files/FileManager');

    // 1. ArtifactsWindow (window management)
    this.modules.artifactsWindow = new ArtifactsWindow({
      controller: this,
      eventBus: this.eventBus,
    });
    await this.modules.artifactsWindow.init();

    // 2. TabManager (tab switching)
    this.modules.tabManager = new TabManager({
      artifactsWindow: this.modules.artifactsWindow,
      eventBus: this.eventBus,
    });
    await this.modules.tabManager.init();

    // Get panes from tab manager
    const codePaneEl = this.modules.tabManager.getPane('code');
    const outputPaneEl = this.modules.tabManager.getPane('output');
    const filesPaneEl = this.modules.tabManager.getPane('files');

    // 3. CodeViewer (code display)
    this.modules.codeViewer = new CodeViewer({
      controller: this,
      eventBus: this.eventBus,
    });
    await this.modules.codeViewer.init(codePaneEl);

    // 4. OutputViewer (output rendering)
    this.modules.outputViewer = new OutputViewer({
      controller: this,
      eventBus: this.eventBus,
    });
    await this.modules.outputViewer.init(outputPaneEl);

    // 5. SafeCodeExecutor (code execution)
    this.modules.codeExecutor = new SafeCodeExecutor({
      timeout: 5000,
    });

    // 6. FileManager (file operations)
    this.modules.fileManager = new FileManager({
      controller: this,
      eventBus: this.eventBus,
    });
    await this.modules.fileManager.init(filesPaneEl);

    console.log('✅ ArtifactsController: Modules initialized');
  }

  /**
   * Setup event listeners
   * @private
   */
  async _setupEventListeners() {
    console.log('📦 ArtifactsController: Setting up event listeners...');

    // Backend events will be added here

    console.log('✅ ArtifactsController: Event listeners setup');
  }

  /**
   * Setup IPC listeners
   * @private
   */
  async _setupIpcListeners() {
    console.log('📦 ArtifactsController: Setting up IPC listeners...');

    // Listen for artifact stream
    const cleanupStream = window.aether.artifacts.onStream((data) => {
      this._handleStream(data);
    });
    this._ipcListeners.push(cleanupStream);

    // Listen for load code
    const cleanupLoadCode = window.aether.artifacts.onLoadCode((code, language, filename) => {
      this._handleLoadCode(code, language, filename);
    });
    this._ipcListeners.push(cleanupLoadCode);

    // Listen for load output
    const cleanupLoadOutput = window.aether.artifacts.onLoadOutput((data) => {
      this._handleLoadOutput(data);
    });
    this._ipcListeners.push(cleanupLoadOutput);

    // Listen for switch tab
    const cleanupSwitchTab = window.aether.artifacts.onSwitchTab((tab) => {
      this._handleSwitchTab(tab);
    });
    this._ipcListeners.push(cleanupSwitchTab);

    // Listen for switch chat
    const cleanupSwitchChat = window.aether.artifacts.onSwitchChat((chatId) => {
      this._handleSwitchChat(chatId);
    });
    this._ipcListeners.push(cleanupSwitchChat);

    // Listen for focus
    const cleanupFocus = window.aether.artifacts.onFocus(() => {
      this._handleFocus();
    });
    this._ipcListeners.push(cleanupFocus);

    // Listen for ensure visible
    const cleanupEnsureVisible = window.aether.artifacts.onEnsureVisible(() => {
      this._handleEnsureVisible();
    });
    this._ipcListeners.push(cleanupEnsureVisible);

    // Listen for set mode
    const cleanupSetMode = window.aether.artifacts.onSetMode((mode) => {
      this._handleSetMode(mode);
    });
    this._ipcListeners.push(cleanupSetMode);

    console.log('✅ ArtifactsController: IPC listeners setup');
  }

  /**
   * Initialize global state
   * @private
   */
  async _initializeGlobalState() {
    console.log('📦 ArtifactsController: Initializing global state...');

    // Get backend health
    try {
      const health = await this.modules.endpoint.getHealth();
      console.log('[ArtifactsController] Backend health:', health);
      
      this.backendConnected = true;
      this.eventBus.emit(EventTypes.CONNECTION.BACKEND_ONLINE, { health });

    } catch (error) {
      console.warn('[ArtifactsController] Backend health check failed:', error);
      this.backendConnected = false;
      this.eventBus.emit(EventTypes.CONNECTION.BACKEND_OFFLINE, { error });
    }

    // Make controller globally accessible
    window.artifactsController = this;

    // Setup global log function
    window.logToMain = (...args) => {
      try {
        const message = args.map(a => 
          typeof a === 'object' ? JSON.stringify(a) : String(a)
        ).join(' ');
        
        window.aether.log.send(message);
      } catch (error) {
        console.error('[ArtifactsController] Failed to log to main:', error);
      }
    };

    // Report initial state
    this._reportWindowState();

    console.log('✅ ArtifactsController: Global state initialized');
  }

  /**
   * Report window state to main process
   * @private
   */
  _reportWindowState() {
    try {
      if (window.aether && window.aether.windowControl && window.aether.windowControl.setState) {
        window.aether.windowControl.setState(this.hasContent);
      }
    } catch (error) {
      console.error('[ArtifactsController] Failed to report window state:', error);
    }
  }

  /**
   * Handle artifact stream with throttled logging
   * @private
   */
  _handleStream(data) {
    try {
      const artifactId = data.id || `artifact_${Date.now()}`;
      const throttle = this._logThrottle.get(artifactId) || { lastLog: 0, chunkCount: 0 };
      
      // ALWAYS log START marker
      if (data.start) {
        console.log(`[ArtifactsController] 🚀 Stream started: ${data.type}/${data.format} (ID: ${artifactId.slice(0,8)}...)`);
        throttle.chunkCount = 0;
        throttle.lastLog = Date.now();
        this._logThrottle.set(artifactId, throttle);
      }
      
      this.eventBus.emit(EventTypes.ARTIFACTS.STREAM_RECEIVED, { data });

      // Check if artifact already exists (streaming update)
      let artifact = this.artifacts.get(artifactId);
      
      if (!artifact) {
        // New artifact
        artifact = {
          id: artifactId,
          backend_id: data.backendId || data._backend_id,
          type: data.type || data.kind || 'output',
          content: '',
          language: data.language || data.format || 'text',
          format: data.format || 'text',
          chatId: data.chatId || this.currentChatId,
          messageId: data.messageId,
          parentId: data.parentId,
          timestamp: Date.now(),
          chunkCount: 0
        };
        this.artifacts.set(artifactId, artifact);
      }
      
      // Update content (streaming accumulation)
      if (data.content) {
        artifact.content += data.content;
        artifact.chunkCount++;
        throttle.chunkCount++;
        
        // Throttled progress logging - once per second max
        const now = Date.now();
        if (now - throttle.lastLog > 1000) {
          console.log(`[ArtifactsController] 📝 Streaming: ${artifact.chunkCount} chunks, ${artifact.content.length} chars`);
          throttle.lastLog = now;
        }
      }
      
      // Load artifact on end marker or if it's a complete artifact
      if (data.end || (!data.start && !data.end)) {
        // ALWAYS log END marker
        if (data.end) {
          console.log(`[ArtifactsController] ✅ Stream complete: ${artifact.chunkCount} chunks, ${artifact.content.length} chars`);
          this._logThrottle.delete(artifactId);
        }
        this.loadArtifact(artifact);
      }

    } catch (error) {
      console.error('[ArtifactsController] ❌ Stream error:', error);
    }
  }

  /**
   * Handle load code
   * @private
   */
  _handleLoadCode(code, language, filename) {
    try {
      const artifact = {
        id: `code_${Date.now()}`,
        type: 'code',
        content: code,
        language: language || 'text',
        filename: filename || 'untitled',
        timestamp: Date.now()
      };

      this.loadArtifact(artifact);

    } catch (error) {
      console.error('[ArtifactsController] Handle load code failed:', error);
    }
  }

  /**
   * Handle load output
   * @private
   */
  _handleLoadOutput(data) {
    try {
      const artifact = {
        id: `output_${Date.now()}`,
        type: 'output',
        content: data.content || data,
        format: data.format || 'text',
        timestamp: Date.now()
      };

      this.loadArtifact(artifact);

    } catch (error) {
      console.error('[ArtifactsController] Handle load output failed:', error);
    }
  }

  /**
   * Handle switch tab
   * @private
   */
  _handleSwitchTab(tab) {
    try {
      this.switchTab(tab);
    } catch (error) {
      console.error('[ArtifactsController] Handle switch tab failed:', error);
    }
  }

  /**
   * Handle switch chat
   * @private
   */
  _handleSwitchChat(chatId) {
    try {
      console.log(`[ArtifactsController] Switching to chat: ${chatId}`);
      this.currentChatId = chatId;
      this.eventBus.emit(EventTypes.ARTIFACTS.CHAT_SWITCHED, { chatId });

      // Filter artifacts for this chat when implemented
      // if (this.modules.fileManager) {
      //   this.modules.fileManager.filterByChat(chatId);
      // }

    } catch (error) {
      console.error('[ArtifactsController] Handle switch chat failed:', error);
    }
  }

  /**
   * Handle focus
   * @private
   */
  _handleFocus() {
    try {
      this.eventBus.emit(EventTypes.UI.WINDOW_FOCUSED, { window: 'artifacts' });
      console.log('[ArtifactsController] Focus received');
    } catch (error) {
      console.error('[ArtifactsController] Handle focus failed:', error);
    }
  }

  /**
   * Handle ensure visible
   * @private
   */
  _handleEnsureVisible() {
    try {
      this.eventBus.emit(EventTypes.UI.WINDOW_VISIBILITY_REQUESTED, { window: 'artifacts' });
      console.log('[ArtifactsController] Ensure visible');
    } catch (error) {
      console.error('[ArtifactsController] Handle ensure visible failed:', error);
    }
  }

  /**
   * Handle set mode
   * @private
   */
  _handleSetMode(mode) {
    try {
      console.log(`[ArtifactsController] Mode set: ${mode}`);
      this.eventBus.emit(EventTypes.ARTIFACTS.MODE_CHANGED, { mode });
    } catch (error) {
      console.error('[ArtifactsController] Handle set mode failed:', error);
    }
  }
}

// Export
module.exports = ArtifactsController;

if (typeof window !== 'undefined') {
  window.ArtifactsController = ArtifactsController;
  console.log('📦 ArtifactsController loaded');
}

