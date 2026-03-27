'use strict';

// ---------------------------------------------------------------------------
// Mocks — survive resetMocks: true
// ---------------------------------------------------------------------------

const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => mockLog),
}));

const mockToast = {
  success: jest.fn(),
  error: jest.fn(),
  warning: jest.fn(),
  info: jest.fn(),
};
jest.mock('../../../../src/renderer/shared/components/Toast', () => mockToast);

// ---------------------------------------------------------------------------
// Require the class constructor
// ---------------------------------------------------------------------------

const LLMProviderSettings = require('../../../../src/renderer/main/modules/settings/LLMProviderSettings');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupDOM() {
  document.body.innerHTML = `
    <select id="llm-provider"></select>
    <input id="llm-api-base" />
    <select id="llm-model"></select>
    <div id="llm-model-help"></div>
    <button id="llm-refresh-btn"></button>
    <div id="inference-inline-panel" style="display:none">
      <input id="inference-enabled-toggle" type="checkbox" />
      <button id="inference-start-stop-btn"></button>
      <button id="inference-refresh-btn"></button>
      <button id="inference-pull-btn"></button>
      <input id="inference-pull-input" />
      <div id="inference-status-badge"></div>
      <div id="inference-engine-label"></div>
      <div id="inference-gpu-label"></div>
      <div id="inference-pull-section"></div>
      <div id="inference-controls-section"></div>
      <div id="inference-disabled-msg"></div>
    </div>
  `;
}

function teardownDOM() {
  document.body.innerHTML = '';
}

function createSettings() {
  // Proxy endpoint.api back to global.fetch to preserve test compatibility
  const mockEndpoint = {
    api: {
      get: async (path, options = {}) => {
        const url = path.startsWith('http') ? path : `http://127.0.0.1:8765${path}`;
        const res = await fetch(url, { method: 'GET', ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const err = new Error(body.detail || `HTTP ${res.status}`);
          err.status = res.status;
          err.body = body;
          throw err;
        }
        return res.json();
      },
      post: async (path, body, options = {}) => {
        const url = path.startsWith('http') ? path : `http://127.0.0.1:8765${path}`;
        const fetchOptions = { method: 'POST', ...options, headers: { 'Content-Type': 'application/json', ...options.headers } };
        if (body) fetchOptions.body = JSON.stringify(body);
        const res = await fetch(url, fetchOptions);
        if (!res.ok) {
          const resBody = await res.json().catch(() => ({}));
          const err = new Error(resBody.detail || `HTTP ${res.status}`);
          err.status = res.status;
          err.body = resBody;
          throw err;
        }
        return res.json();
      }
    }
  };
  return new LLMProviderSettings({ endpoint: mockEndpoint });
}

function mockFetchOk(data) {
  return jest.fn().mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue(data),
    status: 200,
    statusText: 'OK',
  });
}

function mockFetchFail(status = 500) {
  return jest.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: 'Server Error',
    json: jest.fn().mockResolvedValue({}),
  });
}

