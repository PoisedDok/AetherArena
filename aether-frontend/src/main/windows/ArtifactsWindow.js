'use strict';

/**
 * @.architecture
 * 
 * Incoming: WindowManager (create, send, control methods), BrowserWindow events (close, closed, did-finish-load) --- {method_call | electron_event, void | Event}
 * Processing: Create frameless opaque BrowserWindow (preload artifacts-preload.js), attach ExternalLinkHandler + PermissionHandler (clipboard), load index.html, queue messages while loading (messageQueue array), flush queue on did-finish-load, hide on close (not destroy unless isQuitting), send IPC to renderer (artifacts:ensure-visible, artifacts:*), provide control methods (minimize, maximize, close → hide, toggle-visibility), track isActive state, resizable window via Electron native, DevTools in development --- {8 jobs: JOB_CREATE_DOM_ELEMENT, JOB_DISPOSE, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_INITIALIZE, JOB_LOAD_FROM_DB, JOB_SEND_IPC, JOB_UPDATE_STATE}
 * Outgoing: BrowserWindow (artifacts window), IPC to renderer (artifacts:* events) --- {electron_window | ipc_message, BrowserWindow | void}
 * 
 * 
 * @module main/windows/ArtifactsWindow
 * 
 * Artifacts Window
 * ============================================================================
 * Code execution and output display window.
 * 
 * Features:
 * - Standalone resizable window (Electron native drag/resize)
 * - Hide on close (preserve state)
 * - Message queueing while loading
 * - Transparent window background (glass surfaces rendered in renderer + optional native material)
 * 
 * @module main/windows/ArtifactsWindow
 */

const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { logger } = require('../../core/utils/logger');
const config = require('../../core/config');
const { resolvePreloadPath } = require('../utils/preload-utils');
const { attachToWindow: attachExternalLinkHandler } = require('../security/ExternalLinkHandler');
const { attachToWindow: attachPermissionHandler, PERMISSIONS } = require('../security/PermissionHandler');

// ============================================================================
// ArtifactsWindow Class
// ============================================================================

class ArtifactsWindow {
  constructor(options = {}) {
    this.options = {
      width: options.width || 560,
      height: options.height || 640,
      isQuitting: false, // Shared quitting flag
      ...options,
    };
    
    this.logger = logger.child({ module: 'ArtifactsWindow' });
    this.window = null;
    this.messageQueue = [];
    this.isActive = false;

    // Renderer readiness gate: true only after the renderer's async bootstrap
    // completes and IPC listeners are registered. Prevents queue flush and
    // direct sends from racing ahead of renderer initialization.
    this._rendererReady = false;
    this._hasRendererReadyIpc = false;
    this._rendererReadyHandler = null;
    this._rendererReadyTimeout = null;

    // Fade animation state (§2 DEVELOPMENT_PROTOCOL lifecycle)
    this._isFading = false;
    this._fadeTimeoutId = null;
  }

  /**
   * Set quitting flag (shared state)
   */
  setQuitting(isQuitting) {
    this.options.isQuitting = isQuitting;
  }

  /**
   * Create the artifacts window
   */
  create() {
    if (this.window && !this.window.isDestroyed()) {
      this.logger.warn('Artifacts window already exists');
      this.window.show();
      return this.window;
    }
    
    // Reset renderer readiness on fresh window creation
    this._rendererReady = false;
    this._cleanupRendererReadyListener();
    
    this.logger.info('Creating artifacts window');
    
    const windowOptions = {
      show: this.options.show !== false,   // Default visible; pass show:false to create hidden
      width: this.options.width,
      height: this.options.height,
      frame: false,
      transparent: true,
      backgroundColor: this.options.backgroundColor || config.ui.artifactsWindowBackgroundColor,
      hasShadow: false,
      alwaysOnTop: true,
      resizable: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        preload: resolvePreloadPath(__dirname, 'artifacts-preload.js'),
      },
    };

    if (config.ui.enableNativeWindowEffects && process.platform === 'darwin') {
      windowOptions.vibrancy = config.ui.macVibrancy;
      windowOptions.visualEffectState = config.ui.macVisualEffectState;
    }

    this.window = new BrowserWindow(windowOptions);

