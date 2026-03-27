'use strict';

/**
 * @.architecture
 * 
 * Incoming: WindowManager (create method), BrowserWindow events (blur, will-minimize, move, closed) --- {method_call | electron_event, void | Event}
 * Processing: Create frameless transparent BrowserWindow (preload main-preload.js), attach ExternalLinkHandler + PermissionHandler (media + clipboard), load index.html, toggle widget mode (blur → widget, click → normal), save/restore bounds, calculate widget position via display-utils, send IPC to renderer (enter-widget-mode, exit-widget-mode), handle zoom (Ctrl+wheel, zoomIn/Out, 0.5-2.0x), setAlwaysOnTop, setSkipTaskbar, setAspectRatio (1.0 for widget), open DevTools in development --- {10 jobs: JOB_INITIALIZE, JOB_CREATE_DOM_ELEMENT, JOB_DISPOSE, JOB_GET_STATE, JOB_INITIALIZE, JOB_LOAD_FROM_DB, JOB_EMIT_EVENT, JOB_SEND_IPC, JOB_UPDATE_STATE, JOB_UPDATE_STATE}
 * Outgoing: BrowserWindow (main window), IPC to renderer (widget mode events) --- {electron_window | ipc_message, BrowserWindow | void}
 * 
 * 
 * @module main/windows/MainWindow
 * 
 * Main Window
 * ============================================================================
 * Primary application window with widget mode support.
 * 
 * Features:
 * - Widget mode (compact, always-on-top)
 * - Normal mode (full-sized)
 * - Transparent, frameless window
 * - Zoom controls
 * - Microphone permissions
 * 
 * @module main/windows/MainWindow
 */

const { BrowserWindow } = require('electron');
const path = require('path');
const { logger } = require('../../core/utils/logger');
const config = require('../../core/config');
const { resolvePreloadPath } = require('../utils/preload-utils');
const { attachToWindow: attachExternalLinkHandler } = require('../security/ExternalLinkHandler');
const { attachToWindow: attachPermissionHandler, PERMISSIONS } = require('../security/PermissionHandler');

// ============================================================================
// MainWindow Class
// ============================================================================

class MainWindow {
  constructor(options = {}) {
    this.options = {
      width: options.width || config.ui?.normalWidth || 800,
      height: options.height || config.ui?.normalHeight || 600,
      widgetSize: options.widgetSize || config.ui?.widgetSize || 180,
      ...options,
    };
    
    this.logger = logger.child({ module: 'MainWindow' });
    this.window = null;
    this.isWidgetMode = false;
    this.previousBounds = null;
    this.widgetBounds = null;
    this._nativeEffectsState = null;
    this.messageQueue = [];
    this._isReady = false;
  }

  /**
   * Create the main window
   */
  create() {
    if (this.window && !this.window.isDestroyed()) {
      this.logger.warn('Main window already exists');
      return this.window;
    }
    
    this.logger.info('Creating main window');
    
    const windowOptions = {
      width: this.options.width,
      height: this.options.height,
      frame: false,
      transparent: true,
      backgroundColor: this.options.backgroundColor || config.ui.mainWindowBackgroundColor,
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        zoomFactor: 1.0,
        preload: resolvePreloadPath(__dirname, 'main-preload.js'),
      },
    };

    if (config.ui.enableNativeWindowEffects && process.platform === 'darwin') {
      windowOptions.vibrancy = config.ui.macVibrancy;
      windowOptions.visualEffectState = config.ui.macVisualEffectState;
    }

    this.window = new BrowserWindow(windowOptions);

    // Capture initial native effects state (so widget mode can temporarily disable it)
    this._nativeEffectsState = {
      macVibrancy: windowOptions.vibrancy || null,
      macVisualEffectState: windowOptions.visualEffectState || null,
      windowsBackgroundMaterial: config.ui.windowsBackgroundMaterial || null,
    };

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
    
    // Enable zoom capabilities (100% to 500%)
    this.window.webContents.setVisualZoomLevelLimits(1, 5);
    
    // Attach security handlers
    this._attachSecurityHandlers();
    
    // Load HTML file
    this._loadHTML();
    
    // Setup event handlers
    this._setupEventHandlers();
    
    // Open DevTools in development (main window)
    if ((process.env.ELECTRON_DEV === 'true' || process.env.NODE_ENV === 'development') && config.dev.openDevToolsMain) {
      this.window.webContents.openDevTools({ mode: 'detach' });
    }
    
    this.logger.info('Main window created', {
      width: this.options.width,
      height: this.options.height,
    });
    
