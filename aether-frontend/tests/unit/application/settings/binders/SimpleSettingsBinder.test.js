/** @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js */
'use strict';

/**
 * SimpleSettingsBinder Unit Tests
 * ============================================================================
 * Tests populate/collect for database, memory, monitoring, UI, and embedding
 * model settings panels. Each panel tested for: correct DOM writes, null/missing
 * element handling, edge values.
 *
 * @module tests/unit/application/settings/binders/SimpleSettingsBinder.test
 */

const SimpleSettingsBinder = require('../../../../../src/application/main/modules/settings/binders/SimpleSettingsBinder');

// Mock /v1/settings/infrastructure response for dynamic embedding model population
const MOCK_INFRA_RESPONSE = {
  embedding_service: {
    enabled: true,
    model: 'Xenova/bge-small-en-v1.5',
    embedding_model_options: [
      { value: 'Xenova/bge-small-en-v1.5', label: 'bge-small-en-v1.5 — Fast (default)', dimensions: 384, description: 'Primary ONNX embedding model' },
      { value: 'Xenova/nomic-embed-text-v1', label: 'nomic-embed-text-v1 — Higher quality', dimensions: 768, description: 'Quality ONNX embedding model' },
    ],
  },
  http_client: {},
};

describe('SimpleSettingsBinder', () => {
  let binder;
  let mockLog;
  let setDirtySpy;

  beforeEach(() => {
    mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    setDirtySpy = jest.fn();
    const mockEndpoint = {
      api: {
        get: jest.fn().mockResolvedValue(MOCK_INFRA_RESPONSE)
      }
    };
    binder = new SimpleSettingsBinder({ log: mockLog, setDirty: setDirtySpy, endpoint: mockEndpoint });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  // =========================================================================
  // populateDatabase
  // =========================================================================
  describe('populateDatabase()', () => {
    it('sets pool_size value', () => {
      const el = document.createElement('input');
      el.id = 'db-pool-size';
      document.body.appendChild(el);

      binder.populateDatabase({ pool_size: 10 });
      expect(el.value).toBe('10');
    });

    it('sets max_overflow value', () => {
      const el = document.createElement('input');
      el.id = 'db-max-overflow';
      document.body.appendChild(el);

      binder.populateDatabase({ max_overflow: 5 });
      expect(el.value).toBe('5');
    });

    it('sets max_overflow to 0 (falsy but defined)', () => {
      const el = document.createElement('input');
      el.id = 'db-max-overflow';
      document.body.appendChild(el);

      binder.populateDatabase({ max_overflow: 0 });
      expect(el.value).toBe('0');
    });

    it('sets pool_timeout value', () => {
      const el = document.createElement('input');
      el.id = 'db-pool-timeout';
      document.body.appendChild(el);

      binder.populateDatabase({ pool_timeout: 30 });
      expect(el.value).toBe('30');
    });

    it('sets echo_sql checkbox', () => {
      const el = document.createElement('input');
      el.type = 'checkbox';
      el.id = 'db-echo-sql';
      document.body.appendChild(el);

      binder.populateDatabase({ echo_sql: true });
      expect(el.checked).toBe(true);
    });

    it('unchecks echo_sql when false', () => {
      const el = document.createElement('input');
      el.type = 'checkbox';
      el.id = 'db-echo-sql';
      el.checked = true;
      document.body.appendChild(el);

      binder.populateDatabase({ echo_sql: false });
      expect(el.checked).toBe(false);
    });

    it('does nothing when database is null', () => {
      expect(() => binder.populateDatabase(null)).not.toThrow();
    });

    it('does nothing when database is undefined', () => {
      expect(() => binder.populateDatabase(undefined)).not.toThrow();
    });

    it('does not throw when DOM elements are absent', () => {
      expect(() => binder.populateDatabase({ pool_size: 10 })).not.toThrow();
    });

    it('logs when enableLogging is true', () => {
      binder.enableLogging = true;
      binder.populateDatabase({ pool_size: 5 });
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.stringContaining('Database settings populated'),
        expect.any(Object)
      );
    });
  });

  // =========================================================================
  // populateMemory
  // =========================================================================
  describe('populateMemory()', () => {
    it('checks memory-enabled when enabled is not false', () => {
      const el = document.createElement('input');
      el.type = 'checkbox';
      el.id = 'memory-enabled';
      document.body.appendChild(el);

      binder.populateMemory({ enabled: true });
      expect(el.checked).toBe(true);
    });

    it('checks memory-enabled when enabled is undefined (defaults to true)', () => {
      const el = document.createElement('input');
      el.type = 'checkbox';
      el.id = 'memory-enabled';
      document.body.appendChild(el);

      binder.populateMemory({});
      expect(el.checked).toBe(true);
    });

    it('unchecks memory-enabled when enabled is false', () => {
      const el = document.createElement('input');
      el.type = 'checkbox';
      el.id = 'memory-enabled';
      el.checked = true;
      document.body.appendChild(el);

      binder.populateMemory({ enabled: false });
      expect(el.checked).toBe(false);
    });

    it('sets memory-type value', () => {
      const el = document.createElement('input');
      el.id = 'memory-type';
      document.body.appendChild(el);

      binder.populateMemory({ type: 'supabase' });
      expect(el.value).toBe('supabase');
    });

    it('does not set memory-type when type is missing', () => {
      const el = document.createElement('input');
      el.id = 'memory-type';
      el.value = 'original';
      document.body.appendChild(el);

      binder.populateMemory({});
      expect(el.value).toBe('original');
    });

    it('does nothing when memory is null', () => {
      const el = document.createElement('input');
      el.type = 'checkbox';
      el.id = 'memory-enabled';
      document.body.appendChild(el);

      binder.populateMemory(null);
      expect(el.checked).toBe(false); // unchanged
    });

    it('does not throw when DOM elements are absent', () => {
      expect(() => binder.populateMemory({ enabled: true })).not.toThrow();
    });
  });

  // =========================================================================
  // populateMonitoring
  // =========================================================================
  describe('populateMonitoring()', () => {
    it('sets log_level', () => {
      const el = document.createElement('input');
      el.id = 'monitoring-log-level';
      document.body.appendChild(el);

      binder.populateMonitoring({ log_level: 'debug' });
      expect(el.value).toBe('debug');
    });

    it('sets log_format', () => {
      const el = document.createElement('input');
      el.id = 'monitoring-log-format';
      document.body.appendChild(el);

      binder.populateMonitoring({ log_format: 'json' });
      expect(el.value).toBe('json');
    });

    it('sets metrics_enabled checkbox', () => {
      const el = document.createElement('input');
      el.type = 'checkbox';
      el.id = 'monitoring-metrics-enabled';
      document.body.appendChild(el);

      binder.populateMonitoring({ metrics_enabled: true });
      expect(el.checked).toBe(true);
    });

    it('sets tracing_enabled checkbox', () => {
      const el = document.createElement('input');
      el.type = 'checkbox';
      el.id = 'monitoring-tracing-enabled';
      document.body.appendChild(el);

      binder.populateMonitoring({ tracing_enabled: false });
      expect(el.checked).toBe(false);
    });

    it('sets health_check_interval', () => {
      const el = document.createElement('input');
      el.id = 'monitoring-health-check-interval';
      document.body.appendChild(el);

      binder.populateMonitoring({ health_check_interval: 60 });
      expect(el.value).toBe('60');
    });

    it('does nothing when monitoring is null', () => {
      expect(() => binder.populateMonitoring(null)).not.toThrow();
    });

    it('does not throw when DOM elements are absent', () => {
      expect(() => binder.populateMonitoring({ log_level: 'info' })).not.toThrow();
    });
  });

  // =========================================================================
  // populateUi
  // =========================================================================
  describe('populateUi()', () => {
    it('checks effects toggle when effects_mode is reduced', () => {
      const el = document.createElement('input');
      el.type = 'checkbox';
      el.id = 'ui-reduced-effects';
      document.body.appendChild(el);

      binder.populateUi({ effects_mode: 'reduced' });
      expect(el.checked).toBe(true);
    });

    it('unchecks effects toggle when effects_mode is not reduced', () => {
      const el = document.createElement('input');
      el.type = 'checkbox';
      el.id = 'ui-reduced-effects';
      el.checked = true;
      document.body.appendChild(el);

      binder.populateUi({ effects_mode: 'full' });
      expect(el.checked).toBe(false);
    });

    it('unchecks effects toggle when ui is null', () => {
      const el = document.createElement('input');
      el.type = 'checkbox';
      el.id = 'ui-reduced-effects';
      el.checked = true;
      document.body.appendChild(el);

      binder.populateUi(null);
      expect(el.checked).toBe(false);
    });

    it('sets visualizer_mode value', () => {
      const el = document.createElement('input');
      el.id = 'ui-visualizer-mode';
      document.body.appendChild(el);

      binder.populateUi({ visualizer_mode: 'waves' });
      expect(el.value).toBe('waves');
    });

    it('defaults visualizer_mode to cosmos when not set', () => {
      const el = document.createElement('input');
      el.id = 'ui-visualizer-mode';
      document.body.appendChild(el);

      binder.populateUi({});
      expect(el.value).toBe('cosmos');
    });

    it('does not throw when DOM elements are absent', () => {
      expect(() => binder.populateUi({ effects_mode: 'reduced' })).not.toThrow();
    });
  });

  // =========================================================================
  // collectUiSettings
  // =========================================================================
  describe('collectUiSettings()', () => {
    it('returns reduced effects_mode when toggle is checked', () => {
      const el = document.createElement('input');
      el.type = 'checkbox';
      el.id = 'ui-reduced-effects';
      el.checked = true;
      document.body.appendChild(el);

      const result = binder.collectUiSettings();
      expect(result.effects_mode).toBe('reduced');
    });

    it('returns full effects_mode when toggle is unchecked', () => {
      const el = document.createElement('input');
      el.type = 'checkbox';
      el.id = 'ui-reduced-effects';
      el.checked = false;
      document.body.appendChild(el);

      const result = binder.collectUiSettings();
      expect(result.effects_mode).toBe('full');
    });

    it('returns full effects_mode when toggle element is absent', () => {
      const result = binder.collectUiSettings();
      expect(result.effects_mode).toBe('full');
    });

    it('includes visualizer_mode when element exists', () => {
      const el = document.createElement('input');
      el.id = 'ui-visualizer-mode';
      el.value = 'waves';
      document.body.appendChild(el);

      const result = binder.collectUiSettings();
      expect(result.visualizer_mode).toBe('waves');
    });

    it('defaults visualizer_mode to cosmos when value is empty', () => {
      const el = document.createElement('input');
      el.id = 'ui-visualizer-mode';
      el.value = '';
      document.body.appendChild(el);

      const result = binder.collectUiSettings();
      expect(result.visualizer_mode).toBe('cosmos');
    });

    it('does not include visualizer_mode when element is absent', () => {
      const result = binder.collectUiSettings();
      expect(result).not.toHaveProperty('visualizer_mode');
    });
  });

  // =========================================================================
  // populateEmbeddingModel
  // =========================================================================
  describe('populateEmbeddingModel()', () => {
    // Options come from global.fetch mock returning MOCK_INFRA_RESPONSE
    // (binder fetches /v1/settings/infrastructure internally — never from parameter)

    it('dynamically populates options from backend /v1/settings/infrastructure', async () => {
      const el = document.createElement('select');
      el.id = 'embedding-model-select';
      document.body.appendChild(el);

      await binder.populateEmbeddingModel({ model: 'Xenova/nomic-embed-text-v1' });
      expect(binder._endpoint.api.get).toHaveBeenCalledWith('/v1/settings/infrastructure');
      expect(el.options.length).toBe(2);
      expect(el.options[0].value).toBe('Xenova/bge-small-en-v1.5');
      expect(el.options[1].value).toBe('Xenova/nomic-embed-text-v1');
      expect(el.value).toBe('Xenova/nomic-embed-text-v1');
    });

    it('defaults to Xenova/bge-small-en-v1.5 when model is missing', async () => {
      const el = document.createElement('select');
      el.id = 'embedding-model-select';
      document.body.appendChild(el);

      await binder.populateEmbeddingModel({});
      expect(el.value).toBe('Xenova/bge-small-en-v1.5');
    });

    it('sets hint text with dimension count from fetched options for nomic model', async () => {
      const selectEl = document.createElement('select');
      selectEl.id = 'embedding-model-select';
      document.body.appendChild(selectEl);

      const hintEl = document.createElement('div');
      hintEl.id = 'embedding-model-hint';
      document.body.appendChild(hintEl);

      await binder.populateEmbeddingModel({ model: 'Xenova/nomic-embed-text-v1' });
      expect(hintEl.textContent).toContain('768 dimensions');
    });

    it('sets hint text with 384 dimensions for non-nomic model', async () => {
      const selectEl = document.createElement('select');
      selectEl.id = 'embedding-model-select';
      document.body.appendChild(selectEl);

      const hintEl = document.createElement('div');
      hintEl.id = 'embedding-model-hint';
      document.body.appendChild(hintEl);

      await binder.populateEmbeddingModel({ model: 'Xenova/bge-small-en-v1.5' });
      expect(hintEl.textContent).toContain('384 dimensions');
    });

    it('wires change handler once (idempotent)', async () => {
      const selectEl = document.createElement('select');
      selectEl.id = 'embedding-model-select';
      document.body.appendChild(selectEl);

      await binder.populateEmbeddingModel({});
      expect(selectEl.dataset.wired).toBe('true');

      // Call again -- should not double-wire
      const spy = jest.spyOn(selectEl, 'addEventListener');
      await binder.populateEmbeddingModel({});
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('change handler calls setDirty', async () => {
      const selectEl = document.createElement('select');
      selectEl.id = 'embedding-model-select';
      document.body.appendChild(selectEl);

      await binder.populateEmbeddingModel({});
      selectEl.value = 'Xenova/nomic-embed-text-v1';
      selectEl.dispatchEvent(new Event('change'));
      expect(setDirtySpy).toHaveBeenCalledWith(true);
    });

    it('change handler updates hint for nomic model', async () => {
      const selectEl = document.createElement('select');
      selectEl.id = 'embedding-model-select';
      document.body.appendChild(selectEl);

      const hintEl = document.createElement('div');
      hintEl.id = 'embedding-model-hint';
      document.body.appendChild(hintEl);

      await binder.populateEmbeddingModel({});
      selectEl.value = 'Xenova/nomic-embed-text-v1';
      selectEl.dispatchEvent(new Event('change'));
      expect(hintEl.textContent).toContain('768');
    });

    it('does nothing when select element is absent (skips fetch)', async () => {
      await expect(binder.populateEmbeddingModel({})).resolves.toBeUndefined();
      // No fetch because early-return before fetching
      expect(binder._endpoint.api.get).not.toHaveBeenCalled();
    });

    it('handles null embeddingService with default model', async () => {
      const selectEl = document.createElement('select');
      selectEl.id = 'embedding-model-select';
      document.body.appendChild(selectEl);

      await binder.populateEmbeddingModel(null);
      // Falls back to default model, still populates from fetched options
      expect(selectEl.value).toBe('Xenova/bge-small-en-v1.5');
    });

    it('gracefully handles fetch failure — logs warning, leaves dropdown as-is', async () => {
      binder._endpoint.api.get.mockRejectedValue(new Error('Network error'));

      const selectEl = document.createElement('select');
      selectEl.id = 'embedding-model-select';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Loading models...';
      selectEl.appendChild(placeholder);
      document.body.appendChild(selectEl);

      await binder.populateEmbeddingModel({ model: 'Xenova/bge-small-en-v1.5' });
      // Options not replaced — still shows placeholder
      expect(selectEl.options.length).toBe(1);
      expect(mockLog.warn).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Constructor defaults
  // =========================================================================
  describe('constructor', () => {
    it('uses default log when not provided', () => {
      const b = new SimpleSettingsBinder();
      expect(() => b.populateDatabase(null)).not.toThrow();
    });

    it('uses default setDirty when not provided', async () => {
      const b = new SimpleSettingsBinder();
      const selectEl = document.createElement('select');
      selectEl.id = 'embedding-model-select';
      document.body.appendChild(selectEl);
      // Should not throw even though setDirty is default no-op
      await expect(b.populateEmbeddingModel({})).resolves.toBeUndefined();
    });
  });
});
