/** @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js */
'use strict';

const ServiceProviderBinder = require('../../../../../src/application/main/modules/settings/binders/ServiceProviderBinder');

/**
 * Build DOM scaffold for a single service provider panel.
 * @param {string} uiSuffix - e.g. 'summary', 'query-gen', 'testing'
 */
function buildServiceDom(uiSuffix) {
  const frag = document.createDocumentFragment();
  const container = document.createElement('div');
  container.innerHTML = `
    <input id="svc-${uiSuffix}-provider" value="">
    <input id="svc-${uiSuffix}-model" value="">
    <input id="svc-${uiSuffix}-api-base" value="">
    <span id="svc-${uiSuffix}-hint"></span>
    <div id="svc-${uiSuffix}-model-info"></div>
  `;
  // Append children to body individually
  while (container.firstChild) {
    document.body.appendChild(container.firstChild);
  }
}

/**
 * Build full DOM scaffold for all 6 service provider panels.
 */
function buildAllServicesDom() {
  document.body.innerHTML = '';
  ['summary', 'query-gen', 'testing', 'research', 'vision'].forEach(buildServiceDom);
}

// Mock /v1/llm-providers/discover response for dynamic dropdown population
const MOCK_PROVIDERS = [
  { key: 'aether_inference', displayName: 'Aether Inference (Local)', available: true },
  { key: 'openai-compatible', displayName: 'OpenAI Compatible (LM Studio)', available: true },
  { key: 'ollama', displayName: 'Ollama', available: true },
];

