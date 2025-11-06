'use strict';

/**
 * @.architecture
 * 
 * Incoming: Electron BrowserWindow, artifacts-preload.js (window.aether API) --- {object, javascript_api}
 * Processing: Initialize DI container, register services (EventBus, StorageAPI, Config), bootstrap ArtifactsController with 6 modules (Window, TabManager, CodeViewer, OutputViewer, FileManager, SafeCodeExecutor), setup global error handlers --- {5 jobs: JOB_CREATE_BRIDGE, JOB_DELEGATE_TO_MODULE, JOB_GET_STATE, JOB_INITIALIZE, JOB_TRACK_ENTITY}
 * Outgoing: ArtifactsController initialized with full module tree, IPC listeners active, DOM rendered --- {controller_instance, ArtifactsController}
 * 
 * @module renderer/artifacts/renderer
 */

console.log('🚀 Artifacts Renderer: Starting...');

if (!window.aether) {
  console.error('❌ Artifacts Renderer: Preload API not available');
  document.body.innerHTML = `
    <div style="padding: 40px; text-align: center; font-family: system-ui; color: #ff4444;">
      <h1>Security Error</h1>
      <p>Preload API not available. Check artifacts-preload.js configuration.</p>
    </div>
  `;
  throw new Error('Preload API not found');
}

console.log('✅ Artifacts Renderer: Preload API available');
console.log('📦 Aether versions:', window.aether.versions);

const { DependencyContainer } = require('../../core/di/Container');
const EventBus = require('../../core/events/EventBus');
const { EventTypes } = require('../../core/events/EventTypes');
const ArtifactsController = require('./controllers/ArtifactsController');
const { StorageAPI } = require('../../infrastructure/api/storage');
const config = require('../../core/config/renderer-config');

let controller = null;
let container = null;
let eventBus = null;

async function bootstrap() {
  console.log('🏗️  Bootstrapping artifacts application...');

  try {
    container = new DependencyContainer();
    
    eventBus = new EventBus({
      enableLogging: config.dev.verboseLogging,
      maxListeners: 10
    });
    container.register('eventBus', () => eventBus, { singleton: true });

    const storageAPI = new StorageAPI({
      enableLogging: config.dev.verboseLogging
    });
    window.storageAPI = storageAPI;
    container.register('storageAPI', () => storageAPI, { singleton: true });

    controller = new ArtifactsController({
      container,
      eventBus,
      config: {
        API_BASE_URL: config.backend.baseUrl,
        WS_URL: config.backend.wsUrl,
        NODE_ENV: config.dev.debugMode ? 'development' : 'production'
      },
      ipc: window.aether.ipc
    });

    await controller.init();

    window.artifactsController = controller;
    window.eventBus = eventBus;
    window.container = container;

    eventBus.on(EventTypes.SYSTEM.ERROR, (error) => {
      console.error('[ArtifactsRenderer] System error:', error);
    });

    console.log('✅ Artifacts application bootstrapped successfully');
    console.log('📊 Controller stats:', controller.getStats());

  } catch (error) {
    console.error('❌ Bootstrap failed:', error);
    document.body.innerHTML = `
      <div style="padding: 40px; text-align: center; font-family: system-ui;">
        <h1 style="color: #ff4444;">Initialization Error</h1>
        <p>${error.message}</p>
        <pre style="text-align: left; background: #f5f5f5; padding: 20px; border-radius: 8px;">${error.stack}</pre>
      </div>
    `;
    throw error;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}

window.addEventListener('beforeunload', () => {
  if (controller) {
    controller.dispose();
  }
});

window.addEventListener('error', (event) => {
  console.error('[ArtifactsRenderer] Unhandled error:', event.error);
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
  console.error('[ArtifactsRenderer] Unhandled promise rejection:', event.reason);
  if (eventBus) {
    eventBus.emit(EventTypes.SYSTEM.ERROR, {
      error: event.reason,
      promise: event.promise
    });
  }
});

console.log('✅ Artifacts renderer script loaded');
