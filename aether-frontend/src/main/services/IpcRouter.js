'use strict';

/**
 * @.architecture
 * 
 * Incoming: IPC events from Main Window, Chat Window, Artifacts Window (via ipcMain.on) --- {ipc_types.event, any}
 * Processing: Route messages between windows, validate source window, enrich metadata, delegate to WindowManager for lifecycle actions --- {5 jobs: JOB_DELEGATE_TO_MODULE, JOB_INITIALIZE, JOB_ROUTE_BY_TYPE, JOB_SEND_IPC, JOB_VALIDATE_IPC_SOURCE}
 * Outgoing: window.webContents.send() → Main/Chat/Artifacts Window renderers --- {ipc_types.message, any}
 * 
 * @module main/services/IpcRouter
 * 
 * IPC Router
 * ============================================================================
 * Routes IPC messages between main process and renderer windows.
 * Implements secure message routing with source validation.
 * 
 * Architecture:
 * - Main Window ↔ Main Process ↔ Chat Window
 * - Chat Window ↔ Main Process ↔ Artifacts Window
 * - Two-stage routing for artifacts (enrichment in Chat Window)
 * 
 * Security:
 * - Source validation (event.sender check)
 * - Channel whitelisting
 * - No dynamic channel registration
 */

const { ipcMain } = require('electron');
const { logger } = require('../../core/utils/logger');

// ============================================================================
// IpcRouter Class
// ============================================================================

class IpcRouter {
  constructor(windowManager, options = {}) {
    if (!windowManager) {
      throw new Error('WindowManager is required for IpcRouter');
    }
    
    this.windowManager = windowManager;
    this.options = {
      validateSource: options.validateSource !== false, // Default true
      logMessages: options.logMessages || false,
      logErrors: options.logErrors !== false, // Default true
      ...options,
    };
    
    this.logger = logger.child({ module: 'IpcRouter' });
    this.handlers = new Map();
    this.isInitialized = false;
  }

  /**
   * Initialize router and register all handlers
   */
  initialize() {
    if (this.isInitialized) {
      this.logger.warn('IpcRouter already initialized');
      return;
    }
    
    this.logger.info('Initializing IPC router');
    
    // Register all route handlers
    this._registerMainWindowRoutes();
    this._registerChatWindowRoutes();
    this._registerArtifactsWindowRoutes();
    this._registerUtilityRoutes();
    
    this.isInitialized = true;
    this.logger.info('IPC router initialized');
  }

  /**
   * Shutdown router and remove all handlers
   */
  shutdown() {
    this.logger.info('Shutting down IPC router');
    
    // Remove all registered handlers
    this.handlers.forEach((_, channel) => {
      ipcMain.removeAllListeners(channel);
    });
    
    this.handlers.clear();
    this.isInitialized = false;
    
    this.logger.info('IPC router shutdown complete');
  }

  /**
   * Register a route handler
   */
  _registerRoute(channel, handler, options = {}) {
    if (this.handlers.has(channel)) {
      this.logger.warn('Route already registered, overwriting', { channel });
    }
    
    const wrappedHandler = (event, ...args) => {
      try {
        // Log if enabled
        if (this.options.logMessages) {
          this.logger.debug('IPC message received', {
            channel,
            sourceWindow: this._getWindowName(event.sender),
          });
        }
        
        // Source validation if enabled
        if (this.options.validateSource && options.allowedSources) {
          const sourceName = this._getWindowName(event.sender);
          if (!options.allowedSources.includes(sourceName)) {
            this.logger.warn('IPC message from unauthorized source', {
              channel,
              source: sourceName,
              allowed: options.allowedSources,
            });
            return;
          }
        }
        
        // Execute handler
        handler(event, ...args);
      } catch (err) {
        if (this.options.logErrors) {
          this.logger.error('IPC handler error', {
            channel,
            error: err.message,
            stack: err.stack,
          });
        }
      }
    };
    
    ipcMain.on(channel, wrappedHandler);
    this.handlers.set(channel, wrappedHandler);
  }

  /**
   * Get window name from webContents
   */
  _getWindowName(webContents) {
    const mainWindow = this.windowManager.getMainWindow();
    const chatWindow = this.windowManager.getChatWindow();
    const artifactsWindow = this.windowManager.getArtifactsWindow();
    
    if (mainWindow && webContents === mainWindow.webContents) return 'mainWindow';
    if (chatWindow && webContents === chatWindow.webContents) return 'chatWindow';
    if (artifactsWindow && webContents === artifactsWindow.webContents) return 'artifactsWindow';
    
    return 'unknown';
  }

