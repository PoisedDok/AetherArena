'use strict';

const { LRUCache } = require('../../../../src/core/utils/LRUCache');

describe('LRUCache', () => {
  describe('Constructor', () => {
    it('should create with default maxSize and TTL', () => {
      const cache = new LRUCache();
      expect(cache.maxSize).toBe(50);
      expect(cache.ttlMs).toBe(5 * 60 * 1000);
    });

    it('should accept custom maxSize and TTL', () => {
      const cache = new LRUCache(10, 1000);
      expect(cache.maxSize).toBe(10);
      expect(cache.ttlMs).toBe(1000);
    });
  });

  describe('get/set', () => {
    it('should store and retrieve values', () => {
      const cache = new LRUCache();
      cache.set('key1', 'value1');
      expect(cache.get('key1')).toBe('value1');
    });

    it('should return null for missing keys', () => {
      const cache = new LRUCache();
      expect(cache.get('nope')).toBeNull();
    });

    it('should store various value types', () => {
      const cache = new LRUCache();
      cache.set('num', 42);
      cache.set('obj', { a: 1 });
      cache.set('arr', [1, 2]);
      cache.set('null', null);
      expect(cache.get('num')).toBe(42);
      expect(cache.get('obj')).toEqual({ a: 1 });
      expect(cache.get('arr')).toEqual([1, 2]);
      expect(cache.get('null')).toBeNull(); // null is stored but get returns null for missing
    });

    it('should update existing key', () => {
      const cache = new LRUCache();
      cache.set('k', 'v1');
      cache.set('k', 'v2');
      expect(cache.get('k')).toBe('v2');
    });
  });

  describe('LRU eviction', () => {
    it('should evict oldest when at capacity', () => {
      const cache = new LRUCache(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.set('d', 4); // should evict 'a'
      expect(cache.get('a')).toBeNull();
      expect(cache.get('b')).toBe(2);
      expect(cache.get('d')).toBe(4);
    });

    it('should promote accessed items (LRU order)', () => {
      const cache = new LRUCache(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.get('a'); // promote 'a' to most recent
      cache.set('d', 4); // should evict 'b' (oldest after 'a' promoted)
      expect(cache.get('a')).toBe(1);
      expect(cache.get('b')).toBeNull();
      expect(cache.get('c')).toBe(3);
      expect(cache.get('d')).toBe(4);
    });
  });

  describe('TTL expiration', () => {
    it('should expire entries after TTL', () => {
      jest.useFakeTimers();
      const cache = new LRUCache(50, 100); // 100ms TTL
      cache.set('k', 'v');
      expect(cache.get('k')).toBe('v');
      jest.advanceTimersByTime(150);
      expect(cache.get('k')).toBeNull();
      jest.useRealTimers();
    });

    it('should not expire entries before TTL', () => {
      jest.useFakeTimers();
      const cache = new LRUCache(50, 1000);
      cache.set('k', 'v');
      jest.advanceTimersByTime(500);
      expect(cache.get('k')).toBe('v');
      jest.useRealTimers();
    });
  });

  describe('has()', () => {
    it('should return true for existing non-expired keys', () => {
      const cache = new LRUCache();
      cache.set('k', 'v');
      expect(cache.has('k')).toBe(true);
    });

    it('should return false for missing keys', () => {
      const cache = new LRUCache();
      expect(cache.has('nope')).toBe(false);
    });

    it('should return false for expired keys', () => {
      jest.useFakeTimers();
      const cache = new LRUCache(50, 100);
      cache.set('k', 'v');
      jest.advanceTimersByTime(150);
      expect(cache.has('k')).toBe(false);
      jest.useRealTimers();
    });
  });

  describe('invalidate()', () => {
    it('should remove specific key', () => {
      const cache = new LRUCache();
      cache.set('k', 'v');
      cache.invalidate('k');
      expect(cache.get('k')).toBeNull();
    });

    it('should not throw for non-existent key', () => {
      const cache = new LRUCache();
      expect(() => cache.invalidate('nope')).not.toThrow();
    });
  });

  describe('clear()', () => {
    it('should remove all entries', () => {
      const cache = new LRUCache();
      cache.set('a', 1);
      cache.set('b', 2);
      cache.clear();
      expect(cache.get('a')).toBeNull();
      expect(cache.get('b')).toBeNull();
    });
  });
});
