'use strict';

/**
 * Notes Window Preload Script
 * ============================================================================
 * Secure preload for detached notes window.
 */

const { contextBridge, ipcRenderer } = require('electron');
const { createBridge } = require('./common/bridge-factory');
const { createLogger } = require('../core/utils/logger');
const { freeze } = Object;
const rendererConfig = require('../core/config/renderer-config');
const { injectCspMeta } = require('./common/csp-injector');

const log = createLogger({ component: 'NotesPreload' });

injectCspMeta({ getConfigSnapshot: rendererConfig.getConfigSnapshot });

const ipcBridge = createBridge({
  ipcRenderer,
  context: 'notesWindow',
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

  window: freeze({
    openNotes: (initialData = null) => {
      ipcBridge.send('window:open-notes', initialData);
    },
  }),

  dialog: freeze({
    async saveTextFile(content, defaultPath = 'notes.md') {
      try {
        return await ipcBridge.invoke('dialog:save-file', { content, defaultPath });
      } catch (error) {
        log.error('save file failed', { error: error.message });
        return { success: false, error: error.message };
      }
    },

    async readTextFile() {
      try {
        return await ipcBridge.invoke('dialog:read-file', {});
      } catch (error) {
        log.error('read file failed', { error: error.message });
        return null;
      }
    }
  }),
});

try {
  contextBridge.exposeInMainWorld('aether', aetherAPI);
  log.info('notes window API exposed');
} catch (error) {
  log.error('failed to expose API', { error: error.message });
  throw error;
}
