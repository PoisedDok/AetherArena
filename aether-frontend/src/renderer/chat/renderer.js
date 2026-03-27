'use strict';

/**
 * @.architecture
 * 
 * Incoming: preload IPC bridge (from chat-preload.js) --- {ipc_types.chat_assistant_stream | chat_request_complete | artifacts_stream, json}
 * Processing: Bootstrap ChatRenderer, initialize DI container, EventBus, ChatController, delegate to 7 submodules --- {3 jobs: JOB_INITIALIZE, JOB_DELEGATE_TO_MODULE, JOB_EMIT_EVENT}
 * Outgoing: ChatController → MessageManager → StreamHandler → MessageView (DOM), MessageState (PostgreSQL) --- {dom_types.chat_entry_element | database_types.message_record, HTMLElement | json}
 * 
 * 
 * @module renderer/chat/renderer
 * 
 * Chat Window Renderer - Production Edition
 * ============================================================================
 * Complete chat interface with modular architecture, dependency injection,
 * event-driven communication, and production-grade error handling.
 * 
 * Architecture:
 * - ChatController orchestrates all modules
 * - EventBus for inter-module communication
 * - DI Container for service management
 * - MessageManager handles messaging logic
 * - ChatWindow manages UI lifecycle
 * - StreamHandler processes streaming responses
 * - MessageState handles PostgreSQL persistence
 * - SecuritySanitizer validates all content
 * - MarkdownRenderer handles markdown/code
 * 
 * Security:
 * - CSP-compliant (no eval, no inline scripts)
 * - contextIsolation enabled
 * - HTML sanitization via DOMPurify
 * - Input validation on all boundaries
 * - Rate-limited IPC communication
 */

const { createRendererLogger } = require('../shared/utils/logger');
const { StartupSplash } = require('../shared/components/StartupSplash');
const { getAether } = require('../shared/bridge/AetherBridge');

const moduleLogger = createRendererLogger('ChatRenderer');
const aether = getAether();
moduleLogger.info('Chat renderer starting');

const DEFAULTS = require('../../core/config/defaults');
// NOTE: Do not depend on core/config/renderer-config in renderer.
// Renderer config is resolved from the main process via IPC (PortManager discovery).

// ============================================================================
// Validation
// ============================================================================

if (!aether) {
  moduleLogger.error('Preload API not available');
  document.body.innerHTML = '<div class="error-screen"><h1>Security Error</h1><p>Preload API not available. Check chat-preload.js configuration.</p></div>';
  throw new Error('Preload API not found');
}

moduleLogger.info('Preload API available');
moduleLogger.debug('Renderer environment snapshot', {
  versions: aether.versions,
  window: aether.window,
  libraries: {
    hljs: !!window.hljs,
    marked: !!window.marked,
    sanitizer: !!window.sanitizer
  }
});

async function resolveBackendBaseUrl() {
  // Main window uses config-init; chat window does not. Resolve via PortManager status (main process).
  if (!aether?.ipc?.invoke) {
    throw new Error('[ChatRenderer] CONTRACT VIOLATION: aether.ipc.invoke is required for backend discovery');
  }
  const baseUrl = await aether.ipc.invoke('backend:get-url');
  if (!baseUrl || typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
    throw new Error('[ChatRenderer] CONTRACT VIOLATION: Missing backend baseUrl (backend not discoverable)');
  }
  return baseUrl.replace(/\/$/, '');
}

function resolveBackendWsUrl(baseUrl) {
  return baseUrl.replace(/^http/, 'ws');
}

function resolveRendererEnv() {
  if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV) {
    return process.env.NODE_ENV;
  }
  return 'production';
}

async function createRendererConfig() {
  const baseUrl = await resolveBackendBaseUrl();
  const wsUrl = resolveBackendWsUrl(baseUrl);

  return Object.freeze({
    NODE_ENV: resolveRendererEnv(),
    API_BASE_URL: baseUrl,
    WS_URL: wsUrl,
    API_TIMEOUT: DEFAULTS.api.timeout,
    WS_RECONNECT_INTERVAL: DEFAULTS.websocket.reconnectDelay,
  });
}

// ============================================================================
// Import Dependencies
// ============================================================================

