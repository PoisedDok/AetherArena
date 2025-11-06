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
    
    // Create browser window
    this.window = new BrowserWindow({
      width: this.options.width,
      height: this.options.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        zoomFactor: 1.0,
        preload: path.join(__dirname, '../../../build/preload/main-preload.js'),
      },
    });
    
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
    
    // Open DevTools in development
    if (process.env.ELECTRON_DEV === 'true' || process.env.NODE_ENV === 'development') {
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
      if (this.isWidgetMode) {
        const bounds = this.window.getBounds();
        this.widgetBounds = { x: bounds.x, y: bounds.y };
      }
    });
    
    // Closed event
    this.window.on('closed', () => {
      this.logger.info('Main window closed');
      this.window = null;
    });
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
    
    // Set aspect ratio (square)
    this.window.setAspectRatio(1.0);
    
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
      height: this.options.widgetSize,
    });
    
    // Update window properties
    this.window.setSkipTaskbar(true);
    this.window.setAlwaysOnTop(true, 'screen-saver');
    this.window.setBackgroundColor('#00000000');
    
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
   * Update widget position (when dragged)
   */
  updateWidgetPosition(bounds) {
    if (this.isWidgetMode && bounds) {
      this.widgetBounds = { x: bounds.x, y: bounds.y };
      this.logger.debug('Widget position updated', this.widgetBounds);
    }
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

