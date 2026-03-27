'use strict';

/**
Incoming: ipc.artifacts:stream, storageAPI.saveArtifact responses --- {ipc.chat_stream_event, json}
Processing: Coordinate renderer modules, cache session artifacts, delegate persistence --- {6 jobs: JOB_DELEGATE_TO_MODULE, JOB_EMIT_EVENT, JOB_FILTER_DATA, JOB_ROUTE_BY_TYPE, JOB_SAVE_TO_DB, JOB_UPDATE_STATE}
Outgoing: Artifacts modules (codeViewer/outputViewer/fileManager), EventBus artifact lifecycle events --- {state.chat_session, json}
*/

const { EventTypes, EventPriority } = require('../../../core/events/EventTypes');
// REMOVED: getArtifactVariantKey → Moved to ArtifactLookupService
// REMOVED: resolveArtifactPresentation → Using ArtifactRouter.route() instead
const { createRendererLogger } = require('../../shared/utils/logger');
const { getAether } = require('../../shared/bridge/AetherBridge');
const { resolveStorageAPI } = require('../../../shared/utils/storage-resolver');
const sessionBridge = require('../../shared/adapters/session');
const { ArtifactSessionStore } = require('../../shared/state/artifactSessionStore');
const {
  ArtifactsServices,
  // REMOVED: CodeExecutionValidator, ExecutionResultFormatter → Moved to CodeExecutionHandler
  FileExportValidator,
  ArtifactRouter,
  ArtifactEnricher,
} = require('../../../application/artifacts/ArtifactsServices');
// REMOVED: ArtifactDeduplicationService → Frontend should NOT have deduplication business logic

// NEW: Infrastructure & Renderer (Phase 3)
const { ModuleCoordinator } = require('../services/ModuleCoordinator');

// Extracted modules (from ArtifactsController monolith refactor)
const { ArtifactDeletionHandler } = require('./modules/ArtifactDeletionHandler');
const { ArtifactLookupService } = require('./modules/ArtifactLookupService');
const { CodeExecutionHandler } = require('./modules/CodeExecutionHandler');

const { freeze } = Object;

const artifactsLogger = createRendererLogger('ArtifactsController');

