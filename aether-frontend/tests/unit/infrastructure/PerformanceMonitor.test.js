'use strict';

/**
 * PerformanceMonitor Unit Tests
 * ============================================================================
 * Tests operation timing (start/end), measure/measureAsync wrappers,
 * threshold detection (slow/critical), stats, summary, render/resource
 * timing, clear, and JSON export.
 *
 * @module tests/unit/infrastructure/PerformanceMonitor.test
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

const { PerformanceMonitor } = require('../../../src/infrastructure/monitoring/PerformanceMonitor');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PerformanceMonitor', () => {
  let pm;

  beforeEach(() => {
    jest.clearAllMocks();
    pm = new PerformanceMonitor();
  });

  afterEach(() => {
    pm.clear();
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('initialises with defaults', () => {
      expect(pm.enableLogging).toBe(false);
      expect(pm.thresholds.slow).toBe(100);
      expect(pm.thresholds.critical).toBe(1000);
      expect(pm.measurements).toBeInstanceOf(Map);
      expect(pm.marks).toBeInstanceOf(Map);
      expect(pm.summary.totalOperations).toBe(0);
    });

    it('accepts custom thresholds', () => {
      const p = new PerformanceMonitor({ thresholds: { slow: 50, critical: 500 } });
      expect(p.thresholds.slow).toBe(50);
      expect(p.thresholds.critical).toBe(500);
    });

    it('detects Performance API availability', () => {
      // In Node.js, performance.mark and performance.measure exist
      expect(pm.available).toBe(true);
    });
  });

  // =========================================================================
  // start() / end()
  // =========================================================================

  describe('start() and end()', () => {
    it('returns mark name from start', () => {
      const mark = pm.start('op');
      expect(mark).toBe('op_start');
      expect(pm.marks.has('op_start')).toBe(true);
    });

    it('end returns duration in ms', () => {
      pm.start('op');
      const duration = pm.end('op');
      expect(typeof duration).toBe('number');
      expect(duration).toBeGreaterThanOrEqual(0);
    });

    it('records measurement on end', () => {
      pm.start('op');
      pm.end('op');
      const stats = pm.getStats('op');
      expect(stats).not.toBeNull();
      expect(stats.count).toBe(1);
    });

    it('cleans up marks after end', () => {
      pm.start('op');
      pm.end('op');
      expect(pm.marks.has('op_start')).toBe(false);
    });

    it('end returns null for unstarted operation', () => {
      const duration = pm.end('never_started');
      // No start mark exists, duration depends on whether Performance API measure works
      // It should fall through to Date.now() fallback which also fails (no mark), so null
      expect(duration).toBeNull();
    });

    it('logs when enableLogging', () => {
      pm.enableLogging = true;
      pm.start('op');
      pm.end('op');
      expect(mockLog.debug).toHaveBeenCalledWith(expect.stringContaining('started: op'));
      expect(mockLog.debug).toHaveBeenCalledWith(expect.stringContaining('ended: op'));
    });
  });

  // =========================================================================
  // measure()
  // =========================================================================

  describe('measure()', () => {
    it('measures sync function and returns result', () => {
      const result = pm.measure('sync-op', () => 42);
      expect(result).toBe(42);
      expect(pm.getStats('sync-op')).not.toBeNull();
    });

    it('still records timing when function throws', () => {
      expect(() => {
        pm.measure('fail-op', () => { throw new Error('fail'); });
      }).toThrow('fail');
      expect(pm.getStats('fail-op')).not.toBeNull();
    });
  });

  // =========================================================================
  // measureAsync()
  // =========================================================================

  describe('measureAsync()', () => {
    it('measures async function and returns result', async () => {
      const result = await pm.measureAsync('async-op', async () => 'done');
      expect(result).toBe('done');
      expect(pm.getStats('async-op')).not.toBeNull();
    });

    it('still records timing when async function rejects', async () => {
      await expect(
        pm.measureAsync('fail-async', async () => { throw new Error('fail'); })
      ).rejects.toThrow('fail');
      expect(pm.getStats('fail-async')).not.toBeNull();
    });
  });

  // =========================================================================
  // Threshold detection
  // =========================================================================

  describe('threshold detection', () => {
    it('flags slow operations', () => {
      pm.thresholds = { slow: 0, critical: 99999 };
      pm.start('slow');
      pm.end('slow');
      const stats = pm.getStats('slow');
      expect(stats.slowCount).toBeGreaterThanOrEqual(1);
      expect(pm.summary.slowOperations).toBeGreaterThanOrEqual(1);
    });

    it('flags critical operations', () => {
      pm.thresholds = { slow: 0, critical: 0 };
      pm.start('crit');
      pm.end('crit');
      const stats = pm.getStats('crit');
      expect(stats.criticalCount).toBeGreaterThanOrEqual(1);
      expect(pm.summary.criticalOperations).toBeGreaterThanOrEqual(1);
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('CRITICAL'));
    });
  });

  // =========================================================================
  // getStats() / getAllStats()
  // =========================================================================

  describe('getStats()', () => {
    it('returns null for unknown operation', () => {
      expect(pm.getStats('unknown')).toBeNull();
    });

    it('returns frozen stats', () => {
      pm.start('x');
      pm.end('x');
      const stats = pm.getStats('x');
      expect(Object.isFrozen(stats)).toBe(true);
      expect(stats.name).toBe('x');
    });
  });

  describe('getAllStats()', () => {
    it('returns frozen array of all operations', () => {
      pm.start('a');
      pm.end('a');
      pm.start('b');
      pm.end('b');
      const all = pm.getAllStats();
      expect(Object.isFrozen(all)).toBe(true);
      expect(all).toHaveLength(2);
    });
  });

  // =========================================================================
  // getSummary()
  // =========================================================================

  describe('getSummary()', () => {
    it('returns frozen summary', () => {
      const s = pm.getSummary();
      expect(Object.isFrozen(s)).toBe(true);
      expect(s.totalOperations).toBe(0);
      expect(s.slowPercentage).toBe(0);
    });

    it('calculates percentages', () => {
      pm.thresholds = { slow: 0, critical: 99999 };
      pm.start('op1');
      pm.end('op1');
      const s = pm.getSummary();
      expect(s.totalOperations).toBe(1);
      expect(Number(s.slowPercentage)).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // getRenderTiming() / getResourceTiming()
  // =========================================================================

  describe('getRenderTiming()', () => {
    it('returns object (empty in node - no paint entries)', () => {
      const timing = pm.getRenderTiming();
      // In node, getEntriesByType exists but returns empty for 'paint'/'navigation'
      if (timing === null) {
        expect(timing).toBeNull();
      } else {
        expect(timing.firstPaint).toBeDefined();
      }
    });
  });

  describe('getResourceTiming()', () => {
    it('returns array (empty in node)', () => {
      const resources = pm.getResourceTiming();
      expect(Array.isArray(resources)).toBe(true);
    });
  });

  // =========================================================================
  // clear()
  // =========================================================================

  describe('clear()', () => {
    it('resets all state', () => {
      pm.start('op');
      pm.end('op');
      pm.clear();
      expect(pm.measurements.size).toBe(0);
      expect(pm.marks.size).toBe(0);
      expect(pm.summary.totalOperations).toBe(0);
    });

    it('logs when enableLogging', () => {
      pm.enableLogging = true;
      pm.clear();
      expect(mockLog.debug).toHaveBeenCalledWith(expect.stringContaining('cleared'));
    });
  });

  // =========================================================================
  // exportJSON()
  // =========================================================================

  describe('exportJSON()', () => {
    it('returns valid JSON with summary and measurements', () => {
      pm.start('op');
      pm.end('op');
      const json = pm.exportJSON();
      const parsed = JSON.parse(json);
      expect(parsed.summary).toBeDefined();
      expect(parsed.measurements).toBeDefined();
      expect(parsed.timestamp).toBeDefined();
    });
  });

  // =========================================================================
  // _recordMeasurement() statistics
  // =========================================================================

  describe('_recordMeasurement()', () => {
    it('accumulates stats across multiple measurements', () => {
      pm._recordMeasurement('x', 10);
      pm._recordMeasurement('x', 20);
      pm._recordMeasurement('x', 30);
      const s = pm.getStats('x');
      expect(s.count).toBe(3);
      expect(s.total).toBe(60);
      expect(s.avg).toBe(20);
      expect(s.min).toBe(10);
      expect(s.max).toBe(30);
      expect(s.last).toBe(30);
    });
  });
});
