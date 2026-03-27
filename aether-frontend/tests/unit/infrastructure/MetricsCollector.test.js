'use strict';

/**
 * MetricsCollector Unit Tests
 * ============================================================================
 * Tests FPS, latency, memory, request, token, and custom metrics collection,
 * snapshot, reset, backend reporting, start/stop lifecycle.
 *
 * @module tests/unit/infrastructure/MetricsCollector.test
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock('../../../src/core/utils/logger', () => ({
  createLogger: jest.fn(() => mockLog),
}));

// Mock requestAnimationFrame / cancelAnimationFrame (not in node)
global.requestAnimationFrame = jest.fn((cb) => {
  const id = setTimeout(() => cb(performance.now()), 0);
  return id;
});
global.cancelAnimationFrame = jest.fn((id) => clearTimeout(id));

const { MetricsCollector } = require('../../../src/infrastructure/monitoring/MetricsCollector');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MetricsCollector', () => {
  let mc;

  beforeEach(() => {
    jest.clearAllMocks();
    // Create without auto-start (window is undefined in node env)
    mc = new MetricsCollector();
  });

  afterEach(() => {
    mc.stop();
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('initialises with defaults', () => {
      expect(mc.enableLogging).toBe(false);
      expect(mc.reportInterval).toBe(30000);
      expect(mc.maxHistorySize).toBe(1000);
      expect(mc.reportToBackend).toBe(false);
      expect(mc.metrics.fps.current).toBe(0);
      expect(mc.metrics.requests.total).toBe(0);
      expect(mc.metrics.tokens.total).toBe(0);
    });

    it('accepts custom options', () => {
      const m = new MetricsCollector({
        enableLogging: true,
        reportInterval: 5000,
        maxHistorySize: 50,
        reportToBackend: true,
        backendURL: 'http://test',
      });
      expect(m.enableLogging).toBe(true);
      expect(m.reportInterval).toBe(5000);
      expect(m.maxHistorySize).toBe(50);
      expect(m.reportToBackend).toBe(true);
      expect(m.backendURL).toBe('http://test');
      m.stop();
    });
  });

  // =========================================================================
  // FPS
  // =========================================================================

  describe('FPS metrics', () => {
    it('records FPS and updates stats', () => {
      mc.recordFPS(60);
      mc.recordFPS(55);
      expect(mc.metrics.fps.current).toBe(55);
      expect(mc.metrics.fps.min).toBe(55);
      expect(mc.metrics.fps.max).toBe(60);
      expect(mc.metrics.fps.history).toHaveLength(2);
      expect(mc.metrics.fps.avg).toBeCloseTo(57.5);
    });

    it('ignores invalid FPS values', () => {
      mc.recordFPS(-1);
      mc.recordFPS(NaN);
      mc.recordFPS(Infinity);
      expect(mc.metrics.fps.history).toHaveLength(0);
    });

    it('trims history to maxHistorySize', () => {
      mc.maxHistorySize = 3;
      for (let i = 0; i < 5; i++) mc.recordFPS(60);
      expect(mc.metrics.fps.history).toHaveLength(3);
    });

    it('getFPSStats returns frozen copy', () => {
      mc.recordFPS(60);
      const stats = mc.getFPSStats();
      expect(Object.isFrozen(stats)).toBe(true);
      expect(stats.current).toBe(60);
    });
  });

  // =========================================================================
  // Latency
  // =========================================================================

  describe('latency metrics', () => {
    it('records latency and updates stats', () => {
      mc.recordLatency(100);
      mc.recordLatency(200);
      expect(mc.metrics.latency.current).toBe(200);
      expect(mc.metrics.latency.min).toBe(100);
      expect(mc.metrics.latency.max).toBe(200);
      expect(mc.metrics.latency.avg).toBeCloseTo(150);
    });

    it('ignores invalid latency', () => {
      mc.recordLatency(-5);
      mc.recordLatency(NaN);
      expect(mc.metrics.latency.history).toHaveLength(0);
    });

    it('trims latency history', () => {
      mc.maxHistorySize = 2;
      mc.recordLatency(10);
      mc.recordLatency(20);
      mc.recordLatency(30);
      expect(mc.metrics.latency.history).toHaveLength(2);
    });

    it('getLatencyStats returns frozen copy', () => {
      mc.recordLatency(50);
      const stats = mc.getLatencyStats();
      expect(Object.isFrozen(stats)).toBe(true);
      expect(stats.current).toBe(50);
    });

    it('startLatencyPing / endLatencyPing measures round trip', () => {
      const id = mc.startLatencyPing('test-ping');
      expect(id).toBe('test-ping');
      const latency = mc.endLatencyPing('test-ping');
      expect(latency).toBeGreaterThanOrEqual(0);
      expect(mc.metrics.latency.history).toHaveLength(1);
    });

    it('startLatencyPing auto-generates ID', () => {
      const id = mc.startLatencyPing();
      expect(id).toMatch(/^ping_/);
    });

    it('endLatencyPing returns null for unknown id', () => {
      expect(mc.endLatencyPing('unknown')).toBeNull();
    });
  });

  // =========================================================================
  // Memory
  // =========================================================================

  describe('memory metrics', () => {
    it('records memory when performance.memory available', () => {
      // Install performance.memory mock
      Object.defineProperty(performance, 'memory', {
        value: { usedJSHeapSize: 100, totalJSHeapSize: 200, jsHeapSizeLimit: 4096 },
        writable: true,
        configurable: true,
      });

      mc.recordMemory();
      expect(mc.metrics.memory.used).toBe(100);
      expect(mc.metrics.memory.total).toBe(200);
      expect(mc.metrics.memory.history).toHaveLength(1);

      delete performance.memory;
    });

    it('does nothing when performance.memory missing', () => {
      // In node, performance.memory doesn't exist by default
      if (performance.memory) delete performance.memory;
      mc.recordMemory();
      expect(mc.metrics.memory.history).toHaveLength(0);
    });

    it('getMemoryStats calls recordMemory and returns frozen', () => {
      Object.defineProperty(performance, 'memory', {
        value: { usedJSHeapSize: 50, totalJSHeapSize: 100, jsHeapSizeLimit: 2048 },
        writable: true,
        configurable: true,
      });

      const stats = mc.getMemoryStats();
      expect(Object.isFrozen(stats)).toBe(true);
      expect(stats.used).toBe(50);

      delete performance.memory;
    });

    it('trims memory history', () => {
      Object.defineProperty(performance, 'memory', {
        value: { usedJSHeapSize: 10, totalJSHeapSize: 20, jsHeapSizeLimit: 100 },
        writable: true,
        configurable: true,
      });

      mc.maxHistorySize = 2;
      mc.recordMemory();
      mc.recordMemory();
      mc.recordMemory();
      expect(mc.metrics.memory.history).toHaveLength(2);

      delete performance.memory;
    });
  });

  // =========================================================================
  // Requests
  // =========================================================================

  describe('request metrics', () => {
    it('tracks request lifecycle', () => {
      mc.recordRequestStart();
      expect(mc.metrics.requests.total).toBe(1);
      expect(mc.metrics.requests.pending).toBe(1);

      mc.recordRequestSuccess();
      expect(mc.metrics.requests.success).toBe(1);
      expect(mc.metrics.requests.pending).toBe(0);
    });

    it('tracks request errors', () => {
      mc.recordRequestStart();
      mc.recordRequestError();
      expect(mc.metrics.requests.error).toBe(1);
      expect(mc.metrics.requests.pending).toBe(0);
    });

    it('getRequestStats returns frozen copy', () => {
      mc.recordRequestStart();
      const stats = mc.getRequestStats();
      expect(Object.isFrozen(stats)).toBe(true);
      expect(stats.total).toBe(1);
    });
  });

  // =========================================================================
  // Tokens
  // =========================================================================

  describe('token metrics', () => {
    it('records token usage', () => {
      mc.recordTokens(100, 200);
      expect(mc.metrics.tokens.input).toBe(100);
      expect(mc.metrics.tokens.output).toBe(200);
      expect(mc.metrics.tokens.total).toBe(300);
    });

    it('accumulates tokens', () => {
      mc.recordTokens(10, 20);
      mc.recordTokens(30, 40);
      expect(mc.metrics.tokens.total).toBe(100);
    });

    it('defaults to 0', () => {
      mc.recordTokens();
      expect(mc.metrics.tokens.total).toBe(0);
    });

    it('getTokenStats returns frozen copy', () => {
      mc.recordTokens(5, 10);
      const stats = mc.getTokenStats();
      expect(Object.isFrozen(stats)).toBe(true);
      expect(stats.total).toBe(15);
    });
  });

  // =========================================================================
  // Custom metrics
  // =========================================================================

  describe('custom metrics', () => {
    it('records and retrieves custom metric', () => {
      mc.recordCustom('renderTime', 16);
      mc.recordCustom('renderTime', 20);
      const m = mc.getCustom('renderTime');
      expect(Object.isFrozen(m)).toBe(true);
      expect(m.current).toBe(20);
      expect(m.count).toBe(2);
      expect(m.avg).toBe(18);
      expect(m.min).toBe(16);
      expect(m.max).toBe(20);
    });

    it('returns null for unknown metric', () => {
      expect(mc.getCustom('unknown')).toBeNull();
    });
  });

  // =========================================================================
  // Snapshot
  // =========================================================================

  describe('getSnapshot()', () => {
    it('returns frozen snapshot without history arrays', () => {
      mc.recordFPS(60);
      mc.recordLatency(100);
      mc.recordRequestStart();
      mc.recordTokens(10, 20);
      const snap = mc.getSnapshot();
      expect(Object.isFrozen(snap)).toBe(true);
      expect(snap.fps.history).toBeUndefined();
      expect(snap.latency.history).toBeUndefined();
      expect(snap.memory.history).toBeUndefined();
      expect(snap.requests.total).toBe(1);
      expect(snap.tokens.total).toBe(30);
    });
  });

  // =========================================================================
  // Reset
  // =========================================================================

  describe('reset()', () => {
    it('resets all metrics to initial state', () => {
      mc.recordFPS(60);
      mc.recordLatency(100);
      mc.recordRequestStart();
      mc.recordTokens(10, 20);
      mc.recordCustom('x', 1);
      mc.reset();
      expect(mc.metrics.fps.current).toBe(0);
      expect(mc.metrics.fps.history).toEqual([]);
      expect(mc.metrics.latency.current).toBe(0);
      expect(mc.metrics.requests.total).toBe(0);
      expect(mc.metrics.tokens.total).toBe(0);
      expect(mc.metrics.custom).toEqual({});
    });

    it('logs when enableLogging', () => {
      mc.enableLogging = true;
      mc.reset();
      expect(mockLog.debug).toHaveBeenCalledWith('reset');
    });
  });

  // =========================================================================
  // Start / Stop
  // =========================================================================

  describe('start() and stop()', () => {
    it('start logs when enableLogging', () => {
      mc.enableLogging = true;
      mc.start();
      expect(mockLog.info).toHaveBeenCalledWith('started');
    });

    it('stop cancels animation frame and report timer', () => {
      mc.fpsRequestId = 123;
      mc.reportTimer = setInterval(() => {}, 99999);
      mc.stop();
      expect(mc.fpsRequestId).toBeNull();
      expect(mc.reportTimer).toBeNull();
      expect(global.cancelAnimationFrame).toHaveBeenCalledWith(123);
    });

    it('stop logs when enableLogging', () => {
      mc.enableLogging = true;
      mc.stop();
      expect(mockLog.info).toHaveBeenCalledWith('stopped');
    });

    it('stop handles null timers gracefully', () => {
      mc.fpsRequestId = null;
      mc.reportTimer = null;
      mc.stop(); // should not throw
    });
  });

  // =========================================================================
  // Backend reporting
  // =========================================================================

  describe('_reportToBackend()', () => {
    it('sends snapshot to backend', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true });
      mc.backendURL = 'http://test';
      mc.enableLogging = true;
      await mc._reportToBackend();
      expect(global.fetch).toHaveBeenCalledWith(
        'http://test/monitoring',
        expect.objectContaining({ method: 'POST' })
      );
      expect(mockLog.debug).toHaveBeenCalledWith('reported to backend');
      delete global.fetch;
    });

    it('does nothing without backendURL', async () => {
      global.fetch = jest.fn();
      mc.backendURL = null;
      await mc._reportToBackend();
      expect(global.fetch).not.toHaveBeenCalled();
      delete global.fetch;
    });

    it('handles fetch error gracefully', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('network'));
      mc.backendURL = 'http://test';
      await mc._reportToBackend();
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('failed to report'),
        expect.any(Object)
      );
      delete global.fetch;
    });
  });
});
