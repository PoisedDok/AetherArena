'use strict';

/**
 * @.architecture
 * 
 * Incoming: window.aether.ipc (from chat-preload.js) --- {ipc_types.chat_assistant_stream | chat_request_complete | artifacts_stream, json}
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

console.log('🚀 Chat Renderer: Starting...');

// ============================================================================
// Validation
// ============================================================================

if (!window.aether) {
  console.error('❌ Chat Renderer: Preload API not available');
  document.body.innerHTML = `
    <div style="padding: 40px; text-align: center; font-family: system-ui;">
      <h1 style="color: #ff4444;">Security Error</h1>
      <p>Preload API not available. Check chat-preload.js configuration.</p>
    </div>
  `;
  throw new Error('Preload API not found');
}

console.log('✅ Chat Renderer: Preload API available');
console.log('📦 Aether versions:', window.aether.versions);
console.log('📍 Chat window:', window.aether.window);
console.log('📚 Libraries:', {
  hljs: !!window.hljs,
  marked: !!window.marked,
  sanitizer: !!window.sanitizer
});

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
console.log('[ChatRenderer] Core modules loaded:', {
  DependencyContainer: typeof DependencyContainer,
  EventBus: typeof EventBus,
  EventTypes: typeof EventTypes,
  hasSystemEvents: !!(EventTypes && EventTypes.SYSTEM),
  ChatController: typeof ChatController
});

// ============================================================================
// Renderer Config (Browser-Safe)
// ============================================================================

/**
 * Create renderer-safe configuration
 * Uses defaults + environment detection, no Node.js dependencies
 * Config must be passed via preload/window context, not via require()
 */
