'use strict';

/**
 * @.architecture
 * 
 * Incoming: WindowManager (create, control methods), BrowserWindow events (close, closed) --- {method_call | electron_event, void | Event}
 * Processing: Create frameless/standard BrowserWindow (preload research-preload.js), manage standalone research dashboard lifecycle --- {6 jobs: JOB_CREATE_DOM_ELEMENT, JOB_DISPOSE, JOB_EMIT_EVENT, JOB_INITIALIZE, JOB_SEND_IPC, JOB_UPDATE_STATE}
 * Outgoing: BrowserWindow (research window) --- {electron_window, BrowserWindow}
 * 
 * @module main/windows/ResearchWindow
 */

const { BrowserWindow } = require('electron');
const path = require('path');
const { logger } = require('../../core/utils/logger');
const config = require('../../core/config');
const { resolvePreloadPath } = require('../utils/preload-utils');

class ResearchWindow {
  constructor(options = {}) {
    this.options = {
      width: options.width || 1200,
      height: options.height || 800,
      isQuitting: false,
      ...options,
    };
    
    this.logger = logger.child({ module: 'ResearchWindow' });
    this.window = null;
    this.messageQueue = [];
    this._isReady = false;
  }

  setQuitting(isQuitting) {
    this.options.isQuitting = isQuitting;
  }

  create() {
    if (this.window && !this.window.isDestroyed()) {
      this.logger.warn('Research window already exists');
      this.window.show();
      return this.window;
    }
    
    this.logger.info('Creating research window');
    
    const windowOptions = {
      show: this.options.show !== false,
      width: this.options.width,
      height: this.options.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: true,
      alwaysOnTop: false,
      resizable: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        preload: resolvePreloadPath(__dirname, 'research-preload.js'),
      },
    };

    if (config.ui.enableNativeWindowEffects && process.platform === 'darwin') {
      windowOptions.vibrancy = 'hud';
    }

    this.window = new BrowserWindow(windowOptions);

    try {
      this.window.setBackgroundColor('#00000000');
    } catch (e) {}
    
    // Load HTML file
    const htmlPath = path.join(__dirname, '../../renderer/research/index.html');
    this.window.loadFile(htmlPath).catch(err => {
      this.logger.error('Failed to load Research HTML', { htmlPath, error: err.message });
    });
    
    this._setupEventHandlers();
    
    this.logger.info('Research window created');
    return this.window;
  }

  _setupEventHandlers() {
    this.window.on('close', (event) => {
      if (!this.options.isQuitting) {
        event.preventDefault();
        this.window.hide();
      }
    });
    
    this.window.on('closed', () => {
      this.logger.info('Research window closed');
      this.window = null;
      this._isReady = false;
      this.messageQueue = [];
    });

    this.window.webContents.once('did-finish-load', () => {
      this._isReady = true;
      this._flushQueue();
    });

    this.window.webContents.on('before-input-event', (event, input) => {
      const isReload = (input.key.toLowerCase() === 'r' && (input.control || input.meta)) || input.key === 'F5';
      if (input.type === 'keyDown' && isReload && !this.window.webContents.isDevToolsFocused()) {
        event.preventDefault();
      }
    });
  }

  getWindow() {
    return this.window;
  }

  exists() {
    return this.window && !this.window.isDestroyed();
  }

  show() {
    if (this.exists()) {
      this.window.show();
      this.window.focus();
    } else {
      this.create();
    }
  }

  hide() {
    if (this.exists()) {
      this.window.hide();
    }
  }

  focus() {
    if (this.exists()) {
      this.window.focus();
    }
  }

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

  minimize() {
    if (this.exists()) {
      this.window.minimize();
    }
  }

  maximize() {
    if (this.exists()) {
      if (this.window.isMaximized()) {
        this.window.unmaximize();
      } else {
        this.window.maximize();
      }
    }
  }

  control(action) {
    switch (action) {
      case 'close':
      case 'hide':
        this.hide();
        break;
      case 'show':
        this.show();
        break;
      case 'toggle-visibility':
        this.toggleVisibility();
        break;
      case 'minimize':
        this.minimize();
        break;
      case 'maximize':
        this.maximize();
        break;
      default:
        this.logger.warn('Unknown control action for ResearchWindow', { action });
        break;
    }
  }

  destroy() {
    if (this.exists()) {
      this.window.destroy();
      this.window = null;
      this._isReady = false;
      this.messageQueue = [];
    }
  }

  send(channel, ...args) {
    if (!this.exists()) return false;
    
    if (this.window.webContents.isLoading() || !this._isReady) {
      this.messageQueue.push({ channel, args });
      return true;
    }
    
    try {
      this.window.webContents.send(channel, ...args);
      return true;
    } catch (err) {
      this.logger.error('Failed to send to Research window', { channel, error: err.message });
      return false;
    }
  }

  _flushQueue() {
    if (this.messageQueue.length === 0) return;
    
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      try {
        this.window.webContents.send(message.channel, ...message.args);
      } catch (err) {
        this.logger.error('Failed to send queued message to Research window', {
          channel: message.channel,
          error: err.message,
        });
      }
    }
  }
}

module.exports = ResearchWindow;
