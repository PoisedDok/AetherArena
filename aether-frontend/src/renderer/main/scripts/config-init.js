/**
 * @.architecture
 * Incoming: index.html (loaded before inline scripts) --- {script, html}
 * Processing: Expose minimal config to window.AETHER_CONFIG for inline scripts --- {1 job: JOB_INITIALIZE}
 * Outgoing: window.AETHER_CONFIG --- {object, javascript_global}
 */

'use strict';

// Renderer runs with contextIsolation and no Node.js APIs.
// We MUST resolve backend URL via main process (PortManager discovery) through IPC.
//
// Contract:
// - Expose `window.__AETHER_CONFIG_READY__` Promise so subsequent scripts can await it.
// - Expose `window.AETHER_CONFIG.backend.baseUrl` once resolved.
// - Fail-fast if backend cannot be resolved.
window.__AETHER_CONFIG_READY__ = (async () => {
  const aether = window['aether'];
  if (!aether?.ipc?.invoke) {
    throw new Error('[ConfigInit] CONTRACT VIOLATION: preload ipc.invoke is required for backend discovery');
  }

  const baseUrl = await aether.ipc.invoke('backend:get-url');
  if (!baseUrl || typeof baseUrl !== 'string') {
    throw new Error('[ConfigInit] CONTRACT VIOLATION: Backend baseUrl is required. Ensure backend is running and discoverable.');
  }

  window.AETHER_CONFIG = Object.freeze({
    backend: Object.freeze({ baseUrl }),
  });

  console.log('[ConfigInit] Exposed AETHER_CONFIG.backend.baseUrl:', baseUrl);
  return window.AETHER_CONFIG;
})();

window.__AETHER_CONFIG_READY__.catch((err) => {
  console.error('[ConfigInit] Fatal config initialization error:', err?.message || err);
  // Surface as an uncaught error (fail-fast).
  setTimeout(() => {
    throw err;
  }, 0);
});