    // Windows: use native background material if available (Electron version dependent)
    if (config.ui.enableNativeWindowEffects && process.platform === 'win32') {
      try {
        if (typeof this.window.setBackgroundMaterial === 'function') {
          this.window.setBackgroundMaterial(config.ui.windowsBackgroundMaterial);
        }
      } catch (error) {
        this.logger.debug('Background material not supported or failed to apply', { error: error.message });
      }
    }

    // Ensure transparent background
    try {
      this.window.setBackgroundColor('#00000000');
    } catch (error) {
    }
    
    // Attach security handlers
    this._attachSecurityHandlers();
    
    // Load HTML file
    this._loadHTML();
    
    // Setup event handlers
    this._setupEventHandlers();
    
    // Open DevTools in development (aux windows opt-in)
    if ((process.env.ELECTRON_DEV === 'true' || process.env.NODE_ENV === 'development') && config.dev.openDevToolsAux) {
      this.window.webContents.openDevTools({ mode: 'detach' });
    }
    
    this.logger.info('Artifacts window created');
    
    return this.window;
  }

  /**
   * Attach security handlers
   */
  _attachSecurityHandlers() {
    // External link protection
    attachExternalLinkHandler(this.window);
    
    // Permission handler
    attachPermissionHandler(this.window, {
      [PERMISSIONS.CLIPBOARD_SANITIZED_WRITE]: true,
    });
  }

  /**
   * Load HTML file
   */
  _loadHTML() {
    const htmlPath = path.join(__dirname, '../../renderer/artifacts/index.html');
    this.logger.debug('Loading HTML', { htmlPath });
    
    this.window.loadFile(htmlPath).catch(err => {
      this.logger.error('Failed to load HTML', {
        htmlPath,
        error: err.message,
      });
    });
  }

  /**
   * Setup event handlers
   */
  _setupEventHandlers() {
    // Renderer-ready handshake: The renderer sends 'artifacts:renderer-ready'
    // AFTER its async bootstrap completes and all IPC listeners are registered.
    // This replaces the old did-finish-load flush which fired too early —
    // did-finish-load means HTML loaded, NOT that the renderer's JS controller
    // is initialized. Messages flushed before the controller is ready are
    // silently dropped by ipcRenderer (no listeners attached yet).
    this._rendererReadyHandler = (event) => {
      // Security: only accept from our own webContents
      if (this.window && !this.window.isDestroyed() && event.sender === this.window.webContents) {
        this._rendererReady = true;
        this.logger.info('Renderer signaled ready — flushing message queue');
        this._flushQueue();
        this._cleanupRendererReadyListener();
      }
    };
    this._hasRendererReadyIpc = !!(ipcMain && typeof ipcMain.on === 'function');
    if (this._hasRendererReadyIpc) {
      ipcMain.on('artifacts:renderer-ready', this._rendererReadyHandler);
      ipcMain.on('artifacts:hide-completed', (event) => {
        if (!this.window || this.window.isDestroyed() || event.sender !== this.window.webContents) return;
        if (this._isFading) {
          this._clearFade();
          this.window.hide();
        }
      });
    } else {
      this.logger.warn('ipcMain unavailable; falling back to did-finish-load queue flush');
      // Test/non-main environments cannot receive renderer-ready IPC.
      // Consider renderer ready for direct sends once loading is complete.
      this._rendererReady = true;
    }

    // Fallback: If renderer bootstrap fails or hangs, flush after timeout
    // so the window isn't permanently stuck with a stale queue.
    this.window.webContents.once('did-finish-load', () => {
      try {
        this.window.webContents.send('artifacts:ensure-visible');
      } catch (err) {
        this.logger.error('Failed to send ensure-visible', { error: err.message });
      }

      if (!this._hasRendererReadyIpc) {
        // Test/non-main fallback: no renderer-ready IPC path available.
        this._rendererReady = true;
        this._flushQueue();
        return;
      }

      this._rendererReadyTimeout = setTimeout(() => {
        if (!this._rendererReady && this.exists()) {
          this.logger.warn('Renderer did not signal ready within 15s — force flushing queue');
          this._rendererReady = true;
          this._flushQueue();
          this._cleanupRendererReadyListener();
        }
      }, 15000);
    });
    
    // Forward renderer console to terminal (development mode)
    // FILTER: Only show WARN, ERROR, and custom console.log (skip DEBUG/INFO from logger)
    if (process.env.ELECTRON_DEV === 'true' || process.env.NODE_ENV === 'development') {
      this.window.webContents.on('console-message', (event, level, message, line, sourceId) => {
        // level: 0=DEBUG, 1=INFO, 2=WARN, 3=ERROR
        // Skip DEBUG(0) and INFO(1) - they flood the terminal
        if (level >= 2) {
          const levelMap = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
          const levelStr = levelMap[level] || 'LOG';
          const source = sourceId ? ` (${path.basename(sourceId)}:${line})` : '';
          console.log(`[ArtifactsWindow:${levelStr}]${source} ${message}`);
        }
      });
    }
    
    // Close event: fade-hide instead of instant hide
    this.window.on('close', (event) => {
      if (!this.options.isQuitting) {
        event.preventDefault();
        this.fadeHide();
      }
    });
    
    // Prevent accidental reload shortcuts (Cmd+R, Cmd+Shift+R, F5) which can break state
    this.window.webContents.on('before-input-event', (event, input) => {
      const isReload = (input.key.toLowerCase() === 'r' && (input.control || input.meta)) || input.key === 'F5';
      // If we intercept a reload command, we should block it to prevent white screen/crashes
      if (input.type === 'keyDown' && isReload) {
        if (!this.window.webContents.isDevToolsFocused()) {
          event.preventDefault();
          this.logger.debug('Blocked reload shortcut', { key: input.key, shift: input.shift, meta: input.meta, ctrl: input.control });
        }
      }
    });
    
    // Closed event
    this.window.on('closed', () => {
      this.logger.info('Artifacts window closed');
      this.window = null;
      this.messageQueue = [];
    });
  }

  /**
   * Send message to artifacts window (with queueing)
   */
  send(channel, ...args) {
    if (!this.exists()) {
      this.logger.warn('Cannot send to destroyed window', { channel });
      return false;
    }
    
    // Queue if HTML is still loading OR renderer hasn't finished bootstrapping.
    // The renderer signals readiness via 'artifacts:renderer-ready' IPC after
    // its async init completes and IPC listeners are registered. Without this
    // gate, messages arrive at ipcRenderer before any listener is attached
    // and are silently dropped — causing the blank artifacts window bug.
    if (this.window.webContents.isLoading() || !this._rendererReady) {
      this.logger.debug('Queueing message (renderer not ready)', { channel, rendererReady: this._rendererReady });
      this.messageQueue.push({ channel, args });
      return true;
    }
    
    // Send immediately
    try {
      this.window.webContents.send(channel, ...args);
      return true;
    } catch (err) {
      this.logger.error('Failed to send message', {
        channel,
        error: err.message,
      });
      return false;
    }
  }

  /**
   * Flush queued messages
   */
  _flushQueue() {
    if (this.messageQueue.length === 0) return;
    
    this.logger.debug('Flushing message queue', {
      count: this.messageQueue.length,
    });
    
    const failedMessages = [];
    
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      
      try {
        this.window.webContents.send(message.channel, ...message.args);
      } catch (err) {
        this.logger.error('Failed to send queued message', {
          channel: message.channel,
          error: err.message,
        });
        // Re-queue failed message
        failedMessages.push(message);
      }
    }
    
    // Re-add failed messages to front of queue for retry
    if (failedMessages.length > 0) {
      this.messageQueue.unshift(...failedMessages);
      this.logger.warn('Re-queued failed messages', {
        count: failedMessages.length,
      });
    }
  }

  /**
   * Set active state
   */
  setActive(isActive) {
    this.isActive = isActive;
    this.logger.debug('Active state changed', { isActive });
  }

  /**
   * Get active state
   */
  getActive() {
    return this.isActive;
  }

  /**
   * Get window instance
   */
  getWindow() {
    return this.window;
  }

  /**
   * Check if window exists
   */
  exists() {
    return this.window && !this.window.isDestroyed();
  }

  /**
   * Show window. Cancels any in-progress fade so the window
   * reappears at full opacity immediately.
   * Also clears the one-shot show:false flag so future re-creates
   * produce visible windows (the flag is only for initial startup).
   */
  show() {
    if (this.options.show === false) {
      delete this.options.show;
    }
    if (this.exists()) {
      this.cancelFade();
      this.window.show();
      this.window.focus();
      try {
        this.window.webContents.send('artifacts:ensure-visible');
      } catch (err) {
        this.logger.debug('Failed to send ensure-visible', { error: err.message });
      }
    } else {
      this.create();
    }
  }

  /**
   * Hide window with a smooth fade-out animation.
   * Programmatic callers that need an instant hide (e.g. startup)
   * should call window.hide() on the BrowserWindow directly.
   */
  hide() {
    if (this.exists()) {
      this.fadeHide();
    }
  }

  // ==========================================================================
  // Fade Animation
  // ==========================================================================

  /**
   * Animate opacity from 1 → 0 over ~300ms, then hide the window
   * and restore opacity to 1 for the next show().
   * Idempotent — skips if already fading, not visible, or quitting.
   */
  fadeHide() {
    if (!this.exists() || !this.window.isVisible() || this._isFading) return;

    // Skip animation during quit — hide immediately for fast shutdown
    if (this.options.isQuitting) {
      this.window.hide();
      return;
    }

    this._isFading = true;
    
    // Tell renderer to initiate CSS transition
    this.send('artifacts:initiate-hide');

    // Safety timeout in case renderer is stuck or takes too long
    // 300ms transition + 100ms buffer
    this._fadeTimeoutId = setTimeout(() => {
      if (this.exists() && this._isFading) {
        this.logger.debug('fadeHide timeout reached, forcing hide');
        this._clearFade();
        this.window.hide();
      }
    }, 400);
  }

  /**
   * Cancel an in-progress fade and restore full opacity immediately.
   * Called by show() so reopening during a fade is instant.
   */
  cancelFade() {
    if (!this._isFading) return;
    this._clearFade();
    this.send('artifacts:cancel-hide');
  }

  /**
   * Internal: clear the fade timeout and reset the flag.
   * @private
   */
  _clearFade() {
    if (this._fadeTimeoutId) {
      clearTimeout(this._fadeTimeoutId);
      this._fadeTimeoutId = null;
    }
    this._isFading = false;
  }

  /**
   * Focus window
   */
  focus() {
    if (this.exists()) {
      this.window.focus();
    }
  }

  /**
   * Toggle visibility. Routes through show()/hide() so fade and
   * one-shot flag cleanup are always applied.
   */
  toggleVisibility() {
    if (this.exists()) {
      if (this.window.isVisible()) {
        this.hide();
      } else {
        this.show();
      }
    } else {
      this.show();
    }
  }

  /**
   * Minimize window
   */
  minimize() {
    if (this.exists()) {
      this.window.minimize();
    }
  }

  /**
   * Maximize window
   */
  maximize() {
    if (this.exists()) {
      if (this.window.isMaximized()) {
        this.window.unmaximize();
      } else {
        this.window.maximize();
      }
    }
  }

  /**
   * Control window (handle window control actions)
   */
  control(action) {
    switch (action) {
      case 'minimize':
        this.minimize();
        break;
      case 'maximize':
        this.maximize();
        break;
      case 'close':
        this.hide();
        break;
      case 'toggle-visibility':
        this.toggleVisibility();
        break;
      default:
        this.logger.warn('Unknown control action', { action });
        break;
    }
  }

  /**
   * Clean up the renderer-ready IPC listener and timeout.
   * @private
   */
  _cleanupRendererReadyListener() {
    if (this._rendererReadyHandler && ipcMain && typeof ipcMain.removeListener === 'function') {
      ipcMain.removeListener('artifacts:renderer-ready', this._rendererReadyHandler);
    }
    this._rendererReadyHandler = null;
    this._hasRendererReadyIpc = false;
    if (this._rendererReadyTimeout) {
      clearTimeout(this._rendererReadyTimeout);
      this._rendererReadyTimeout = null;
    }
  }

  /**
   * Destroy window. Cancels any pending fade first.
   */
  destroy() {
    this.cancelFade();
    this._cleanupRendererReadyListener();
    this._rendererReady = false;
    if (this.exists()) {
      this.logger.info('Destroying artifacts window');
      this.window.destroy();
      this.window = null;
      this.messageQueue = [];
    }
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = ArtifactsWindow;