describe('ServiceProviderBinder', () => {
  let binder;
  const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  let mockEndpoint;

  beforeEach(() => {
    mockEndpoint = { getModelCapabilities: jest.fn(), getBackendURL: jest.fn().mockReturnValue('http://127.0.0.1:8765') };
    binder = new ServiceProviderBinder({ log: mockLog, endpoint: mockEndpoint });
    jest.clearAllMocks();

    // Mock global fetch for dynamic provider dropdown population
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_PROVIDERS),
    });
  });
  afterEach(() => {
    document.body.innerHTML = '';
    delete global.fetch;
  });

  // ==========================================================================
  // Static maps
  // ==========================================================================

  describe('static UI_MAP', () => {
    it('maps 4 backend keys to UI suffixes', () => {
      const map = ServiceProviderBinder.UI_MAP;
      expect(Object.keys(map)).toHaveLength(4);
      expect(map.summary).toBe('summary');
      expect(map.query_generation).toBe('query-gen');
      expect(map.research).toBe('research');
      expect(map.vision_ocr).toBe('vision');
    });
  });

  describe('static SERVICE_KEY_MAP', () => {
    it('maps 4 UI suffixes to backend keys (inverse of UI_MAP values)', () => {
      const map = ServiceProviderBinder.SERVICE_KEY_MAP;
      expect(Object.keys(map)).toHaveLength(4);
      expect(map['query-gen']).toBe('query_generation');
      expect(map['vision']).toBe('vision_ocr');
    });
  });

  // ==========================================================================
  // populate()
  // ==========================================================================

  describe('populate()', () => {
    it('does nothing when serviceProviders is null', async () => {
      await binder.populate(null);
      // No crash
    });

    it('does nothing when serviceProviders is not an object', async () => {
      await binder.populate('string');
      // No crash
    });

    it('populates provider, model, api_base for a service', async () => {
      buildAllServicesDom();
      mockEndpoint.getModelCapabilities.mockResolvedValue(null);

      await binder.populate({
        summary: { provider: 'openai-compatible', model: 'gpt-4o', api_base: 'https://api.openai.com' },
      });

      expect(document.getElementById('svc-summary-provider').value).toBe('openai-compatible');
      expect(document.getElementById('svc-summary-model').value).toBe('gpt-4o');
      expect(document.getElementById('svc-summary-api-base').value).toBe('https://api.openai.com');
    });

    it('sets hint to "Default (Aether Inference)" when provider is empty', async () => {
      buildAllServicesDom();
      mockEndpoint.getModelCapabilities.mockResolvedValue(null);

      await binder.populate({ summary: { provider: '', model: 'test' } });
      expect(document.getElementById('svc-summary-hint').textContent).toBe('Default (Aether Inference)');
    });

    it('sets hint to "Default (Aether Inference)" when provider is aether_inference', async () => {
      buildAllServicesDom();
      mockEndpoint.getModelCapabilities.mockResolvedValue(null);

      await binder.populate({ summary: { provider: 'aether_inference', model: 'test' } });
      expect(document.getElementById('svc-summary-hint').textContent).toBe('Default (Aether Inference)');
    });

    it('sets hint to provider name when provider is custom', async () => {
      buildAllServicesDom();
      mockEndpoint.getModelCapabilities.mockResolvedValue(null);

      await binder.populate({ research: { provider: 'anthropic', model: 'claude-3' } });
      expect(document.getElementById('svc-research-hint').textContent).toBe('anthropic');
    });

    it('skips services not present in serviceProviders', async () => {
      buildAllServicesDom();
      await binder.populate({ summary: { provider: 'test' } });
      // Other service provider dropdowns should have default option (Aether Inference)
      // from dynamic population, but value should be ''
      expect(document.getElementById('svc-research-provider').value).toBe('');
    });

    it('calls displayServiceModelInfo when model is present', async () => {
      buildAllServicesDom();
      mockEndpoint.getModelCapabilities.mockResolvedValue(null);
      const spy = jest.spyOn(binder, 'displayServiceModelInfo');

      await binder.populate({ research: { provider: 'test', model: 'gpt-4' } });

      expect(spy).toHaveBeenCalledWith('research');
      spy.mockRestore();
    });

    it('calls attachModelInfoListeners', async () => {
      buildAllServicesDom();
      const spy = jest.spyOn(binder, 'attachModelInfoListeners');
      await binder.populate({ summary: { provider: 'test' } });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  // ==========================================================================
  // collect()
  // ==========================================================================

  describe('collect()', () => {
    it('returns null when no provider elements exist in DOM', () => {
      // empty DOM
      expect(binder.collect()).toBeNull();
    });

    it('collects all 6 services when DOM is fully present', () => {
      buildAllServicesDom();
      document.getElementById('svc-summary-provider').value = 'openai';
      document.getElementById('svc-summary-model').value = 'gpt-4o';
      document.getElementById('svc-summary-api-base').value = 'https://api.openai.com';

      const result = binder.collect();

      expect(result).not.toBeNull();
      expect(result.summary).toBeDefined();
      expect(result.summary.provider).toBe('openai');
      expect(result.summary.model).toBe('gpt-4o');
      expect(result.summary.api_base).toBe('https://api.openai.com');
      expect(result.summary.api_key).toBe('not-needed');
    });

    it('maps UI suffixes back to correct backend keys', () => {
      buildAllServicesDom();
      const result = binder.collect();

      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('query_generation'); // from 'query-gen'
      expect(result).toHaveProperty('research');
      expect(result).toHaveProperty('vision_ocr'); // from 'vision'
    });

    it('defaults to empty strings for missing model/api_base elements', () => {
      // Only provider element for summary
      document.body.innerHTML = '<input id="svc-summary-provider" value="test">';
      const result = binder.collect();
      expect(result.summary.model).toBe('');
      expect(result.summary.api_base).toBe('');
    });
  });

  // ==========================================================================
  // attachModelInfoListeners()
  // ==========================================================================

  describe('attachModelInfoListeners()', () => {
    it('is idempotent -- only wires once', () => {
      buildAllServicesDom();
      binder.attachModelInfoListeners(ServiceProviderBinder.UI_MAP);
      binder.attachModelInfoListeners(ServiceProviderBinder.UI_MAP);
      expect(binder._svcModelInfoListenersBound).toBe(true);
    });

    it('does not throw when model elements are absent', () => {
      expect(() => binder.attachModelInfoListeners(ServiceProviderBinder.UI_MAP)).not.toThrow();
    });
  });

  // ==========================================================================
  // displayServiceModelInfo()
  // ==========================================================================

  describe('displayServiceModelInfo()', () => {
    it('returns silently when info element is absent', async () => {
      document.body.innerHTML = '<input id="svc-summary-model" value="test">';
      // no svc-summary-model-info
      await expect(binder.displayServiceModelInfo('summary')).resolves.toBeUndefined();
    });

    it('clears and hides when model name is empty', async () => {
      buildServiceDom('summary');
      document.getElementById('svc-summary-model').value = '';
      const infoEl = document.getElementById('svc-summary-model-info');
      infoEl.classList.add('visible');
      infoEl.innerHTML = 'old content';

      await binder.displayServiceModelInfo('summary');

      expect(infoEl.classList.contains('visible')).toBe(false);
      expect(infoEl.innerHTML).toBe('');
    });

    it('clears and hides when capabilities are null', async () => {
      buildServiceDom('summary');
      document.getElementById('svc-summary-model').value = 'test-model';
      mockEndpoint.getModelCapabilities.mockResolvedValue(null);

      await binder.displayServiceModelInfo('summary');

      const infoEl = document.getElementById('svc-summary-model-info');
      expect(infoEl.classList.contains('visible')).toBe(false);
    });

    it('renders context window and vision/tool badges when capabilities present', async () => {
      buildServiceDom('summary');
      document.getElementById('svc-summary-model').value = 'gpt-4o';
      mockEndpoint.getModelCapabilities.mockResolvedValue({
        context_window: 128000,
        supports_vision: true,
        supports_functions: true,
      });

      await binder.displayServiceModelInfo('summary');

      const infoEl = document.getElementById('svc-summary-model-info');
      expect(infoEl.classList.contains('visible')).toBe(true);
      expect(infoEl.innerHTML).toContain('128,000 tokens');
      expect(infoEl.innerHTML).toContain('Vision');
      expect(infoEl.innerHTML).toContain('Tool Use');
    });

    it('renders negative badges for unsupported features', async () => {
      buildServiceDom('testing');
      document.getElementById('svc-testing-model').value = 'basic-model';
      mockEndpoint.getModelCapabilities.mockResolvedValue({
        supports_vision: false,
        supports_functions: false,
      });

      await binder.displayServiceModelInfo('testing');

      const infoEl = document.getElementById('svc-testing-model-info');
      expect(infoEl.innerHTML).toContain('No Vision');
      expect(infoEl.innerHTML).toContain('No Tools');
    });

    it('hides when capabilities have no recognized fields', async () => {
      buildServiceDom('summary');
      document.getElementById('svc-summary-model').value = 'unknown';
      mockEndpoint.getModelCapabilities.mockResolvedValue({ unknown_field: true });

      await binder.displayServiceModelInfo('summary');

      const infoEl = document.getElementById('svc-summary-model-info');
      expect(infoEl.classList.contains('visible')).toBe(false);
      expect(infoEl.innerHTML).toBe('');
    });

    it('clears and hides on fetch error', async () => {
      buildServiceDom('summary');
      document.getElementById('svc-summary-model').value = 'test';
      mockEndpoint.getModelCapabilities.mockRejectedValue(new Error('fail'));

      await binder.displayServiceModelInfo('summary');

      const infoEl = document.getElementById('svc-summary-model-info');
      expect(infoEl.classList.contains('visible')).toBe(false);
      expect(infoEl.innerHTML).toBe('');
    });
  });
});
