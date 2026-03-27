'use strict';

/**
 * PerformanceIntegration Unit Tests
 * ============================================================================
 * Tests constructor (defaults/custom config/submodule init/window global),
 * start/stop lifecycle, startup tracking (startPhase/endPhase/markMilestone/
 * completeStartup), performance measurement (measure/measureAsync),
 * validateBudgets, getReport, exportJSON, logStatus, event handlers
 * (_handleMemoryBudgetExceeded/_handleLeakDetected/_handleBudgetViolation/
 * _handleBudgetWarning), window global attachment.
 *
 * @module tests/unit/infrastructure/PerformanceIntegration.test
 */

// ---------------------------------------------------------------------------
// Mocks -- all submodules and logger
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

// Mock StartupProfiler
const mockStartupProfiler = {
  startPhase: jest.fn(),
  endPhase: jest.fn().mockReturnValue(100),
  markMilestone: jest.fn(),
  completeStartup: jest.fn(),
  getMetrics: jest.fn().mockReturnValue({
    total: 1200,
    phases: [
      { name: 'preload', duration: 80 },
      { name: 'bootstrap', duration: 300 },
      { name: 'module-load', duration: 200 },
    ],
    navigation: { domContentLoaded: 400, domInteractive: 900 },
    paint: { firstPaint: 500, firstContentfulPaint: 700 },
  }),
  logSummary: jest.fn(),
  getSummary: jest.fn().mockReturnValue({ total: 1200 }),
};

jest.mock('../../../src/infrastructure/monitoring/StartupProfiler', () => ({
  StartupProfiler: jest.fn(() => mockStartupProfiler),
  PHASES: { PRELOAD: 'preload', BOOTSTRAP: 'bootstrap', MODULE_LOAD: 'module-load' },
  MILESTONES: { COMPLETE: 'complete' },
}));

// Mock MemoryMonitor
const mockMemoryMonitor = {
  start: jest.fn(),
  stop: jest.fn(),
  getCurrentMemory: jest.fn().mockReturnValue({ usedJSHeapSize: 100 * 1024 * 1024 }),
  getReport: jest.fn().mockReturnValue({ current: 100 }),
  forceGC: jest.fn(),
  logStatus: jest.fn(),
};

jest.mock('../../../src/infrastructure/monitoring/MemoryMonitor', () => ({
  MemoryMonitor: jest.fn(() => mockMemoryMonitor),
}));

// Mock PerformanceBudget
const mockPerformanceBudget = {
  validateStartup: jest.fn().mockReturnValue({ passed: true, violations: [], warnings: [] }),
  validateMemory: jest.fn().mockReturnValue({ passed: true, violations: [], warnings: [] }),
  validateRuntime: jest.fn().mockReturnValue({ passed: true, violations: [], warnings: [] }),
  getStatus: jest.fn().mockReturnValue({ overall: 'pass', violations: 0, warnings: 0 }),
  getReport: jest.fn().mockReturnValue({}),
};

jest.mock('../../../src/infrastructure/monitoring/PerformanceBudget', () => ({
  PerformanceBudget: jest.fn(() => mockPerformanceBudget),
}));

// Mock RendererOptimizer
const mockRendererOptimizer = {
  _applyOptimizations: jest.fn(),
  getReport: jest.fn().mockReturnValue({ optimizations: [] }),
};

jest.mock('../../../src/infrastructure/monitoring/RendererOptimizer', () => ({
  RendererOptimizer: jest.fn(() => mockRendererOptimizer),
}));

// Mock MetricsCollector
const mockMetricsCollector = {
  start: jest.fn(),
  stop: jest.fn(),
  getFPSStats: jest.fn().mockReturnValue({ current: 60 }),
  getLatencyStats: jest.fn().mockReturnValue({ current: 50 }),
  getMemoryStats: jest.fn().mockReturnValue({ current: 100 }),
  getRequestStats: jest.fn().mockReturnValue({ total: 10 }),
};

