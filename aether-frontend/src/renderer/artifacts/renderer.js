'use strict';

/**
 * @.architecture
 * 
 * Incoming: Electron BrowserWindow, artifacts-preload.js (preload API) --- {object, javascript_api}
 * Processing: Initialize DI container, register services (EventBus, StorageAPI, Config), bootstrap ArtifactsController with 6 modules (Window, TabManager, CodeViewer, OutputViewer, FileManager, SafeCodeExecutor), setup global error handlers --- {4 jobs: JOB_DELEGATE_TO_MODULE, JOB_GET_STATE, JOB_INITIALIZE, JOB_TRACK_ENTITY}
 * Outgoing: ArtifactsController initialized with full module tree, IPC listeners active, DOM rendered --- {controller_instance, ArtifactsController}
 * 
 * @module renderer/artifacts/renderer
 */

const { createRendererLogger } = require('../shared/utils/logger');
const log = createRendererLogger('ArtifactsRenderer');

log.debug('Artifacts Renderer: Starting...');

const { getAether } = require('../shared/bridge/AetherBridge');
const aether = getAether();

if (!aether) {
  log.error('Artifacts Renderer: Preload API not available');
  document.body.innerHTML = '<div class="error-screen"><h1>Security Error</h1><p>Preload API not available. Check artifacts-preload.js configuration.</p></div>';
  throw new Error('Preload API not found');
}

log.debug('Artifacts Renderer: Preload API available');
log.debug('Aether versions:', aether.versions);

const { createRendererContainer } = require('../shared/platform/container');
const { createRendererEventBus, RendererEventTypes: EventTypes } = require('../shared/platform/eventBus');
const { createRendererEndpoint } = require('../shared/platform/endpoint');
const { resolveStorageAPI } = require('../../shared/utils/storage-resolver');
const { StartupSplash } = require('../shared/components/StartupSplash');
const ArtifactsController = require('./controllers/ArtifactsController');
const ArtifactsApp = require('./runtime/ArtifactsApp');
const DEFAULTS = require('../../core/config/defaults');

async function resolveBackendBaseUrl() {
  if (!aether?.ipc?.invoke) {
    throw new Error('[ArtifactsRenderer] CONTRACT VIOLATION: aether.ipc.invoke is required for backend discovery');
  }
  const baseUrl = await aether.ipc.invoke('backend:get-url');
  if (!baseUrl || typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
    throw new Error('[ArtifactsRenderer] CONTRACT VIOLATION: Missing backend baseUrl (backend not discoverable)');
  }
  return baseUrl.replace(/\/$/, '');
}

function resolveBackendWsUrl(baseUrl) {
  return baseUrl.replace(/^http/, 'ws');
}

function resolveNodeEnv() {
  if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV) {
    return process.env.NODE_ENV;
  }
  return 'production';
}

async function createRendererConfig() {
  const baseUrl = await resolveBackendBaseUrl();
  const wsUrl = resolveBackendWsUrl(baseUrl);
  return Object.freeze({
    NODE_ENV: resolveNodeEnv(),
    API_BASE_URL: baseUrl,
    WS_URL: wsUrl,
    API_TIMEOUT: DEFAULTS.api.timeout,
    WS_RECONNECT_INTERVAL: DEFAULTS.websocket.reconnectDelay,
  });
}

let controller = null;
let container = null;
let eventBus = null;
let startupSplash = null;

async function runStartupSplash() {
  if (startupSplash) {
    return;
  }
  try {
    const snapshot = aether?.config?.getSnapshot?.() || null;
    startupSplash = new StartupSplash({ windowName: 'artifacts', configSnapshot: snapshot });
    await startupSplash.run();
  } catch (error) {
    log.warn('[ArtifactsRenderer] Startup splash failed:', error?.message || error);
    startupSplash = null;
  }
}

async function applyUiEffectsSettings() {
  if (typeof document === 'undefined') {
    return;
  }
  // Offline-safe: artifacts window must boot even when backend is unavailable.
  // Default to 'full' effects until settings can be fetched later.
  if (!container) {
    log.warn('[ArtifactsRenderer] Container not initialized for UI settings; using defaults');
    document.documentElement.setAttribute('data-effects', 'full');
    return;
  }

  try {
    const endpoint = container.resolve('endpoint');
    const settings = await endpoint.getSettings();
    const effectsMode = settings?.ui?.effects_mode === 'reduced' ? 'reduced' : 'full';
    document.documentElement.setAttribute('data-effects', effectsMode);
  } catch (error) {
    log.warn('[ArtifactsRenderer] Failed to load ui settings; using defaults', error?.message || error);
    document.documentElement.setAttribute('data-effects', 'full');
  }
}

