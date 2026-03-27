'use strict';

/**
 * ModelManager Unit Tests
 * ============================================================================
 * Tests LLM model management: refresh from backend, capability probing and
 * caching, vision detection, model search/filter, contract enforcement,
 * event emission, and cleanup.
 *
 * @module tests/unit/application/ModelManager.test
 */

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
}));

const ModelManager = require('../../../src/application/main/modules/models/ModelManager');
const { EventTypes } = require('../../../src/core/events/EventTypes');

function createMockEndpoint() {
  return {
    getModels: jest.fn().mockResolvedValue({
      models: ['gpt-4', 'llama-3', 'qwen-2.5'],
    }),
    getModelCapabilities: jest.fn().mockResolvedValue({
      supports_vision: false,
      context_window: 128000,
      supports_reasoning: true,
    }),
  };
}

function createMockEventBus() {
  return { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
}

describe('ModelManager', () => {
  let manager;
  let endpoint;
  let eventBus;

  beforeEach(() => {
    endpoint = createMockEndpoint();
    eventBus = createMockEventBus();
    manager = new ModelManager({ endpoint, eventBus });
  });

  afterEach(() => {
    if (manager) manager.dispose();
  });

  // -----------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------
  describe('constructor', () => {
    it('throws when endpoint not provided', () => {
      expect(() => new ModelManager({ eventBus })).toThrow('endpoint required');
    });

    it('throws when eventBus not provided', () => {
      expect(() => new ModelManager({ endpoint })).toThrow('eventBus required');
    });

    it('initializes with empty state', () => {
      expect(manager.getModels()).toEqual([]);
      expect(manager.getCurrentModel()).toBeNull();
      expect(manager.capabilities.size).toBe(0);
    });
  });

  // -----------------------------------------------------------
  // refreshModelList
  // -----------------------------------------------------------
  describe('refreshModelList()', () => {
    it('fetches from endpoint and stores sorted models', async () => {
      const models = await manager.refreshModelList();
      expect(endpoint.getModels).toHaveBeenCalled();
      expect(models).toEqual(['gpt-4', 'llama-3', 'qwen-2.5']);
    });

    it('extracts model names from objects with id field', async () => {
      endpoint.getModels.mockResolvedValue({
        models: [{ id: 'model-b' }, { id: 'model-a' }],
      });
      const models = await manager.refreshModelList();
      expect(models).toEqual(['model-a', 'model-b']);
    });

    it('extracts model names from objects with name field', async () => {
      endpoint.getModels.mockResolvedValue({
        models: [{ name: 'beta-model' }, { name: 'alpha-model' }],
      });
      const models = await manager.refreshModelList();
      expect(models).toEqual(['alpha-model', 'beta-model']);
    });

    it('handles flat array response (no models key)', async () => {
      endpoint.getModels.mockResolvedValue(['zebra-model', 'alpha-model']);
      const models = await manager.refreshModelList();
      expect(models).toEqual(['alpha-model', 'zebra-model']);
    });

    it('filters out falsy values', async () => {
      endpoint.getModels.mockResolvedValue({
        models: ['good-model', null, '', undefined, 'also-good'],
      });
      const models = await manager.refreshModelList();
      expect(models).toEqual(['also-good', 'good-model']);
    });

    it('throws CONTRACT VIOLATION on invalid response', async () => {
      endpoint.getModels.mockResolvedValue(null);
      await expect(manager.refreshModelList()).rejects.toThrow('CONTRACT VIOLATION');
    });

    it('emits MODEL.LIST_UPDATED event', async () => {
      await manager.refreshModelList();
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.MODEL.LIST_UPDATED,
        expect.objectContaining({
          models: expect.any(Array),
          count: 3,
          timestamp: expect.any(Number),
        })
      );
    });

    it('passes apiBase parameter to endpoint', async () => {
      await manager.refreshModelList('http://custom:8000');
      expect(endpoint.getModels).toHaveBeenCalledWith('http://custom:8000');
    });

    it('passes null when apiBase is empty', async () => {
      await manager.refreshModelList('');
      expect(endpoint.getModels).toHaveBeenCalledWith(null);
    });
  });

  // -----------------------------------------------------------
  // probeCapabilities
  // -----------------------------------------------------------
  describe('probeCapabilities()', () => {
    it('fetches and caches capabilities', async () => {
      const caps = await manager.probeCapabilities('gpt-4');
      expect(endpoint.getModelCapabilities).toHaveBeenCalledWith('gpt-4');
      expect(caps.context_window).toBe(128000);

      // Verify cache
      const cached = manager.getCachedCapabilities('gpt-4');
      expect(cached.context_window).toBe(128000);
      expect(cached.timestamp).toBeDefined();
    });

    it('emits CAPABILITIES_UPDATED event', async () => {
      await manager.probeCapabilities('gpt-4');
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.MODEL.CAPABILITIES_UPDATED,
        expect.objectContaining({
          model: 'gpt-4',
          capabilities: expect.any(Object),
        })
      );
    });

    it('emits VISION_DETECTED for vision-capable models', async () => {
      endpoint.getModelCapabilities.mockResolvedValue({
        supports_vision: true,
        context_window: 32000,
      });
      await manager.probeCapabilities('internvl-26b');
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.MODEL.VISION_DETECTED,
        expect.objectContaining({ model: 'internvl-26b' })
      );
    });

    it('does not emit VISION_DETECTED for non-vision models', async () => {
      await manager.probeCapabilities('gpt-4');
      const visionCalls = eventBus.emit.mock.calls.filter(
        c => c[0] === EventTypes.MODEL.VISION_DETECTED
      );
      expect(visionCalls).toHaveLength(0);
    });

    it('returns null for empty model name', async () => {
      expect(await manager.probeCapabilities(null)).toBeNull();
      expect(await manager.probeCapabilities('')).toBeNull();
    });

    it('returns null on endpoint error', async () => {
      endpoint.getModelCapabilities.mockRejectedValue(new Error('probe failed'));
      const result = await manager.probeCapabilities('bad-model');
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------
  // setCurrentModel
  // -----------------------------------------------------------
  describe('setCurrentModel()', () => {
    it('updates current model and emits event', () => {
      manager.setCurrentModel('gpt-4');
      expect(manager.getCurrentModel()).toBe('gpt-4');
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.MODEL.CHANGED,
        expect.objectContaining({
          model: 'gpt-4',
          previousModel: null,
          timestamp: expect.any(Number),
        }),
        expect.any(Object)
      );
    });

    it('tracks previous model', () => {
      manager.setCurrentModel('gpt-4');
      eventBus.emit.mockClear();
      manager.setCurrentModel('llama-3');
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.MODEL.CHANGED,
        expect.objectContaining({
          model: 'llama-3',
          previousModel: 'gpt-4',
        }),
        expect.any(Object)
      );
    });

    it('does nothing for empty model name', () => {
      manager.setCurrentModel(null);
      manager.setCurrentModel('');
      expect(manager.getCurrentModel()).toBeNull();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------
  // detectVisionModelType
  // -----------------------------------------------------------
  describe('detectVisionModelType()', () => {
    it('detects internvl', () => {
      expect(manager.detectVisionModelType('InternVL2-26B')).toBe('internvl');
    });

    it('detects qwen', () => {
      expect(manager.detectVisionModelType('Qwen2.5-VL')).toBe('qwen');
    });

    it('detects smoldocling', () => {
      expect(manager.detectVisionModelType('SmolDocling-256')).toBe('smoldocling');
    });

    it('detects pixtral', () => {
      expect(manager.detectVisionModelType('pixtral-12b')).toBe('pixtral');
    });

    it('detects llava', () => {
      expect(manager.detectVisionModelType('llava-1.6')).toBe('llava');
    });

    it('detects granite', () => {
      expect(manager.detectVisionModelType('granite-3b-vision')).toBe('granite');
    });

    it('returns smoldocling as default for unknown models', () => {
      expect(manager.detectVisionModelType('gpt-4')).toBe('smoldocling');
    });

    it('returns smoldocling for null/empty', () => {
      expect(manager.detectVisionModelType(null)).toBe('smoldocling');
      expect(manager.detectVisionModelType('')).toBe('smoldocling');
    });
  });

  // -----------------------------------------------------------
  // supportsVision
  // -----------------------------------------------------------
  describe('supportsVision()', () => {
    it('returns null for empty model name', async () => {
      expect(await manager.supportsVision(null)).toBeNull();
    });

    it('uses cached capabilities when available', async () => {
      manager.capabilities.set('cached-model', { supports_vision: true });
      const result = await manager.supportsVision('cached-model');
      expect(result).toBe(true);
      expect(endpoint.getModelCapabilities).not.toHaveBeenCalled();
    });

    it('probes when not cached', async () => {
      endpoint.getModelCapabilities.mockResolvedValue({ supports_vision: true });
      const result = await manager.supportsVision('new-model');
      expect(result).toBe(true);
      expect(endpoint.getModelCapabilities).toHaveBeenCalledWith('new-model');
    });

    it('returns false on probe failure', async () => {
      endpoint.getModelCapabilities.mockRejectedValue(new Error('fail'));
      const result = await manager.supportsVision('bad-model');
      expect(result).toBe(false);
    });
  });

  // -----------------------------------------------------------
  // searchModels / filterModels / getVisionModels
  // -----------------------------------------------------------
  describe('search and filter', () => {
    beforeEach(async () => {
      endpoint.getModels.mockResolvedValue({
        models: ['gpt-4', 'llama-3', 'internvl-26b', 'qwen-2.5-vlm'],
      });
      await manager.refreshModelList();
    });

    it('searchModels returns case-insensitive matches', () => {
      expect(manager.searchModels('GPT')).toEqual(['gpt-4']);
    });

    it('searchModels returns all for empty keyword', () => {
      expect(manager.searchModels('')).toHaveLength(4);
      expect(manager.searchModels(null)).toHaveLength(4);
    });

    it('filterModels applies predicate', () => {
      const result = manager.filterModels(m => m.startsWith('g'));
      expect(result).toEqual(['gpt-4']);
    });

    it('getVisionModels returns models with vision keywords', () => {
      const vision = manager.getVisionModels();
      expect(vision).toContain('internvl-26b');
      expect(vision).toContain('qwen-2.5-vlm');
      expect(vision).not.toContain('gpt-4');
      expect(vision).not.toContain('llama-3');
    });
  });

  // -----------------------------------------------------------
  // clearCache / getStats / dispose
  // -----------------------------------------------------------
  describe('clearCache()', () => {
    it('empties capabilities map', async () => {
      await manager.probeCapabilities('gpt-4');
      expect(manager.capabilities.size).toBe(1);
      manager.clearCache();
      expect(manager.capabilities.size).toBe(0);
    });
  });

  describe('getStats()', () => {
    it('returns frozen stats', async () => {
      await manager.refreshModelList();
      manager.setCurrentModel('gpt-4');
      const stats = manager.getStats();
      expect(Object.isFrozen(stats)).toBe(true);
      expect(stats.totalModels).toBe(3);
      expect(stats.currentModel).toBe('gpt-4');
      expect(stats.cachedCapabilities).toBe(0);
    });
  });

  describe('dispose()', () => {
    it('clears all state and references', async () => {
      await manager.refreshModelList();
      await manager.probeCapabilities('gpt-4');
      manager.setCurrentModel('gpt-4');
      manager.dispose();
      expect(manager.getModels()).toEqual([]);
      expect(manager.getCurrentModel()).toBeNull();
      expect(manager.capabilities.size).toBe(0);
      expect(manager.endpoint).toBeNull();
      expect(manager.eventBus).toBeNull();
    });

    it('is safe to call twice', () => {
      expect(() => {
        manager.dispose();
        manager.dispose();
      }).not.toThrow();
      manager = null;
    });
  });

  // -----------------------------------------------------------
  // enableLogging branches
  // -----------------------------------------------------------
  describe('enableLogging branches', () => {
    let logManager;
    let logEndpoint;
    let logEventBus;

    beforeEach(() => {
      logEndpoint = createMockEndpoint();
      logEventBus = createMockEventBus();
      logManager = new ModelManager({
        endpoint: logEndpoint,
        eventBus: logEventBus,
        enableLogging: true,
      });
    });

    afterEach(() => {
      if (logManager) logManager.dispose();
    });

    it('logs during refreshModelList', async () => {
      await logManager.refreshModelList();
      // Covers lines 61, 95 (enableLogging debug calls)
      expect(logEndpoint.getModels).toHaveBeenCalled();
    });

    it('logs during probeCapabilities', async () => {
      await logManager.probeCapabilities('gpt-4');
      // Covers lines 110, 137 (enableLogging debug calls)
      expect(logEndpoint.getModelCapabilities).toHaveBeenCalledWith('gpt-4');
    });

    it('logs during setCurrentModel', () => {
      logManager.setCurrentModel('gpt-4');
      // Covers line 165 (enableLogging debug call)
      expect(logManager.getCurrentModel()).toBe('gpt-4');
    });

    it('logs during clearCache', () => {
      logManager.clearCache();
      // Covers line 294 (enableLogging debug call)
      expect(logManager.capabilities.size).toBe(0);
    });

    it('logs during dispose', () => {
      logManager.dispose();
      // Covers line 309 (enableLogging debug call)
      logManager = null;
    });
  });

  // -----------------------------------------------------------
  // getCachedCapabilities -- null fallback branch
  // -----------------------------------------------------------
  describe('getCachedCapabilities()', () => {
    it('returns null for uncached model', () => {
      expect(manager.getCachedCapabilities('nonexistent')).toBeNull();
    });
  });

  // -----------------------------------------------------------
  // refreshModelList -- empty array fallback branch
  // -----------------------------------------------------------
  describe('refreshModelList() edge branches', () => {
    it('returns empty for object with no models key and not array', async () => {
      endpoint.getModels.mockResolvedValue({ foo: 'bar' });
      const models = await manager.refreshModelList();
      expect(models).toEqual([]);
    });
  });

  // -----------------------------------------------------------
  // supportsVision -- cached.supports_vision falsy branch
  // -----------------------------------------------------------
  describe('supportsVision() cached falsy branch', () => {
    it('returns false when cached supports_vision is falsy', async () => {
      manager.capabilities.set('no-vision', { supports_vision: false });
      const result = await manager.supportsVision('no-vision');
      expect(result).toBe(false);
    });
  });

  // -----------------------------------------------------------
  // supportsVision -- outer catch (lines 213-214)
  // -----------------------------------------------------------
  describe('supportsVision() outer catch', () => {
    it('returns false when capabilities.get throws', async () => {
      // Replace capabilities Map with one that throws on .get()
      manager.capabilities = {
        get() { throw new Error('map broken'); },
        set() {},
        clear() {},
        get size() { return 0; },
      };
      const result = await manager.supportsVision('some-model');
      expect(result).toBe(false);
    });
  });

  // -----------------------------------------------------------
  // window global export (lines 317-319)
  // -----------------------------------------------------------
  describe('window global export', () => {
    it('attaches ModelManager to window when window exists', () => {
      jest.isolateModules(() => {
        global.window = {};
        jest.mock('../../../src/renderer/shared/utils/logger', () => ({
          createRendererLogger: () => ({
            info: jest.fn(), warn: jest.fn(), error: jest.fn(),
            debug: jest.fn(), trace: jest.fn(),
          }),
        }));
        const MM = require('../../../src/application/main/modules/models/ModelManager');
        expect(global.window.ModelManager).toBe(MM);
        delete global.window;
      });
    });
  });
});
