'use strict';

/**
 * StartupProfiler Unit Tests
 * ============================================================================
 * Tests phase tracking (start/end), milestones, measureSync/measureAsync,
 * startup completion, budget validation, navigation/paint/resource timing,
 * metrics, summary, export, and logging.
 *
 * @module tests/unit/infrastructure/StartupProfiler.test
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

const { StartupProfiler, PHASES, MILESTONES } = require('../../../src/infrastructure/monitoring/StartupProfiler');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StartupProfiler', () => {
  let sp;

  beforeEach(() => {
    jest.clearAllMocks();
    sp = new StartupProfiler({ enableLogging: false });
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('initialises with defaults', () => {
      expect(sp.budget).toBe(2000);
      expect(sp.phases).toBeInstanceOf(Map);
      expect(sp.milestones).toBeInstanceOf(Map);
      expect(sp.isStartupComplete).toBe(false);
      // APP_START milestone auto-marked
      expect(sp.milestones.has(MILESTONES.APP_START)).toBe(true);
    });

    it('accepts custom budget', () => {
      const s = new StartupProfiler({ budget: 5000, enableLogging: false });
      expect(s.budget).toBe(5000);
    });

    it('logs when enableLogging true', () => {
      new StartupProfiler({ enableLogging: true });
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.stringContaining('Initialized')
      );
    });
  });

  // =========================================================================
  // Phase tracking
  // =========================================================================

  describe('startPhase() / endPhase()', () => {
    it('tracks a phase with duration', () => {
      sp.startPhase('test');
      const dur = sp.endPhase('test');
      expect(typeof dur).toBe('number');
      expect(dur).toBeGreaterThanOrEqual(0);
      expect(sp.phases.get('test').duration).toBe(dur);
    });

    it('rejects startPhase after startup complete', () => {
      sp.enableLogging = true;
      sp.completeStartup();
      sp.startPhase('late');
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('Cannot start phase')
      );
    });

    it('endPhase returns null for unknown phase', () => {
      sp.enableLogging = true;
      expect(sp.endPhase('unknown')).toBeNull();
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('Phase not found')
      );
    });

    it('endPhase returns cached duration if already ended', () => {
      sp.enableLogging = true;
      sp.startPhase('x');
      const d1 = sp.endPhase('x');
      const d2 = sp.endPhase('x');
      expect(d2).toBe(d1);
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('already ended')
      );
    });

    it('clears currentPhase on end', () => {
      sp.startPhase('x');
      expect(sp.currentPhase).toBe('x');
      sp.endPhase('x');
      expect(sp.currentPhase).toBeNull();
    });

    it('logs when enableLogging', () => {
      sp.enableLogging = true;
      sp.startPhase('op');
      sp.endPhase('op');
      expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('Phase started: op'));
      expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('Phase completed: op'));
    });
  });

  // =========================================================================
  // measureSync()
  // =========================================================================

  describe('measureSync()', () => {
    it('measures sync function and returns result', () => {
      const result = sp.measureSync('sync', () => 42);
      expect(result).toBe(42);
      expect(sp.phases.has('sync')).toBe(true);
      expect(sp.phases.get('sync').duration).not.toBeNull();
    });

    it('still ends phase when function throws', () => {
      expect(() => {
        sp.measureSync('fail', () => { throw new Error('fail'); });
      }).toThrow('fail');
      expect(sp.phases.get('fail').duration).not.toBeNull();
    });
  });

  // =========================================================================
  // measureAsync()
  // =========================================================================

  describe('measureAsync()', () => {
    it('measures async function and returns result', async () => {
      const result = await sp.measureAsync('async', async () => 'done');
      expect(result).toBe('done');
      expect(sp.phases.get('async').duration).not.toBeNull();
    });

    it('still ends phase when async function rejects', async () => {
      await expect(
        sp.measureAsync('fail-async', async () => { throw new Error('boom'); })
      ).rejects.toThrow('boom');
      expect(sp.phases.get('fail-async').duration).not.toBeNull();
    });
  });

  // =========================================================================
  // Milestones
  // =========================================================================

  describe('markMilestone()', () => {
    it('records milestone with elapsed time', () => {
      const ts = sp.markMilestone('custom');
      expect(typeof ts).toBe('number');
      const m = sp.milestones.get('custom');
      expect(m.elapsed).toBeGreaterThanOrEqual(0);
    });

    it('triggers completeStartup when COMPLETE milestone marked', () => {
      sp.markMilestone(MILESTONES.COMPLETE);
      expect(sp.isStartupComplete).toBe(true);
    });

    it('logs when enableLogging', () => {
      sp.enableLogging = true;
      sp.markMilestone('test');
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.stringContaining('Milestone: test')
      );
    });
  });

  // =========================================================================
  // completeStartup()
  // =========================================================================

  describe('completeStartup()', () => {
    it('marks startup as complete', () => {
      sp.completeStartup();
      expect(sp.isStartupComplete).toBe(true);
    });

    it('is idempotent', () => {
      sp.completeStartup();
      sp.completeStartup();
      expect(sp.isStartupComplete).toBe(true);
    });

    it('logs budget status when enableLogging', () => {
      sp.enableLogging = true;
      sp.completeStartup();
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.stringContaining('Startup complete')
      );
    });
  });

  // =========================================================================
  // Navigation / Paint / Resource Timing
  // =========================================================================

  describe('getNavigationTiming()', () => {
    it('returns null when performance.timing absent', () => {
      // Node.js doesn't have performance.timing
      const result = sp.getNavigationTiming();
      expect(result).toBeNull();
    });
  });

  describe('getPaintTiming()', () => {
    it('returns null when no paint entries', () => {
      // Node.js getEntriesByType("paint") returns empty
      const result = sp.getPaintTiming();
      expect(result).toBeNull();
    });
  });

  describe('getResourceTiming()', () => {
    it('returns frozen summary (empty in node)', () => {
      const result = sp.getResourceTiming();
      if (result) {
        expect(result.total).toBeDefined();
      } else {
        expect(result).toBeNull();
      }
    });
  });

  // =========================================================================
  // getMetrics()
  // =========================================================================

  describe('getMetrics()', () => {
    it('returns frozen metrics object', () => {
      sp.startPhase('a');
      sp.endPhase('a');
      sp.completeStartup();
      const m = sp.getMetrics();
      expect(Object.isFrozen(m)).toBe(true);
      expect(m.isComplete).toBe(true);
      expect(m.phases).toHaveLength(1);
      expect(m.milestones.length).toBeGreaterThan(0);
      expect(m.budget).toBe(2000);
    });

    it('returns null total when not complete', () => {
      // isStartupComplete is false, but _getTime() - startTime is always computed
      // Actually: totalTime = this.isStartupComplete ? ... : null
      // Wait, looking at code: it's always computed if isStartupComplete
      const m = sp.getMetrics();
      // isStartupComplete is false, so total is null
      expect(m.total).toBeNull();
      expect(m.withinBudget).toBeNull();
    });
  });

  // =========================================================================
  // getSummary()
  // =========================================================================

  describe('getSummary()', () => {
    it('returns frozen summary with slowest phases', () => {
      sp.startPhase('fast');
      sp.endPhase('fast');
      sp.startPhase('slow');
      sp.endPhase('slow');
      sp.completeStartup();
      const s = sp.getSummary();
      expect(Object.isFrozen(s)).toBe(true);
      expect(s.total).toBeGreaterThanOrEqual(0);
      expect(s.budget).toBe(2000);
      expect(s.slowestPhases.length).toBeLessThanOrEqual(5);
    });
  });

  // =========================================================================
  // exportJSON()
  // =========================================================================

  describe('exportJSON()', () => {
    it('returns valid JSON', () => {
      sp.startPhase('p');
      sp.endPhase('p');
      const json = sp.exportJSON();
      const parsed = JSON.parse(json);
      expect(parsed.phases).toBeDefined();
      expect(parsed.milestones).toBeDefined();
    });
  });

  // =========================================================================
  // logSummary()
  // =========================================================================

  describe('logSummary()', () => {
    it('logs performance summary', () => {
      sp.completeStartup();
      sp.logSummary();
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.stringContaining('Performance Summary'),
        expect.any(Object)
      );
    });
  });

  // =========================================================================
  // PHASES / MILESTONES exports
  // =========================================================================

  describe('exports', () => {
    it('PHASES is frozen with expected keys', () => {
      expect(Object.isFrozen(PHASES)).toBe(true);
      expect(PHASES.PRELOAD).toBe('preload');
      expect(PHASES.INTERACTIVE).toBe('interactive');
    });

    it('MILESTONES is frozen with expected keys', () => {
      expect(Object.isFrozen(MILESTONES)).toBe(true);
      expect(MILESTONES.APP_START).toBe('appStart');
      expect(MILESTONES.COMPLETE).toBe('complete');
    });
  });

  // =========================================================================
  // Budget exceeded branch
  // =========================================================================

  describe('completeStartup() — budget exceeded', () => {
    it('logs warning when total > budget and logging enabled', () => {
      const s = new StartupProfiler({ budget: 1, enableLogging: true });
      // Artificially push startTime back to guarantee exceeding 1ms budget
      s.startTime = Date.now() - 100;
      s.completeStartup();
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('exceeded budget')
      );
    });

    it('logs success when within budget and logging enabled', () => {
      const s = new StartupProfiler({ budget: 999999, enableLogging: true });
      s.completeStartup();
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.stringContaining('within budget')
      );
    });
  });

  // =========================================================================
  // getNavigationTiming() — with mocked performance.timing
  // =========================================================================

  describe('getNavigationTiming() — with timing data', () => {
    let origTiming;

    beforeEach(() => {
      origTiming = performance.timing;
    });

    afterEach(() => {
      Object.defineProperty(performance, 'timing', {
        value: origTiming,
        writable: true,
        configurable: true,
      });
    });

    it('returns timing data when performance.timing is available', () => {
      const navStart = 1000;
      Object.defineProperty(performance, 'timing', {
        value: {
          navigationStart: navStart,
          domLoading: navStart + 100,
          domInteractive: navStart + 200,
          domContentLoadedEventEnd: navStart + 300,
          domContentLoadedEventStart: navStart + 280,
          loadEventEnd: navStart + 500,
          loadEventStart: navStart + 450,
        },
        writable: true,
        configurable: true,
      });

      const s = new StartupProfiler({ enableLogging: false });
      const result = s.getNavigationTiming();

      expect(result).not.toBeNull();
      expect(Object.isFrozen(result)).toBe(true);
      expect(result.domLoading).toBe(100);
      expect(result.domInteractive).toBe(200);
      expect(result.domContentLoaded).toBe(300);
      expect(result.loadComplete).toBe(500);
      expect(result.domContentLoadedEvent).toBe(20); // 300 - 280
      expect(result.loadEvent).toBe(50); // 500 - 450
    });
  });

  // =========================================================================
  // getPaintTiming() — with mocked entries
  // =========================================================================

  describe('getPaintTiming() — with paint entries', () => {
    let origGetEntries;

    beforeEach(() => {
      origGetEntries = performance.getEntriesByType;
    });

    afterEach(() => {
      performance.getEntriesByType = origGetEntries;
    });

    it('returns paint data when entries exist', () => {
      performance.getEntriesByType = jest.fn((type) => {
        if (type === 'paint') {
          return [
            { name: 'first-paint', startTime: 150 },
            { name: 'first-contentful-paint', startTime: 250 },
          ];
        }
        return [];
      });

      const s = new StartupProfiler({ enableLogging: false });
      const result = s.getPaintTiming();

      expect(result).not.toBeNull();
      expect(Object.isFrozen(result)).toBe(true);
      expect(result.firstPaint).toBe(150);
      expect(result.firstContentfulPaint).toBe(250);
    });

    it('returns null when only non-paint entries exist', () => {
      performance.getEntriesByType = jest.fn(() => [
        { name: 'other-metric', startTime: 100 },
      ]);

      const s = new StartupProfiler({ enableLogging: false });
      expect(s.getPaintTiming()).toBeNull();
    });

    it('returns partial data when only first-paint exists', () => {
      performance.getEntriesByType = jest.fn(() => [
        { name: 'first-paint', startTime: 120 },
      ]);

      const s = new StartupProfiler({ enableLogging: false });
      const result = s.getPaintTiming();
      expect(result).not.toBeNull();
      expect(result.firstPaint).toBe(120);
      expect(result.firstContentfulPaint).toBeUndefined();
    });

    it('returns null on getEntriesByType error', () => {
      performance.getEntriesByType = jest.fn(() => { throw new Error('fail'); });

      const s = new StartupProfiler({ enableLogging: false });
      expect(s.getPaintTiming()).toBeNull();
    });
  });

  // =========================================================================
  // getResourceTiming() — with mocked resource entries
  // =========================================================================

  describe('getResourceTiming() — with resource entries', () => {
    let origGetEntries;

    beforeEach(() => {
      origGetEntries = performance.getEntriesByType;
    });

    afterEach(() => {
      performance.getEntriesByType = origGetEntries;
    });

    it('returns resource summary grouped by type', () => {
      performance.getEntriesByType = jest.fn((type) => {
        if (type === 'resource') {
          return [
            { initiatorType: 'script', duration: 100, transferSize: 5000 },
            { initiatorType: 'script', duration: 50, transferSize: 3000 },
            { initiatorType: 'css', duration: 30, transferSize: 1500 },
            { initiatorType: 'img', duration: 200, transferSize: 0 }, // transferSize can be 0
          ];
        }
        return [];
      });

      const s = new StartupProfiler({ enableLogging: false });
      const result = s.getResourceTiming();

      expect(result).not.toBeNull();
      expect(Object.isFrozen(result)).toBe(true);
      expect(result.total).toBe(4);
      expect(result.byType.script.count).toBe(2);
      expect(result.byType.script.duration).toBe(150);
      expect(result.byType.script.size).toBe(8000);
      expect(result.byType.css.count).toBe(1);
      expect(result.byType.css.duration).toBe(30);
      expect(result.byType.img.count).toBe(1);
      expect(result.byType.img.size).toBe(0);
      expect(result.totalDuration).toBe(380);
      expect(result.totalTransferSize).toBe(9500);
    });

    it('handles resources without initiatorType (falls back to "other")', () => {
      performance.getEntriesByType = jest.fn((type) => {
        if (type === 'resource') {
          return [
            { initiatorType: '', duration: 10, transferSize: 100 },
          ];
        }
        return [];
      });

      const s = new StartupProfiler({ enableLogging: false });
      const result = s.getResourceTiming();
      // '' is falsy → '' || 'other' → 'other'
      expect(result.byType.other).toBeDefined();
      expect(result.byType.other.count).toBe(1);
      expect(result.byType.other.duration).toBe(10);
      expect(result.byType.other.size).toBe(100);
    });

    it('returns null on getEntriesByType error', () => {
      performance.getEntriesByType = jest.fn(() => { throw new Error('fail'); });

      const s = new StartupProfiler({ enableLogging: false });
      expect(s.getResourceTiming()).toBeNull();
    });
  });

  // =========================================================================
  // _captureWebVitals() — with paint data
  // =========================================================================

  describe('_captureWebVitals() — with paint data', () => {
    let origGetEntries;

    beforeEach(() => {
      origGetEntries = performance.getEntriesByType;
    });

    afterEach(() => {
      performance.getEntriesByType = origGetEntries;
    });

    it('marks FIRST_PAINT and FIRST_CONTENTFUL_PAINT milestones', () => {
      performance.getEntriesByType = jest.fn((type) => {
        if (type === 'paint') {
          return [
            { name: 'first-paint', startTime: 80 },
            { name: 'first-contentful-paint', startTime: 120 },
          ];
        }
        return [];
      });

      const s = new StartupProfiler({ enableLogging: false });
      s.completeStartup();

      expect(s.milestones.has(MILESTONES.FIRST_PAINT)).toBe(true);
      expect(s.milestones.has(MILESTONES.FIRST_CONTENTFUL_PAINT)).toBe(true);
    });

    it('marks only FIRST_PAINT when FCP is missing', () => {
      performance.getEntriesByType = jest.fn((type) => {
        if (type === 'paint') {
          return [{ name: 'first-paint', startTime: 80 }];
        }
        return [];
      });

      const s = new StartupProfiler({ enableLogging: false });
      s.completeStartup();

      expect(s.milestones.has(MILESTONES.FIRST_PAINT)).toBe(true);
      expect(s.milestones.has(MILESTONES.FIRST_CONTENTFUL_PAINT)).toBe(false);
    });
  });

  // =========================================================================
  // _getWebVitals()
  // =========================================================================

  describe('_getWebVitals()', () => {
    it('returns FCP and TTI from milestones', () => {
      sp.markMilestone(MILESTONES.FIRST_CONTENTFUL_PAINT);
      sp.markMilestone(MILESTONES.INTERACTIVE);

      const vitals = sp._getWebVitals();
      expect(vitals.FCP).toBeGreaterThanOrEqual(0);
      expect(vitals.TTI).toBeGreaterThanOrEqual(0);
    });

    it('returns null when milestones missing', () => {
      const vitals = sp._getWebVitals();
      expect(vitals.FCP).toBeNull();
      expect(vitals.TTI).toBeNull();
    });
  });

  // =========================================================================
  // _mark() with Performance API
  // =========================================================================

  describe('_mark() — Performance API integration', () => {
    it('creates performance.mark when API available', () => {
      const origMark = performance.mark;
      performance.mark = jest.fn();
      sp.hasPerformanceAPI = true;

      const name = sp._mark('test-mark');
      expect(name).toBe('startup:test-mark');
      expect(performance.mark).toHaveBeenCalledWith('startup:test-mark');
      expect(sp.marks.get('test-mark')).toBeDefined();

      performance.mark = origMark;
    });

    it('handles mark error gracefully', () => {
      const origMark = performance.mark;
      performance.mark = jest.fn(() => { throw new Error('mark fail'); });
      sp.hasPerformanceAPI = true;

      expect(() => sp._mark('err')).not.toThrow();
      expect(sp.marks.get('err')).toBeDefined();

      performance.mark = origMark;
    });
  });

  // =========================================================================
  // endPhase with Performance API measure
  // =========================================================================

  describe('endPhase — performance.measure integration', () => {
    let origMeasure;

    beforeEach(() => {
      origMeasure = performance.measure;
    });

    afterEach(() => {
      performance.measure = origMeasure;
    });

    it('calls performance.measure when API available', () => {
      performance.measure = jest.fn();
      sp.hasPerformanceAPI = true;

      sp.startPhase('measurable');
      sp.endPhase('measurable');

      expect(performance.measure).toHaveBeenCalledWith(
        'measurable',
        'startup:measurable_start',
        'startup:measurable_end'
      );
    });

    it('handles measure error gracefully', () => {
      performance.measure = jest.fn(() => { throw new Error('measure fail'); });
      sp.hasPerformanceAPI = true;

      sp.startPhase('err-phase');
      expect(() => sp.endPhase('err-phase')).not.toThrow();
    });
  });

  // =========================================================================
  // getMetrics() — withinBudget field
  // =========================================================================

  describe('getMetrics() — withinBudget', () => {
    it('returns withinBudget=true when under budget', () => {
      sp.budget = 999999;
      sp.completeStartup();
      const m = sp.getMetrics();
      expect(m.withinBudget).toBe(true);
    });

    it('returns withinBudget=false when over budget', () => {
      sp.budget = 1;
      sp.startTime = Date.now() - 100;
      sp.completeStartup();
      const m = sp.getMetrics();
      expect(m.withinBudget).toBe(false);
    });
  });

  // =========================================================================
  // getSummary() — overbudget field and paint data
  // =========================================================================

  describe('getSummary() — overbudget and paint data', () => {
    let origGetEntries;

    beforeEach(() => {
      origGetEntries = performance.getEntriesByType;
    });

    afterEach(() => {
      performance.getEntriesByType = origGetEntries;
    });

    it('sets overbudget to difference when over', () => {
      sp.budget = 1;
      sp.startTime = Date.now() - 100;
      sp.completeStartup();
      const s = sp.getSummary();
      expect(s.overbudget).toBeGreaterThan(0);
    });

    it('sets overbudget to 0 when within budget', () => {
      sp.budget = 999999;
      sp.completeStartup();
      const s = sp.getSummary();
      expect(s.overbudget).toBe(0);
    });

    it('includes paint data when available', () => {
      performance.getEntriesByType = jest.fn((type) => {
        if (type === 'paint') {
          return [
            { name: 'first-paint', startTime: 100 },
            { name: 'first-contentful-paint', startTime: 200 },
          ];
        }
        return [];
      });

      const s = new StartupProfiler({ enableLogging: false });
      s.completeStartup();
      const summary = s.getSummary();
      expect(summary.firstPaint).toBe(100);
      expect(summary.firstContentfulPaint).toBe(200);
    });
  });

  // =========================================================================
  // logSummary() — with paint/fcp/overbudget lines
  // =========================================================================

  describe('logSummary() — with full data', () => {
    let origGetEntries;

    beforeEach(() => {
      origGetEntries = performance.getEntriesByType;
    });

    afterEach(() => {
      performance.getEntriesByType = origGetEntries;
    });

    it('logs FP and FCP lines when paint data available', () => {
      performance.getEntriesByType = jest.fn((type) => {
        if (type === 'paint') {
          return [
            { name: 'first-paint', startTime: 80 },
            { name: 'first-contentful-paint', startTime: 150 },
          ];
        }
        return [];
      });

      const s = new StartupProfiler({ enableLogging: false });
      s.startPhase('boot');
      s.endPhase('boot');
      s.completeStartup();
      s.logSummary();

      // Verify summary logged with paint data included
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.stringContaining('Performance Summary'),
        expect.objectContaining({
          details: expect.stringContaining('FP:'),
        })
      );
    });

    it('logs overbudget line when over budget', () => {
      const s = new StartupProfiler({ budget: 1, enableLogging: false });
      s.startTime = Date.now() - 500;
      s.completeStartup();
      s.logSummary();

      expect(mockLog.info).toHaveBeenCalledWith(
        expect.stringContaining('Performance Summary'),
        expect.objectContaining({
          details: expect.stringContaining('Over budget'),
        })
      );
    });
  });
});
