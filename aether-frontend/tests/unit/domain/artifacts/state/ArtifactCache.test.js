'use strict';

jest.mock('../../../../../src/core/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
  })
}));

const { ArtifactCache, DEFAULT_CONFIG } = require('../../../../../src/domain/artifacts/state/ArtifactCache');

describe('ArtifactCache', () => {
  let cache;

  beforeEach(() => {
    cache = new ArtifactCache({ maxEntries: 5, maxTotalSize: 10000, maxArtifactSize: 5000 });
  });

  describe('DEFAULT_CONFIG', () => {
    it('has expected defaults', () => {
      expect(DEFAULT_CONFIG.MAX_ENTRIES).toBe(1000);
      expect(DEFAULT_CONFIG.MAX_TOTAL_SIZE).toBe(100 * 1024 * 1024);
      expect(DEFAULT_CONFIG.MAX_ARTIFACT_SIZE).toBe(50 * 1024 * 1024);
      expect(DEFAULT_CONFIG.ENABLE_METRICS).toBe(true);
    });
  });

  describe('constructor', () => {
    it('uses provided config', () => {
      const config = cache.getConfig();
      expect(config.maxEntries).toBe(5);
      expect(config.maxTotalSize).toBe(10000);
    });

    it('uses defaults when no config given', () => {
      const c = new ArtifactCache();
      expect(c.getConfig().maxEntries).toBe(1000);
    });
  });

  describe('set() / get()', () => {
    it('stores and retrieves artifact', () => {
      cache.set('a1', { content: 'hello' });
      expect(cache.get('a1')).toEqual({ content: 'hello' });
    });

    it('returns null for non-existent key', () => {
      expect(cache.get('nonexistent')).toBeNull();
    });

    it('throws on invalid id', () => {
      expect(() => cache.set('', { x: 1 })).toThrow('ID must be a non-empty string');
      expect(() => cache.set(null, { x: 1 })).toThrow('ID must be a non-empty string');
      expect(() => cache.get('')).toThrow('ID must be a non-empty string');
    });

    it('throws on invalid artifact', () => {
      expect(() => cache.set('a1', null)).toThrow('Artifact must be an object');
      expect(() => cache.set('a1', 'string')).toThrow('Artifact must be an object');
    });

    it('overwrites existing entry', () => {
      cache.set('a1', { v: 1 });
      cache.set('a1', { v: 2 });
      expect(cache.get('a1')).toEqual({ v: 2 });
      expect(cache.size()).toBe(1);
    });

    it('rejects artifacts exceeding maxArtifactSize', () => {
      const huge = { data: 'x'.repeat(6000) };
      const result = cache.set('huge', huge);
      expect(result).toBe(false);
      expect(cache.has('huge')).toBe(false);
    });

    it('returns true on successful set', () => {
      expect(cache.set('a1', { x: 1 })).toBe(true);
    });
  });

  describe('LRU eviction', () => {
    it('evicts least recently used when at maxEntries', () => {
      // Fill cache to max (5)
      for (let i = 0; i < 5; i++) {
        cache.set(`a${i}`, { v: i });
      }
      expect(cache.size()).toBe(5);

      // Add one more, should evict a0 (oldest)
      cache.set('a5', { v: 5 });
      expect(cache.size()).toBe(5);
      expect(cache.has('a0')).toBe(false);
      expect(cache.has('a5')).toBe(true);
    });

    it('get() promotes entry to most-recently-used', () => {
      for (let i = 0; i < 5; i++) {
        cache.set(`a${i}`, { v: i });
      }
      // Access a0 to promote it
      cache.get('a0');
      // Add new entry: should evict a1 (now the oldest), not a0
      cache.set('a5', { v: 5 });
      expect(cache.has('a0')).toBe(true);
      expect(cache.has('a1')).toBe(false);
    });
  });

  describe('delete()', () => {
    it('removes entry and returns true', () => {
      cache.set('a1', { x: 1 });
      expect(cache.delete('a1')).toBe(true);
      expect(cache.has('a1')).toBe(false);
    });

    it('returns false for non-existent key', () => {
      expect(cache.delete('nonexistent')).toBe(false);
    });

    it('throws on invalid id', () => {
      expect(() => cache.delete('')).toThrow('ID must be a non-empty string');
    });

    it('updates totalSize correctly', () => {
      cache.set('a1', { x: 1 });
      const sizeBefore = cache.getTotalSize();
      cache.delete('a1');
      expect(cache.getTotalSize()).toBeLessThan(sizeBefore);
    });
  });

  describe('has()', () => {
    it('returns false for empty cache', () => {
      expect(cache.has('a1')).toBe(false);
    });

    it('returns true for existing entry', () => {
      cache.set('a1', { x: 1 });
      expect(cache.has('a1')).toBe(true);
    });
  });

  describe('clear()', () => {
    it('removes all entries and resets size', () => {
      cache.set('a1', { x: 1 });
      cache.set('a2', { x: 2 });
      cache.clear();
      expect(cache.size()).toBe(0);
      expect(cache.getTotalSize()).toBe(0);
    });
  });

  describe('size() / getTotalSize()', () => {
    it('returns 0 for empty cache', () => {
      expect(cache.size()).toBe(0);
      expect(cache.getTotalSize()).toBe(0);
    });

    it('tracks size correctly', () => {
      cache.set('a1', { x: 1 });
      expect(cache.size()).toBe(1);
      expect(cache.getTotalSize()).toBeGreaterThan(0);
    });
  });

  describe('keys() / values() / entries()', () => {
    it('returns empty arrays for empty cache', () => {
      expect(cache.keys()).toEqual([]);
      expect(cache.values()).toEqual([]);
      expect(cache.entries()).toEqual([]);
    });

    it('keys() returns all IDs', () => {
      cache.set('a1', { v: 1 });
      cache.set('a2', { v: 2 });
      expect(cache.keys()).toEqual(['a1', 'a2']);
    });

    it('values() returns all artifacts', () => {
      cache.set('a1', { v: 1 });
      const vals = cache.values();
      expect(vals).toEqual([{ v: 1 }]);
    });

    it('entries() returns id + artifact + metadata', () => {
      cache.set('a1', { v: 1 });
      const entries = cache.entries();
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe('a1');
      expect(entries[0].artifact).toEqual({ v: 1 });
      expect(entries[0].metadata.size).toBeGreaterThan(0);
      expect(entries[0].metadata.cachedAt).toBeGreaterThan(0);
      expect(entries[0].metadata.accessCount).toBe(0);
    });
  });

  describe('getMetrics()', () => {
    it('tracks hits and misses', () => {
      cache.set('a1', { v: 1 });
      cache.get('a1'); // hit
      cache.get('a2'); // miss

      const metrics = cache.getMetrics();
      expect(metrics.hits).toBe(1);
      expect(metrics.misses).toBe(1);
      expect(metrics.sets).toBe(1);
      expect(metrics.hitRate).toBe('50.00%');
    });

    it('tracks count evictions', () => {
      for (let i = 0; i < 6; i++) {
        cache.set(`a${i}`, { v: i });
      }
      const metrics = cache.getMetrics();
      expect(metrics.evictions).toBeGreaterThan(0);
      expect(metrics.countEvictions).toBeGreaterThan(0);
    });

    it('tracks size evictions when totalSize exceeds maxTotalSize', () => {
      // Each { data: 'x'.repeat(1500) } ≈ 1511 bytes via JSON.stringify.
      // maxTotalSize: 2000 → second insert triggers size eviction of first.
      const smallCache = new ArtifactCache({ maxEntries: 100, maxTotalSize: 2000, maxArtifactSize: 2000 });
      smallCache.set('a1', { data: 'x'.repeat(1500) });
      smallCache.set('a2', { data: 'x'.repeat(1500) });

      const metrics = smallCache.getMetrics();
      expect(metrics.sizeEvictions).toBeGreaterThan(0);
      expect(metrics.evictions).toBeGreaterThan(0);
      // First entry was evicted by size
      expect(smallCache.has('a1')).toBe(false);
      expect(smallCache.has('a2')).toBe(true);
    });

    it('tracks deletes', () => {
      cache.set('a1', { v: 1 });
      cache.delete('a1');
      expect(cache.getMetrics().deletes).toBe(1);
    });
  });

  describe('_calculateSize()', () => {
    it('falls back to default size for circular references', () => {
      // Fallback size is 10KB (10240). Need maxArtifactSize > 10240 to accept it.
      const bigCache = new ArtifactCache({ maxEntries: 10, maxTotalSize: 100000, maxArtifactSize: 20000 });
      const circular = { a: 1 };
      circular.self = circular; // circular reference — JSON.stringify throws
      const result = bigCache.set('circ', circular);
      expect(result).toBe(true);
      expect(bigCache.has('circ')).toBe(true);
      // Fallback size is 10 * 1024 = 10240 bytes
      expect(bigCache.getTotalSize()).toBe(10240);
    });
  });

  describe('resetMetrics()', () => {
    it('resets all metric counters', () => {
      cache.set('a1', { v: 1 });
      cache.get('a1');
      cache.resetMetrics();

      const m = cache.getMetrics();
      expect(m.hits).toBe(0);
      expect(m.misses).toBe(0);
      expect(m.sets).toBe(0);
    });
  });

  describe('getConfig()', () => {
    it('returns frozen config copy', () => {
      const config = cache.getConfig();
      expect(() => { config.maxEntries = 999; }).toThrow();
    });
  });
});