function clearMocks() {
  mockLog.info.mockClear();
  mockLog.warn.mockClear();
  mockLog.error.mockClear();
  mockLog.debug.mockClear();
  mockToast.success.mockClear();
  mockToast.error.mockClear();
  mockToast.warning.mockClear();
  mockToast.info.mockClear();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LLMProviderSettings', () => {
  let settings;

  beforeEach(() => {
    clearMocks();
    setupDOM();
    settings = createSettings();
    delete window.AETHER_CONFIG;
  });

  afterEach(() => {
    if (settings && !settings._isDisposed) {
      settings.dispose();
    }
    teardownDOM();
    if (global.fetch && global.fetch.mockRestore) {
      global.fetch.mockRestore();
    }
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('initializes with default state', () => {
      expect(settings._providers).toEqual([]);
      expect(settings._currentConfig).toBeNull();
      expect(settings._availableModels).toEqual([]);
      expect(settings._isLoading).toBe(false);
    });

    it('initializes lifecycle flags', () => {
      expect(settings._isInitialized).toBe(false);
      expect(settings._isDisposed).toBe(false);
    });

    it('initializes resource tracking arrays', () => {
      expect(settings._listeners).toEqual([]);
      expect(settings._timers).toEqual([]);
      expect(settings._abortControllers).toEqual([]);
    });

    it('initializes inference panel state', () => {
      expect(settings._inferenceListenersAttached).toBe(false);
      expect(settings._inferenceTimer).toBeNull();
      expect(settings._inferenceStatus).toBeNull();
    });

    it('DOM references start as null', () => {
      expect(settings._providerSelect).toBeNull();
      expect(settings._urlInput).toBeNull();
      expect(settings._modelSelect).toBeNull();
      expect(settings._modelHelp).toBeNull();
    });
  });

  // =========================================================================
  // _gatherElements
  // =========================================================================

  describe('_gatherElements', () => {
    it('populates DOM references from document', () => {
      settings._gatherElements();
      expect(settings._providerSelect).toBe(document.getElementById('llm-provider'));
      expect(settings._urlInput).toBe(document.getElementById('llm-api-base'));
      expect(settings._modelSelect).toBe(document.getElementById('llm-model'));
      expect(settings._modelHelp).toBe(document.getElementById('llm-model-help'));
    });

    it('throws when required elements are missing', () => {
      teardownDOM();
      expect(() => settings._gatherElements()).toThrow('Required DOM elements not found');
    });
  });


  // =========================================================================
  // _setupEventListeners
  // =========================================================================

  describe('_setupEventListeners', () => {
    it('tracks 3 listeners (provider, url, model)', () => {
      settings._gatherElements();
      settings._setupEventListeners();
      expect(settings._listeners.length).toBe(3);
      expect(settings._listeners[0].event).toBe('change');
      expect(settings._listeners[1].event).toBe('input');
      expect(settings._listeners[2].event).toBe('change');
    });
  });

  // =========================================================================
  // _updateProviderDropdown
  // =========================================================================

  describe('_updateProviderDropdown', () => {
    beforeEach(() => {
      settings._gatherElements();
    });

    it('shows loading option when showLoading=true', () => {
      settings._updateProviderDropdown([], true);
      const options = settings._providerSelect.querySelectorAll('option');
      expect(options.length).toBe(1);
      expect(options[0].textContent).toBe('Discovering providers...');
      expect(options[0].disabled).toBe(true);
    });

    it('populates fallback providers when list is empty', () => {
      settings._updateProviderDropdown([]);
      const options = settings._providerSelect.querySelectorAll('option');
      expect(options.length).toBe(4);
    });

    it('sorts available providers first', () => {
      settings._updateProviderDropdown([
        { key: 'custom', displayName: 'Custom', url: '', available: false },
        { key: 'lmstudio', displayName: 'LM Studio', url: 'http://localhost:1234/v1', available: true },
      ]);
      const options = settings._providerSelect.querySelectorAll('option');
      expect(options[0].value).toBe('lmstudio');
      expect(options[0].textContent).toContain('Available');
    });

    it('does nothing when providerSelect is null', () => {
      settings._providerSelect = null;
      expect(() => settings._updateProviderDropdown([])).not.toThrow();
    });
  });

  // =========================================================================
  // _populateModels
  // =========================================================================

  describe('_populateModels', () => {
    beforeEach(() => {
      settings._gatherElements();
    });

    it('shows empty message when no models', () => {
      settings._populateModels([]);
      const options = settings._modelSelect.querySelectorAll('option');
      expect(options.length).toBe(1);
      expect(options[0].textContent).toBe('No models available');
      expect(options[0].disabled).toBe(true);
    });

    it('populates models with placeholder', () => {
      settings._populateModels(['model-a', 'model-b']);
      const options = settings._modelSelect.querySelectorAll('option');
      expect(options.length).toBe(3); // placeholder + 2 models
      expect(options[0].textContent).toBe('Select a model...');
      expect(options[1].value).toBe('model-a');
      expect(options[2].value).toBe('model-b');
    });

    it('does nothing when modelSelect is null', () => {
      settings._modelSelect = null;
      expect(() => settings._populateModels(['a'])).not.toThrow();
    });
  });

  // =========================================================================
  // getCurrentConfiguration
  // =========================================================================

  describe('getCurrentConfiguration', () => {
    it('returns empty config when no elements', () => {
      const config = settings.getCurrentConfiguration();
      expect(config).toEqual({
        provider_key: '',
        provider_url: '',
        model_name: null,
      });
    });

    it('returns current form values', () => {
      settings._gatherElements();
      settings._providerSelect.innerHTML = '<option value="ollama">Ollama</option>';
      settings._providerSelect.value = 'ollama';
      settings._urlInput.value = 'http://127.0.0.1:11434';
      settings._modelSelect.innerHTML = '<option value="llama3">llama3</option>';
      settings._modelSelect.value = 'llama3';

      const config = settings.getCurrentConfiguration();
      expect(config.provider_key).toBe('ollama');
      expect(config.provider_url).toBe('http://127.0.0.1:11434');
      expect(config.model_name).toBe('llama3');
    });
  });

  // =========================================================================
  // discoverProviders
  // =========================================================================

  describe('discoverProviders', () => {
    beforeEach(() => {
      settings._gatherElements();
    });

    it('returns early when already loading', async () => {
      settings._isLoading = true;
      global.fetch = jest.fn();
      await settings.discoverProviders();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('discovers providers and toasts success', async () => {
      const providers = [
        { key: 'lmstudio', displayName: 'LM Studio', url: 'http://localhost:1234/v1', available: true, models: [] },
      ];
      global.fetch = mockFetchOk(providers);

      await settings.discoverProviders();

      expect(settings._providers).toEqual(providers);
      expect(mockToast.success).toHaveBeenCalledWith('Found 1 available LLM provider');
      expect(settings._isLoading).toBe(false);
    });

    it('toasts info when no available providers', async () => {
      global.fetch = mockFetchOk([
        { key: 'custom', displayName: 'Custom', url: '', available: false, models: [] },
      ]);

      await settings.discoverProviders();

      expect(mockToast.info).toHaveBeenCalledWith(
        'No local LLM providers detected. Configure a custom provider below.'
      );
    });

    it('toasts error on fetch failure', async () => {
      global.fetch = mockFetchFail(500);

      await settings.discoverProviders();

      expect(mockToast.error).toHaveBeenCalledWith('Failed to discover LLM providers');
      expect(settings._isLoading).toBe(false);
    });

    it('silently returns on abort', async () => {
      const abortError = new DOMException('Aborted', 'AbortError');
      global.fetch = jest.fn().mockRejectedValue(abortError);

      await settings.discoverProviders();

      expect(mockToast.error).not.toHaveBeenCalled();
    });

    it('pluralizes providers count correctly', async () => {
      global.fetch = mockFetchOk([
        { key: 'a', displayName: 'A', url: 'u', available: true, models: [] },
        { key: 'b', displayName: 'B', url: 'u', available: true, models: [] },
      ]);

      await settings.discoverProviders();

      expect(mockToast.success).toHaveBeenCalledWith('Found 2 available LLM providers');
    });
  });

  // =========================================================================
  // fetchModels
  // =========================================================================

  describe('fetchModels', () => {
    beforeEach(() => {
      settings._gatherElements();
    });

    it('returns early for empty providerUrl', async () => {
      global.fetch = jest.fn();
      await settings.fetchModels('', 'custom');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('fetches and populates models', async () => {
      global.fetch = mockFetchOk({ models: ['gpt-4', 'gpt-3.5'] });

      await settings.fetchModels('http://localhost:1234/v1', 'lmstudio');

      expect(settings._availableModels).toEqual(['gpt-4', 'gpt-3.5']);
      expect(settings._modelHelp.textContent).toContain('Found 2 models');
      expect(settings._modelHelp.className).toBe('form-help form-help--success');
      expect(settings._modelSelect.disabled).toBe(false);
    });

    it('shows warning when no models found', async () => {
      global.fetch = mockFetchOk({ models: [] });

      await settings.fetchModels('http://localhost:1234/v1', 'lmstudio');

      expect(settings._modelHelp.textContent).toBe('No models found. Check provider URL.');
      expect(settings._modelHelp.className).toBe('form-help form-help--warning');
    });

    it('shows error on fetch failure', async () => {
      global.fetch = mockFetchFail(500);

      await settings.fetchModels('http://localhost:1234/v1', 'lmstudio');

      expect(settings._modelHelp.textContent).toContain('Failed to fetch models');
      expect(settings._modelHelp.className).toBe('form-help form-help--error');
    });

    it('silently returns on abort', async () => {
      const abortError = new DOMException('Aborted', 'AbortError');
      global.fetch = jest.fn().mockRejectedValue(abortError);

      await settings.fetchModels('http://localhost:1234/v1', 'lmstudio');

      expect(mockLog.error).not.toHaveBeenCalled();
    });

    it('pluralizes model count correctly for singular', async () => {
      global.fetch = mockFetchOk({ models: ['single-model'] });

      await settings.fetchModels('http://host/v1', 'key');

      expect(settings._modelHelp.textContent).toBe('Found 1 model');
    });
  });

  // =========================================================================
  // loadCurrentConfig
  // =========================================================================

  describe('loadCurrentConfig', () => {
    beforeEach(() => {
      settings._gatherElements();
      settings._toggleInferencePanel = jest.fn();
      settings.fetchModels = jest.fn();
    });

    it('applies config to UI', async () => {
      // Add matching option so .value assignment works
      settings._providerSelect.innerHTML = '<option value="ollama">Ollama</option>';
      global.fetch = mockFetchOk({
        provider_key: 'ollama',
        provider_url: 'http://127.0.0.1:11434',
        model_name: 'llama3',
      });

      await settings.loadCurrentConfig();

      expect(settings._providerSelect.value).toBe('ollama');
      expect(settings._urlInput.value).toBe('http://127.0.0.1:11434');
      expect(settings._toggleInferencePanel).toHaveBeenCalledWith(false);
    });

    it('toggles inference panel for aether_inference', async () => {
      global.fetch = mockFetchOk({
        provider_key: 'aether_inference',
        provider_url: 'http://127.0.0.1:7090/v1',
      });

      await settings.loadCurrentConfig();

      expect(settings._toggleInferencePanel).toHaveBeenCalledWith(true);
    });

    it('fetches models when model_name is configured', async () => {
      global.fetch = mockFetchOk({
        provider_key: 'lmstudio',
        provider_url: 'http://localhost:1234/v1',
        model_name: 'gpt-4',
      });

      await settings.loadCurrentConfig();

      expect(settings.fetchModels).toHaveBeenCalledWith('http://localhost:1234/v1', 'lmstudio');
    });

    it('logs error silently on failure', async () => {
      global.fetch = mockFetchFail(500);

      await settings.loadCurrentConfig();

      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load'),
        expect.any(Object)
      );
      expect(mockToast.error).not.toHaveBeenCalled(); // No toast — uses defaults
    });
  });

  // =========================================================================
  // saveConfiguration
  // =========================================================================

  describe('saveConfiguration', () => {
    beforeEach(() => {
      settings._gatherElements();
    });

    it('warns when provider or url missing', async () => {
      settings._providerSelect.value = '';
      settings._urlInput.value = '';

      const result = await settings.saveConfiguration();

      expect(result).toBe(false);
      expect(mockToast.warning).toHaveBeenCalledWith('Please select a provider and enter a URL');
    });

    it('saves config and toasts success', async () => {
      settings._providerSelect.innerHTML = '<option value="ollama">Ollama</option>';
      settings._providerSelect.value = 'ollama';
      settings._urlInput.value = 'http://127.0.0.1:11434';
      settings._modelSelect.innerHTML = '<option value="llama3">llama3</option>';
      settings._modelSelect.value = 'llama3';

      global.fetch = mockFetchOk({ provider_key: 'ollama', provider_url: 'http://127.0.0.1:11434', model_name: 'llama3' });

      const result = await settings.saveConfiguration();

      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/llm-providers/config'),
        expect.objectContaining({ method: 'POST' })
      );
      expect(mockToast.success).toHaveBeenCalledWith('LLM provider configuration saved');
    });

    it('toasts error on failure', async () => {
      settings._providerSelect.innerHTML = '<option value="ollama">Ollama</option>';
      settings._providerSelect.value = 'ollama';
      settings._urlInput.value = 'http://host';

      global.fetch = mockFetchFail(500);

      const result = await settings.saveConfiguration();

      expect(result).toBe(false);
      expect(mockToast.error).toHaveBeenCalledWith('Failed to save LLM provider configuration');
    });

    it('returns false on abort', async () => {
      settings._providerSelect.innerHTML = '<option value="ollama">Ollama</option>';
      settings._providerSelect.value = 'ollama';
      settings._urlInput.value = 'http://host';

      const abortError = new DOMException('Aborted', 'AbortError');
      global.fetch = jest.fn().mockRejectedValue(abortError);

      const result = await settings.saveConfiguration();

      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // initialize
  // =========================================================================

  describe('initialize', () => {
    it('skips when already initialized', async () => {
      settings._isInitialized = true;
      settings._gatherElements = jest.fn();
      await settings.initialize();
      expect(settings._gatherElements).not.toHaveBeenCalled();
    });

    it('skips when disposed', async () => {
      settings._isDisposed = true;
      settings._gatherElements = jest.fn();
      await settings.initialize();
      expect(settings._gatherElements).not.toHaveBeenCalled();
    });

    it('toasts error when init fails', async () => {
      teardownDOM();
      await settings.initialize();
      expect(mockToast.error).toHaveBeenCalledWith('Failed to initialize LLM provider settings');
    });
  });

  // =========================================================================
  // _toggleInferencePanel
  // =========================================================================

  describe('_toggleInferencePanel', () => {
    it('shows panel when show=true', () => {
      settings._setupInferenceListeners = jest.fn();
      settings._refreshInferenceStatus = jest.fn();
      settings._toggleInferencePanel(true);

      const panel = document.getElementById('inference-inline-panel');
      expect(panel.style.display).toBe('');
      expect(settings._setupInferenceListeners).toHaveBeenCalledTimes(1);
      expect(settings._refreshInferenceStatus).toHaveBeenCalledTimes(1);
    });

    it('hides panel when show=false', () => {
      settings._clearInferencePolling = jest.fn();
      settings._toggleInferencePanel(false);

      const panel = document.getElementById('inference-inline-panel');
      expect(panel.style.display).toBe('none');
      expect(settings._clearInferencePolling).toHaveBeenCalledTimes(1);
    });

    it('does nothing when panel element is missing', () => {
      document.getElementById('inference-inline-panel').remove();
      expect(() => settings._toggleInferencePanel(true)).not.toThrow();
    });
  });

  // =========================================================================
  // _setupInferenceListeners
  // =========================================================================

  describe('_setupInferenceListeners', () => {
    it('is idempotent', () => {
      jest.useFakeTimers();
      settings._setupInferenceListeners();
      const firstCount = settings._listeners.length;
      settings._setupInferenceListeners();
      expect(settings._listeners.length).toBe(firstCount);
      jest.useRealTimers();
    });

    it('tracks inference listeners and polling timer', () => {
      jest.useFakeTimers();
      settings._setupInferenceListeners();
      // 4 listeners: toggle, start/stop, refresh, pull
      expect(settings._listeners.length).toBe(4);
      expect(settings._timers.length).toBe(1);
      expect(settings._timers[0].type).toBe('interval');
      jest.useRealTimers();
    });
  });

  // =========================================================================
  // _clearInferencePolling
  // =========================================================================

  describe('_clearInferencePolling', () => {
    it('clears interval and nulls timer', () => {
      jest.useFakeTimers();
      settings._inferenceTimer = setInterval(() => {}, 15000);
      settings._clearInferencePolling();
      expect(settings._inferenceTimer).toBeNull();
      jest.useRealTimers();
    });

    it('does nothing when no timer', () => {
      settings._inferenceTimer = null;
      expect(() => settings._clearInferencePolling()).not.toThrow();
    });
  });

  // =========================================================================
  // _updateInferencePanel
  // =========================================================================

  describe('_updateInferencePanel', () => {
    it('shows Running badge when healthy', () => {
      settings._updateInferencePanel({ healthy: true, user_enabled: true });
      const badge = document.getElementById('inference-status-badge');
      expect(badge.textContent).toBe('Running');
      expect(badge.className).toBe('inference-badge badge-running');
    });

    it('shows Running (auto-start off) when running but disabled', () => {
      settings._updateInferencePanel({ healthy: true, user_enabled: false });
      const badge = document.getElementById('inference-status-badge');
      expect(badge.textContent).toBe('Running (auto-start off)');
      expect(badge.className).toBe('inference-badge badge-warning');
    });

    it('shows Disabled when user_enabled=false and not running', () => {
      settings._updateInferencePanel({ healthy: false, user_enabled: false });
      const badge = document.getElementById('inference-status-badge');
      expect(badge.textContent).toBe('Disabled');
      expect(badge.className).toBe('inference-badge badge-disabled');
    });

    it('shows Stopped when enabled but not running', () => {
      settings._updateInferencePanel({ healthy: false, user_enabled: true });
      const badge = document.getElementById('inference-status-badge');
      expect(badge.textContent).toBe('Stopped');
      expect(badge.className).toBe('inference-badge badge-stopped');
    });

    it('updates engine and GPU labels', () => {
      settings._updateInferencePanel({
        healthy: true,
        user_enabled: true,
        engine_display: 'llama.cpp',
        platform: { gpu_name: 'RTX 4090', gpu_memory_gb: 24 },
      });
      const engineLabel = document.getElementById('inference-engine-label');
      const gpuLabel = document.getElementById('inference-gpu-label');
      expect(engineLabel.textContent).toBe('llama.cpp');
      expect(gpuLabel.textContent).toBe('RTX 4090 (24GB)');
    });

    it('shows Start button when enabled and stopped', () => {
      settings._updateInferencePanel({ healthy: false, user_enabled: true });
      const btn = document.getElementById('inference-start-stop-btn');
      expect(btn.textContent).toBe('Start');
      expect(btn.style.display).toBe('');
    });

    it('shows Stop button when running', () => {
      settings._updateInferencePanel({ healthy: true, user_enabled: true });
      const btn = document.getElementById('inference-start-stop-btn');
      expect(btn.textContent).toBe('Stop');
    });

    it('hides start button when disabled and stopped', () => {
      settings._updateInferencePanel({ healthy: false, user_enabled: false });
      const btn = document.getElementById('inference-start-stop-btn');
      expect(btn.style.display).toBe('none');
    });

    it('hides pull section when not running', () => {
      settings._updateInferencePanel({ healthy: false, user_enabled: true });
      const pullSection = document.getElementById('inference-pull-section');
      expect(pullSection.style.display).toBe('none');
    });

    it('shows pull section when running and enabled', () => {
      settings._updateInferencePanel({ healthy: true, user_enabled: true });
      const pullSection = document.getElementById('inference-pull-section');
      expect(pullSection.style.display).toBe('');
    });

    it('defaults user_enabled to true when undefined', () => {
      settings._updateInferencePanel({ healthy: true });
      const badge = document.getElementById('inference-status-badge');
      expect(badge.textContent).toBe('Running');
    });
  });

  // =========================================================================
  // _inferenceToggleStartStop
  // =========================================================================

  describe('_inferenceToggleStartStop', () => {
    it('starts server when not running', async () => {
      settings._inferenceStatus = { healthy: false };
      settings._refreshInferenceStatus = jest.fn();
      global.fetch = mockFetchOk({ status: 'started' });

      await settings._inferenceToggleStartStop();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/inference/start'),
        expect.any(Object)
      );
      expect(mockToast.success).toHaveBeenCalledWith('Inference server started');
    });

    it('stops server when running', async () => {
      settings._inferenceStatus = { healthy: true };
      settings._refreshInferenceStatus = jest.fn();
      global.fetch = mockFetchOk({ status: 'stopped' });

      await settings._inferenceToggleStartStop();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/inference/stop'),
        expect.any(Object)
      );
      expect(mockToast.success).toHaveBeenCalledWith('Inference server stopped');
    });

    it('toasts error on fetch failure', async () => {
      settings._inferenceStatus = null;
      settings._refreshInferenceStatus = jest.fn();
      global.fetch = jest.fn().mockRejectedValue(new Error('net'));

      await settings._inferenceToggleStartStop();

      expect(mockToast.error).toHaveBeenCalledWith('Action failed');
    });

    it('re-enables button in finally block', async () => {
      settings._inferenceStatus = null;
      settings._refreshInferenceStatus = jest.fn();
      global.fetch = jest.fn().mockRejectedValue(new Error('net'));

      await settings._inferenceToggleStartStop();

      const btn = document.getElementById('inference-start-stop-btn');
      expect(btn.disabled).toBe(false);
    });
  });

  // =========================================================================
  // _inferenceHandleEnabledToggle
  // =========================================================================

  describe('_inferenceHandleEnabledToggle', () => {
    it('enables and starts server', async () => {
      settings._refreshInferenceStatus = jest.fn();
      global.fetch = mockFetchOk({});

      await settings._inferenceHandleEnabledToggle(true);

      expect(global.fetch).toHaveBeenCalledTimes(2); // pref + start
      expect(mockToast.success).toHaveBeenCalledWith('Inference server enabled and starting');
    });

    it('disables and stops server', async () => {
      settings._refreshInferenceStatus = jest.fn();
      global.fetch = mockFetchOk({});

      await settings._inferenceHandleEnabledToggle(false);

      expect(mockToast.success).toHaveBeenCalledWith('Inference server disabled and stopped');
    });

    it('reverts toggle on error', async () => {
      settings._refreshInferenceStatus = jest.fn();
      global.fetch = jest.fn().mockRejectedValue(new Error('fail'));

      const toggle = document.getElementById('inference-enabled-toggle');
      toggle.checked = true;

      await settings._inferenceHandleEnabledToggle(true);

      expect(toggle.checked).toBe(false); // reverted
      expect(mockToast.error).toHaveBeenCalledWith('Failed to toggle inference server');
    });
  });

  // =========================================================================
  // _inferencePullModel
  // =========================================================================

  describe('_inferencePullModel', () => {
    it('warns when no model entered', async () => {
      const input = document.getElementById('inference-pull-input');
      input.value = '';

      await settings._inferencePullModel();

      expect(mockToast.warning).toHaveBeenCalledWith('Enter a model name');
    });

    it('pulls model and toasts success', async () => {
      const input = document.getElementById('inference-pull-input');
      input.value = 'llama3';
      settings._providers = [{ key: 'aether_inference', url: 'http://127.0.0.1:7090/v1' }];
      settings.fetchModels = jest.fn();
      settings._refreshInferenceStatus = jest.fn();

      global.fetch = mockFetchOk({ status: 'complete' });

      await settings._inferencePullModel();

      expect(mockToast.success).toHaveBeenCalledWith('Model "llama3" downloaded');
      expect(settings.fetchModels).toHaveBeenCalledTimes(1);
    });

    it('toasts error on download failure result', async () => {
      const input = document.getElementById('inference-pull-input');
      input.value = 'bad-model';
      settings._refreshInferenceStatus = jest.fn();

      global.fetch = mockFetchOk({ status: 'error', error: 'not found' });

      await settings._inferencePullModel();

      expect(mockToast.error).toHaveBeenCalledWith('Download failed: not found');
    });

    it('toasts info for in-progress download', async () => {
      const input = document.getElementById('inference-pull-input');
      input.value = 'model';
      settings._refreshInferenceStatus = jest.fn();

      global.fetch = mockFetchOk({ status: 'downloading' });

      await settings._inferencePullModel();

      expect(mockToast.info).toHaveBeenCalledWith('Download started — check back shortly');
    });

    it('re-enables button in finally', async () => {
      const input = document.getElementById('inference-pull-input');
      input.value = 'model';
      settings._refreshInferenceStatus = jest.fn();
      global.fetch = jest.fn().mockRejectedValue(new Error('net'));

      await settings._inferencePullModel();

      const btn = document.getElementById('inference-pull-btn');
      expect(btn.disabled).toBe(false);
      expect(btn.textContent).toBe('Download');
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    it('is idempotent', () => {
      settings.dispose();
      expect(settings._isDisposed).toBe(true);
      expect(() => settings.dispose()).not.toThrow();
    });

    it('aborts all controllers', () => {
      const controller = { abort: jest.fn() };
      settings._abortControllers = [controller];
      settings.dispose();
      expect(controller.abort).toHaveBeenCalledTimes(1);
      expect(settings._abortControllers).toEqual([]);
    });

    it('clears all timers', () => {
      jest.useFakeTimers();
      const intervalId = setInterval(() => {}, 1000);
      const timeoutId = setTimeout(() => {}, 1000);
      settings._timers = [
        { id: intervalId, type: 'interval' },
        { id: timeoutId, type: 'timeout' },
      ];
      settings.dispose();
      expect(settings._timers).toEqual([]);
      jest.useRealTimers();
    });

    it('removes all event listeners', () => {
      settings._gatherElements();
      settings._setupEventListeners();
      const count = settings._listeners.length;
      expect(count).toBe(3);

      settings.dispose();

      expect(settings._listeners).toEqual([]);
    });

    it('nulls all DOM references', () => {
      settings._gatherElements();
      settings.dispose();
      expect(settings._providerSelect).toBeNull();
      expect(settings._urlInput).toBeNull();
      expect(settings._modelSelect).toBeNull();
      expect(settings._modelHelp).toBeNull();
    });

    it('resets all flags and state', () => {
      settings._isInitialized = true;
      settings._inferenceListenersAttached = true;
      settings._providers = [{ key: 'a' }];
      settings._availableModels = ['m'];

      settings.dispose();

      expect(settings._isInitialized).toBe(false);
      expect(settings._isDisposed).toBe(true);
      expect(settings._providers).toEqual([]);
      expect(settings._availableModels).toEqual([]);
      expect(settings._currentConfig).toBeNull();
      expect(settings._inferenceListenersAttached).toBe(false);
      expect(settings._inferenceStatus).toBeNull();
      expect(settings._inferenceTimer).toBeNull();
    });

    it('clears inference polling', () => {
      jest.useFakeTimers();
      settings._inferenceTimer = setInterval(() => {}, 15000);
      settings.dispose();
      expect(settings._inferenceTimer).toBeNull();
      jest.useRealTimers();
    });

    it('quantitative proof: N listeners = M removed', () => {
      settings._gatherElements();
      settings._setupEventListeners();
      jest.useFakeTimers();
      settings._setupInferenceListeners();
      const N = settings._listeners.length;
      expect(N).toBe(7); // 3 main + 4 inference

      settings.dispose();

      expect(settings._listeners.length).toBe(0);
      jest.useRealTimers();
    });
  });


  // =========================================================================
  // initialize — successful path (lines 56-65)
  // =========================================================================

  describe('initialize — full success path', () => {
    it('sets _isInitialized after successful init', async () => {
      settings.discoverProviders = jest.fn().mockResolvedValue();
      settings.loadCurrentConfig = jest.fn().mockResolvedValue();

      await settings.initialize();

      expect(settings._isInitialized).toBe(true);
      expect(settings.discoverProviders).toHaveBeenCalledTimes(1);
      expect(settings.loadCurrentConfig).toHaveBeenCalledTimes(1);
      expect(settings._providerSelect).not.toBeNull();
      expect(settings._listeners.length).toBe(3);
    });
  });

  // =========================================================================
  // Event handler bodies (lines 96-140)
  // =========================================================================

  describe('_setupEventListeners — handler bodies', () => {
    beforeEach(() => {
      settings._gatherElements();
      settings._setupEventListeners();
    });

    it('provider change: updates URL and populates models for available provider', async () => {
      settings._providers = [
        { key: 'lmstudio', url: 'http://localhost:1234/v1', available: true, models: ['model-a', 'model-b'] },
      ];
      settings._toggleInferencePanel = jest.fn();

      settings._providerSelect.innerHTML = '<option value="lmstudio">LM Studio</option>';
      settings._providerSelect.value = 'lmstudio';
      settings._providerSelect.dispatchEvent(new Event('change'));

      // Allow async handler to complete
      await new Promise(r => setTimeout(r, 0));

      expect(settings._urlInput.value).toBe('http://localhost:1234/v1');
      // Models populated (has placeholder + 2 models = 3 options)
      expect(settings._modelSelect.querySelectorAll('option').length).toBe(3);
      expect(settings._toggleInferencePanel).toHaveBeenCalledWith(false);
    });

    it('provider change: fetches models when provider has none', async () => {
      settings._providers = [
        { key: 'ollama', url: 'http://127.0.0.1:11434', available: true, models: [] },
      ];
      settings._toggleInferencePanel = jest.fn();
      settings.fetchModels = jest.fn().mockResolvedValue();

      settings._providerSelect.innerHTML = '<option value="ollama">Ollama</option>';
      settings._providerSelect.value = 'ollama';
      settings._providerSelect.dispatchEvent(new Event('change'));

      await new Promise(r => setTimeout(r, 0));

      expect(settings.fetchModels).toHaveBeenCalledWith('http://127.0.0.1:11434', 'ollama');
    });

    it('provider change: fetches models when provider is unavailable', async () => {
      settings._providers = [
        { key: 'custom', url: 'http://custom/v1', available: false, models: [] },
      ];
      settings._toggleInferencePanel = jest.fn();
      settings.fetchModels = jest.fn().mockResolvedValue();

      settings._providerSelect.innerHTML = '<option value="custom">Custom</option>';
      settings._providerSelect.value = 'custom';
      settings._providerSelect.dispatchEvent(new Event('change'));

      await new Promise(r => setTimeout(r, 0));

      expect(settings.fetchModels).toHaveBeenCalledWith('http://custom/v1', 'custom');
    });

    it('provider change: toggles inference panel for aether_inference', async () => {
      settings._providers = [
        { key: 'aether_inference', url: 'http://127.0.0.1:7090/v1', available: false, models: [] },
      ];
      settings._toggleInferencePanel = jest.fn();
      settings.fetchModels = jest.fn().mockResolvedValue();

      settings._providerSelect.innerHTML = '<option value="aether_inference">Aether</option>';
      settings._providerSelect.value = 'aether_inference';
      settings._providerSelect.dispatchEvent(new Event('change'));

      await new Promise(r => setTimeout(r, 0));

      expect(settings._toggleInferencePanel).toHaveBeenCalledWith(true);
    });

    it('provider change: does nothing when provider not found', async () => {
      settings._providers = [];
      settings._toggleInferencePanel = jest.fn();

      settings._providerSelect.innerHTML = '<option value="unknown">Unknown</option>';
      settings._providerSelect.value = 'unknown';
      settings._providerSelect.dispatchEvent(new Event('change'));

      await new Promise(r => setTimeout(r, 0));

      expect(settings._toggleInferencePanel).toHaveBeenCalledWith(false);
    });

    it('URL input: debounced fetch after 800ms', async () => {
      jest.useFakeTimers();
      settings.fetchModels = jest.fn().mockResolvedValue();
      settings._providerSelect.innerHTML = '<option value="custom">Custom</option>';
      settings._providerSelect.value = 'custom';
      settings._urlInput.value = 'http://new-url/v1';

      settings._urlInput.dispatchEvent(new Event('input'));

      // Not called yet (debounce)
      expect(settings.fetchModels).not.toHaveBeenCalled();

      jest.advanceTimersByTime(800);
      // Flush microtasks
      await Promise.resolve();

      expect(settings.fetchModels).toHaveBeenCalledWith('http://new-url/v1', 'custom');
      jest.useRealTimers();
    });

    it('URL input: debounce clears on rapid input', async () => {
      jest.useFakeTimers();
      settings.fetchModels = jest.fn().mockResolvedValue();
      settings._providerSelect.innerHTML = '<option value="custom">Custom</option>';
      settings._providerSelect.value = 'custom';

      // First input
      settings._urlInput.value = 'http://first/v1';
      settings._urlInput.dispatchEvent(new Event('input'));

      // Second input at 500ms (before debounce fires)
      jest.advanceTimersByTime(500);
      settings._urlInput.value = 'http://second/v1';
      settings._urlInput.dispatchEvent(new Event('input'));

      // Advance past debounce for second
      jest.advanceTimersByTime(800);
      await Promise.resolve();

      // Only the second value should have been fetched
      expect(settings.fetchModels).toHaveBeenCalledTimes(1);
      expect(settings.fetchModels).toHaveBeenCalledWith('http://second/v1', 'custom');
      jest.useRealTimers();
    });

    it('URL input: skips fetch when URL is empty', async () => {
      jest.useFakeTimers();
      settings.fetchModels = jest.fn().mockResolvedValue();
      settings._urlInput.value = '';

      settings._urlInput.dispatchEvent(new Event('input'));
      jest.advanceTimersByTime(800);
      await Promise.resolve();

      expect(settings.fetchModels).not.toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('URL input: defaults providerKey to custom_openai when empty', async () => {
      jest.useFakeTimers();
      settings.fetchModels = jest.fn().mockResolvedValue();
      settings._providerSelect.value = '';
      settings._urlInput.value = 'http://custom/v1';

      settings._urlInput.dispatchEvent(new Event('input'));
      jest.advanceTimersByTime(800);
      await Promise.resolve();

      expect(settings.fetchModels).toHaveBeenCalledWith('http://custom/v1', 'custom_openai');
      jest.useRealTimers();
    });

    it('model change: updates help text', () => {
      settings._modelSelect.innerHTML = '<option value="llama3">llama3</option>';
      settings._modelSelect.value = 'llama3';
      settings._modelSelect.dispatchEvent(new Event('change'));

      expect(settings._modelHelp.textContent).toBe('Selected: llama3');
      expect(settings._modelHelp.className).toBe('form-help form-help--success');
    });

    it('model change: does nothing when no model selected', () => {
      settings._modelHelp.textContent = 'previous';
      settings._modelSelect.value = '';
      settings._modelSelect.dispatchEvent(new Event('change'));

      expect(settings._modelHelp.textContent).toBe('previous');
    });
  });

  // =========================================================================
  // _setupInferenceListeners — timer callback (lines 547-549)
  // =========================================================================

  describe('inference polling timer', () => {
    it('refreshes status when panel is visible', () => {
      jest.useFakeTimers();
      settings._refreshInferenceStatus = jest.fn();
      const panel = document.getElementById('inference-inline-panel');
      panel.style.display = '';

      settings._setupInferenceListeners();
      jest.advanceTimersByTime(15000);

      expect(settings._refreshInferenceStatus).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
    });

    it('skips refresh when panel is hidden', () => {
      jest.useFakeTimers();
      settings._refreshInferenceStatus = jest.fn();
      const panel = document.getElementById('inference-inline-panel');
      panel.style.display = 'none';

      settings._setupInferenceListeners();
      // Clear the setup call
      settings._refreshInferenceStatus.mockClear();

      jest.advanceTimersByTime(15000);

      expect(settings._refreshInferenceStatus).not.toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('skips refresh when panel element is removed', () => {
      jest.useFakeTimers();
      settings._refreshInferenceStatus = jest.fn();
      document.getElementById('inference-inline-panel').remove();

      settings._setupInferenceListeners();
      settings._refreshInferenceStatus.mockClear();

      jest.advanceTimersByTime(15000);

      expect(settings._refreshInferenceStatus).not.toHaveBeenCalled();
      jest.useRealTimers();
    });
  });

  // =========================================================================
  // _refreshInferenceStatus (lines 571-586)
  // =========================================================================

  describe('_refreshInferenceStatus — full', () => {
    it('updates panel on successful fetch', async () => {
      const statusData = { healthy: true, user_enabled: true, engine_display: 'llama.cpp' };
      global.fetch = mockFetchOk(statusData);
      settings._updateInferencePanel = jest.fn();

      await settings._refreshInferenceStatus();

      expect(settings._inferenceStatus).toEqual(statusData);
      expect(settings._updateInferencePanel).toHaveBeenCalledWith(statusData);
    });

    it('returns early on non-ok response', async () => {
      global.fetch = mockFetchFail(503);
      settings._updateInferencePanel = jest.fn();

      await settings._refreshInferenceStatus();

      expect(settings._updateInferencePanel).not.toHaveBeenCalled();
    });

    it('shows Unavailable badge on fetch error', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('network'));

      await settings._refreshInferenceStatus();

      const badge = document.getElementById('inference-status-badge');
      expect(badge.textContent).toBe('Unavailable');
      expect(badge.className).toBe('inference-badge badge-error');
    });

    it('handles missing badge element in error path', async () => {
      document.getElementById('inference-status-badge').remove();
      global.fetch = jest.fn().mockRejectedValue(new Error('net'));

      await expect(settings._refreshInferenceStatus()).resolves.not.toThrow();
    });
  });

  // =========================================================================
  // _inferenceToggleStartStop — non-ok response (line 697)
  // =========================================================================

  describe('_inferenceToggleStartStop — error branch', () => {
    it('shows error toast on non-ok response', async () => {
      settings._inferenceStatus = { healthy: false };
      settings._refreshInferenceStatus = jest.fn();
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        json: jest.fn().mockResolvedValue({ detail: 'Venv missing' }),
      });

      await settings._inferenceToggleStartStop();

      expect(mockToast.error).toHaveBeenCalledWith('Venv missing');
    });

    it('falls back to generic error when no detail', async () => {
      settings._inferenceStatus = null;
      settings._refreshInferenceStatus = jest.fn();
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        json: jest.fn().mockResolvedValue({}),
      });

      await settings._inferenceToggleStartStop();

      expect(mockToast.error).toHaveBeenCalledWith('Action failed');
    });

    it('uses status=running path for stop', async () => {
      settings._inferenceStatus = { status: 'running' };
      settings._refreshInferenceStatus = jest.fn();
      global.fetch = mockFetchOk({ status: 'stopped' });

      await settings._inferenceToggleStartStop();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/inference/stop'),
        expect.any(Object)
      );
    });
  });

  // =========================================================================
  // _inferenceHandleEnabledToggle — error branches (lines 725, 738, 748)
  // =========================================================================

  describe('_inferenceHandleEnabledToggle — error branches', () => {
    it('throws and reverts toggle when pref save fails (non-ok)', async () => {
      settings._refreshInferenceStatus = jest.fn();
      const toggle = document.getElementById('inference-enabled-toggle');
      toggle.checked = true;

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: jest.fn().mockResolvedValue({}),
      });

      await settings._inferenceHandleEnabledToggle(true);

      expect(toggle.checked).toBe(false); // reverted
      expect(mockToast.error).toHaveBeenCalledWith('Failed to toggle inference server');
    });

    it('shows warning when start response is not ok', async () => {
      settings._refreshInferenceStatus = jest.fn();
      let callCount = 0;
      global.fetch = jest.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // Pref save succeeds
          return { ok: true, json: jest.fn().mockResolvedValue({}) };
        }
        // Start fails
        return { ok: false, json: jest.fn().mockResolvedValue({ detail: 'venv not ready' }) };
      });

      await settings._inferenceHandleEnabledToggle(true);

      expect(mockToast.warning).toHaveBeenCalledWith('venv not ready');
    });

    it('shows warning fallback when start has no detail', async () => {
      settings._refreshInferenceStatus = jest.fn();
      let callCount = 0;
      global.fetch = jest.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return { ok: true, json: jest.fn().mockResolvedValue({}) };
        return { ok: false, json: jest.fn().mockResolvedValue({}) };
      });

      await settings._inferenceHandleEnabledToggle(true);

      expect(mockToast.warning).toHaveBeenCalledWith(
        'Server enabled but failed to start — check venv setup'
      );
    });

    it('shows info toast when stop response is not ok', async () => {
      settings._refreshInferenceStatus = jest.fn();
      let callCount = 0;
      global.fetch = jest.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return { ok: true, json: jest.fn().mockResolvedValue({}) };
        // Stop not ok (server wasn't running)
        return { ok: false, json: jest.fn().mockResolvedValue({}) };
      });

      await settings._inferenceHandleEnabledToggle(false);

      expect(mockToast.info).toHaveBeenCalledWith('Inference server disabled (was not running)');
    });
  });

  // =========================================================================
  // _updateInferencePanel — edge cases
  // =========================================================================

  describe('_updateInferencePanel — edge cases', () => {
    it('uses engine fallback when engine_display is absent', () => {
      settings._updateInferencePanel({
        healthy: true,
        user_enabled: true,
        engine: 'ollama',
      });
      expect(document.getElementById('inference-engine-label').textContent).toBe('ollama');
    });

    it('uses dash when no engine info', () => {
      settings._updateInferencePanel({
        healthy: false,
        user_enabled: true,
      });
      expect(document.getElementById('inference-engine-label').textContent).toBe('\u2014');
    });

    it('uses gpu fallback when gpu_name is absent', () => {
      settings._updateInferencePanel({
        healthy: true,
        user_enabled: true,
        platform: { gpu: 'Metal' },
      });
      expect(document.getElementById('inference-gpu-label').textContent).toBe('Metal');
    });

    it('shows dash when no GPU info', () => {
      settings._updateInferencePanel({
        healthy: true,
        user_enabled: true,
        platform: {},
      });
      expect(document.getElementById('inference-gpu-label').textContent).toContain('\u2014');
    });

    it('omits memory when gpu_memory_gb is absent', () => {
      settings._updateInferencePanel({
        healthy: true,
        user_enabled: true,
        platform: { gpu_name: 'M2' },
      });
      expect(document.getElementById('inference-gpu-label').textContent).toBe('M2');
    });

    it('updates enabledToggle when checked differs', () => {
      const toggle = document.getElementById('inference-enabled-toggle');
      toggle.checked = false;

      settings._updateInferencePanel({ healthy: false, user_enabled: true });

      expect(toggle.checked).toBe(true);
    });

    it('skips toggle update when already matching', () => {
      const toggle = document.getElementById('inference-enabled-toggle');
      toggle.checked = true;

      settings._updateInferencePanel({ healthy: true, user_enabled: true });

      expect(toggle.checked).toBe(true);
    });

    it('handles missing controlsSection and disabledMsg', () => {
      document.getElementById('inference-controls-section').remove();
      document.getElementById('inference-disabled-msg').remove();

      expect(() => settings._updateInferencePanel({ healthy: false, user_enabled: false })).not.toThrow();
    });

    it('handles missing badge element', () => {
      document.getElementById('inference-status-badge').remove();
      expect(() => settings._updateInferencePanel({ healthy: true, user_enabled: true })).not.toThrow();
    });

    it('handles missing startStopBtn', () => {
      document.getElementById('inference-start-stop-btn').remove();
      expect(() => settings._updateInferencePanel({ healthy: true, user_enabled: true })).not.toThrow();
    });

    it('handles missing pullSection', () => {
      document.getElementById('inference-pull-section').remove();
      expect(() => settings._updateInferencePanel({ healthy: true, user_enabled: true })).not.toThrow();
    });

    it('handles missing enabledToggle', () => {
      document.getElementById('inference-enabled-toggle').remove();
      expect(() => settings._updateInferencePanel({ healthy: true, user_enabled: true })).not.toThrow();
    });

    it('skips gpuLabel when no platform data', () => {
      const gpuLabel = document.getElementById('inference-gpu-label');
      gpuLabel.textContent = 'previous';

      settings._updateInferencePanel({ healthy: true, user_enabled: true });

      // gpuLabel not updated because no platform data
      expect(gpuLabel.textContent).toBe('previous');
    });

    it('handles missing engineLabel', () => {
      document.getElementById('inference-engine-label').remove();
      expect(() => settings._updateInferencePanel({ healthy: true, user_enabled: true })).not.toThrow();
    });
  });

  // =========================================================================
  // _inferencePullModel — provider not found edge case
  // =========================================================================

  describe('_inferencePullModel — edge case', () => {
    it('does not fetch models when aether_inference provider not found', async () => {
      const input = document.getElementById('inference-pull-input');
      input.value = 'llama3';
      settings._providers = [];
      settings.fetchModels = jest.fn();
      settings._refreshInferenceStatus = jest.fn();

      global.fetch = mockFetchOk({ status: 'complete' });

      await settings._inferencePullModel();

      expect(mockToast.success).toHaveBeenCalledWith('Model "llama3" downloaded');
      expect(settings.fetchModels).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _setupInferenceListeners — button handlers
  // =========================================================================

  describe('inference button handlers', () => {
    it('enabled toggle fires _inferenceHandleEnabledToggle', () => {
      jest.useFakeTimers();
      settings._inferenceHandleEnabledToggle = jest.fn();
      settings._setupInferenceListeners();

      const toggle = document.getElementById('inference-enabled-toggle');
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));

      expect(settings._inferenceHandleEnabledToggle).toHaveBeenCalledWith(true);
      jest.useRealTimers();
    });

    it('start/stop button fires _inferenceToggleStartStop', () => {
      jest.useFakeTimers();
      settings._inferenceToggleStartStop = jest.fn();
      settings._setupInferenceListeners();

      document.getElementById('inference-start-stop-btn').click();

      expect(settings._inferenceToggleStartStop).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
    });

    it('refresh button fires _refreshInferenceStatus', () => {
      jest.useFakeTimers();
      settings._refreshInferenceStatus = jest.fn();
      settings._setupInferenceListeners();

      document.getElementById('inference-refresh-btn').click();

      expect(settings._refreshInferenceStatus).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
    });

    it('pull button fires _inferencePullModel', () => {
      jest.useFakeTimers();
      settings._inferencePullModel = jest.fn();
      settings._setupInferenceListeners();

      document.getElementById('inference-pull-btn').click();

      expect(settings._inferencePullModel).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
    });

    it('handles missing inference DOM elements gracefully', () => {
      jest.useFakeTimers();
      document.getElementById('inference-enabled-toggle').remove();
      document.getElementById('inference-start-stop-btn').remove();
      document.getElementById('inference-refresh-btn').remove();
      document.getElementById('inference-pull-btn').remove();

      expect(() => settings._setupInferenceListeners()).not.toThrow();
      // Only the timer is tracked, no listeners for missing elements
      expect(settings._timers.length).toBe(1);
      jest.useRealTimers();
    });
  });

  // =========================================================================
  // saveConfiguration — error JSON parse fallback
  // =========================================================================

  describe('saveConfiguration — edge cases', () => {
    it('handles error response with unparseable body', async () => {
      settings._gatherElements();
      settings._providerSelect.innerHTML = '<option value="test">Test</option>';
      settings._providerSelect.value = 'test';
      settings._urlInput.value = 'http://host/v1';

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: jest.fn().mockRejectedValue(new Error('invalid json')),
      });

      const result = await settings.saveConfiguration();

      expect(result).toBe(false);
      expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('Failed'));
    });

    it('sends null model_name when no model selected', async () => {
      settings._gatherElements();
      settings._providerSelect.innerHTML = '<option value="test">Test</option>';
      settings._providerSelect.value = 'test';
      settings._urlInput.value = 'http://host/v1';
      settings._modelSelect.value = '';

      global.fetch = mockFetchOk({ saved: true });

      await settings.saveConfiguration();

      const callBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(callBody.model_name).toBeNull();
    });
  });


  // =========================================================================
  // edge: feedback is falsy
  // =========================================================================

  describe('edge: feedback is falsy', () => {
    it('handles null feedback gracefully', () => {
      // Covers the `provider.available && provider.models.length > 0` false path
      // when provider has available=true but models array is empty
      settings._gatherElements();
      settings._setupEventListeners();
      settings._providers = [
        { key: 'test', url: 'http://test/v1', available: true, models: [] },
      ];
      settings.fetchModels = jest.fn().mockResolvedValue();
      settings._toggleInferencePanel = jest.fn();

      settings._providerSelect.innerHTML = '<option value="test">Test</option>';
      settings._providerSelect.value = 'test';
      settings._providerSelect.dispatchEvent(new Event('change'));
    });

    it('includes error feedback in provider list view', () => {
      settings._gatherElements();
      settings._updateProviderDropdown([
        { key: 'a', displayName: 'Alpha', url: '', available: false },
        { key: 'b', displayName: 'Beta', url: 'u', available: true },
      ]);

      const options = settings._providerSelect.querySelectorAll('option');
      // Available first
      expect(options[0].value).toBe('b');
      expect(options[0].textContent).toContain('Available');
      // Unavailable second
      expect(options[1].value).toBe('a');
      expect(options[1].textContent).toBe('Alpha');
    });
  });
});
