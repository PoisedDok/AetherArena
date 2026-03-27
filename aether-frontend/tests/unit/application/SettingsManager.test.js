/** @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js */
'use strict';

/**
 * SettingsManager Orchestrator Tests
 * ============================================================================
 * Tests the thin orchestrator: constructor, delegation to domain SettingsService,
 * binder proxy methods, loadSettings/saveSettings orchestration, correlation IDs,
 * error emission, lifecycle/dispose, dirty tracking, and enableLogging branches.
 *
 * All utility methods (get/set/validate/export/import/stats/defaults) are now
 * delegated to SettingsService -- tested here as proxy verification.
 *
 * DOM-heavy rendering methods (_populateXxx, _collectXxx) are tested in their
 * respective binder test suites.
 *
 * @module tests/unit/application/SettingsManager.test
 */

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
}));

jest.mock('../../../src/core/config/defaults', () => Object.freeze({
  backend: Object.freeze({ baseUrl: 'http://127.0.0.1:8765' }),
  paths: Object.freeze({ skillsDir: './skills', memoryDb: './memory.db' }),
}));

// Mock full config module to prevent EnvLoader init (Settings model requires core/config)
jest.mock('../../../src/core/config', () => Object.freeze({
  backend: Object.freeze({ baseUrl: 'http://127.0.0.1:8765' }),
  paths: Object.freeze({ skillsDir: './skills', memoryDb: './memory.db' }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEndpoint() {
  return {
    getSettings: jest.fn().mockResolvedValue({ llm: { model: 'gpt-4' } }),
    setSettings: jest.fn().mockResolvedValue({ success: true }),
    getUserPreferences: jest.fn().mockResolvedValue({ theme: 'dark' }),
    getUserSettingsMetadata: jest.fn().mockResolvedValue([
      { key: 'llm.model', type: 'string' },
    ]),
    getSettingsHealth: jest.fn().mockResolvedValue({ status: 'healthy' }),
    getServicesStatus: jest.fn().mockResolvedValue({ services: [] }),
    getModels: jest.fn().mockResolvedValue({ models: [] }),
    getProfiles: jest.fn().mockResolvedValue({ profiles: [] }),
    getModelCapabilities: jest.fn().mockResolvedValue(null),
  };
}

function createMockEventBus() {
  return { emit: jest.fn(), on: jest.fn(), off: jest.fn(), removeAllListeners: jest.fn() };
}

// ---------------------------------------------------------------------------
// crypto override helper
// ---------------------------------------------------------------------------

let uuidCounter = 0;

function installCryptoMock() {
  uuidCounter = 0;
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      randomUUID() {
        uuidCounter += 1;
        return `00000000-0000-0000-0000-${String(uuidCounter).padStart(12, '0')}`;
      },
      getRandomValues(arr) { return arr; },
    },
    writable: true,
    configurable: true,
  });
}

function removeCryptoMock() {
  Object.defineProperty(globalThis, 'crypto', {
    value: undefined,
    writable: true,
    configurable: true,
  });
}

installCryptoMock();

// ---------------------------------------------------------------------------
// Import SUT
// ---------------------------------------------------------------------------

const SettingsManager = require('../../../src/application/main/modules/settings/SettingsManager');
const { EventTypes } = require('../../../src/core/events/EventTypes');

// ===========================================================================
// Tests
// ===========================================================================

describe('SettingsManager', () => {
  let manager;
  let endpoint;
  let eventBus;

  beforeEach(() => {
    installCryptoMock();
    endpoint = createMockEndpoint();
    eventBus = createMockEventBus();
    manager = new SettingsManager({ endpoint, eventBus });
  });

  afterEach(() => {
    if (manager) {
      try { manager.dispose(); } catch (_) { /* already disposed */ }
    }
  });

  // =========================================================================
  // constructor
  // =========================================================================
  describe('constructor', () => {
    it('throws when endpoint is not provided', () => {
      expect(() => new SettingsManager({ eventBus }))
        .toThrow('[SettingsManager] endpoint required');
    });

    it('throws when eventBus is not provided', () => {
      expect(() => new SettingsManager({ endpoint }))
        .toThrow('[SettingsManager] eventBus required');
    });

    it('throws when called with no arguments', () => {
      expect(() => new SettingsManager())
        .toThrow('[SettingsManager] endpoint required');
    });

    it('sets enableLogging to false by default', () => {
      expect(manager.enableLogging).toBe(false);
    });

    it('sets enableLogging when provided', () => {
      const m = new SettingsManager({ endpoint, eventBus, enableLogging: true });
      expect(m.enableLogging).toBe(true);
      m.dispose();
    });

    it('stores endpoint and eventBus references', () => {
      expect(manager.endpoint).toBe(endpoint);
      expect(manager.eventBus).toBe(eventBus);
    });

    it('initialises _isDirty to false', () => {
      expect(manager._isDirty).toBe(false);
    });

    it('initialises _isPopulating to false', () => {
      expect(manager._isPopulating).toBe(false);
    });

    it('creates _settingsService', () => {
      expect(manager._settingsService).toBeDefined();
      expect(manager._settingsService).not.toBeNull();
    });

    it('creates all binders', () => {
      expect(manager._simpleBinder).toBeDefined();
      expect(manager._handsfreeBinder).toBeDefined();
      expect(manager._localSourcesBinder).toBeDefined();
      expect(manager._visionBinder).toBeDefined();
      expect(manager._summaryBinder).toBeDefined();
      expect(manager._advancedBinder).toBeDefined();
      expect(manager._serviceProviderBinder).toBeDefined();
      expect(manager._serviceStatusBinder).toBeDefined();
    });

    it('attaches dirty tracker', () => {
      expect(typeof manager._inputHandler).toBe('function');
      expect(typeof manager._changeHandler).toBe('function');
    });
  });

  // =========================================================================
  // currentSettings getter/setter
  // =========================================================================
  describe('currentSettings', () => {
    it('getter returns a plain object from the service', () => {
      const settings = manager.currentSettings;
      expect(settings).toBeDefined();
      expect(typeof settings).toBe('object');
    });

    it('setter updates service state', () => {
      manager.currentSettings = { llm: { model: 'test-model' } };
      expect(manager.getSetting('llm.model')).toBe('test-model');
    });

    it('getter returns empty object when service is null', () => {
      manager._settingsService = null;
      expect(manager.currentSettings).toEqual({});
    });

    it('setter is no-op when service is null', () => {
      manager._settingsService = null;
      expect(() => { manager.currentSettings = { llm: {} }; }).not.toThrow();
    });
  });

  // =========================================================================
  // Domain service proxy methods
  // =========================================================================
  describe('getSetting()', () => {
    it('retrieves nested key via dot-path', () => {
      manager.currentSettings = { llm: { model: 'gpt-4' } };
      expect(manager.getSetting('llm.model')).toBe('gpt-4');
    });

    it('returns undefined for missing path', () => {
      expect(manager.getSetting('nonexistent.deep.path')).toBeUndefined();
    });
  });

  describe('setSetting()', () => {
    it('sets nested key via dot-path', () => {
      manager.setSetting('llm.model', 'gpt-4');
      expect(manager.getSetting('llm.model')).toBe('gpt-4');
    });

    it('creates intermediate objects', () => {
      manager.setSetting('custom.deep.path', 'value');
      expect(manager.getSetting('custom.deep.path')).toBe('value');
    });
  });

  describe('getSettings()', () => {
    it('returns a plain object copy', () => {
      manager.setSetting('llm.model', 'test');
      const s = manager.getSettings();
      expect(s.llm.model).toBe('test');
    });
  });

  describe('getDefaults()', () => {
    it('returns plain object with known categories', () => {
      const d = manager.getDefaults();
      expect(d).toHaveProperty('interpreter');
      expect(d).toHaveProperty('llm');
      expect(d).toHaveProperty('voice');
      expect(d).toHaveProperty('memory');
      expect(d).toHaveProperty('security');
    });

    it('returns fresh copy each time', () => {
      const d1 = manager.getDefaults();
      const d2 = manager.getDefaults();
      expect(d1).toEqual(d2);
      expect(d1).not.toBe(d2);
    });
  });

  describe('resetToDefaults()', () => {
    it('resets settings to defaults', () => {
      manager.setSetting('custom.key', 'value');
      manager.resetToDefaults();
      expect(manager.getSetting('custom.key')).toBeUndefined();
    });
  });

  describe('validateSettings()', () => {
    it('returns valid for a plain object', () => {
      const result = manager.validateSettings({ llm: { provider: 'aether_inference', model: 'gpt-4' } });
      expect(result.valid).toBe(true);
    });

    it('returns invalid for null', () => {
      const result = manager.validateSettings(null);
      expect(result.valid).toBe(false);
    });

    it('returns invalid for non-object', () => {
      const result = manager.validateSettings('not-an-object');
      expect(result.valid).toBe(false);
    });
  });

  describe('exportSettings()', () => {
    it('returns JSON string', () => {
      manager.setSetting('llm.model', 'gpt-4');
      const json = manager.exportSettings();
      expect(typeof json).toBe('string');
      const parsed = JSON.parse(json);
      expect(parsed.llm.model).toBe('gpt-4');
    });
  });

  describe('importSettings()', () => {
    it('successfully imports valid JSON settings', () => {
      const json = JSON.stringify({ llm: { model: 'imported-model', provider: 'test' } });
      const result = manager.importSettings(json);
      expect(result.success).toBe(true);
    });

    it('returns failure for invalid JSON', () => {
      const result = manager.importSettings('not valid json{{{');
      expect(result.success).toBe(false);
    });

    it('round-trips: export then import', () => {
      manager.setSetting('llm.model', 'round-trip-model');
      const exported = manager.exportSettings();

      manager.resetToDefaults();
      const result = manager.importSettings(exported);
      expect(result.success).toBe(true);
      expect(manager.getSetting('llm.model')).toBe('round-trip-model');
    });
  });

  describe('getStats()', () => {
    it('returns a frozen object', () => {
      const stats = manager.getStats();
      expect(Object.isFrozen(stats)).toBe(true);
    });

    it('has expected keys', () => {
      const stats = manager.getStats();
      expect(stats).toHaveProperty('hasSettings');
      expect(stats).toHaveProperty('settingsSize');
    });

    it('hasSettings is true', () => {
      expect(manager.getStats().hasSettings).toBe(true);
    });

    it('settingsSize is a positive number', () => {
      expect(manager.getStats().settingsSize).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // _generateCorrelationId
  // =========================================================================
  describe('_generateCorrelationId()', () => {
    it('returns string with settings-{stage}-{uuid} format', () => {
      const id = manager._generateCorrelationId('load');
      expect(id).toMatch(/^settings-load-/);
    });

    it('defaults stage to "load"', () => {
      const id = manager._generateCorrelationId();
      expect(id).toMatch(/^settings-load-/);
    });

    it('uses provided stage', () => {
      const id = manager._generateCorrelationId('save');
      expect(id).toMatch(/^settings-save-/);
    });

    it('throws when crypto is unavailable', () => {
      removeCryptoMock();
      try {
        expect(() => manager._generateCorrelationId())
          .toThrow('crypto.randomUUID is required');
      } finally {
        installCryptoMock();
      }
    });

    it('throws when crypto.randomUUID is not a function', () => {
      Object.defineProperty(globalThis, 'crypto', {
        value: {},
        writable: true,
        configurable: true,
      });
      try {
        expect(() => manager._generateCorrelationId())
          .toThrow('crypto.randomUUID is required');
      } finally {
        installCryptoMock();
      }
    });

    it('wraps randomUUID errors in CONTRACT VIOLATION', () => {
      Object.defineProperty(globalThis, 'crypto', {
        value: {
          randomUUID() { throw new Error('entropy failure'); },
        },
        writable: true,
        configurable: true,
      });
      try {
        expect(() => manager._generateCorrelationId())
          .toThrow('CONTRACT VIOLATION: Failed to generate correlation ID');
      } finally {
        installCryptoMock();
      }
    });
  });

  // =========================================================================
  // _emitSettingsLoadError / _emitSettingsSaveError
  // =========================================================================
  describe('_emitSettingsLoadError()', () => {
    it('emits UI.ERROR with load message', () => {
      const err = new Error('network failure');
      manager._emitSettingsLoadError('corr-123', err);
      expect(eventBus.emit).toHaveBeenCalledWith(EventTypes.UI.ERROR, {
        message: 'Failed to load settings from backend',
        correlationId: 'corr-123',
        error: 'network failure',
      });
    });

    it('handles non-Error error objects', () => {
      manager._emitSettingsLoadError('corr-456', 'string error');
      expect(eventBus.emit).toHaveBeenCalledWith(EventTypes.UI.ERROR, expect.objectContaining({
        error: 'string error',
      }));
    });

    it('does nothing when eventBus is null', () => {
      manager.eventBus = null;
      expect(() => manager._emitSettingsLoadError('id', new Error('test'))).not.toThrow();
    });
  });

  describe('_emitSettingsSaveError()', () => {
    it('emits UI.ERROR with save message', () => {
      const err = new Error('save failure');
      manager._emitSettingsSaveError('corr-789', err);
      expect(eventBus.emit).toHaveBeenCalledWith(EventTypes.UI.ERROR, {
        message: 'Failed to save settings to backend',
        correlationId: 'corr-789',
        error: 'save failure',
      });
    });

    it('does nothing when eventBus is null', () => {
      manager.eventBus = null;
      expect(() => manager._emitSettingsSaveError('id', new Error('test'))).not.toThrow();
    });
  });

  // =========================================================================
  // getUserPreferences
  // =========================================================================
  describe('getUserPreferences()', () => {
    it('returns preferences from endpoint', async () => {
      const result = await manager.getUserPreferences();
      expect(result).toEqual({ theme: 'dark' });
      expect(endpoint.getUserPreferences).toHaveBeenCalledWith(
        expect.objectContaining({ correlationId: expect.stringMatching(/^settings-user-prefs-/) })
      );
    });

    it('throws on null response', async () => {
      endpoint.getUserPreferences.mockResolvedValue(null);
      await expect(manager.getUserPreferences())
        .rejects.toThrow('Invalid user preferences response');
    });
  });

  // =========================================================================
  // getUserSettingsMetadata
  // =========================================================================
  describe('getUserSettingsMetadata()', () => {
    it('returns metadata array from endpoint', async () => {
      const result = await manager.getUserSettingsMetadata();
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
    });

    it('throws on non-array response', async () => {
      endpoint.getUserSettingsMetadata.mockResolvedValue({ notAnArray: true });
      await expect(manager.getUserSettingsMetadata())
        .rejects.toThrow('Invalid metadata response');
    });
  });

  // =========================================================================
  // checkSettingsHealth
  // =========================================================================
  describe('checkSettingsHealth()', () => {
    it('returns health status from endpoint', async () => {
      const result = await manager.checkSettingsHealth();
      expect(result).toEqual({ status: 'healthy' });
    });

    it('returns error object on endpoint failure', async () => {
      endpoint.getSettingsHealth.mockRejectedValue(new Error('connection refused'));
      const result = await manager.checkSettingsHealth();
      expect(result).toEqual({
        status: 'unhealthy',
        error: 'connection refused',
      });
    });
  });

  // =========================================================================
  // _applyUiSettings
  // =========================================================================
  describe('_applyUiSettings()', () => {
    it('sets data-effects attribute to reduced', () => {
      manager._applyUiSettings({ effects_mode: 'reduced' });
      expect(document.documentElement.getAttribute('data-effects')).toBe('reduced');
    });

    it('defaults to full when effects_mode is not reduced', () => {
      manager._applyUiSettings({ effects_mode: 'something-else' });
      expect(document.documentElement.getAttribute('data-effects')).toBe('full');
    });

    it('defaults to full when ui is null', () => {
      manager._applyUiSettings(null);
      expect(document.documentElement.getAttribute('data-effects')).toBe('full');
    });
  });

  // =========================================================================
  // loadSettings (async -- mock DOM-heavy methods)
  // =========================================================================
  describe('loadSettings()', () => {
    beforeEach(() => {
      jest.spyOn(manager, '_applyUiSettings').mockImplementation(() => {});
      jest.spyOn(manager, '_populateSummarySettings').mockImplementation(() => {});
      jest.spyOn(manager, '_populateAdvancedSettings').mockResolvedValue();
      jest.spyOn(manager, '_populateVisionSettings').mockResolvedValue();
      jest.spyOn(manager, '_populateHandsfreeSettings').mockResolvedValue();
      jest.spyOn(manager, '_populateDatabaseSettings').mockImplementation(() => {});
      jest.spyOn(manager, '_populateMemorySettings').mockImplementation(() => {});
      jest.spyOn(manager, '_populateMonitoringSettings').mockImplementation(() => {});
      jest.spyOn(manager, '_populateEmbeddingModelSettings').mockResolvedValue();
      jest.spyOn(manager, '_populateServiceProviderSettings').mockResolvedValue();
      jest.spyOn(manager, '_populateLocalSourcesSettings').mockResolvedValue();
      jest.spyOn(manager, '_setDirty').mockImplementation(() => {});
    });

    it('fetches settings from endpoint and stores in service', async () => {
      endpoint.getSettings.mockResolvedValue({ llm: { model: 'gpt-4' }, handsfree: { enabled: true } });
      const result = await manager.loadSettings();
      expect(result.source).toBe('backend');
      expect(result.settings.llm.model).toBe('gpt-4');
    });

    it('throws on null response from endpoint', async () => {
      endpoint.getSettings.mockResolvedValue(null);
      await expect(manager.loadSettings())
        .rejects.toThrow('CONTRACT VIOLATION: Backend returned invalid settings');
    });

    it('throws on non-object response from endpoint', async () => {
      endpoint.getSettings.mockResolvedValue('invalid');
      await expect(manager.loadSettings())
        .rejects.toThrow('CONTRACT VIOLATION: Backend returned invalid settings');
    });

    it('emits UI.ERROR event when endpoint rejects', async () => {
      endpoint.getSettings.mockRejectedValue(new Error('network down'));
      jest.spyOn(manager, '_emitSettingsLoadError');
      await expect(manager.loadSettings()).rejects.toThrow('network down');
      expect(manager._emitSettingsLoadError).toHaveBeenCalledWith(
        expect.stringMatching(/^settings-load-/),
        expect.any(Error)
      );
    });

    it('emits UI.ERROR event on invalid (null) response', async () => {
      endpoint.getSettings.mockResolvedValue(null);
      jest.spyOn(manager, '_emitSettingsLoadError');
      await expect(manager.loadSettings()).rejects.toThrow('CONTRACT VIOLATION');
      expect(manager._emitSettingsLoadError).toHaveBeenCalledWith(
        expect.stringMatching(/^settings-load-/),
        expect.any(Error)
      );
    });

    it('emits SETTINGS.LLM_UPDATED event', async () => {
      await manager.loadSettings();
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.SETTINGS.LLM_UPDATED,
        expect.objectContaining({
          source: 'backend',
          correlationId: expect.stringMatching(/^settings-load-/),
        })
      );
    });

    it('calls _setDirty(false) after load', async () => {
      await manager.loadSettings();
      expect(manager._setDirty).toHaveBeenCalledWith(false);
    });

    it('resets _isPopulating to false in finally block (even on error)', async () => {
      endpoint.getSettings.mockResolvedValue({ llm: {} });
      jest.spyOn(manager, '_populateSummarySettings').mockImplementation(() => {
        throw new Error('DOM error');
      });
      await expect(manager.loadSettings()).rejects.toThrow('DOM error');
      expect(manager._isPopulating).toBe(false);
    });

    it('calls _populateAdvancedSettings when llm or interpreter present', async () => {
      endpoint.getSettings.mockResolvedValue({ llm: { model: 'test' }, interpreter: {} });
      await manager.loadSettings();
      expect(manager._populateAdvancedSettings).toHaveBeenCalledTimes(1);
    });

    it('calls _populateVisionSettings when vision_document present', async () => {
      endpoint.getSettings.mockResolvedValue({ vision_document: { enabled: true } });
      await manager.loadSettings();
      expect(manager._populateVisionSettings).toHaveBeenCalledTimes(1);
    });

    it('calls _populateHandsfreeSettings when handsfree present', async () => {
      endpoint.getSettings.mockResolvedValue({ handsfree: { enabled: true } });
      await manager.loadSettings();
      expect(manager._populateHandsfreeSettings).toHaveBeenCalledTimes(1);
    });

    it('calls _populateDatabaseSettings when database present', async () => {
      endpoint.getSettings.mockResolvedValue({ database: { pool_size: 10 } });
      await manager.loadSettings();
      expect(manager._populateDatabaseSettings).toHaveBeenCalledTimes(1);
    });

    it('calls _populateMemorySettings when memory present', async () => {
      endpoint.getSettings.mockResolvedValue({ memory: { enabled: true } });
      await manager.loadSettings();
      expect(manager._populateMemorySettings).toHaveBeenCalledTimes(1);
    });

    it('calls _populateMonitoringSettings when monitoring present', async () => {
      endpoint.getSettings.mockResolvedValue({ monitoring: { log_level: 'info' } });
      await manager.loadSettings();
      expect(manager._populateMonitoringSettings).toHaveBeenCalledTimes(1);
    });

    it('calls _populateServiceProviderSettings when service_providers present', async () => {
      endpoint.getSettings.mockResolvedValue({ service_providers: { chat: 'openai' } });
      await manager.loadSettings();
      expect(manager._populateServiceProviderSettings).toHaveBeenCalledTimes(1);
    });

    it('calls _populateLocalSourcesSettings when integrations.local_sources present', async () => {
      endpoint.getSettings.mockResolvedValue({ integrations: { local_sources: { enabled: true } } });
      await manager.loadSettings();
      expect(manager._populateLocalSourcesSettings).toHaveBeenCalledTimes(1);
    });

    it('does not throw when _populateAdvancedSettings rejects (fire-and-forget)', async () => {
      endpoint.getSettings.mockResolvedValue({ llm: { model: 'test' } });
      manager._populateAdvancedSettings.mockRejectedValue(new Error('adv fail'));
      await expect(manager.loadSettings()).resolves.toBeDefined();
    });

    it('does not throw when _populateVisionSettings rejects', async () => {
      endpoint.getSettings.mockResolvedValue({ vision_document: {} });
      manager._populateVisionSettings.mockRejectedValue(new Error('vision fail'));
      await expect(manager.loadSettings()).resolves.toBeDefined();
    });

    it('does not throw when _populateHandsfreeSettings rejects', async () => {
      endpoint.getSettings.mockResolvedValue({ handsfree: {} });
      manager._populateHandsfreeSettings.mockRejectedValue(new Error('hf fail'));
      await expect(manager.loadSettings()).resolves.toBeDefined();
    });
  });

  // =========================================================================
  // saveSettings
  // =========================================================================
  describe('saveSettings()', () => {
    beforeEach(() => {
      jest.spyOn(manager, '_applyUiSettings').mockImplementation(() => {});
      jest.spyOn(manager, '_setDirty').mockImplementation(() => {});
      jest.spyOn(manager, '_collectVisionSettings').mockReturnValue({});
      jest.spyOn(manager, '_collectHandsfreeSettings').mockReturnValue({});
      jest.spyOn(manager, '_collectUiSettings').mockReturnValue({});
      jest.spyOn(manager, '_collectSummarySettingsFromUi').mockReturnValue(null);
      jest.spyOn(manager, '_collectLocalSourcesSettingsFromUi').mockReturnValue(null);
      jest.spyOn(manager, '_collectServiceProviderSettings').mockReturnValue(null);
    });

    it('falls back to currentSettings when null is passed', async () => {
      manager.currentSettings = { llm: { provider: 'openai', model: 'gpt-4o' } };
      const result = await manager.saveSettings(null);
      expect(result.success).toBe(true);
      expect(endpoint.setSettings).toHaveBeenCalledTimes(1);
    });

    it('throws on non-object settings argument', async () => {
      await expect(manager.saveSettings('bad'))
        .rejects.toThrow('CONTRACT VIOLATION: Settings must be a non-null object');
    });

    it('uses currentSettings when no argument provided', async () => {
      manager.currentSettings = { llm: { model: 'test' } };
      await manager.saveSettings();
      expect(endpoint.setSettings).toHaveBeenCalledWith(
        expect.objectContaining({ llm: expect.any(Object) }),
        expect.objectContaining({ correlationId: expect.any(String) })
      );
    });

    it('emits SETTINGS.LLM_UPDATED and UI.SETTINGS_SAVED on success', async () => {
      await manager.saveSettings({ llm: {} });
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.SETTINGS.LLM_UPDATED,
        expect.objectContaining({ source: 'backend' })
      );
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.UI.SETTINGS_SAVED,
        expect.objectContaining({ source: 'backend' })
      );
    });

    it('emits save error and re-throws on endpoint failure', async () => {
      endpoint.setSettings.mockRejectedValue(new Error('save failed'));
      jest.spyOn(manager, '_emitSettingsSaveError');
      await expect(manager.saveSettings({ llm: {} }))
        .rejects.toThrow('save failed');
      expect(manager._emitSettingsSaveError).toHaveBeenCalled();
    });

    it('calls _setDirty(false) on successful save', async () => {
      await manager.saveSettings({ llm: {} });
      expect(manager._setDirty).toHaveBeenCalledWith(false);
    });

    it('collects summary settings from UI when available', async () => {
      manager._collectSummarySettingsFromUi.mockReturnValue({ auto_summarize: true });
      const settings = { llm: {} };
      await manager.saveSettings(settings);
      const savedArg = endpoint.setSettings.mock.calls[0][0];
      expect(savedArg.summary).toEqual(expect.objectContaining({ auto_summarize: true }));
    });

    it('collects local sources settings from UI when available', async () => {
      manager._collectLocalSourcesSettingsFromUi.mockReturnValue({ enabled: true });
      const settings = { llm: {} };
      await manager.saveSettings(settings);
      const savedArg = endpoint.setSettings.mock.calls[0][0];
      expect(savedArg.integrations.local_sources).toEqual({ enabled: true });
    });

    it('collects service provider settings when available', async () => {
      manager._collectServiceProviderSettings.mockReturnValue({ chat: 'anthropic' });
      const settings = { llm: {} };
      await manager.saveSettings(settings);
      const savedArg = endpoint.setSettings.mock.calls[0][0];
      expect(savedArg.service_providers).toEqual({ chat: 'anthropic' });
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================
  describe('dispose()', () => {
    it('removes document event listeners', () => {
      const spy = jest.spyOn(document, 'removeEventListener');
      manager.dispose();
      const inputCalls = spy.mock.calls.filter(c => c[0] === 'input');
      const changeCalls = spy.mock.calls.filter(c => c[0] === 'change');
      expect(inputCalls.length).toBeGreaterThanOrEqual(1);
      expect(changeCalls.length).toBeGreaterThanOrEqual(1);
      spy.mockRestore();
    });

    it('nulls out _inputHandler and _changeHandler', () => {
      manager.dispose();
      expect(manager._inputHandler).toBeNull();
      expect(manager._changeHandler).toBeNull();
    });

    it('nulls out endpoint and eventBus', () => {
      manager.dispose();
      expect(manager.endpoint).toBeNull();
      expect(manager.eventBus).toBeNull();
    });

    it('handles double-dispose gracefully', () => {
      manager.dispose();
      expect(() => manager.dispose()).not.toThrow();
    });
  });

  // =========================================================================
  // _setDirty
  // =========================================================================
  describe('_setDirty()', () => {
    it('sets _isDirty flag', () => {
      manager._setDirty(true);
      expect(manager._isDirty).toBe(true);
    });

    it('skips when _isPopulating is true', () => {
      manager._isPopulating = true;
      manager._setDirty(true);
      expect(manager._isDirty).toBe(false);
    });

    it('updates DOM status element when present', () => {
      const statusEl = document.createElement('div');
      statusEl.id = 'settings-status';
      document.body.appendChild(statusEl);

      manager._setDirty(true);
      expect(statusEl.textContent).toBe('● Unsaved changes');

      manager._setDirty(false);
      expect(statusEl.textContent).toBe('');

      document.body.removeChild(statusEl);
    });

    it('updates DOM save button when present', () => {
      const saveBtn = document.createElement('button');
      saveBtn.id = 'settings-save';
      document.body.appendChild(saveBtn);

      manager._setDirty(true);
      expect(saveBtn.classList.contains('is-dirty')).toBe(true);
      expect(saveBtn.disabled).toBe(false);

      manager._setDirty(false);
      expect(saveBtn.classList.contains('is-dirty')).toBe(false);
      expect(saveBtn.disabled).toBe(true);

      document.body.removeChild(saveBtn);
    });
  });

  // =========================================================================
  // enableLogging branches
  // =========================================================================
  describe('enableLogging branches', () => {
    let logManager;

    beforeEach(() => {
      logManager = new SettingsManager({ endpoint, eventBus, enableLogging: true });
      jest.spyOn(logManager, '_applyUiSettings').mockImplementation(() => {});
      jest.spyOn(logManager, '_populateSummarySettings').mockImplementation(() => {});
      jest.spyOn(logManager, '_populateAdvancedSettings').mockResolvedValue();
      jest.spyOn(logManager, '_populateVisionSettings').mockResolvedValue();
      jest.spyOn(logManager, '_populateHandsfreeSettings').mockResolvedValue();
      jest.spyOn(logManager, '_populateDatabaseSettings').mockImplementation(() => {});
      jest.spyOn(logManager, '_populateMemorySettings').mockImplementation(() => {});
      jest.spyOn(logManager, '_populateMonitoringSettings').mockImplementation(() => {});
      jest.spyOn(logManager, '_populateEmbeddingModelSettings').mockResolvedValue();
      jest.spyOn(logManager, '_populateServiceProviderSettings').mockResolvedValue();
      jest.spyOn(logManager, '_populateLocalSourcesSettings').mockResolvedValue();
      jest.spyOn(logManager, '_setDirty').mockImplementation(() => {});
      jest.spyOn(logManager, '_collectVisionSettings').mockReturnValue({});
      jest.spyOn(logManager, '_collectHandsfreeSettings').mockReturnValue({});
      jest.spyOn(logManager, '_collectUiSettings').mockReturnValue({});
      jest.spyOn(logManager, '_collectSummarySettingsFromUi').mockReturnValue(null);
      jest.spyOn(logManager, '_collectLocalSourcesSettingsFromUi').mockReturnValue(null);
      jest.spyOn(logManager, '_collectServiceProviderSettings').mockReturnValue(null);
    });

    afterEach(() => {
      logManager.dispose();
    });

    it('logs during loadSettings', async () => {
      await logManager.loadSettings();
      expect(logManager.log.info).toHaveBeenCalledWith(
        expect.stringContaining('Loading settings')
      );
      expect(logManager.log.info).toHaveBeenCalledWith(
        expect.stringContaining('Loaded settings from backend')
      );
    });

    it('logs during saveSettings', async () => {
      await logManager.saveSettings({ llm: {} });
      expect(logManager.log.info).toHaveBeenCalledWith(
        expect.stringContaining('Saving settings')
      );
      expect(logManager.log.info).toHaveBeenCalledWith(
        expect.stringContaining('Saved settings to backend')
      );
    });

    it('logs during getUserPreferences', async () => {
      await logManager.getUserPreferences();
      expect(logManager.log.info).toHaveBeenCalledWith(
        expect.stringContaining('Loading user preferences')
      );
    });

    it('logs during getUserSettingsMetadata', async () => {
      await logManager.getUserSettingsMetadata();
      expect(logManager.log.info).toHaveBeenCalledWith(
        expect.stringContaining('Loading settings metadata')
      );
    });

    it('logs during setSetting', () => {
      logManager.setSetting('llm.model', 'gpt-4');
      expect(logManager.log.info).toHaveBeenCalledWith(
        expect.stringContaining('Set llm.model = gpt-4')
      );
    });

    it('logs during resetToDefaults', () => {
      logManager.resetToDefaults();
      expect(logManager.log.info).toHaveBeenCalledWith(
        expect.stringContaining('Reset to defaults')
      );
    });

    it('logs during dispose', () => {
      logManager.dispose();
      expect(logManager.log.info).toHaveBeenCalledWith(
        expect.stringContaining('Disposed')
      );
    });

    it('logs summary settings update during saveSettings', async () => {
      logManager._collectSummarySettingsFromUi.mockReturnValue({ enabled: true });
      await logManager.saveSettings({ llm: {} });
      expect(logManager.log.info).toHaveBeenCalledWith(
        expect.stringContaining('Updated summary settings before save'),
        expect.any(Object)
      );
    });

    it('logs local sources update during saveSettings', async () => {
      logManager._collectLocalSourcesSettingsFromUi.mockReturnValue({ enabled: true });
      await logManager.saveSettings({ llm: {} });
      expect(logManager.log.info).toHaveBeenCalledWith(
        expect.stringContaining('Updated integrations.local_sources before save')
      );
    });
  });

  // =========================================================================
  // window global export
  // =========================================================================
  describe('window global export', () => {
    it('attaches SettingsManager to window when window is defined', () => {
      jest.isolateModules(() => {
        jest.mock('../../../src/renderer/shared/utils/logger', () => ({
          createRendererLogger: () => ({
            info: jest.fn(), warn: jest.fn(), error: jest.fn(),
            debug: jest.fn(), trace: jest.fn(),
          }),
        }));
        jest.mock('../../../src/core/config/defaults', () => Object.freeze({
          backend: Object.freeze({ baseUrl: 'http://127.0.0.1:8765' }),
          paths: Object.freeze({ skillsDir: './skills', memoryDb: './memory.db' }),
        }));
        const SM = require('../../../src/application/main/modules/settings/SettingsManager');
        expect(window.SettingsManager).toBe(SM);
      });
    });
  });

  // =========================================================================
  // dirty tracking integration
  // =========================================================================
  describe('dirty tracking integration', () => {
    let modal;

    beforeEach(() => {
      modal = document.createElement('div');
      modal.id = 'settings-modal';
      document.body.appendChild(modal);
    });

    afterEach(() => {
      if (document.getElementById('settings-modal')) {
        document.body.removeChild(modal);
      }
    });

    it('sets dirty when input event fires inside settings modal', () => {
      const input = document.createElement('input');
      modal.appendChild(input);

      const event = new Event('input', { bubbles: true });
      input.dispatchEvent(event);

      expect(manager._isDirty).toBe(true);
    });

    it('does not set dirty when input fires outside settings modal', () => {
      const outsideInput = document.createElement('input');
      document.body.appendChild(outsideInput);

      const event = new Event('input', { bubbles: true });
      outsideInput.dispatchEvent(event);

      expect(manager._isDirty).toBe(false);
      document.body.removeChild(outsideInput);
    });

    it('sets dirty when change event fires inside settings modal', () => {
      const select = document.createElement('select');
      modal.appendChild(select);

      const event = new Event('change', { bubbles: true });
      select.dispatchEvent(event);

      expect(manager._isDirty).toBe(true);
    });
  });

  // =========================================================================
  // Binder proxy methods: Service Status
  // =========================================================================
  describe('binder proxies: service status', () => {
    it('loadServicesStatus delegates to _serviceStatusBinder.load', async () => {
      jest.spyOn(manager._serviceStatusBinder, 'load').mockResolvedValue({ ok: true });
      const result = await manager.loadServicesStatus();
      expect(manager._serviceStatusBinder.load).toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
    });
  });

  // =========================================================================
  // Binder proxies: Advanced
  // =========================================================================
  describe('binder proxies: advanced', () => {
    it('_populateAdvancedSettings delegates to _advancedBinder.populate', async () => {
      jest.spyOn(manager._advancedBinder, 'populate').mockResolvedValue();
      await manager._populateAdvancedSettings({ model: 'gpt-4' }, { profile: 'x' });
      expect(manager._advancedBinder.populate).toHaveBeenCalledWith(
        { model: 'gpt-4' }, { profile: 'x' }
      );
      expect(manager._isPopulating).toBe(false);
    });

    it('_displayModelCapabilities delegates to _advancedBinder', async () => {
      jest.spyOn(manager._advancedBinder, 'displayModelCapabilities').mockResolvedValue('caps');
      const result = await manager._displayModelCapabilities('gpt-4');
      expect(manager._advancedBinder.displayModelCapabilities).toHaveBeenCalledWith('gpt-4');
      expect(result).toBe('caps');
    });

    it('_hideModelDetails delegates to _advancedBinder', () => {
      jest.spyOn(manager._advancedBinder, 'hideModelDetails').mockImplementation(() => {});
      manager._hideModelDetails();
      expect(manager._advancedBinder.hideModelDetails).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Binder proxies: Vision
  // =========================================================================
  describe('binder proxies: vision', () => {
    it('_populateVisionSettings delegates to _visionBinder.populate', async () => {
      jest.spyOn(manager._visionBinder, 'populate').mockResolvedValue();
      await manager._populateVisionSettings({ engine: 'tesseract' });
      expect(manager._visionBinder.populate).toHaveBeenCalled();
      expect(manager._isPopulating).toBe(false);
    });

    it('_populateVisionSettings returns early and warns when no document', async () => {
      manager.enableLogging = true;
      await manager._populateVisionSettings(null);
      expect(manager.log.warn).toHaveBeenCalledWith(
        '[SettingsManager] No vision_document in settings'
      );
    });

    it('_populateVisionSettings returns early without logging when not enabled', async () => {
      manager.enableLogging = false;
      await manager._populateVisionSettings(null);
      expect(manager.log.warn).not.toHaveBeenCalled();
    });

    it('_checkPrimaryModelVisionSupport delegates to _visionBinder', async () => {
      jest.spyOn(manager._visionBinder, 'checkPrimaryModelVisionSupport').mockResolvedValue(true);
      manager.currentSettings = { llm: {} };
      const result = await manager._checkPrimaryModelVisionSupport();
      expect(result).toBe(true);
    });

    it('_collectVisionSettings delegates to _visionBinder.collect', () => {
      manager.currentSettings = { vision_document: { engine: 'tesseract' } };
      jest.spyOn(manager._visionBinder, 'collect').mockReturnValue({ engine: 'tesseract' });
      const result = manager._collectVisionSettings();
      expect(manager._visionBinder.collect).toHaveBeenCalledWith({ engine: 'tesseract' });
      expect(result).toEqual({ engine: 'tesseract' });
    });

    it('_collectVisionSettings throws on missing vision_document', () => {
      manager.currentSettings = {};
      expect(() => manager._collectVisionSettings()).toThrow('CONTRACT VIOLATION');
    });
  });

  // =========================================================================
  // Binder proxies: Service Providers
  // =========================================================================
  describe('binder proxies: service providers', () => {
    it('_collectServiceProviderSettings delegates', () => {
      jest.spyOn(manager._serviceProviderBinder, 'collect').mockReturnValue({ p: 1 });
      const result = manager._collectServiceProviderSettings();
      expect(result).toEqual({ p: 1 });
    });

    it('_populateServiceProviderSettings delegates', () => {
      jest.spyOn(manager._serviceProviderBinder, 'populate').mockImplementation(() => {});
      manager._populateServiceProviderSettings({ openai: {} });
      expect(manager._serviceProviderBinder.populate).toHaveBeenCalledWith({ openai: {} });
    });

    it('_attachServiceModelInfoListeners delegates', () => {
      jest.spyOn(manager._serviceProviderBinder, 'attachModelInfoListeners').mockImplementation(() => {});
      const uiMap = {};
      manager._attachServiceModelInfoListeners(uiMap);
      expect(manager._serviceProviderBinder.attachModelInfoListeners).toHaveBeenCalledWith(uiMap);
    });

    it('_displayServiceModelInfo delegates', async () => {
      jest.spyOn(manager._serviceProviderBinder, 'displayServiceModelInfo').mockResolvedValue();
      await manager._displayServiceModelInfo('openai');
      expect(manager._serviceProviderBinder.displayServiceModelInfo).toHaveBeenCalledWith('openai');
    });
  });

  // =========================================================================
  // Binder proxies: Local Sources
  // =========================================================================
  describe('binder proxies: local sources', () => {
    it('_populateLocalSourcesSettings delegates', () => {
      jest.spyOn(manager._localSourcesBinder, 'populate').mockImplementation(() => {});
      manager._populateLocalSourcesSettings({ paths: ['/a'] });
      expect(manager._localSourcesBinder.populate).toHaveBeenCalledWith({ paths: ['/a'] });
    });

    it('_collectLocalSourcesSettingsFromUi delegates', () => {
      jest.spyOn(manager._localSourcesBinder, 'collect').mockReturnValue({ paths: [] });
      const result = manager._collectLocalSourcesSettingsFromUi();
      expect(result).toEqual({ paths: [] });
    });

    it('_setLocalSourcesText sets textContent on existing element', () => {
      const el = document.createElement('span');
      el.id = 'ls-status';
      document.body.appendChild(el);
      manager._setLocalSourcesText('ls-status', 'Ready');
      expect(el.textContent).toBe('Ready');
      el.remove();
    });

    it('_setLocalSourcesText sets empty string for falsy text', () => {
      const el = document.createElement('span');
      el.id = 'ls-status2';
      document.body.appendChild(el);
      manager._setLocalSourcesText('ls-status2', null);
      expect(el.textContent).toBe('');
      el.remove();
    });

    it('_setLocalSourcesText does nothing for missing element', () => {
      manager._setLocalSourcesText('nonexistent-id', 'text');
      // No error thrown
    });

    it('_lockLocalSourcesControls delegates', () => {
      jest.spyOn(manager._localSourcesBinder, 'lockControls').mockImplementation(() => {});
      manager._lockLocalSourcesControls('reason');
      expect(manager._localSourcesBinder.lockControls).toHaveBeenCalledWith('reason');
    });

    it('_attachLocalSourcesListenersOnce delegates', () => {
      jest.spyOn(manager._localSourcesBinder, 'attachListenersOnce').mockImplementation(() => {});
      manager._attachLocalSourcesListenersOnce();
      expect(manager._localSourcesBinder.attachListenersOnce).toHaveBeenCalled();
    });

    it('_refreshLocalSourcesStatus delegates', async () => {
      jest.spyOn(manager._localSourcesBinder, 'refreshStatus').mockResolvedValue('ok');
      const result = await manager._refreshLocalSourcesStatus();
      expect(result).toBe('ok');
    });

    it('_saveLocalSourcesPartial delegates', async () => {
      jest.spyOn(manager._localSourcesBinder, 'savePartial').mockResolvedValue();
      await manager._saveLocalSourcesPartial({ paths: [] });
      expect(manager._localSourcesBinder.savePartial).toHaveBeenCalledWith({ paths: [] });
    });

  });

  // =========================================================================
  // Binder proxies: Handsfree
  // =========================================================================
  describe('binder proxies: handsfree', () => {
    it('_populateHandsfreeSettings delegates and resets _isPopulating', async () => {
      jest.spyOn(manager._handsfreeBinder, 'populate').mockImplementation(() => {});
      await manager._populateHandsfreeSettings({ tts: 'on' });
      expect(manager._handsfreeBinder.populate).toHaveBeenCalledWith({ tts: 'on' });
      expect(manager._isPopulating).toBe(false);
    });

    it('_populateHandsfreeSettings returns early and warns when null with logging', async () => {
      manager.enableLogging = true;
      await manager._populateHandsfreeSettings(null);
      expect(manager.log.warn).toHaveBeenCalledWith(
        '[SettingsManager] No handsfree settings provided'
      );
    });

    it('_populateHandsfreeSettings returns early silently when null without logging', async () => {
      manager.enableLogging = false;
      await manager._populateHandsfreeSettings(null);
      expect(manager.log.warn).not.toHaveBeenCalled();
    });

    it('_updateTtsVoiceVisibility delegates', () => {
      jest.spyOn(manager._handsfreeBinder, 'updateTtsVoiceVisibility').mockImplementation(() => {});
      manager._updateTtsVoiceVisibility('elevenlabs');
      expect(manager._handsfreeBinder.updateTtsVoiceVisibility).toHaveBeenCalledWith('elevenlabs');
    });

    it('_updateProactiveTtsVisibility delegates', () => {
      jest.spyOn(manager._handsfreeBinder, 'updateProactiveTtsVisibility').mockImplementation(() => {});
      manager._updateProactiveTtsVisibility(true);
      expect(manager._handsfreeBinder.updateProactiveTtsVisibility).toHaveBeenCalledWith(true);
    });

    it('_autoSetLanguageFromVoice delegates', () => {
      jest.spyOn(manager._handsfreeBinder, 'autoSetLanguageFromVoice').mockImplementation(() => {});
      manager._autoSetLanguageFromVoice('en-US-1');
      expect(manager._handsfreeBinder.autoSetLanguageFromVoice).toHaveBeenCalledWith('en-US-1');
    });

    it('initVoicePreviewButtons delegates', () => {
      jest.spyOn(manager._handsfreeBinder, 'initVoicePreviewButtons').mockImplementation(() => {});
      manager.initVoicePreviewButtons();
      expect(manager._handsfreeBinder.initVoicePreviewButtons).toHaveBeenCalled();
    });

    it('_wireRangeSliderLiveUpdates delegates', () => {
      jest.spyOn(manager._handsfreeBinder, 'wireRangeSliderLiveUpdates').mockImplementation(() => {});
      manager._wireRangeSliderLiveUpdates();
      expect(manager._handsfreeBinder.wireRangeSliderLiveUpdates).toHaveBeenCalled();
    });

    it('_previewVoice delegates', async () => {
      jest.spyOn(manager._handsfreeBinder, 'previewVoice').mockResolvedValue('audio');
      const result = await manager._previewVoice('elevenlabs', 'voice1', {});
      expect(result).toBe('audio');
    });

    it('_collectHandsfreeSettings delegates with baseline', () => {
      manager.currentSettings = { handsfree: { tts: 'on' } };
      jest.spyOn(manager._handsfreeBinder, 'collect').mockReturnValue({ tts: 'off' });
      const result = manager._collectHandsfreeSettings();
      expect(manager._handsfreeBinder.collect).toHaveBeenCalledWith({ tts: 'on' });
      expect(result).toEqual({ tts: 'off' });
    });

    it('_collectHandsfreeSettings throws on missing handsfree settings', () => {
      manager.currentSettings = {};
      expect(() => manager._collectHandsfreeSettings()).toThrow('CONTRACT VIOLATION');
    });
  });

  // =========================================================================
  // Binder proxies: Simple (database, memory, monitoring, UI, embedding)
  // =========================================================================
  describe('binder proxies: simple', () => {
    it('_populateUiSettings delegates and resets _isPopulating', () => {
      jest.spyOn(manager._simpleBinder, 'populateUi').mockImplementation(() => {});
      manager._populateUiSettings({ effects_mode: 'reduced' });
      expect(manager._simpleBinder.populateUi).toHaveBeenCalledWith({ effects_mode: 'reduced' });
      expect(manager._isPopulating).toBe(false);
    });

    it('_populateDatabaseSettings delegates', () => {
      jest.spyOn(manager._simpleBinder, 'populateDatabase').mockImplementation(() => {});
      manager._populateDatabaseSettings({ pool_size: 5 });
      expect(manager._simpleBinder.populateDatabase).toHaveBeenCalledWith({ pool_size: 5 });
      expect(manager._isPopulating).toBe(false);
    });

    it('_populateMemorySettings delegates', () => {
      jest.spyOn(manager._simpleBinder, 'populateMemory').mockImplementation(() => {});
      manager._populateMemorySettings({ enabled: true });
      expect(manager._simpleBinder.populateMemory).toHaveBeenCalledWith({ enabled: true });
      expect(manager._isPopulating).toBe(false);
    });

    it('_populateMonitoringSettings delegates', () => {
      jest.spyOn(manager._simpleBinder, 'populateMonitoring').mockImplementation(() => {});
      manager._populateMonitoringSettings({ log_level: 'debug' });
      expect(manager._simpleBinder.populateMonitoring).toHaveBeenCalledWith({ log_level: 'debug' });
      expect(manager._isPopulating).toBe(false);
    });

    it('_populateEmbeddingModelSettings delegates', async () => {
      jest.spyOn(manager._simpleBinder, 'populateEmbeddingModel').mockResolvedValue();
      await manager._populateEmbeddingModelSettings({ model: 'ada' });
      expect(manager._simpleBinder.populateEmbeddingModel).toHaveBeenCalledWith({ model: 'ada' });
      expect(manager._isPopulating).toBe(false);
    });

    it('_collectUiSettings delegates', () => {
      jest.spyOn(manager._simpleBinder, 'collectUiSettings').mockReturnValue({ effects: 'full' });
      const result = manager._collectUiSettings();
      expect(result).toEqual({ effects: 'full' });
    });
  });

  // =========================================================================
  // Binder proxies: Summary
  // =========================================================================
  describe('binder proxies: summary', () => {
    it('_populateSummarySettings delegates and resets _isPopulating', () => {
      jest.spyOn(manager._summaryBinder, 'populate').mockImplementation(() => {});
      manager._populateSummarySettings({ auto: true });
      expect(manager._summaryBinder.populate).toHaveBeenCalledWith({ auto: true });
      expect(manager._isPopulating).toBe(false);
    });

    it('_populateSummarySettings catches populate error', () => {
      jest.spyOn(manager._summaryBinder, 'populate').mockImplementation(() => {
        throw new Error('summary fail');
      });
      manager._populateSummarySettings({ auto: true });
      expect(manager.log.error).toHaveBeenCalledWith(
        '[SettingsManager] Failed to populate summary settings:',
        expect.any(Error)
      );
      expect(manager._isPopulating).toBe(false);
    });

    it('_attachSummaryListenersOnce delegates', () => {
      jest.spyOn(manager._summaryBinder, 'attachListenersOnce').mockImplementation(() => {});
      manager._attachSummaryListenersOnce();
      expect(manager._summaryBinder.attachListenersOnce).toHaveBeenCalled();
    });

    it('_collectSummarySettingsFromUi delegates with baseline', () => {
      manager.currentSettings = {
        summary_service: { model: 'gpt-4' },
        summary: { auto: true },
      };
      jest.spyOn(manager._summaryBinder, 'collect').mockReturnValue({ collected: true });
      const result = manager._collectSummarySettingsFromUi();
      expect(manager._summaryBinder.collect).toHaveBeenCalled();
      expect(result).toEqual({ collected: true });
    });

    it('_collectSummarySettingsFromUi throws on missing summary_service', () => {
      manager.currentSettings = {};
      expect(() => manager._collectSummarySettingsFromUi()).toThrow('CONTRACT VIOLATION');
    });

    it('_collectSummarySettingsFromUi uses empty object when summary is missing', () => {
      manager.currentSettings = { summary_service: { model: 'gpt-4' } };
      jest.spyOn(manager._summaryBinder, 'collect').mockReturnValue({});
      manager._collectSummarySettingsFromUi();
      // Third argument should be the full currentSettings
      expect(manager._summaryBinder.collect).toHaveBeenCalledWith(
        { model: 'gpt-4' },
        {},
        manager.currentSettings
      );
    });
  });

  // =========================================================================
  // _applyUiSettings
  // =========================================================================
  describe('_applyUiSettings', () => {
    it('sets data-effects to reduced when effects_mode is reduced', () => {
      manager._applyUiSettings({ effects_mode: 'reduced' });
      expect(document.documentElement.getAttribute('data-effects')).toBe('reduced');
    });

    it('sets data-effects to full by default', () => {
      manager._applyUiSettings({});
      expect(document.documentElement.getAttribute('data-effects')).toBe('full');
    });
  });

  // =========================================================================
  // checkSettingsHealth enableLogging error
  // =========================================================================
  describe('checkSettingsHealth', () => {
    it('logs error when health check fails and logging is enabled', async () => {
      manager.enableLogging = true;
      endpoint.getSettingsHealth.mockRejectedValueOnce(new Error('health fail'));
      const result = await manager.checkSettingsHealth();
      expect(result.status).toBe('unhealthy');
      expect(manager.log.error).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Full lifecycle
  // =========================================================================
  describe('full lifecycle', () => {
    it('constructor -> operations -> dispose cycle completes cleanly', () => {
      const m = new SettingsManager({ endpoint, eventBus });

      m.setSetting('llm.model', 'gpt-4');
      expect(m.getSetting('llm.model')).toBe('gpt-4');
      expect(m.getStats().hasSettings).toBe(true);

      const exported = m.exportSettings();
      expect(typeof exported).toBe('string');

      m.resetToDefaults();

      const imported = m.importSettings(exported);
      expect(imported.success).toBe(true);
      expect(m.getSetting('llm.model')).toBe('gpt-4');

      m.dispose();
      expect(m.endpoint).toBeNull();
      expect(m.eventBus).toBeNull();
    });
  });

  // =========================================================================
  // saveSettings DOM collection branches
  // =========================================================================

  describe('saveSettings() DOM element collection', () => {
    let manager, endpoint, eventBus;

    beforeEach(() => {
      document.body.innerHTML = '';
      endpoint = createMockEndpoint();
      eventBus = createMockEventBus();
      installCryptoMock();
      const SettingsManager = require('../../../src/application/main/modules/settings/SettingsManager');
      manager = new SettingsManager({ endpoint, eventBus });
      jest.spyOn(manager, '_applyUiSettings').mockImplementation(() => {});
      jest.spyOn(manager, '_setDirty').mockImplementation(() => {});
      jest.spyOn(manager, '_collectVisionSettings').mockReturnValue({ ocr_engine: 'tesseract' });
      jest.spyOn(manager, '_collectHandsfreeSettings').mockReturnValue({ enabled: true });
      jest.spyOn(manager, '_collectUiSettings').mockReturnValue({ reduced_effects: false });
      jest.spyOn(manager, '_collectSummarySettingsFromUi').mockReturnValue(null);
      jest.spyOn(manager, '_collectLocalSourcesSettingsFromUi').mockReturnValue(null);
      jest.spyOn(manager, '_collectServiceProviderSettings').mockReturnValue(null);
    });

    afterEach(() => {
      manager.dispose();
      document.body.innerHTML = '';
    });

    function addInput(id, value) {
      const el = document.createElement('input');
      el.id = id;
      el.value = value;
      document.body.appendChild(el);
      return el;
    }

    function addCheckbox(id, checked) {
      const el = document.createElement('input');
      el.id = id;
      el.type = 'checkbox';
      el.checked = checked;
      document.body.appendChild(el);
      return el;
    }

    it('collects LLM settings from DOM when elements exist', async () => {
      addInput('llm-model', 'claude-3');
      addInput('llm-provider', 'anthropic');
      addInput('llm-api-base', 'https://api.anthropic.com');
      addInput('llm-temperature-adv', '0.7');
      addInput('llm-max-tokens-adv', '4096');
      addInput('llm-context-window-adv', '128000');
      addCheckbox('llm-supports-vision', true);

      const settings = { llm: { model: 'old' } };
      await manager.saveSettings(settings);

      const saved = endpoint.setSettings.mock.calls[0][0];
      expect(saved.llm.model).toBe('claude-3');
      expect(saved.llm.provider).toBe('anthropic');
      expect(saved.llm.api_base).toBe('https://api.anthropic.com');
      expect(saved.llm.temperature).toBe(0.7);
      expect(saved.llm.max_tokens).toBe(4096);
      expect(saved.llm.context_window).toBe(128000);
      expect(saved.llm.supports_vision).toBe(true);
    });

    it('collects interpreter settings from DOM', async () => {
      addInput('oi-profile', 'coder');
      addInput('interpreter-system-message', 'You are helpful');

      const settings = { llm: {}, interpreter: {} };
      await manager.saveSettings(settings);

      const saved = endpoint.setSettings.mock.calls[0][0];
      expect(saved.interpreter.profile).toBe('coder');
      expect(saved.interpreter.system_message).toBe('You are helpful');
    });

    it('collects file indexing settings from DOM', async () => {
      addCheckbox('file-indexing-enabled', true);

      const settings = { llm: {} };
      await manager.saveSettings(settings);

      const saved = endpoint.setSettings.mock.calls[0][0];
      expect(saved.integrations.file_indexing.enabled).toBe(true);
    });

    it('collects vision settings from DOM when elements exist', async () => {
      addInput('ocr-engine', 'tesseract');

      const settings = { llm: {}, vision_document: { mode: 'auto' } };
      await manager.saveSettings(settings);

      const saved = endpoint.setSettings.mock.calls[0][0];
      expect(saved.vision_document).toEqual(expect.objectContaining({ ocr_engine: 'tesseract' }));
    });

    it('collects handsfree settings from DOM when elements exist', async () => {
      addCheckbox('handsfree-enabled', true);

      const settings = { llm: {} };
      await manager.saveSettings(settings);

      const saved = endpoint.setSettings.mock.calls[0][0];
      expect(saved.handsfree).toEqual(expect.objectContaining({ enabled: true }));
    });

    it('collects database settings from DOM', async () => {
      addInput('db-pool-size', '10');
      addInput('db-max-overflow', '5');
      addInput('db-pool-timeout', '30');
      addCheckbox('db-echo-sql', false);

      const settings = { llm: {}, database: {} };
      await manager.saveSettings(settings);

      const saved = endpoint.setSettings.mock.calls[0][0];
      expect(saved.database.pool_size).toBe(10);
      expect(saved.database.max_overflow).toBe(5);
      expect(saved.database.pool_timeout).toBe(30);
      expect(saved.database.echo_sql).toBe(false);
    });

    it('collects memory settings from DOM', async () => {
      addCheckbox('memory-enabled', true);
      addInput('memory-type', 'vector');
      addInput('memory-embedder', 'openai');
      addInput('memory-top-k', '5');

      const settings = { llm: {}, memory: {} };
      await manager.saveSettings(settings);

      const saved = endpoint.setSettings.mock.calls[0][0];
      expect(saved.memory.enabled).toBe(true);
      expect(saved.memory.type).toBe('vector');
      expect(saved.memory.embedder).toBe('openai');
      expect(saved.memory.top_k).toBe(5);
    });

    it('collects monitoring settings from DOM', async () => {
      addInput('monitoring-log-level', 'debug');
      addInput('monitoring-log-format', 'json');
      addCheckbox('monitoring-metrics-enabled', true);
      addCheckbox('monitoring-tracing-enabled', false);
      addInput('monitoring-health-check-interval', '60');

      const settings = { llm: {}, monitoring: {} };
      await manager.saveSettings(settings);

      const saved = endpoint.setSettings.mock.calls[0][0];
      expect(saved.monitoring.log_level).toBe('debug');
      expect(saved.monitoring.log_format).toBe('json');
      expect(saved.monitoring.metrics_enabled).toBe(true);
      expect(saved.monitoring.tracing_enabled).toBe(false);
      expect(saved.monitoring.health_check_interval).toBe(60);
    });

    it('collects UI settings from DOM when element exists', async () => {
      addCheckbox('ui-reduced-effects', false);

      const settings = { llm: {}, ui: { theme: 'dark' } };
      await manager.saveSettings(settings);

      const saved = endpoint.setSettings.mock.calls[0][0];
      expect(saved.ui).toEqual(expect.objectContaining({ reduced_effects: false }));
    });

    it('saves LLM provider config when llmProviderSettings exists', async () => {
      const mockSave = jest.fn().mockResolvedValue(true);
      manager.llmProviderSettings = { saveConfiguration: mockSave };

      try {
        await manager.saveSettings({ llm: {} });
        expect(mockSave).toHaveBeenCalled();
      } finally {
        manager.llmProviderSettings = null;
      }
    });

    it('handles LLM provider config save failure gracefully', async () => {
      const mockSave = jest.fn().mockRejectedValue(new Error('save error'));
      manager.llmProviderSettings = { saveConfiguration: mockSave };

      try {
        await manager.saveSettings({ llm: {} });
        // Should not throw - error is caught internally
        expect(mockSave).toHaveBeenCalled();
      } finally {
        manager.llmProviderSettings = null;
      }
    });
  });
});
