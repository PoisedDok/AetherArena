'use strict';

/**
 * @.architecture
 * 
 * Incoming: WindowManager (create, control methods), BrowserWindow events (close, closed, did-finish-load) --- {method_call | electron_event, void | Event}
 * Processing: Create frameless transparent BrowserWindow (preload chat-preload.js), attach ExternalLinkHandler + PermissionHandler (clipboard), load index.html, hide on close (not destroy unless isQuitting), send IPC to renderer (chat:ensure-visible), provide control methods (minimize, maximize, close → hide, toggle-visibility), resizable window, alwaysOnTop, DevTools in development --- {8 jobs: JOB_CREATE_DOM_ELEMENT, JOB_DISPOSE, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_INITIALIZE, JOB_LOAD_FROM_DB, JOB_SEND_IPC, JOB_UPDATE_STATE}
 * Outgoing: BrowserWindow (chat window), IPC to renderer (chat:ensure-visible) --- {electron_window | ipc_message, BrowserWindow | void}
 * 
 * 
 * @module main/windows/ChatWindow
 * 
 * Chat Window
 * ============================================================================
 * Dedicated chat interface window.
 * 
 * Features:
 * - Floating, resizable window
 * - Hide on close (preserve state)
 * - Always on top
 * - Transparent, frameless
 * 
 * @module main/windows/ChatWindow
 */

const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const { logger } = require('../../core/utils/logger');
const config = require('../../core/config');
const { resolvePreloadPath } = require('../utils/preload-utils');
const { attachToWindow: attachExternalLinkHandler } = require('../security/ExternalLinkHandler');
const { attachToWindow: attachPermissionHandler, PERMISSIONS } = require('../security/PermissionHandler');

// ============================================================================
// ChatWindow Class
// ============================================================================

class ChatWindow {
  constructor(options = {}) {
    this.options = {
      width: options.width || 520,
      height: options.height || 640,
      isQuitting: false, // Shared quitting flag
      ...options,
    };
    
    this.logger = logger.child({ module: 'ChatWindow' });
    this.window = null;
    this.messageQueue = [];

    // Renderer readiness gate
    this._rendererReady = false;
    this._hasRendererReadyIpc = false;
    this._rendererReadyHandler = null;
    this._rendererReadyTimeout = null;

    // Clean work mode state
    this._isCleanMode = false;
    this._cleanModeBounds = null;
    this._normalBounds = null; // Continuously tracked: last known non-maximized, non-clean bounds
    this._lastCleanModeToggle = 0; // Dedup timestamp (maximize event + IPC can both fire)

    // Fade animation state (§2 DEVELOPMENT_PROTOCOL lifecycle)
    this._isFading = false;
    this._fadeTimeoutId = null;

    // Notch mode state
    this._isNotchMode = false;
    this._notchModeBounds = null;
    this._isStreaming = false;
  }

  setStreamingState(isStreaming) {
    this._isStreaming = isStreaming;
  }

  /**
   * Set quitting flag (shared state)
   */
  setQuitting(isQuitting) {
    this.options.isQuitting = isQuitting;
  }