// Core
const { DependencyContainer } = require('../../core/di/Container');
const EventBus = require('../../core/events/EventBus');
const { EventTypes, EventPriority } = require('../../core/events/EventTypes');

// Controllers
const ChatController = require('./controllers/ChatController');

// Verify critical imports loaded
moduleLogger.debug('Core modules loaded', {
  DependencyContainer: typeof DependencyContainer,
  EventBus: typeof EventBus,
  EventTypes: typeof EventTypes,
  hasSystemEvents: !!(EventTypes && EventTypes.SYSTEM),
  ChatController: typeof ChatController
});

// ============================================================================
// Renderer Config (Browser-Safe)
// ============================================================================

// Configuration is resolved via main process discovery (see async helpers above).

// ============================================================================
// Bootstrap Application
// ============================================================================

class ChatRenderer {
  constructor() {
    this.controller = null;
    this.container = null;
    this.eventBus = null;
    this.config = null;
    this.initialized = false;
    this._startupSplash = null;
    this.aether = aether;
    
    // Window listener tracking for cleanup
    this._windowListeners = [];
    
    this.log = moduleLogger.child({ scope: 'instance', instanceId: Date.now() });
    
    this.log.debug('Constructed chat renderer instance');
  }
  
  /**
   * Initialize chat renderer
   */
  async initialize() {
    this.log.info('Initializing chat renderer');
    
    try {
      // Phase 1: Load configuration
      await this._loadConfiguration();

      // Phase 2: Initialize DI container
      this._initializeContainer();
      
      // Phase 3: Initialize EventBus
      this._initializeEventBus();
      
      // Phase 4: Setup global error handlers
      this._setupErrorHandlers();
      
      // Phase 5: Initialize Endpoint
      this._initializeEndpoint();

      // Phase 6: Create and initialize ChatController
      await this._initializeController();
      
      // Phase 7: Setup global window references
      this._setupGlobalReferences();
      
      // Phase 8: Apply UI effects settings
      await this._applyUiEffectsFromSettings();
      
      this.initialized = true;
      
      this.log.info('Chat renderer initialization complete');
      
      // Handshake with main process
      if (this.aether?.ipc?.send) {
        this.aether.ipc.send('chat:renderer-ready');
      } else {
        this.log.error('Failed to send chat:renderer-ready signal - IPC unavailable');
      }
      
      // Emit ready event
      this.eventBus.emit(EventTypes.SYSTEM.READY, {
        renderer: 'chat',
        timestamp: Date.now()
      }, { priority: EventPriority.HIGH });
      
    } catch (error) {
      this.log.error('Chat renderer initialization failed', { error });
      this._showFatalError(error);
      throw error;
    }
  }

  async _runStartupSplash() {
    if (this._startupSplash) {
      return;
    }
    try {
      const snapshot = this.aether?.config?.getSnapshot?.() || null;
      this._startupSplash = new StartupSplash({ windowName: 'chat', configSnapshot: snapshot });
      await this._startupSplash.run();
    } catch (error) {
      this.log.warn('Startup splash failed', { error: error?.message || String(error) });
      this._startupSplash = null;
    }
  }

  /**
   * Load configuration
   * @private
   */
  async _loadConfiguration() {
    this.log.debug('Loading renderer configuration');
    
    // Create browser-safe config
    this.config = await createRendererConfig();
    
    this.log.info('Renderer configuration resolved', {
      env: this.config.NODE_ENV,
      apiUrl: this.config.API_BASE_URL,
      wsUrl: this.config.WS_URL
    });
  }
  
  /**
   * Initialize DI container
   * @private
   */
  _initializeContainer() {
    this.log.debug('Initializing dependency container');
    
    this.container = new DependencyContainer();
    
    // Register config
    this.container.register('config', () => this.config, { singleton: true });
    
    this.log.debug('Dependency container initialized');
  }
  
  /**
   * Initialize EventBus
   * @private
   */
  _initializeEventBus() {
    this.log.debug('Initializing event bus');
    
    this.eventBus = new EventBus({
      maxListeners: 100,
      enableLogging: this.config.NODE_ENV === 'development'
    });
    
    // Register in container
    this.container.register('eventBus', () => this.eventBus, { singleton: true });
    
    // Setup global event listeners
    this._setupGlobalEventListeners();
    
    this.log.debug('Event bus initialized');
  }
  
