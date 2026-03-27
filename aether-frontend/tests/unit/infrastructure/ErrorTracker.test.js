/** @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js */
'use strict';

/**
 * ErrorTracker Unit Tests
 * ============================================================================
 * Tests error capture, deduplication, rate limiting, backend reporting,
 * global handler attachment, statistics, export, and clear.
 *
 * @module tests/unit/infrastructure/ErrorTracker.test
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

const { ErrorTracker } = require('../../../src/infrastructure/monitoring/ErrorTracker');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ErrorTracker', () => {
  let tracker;

  beforeEach(() => {
    jest.clearAllMocks();
    tracker = new ErrorTracker({ autoAttach: false });
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('creates with defaults', () => {
      expect(tracker.enableLogging).toBe(false);
      expect(tracker.reportToBackend).toBe(false);
      expect(tracker.maxErrorsPerMinute).toBe(10);
      expect(tracker.errors).toEqual([]);
    });

    it('accepts custom options', () => {
      const t = new ErrorTracker({
        autoAttach: false,
        enableLogging: true,
        reportToBackend: true,
        backendURL: 'http://localhost',
        maxErrorsPerMinute: 5,
        maxStoredErrors: 20,
      });
      expect(t.enableLogging).toBe(true);
      expect(t.reportToBackend).toBe(true);
      expect(t.backendURL).toBe('http://localhost');
      expect(t.maxErrorsPerMinute).toBe(5);
      expect(t.maxStoredErrors).toBe(20);
    });
  });

  // =========================================================================
  // captureError()
  // =========================================================================

  describe('captureError()', () => {
    it('captures Error object and returns error ID', () => {
      const id = tracker.captureError(new Error('test'));
      expect(id).toMatch(/^err_/);
      expect(tracker.errors).toHaveLength(1);
      expect(tracker.errors[0].message).toBe('test');
    });

    it('captures string error', () => {
      tracker.captureError('string error');
      expect(tracker.errors[0].message).toBe('string error');
      expect(tracker.errors[0].name).toBe('Error');
    });

    it('captures plain object error', () => {
      tracker.captureError({ name: 'CustomError', message: 'custom msg' });
      expect(tracker.errors[0].name).toBe('CustomError');
      expect(tracker.errors[0].message).toBe('custom msg');
    });

    it('captures non-standard types', () => {
      tracker.captureError(42);
      expect(tracker.errors[0].message).toBe('42');
    });

    it('attaches context', () => {
      tracker.captureError(new Error('test'), { component: 'UI' });
      expect(tracker.errors[0].context.component).toBe('UI');
      expect(tracker.errors[0].context.timestamp).toBeDefined();
    });

    it('logs when enableLogging is true', () => {
      tracker.enableLogging = true;
      tracker.captureError(new Error('logged'));
      expect(mockLog.error).toHaveBeenCalledWith('captured error', expect.any(Object));
    });

    it('trims stored errors to maxStoredErrors', () => {
      tracker.maxStoredErrors = 3;
      tracker.deduplicationWindow = 0; // disable dedup for this test
      for (let i = 0; i < 5; i++) {
        tracker.captureError(new Error(`err-${i}`));
      }
      expect(tracker.errors).toHaveLength(3);
      expect(tracker.errors[0].message).toBe('err-2');
    });
  });

  // =========================================================================
  // Deduplication
  // =========================================================================

  describe('deduplication', () => {
    it('deduplicates same error within window', () => {
      const err = new Error('dup');
      tracker.captureError(err);
      const id2 = tracker.captureError(err);
      expect(id2).toBeNull();
      expect(tracker.stats.deduplicatedErrors).toBe(1);
      expect(tracker.errors).toHaveLength(1);
    });

    it('allows same error after dedup window passes', () => {
      tracker.deduplicationWindow = 50; // 50ms
      const err = new Error('dup');
      tracker.captureError(err);
      // Manually expire the dedup entry
      for (const [key] of tracker.lastErrorTimes) {
        tracker.lastErrorTimes.set(key, Date.now() - 100);
      }
      const id2 = tracker.captureError(err);
      expect(id2).toMatch(/^err_/);
    });
  });

  // =========================================================================
  // Rate limiting
  // =========================================================================

  describe('rate limiting', () => {
    it('rate limits after maxErrorsPerMinute', () => {
      tracker.maxErrorsPerMinute = 3;
      tracker.deduplicationWindow = 0;
      for (let i = 0; i < 3; i++) {
        tracker.captureError(new Error(`e${i}`));
      }
      const id = tracker.captureError(new Error('e3'));
      expect(id).toBeNull();
      expect(tracker.stats.rateLimitedErrors).toBe(1);
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('rate limit'));
    });

    it('resets rate limit after window expires', () => {
      tracker.maxErrorsPerMinute = 2;
      tracker.deduplicationWindow = 0;
      tracker.captureError(new Error('e0'));
      tracker.captureError(new Error('e1'));
      // Expire rate limit window
      tracker.rateLimitResetTime = Date.now() - 1;
      const id = tracker.captureError(new Error('e2'));
      expect(id).toMatch(/^err_/);
    });
  });

  // =========================================================================
  // Backend reporting
  // =========================================================================

  describe('backend reporting', () => {
    it('reports to backend when enabled', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true });
      tracker.reportToBackend = true;
      tracker.backendURL = 'http://test';
      tracker.enableLogging = true;
      tracker.captureError(new Error('report'));

      // Wait for async report
      await new Promise(r => setTimeout(r, 10));

      expect(global.fetch).toHaveBeenCalledWith(
        'http://test/monitoring/errors',
        expect.objectContaining({ method: 'POST' })
      );
      expect(tracker.stats.reportedErrors).toBe(1);
      delete global.fetch;
    });

    it('handles backend report failure gracefully', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('network'));
      tracker.reportToBackend = true;
      tracker.backendURL = 'http://test';
      tracker.captureError(new Error('report'));

      await new Promise(r => setTimeout(r, 10));

      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('failed to report'),
        expect.any(Object)
      );
      delete global.fetch;
    });
  });

  // =========================================================================
  // captureException() / captureMessage()
  // =========================================================================

  describe('captureException()', () => {
    it('captures with source context', () => {
      tracker.captureException(new Error('exc'), 'TestModule');
      expect(tracker.errors[0].context.source).toBe('TestModule');
      expect(tracker.errors[0].context.type).toBe('exception');
    });
  });

  describe('captureMessage()', () => {
    it('captures string message as Error', () => {
      tracker.captureMessage('something happened', 'warning', { extra: 1 });
      expect(tracker.errors[0].message).toBe('something happened');
      expect(tracker.errors[0].context.level).toBe('warning');
      expect(tracker.errors[0].context.type).toBe('message');
    });
  });

  // =========================================================================
  // attachHandlers()
  // =========================================================================

  describe('attachHandlers()', () => {
    it('attaches window error listeners', () => {
      const spy = jest.spyOn(window, 'addEventListener');
      tracker.attachHandlers();
      expect(spy).toHaveBeenCalledWith('error', expect.any(Function));
      expect(spy).toHaveBeenCalledWith('unhandledrejection', expect.any(Function));
      spy.mockRestore();
    });

    it('logs when enableLogging is true', () => {
      tracker.enableLogging = true;
      tracker.attachHandlers();
      expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('attached global'));
    });
  });

  // =========================================================================
  // detachHandlers()
  // =========================================================================

  describe('detachHandlers()', () => {
    it('removes previously attached window listeners', () => {
      const addSpy = jest.spyOn(window, 'addEventListener');
      const removeSpy = jest.spyOn(window, 'removeEventListener');
      tracker.attachHandlers();
      expect(addSpy).toHaveBeenCalledTimes(2);
      tracker.detachHandlers();
      expect(removeSpy).toHaveBeenCalledWith('error', expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith('unhandledrejection', expect.any(Function));
      expect(tracker._boundErrorHandler).toBeNull();
      expect(tracker._boundRejectionHandler).toBeNull();
      addSpy.mockRestore();
      removeSpy.mockRestore();
    });

    it('is safe to call without prior attach', () => {
      expect(() => tracker.detachHandlers()).not.toThrow();
    });
  });

  // =========================================================================
  // getErrors() / getError()
  // =========================================================================

  describe('getErrors()', () => {
    it('returns frozen copy of errors', () => {
      tracker.captureError(new Error('e1'));
      const errors = tracker.getErrors();
      expect(Object.isFrozen(errors)).toBe(true);
      expect(errors).toHaveLength(1);
    });
  });

  describe('getError()', () => {
    it('returns frozen error by ID', () => {
      const id = tracker.captureError(new Error('find'));
      const found = tracker.getError(id);
      expect(found).not.toBeNull();
      expect(found.id).toBe(id);
      expect(Object.isFrozen(found)).toBe(true);
    });

    it('returns null for unknown ID', () => {
      expect(tracker.getError('unknown')).toBeNull();
    });
  });

  // =========================================================================
  // getStats()
  // =========================================================================

  describe('getStats()', () => {
    it('returns frozen stats', () => {
      tracker.captureError(new Error('e'));
      const stats = tracker.getStats();
      expect(Object.isFrozen(stats)).toBe(true);
      expect(stats.totalErrors).toBe(1);
      expect(stats.storedErrors).toBe(1);
      // uniqueSignatures comes from errorCounts which only tracks duplicated errors
      expect(stats.uniqueSignatures).toBe(0);
    });
  });

  // =========================================================================
  // clear()
  // =========================================================================

  describe('clear()', () => {
    it('resets all state', () => {
      tracker.captureError(new Error('e'));
      tracker.clear();
      expect(tracker.errors).toEqual([]);
      expect(tracker.errorCounts.size).toBe(0);
      expect(tracker.lastErrorTimes.size).toBe(0);
      expect(tracker.stats.totalErrors).toBe(0);
    });

    it('logs when enableLogging is true', () => {
      tracker.enableLogging = true;
      tracker.clear();
      expect(mockLog.debug).toHaveBeenCalledWith(expect.stringContaining('cleared'));
    });
  });

  // =========================================================================
  // exportJSON()
  // =========================================================================

  describe('exportJSON()', () => {
    it('exports valid JSON with errors and stats', () => {
      tracker.captureError(new Error('export'));
      const json = tracker.exportJSON();
      const parsed = JSON.parse(json);
      expect(parsed.errors).toHaveLength(1);
      expect(parsed.stats).toBeDefined();
      expect(parsed.timestamp).toBeDefined();
    });
  });

  // =========================================================================
  // dispose()
  // =========================================================================

  describe('dispose()', () => {
    it('detaches handlers and clears state', () => {
      tracker.attachHandlers();
      tracker.captureError(new Error('before-dispose'));
      tracker.dispose();
      expect(tracker._isDisposed).toBe(true);
      expect(tracker.errors).toEqual([]);
      expect(tracker._boundErrorHandler).toBeNull();
      expect(tracker._boundRejectionHandler).toBeNull();
    });

    it('is idempotent', () => {
      tracker.dispose();
      expect(() => tracker.dispose()).not.toThrow();
    });

    it('blocks captureError after dispose', () => {
      tracker.dispose();
      const id = tracker.captureError(new Error('after-dispose'));
      expect(id).toBeNull();
    });
  });

  // =========================================================================
  // Window global export
  // =========================================================================

  describe('window global', () => {
    it('exports ErrorTracker to window', () => {
      expect(window.ErrorTracker).toBe(ErrorTracker);
    });
  });
});
