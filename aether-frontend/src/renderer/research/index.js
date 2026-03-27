'use strict';

/**
 * @.architecture
 * Incoming: BrowserWindow load --- {electron event}
 * Processing: Initialize research window, setup IPC listeners, fetch backend status, render Perplexica iframe --- {JOB_INITIALIZE, JOB_FETCH_API, JOB_UPDATE_DOM}
 * Outgoing: Window control messages, Perplexica iframe content --- {IPC_MESSAGE, DOM_UPDATE}
 */

const { createRendererEndpoint } = require('../shared/platform/endpoint');

// Logger utility
const log = {
  info: (msg, data) => console.log(`[ResearchWindow] ${msg}`, data || ''),
  warn: (msg, data) => console.warn(`[ResearchWindow] ${msg}`, data || ''),
  error: (msg, data) => console.error(`[ResearchWindow] ${msg}`, data || '')
};

document.addEventListener('DOMContentLoaded', async () => {
  try {
    // 1. Setup Window Controls
    document.getElementById('btn-minimize').addEventListener('click', () => {
      if (window.aether?.ipc) aether.ipc.send('research:window-control', 'minimize');
    });
    
    document.getElementById('btn-maximize').addEventListener('click', () => {
      if (window.aether?.ipc) aether.ipc.send('research:window-control', 'maximize');
    });
    
    document.getElementById('btn-close').addEventListener('click', () => {
      if (window.aether?.ipc) aether.ipc.send('research:window-control', 'close');
    });

    const statusDot = document.querySelector('.status-dot');
    const statusText = document.querySelector('.status-text');
    const iframe = document.getElementById('perplexica-iframe');
    const loadingOverlay = document.getElementById('loading-overlay');
    const errorOverlay = document.getElementById('error-overlay');
    const btnRetry = document.getElementById('btn-retry');

    let endpoint = null;

    const setStatus = (status, text) => {
      if (statusDot) {
        statusDot.className = `status-dot status-${status}`;
      }
      if (statusText) {
        statusText.textContent = text;
      }
    };

    const loadIframe = async () => {
      try {
        setStatus('loading', 'Connecting...');
        loadingOverlay.style.display = 'flex';
        errorOverlay.style.display = 'none';
        iframe.style.display = 'none';

        // 2. Resolve Backend Config & Initialize Endpoint
        let baseUrl;
        try {
          baseUrl = await window.aether.ipc.invoke('backend:get-url');
        } catch (err) {
          log.warn('Failed to get backend URL from IPC, falling back to default', err);
          baseUrl = 'http://127.0.0.1:8765'; // Fallback for dev/offline backend
        }
        
        const wsUrl = baseUrl.replace(/^http/, 'ws');
        const config = Object.freeze({ API_BASE_URL: baseUrl, WS_URL: wsUrl });
        
        if (!endpoint) {
          endpoint = createRendererEndpoint(config);
        }

        // 3. Fetch Research Status
        const response = await fetch(`${baseUrl}/v1/status/research`);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (!data.perplexica_enabled) {
          throw new Error('Research service (Perplexica) is disabled');
        }

        const dashboardUrl = data.perplexica_url || 'http://localhost:3000';
        
        // 4. Handle Iframe Load
        let loaded = false;
        
        iframe.onload = () => {
          loaded = true;
          loadingOverlay.style.display = 'none';
          iframe.style.display = 'block';
          setStatus('connected', 'Connected');
          log.info('Iframe loaded successfully');
        };

        iframe.onerror = () => {
          loaded = true;
          loadingOverlay.style.display = 'none';
          errorOverlay.style.display = 'flex';
          setStatus('error', 'Connection failed');
          log.error('Iframe failed to load');
        };

        iframe.src = dashboardUrl;

        // Fallback timeout
        setTimeout(() => {
          if (!loaded) {
            loadingOverlay.style.display = 'none';
            errorOverlay.style.display = 'flex';
            setStatus('error', 'Connection timeout');
            log.warn('Iframe load timeout');
          }
        }, 15000);

      } catch (err) {
        log.error('Failed to load dashboard:', err);
        loadingOverlay.style.display = 'none';
        errorOverlay.style.display = 'flex';
        setStatus('error', 'Service unavailable');
        
        const errorMsg = document.querySelector('.error-message');
        if (errorMsg) errorMsg.textContent = err.message || 'Service unreachable';
      }
    };

    btnRetry.addEventListener('click', loadIframe);

    // Initial load
    await loadIframe();

  } catch (err) {
    log.error('Initialization failed:', err);
    document.body.innerHTML = `<div style="color:red; padding:20px;">Initialization failed: ${err.message}</div>`;
  }
});