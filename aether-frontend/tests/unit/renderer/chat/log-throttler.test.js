'use strict';

// ---------------------------------------------------------------------------
// LogThrottler — Pure utility, no mocks needed, fake timers for Date.now()
// ---------------------------------------------------------------------------

const LogThrottler = require(
  '../../../../src/renderer/chat/modules/messaging/utils/LogThrottler'
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LogThrottler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-02-09T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // =========================================================================
  // Constructor
  // =========================================================================
  describe('constructor', () => {
    test('defaults interval to 1000ms when not specified', () => {
      const throttler = new LogThrottler();
      expect(throttler.interval).toBe(1000);
    });

    test('defaults interval to 1000ms when options is empty', () => {
      const throttler = new LogThrottler({});
      expect(throttler.interval).toBe(1000);
    });

    test('accepts custom interval', () => {
      const throttler = new LogThrottler({ interval: 500 });
      expect(throttler.interval).toBe(500);
    });

    test('accepts large interval', () => {
      const throttler = new LogThrottler({ interval: 60000 });
      expect(throttler.interval).toBe(60000);
    });

    test('initializes lastLog to 0', () => {
      const throttler = new LogThrottler();
      expect(throttler.lastLog).toBe(0);
    });

    test('initializes updateCount to 0', () => {
      const throttler = new LogThrottler();
      expect(throttler.updateCount).toBe(0);
    });

    test('initializes currentKey to null', () => {
      const throttler = new LogThrottler();
      expect(throttler.currentKey).toBeNull();
    });

    // FIX VERIFIED: interval: 0 is now preserved (uses ?? instead of ||)
    test('interval 0 is preserved as valid value (always log)', () => {
      const throttler = new LogThrottler({ interval: 0 });
      expect(throttler.interval).toBe(0);
    });

    test('interval null defaults to 1000', () => {
      const throttler = new LogThrottler({ interval: null });
      expect(throttler.interval).toBe(1000);
    });

    test('interval undefined defaults to 1000', () => {
      const throttler = new LogThrottler({ interval: undefined });
      expect(throttler.interval).toBe(1000);
    });
  });

  // =========================================================================
  // shouldLog() — basic throttling
  // =========================================================================
  describe('shouldLog — basic throttling', () => {
    test('first call always returns log: true (lastLog starts at 0)', () => {
      const throttler = new LogThrottler({ interval: 1000 });

      const result = throttler.shouldLog();

      expect(result).toEqual({ log: true, count: 1 });
    });

    test('immediate second call returns log: false', () => {
      const throttler = new LogThrottler({ interval: 1000 });

      throttler.shouldLog(); // first — logs
      const result = throttler.shouldLog(); // second — too soon

      expect(result).toEqual({ log: false, count: 1 });
    });

    test('call after interval returns log: true', () => {
      const throttler = new LogThrottler({ interval: 1000 });

      throttler.shouldLog(); // first — logs

      jest.advanceTimersByTime(1000);

      const result = throttler.shouldLog();

      expect(result).toEqual({ log: true, count: 1 });
    });

    test('call just before interval returns log: false', () => {
      const throttler = new LogThrottler({ interval: 1000 });

      throttler.shouldLog(); // first — logs

      jest.advanceTimersByTime(999);

      const result = throttler.shouldLog();

      expect(result).toEqual({ log: false, count: 1 });
    });

    test('call exactly at interval boundary returns log: true (uses >=)', () => {
      const throttler = new LogThrottler({ interval: 500 });

      throttler.shouldLog(); // first — logs

      jest.advanceTimersByTime(500);

      const result = throttler.shouldLog();

      expect(result).toEqual({ log: true, count: 1 });
    });

    test('call well past interval returns log: true', () => {
      const throttler = new LogThrottler({ interval: 1000 });

      throttler.shouldLog(); // first — logs

      jest.advanceTimersByTime(5000);

      const result = throttler.shouldLog();

      expect(result).toEqual({ log: true, count: 1 });
    });
  });

  // =========================================================================
  // shouldLog() — updateCount tracking
  // =========================================================================
  describe('shouldLog — updateCount tracking', () => {
    test('first call: count is 1', () => {
      const throttler = new LogThrottler({ interval: 1000 });

      const result = throttler.shouldLog();

      expect(result.count).toBe(1);
    });

    test('multiple calls within interval accumulate count', () => {
      const throttler = new LogThrottler({ interval: 1000 });

      throttler.shouldLog(); // logs, resets count

      const r2 = throttler.shouldLog(); // count 1
      expect(r2).toEqual({ log: false, count: 1 });

      const r3 = throttler.shouldLog(); // count 2
      expect(r3).toEqual({ log: false, count: 2 });

      const r4 = throttler.shouldLog(); // count 3
      expect(r4).toEqual({ log: false, count: 3 });
    });

    test('count resets to 0 after logging, then accumulates again', () => {
      const throttler = new LogThrottler({ interval: 1000 });

      throttler.shouldLog(); // logs, count = 1, resets to 0

      throttler.shouldLog(); // count = 1
      throttler.shouldLog(); // count = 2

      jest.advanceTimersByTime(1000);

      // Next shouldLog: count was 2, increments to 3, logs, returns count: 3
      const result = throttler.shouldLog();

      expect(result).toEqual({ log: true, count: 3 });
    });

    test('returned count on log: true includes the current call', () => {
      const throttler = new LogThrottler({ interval: 1000 });

      // First call: updateCount starts at 0, increments to 1, logs
      const r1 = throttler.shouldLog();
      expect(r1.count).toBe(1);

      // 5 more calls within interval
      for (let i = 0; i < 5; i++) {
        throttler.shouldLog();
      }

      jest.advanceTimersByTime(1000);

      // 6th call after interval: updateCount was 5, increments to 6
      const r2 = throttler.shouldLog();
      expect(r2).toEqual({ log: true, count: 6 });
    });

    test('updateCount resets to 0 after successful log', () => {
      const throttler = new LogThrottler({ interval: 1000 });

      throttler.shouldLog(); // logs
      expect(throttler.updateCount).toBe(0);
    });
  });

  // =========================================================================
  // shouldLog() — key tracking
  // =========================================================================
  describe('shouldLog — key tracking', () => {
    test('null key does not trigger key tracking', () => {
      const throttler = new LogThrottler({ interval: 1000 });

      throttler.shouldLog(null);

      expect(throttler.currentKey).toBeNull();
    });

    test('string key sets currentKey', () => {
      const throttler = new LogThrottler({ interval: 1000 });

      throttler.shouldLog('artifact-1');

      expect(throttler.currentKey).toBe('artifact-1');
    });

    test('same key does not reset updateCount', () => {
      const throttler = new LogThrottler({ interval: 1000 });

      throttler.shouldLog('key-a'); // logs, count resets

      throttler.shouldLog('key-a'); // same key, count = 1
      throttler.shouldLog('key-a'); // same key, count = 2

      expect(throttler.updateCount).toBe(2);
    });

    test('different key resets updateCount to 0 then increments', () => {
      const throttler = new LogThrottler({ interval: 1000 });

      throttler.shouldLog('key-a'); // logs, count resets

      throttler.shouldLog('key-a'); // count = 1
      throttler.shouldLog('key-a'); // count = 2

      // Switch key
      const result = throttler.shouldLog('key-b');

      // Count was reset to 0 (key change), then incremented to 1
      // Still within interval from last log
      expect(result).toEqual({ log: false, count: 1 });
      expect(throttler.currentKey).toBe('key-b');
    });

    test('switching from null key to string key triggers tracking', () => {
      const throttler = new LogThrottler({ interval: 1000 });

      throttler.shouldLog(null); // logs, currentKey stays null
      throttler.shouldLog('key-a'); // different from null: key-a is truthy, currentKey was null

      expect(throttler.currentKey).toBe('key-a');
    });

    test('switching from string key to null key does NOT reset count', () => {
      const throttler = new LogThrottler({ interval: 1000 });

      throttler.shouldLog('key-a'); // logs
      throttler.shouldLog('key-a'); // count = 1

      // null key: condition is `key && this.currentKey !== key`
      // null is falsy, so the if-block is skipped
      throttler.shouldLog(null);
      expect(throttler.updateCount).toBe(2);
      expect(throttler.currentKey).toBe('key-a');
    });

    test('switching from string key back to same key does not reset', () => {
      const throttler = new LogThrottler({ interval: 1000 });

      throttler.shouldLog('key-a'); // logs
      throttler.shouldLog('key-b'); // different key: resets count, count = 1
      throttler.shouldLog('key-a'); // different key again: resets count, count = 1

      expect(throttler.currentKey).toBe('key-a');
      expect(throttler.updateCount).toBe(1);
    });

    test('empty string key does not trigger key tracking', () => {
      const throttler = new LogThrottler({ interval: 1000 });

      throttler.shouldLog(''); // '' is falsy

      expect(throttler.currentKey).toBeNull();
    });
  });

  // =========================================================================
  // shouldLog() — rapid sequence
  // =========================================================================
  describe('shouldLog — rapid sequence', () => {
    test('100 rapid calls: first logs, rest 99 do not', () => {
      const throttler = new LogThrottler({ interval: 5000 });

      const results = [];
      for (let i = 0; i < 100; i++) {
        results.push(throttler.shouldLog());
      }

      expect(results[0]).toEqual({ log: true, count: 1 });
      for (let i = 1; i < 100; i++) {
        expect(results[i].log).toBe(false);
        expect(results[i].count).toBe(i);
      }
    });

    test('alternating log/no-log with exact interval steps', () => {
      const throttler = new LogThrottler({ interval: 100 });

      expect(throttler.shouldLog().log).toBe(true);

      jest.advanceTimersByTime(50);
      expect(throttler.shouldLog().log).toBe(false);

      jest.advanceTimersByTime(50);
      expect(throttler.shouldLog().log).toBe(true);

      jest.advanceTimersByTime(50);
      expect(throttler.shouldLog().log).toBe(false);

      jest.advanceTimersByTime(50);
      expect(throttler.shouldLog().log).toBe(true);
    });
  });

  // =========================================================================
  // force()
  // =========================================================================
  describe('force', () => {
    test('resets lastLog to 0', () => {
      const throttler = new LogThrottler({ interval: 1000 });

      throttler.shouldLog(); // sets lastLog
      expect(throttler.lastLog).toBeGreaterThan(0);

      throttler.force();

      expect(throttler.lastLog).toBe(0);
    });

    test('next shouldLog returns log: true after force', () => {
      const throttler = new LogThrottler({ interval: 10000 });

      throttler.shouldLog(); // logs

      // Still within interval
      expect(throttler.shouldLog().log).toBe(false);

      throttler.force();

      // Now should log even though interval hasn't elapsed
      const result = throttler.shouldLog();
      expect(result.log).toBe(true);
    });

    test('does not reset updateCount', () => {
      const throttler = new LogThrottler({ interval: 10000 });

      throttler.shouldLog(); // logs, resets count
      throttler.shouldLog(); // count = 1
      throttler.shouldLog(); // count = 2

      throttler.force();

      // Next shouldLog: count was 2, increments to 3
      const result = throttler.shouldLog();
      expect(result.count).toBe(3);
    });

    test('does not reset currentKey', () => {
      const throttler = new LogThrottler({ interval: 10000 });

      throttler.shouldLog('my-key');
      throttler.force();

      expect(throttler.currentKey).toBe('my-key');
    });

    test('can be called multiple times safely', () => {
      const throttler = new LogThrottler();

      expect(() => {
        throttler.force();
        throttler.force();
        throttler.force();
      }).not.toThrow();

      expect(throttler.lastLog).toBe(0);
    });
  });

  // =========================================================================
  // reset()
  // =========================================================================
  describe('reset', () => {
    test('resets lastLog to 0', () => {
      const throttler = new LogThrottler();
      throttler.shouldLog();

      throttler.reset();

      expect(throttler.lastLog).toBe(0);
    });

    test('resets updateCount to 0', () => {
      const throttler = new LogThrottler();
      throttler.shouldLog(); // count = 1, then resets to 0 after log
      throttler.shouldLog(); // count = 1
      throttler.shouldLog(); // count = 2

      throttler.reset();

      expect(throttler.updateCount).toBe(0);
    });

    test('resets currentKey to null', () => {
      const throttler = new LogThrottler();
      throttler.shouldLog('some-key');

      throttler.reset();

      expect(throttler.currentKey).toBeNull();
    });

    test('does not reset interval', () => {
      const throttler = new LogThrottler({ interval: 500 });

      throttler.reset();

      expect(throttler.interval).toBe(500);
    });

    test('after reset, next shouldLog returns log: true', () => {
      const throttler = new LogThrottler({ interval: 10000 });
      throttler.shouldLog(); // logs

      // Within interval
      expect(throttler.shouldLog().log).toBe(false);

      throttler.reset();

      expect(throttler.shouldLog().log).toBe(true);
    });

    test('can be called multiple times safely', () => {
      const throttler = new LogThrottler();

      expect(() => {
        throttler.reset();
        throttler.reset();
      }).not.toThrow();
    });
  });

  // =========================================================================
  // getUpdateCount()
  // =========================================================================
  describe('getUpdateCount', () => {
    test('returns 0 initially', () => {
      const throttler = new LogThrottler();
      expect(throttler.getUpdateCount()).toBe(0);
    });

    test('returns 0 after first shouldLog (resets on log)', () => {
      const throttler = new LogThrottler({ interval: 1000 });
      throttler.shouldLog(); // logs, resets count to 0
      expect(throttler.getUpdateCount()).toBe(0);
    });

    test('returns accumulated count between logs', () => {
      const throttler = new LogThrottler({ interval: 1000 });
      throttler.shouldLog(); // logs, count = 0
      throttler.shouldLog(); // no log, count = 1
      throttler.shouldLog(); // no log, count = 2

      expect(throttler.getUpdateCount()).toBe(2);
    });

    test('returns 0 after reset', () => {
      const throttler = new LogThrottler();
      throttler.shouldLog();
      throttler.shouldLog();

      throttler.reset();

      expect(throttler.getUpdateCount()).toBe(0);
    });
  });

  // =========================================================================
  // Lifecycle integration
  // =========================================================================
  describe('lifecycle integration', () => {
    test('full lifecycle: create → throttle → force → throttle → reset → throttle', () => {
      const throttler = new LogThrottler({ interval: 200 });

      // Phase 1: Initial throttling
      const r1 = throttler.shouldLog('stream-1');
      expect(r1).toEqual({ log: true, count: 1 });

      jest.advanceTimersByTime(50);
      const r2 = throttler.shouldLog('stream-1');
      expect(r2).toEqual({ log: false, count: 1 });

      jest.advanceTimersByTime(50);
      const r3 = throttler.shouldLog('stream-1');
      expect(r3).toEqual({ log: false, count: 2 });

      // Phase 2: Force bypass
      throttler.force();
      const r4 = throttler.shouldLog('stream-1');
      expect(r4).toEqual({ log: true, count: 3 });

      // Phase 3: Key change
      const r5 = throttler.shouldLog('stream-2');
      expect(r5.log).toBe(false);
      expect(r5.count).toBe(1); // Reset due to key change

      // Phase 4: Reset
      throttler.reset();
      expect(throttler.getUpdateCount()).toBe(0);
      expect(throttler.currentKey).toBeNull();
      expect(throttler.lastLog).toBe(0);

      // Phase 5: Fresh start after reset
      const r6 = throttler.shouldLog('stream-3');
      expect(r6).toEqual({ log: true, count: 1 });
    });

    test('high-frequency streaming simulation', () => {
      const throttler = new LogThrottler({ interval: 1000 });
      let logCount = 0;

      // Simulate 100 chunks over 2.5 seconds (every 25ms)
      for (let i = 0; i < 100; i++) {
        const result = throttler.shouldLog('artifact-chunk');
        if (result.log) logCount++;
        jest.advanceTimersByTime(25);
      }

      // 2500ms total, interval 1000ms
      // First log at t=0, second at t>=1000, third at t>=2000
      // Exact count depends on when shouldLog is called relative to interval
      expect(logCount).toBe(3);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================
  describe('edge cases', () => {
    test('shouldLog with no arguments', () => {
      const throttler = new LogThrottler();

      const result = throttler.shouldLog();

      expect(result).toEqual({ log: true, count: 1 });
    });

    test('shouldLog with undefined key', () => {
      const throttler = new LogThrottler();

      const result = throttler.shouldLog(undefined);

      // undefined is falsy, same as null — no key tracking
      expect(result).toEqual({ log: true, count: 1 });
      expect(throttler.currentKey).toBeNull();
    });

    test('shouldLog with numeric key (truthy non-string)', () => {
      const throttler = new LogThrottler();

      throttler.shouldLog(42);

      expect(throttler.currentKey).toBe(42);
    });

    test('shouldLog with false as key does not trigger tracking', () => {
      const throttler = new LogThrottler();

      throttler.shouldLog(false);

      expect(throttler.currentKey).toBeNull();
    });

    test('interval of 1ms allows very frequent logging', () => {
      const throttler = new LogThrottler({ interval: 1 });

      const r1 = throttler.shouldLog();
      expect(r1.log).toBe(true);

      jest.advanceTimersByTime(1);

      const r2 = throttler.shouldLog();
      expect(r2.log).toBe(true);
    });

    test('very large interval suppresses all subsequent logs', () => {
      const throttler = new LogThrottler({ interval: 999999999 });

      throttler.shouldLog(); // logs

      jest.advanceTimersByTime(1000000);

      const result = throttler.shouldLog();
      expect(result.log).toBe(false);
    });
  });

  // =========================================================================
  // Module exports
  // =========================================================================
  describe('module exports', () => {
    test('exports LogThrottler constructor', () => {
      expect(typeof LogThrottler).toBe('function');
    });

    test('instances have expected methods', () => {
      const throttler = new LogThrottler();
      expect(typeof throttler.shouldLog).toBe('function');
      expect(typeof throttler.force).toBe('function');
      expect(typeof throttler.reset).toBe('function');
      expect(typeof throttler.getUpdateCount).toBe('function');
    });
  });
});