async function bootstrap() {
  log.debug('Bootstrapping artifacts application...');

  try {
    const config = await createRendererConfig();

    container = createRendererContainer({ name: 'artifacts' });

    eventBus = createRendererEventBus({
      name: 'artifacts',
      enableLogging: config.NODE_ENV === 'development',
      maxListeners: 50
    });
    container.register('eventBus', () => eventBus, { singleton: true });

    // Backend availability gate: resolve BEFORE endpoint creation so the flag
    // is passed into the constructor (prevents GuruConnection auto-connect race).
    const snapshot = aether?.config?.getSnapshot?.() || null;
    const skipHealth = snapshot?.dev?.skipHealthCheck;

    container.register(
      'endpoint',
      () =>
        createRendererEndpoint({ ...config, backendAvailable: !skipHealth }),
      { singleton: true }
    );

    if (skipHealth) {
      log.info('[ArtifactsRenderer] Backend availability set to false (dev.skipHealthCheck=true)');
    }

    const storageAPI =
      resolveStorageAPI({ storageAPI: aether ? (aether.storage || aether.storageAPI) : null });

    if (!storageAPI) {
      throw new Error(
        '[ArtifactsRenderer] Storage API unavailable. Ensure artifacts-preload exposes storage bridge before bootstrapping.'
      );
    }

    container.register('storageAPI', () => storageAPI, { singleton: true });

    container.register(
      'artifactsApp',
      () =>
        new ArtifactsApp({
          container,
          eventBus,
          config,
          ipc: aether.artifacts
        }),
      { singleton: true }
    );

    controller = new ArtifactsController({
      container,
      eventBus,
      config,
      ipc: aether.ipc,
      storageAPI
    });

    await controller.init();
    await applyUiEffectsSettings();

    window.artifactsController = controller;
    window.eventBus = eventBus;
    window.container = container;

    eventBus.on(EventTypes.SYSTEM.ERROR, (error) => {
      log.error('[ArtifactsRenderer] System error:', error);
    });

    // Signal to main process that the renderer is fully bootstrapped and all
    // IPC listeners are registered. The main process ArtifactsWindow gates
    // its message queue flush on this signal — without it, messages sent via
    // webContents.send() arrive before any ipcRenderer listener is attached
    // and are silently dropped, causing a blank artifacts window.
    try {
      aether.ipc.send('artifacts:renderer-ready');
      log.debug('Renderer-ready signal sent to main process');
    } catch (readySignalError) {
      log.error('[ArtifactsRenderer] Failed to send renderer-ready signal:', readySignalError);
    }

    log.debug('Artifacts application bootstrapped successfully');
    log.debug('Controller stats:', controller.getStats());

  } catch (error) {
    log.error('Bootstrap failed:', error);
    document.body.innerHTML = '<div style="padding: 40px; text-align: center; font-family: system-ui;"><h1 style="color: var(--color-error);">Initialization Error</h1><p class="error-message"></p><pre class="error-stack" style="text-align: left; background: var(--color-surface-base); color: var(--color-text-primary); padding: 20px; border-radius: var(--radius-md);"></pre></div>';
    const msgEl = document.querySelector('.error-message');
    const stackEl = document.querySelector('.error-stack');
    if (msgEl) msgEl.textContent = error.message || 'Unknown error';
    if (stackEl) stackEl.textContent = error.stack || 'No stack trace';
    throw error;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}

window.addEventListener('beforeunload', (event) => {
  // HIGH FIX: Await async dispose() - use event.preventDefault() + async cleanup
  if (controller) {
    event.preventDefault();
    try {
      startupSplash?.dispose();
      startupSplash = null;
    } catch (error) {
      log.warn('[ArtifactsRenderer] Failed to dispose StartupSplash:', error?.message || error);
    }
    const controllerRef = controller;
    // Null module-level state immediately to prevent post-dispose access
    // Error/rejection handlers check `if (eventBus)` before emitting
    controller = null;
    if (eventBus && typeof eventBus.removeAllListeners === 'function') {
      eventBus.removeAllListeners();
    }
    eventBus = null;
    if (container && typeof container.clear === 'function') {
      container.clear();
    }
    container = null;
    controllerRef.dispose().then(() => {
      window.close();
    }).catch((error) => {
      log.error('[ArtifactsRenderer] Dispose failed:', error);
      window.close();
    });
  }
});

window.addEventListener('error', (event) => {
  log.error('[ArtifactsRenderer] Unhandled error:', event.error);
  if (eventBus) {
    eventBus.emit(EventTypes.SYSTEM.ERROR, {
      error: event.error,
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno
    });
  }
});

window.addEventListener('unhandledrejection', (event) => {
  log.error('[ArtifactsRenderer] Unhandled promise rejection:', event.reason);
  if (eventBus) {
    eventBus.emit(EventTypes.SYSTEM.ERROR, {
      error: event.reason,
      promise: event.promise
    });
  }
});

log.debug('Artifacts renderer script loaded');