  /**
   * Create the chat window
   */
  create() {
    if (this.window && !this.window.isDestroyed()) {
      this.logger.warn('Chat window already exists');
      this.window.show();
      return this.window;
    }
    
    // Reset renderer readiness on fresh window creation
    this._rendererReady = false;
    this._cleanupRendererReadyListener();
    
    this.logger.info('Creating chat window');
    
    const windowOptions = {
      show: this.options.show !== false,   // Default visible; pass show:false to create hidden
      width: this.options.width,
      height: this.options.height,
      frame: false,
      transparent: true,
      backgroundColor: this.options.backgroundColor || config.ui.chatWindowBackgroundColor,
      hasShadow: false,
      alwaysOnTop: true,
      resizable: true,
      maximizable: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        preload: resolvePreloadPath(__dirname, 'chat-preload.js'),
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
    
    // Set opacity
    this.window.setOpacity(1.0);
    
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
    
    this.logger.info('Chat window created');
    
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
    const htmlPath = path.join(__dirname, '../../renderer/chat/index.html');
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
    // Renderer-ready handshake: The renderer sends 'chat:renderer-ready'
    // AFTER its async bootstrap completes and all IPC listeners are registered.
    this._rendererReadyHandler = (event) => {
      // Security: only accept from our own webContents
      if (this.window && !this.window.isDestroyed() && event.sender === this.window.webContents) {
        this._rendererReady = true;
        this.logger.info('Renderer signaled ready — flushing message queue');
        this._flushQueue();
        this._cleanupRendererReadyListener();
      }
    };
    this._notchProximityHandler = (event, data) => {
      if (this.window && !this.window.isDestroyed() && event.sender === this.window.webContents) {
        this._updateNotchActivity(data.hovering);
      }
    };
    this._hasRendererReadyIpc = !!(ipcMain && typeof ipcMain.on === 'function');
    if (this._hasRendererReadyIpc) {
      ipcMain.on('chat:renderer-ready', this._rendererReadyHandler);
      ipcMain.on('chat:notch-proximity', this._notchProximityHandler);
      ipcMain.on('chat:hide-completed', (event) => {
        if (!this.window || this.window.isDestroyed() || event.sender !== this.window.webContents) return;
        if (this._isFading) {
          this._clearFade();
          this.window.hide();
        }
      });
    } else {
      this.logger.warn('ipcMain unavailable; falling back to did-finish-load queue flush');
      this._rendererReady = true;
    }

    // Did finish load: ensure visibility
    this.window.webContents.once('did-finish-load', () => {
      try {
        this.window.webContents.send('chat:ensure-visible');
      } catch (err) {
        this.logger.error('Failed to send ensure-visible', {
          error: err.message,
        });
      }

      if (!this._hasRendererReadyIpc) {
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
          console.log(`[ChatWindow:${levelStr}]${source} ${message}`);
        }
      });
    }
    
    // Track normal (non-maximized, non-clean, non-notch) bounds for reliable restore.
    // Saved on every move/resize so we never lose the user's last floating position.
    this._normalBounds = this.window.getBounds();
    const trackNormalBounds = () => {
      if (this.window && !this.window.isDestroyed() && !this.window.isMaximized() && !this._isCleanMode && !this._isNotchMode) {
        this._normalBounds = this.window.getBounds();
      }
    };
    this.window.on('move', trackNormalBounds);
    this.window.on('resize', trackNormalBounds);

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
      this.logger.info('Chat window closed');
      this.window = null;
      this.messageQueue = [];
    });
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
        this.window.webContents.send('chat:ensure-visible');
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
    this.send('chat:initiate-hide');

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
    this.send('chat:cancel-hide');
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
   * Toggle clean work mode: dock to top-center (wide, short) for focused work,
   * or restore to previous floating position.
   *
   * Clean mode: 65% of screen width, 320px height, top-center of work area.
   * Leaves the bottom of the screen visible for the visualizer/desktop.
   *
   * Uses setBounds(bounds, false) — the second arg disables macOS animation,
   * so the transition from maximized state is instant (no flash).
   */
  toggleCleanMode() {
    if (!this.exists()) return;

    // Dedup guard: both the maximize-event interceptor and the renderer IPC
    // handler can fire for the same double-click. Collapse duplicates within 300ms.
    const now = Date.now();
    if (now - this._lastCleanModeToggle < 300) return;
    this._lastCleanModeToggle = now;

    if (this._isCleanMode) {
      this._isCleanMode = false; // Set before setBounds so resize event properly captures restore bounds
      
      // Restore to the last known normal (floating) bounds.
      // _cleanModeBounds holds the snapshot taken when entering clean mode.
      // Falls back to continuously-tracked _normalBounds, then constructor defaults.
      const restoreBounds = this._cleanModeBounds
        || this._normalBounds
        || { x: 100, y: 100, width: this.options.width, height: this.options.height };
      
      this.window.setBounds(restoreBounds, false);
      this.logger.debug('Exited clean work mode');
    } else {
      // Save current normal bounds for restore. If currently maximized (OS zoom
      // intercepted), use the continuously-tracked _normalBounds instead of the
      // maximized bounds.
      this._cleanModeBounds = this.window.isMaximized()
        ? (this._normalBounds || { x: 100, y: 100, width: this.options.width, height: this.options.height })
        : this.window.getBounds();

      // Calculate clean mode bounds relative to the primary display work area
      const primaryDisplay = screen.getPrimaryDisplay();
      const workArea = primaryDisplay.workArea;

      const cleanWidth = Math.round(workArea.width * 0.65);
      const cleanHeight = 320;
      const cleanX = workArea.x + Math.round((workArea.width - cleanWidth) / 2);
      const cleanY = workArea.y;

      this._isCleanMode = true; // Set BEFORE setBounds to prevent trackNormalBounds from overwriting state

      this.window.setBounds({
        x: cleanX,
        y: cleanY,
        width: cleanWidth,
        height: cleanHeight,
      }, false);
      
      this.logger.debug('Entered clean work mode', { width: cleanWidth, height: cleanHeight });
    }
  }

  /**
   * Toggle notch mode: dock compactly to top of screen, auto-hide when idle,
   * slide down on mouse proximity.
   */
  toggleNotchMode() {
    if (!this.exists()) return;

    // Dedup guard
    const now = Date.now();
    if (now - this._lastCleanModeToggle < 300) return;
    this._lastCleanModeToggle = now;

    if (this._isNotchMode) {
      this._stopNotchProximityCheck();

      // Clear the CSS class via IPC
      this.send('chat:notch-mode-changed', { enabled: false });

      this._isNotchMode = false; // Set before setBounds so resize event doesn't corrupt _normalBounds

      // Restore to normal floating bounds
      const restoreBounds = this._notchModeBounds
        || this._normalBounds
        || { x: 100, y: 100, width: this.options.width, height: this.options.height };
      
      this.window.setBounds(restoreBounds, true);
      this.logger.debug('Exited notch mode');
      
      if (this.options.onNotchModeChanged) {
        this.options.onNotchModeChanged(false);
      }
    } else {
      // Save current bounds
      this._notchModeBounds = this.window.isMaximized()
        ? (this._normalBounds || { x: 100, y: 100, width: this.options.width, height: this.options.height })
        : this.window.getBounds();

      // Enable the CSS class via IPC
      this.send('chat:notch-mode-changed', { enabled: true });

      const currentDisplay = screen.getDisplayMatching(this._notchModeBounds);
      const workArea = currentDisplay.workArea;

      const notchWidth = Math.round(workArea.width * 0.60);
      const notchHeight = 300; // Space for one user agent small turn
      const notchIdleHeight = 46; // Matches full native header height
      const notchX = workArea.x + Math.round((workArea.width - notchWidth) / 2);
      const notchY = workArea.y;

      this._isNotchMode = true; // Set BEFORE setBounds to prevent trackNormalBounds from overwriting state

      this.window.setBounds({
        x: notchX,
        y: notchY,
        width: notchWidth,
        height: notchHeight,
      }, true);
      
      this.logger.debug('Entered notch mode', { width: notchWidth, height: notchHeight });
      
      if (this.options.onNotchModeChanged) {
        this.options.onNotchModeChanged(true);
      }
      
      this._startNotchProximityCheck(notchHeight, notchIdleHeight);
    }
  }

  _updateNotchActivity(isHovering) {
    this._isNotchHovering = isHovering;
    this._evaluateNotchState();
  }

  _startNotchProximityCheck(notchHeight, notchIdleHeight) {
    this._stopNotchProximityCheck();

    this._notchFullHeight = notchHeight;
    this._notchIdleHeight = notchIdleHeight;
    this._notchIsHidden = false;
    this._isNotchHovering = false;

    // We also need to listen to focus/blur to re-evaluate
    if (!this._notchFocusHandler) {
      this._notchFocusHandler = () => this._evaluateNotchState();
      this.window.on('focus', this._notchFocusHandler);
      this.window.on('blur', this._notchFocusHandler);
    }

    // Evaluate initially
    this._evaluateNotchState();
  }

  _stopNotchProximityCheck() {
    if (this._notchCollapseTimer) {
      clearTimeout(this._notchCollapseTimer);
      this._notchCollapseTimer = null;
    }
    if (this._notchFocusHandler && this.window && !this.window.isDestroyed()) {
      if (typeof this.window.removeListener === 'function') {
        this.window.removeListener('focus', this._notchFocusHandler);
        this.window.removeListener('blur', this._notchFocusHandler);
      } else if (typeof this.window.off === 'function') {
        this.window.off('focus', this._notchFocusHandler);
        this.window.off('blur', this._notchFocusHandler);
      } else {
        // Fallback for mock environments
        try {
          this.window.removeListener('focus', this._notchFocusHandler);
          this.window.removeListener('blur', this._notchFocusHandler);
        } catch (e) {
          this.logger.debug('Failed to remove focus/blur listeners, mock environment?', { error: e.message });
        }
      }
      this._notchFocusHandler = null;
    }
    this._isNotchHovering = false;
  }

  _evaluateNotchState() {
    if (!this.exists() || !this._isNotchMode || !this.window.isVisible()) return;

    // Use webContents.isFocused() to avoid macOS Electron frame/alwaysOnTop focus bugs
    const isActuallyFocused = this.window.isFocused() && this.window.webContents.isFocused();
    const isActive = isActuallyFocused || this._isStreaming || this._isNotchHovering;

    if (isActive) {
      // Clear any pending collapse
      if (this._notchCollapseTimer) {
        clearTimeout(this._notchCollapseTimer);
        this._notchCollapseTimer = null;
      }
      
      // Expand if hidden
      if (this._notchIsHidden) {
        this._notchIsHidden = false;
        const bounds = this.window.getBounds();
        this.window.setBounds({
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: this._notchFullHeight
        }, true);
      }
    } else {
      // Not active: start collapse timer if not already running
      if (!this._notchIsHidden && !this._notchCollapseTimer) {
        this._notchCollapseTimer = setTimeout(() => {
          if (!this.exists() || !this._isNotchMode) return;
          this._notchIsHidden = true;
          this._notchCollapseTimer = null;
          
          const currentBounds = this.window.getBounds();
          this.window.setBounds({
            x: currentBounds.x,
            y: currentBounds.y,
            width: currentBounds.width,
            height: this._notchIdleHeight
          }, true);
        }, 3000);
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
      case 'toggle-clean-mode':
        this.toggleCleanMode();
        break;
      case 'toggle-notch-mode':
        this.toggleNotchMode();
        break;
      default:
        this.logger.warn('Unknown control action', { action });
        break;
    }
  }

  /**
   * Send message to chat window (with queueing)
   */
  send(channel, ...args) {
    if (!this.exists()) {
      this.logger.warn('Cannot send to destroyed window', { channel });
      return false;
    }
    
    // Queue if HTML is still loading OR renderer hasn't finished bootstrapping.
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
   * Clean up the renderer-ready IPC listener and timeout.
   * @private
   */
  _cleanupRendererReadyListener() {
    if (this._rendererReadyHandler && ipcMain && typeof ipcMain.removeListener === 'function') {
      ipcMain.removeListener('chat:renderer-ready', this._rendererReadyHandler);
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
      this.logger.info('Destroying chat window');
      this.window.destroy();
      this.window = null;
      this.messageQueue = [];
    }
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = ChatWindow;
