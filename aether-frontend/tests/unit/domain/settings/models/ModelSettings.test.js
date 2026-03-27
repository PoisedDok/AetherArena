'use strict';

const { ModelSettings } = require('../../../../../src/domain/settings/models/ModelSettings');

describe('ModelSettings Domain Model', () => {
  describe('Constructor', () => {
    it('should create with defaults', () => {
      const ms = new ModelSettings();
      expect(ms.availableModels).toEqual([]);
      expect(ms.currentModel).toBeNull();
      expect(ms.capabilities).toBeInstanceOf(Map);
    });

    it('should accept provided data', () => {
      const ms = new ModelSettings({
        availableModels: ['model-a', 'model-b'],
        currentModel: 'model-a'
      });
      expect(ms.availableModels).toEqual(['model-a', 'model-b']);
      expect(ms.currentModel).toBe('model-a');
    });
  });

  describe('create factory', () => {
    it('should sort models alphabetically', () => {
      const ms = ModelSettings.create(['zeta', 'alpha', 'beta']);
      expect(ms.availableModels).toEqual(['alpha', 'beta', 'zeta']);
    });

    it('should convert all to strings', () => {
      const ms = ModelSettings.create([123, 'abc']);
      expect(ms.availableModels).toEqual(['123', 'abc']);
    });

    it('should set current model', () => {
      const ms = ModelSettings.create(['a'], 'a');
      expect(ms.currentModel).toBe('a');
    });
  });

  describe('Model management', () => {
    let ms;
    beforeEach(() => {
      ms = ModelSettings.create(['gpt-4', 'claude-3', 'llama-3'], 'gpt-4');
    });

    it('should set available models (sorted)', () => {
      ms.setAvailableModels(['z-model', 'a-model']);
      expect(ms.availableModels).toEqual(['a-model', 'z-model']);
    });

    it('should set current model', () => {
      ms.setCurrentModel('claude-3');
      expect(ms.currentModel).toBe('claude-3');
    });

    it('should throw on non-existent model', () => {
      expect(() => ms.setCurrentModel('nonexistent')).toThrow('not found');
    });

    it('should get current model', () => {
      expect(ms.getCurrentModel()).toBe('gpt-4');
    });

    it('should return copy of available models', () => {
      const models = ms.getAvailableModels();
      models.push('injected');
      expect(ms.availableModels).not.toContain('injected');
    });

    it('should check model existence', () => {
      expect(ms.hasModel('gpt-4')).toBe(true);
      expect(ms.hasModel('nope')).toBe(false);
    });

    it('should count models', () => {
      expect(ms.getModelCount()).toBe(3);
    });

    it('should check hasModels and hasCurrentModel', () => {
      expect(ms.hasModels()).toBe(true);
      expect(ms.hasCurrentModel()).toBe(true);
      const empty = new ModelSettings();
      expect(empty.hasModels()).toBe(false);
      expect(empty.hasCurrentModel()).toBe(false);
    });
  });

  describe('Search and filter', () => {
    let ms;
    beforeEach(() => {
      ms = ModelSettings.create([
        'gpt-4', 'gpt-4-vision', 'claude-3-opus',
        'llama-3', 'qwen-vl', 'internvl-2'
      ]);
    });

    it('should search by keyword (case insensitive)', () => {
      expect(ms.searchModels('gpt')).toEqual(['gpt-4', 'gpt-4-vision']);
      expect(ms.searchModels('GPT')).toEqual(['gpt-4', 'gpt-4-vision']);
    });

    it('should return all models for empty keyword', () => {
      expect(ms.searchModels('')).toHaveLength(6);
      expect(ms.searchModels(null)).toHaveLength(6);
    });

    it('should filter by predicate', () => {
      const result = ms.filterModels(m => m.includes('3'));
      expect(result).toEqual(['claude-3-opus', 'llama-3']);
    });

    it('should get vision models', () => {
      const vision = ms.getVisionModels();
      expect(vision).toContain('gpt-4-vision');
      expect(vision).toContain('qwen-vl');
      expect(vision).toContain('internvl-2');
      expect(vision).not.toContain('llama-3');
    });
  });

  describe('Vision model detection', () => {
    let ms;
    beforeEach(() => { ms = new ModelSettings(); });

    it('should detect internvl', () => {
      expect(ms.detectVisionModelType('InternVL-2-8B')).toBe('internvl');
    });

    it('should detect qwen', () => {
      expect(ms.detectVisionModelType('Qwen-VL-Chat')).toBe('qwen');
    });

    it('should detect pixtral', () => {
      expect(ms.detectVisionModelType('pixtral-12b')).toBe('pixtral');
    });

    it('should detect llava', () => {
      expect(ms.detectVisionModelType('llava-1.5')).toBe('llava');
    });

    it('should detect granite', () => {
      expect(ms.detectVisionModelType('granite-3b-vision')).toBe('granite');
    });

    it('should default to smoldocling', () => {
      expect(ms.detectVisionModelType('unknown-model')).toBe('smoldocling');
      expect(ms.detectVisionModelType(null)).toBe('smoldocling');
      expect(ms.detectVisionModelType('')).toBe('smoldocling');
    });
  });

  describe('Capabilities cache', () => {
    let ms;
    beforeEach(() => { ms = new ModelSettings(); });

    it('should set and get capabilities', () => {
      ms.setCapabilities('gpt-4', { vision: true, context: 128000 });
      const caps = ms.getCapabilities('gpt-4');
      expect(caps.vision).toBe(true);
      expect(caps.context).toBe(128000);
      expect(caps.timestamp).toBeDefined();
    });

    it('should return null for uncached model', () => {
      expect(ms.getCapabilities('nope')).toBeNull();
    });

    it('should check if cached', () => {
      ms.setCapabilities('m1', { x: 1 });
      expect(ms.hasCapabilities('m1')).toBe(true);
      expect(ms.hasCapabilities('m2')).toBe(false);
    });

    it('should clear cache', () => {
      ms.setCapabilities('m1', {});
      ms.setCapabilities('m2', {});
      ms.clearCapabilitiesCache();
      expect(ms.capabilities.size).toBe(0);
    });
  });

  describe('Statistics', () => {
    it('should return comprehensive stats', () => {
      const ms = ModelSettings.create(['gpt-4', 'qwen-vl', 'llama-3'], 'gpt-4');
      ms.setCapabilities('gpt-4', { vision: true });
      const stats = ms.getStatistics();
      expect(stats.totalModels).toBe(3);
      expect(stats.currentModel).toBe('gpt-4');
      expect(stats.cachedCapabilities).toBe(1);
      expect(stats.visionModels).toBeGreaterThan(0);
    });
  });

  describe('Serialization', () => {
    it('should serialize to JSON', () => {
      const ms = ModelSettings.create(['gpt-4', 'claude'], 'gpt-4');
      const json = ms.toJSON();
      expect(json.availableModels).toEqual(['claude', 'gpt-4']);
      expect(json.currentModel).toBe('gpt-4');
      expect(json.capabilitiesCount).toBe(0);
    });

    it('should restore from JSON', () => {
      const ms = ModelSettings.create(['gpt-4', 'claude'], 'gpt-4');
      const json = ms.toJSON();
      const restored = ModelSettings.fromJSON(json);
      expect(restored.availableModels).toEqual(['claude', 'gpt-4']);
      expect(restored.currentModel).toBe('gpt-4');
      expect(restored.capabilities).toBeInstanceOf(Map);
    });
  });
});