  /**
   * Setup global event listeners
   * @private
   */
  _setupGlobalEventListeners() {
    // Validate EventTypes is properly loaded
    if (!EventTypes || !EventTypes.SYSTEM) {
      this.log.error('EventTypes not properly loaded', { EventTypes });
      throw new Error('EventTypes module failed to load');
    }
    
    // System errors
    this.eventBus.on(EventTypes.SYSTEM.ERROR, (data) => {
      this.log.error('System error event received', data);
      
      if (data.fatal) {
        this._showFatalError(data.error);
      }
    }, { priority: EventPriority.HIGH });
    
    // Connection events
    this.eventBus.on(EventTypes.CONNECTION.BACKEND_ONLINE, (data) => {
      this.log.info('Backend connection restored', data);
    });
    
    this.eventBus.on(EventTypes.CONNECTION.BACKEND_OFFLINE, (data) => {
      this.log.warn('Backend reported offline', data);
    });
    
    // Chat events - using correct event names from EventTypes
    this.eventBus.on(EventTypes.CHAT.MESSAGE_SENT, (data) => {
      this.log.debug('Message sent event', data);
    });
    
    // Listen for both message and stream errors
    this.eventBus.on(EventTypes.CHAT.MESSAGE_ERROR, (data) => {
      this.log.error('Chat message error', { error: data.error });
    });
    
    this.eventBus.on(EventTypes.CHAT.STREAM_ERROR, (data) => {
      this.log.error('Chat stream error', { error: data.error });
    });
  }
  
  /**
   * Setup error handlers
   * @private
   */
  _setupErrorHandlers() {
    this.log.debug('Setting up global error handlers');
    
    // Unhandled promise rejections
    const rejectionHandler = (event) => {
      this.log.error('Unhandled promise rejection', { reason: event.reason });
      
      this.eventBus.emit(EventTypes.SYSTEM.ERROR, {
        error: event.reason,
        type: 'unhandledRejection',
        fatal: false
      });
      
      // Prevent default error logging
      event.preventDefault();
    };
    window.addEventListener('unhandledrejection', rejectionHandler);
    this._windowListeners.push({ event: 'unhandledrejection', handler: rejectionHandler });
    
    // Global errors
    const errorHandler = (event) => {
      this.log.error('Global error event', { error: event.error });
      
      this.eventBus.emit(EventTypes.SYSTEM.ERROR, {
        error: event.error,
        type: 'globalError',
        fatal: false
      });
    };
    window.addEventListener('error', errorHandler);
    this._windowListeners.push({ event: 'error', handler: errorHandler });
    
    this.log.debug('Global error handlers configured');
  }
  
  /**
   * Initialize API Endpoint
   * @private
   */
  _initializeEndpoint() {
    this.log.debug('Initializing endpoint');
    
    const Endpoint = require('../../core/communication/Endpoint');
    const snapshot = this.aether?.config?.getSnapshot?.() || null;
    const skipHealth = snapshot?.dev?.skipHealthCheck;
    const endpoint = new Endpoint({
      API_BASE_URL: this.config.API_BASE_URL,
      WS_URL: this.config.WS_URL,
      NODE_ENV: this.config.NODE_ENV,
      backendAvailable: !skipHealth
    });
    if (skipHealth) {
      this.log.info('Backend availability set to false (dev.skipHealthCheck=true)');
    }

    // Register in DI container
    this.container.register('endpoint', () => endpoint, { singleton: true });

    this.log.debug('Endpoint initialized');
  }

  /**
   * Initialize ChatController
   * @private
   */
  async _initializeController() {
    this.log.debug('Initializing ChatController');
    
    try {
      // Create controller
      this.controller = new ChatController({
        container: this.container,
        eventBus: this.eventBus,
        config: this.config,
        ipc: this.aether.ipc
      });
      
      // Initialize controller
      await this.controller.init();
      
      this.log.info('ChatController initialized');
    } catch (error) {
      this.log.error('ChatController initialization failed', { error });
      throw error;
    }
  }
  