  /**
   * Safely send to window
   */
  _sendToWindow(window, channel, ...args) {
    if (!window || window.isDestroyed()) {
      this.logger.warn('Cannot send to destroyed window', { channel });
      return false;
    }
    
    try {
      window.webContents.send(channel, ...args);
      return true;
    } catch (err) {
      this.logger.error('Failed to send to window', {
        channel,
        error: err.message,
      });
      return false;
    }
  }

  // ==========================================================================
  // Main Window Routes
  // ==========================================================================

  _registerMainWindowRoutes() {
    // Widget mode toggle
    this._registerRoute('toggle-widget-mode', () => {
      this.windowManager.toggleWidgetMode();
    });

    // Window double-click (exit widget mode)
    this._registerRoute('window-double-clicked', () => {
      if (this.windowManager.isWidgetMode) {
        this.windowManager.exitWidgetMode();
      }
    }, { allowedSources: ['mainWindow'] });

    // Widget position update
    this._registerRoute('widget-position-update', (event, bounds) => {
      this.windowManager.updateWidgetPosition(bounds);
    }, { allowedSources: ['mainWindow'] });

    // Zoom controls
    this._registerRoute('wheel-event', (event, wheelData) => {
      this.windowManager.handleWheelEvent(wheelData);
    }, { allowedSources: ['mainWindow'] });

    this._registerRoute('zoom-in', () => {
      this.windowManager.zoomIn();
    });

    this._registerRoute('zoom-out', () => {
      this.windowManager.zoomOut();
    });

    // Chat communication: forward from main to chat
    this._registerRoute('chat:send', (event, payload) => {
      const chatWindow = this.windowManager.getChatWindow();
      const mainWindow = this.windowManager.getMainWindow();
      
      // Forward to both chat window (for UI) and main window (for backend processing)
      this._sendToWindow(chatWindow, 'chat:send', payload);
      this._sendToWindow(mainWindow, 'chat:send', payload);
    });

    // Artifacts streaming: Stage 1 (Main → Chat for chatId injection)
    this._registerRoute('artifacts:stream', (event, data) => {
      const chatWindow = this.windowManager.getChatWindow();
      
      // Validate source is main window
      if (this.options.validateSource && event.sender !== this.windowManager.getMainWindow()?.webContents) {
        this.logger.warn('artifacts:stream from non-main window');
        return;
      }
      
      this.logger.debug('Stage 1: Forwarding artifacts:stream to chat window');
      this._sendToWindow(chatWindow, 'artifacts:stream', data);
    }, { allowedSources: ['mainWindow'] });
  }

  // ==========================================================================
  // Chat Window Routes
  // ==========================================================================

