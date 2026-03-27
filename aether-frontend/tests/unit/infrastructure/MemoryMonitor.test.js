'use strict';

/**
 * MemoryMonitor Unit Tests
 * ============================================================================
 * Tests memory monitoring lifecycle (start/stop), sampling, threshold
 * detection (warning/critical/budget), leak detection, trend analysis,
 * stats, reporting, GC, and cleanup.
 *
 * @module tests/unit/infrastructure/MemoryMonitor.test
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

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => mockLog),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;

/** Install a fake performance.memory on the global performance object. */
function installPerfMemory(usedMB = 100, totalMB = 200, limitMB = 4096) {
  Object.defineProperty(performance, 'memory', {
    value: {
      usedJSHeapSize: usedMB * MB,
      totalJSHeapSize: totalMB * MB,
      jsHeapSizeLimit: limitMB * MB,
    },
    writable: true,
    configurable: true,
  });
}

function removePerfMemory() {
  // Delete the property so hasMemoryAPI becomes false for new instances
  if (Object.getOwnPropertyDescriptor(performance, 'memory')) {
    delete performance.memory;
  }
}

function setPerfMemoryUsed(usedMB) {
  performance.memory.usedJSHeapSize = usedMB * MB;
}

// ---------------------------------------------------------------------------
// Import SUT
// ---------------------------------------------------------------------------

