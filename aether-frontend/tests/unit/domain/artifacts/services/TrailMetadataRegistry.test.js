'use strict';

jest.mock('../../../../../src/core/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
  })
}));

const { TrailMetadataRegistry } = require('../../../../../src/domain/artifacts/services/TrailMetadataRegistry');

describe('TrailMetadataRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new TrailMetadataRegistry({ enableLogging: true });
  });

  describe('register()', () => {
    it('stores valid payload', () => {
      registry.register({
        artifact_id: 'art-001',
        node_id: 'node-001',
        subgroup_id: 'sg-001',
        artifact_type: 'code'
      });

      expect(registry.has('art-001')).toBe(true);
      const meta = registry.get('art-001');
      expect(meta.node_id).toBe('node-001');
      expect(meta.subgroup_id).toBe('sg-001');
      expect(meta.artifact_type).toBe('code');
      expect(meta.timestamp).toBeGreaterThan(0);
    });

    it('throws on null payload', () => {
      expect(() => registry.register(null)).toThrow('CONTRACT VIOLATION');
    });

    it('throws on missing artifact_id', () => {
      expect(() => registry.register({ node_id: 'n1', subgroup_id: 's1' })).toThrow('artifact_id required');
    });

    it('throws on non-string artifact_id', () => {
      expect(() => registry.register({ artifact_id: 42, node_id: 'n1', subgroup_id: 's1' })).toThrow('artifact_id required');
    });

    it('throws on missing node_id', () => {
      expect(() => registry.register({ artifact_id: 'a1', subgroup_id: 's1' })).toThrow('node_id required');
    });

    it('throws on missing subgroup_id', () => {
      expect(() => registry.register({ artifact_id: 'a1', node_id: 'n1' })).toThrow('subgroup_id required');
    });

    it('stores null artifact_type when not provided', () => {
      registry.register({ artifact_id: 'a1', node_id: 'n1', subgroup_id: 's1' });
      expect(registry.get('a1').artifact_type).toBeNull();
    });

    it('overwrites existing mapping', () => {
      registry.register({ artifact_id: 'a1', node_id: 'n1', subgroup_id: 's1', artifact_type: 'code' });
      registry.register({ artifact_id: 'a1', node_id: 'n2', subgroup_id: 's2', artifact_type: 'output' });

      const meta = registry.get('a1');
      expect(meta.node_id).toBe('n2');
      expect(meta.artifact_type).toBe('output');
    });
  });

  describe('get()', () => {
    it('throws on null/empty artifact_id', () => {
      expect(() => registry.get(null)).toThrow('CONTRACT VIOLATION');
      expect(() => registry.get('')).toThrow('CONTRACT VIOLATION');
      expect(() => registry.get(42)).toThrow('CONTRACT VIOLATION');
    });

    it('throws when artifact_id not registered', () => {
      expect(() => registry.get('nonexistent')).toThrow('Trail metadata not found');
    });

    it('returns metadata for registered artifact', () => {
      registry.register({ artifact_id: 'a1', node_id: 'n1', subgroup_id: 's1' });
      const meta = registry.get('a1');
      expect(meta.node_id).toBe('n1');
    });
  });

  describe('has()', () => {
    it('returns false for null/non-string', () => {
      expect(registry.has(null)).toBe(false);
      expect(registry.has(42)).toBe(false);
      expect(registry.has('')).toBe(false);
    });

    it('returns false for unregistered', () => {
      expect(registry.has('nonexistent')).toBe(false);
    });

    it('returns true for registered', () => {
      registry.register({ artifact_id: 'a1', node_id: 'n1', subgroup_id: 's1' });
      expect(registry.has('a1')).toBe(true);
    });
  });

  describe('getRegisteredArtifactIds()', () => {
    it('returns empty array when no registrations', () => {
      expect(registry.getRegisteredArtifactIds()).toEqual([]);
    });

    it('returns all registered IDs', () => {
      registry.register({ artifact_id: 'a1', node_id: 'n1', subgroup_id: 's1' });
      registry.register({ artifact_id: 'a2', node_id: 'n2', subgroup_id: 's2' });
      expect(registry.getRegisteredArtifactIds()).toEqual(['a1', 'a2']);
    });
  });

  describe('getStats()', () => {
    it('returns zero stats when empty', () => {
      const stats = registry.getStats();
      expect(stats.totalMappings).toBe(0);
      expect(stats.oldestMapping).toBeNull();
      expect(stats.newestMapping).toBeNull();
    });

    it('returns accurate stats', () => {
      registry.register({ artifact_id: 'a1', node_id: 'n1', subgroup_id: 's1' });
      registry.register({ artifact_id: 'a2', node_id: 'n2', subgroup_id: 's2' });

      const stats = registry.getStats();
      expect(stats.totalMappings).toBe(2);
      expect(stats.oldestMapping).toBeGreaterThanOrEqual(0);
      expect(stats.newestMapping).toBeGreaterThanOrEqual(0);
    });
  });

  describe('clear()', () => {
    it('removes all mappings', () => {
      registry.register({ artifact_id: 'a1', node_id: 'n1', subgroup_id: 's1' });
      registry.register({ artifact_id: 'a2', node_id: 'n2', subgroup_id: 's2' });

      registry.clear();

      expect(registry.has('a1')).toBe(false);
      expect(registry.has('a2')).toBe(false);
      expect(registry.getStats().totalMappings).toBe(0);
    });
  });
});
