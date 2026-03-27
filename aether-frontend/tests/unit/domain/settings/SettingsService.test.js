'use strict';

/**
 * SettingsService Unit Tests
 * 
 * Comprehensive tests for all 14 public methods:
 * constructor, loadSettings, saveSettings, getSettings, getSetting, setSetting,
 * resetToDefaults, getDefaults, validateSettings, exportSettings, importSettings,
 * getLastSource, getStatistics, cleanup
 * 
 * Tests verify: DI, event emissions, error paths, state transitions, clone isolation,
 * validation gating, import/export round-trips, cleanup lifecycle.
 */

const { SettingsService } = require('../../../../src/domain/settings/services/SettingsService');
const { Settings } = require('../../../../src/domain/settings/models/Settings');

// The validator is used internally by SettingsService via:
// SettingsValidator.validateSettings(data) inside validateSettings()
// We don't mock it -- we test real validation behavior.

function createMockRepository(settingsData) {
  const data = settingsData || {
    interpreter: { safe_mode: 'auto' },
    llm: { provider: 'openai', model: 'gpt-4o', context_window: 128000, max_tokens: 4096 },
    voice: { mic_button_enabled: true, stt: { sample_rate_hz: 16000 } },
    memory: { type: 'supabase' },
    security: { bind_host: '127.0.0.1' },
  };

  return {
    loadSettings: jest.fn().mockResolvedValue({
      settings: new Settings(data),
      source: 'backend',
    }),
    saveSettings: jest.fn().mockResolvedValue({ success: true, source: 'backend' }),
  };
}

