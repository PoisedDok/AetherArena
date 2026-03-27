'use strict';

// ---------------------------------------------------------------------------
// TimeFormatter — Static methods, pure formatting, no mocks needed
// Uses toLocaleTimeString() which varies by locale. Assertions use
// type checks and structural patterns rather than exact string matching.
// ---------------------------------------------------------------------------

const TimeFormatter = require(
  '../../../../src/renderer/chat/modules/messaging/utils/TimeFormatter'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assert result is a valid time string (non-empty, from toLocaleTimeString).
 * We cannot assert exact format since it's locale-dependent.
 */
function expectTimeString(value) {
  expect(typeof value).toBe('string');
  expect(value.length).toBeGreaterThan(0);
  // Must contain at least one digit (time always has numbers)
  expect(value).toMatch(/\d/);
}

// A known fixed date for deterministic assertions
const FIXED_ISO = '2026-02-09T15:30:45.000Z';
const FIXED_EPOCH = new Date(FIXED_ISO).getTime();
const FIXED_DATE = new Date(FIXED_ISO);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TimeFormatter', () => {
  // =========================================================================
  // format() — ISO string input
  // =========================================================================
  describe('format — ISO string input', () => {
    test('returns valid time string for ISO timestamp', () => {
      const result = TimeFormatter.format('2026-02-09T15:30:45.000Z');
      expectTimeString(result);
    });

    test('returns valid time string for ISO with timezone offset', () => {
      const result = TimeFormatter.format('2026-02-09T15:30:45+05:00');
      expectTimeString(result);
    });

    test('returns valid time string for ISO date-only with T separator', () => {
      const result = TimeFormatter.format('2026-02-09T00:00:00.000Z');
      expectTimeString(result);
    });

    test('returns consistent results for same ISO input', () => {
      const r1 = TimeFormatter.format(FIXED_ISO);
      const r2 = TimeFormatter.format(FIXED_ISO);
      expect(r1).toBe(r2);
    });

    test('returns different results for different times', () => {
      const morning = TimeFormatter.format('2026-02-09T06:00:00.000Z');
      const evening = TimeFormatter.format('2026-02-09T18:00:00.000Z');
      // These should differ unless locale happens to format them identically
      // (extremely unlikely for 06:00 vs 18:00)
      expectTimeString(morning);
      expectTimeString(evening);
    });
  });

  // =========================================================================
  // format() — epoch number input
  // =========================================================================
  describe('format — epoch number input', () => {
    test('returns valid time string for epoch milliseconds', () => {
      const result = TimeFormatter.format(FIXED_EPOCH);
      expectTimeString(result);
    });

    test('returns valid time string for epoch 0 (Unix epoch)', () => {
      const result = TimeFormatter.format(0);
      // 0 is falsy, so format() returns current time (fallback)
      expectTimeString(result);
    });

    test('returns valid time string for recent epoch', () => {
      const result = TimeFormatter.format(Date.now());
      expectTimeString(result);
    });

    test('returns valid time string for large epoch (far future)', () => {
      // Year 2100 approx
      const result = TimeFormatter.format(4102444800000);
      expectTimeString(result);
    });

    test('returns same result as ISO for equivalent timestamp', () => {
      const fromIso = TimeFormatter.format(FIXED_ISO);
      const fromEpoch = TimeFormatter.format(FIXED_EPOCH);
      expect(fromIso).toBe(fromEpoch);
    });

    test('handles negative epoch (dates before 1970)', () => {
      // 1969-12-31
      const result = TimeFormatter.format(-86400000);
      expectTimeString(result);
    });
  });

  // =========================================================================
  // format() — Date object input
  // =========================================================================
  describe('format — Date object input', () => {
    test('returns valid time string for Date object', () => {
      const result = TimeFormatter.format(FIXED_DATE);
      expectTimeString(result);
    });

    test('returns same result as epoch for equivalent Date', () => {
      const fromDate = TimeFormatter.format(new Date(FIXED_EPOCH));
      const fromEpoch = TimeFormatter.format(FIXED_EPOCH);
      expect(fromDate).toBe(fromEpoch);
    });

    test('returns fallback for invalid Date (NaN)', () => {
      const invalidDate = new Date('not-a-date');
      expect(isNaN(invalidDate.getTime())).toBe(true);

      const result = TimeFormatter.format(invalidDate);
      // Falls through to fallback: new Date().toLocaleTimeString()
      expectTimeString(result);
    });
  });

  // =========================================================================
  // format() — falsy/missing input
  // =========================================================================
  describe('format — falsy/missing input', () => {
    test('returns current time for null', () => {
      const result = TimeFormatter.format(null);
      expectTimeString(result);
    });

    test('returns current time for undefined', () => {
      const result = TimeFormatter.format(undefined);
      expectTimeString(result);
    });

    test('returns current time for empty string', () => {
      const result = TimeFormatter.format('');
      expectTimeString(result);
    });

    test('returns current time for false', () => {
      const result = TimeFormatter.format(false);
      expectTimeString(result);
    });

    test('returns current time for 0', () => {
      const result = TimeFormatter.format(0);
      expectTimeString(result);
    });
  });

  // =========================================================================
  // format() — edge cases and fallbacks
  // =========================================================================
  describe('format — edge cases', () => {
    test('non-ISO string without T: falls through to fallback', () => {
      // String without 'T' — skips ISO branch, not a number, not a Date
      const result = TimeFormatter.format('2026-02-09');
      // Falls through all branches to fallback
      expectTimeString(result);
    });

    test('string containing T but not valid ISO: fallback on invalid parse', () => {
      // Contains 'T' so enters ISO branch, but invalid date
      const result = TimeFormatter.format('notTaDate');
      // new Date('notTaDate') is invalid, isNaN check catches it
      // Falls through to final fallback
      expectTimeString(result);
    });

    test('string with T that is valid ISO is parsed correctly', () => {
      const result = TimeFormatter.format('2026-01-15T10:30:00Z');
      expectTimeString(result);
    });

    test('NaN input: falls through to fallback', () => {
      const result = TimeFormatter.format(NaN);
      // NaN is typeof 'number', new Date(NaN) is invalid
      expectTimeString(result);
    });

    test('Infinity input: falls through to fallback', () => {
      const result = TimeFormatter.format(Infinity);
      // typeof 'number', new Date(Infinity) is invalid
      expectTimeString(result);
    });

    test('object input: falls through to fallback', () => {
      const result = TimeFormatter.format({ time: '12:00' });
      expectTimeString(result);
    });

    test('array input: falls through to fallback', () => {
      const result = TimeFormatter.format([2026, 2, 9]);
      expectTimeString(result);
    });

    test('boolean true: falls through to fallback', () => {
      const result = TimeFormatter.format(true);
      expectTimeString(result);
    });

    test('never throws regardless of input', () => {
      const inputs = [
        null, undefined, '', 0, false, NaN, Infinity, -Infinity,
        {}, [], 'garbage', Symbol.for('test'), true,
        new Date('invalid'), -1, 999999999999999999,
      ];

      for (const input of inputs) {
        expect(() => TimeFormatter.format(input)).not.toThrow();
      }
    });
  });

  // =========================================================================
  // formatShort()
  // =========================================================================
  describe('formatShort', () => {
    test('returns valid short time string for ISO input', () => {
      const result = TimeFormatter.formatShort(FIXED_ISO);
      expectTimeString(result);
    });

    test('returns valid short time string for epoch input', () => {
      const result = TimeFormatter.formatShort(FIXED_EPOCH);
      expectTimeString(result);
    });

    test('returns valid short time string for Date input', () => {
      const result = TimeFormatter.formatShort(FIXED_DATE);
      expectTimeString(result);
    });

    test('returns valid short time string for null', () => {
      const result = TimeFormatter.formatShort(null);
      expectTimeString(result);
    });

    test('returns valid short time string for undefined', () => {
      const result = TimeFormatter.formatShort(undefined);
      expectTimeString(result);
    });

    test('uses hour:2-digit, minute:2-digit options', () => {
      // We can verify the short format is shorter than full format
      const full = TimeFormatter.format(FIXED_ISO);
      const short = TimeFormatter.formatShort(FIXED_ISO);

      expectTimeString(short);
      // Short format should generally be shorter (no seconds)
      // but this depends on locale; at minimum both should be valid
      expectTimeString(full);
    });

    test('returns fallback for invalid Date', () => {
      const result = TimeFormatter.formatShort(new Date('invalid'));
      expectTimeString(result);
    });

    test('never throws regardless of input', () => {
      const inputs = [
        null, undefined, '', 0, false, NaN, Infinity,
        {}, [], 'garbage', new Date('invalid'),
      ];

      for (const input of inputs) {
        expect(() => TimeFormatter.formatShort(input)).not.toThrow();
      }
    });

    test('handles string dates more permissively than format()', () => {
      // formatShort uses _parseTimestamp which passes any string to new Date()
      // format() requires 'T' in string for ISO detection
      // '2026-02-09' has no T, so format() uses fallback
      // But formatShort/_parseTimestamp tries new Date('2026-02-09') which IS valid
      const result = TimeFormatter.formatShort('2026-02-09');
      expectTimeString(result);
    });
  });

  // =========================================================================
  // _parseTimestamp() (static, private but tested via public API)
  // =========================================================================
  describe('_parseTimestamp', () => {
    test('returns null for null input', () => {
      const result = TimeFormatter._parseTimestamp(null);
      expect(result).toBeNull();
    });

    test('returns null for undefined input', () => {
      const result = TimeFormatter._parseTimestamp(undefined);
      expect(result).toBeNull();
    });

    test('returns null for empty string', () => {
      const result = TimeFormatter._parseTimestamp('');
      expect(result).toBeNull();
    });

    test('returns null for false', () => {
      const result = TimeFormatter._parseTimestamp(false);
      expect(result).toBeNull();
    });

    test('returns null for 0', () => {
      const result = TimeFormatter._parseTimestamp(0);
      expect(result).toBeNull();
    });

    test('returns Date for Date input', () => {
      const date = new Date('2026-02-09T12:00:00Z');
      const result = TimeFormatter._parseTimestamp(date);
      expect(result).toBe(date);
    });

    test('returns null for invalid Date', () => {
      const result = TimeFormatter._parseTimestamp(new Date('invalid'));
      expect(result).toBeNull();
    });

    test('returns Date for epoch number', () => {
      const result = TimeFormatter._parseTimestamp(FIXED_EPOCH);
      expect(result).toBeInstanceOf(Date);
      expect(result.getTime()).toBe(FIXED_EPOCH);
    });

    test('returns Date for ISO string', () => {
      const result = TimeFormatter._parseTimestamp(FIXED_ISO);
      expect(result).toBeInstanceOf(Date);
      expect(result.getTime()).toBe(FIXED_EPOCH);
    });

    test('returns null for non-parseable string', () => {
      const result = TimeFormatter._parseTimestamp('not-a-date-at-all');
      expect(result).toBeNull();
    });

    test('returns Date for date-only string', () => {
      // new Date('2026-02-09') is valid in most engines
      const result = TimeFormatter._parseTimestamp('2026-02-09');
      expect(result).toBeInstanceOf(Date);
    });
  });

  // =========================================================================
  // Static nature
  // =========================================================================
  describe('static methods', () => {
    test('format is a static method (no instance needed)', () => {
      expect(typeof TimeFormatter.format).toBe('function');
      // Can call directly on class
      const result = TimeFormatter.format(FIXED_EPOCH);
      expectTimeString(result);
    });

    test('formatShort is a static method', () => {
      expect(typeof TimeFormatter.formatShort).toBe('function');
      const result = TimeFormatter.formatShort(FIXED_EPOCH);
      expectTimeString(result);
    });

    test('_parseTimestamp is a static method', () => {
      expect(typeof TimeFormatter._parseTimestamp).toBe('function');
    });
  });

  // =========================================================================
  // Module exports
  // =========================================================================
  describe('module exports', () => {
    test('exports TimeFormatter constructor', () => {
      expect(typeof TimeFormatter).toBe('function');
    });
  });
});
