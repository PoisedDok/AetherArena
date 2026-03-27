'use strict';

/**
 * @.architecture
 * 
 * Incoming: HTML script load --- {html_types.document_ready, Event}
 * Processing: Initialize endpoint, instantiate IndexBrowserModal, wire window controls, bind to DOM container --- {4 jobs: JOB_INITIALIZE, JOB_CREATE_DOM_ELEMENT, JOB_DELEGATE_TO_MODULE, JOB_SEND_IPC}
 * Outgoing: IndexBrowserModal instance rendered into DOM, IPC window controls --- {object, DOM}
 * 
 * @module renderer/index-browser/index
 */

const { createRendererLogger } = require('../shared/utils/logger');
const { createRendererEndpoint } = require('../shared/platform/endpoint');
const IndexBrowserModal = require('../main/modules/indexes/IndexBrowserModal');
const log = createRendererLogger('IndexBrowserRenderer');

log.debug('Index Browser Renderer: Starting...');

const aether = window.aether;

if (!aether) {
  log.error('Index Browser Renderer: Preload API not available');
  document.body.innerHTML = '<div class="error-screen"><h1>Security Error</h1><p>Preload API not available.</p></div>';
  throw new Error('Preload API not found');
}

// Ensure the modal registry doesn't conflict
window.MODAL_REGISTRY = new Set();

document.addEventListener('DOMContentLoaded', async () => {
  try {
    // 1. Resolve Backend Config & Initialize Endpoint
    let baseUrl;
    try {
      baseUrl = await aether.ipc.invoke('backend:get-url');
    } catch (err) {
      log.warn('Failed to get backend URL from IPC, falling back to default', err);
      baseUrl = 'http://127.0.0.1:8765';
    }
    
    const wsUrl = baseUrl.replace(/^http/, 'ws');
    
    const config = Object.freeze({
      API_BASE_URL: baseUrl,
      WS_URL: wsUrl,
    });
    
    const endpoint = createRendererEndpoint(config);
    
    // 2. Setup Window Controls
    const btnMinimize = document.getElementById('btn-minimize');
    const btnMaximize = document.getElementById('btn-maximize');
    const btnClose = document.getElementById('btn-close');

    if (btnMinimize) {
      btnMinimize.addEventListener('click', () => {
        if (aether.ipc) aether.ipc.send('index-browser:window-control', 'minimize');
      });
    }
    
    if (btnMaximize) {
      btnMaximize.addEventListener('click', () => {
        if (aether.ipc) aether.ipc.send('index-browser:window-control', 'maximize');
      });
    }
    
    if (btnClose) {
      btnClose.addEventListener('click', () => {
        if (aether.ipc) aether.ipc.send('index-browser:window-control', 'close');
      });
    }

    // 3. Initialize Modal
    const modalContainer = document.getElementById('modal-container');
    
    const indexBrowserModal = new IndexBrowserModal({
      id: 'standalone-index-browser',
      endpoint: endpoint,
      container: modalContainer,
    });

    // Override the base modal's close method to close the window instead
    const originalClose = indexBrowserModal.close.bind(indexBrowserModal);
    indexBrowserModal.close = () => {
      originalClose();
      if (aether.ipc) aether.ipc.send('index-browser:window-control', 'close');
    };

    // Listen for init data
    if (aether.ipc) {
      aether.ipc.on('index-browser:init', (data) => {
        log.info('Received init data', data);
        if (!indexBrowserModal.isOpen) {
            indexBrowserModal.show(data);
        } else {
            if (data) {
                indexBrowserModal._preselectSource(data);
            }
            // If the modal is already "open" but failed to load data previously
            // (e.g. backend was offline), try rendering again to retry the fetch.
            if (indexBrowserModal.indexingService.indexes.length === 0) {
                log.info('Retrying index fetch on reopen...');
                indexBrowserModal._renderContent();
            }
        }
      });
    }

    // Show by default
    await indexBrowserModal.show();

  } catch (err) {
    log.error('Initialization failed:', err);
    document.body.innerHTML = `<div style="color:red; padding:20px;">Initialization failed: ${err.message}</div>`;
  }
});
