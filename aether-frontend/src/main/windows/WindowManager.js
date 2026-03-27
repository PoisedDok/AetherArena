'use strict';

/**
 * @.architecture
 * 
 * Incoming: main/index.js (initialize, shutdown), IpcRouter (control actions, focus requests) --- {method_call, javascript_api}
 * Processing: Create/manage MainWindow (widget mode), ChatWindow, ArtifactsWindow, coordinate inter-window communication (sendToArtifacts with auto-create + queueing), handle file operations (exportArtifactFile via dialog.showSaveDialog, openFile via shell.openPath), forward control actions (controlChatWindow, controlArtifactsWindow), manage isQuitting flag (prevents hide-on-close), provide getters (getMainWindow, getChatWindow, getArtifactsWindow), orchestrate shutdown (setQuitting + destroy all) --- {8 jobs: JOB_ATTACH_TO_WINDOW, JOB_DELEGATE_TO_MODULE, JOB_DISPOSE, JOB_GET_STATE, JOB_INITIALIZE, JOB_SEND_IPC, JOB_UPDATE_STATE, JOB_WRITE_FILE}
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
const NotesWindow = require('./NotesWindow');
const IndexBrowserWindow = require('./IndexBrowserWindow');
const ResearchWindow = require('./ResearchWindow');

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
    this.notesWindow = null;
    this.indexBrowserWindow = null;
    this.researchWindow = null;
    
    // Visibility forwarding listeners (tracked for cleanup)
    this._visibilityListeners = [];
    
    // Artifacts auto-hide timer (scheduled after chat:request-complete)
    this._artifactsAutoHideTimer = null;
    
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
      this.logger.info('Main window created, waiting to create chat/artifacts windows');
      
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
   * Create chat + artifacts windows after startup animation completes.
   * Chat window is created HIDDEN — it will be shown after the welcome
   * demo sequence finishes (startup:welcome-complete IPC) so the user
   * sees the full-screen orb + welcome text before the chat appears.
   */
  createAuxWindows() {
    if (!this.chatWindow) {
      this.chatWindow = new ChatWindow({ 
        ...this.options.chatWindow, 
        show: false,
        onNotchModeChanged: this._handleNotchModeChanged.bind(this)
      });
    }
    if (!this.chatWindow.exists()) {
      this.chatWindow.create();
      this._setupVisibilityForwarding('chat', this.chatWindow);
    }

    if (!this.artifactsWindow) {
      this.artifactsWindow = new ArtifactsWindow({ ...this.options.artifactsWindow, show: false });
    }
    if (!this.artifactsWindow.exists()) {
      this.artifactsWindow.create();
      this._setupVisibilityForwarding('artifacts', this.artifactsWindow);
    }
  }

  /**
   * Show the chat window after the welcome sequence completes.
   * Enters widget mode on the main window first, then after a brief
   * delay (for the resize animation to settle) shows and focuses chat.
   * Idempotent — guarded by _chatRevealedAfterWelcome flag.
   */
  revealChatAfterWelcome() {
    if (this._chatRevealedAfterWelcome) return;
    this._chatRevealedAfterWelcome = true;

    // Reset the hidden-creation flag so any future window re-creation
    // (e.g. BrowserWindow destroyed then createChatWindow called)
    // produces a visible window. show:false was a one-shot startup concern.
    if (this.chatWindow && this.chatWindow.options) {
      delete this.chatWindow.options.show;
    }

    // 1. Minimize main window to widget orb
    this.enterWidgetMode();

    // 2. Brief delay for widget transition to settle, then show chat
    setTimeout(() => {
      const chatBw = this.getChatWindow();
      if (chatBw && !chatBw.isDestroyed() && !chatBw.isVisible()) {
        chatBw.show();
        chatBw.focus();
        this.logger.info('Chat window revealed after welcome sequence');
      }
    }, 500);
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

    if (this.notesWindow) {
      this.notesWindow.setQuitting(isQuitting);
    }

    if (this.indexBrowserWindow) {
      this.indexBrowserWindow.setQuitting(isQuitting);
    }

    if (this.researchWindow) {
      this.researchWindow.setQuitting(isQuitting);
    }
  }

  /**
   * Shutdown all windows
   */
  shutdown() {
    this.logger.info('Shutting down window manager');
    
    this.setQuitting(true);
    
    // Cancel artifacts auto-hide timer
    this.cancelArtifactsAutoHide();
    
    // Cancel any in-progress fades (prevents setInterval from firing post-destroy)
    if (this.artifactsWindow) {
      this.artifactsWindow.cancelFade();
    }
    if (this.chatWindow) {
      this.chatWindow.cancelFade();
    }
    
    // Remove visibility forwarding listeners before destroying windows
    for (const { bw, onShow, onHide } of this._visibilityListeners) {
      try {
        if (bw && !bw.isDestroyed()) {
          bw.removeListener('show', onShow);
          bw.removeListener('hide', onHide);
        }
      } catch (err) {
        this.logger.debug('Failed to remove visibility listener', { error: err.message });
      }
    }
    this._visibilityListeners = [];
    
    if (this.artifactsWindow) {
      this.artifactsWindow.destroy();
    }
    
    if (this.notesWindow) {
      this.notesWindow.destroy();
    }
    
    if (this.indexBrowserWindow) {
      this.indexBrowserWindow.destroy();
    }
    
    if (this.researchWindow) {
      this.researchWindow.destroy();
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

  getNotesWindow() {
    return this.notesWindow?.getWindow();
  }

  getIndexBrowserWindow() {
    return this.indexBrowserWindow?.getWindow();
  }

  getResearchWindow() {
    return this.researchWindow?.getWindow();
  }

  /**
   * Check if webContents belongs to a managed window
   * @param {WebContents} webContents 
   * @returns {boolean}
   */
  isValidWebContents(webContents) {
    if (!webContents) return false;
    
    const mainWindow = this.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed() && webContents === mainWindow.webContents) {
      return true;
    }
    
    const chatWindow = this.getChatWindow();
    if (chatWindow && !chatWindow.isDestroyed() && webContents === chatWindow.webContents) {
      return true;
    }
    
    const artifactsWindow = this.getArtifactsWindow();
    if (artifactsWindow && !artifactsWindow.isDestroyed() && webContents === artifactsWindow.webContents) {
      return true;
    }
    
    const notesWindow = this.getNotesWindow();
    if (notesWindow && !notesWindow.isDestroyed() && webContents === notesWindow.webContents) {
      return true;
    }
    
    const indexBrowserWindow = this.getIndexBrowserWindow();
    if (indexBrowserWindow && !indexBrowserWindow.isDestroyed() && webContents === indexBrowserWindow.webContents) {
      return true;
    }
    
    const researchWindow = this.getResearchWindow();
    if (researchWindow && !researchWindow.isDestroyed() && webContents === researchWindow.webContents) {
      return true;
    }
    
    return false;
  }

  get isChatInNotchMode() {
    return this.chatWindow?._isNotchMode || false;
  }

  get isArtifactsWindowActive() {
    return this.artifactsWindow?.getActive() || false;
  }

  get isWidgetMode() {
    return this.mainWindow?.isWidgetMode || false;
  }

  // ==========================================================================
  // Main Window Operations
  // ==========================================================================

  sendToMain(channel, ...args) {
    if (!this.mainWindow || !this.mainWindow.exists()) {
      return false;
    }
    return this.mainWindow.send(channel, ...args);
  }

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

  startWidgetDrag(screenPos) {
    if (this.mainWindow) {
      this.mainWindow.startWidgetDrag(screenPos);
    }
  }

  moveWidgetDrag(screenPos) {
    if (this.mainWindow) {
      this.mainWindow.moveWidgetDrag(screenPos);
    }
  }

  endWidgetDrag() {
    if (this.mainWindow) {
      this.mainWindow.endWidgetDrag();
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
      this.chatWindow = new ChatWindow({
        ...this.options.chatWindow,
        onNotchModeChanged: this._handleNotchModeChanged.bind(this)
      });
    }
    const alreadyExisted = this.chatWindow.exists();
    this.chatWindow.create();
    if (!alreadyExisted) {
      this._setupVisibilityForwarding('chat', this.chatWindow);
    }
  }

  _handleNotchModeChanged(enabled) {
    if (!enabled && this.artifactsWindow && this.artifactsWindow.exists() && this.artifactsWindow.getActive()) {
      this.logger.debug('Showing artifacts window after exiting notch mode because it is active');
      this.artifactsWindow.show();
    }
  }

  controlChatWindow(action) {
    if (!this.chatWindow) {
      this.createChatWindow();
      return;
    }
    this.chatWindow.control(action);
  }

  /**
   * Ensures the chat window is created, visible, and focused.
   * Centralizes window lifecycle logic.
   */
  ensureChatWindowVisible() {
    if (!this.chatWindow || !this.chatWindow.exists()) {
      this.createChatWindow();
      if (this.chatWindow && this.chatWindow.exists()) {
        this.chatWindow.show();
        this.chatWindow.focus();
      }
    } else {
      this.chatWindow.show();
      this.chatWindow.focus();
    }
  }

  /**
   * Send message to chat window (with auto-create and queueing).
   */
  sendToChat(channel, ...args) {
    // Cancel in-progress fade
    if (this.chatWindow) {
      this.chatWindow.cancelFade();
    }

    // Create window if it doesn't exist
    if (!this.chatWindow || !this.chatWindow.exists()) {
      this.createChatWindow();
    }
    
    // Send with queueing support
    const success = this.chatWindow.send(channel, ...args);
    
    return success;
  }

  // ==========================================================================
  // Artifacts Window Operations
  // ==========================================================================

  createArtifactsWindow() {
    if (!this.artifactsWindow) {
      this.artifactsWindow = new ArtifactsWindow(this.options.artifactsWindow);
    }
    const alreadyExisted = this.artifactsWindow.exists();
    this.artifactsWindow.create();
    if (!alreadyExisted) {
      this._setupVisibilityForwarding('artifacts', this.artifactsWindow);
    }
  }

  controlArtifactsWindow(action) {
    if (!this.artifactsWindow) {
      this.createArtifactsWindow();
      return;
    }
    this.artifactsWindow.control(action);
  }

  /**
   * Ensures the artifacts window is created, visible, and focused.
   * Centralizes window lifecycle logic.
   */
  ensureArtifactsWindowVisible() {
    if (!this.artifactsWindow || !this.artifactsWindow.exists()) {
      this.createArtifactsWindow();
    }
    
    if (this.artifactsWindow && this.artifactsWindow.exists()) {
      if (!this.isChatInNotchMode) {
        this.artifactsWindow.show();
        this.artifactsWindow.focus();
      } else {
        this.artifactsWindow.setActive(true);
      }
    }
  }

  /**
   * Schedule the artifacts window to auto-hide after a 2s delay.
   * Called when an agent response completes (chat:request-complete).
   * Each call resets the timer — rapid responses only trigger one hide.
   * The timer is cancelled if new artifact data arrives (sendToArtifacts).
   */
  scheduleArtifactsAutoHide() {
    // Reset: clear any pending timer so only the latest fires
    this.cancelArtifactsAutoHide();

    this._artifactsAutoHideTimer = setTimeout(() => {
      this._artifactsAutoHideTimer = null;
      if (this.artifactsWindow && this.artifactsWindow.exists()) {
        const bw = this.artifactsWindow.getWindow();
        if (bw && !bw.isDestroyed() && bw.isVisible()) {
          this.artifactsWindow.fadeHide();
          this.logger.debug('Artifacts auto-hide triggered after response completion');
        }
      }
    }, 2000);
  }

  /**
   * Cancel any pending artifacts auto-hide timer.
   * Called by sendToArtifacts() (new data wins) and shutdown().
   */
  cancelArtifactsAutoHide() {
    if (this._artifactsAutoHideTimer) {
      clearTimeout(this._artifactsAutoHideTimer);
      this._artifactsAutoHideTimer = null;
    }
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
   * Send message to artifacts window (with auto-create and queueing).
   * Cancels any pending auto-hide or in-progress fade — new artifact
   * data always wins over a scheduled hide.
   */
  sendToArtifacts(channel, ...args) {
    // New data arriving: cancel pending auto-hide and any in-progress fade
    this.cancelArtifactsAutoHide();
    if (this.artifactsWindow) {
      this.artifactsWindow.cancelFade();
    }

    // Create window if it doesn't exist
    if (!this.artifactsWindow || !this.artifactsWindow.exists()) {
      this.createArtifactsWindow();
    }
    
    // Send with queueing support
    const success = this.artifactsWindow.send(channel, ...args);
    
    return success;
  }

  /**
   * Focus artifacts window (with optional data)
   */
  focusArtifacts(data) {
    this.logger.debug('Forwarding focus-artifacts', { data });
    this.sendToArtifacts('artifacts:focus-artifacts', data);
    if (this.artifactsWindow && this.artifactsWindow.exists()) {
      this.artifactsWindow.focus();
    }
  }

  /**
   * Load code in artifacts window
   */
  loadArtifactsCode(data) {
    this.logger.debug('Forwarding load-code', { data });
    this.ensureArtifactsWindowVisible();
    this.sendToArtifacts('artifacts:load-code', data);
  }

  /**
   * Load output in artifacts window
   */
  loadArtifactsOutput(data) {
    this.logger.debug('Forwarding load-output', { data });
    this.ensureArtifactsWindowVisible();
    this.sendToArtifacts('artifacts:load-output', data);
  }

  // ==========================================================================
  // Notes Window Operations
  // ==========================================================================

  createNotesWindow() {
    if (!this.notesWindow) {
      this.notesWindow = new NotesWindow(this.options.notesWindow || {});
    }
    this.notesWindow.create();
  }

  controlNotesWindow(action) {
    if (!this.notesWindow) {
      this.createNotesWindow();
      return;
    }
    this.notesWindow.control(action);
  }

  sendToNotes(channel, ...args) {
    if (!this.notesWindow || !this.notesWindow.exists()) {
      this.createNotesWindow();
    }
    return this.notesWindow.send(channel, ...args);
  }

  // ==========================================================================
  // Index Browser Window Operations
  // ==========================================================================

  createIndexBrowserWindow() {
    if (!this.indexBrowserWindow) {
      this.indexBrowserWindow = new IndexBrowserWindow(this.options.indexBrowserWindow || {});
    }
    this.indexBrowserWindow.create();
  }

  controlIndexBrowserWindow(action) {
    if (!this.indexBrowserWindow) {
      this.createIndexBrowserWindow();
      return;
    }
    this.indexBrowserWindow.control(action);
  }

  sendToIndexBrowser(channel, ...args) {
    if (!this.indexBrowserWindow || !this.indexBrowserWindow.exists()) {
      this.createIndexBrowserWindow();
    }
    return this.indexBrowserWindow.send(channel, ...args);
  }

  // ==========================================================================
  // Research Window Operations
  // ==========================================================================

  createResearchWindow() {
    if (!this.researchWindow) {
      this.researchWindow = new ResearchWindow(this.options.researchWindow || {});
    }
    this.researchWindow.create();
  }

  controlResearchWindow(action) {
    if (!this.researchWindow) {
      this.createResearchWindow();
      return;
    }
    this.researchWindow.control(action);
  }

  sendToResearch(channel, ...args) {
    if (!this.researchWindow || !this.researchWindow.exists()) {
      this.createResearchWindow();
    }
    return this.researchWindow.send(channel, ...args);
  }

  // ==========================================================================
  // Aux Window Visibility Forwarding (Panel Dock)
  // ==========================================================================

  /**
   * Attach BrowserWindow show/hide listeners and forward visibility state
   * to the main renderer via IPC for the Panel Dock component.
   * @param {string} windowName - 'chat' or 'artifacts'
   * @param {ChatWindow|ArtifactsWindow} windowWrapper - Window wrapper instance
   * @private
   */
  _setupVisibilityForwarding(windowName, windowWrapper) {
    const bw = windowWrapper.getWindow();
    if (!bw || bw.isDestroyed()) return;

    const onShow = () => this._sendVisibility(windowName, true);
    const onHide = () => this._sendVisibility(windowName, false);

    bw.on('show', onShow);
    bw.on('hide', onHide);
    this._visibilityListeners.push({ bw, onShow, onHide });

    // Send initial state immediately so the dock has correct state on mount
    const visible = bw.isVisible();
    this._sendVisibility(windowName, visible);

    this.logger.debug(`Visibility forwarding attached for ${windowName} (initial: ${visible})`);
  }

  /**
   * Send aux window visibility state to the main renderer.
   * Guards against destroyed main window during shutdown.
   * @param {string} windowName - 'chat' or 'artifacts'
   * @param {boolean} visible
   * @private
   */
  _sendVisibility(windowName, visible) {
    try {
      const mainWin = this.getMainWindow();
      if (!mainWin || mainWin.isDestroyed()) return;
      const wc = mainWin.webContents;
      if (!wc || wc.isDestroyed()) return;
      wc.send('aux:visibility-changed', { window: windowName, visible });
    } catch (err) {
      // Swallow during shutdown — main window may be mid-destruction
      this.logger.debug('Visibility send failed (likely shutdown)', { error: err.message });
    }
  }

  /**
   * Get current visibility state of both aux windows.
   * Used by the renderer's initial state query (aux:get-visibility invoke).
   * @returns {{ chat: boolean, artifacts: boolean }}
   */
  getAuxVisibility() {
    const chatBw = this.getChatWindow();
    const artBw = this.getArtifactsWindow();
    return {
      chat: !!(chatBw && !chatBw.isDestroyed() && chatBw.isVisible()),
      artifacts: !!(artBw && !artBw.isDestroyed() && artBw.isVisible()),
    };
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
      
      // URL handling: use shell.openExternal for http/https URLs
      if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
        try {
          // Security: validate URL before opening to prevent protocol injection
          const parsed = new URL(filePath);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            this.logger.error('Blocked non-HTTP URL protocol', { url: filePath, protocol: parsed.protocol });
            return;
          }
          await shell.openExternal(filePath);
          this.logger.info('URL opened in browser', { url: filePath });
        } catch (urlErr) {
          this.logger.error('Failed to open URL', { url: filePath, error: urlErr.message });
        }
        return;
      }
      
      // Local file handling: verify existence then open with system default
      if (!fs.existsSync(filePath)) {
        this.logger.error('File does not exist', { filePath });
        return;
      }
      
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
