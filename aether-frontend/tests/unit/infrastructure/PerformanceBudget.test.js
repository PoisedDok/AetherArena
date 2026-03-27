'use strict';

/**
 * PerformanceBudget Unit Tests
 * ============================================================================
 * Tests constructor (defaults/custom budgets/callbacks), validateStartup
 * (pass/violations/warnings/nulls), validateMemory (pass/violation/critical/warning),
 * validateRuntime (fps/latency), validateResources (scripts/styles/transferSize),
 * getStatus, getReport, exportJSON, clear, _mergeBudgets, _recordViolation,
 * _recordWarning, _generateRecommendations, window global attachment.
 *
 * @module tests/unit/infrastructure/PerformanceBudget.test
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

const { PerformanceBudget, DEFAULT_BUDGETS } = require('../../../src/infrastructure/monitoring/PerformanceBudget');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** All-passing startup metrics (well under budget). */
const goodStartup = () => ({
  total: 500,
  preload: 50,
  domReady: 100,
  bootstrap: 200,
  moduleLoad: 150,
  firstPaint: 300,
  firstContentfulPaint: 400,
  interactive: 500,
});

/** Startup metrics that exceed every budget. */
const badStartup = () => ({
  total: 5000,
  preload: 500,
  domReady: 1000,
  bootstrap: 2000,
  moduleLoad: 1500,
  firstPaint: 3000,
  firstContentfulPaint: 4000,
  interactive: 5000,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PerformanceBudget', () => {
  let pb;

  beforeEach(() => {
    jest.clearAllMocks();
    pb = new PerformanceBudget({ enableLogging: false });
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('creates instance with default budgets', () => {
      expect(pb.budgets).toBeDefined();
      expect(pb.budgets.startup.total).toBe(DEFAULT_BUDGETS.startup.total);
      expect(pb.budgets.memory.heap).toBe(DEFAULT_BUDGETS.memory.heap);
    });

    it('defaults enableLogging to true when not specified', () => {
      const p = new PerformanceBudget();
      expect(p.enableLogging).toBe(true);
    });

    it('respects enableLogging: false', () => {
      expect(pb.enableLogging).toBe(false);
    });

    it('initialises empty violations and warnings', () => {
      expect(pb.violations).toEqual([]);
      expect(pb.warnings).toEqual([]);
    });

    it('initialises state for all categories', () => {
      expect(pb.state.startup).toBeDefined();
      expect(pb.state.memory).toBeDefined();
      expect(pb.state.runtime).toBeDefined();
      expect(pb.state.resources).toBeDefined();
      expect(pb.state.lighthouse).toBeDefined();
    });

    it('stores onViolation callback', () => {
      const cb = jest.fn();
      const p = new PerformanceBudget({ onViolation: cb, enableLogging: false });
      expect(p.onViolation).toBe(cb);
    });

    it('stores onWarning callback', () => {
      const cb = jest.fn();
      const p = new PerformanceBudget({ onWarning: cb, enableLogging: false });
      expect(p.onWarning).toBe(cb);
    });

    it('merges custom budgets with defaults', () => {
      const p = new PerformanceBudget({
        budgets: { startup: { total: 9999 } },
        enableLogging: false,
      });
      expect(p.budgets.startup.total).toBe(9999);
      // Other startup keys preserved
      expect(p.budgets.startup.preload).toBe(DEFAULT_BUDGETS.startup.preload);
      // Other categories untouched
      expect(p.budgets.memory.heap).toBe(DEFAULT_BUDGETS.memory.heap);
    });

    it('ignores unknown budget categories', () => {
      const p = new PerformanceBudget({
        budgets: { unknownCat: { foo: 1 } },
        enableLogging: false,
      });
      expect(p.budgets.unknownCat).toBeUndefined();
    });

    it('sets startTime to approximately now', () => {
      const before = Date.now();
      const p = new PerformanceBudget({ enableLogging: false });
      const after = Date.now();
      expect(p.startTime).toBeGreaterThanOrEqual(before);
      expect(p.startTime).toBeLessThanOrEqual(after);
    });
  });

  // =========================================================================
  // DEFAULT_BUDGETS export
  // =========================================================================

  describe('DEFAULT_BUDGETS', () => {
    it('is frozen (immutable)', () => {
      expect(Object.isFrozen(DEFAULT_BUDGETS)).toBe(true);
    });

    it('has all expected top-level categories', () => {
      expect(DEFAULT_BUDGETS).toHaveProperty('startup');
      expect(DEFAULT_BUDGETS).toHaveProperty('memory');
      expect(DEFAULT_BUDGETS).toHaveProperty('runtime');
      expect(DEFAULT_BUDGETS).toHaveProperty('resources');
      expect(DEFAULT_BUDGETS).toHaveProperty('lighthouse');
    });
  });

  // =========================================================================
  // validateStartup
  // =========================================================================

  describe('validateStartup', () => {
    it('returns passed: true when all metrics within budget', () => {
      const result = pb.validateStartup(goodStartup());
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('returns exactly 8 violations when all 8 metrics exceed budget', () => {
      const result = pb.validateStartup(badStartup());
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(8);
      // Every violation has correct structure with derived fields
      for (const v of result.violations) {
        expect(v.category).toBe('startup');
        expect(typeof v.metric).toBe('string');
        expect(typeof v.actual).toBe('number');
        expect(typeof v.budget).toBe('number');
        expect(v.overage).toBe(v.actual - v.budget);
        expect(v.overage).toBeGreaterThan(0);
        expect(typeof v.timestamp).toBe('number');
      }
      // Verify specific metrics are all represented
      const metrics = result.violations.map(v => v.metric);
      expect(metrics).toEqual(expect.arrayContaining([
        'total', 'preload', 'domReady', 'bootstrap',
        'moduleLoad', 'firstPaint', 'firstContentfulPaint', 'interactive',
      ]));
    });

    it('records warnings for metrics within 90-100% of budget', () => {
      // 91% of budget should trigger warning
      const metrics = {
        total: DEFAULT_BUDGETS.startup.total * 0.95,
      };
      const result = pb.validateStartup(metrics);
      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].category).toBe('startup');
      expect(result.warnings[0].metric).toBe('total');
      expect(result.warnings[0].percentage).toBeGreaterThan(90);
    });

    it('skips null or undefined metric values', () => {
      const metrics = { total: null, preload: undefined, domReady: 100 };
      const result = pb.validateStartup(metrics);
      // Only domReady evaluated (and it passes)
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('updates state.startup', () => {
      pb.validateStartup(badStartup());
      expect(pb.state.startup.passed).toBe(false);
      expect(pb.state.startup.violations.length).toBeGreaterThan(0);
    });

    it('logs info on pass when enableLogging is true', () => {
      const p = new PerformanceBudget({ enableLogging: true });
      p.validateStartup(goodStartup());
      expect(mockLog.info).toHaveBeenCalledWith('startup budget passed');
    });

    it('logs warn on violation when enableLogging is true', () => {
      const p = new PerformanceBudget({ enableLogging: true });
      p.validateStartup(badStartup());
      expect(mockLog.warn).toHaveBeenCalledWith(
        'startup budget violations',
        expect.objectContaining({ violations: expect.any(Array) })
      );
    });

    it('does not log when enableLogging is false', () => {
      pb.validateStartup(badStartup());
      // mockLog.info and mockLog.warn called only from _recordViolation (which uses log.warn),
      // but not from the if (this.enableLogging) block in validateStartup
      // Since enableLogging is false, the "startup budget violations" message is not logged
      const calls = mockLog.warn.mock.calls.filter(c => c[0] === 'startup budget violations');
      expect(calls).toHaveLength(0);
    });

    it('records all 8 violations into global violations array', () => {
      expect(pb.violations).toHaveLength(0);
      pb.validateStartup(badStartup());
      expect(pb.violations).toHaveLength(8);
    });

    // --- Boundary tests ---

    it('value exactly at budget does NOT violate (not >)', () => {
      const result = pb.validateStartup({ total: DEFAULT_BUDGETS.startup.total });
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('value at exactly 90% of budget does NOT warn (threshold is >90%)', () => {
      const result = pb.validateStartup({ total: DEFAULT_BUDGETS.startup.total * 0.9 });
      expect(result.warnings).toHaveLength(0);
    });

    it('value at 90.01% of budget DOES warn', () => {
      const budget = DEFAULT_BUDGETS.startup.total;
      const result = pb.validateStartup({ total: budget * 0.9001 });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].metric).toBe('total');
    });

    it('value at budget + 1 violates', () => {
      const result = pb.validateStartup({ total: DEFAULT_BUDGETS.startup.total + 1 });
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].overage).toBe(1);
    });

    it('value of 0 passes (well under budget)', () => {
      const result = pb.validateStartup({ total: 0 });
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('negative value passes (< budget)', () => {
      const result = pb.validateStartup({ total: -100 });
      expect(result.passed).toBe(true);
    });

    it('handles empty metrics object (no fields)', () => {
      const result = pb.validateStartup({});
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });
  });

  // =========================================================================
  // validateMemory
  // =========================================================================

  describe('validateMemory', () => {
    const heap = DEFAULT_BUDGETS.memory.heap;
    const warning = DEFAULT_BUDGETS.memory.warning;
    const critical = DEFAULT_BUDGETS.memory.critical;

    it('returns passed: true when heap usage is under warning threshold', () => {
      const result = pb.validateMemory({ usedJSHeapSize: 100 * 1024 * 1024 });
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('returns violation when heap exceeds budget', () => {
      const result = pb.validateMemory({ usedJSHeapSize: heap + 1 });
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].category).toBe('memory');
      expect(result.violations[0].metric).toBe('heap');
      expect(result.violations[0].overage).toBe(1);
    });

    it('returns critical warning when heap between critical and heap limit', () => {
      const result = pb.validateMemory({ usedJSHeapSize: critical + 1 });
      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].level).toBe('critical');
    });

    it('returns standard warning when heap between warning and critical', () => {
      const result = pb.validateMemory({ usedJSHeapSize: warning + 1 });
      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].level).toBe('warning');
    });

    it('accepts metrics.used as fallback key', () => {
      const result = pb.validateMemory({ used: heap + 100 });
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
    });

    it('treats missing heap metrics as 0 (passes)', () => {
      const result = pb.validateMemory({});
      expect(result.passed).toBe(true);
    });

    it('updates state.memory', () => {
      pb.validateMemory({ usedJSHeapSize: heap + 1 });
      expect(pb.state.memory.passed).toBe(false);
    });

    it('logs warn on violation when enableLogging is true', () => {
      const p = new PerformanceBudget({ enableLogging: true });
      p.validateMemory({ usedJSHeapSize: heap + 1 });
      expect(mockLog.warn).toHaveBeenCalledWith(
        'memory budget violations',
        expect.objectContaining({ violations: expect.any(Array) })
      );
    });
  });

  // =========================================================================
  // validateRuntime
  // =========================================================================

  describe('validateRuntime', () => {
    const fpsBudget = DEFAULT_BUDGETS.runtime.fps;
    const latencyBudget = DEFAULT_BUDGETS.runtime.latency;

    it('returns passed: true when fps and latency within budget', () => {
      const result = pb.validateRuntime({ fps: 60, latency: 50 });
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('returns violation when fps below budget', () => {
      const result = pb.validateRuntime({ fps: fpsBudget - 10 });
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].metric).toBe('fps');
      expect(result.violations[0].underrun).toBe(10);
    });

    it('returns violation when latency above budget', () => {
      const result = pb.validateRuntime({ latency: latencyBudget + 100 });
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].metric).toBe('latency');
      expect(result.violations[0].overage).toBe(100);
    });

    it('returns two violations when both fps and latency fail', () => {
      const result = pb.validateRuntime({ fps: 5, latency: 1000 });
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(2);
    });

    it('does not check fps when undefined', () => {
      const result = pb.validateRuntime({ latency: 10 });
      expect(result.passed).toBe(true);
    });

    it('does not check latency when undefined', () => {
      const result = pb.validateRuntime({ fps: 60 });
      expect(result.passed).toBe(true);
    });

    it('updates state.runtime', () => {
      pb.validateRuntime({ fps: 5 });
      expect(pb.state.runtime.passed).toBe(false);
    });

    // --- BUG REGRESSION: validateRuntime now records violations globally ---

    it('records runtime violations into global violations array', () => {
      expect(pb.violations).toHaveLength(0);
      pb.validateRuntime({ fps: 5 });
      expect(pb.violations).toHaveLength(1);
      expect(pb.violations[0].category).toBe('runtime');
      expect(pb.violations[0].metric).toBe('fps');
    });

    it('fires onViolation callback for runtime violations', () => {
      const cb = jest.fn();
      const p = new PerformanceBudget({ onViolation: cb, enableLogging: false });
      p.validateRuntime({ fps: 1, latency: 9999 });
      expect(cb).toHaveBeenCalledTimes(2);
      expect(cb.mock.calls[0][0].metric).toBe('fps');
      expect(cb.mock.calls[1][0].metric).toBe('latency');
    });

    // --- Boundary tests ---

    it('fps exactly at budget does NOT violate (check is <)', () => {
      const result = pb.validateRuntime({ fps: DEFAULT_BUDGETS.runtime.fps });
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('fps one below budget violates', () => {
      const result = pb.validateRuntime({ fps: DEFAULT_BUDGETS.runtime.fps - 1 });
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].underrun).toBe(1);
    });

    it('latency exactly at budget does NOT violate (check is >)', () => {
      const result = pb.validateRuntime({ latency: DEFAULT_BUDGETS.runtime.latency });
      expect(result.passed).toBe(true);
    });

    it('latency one above budget violates', () => {
      const result = pb.validateRuntime({ latency: DEFAULT_BUDGETS.runtime.latency + 1 });
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].overage).toBe(1);
    });
  });

  // =========================================================================
  // validateResources
  // =========================================================================

  describe('validateResources', () => {
    const maxScripts = DEFAULT_BUDGETS.resources.maxScripts;
    const maxStyles = DEFAULT_BUDGETS.resources.maxStyles;
    const maxTransfer = DEFAULT_BUDGETS.resources.totalTransferSize;

    it('returns passed: true when all resources within budget', () => {
      const result = pb.validateResources({
        scripts: new Array(5),
        styles: new Array(3),
        images: new Array(10),
        fonts: new Array(2),
        totalTransferSize: 1024,
      });
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('returns violation for too many scripts', () => {
      const result = pb.validateResources({
        scripts: new Array(maxScripts + 10),
      });
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].metric).toBe('scripts');
      expect(result.violations[0].overage).toBe(10);
    });

    it('returns violation for too many styles', () => {
      const result = pb.validateResources({
        styles: new Array(maxStyles + 5),
      });
      expect(result.passed).toBe(false);
      expect(result.violations[0].metric).toBe('styles');
    });

    it('returns violation for exceeding transfer size', () => {
      const result = pb.validateResources({
        totalTransferSize: maxTransfer + 1,
      });
      expect(result.passed).toBe(false);
      expect(result.violations[0].metric).toBe('transferSize');
    });

    it('handles missing resource arrays (defaults to 0)', () => {
      const result = pb.validateResources({});
      expect(result.passed).toBe(true);
    });

    it('can return multiple violations', () => {
      const result = pb.validateResources({
        scripts: new Array(maxScripts + 1),
        styles: new Array(maxStyles + 1),
        totalTransferSize: maxTransfer + 1,
      });
      expect(result.violations).toHaveLength(3);
    });

    it('updates state.resources', () => {
      pb.validateResources({ scripts: new Array(maxScripts + 1) });
      expect(pb.state.resources.passed).toBe(false);
    });

    // --- BUG REGRESSION: images and fonts now checked against budget ---

    it('returns violation for too many images', () => {
      const maxImages = DEFAULT_BUDGETS.resources.maxImages;
      const result = pb.validateResources({ images: new Array(maxImages + 3) });
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].metric).toBe('images');
      expect(result.violations[0].overage).toBe(3);
    });

    it('returns violation for too many fonts', () => {
      const maxFonts = DEFAULT_BUDGETS.resources.maxFonts;
      const result = pb.validateResources({ fonts: new Array(maxFonts + 2) });
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].metric).toBe('fonts');
      expect(result.violations[0].overage).toBe(2);
    });

    it('can return 5 violations (all 4 resource types + transfer)', () => {
      const result = pb.validateResources({
        scripts: new Array(maxScripts + 1),
        styles: new Array(maxStyles + 1),
        images: new Array(DEFAULT_BUDGETS.resources.maxImages + 1),
        fonts: new Array(DEFAULT_BUDGETS.resources.maxFonts + 1),
        totalTransferSize: maxTransfer + 1,
      });
      expect(result.violations).toHaveLength(5);
    });

    // --- BUG REGRESSION: validateResources now records violations globally ---

    it('records resource violations into global violations array', () => {
      expect(pb.violations).toHaveLength(0);
      pb.validateResources({ scripts: new Array(maxScripts + 1) });
      expect(pb.violations).toHaveLength(1);
      expect(pb.violations[0].category).toBe('resources');
    });

    it('fires onViolation callback for resource violations', () => {
      const cb = jest.fn();
      const p = new PerformanceBudget({ onViolation: cb, enableLogging: false });
      p.validateResources({ scripts: new Array(maxScripts + 1) });
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0].category).toBe('resources');
    });

    // --- Boundary tests ---

    it('scripts exactly at max does NOT violate', () => {
      const result = pb.validateResources({ scripts: new Array(maxScripts) });
      expect(result.passed).toBe(true);
    });

    it('transfer exactly at budget does NOT violate', () => {
      const result = pb.validateResources({ totalTransferSize: maxTransfer });
      expect(result.passed).toBe(true);
    });
  });

  // =========================================================================
  // getStatus
  // =========================================================================

  describe('getStatus', () => {
    it('returns overall pass when no violations', () => {
      pb.validateStartup(goodStartup());
      pb.validateMemory({ usedJSHeapSize: 100 * 1024 * 1024 });
      pb.validateRuntime({ fps: 60, latency: 50 });
      pb.validateResources({ scripts: [1, 2] });
      const status = pb.getStatus();
      // startup and lighthouse both default to passed: false in initial state
      // After validateStartup passes, startup.passed = true
      // lighthouse is still false, so overall is fail
      expect(status.overall).toBe('fail'); // lighthouse never validated = passed: false
      expect(status.violations).toBe(0);
      expect(status.warnings).toBe(0);
      expect(status).toHaveProperty('uptime');
      expect(status).toHaveProperty('state');
      expect(status).toHaveProperty('budgets');
    });

    it('returns overall pass when all state categories pass (including lighthouse)', () => {
      pb.validateStartup(goodStartup());
      pb.validateMemory({ usedJSHeapSize: 100 * 1024 * 1024 });
      pb.validateRuntime({ fps: 60, latency: 50 });
      pb.validateResources({ scripts: [1, 2] });
      // Lighthouse has no validator -- set manually to cover the 'pass' branch
      pb.state.lighthouse = { passed: true, violations: [] };
      const status = pb.getStatus();
      expect(status.overall).toBe('pass');
    });

    it('returns overall fail when violations exist', () => {
      pb.validateStartup(badStartup());
      const status = pb.getStatus();
      expect(status.overall).toBe('fail');
      expect(status.violations).toBeGreaterThan(0);
    });

    it('returns frozen object', () => {
      const status = pb.getStatus();
      expect(Object.isFrozen(status)).toBe(true);
    });

    it('counts warnings correctly', () => {
      // Trigger a memory warning
      const warnLevel = DEFAULT_BUDGETS.memory.warning;
      pb.validateMemory({ usedJSHeapSize: warnLevel + 1 });
      const status = pb.getStatus();
      expect(status.warnings).toBe(1);
    });
  });

  // =========================================================================
  // getReport
  // =========================================================================

  describe('getReport', () => {
    it('contains all expected fields', () => {
      const report = pb.getReport();
      expect(report).toHaveProperty('timestamp');
      expect(report).toHaveProperty('uptime');
      expect(report).toHaveProperty('status');
      expect(report).toHaveProperty('violations');
      expect(report).toHaveProperty('warnings');
      expect(report).toHaveProperty('recommendations');
    });

    it('returns frozen object', () => {
      const report = pb.getReport();
      expect(Object.isFrozen(report)).toBe(true);
    });

    it('returns copy of violations (not reference)', () => {
      pb.validateStartup(badStartup());
      const report = pb.getReport();
      const lenBefore = report.violations.length;
      pb.validateStartup(badStartup()); // more violations
      // report snapshot unchanged
      expect(report.violations).toHaveLength(lenBefore);
    });
  });

  // =========================================================================
  // exportJSON
  // =========================================================================

  describe('exportJSON', () => {
    it('returns a valid JSON string', () => {
      const json = pb.exportJSON();
      expect(typeof json).toBe('string');
      const parsed = JSON.parse(json);
      expect(parsed).toHaveProperty('status');
      expect(parsed).toHaveProperty('violations');
    });

    it('is pretty-printed with 2-space indent', () => {
      const json = pb.exportJSON();
      // Indentation check: second line should start with spaces
      const lines = json.split('\n');
      expect(lines.length).toBeGreaterThan(1);
      expect(lines[1]).toMatch(/^\s{2}/);
    });
  });

  // =========================================================================
  // clear
  // =========================================================================

  describe('clear', () => {
    it('empties violations and warnings arrays', () => {
      pb.validateStartup(badStartup());
      expect(pb.violations.length).toBeGreaterThan(0);
      pb.clear();
      expect(pb.violations).toHaveLength(0);
      expect(pb.warnings).toHaveLength(0);
    });

    it('logs debug when enableLogging is true', () => {
      const p = new PerformanceBudget({ enableLogging: true });
      p.clear();
      expect(mockLog.debug).toHaveBeenCalledWith('cleared violations and warnings');
    });

    it('does not log when enableLogging is false', () => {
      jest.clearAllMocks();
      pb.clear();
      const debugCalls = mockLog.debug.mock.calls.filter(c => c[0] === 'cleared violations and warnings');
      expect(debugCalls).toHaveLength(0);
    });
  });

  // =========================================================================
  // _recordViolation
  // =========================================================================

  describe('_recordViolation', () => {
    it('pushes violation to this.violations', () => {
      const v = { category: 'test', metric: 'x', actual: 1, budget: 0 };
      pb._recordViolation(v);
      expect(pb.violations).toContain(v);
    });

    it('calls onViolation callback', () => {
      const cb = jest.fn();
      const p = new PerformanceBudget({ onViolation: cb, enableLogging: false });
      const v = { category: 'test', metric: 'x', actual: 1, budget: 0 };
      p._recordViolation(v);
      expect(cb).toHaveBeenCalledWith(v);
    });

    it('catches callback errors without throwing', () => {
      const cb = jest.fn(() => { throw new Error('boom'); });
      const p = new PerformanceBudget({ onViolation: cb, enableLogging: false });
      expect(() => {
        p._recordViolation({ category: 'test', metric: 'x', actual: 1, budget: 0 });
      }).not.toThrow();
    });

    it('logs violation callback error', () => {
      const cb = jest.fn(() => { throw new Error('boom'); });
      const p = new PerformanceBudget({ onViolation: cb, enableLogging: true });
      p._recordViolation({ category: 'test', metric: 'x', actual: 1, budget: 0 });
      expect(mockLog.error).toHaveBeenCalledWith(
        'violation callback error',
        expect.objectContaining({ error: 'boom' })
      );
    });

    it('logs VIOLATION message when enableLogging is true', () => {
      const p = new PerformanceBudget({ enableLogging: true });
      p._recordViolation({ category: 'startup', metric: 'total', actual: 5000, budget: 2000 });
      expect(mockLog.warn).toHaveBeenCalledWith(
        'VIOLATION: startup.total',
        'actual: 5000, budget: 2000'
      );
    });
  });

  // =========================================================================
  // _recordWarning
  // =========================================================================

  describe('_recordWarning', () => {
    it('pushes warning to this.warnings', () => {
      const w = { category: 'test', metric: 'x', actual: 1, budget: 2 };
      pb._recordWarning(w);
      expect(pb.warnings).toContain(w);
    });

    it('calls onWarning callback', () => {
      const cb = jest.fn();
      const p = new PerformanceBudget({ onWarning: cb, enableLogging: false });
      const w = { category: 'test', metric: 'x', actual: 1, budget: 2 };
      p._recordWarning(w);
      expect(cb).toHaveBeenCalledWith(w);
    });

    it('catches callback errors without throwing', () => {
      const cb = jest.fn(() => { throw new Error('warn-boom'); });
      const p = new PerformanceBudget({ onWarning: cb, enableLogging: false });
      expect(() => {
        p._recordWarning({ category: 'test', metric: 'x', actual: 1, budget: 2 });
      }).not.toThrow();
    });

    it('logs warning callback error', () => {
      const cb = jest.fn(() => { throw new Error('warn-boom'); });
      const p = new PerformanceBudget({ onWarning: cb, enableLogging: true });
      p._recordWarning({ category: 'test', metric: 'x', actual: 1, budget: 2 });
      expect(mockLog.error).toHaveBeenCalledWith(
        'warning callback error',
        expect.objectContaining({ error: 'warn-boom' })
      );
    });

    it('logs WARNING message when enableLogging is true', () => {
      const p = new PerformanceBudget({ enableLogging: true });
      p._recordWarning({ category: 'memory', metric: 'heap', actual: 390, budget: 400 });
      expect(mockLog.warn).toHaveBeenCalledWith(
        'WARNING: memory.heap',
        'actual: 390, budget: 400'
      );
    });
  });

  // =========================================================================
  // _generateRecommendations
  // =========================================================================

  describe('_generateRecommendations', () => {
    it('returns empty array when all categories pass', () => {
      pb.validateStartup(goodStartup());
      pb.validateMemory({ usedJSHeapSize: 0 });
      pb.validateRuntime({ fps: 60 });
      const recs = pb._generateRecommendations();
      expect(recs).toEqual([]);
    });

    it('recommends lazy loading when moduleLoad violates', () => {
      pb.validateStartup({ moduleLoad: 99999 });
      const recs = pb._generateRecommendations();
      const moduleRec = recs.find(r => r.issue === 'Slow module loading');
      expect(moduleRec).toBeDefined();
      expect(moduleRec.priority).toBe('high');
    });

    it('recommends profiling when total startup violates', () => {
      pb.validateStartup({ total: 99999 });
      const recs = pb._generateRecommendations();
      const totalRec = recs.find(r => r.issue === 'Slow total startup time');
      expect(totalRec).toBeDefined();
      expect(totalRec.priority).toBe('critical');
    });

    it('recommends memory review on memory violation', () => {
      const heap = DEFAULT_BUDGETS.memory.heap;
      pb.validateMemory({ usedJSHeapSize: heap + 1 });
      const recs = pb._generateRecommendations();
      const memRec = recs.find(r => r.category === 'memory');
      expect(memRec).toBeDefined();
      expect(memRec.priority).toBe('high');
    });

    it('recommends render optimisation on fps violation', () => {
      pb.validateRuntime({ fps: 5 });
      const recs = pb._generateRecommendations();
      const fpsRec = recs.find(r => r.issue === 'Low FPS');
      expect(fpsRec).toBeDefined();
      expect(fpsRec.priority).toBe('medium');
    });

    it('does not recommend render optimisation for latency-only violation', () => {
      pb.validateRuntime({ latency: 99999 });
      const recs = pb._generateRecommendations();
      const fpsRec = recs.find(r => r.issue === 'Low FPS');
      expect(fpsRec).toBeUndefined();
    });
  });

  // =========================================================================
  // Window global
  // =========================================================================

  describe('window global', () => {
    it('attaches PerformanceBudget to window when defined', () => {
      jest.isolateModules(() => {
        jest.mock('../../../src/core/utils/logger', () => ({
          createLogger: jest.fn(() => ({
            info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
          })),
        }));
        global.window = {};
        const mod = require('../../../src/infrastructure/monitoring/PerformanceBudget');
        expect(global.window.PerformanceBudget).toBe(mod.PerformanceBudget);
        delete global.window;
      });
    });
  });

  // =========================================================================
  // Integration: end-to-end flow
  // =========================================================================

  describe('integration', () => {
    it('accumulates violations across all validate calls into global array', () => {
      pb.validateStartup(badStartup());               // 8 violations
      pb.validateMemory({ usedJSHeapSize: DEFAULT_BUDGETS.memory.heap + 1 }); // 1 violation
      pb.validateRuntime({ fps: 1 });                  // 1 violation (fps)
      pb.validateResources({ scripts: new Array(200) }); // 1 violation (scripts)

      const status = pb.getStatus();
      expect(status.overall).toBe('fail');
      // All validators now call _recordViolation.
      // 8 startup + 1 memory + 1 runtime + 1 resources = 11
      expect(status.violations).toBe(11);
    });

    it('clear resets violations but not state', () => {
      pb.validateStartup(badStartup());
      pb.clear();
      expect(pb.violations).toHaveLength(0);
      // state still reflects last validation
      expect(pb.state.startup.passed).toBe(false);
    });

    it('exportJSON round-trips correctly', () => {
      pb.validateStartup(badStartup());
      const json = pb.exportJSON();
      const parsed = JSON.parse(json);
      expect(parsed.violations.length).toBeGreaterThan(0);
      expect(parsed.recommendations.length).toBeGreaterThan(0);
    });
  });
});