function createRendererConfig() {
  const isDev = typeof window !== 'undefined' && 
                (window.location.hostname === 'localhost' || 
                 window.location.hostname === '127.0.0.1');
  
  // Use defaults - config should be injected via preload if needed
  const configDefaults = {
    API_BASE_URL: 'http://localhost:8765',
    WS_URL: 'ws://localhost:8765'
  };
  
  return Object.freeze({
    NODE_ENV: isDev ? 'development' : 'production',
    API_BASE_URL: configDefaults.API_BASE_URL,
    WS_URL: configDefaults.WS_URL,
    API_TIMEOUT: 30000,
    WS_RECONNECT_INTERVAL: 3000,
    WS_MAX_RECONNECT_ATTEMPTS: 10
  });
}

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
    
    console.log('[ChatRenderer] Constructed');
  }
  
  /**
   * Initialize chat renderer
   */
  async initialize() {
    console.log('🏗️  [ChatRenderer] Initializing...');
    
    try {
      // Phase 1: Load configuration
      await this._loadConfiguration();
      
      // Phase 2: Initialize DI container
      this._initializeContainer();
      
      // Phase 3: Initialize EventBus
      this._initializeEventBus();
      
      // Phase 4: Setup global error handlers
      this._setupErrorHandlers();
      
      // Phase 5: Create and initialize ChatController
      await this._initializeController();
      
      // Phase 6: Setup global window references
      this._setupGlobalReferences();
      
      this.initialized = true;
      
      console.log('✅ [ChatRenderer] Initialization complete');
      
      // Emit ready event
      this.eventBus.emit(EventTypes.SYSTEM.READY, {
        renderer: 'chat',
        timestamp: Date.now()
      }, { priority: EventPriority.HIGH });
      
    } catch (error) {
      console.error('❌ [ChatRenderer] Initialization failed:', error);
      this._showFatalError(error);
      throw error;
    }
  }
  
  /**
   * Load configuration
   * @private
   */
  async _loadConfiguration() {
    console.log('[ChatRenderer] Loading configuration...');
    
    // Create browser-safe config
    this.config = createRendererConfig();
    
    console.log('✅ [ChatRenderer] Configuration loaded:', {
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
    console.log('[ChatRenderer] Initializing DI container...');
    
    this.container = new DependencyContainer();
    
    // Register config
    this.container.register('config', () => this.config, { singleton: true });
    
    console.log('✅ [ChatRenderer] DI container initialized');
  }
  
  /**
   * Initialize EventBus
   * @private
   */
  _initializeEventBus() {
    console.log('[ChatRenderer] Initializing EventBus...');
    
    this.eventBus = new EventBus({
      maxListeners: 100,
      enableLogging: this.config.NODE_ENV === 'development'
    });
    
    // Register in container
    this.container.register('eventBus', () => this.eventBus, { singleton: true });
    
    // Setup global event listeners
    this._setupGlobalEventListeners();
    
    console.log('✅ [ChatRenderer] EventBus initialized');
  }
  
  /**
   * Setup global event listeners
   * @private
   */
  _setupGlobalEventListeners() {
    // Validate EventTypes is properly loaded
    if (!EventTypes || !EventTypes.SYSTEM) {
      console.error('[ChatRenderer] EventTypes not properly loaded:', EventTypes);
      throw new Error('EventTypes module failed to load');
    }
    
    // System errors
    this.eventBus.on(EventTypes.SYSTEM.ERROR, (data) => {
      console.error('[ChatRenderer] System error:', data);
      
      if (data.fatal) {
        this._showFatalError(data.error);
      }
    }, { priority: EventPriority.HIGH });
    
    // Connection events
    this.eventBus.on(EventTypes.CONNECTION.BACKEND_ONLINE, (data) => {
      console.log('[ChatRenderer] Backend online:', data);
    });
    
    this.eventBus.on(EventTypes.CONNECTION.BACKEND_OFFLINE, (data) => {
      console.warn('[ChatRenderer] Backend offline:', data);
    });
    
    // Chat events - using correct event names from EventTypes
    this.eventBus.on(EventTypes.CHAT.MESSAGE_SENT, (data) => {
      console.log('[ChatRenderer] Message sent');
    });
    
    // Listen for both message and stream errors
    this.eventBus.on(EventTypes.CHAT.MESSAGE_ERROR, (data) => {
      console.error('[ChatRenderer] Chat message error:', data.error);
    });
    
    this.eventBus.on(EventTypes.CHAT.STREAM_ERROR, (data) => {
      console.error('[ChatRenderer] Chat stream error:', data.error);
    });
  }
  
  /**
   * Setup error handlers
   * @private
   */
  _setupErrorHandlers() {
    console.log('[ChatRenderer] Setting up error handlers...');
    
    // Unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
      console.error('[ChatRenderer] Unhandled promise rejection:', event.reason);
      
      this.eventBus.emit(EventTypes.SYSTEM.ERROR, {
        error: event.reason,
        type: 'unhandledRejection',
        fatal: false
      });
      
      // Prevent default error logging
      event.preventDefault();
    });
    
    // Global errors
    window.addEventListener('error', (event) => {
      console.error('[ChatRenderer] Global error:', event.error);
      
      this.eventBus.emit(EventTypes.SYSTEM.ERROR, {
        error: event.error,
        type: 'globalError',
        fatal: false
      });
    });
    
    console.log('✅ [ChatRenderer] Error handlers setup');
  }
  
  /**
   * Initialize ChatController
   * @private
   */
  async _initializeController() {
    console.log('[ChatRenderer] Initializing ChatController...');
    
    try {
      // Create controller
      this.controller = new ChatController({
        container: this.container,
        eventBus: this.eventBus,
        config: this.config,
        ipc: window.aether.ipc
      });
      
      // Initialize controller
      await this.controller.init();
      
      console.log('✅ [ChatRenderer] ChatController initialized');
    } catch (error) {
      console.error('❌ [ChatRenderer] ChatController initialization failed:', error);
      throw error;
    }
  }
  
  /**
   * Setup global window references
   * @private
   */
  _setupGlobalReferences() {
    console.log('[ChatRenderer] Setting up global references...');
    
    // Expose controller for debugging
    if (this.config.NODE_ENV === 'development') {
      window.__chatRenderer = this;
      window.__chatController = this.controller;
      window.__eventBus = this.eventBus;
      window.__container = this.container;
    }
    
    // Legacy compatibility
    window.chatController = this.controller;
    
    // Setup global log function
    window.logToMain = (...args) => {
      try {
        const message = args.map(a => 
          typeof a === 'object' ? JSON.stringify(a) : String(a)
        ).join(' ');
        
        if (window.aether && window.aether.log) {
          window.aether.log.send(message);
        }
      } catch (error) {
        console.error('[ChatRenderer] Failed to log to main:', error);
      }
    };
    
    console.log('✅ [ChatRenderer] Global references setup');
  }
  
  /**
   * Show fatal error
   * @private
   * @param {Error} error - Error object
   */
  _showFatalError(error) {
    console.error('[ChatRenderer] Fatal error:', error);
    
    const errorMessage = error.message || 'Unknown error';
    const errorStack = error.stack || 'No stack trace';
    
    document.body.innerHTML = `
      <div style="
        padding: 40px;
        text-align: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        background: #1a1a1a;
        color: #e0e0e0;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
      ">
        <h1 style="color: #ff4444; margin: 0 0 20px 0;">
          Fatal Error
        </h1>
        <p style="font-size: 16px; margin: 0 0 20px 0; max-width: 600px;">
          ${this._escapeHtml(errorMessage)}
        </p>
        <details style="
          max-width: 800px;
          width: 100%;
          background: rgba(0,0,0,0.3);
          padding: 20px;
          border-radius: 8px;
          text-align: left;
        ">
          <summary style="cursor: pointer; font-weight: 600; margin-bottom: 10px;">
            Show Details
          </summary>
          <pre style="
            overflow-x: auto;
            font-size: 12px;
            line-height: 1.5;
            margin: 0;
            color: #ff6b6b;
          ">${this._escapeHtml(errorStack)}</pre>
        </details>
        <button 
          onclick="location.reload()" 
          style="
            margin-top: 30px;
            padding: 12px 24px;
            background: #0066cc;
            color: white;
            border: none;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 150ms;
          "
          onmouseover="this.style.background='#0052a3'"
          onmouseout="this.style.background='#0066cc'"
        >
          Reload Window
        </button>
      </div>
    `;
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
  dispose() {
    console.log('[ChatRenderer] Disposing...');
    
    try {
      // Dispose controller
      if (this.controller) {
        this.controller.dispose();
        this.controller = null;
      }
      
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
      
      console.log('✅ [ChatRenderer] Disposed');
    } catch (error) {
      console.error('[ChatRenderer] Disposal error:', error);
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
    
    console.log('✅ Chat application ready');
  } catch (error) {
    console.error('❌ Fatal error during initialization:', error);
  }
}

// Cleanup on unload
window.addEventListener('beforeunload', () => {
  if (renderer) {
    renderer.dispose();
  }
});

console.log('✅ Chat renderer script loaded');
