'use strict';

/**
 * @.architecture
 * 
 * Incoming: Electron ipcRenderer (from main process) --- {object, javascript_api}
 * Processing: Create secure IPC bridge with validation/rate limiting, freeze API objects, expose to renderer via contextBridge --- {6 jobs: JOB_ATTACH_TO_WINDOW, JOB_CREATE_BRIDGE, JOB_DELEGATE_TO_MODULE, JOB_GET_STATE, JOB_INITIALIZE, JOB_SEND_IPC}
 * Outgoing: window.aether (exposed to renderer) --- {object, javascript_api}
 * 
 * @module preload/main-preload
 * 
 * Main Window Preload Script
 * ============================================================================
 * Secure preload for main widget window.
 * Exposes validated IPC bridge with rate limiting and size checks.
 * 
 * Security:
 * - contextIsolation enabled
 * - Channel whitelisting
 * - Payload validation
 * - Rate limiting
 * - Size validation
 */

const { contextBridge, ipcRenderer } = require('electron');
const { createBridge } = require('./common/bridge-factory');
const { freeze } = Object;

// ============================================================================
// Create Secure IPC Bridge
// ============================================================================

const ipcBridge = createBridge({
  ipcRenderer,
  context: 'mainWindow',
  enableRateLimiting: true,
  enableSizeValidation: true,
  enablePayloadValidation: true,
  onError: (error, details) => {
    console.error('[MainPreload] IPC Error:', error.message, details);
  },
});

// ============================================================================
// Main Window API
// ============================================================================

const aetherAPI = freeze({
  /**
   * IPC Communication
   */
  ipc: freeze({
    send: ipcBridge.send.bind(ipcBridge),
    on: ipcBridge.on.bind(ipcBridge),
    once: ipcBridge.once.bind(ipcBridge),
    removeListener: ipcBridge.removeListener.bind(ipcBridge),
    removeAllListeners: ipcBridge.removeAllListeners.bind(ipcBridge),
  }),

  /**
   * Window Controls
   */
  window: freeze({
    /**
     * Toggle widget mode
     */
    toggleWidgetMode: () => {
      ipcBridge.send('toggle-widget-mode', {});
    },

    /**
     * Handle double click (exit widget mode)
     */
    onDoubleClick: () => {
      ipcBridge.send('window-double-clicked', {});
    },

    /**
     * Update widget position
     * @param {number} x - X coordinate
     * @param {number} y - Y coordinate
     */
    updatePosition: (x, y) => {
      ipcBridge.send('widget-position-update', { x, y });
    },

    /**
     * Zoom in
     */
    zoomIn: () => {
      ipcBridge.send('zoom-in', {});
    },

    /**
     * Zoom out
     */
    zoomOut: () => {
      ipcBridge.send('zoom-out', {});
    },

    /**
     * Handle mouse wheel event
     * @param {number} deltaY - Wheel delta Y
     * @param {boolean} ctrlKey - Is Ctrl key pressed
     */
    onWheel: (deltaY, ctrlKey = false) => {
      ipcBridge.send('wheel-event', { deltaY, ctrlKey });
    },

    /**
     * Listen for widget mode changes
     * @param {Function} callback - Callback(isWidgetMode)
     * @returns {Function} Cleanup function
     */
    onWidgetModeChange: (callback) => {
      const enterCleanup = ipcBridge.on('enter-widget-mode', () => callback(true));
      const exitCleanup = ipcBridge.on('exit-widget-mode', () => callback(false));
      return () => {
        enterCleanup();
        exitCleanup();
      };
    },
  }),

  /**
   * Chat Integration
   */
  chat: freeze({
    /**
     * Send message to chat
     * @param {string} message - Message content
     * @param {Object} metadata - Optional metadata
     */
    send: (message, metadata = {}) => {
      ipcBridge.send('chat:send', { message, ...metadata });
    },

    /**
     * Listen for assistant responses
     * @param {Function} callback - Callback(chunk, metadata)
     * @returns {Function} Cleanup function
     */
    onAssistantStream: (callback) => {
      return ipcBridge.on('chat:assistant-stream', callback);
    },

    /**
     * Listen for request completion
     * @param {Function} callback - Callback(metadata)
     * @returns {Function} Cleanup function
     */
    onRequestComplete: (callback) => {
      return ipcBridge.on('chat:request-complete', callback);
    },

    /**
     * Stop current request
     */
    stop: () => {
      ipcBridge.send('chat:stop', {});
    },

    /**
     * Open/show chat window
     */
    open: () => {
      ipcBridge.send('chat:window-control', 'toggle-visibility');
    },

    /**
     * Control chat window
     * @param {string} action - minimize|maximize|close|toggle-visibility
     */
    controlWindow: (action) => {
      ipcBridge.send('chat:window-control', action);
    },
  }),

  /**
   * Artifacts Integration
   */
  artifacts: freeze({
    /**
     * Stream artifact data
     * @param {Object} data - Artifact data
     */
    stream: (data) => {
      ipcBridge.send('artifacts:stream', data);
    },

    /**
     * Open/show artifacts window
     */
    open: () => {
      ipcBridge.send('artifacts:window-control', 'toggle-visibility');
    },

    /**
     * Control artifacts window
     * @param {string} action - minimize|maximize|close|toggle-visibility
     */
    controlWindow: (action) => {
      ipcBridge.send('artifacts:window-control', action);
    },

    /**
     * Export artifact as file
     * @param {string} content - File content
     * @param {string} name - File name
     * @param {string} extension - File extension
     */
    exportFile: (content, name, extension) => {
      ipcBridge.send('artifacts:file-export', { content, name, extension });
    },

    /**
     * Open file with system app
     * @param {string} path - File path
     */
    openFile: (path) => {
      ipcBridge.send('artifacts:open-file', { path });
    },
  }),

  /**
   * Logging
   */
  log: freeze({
    /**
     * Send log to main process
     * @param {string} message - Log message
     */
    send: (message) => {
      if (typeof message === 'string' && message.length <= 10000) {
        ipcBridge.send('renderer-log', message);
      }
    },
  }),

  /**
   * Metadata
   */
  versions: freeze({
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  }),

  /**
   * Get bridge metadata
   * @returns {Object}
   */
  getMetadata: () => ipcBridge.getMetadata(),

  /**
   * Get bridge statistics
   * @returns {Object}
   */
  getStats: () => ipcBridge.getStats(),
});

// ============================================================================
// Expose API to Renderer
// ============================================================================

try {
  contextBridge.exposeInMainWorld('aether', aetherAPI);
  console.log('[MainPreload] Main window API exposed successfully');
} catch (error) {
  console.error('[MainPreload] Failed to expose API:', error);
  throw error;
}

