'use strict';

/**
 * Research Window Preload Script
 * ============================================================================
 * Secure preload for detached research dashboard window.
 */

const { contextBridge, ipcRenderer } = require('electron');
const { createBridge } = require('./common/bridge-factory');
const { createLogger } = require('../core/utils/logger');
const { freeze } = Object;
const rendererConfig = require('../core/config/renderer-config');
const { injectCspMeta } = require('./common/csp-injector');

const log = createLogger({ component: 'ResearchPreload' });

injectCspMeta({ getConfigSnapshot: rendererConfig.getConfigSnapshot });

const ipcBridge = createBridge({
  ipcRenderer,
  context: 'researchWindow',
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
});

try {
  contextBridge.exposeInMainWorld('aether', aetherAPI);
  log.info('research window API exposed');
} catch (error) {
  log.error('failed to expose API', { error: error.message });
  throw error;
}