  _registerChatWindowRoutes() {
    // Window control
    this._registerRoute('chat:window-control', (event, action) => {
      this.windowManager.controlChatWindow(action);
    });

    // Forward chat messages from chat window to main renderer
    this._registerRoute('chat:send', (event, payload) => {
      const mainWindow = this.windowManager.getMainWindow();
      
      // Only forward if from chat window
      if (event.sender === this.windowManager.getChatWindow()?.webContents) {
        this._sendToWindow(mainWindow, 'chat:send', payload);
      }
    }, { allowedSources: ['chatWindow'] });

    // Assistant stream updates (Main → Chat)
    this._registerRoute('chat:assistant-stream', (event, data) => {
      const chatWindow = this.windowManager.getChatWindow();
      
      // Enrich with metadata
      const enhancedData = {
        ...data,
        _artifactsActive: this.windowManager.isArtifactsWindowActive(),
        _timestamp: Date.now(),
      };
      
      this._sendToWindow(chatWindow, 'chat:assistant-stream', enhancedData);
    }, { allowedSources: ['mainWindow'] });

    // Assistant persist (separate from streaming)
    this._registerRoute('chat:assistant-persist', (event, data) => {
      const chatWindow = this.windowManager.getChatWindow();
      this._sendToWindow(chatWindow, 'chat:assistant-stream-persist', data);
    });

    // Request completion
    this._registerRoute('chat:request-complete', () => {
      const chatWindow = this.windowManager.getChatWindow();
      this._sendToWindow(chatWindow, 'chat:request-complete');
    });

    // Stop request
    this._registerRoute('chat:stop', (event) => {
      const mainWindow = this.windowManager.getMainWindow();
      const chatWindow = this.windowManager.getChatWindow();
      
      // Forward to both windows
      this._sendToWindow(mainWindow, 'chat:stop');
      this._sendToWindow(chatWindow, 'chat:stop');
    });

    // Artifacts streaming: Stage 2 (Chat → Artifacts with chatId)
    this._registerRoute('artifacts:stream:ready', (event, data) => {
      const artifactsWindow = this.windowManager.getArtifactsWindow();
      
      // Validate source is chat window
      if (this.options.validateSource && event.sender !== this.windowManager.getChatWindow()?.webContents) {
        this.logger.warn('artifacts:stream:ready from non-chat window');
        return;
      }
      
      this.logger.debug('Stage 2: Forwarding artifacts to artifacts window', {
        chatId: data.chatId,
      });
      
      // Create artifacts window if needed
      if (!artifactsWindow || artifactsWindow.isDestroyed()) {
        this.windowManager.createArtifactsWindow();
      }
      
      // Send to artifacts window (with queueing if loading)
      this.windowManager.sendToArtifacts('artifacts:stream', data);
    }, { allowedSources: ['chatWindow'] });

    // Switch chat (notify artifacts)
    this._registerRoute('artifacts:switch-chat', (event, chatId) => {
      const artifactsWindow = this.windowManager.getArtifactsWindow();
      this.logger.debug('Forwarding artifacts:switch-chat', { chatId });
      this._sendToWindow(artifactsWindow, 'artifacts:switch-chat', chatId);
    });

    // Artifacts focus/load/switch requests
    this._registerRoute('artifacts:focus-artifacts', (event, data) => {
      this.windowManager.focusArtifacts(data);
    });

    this._registerRoute('artifacts:switch-tab', (event, targetTab) => {
      const artifactsWindow = this.windowManager.getArtifactsWindow();
      this._sendToWindow(artifactsWindow, 'artifacts:switch-tab', targetTab);
    });

    this._registerRoute('artifacts:load-code', (event, data) => {
      this.windowManager.loadArtifactsCode(data);
    });

    this._registerRoute('artifacts:load-output', (event, data) => {
      this.windowManager.loadArtifactsOutput(data);
    });
  }

  // ==========================================================================
  // Artifacts Window Routes
  // ==========================================================================

  _registerArtifactsWindowRoutes() {
    // Window control
    this._registerRoute('artifacts:window-control', (event, action) => {
      this.windowManager.controlArtifactsWindow(action);
    });

    // Window state updates (active/inactive)
    this._registerRoute('artifacts:window-state', (event, data) => {
      this.windowManager.setArtifactsWindowState(data);
      
      // Notify chat window
      const chatWindow = this.windowManager.getChatWindow();
      this._sendToWindow(chatWindow, 'artifacts:window-state', data);
    });

    // Mode changed
    this._registerRoute('artifacts:mode-changed', (event, mode) => {
      this.logger.debug('Artifacts mode changed', { mode });
    });

    // File operations
    this._registerRoute('artifacts:file-export', async (event, payload) => {
      await this.windowManager.exportArtifactFile(payload);
    });

    this._registerRoute('artifacts:open-file', async (event, payload) => {
      await this.windowManager.openFile(payload);
    });
  }

  // ==========================================================================
  // Utility Routes
  // ==========================================================================

  _registerUtilityRoutes() {
    // Renderer logging
    this._registerRoute('renderer-log', (event, message) => {
      const windowName = this._getWindowName(event.sender);
      this.logger.info(`[Renderer:${windowName}] ${message}`);
    });

    // Open external URL
    this._registerRoute('open-external-url', async (event, url) => {
      const { shell } = require('electron');
      try {
        await shell.openExternal(url);
      } catch (err) {
        this.logger.error('Failed to open external URL', {
          url,
          error: err.message,
        });
      }
    });
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalRouter = null;

/**
 * Get or create global router instance
 */
function getRouter(windowManager, options = {}) {
  if (!globalRouter && windowManager) {
    globalRouter = new IpcRouter(windowManager, options);
  }
  return globalRouter;
}

/**
 * Create a new router instance
 */
function createRouter(windowManager, options = {}) {
  return new IpcRouter(windowManager, options);
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  IpcRouter,
  getRouter,
  createRouter,
};

