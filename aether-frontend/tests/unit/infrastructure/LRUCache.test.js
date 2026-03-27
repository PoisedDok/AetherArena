'use strict';

/**
 * LRUCache Unit Tests
 * ============================================================================
 * Tests the LRU cache: get/set/has/invalidate/clear, TTL expiration,
 * capacity eviction, and LRU ordering.
 *
 * @module tests/unit/infrastructure/LRUCache.test
 */

const { LRUCache } = require('../../../src/infrastructure/cache/LRUCache');

describe('LRUCache', () => {
  let cache;

  beforeEach(() => {
    cache = new LRUCache(3, 5000); // max 3, 5s TTL
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('creates with defaults', () => {
      const c = new LRUCache();
      expect(c.maxSize).toBe(50);
      expect(c.ttlMs).toBe(5 * 60 * 1000);
      expect(c.cache).toBeInstanceOf(Map);
    });

    it('accepts custom size and TTL', () => {
      expect(cache.maxSize).toBe(3);
      expect(cache.ttlMs).toBe(5000);
    });
  });

  // =========================================================================
  // set() + get()
  // =========================================================================

  describe('set() and get()', () => {
    it('stores and retrieves a value', () => {
      cache.set('k', 'v');
      expect(cache.get('k')).toBe('v');
    });

    it('returns null for missing key', () => {
      expect(cache.get('missing')).toBeNull();
    });

    it('overwrites existing key', () => {
      cache.set('k', 'v1');
      cache.set('k', 'v2');
      expect(cache.get('k')).toBe('v2');
    });

    it('stores objects', () => {
      const obj = { a: 1, b: [2, 3] };
      cache.set('obj', obj);
      expect(cache.get('obj')).toBe(obj);
    });
  });

  // =========================================================================
  // TTL expiration
  // =========================================================================

  describe('TTL expiration', () => {
    it('returns null for expired entry', () => {
      cache = new LRUCache(3, 50); // 50ms TTL
      cache.set('k', 'v');
      // Manually expire by adjusting timestamp
      const entry = cache.cache.get('k');
      entry.timestamp = Date.now() - 100;
      expect(cache.get('k')).toBeNull();
    });

    it('deletes expired entry from cache', () => {
      cache = new LRUCache(3, 50);
      cache.set('k', 'v');
      const entry = cache.cache.get('k');
      entry.timestamp = Date.now() - 100;
      cache.get('k'); // triggers deletion
      expect(cache.cache.has('k')).toBe(false);
    });
  });

  // =========================================================================
  // LRU eviction
  // =========================================================================

  describe('LRU eviction', () => {
    it('evicts oldest entry when at capacity', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.set('d', 4); // should evict 'a'

      expect(cache.get('a')).toBeNull();
      expect(cache.get('b')).toBe(2);
      expect(cache.get('c')).toBe(3);
      expect(cache.get('d')).toBe(4);
    });

    it('accessing entry moves it to most-recently-used', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.get('a'); // touch 'a' -- moves it to MRU
      cache.set('d', 4); // should evict 'b' (oldest after 'a' was touched)

      expect(cache.get('a')).toBe(1); // still here
      expect(cache.get('b')).toBeNull(); // evicted
    });
  });

  // =========================================================================
  // has()
  // =========================================================================

  describe('has()', () => {
    it('returns true for existing key', () => {
      cache.set('k', 'v');
      expect(cache.has('k')).toBe(true);
    });

    it('returns false for missing key', () => {
      expect(cache.has('missing')).toBe(false);
    });

    it('returns false for expired key', () => {
      cache = new LRUCache(3, 50);
      cache.set('k', 'v');
      const entry = cache.cache.get('k');
      entry.timestamp = Date.now() - 100;
      expect(cache.has('k')).toBe(false);
    });
  });

  // =========================================================================
  // invalidate()
  // =========================================================================

  describe('invalidate()', () => {
    it('removes entry from cache', () => {
      cache.set('k', 'v');
      cache.invalidate('k');
      expect(cache.get('k')).toBeNull();
    });

    it('does nothing for missing key', () => {
      cache.invalidate('missing'); // should not throw
    });
  });

  // =========================================================================
  // clear()
  // =========================================================================

  describe('clear()', () => {
    it('empties the cache', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.clear();
      expect(cache.get('a')).toBeNull();
      expect(cache.get('b')).toBeNull();
      expect(cache.cache.size).toBe(0);
    });
  });
});
