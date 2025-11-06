'use strict';

/**
 * @.architecture
 * 
 * Incoming: WindowManager (create, control methods), BrowserWindow events (close, closed, did-finish-load) --- {method_call | electron_event, void | Event}
 * Processing: Create frameless transparent BrowserWindow (preload chat-preload.js), attach ExternalLinkHandler + PermissionHandler (clipboard), load index.html, hide on close (not destroy unless isQuitting), send IPC to renderer (chat:ensure-visible), provide control methods (minimize, maximize, close → hide, toggle-visibility), resizable window, alwaysOnTop, DevTools in development --- {9 jobs: JOB_INITIALIZE, JOB_CREATE_DOM_ELEMENT, JOB_DISPOSE, JOB_GET_STATE, JOB_INITIALIZE, JOB_LOAD_FROM_DB, JOB_EMIT_EVENT, JOB_SEND_IPC, JOB_UPDATE_STATE}
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

const { BrowserWindow } = require('electron');
const path = require('path');
const { logger } = require('../../core/utils/logger');
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
    
    this.logger.info('Creating chat window');
    
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
        preload: path.join(__dirname, '../../../build/preload/chat-preload.js'),
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
    // Did finish load: ensure visibility
    this.window.webContents.once('did-finish-load', () => {
      try {
        this.window.webContents.send('chat:ensure-visible');
      } catch (err) {
        this.logger.error('Failed to send ensure-visible', {
          error: err.message,
        });
      }
    });
    
    // Close event: hide instead of destroy
    this.window.on('close', (event) => {
      if (!this.options.isQuitting) {
        event.preventDefault();
        this.window.hide();
        this.logger.debug('Chat window hidden (not closed)');
      }
    });
    
    // Closed event
    this.window.on('closed', () => {
      this.logger.info('Chat window closed');
      this.window = null;
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
      this.logger.info('Destroying chat window');
      this.window.destroy();
      this.window = null;
    }
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = ChatWindow;

