'use strict';

/**
 * @.architecture
 * 
 * Incoming: main/index.js (initialize, shutdown), IpcRouter (control actions, focus requests) --- {method_call, javascript_api}
 * Processing: Create/manage MainWindow (widget mode), ChatWindow, ArtifactsWindow, coordinate inter-window communication (sendToArtifacts with auto-create + queueing), handle file operations (exportArtifactFile via dialog.showSaveDialog, openFile via shell.openPath), forward control actions (controlChatWindow, controlArtifactsWindow), manage isQuitting flag (prevents hide-on-close), provide getters (getMainWindow, getChatWindow, getArtifactsWindow), orchestrate shutdown (setQuitting + destroy all) --- {7 jobs: JOB_DELEGATE_TO_MODULE, JOB_DISPOSE, JOB_GET_STATE, JOB_INITIALIZE, JOB_SEND_IPC, JOB_UPDATE_STATE, JOB_WRITE_FILE}
 * Outgoing: MainWindow, ChatWindow, ArtifactsWindow (BrowserWindow instances), file operations (dialog, shell) --- {object, javascript_api}
 * 
 * 
 * @module main/windows/WindowManager
 * 
 * Window Manager
 * ============================================================================
 * Orchestrates all application windows and their lifecycle.
 * 
 * Responsibilities:
 * - Create and manage all windows
 * - Coordinate inter-window communication
 * - Handle window control actions
 * - Manage file operations
 * 
 * @module main/windows/WindowManager
 */

const { dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { logger } = require('../../core/utils/logger');
const MainWindow = require('./MainWindow');
const ChatWindow = require('./ChatWindow');
const ArtifactsWindow = require('./ArtifactsWindow');

// ============================================================================
// WindowManager Class
// ============================================================================

class WindowManager {
  constructor(options = {}) {
    this.options = options;
    this.logger = logger.child({ module: 'WindowManager' });
    
    // Window instances
    this.mainWindow = null;
    this.chatWindow = null;
    this.artifactsWindow = null;
    
    // Shared state
    this.isQuitting = false;
  }

  /**
   * Initialize all windows
   */
  async initialize() {
    this.logger.info('Initializing window manager');
    
    try {
      // Create main window
      this.mainWindow = new MainWindow(this.options.mainWindow);
      this.mainWindow.create();
      
      // Create chat window
      this.chatWindow = new ChatWindow(this.options.chatWindow);
      this.chatWindow.create();
      
      // Create artifacts window (initially hidden)
      // We create it early to ensure it's ready for messages
      // this.artifactsWindow = new ArtifactsWindow(this.options.artifactsWindow);
      // this.artifactsWindow.create();
      // this.artifactsWindow.hide();
      
      this.logger.info('Window manager initialized');
    } catch (err) {
      this.logger.error('Failed to initialize windows', {
        error: err.message,
        stack: err.stack,
      });
      throw err;
    }
  }

  /**
   * Set quitting flag (prevents hide-on-close behavior)
   */
  setQuitting(isQuitting) {
    this.isQuitting = isQuitting;
    
    if (this.chatWindow) {
      this.chatWindow.setQuitting(isQuitting);
    }
    
    if (this.artifactsWindow) {
      this.artifactsWindow.setQuitting(isQuitting);
    }
  }

  /**
   * Shutdown all windows
   */
  shutdown() {
    this.logger.info('Shutting down window manager');
    
    this.setQuitting(true);
    
    if (this.artifactsWindow) {
      this.artifactsWindow.destroy();
    }
    
    if (this.chatWindow) {
      this.chatWindow.destroy();
    }
    
    if (this.mainWindow) {
      this.mainWindow.destroy();
    }
    
    this.logger.info('Window manager shutdown complete');
  }

  // ==========================================================================
  // Window Getters
  // ==========================================================================

  getMainWindow() {
    return this.mainWindow?.getWindow();
  }

  getChatWindow() {
    return this.chatWindow?.getWindow();
  }

  getArtifactsWindow() {
    return this.artifactsWindow?.getWindow();
  }

  get isWidgetMode() {
    return this.mainWindow?.isWidgetMode || false;
  }

  // ==========================================================================
  // Main Window Operations
  // ==========================================================================

  toggleWidgetMode() {
    if (this.mainWindow) {
      this.mainWindow.toggleWidgetMode();
    }
  }

  enterWidgetMode() {
    if (this.mainWindow) {
      this.mainWindow.enterWidgetMode();
    }
  }

  exitWidgetMode() {
    if (this.mainWindow) {
      this.mainWindow.exitWidgetMode();
    }
  }

  updateWidgetPosition(bounds) {
    if (this.mainWindow) {
      this.mainWindow.updateWidgetPosition(bounds);
    }
  }

  handleWheelEvent(wheelData) {
    if (this.mainWindow) {
      this.mainWindow.handleWheelEvent(wheelData);
    }
  }

  zoomIn() {
    if (this.mainWindow) {
      this.mainWindow.zoomIn();
    }
  }

  zoomOut() {
    if (this.mainWindow) {
      this.mainWindow.zoomOut();
    }
  }

  // ==========================================================================
  // Chat Window Operations
  // ==========================================================================

  createChatWindow() {
    if (!this.chatWindow) {
      this.chatWindow = new ChatWindow(this.options.chatWindow);
    }
    this.chatWindow.create();
  }

  controlChatWindow(action) {
    if (!this.chatWindow) {
      this.createChatWindow();
      return;
    }
    this.chatWindow.control(action);
  }

  // ==========================================================================
  // Artifacts Window Operations
  // ==========================================================================

  createArtifactsWindow() {
    if (!this.artifactsWindow) {
      this.artifactsWindow = new ArtifactsWindow(this.options.artifactsWindow);
    }
    this.artifactsWindow.create();
  }

  controlArtifactsWindow(action) {
    if (!this.artifactsWindow) {
      this.createArtifactsWindow();
      return;
    }
    this.artifactsWindow.control(action);
  }

  setArtifactsWindowState(data) {
    if (this.artifactsWindow) {
      this.artifactsWindow.setActive(!!data?.active);
    }
  }

  isArtifactsWindowActive() {
    return this.artifactsWindow?.getActive() || false;
  }

  /**
   * Send message to artifacts window (with auto-create and queueing)
   */
  sendToArtifacts(channel, ...args) {
    // Create window if it doesn't exist
    if (!this.artifactsWindow || !this.artifactsWindow.exists()) {
      this.createArtifactsWindow();
    }
    
    // Send with queueing support
    const success = this.artifactsWindow.send(channel, ...args);
    
    // Show window if message was sent/queued successfully
    if (success && !this.artifactsWindow.getWindow().isVisible()) {
      this.artifactsWindow.show();
    }
    
    return success;
  }

  /**
   * Focus artifacts window (with optional data)
   */
  focusArtifacts(data) {
    if (!this.artifactsWindow || !this.artifactsWindow.exists()) {
      this.createArtifactsWindow();
      
      // Queue the focus message
      setTimeout(() => {
        if (this.artifactsWindow && this.artifactsWindow.exists()) {
          this.artifactsWindow.send('artifacts:focus-artifacts', data);
        }
      }, 500);
    } else {
      this.logger.debug('Forwarding focus-artifacts', { data });
      this.artifactsWindow.send('artifacts:focus-artifacts', data);
    }
  }

  /**
   * Load code in artifacts window
   */
  loadArtifactsCode(data) {
    if (!this.artifactsWindow || !this.artifactsWindow.exists()) {
      this.createArtifactsWindow();
      
      // Queue the message
      setTimeout(() => {
        if (this.artifactsWindow && this.artifactsWindow.exists()) {
          this.artifactsWindow.send('artifacts:load-code', data);
        }
      }, 500);
    } else {
      this.logger.debug('Forwarding load-code', { data });
      this.artifactsWindow.send('artifacts:load-code', data);
    }
  }

  /**
   * Load output in artifacts window
   */
  loadArtifactsOutput(data) {
    if (!this.artifactsWindow || !this.artifactsWindow.exists()) {
      this.createArtifactsWindow();
      
      // Queue the message
      setTimeout(() => {
        if (this.artifactsWindow && this.artifactsWindow.exists()) {
          this.artifactsWindow.send('artifacts:load-output', data);
        }
      }, 500);
    } else {
      this.logger.debug('Forwarding load-output', { data });
      this.artifactsWindow.send('artifacts:load-output', data);
    }
  }

  // ==========================================================================
  // File Operations
  // ==========================================================================

  /**
   * Export artifact file
   */
  async exportArtifactFile(payload) {
    try {
      const defaultPath = payload?.name || 'artifact.txt';
      const result = await dialog.showSaveDialog({ defaultPath });
      
      if (result.canceled || !result.filePath) {
        this.logger.debug('File export canceled');
        return;
      }
      
      const content = String(payload?.content || '');
      fs.writeFileSync(result.filePath, content, 'utf8');
      
      this.logger.info('File exported', { path: result.filePath });
    } catch (err) {
      this.logger.error('File export failed', {
        error: err.message,
      });
    }
  }

  /**
   * Open file with system default application
   */
  async openFile(payload) {
    try {
      const filePath = payload?.path;
      
      if (!filePath) {
        this.logger.error('No file path provided');
        return;
      }
      
      // Verify file exists
      if (!fs.existsSync(filePath)) {
        this.logger.error('File does not exist', { filePath });
        return;
      }
      
      // Open with system default
      const result = await shell.openPath(filePath);
      
      if (result) {
        this.logger.error('Failed to open file', { filePath, error: result });
      } else {
        this.logger.info('File opened successfully', { filePath });
      }
    } catch (err) {
      this.logger.error('File open failed', {
        error: err.message,
      });
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalManager = null;

/**
 * Get or create global manager instance
 */
function getManager(options = {}) {
  if (!globalManager) {
    globalManager = new WindowManager(options);
  }
  return globalManager;
}

/**
 * Create a new manager instance
 */
function createManager(options = {}) {
  return new WindowManager(options);
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  WindowManager,
  getManager,
  createManager,
};

