'use strict';

/**
 * Index Browser Window Preload Script
 * ============================================================================
 * Secure preload for detached index browser window.
 */

const { contextBridge, ipcRenderer } = require('electron');
const { createBridge } = require('./common/bridge-factory');
const { createLogger } = require('../core/utils/logger');
const { freeze } = Object;
const rendererConfig = require('../core/config/renderer-config');
const { injectCspMeta } = require('./common/csp-injector');

const log = createLogger({ component: 'IndexBrowserPreload' });

injectCspMeta({ getConfigSnapshot: rendererConfig.getConfigSnapshot });

const ipcBridge = createBridge({
  ipcRenderer,
  context: 'indexBrowserWindow',
  enableRateLimiting: true,
  enableSizeValidation: true,
  enablePayloadValidation: true,
  onError: (error, details) => {
    log.error('IPC error', { error: error.message, details });
  },
});

const aetherAPI = freeze({
  ipc: freeze({
    send: ipcBridge.send.bind(ipcBridge),
    on: ipcBridge.on.bind(ipcBridge),
    once: ipcBridge.once.bind(ipcBridge),
    removeListener: ipcBridge.removeListener.bind(ipcBridge),
    removeAllListeners: ipcBridge.removeAllListeners.bind(ipcBridge),
    invoke: ipcBridge.invoke.bind(ipcBridge),
  }),

  dialog: freeze({
    /**
     * Show directory picker dialog
     * @returns {Promise<string|null>} Selected directory path or null if canceled
     */
    async showDirectoryPicker() {
      try {
        return await ipcBridge.invoke('dialog:show-directory-picker', {});
      } catch (error) {
        log.error('directory picker failed', { error: error.message });
        return null;
      }
    },

    /**
     * Show file picker dialog
     * @param {Object} options - File picker options
     * @returns {Promise<Array<string>|null>} Selected file paths or null if canceled
     */
    async showFilePicker(options = {}) {
      try {
        return await ipcBridge.invoke('dialog:show-file-picker', options);
      } catch (error) {
        log.error('file picker failed', { error: error.message });
        return null;
      }
    },
  }),

  file: freeze({
    /**
     * Read file content
     * @param {string} path - File path
     * @returns {Promise<Object>} { success, content, filename, isBinary, error }
     */
    read: (path) => ipcBridge.invoke('file:read-by-path', { path })
  }),

  artifacts: freeze({
    /**
     * Open file with system app
     * @param {string} path - File path
     */
    openFile: (path) => {
      ipcBridge.send('artifacts:open-file', { path });
    },
  }),
});

try {
  contextBridge.exposeInMainWorld('aether', aetherAPI);
  log.info('index browser window API exposed');
} catch (error) {
  log.error('failed to expose API', { error: error.message });
  throw error;
}