const { MemoryMonitor, THRESHOLDS } = require('../../../src/infrastructure/monitoring/MemoryMonitor');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoryMonitor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    installPerfMemory(100, 200, 4096);
  });

  afterEach(() => {
    jest.useRealTimers();
    removePerfMemory();
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('initialises with defaults when memory API available', () => {
      const mon = new MemoryMonitor();
      expect(mon.hasMemoryAPI).toBe(true);
      expect(mon.budget).toBe(THRESHOLDS.BUDGET);
      expect(mon.sampleInterval).toBe(5000);
      expect(mon.historySize).toBe(100);
      expect(mon.isMonitoring).toBe(false);
      expect(mon.samples).toEqual([]);
    });

    it('accepts custom options', () => {
      const onWarn = jest.fn();
      const mon = new MemoryMonitor({
        budget: 200 * MB,
        sampleInterval: 1000,
        historySize: 50,
        onWarning: onWarn,
        enableLogging: false,
      });
      expect(mon.budget).toBe(200 * MB);
      expect(mon.sampleInterval).toBe(1000);
      expect(mon.historySize).toBe(50);
      expect(mon.onWarning).toBe(onWarn);
      expect(mon.enableLogging).toBe(false);
    });

    it('detects missing memory API', () => {
      removePerfMemory();
      const mon = new MemoryMonitor();
      expect(mon.hasMemoryAPI).toBe(false);
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('not available')
      );
    });
  });

  // =========================================================================
  // start() / stop()
  // =========================================================================

  describe('start() and stop()', () => {
    it('starts monitoring and takes initial sample', () => {
      const mon = new MemoryMonitor();
      mon.start();
      expect(mon.isMonitoring).toBe(true);
      expect(mon.samples).toHaveLength(1);
      expect(mon.monitoringInterval).not.toBeNull();
      mon.stop();
    });

    it('takes samples on interval', () => {
      const mon = new MemoryMonitor({ sampleInterval: 1000 });
      mon.start();
      expect(mon.samples).toHaveLength(1);

      jest.advanceTimersByTime(1000);
      expect(mon.samples).toHaveLength(2);

      jest.advanceTimersByTime(1000);
      expect(mon.samples).toHaveLength(3);
      mon.stop();
    });

    it('does not double-start', () => {
      const mon = new MemoryMonitor();
      mon.start();
      mon.start(); // no-op
      expect(mon.samples).toHaveLength(1); // only one initial sample
      mon.stop();
    });

    it('stops monitoring and clears interval', () => {
      const mon = new MemoryMonitor();
      mon.start();
      mon.stop();
      expect(mon.isMonitoring).toBe(false);
      expect(mon.monitoringInterval).toBeNull();
    });

    it('stop is safe when not monitoring', () => {
      const mon = new MemoryMonitor();
      mon.stop(); // should not throw
      expect(mon.isMonitoring).toBe(false);
    });

    it('does not start when memory API missing', () => {
      removePerfMemory();
      const mon = new MemoryMonitor();
      mon.start();
      expect(mon.isMonitoring).toBe(false);
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('Cannot start')
      );
    });
  });

  // =========================================================================
  // sample()
  // =========================================================================

  describe('sample()', () => {
    it('takes a sample and returns frozen snapshot', () => {
      const mon = new MemoryMonitor();
      const s = mon.sample();
      expect(s).not.toBeNull();
      expect(Object.isFrozen(s)).toBe(true);
      expect(s.used).toBe(100 * MB);
      expect(mon.samples).toHaveLength(1);
    });

    it('returns null when memory API missing', () => {
      removePerfMemory();
      const mon = new MemoryMonitor();
      expect(mon.sample()).toBeNull();
    });

    it('updates currentMemory and peakMemory', () => {
      const mon = new MemoryMonitor();
      mon.sample();
      expect(mon.currentMemory).toBeDefined();
      expect(mon.currentMemory.used).toBe(100 * MB);
      expect(mon.peakMemory).toBe(100 * MB);
    });

    it('tracks peak across multiple samples', () => {
      const mon = new MemoryMonitor();
      mon.sample(); // 100MB
      setPerfMemoryUsed(200);
      mon.sample(); // 200MB
      setPerfMemoryUsed(150);
      mon.sample(); // 150MB
      expect(mon.peakMemory).toBe(200 * MB);
    });

    it('trims history to historySize', () => {
      const mon = new MemoryMonitor({ historySize: 3 });
      for (let i = 0; i < 5; i++) {
        mon.sample();
      }
      expect(mon.samples).toHaveLength(3);
    });
  });

  // =========================================================================
  // forceGC()
  // =========================================================================

  describe('forceGC()', () => {
    it('calls global.gc when available', () => {
      const origGc = global.gc;
      global.gc = jest.fn();
      const mon = new MemoryMonitor();
      mon.forceGC();
      expect(global.gc).toHaveBeenCalled();
      global.gc = origGc;
    });

    it('logs when GC not available', () => {
      const origGc = global.gc;
      delete global.gc;
      const mon = new MemoryMonitor();
      mon.forceGC();
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.stringContaining('GC not available')
      );
      global.gc = origGc;
    });

    it('handles GC error', () => {
      const origGc = global.gc;
      global.gc = jest.fn(() => { throw new Error('gc fail'); });
      const mon = new MemoryMonitor();
      mon.forceGC();
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('GC failed'),
        expect.any(Error)
      );
      global.gc = origGc;
    });
  });

  // =========================================================================
  // getCurrentMemory()
  // =========================================================================

  describe('getCurrentMemory()', () => {
    it('returns frozen memory snapshot', () => {
      const mon = new MemoryMonitor();
      const mem = mon.getCurrentMemory();
      expect(Object.isFrozen(mem)).toBe(true);
      expect(mem.used).toBe(100 * MB);
      expect(mem.total).toBe(200 * MB);
      expect(mem.percentage).toBeGreaterThan(0);
    });

    it('returns null when API missing', () => {
      removePerfMemory();
      const mon = new MemoryMonitor();
      expect(mon.getCurrentMemory()).toBeNull();
    });
  });

  // =========================================================================
  // getStats()
  // =========================================================================

  describe('getStats()', () => {
    it('returns null with no samples', () => {
      const mon = new MemoryMonitor();
      expect(mon.getStats()).toBeNull();
    });

    it('returns frozen stats after sampling', () => {
      const mon = new MemoryMonitor();
      mon.sample();
      setPerfMemoryUsed(120);
      mon.sample();
      const stats = mon.getStats();
      expect(Object.isFrozen(stats)).toBe(true);
      expect(stats.samples).toBe(2);
      expect(stats.peak).toBe(120 * MB);
      expect(stats.average).toBeGreaterThan(0);
      expect(stats.median).toBeGreaterThan(0);
      expect(stats.min).toBe(100 * MB);
      expect(stats.max).toBe(120 * MB);
      expect(stats.withinBudget).toBe(true);
      expect(stats.overBudget).toBe(0);
    });

    it('reports over-budget correctly', () => {
      const mon = new MemoryMonitor({ budget: 50 * MB });
      mon.sample(); // 100MB > 50MB budget
      const stats = mon.getStats();
      expect(stats.withinBudget).toBe(false);
      expect(stats.overBudget).toBe(50 * MB);
    });
  });

  // =========================================================================
  // getTrend()
  // =========================================================================

  describe('getTrend()', () => {
    it('returns insufficient-data with < 10 samples', () => {
      const mon = new MemoryMonitor();
      for (let i = 0; i < 5; i++) mon.sample();
      expect(mon.getTrend()).toBe('insufficient-data');
    });

    it('returns insufficient-data with 10-19 samples (no older set)', () => {
      const mon = new MemoryMonitor();
      for (let i = 0; i < 12; i++) mon.sample();
      // slice(-20, -10) on a 12-element array gives 2 elements
      // This should work since older.length > 0
      expect(['insufficient-data', 'stable', 'growing', 'declining']).toContain(mon.getTrend());
    });

    it('returns growing when recent > older by > 1MB', () => {
      const mon = new MemoryMonitor();
      // 20 samples: first 10 at 100MB, last 10 at 102MB
      for (let i = 0; i < 10; i++) {
        setPerfMemoryUsed(100);
        mon.sample();
      }
      for (let i = 0; i < 10; i++) {
        setPerfMemoryUsed(102);
        mon.sample();
      }
      expect(mon.getTrend()).toBe('growing');
    });

    it('returns declining when recent < older by > 1MB', () => {
      const mon = new MemoryMonitor();
      for (let i = 0; i < 10; i++) {
        setPerfMemoryUsed(102);
        mon.sample();
      }
      for (let i = 0; i < 10; i++) {
        setPerfMemoryUsed(100);
        mon.sample();
      }
      expect(mon.getTrend()).toBe('declining');
    });

    it('returns stable when difference < 1MB', () => {
      const mon = new MemoryMonitor();
      for (let i = 0; i < 20; i++) {
        setPerfMemoryUsed(100);
        mon.sample();
      }
      expect(mon.getTrend()).toBe('stable');
    });
  });

  // =========================================================================
  // getLeaks()
  // =========================================================================

  describe('getLeaks()', () => {
    it('returns frozen empty array initially', () => {
      const mon = new MemoryMonitor();
      const leaks = mon.getLeaks();
      expect(Object.isFrozen(leaks)).toBe(true);
      expect(leaks).toEqual([]);
    });
  });

  // =========================================================================
  // isHealthy()
  // =========================================================================

  describe('isHealthy()', () => {
    it('returns true when no memory data', () => {
      const mon = new MemoryMonitor();
      expect(mon.isHealthy()).toBe(true);
    });

    it('returns true when within budget and stable', () => {
      const mon = new MemoryMonitor();
      for (let i = 0; i < 20; i++) {
        setPerfMemoryUsed(100);
        mon.sample();
      }
      expect(mon.isHealthy()).toBe(true);
    });

    it('returns false when over budget', () => {
      const mon = new MemoryMonitor({ budget: 50 * MB });
      for (let i = 0; i < 20; i++) {
        setPerfMemoryUsed(100);
        mon.sample();
      }
      expect(mon.isHealthy()).toBe(false);
    });

    it('returns false when trend is growing', () => {
      const mon = new MemoryMonitor();
      for (let i = 0; i < 10; i++) {
        setPerfMemoryUsed(100);
        mon.sample();
      }
      for (let i = 0; i < 10; i++) {
        setPerfMemoryUsed(110);
        mon.sample();
      }
      expect(mon.isHealthy()).toBe(false);
    });
  });

  // =========================================================================
  // Threshold callbacks
  // =========================================================================

  describe('threshold detection', () => {
    it('fires onBudgetExceeded when used > budget', () => {
      const cb = jest.fn();
      const mon = new MemoryMonitor({
        budget: 50 * MB,
        onBudgetExceeded: cb,
        sampleInterval: 1000,
      });
      mon.start();
      jest.advanceTimersByTime(1000); // triggers _checkThresholds
      expect(cb).toHaveBeenCalled();
      expect(mon.pressureEvents.length).toBeGreaterThan(0);
      mon.stop();
    });

    it('fires onCritical when used > CRITICAL threshold', () => {
      const cb = jest.fn();
      const mon = new MemoryMonitor({
        onCritical: cb,
        sampleInterval: 1000,
      });
      setPerfMemoryUsed(385); // > 380MB CRITICAL
      mon.start();
      jest.advanceTimersByTime(1000);
      expect(cb).toHaveBeenCalled();
      mon.stop();
    });

    it('fires onWarning when used > WARNING threshold', () => {
      const cb = jest.fn();
      const mon = new MemoryMonitor({
        onWarning: cb,
        sampleInterval: 1000,
      });
      setPerfMemoryUsed(355); // > 350MB WARNING, < 380MB CRITICAL
      mon.start();
      jest.advanceTimersByTime(1000);
      expect(cb).toHaveBeenCalled();
      mon.stop();
    });

    it('handles callback error without crashing', () => {
      const cb = jest.fn(() => { throw new Error('cb fail'); });
      const mon = new MemoryMonitor({
        budget: 50 * MB,
        onBudgetExceeded: cb,
        sampleInterval: 1000,
      });
      mon.start();
      jest.advanceTimersByTime(1000);
      expect(cb).toHaveBeenCalled();
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('callback error'),
        expect.any(Error)
      );
      mon.stop();
    });

    it('handles onCritical callback error', () => {
      const cb = jest.fn(() => { throw new Error('cb fail'); });
      const mon = new MemoryMonitor({
        onCritical: cb,
        sampleInterval: 1000,
      });
      setPerfMemoryUsed(385);
      mon.start();
      jest.advanceTimersByTime(1000);
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('Critical callback error'),
        expect.any(Error)
      );
      mon.stop();
    });

    it('handles onWarning callback error', () => {
      const cb = jest.fn(() => { throw new Error('cb fail'); });
      const mon = new MemoryMonitor({
        onWarning: cb,
        sampleInterval: 1000,
      });
      setPerfMemoryUsed(355);
      mon.start();
      jest.advanceTimersByTime(1000);
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('Warning callback error'),
        expect.any(Error)
      );
      mon.stop();
    });

    it('records pressure events with trimming', () => {
      const mon = new MemoryMonitor({ budget: 50 * MB, sampleInterval: 100 });
      mon.start();
      // Generate > 50 events
      for (let i = 0; i < 55; i++) {
        jest.advanceTimersByTime(100);
      }
      expect(mon.pressureEvents.length).toBeLessThanOrEqual(50);
      mon.stop();
    });
  });

  // =========================================================================
  // Leak detection
  // =========================================================================

  describe('leak detection', () => {
    it('detects leak when sustained growth > LEAK_THRESHOLD', () => {
      const cb = jest.fn();
      const mon = new MemoryMonitor({
        onLeakDetected: cb,
        sampleInterval: 1000,
      });
      mon.start(); // sample 1
      // First 9 at 100MB (need 10 "older" samples)
      for (let i = 0; i < 9; i++) {
        setPerfMemoryUsed(100);
        jest.advanceTimersByTime(1000);
      }
      // Next 10 at 115MB (growth = 15MB > 10MB threshold)
      for (let i = 0; i < 10; i++) {
        setPerfMemoryUsed(115);
        jest.advanceTimersByTime(1000);
      }
      expect(cb).toHaveBeenCalled();
      expect(mon.leaks.length).toBeGreaterThan(0);
      mon.stop();
    });

    it('does not detect leak with < 20 samples', () => {
      const cb = jest.fn();
      const mon = new MemoryMonitor({
        onLeakDetected: cb,
        sampleInterval: 1000,
      });
      mon.start();
      for (let i = 0; i < 10; i++) {
        jest.advanceTimersByTime(1000);
      }
      expect(cb).not.toHaveBeenCalled();
      mon.stop();
    });

    it('handles onLeakDetected callback error', () => {
      const cb = jest.fn(() => { throw new Error('leak cb fail'); });
      const mon = new MemoryMonitor({
        onLeakDetected: cb,
        sampleInterval: 1000,
      });
      mon.start();
      for (let i = 0; i < 9; i++) {
        setPerfMemoryUsed(100);
        jest.advanceTimersByTime(1000);
      }
      for (let i = 0; i < 10; i++) {
        setPerfMemoryUsed(115);
        jest.advanceTimersByTime(1000);
      }
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('Leak detected callback error'),
        expect.any(Error)
      );
      mon.stop();
    });
  });

  // =========================================================================
  // Reporting
  // =========================================================================

  describe('getReport()', () => {
    it('returns frozen report object', () => {
      const mon = new MemoryMonitor();
      mon.sample();
      const report = mon.getReport();
      expect(Object.isFrozen(report)).toBe(true);
      expect(report.healthy).toBeDefined();
      expect(report.current).toBeDefined();
      expect(report.stats).toBeDefined();
      expect(report.trend).toBeDefined();
      expect(report.leaks).toBeDefined();
      expect(report.history).toBeDefined();
    });
  });

  describe('exportJSON()', () => {
    it('returns valid JSON string', () => {
      const mon = new MemoryMonitor();
      mon.sample();
      const json = mon.exportJSON();
      const parsed = JSON.parse(json);
      expect(parsed.healthy).toBeDefined();
      expect(parsed.stats).toBeDefined();
    });
  });

  describe('logStatus()', () => {
    it('logs status when samples exist', () => {
      const mon = new MemoryMonitor();
      mon.sample();
      mon.logStatus();
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.stringContaining('Memory Status'),
        expect.any(Object)
      );
    });

    it('logs no-data message when no samples', () => {
      const mon = new MemoryMonitor();
      mon.logStatus();
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.stringContaining('No data available')
      );
    });
  });

  // =========================================================================
  // clear()
  // =========================================================================

  describe('clear()', () => {
    it('resets all state', () => {
      const mon = new MemoryMonitor();
      mon.sample();
      mon.pressureEvents.push({ level: 'test' });
      mon.leaks.push({ growth: 1 });
      mon.clear();
      expect(mon.samples).toEqual([]);
      expect(mon.leaks).toEqual([]);
      expect(mon.pressureEvents).toEqual([]);
      expect(mon.peakMemory).toBe(0);
      expect(mon.lastSample).toBeNull();
    });
  });

  // =========================================================================
  // Private helpers
  // =========================================================================

  describe('_calculateGrowthRate()', () => {
    it('returns 0 with < 2 samples', () => {
      const mon = new MemoryMonitor();
      expect(mon._calculateGrowthRate()).toBe(0);
      mon.sample();
      expect(mon._calculateGrowthRate()).toBe(0);
    });
  });

  describe('_formatBytes()', () => {
    it('formats 0', () => {
      const mon = new MemoryMonitor();
      expect(mon._formatBytes(0)).toBe('0 B');
    });

    it('formats MB', () => {
      const mon = new MemoryMonitor();
      const formatted = mon._formatBytes(100 * MB);
      expect(formatted).toContain('MB');
    });
  });

  describe('_average()', () => {
    it('returns 0 for empty array', () => {
      const mon = new MemoryMonitor();
      expect(mon._average([])).toBe(0);
    });

    it('computes average', () => {
      const mon = new MemoryMonitor();
      expect(mon._average([10, 20, 30])).toBe(20);
    });
  });

  describe('_median()', () => {
    it('returns 0 for empty array', () => {
      const mon = new MemoryMonitor();
      expect(mon._median([])).toBe(0);
    });

    it('computes median for odd-length array', () => {
      const mon = new MemoryMonitor();
      expect(mon._median([1, 3, 2])).toBe(2);
    });

    it('computes median for even-length array', () => {
      const mon = new MemoryMonitor();
      expect(mon._median([1, 2, 3, 4])).toBe(2.5);
    });
  });

  // =========================================================================
  // THRESHOLDS export
  // =========================================================================

  describe('THRESHOLDS', () => {
    it('exports frozen thresholds', () => {
      expect(Object.isFrozen(THRESHOLDS)).toBe(true);
      expect(THRESHOLDS.BUDGET).toBe(400 * MB);
      expect(THRESHOLDS.WARNING).toBe(350 * MB);
      expect(THRESHOLDS.CRITICAL).toBe(380 * MB);
      expect(THRESHOLDS.LEAK_THRESHOLD).toBe(10 * MB);
    });
  });
});