    return this.window;
  }

  /**
   * Attach security handlers
   */
  _attachSecurityHandlers() {
    // External link protection
    attachExternalLinkHandler(this.window);
    
    // Permission handler with microphone enabled
    attachPermissionHandler(this.window, {
      [PERMISSIONS.MEDIA]: true,
      [PERMISSIONS.CLIPBOARD_SANITIZED_WRITE]: true,
    });
  }

  /**
   * Load HTML file
   */
  _loadHTML() {
    const htmlPath = path.join(__dirname, '../../renderer/main/index.html');
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
    // Handle loaded state and queue
    this.window.webContents.once('did-finish-load', () => {
      this._isReady = true;
      this._flushQueue();
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
          console.log(`[MainWindow:${levelStr}]${source} ${message}`);
        }
      });
    }
    
    // Blur event: enter widget mode
    this.window.on('blur', () => {
      if (this.window.webContents.isDevToolsFocused()) {
        this.logger.debug('Window blurred but DevTools focused');
        return;
      }
      
      this.logger.debug('Window blurred, entering widget mode');
      this.enterWidgetMode();
    });
    
    // Minimize event: enter widget mode
    this.window.on('will-minimize', (event) => {
      event.preventDefault();
      this.enterWidgetMode();
    });
    
    // Move event: track widget position
    this.window.on('move', () => {
      // Skip redundant tracking if a custom JS drag is already updating position
      if (this._dragState) return;

      if (this.isWidgetMode) {
        const bounds = this.window.getBounds();
        this.widgetBounds = { x: bounds.x, y: bounds.y };
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
      this.logger.info('Main window closed');
      this.window = null;
      this._isReady = false;
      this.messageQueue = [];
    });
  }

  /**
   * Send message to main window (with queueing)
   */
  send(channel, ...args) {
    if (!this.exists()) {
      this.logger.warn('Cannot send to destroyed window', { channel });
      return false;
    }
    
    // Queue if HTML is still loading
    if (this.window.webContents.isLoading() || !this._isReady) {
      this.logger.debug('Queueing message (main window not ready)', { channel });
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
   * Enter widget mode
   */
  enterWidgetMode() {
    if (this.isWidgetMode) return;
    
    this.logger.info('Entering widget mode');
    this.isWidgetMode = true;
    
    // Save current bounds
    if (!this.previousBounds) {
      this.previousBounds = this.window.getBounds();
    }
    
    // Set aspect ratio (include extra height for text area)
    const extraHeight = 65; // Flexible space for the translucent text area
    this.window.setAspectRatio(this.options.widgetSize / (this.options.widgetSize + extraHeight));
    
    // Calculate widget position
    const { calculateWidgetPosition } = require('../utils/display-utils');
    const widgetBounds = this.widgetBounds || calculateWidgetPosition(
      this.previousBounds || this.window.getBounds(),
      this.options.widgetSize,
      config.ui?.widgetMargin || 24
    );
    
    // Apply widget bounds
    this.window.setBounds({
      x: Math.round(widgetBounds.x),
      y: Math.round(widgetBounds.y),
      width: this.options.widgetSize,
      height: this.options.widgetSize + extraHeight,
    });
    
    // Update window properties
    this.window.setSkipTaskbar(true);
    this.window.setAlwaysOnTop(true, 'screen-saver');
    this.window.setBackgroundColor('#00000000');

    // Widget mode should be “visualizer only”: OS-level window materials tint the full window rect.
    if (config.ui.enableNativeWindowEffects && config.ui.disableNativeWindowEffectsInWidgetMode) {
      if (process.platform === 'darwin') {
        try {
          if (typeof this.window.setVibrancy === 'function') {
            // Disable vibrancy so the window rect is fully transparent; the renderer draws the circle.
            this.window.setVibrancy(null);
          }
        } catch (error) {
          this.logger.debug('Failed to disable vibrancy for widget mode', { error: error.message });
        }
      }
      if (process.platform === 'win32') {
        try {
          if (typeof this.window.setBackgroundMaterial === 'function') {
            this.window.setBackgroundMaterial('none');
          }
        } catch (error) {
          this.logger.debug('Failed to disable background material for widget mode', { error: error.message });
        }
      }
    }
    
    // Notify renderer
    try {
      this.window.webContents.send('enter-widget-mode');
    } catch (err) {
      this.logger.error('Failed to notify renderer', { error: err.message });
    }
    
    // Ensure transparency after short delay
    setTimeout(() => {
      if (this.window && !this.window.isDestroyed()) {
        this.window.setBackgroundColor('#00000000');
      }
    }, 300);
  }

  /**
   * Exit widget mode
   */
  exitWidgetMode() {
    if (!this.isWidgetMode) return;
    
    this.logger.info('Exiting widget mode');
    this.isWidgetMode = false;
    
    // Reset aspect ratio
    this.window.setAspectRatio(0);
    
    // Restore previous bounds or default size
    if (this.previousBounds) {
      this.window.setBounds(this.previousBounds);
    } else {
      this.window.setBounds({
        width: this.options.width,
        height: this.options.height,
      });
    }
    
    this.previousBounds = null;
    
    // Update window properties
    this.window.setSkipTaskbar(false);
    this.window.setAlwaysOnTop(true, 'floating');

    // Restore native window effects for normal mode
    if (config.ui.enableNativeWindowEffects && this._nativeEffectsState) {
      if (process.platform === 'darwin') {
        try {
          if (typeof this.window.setVibrancy === 'function' && this._nativeEffectsState.macVibrancy) {
            this.window.setVibrancy(this._nativeEffectsState.macVibrancy);
          }
          if (this._nativeEffectsState.macVisualEffectState) {
            this.window.setVisualEffectState(this._nativeEffectsState.macVisualEffectState);
          }
        } catch (error) {
          this.logger.debug('Failed to restore vibrancy for normal mode', { error: error.message });
        }
      }
      if (process.platform === 'win32') {
        try {
          if (typeof this.window.setBackgroundMaterial === 'function' && this._nativeEffectsState.windowsBackgroundMaterial) {
            this.window.setBackgroundMaterial(this._nativeEffectsState.windowsBackgroundMaterial);
          }
        } catch (error) {
          this.logger.debug('Failed to restore background material for normal mode', { error: error.message });
        }
      }
    }
    
    // Notify renderer
    try {
      this.window.webContents.send('exit-widget-mode');
    } catch (err) {
      this.logger.error('Failed to notify renderer', { error: err.message });
    }
  }

  /**
   * Toggle widget mode
   */
  toggleWidgetMode() {
    if (this.isWidgetMode) {
      this.exitWidgetMode();
    } else {
      this.enterWidgetMode();
    }
  }

  /**
   * Begin JS-based widget drag.
   * Snapshots the current window position and the cursor's screen coords
   * so subsequent moveWidgetDrag calls can compute absolute window placement.
   * @param {{ screenX: number, screenY: number }} screenPos
   */
  startWidgetDrag(screenPos) {
    if (!this.isWidgetMode || !this.window || this.window.isDestroyed()) return;
    const [winX, winY] = this.window.getPosition();
    this._dragState = {
      startScreenX: screenPos.screenX,
      startScreenY: screenPos.screenY,
      startWinX: winX,
      startWinY: winY,
    };
    this.logger.debug('Widget drag started', this._dragState);
  }

  /**
   * Move window during JS drag.
   * Computes delta between current screen coords and the drag-start snapshot,
   * then repositions the window absolutely.
   * @param {{ screenX: number, screenY: number }} screenPos
   */
  moveWidgetDrag(screenPos) {
    if (!this._dragState || !this.window || this.window.isDestroyed()) return;
    const deltaX = screenPos.screenX - this._dragState.startScreenX;
    const deltaY = screenPos.screenY - this._dragState.startScreenY;
    const newX = this._dragState.startWinX + deltaX;
    const newY = this._dragState.startWinY + deltaY;
    this.window.setPosition(newX, newY);
    // Keep widgetBounds in sync for persistence / restore
    this.widgetBounds = { x: newX, y: newY };
  }

  /**
   * End JS-based widget drag. Clears drag state.
   */
  endWidgetDrag() {
    if (this._dragState) {
      this.logger.debug('Widget drag ended', this.widgetBounds);
    }
    this._dragState = null;
  }

  /**
   * Handle wheel event (zoom)
   */
  handleWheelEvent(wheelData) {
    if (!wheelData.ctrlKey) return;
    
    const currentZoom = this.window.webContents.getZoomFactor();
    const delta = wheelData.deltaY < 0 ? 0.1 : -0.1;
    const newZoom = Math.max(0.5, Math.min(2.0, currentZoom + delta));
    
    this.window.webContents.setZoomFactor(newZoom);
    this.logger.debug('Zoom changed', { zoom: newZoom });
  }

  /**
   * Zoom in
   */
  zoomIn() {
    const currentZoom = this.window.webContents.getZoomFactor();
    const newZoom = Math.min(2.0, currentZoom + 0.1);
    this.window.webContents.setZoomFactor(newZoom);
    this.logger.debug('Zoomed in', { zoom: newZoom });
  }

  /**
   * Zoom out
   */
  zoomOut() {
    const currentZoom = this.window.webContents.getZoomFactor();
    const newZoom = Math.max(0.5, currentZoom - 0.1);
    this.window.webContents.setZoomFactor(newZoom);
    this.logger.debug('Zoomed out', { zoom: newZoom });
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
   * Show window
   */
  show() {
    if (this.exists()) {
      this.window.show();
    }
  }

  /**
   * Hide window
   */
  hide() {
    if (this.exists()) {
      this.window.hide();
    }
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
   * Destroy window
   */
  destroy() {
    if (this.exists()) {
      this.logger.info('Destroying main window');
      this.window.destroy();
      this.window = null;
    }
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = MainWindow;
