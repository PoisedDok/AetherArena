/** @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js */
'use strict';

const AdvancedSettingsBinder = require('../../../../../src/application/main/modules/settings/binders/AdvancedSettingsBinder');

/**
 * Helper: build the advanced settings DOM scaffold.
 * Includes model select with a placeholder option, profile select,
 * model details section, context window slider, temperature/max-tokens inputs,
 * and the vision toggle.
 */
function buildAdvancedDom() {
  document.body.innerHTML = `
    <select id="llm-provider"><option value="">Loading providers...</option></select>
    <input id="llm-api-base" value="">
    <select id="llm-model"><option value="">-- select --</option></select>
    <span id="llm-model-help"></span>
    <select id="oi-profile"><option value="">-- select --</option></select>
    <span id="oi-profile-help"></span>
    <div id="model-details-section" style="display:none;">
      <div id="model-details-content"></div>
    </div>
    <input type="range" id="llm-context-window-adv-slider" min="0" max="8192" value="0">
    <input type="hidden" id="llm-context-window-adv" value="0">
    <span id="llm-context-window-display"></span>
    <input id="llm-temperature-adv" value="0.7">
    <input id="llm-max-tokens-adv" value="4096">
    <input type="checkbox" id="llm-supports-vision">
  `;
}

describe('AdvancedSettingsBinder', () => {
  let binder;
  const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  let mockEndpoint;

  beforeEach(() => {
    mockEndpoint = {
      api: { get: jest.fn() },
      getModelCapabilities: jest.fn(),
    };
    binder = new AdvancedSettingsBinder({ log: mockLog, endpoint: mockEndpoint });
    jest.clearAllMocks();
  });
  afterEach(() => { document.body.innerHTML = ''; });

  // ==========================================================================
  // populate()
  // ==========================================================================

  describe('populate()', () => {
    // Default mock: provider discover returns providers, models returns empty
    function setupDefaultMocks() {
      mockEndpoint.api.get.mockImplementation((url) => {
        if (url === '/v1/llm-providers/discover') {
          return Promise.resolve([
            { key: 'aether_inference', displayName: 'Aether Inference (Local)', available: true },
            { key: 'openai-compatible', displayName: 'OpenAI Compatible (LM Studio)', available: true },
            { key: 'ollama', displayName: 'Ollama', available: true },
          ]);
        }
        if (url === '/v1/models') return Promise.resolve({ models: [] });
        if (url === '/v1/settings/profiles') return Promise.resolve({ profiles: [] });
        return Promise.resolve({});
      });
      mockEndpoint.getModelCapabilities.mockResolvedValue(null);
    }

    it('sets provider and api_base from llm config', async () => {
      buildAdvancedDom();
      setupDefaultMocks();
      await binder.populate({ provider: 'openai-compatible', api_base: 'https://api.example.com' }, {});
      expect(document.getElementById('llm-provider').value).toBe('openai-compatible');
      expect(document.getElementById('llm-api-base').value).toBe('https://api.example.com');
    });

    it('dynamically populates provider dropdown from backend', async () => {
      buildAdvancedDom();
      setupDefaultMocks();
      await binder.populate({ provider: 'ollama' }, {});
      const providerEl = document.getElementById('llm-provider');
      expect(providerEl.options.length).toBe(3); // dynamically populated
      expect(providerEl.value).toBe('ollama');
    });

    it('fetches models and populates select options', async () => {
      buildAdvancedDom();
      mockEndpoint.api.get.mockImplementation((url) => {
        if (url === '/v1/llm-providers/discover') {
          return Promise.resolve([{ key: 'aether_inference', displayName: 'Aether Inference', available: true }]);
        }
        if (url === '/v1/models') return Promise.resolve({ models: ['gpt-4', 'gpt-3.5'] });
        if (url === '/v1/settings/profiles') return Promise.resolve({ profiles: [] });
        return Promise.resolve({});
      });
      mockEndpoint.getModelCapabilities.mockResolvedValue(null);

      await binder.populate({ model: 'gpt-4' }, {});

      const modelEl = document.getElementById('llm-model');
      // placeholder + 2 fetched = 3
      expect(modelEl.options.length).toBe(3);
      expect(modelEl.options[1].value).toBe('gpt-4');
      expect(modelEl.options[2].value).toBe('gpt-3.5');
      expect(modelEl.value).toBe('gpt-4');
    });

    it('falls back to current model as sole option when fetch fails', async () => {
      buildAdvancedDom();
      mockEndpoint.api.get.mockRejectedValue(new Error('network error'));
      mockEndpoint.getModelCapabilities.mockResolvedValue(null);

      await binder.populate({ model: 'fallback-model' }, {});

      const modelEl = document.getElementById('llm-model');
      // placeholder + 1 fallback = 2
      expect(modelEl.options.length).toBe(2);
      expect(modelEl.options[1].value).toBe('fallback-model');
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch models'),
        expect.any(Error),
      );
    });

    it('sets help text in finally block', async () => {
      buildAdvancedDom();
      mockEndpoint.api.get.mockResolvedValue({ models: [] });
      mockEndpoint.getModelCapabilities.mockResolvedValue(null);
      await binder.populate({}, {});
      expect(document.getElementById('llm-model-help').textContent).toBe('Select your language model');
      expect(document.getElementById('oi-profile-help').textContent).toBe('Choose your AI assistant profile');
    });

    it('fetches profiles and populates profile select', async () => {
      buildAdvancedDom();
      mockEndpoint.api.get.mockImplementation((url) => {
        if (url === '/v1/models') return Promise.resolve({ models: [] });
        if (url === '/v1/settings/profiles') return Promise.resolve({ profiles: ['default.yaml', 'advanced.py'] });
        return Promise.resolve({});
      });

      await binder.populate({}, { profile: 'default.yaml' });

      const profileEl = document.getElementById('oi-profile');
      expect(profileEl.options.length).toBe(3);
      // Verify display text strips extensions
      expect(profileEl.options[1].textContent).toBe('default');
      expect(profileEl.options[2].textContent).toBe('advanced');
      expect(profileEl.value).toBe('default.yaml');
    });

    it('falls back to current profile when profile fetch fails', async () => {
      buildAdvancedDom();
      mockEndpoint.api.get.mockImplementation((url) => {
        if (url === '/v1/models') return Promise.resolve({ models: [] });
        if (url === '/v1/settings/profiles') return Promise.reject(new Error('profile error'));
        return Promise.resolve({});
      });

      await binder.populate({}, { profile: 'custom.yaml' });

      const profileEl = document.getElementById('oi-profile');
      expect(profileEl.options.length).toBe(2);
      expect(profileEl.value).toBe('custom.yaml');
    });

    it('wires model change listener only once (idempotent)', async () => {
      buildAdvancedDom();
      mockEndpoint.api.get.mockResolvedValue({ models: ['m1'] });
      mockEndpoint.getModelCapabilities.mockResolvedValue(null);

      await binder.populate({ model: 'm1' }, {});
      await binder.populate({ model: 'm1' }, {});

      const modelEl = document.getElementById('llm-model');
      expect(modelEl.dataset.listenerAdded).toBe('true');
    });

    it('does not crash when DOM elements are absent', async () => {
      // empty DOM
      mockEndpoint.api.get.mockResolvedValue({ models: [] });
      await expect(binder.populate({ provider: 'test' }, {})).resolves.toBeUndefined();
    });
  });

  // ==========================================================================
  // displayModelCapabilities()
  // ==========================================================================

  describe('displayModelCapabilities()', () => {
    it('calls hideModelDetails when modelName is empty', async () => {
      buildAdvancedDom();
      await binder.displayModelCapabilities('');
      expect(document.getElementById('model-details-section').style.display).toBe('none');
    });

    it('returns early when DOM elements missing', async () => {
      // empty DOM
      await expect(binder.displayModelCapabilities('test-model')).resolves.toBeUndefined();
    });

    it('hides details when capabilities are null', async () => {
      buildAdvancedDom();
      mockEndpoint.getModelCapabilities.mockResolvedValue(null);
      await binder.displayModelCapabilities('test-model');
      expect(document.getElementById('model-details-section').style.display).toBe('none');
    });

    it('renders vision and tool-use badges', async () => {
      buildAdvancedDom();
      mockEndpoint.getModelCapabilities.mockResolvedValue({
        supports_vision: true,
        supports_functions: true,
        supports_streaming: true,
        max_tokens: 16000,
      });

      await binder.displayModelCapabilities('gpt-4o');

      const content = document.getElementById('model-details-content').innerHTML;
      expect(content).toContain('Vision');
      expect(content).toContain('Tool Use');
      expect(content).toContain('Streaming');
      expect(content).toContain('16,000 max output');
      expect(binder.currentModelSupportsVision).toBe(true);
    });

    it('renders negative badges for unsupported features', async () => {
      buildAdvancedDom();
      mockEndpoint.getModelCapabilities.mockResolvedValue({
        supports_vision: false,
        supports_functions: false,
      });

      await binder.displayModelCapabilities('gpt-3.5');

      const content = document.getElementById('model-details-content').innerHTML;
      expect(content).toContain('No Vision');
      expect(content).toContain('No Tools');
      expect(binder.currentModelSupportsVision).toBe(false);
    });

    it('shows "no capability info" when capabilities has no recognized fields', async () => {
      buildAdvancedDom();
      mockEndpoint.getModelCapabilities.mockResolvedValue({ some_other_field: true });

      await binder.displayModelCapabilities('unknown-model');

      const content = document.getElementById('model-details-content').innerHTML;
      expect(content).toContain('No capability information');
    });

    it('syncs context window slider and display', async () => {
      buildAdvancedDom();
      mockEndpoint.getModelCapabilities.mockResolvedValue({
        context_window: 32000,
        context_window_max: 128000,
      });

      await binder.displayModelCapabilities('long-ctx-model');

      const slider = document.getElementById('llm-context-window-adv-slider');
      const hidden = document.getElementById('llm-context-window-adv');
      const display = document.getElementById('llm-context-window-display');

      expect(slider.max).toBe('128000');
      expect(slider.value).toBe('32000');
      expect(hidden.value).toBe('32000');
      expect(display.textContent).toContain('32,000 tokens');
    });

    it('auto-syncs temperature only when at default 0.7', async () => {
      buildAdvancedDom();
      mockEndpoint.getModelCapabilities.mockResolvedValue({
        default_temperature: 0.9,
      });

      // Temperature is at default 0.7 -- should be overwritten
      await binder.displayModelCapabilities('model-a');
      expect(document.getElementById('llm-temperature-adv').value).toBe('0.9');
    });

    it('does NOT override temperature when user changed it from default', async () => {
      buildAdvancedDom();
      document.getElementById('llm-temperature-adv').value = '0.5';
      mockEndpoint.getModelCapabilities.mockResolvedValue({
        default_temperature: 0.9,
      });

      await binder.displayModelCapabilities('model-a');
      expect(document.getElementById('llm-temperature-adv').value).toBe('0.5');
    });

    it('auto-syncs max_tokens only when at default 4096', async () => {
      buildAdvancedDom();
      mockEndpoint.getModelCapabilities.mockResolvedValue({
        default_max_tokens: 8192,
      });

      await binder.displayModelCapabilities('model-a');
      expect(document.getElementById('llm-max-tokens-adv').value).toBe('8192');
    });

    it('does NOT override max_tokens when user changed it from default', async () => {
      buildAdvancedDom();
      document.getElementById('llm-max-tokens-adv').value = '2048';
      mockEndpoint.getModelCapabilities.mockResolvedValue({
        default_max_tokens: 8192,
      });

      await binder.displayModelCapabilities('model-a');
      expect(document.getElementById('llm-max-tokens-adv').value).toBe('2048');
    });

    it('sets vision toggle checkbox from capabilities', async () => {
      buildAdvancedDom();
      mockEndpoint.getModelCapabilities.mockResolvedValue({
        supports_vision: true,
      });

      await binder.displayModelCapabilities('vision-model');
      expect(document.getElementById('llm-supports-vision').checked).toBe(true);
    });

    it('shows error HTML and logs on fetch failure', async () => {
      buildAdvancedDom();
      mockEndpoint.getModelCapabilities.mockRejectedValue(new Error('api down'));

      await binder.displayModelCapabilities('bad-model');

      const content = document.getElementById('model-details-content').innerHTML;
      expect(content).toContain('Failed to load capabilities');
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch model capabilities'),
        expect.any(Error),
      );
    });
  });

  // ==========================================================================
  // hideModelDetails()
  // ==========================================================================

  describe('hideModelDetails()', () => {
    it('hides the details section and resets vision flag', () => {
      buildAdvancedDom();
      document.getElementById('model-details-section').style.display = 'block';
      binder._currentModelSupportsVision = true;

      binder.hideModelDetails();

      expect(document.getElementById('model-details-section').style.display).toBe('none');
      expect(binder.currentModelSupportsVision).toBe(false);
    });

    it('does not throw when DOM elements are absent', () => {
      expect(() => binder.hideModelDetails()).not.toThrow();
    });
  });
});
