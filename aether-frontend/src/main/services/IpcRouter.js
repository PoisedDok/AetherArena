'use strict';

/**
 * @.architecture
 * 
 * Incoming: IPC events from Main Window, Chat Window, Artifacts Window (via ipcMain.on) --- {ipc_types.event, any}
 * Processing: Route messages between windows, validate source window, enrich metadata, delegate to WindowManager for lifecycle actions --- {7 jobs: JOB_DELEGATE_TO_MODULE, JOB_DISPOSE, JOB_INITIALIZE, JOB_ROUTE_BY_TYPE, JOB_SEND_IPC, JOB_UPDATE_STATE, JOB_VALIDATE_IPC_SOURCE}
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

const path = require('path');
const { ipcMain, dialog, app } = require('electron');
const { logger } = require('../../core/utils/logger');
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

// ============================================================================
// IpcRouter Class
// ============================================================================

class IpcRouter {
  constructor(windowManager, options = {}) {
    if (!windowManager) {
      throw new Error('WindowManager is required for IpcRouter');
    }
    
    this.windowManager = windowManager;
    this.systemMonitor = options.systemMonitor || null;
    this.options = {
      validateSource: options.validateSource !== false,
      logMessages: options.logMessages || false,
      logErrors: options.logErrors !== false,
      ...options,
    };
    
    this.logger = logger.child({ module: 'IpcRouter' });
    this.handlers = new Map();
    this.handleHandlers = new Map();
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

    // Clear welcome fallback timer if still pending
    if (this._welcomeFallbackTimer) {
      clearTimeout(this._welcomeFallbackTimer);
      this._welcomeFallbackTimer = null;
    }
    
    // Remove all registered handlers
    this.handlers.forEach((_, channel) => {
      ipcMain.removeAllListeners(channel);
    });
    this.handleHandlers.forEach((_, channel) => {
      ipcMain.removeHandler(channel);
    });
    
    this.handlers.clear();
    this.handleHandlers.clear();
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
        
        // Structural validation
        if (options.schema) {
          if (typeof options.schema !== 'function') {
            throw new Error(`Schema for channel ${channel} must be a validation function`);
          }
          const isValid = options.schema(...args);
          if (!isValid) {
            this.logger.error('IPC message failed structural validation', {
              channel,
              payload: args
            });
            return; // Drop invalid payload
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
   * Register an ipcMain.handle route
   */
  _registerHandle(channel, handler, options = {}) {
    if (this.handleHandlers.has(channel)) {
      ipcMain.removeHandler(channel);
      this.logger.warn('Handle route already registered, overwriting', { channel });
    }

    const wrappedHandler = async (event, ...args) => {
      try {
        if (this.options.logMessages) {
          this.logger.debug('IPC handle received', {
            channel,
            sourceWindow: this._getWindowName(event.sender),
          });
        }
        
        if (this.options.validateSource && options.allowedSources) {
          const sourceName = this._getWindowName(event.sender);
          if (!options.allowedSources.includes(sourceName)) {
            this.logger.warn('IPC handle from unauthorized source', {
              channel,
              source: sourceName,
              allowed: options.allowedSources,
            });
            throw new Error('Unauthorized IPC source');
          }
        }
        
        // Structural validation
        if (options.schema) {
          if (typeof options.schema !== 'function') {
            throw new Error(`Schema for channel ${channel} must be a validation function`);
          }
          const isValid = options.schema(...args);
          if (!isValid) {
            this.logger.error('IPC handle failed structural validation', {
              channel,
              payload: args
            });
            throw new Error('Invalid IPC payload structure');
          }
        }
        
        return await handler(event, ...args);
      } catch (err) {
        if (this.options.logErrors) {
          this.logger.error('IPC handle error', {
            channel,
            error: err.message,
            stack: err.stack,
          });
        }
        throw err;
      }
    };

    ipcMain.handle(channel, wrappedHandler);
    this.handleHandlers.set(channel, wrappedHandler);
  }

  /**
   * Get window name from webContents
   */
  _getWindowName(webContents) {
    const mainWindow = this.windowManager.getMainWindow();
    const chatWindow = this.windowManager.getChatWindow();
    const artifactsWindow = this.windowManager.getArtifactsWindow();
    const notesWindow = this.windowManager.getNotesWindow();
    const indexBrowserWindow = this.windowManager.getIndexBrowserWindow();
    const researchWindow = this.windowManager.getResearchWindow();
    
    if (mainWindow && webContents === mainWindow.webContents) return 'mainWindow';
    if (chatWindow && webContents === chatWindow.webContents) return 'chatWindow';
    if (artifactsWindow && webContents === artifactsWindow.webContents) return 'artifactsWindow';
    if (notesWindow && webContents === notesWindow.webContents) return 'notesWindow';
    if (indexBrowserWindow && webContents === indexBrowserWindow.webContents) return 'indexBrowserWindow';
    if (researchWindow && webContents === researchWindow.webContents) return 'researchWindow';
    
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

  _sanitizeExternalUrl(rawUrl) {
    if (typeof rawUrl !== 'string') {
      return null;
    }

    const trimmed = rawUrl.trim();
    if (!trimmed || trimmed.length > 2048) {
      return null;
    }

    try {
      const parsed = new URL(trimmed);
      const protocol = parsed.protocol.toLowerCase();
      if (!ALLOWED_EXTERNAL_PROTOCOLS.has(protocol)) {
        return null;
      }

      // Require hostname for web URLs to avoid opening malformed browser targets.
      if ((protocol === 'http:' || protocol === 'https:') && !parsed.hostname) {
        return null;
      }

      return parsed.toString();
    } catch (_error) {
      return null;
    }
  }

  // ==========================================================================
  // Main Window Routes
  // ==========================================================================

  _registerMainWindowRoutes() {
    // Startup animation finished — create chat (hidden) + artifacts windows.
    // Chat stays hidden until the early welcome-complete signal (~2.5s into demo).
    // Fallback: if welcome-complete never arrives (init error), reveal chat after 15s.
    this._registerRoute('startup:animation-complete', () => {
      this.windowManager.createAuxWindows();

      // Safety net: reveal chat even if welcome sequence fails or never fires
      this._welcomeFallbackTimer = setTimeout(() => {
        this._welcomeFallbackTimer = null;
        this.windowManager.revealChatAfterWelcome();
      }, 15000);
    }, { allowedSources: ['mainWindow'] });

    // Welcome demo — enter widget mode on main window, reveal chat.
    // Fired early (~2.5s into demo) so user sees orb + chat simultaneously.
    this._registerRoute('startup:welcome-complete', () => {
      if (this._welcomeFallbackTimer) {
        clearTimeout(this._welcomeFallbackTimer);
        this._welcomeFallbackTimer = null;
      }
      this.windowManager.revealChatAfterWelcome();
    }, { allowedSources: ['mainWindow'] });

    // Model warmup — fire-and-forget health probe to the backend.
    // Sent at welcome start so the HTTP connection pool, backend caches,
    // and inference pipeline are warm by the time the user starts typing.
    this._registerRoute('model:warmup', () => {
      try {
        const cfg = require('../../core/config');
        const baseUrl = cfg?.backend?.baseUrl;
        if (!baseUrl) {
          this.logger.warn('model:warmup skipped — backend baseUrl not yet discovered');
          return;
        }

        // Fire-and-forget: GET /health warms the HTTP connection pool
        // and confirms the backend + inference server are responsive.
        const http = require('http');
        const url = new URL('/health', baseUrl);
        const req = http.get(url, (res) => {
          // Drain the response to free the socket
          res.resume();
          this.logger.debug(`model:warmup health probe completed (${res.statusCode})`);
        });
        req.on('error', (err) => {
          this.logger.warn('model:warmup health probe failed', { error: err.message });
        });
        req.setTimeout(5000, () => {
          req.destroy();
          this.logger.warn('model:warmup health probe timed out');
        });
      } catch (err) {
        this.logger.warn('model:warmup failed', { error: err.message });
      }
    }, { allowedSources: ['mainWindow'] });

    // App relaunch (used by onboarding and control panel restart button)
    // CRITICAL: Use app.quit(), NOT app.exit(). app.exit() bypasses
    // the before-quit handler which runs shutdown() — the only place
    // that kills the detached backend process group. Without it,
    // zombie backend processes accumulate on every relaunch.
    this._registerRoute('app:relaunch', () => {
      const { app } = require('electron');
      this.logger.info('App relaunch requested via IPC — triggering graceful shutdown');
      global.isRelaunching = true;
      app.relaunch();
      app.quit();
    }, { allowedSources: ['mainWindow'] });

    // App quit (graceful shutdown triggered by control panel quit button)
    this._registerRoute('app:quit', () => {
      const { app } = require('electron');
      this.logger.info('App quit requested via IPC — triggering before-quit lifecycle');
      app.quit();
    }, { allowedSources: ['mainWindow'] });

    // Widget mode toggle
    this._registerRoute('toggle-widget-mode', () => {
      this.windowManager.toggleWidgetMode();
    });

    // Window double-click: toggle widget mode (works both directions)
    this._registerRoute('window-double-clicked', () => {
      this.windowManager.toggleWidgetMode();
    }, { allowedSources: ['mainWindow'] });

    // Toggle chat window (create / show / hide) — sent by double-right-click
    this._registerRoute('window-toggle-chat', () => {
      const chatWindow = this.windowManager.getChatWindow();
      if (!chatWindow || chatWindow.isDestroyed()) {
        this.windowManager.createChatWindow();
        return;
      }
      if (chatWindow.isVisible()) {
        chatWindow.hide();
      } else {
        chatWindow.show();
        chatWindow.focus();
      }
    }, { allowedSources: ['mainWindow'] });

    // JS-based widget drag: start → move → end
    // The renderer sends screen-coordinate pairs; the main process snapshots
    // the window position on start and applies deltas on move.
    this._registerRoute('widget-drag-start', (event, screenPos) => {
      this.windowManager.startWidgetDrag(screenPos);
    }, { allowedSources: ['mainWindow'] });

    this._registerRoute('widget-drag-move', (event, screenPos) => {
      this.windowManager.moveWidgetDrag(screenPos);
    }, { allowedSources: ['mainWindow'] });

    this._registerRoute('widget-drag-end', () => {
      this.windowManager.endWidgetDrag();
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

    // NOTE: chat:send routing is handled in _registerChatWindowRoutes() with proper source validation
    // DO NOT register it here to avoid duplicate handlers

    // Artifacts streaming (Main → Artifacts)
    this._registerRoute('artifacts:stream', (event, data) => {
      // Validate source is main window
      if (this.options.validateSource && event.sender !== this.windowManager.getMainWindow()?.webContents) {
        this.logger.warn('artifacts:stream from non-main window');
        return;
      }
      
      this.logger.debug('Forwarding artifacts to artifacts window', {
        chatId: data?.chatId || data?.chat_id,
        artifactId: data?.artifact_id,
      });
      
      // Send to artifacts window (auto-creates + queues if needed)
      this.windowManager.sendToArtifacts('artifacts:stream', data);
      
      // Auto-show the artifacts window when an artifact stream begins
      const aw = this.windowManager.artifactsWindow;
      if (aw && aw.exists()) {
        const win = aw.getWindow();
        if (win && !win.isVisible()) {
          if (!this.windowManager.isChatInNotchMode) {
            aw.show();
          } else {
            aw.setActive(true);
          }
        }
      }
    }, { 
      allowedSources: ['mainWindow'],
      schema: (data) => data && typeof data === 'object'
    });
  }

  // ==========================================================================
  // Chat Window Routes
  // ==========================================================================

  _registerChatWindowRoutes() {
    // Window control
    this._registerRoute('chat:window-control', (event, action) => {
      this.windowManager.controlChatWindow(action);
    });
    
    // Show chat window (from main window library modal)
    this._registerRoute('chat:show-window', (event) => {
      this.windowManager.ensureChatWindowVisible();
    });
    
    // New chat request (from main window library modal)
    this._registerRoute('chat:new-requested', (event) => {
      this.windowManager.ensureChatWindowVisible();
      this.windowManager.sendToChat('chat:new-requested');
    });
    
    // Switch to specific chat (from main window library modal)
    this._registerRoute('chat:switch-to-chat', (event, data) => {
      if (data?.chatId) {
        // Ensure chat window is shown before loading
        this.windowManager.ensureChatWindowVisible();
        // Send to chat window to trigger internal chat loading
        this.windowManager.sendToChat('chat:load-specific', data);
      }
    });
    
    // Send proactive context to chat window (from main window proactive notifications)
    this._registerRoute('chat:proactive-context', (event, data) => {
      // Ensure chat window is shown when proactive context is triggered
      this.windowManager.ensureChatWindowVisible();
      // Forward proactive context to chat window
      this.windowManager.sendToChat('chat:proactive-context', data);
    });

    // Forward chat messages from chat window to main renderer
    this._registerRoute('chat:send', (event, payload) => {
      // Only forward if from chat window
      if (event.sender === this.windowManager.getChatWindow()?.webContents) {
        if (this.windowManager.chatWindow) {
          this.windowManager.chatWindow.setStreamingState(true);
        }
        this.windowManager.sendToMain('chat:send', payload);
      }
    }, { 
      allowedSources: ['chatWindow'],
      schema: (payload) => payload && typeof payload === 'object' && typeof payload.message === 'string'
    });

    // Assistant stream updates (Main → Chat)
    this._registerRoute('chat:assistant-stream', (event, data) => {
      // Enrich with metadata
      const enhancedData = {
        ...data,
        _artifactsActive: this.windowManager.isArtifactsWindowActive(),
        _timestamp: Date.now(),
      };
      
      if (this.windowManager.chatWindow) {
        // Prevent sync/status messages from blocking notch mode auto-hide
        const isStreamingContent = data && (data.type === 'message' || data.chunk || data.content);
        if (isStreamingContent) {
          this.windowManager.chatWindow.setStreamingState(true);
        }
      }
      
      this.windowManager.sendToChat('chat:assistant-stream', enhancedData);
    }, { allowedSources: ['mainWindow'] });

    // Assistant persist (separate from streaming)
    this._registerRoute('chat:assistant-persist', (event, data) => {
      this.windowManager.sendToChat('chat:assistant-stream-persist', data);
    });

    // Request completion — forward to chat renderer and schedule artifacts auto-hide
    this._registerRoute('chat:request-complete', () => {
      if (this.windowManager.chatWindow) {
        this.windowManager.chatWindow.setStreamingState(false);
      }
      this.windowManager.sendToChat('chat:request-complete');
      this.windowManager.scheduleArtifactsAutoHide();
    });

    // STT stream (Main → Chat)
    this._registerRoute('chat:stt-stream', (event, data) => {
      this.windowManager.sendToChat('chat:stt-stream', data);
    }, { allowedSources: ['mainWindow'] });

    // Stop request
    this._registerRoute('chat:stop', (event, payload = {}) => {
      if (this.windowManager.chatWindow) {
        this.windowManager.chatWindow.setStreamingState(false);
      }
      // Forward to both windows
      this.windowManager.sendToMain('chat:stop', payload);
      this.windowManager.sendToChat('chat:stop', payload);
    });

    // Artifacts streaming: Stage 2 (Chat → Artifacts with chatId)
    this._registerRoute('artifacts:stream:ready', (event, data) => {
      
      // Validate source is chat window
      if (this.options.validateSource && event.sender !== this.windowManager.getChatWindow()?.webContents) {
        this.logger.warn('artifacts:stream:ready from non-chat window');
        return;
      }
      
      this.logger.debug('Stage 2: Forwarding artifacts to artifacts window', {
        chatId: data?.chatId || data?.chat_id,
        artifactId: data?.artifact_id,
      });
      
      // Send to artifacts window (auto-creates + queues if needed)
      const result = this.windowManager.sendToArtifacts('artifacts:stream', data);
      
      // Auto-show the artifacts window when an artifact stream begins
      const aw = this.windowManager.artifactsWindow;
      if (aw && aw.exists()) {
        const win = aw.getWindow();
        if (win && !win.isVisible()) {
          if (!this.windowManager.isChatInNotchMode) {
            aw.show();
          } else {
            aw.setActive(true);
          }
        }
      }
      
    }, { 
      allowedSources: ['chatWindow'],
      schema: (data) => data && typeof data === 'object' && (typeof data.chatId === 'string' || typeof data.chat_id === 'string')
    });

    // Switch chat (notify artifacts)
    this._registerRoute('artifacts:switch-chat', (event, chatId) => {
      this.logger.debug('Forwarding artifacts:switch-chat', { chatId });
      this.windowManager.sendToArtifacts('artifacts:switch-chat', chatId);
    });

    // Artifacts focus/load/switch requests
    this._registerRoute('artifacts:focus-artifacts', (event, data) => {
      this.windowManager.focusArtifacts(data);
    });

    this._registerRoute('artifacts:switch-tab', (event, targetTab) => {
      this.windowManager.sendToArtifacts('artifacts:switch-tab', targetTab);
    });
    
    this._registerRoute('artifacts:show-artifact', (event, data) => {
      this.windowManager.ensureArtifactsWindowVisible();
      // Send the artifact data
      this.windowManager.sendToArtifacts('artifacts:show-artifact', data);
    });
    
    this._registerRoute('artifacts:show-window', (event) => {
      this.windowManager.ensureArtifactsWindowVisible();
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
      this.windowManager.sendToChat('artifacts:window-state', data);
    });

    // Mode changed
    this._registerRoute('artifacts:mode-changed', (event, mode) => {
      this.logger.debug('Artifacts mode changed', { mode });
    });

    // File operations
    this._registerRoute('artifacts:file-export', (event, payload) => {
      // Execute async operation without blocking IPC handler
      this.windowManager.exportArtifactFile(payload).catch((err) => {
        this.logger.error('Failed to export artifact file', {
          error: err.message,
          stack: err.stack,
        });
      });
    });

    this._registerRoute('artifacts:open-file', (event, payload) => {
      // Execute async operation without blocking IPC handler
      this.windowManager.openFile(payload).catch((err) => {
        this.logger.error('Failed to open file', {
          error: err.message,
          stack: err.stack,
        });
      });
    });

    // Open THIRD-PARTY-NOTICES with system text viewer.
    // Path resolved HERE in main process because preload sandbox cannot import 'path'.
    // Packaged: extraResources copies file into process.resourcesPath (see package.json build.extraResources).
    // Dev: app.getAppPath() → aether-frontend/; file is at project root (one level up).
    this._registerRoute('about:open-notices-file', () => {
      const noticesPath = app.isPackaged
        ? path.join(process.resourcesPath, 'THIRD-PARTY-NOTICES')
        : path.join(app.getAppPath(), '..', 'THIRD-PARTY-NOTICES');
      this.windowManager.openFile({ path: noticesPath }).catch((err) => {
        this.logger.error('Failed to open notices file', {
          error: err.message,
          stack: err.stack,
        });
      });
    });

    // Execute code from artifacts window via backend (route through main window chat sender).
    // SECURITY: Only artifactsWindow may request execution.
    this._registerRoute(
      'artifacts:execute-code',
      (event, payload) => {
        const mainWindow = this.windowManager.getMainWindow();
        if (!payload || typeof payload !== 'object') {
          this.logger.warn('artifacts:execute-code invalid payload');
          return;
        }
        const chatId = payload.chatId;
        const code = payload.code;
        const language = payload.language;
        if (!chatId || typeof chatId !== 'string') {
          this.logger.warn('artifacts:execute-code missing chatId');
          return;
        }
        if (!code || typeof code !== 'string') {
          this.logger.warn('artifacts:execute-code missing code');
          return;
        }
        if (!language || typeof language !== 'string') {
          this.logger.warn('artifacts:execute-code missing language');
          return;
        }

        // Build a strict execution prompt. No hardcoded URLs; standard chat send pipeline handles routing.
        const prompt =
          `Run the following ${language} code EXACTLY as written. ` +
          `Do not rewrite the code. Execute it and return the result/output.\n\n` +
          `\`\`\`${language}\n${code}\n\`\`\``;

        // Forward into the same channel the main window already uses to send to backend.
        // This keeps a single source of truth for message sending (main window).
        this.windowManager.sendToMain('chat:send', {
          message: prompt,
          chatId,
          metadata: {
            source: 'artifacts_execute',
            language,
            artifactId: payload.artifactId || null,
          },
        });
      },
      { allowedSources: ['artifactsWindow'] }
    );
  }

  // ==========================================================================
  // Utility Routes
  // ==========================================================================

  _registerUtilityRoutes() {
    // Forward window controls to main window
    this._registerRoute('window:open-agents', (event) => {
      const mainWindow = this.windowManager.getMainWindow();
      if (mainWindow) {
        mainWindow.show();
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
      this.windowManager.sendToMain('window:open-agents');
    }, { allowedSources: ['chatWindow', 'mainWindow'] });

    // Utility Routes
    this._registerRoute('window:open-notes', (event, data) => {
      this.windowManager.createNotesWindow();
      if (data) {
        this.windowManager.sendToNotes('notes:init', data);
      }
    }, { allowedSources: ['mainWindow', 'chatWindow', 'artifactsWindow'] });

    // Index Browser Window Routes
    this._registerRoute('window:open-index-browser', (event, data) => {
      this.windowManager.createIndexBrowserWindow();
      this.windowManager.enterWidgetMode(); // Auto-minimize main window
      // ALWAYS send init so the renderer knows it was reopened and can refresh if needed
      this.windowManager.sendToIndexBrowser('index-browser:init', data || null);
    }, { allowedSources: ['mainWindow', 'chatWindow', 'artifactsWindow'] });

    this._registerRoute('window:open-research', (event, data) => {
      this.windowManager.createResearchWindow();
      this.windowManager.enterWidgetMode(); // Auto-minimize main window
      if (data) {
        this.windowManager.sendToResearch('research:init', data);
      }
    }, { allowedSources: ['mainWindow', 'chatWindow', 'artifactsWindow', 'indexBrowserWindow'] });

    // Notes Window Routes
    this._registerRoute('notes:window-control', (event, action) => {
      this.windowManager.controlNotesWindow(action);
    }, { allowedSources: ['notesWindow'] });

    // Index Browser Window Routes
    this._registerRoute('index-browser:window-control', (event, action) => {
      this.windowManager.controlIndexBrowserWindow(action);
    }, { allowedSources: ['indexBrowserWindow'] });

    // Research Window Routes
    this._registerRoute('research:window-control', (event, action) => {
      this.windowManager.controlResearchWindow(action);
    }, { allowedSources: ['researchWindow'] });

    // Renderer logging
    this._registerRoute('renderer-log', (event, message) => {
      const windowName = this._getWindowName(event.sender);
      this.logger.info(`[Renderer:${windowName}] ${message}`);
    });

    // Open external URL
    this._registerRoute('open-external-url', async (event, url) => {
      const { shell } = require('electron');
      const safeUrl = this._sanitizeExternalUrl(url);
      if (!safeUrl) {
        this.logger.warn('Rejected external URL payload', {
          source: this._getWindowName(event.sender),
        });
        return;
      }

      try {
        await shell.openExternal(safeUrl);
      } catch (err) {
        this.logger.error('Failed to open external URL', {
          url: safeUrl,
          error: err.message,
        });
      }
    }, { allowedSources: ['mainWindow'] });

    // System stats (using handle for async response)
    this._registerHandle('system:get-stats', async () => {
      if (this.systemMonitor) {
        return this.systemMonitor.getStats();
      }
      return null;
    });

    // Diagnostics: return log file paths so the renderer can display them
    this._registerHandle('app:get-log-paths', async () => {
      const { app } = require('electron');
      const path = require('path');
      const userDataPath = app.getPath('userData');
      const logsDir = path.join(userDataPath, 'logs');
      return {
        logsDirectory: logsDir,
        frontendLog: path.join(logsDir, 'aether.log'),
        backendSpawnLog: path.join(logsDir, 'backend-spawn.log'),
        userData: userDataPath,
      };
    });

    // Diagnostics: open logs folder in system file manager
    this._registerHandle('app:open-log-directory', async () => {
      const { app, shell } = require('electron');
      const path = require('path');
      const logsDir = path.join(app.getPath('userData'), 'logs');
      const result = await shell.openPath(logsDir);
      if (result) {
        this.logger.warn('Failed to open logs directory:', result);
      }
      return { success: !result, path: logsDir };
    });

    // Widget mode state query: renderer can sync after late initialization.
    // When the window enters widget mode during the startup splash, the renderer
    // misses the enter-widget-mode IPC (no listener registered yet). This handle
    // lets MainApp query the authoritative state from the main process on init.
    this._registerHandle('widget-mode:get-state', async () => {
      return { isWidgetMode: this.windowManager.isWidgetMode };
    });

    // Panel Dock: query current aux window visibility (one-shot on mount)
    this._registerHandle('aux:get-visibility', async () => {
      return this.windowManager.getAuxVisibility();
    });

    // Backend URL (authoritative, post-discovery)
    // SECURITY: Do not expose internal service registry; renderer only needs backend baseUrl.
    this._registerHandle('backend:get-url', async () => {
      // Lazy require to avoid early init/circular dependency risks.
      // In main/index.js we run PortManager discovery before renderer requests should happen.
      const cfg = require('../../core/config');
      const baseUrl = cfg?.backend?.baseUrl;
      if (!baseUrl || typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
        throw new Error('[IpcRouter] Backend baseUrl unavailable (start/discover backend first)');
      }
      return baseUrl.replace(/\/$/, '');
    });

    // Dialog handlers for native file pickers.
    // Pass the parent BrowserWindow so macOS opens the dialog ON TOP of the app
    // instead of behind it (which minimises the window).
    this._registerHandle('dialog:show-directory-picker', async () => {
      try {
        const parentWindow = this.windowManager.getMainWindow();
        const result = await dialog.showOpenDialog(parentWindow, {
          properties: ['openDirectory', 'createDirectory'],
          title: 'Select Directory to Index'
        });
        
        if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
          return null;
        }
        
        return result.filePaths[0];
      } catch (error) {
        this.logger.error('Directory picker failed:', error);
        return null;
      }
    });

    this._registerHandle('dialog:show-file-picker', async (event, options = {}) => {
      try {
        const dialogOptions = {
          properties: ['openFile'],
          title: 'Select File'
        };
        
        if (options.multiSelections) {
          dialogOptions.properties.push('multiSelections');
        }
        
        if (options.filters && Array.isArray(options.filters)) {
          dialogOptions.filters = options.filters;
        }
        
        const parentWindow = this.windowManager.getMainWindow();
        const result = await dialog.showOpenDialog(parentWindow, dialogOptions);
        
        if (result.canceled || !result.filePaths) {
          return null;
        }
        
        return result.filePaths;
      } catch (error) {
        this.logger.error('File picker failed:', error);
        return null;
      }
    });

    this._registerHandle('dialog:save-file', async (event, { content, defaultPath, filters }) => {
      try {
        const fs = require('fs');
        const mainWindow = this.windowManager.getMainWindow();
        const result = await dialog.showSaveDialog(mainWindow, {
          title: 'Save File',
          defaultPath: defaultPath || 'notes.md',
          filters: filters || [{ name: 'Text Files', extensions: ['txt', 'md'] }],
          properties: ['createDirectory', 'showOverwriteConfirmation']
        });

        if (result.canceled || !result.filePath) {
          return { success: false, error: 'Canceled' };
        }

        fs.writeFileSync(result.filePath, content, 'utf-8');
        return { success: true, filePath: result.filePath };
      } catch (error) {
        this.logger.error('File save failed:', error);
        return { success: false, error: error.message };
      }
    });

    this._registerHandle('dialog:read-file', async (event, { filters } = {}) => {
      try {
        const fs = require('fs');
        const path = require('path');
        const mainWindow = this.windowManager.getMainWindow();
        const result = await dialog.showOpenDialog(mainWindow, {
          title: 'Open File',
          filters: filters || [{ name: 'Text Files', extensions: ['txt', 'md'] }],
          properties: ['openFile']
        });

        if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
          return null;
        }

        const filePath = result.filePaths[0];
        const content = fs.readFileSync(filePath, 'utf-8');
        const filename = path.basename(filePath);
        return { content, filePath, filename };
      } catch (error) {
        this.logger.error('File read failed:', error);
        return null;
      }
    });

    this._registerHandle('file:read-by-path', async (event, { path: filePath }) => {
      try {
        const fs = require('fs');
        const path = require('path');
        
        if (!filePath || !fs.existsSync(filePath)) {
          return { success: false, error: 'File not found' };
        }
        
        const stats = fs.statSync(filePath);
        // 20MB limit
        if (stats.size > 20 * 1024 * 1024) {
          return { success: false, error: 'File too large (exceeds 20MB limit)' };
        }
        
        const filename = path.basename(filePath);
        const ext = path.extname(filePath).toLowerCase();
        
        // Detect binary/image types
        const binaryExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf'];
        const isBinary = binaryExts.includes(ext);
        
        let content;
        if (isBinary) {
          const buffer = fs.readFileSync(filePath);
          content = buffer.toString('base64');
          
          if (ext === '.pdf') {
            content = `data:application/pdf;base64,${content}`;
          } else if (ext === '.png') {
            content = `data:image/png;base64,${content}`;
          } else if (ext === '.jpg' || ext === '.jpeg') {
            content = `data:image/jpeg;base64,${content}`;
          } else if (ext === '.gif') {
            content = `data:image/gif;base64,${content}`;
          } else if (ext === '.webp') {
            content = `data:image/webp;base64,${content}`;
          }
        } else {
          content = fs.readFileSync(filePath, 'utf-8');
        }
        
        return { success: true, content, filename, isBinary };
      } catch (error) {
        this.logger.error('file:read-by-path failed:', error);
        return { success: false, error: error.message };
      }
    });

    this._registerHandle('dialog:save-pdf', async (event, { html, filename }) => {
      try {
        const { BrowserWindow } = require('electron');
        const fs = require('fs');
        const path = require('path');

        this.logger.info(`IpcRouter: Starting PDF export for ${filename}`);

        // 1. Get main window to use as parent
        const mainWindow = this.windowManager.getMainWindow();
        
        this.logger.info(`IpcRouter: Using main window for dialog: ${!!mainWindow}`);

        // 2. Ask for save location
        // Try with parent window first, then without if it fails
        let filePath, canceled;
        try {
          const result = await dialog.showSaveDialog(mainWindow, {
            title: 'Export Findings as PDF',
            defaultPath: filename || 'findings.pdf',
            filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
            properties: ['createDirectory', 'showOverwriteConfirmation']
          });
          filePath = result.filePath;
          canceled = result.canceled;
        } catch (dialogErr) {
          this.logger.warn('IpcRouter: showSaveDialog with parent failed, retrying without parent', dialogErr);
          const result = await dialog.showSaveDialog({
            title: 'Export Findings as PDF',
            defaultPath: filename || 'findings.pdf',
            filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
            properties: ['createDirectory', 'showOverwriteConfirmation']
          });
          filePath = result.filePath;
          canceled = result.canceled;
        }

        if (canceled || !filePath) {
          this.logger.info('IpcRouter: PDF export canceled by user');
          return { success: false, error: 'Canceled' };
        }

        this.logger.info(`IpcRouter: Saving PDF to ${filePath}`);

        // 3. Create a hidden window to render the HTML
        let printWin = new BrowserWindow({
          show: false,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
          }
        });

        // Use a data URL for the HTML content
        const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
        
        await new Promise((resolve, reject) => {
          printWin.webContents.once('did-finish-load', resolve);
          printWin.webContents.once('did-fail-load', (e, code, desc) => reject(new Error(desc)));
          printWin.loadURL(dataUrl);
        });

        // 4. Print to PDF
        const pdfData = await printWin.webContents.printToPDF({
          printBackground: true,
          marginsType: 0,
          pageSize: 'A4'
        });

        // 5. Save file
        fs.writeFileSync(filePath, pdfData);
        
        // 6. Cleanup
        printWin.destroy();
        printWin = null;

        this.logger.info('IpcRouter: PDF export successful');
        return { success: true, filePath };
      } catch (error) {
        this.logger.error('IpcRouter: PDF export failed:', error);
        return { success: false, error: error.message };
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
