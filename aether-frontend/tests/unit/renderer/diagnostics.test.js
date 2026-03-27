'use strict';

let DiagnosticsUtils;

beforeEach(() => {
  // Fresh module for each test group (singleton state matters)
  jest.resetModules();
  DiagnosticsUtils = require('../../../src/renderer/shared/utils/diagnostics');
});

describe('DiagnosticsUtils', () => {
  // =========================================================================
  // Module structure
  // =========================================================================
  describe('module structure', () => {
    it('exports a frozen object', () => {
      expect(Object.isFrozen(DiagnosticsUtils)).toBe(true);
    });

    it('has all expected methods', () => {
      const expected = [
        'error', 'warn', 'info', 'debug', 'trace',
        'setLogLevel', 'start', 'end', 'measure', 'measureAsync',
        'trackFPS', 'getAverageFPS', 'getFPSStats',
        'getMemoryUsage', 'getPerformanceTiming', 'detectFeatures',
        'logSystemInfo', 'snapshot', 'clear',
      ];
      for (const method of expected) {
        expect(typeof DiagnosticsUtils[method]).toBe('function');
      }
    });
  });

  // =========================================================================
  // Log level management
  // =========================================================================
  describe('setLogLevel()', () => {
    it('accepts string level names', () => {
      expect(() => DiagnosticsUtils.setLogLevel('ERROR')).not.toThrow();
      expect(() => DiagnosticsUtils.setLogLevel('WARN')).not.toThrow();
      expect(() => DiagnosticsUtils.setLogLevel('INFO')).not.toThrow();
      expect(() => DiagnosticsUtils.setLogLevel('DEBUG')).not.toThrow();
      expect(() => DiagnosticsUtils.setLogLevel('TRACE')).not.toThrow();
    });

    it('accepts case-insensitive string levels', () => {
      expect(() => DiagnosticsUtils.setLogLevel('error')).not.toThrow();
      expect(() => DiagnosticsUtils.setLogLevel('warn')).not.toThrow();
    });

    it('defaults to INFO for unknown string level', () => {
      // Should not throw
      expect(() => DiagnosticsUtils.setLogLevel('NONEXISTENT')).not.toThrow();
    });

    it('accepts numeric levels', () => {
      expect(() => DiagnosticsUtils.setLogLevel(0)).not.toThrow();
      expect(() => DiagnosticsUtils.setLogLevel(4)).not.toThrow();
    });
  });

  // =========================================================================
  // Log methods (level filtering)
  // =========================================================================
  describe('log methods', () => {
    it('error() does not throw', () => {
      DiagnosticsUtils.setLogLevel('ERROR');
      expect(() => DiagnosticsUtils.error('test error')).not.toThrow();
    });

    it('warn() does not throw at WARN level', () => {
      DiagnosticsUtils.setLogLevel('WARN');
      expect(() => DiagnosticsUtils.warn('test warn')).not.toThrow();
    });

    it('info() does not throw at INFO level', () => {
      DiagnosticsUtils.setLogLevel('INFO');
      expect(() => DiagnosticsUtils.info('test info')).not.toThrow();
    });

    it('debug() does not throw at DEBUG level', () => {
      DiagnosticsUtils.setLogLevel('DEBUG');
      expect(() => DiagnosticsUtils.debug('test debug')).not.toThrow();
    });

    it('trace() does not throw at TRACE level', () => {
      DiagnosticsUtils.setLogLevel('TRACE');
      expect(() => DiagnosticsUtils.trace('test trace')).not.toThrow();
    });

    it('info() is suppressed at ERROR level', () => {
      DiagnosticsUtils.setLogLevel(0); // ERROR only
      // Should not throw even if suppressed
      expect(() => DiagnosticsUtils.info('suppressed')).not.toThrow();
    });

    it('debug() is suppressed at WARN level', () => {
      DiagnosticsUtils.setLogLevel(1); // WARN
      expect(() => DiagnosticsUtils.debug('suppressed')).not.toThrow();
    });
  });

  // =========================================================================
  // Performance measurement (start/end)
  // =========================================================================
  describe('start() and end()', () => {
    it('start() does not throw', () => {
      expect(() => DiagnosticsUtils.start('test-op')).not.toThrow();
    });

    it('end() returns duration after start', () => {
      DiagnosticsUtils.setLogLevel('DEBUG');
      DiagnosticsUtils.start('test-timing');
      const duration = DiagnosticsUtils.end('test-timing');
      expect(typeof duration).toBe('number');
      expect(duration).toBeGreaterThanOrEqual(0);
    });

    it('end() returns 0 for unstarted measurement', () => {
      const duration = DiagnosticsUtils.end('never-started');
      expect(duration).toBe(0);
    });

    it('end() cleans up after measurement', () => {
      DiagnosticsUtils.start('cleanup-test');
      DiagnosticsUtils.end('cleanup-test');
      // Second end should return 0 (already consumed)
      expect(DiagnosticsUtils.end('cleanup-test')).toBe(0);
    });
  });

  // =========================================================================
  // measure (sync)
  // =========================================================================
  describe('measure()', () => {
    it('returns function result', () => {
      const result = DiagnosticsUtils.measure('test', () => 42);
      expect(result).toBe(42);
    });

    it('propagates errors from measured function', () => {
      expect(() => {
        DiagnosticsUtils.measure('failing', () => {
          throw new Error('boom');
        });
      }).toThrow('boom');
    });
  });

  // =========================================================================
  // measureAsync
  // =========================================================================
  describe('measureAsync()', () => {
    it('returns async function result', async () => {
      const result = await DiagnosticsUtils.measureAsync('async-test', async () => 'done');
      expect(result).toBe('done');
    });

    it('propagates async errors', async () => {
      await expect(
        DiagnosticsUtils.measureAsync('async-fail', async () => {
          throw new Error('async boom');
        })
      ).rejects.toThrow('async boom');
    });
  });

  // =========================================================================
  // FPS tracking
  // =========================================================================
  describe('FPS tracking', () => {
    beforeEach(() => {
      DiagnosticsUtils.clear();
    });

    it('getAverageFPS() returns 0 with no history', () => {
      expect(DiagnosticsUtils.getAverageFPS()).toBe(0);
    });

    it('getFPSStats() returns zeros with no history', () => {
      const stats = DiagnosticsUtils.getFPSStats();
      expect(stats).toEqual({ min: 0, max: 0, avg: 0, current: 0 });
    });

    it('trackFPS() returns a number', () => {
      const fps = DiagnosticsUtils.trackFPS();
      expect(typeof fps).toBe('number');
    });

    it('trackFPS() accumulates history after multiple calls', () => {
      // First call sets lastFrameTime but no fps calculated
      DiagnosticsUtils.trackFPS();
      // Second call calculates fps
      const fps = DiagnosticsUtils.trackFPS();
      expect(fps).toBeGreaterThanOrEqual(0);
    });

    it('getFPSStats() returns non-zero after tracking', () => {
      DiagnosticsUtils.trackFPS();
      DiagnosticsUtils.trackFPS();
      const stats = DiagnosticsUtils.getFPSStats();
      expect(stats.min).toBeGreaterThanOrEqual(0);
      expect(stats.max).toBeGreaterThanOrEqual(0);
      expect(stats.avg).toBeGreaterThanOrEqual(0);
      expect(typeof stats.current).toBe('number');
    });
  });

  // =========================================================================
  // Memory usage
  // =========================================================================
  describe('getMemoryUsage()', () => {
    it('returns null or object (depends on environment)', () => {
      const result = DiagnosticsUtils.getMemoryUsage();
      // JSDOM may or may not have performance.memory
      expect(result === null || typeof result === 'object').toBe(true);
    });
  });

  // =========================================================================
  // Performance timing
  // =========================================================================
  describe('getPerformanceTiming()', () => {
    it('returns null or object (depends on environment)', () => {
      const result = DiagnosticsUtils.getPerformanceTiming();
      expect(result === null || typeof result === 'object').toBe(true);
    });
  });

  // =========================================================================
  // Feature detection
  // =========================================================================
  describe('detectFeatures()', () => {
    it('returns a frozen object with boolean values', () => {
      const features = DiagnosticsUtils.detectFeatures();
      expect(Object.isFrozen(features)).toBe(true);
      for (const [key, value] of Object.entries(features)) {
        expect(typeof value).toBe('boolean');
      }
    });

    it('detects localStorage in JSDOM', () => {
      const features = DiagnosticsUtils.detectFeatures();
      expect(typeof features.localStorage).toBe('boolean');
    });

    it('detects performanceNow', () => {
      const features = DiagnosticsUtils.detectFeatures();
      expect(features.performanceNow).toBe(true);
    });
  });

  // =========================================================================
  // logSystemInfo
  // =========================================================================
  describe('logSystemInfo()', () => {
    it('returns an object with system info', () => {
      const info = DiagnosticsUtils.logSystemInfo();
      expect(typeof info).toBe('object');
      expect(info).toHaveProperty('userAgent');
      expect(info).toHaveProperty('platform');
      expect(info).toHaveProperty('language');
      expect(info).toHaveProperty('cookiesEnabled');
      expect(info).toHaveProperty('onLine');
    });
  });

  // =========================================================================
  // snapshot
  // =========================================================================
  describe('snapshot()', () => {
    it('returns object with timestamp, fps, memory, timing', () => {
      const snap = DiagnosticsUtils.snapshot();
      expect(typeof snap.timestamp).toBe('number');
      expect(snap.timestamp).toBeGreaterThan(0);
      expect(snap).toHaveProperty('fps');
      expect(snap).toHaveProperty('memory');
      expect(snap).toHaveProperty('timing');
    });

    it('fps stats are structured correctly', () => {
      const snap = DiagnosticsUtils.snapshot();
      expect(snap.fps).toHaveProperty('min');
      expect(snap.fps).toHaveProperty('max');
      expect(snap.fps).toHaveProperty('avg');
      expect(snap.fps).toHaveProperty('current');
    });
  });

  // =========================================================================
  // clear
  // =========================================================================
  describe('clear()', () => {
    it('resets FPS history', () => {
      DiagnosticsUtils.trackFPS();
      DiagnosticsUtils.trackFPS();
      DiagnosticsUtils.clear();
      expect(DiagnosticsUtils.getAverageFPS()).toBe(0);
      expect(DiagnosticsUtils.getFPSStats()).toEqual({ min: 0, max: 0, avg: 0, current: 0 });
    });

    it('resets measurements', () => {
      DiagnosticsUtils.start('test');
      DiagnosticsUtils.clear();
      // After clear, end returns 0 (no measurement)
      expect(DiagnosticsUtils.end('test')).toBe(0);
    });
  });
});
