/** @jest-environment jsdom */
'use strict';

/**
 * LocalStorage Unit Tests
 * ============================================================================
 * Tests the browser localStorage wrapper: set/get/remove/has/clear, namespace
 * support, JSON serialization with metadata, QuotaExceededError handling,
 * in-memory fallback, keys listing, stats, cleanup, enableLogging, and
 * window global export.
 *
 * @module tests/unit/infrastructure/LocalStorage.test
 */

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import SUT
// ---------------------------------------------------------------------------

const { LocalStorage } = require('../../../src/infrastructure/persistence/LocalStorage');

// ===========================================================================
// Tests
// ===========================================================================

describe('LocalStorage', () => {
  let storage;

  beforeEach(() => {
    localStorage.clear();
    storage = new LocalStorage();
  });

  // =========================================================================
  // constructor
  // =========================================================================
  describe('constructor', () => {
    it('defaults namespace to "aether"', () => {
      expect(storage.namespace).toBe('aether');
    });

    it('accepts custom namespace', () => {
      const s = new LocalStorage({ namespace: 'test-ns' });
      expect(s.namespace).toBe('test-ns');
    });

    it('defaults enableLogging to false', () => {
      expect(storage.enableLogging).toBe(false);
    });

    it('sets enableLogging when provided', () => {
      const s = new LocalStorage({ enableLogging: true });
      expect(s.enableLogging).toBe(true);
    });

    it('detects localStorage availability', () => {
      expect(storage.available).toBe(true);
    });

    it('uses in-memory fallback when localStorage unavailable', () => {
      // Force unavailability by making _checkAvailability return false
      const origCheck = LocalStorage.prototype._checkAvailability;
      LocalStorage.prototype._checkAvailability = () => false;
      const s = new LocalStorage();
      expect(s.available).toBe(false);
      expect(s.fallback).toBeInstanceOf(Map);
      LocalStorage.prototype._checkAvailability = origCheck;
    });
  });

  // =========================================================================
  // set / get
  // =========================================================================
  describe('set()', () => {
    it('stores value and returns true', () => {
      const result = storage.set('key1', 'value1');
      expect(result).toBe(true);
    });

    it('wraps value in JSON with metadata', () => {
      storage.set('key1', { data: 42 });
      const raw = localStorage.getItem('aether:key1');
      const parsed = JSON.parse(raw);
      expect(parsed.value).toEqual({ data: 42 });
      expect(parsed.version).toBe(1);
      expect(typeof parsed.timestamp).toBe('number');
    });

    it('handles QuotaExceededError with cleanup and retry', () => {
      let callCount = 0;
      const origSetItem = localStorage.setItem.bind(localStorage);

      // Pre-populate some data for cleanup to work
      origSetItem('aether:old1', JSON.stringify({ value: 'old', timestamp: 1000 }));

      const origFn = Storage.prototype.setItem;
      Storage.prototype.setItem = function(k, v) {
        callCount++;
        if (callCount === 1) {
          const err = new DOMException('quota exceeded', 'QuotaExceededError');
          throw err;
        }
        return origFn.call(this, k, v);
      };

      const result = storage.set('newKey', 'newValue');
      expect(result).toBe(true);
      Storage.prototype.setItem = origFn;
    });

    it('returns false when retry after QuotaExceededError also fails', () => {
      const origFn = Storage.prototype.setItem;
      Storage.prototype.setItem = function() {
        const err = new DOMException('quota exceeded', 'QuotaExceededError');
        throw err;
      };
      const result = storage.set('key', 'val');
      expect(result).toBe(false);
      Storage.prototype.setItem = origFn;
    });

    it('returns false on non-quota error', () => {
      const origFn = Storage.prototype.setItem;
      Storage.prototype.setItem = function() {
        throw new Error('generic error');
      };
      const result = storage.set('key', 'val');
      expect(result).toBe(false);
      Storage.prototype.setItem = origFn;
    });
  });

  describe('get()', () => {
    it('retrieves stored value', () => {
      storage.set('key1', 'hello');
      expect(storage.get('key1')).toBe('hello');
    });

    it('returns defaultValue when key not found', () => {
      expect(storage.get('missing', 'default')).toBe('default');
    });

    it('returns null as default when no defaultValue specified', () => {
      expect(storage.get('missing')).toBeNull();
    });

    it('handles complex objects', () => {
      storage.set('complex', { nested: { arr: [1, 2, 3] } });
      expect(storage.get('complex')).toEqual({ nested: { arr: [1, 2, 3] } });
    });

    it('returns defaultValue on parse error', () => {
      localStorage.setItem('aether:corrupt', 'not-json');
      expect(storage.get('corrupt', 'fallback')).toBe('fallback');
    });
  });

  // =========================================================================
  // remove / has
  // =========================================================================
  describe('remove()', () => {
    it('removes existing key and returns true', () => {
      storage.set('key1', 'val');
      const result = storage.remove('key1');
      expect(result).toBe(true);
      expect(storage.get('key1')).toBeNull();
    });

    it('returns true even for non-existent key', () => {
      expect(storage.remove('nonexistent')).toBe(true);
    });

    it('returns false on error', () => {
      const origFn = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function() {
        throw new Error('fail');
      };
      expect(storage.remove('key')).toBe(false);
      Storage.prototype.removeItem = origFn;
    });
  });

  describe('has()', () => {
    it('returns true when key exists', () => {
      storage.set('key1', 'val');
      expect(storage.has('key1')).toBe(true);
    });

    it('returns false when key does not exist', () => {
      expect(storage.has('missing')).toBe(false);
    });
  });

  // =========================================================================
  // clear
  // =========================================================================
  describe('clear()', () => {
    it('removes only keys in namespace', () => {
      storage.set('key1', 'val1');
      storage.set('key2', 'val2');
      localStorage.setItem('other:key', 'should-stay');

      const removed = storage.clear();
      expect(removed).toBe(2);
      expect(storage.get('key1')).toBeNull();
      expect(localStorage.getItem('other:key')).toBe('should-stay');
    });

    it('returns 0 when no keys in namespace', () => {
      expect(storage.clear()).toBe(0);
    });
  });

  // =========================================================================
  // keys
  // =========================================================================
  describe('keys()', () => {
    it('returns keys without namespace prefix', () => {
      storage.set('alpha', 1);
      storage.set('beta', 2);
      const keys = storage.keys();
      expect(keys).toContain('alpha');
      expect(keys).toContain('beta');
      expect(keys).toHaveLength(2);
    });

    it('excludes keys from other namespaces', () => {
      storage.set('mine', 1);
      localStorage.setItem('other:theirs', 'x');
      expect(storage.keys()).toEqual(['mine']);
    });

    it('returns empty array when no keys', () => {
      expect(storage.keys()).toEqual([]);
    });
  });

  // =========================================================================
  // getStats
  // =========================================================================
  describe('getStats()', () => {
    it('returns frozen stats object', () => {
      const stats = storage.getStats();
      expect(Object.isFrozen(stats)).toBe(true);
    });

    it('has expected fields', () => {
      const stats = storage.getStats();
      expect(stats).toHaveProperty('available', true);
      expect(stats).toHaveProperty('namespace', 'aether');
      expect(stats).toHaveProperty('keyCount');
      expect(stats).toHaveProperty('estimatedSize');
    });

    it('reflects stored data count', () => {
      storage.set('a', 1);
      storage.set('b', 2);
      expect(storage.getStats().keyCount).toBe(2);
    });

    it('estimates size of stored data', () => {
      storage.set('data', 'hello world');
      expect(storage.getStats().estimatedSize).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // _getFullKey / _checkAvailability
  // =========================================================================
  describe('_getFullKey()', () => {
    it('prefixes key with namespace', () => {
      expect(storage._getFullKey('test')).toBe('aether:test');
    });

    it('works with custom namespace', () => {
      const s = new LocalStorage({ namespace: 'custom' });
      expect(s._getFullKey('key')).toBe('custom:key');
    });
  });

  describe('_checkAvailability()', () => {
    it('returns true when localStorage works', () => {
      expect(storage._checkAvailability()).toBe(true);
    });
  });

  // =========================================================================
  // _cleanup
  // =========================================================================
  describe('_cleanup()', () => {
    it('removes oldest 25% of entries', () => {
      // Add 4 entries with different timestamps
      localStorage.setItem('aether:old1', JSON.stringify({ value: 1, timestamp: 100 }));
      localStorage.setItem('aether:old2', JSON.stringify({ value: 2, timestamp: 200 }));
      localStorage.setItem('aether:new1', JSON.stringify({ value: 3, timestamp: 300 }));
      localStorage.setItem('aether:new2', JSON.stringify({ value: 4, timestamp: 400 }));

      storage._cleanup();

      // 25% of 4 = 1, so oldest entry should be removed
      expect(localStorage.getItem('aether:old1')).toBeNull();
      // Newer entries should remain
      expect(localStorage.getItem('aether:new2')).not.toBeNull();
    });

    it('handles invalid JSON entries by marking timestamp as 0', () => {
      localStorage.setItem('aether:corrupt', 'not-json');
      localStorage.setItem('aether:valid', JSON.stringify({ value: 1, timestamp: 999 }));

      storage._cleanup();
      // corrupt (timestamp 0) is oldest, should be removed first
      expect(localStorage.getItem('aether:corrupt')).toBeNull();
    });
  });

  // =========================================================================
  // In-memory fallback
  // =========================================================================
  describe('in-memory fallback', () => {
    let fallbackStorage;

    beforeEach(() => {
      const origCheck = LocalStorage.prototype._checkAvailability;
      LocalStorage.prototype._checkAvailability = () => false;
      fallbackStorage = new LocalStorage();
      LocalStorage.prototype._checkAvailability = origCheck;
    });

    it('set/get works via fallback Map', () => {
      expect(fallbackStorage.set('key', 'value')).toBe(true);
      expect(fallbackStorage.get('key')).toBe('value');
    });

    it('remove works via fallback Map', () => {
      fallbackStorage.set('key', 'value');
      expect(fallbackStorage.remove('key')).toBe(true);
      expect(fallbackStorage.get('key')).toBeNull();
    });

    it('has works via fallback Map', () => {
      fallbackStorage.set('key', 'value');
      expect(fallbackStorage.has('key')).toBe(true);
      expect(fallbackStorage.has('missing')).toBe(false);
    });

    it('clear works via fallback Map', () => {
      fallbackStorage.set('a', 1);
      fallbackStorage.set('b', 2);
      const removed = fallbackStorage.clear();
      expect(removed).toBe(2);
    });

    it('keys works via fallback Map', () => {
      fallbackStorage.set('x', 1);
      fallbackStorage.set('y', 2);
      const keys = fallbackStorage.keys();
      expect(keys).toContain('x');
      expect(keys).toContain('y');
    });
  });

  // =========================================================================
  // enableLogging branches
  // =========================================================================
  describe('enableLogging branches', () => {
    let logStorage;

    beforeEach(() => {
      logStorage = new LocalStorage({ enableLogging: true });
    });

    it('logs on set', () => {
      logStorage.set('key', 'val');
      // Logger is module-scoped _log, not instance-level; just verify no throw
      expect(logStorage.get('key')).toBe('val');
    });

    it('logs on get', () => {
      logStorage.set('key', 'val');
      expect(logStorage.get('key')).toBe('val');
    });

    it('logs on remove', () => {
      logStorage.set('key', 'val');
      expect(logStorage.remove('key')).toBe(true);
    });

    it('logs on clear', () => {
      logStorage.set('key', 'val');
      expect(logStorage.clear()).toBe(1);
    });
  });

  // =========================================================================
  // window global export
  // =========================================================================
  describe('window global export', () => {
    it('attaches LocalStorage to window when defined', () => {
      jest.isolateModules(() => {
        jest.mock('../../../src/renderer/shared/utils/logger', () => ({
          createRendererLogger: () => ({
            info: jest.fn(), warn: jest.fn(), error: jest.fn(),
            debug: jest.fn(), trace: jest.fn(),
          }),
        }));
        // jsdom provides window
        const { LocalStorage: LS } = require('../../../src/infrastructure/persistence/LocalStorage');
        expect(window.LocalStorage).toBe(LS);
      });
    });
  });

  // =========================================================================
  // Full lifecycle
  // =========================================================================
  describe('full lifecycle', () => {
    it('set -> get -> has -> keys -> clear -> verify empty', () => {
      storage.set('a', 'alpha');
      storage.set('b', 'beta');

      expect(storage.get('a')).toBe('alpha');
      expect(storage.has('a')).toBe(true);
      expect(storage.keys()).toHaveLength(2);

      const removed = storage.clear();
      expect(removed).toBe(2);
      expect(storage.keys()).toHaveLength(0);
      expect(storage.has('a')).toBe(false);
    });
  });
});