  /**
   * Setup global window references
   * @private
   */
  _setupGlobalReferences() {
    this.log.debug('Setting up global references');
    
    // Expose controller for debugging
    if (this.config.NODE_ENV === 'development') {
      window.__chatRenderer = this;
      window.__chatController = this.controller;
      window.__eventBus = this.eventBus;
      window.__container = this.container;
    }
    
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
        this.log.error('Failed to proxy renderer log to main process', { error });
      }
    };
    
    this.log.debug('Global references ready');
  }

  /**
   * Apply UI effects settings from backend
   * @private
   */
  async _applyUiEffectsFromSettings() {
    if (typeof document === 'undefined') {
      return;
    }
    // Offline-safe: renderers must boot even when backend is unavailable.
    // Default to 'full' effects until settings can be fetched later.
    const endpoint = this.container?.has('endpoint') ? this.container.resolve('endpoint') : null;
    if (!endpoint) {
      this.log.warn('Endpoint not available for UI settings; using defaults');
      document.documentElement.setAttribute('data-effects', 'full');
      return;
    }

    try {
      const settings = await endpoint.getSettings();
      const effectsMode = settings?.ui?.effects_mode === 'reduced' ? 'reduced' : 'full';
      document.documentElement.setAttribute('data-effects', effectsMode);
    } catch (error) {
      this.log.warn('Failed to load ui settings; using defaults', { error: error?.message || String(error) });
      document.documentElement.setAttribute('data-effects', 'full');
    }
  }
  
  /**
   * Show fatal error
   * @private
   * @param {Error} error - Error object
   */
  _showFatalError(error) {
    this.log.error('Fatal renderer error', { error });
    
    const errorMessage = error.message || 'Unknown error';
    const errorStack = error.stack || 'No stack trace';
    
    document.body.innerHTML = '<div class="error-screen"><h1>Fatal Error</h1><p class="error-message"></p><details class="error-details"><summary>Show Details</summary><pre class="error-stack"></pre></details><button id="reload-btn">Reload Window</button></div>';
    const msgEl = document.querySelector('.error-message');
    const stackEl = document.querySelector('.error-stack');
    const btn = document.getElementById('reload-btn');
    if (msgEl) msgEl.textContent = errorMessage;
    if (stackEl) stackEl.textContent = errorStack;
    if (btn) btn.addEventListener('click', () => location.reload());
  }
  
  /**
   * Escape HTML for safe display
   * @private
   * @param {string} text - Text to escape
   * @returns {string}
   */
  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  
  /**
   * Dispose and cleanup
   */
  async dispose() {
    this.log.info('Disposing chat renderer');
    
    try {
      if (this._startupSplash) {
        this._startupSplash.dispose();
        this._startupSplash = null;
      }
      // Dispose controller
      if (this.controller) {
        // HIGH FIX: Await async dispose if it returns Promise
        const result = this.controller.dispose();
        if (result instanceof Promise) {
          await result;
        }
        this.controller = null;
      }
      
      // Remove window listeners
      for (const { event, handler } of this._windowListeners) {
        try {
          window.removeEventListener(event, handler);
        } catch (err) {
          this.log.error('Failed to remove window listener', { event, err });
        }
      }
      this._windowListeners = [];

      // Clear event bus
      if (this.eventBus) {
        this.eventBus.removeAllListeners();
        this.eventBus = null;
      }
      
      // Clear container
      if (this.container) {
        this.container.clear();
        this.container = null;
      }
      
      this.log.debug('Chat renderer disposed');
    } catch (error) {
      this.log.error('Chat renderer disposal error', { error });
    }
  }
}

// ============================================================================
// Application Entry Point
// ============================================================================

let renderer = null;

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeApp);
} else {
  initializeApp();
}

async function initializeApp() {
  try {
    renderer = new ChatRenderer();
    await renderer.initialize();
    
    moduleLogger.info('Chat application ready');
  } catch (error) {
    moduleLogger.error('Fatal error during renderer bootstrap', { error });
  }
}

// Cleanup on unload
window.addEventListener('beforeunload', () => {
if (renderer) {
  renderer.dispose();
}
});

moduleLogger.debug('Chat renderer script loaded');
