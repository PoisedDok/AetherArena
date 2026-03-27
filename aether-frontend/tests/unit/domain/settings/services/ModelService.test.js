'use strict';

jest.mock('../../../../../src/core/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
  })
}));

const { ModelService } = require('../../../../../src/domain/settings/services/ModelService');
const { ModelSettings } = require('../../../../../src/domain/settings/models/ModelSettings');
const { ModelCapabilities } = require('../../../../../src/domain/settings/models/ModelCapabilities');

function createMockRepo() {
  return {
    loadModels: jest.fn().mockResolvedValue(
      ModelSettings.create(['gpt-4o', 'claude-3', 'llama-3.1'])
    ),
    loadModelCapabilities: jest.fn().mockResolvedValue(
      ModelCapabilities.create('gpt-4o', { supports_vision: true, context_window: 128000, max_tokens: 4096 })
    )
  };
}

function createMockEventBus() {
  return { emit: jest.fn() };
}

describe('ModelService', () => {
  describe('constructor', () => {
    it('initializes with empty model list', () => {
      const svc = new ModelService();
      expect(svc.getModels()).toEqual([]);
      expect(svc.getCurrentModel()).toBeNull();
    });
  });

  describe('refreshModels()', () => {
    it('throws when repository not configured', async () => {
      const svc = new ModelService();
      await expect(svc.refreshModels()).rejects.toThrow('Repository not configured');
    });

    it('loads models from repository and emits event', async () => {
      const repo = createMockRepo();
      const bus = createMockEventBus();
      const svc = new ModelService({ repository: repo, eventBus: bus });

      const result = await svc.refreshModels('https://api.example.com');
      expect(repo.loadModels).toHaveBeenCalledWith('https://api.example.com');
      expect(result).toBeInstanceOf(ModelSettings);
      expect(svc.getModels().length).toBe(3);
      expect(bus.emit).toHaveBeenCalledWith('models:updated', expect.objectContaining({
        count: 3
      }));
    });

    it('wraps repo errors', async () => {
      const repo = createMockRepo();
      repo.loadModels.mockRejectedValue(new Error('network fail'));
      const svc = new ModelService({ repository: repo });

      await expect(svc.refreshModels()).rejects.toThrow('Failed to refresh models: network fail');
    });
  });

  describe('setModel()', () => {
    it('sets current model when it exists in cache', async () => {
      const repo = createMockRepo();
      const bus = createMockEventBus();
      const svc = new ModelService({ repository: repo, eventBus: bus });
      await svc.refreshModels();

      svc.setModel('gpt-4o');
      expect(svc.getCurrentModel()).toBe('gpt-4o');
      expect(bus.emit).toHaveBeenCalledWith('model:changed', expect.objectContaining({
        model: 'gpt-4o'
      }));
    });

    it('throws when model not in cache', async () => {
      const repo = createMockRepo();
      const svc = new ModelService({ repository: repo });
      await svc.refreshModels();

      expect(() => svc.setModel('nonexistent')).toThrow('not found in cache');
    });
  });

  describe('probeCapabilities()', () => {
    it('loads capabilities from repo and caches them', async () => {
      const repo = createMockRepo();
      const bus = createMockEventBus();
      const svc = new ModelService({ repository: repo, eventBus: bus });

      const caps = await svc.probeCapabilities('gpt-4o');
      expect(repo.loadModelCapabilities).toHaveBeenCalledWith('gpt-4o');
      expect(caps.supports_vision).toBe(true);
      expect(caps.context_window).toBe(128000);

      // Verify cached
      const cached = svc.getCachedCapabilities('gpt-4o');
      expect(cached).toBeTruthy();
      expect(cached.supports_vision).toBe(true);
    });

    it('emits vision-detected event for vision models', async () => {
      const repo = createMockRepo();
      const bus = createMockEventBus();
      const svc = new ModelService({ repository: repo, eventBus: bus });

      await svc.probeCapabilities('gpt-4o');
      expect(bus.emit).toHaveBeenCalledWith('model:vision-detected', expect.objectContaining({
        model: 'gpt-4o'
      }));
    });

    it('throws when repo not configured', async () => {
      const svc = new ModelService();
      await expect(svc.probeCapabilities('x')).rejects.toThrow('Repository not configured');
    });
  });

  describe('supportsVision()', () => {
    it('returns cached result if available', async () => {
      const repo = createMockRepo();
      const svc = new ModelService({ repository: repo });

      // Probe first to cache
      await svc.probeCapabilities('gpt-4o');
      // supportsVision should use cache, not call repo again
      const result = await svc.supportsVision('gpt-4o');
      expect(result).toBe(true);
      expect(repo.loadModelCapabilities).toHaveBeenCalledTimes(1); // only the probe call
    });

    it('probes if not cached', async () => {
      const repo = createMockRepo();
      const svc = new ModelService({ repository: repo });

      const result = await svc.supportsVision('gpt-4o');
      expect(result).toBe(true);
      expect(repo.loadModelCapabilities).toHaveBeenCalledWith('gpt-4o');
    });

    it('returns false on probe failure', async () => {
      const repo = createMockRepo();
      repo.loadModelCapabilities.mockRejectedValue(new Error('fail'));
      const svc = new ModelService({ repository: repo });

      const result = await svc.supportsVision('unknown');
      expect(result).toBe(false);
    });
  });

  describe('detectVisionModelType()', () => {
    it('detects internvl', () => {
      const svc = new ModelService();
      expect(svc.detectVisionModelType('InternVL-Chat-V1-5')).toBe('internvl');
    });

    it('detects qwen', () => {
      const svc = new ModelService();
      expect(svc.detectVisionModelType('Qwen-VL-Chat')).toBe('qwen');
    });

    it('defaults to smoldocling', () => {
      const svc = new ModelService();
      expect(svc.detectVisionModelType('some-unknown-model')).toBe('smoldocling');
    });
  });

  describe('searchModels()', () => {
    it('filters by keyword', async () => {
      const repo = createMockRepo();
      const svc = new ModelService({ repository: repo });
      await svc.refreshModels();

      expect(svc.searchModels('gpt')).toEqual(['gpt-4o']);
    });
  });

  describe('hasModel()', () => {
    it('returns true for loaded model', async () => {
      const repo = createMockRepo();
      const svc = new ModelService({ repository: repo });
      await svc.refreshModels();

      expect(svc.hasModel('gpt-4o')).toBe(true);
      expect(svc.hasModel('nonexistent')).toBe(false);
    });
  });

  describe('clearCache()', () => {
    it('clears capabilities cache and emits event', async () => {
      const repo = createMockRepo();
      const bus = createMockEventBus();
      const svc = new ModelService({ repository: repo, eventBus: bus });

      await svc.probeCapabilities('gpt-4o');
      expect(svc.getCachedCapabilities('gpt-4o')).toBeTruthy();

      svc.clearCache();
      expect(svc.getCachedCapabilities('gpt-4o')).toBeNull();
      expect(bus.emit).toHaveBeenCalledWith('model:cache-cleared', expect.any(Object));
    });
  });

  describe('cleanup()', () => {
    it('resets to empty state', async () => {
      const repo = createMockRepo();
      const bus = createMockEventBus();
      const svc = new ModelService({ repository: repo, eventBus: bus });
      await svc.refreshModels();

      svc.cleanup();
      expect(svc.getModels()).toEqual([]);
      expect(svc.getCurrentModel()).toBeNull();
      expect(bus.emit).toHaveBeenCalledWith('models:cleanup', expect.any(Object));
    });
  });

  describe('getStatistics()', () => {
    it('returns stats', async () => {
      const repo = createMockRepo();
      const svc = new ModelService({ repository: repo });
      await svc.refreshModels();

      const stats = svc.getStatistics();
      expect(stats.totalModels).toBe(3);
      expect(stats.currentModel).toBeNull();
      expect(stats.cachedCapabilities).toBe(0);
    });
  });
});
