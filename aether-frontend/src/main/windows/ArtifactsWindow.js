'use strict';

/**
 * @.architecture
 * 
 * Incoming: WindowManager (create, send, control methods), BrowserWindow events (close, closed, did-finish-load) --- {method_call | electron_event, void | Event}
 * Processing: Create frameless transparent BrowserWindow (preload artifacts-preload.js), attach ExternalLinkHandler + PermissionHandler (clipboard), load index.html, queue messages while loading (messageQueue array), flush queue on did-finish-load, hide on close (not destroy unless isQuitting), send IPC to renderer (artifacts:ensure-visible, artifacts:*), provide control methods (minimize, maximize, close → hide, toggle-visibility), track isActive state, resizable window, alwaysOnTop, DevTools in development --- {10 jobs: JOB_INITIALIZE, JOB_CREATE_DOM_ELEMENT, JOB_DISPOSE, JOB_GET_STATE, JOB_INITIALIZE, JOB_LOAD_FROM_DB, JOB_EMIT_EVENT, JOB_UPDATE_STATE, JOB_SEND_IPC, JOB_UPDATE_STATE}
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
 * - Floating, resizable window
 * - Hide on close (preserve state)
 * - Always on top
 * - Message queueing while loading
 * 
 * @module main/windows/ArtifactsWindow
 */

const { BrowserWindow } = require('electron');
const path = require('path');
const { logger } = require('../../core/utils/logger');
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
    
    this.logger.info('Creating artifacts window');
    
    // Create browser window
    this.window = new BrowserWindow({
      width: this.options.width,
      height: this.options.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: true,
      alwaysOnTop: true,
      resizable: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        preload: path.join(__dirname, '../../../build/preload/artifacts-preload.js'),
      },
    });
    
    // Set opacity
    this.window.setOpacity(1.0);
    
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
    // Did finish load: ensure visibility and flush queue
    this.window.webContents.once('did-finish-load', () => {
      try {
        this.window.webContents.send('artifacts:ensure-visible');
      } catch (err) {
        this.logger.error('Failed to send ensure-visible', {
          error: err.message,
        });
      }
      
      // Flush message queue
      this._flushQueue();
    });
    
    // Close event: hide instead of destroy
    this.window.on('close', (event) => {
      if (!this.options.isQuitting) {
        event.preventDefault();
        this.window.hide();
        this.logger.debug('Artifacts window hidden (not closed)');
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
    
    // If window is still loading, queue the message
    if (this.window.webContents.isLoading()) {
      this.logger.debug('Queueing message (window loading)', { channel });
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
    
    while (this.messageQueue.length > 0) {
      const { channel, args } = this.messageQueue.shift();
      
      try {
        this.window.webContents.send(channel, ...args);
      } catch (err) {
        this.logger.error('Failed to send queued message', {
          channel,
          error: err.message,
        });
      }
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
   * Show window
   */
  show() {
    if (this.exists()) {
      this.window.show();
      this.window.focus();
    } else {
      this.create();
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
   * Toggle visibility
   */
  toggleVisibility() {
    if (this.exists()) {
      if (this.window.isVisible()) {
        this.hide();
      } else {
        this.show();
      }
    } else {
      this.create();
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
   * Destroy window
   */
  destroy() {
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

