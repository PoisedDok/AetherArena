'use strict';

/**
 * Resolve the frontend storage API that the preload layer exposes.
 * Preference order:
 *   1. Explicit instance passed in via options.storageAPI
 *   2. globalThis.aether.storage (bridged IPC proxy)
 *   3. globalThis.aether.storageAPI (legacy exposure)
 *   4. globalThis.storageAPI (fallback)
 *
 * The resolver is safe to execute in browser (window) and Node/electron
 * contexts since it relies on globalThis.
 *
 * @param {object} [options]
 * @param {object|null} [options.storageAPI]
 * @returns {object|null}
 */
function resolveStorageAPI(options = {}) {
  if (options.storageAPI) {
    return options.storageAPI;
  }

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : undefined;

  if (globalRef) {
    if (globalRef.aether && globalRef.aether.storage) {
      return globalRef.aether.storage;
    }
    if (globalRef.aether && globalRef.aether.storageAPI) {
      return globalRef.aether.storageAPI;
    }
    if (globalRef.storageAPI) {
      return globalRef.storageAPI;
    }
  }

  return null;
}

module.exports = {
  resolveStorageAPI,
};