jest.mock('../../../src/infrastructure/monitoring/MetricsCollector', () => ({
  MetricsCollector: jest.fn(() => mockMetricsCollector),
}));

// Mock PerformanceMonitor
const mockPerformanceMonitor = {
  measure: jest.fn((name, fn) => fn()),
  measureAsync: jest.fn(async (name, fn) => await fn()),
  getSummary: jest.fn().mockReturnValue({ operations: 0 }),
  getRenderTiming: jest.fn().mockReturnValue({}),
  getResourceTiming: jest.fn().mockReturnValue({}),
};

jest.mock('../../../src/infrastructure/monitoring/PerformanceMonitor', () => ({
  PerformanceMonitor: jest.fn(() => mockPerformanceMonitor),
}));

// ---------------------------------------------------------------------------
// Require under test (after all mocks)
// ---------------------------------------------------------------------------

const { PerformanceIntegration, PHASES, MILESTONES } = require('../../../src/infrastructure/monitoring/PerformanceIntegration');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PerformanceIntegration', () => {
  let pi;

  beforeEach(() => {
    jest.clearAllMocks();
    delete global.window;
    pi = new PerformanceIntegration({ enableLogging: false });
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('creates instance with default options', () => {
      expect(pi).toBeDefined();
      expect(pi.enableLogging).toBe(false);
      expect(pi.config).toEqual({});
    });

    it('defaults enableLogging to true', () => {
      const p = new PerformanceIntegration();
      expect(p.enableLogging).toBe(true);
    });

    it('stores custom config', () => {
      const cfg = { startupBudget: 5000 };
      const p = new PerformanceIntegration({ config: cfg, enableLogging: false });
      expect(p.config).toBe(cfg);
    });

    it('initialises all 6 submodules', () => {
      expect(pi.startupProfiler).toBe(mockStartupProfiler);
      expect(pi.memoryMonitor).toBe(mockMemoryMonitor);
      expect(pi.performanceBudget).toBe(mockPerformanceBudget);
      expect(pi.rendererOptimizer).toBe(mockRendererOptimizer);
      expect(pi.metricsCollector).toBe(mockMetricsCollector);
      expect(pi.performanceMonitor).toBe(mockPerformanceMonitor);
    });

    it('attaches to window.__PERFORMANCE__ when window exists', () => {
      global.window = {};
      const p = new PerformanceIntegration({ enableLogging: false });
      expect(global.window.__PERFORMANCE__).toBe(p);
      delete global.window;
    });

    it('does not throw when window is undefined', () => {
      delete global.window;
      expect(() => new PerformanceIntegration({ enableLogging: false })).not.toThrow();
    });

    it('logs info when enableLogging is true', () => {
      new PerformanceIntegration({ enableLogging: true });
      expect(mockLog.info).toHaveBeenCalledWith('[PerformanceIntegration] Initialized');
    });
  });

  // =========================================================================
  // Exports
  // =========================================================================

  describe('exports', () => {
    it('re-exports PHASES from StartupProfiler', () => {
      expect(PHASES).toEqual({ PRELOAD: 'preload', BOOTSTRAP: 'bootstrap', MODULE_LOAD: 'module-load' });
    });

    it('re-exports MILESTONES from StartupProfiler', () => {
      expect(MILESTONES).toEqual({ COMPLETE: 'complete' });
    });
  });

  // =========================================================================
  // start / stop
  // =========================================================================

  describe('start', () => {
    it('starts memoryMonitor by default', () => {
      pi.start();
      expect(mockMemoryMonitor.start).toHaveBeenCalledTimes(1);
    });

    it('starts metricsCollector by default', () => {
      pi.start();
      expect(mockMetricsCollector.start).toHaveBeenCalledTimes(1);
    });

    it('applies renderer optimizations by default', () => {
      pi.start();
      expect(mockRendererOptimizer._applyOptimizations).toHaveBeenCalledTimes(1);
    });

    it('skips memoryMonitor.start when enableMemoryMonitoring is false', () => {
      const p = new PerformanceIntegration({
        config: { enableMemoryMonitoring: false },
        enableLogging: false,
      });
      p.start();
      // The mock is shared, so we check it was NOT called after clearing
      jest.clearAllMocks();
      p.start();
      expect(mockMemoryMonitor.start).not.toHaveBeenCalled();
    });

    it('skips metricsCollector.start when enableMonitoring is false', () => {
      const p = new PerformanceIntegration({
        config: { enableMonitoring: false },
        enableLogging: false,
      });
      jest.clearAllMocks();
      p.start();
      expect(mockMetricsCollector.start).not.toHaveBeenCalled();
    });

    it('skips renderer optimizations when enableRendererOptimization is false', () => {
      const p = new PerformanceIntegration({
        config: { enableRendererOptimization: false },
        enableLogging: false,
      });
      jest.clearAllMocks();
      p.start();
      expect(mockRendererOptimizer._applyOptimizations).not.toHaveBeenCalled();
    });

    it('logs when enableLogging is true', () => {
      const p = new PerformanceIntegration({ enableLogging: true });
      jest.clearAllMocks();
      p.start();
      expect(mockLog.info).toHaveBeenCalledWith('[PerformanceIntegration] Started monitoring');
    });
  });

  describe('stop', () => {
    it('stops memoryMonitor and metricsCollector', () => {
      pi.stop();
      expect(mockMemoryMonitor.stop).toHaveBeenCalledTimes(1);
      expect(mockMetricsCollector.stop).toHaveBeenCalledTimes(1);
    });

    it('logs when enableLogging is true', () => {
      const p = new PerformanceIntegration({ enableLogging: true });
      jest.clearAllMocks();
      p.stop();
      expect(mockLog.info).toHaveBeenCalledWith('[PerformanceIntegration] Stopped monitoring');
    });
  });

  // =========================================================================
  // Startup tracking
  // =========================================================================

  describe('startPhase', () => {
    it('delegates to startupProfiler', () => {
      pi.startPhase('preload');
      expect(mockStartupProfiler.startPhase).toHaveBeenCalledWith('preload');
    });
  });

  describe('endPhase', () => {
    it('delegates to startupProfiler and returns result', () => {
      const result = pi.endPhase('preload');
      expect(mockStartupProfiler.endPhase).toHaveBeenCalledWith('preload');
      expect(result).toBe(100);
    });
  });

  describe('markMilestone', () => {
    it('delegates to startupProfiler', () => {
      pi.markMilestone('dom-ready');
      expect(mockStartupProfiler.markMilestone).toHaveBeenCalledWith('dom-ready');
    });
  });

  describe('completeStartup', () => {
    it('marks COMPLETE milestone and completes startup', async () => {
      await pi.completeStartup();
      expect(mockStartupProfiler.markMilestone).toHaveBeenCalledWith('complete');
      expect(mockStartupProfiler.completeStartup).toHaveBeenCalledTimes(1);
    });

    it('validates startup budget with all 8 mapped metrics', async () => {
      await pi.completeStartup();
      expect(mockPerformanceBudget.validateStartup).toHaveBeenCalledWith({
        total: 1200,
        preload: 80,
        domReady: 400,
        bootstrap: 300,
        moduleLoad: 200,
        firstPaint: 500,
        firstContentfulPaint: 700,
        interactive: 900,
      });
    });

    it('validates memory budget when memory available', async () => {
      await pi.completeStartup();
      expect(mockPerformanceBudget.validateMemory).toHaveBeenCalledTimes(1);
    });

    it('skips memory validation when getCurrentMemory returns null', async () => {
      mockMemoryMonitor.getCurrentMemory.mockReturnValueOnce(null);
      await pi.completeStartup();
      expect(mockPerformanceBudget.validateMemory).not.toHaveBeenCalled();
    });

    it('handles missing phases/navigation/paint with undefined values', async () => {
      mockStartupProfiler.getMetrics.mockReturnValueOnce({
        total: 500,
        phases: [], // no phases at all
        navigation: null,
        paint: null,
      });
      await pi.completeStartup();
      expect(mockPerformanceBudget.validateStartup).toHaveBeenCalledWith({
        total: 500,
        preload: undefined,
        domReady: undefined,
        bootstrap: undefined,
        moduleLoad: undefined,
        firstPaint: undefined,
        firstContentfulPaint: undefined,
        interactive: undefined,
      });
    });

    it('returns startup validation, metrics, and memory', async () => {
      const result = await pi.completeStartup();
      expect(result).toHaveProperty('startup');
      expect(result).toHaveProperty('metrics');
      expect(result).toHaveProperty('memory');
      expect(result.startup.passed).toBe(true);
    });

    it('logs summary on pass when enableLogging is true', async () => {
      const p = new PerformanceIntegration({ enableLogging: true });
      jest.clearAllMocks();
      await p.completeStartup();
      expect(mockStartupProfiler.logSummary).toHaveBeenCalledTimes(1);
      expect(mockLog.info).toHaveBeenCalledWith(
        '[PerformanceIntegration] ✅ All startup budgets passed'
      );
    });

    it('logs warning on startup violation when enableLogging is true', async () => {
      mockPerformanceBudget.validateStartup.mockReturnValueOnce({
        passed: false,
        violations: [{ metric: 'total' }],
        warnings: [],
      });
      const p = new PerformanceIntegration({ enableLogging: true });
      jest.clearAllMocks();
      await p.completeStartup();
      expect(mockLog.warn).toHaveBeenCalledWith(
        '[PerformanceIntegration] Startup budget violations detected'
      );
    });
  });

  // =========================================================================
  // Performance measurement
  // =========================================================================

  describe('measure', () => {
    it('delegates to performanceMonitor and returns result', () => {
      const fn = () => 42;
      const result = pi.measure('op', fn);
      expect(mockPerformanceMonitor.measure).toHaveBeenCalledWith('op', fn);
      expect(result).toBe(42);
    });
  });

  describe('measureAsync', () => {
    it('delegates to performanceMonitor and returns result', async () => {
      const fn = async () => 99;
      const result = await pi.measureAsync('async-op', fn);
      expect(mockPerformanceMonitor.measureAsync).toHaveBeenCalledWith('async-op', fn);
      expect(result).toBe(99);
    });
  });

  // =========================================================================
  // validateBudgets
  // =========================================================================

  describe('validateBudgets', () => {
    it('validates memory when getCurrentMemory returns data', () => {
      const result = pi.validateBudgets();
      expect(mockPerformanceBudget.validateMemory).toHaveBeenCalledTimes(1);
      expect(result.memory).toBeDefined();
    });

    it('skips memory validation when getCurrentMemory returns null', () => {
      mockMemoryMonitor.getCurrentMemory.mockReturnValueOnce(null);
      const result = pi.validateBudgets();
      expect(result.memory).toBeUndefined();
    });

    it('validates runtime with FPS and latency from metricsCollector', () => {
      pi.validateBudgets();
      expect(mockPerformanceBudget.validateRuntime).toHaveBeenCalledWith({
        fps: 60,
        latency: 50,
      });
    });

    it('returns frozen result', () => {
      const result = pi.validateBudgets();
      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  // =========================================================================
  // Reporting
  // =========================================================================

  describe('getReport', () => {
    it('contains all expected sections', () => {
      const report = pi.getReport();
      expect(report).toHaveProperty('timestamp');
      expect(report).toHaveProperty('startup');
      expect(report).toHaveProperty('memory');
      expect(report).toHaveProperty('budgets');
      expect(report).toHaveProperty('metrics');
      expect(report).toHaveProperty('performance');
      expect(report).toHaveProperty('optimization');
    });

    it('delegates to all submodule report methods', () => {
      pi.getReport();
      expect(mockStartupProfiler.getMetrics).toHaveBeenCalled();
      expect(mockMemoryMonitor.getReport).toHaveBeenCalled();
      expect(mockPerformanceBudget.getStatus).toHaveBeenCalled();
      expect(mockMetricsCollector.getFPSStats).toHaveBeenCalled();
      expect(mockMetricsCollector.getLatencyStats).toHaveBeenCalled();
      expect(mockMetricsCollector.getMemoryStats).toHaveBeenCalled();
      expect(mockMetricsCollector.getRequestStats).toHaveBeenCalled();
      expect(mockPerformanceMonitor.getSummary).toHaveBeenCalled();
      expect(mockPerformanceMonitor.getRenderTiming).toHaveBeenCalled();
      expect(mockPerformanceMonitor.getResourceTiming).toHaveBeenCalled();
      expect(mockRendererOptimizer.getReport).toHaveBeenCalled();
    });

    it('returns frozen object', () => {
      const report = pi.getReport();
      expect(Object.isFrozen(report)).toBe(true);
    });
  });

  describe('exportJSON', () => {
    it('returns valid JSON string', () => {
      const json = pi.exportJSON();
      expect(typeof json).toBe('string');
      const parsed = JSON.parse(json);
      expect(parsed).toHaveProperty('timestamp');
    });
  });

  describe('logStatus', () => {
    it('logs performance status and delegates to memoryMonitor.logStatus', () => {
      pi.logStatus();
      expect(mockPerformanceBudget.getStatus).toHaveBeenCalled();
      expect(mockPerformanceMonitor.getSummary).toHaveBeenCalled();
      expect(mockStartupProfiler.getSummary).toHaveBeenCalled();
      expect(mockMemoryMonitor.logStatus).toHaveBeenCalled();
      expect(mockLog.info).toHaveBeenCalledWith(
        '[PerformanceIntegration] Performance Status',
        expect.any(Object)
      );
    });
  });

  // =========================================================================
  // Event handlers
  // =========================================================================

  describe('_handleMemoryBudgetExceeded', () => {
    it('logs error, forces GC, and logs memory status', () => {
      const mem = { usedJSHeapSize: 999 };
      pi._handleMemoryBudgetExceeded(mem);
      expect(mockLog.error).toHaveBeenCalledWith(
        '[PerformanceIntegration] ❌ MEMORY BUDGET EXCEEDED:',
        mem
      );
      expect(mockMemoryMonitor.forceGC).toHaveBeenCalledTimes(1);
      expect(mockMemoryMonitor.logStatus).toHaveBeenCalledTimes(1);
    });
  });

  describe('_handleLeakDetected', () => {
    it('logs warning with leak data', () => {
      const leak = { type: 'grow', delta: 50 };
      pi._handleLeakDetected(leak);
      expect(mockLog.warn).toHaveBeenCalledWith(
        '[PerformanceIntegration] ⚠️  POTENTIAL MEMORY LEAK DETECTED:',
        leak
      );
    });
  });

  describe('_handleBudgetViolation', () => {
    it('logs warning with violation data', () => {
      const violation = { category: 'startup', metric: 'total' };
      pi._handleBudgetViolation(violation);
      expect(mockLog.warn).toHaveBeenCalledWith(
        '[PerformanceIntegration] ⚠️  BUDGET VIOLATION:',
        violation
      );
    });
  });

  describe('_handleBudgetWarning', () => {
    it('logs warning when enableLogging is true', () => {
      const p = new PerformanceIntegration({ enableLogging: true });
      jest.clearAllMocks();
      const warning = { category: 'memory', metric: 'heap' };
      p._handleBudgetWarning(warning);
      expect(mockLog.warn).toHaveBeenCalledWith(
        '[PerformanceIntegration] ⚠️  BUDGET WARNING:',
        warning
      );
    });

    it('does not log when enableLogging is false', () => {
      jest.clearAllMocks();
      pi._handleBudgetWarning({ category: 'memory', metric: 'heap' });
      expect(mockLog.warn).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Callback wiring (inline arrow functions in constructor)
  // =========================================================================

  describe('constructor callback wiring', () => {
    it('MemoryMonitor onBudgetExceeded callback delegates to _handleMemoryBudgetExceeded', () => {
      const { MemoryMonitor } = require('../../../src/infrastructure/monitoring/MemoryMonitor');
      // Get the options passed to the last MemoryMonitor constructor call
      const lastCall = MemoryMonitor.mock.calls[MemoryMonitor.mock.calls.length - 1];
      const opts = lastCall[0];
      const spy = jest.spyOn(pi, '_handleMemoryBudgetExceeded').mockImplementation(() => {});
      opts.onBudgetExceeded({ usedJSHeapSize: 999 });
      expect(spy).toHaveBeenCalledWith({ usedJSHeapSize: 999 });
      spy.mockRestore();
    });

    it('MemoryMonitor onLeakDetected callback delegates to _handleLeakDetected', () => {
      const { MemoryMonitor } = require('../../../src/infrastructure/monitoring/MemoryMonitor');
      const lastCall = MemoryMonitor.mock.calls[MemoryMonitor.mock.calls.length - 1];
      const opts = lastCall[0];
      const spy = jest.spyOn(pi, '_handleLeakDetected').mockImplementation(() => {});
      opts.onLeakDetected({ type: 'grow' });
      expect(spy).toHaveBeenCalledWith({ type: 'grow' });
      spy.mockRestore();
    });

    it('PerformanceBudget onViolation callback delegates to _handleBudgetViolation', () => {
      const { PerformanceBudget } = require('../../../src/infrastructure/monitoring/PerformanceBudget');
      const lastCall = PerformanceBudget.mock.calls[PerformanceBudget.mock.calls.length - 1];
      const opts = lastCall[0];
      const spy = jest.spyOn(pi, '_handleBudgetViolation').mockImplementation(() => {});
      opts.onViolation({ category: 'startup' });
      expect(spy).toHaveBeenCalledWith({ category: 'startup' });
      spy.mockRestore();
    });

    it('PerformanceBudget onWarning callback delegates to _handleBudgetWarning', () => {
      const { PerformanceBudget } = require('../../../src/infrastructure/monitoring/PerformanceBudget');
      const lastCall = PerformanceBudget.mock.calls[PerformanceBudget.mock.calls.length - 1];
      const opts = lastCall[0];
      const spy = jest.spyOn(pi, '_handleBudgetWarning').mockImplementation(() => {});
      opts.onWarning({ category: 'memory' });
      expect(spy).toHaveBeenCalledWith({ category: 'memory' });
      spy.mockRestore();
    });
  });

  // =========================================================================
  // Window global
  // =========================================================================

  describe('window global export', () => {
    it('attaches PerformanceIntegration to window when defined', () => {
      jest.isolateModules(() => {
        jest.mock('../../../src/renderer/shared/utils/logger', () => ({
          createRendererLogger: jest.fn(() => ({
            debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
          })),
        }));
        jest.mock('../../../src/infrastructure/monitoring/StartupProfiler', () => ({
          StartupProfiler: jest.fn(() => mockStartupProfiler),
          PHASES: {}, MILESTONES: {},
        }));
        jest.mock('../../../src/infrastructure/monitoring/MemoryMonitor', () => ({
          MemoryMonitor: jest.fn(() => mockMemoryMonitor),
        }));
        jest.mock('../../../src/infrastructure/monitoring/PerformanceBudget', () => ({
          PerformanceBudget: jest.fn(() => mockPerformanceBudget),
        }));
        jest.mock('../../../src/infrastructure/monitoring/RendererOptimizer', () => ({
          RendererOptimizer: jest.fn(() => mockRendererOptimizer),
        }));
        jest.mock('../../../src/infrastructure/monitoring/MetricsCollector', () => ({
          MetricsCollector: jest.fn(() => mockMetricsCollector),
        }));
        jest.mock('../../../src/infrastructure/monitoring/PerformanceMonitor', () => ({
          PerformanceMonitor: jest.fn(() => mockPerformanceMonitor),
        }));

        global.window = {};
        const mod = require('../../../src/infrastructure/monitoring/PerformanceIntegration');
        expect(global.window.PerformanceIntegration).toBe(mod.PerformanceIntegration);
        delete global.window;
      });
    });
  });
});
