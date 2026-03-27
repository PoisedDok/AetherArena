'use strict';

const { SettingsRepository } = require('../../../../../src/domain/settings/repositories/SettingsRepository');
const { Settings } = require('../../../../../src/domain/settings/models/Settings');
const { ProfileSettings } = require('../../../../../src/domain/settings/models/ProfileSettings');
const { ModelSettings } = require('../../../../../src/domain/settings/models/ModelSettings');
const { ModelCapabilities } = require('../../../../../src/domain/settings/models/ModelCapabilities');

function createMockEndpoint() {
  return {
    getSettings: jest.fn().mockResolvedValue({
      llm: { provider: 'openai', model: 'gpt-4o' },
      interpreter: { safe_mode: 'auto' }
    }),
    setSettings: jest.fn().mockResolvedValue({ success: true }),
    getProfiles: jest.fn().mockResolvedValue({
      profiles: ['alpha.py', 'beta.py']
    }),
    getModels: jest.fn().mockResolvedValue({
      models: ['gpt-4o', 'claude-3', 'llama-3.1']
    }),
    getModelCapabilities: jest.fn().mockResolvedValue({
      supports_vision: true, context_window: 128000, max_tokens: 4096
    })
  };
}

describe('SettingsRepository', () => {
  describe('loadSettings()', () => {
    it('throws when endpoint not configured', async () => {
      const repo = new SettingsRepository();
      await expect(repo.loadSettings()).rejects.toThrow('CONTRACT VIOLATION');
    });

    it('loads settings from endpoint and returns Settings model', async () => {
      const endpoint = createMockEndpoint();
      const repo = new SettingsRepository({ endpoint });

      const result = await repo.loadSettings();
      expect(endpoint.getSettings).toHaveBeenCalled();
      expect(result.source).toBe('backend');
      expect(result.settings).toBeInstanceOf(Settings);
    });

    it('throws on invalid backend response', async () => {
      const endpoint = createMockEndpoint();
      endpoint.getSettings.mockResolvedValue(null);
      const repo = new SettingsRepository({ endpoint });

      await expect(repo.loadSettings()).rejects.toThrow('CONTRACT VIOLATION');
    });
  });

  describe('saveSettings()', () => {
    it('throws when endpoint not configured', async () => {
      const repo = new SettingsRepository();
      await expect(repo.saveSettings({})).rejects.toThrow('CONTRACT VIOLATION');
    });

    it('throws when settings has no toJSON', async () => {
      const endpoint = createMockEndpoint();
      const repo = new SettingsRepository({ endpoint });

      await expect(repo.saveSettings({ data: 'raw' })).rejects.toThrow('CONTRACT VIOLATION');
    });

    it('serializes and sends to endpoint', async () => {
      const endpoint = createMockEndpoint();
      const repo = new SettingsRepository({ endpoint });

      // Create a real Settings instance
      const settings = Settings.fromJSON({
        llm: { provider: 'openai', model: 'gpt-4o' }
      });

      const result = await repo.saveSettings(settings);
      expect(endpoint.setSettings).toHaveBeenCalledWith(expect.any(Object));
      expect(result.success).toBe(true);
      expect(result.source).toBe('backend');
    });

    it('throws when toJSON returns non-object', async () => {
      const endpoint = createMockEndpoint();
      const repo = new SettingsRepository({ endpoint });

      // Object with toJSON that returns null
      const badSettings = { toJSON: () => null };
      await expect(repo.saveSettings(badSettings)).rejects.toThrow('CONTRACT VIOLATION');
      expect(endpoint.setSettings).not.toHaveBeenCalled();
    });
  });

  describe('loadProfiles()', () => {
    it('throws when endpoint not configured', async () => {
      const repo = new SettingsRepository();
      await expect(repo.loadProfiles()).rejects.toThrow('Endpoint not configured');
    });

    it('returns ProfileSettings from endpoint', async () => {
      const endpoint = createMockEndpoint();
      const repo = new SettingsRepository({ endpoint });

      const result = await repo.loadProfiles();
      expect(result).toBeInstanceOf(ProfileSettings);
      expect(result.getAvailableProfiles().length).toBe(2);
    });

    it('handles missing profiles array gracefully', async () => {
      const endpoint = createMockEndpoint();
      endpoint.getProfiles.mockResolvedValue({});
      const repo = new SettingsRepository({ endpoint });

      const result = await repo.loadProfiles();
      expect(result.getAvailableProfiles()).toEqual([]);
    });

    it('wraps endpoint errors with context message', async () => {
      const endpoint = createMockEndpoint();
      endpoint.getProfiles.mockRejectedValue(new Error('network timeout'));
      const repo = new SettingsRepository({ endpoint });

      await expect(repo.loadProfiles()).rejects.toThrow('Failed to load profiles: network timeout');
    });
  });

  describe('saveProfileSelection()', () => {
    it('throws when endpoint not configured', async () => {
      const repo = new SettingsRepository();
      await expect(repo.saveProfileSelection('x')).rejects.toThrow('Endpoint not configured');
    });

    it('sends interpreter.profile payload', async () => {
      const endpoint = createMockEndpoint();
      const repo = new SettingsRepository({ endpoint });

      const result = await repo.saveProfileSelection('alpha.py');
      expect(endpoint.setSettings).toHaveBeenCalledWith({
        interpreter: { profile: 'alpha.py' }
      });
      expect(result).toBe(true);
    });

    it('wraps endpoint errors with context message', async () => {
      const endpoint = createMockEndpoint();
      endpoint.setSettings.mockRejectedValue(new Error('permission denied'));
      const repo = new SettingsRepository({ endpoint });

      await expect(repo.saveProfileSelection('alpha.py')).rejects.toThrow(
        'Failed to save profile selection: permission denied'
      );
    });
  });

  describe('loadModels()', () => {
    it('throws when endpoint not configured', async () => {
      const repo = new SettingsRepository();
      await expect(repo.loadModels()).rejects.toThrow('CONTRACT VIOLATION');
    });

    it('returns ModelSettings from endpoint', async () => {
      const endpoint = createMockEndpoint();
      const repo = new SettingsRepository({ endpoint });

      const result = await repo.loadModels('https://api.example.com');
      expect(endpoint.getModels).toHaveBeenCalledWith('https://api.example.com');
      expect(result).toBeInstanceOf(ModelSettings);
      expect(result.getAvailableModels().length).toBe(3);
    });

    it('handles response as flat array', async () => {
      const endpoint = createMockEndpoint();
      endpoint.getModels.mockResolvedValue(['model-a', 'model-b']);
      const repo = new SettingsRepository({ endpoint });

      const result = await repo.loadModels();
      expect(result.getAvailableModels().length).toBe(2);
    });

    it('handles response with object items (id field)', async () => {
      const endpoint = createMockEndpoint();
      endpoint.getModels.mockResolvedValue({
        models: [{ id: 'gpt-4o' }, { name: 'claude-3' }]
      });
      const repo = new SettingsRepository({ endpoint });

      const result = await repo.loadModels();
      expect(result.hasModel('gpt-4o')).toBe(true);
      expect(result.hasModel('claude-3')).toBe(true);
    });

    it('throws on invalid response', async () => {
      const endpoint = createMockEndpoint();
      endpoint.getModels.mockResolvedValue(null);
      const repo = new SettingsRepository({ endpoint });

      await expect(repo.loadModels()).rejects.toThrow('CONTRACT VIOLATION');
    });
  });

  describe('loadModelCapabilities()', () => {
    it('throws when endpoint not configured', async () => {
      const repo = new SettingsRepository();
      await expect(repo.loadModelCapabilities('x')).rejects.toThrow('Endpoint not configured');
    });

    it('returns ModelCapabilities from endpoint', async () => {
      const endpoint = createMockEndpoint();
      const repo = new SettingsRepository({ endpoint });

      const result = await repo.loadModelCapabilities('gpt-4o');
      expect(endpoint.getModelCapabilities).toHaveBeenCalledWith('gpt-4o');
      expect(result).toBeInstanceOf(ModelCapabilities);
      expect(result.supportsVision()).toBe(true);
      expect(result.getContextWindow()).toBe(128000);
    });

    it('wraps endpoint errors with context message', async () => {
      const endpoint = createMockEndpoint();
      endpoint.getModelCapabilities.mockRejectedValue(new Error('model not found'));
      const repo = new SettingsRepository({ endpoint });

      await expect(repo.loadModelCapabilities('unknown')).rejects.toThrow(
        'Failed to load model capabilities: model not found'
      );
    });
  });
});
