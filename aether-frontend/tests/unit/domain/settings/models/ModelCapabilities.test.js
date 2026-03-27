'use strict';

const { ModelCapabilities } = require('../../../../../src/domain/settings/models/ModelCapabilities');

describe('ModelCapabilities Domain Model', () => {
  describe('Constructor', () => {
    it('should create with defaults', () => {
      const mc = new ModelCapabilities();
      expect(mc.modelName).toBeNull();
      expect(mc.supports_vision).toBe(false);
      expect(mc.context_window).toBe(0);
      expect(mc.max_tokens).toBe(0);
      expect(mc.features).toEqual([]);
      expect(mc.timestamp).toBeInstanceOf(Date);
    });

    it('should accept provided data', () => {
      const mc = new ModelCapabilities({
        modelName: 'gpt-4', supports_vision: true,
        context_window: 128000, max_tokens: 4096,
        features: ['function_calling', 'json_mode']
      });
      expect(mc.modelName).toBe('gpt-4');
      expect(mc.supports_vision).toBe(true);
      expect(mc.context_window).toBe(128000);
      expect(mc.max_tokens).toBe(4096);
      expect(mc.features).toEqual(['function_calling', 'json_mode']);
    });
  });

  describe('create factory', () => {
    it('should create with model name and data', () => {
      const mc = ModelCapabilities.create('claude-3', {
        supports_vision: true, context_window: 200000,
        max_tokens: 8192, features: ['tool_use']
      });
      expect(mc.modelName).toBe('claude-3');
      expect(mc.supports_vision).toBe(true);
      expect(mc.context_window).toBe(200000);
      expect(mc.timestamp).toBeInstanceOf(Date);
    });

    it('should handle empty data', () => {
      const mc = ModelCapabilities.create('model-x');
      expect(mc.modelName).toBe('model-x');
      expect(mc.supports_vision).toBe(false);
      expect(mc.context_window).toBe(0);
    });
  });

  describe('Capability checks', () => {
    it('should check vision support', () => {
      expect(new ModelCapabilities({ supports_vision: true }).supportsVision()).toBe(true);
      expect(new ModelCapabilities({ supports_vision: false }).supportsVision()).toBe(false);
      expect(new ModelCapabilities().supportsVision()).toBe(false);
    });

    it('should check feature presence', () => {
      const mc = new ModelCapabilities({ features: ['tool_use', 'json_mode'] });
      expect(mc.hasFeature('tool_use')).toBe(true);
      expect(mc.hasFeature('streaming')).toBe(false);
    });

    it('should return context window', () => {
      expect(new ModelCapabilities({ context_window: 128000 }).getContextWindow()).toBe(128000);
    });

    it('should return max tokens', () => {
      expect(new ModelCapabilities({ max_tokens: 4096 }).getMaxTokens()).toBe(4096);
    });
  });

  describe('Staleness', () => {
    it('should not be stale when fresh', () => {
      const mc = new ModelCapabilities({ timestamp: new Date() });
      expect(mc.isStale()).toBe(false);
    });

    it('should be stale when old', () => {
      const oldDate = new Date(Date.now() - 2 * 3600000);
      const mc = new ModelCapabilities({ timestamp: oldDate });
      expect(mc.isStale()).toBe(true);
    });

    it('should use custom max age', () => {
      const recent = new Date(Date.now() - 500);
      const mc = new ModelCapabilities({ timestamp: recent });
      expect(mc.isStale(200)).toBe(true);
      expect(mc.isStale(60000)).toBe(false);
    });

    it('should be stale when timestamp is null', () => {
      // Explicit null = no timestamp = stale (should refetch)
      const mc = new ModelCapabilities({ timestamp: null });
      expect(mc.isStale()).toBe(true);
    });
  });

  describe('Age', () => {
    it('should return age in milliseconds', () => {
      const mc = new ModelCapabilities({ timestamp: new Date(Date.now() - 5000) });
      expect(mc.getAge()).toBeGreaterThanOrEqual(5000);
    });

    it('should return 0 when no timestamp', () => {
      const mc = new ModelCapabilities({ timestamp: null });
      expect(mc.getAge()).toBe(0);
    });
  });

  describe('Serialization', () => {
    it('should convert to JSON', () => {
      const mc = new ModelCapabilities({
        modelName: 'gpt-4', supports_vision: true,
        context_window: 128000, max_tokens: 4096,
        features: ['tool_use'], timestamp: new Date('2024-01-01T00:00:00Z')
      });
      const json = mc.toJSON();
      expect(json.modelName).toBe('gpt-4');
      expect(json.supports_vision).toBe(true);
      expect(json.timestamp).toBe('2024-01-01T00:00:00.000Z');
      expect(json.features).toEqual(['tool_use']);
      expect(typeof json.age).toBe('number');
    });

    it('should handle null timestamp in toJSON', () => {
      // Explicit null preserved — serializes as null
      const mc = new ModelCapabilities({ timestamp: null });
      expect(mc.toJSON().timestamp).toBeNull();
      expect(mc.toJSON().age).toBe(0);
    });

    it('should round-trip through fromJSON', () => {
      const original = ModelCapabilities.create('claude', {
        supports_vision: true, context_window: 200000,
        features: ['tool_use']
      });
      const json = original.toJSON();
      const restored = ModelCapabilities.fromJSON(json);
      expect(restored.modelName).toBe('claude');
      expect(restored.supports_vision).toBe(true);
      expect(restored.context_window).toBe(200000);
      expect(restored.features).toEqual(['tool_use']);
      expect(restored.timestamp).toBeInstanceOf(Date);
    });

    it('should handle missing timestamp in fromJSON', () => {
      // fromJSON passes null when source JSON has no timestamp
      const restored = ModelCapabilities.fromJSON({ modelName: 'x' });
      expect(restored.timestamp).toBeNull();
      expect(restored.getAge()).toBe(0);
      expect(restored.isStale()).toBe(true);
    });
  });
});
