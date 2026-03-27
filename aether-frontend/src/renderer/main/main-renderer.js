'use strict';

/**
 * @.architecture
 *
 * Incoming: preload bridge (from main-preload.js) --- {ipc.bridge, javascript_api}
 * Processing: Bootstrap DI container, instantiate MainController/MainApp, register endpoint/event bus --- {3 jobs: JOB_INITIALIZE, JOB_DELEGATE_TO_MODULE, JOB_EMIT_EVENT}
 * Outgoing: MainController.init(), container registrations --- {controller_instance, javascript_module}
 */

const { createRendererLogger } = require('../shared/utils/logger');
const log = createRendererLogger('MainRenderer');

log.debug('Main Renderer: Starting...');

const { getAether } = require('../shared/bridge/AetherBridge');
const aether = getAether();

if (!aether) {
  log.error('Main Renderer: Preload API not available');
  document.body.innerHTML = '<div class="error-screen"><h1>Security Error</h1><p>Preload API not available. Check main-preload.js configuration.</p></div>';
  throw new Error('Preload API not found');
}

// ============================================================================
// EARLY DOUBLE-CLICK HANDLER
// ============================================================================
// Register a document-level dblclick handler BEFORE the startup splash runs.
// During the splash, MainApp's setupEventListeners() hasn't executed yet, so
// there are no dblclick handlers on #root / canvas / #widget-interaction-layer.
// If the window blurs during startup (entering widget mode), the user has NO
// way to double-click to restore without this early handler.
//
// Once MainApp fully initializes, its specific element handlers call
// event.stopPropagation() so this document-level handler does not double-fire.
// ============================================================================
let _earlyDblClickActive = true;

/**
 * Global flag: set to true by MainApp.setupEventListeners() once specific
 * element-level dblclick handlers are wired. At that point the early handler
 * becomes redundant (the element handlers stopPropagation before it fires).
 * The flag is a safety net — if stopPropagation somehow fails, the early
 * handler will no-op to prevent a double-toggle.
 */
window.__mainAppDblClickReady = false;

function _earlyDblClickHandler(e) {
  if (!_earlyDblClickActive) return;
  // Safety: if MainApp has taken over, skip (element handlers stopPropagation,
  // but guard against edge cases where propagation still reaches document).
  if (window.__mainAppDblClickReady) return;
  try {
    aether.window.onDoubleClick();
    log.debug('[MainRenderer] Early dblclick handler fired (pre-init toggle)');
  } catch (err) {
    log.warn('[MainRenderer] Early dblclick IPC failed:', err?.message || err);
  }
}

document.addEventListener('dblclick', _earlyDblClickHandler);

// Expose cleanup so MainApp can deactivate the early handler when ready
window.__deactivateEarlyDblClick = function () {
  _earlyDblClickActive = false;
  try {
    document.removeEventListener('dblclick', _earlyDblClickHandler);
  } catch (_) { /* ignore */ }
};

const { createRendererContainer } = require('../shared/platform/container');
const { createRendererEventBus } = require('../shared/platform/eventBus');
const { createRendererEndpoint } = require('../shared/platform/endpoint');
const { StartupSplash } = require('../shared/components/StartupSplash');
const MainController = require('./controllers/MainController');
const MainApp = require('./runtime/MainApp');
const SettingsManager = require('../../application/main/modules/settings/SettingsManager');
const DEFAULTS = require('../../core/config/defaults');

function resolveRendererEnv() {
  if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV) {
    return process.env.NODE_ENV;
  }
  return 'production';
}

async function resolveBackendBaseUrl() {
  // Ensure main window config-init completed (it resolves backend URL via main process PortManager discovery).
  if (window.__AETHER_CONFIG_READY__) {
    await window.__AETHER_CONFIG_READY__;
  }
  const baseUrl = window.AETHER_CONFIG?.backend?.baseUrl || DEFAULTS.backend.baseUrl;
  if (!baseUrl || typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
    throw new Error('[MainRenderer] CONTRACT VIOLATION: Missing backend baseUrl. Config init did not complete.');
  }
  return baseUrl;
}

function resolveBackendWsUrl(baseUrl) {
  return baseUrl.replace(/^http/, 'ws');
}