function createMockEventBus() {
  return { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
}

describe('SettingsService', () => {
  // -----------------------------------------------------------
  // constructor
  // -----------------------------------------------------------
  describe('constructor', () => {
    it('initializes with default settings when no dependencies', () => {
      const svc = new SettingsService();
      expect(svc.repository).toBeNull();
      expect(svc.eventBus).toBeNull();
      expect(svc._lastSource).toBe('defaults');

      const settings = svc.getSettings();
      expect(settings).toBeInstanceOf(Settings);
      // Defaults must have all 5 categories
      const json = settings.toJSON();
      expect(json).toHaveProperty('interpreter');
      expect(json).toHaveProperty('llm');
      expect(json).toHaveProperty('voice');
      expect(json).toHaveProperty('memory');
      expect(json).toHaveProperty('security');
    });

    it('accepts injected dependencies', () => {
      const repo = createMockRepository();
      const bus = createMockEventBus();
      const svc = new SettingsService({ repository: repo, eventBus: bus });
      expect(svc.repository).toBe(repo);
      expect(svc.eventBus).toBe(bus);
    });
  });

  // -----------------------------------------------------------
  // loadSettings()
  // -----------------------------------------------------------
  describe('loadSettings()', () => {
    it('throws when repository not configured', async () => {
      const svc = new SettingsService();
      await expect(svc.loadSettings()).rejects.toThrow('Repository not configured');
    });

    it('loads from repository and updates internal state', async () => {
      const repo = createMockRepository();
      const svc = new SettingsService({ repository: repo });

      const result = await svc.loadSettings();
      expect(repo.loadSettings).toHaveBeenCalledTimes(1);
      expect(result.source).toBe('backend');
      expect(result.settings).toBeInstanceOf(Settings);
      // After load, lastSource should be backend
      expect(svc.getLastSource()).toBe('backend');
    });

    it('merges loaded settings with defaults (preserves missing fields)', async () => {
      // Repo returns partial settings -- mergeWithDefaults fills gaps
      const repo = createMockRepository({ llm: { model: 'custom-model' } });
      const svc = new SettingsService({ repository: repo });

      const result = await svc.loadSettings();
      const json = result.settings.toJSON();
      // Custom field preserved
      expect(json.llm.model).toBe('custom-model');
      // Default fields filled in
      expect(json.llm.provider).toBe('aether_inference');
      expect(json.interpreter).toBeDefined();
      expect(json.voice).toBeDefined();
    });

    it('emits settings:loaded event with eventBus', async () => {
      const repo = createMockRepository();
      const bus = createMockEventBus();
      const svc = new SettingsService({ repository: repo, eventBus: bus });

      await svc.loadSettings();
      expect(bus.emit).toHaveBeenCalledWith('settings:loaded', expect.objectContaining({
        source: 'backend',
        settings: expect.any(Object),
        timestamp: expect.any(Number),
      }));
    });

    it('does not emit event when no eventBus', async () => {
      const repo = createMockRepository();
      const svc = new SettingsService({ repository: repo });

      // Should not throw when eventBus is null
      await expect(svc.loadSettings()).resolves.toBeDefined();
    });

    it('resets to defaults on error and re-throws', async () => {
      const repo = createMockRepository();
      repo.loadSettings.mockRejectedValue(new Error('Backend unreachable'));
      const svc = new SettingsService({ repository: repo });

      // Verify it throws
      await expect(svc.loadSettings()).rejects.toThrow('Backend unreachable');

      // Verify state was reset to defaults
      expect(svc.getLastSource()).toBe('defaults');
      const settings = svc.getSettings();
      expect(settings.llm.provider).toBe('aether_inference'); // default
    });
  });

  // -----------------------------------------------------------
  // saveSettings()
  // -----------------------------------------------------------
  describe('saveSettings()', () => {
    it('throws when repository not configured', async () => {
      const svc = new SettingsService();
      await expect(svc.saveSettings({})).rejects.toThrow('Repository not configured');
    });

    it('saves a Settings instance', async () => {
      const repo = createMockRepository();
      const svc = new SettingsService({ repository: repo });

      const settingsInstance = Settings.fromJSON({
        interpreter: { safe_mode: 'auto' },
        llm: { provider: 'openai', model: 'gpt-4o', context_window: 128000, max_tokens: 4096 },
      });

      const result = await svc.saveSettings(settingsInstance);
      expect(result.success).toBe(true);
      expect(result.source).toBe('backend');
      expect(repo.saveSettings).toHaveBeenCalledTimes(1);
      // Verify it was called with a Settings instance
      const savedArg = repo.saveSettings.mock.calls[0][0];
      expect(savedArg).toBeInstanceOf(Settings);
    });

    it('converts plain object to Settings before saving', async () => {
      const repo = createMockRepository();
      const svc = new SettingsService({ repository: repo });

      const plainObj = {
        interpreter: { safe_mode: 'off' },
        llm: { provider: 'openai', model: 'gpt-4', context_window: 8000, max_tokens: 4000 },
        memory: { type: 'supabase' },
      };

      const result = await svc.saveSettings(plainObj);
      expect(result.success).toBe(true);
      // The saved argument should be a Settings instance (converted from plain)
      const savedArg = repo.saveSettings.mock.calls[0][0];
      expect(savedArg).toBeInstanceOf(Settings);
    });

    it('validates before saving - rejects invalid settings', async () => {
      const repo = createMockRepository();
      const svc = new SettingsService({ repository: repo });

      // context_window 500 is below minimum 1000
      const invalid = {
        llm: { provider: 'x', model: 'y', context_window: 500 },
      };

      await expect(svc.saveSettings(invalid)).rejects.toThrow('Failed to save settings');
      // Repository should NOT have been called -- validation blocks it
      expect(repo.saveSettings).not.toHaveBeenCalled();
    });

    it('rejects invalid safe_mode before save reaches repo', async () => {
      const repo = createMockRepository();
      const svc = new SettingsService({ repository: repo });

      await expect(svc.saveSettings({
        interpreter: { safe_mode: 'YOLO' },
      })).rejects.toThrow();
      expect(repo.saveSettings).not.toHaveBeenCalled();
    });

    it('rejects malicious api_base URL before save', async () => {
      const repo = createMockRepository();
      const svc = new SettingsService({ repository: repo });

      await expect(svc.saveSettings({
        llm: { provider: 'x', model: 'y', api_base: 'javascript:alert(1)' },
      })).rejects.toThrow();
      expect(repo.saveSettings).not.toHaveBeenCalled();
    });

    it('updates internal state after successful save', async () => {
      const repo = createMockRepository();
      const svc = new SettingsService({ repository: repo });

      const settings = Settings.fromJSON({
        llm: { provider: 'anthropic', model: 'claude-3', context_window: 200000, max_tokens: 8192 },
      });

      await svc.saveSettings(settings);

      // Verify internal state was updated
      const current = svc.getSettings();
      expect(current.llm.provider).toBe('anthropic');
      expect(svc.getLastSource()).toBe('backend');
    });

    it('stores a clone -- mutations to original do not affect stored', async () => {
      const repo = createMockRepository();
      const svc = new SettingsService({ repository: repo });

      const settings = Settings.fromJSON({
        llm: { provider: 'openai', model: 'gpt-4', context_window: 8000, max_tokens: 4000 },
      });

      await svc.saveSettings(settings);

      // Mutate the original
      settings.llm.provider = 'MUTATED';

      // Stored copy should be unaffected
      expect(svc.getSettings().llm.provider).toBe('openai');
    });

    it('emits settings:saved event', async () => {
      const repo = createMockRepository();
      const bus = createMockEventBus();
      const svc = new SettingsService({ repository: repo, eventBus: bus });

      await svc.saveSettings(Settings.fromJSON({
        llm: { provider: 'openai', model: 'gpt-4', context_window: 8000, max_tokens: 4000 },
      }));

      expect(bus.emit).toHaveBeenCalledWith('settings:saved', expect.objectContaining({
        source: 'backend',
        settings: expect.any(Object),
        timestamp: expect.any(Number),
      }));
    });

    it('wraps repository errors', async () => {
      const repo = createMockRepository();
      repo.saveSettings.mockRejectedValue(new Error('disk full'));
      const svc = new SettingsService({ repository: repo });

      await expect(svc.saveSettings(Settings.fromJSON({
        llm: { provider: 'openai', model: 'gpt-4', context_window: 8000, max_tokens: 4000 },
      }))).rejects.toThrow('Failed to save settings: disk full');
    });
  });

  // -----------------------------------------------------------
  // getSettings()
  // -----------------------------------------------------------
  describe('getSettings()', () => {
    it('returns a Settings instance', () => {
      const svc = new SettingsService();
      expect(svc.getSettings()).toBeInstanceOf(Settings);
    });

    it('returns a clone -- mutations do not affect service state', () => {
      const svc = new SettingsService();
      const s1 = svc.getSettings();
      s1.llm.provider = 'MUTATED';

      const s2 = svc.getSettings();
      expect(s2.llm.provider).not.toBe('MUTATED');
      expect(s2.llm.provider).toBe('aether_inference'); // default
    });
  });

  // -----------------------------------------------------------
  // getSetting(path)
  // -----------------------------------------------------------
  describe('getSetting()', () => {
    it('retrieves a top-level category', () => {
      const svc = new SettingsService();
      const llm = svc.getSetting('llm');
      expect(llm).toBeDefined();
      expect(llm.provider).toBe('aether_inference');
    });

    it('retrieves a nested value via dot-path', () => {
      const svc = new SettingsService();
      expect(svc.getSetting('llm.provider')).toBe('aether_inference');
      expect(svc.getSetting('voice.stt.provider')).toBe('dsm');
    });

    it('returns undefined for non-existent path', () => {
      const svc = new SettingsService();
      expect(svc.getSetting('nonexistent')).toBeUndefined();
      expect(svc.getSetting('llm.nonexistent')).toBeUndefined();
      expect(svc.getSetting('a.b.c.d')).toBeUndefined();
    });
  });

  // -----------------------------------------------------------
  // setSetting(path, value)
  // -----------------------------------------------------------
  describe('setSetting()', () => {
    it('sets a nested value', () => {
      const svc = new SettingsService();
      svc.setSetting('llm.model', 'changed-model');
      expect(svc.getSetting('llm.model')).toBe('changed-model');
    });

    it('creates intermediate objects for deep paths', () => {
      const svc = new SettingsService();
      svc.setSetting('custom.deep.path', 'value');
      expect(svc.getSetting('custom.deep.path')).toBe('value');
    });

    it('emits settings:updated event with path and value', () => {
      const bus = createMockEventBus();
      const svc = new SettingsService({ eventBus: bus });

      svc.setSetting('llm.model', 'new-model');
      expect(bus.emit).toHaveBeenCalledWith('settings:updated', expect.objectContaining({
        path: 'llm.model',
        value: 'new-model',
        timestamp: expect.any(Number),
      }));
    });

    it('does not emit when no eventBus', () => {
      const svc = new SettingsService();
      // Should not throw
      expect(() => svc.setSetting('llm.model', 'x')).not.toThrow();
    });

    it('allows setting values without validation (design note: validation is at save-time)', () => {
      // This documents current behavior: setSetting does NOT validate.
      // Invalid values are caught only when saveSettings() is called.
      const svc = new SettingsService();
      svc.setSetting('llm.temperature', 999); // way above valid range
      expect(svc.getSetting('llm.temperature')).toBe(999);
    });
  });

  // -----------------------------------------------------------
  // resetToDefaults()
  // -----------------------------------------------------------
  describe('resetToDefaults()', () => {
    it('resets all settings to defaults', () => {
      const svc = new SettingsService();
      // Modify state
      svc.setSetting('llm.model', 'custom');
      expect(svc.getSetting('llm.model')).toBe('custom');

      const result = svc.resetToDefaults();
      expect(result).toBeInstanceOf(Settings);
      expect(result.llm.provider).toBe('aether_inference');
      expect(svc.getSetting('llm.model')).not.toBe('custom');
    });

    it('resets lastSource to defaults', () => {
      const repo = createMockRepository();
      const svc = new SettingsService({ repository: repo });
      // Simulate a load
      svc._lastSource = 'backend';

      svc.resetToDefaults();
      expect(svc.getLastSource()).toBe('defaults');
    });

    it('emits settings:reset event', () => {
      const bus = createMockEventBus();
      const svc = new SettingsService({ eventBus: bus });

      svc.resetToDefaults();
      expect(bus.emit).toHaveBeenCalledWith('settings:reset', expect.objectContaining({
        settings: expect.any(Object),
        timestamp: expect.any(Number),
      }));
    });

    it('returns a clone -- mutations do not affect service', () => {
      const svc = new SettingsService();
      const result = svc.resetToDefaults();
      result.llm.provider = 'MUTATED';
      expect(svc.getSetting('llm.provider')).toBe('aether_inference');
    });
  });

  // -----------------------------------------------------------
  // getDefaults()
  // -----------------------------------------------------------
  describe('getDefaults()', () => {
    it('returns a fresh default Settings instance', () => {
      const svc = new SettingsService();
      const defaults = svc.getDefaults();
      expect(defaults).toBeInstanceOf(Settings);
      expect(defaults.llm.provider).toBe('aether_inference');
    });

    it('returns independent instances each call', () => {
      const svc = new SettingsService();
      const d1 = svc.getDefaults();
      const d2 = svc.getDefaults();
      d1.llm.provider = 'MUTATED';
      expect(d2.llm.provider).toBe('aether_inference');
    });
  });

  // -----------------------------------------------------------
  // validateSettings()
  // -----------------------------------------------------------
  describe('validateSettings()', () => {
    let svc;
    beforeEach(() => {
      svc = new SettingsService();
    });

    it('throws on invalid settings by default (throwOnError: true)', () => {
      expect(() => svc.validateSettings({
        interpreter: { safe_mode: 'INVALID' },
      })).toThrow('Invalid settings');
    });

    it('returns validation result without throwing when throwOnError: false', () => {
      const result = svc.validateSettings({
        interpreter: { safe_mode: 'INVALID' },
      }, { throwOnError: false });

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('safe_mode');
    });

    it('accepts valid settings', () => {
      const result = svc.validateSettings({
        interpreter: { safe_mode: 'auto' },
        llm: { provider: 'openai', model: 'gpt-4', context_window: 8000, max_tokens: 4000 },
      }, { throwOnError: false });

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('accepts a Settings instance as input', () => {
      const settings = Settings.fromJSON({
        llm: { provider: 'openai', model: 'gpt-4', context_window: 8000, max_tokens: 4000 },
      });

      // Should not throw
      expect(() => svc.validateSettings(settings)).not.toThrow();
    });

    it('rejects path traversal in model name', () => {
      const result = svc.validateSettings({
        llm: { provider: 'x', model: '../../../etc/passwd' },
      }, { throwOnError: false });

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('path traversal'))).toBe(true);
    });

    it('rejects javascript: protocol in api_base', () => {
      const result = svc.validateSettings({
        llm: { provider: 'x', model: 'y', api_base: 'javascript:alert(1)' },
      }, { throwOnError: false });

      expect(result.valid).toBe(false);
    });

    it('rejects out-of-range temperature', () => {
      expect(() => svc.validateSettings({
        llm: { provider: 'x', model: 'y', temperature: -1 },
      })).toThrow();

      expect(() => svc.validateSettings({
        llm: { provider: 'x', model: 'y', temperature: 3 },
      })).toThrow();
    });

    it('accepts empty object (all fields optional)', () => {
      const result = svc.validateSettings({}, { throwOnError: false });
      expect(result.valid).toBe(true);
    });
  });

  // -----------------------------------------------------------
  // exportSettings()
  // -----------------------------------------------------------
  describe('exportSettings()', () => {
    it('returns a JSON string', () => {
      const svc = new SettingsService();
      const exported = svc.exportSettings();
      expect(typeof exported).toBe('string');
      expect(() => JSON.parse(exported)).not.toThrow();
    });

    it('contains all 5 settings categories', () => {
      const svc = new SettingsService();
      const parsed = JSON.parse(svc.exportSettings());
      expect(parsed).toHaveProperty('interpreter');
      expect(parsed).toHaveProperty('llm');
      expect(parsed).toHaveProperty('voice');
      expect(parsed).toHaveProperty('memory');
      expect(parsed).toHaveProperty('security');
    });

    it('reflects current state, not just defaults', async () => {
      const repo = createMockRepository({
        llm: { provider: 'custom-provider', model: 'custom-model' },
      });
      const svc = new SettingsService({ repository: repo });
      await svc.loadSettings();

      const parsed = JSON.parse(svc.exportSettings());
      expect(parsed.llm.model).toBe('custom-model');
    });
  });

  // -----------------------------------------------------------
  // importSettings()
  // -----------------------------------------------------------
  describe('importSettings()', () => {
    it('imports valid JSON string and updates current settings', () => {
      const svc = new SettingsService();
      const data = {
        llm: { provider: 'imported-provider', model: 'imported-model' },
      };

      const result = svc.importSettings(JSON.stringify(data));
      expect(result.success).toBe(true);
      expect(svc.getSetting('llm.provider')).toBe('imported-provider');
    });

    it('returns error object for invalid JSON', () => {
      const svc = new SettingsService();
      const result = svc.importSettings('{broken json}');
      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('emits settings:imported event', () => {
      const bus = createMockEventBus();
      const svc = new SettingsService({ eventBus: bus });

      svc.importSettings(JSON.stringify({ llm: { model: 'x' } }));
      expect(bus.emit).toHaveBeenCalledWith('settings:imported', expect.objectContaining({
        settings: expect.any(Object),
        timestamp: expect.any(Number),
      }));
    });

    it('does not emit event on import failure', () => {
      const bus = createMockEventBus();
      const svc = new SettingsService({ eventBus: bus });

      svc.importSettings('{broken}');
      expect(bus.emit).not.toHaveBeenCalled();
    });

    it('does NOT validate imported settings (design note: validation at save-time only)', () => {
      // This documents current behavior: importSettings bypasses validation.
      // Invalid settings are accepted and only caught when saveSettings() is called.
      const svc = new SettingsService();
      const result = svc.importSettings(JSON.stringify({
        llm: { context_window: 1 }, // way below minimum 1000
      }));
      expect(result.success).toBe(true);
      // The invalid value is stored
      expect(svc.getSetting('llm.context_window')).toBe(1);
    });

    it('round-trips through export -> import', () => {
      const svc = new SettingsService();
      svc.setSetting('llm.model', 'round-trip-model');

      const exported = svc.exportSettings();
      const svc2 = new SettingsService();
      svc2.importSettings(exported);

      expect(svc2.getSetting('llm.model')).toBe('round-trip-model');
    });
  });

  // -----------------------------------------------------------
  // getLastSource()
  // -----------------------------------------------------------
  describe('getLastSource()', () => {
    it('returns "defaults" initially', () => {
      const svc = new SettingsService();
      expect(svc.getLastSource()).toBe('defaults');
    });

    it('returns "backend" after successful load', async () => {
      const repo = createMockRepository();
      const svc = new SettingsService({ repository: repo });
      await svc.loadSettings();
      expect(svc.getLastSource()).toBe('backend');
    });

    it('returns "defaults" after failed load', async () => {
      const repo = createMockRepository();
      repo.loadSettings.mockRejectedValue(new Error('fail'));
      const svc = new SettingsService({ repository: repo });

      try { await svc.loadSettings(); } catch { /* expected */ }
      expect(svc.getLastSource()).toBe('defaults');
    });

    it('returns "backend" after successful save', async () => {
      const repo = createMockRepository();
      const svc = new SettingsService({ repository: repo });

      await svc.saveSettings(Settings.fromJSON({
        llm: { provider: 'x', model: 'y', context_window: 8000, max_tokens: 4000 },
      }));
      expect(svc.getLastSource()).toBe('backend');
    });

    it('returns "defaults" after reset', () => {
      const svc = new SettingsService();
      svc._lastSource = 'backend';
      svc.resetToDefaults();
      expect(svc.getLastSource()).toBe('defaults');
    });
  });

  // -----------------------------------------------------------
  // getStatistics()
  // -----------------------------------------------------------
  describe('getStatistics()', () => {
    it('returns stats object with expected shape', () => {
      const svc = new SettingsService();
      const stats = svc.getStatistics();

      expect(stats).toHaveProperty('hasSettings', true);
      expect(stats).toHaveProperty('settingsSize');
      expect(stats).toHaveProperty('lastSource', 'defaults');
      expect(typeof stats.settingsSize).toBe('number');
      expect(stats.settingsSize).toBeGreaterThan(0);
    });

    it('reflects updated lastSource after load', async () => {
      const repo = createMockRepository();
      const svc = new SettingsService({ repository: repo });
      await svc.loadSettings();

      expect(svc.getStatistics().lastSource).toBe('backend');
    });
  });

  // -----------------------------------------------------------
  // cleanup()
  // -----------------------------------------------------------
  describe('cleanup()', () => {
    it('resets settings to defaults', () => {
      const svc = new SettingsService();
      svc.setSetting('llm.model', 'dirty');

      svc.cleanup();
      expect(svc.getSetting('llm.provider')).toBe('aether_inference');
    });

    it('resets lastSource to defaults', () => {
      const svc = new SettingsService();
      svc._lastSource = 'backend';

      svc.cleanup();
      expect(svc.getLastSource()).toBe('defaults');
    });

    it('emits settings:cleanup event', () => {
      const bus = createMockEventBus();
      const svc = new SettingsService({ eventBus: bus });

      svc.cleanup();
      expect(bus.emit).toHaveBeenCalledWith('settings:cleanup', expect.objectContaining({
        timestamp: expect.any(Number),
      }));
    });

    it('is safe to call multiple times', () => {
      const bus = createMockEventBus();
      const svc = new SettingsService({ eventBus: bus });

      svc.cleanup();
      svc.cleanup();
      svc.cleanup();
      // Should emit 3 times, no error
      expect(bus.emit).toHaveBeenCalledTimes(3);
    });
  });

  // -----------------------------------------------------------
  // Integration: full lifecycle
  // -----------------------------------------------------------
  describe('full lifecycle', () => {
    it('load -> modify -> save -> cleanup', async () => {
      const repo = createMockRepository();
      const bus = createMockEventBus();
      const svc = new SettingsService({ repository: repo, eventBus: bus });

      // Step 1: Load
      await svc.loadSettings();
      expect(svc.getLastSource()).toBe('backend');
      expect(bus.emit).toHaveBeenCalledWith('settings:loaded', expect.any(Object));

      // Step 2: Modify
      svc.setSetting('llm.model', 'modified-model');
      expect(svc.getSetting('llm.model')).toBe('modified-model');
      expect(bus.emit).toHaveBeenCalledWith('settings:updated', expect.any(Object));

      // Step 3: Save
      await svc.saveSettings(svc.getSettings());
      expect(repo.saveSettings).toHaveBeenCalledTimes(1);
      expect(bus.emit).toHaveBeenCalledWith('settings:saved', expect.any(Object));

      // Step 4: Cleanup
      svc.cleanup();
      expect(svc.getLastSource()).toBe('defaults');
      expect(svc.getSetting('llm.model')).not.toBe('modified-model');
      expect(bus.emit).toHaveBeenCalledWith('settings:cleanup', expect.any(Object));
    });

    it('import -> validate -> save (validation blocks invalid imports)', async () => {
      const repo = createMockRepository();
      const svc = new SettingsService({ repository: repo });

      // Import settings with invalid value
      svc.importSettings(JSON.stringify({
        llm: { provider: 'x', model: 'y', context_window: 1 }, // too small
      }));

      // Import succeeds (no validation at import time)
      expect(svc.getSetting('llm.context_window')).toBe(1);

      // But save should fail because validation runs at save time
      await expect(svc.saveSettings(svc.getSettings())).rejects.toThrow('Failed to save settings');
      expect(repo.saveSettings).not.toHaveBeenCalled();
    });
  });
});
