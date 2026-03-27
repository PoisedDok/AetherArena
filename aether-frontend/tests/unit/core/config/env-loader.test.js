'use strict';

/**
 * EnvLoader Unit Tests
 * ============================================================================
 * Tests constructor, init (idempotency, process.env loading, window.env loading,
 * prefix filtering, precedence), get (cache/process/window fallback, default),
 * getString/getInt/getBool/getFloat (delegation to validators), has, getWithPrefix,
 * getAll, reload, clear, set, size, singleton export.
 *
 * @module tests/unit/core/config/env-loader.test
 */

describe('EnvLoader', () => {
  let EnvLoader;
  let loader;

  // Save/restore process.env to avoid leaking between tests
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.isolateModules(() => {
      ({ EnvLoader } = require('../../../../src/core/config/env-loader'));
    });
    loader = new EnvLoader();
    // Clean up any leftover env from prior test
    Object.keys(process.env).forEach(k => {
      if (k.startsWith('AETHER_TEST_') || k.startsWith('GURU_TEST_')) {
        delete process.env[k];
      }
    });
    delete global.window;
  });

  afterEach(() => {
    delete global.window;
    // Restore keys we may have set
    Object.keys(process.env).forEach(k => {
      if (k.startsWith('AETHER_TEST_') || k.startsWith('GURU_TEST_')) {
        delete process.env[k];
      }
    });
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('creates instance with empty cache', () => {
      expect(loader._cache.size).toBe(0);
    });

    it('is not initialized', () => {
      expect(loader._initialized).toBe(false);
    });

    it('has default prefixes from DEFAULTS', () => {
      expect(loader._prefixes).toContain('AETHER_');
      expect(loader._prefixes).toContain('GURU_');
      expect(loader._prefixes).toContain('LM_STUDIO_');
      expect(loader._prefixes).toContain('ELECTRON_');
    });
  });

  // =========================================================================
  // init
  // =========================================================================

  describe('init', () => {
    it('sets _initialized to true', () => {
      loader.init();
      expect(loader._initialized).toBe(true);
    });

    it('is idempotent (second call does not reload)', () => {
      process.env.AETHER_TEST_INIT = 'first';
      loader.init();
      const sizeAfterFirst = loader._cache.size;
      process.env.AETHER_TEST_INIT2 = 'second';
      loader.init(); // should no-op
      expect(loader._cache.size).toBe(sizeAfterFirst);
      delete process.env.AETHER_TEST_INIT;
      delete process.env.AETHER_TEST_INIT2;
    });

    it('loads matching process.env variables', () => {
      process.env.AETHER_TEST_FOO = 'bar';
      loader.init();
      expect(loader._cache.get('AETHER_TEST_FOO')).toBe('bar');
      delete process.env.AETHER_TEST_FOO;
    });

    it('ignores non-matching prefixes', () => {
      process.env.MY_CUSTOM_VAR = 'nope';
      loader.init();
      expect(loader._cache.has('MY_CUSTOM_VAR')).toBe(false);
      delete process.env.MY_CUSTOM_VAR;
    });

    it('loads from window.env when available', () => {
      global.window = { env: { GURU_TEST_WIN: 'winval' } };
      loader.init();
      expect(loader._cache.get('GURU_TEST_WIN')).toBe('winval');
    });

    it('process.env takes precedence over window.env', () => {
      process.env.AETHER_TEST_PREC = 'fromProcess';
      global.window = { env: { AETHER_TEST_PREC: 'fromWindow' } };
      loader.init();
      expect(loader._cache.get('AETHER_TEST_PREC')).toBe('fromProcess');
      delete process.env.AETHER_TEST_PREC;
    });

    it('logs count when variables found', () => {
      process.env.AETHER_TEST_LOG = 'val';
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      loader.init();
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('[EnvLoader] Initialized with'));
      spy.mockRestore();
      delete process.env.AETHER_TEST_LOG;
    });

    it('does not log when no matching variables', () => {
      // Remove any AETHER_/GURU_/LM_STUDIO_/ELECTRON_ vars for this test
      const saved = {};
      for (const k of Object.keys(process.env)) {
        if (loader._shouldInclude(k)) {
          saved[k] = process.env[k];
          delete process.env[k];
        }
      }
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      loader.init();
      const initCalls = spy.mock.calls.filter(c =>
        typeof c[0] === 'string' && c[0].includes('[EnvLoader]')
      );
      expect(initCalls).toHaveLength(0);
      spy.mockRestore();
      // Restore
      Object.assign(process.env, saved);
    });
  });

  // =========================================================================
  // get
  // =========================================================================

  describe('get', () => {
    it('returns cached value', () => {
      loader._cache.set('AETHER_TEST_X', '123');
      loader._initialized = true;
      expect(loader.get('AETHER_TEST_X')).toBe('123');
    });

    it('falls back to process.env if not cached', () => {
      process.env.AETHER_TEST_FB = 'fallback';
      loader._initialized = true;
      expect(loader.get('AETHER_TEST_FB')).toBe('fallback');
      // Also caches it
      expect(loader._cache.get('AETHER_TEST_FB')).toBe('fallback');
      delete process.env.AETHER_TEST_FB;
    });

    it('falls back to window.env if not in cache or process.env', () => {
      global.window = { env: { GURU_TEST_WINFB: 'winfb' } };
      loader._initialized = true;
      expect(loader.get('GURU_TEST_WINFB')).toBe('winfb');
      expect(loader._cache.get('GURU_TEST_WINFB')).toBe('winfb');
    });

    it('returns defaultValue when key not found anywhere', () => {
      loader._initialized = true;
      expect(loader.get('NONEXISTENT_KEY', 'myDefault')).toBe('myDefault');
    });

    it('returns undefined when no default provided', () => {
      loader._initialized = true;
      expect(loader.get('NONEXISTENT_KEY')).toBeUndefined();
    });

    it('auto-initializes if not yet initialized', () => {
      expect(loader._initialized).toBe(false);
      loader.get('SOME_KEY');
      expect(loader._initialized).toBe(true);
    });
  });

  // =========================================================================
  // getString
  // =========================================================================

  describe('getString', () => {
    it('returns string value from cache', () => {
      loader._cache.set('AETHER_TEST_STR', 'hello');
      loader._initialized = true;
      expect(loader.getString('AETHER_TEST_STR')).toBe('hello');
    });

    it('returns default when key not found', () => {
      loader._initialized = true;
      expect(loader.getString('NONEXISTENT', 'def')).toBe('def');
    });

    it('returns empty string by default', () => {
      loader._initialized = true;
      expect(loader.getString('NONEXISTENT')).toBe('');
    });
  });

  // =========================================================================
  // getInt
  // =========================================================================

  describe('getInt', () => {
    it('returns parsed integer from cache', () => {
      loader._cache.set('AETHER_TEST_INT', '42');
      loader._initialized = true;
      expect(loader.getInt('AETHER_TEST_INT', 0, 0, 100)).toBe(42);
    });

    it('returns default for non-numeric values', () => {
      loader._cache.set('AETHER_TEST_NAN', 'notanumber');
      loader._initialized = true;
      expect(loader.getInt('AETHER_TEST_NAN', 7, 0, 100)).toBe(7);
    });

    it('returns default when key not found', () => {
      loader._initialized = true;
      expect(loader.getInt('NONEXISTENT', 99)).toBe(99);
    });
  });

  // =========================================================================
  // getBool
  // =========================================================================

  describe('getBool', () => {
    it('returns true for "true"', () => {
      loader._cache.set('AETHER_TEST_BOOL', 'true');
      loader._initialized = true;
      expect(loader.getBool('AETHER_TEST_BOOL')).toBe(true);
    });

    it('returns false for "false"', () => {
      loader._cache.set('AETHER_TEST_BOOL2', 'false');
      loader._initialized = true;
      expect(loader.getBool('AETHER_TEST_BOOL2')).toBe(false);
    });

    it('returns default for unrecognised value', () => {
      loader._cache.set('AETHER_TEST_BOOLX', 'maybe');
      loader._initialized = true;
      expect(loader.getBool('AETHER_TEST_BOOLX', true)).toBe(true);
    });

    it('returns default when key not found', () => {
      loader._initialized = true;
      expect(loader.getBool('NONEXISTENT', false)).toBe(false);
    });
  });

  // =========================================================================
  // getFloat
  // =========================================================================

  describe('getFloat', () => {
    it('returns parsed float from cache', () => {
      loader._cache.set('AETHER_TEST_FLOAT', '3.14');
      loader._initialized = true;
      const val = loader.getFloat('AETHER_TEST_FLOAT', 0, 0, 10);
      expect(val).toBeCloseTo(3.14);
    });

    it('returns default for non-float values', () => {
      loader._cache.set('AETHER_TEST_NANF', 'abc');
      loader._initialized = true;
      expect(loader.getFloat('AETHER_TEST_NANF', 1.5)).toBeCloseTo(1.5);
    });
  });

  // =========================================================================
  // has
  // =========================================================================

  describe('has', () => {
    it('returns true when key in cache', () => {
      loader._cache.set('AETHER_TEST_HAS', 'yes');
      loader._initialized = true;
      expect(loader.has('AETHER_TEST_HAS')).toBe(true);
    });

    it('returns true when key in process.env but not cache', () => {
      process.env.AETHER_TEST_HAS2 = 'yes';
      loader._initialized = true;
      expect(loader.has('AETHER_TEST_HAS2')).toBe(true);
      delete process.env.AETHER_TEST_HAS2;
    });

    it('returns true when key in window.env but not cache', () => {
      global.window = { env: { GURU_TEST_HAS3: 'yes' } };
      loader._initialized = true;
      expect(loader.has('GURU_TEST_HAS3')).toBe(true);
    });

    it('returns false when key not found anywhere', () => {
      loader._initialized = true;
      expect(loader.has('TOTALLY_UNKNOWN')).toBe(false);
    });

    it('auto-initializes if not initialized', () => {
      expect(loader._initialized).toBe(false);
      loader.has('ANY');
      expect(loader._initialized).toBe(true);
    });
  });

  // =========================================================================
  // getWithPrefix
  // =========================================================================

  describe('getWithPrefix', () => {
    it('returns filtered subset', () => {
      loader._cache.set('AETHER_TEST_A', '1');
      loader._cache.set('AETHER_TEST_B', '2');
      loader._cache.set('GURU_TEST_C', '3');
      loader._initialized = true;
      const result = loader.getWithPrefix('AETHER_TEST_');
      expect(result).toEqual({ AETHER_TEST_A: '1', AETHER_TEST_B: '2' });
    });

    it('returns empty object when no matches', () => {
      loader._initialized = true;
      const result = loader.getWithPrefix('ZZZZZ_');
      expect(result).toEqual({});
    });

    it('auto-initializes if not initialized', () => {
      loader.getWithPrefix('X_');
      expect(loader._initialized).toBe(true);
    });
  });

  // =========================================================================
  // getAll
  // =========================================================================

  describe('getAll', () => {
    it('returns all cached variables as plain object', () => {
      loader._cache.set('AETHER_TEST_ALL1', 'a');
      loader._cache.set('GURU_TEST_ALL2', 'b');
      loader._initialized = true;
      const all = loader.getAll();
      expect(all.AETHER_TEST_ALL1).toBe('a');
      expect(all.GURU_TEST_ALL2).toBe('b');
    });

    it('auto-initializes if not initialized', () => {
      loader.getAll();
      expect(loader._initialized).toBe(true);
    });
  });

  // =========================================================================
  // reload
  // =========================================================================

  describe('reload', () => {
    it('clears cache and re-initializes', () => {
      loader._cache.set('AETHER_TEST_OLD', 'old');
      loader._initialized = true;
      // Add new env var
      process.env.AETHER_TEST_NEW = 'new';
      loader.reload();
      expect(loader._initialized).toBe(true);
      expect(loader._cache.has('AETHER_TEST_OLD')).toBe(false);
      expect(loader._cache.get('AETHER_TEST_NEW')).toBe('new');
      delete process.env.AETHER_TEST_NEW;
    });
  });

  // =========================================================================
  // clear
  // =========================================================================

  describe('clear', () => {
    it('empties cache and sets initialized to false', () => {
      loader._cache.set('X', 'y');
      loader._initialized = true;
      loader.clear();
      expect(loader._cache.size).toBe(0);
      expect(loader._initialized).toBe(false);
    });
  });

  // =========================================================================
  // set
  // =========================================================================

  describe('set', () => {
    it('adds value to cache', () => {
      loader.set('AETHER_TEST_SET', 'val');
      expect(loader._cache.get('AETHER_TEST_SET')).toBe('val');
    });

    it('overwrites existing value', () => {
      loader.set('AETHER_TEST_SET', 'v1');
      loader.set('AETHER_TEST_SET', 'v2');
      expect(loader._cache.get('AETHER_TEST_SET')).toBe('v2');
    });
  });

  // =========================================================================
  // size
  // =========================================================================

  describe('size', () => {
    it('returns cache size', () => {
      expect(loader.size).toBe(0);
      loader.set('A', '1');
      expect(loader.size).toBe(1);
      loader.set('B', '2');
      expect(loader.size).toBe(2);
    });
  });

  // =========================================================================
  // Singleton export
  // =========================================================================

  describe('singleton export', () => {
    it('exports envLoader as singleton instance of EnvLoader', () => {
      const mod = require('../../../../src/core/config/env-loader');
      expect(mod.envLoader).toBeInstanceOf(mod.EnvLoader);
    });

    it('same require returns same singleton', () => {
      const a = require('../../../../src/core/config/env-loader');
      const b = require('../../../../src/core/config/env-loader');
      expect(a.envLoader).toBe(b.envLoader);
    });
  });
});
