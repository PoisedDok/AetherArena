'use strict';

/**
 * RequestLifecycleManager Unit Tests
 * ============================================================================
 * Tests the pure-logic request tracking and lifecycle management.
 * Covers: start/complete/fail/cancel lifecycle, concurrent limits, timeout
 * management, callback invocation, statistics, history, and resource cleanup.
 *
 * @module tests/unit/application/RequestLifecycleManager.test
 */

// Mock renderer logger before require
jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
}));

const { RequestLifecycleManager } = require('../../../src/application/shared/RequestLifecycleManager');

describe('RequestLifecycleManager', () => {
  let manager;

  beforeEach(() => {
    jest.useFakeTimers();
    manager = new RequestLifecycleManager();
  });

  afterEach(() => {
    manager.destroy();
    jest.useRealTimers();
  });

  // -----------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------
  describe('constructor', () => {
    it('uses defaults when no options provided', () => {
      const m = new RequestLifecycleManager();
      expect(m.name).toBe('RequestLifecycleManager');
      expect(m.enableLogging).toBe(false);
      expect(m.defaultTimeout).toBe(120000);
      expect(m.maxConcurrentRequests).toBe(10);
      expect(m.maxHistorySize).toBe(100);
      expect(m.performanceMonitor).toBeNull();
      expect(m.activeRequests.size).toBe(0);
      expect(m.requestHistory).toEqual([]);
      m.destroy();
    });

    it('accepts custom options', () => {
      const perfMon = { start: jest.fn(), end: jest.fn() };
      const m = new RequestLifecycleManager({
        name: 'TestManager',
        enableLogging: true,
        defaultTimeout: 5000,
        maxConcurrentRequests: 3,
        maxHistorySize: 10,
        performanceMonitor: perfMon,
      });
      expect(m.name).toBe('TestManager');
      expect(m.enableLogging).toBe(true);
      expect(m.defaultTimeout).toBe(5000);
      expect(m.maxConcurrentRequests).toBe(3);
      expect(m.maxHistorySize).toBe(10);
      expect(m.performanceMonitor).toBe(perfMon);
      m.destroy();
    });

    it('initializes stats to zero', () => {
      const stats = manager.getStats();
      expect(stats.total).toBe(0);
      expect(stats.completed).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.timeout).toBe(0);
      expect(stats.cancelled).toBe(0);
      expect(stats.active).toBe(0);
    });
  });

  // -----------------------------------------------------------
  // startRequest
  // -----------------------------------------------------------
  describe('startRequest()', () => {
    it('returns a frozen request handle with id, cancel, complete, fail', () => {
      const handle = manager.startRequest();
      expect(handle.id).toMatch(/^req_\d+_/);
      expect(typeof handle.cancel).toBe('function');
      expect(typeof handle.complete).toBe('function');
      expect(typeof handle.fail).toBe('function');
      // Frozen -- cannot add properties
      expect(Object.isFrozen(handle)).toBe(true);
    });

    it('uses provided requestId when given', () => {
      const handle = manager.startRequest({ requestId: 'custom-123' });
      expect(handle.id).toBe('custom-123');
    });

    it('tracks request as active', () => {
      const handle = manager.startRequest();
      expect(manager.isActive(handle.id)).toBe(true);
      expect(manager.activeRequests.size).toBe(1);
    });

    it('increments total and active stats', () => {
      manager.startRequest();
      manager.startRequest();
      const stats = manager.getStats();
      expect(stats.total).toBe(2);
      expect(stats.active).toBe(2);
    });

    it('applies custom type and metadata', () => {
      const handle = manager.startRequest({
        type: 'chat',
        metadata: { chatId: 'abc' },
      });
      const ctx = manager.getRequest(handle.id);
      expect(ctx.type).toBe('chat');
      expect(ctx.metadata).toEqual({ chatId: 'abc' });
    });

    it('throws when concurrent limit exceeded', () => {
      const m = new RequestLifecycleManager({ maxConcurrentRequests: 2 });
      m.startRequest();
      m.startRequest();
      expect(() => m.startRequest()).toThrow('Maximum concurrent requests (2) exceeded');
      m.destroy();
    });

    it('integrates with performanceMonitor', () => {
      const perfMon = { start: jest.fn(), end: jest.fn() };
      const m = new RequestLifecycleManager({ performanceMonitor: perfMon });
      const handle = m.startRequest();
      expect(perfMon.start).toHaveBeenCalledWith(`request:${handle.id}`);
      m.destroy();
    });
  });

  // -----------------------------------------------------------
  // completeRequest
  // -----------------------------------------------------------
  describe('completeRequest()', () => {
    it('removes request from active tracking', () => {
      const handle = manager.startRequest();
      manager.completeRequest(handle.id, { data: 'ok' });
      expect(manager.isActive(handle.id)).toBe(false);
      expect(manager.activeRequests.size).toBe(0);
    });

    it('updates stats correctly', () => {
      const h1 = manager.startRequest();
      const h2 = manager.startRequest();
      manager.completeRequest(h1.id, 'done');
      const stats = manager.getStats();
      expect(stats.completed).toBe(1);
      expect(stats.active).toBe(1);
      expect(stats.total).toBe(2);
    });

    it('adds completed entry to history', () => {
      const handle = manager.startRequest({ type: 'test-type' });
      manager.completeRequest(handle.id, 'result-data');
      const history = manager.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe(handle.id);
      expect(history[0].status).toBe('completed');
      expect(history[0].type).toBe('test-type');
      expect(history[0].result).toBe('result-data');
      expect(typeof history[0].duration).toBe('number');
    });

    it('invokes onComplete callback with result', () => {
      const onComplete = jest.fn();
      const handle = manager.startRequest({ onComplete });
      manager.completeRequest(handle.id, { value: 42 });
      expect(onComplete).toHaveBeenCalledWith({ value: 42 });
    });

    it('clears timeout timer on completion', () => {
      const handle = manager.startRequest({ timeout: 5000 });
      manager.completeRequest(handle.id);
      // Advance past timeout -- should NOT fire
      jest.advanceTimersByTime(10000);
      expect(manager.getStats().timeout).toBe(0);
    });

    it('handles onComplete callback that throws', () => {
      const onComplete = jest.fn(() => { throw new Error('callback crash'); });
      const handle = manager.startRequest({ onComplete });
      // Should not propagate the error
      expect(() => manager.completeRequest(handle.id)).not.toThrow();
      expect(onComplete).toHaveBeenCalled();
    });

    it('silently ignores unknown request ID', () => {
      expect(() => manager.completeRequest('nonexistent')).not.toThrow();
      expect(manager.getStats().completed).toBe(0);
    });

    it('calls performanceMonitor.end on completion', () => {
      const perfMon = { start: jest.fn(), end: jest.fn() };
      const m = new RequestLifecycleManager({ performanceMonitor: perfMon });
      const handle = m.startRequest();
      m.completeRequest(handle.id);
      expect(perfMon.end).toHaveBeenCalledWith(`request:${handle.id}`);
      m.destroy();
    });
  });

  // -----------------------------------------------------------
  // failRequest
  // -----------------------------------------------------------
  describe('failRequest()', () => {
    it('removes request from active tracking', () => {
      const handle = manager.startRequest();
      manager.failRequest(handle.id, new Error('boom'));
      expect(manager.isActive(handle.id)).toBe(false);
    });

    it('updates failed stats', () => {
      const handle = manager.startRequest();
      manager.failRequest(handle.id, 'error msg');
      const stats = manager.getStats();
      expect(stats.failed).toBe(1);
      expect(stats.active).toBe(0);
    });

    it('stores error message in history for Error objects', () => {
      const handle = manager.startRequest();
      manager.failRequest(handle.id, new Error('network failure'));
      const history = manager.getHistory();
      expect(history[0].status).toBe('failed');
      expect(history[0].error).toBe('network failure');
    });

    it('stores string errors directly in history', () => {
      const handle = manager.startRequest();
      manager.failRequest(handle.id, 'string error');
      const history = manager.getHistory();
      expect(history[0].error).toBe('string error');
    });

    it('clears timeout timer on failure', () => {
      const handle = manager.startRequest({ timeout: 5000 });
      manager.failRequest(handle.id, 'err');
      jest.advanceTimersByTime(10000);
      expect(manager.getStats().timeout).toBe(0);
    });

    it('silently ignores unknown request ID', () => {
      expect(() => manager.failRequest('nonexistent', 'err')).not.toThrow();
      expect(manager.getStats().failed).toBe(0);
    });
  });

  // -----------------------------------------------------------
  // cancelRequest
  // -----------------------------------------------------------
  describe('cancelRequest()', () => {
    it('returns true on successful cancellation', () => {
      const handle = manager.startRequest();
      expect(manager.cancelRequest(handle.id)).toBe(true);
    });

    it('returns false for unknown request', () => {
      expect(manager.cancelRequest('nonexistent')).toBe(false);
    });

    it('removes from active tracking', () => {
      const handle = manager.startRequest();
      manager.cancelRequest(handle.id);
      expect(manager.isActive(handle.id)).toBe(false);
    });

    it('updates cancelled stats', () => {
      const handle = manager.startRequest();
      manager.cancelRequest(handle.id);
      expect(manager.getStats().cancelled).toBe(1);
      expect(manager.getStats().active).toBe(0);
    });

    it('invokes onCancel callback', () => {
      const onCancel = jest.fn();
      const handle = manager.startRequest({ onCancel });
      manager.cancelRequest(handle.id);
      expect(onCancel).toHaveBeenCalled();
    });

    it('handles onCancel callback that throws', () => {
      const onCancel = jest.fn(() => { throw new Error('cancel crash'); });
      const handle = manager.startRequest({ onCancel });
      expect(() => manager.cancelRequest(handle.id)).not.toThrow();
      expect(onCancel).toHaveBeenCalled();
    });

    it('stores cancelled entry in history', () => {
      const handle = manager.startRequest();
      manager.cancelRequest(handle.id);
      const history = manager.getHistory();
      expect(history[0].status).toBe('cancelled');
    });

    it('clears timeout on cancellation', () => {
      const handle = manager.startRequest({ timeout: 5000 });
      manager.cancelRequest(handle.id);
      jest.advanceTimersByTime(10000);
      expect(manager.getStats().timeout).toBe(0);
    });
  });

  // -----------------------------------------------------------
  // Timeout handling
  // -----------------------------------------------------------
  describe('timeout handling', () => {
    it('fires timeout when timer expires', () => {
      manager.startRequest({ timeout: 3000 });
      jest.advanceTimersByTime(3000);
      expect(manager.getStats().timeout).toBe(1);
      expect(manager.getStats().active).toBe(0);
    });

    it('invokes onTimeout callback when timer fires', () => {
      const onTimeout = jest.fn();
      manager.startRequest({ timeout: 1000, onTimeout });
      jest.advanceTimersByTime(1000);
      expect(onTimeout).toHaveBeenCalled();
    });

    it('handles onTimeout callback that throws', () => {
      const onTimeout = jest.fn(() => { throw new Error('timeout crash'); });
      manager.startRequest({ timeout: 1000, onTimeout });
      expect(() => jest.advanceTimersByTime(1000)).not.toThrow();
    });

    it('stores timeout entry in history', () => {
      manager.startRequest({ timeout: 500, type: 'timed-op' });
      jest.advanceTimersByTime(500);
      const history = manager.getHistory();
      expect(history[0].status).toBe('timeout');
      expect(history[0].type).toBe('timed-op');
    });

    it('does not timeout after completion', () => {
      const handle = manager.startRequest({ timeout: 1000 });
      manager.completeRequest(handle.id);
      jest.advanceTimersByTime(2000);
      expect(manager.getStats().timeout).toBe(0);
    });

    it('does not set timeout when timeout is 0', () => {
      const handle = manager.startRequest({ timeout: 0 });
      jest.advanceTimersByTime(500000);
      expect(manager.getStats().timeout).toBe(0);
      expect(manager.isActive(handle.id)).toBe(true);
      manager.cancelRequest(handle.id);
    });
  });

  // -----------------------------------------------------------
  // Request handle convenience methods
  // -----------------------------------------------------------
  describe('request handle methods', () => {
    it('handle.complete() completes the request', () => {
      const handle = manager.startRequest();
      handle.complete('done');
      expect(manager.isActive(handle.id)).toBe(false);
      expect(manager.getStats().completed).toBe(1);
    });

    it('handle.fail() fails the request', () => {
      const handle = manager.startRequest();
      handle.fail(new Error('oops'));
      expect(manager.isActive(handle.id)).toBe(false);
      expect(manager.getStats().failed).toBe(1);
    });

    it('handle.cancel() cancels the request', () => {
      const handle = manager.startRequest();
      handle.cancel();
      expect(manager.isActive(handle.id)).toBe(false);
      expect(manager.getStats().cancelled).toBe(1);
    });
  });

  // -----------------------------------------------------------
  // isActive / getRequest / getActiveRequests
  // -----------------------------------------------------------
  describe('query methods', () => {
    it('isActive returns false for unknown ID', () => {
      expect(manager.isActive('does-not-exist')).toBe(false);
    });

    it('getRequest returns null for unknown ID', () => {
      expect(manager.getRequest('does-not-exist')).toBeNull();
    });

    it('getRequest returns frozen copy', () => {
      const handle = manager.startRequest({ type: 'query-test' });
      const ctx = manager.getRequest(handle.id);
      expect(Object.isFrozen(ctx)).toBe(true);
      expect(ctx.type).toBe('query-test');
    });

    it('getActiveRequests returns array of all active', () => {
      manager.startRequest({ type: 'a' });
      manager.startRequest({ type: 'b' });
      const active = manager.getActiveRequests();
      expect(active).toHaveLength(2);
      expect(active.every(r => Object.isFrozen(r))).toBe(true);
    });

    it('getActiveRequests returns empty array when none active', () => {
      expect(manager.getActiveRequests()).toEqual([]);
    });
  });

  // -----------------------------------------------------------
  // cancelAll
  // -----------------------------------------------------------
  describe('cancelAll()', () => {
    it('cancels all active requests and returns count', () => {
      manager.startRequest();
      manager.startRequest();
      manager.startRequest();
      const count = manager.cancelAll();
      expect(count).toBe(3);
      expect(manager.activeRequests.size).toBe(0);
    });

    it('returns 0 when no active requests', () => {
      expect(manager.cancelAll()).toBe(0);
    });

    it('invokes onCancel for each', () => {
      const cb1 = jest.fn();
      const cb2 = jest.fn();
      manager.startRequest({ onCancel: cb1 });
      manager.startRequest({ onCancel: cb2 });
      manager.cancelAll();
      expect(cb1).toHaveBeenCalled();
      expect(cb2).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------
  // Statistics
  // -----------------------------------------------------------
  describe('getStats()', () => {
    it('calculates successRate as percentage', () => {
      const h1 = manager.startRequest();
      const h2 = manager.startRequest();
      const h3 = manager.startRequest();
      manager.completeRequest(h1.id);
      manager.completeRequest(h2.id);
      manager.failRequest(h3.id, 'err');
      const stats = manager.getStats();
      expect(stats.successRate).toBe('66.67');
    });

    it('returns 0 successRate when no requests', () => {
      expect(manager.getStats().successRate).toBe(0);
    });

    it('calculates avgDuration from history', () => {
      const h1 = manager.startRequest();
      jest.advanceTimersByTime(100);
      manager.completeRequest(h1.id);

      const h2 = manager.startRequest();
      jest.advanceTimersByTime(300);
      manager.completeRequest(h2.id);

      const stats = manager.getStats();
      expect(stats.avgDuration).toBe(200); // (100+300)/2
    });

    it('returns frozen stats object', () => {
      const stats = manager.getStats();
      expect(Object.isFrozen(stats)).toBe(true);
    });
  });

  // -----------------------------------------------------------
  // History
  // -----------------------------------------------------------
  describe('getHistory()', () => {
    it('returns frozen array', () => {
      const h = manager.startRequest();
      manager.completeRequest(h.id);
      const history = manager.getHistory();
      expect(Object.isFrozen(history)).toBe(true);
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        const h = manager.startRequest();
        manager.completeRequest(h.id);
      }
      expect(manager.getHistory(2)).toHaveLength(2);
      expect(manager.getHistory()).toHaveLength(5);
    });

    it('trims history when exceeding maxHistorySize', () => {
      const m = new RequestLifecycleManager({ maxHistorySize: 3 });
      for (let i = 0; i < 5; i++) {
        const h = m.startRequest();
        m.completeRequest(h.id);
      }
      expect(m.getHistory()).toHaveLength(3);
      m.destroy();
    });
  });

  describe('clearHistory()', () => {
    it('empties history array', () => {
      const h = manager.startRequest();
      manager.completeRequest(h.id);
      expect(manager.getHistory()).toHaveLength(1);
      manager.clearHistory();
      expect(manager.getHistory()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------
  // reset
  // -----------------------------------------------------------
  describe('reset()', () => {
    it('zeros all stats but preserves active count', () => {
      const h1 = manager.startRequest();
      manager.completeRequest(h1.id);
      manager.startRequest(); // still active

      manager.reset();

      const stats = manager.getStats();
      expect(stats.total).toBe(0);
      expect(stats.completed).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.timeout).toBe(0);
      expect(stats.cancelled).toBe(0);
      // active reflects current Map size
      expect(stats.active).toBe(1);
    });
  });

  // -----------------------------------------------------------
  // destroy
  // -----------------------------------------------------------
  describe('destroy()', () => {
    it('cancels all active requests', () => {
      manager.startRequest();
      manager.startRequest();
      manager.destroy();
      expect(manager.activeRequests.size).toBe(0);
    });

    it('clears history', () => {
      const h = manager.startRequest();
      manager.completeRequest(h.id);
      manager.destroy();
      expect(manager.getHistory()).toHaveLength(0);
    });

    it('resets stats', () => {
      const h = manager.startRequest();
      manager.completeRequest(h.id);
      manager.destroy();
      expect(manager.getStats().total).toBe(0);
      expect(manager.getStats().completed).toBe(0);
    });

    it('is safe to call twice', () => {
      expect(() => {
        manager.destroy();
        manager.destroy();
      }).not.toThrow();
    });
  });

  // -----------------------------------------------------------
  // enableLogging branches
  // -----------------------------------------------------------
  describe('enableLogging branches', () => {
    let loggingManager;

    beforeEach(() => {
      loggingManager = new RequestLifecycleManager({ enableLogging: true });
    });

    afterEach(() => {
      loggingManager.destroy();
    });

    it('logs on startRequest', () => {
      const handle = loggingManager.startRequest({ type: 'logged' });
      expect(loggingManager.isActive(handle.id)).toBe(true);
    });

    it('logs on completeRequest', () => {
      const handle = loggingManager.startRequest();
      loggingManager.completeRequest(handle.id, 'result');
      expect(loggingManager.getStats().completed).toBe(1);
    });

    it('logs on cancelRequest', () => {
      const handle = loggingManager.startRequest();
      expect(loggingManager.cancelRequest(handle.id)).toBe(true);
      expect(loggingManager.getStats().cancelled).toBe(1);
    });
  });

  // -----------------------------------------------------------
  // performanceMonitor integration (fail / timeout)
  // -----------------------------------------------------------
  describe('performanceMonitor integration (fail/timeout)', () => {
    it('calls performanceMonitor.end on failRequest', () => {
      const perfMon = { start: jest.fn(), end: jest.fn() };
      const m = new RequestLifecycleManager({ performanceMonitor: perfMon });
      const handle = m.startRequest();
      m.failRequest(handle.id, new Error('perf-fail'));
      expect(perfMon.end).toHaveBeenCalledWith(`request:${handle.id}`);
      m.destroy();
    });

    it('calls performanceMonitor.end on timeout', () => {
      const perfMon = { start: jest.fn(), end: jest.fn() };
      const m = new RequestLifecycleManager({ performanceMonitor: perfMon });
      const handle = m.startRequest({ timeout: 500 });
      jest.advanceTimersByTime(500);
      expect(perfMon.end).toHaveBeenCalledWith(`request:${handle.id}`);
      m.destroy();
    });
  });

  // -----------------------------------------------------------
  // Edge cases: no timeout handle + defensive guards
  // -----------------------------------------------------------
  describe('edge cases', () => {
    it('completeRequest handles request with no timeoutHandle (timeout=0)', () => {
      const handle = manager.startRequest({ timeout: 0 });
      manager.completeRequest(handle.id, 'no-timeout-result');
      expect(manager.getStats().completed).toBe(1);
      const history = manager.getHistory();
      expect(history[0].result).toBe('no-timeout-result');
    });

    it('failRequest handles request with no timeoutHandle (timeout=0)', () => {
      const handle = manager.startRequest({ timeout: 0 });
      manager.failRequest(handle.id, 'no-timeout-error');
      expect(manager.getStats().failed).toBe(1);
      const history = manager.getHistory();
      expect(history[0].error).toBe('no-timeout-error');
    });

    it('_handleTimeout is a no-op when context already removed', () => {
      // Defensive guard: timeout fires after request already completed/cancelled
      expect(() => manager._handleTimeout('already-gone')).not.toThrow();
      expect(manager.getStats().timeout).toBe(0);
    });
  });

  // -----------------------------------------------------------
  // window global export
  // -----------------------------------------------------------
  describe('window global export', () => {
    it('assigns RequestLifecycleManager to window when window is defined', () => {
      const origWindow = global.window;
      global.window = {};

      jest.isolateModules(() => {
        jest.mock('../../../src/renderer/shared/utils/logger', () => ({
          createRendererLogger: () => ({
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
            trace: jest.fn(),
          }),
        }));
        const { RequestLifecycleManager: RLM } = require('../../../src/application/shared/RequestLifecycleManager');
        expect(global.window.RequestLifecycleManager).toBe(RLM);
      });

      if (origWindow === undefined) {
        delete global.window;
      } else {
        global.window = origWindow;
      }
    });
  });

  // -----------------------------------------------------------
  // Full lifecycle integration
  // -----------------------------------------------------------
  describe('full lifecycle', () => {
    it('complete flow: start -> complete -> stats -> history', () => {
      const onComplete = jest.fn();
      const handle = manager.startRequest({
        type: 'integration',
        metadata: { test: true },
        onComplete,
      });

      expect(manager.isActive(handle.id)).toBe(true);

      jest.advanceTimersByTime(50);
      manager.completeRequest(handle.id, { success: true });

      expect(manager.isActive(handle.id)).toBe(false);
      expect(onComplete).toHaveBeenCalledWith({ success: true });

      const stats = manager.getStats();
      expect(stats.total).toBe(1);
      expect(stats.completed).toBe(1);
      expect(stats.successRate).toBe('100.00');
      expect(stats.avgDuration).toBe(50);

      const history = manager.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe('completed');
    });

    it('mixed flow: start 3, complete 1, fail 1, timeout 1', () => {
      const h1 = manager.startRequest({ timeout: 1000 });
      const h2 = manager.startRequest();
      const h3 = manager.startRequest();

      manager.completeRequest(h2.id, 'ok');
      manager.failRequest(h3.id, 'error');
      jest.advanceTimersByTime(1000); // h1 times out

      const stats = manager.getStats();
      expect(stats.total).toBe(3);
      expect(stats.completed).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.timeout).toBe(1);
      expect(stats.active).toBe(0);
    });
  });
});