// REMOVED: TAB_VARIANT_PRIORITY, DEFAULT_VARIANT_PRIORITY → Moved to ArtifactLookupService

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
    this.aether = options.aether || getAether();
    this.log = artifactsLogger.child({ scope: 'instance' });

    // Application services (clean architecture boundary)
    const storageAPI = options.storageAPI || resolveStorageAPI(options);
    const artifactsServices = options.artifactsServices || new ArtifactsServices({
      storageAPI,
      logger: this.log,
      systemAPI: options.systemAPI || null,
      cacheOptions: {
        maxEntries: 1000,
        maxTotalSize: 100 * 1024 * 1024, // 100MB
        enableMetrics: true,
      },
      artifactService: options.artifactService,
      artifactRepository: options.artifactRepository,
      artifactCache: options.artifactCache,
      artifactIndexService: options.artifactIndexService,
      backendHealthProbe: options.backendHealthProbe,
    });

    this.artifactService = artifactsServices.artifactService;
    this.artifactCache = artifactsServices.artifactCache;
    this.artifactIndexService = artifactsServices.artifactIndexService;

    // REMOVED: ArtifactDeduplicationService
    // REASON: Frontend should be a DUMB RENDERER, not implement business logic
    // If backend sends duplicates, that's a backend bug to fix

    // Backend health probe (via application services)
    this.backendHealthProbe = artifactsServices.backendHealthProbe;

    // Modules (will be initialized)
    this.modules = {};
    
    // Module coordinator (facade pattern - decouples controller from modules)
    this.moduleCoordinator = null; // Will be initialized after modules are created
    
    // Lifecycle flags
    this._isDisposed = false;
    this.initialized = false;

    // State
    this.backendConnected = false;
    this.currentTab = 'output'; // 'code' or 'output'
    this.currentChatId = null;
    this.currentArtifact = null;
    this.hasContent = false;
    // REMOVED: this.artifacts = new Map() → REPLACED with this.artifactCache (LRU cache)
    // REMOVED: this.backendArtifactIndex = new Map() → REPLACED with this.artifactIndexService
    this.sessionStore = new ArtifactSessionStore();
    this.deletedArtifacts = new Set(); // Track deleted artifact IDs

    // Extracted modules
    this.artifactDeletionHandler = new ArtifactDeletionHandler({
      getDeletedArtifacts: () => this.deletedArtifacts,
      getArtifactCache: () => this.artifactCache,
      getCurrentTab: () => this.currentTab,
      getModules: () => this.modules,
      eventBus: this.eventBus,
    });

    this.artifactLookupService = new ArtifactLookupService({
      getArtifactCache: () => this.artifactCache,
      getArtifactIndexService: () => this.artifactIndexService,
      getSessionStore: () => this.sessionStore,
      getCurrentChatId: () => this.currentChatId,
      getDeletedArtifacts: () => this.deletedArtifacts,
      loadArtifact: (artifact, opts) => this.loadArtifact(artifact, opts),
      switchTab: (tab) => this.switchTab(tab),
      showDeletedMessage: (id) => this._showDeletedArtifactMessage(id),
    });

    this.codeExecutionHandler = new CodeExecutionHandler({
      eventBus: this.eventBus,
      aether: this.aether,
      getArtifactCache: () => this.artifactCache,
      getCurrentChatId: () => this.currentChatId,
      getSessionStore: () => this.sessionStore,
      getCodeExecutor: () => this.modules.codeExecutor,
      switchTab: (tab) => this.switchTab(tab),
      loadArtifact: (artifact, opts) => this.loadArtifact(artifact, opts),
      persistArtifact: (payload) => this.persistArtifact(payload),
    });
    
    // IPC listeners for cleanup
    this._ipcListeners = [];
    this._eventListeners = [];
    
    // Log throttling - prevent per-chunk console spam
    this._logThrottle = new Map(); // artifactId -> { lastLog, chunkCount }

    // Bind methods
    this._handleLoadCode = this._handleLoadCode.bind(this);
    this._handleLoadOutput = this._handleLoadOutput.bind(this);
    this._handleSwitchTab = this._handleSwitchTab.bind(this);
    this._handleSwitchChat = this._handleSwitchChat.bind(this);
    this._handleFocus = this._handleFocus.bind(this);
    this._handleEnsureVisible = this._handleEnsureVisible.bind(this);
    this._handleSetMode = this._handleSetMode.bind(this);
    
    this.log.debug('ArtifactsController constructed');
  }

  /**
   * Initialize artifacts controller
   */
  async init() {
    if (this._isDisposed) {
      this.log.warn('init() called on disposed ArtifactsController — ignored');
      return;
    }
    if (this.initialized) {
      this.log.warn('init() called on already-initialized ArtifactsController — ignored');
      return;
    }

    this.log.info('Initializing ArtifactsController');

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

      this.log.info('ArtifactsController initialization complete');
      this.eventBus.emit(EventTypes.SYSTEM.READY, { 
        controller: 'ArtifactsController',
        timestamp: Date.now()
      }, { priority: EventPriority.HIGH });

    } catch (error) {
      this.log.error('ArtifactsController initialization failed', { error });
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
    if (this._isDisposed) return;
    this._isDisposed = true;

    this.log.info('Disposing ArtifactsController');

    // 1. Dispose extracted modules FIRST (they hold closures to controller state)
    try { this.codeExecutionHandler?.dispose(); } catch (e) { this.log.error('Failed to dispose codeExecutionHandler', { error: e }); }
    try { this.artifactLookupService?.dispose(); } catch (e) { this.log.error('Failed to dispose artifactLookupService', { error: e }); }
    try { this.artifactDeletionHandler?.dispose(); } catch (e) { this.log.error('Failed to dispose artifactDeletionHandler', { error: e }); }
    this.codeExecutionHandler = null;
    this.artifactLookupService = null;
    this.artifactDeletionHandler = null;

    // 2. Dispose viewer modules in reverse order
    const moduleNames = Object.keys(this.modules).reverse();
    for (const name of moduleNames) {
      try {
        if (this.modules[name] && typeof this.modules[name].dispose === 'function') {
          this.modules[name].dispose();
        }
      } catch (error) {
        this.log.error('Failed to dispose module', { module: name, error });
      }
    }
    this.modules = {};

    // 3. Remove IPC listeners
    for (const cleanup of this._ipcListeners) {
      try {
        cleanup();
      } catch (error) {
        this.log.error('Failed to cleanup IPC listener', { error });
      }
    }
    this._ipcListeners = [];

    // 4. Remove event listeners
    for (const cleanup of this._eventListeners) {
      try {
        cleanup();
      } catch (error) {
        this.log.error('Failed to cleanup event listener', { error });
      }
    }
    this._eventListeners = [];

    // 5. Clear caches and tracking collections
    this.artifactCache.clear();
    this.artifactIndexService.clear();
    this.deletedArtifacts.clear();
    this._logThrottle.clear();

    // 6. Dispose sessionStore if it has dispose()
    if (this.sessionStore && typeof this.sessionStore.dispose === 'function') {
      try { this.sessionStore.dispose(); } catch (e) { this.log.error('Failed to dispose sessionStore', { error: e }); }
    }

    // 7. Null service and infrastructure references
    this.moduleCoordinator = null;
    this.backendHealthProbe = null;
    this.artifactService = null;
    this.sessionStore = null;
    this.currentArtifact = null;
    this.storageAPI = null;

    // 8. Clean window globals set during init
    if (typeof window !== 'undefined') {
      delete window.artifactSessionManager;
      delete window.artifactsController;
      delete window.logToMain;
    }

    // 9. Reset lifecycle flags
    this.initialized = false;
    this.hasContent = false;

    this.log.debug('ArtifactsController disposed');
  }

  /**
   * Switch to a tab
   * @param {string} tab - Tab name ('code', 'output', or 'files')
   */
  switchTab(tab) {
    if (this._isDisposed) {
      this.log.warn('switchTab() called on disposed ArtifactsController — ignored');
      return;
    }

    this.log.debug('[ArtifactsController] 🔄 switchTab START', {
      requestedTab: tab,
      currentTab: this.currentTab,
      hasTabManager: !!this.modules.tabManager,
      timestamp: Date.now()
    });

    if (tab !== 'code' && tab !== 'output' && tab !== 'files') {
      throw new Error(`[ArtifactsController] Invalid tab: ${tab}`);
    }

    const previousTab = this.currentTab;
    this.currentTab = tab;
    
    // Update UI with TabManager
    if (this.modules.tabManager) {
      this.log.debug('[ArtifactsController] 🎨 Calling TabManager.setActiveTab', { tab });
      const tabManagerStart = Date.now();
      
      try {
        this.modules.tabManager.setActiveTab(tab);
        const tabManagerDuration = Date.now() - tabManagerStart;
        
        this.log.debug('[ArtifactsController] ✅ TabManager.setActiveTab completed', {
          tab,
          duration: tabManagerDuration + 'ms'
        });
      } catch (error) {
        this.log.error('[ArtifactsController] ❌ TabManager.setActiveTab FAILED', {
          tab,
          error: error.message,
          stack: error.stack
        });
        throw error;
      }
    } else {
      this.log.warn('[ArtifactsController] ⚠️  TabManager not available');
    }

    this.log.debug('[ArtifactsController] 🔄 switchTab COMPLETE', {
      tab,
      previousTab,
      duration: Date.now() - (this._switchTabStartTime || Date.now()) + 'ms'
    });
    
    this.log.debug('Switched tab', { from: previousTab, to: tab });
  }

  /**
   * Load artifacts for a chat ID (used by FileManager)
   * CLEAN ARCHITECTURE: Controller → ArtifactService (domain) → ArtifactRepository → storageAPI (IPC)
   * 
   * @param {string} chatId - Chat ID (REQUIRED)
   * @returns {Promise<Array>} Artifacts for the chat
   */
  async loadArtifactsForChat(chatId) {
    if (this._isDisposed) {
      this.log.warn('loadArtifactsForChat() called on disposed ArtifactsController — ignored');
      return [];
    }
    if (!chatId || typeof chatId !== 'string') {
      throw new Error('[ArtifactsController] chatId required (string)');
    }

    try {
      this.log.debug(`Loading artifacts for chat: ${chatId}`);
      
      // Delegate to domain service: ArtifactService → ArtifactRepository → storageAPI
      const artifacts = await this.artifactService.getByChat(chatId);
      
      this.log.info(`Loaded ${artifacts.length} artifacts for chat ${chatId}`);
      return artifacts;
    } catch (error) {
      this.log.error(`Failed to load artifacts for chat ${chatId}:`, error);
      throw error; // FAIL FAST
    }
  }

  /**
   * Persist artifact (used by ArtifactStreamService)
   * CLEAN ARCHITECTURE: Controller → ArtifactService (domain) → ArtifactRepository → storageAPI (IPC)
   * 
   * @param {Object} artifact - Artifact to persist (REQUIRED)
   * @returns {Promise<Object>} Persisted artifact
   */
  async persistArtifact(payload) {
    if (this._isDisposed) {
      this.log.warn('persistArtifact() called on disposed ArtifactsController — ignored');
      return null;
    }
    if (!payload || typeof payload !== 'object') {
      throw new Error('[ArtifactsController] artifact payload required');
    }

    // ARCHITECTURE: Payload must match backend ArtifactCreate schema (snake_case)
    if (!payload.chat_id) {
      throw new Error('[ArtifactsController] payload.chat_id required (snake_case per backend contract)');
    }

    try {
      const artifactId = payload.artifact_id || payload.id || 'unknown';
      this.log.debug(`Persisting artifact: ${artifactId}`);
      
      // Delegate to domain service: ArtifactService → ArtifactRepository → storageAPI
      const saved = await this.artifactService.saveArtifact(payload);
      
      this.log.debug(`Artifact persisted: ${artifactId}`);
      return saved;
    } catch (error) {
      this.log.error(`Failed to persist artifact:`, error);
      throw error; // FAIL FAST
    }
  }

  /**
   * Load artifact into viewer
   * @param {Object} artifact - Artifact data
   * @param {Object} options - Loading options
   * @param {boolean} options.autoSwitch - Whether to auto-switch tabs (true for manual clicks, false for streaming)
   */
  loadArtifact(artifact, options = {}) {
    if (this._isDisposed) {
      this.log.warn('loadArtifact() called on disposed ArtifactsController — ignored');
      return;
    }

    this.log.debug('[STEP L1] 🎯 loadArtifact called', { 
      artifactId: artifact?.id, 
      role: artifact?.role, 
      type: artifact?.type, 
      options 
    });
    
    
    if (!artifact || !artifact.id) {
      throw new Error('[ArtifactsController] Invalid artifact');
    }

    this.log.debug('[STEP L2] 🔍 Resolving artifact presentation');
    // NEW: Using ArtifactRouter (clean domain service)
    const classification = ArtifactRouter.route(artifact, {
      autoSwitch: options.autoSwitch,
      forceAutoSwitch: options.forceAutoSwitch,
      forceOutput: options.forceOutput,
      origin: options.origin || null,
      isFinal: Boolean(options.isFinal),
      currentTab: this.currentTab,
      chatId: this.currentChatId
    });
    this.log.debug('[STEP L3] 📊 Classification result', { 
      viewer: classification.viewer, 
      tab: classification.tab, 
      shouldAutoSwitch: classification.shouldAutoSwitch 
    });

    // NEW: Immutable enrichment (no mutations, creates new object)
    const enrichedArtifact = ArtifactEnricher.enrich(artifact, classification);
    
    this.artifactCache.set(enrichedArtifact.id, enrichedArtifact);
    this.currentArtifact = enrichedArtifact;
    this.hasContent = true;

    this.log.debug('[STEP L4] 🎬 Loading artifact into viewer:', classification.viewer);
    
    // NEW: Using ModuleCoordinator (facade pattern - clean abstraction over viewer modules)
    this.log.debug('[STEP L5] 📦 Delegating to ModuleCoordinator');
    const loaded = this.moduleCoordinator.loadToViewer(enrichedArtifact, classification);
    
    if (!loaded) {
      this.log.warn('[STEP L5] ❌ Failed to load artifact - viewer not available', {
        viewer: classification.viewer,
        artifactId: enrichedArtifact.id
      });
        } else {
      this.log.debug('[STEP L5] ✅ Artifact loaded successfully');
    }

    if (classification.shouldAutoSwitch || options.origin === 'file-click') {
      // CRITICAL: Only autoSwitch if we're not already on the target tab
      const isOnTargetTab = this.currentTab === classification.tab;
      
      // Allow switch if:
      // 1. We're not already on the target tab
      // 2. AND (we're not on Files tab OR target is Files OR origin is 'file-click')
      const isOnFilesTab = this.currentTab === 'files';
      const targetIsFiles = classification.tab === 'files';
      const shouldSwitch = !isOnTargetTab && (!isOnFilesTab || targetIsFiles || options.origin === 'file-click');
      
      if (shouldSwitch) {
        this.log.debug('[STEP L6] 🔄 Auto-switching tab to:', classification.tab, {
          origin: options.origin,
          currentTab: this.currentTab
        });
        this.switchTab(classification.tab);
      } else {
        this.log.debug('[STEP L6] ⏸️  Skipping auto-switch', {
          isOnTargetTab,
          isOnFilesTab,
          targetIsFiles,
          origin: options.origin
        });
      }
    } else {
      this.log.debug('[STEP L6] ⏸️  No auto-switch (shouldAutoSwitch=false, origin=' + options.origin + ')');
    }

    // NEW: Using ModuleCoordinator for highlight (facade pattern)
    this.moduleCoordinator.highlightArtifact(enrichedArtifact.id);

    this._reportWindowState();

    this.eventBus.emit(EventTypes.ARTIFACTS.LOADED, { artifact });
  }

  /**
   * Execute code (thin delegate to CodeExecutionHandler)
   * @param {string} code - Code to execute
   * @param {string} language - Programming language
   * @returns {Promise<Object>} Execution result
   */
  async executeCode(code, language) {
    if (this._isDisposed) {
      this.log.warn('executeCode() called on disposed ArtifactsController — ignored');
      return null;
    }
    return this.codeExecutionHandler.executeCode(code, language);
  }

  /**
   * Request backend execution (thin delegate to CodeExecutionHandler)
   * @param {Object} req
   */
  async requestBackendExecution(req) {
    if (this._isDisposed) {
      this.log.warn('requestBackendExecution() called on disposed ArtifactsController — ignored');
      return null;
    }
    return this.codeExecutionHandler.requestBackendExecution(req);
  }

  /**
   * Execute HTML in place (thin delegate to CodeExecutionHandler)
   * @param {Object} req
   */
  async executeHtmlInPlace(req) {
    if (this._isDisposed) {
      this.log.warn('executeHtmlInPlace() called on disposed ArtifactsController — ignored');
      return null;
    }
    return this.codeExecutionHandler.executeHtmlInPlace(req);
  }

  // REMOVED: _formatExecutionResult() → Replaced with ExecutionResultFormatter.format()

  /**
   * Export file
   * @param {string} content - File content
   * @param {string} filename - File name
   * @param {string} extension - File extension
   */
  async exportFile(content, filename, extension) {
    if (this._isDisposed) {
      this.log.warn('exportFile() called on disposed ArtifactsController — ignored');
      return;
    }

    try {
      // NEW: Security validation BEFORE export (fail-fast, prevent path traversal/malicious files)
      const validation = FileExportValidator.validate(content, filename, extension);
      this.log.info('File export validated', {
        sanitizedFilename: validation.sanitizedFilename,
        extension: validation.validExtension,
        contentSize: validation.contentSize
      });

      this.eventBus.emit(EventTypes.ARTIFACTS.FILE_EXPORT_STARTED, { 
        filename: validation.sanitizedFilename, 
        extension: validation.validExtension 
      });

      // Use IPC to export file (use sanitized values)
      if (this.aether?.artifacts?.exportFile) {
        await this.aether.artifacts.exportFile(
          content, 
          validation.sanitizedFilename, 
          validation.validExtension
        );
      }

      this.eventBus.emit(EventTypes.ARTIFACTS.FILE_EXPORTED, { 
        filename: validation.sanitizedFilename, 
        extension: validation.validExtension 
      });
      this.log.info('Artifact exported', { 
        filename: validation.sanitizedFilename, 
        extension: validation.validExtension 
      });

    } catch (error) {
      this.log.error('Artifact export failed', { error, filename, extension });
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
      artifactCount: this.artifactCache.size,
      modules: Object.keys(this.modules)
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
    this.log.debug('Initializing core dependencies');
    this.log.debug('Core dependencies ready');
  }

  /**
   * Register services in DI container
   * @private
   */
  async _registerServices() {
    this.log.trace('Registering additional services');

    // Services are already registered by artifacts renderer bootstrap
    // Additional services can be registered here if needed

    this.log.trace('Service registration complete');
  }

  /**
   * Initialize modules in dependency order
   * @private
   */
  async _initializeModules() {
    this.log.debug('Initializing modules');

    await this.sessionStore.init();
    window.artifactSessionManager = this.sessionStore;

    const artifactsApp = this.container.resolve('artifactsApp');
    artifactsApp.setController(this);

    const storageAPI =
      (this.container.has('storageAPI') && this.container.resolve('storageAPI')) ||
      resolveStorageAPI();

    const modules = await artifactsApp.initialize({
      sessionStore: this.sessionStore,
      storageAPI
    });

    this.modules.artifactsApp = artifactsApp;
    Object.assign(this.modules, modules);

    // NEW: Initialize ModuleCoordinator (facade for viewer modules)
    this.moduleCoordinator = new ModuleCoordinator(this.modules);
    this.log.debug('ModuleCoordinator initialized with viewer modules');

    this.storageAPI = artifactsApp.getStorageAPI() || storageAPI;

    // Register or resolve stream service and attach controller
    let streamService = null;
    try {
      if (this.container.has('artifactStreamService')) {
        streamService = this.container.resolve('artifactStreamService');
      }
    } catch (resolveErr) {
      this.log.warn('Failed to resolve existing artifactStreamService, creating new instance', { error: resolveErr?.message });
    }
    if (!streamService) {
      const ArtifactStreamService = require('../../shared/services/artifacts/ArtifactStreamService');
      streamService = new ArtifactStreamService({ eventBus: this.eventBus, logger: this.log });
      this.container.register('artifactStreamService', () => streamService, { singleton: true });
    }
    streamService.setController(this);
    this.modules.artifactStreamService = streamService;

    this.log.debug('Module graph initialized');
  }

  /**
   * Setup event listeners
   * @private
   */
  async _setupEventListeners() {
    this.log.trace('Registering controller-level event listeners');

    // ARCHITECTURAL NOTE: Trail metadata enrichment removed from here
    // Artifacts are now enriched with node_id/subgroup_id in ChatController
    // before being forwarded via IPC, ensuring cross-window communication works correctly

    // Listen for artifact deletions from FileManager
    const cleanupFileDeleted = this.eventBus.on(
      EventTypes.ARTIFACTS.FILE_DELETED,
      (data) => this._handleFileDeleted(data)
    );
    this._eventListeners.push(cleanupFileDeleted);

    // CRITICAL FIX: Sync internal tab state with TabManager events
    // This ensures that when user clicks a tab button manually, the controller knows about it.
    // Without this, loadArtifact() logic can get out of sync and fail to switch tabs.
    const cleanupTabChanged = this.eventBus.on(
      EventTypes.ARTIFACTS.TAB_CHANGED,
      (data) => {
        if (data?.tab && this.currentTab !== data.tab) {
          this.log.debug('Syncing controller tab state from event', { 
            old: this.currentTab, 
            new: data.tab 
          });
          this.currentTab = data.tab;
        }
      }
    );
    this._eventListeners.push(cleanupTabChanged);

    this.log.trace('Controller event listeners registered');
  }

  /**
   * Setup IPC listeners
   * @private
   */
  async _setupIpcListeners() {
    this.log.trace('Registering IPC listeners');

    const artifactsAPI = this.aether?.artifacts;
    if (!artifactsAPI) {
      throw new Error('[ArtifactsController] CONTRACT VIOLATION: aether.artifacts is required');
    }

    const cleanupStream = artifactsAPI.onStream((data) => {
      if (this.modules.artifactStreamService) {
        this.modules.artifactStreamService.handleStream(data);
      }
    });
    this._ipcListeners.push(cleanupStream);

    const cleanupLoadCode = artifactsAPI.onLoadCode((code, language, filename) => {
      this._handleLoadCode(code, language, filename);
    });
    this._ipcListeners.push(cleanupLoadCode);

    const cleanupLoadOutput = artifactsAPI.onLoadOutput((data) => {
      this._handleLoadOutput(data);
    });
    this._ipcListeners.push(cleanupLoadOutput);

    const cleanupSwitchTab = artifactsAPI.onSwitchTab((tab) => {
      this._handleSwitchTab(tab);
    });
    this._ipcListeners.push(cleanupSwitchTab);

    const cleanupSwitchChat = artifactsAPI.onSwitchChat((chatId) => {
      this._handleSwitchChat(chatId);
    });
    this._ipcListeners.push(cleanupSwitchChat);

    const cleanupFocus = artifactsAPI.onFocus(() => {
      this._handleFocus();
    });
    this._ipcListeners.push(cleanupFocus);

    const cleanupEnsureVisible = artifactsAPI.onEnsureVisible(() => {
      this._handleEnsureVisible();
    });
    this._ipcListeners.push(cleanupEnsureVisible);

    const cleanupSetMode = artifactsAPI.onSetMode((mode) => {
      this._handleSetMode(mode);
    });
    this._ipcListeners.push(cleanupSetMode);

    if (typeof artifactsAPI.onShowArtifact === 'function') {
      const cleanupShowArtifact = artifactsAPI.onShowArtifact((data) => {
        this._handleShowArtifact(data);
      });
      this._ipcListeners.push(cleanupShowArtifact);
    }

    this.log.trace('IPC listeners registered');
  }

  /**
   * Initialize global state
   * @private
   */
  async _initializeGlobalState() {
    this.log.debug('Initializing global state');

    // NEW: Using BackendHealthProbe (clean abstraction)
    const health = await this.backendHealthProbe.probe();
    if (health?.healthy !== false) {
      this.log.info('Backend health check succeeded', health || {});
      this.backendConnected = true;
      this.eventBus.emit(EventTypes.CONNECTION.BACKEND_ONLINE, { health });
    } else {
      this.log.warn('Backend health check failed', { error: health?.error || 'unknown' });
      this.backendConnected = false;
      this.eventBus.emit(EventTypes.CONNECTION.BACKEND_OFFLINE, { error: health?.error || new Error('backend offline') });
    }

    // Make controller globally accessible
    window.artifactsController = this;

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
        this.log.error('Failed to proxy controller log to main process', { error });
      }
    };

    // Report initial state
    this._reportWindowState();

    this.log.debug('Global state initialized');
  }

  // REMOVED: _probeBackendHealth() → Replaced with BackendHealthProbe.probe()

  /**
   * Report window state to main process
   * @private
   */
  _reportWindowState() {
    try {
      if (this.aether?.windowControl?.setState) {
        this.aether.windowControl.setState(this.hasContent);
      }
    } catch (error) {
      this.log.error('Failed to report window state', { error });
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

      this.loadArtifact(artifact, {
        autoSwitch: true,
        origin: 'manual',
        isFinal: true
      });

    } catch (error) {
      this.log.error('Handle load code failed', { error });
    }
  }

  /**
   * Handle load output
   * @private
   */
  _handleLoadOutput(data) {
    try {
      const artifactId = `output_${Date.now()}`;
      const artifact = {
        id: artifactId,
        artifact_id: artifactId,
        request_id: artifactId,
        type: 'output',
        content: data.output || data.content || data,
        format: data.format || 'text',
        role: 'computer',
        chatId: this.currentChatId,
        timestamp: Date.now(),
        language: data.format === 'html' ? 'html' : (data.format === 'json' ? 'json' : 'text'),
        executionGroup: artifactId,
        start: false,
        end: true
      };

      this.loadArtifact(artifact, {
        autoSwitch: true,
        forceAutoSwitch: true,
        forceOutput: true,
        origin: 'load-output',
        isFinal: true
      });

    } catch (error) {
      this.log.error('Handle load output failed', { error });
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
      this.log.error('Handle switch tab failed', { error, tab });
    }
  }

  /**
   * Handle switch chat
   * @private
   */
  async _handleSwitchChat(chatId) {
    if (this._isDisposed) return;

    try {
      this.log.info('Switching artifacts view to chat', { chatId });

      const previousChatId = this.currentChatId;
      if (previousChatId) {
        this.sessionStore.cacheArtifacts(previousChatId, Array.from(this.artifactCache.values()));
      }

      this.currentChatId = chatId;
      this.currentArtifact = null;
      this.hasContent = false;
      this.artifactCache.clear();
      this.artifactIndexService.clear();

      try {
        await sessionBridge.setActiveChat(chatId);
      } catch (error) {
        this.log.warn('Failed to set active session for artifacts', { chatId, error: error?.message });
      }

      // Mid-async disposed guard: dispose() may have run during the await above
      if (this._isDisposed) return;

      const sessionData = await this.sessionStore.switchSession(chatId);

      // Mid-async disposed guard: dispose() may have run during switchSession await
      if (this._isDisposed) return;

      if (sessionData?.artifacts && Array.isArray(sessionData.artifacts)) {
        this._primeArtifactCache(sessionData.artifacts);
      }

      this.eventBus.emit(EventTypes.ARTIFACTS.CHAT_SWITCHED, { chatId });

      if (this.modules.fileManager) {
        await this.modules.fileManager.loadFiles(chatId);
      }

      this.log.info('Artifacts chat switch complete', { chatId });

    } catch (error) {
      if (!this._isDisposed) {
        this.log.error('Handle switch chat failed', { error, chatId });
      }
    }
  }

  /**
   * Handle focus
   * @private
   */
  _handleFocus() {
    try {
      this.eventBus.emit(EventTypes.UI.WINDOW_FOCUSED, { window: 'artifacts' });
      this.log.trace('Artifacts window focused');
    } catch (error) {
      this.log.error('Handle focus failed', { error });
    }
  }

  /**
   * Handle ensure visible
   * @private
   */
  _handleEnsureVisible() {
    try {
      // Actually show the window
      if (this.modules.artifactsWindow) {
        this.modules.artifactsWindow.show();
      }
      
      this.eventBus.emit(EventTypes.UI.WINDOW_VISIBILITY_REQUESTED, { window: 'artifacts' });
      this.log.trace('Ensure visible invoked');
    } catch (error) {
      this.log.error('Handle ensure visible failed', { error });
    }
  }

  /**
   * Handle set mode
   * @private
   */
  _handleSetMode(mode) {
    try {
      this.log.debug('Artifacts controller mode set', { mode });
      this.eventBus.emit(EventTypes.ARTIFACTS.MODE_CHANGED, { mode });
    } catch (error) {
      this.log.error('Handle set mode failed', { error, mode });
    }
  }

  /**
   * Handle artifact deletion event (thin delegate)
   * @private
   */
  _handleFileDeleted(data) {
    if (this._isDisposed) return;
    this.artifactDeletionHandler.handleFileDeleted(data);
  }
  
  /**
   * Show message for deleted artifact (thin delegate)
   * @private
   */
  _showDeletedArtifactMessage(artifactId) {
    if (this._isDisposed) return;
    this.artifactDeletionHandler.showDeletedArtifactMessage(artifactId);
  }

  /**
   * Handle show artifact (thin delegate)
   * ARCHITECTURAL FIX: Also ensure renderer window is visible.
   * Trail node clicks send artifacts:show-artifact via IPC but the
   * companion artifacts:ensure-visible has no IPC route in the main
   * process, so the renderer's ArtifactsWindow component stays hidden
   * (CSS class) even though the Electron BrowserWindow is shown.
   * Calling _handleEnsureVisible here guarantees the renderer DOM is
   * visible whenever an artifact is requested, regardless of the
   * caller's ability to send ensure-visible separately.
   * @private
   */
  _handleShowArtifact(data) {
    if (this._isDisposed) return;
    this._handleEnsureVisible();
    this.artifactLookupService.handleShowArtifact(data);
  }

  /**
   * Prime artifact cache from a list of artifacts (thin delegate).
   * Called by _handleSwitchChat.
   * @private
   */
  _primeArtifactCache(artifacts = []) {
    if (this._isDisposed) return;
    this.hasContent = this.artifactLookupService.primeArtifactCache(artifacts);
  }

  /**
   * Track artifact in backend index (thin delegate).
   * Called externally by FileManager.
   * @param {Object} artifact
   * @param {string|null} [variantKeyOverride]
   */
  _trackBackendIndex(artifact, variantKeyOverride = null) {
    if (this._isDisposed) return;
    this.artifactLookupService.trackBackendIndex(artifact, variantKeyOverride);
  }
}

// Export
module.exports = ArtifactsController;

if (typeof window !== 'undefined') {
  window.ArtifactsController = ArtifactsController;
  artifactsLogger.debug('ArtifactsController module loaded');
}