async function createRendererConfig() {
  const baseUrl = await resolveBackendBaseUrl();
  const wsUrl = resolveBackendWsUrl(baseUrl);

  return Object.freeze({
    NODE_ENV: resolveRendererEnv(),
    API_BASE_URL: baseUrl,
    WS_URL: wsUrl,
    API_TIMEOUT: DEFAULTS.api.timeout,
    WS_RECONNECT_INTERVAL: DEFAULTS.websocket.reconnectDelay,
    // CRITICAL: Defer WebSocket connection until MainApp's onboarding gate resolves.
    // Backend takes 30-60s to cold-start on first run. Without deferral, the
    // GuruConnection spams reconnect errors the entire time, polluting logs
    // and confusing users. MainApp.initialize() calls guru.connect() after
    // the onboarding gate passes (backend is confirmed healthy).
    deferConnect: true,
  });
}

async function bootstrap() {
  const config = await createRendererConfig();
  let snapshot = null;
  try {
    snapshot = aether?.config?.getSnapshot?.() || null;
  } catch (error) {
    log.warn('[MainRenderer] Failed to read preload config snapshot (non-fatal):', error?.message || error);
    snapshot = null;
  }

  const container = createRendererContainer({ name: 'main' });
  container.register('config', () => config, { singleton: true });

  const eventBus = createRendererEventBus({
    name: 'main',
    maxListeners: 100,
    enableLogging: config.NODE_ENV === 'development',
  });
  container.register('eventBus', () => eventBus, { singleton: true });

  // Backend availability gate: pass at construction so both ApiClient and GuruConnection
  // see the gate from their first instruction (no timing race).
  const skipHealth = snapshot?.dev?.skipHealthCheck;
  container.register('endpoint', () => createRendererEndpoint({
    ...config,
    backendAvailable: !skipHealth
  }), { singleton: true });

  if (skipHealth) {
    log.info('[MainRenderer] Backend availability set to false (dev.skipHealthCheck=true)');
  }

  container.register(
    'mainApp',
    () =>
      new MainApp({
        config,
        endpoint: container.resolve('endpoint'),
        settingsManagerFactory: SettingsManager,
        ipc: aether.ipc,
        eventBus,
      }),
    { singleton: true }
  );

  const controller = new MainController({
    container,
    eventBus,
    config,
    ipc: aether.ipc,
  });

  let startupSplash = null;
  async function runStartupSplash() {
    try {
      startupSplash = new StartupSplash({ windowName: 'main', configSnapshot: snapshot });
      // Splash now includes backend health gate -- it stays visible until
      // backend /v1/health returns 2xx. No retry banners. Clean premium UX.
      await startupSplash.run();

      // NOTE: Do NOT send startup:animation-complete here!
      // It will be sent AFTER onboarding completes (or immediately if onboarding not needed)
      // This prevents chat/artifacts windows from opening during onboarding

      log.debug('[MainRenderer] Splash complete (backend healthy), continuing init...');
    } catch (error) {
      log.warn('[MainRenderer] Startup splash failed:', error?.message || error);
    }
  }

  async function initialize() {
    // Premium startup animation + backend health gate: blocks until backend is ready.
    await runStartupSplash();

    await controller.init();
    window.__mainController = controller;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }

  window.addEventListener('beforeunload', (event) => {
    // HIGH FIX: Await async dispose() - use event.preventDefault() + async cleanup
    event.preventDefault();
    try {
      startupSplash?.dispose();
      startupSplash = null;
    } catch (error) {
      log.warn('[MainRenderer] Failed to dispose StartupSplash:', error?.message || error);
    }
    controller.dispose().then(() => {
      // Allow window to close after cleanup completes
      window.close();
    }).catch((error) => {
      log.error('[MainRenderer] Dispose failed:', error);
      window.close();
    });
  });
}

bootstrap().catch((error) => {
  log.error('[MainRenderer] Fatal bootstrap error:', error?.message || error);
  document.body.innerHTML =
    '<div class="error-screen"><h1>Startup Error</h1><p>Failed to initialize main window. Check logs.</p></div>';
  throw error;
});

log.debug('Main renderer script loaded');
