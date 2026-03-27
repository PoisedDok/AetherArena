'use strict';

const DateUtils = require('../../../src/renderer/shared/utils/date-utils');

describe('DateUtils', () => {
  // Helper: create date offset from now
  const offsetDate = (ms) => new Date(Date.now() + ms);
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;

  // =========================================================================
  // _parseDate (private, but powers everything — test thoroughly)
  // =========================================================================
  describe('_parseDate()', () => {
    it('returns null for falsy values', () => {
      expect(DateUtils._parseDate(null)).toBeNull();
      expect(DateUtils._parseDate(undefined)).toBeNull();
      expect(DateUtils._parseDate(0)).toBeNull();
      expect(DateUtils._parseDate('')).toBeNull();
      expect(DateUtils._parseDate(false)).toBeNull();
    });

    it('returns the same Date object for valid Date instances', () => {
      const d = new Date('2024-01-15T12:00:00Z');
      expect(DateUtils._parseDate(d)).toBe(d);
    });

    it('returns null for invalid Date instances', () => {
      expect(DateUtils._parseDate(new Date('invalid'))).toBeNull();
    });

    it('parses numeric timestamps', () => {
      const ts = 1705320000000; // 2024-01-15T12:00:00Z
      const result = DateUtils._parseDate(ts);
      expect(result).toBeInstanceOf(Date);
      expect(result.getTime()).toBe(ts);
    });

    it('parses ISO 8601 strings (with T)', () => {
      const result = DateUtils._parseDate('2024-01-15T12:00:00Z');
      expect(result).toBeInstanceOf(Date);
      expect(result.toISOString()).toBe('2024-01-15T12:00:00.000Z');
    });

    it('parses date strings with hyphens', () => {
      const result = DateUtils._parseDate('2024-01-15');
      expect(result).toBeInstanceOf(Date);
    });

    it('returns null for invalid ISO strings', () => {
      expect(DateUtils._parseDate('not-a-date-at-all')).toBeNull();
    });

    it('parses numeric strings as timestamps', () => {
      const result = DateUtils._parseDate('1705320000000');
      expect(result).toBeInstanceOf(Date);
    });

    it('returns null for non-numeric, non-ISO strings', () => {
      expect(DateUtils._parseDate('hello world')).toBeNull();
    });

    it('returns null for objects that are not Dates', () => {
      expect(DateUtils._parseDate({})).toBeNull();
      expect(DateUtils._parseDate([])).toBeNull();
    });
  });

  // =========================================================================
  // format
  // =========================================================================
  describe('format()', () => {
    it('returns empty string for null/invalid date', () => {
      expect(DateUtils.format(null)).toBe('');
      expect(DateUtils.format('garbage')).toBe('');
    });

    it('formats a valid date with default options', () => {
      const result = DateUtils.format('2024-01-15T12:00:00Z');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      // Should contain month and year
      expect(result).toMatch(/2024/);
    });

    it('accepts custom Intl options', () => {
      const result = DateUtils.format('2024-01-15T12:00:00Z', {
        month: 'long',
      });
      expect(result).toMatch(/January|Jan/);
    });
  });

  // =========================================================================
  // formatTime
  // =========================================================================
  describe('formatTime()', () => {
    it('returns empty string for null', () => {
      expect(DateUtils.formatTime(null)).toBe('');
    });

    it('formats time with hours and minutes', () => {
      const result = DateUtils.formatTime('2024-01-15T14:30:00Z');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // formatDateTime
  // =========================================================================
  describe('formatDateTime()', () => {
    it('returns empty string for null', () => {
      expect(DateUtils.formatDateTime(null)).toBe('');
    });

    it('includes both date and time components', () => {
      const result = DateUtils.formatDateTime('2024-01-15T14:30:00Z');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      expect(result).toMatch(/2024/);
    });
  });

  // =========================================================================
  // toISO
  // =========================================================================
  describe('toISO()', () => {
    it('returns empty string for null', () => {
      expect(DateUtils.toISO(null)).toBe('');
    });

    it('converts Date to ISO string', () => {
      const d = new Date('2024-01-15T12:00:00Z');
      expect(DateUtils.toISO(d)).toBe('2024-01-15T12:00:00.000Z');
    });

    it('converts timestamp to ISO string', () => {
      const result = DateUtils.toISO(1705320000000);
      expect(result).toBe('2024-01-15T12:00:00.000Z');
    });

    it('converts ISO string to canonical ISO', () => {
      expect(DateUtils.toISO('2024-01-15T12:00:00Z')).toBe('2024-01-15T12:00:00.000Z');
    });
  });

  // =========================================================================
  // relative — the big one (all 15+ branches)
  // =========================================================================
  describe('relative()', () => {
    it('returns empty string for null', () => {
      expect(DateUtils.relative(null)).toBe('');
    });

    // Past dates
    it('returns "just now" for < 10 seconds ago', () => {
      expect(DateUtils.relative(offsetDate(-5 * SEC))).toBe('just now');
    });

    it('returns "X seconds ago" for 10-59 seconds ago', () => {
      const result = DateUtils.relative(offsetDate(-30 * SEC));
      expect(result).toMatch(/\d+ seconds ago/);
    });

    it('returns "1 minute ago" for 60-119 seconds ago', () => {
      expect(DateUtils.relative(offsetDate(-90 * SEC))).toBe('1 minute ago');
    });

    it('returns "X minutes ago" for 2-59 minutes ago', () => {
      const result = DateUtils.relative(offsetDate(-15 * MIN));
      expect(result).toMatch(/\d+ minutes ago/);
    });

    it('returns "1 hour ago" for 60-119 minutes ago', () => {
      expect(DateUtils.relative(offsetDate(-90 * MIN))).toBe('1 hour ago');
    });

    it('returns "X hours ago" for 2-23 hours ago', () => {
      const result = DateUtils.relative(offsetDate(-5 * HOUR));
      expect(result).toMatch(/\d+ hours ago/);
    });

    it('returns "yesterday" for 24-47 hours ago', () => {
      expect(DateUtils.relative(offsetDate(-30 * HOUR))).toBe('yesterday');
    });

    it('returns "X days ago" for 2-6 days ago', () => {
      const result = DateUtils.relative(offsetDate(-4 * DAY));
      expect(result).toMatch(/\d+ days ago/);
    });

    it('returns "1 week ago" for 7-13 days ago', () => {
      expect(DateUtils.relative(offsetDate(-10 * DAY))).toBe('1 week ago');
    });

    it('returns "X weeks ago" for 14-29 days ago', () => {
      const result = DateUtils.relative(offsetDate(-20 * DAY));
      expect(result).toMatch(/\d+ weeks ago/);
    });

    it('returns "1 month ago" for 30-59 days ago', () => {
      expect(DateUtils.relative(offsetDate(-40 * DAY))).toBe('1 month ago');
    });

    it('returns "X months ago" for 2-11 months ago', () => {
      const result = DateUtils.relative(offsetDate(-180 * DAY));
      expect(result).toMatch(/\d+ months ago/);
    });

    it('returns "1 year ago" for 365-729 days ago', () => {
      expect(DateUtils.relative(offsetDate(-400 * DAY))).toBe('1 year ago');
    });

    it('returns "X years ago" for 2+ years ago', () => {
      const result = DateUtils.relative(offsetDate(-800 * DAY));
      expect(result).toMatch(/\d+ years ago/);
    });

    // Future dates
    it('returns "in a few seconds" for < 60 seconds in future', () => {
      expect(DateUtils.relative(offsetDate(30 * SEC))).toBe('in a few seconds');
    });

    it('returns "in 1 minute" for 60-119 seconds in future', () => {
      expect(DateUtils.relative(offsetDate(90 * SEC))).toBe('in 1 minute');
    });

    it('returns "in X minutes" for 2-59 minutes in future', () => {
      const result = DateUtils.relative(offsetDate(15 * MIN));
      expect(result).toMatch(/in \d+ minutes/);
    });

    it('returns "in 1 hour" for 60-119 minutes in future', () => {
      expect(DateUtils.relative(offsetDate(90 * MIN))).toBe('in 1 hour');
    });

    it('returns "in X hours" for 2-23 hours in future', () => {
      const result = DateUtils.relative(offsetDate(5 * HOUR));
      expect(result).toMatch(/in \d+ hours/);
    });

    it('falls back to formatted date for > 24h in future', () => {
      const result = DateUtils.relative(offsetDate(2 * DAY));
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      // Should not contain "in" prefix since it delegates to format()
      expect(result).not.toMatch(/^in /);
    });
  });

  // =========================================================================
  // formatDuration
  // =========================================================================
  describe('formatDuration()', () => {
    // Compact mode (default)
    it('returns "0ms" for negative', () => {
      expect(DateUtils.formatDuration(-100)).toBe('0ms');
    });

    it('formats milliseconds', () => {
      expect(DateUtils.formatDuration(0)).toBe('0ms');
      expect(DateUtils.formatDuration(500)).toBe('500ms');
      expect(DateUtils.formatDuration(999)).toBe('999ms');
    });

    it('formats seconds (< 60s)', () => {
      expect(DateUtils.formatDuration(1000)).toBe('1s');
      expect(DateUtils.formatDuration(5000)).toBe('5s');
      expect(DateUtils.formatDuration(59999)).toBe('59s');
    });

    it('formats minutes + seconds', () => {
      expect(DateUtils.formatDuration(90000)).toBe('1m 30s');
    });

    it('formats hours + minutes', () => {
      expect(DateUtils.formatDuration(3600000)).toBe('1h 0m');
      expect(DateUtils.formatDuration(5400000)).toBe('1h 30m');
    });

    it('formats days + hours', () => {
      expect(DateUtils.formatDuration(90000000)).toBe('1d 1h');
    });

    // Verbose mode
    it('formats verbose with all parts', () => {
      // 1 day, 2 hours, 3 minutes, 4 seconds
      const ms = DAY + 2 * HOUR + 3 * MIN + 4 * SEC;
      const result = DateUtils.formatDuration(ms, true);
      expect(result).toBe('1 day, 2 hours, 3 minutes, 4 seconds');
    });

    it('formats verbose singular', () => {
      const ms = DAY + HOUR + MIN + SEC;
      const result = DateUtils.formatDuration(ms, true);
      expect(result).toBe('1 day, 1 hour, 1 minute, 1 second');
    });

    it('formats verbose with missing middle parts', () => {
      const ms = DAY + 30 * SEC;
      const result = DateUtils.formatDuration(ms, true);
      expect(result).toBe('1 day, 30 seconds');
    });
  });

  // =========================================================================
  // formatElapsedTime
  // =========================================================================
  describe('formatElapsedTime()', () => {
    it('returns "0ms" for non-number startTime', () => {
      expect(DateUtils.formatElapsedTime('abc')).toBe('0ms');
      expect(DateUtils.formatElapsedTime(null)).toBe('0ms');
    });

    it('returns "0ms" for NaN startTime', () => {
      expect(DateUtils.formatElapsedTime(NaN)).toBe('0ms');
    });

    it('uses Date.now() as default endTime', () => {
      const start = Date.now() - 5000;
      const result = DateUtils.formatElapsedTime(start);
      expect(result).toBe('5s');
    });

    it('uses explicit endTime', () => {
      const start = 1000;
      const end = 6000;
      expect(DateUtils.formatElapsedTime(start, end)).toBe('5s');
    });

    it('clamps negative duration to 0', () => {
      const start = Date.now() + 100000;
      const end = Date.now();
      expect(DateUtils.formatElapsedTime(start, end)).toBe('0ms');
    });

    it('passes verbose option through', () => {
      const start = 0;
      const end = DAY + 2 * HOUR;
      const result = DateUtils.formatElapsedTime(start, end, { verbose: true });
      expect(result).toContain('day');
      expect(result).toContain('hour');
    });
  });

  // =========================================================================
  // getTimestamp
  // =========================================================================
  describe('getTimestamp()', () => {
    it('returns current timestamp for null', () => {
      const before = Date.now();
      const result = DateUtils.getTimestamp(null);
      const after = Date.now();
      expect(result).toBeGreaterThanOrEqual(before);
      expect(result).toBeLessThanOrEqual(after);
    });

    it('returns current timestamp for no argument', () => {
      const before = Date.now();
      const result = DateUtils.getTimestamp();
      const after = Date.now();
      expect(result).toBeGreaterThanOrEqual(before);
      expect(result).toBeLessThanOrEqual(after);
    });

    it('returns timestamp for valid date', () => {
      const d = new Date('2024-01-15T12:00:00Z');
      expect(DateUtils.getTimestamp(d)).toBe(d.getTime());
    });

    it('returns Date.now() for unparseable date', () => {
      const before = Date.now();
      const result = DateUtils.getTimestamp('not-a-valid-date');
      const after = Date.now();
      expect(result).toBeGreaterThanOrEqual(before);
      expect(result).toBeLessThanOrEqual(after);
    });
  });

  // =========================================================================
  // getTimestampSeconds
  // =========================================================================
  describe('getTimestampSeconds()', () => {
    it('returns timestamp in seconds', () => {
      const d = new Date('2024-01-15T12:00:00Z');
      expect(DateUtils.getTimestampSeconds(d)).toBe(Math.floor(d.getTime() / 1000));
    });

    it('returns current time in seconds for null', () => {
      const before = Math.floor(Date.now() / 1000);
      const result = DateUtils.getTimestampSeconds();
      const after = Math.floor(Date.now() / 1000);
      expect(result).toBeGreaterThanOrEqual(before);
      expect(result).toBeLessThanOrEqual(after);
    });
  });

  // =========================================================================
  // isToday
  // =========================================================================
  describe('isToday()', () => {
    it('returns false for null', () => {
      expect(DateUtils.isToday(null)).toBe(false);
    });

    it('returns true for current date', () => {
      expect(DateUtils.isToday(new Date())).toBe(true);
    });

    it('returns true for today date string', () => {
      expect(DateUtils.isToday(Date.now())).toBe(true);
    });

    it('returns false for yesterday', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      expect(DateUtils.isToday(yesterday)).toBe(false);
    });

    it('returns false for far past date', () => {
      expect(DateUtils.isToday('2020-01-01T12:00:00Z')).toBe(false);
    });
  });

  // =========================================================================
  // isYesterday
  // =========================================================================
  describe('isYesterday()', () => {
    it('returns false for null', () => {
      expect(DateUtils.isYesterday(null)).toBe(false);
    });

    it('returns true for yesterday', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      expect(DateUtils.isYesterday(yesterday)).toBe(true);
    });

    it('returns false for today', () => {
      expect(DateUtils.isYesterday(new Date())).toBe(false);
    });

    it('returns false for two days ago', () => {
      const twoDaysAgo = new Date();
      twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
      expect(DateUtils.isYesterday(twoDaysAgo)).toBe(false);
    });
  });

  // =========================================================================
  // isPast
  // =========================================================================
  describe('isPast()', () => {
    it('returns false for null', () => {
      expect(DateUtils.isPast(null)).toBe(false);
    });

    it('returns true for past date', () => {
      expect(DateUtils.isPast('2020-01-01T12:00:00Z')).toBe(true);
    });

    it('returns false for future date', () => {
      expect(DateUtils.isPast(offsetDate(DAY))).toBe(false);
    });
  });

  // =========================================================================
  // isFuture
  // =========================================================================
  describe('isFuture()', () => {
    it('returns false for null', () => {
      expect(DateUtils.isFuture(null)).toBe(false);
    });

    it('returns true for future date', () => {
      expect(DateUtils.isFuture(offsetDate(DAY))).toBe(true);
    });

    it('returns false for past date', () => {
      expect(DateUtils.isFuture('2020-01-01T12:00:00Z')).toBe(false);
    });
  });

  // =========================================================================
  // add
  // =========================================================================
  describe('add()', () => {
    const baseDate = new Date('2024-01-15T12:00:00Z');

    it('returns new Date for null input', () => {
      const result = DateUtils.add(null, 1000);
      expect(result).toBeInstanceOf(Date);
    });

    it('adds milliseconds (default unit)', () => {
      const result = DateUtils.add(baseDate, 5000);
      expect(result.getTime()).toBe(baseDate.getTime() + 5000);
    });

    it('adds seconds', () => {
      const result = DateUtils.add(baseDate, 30, 's');
      expect(result.getTime()).toBe(baseDate.getTime() + 30000);
    });

    it('adds minutes', () => {
      const result = DateUtils.add(baseDate, 5, 'm');
      expect(result.getTime()).toBe(baseDate.getTime() + 5 * 60000);
    });

    it('adds hours', () => {
      const result = DateUtils.add(baseDate, 2, 'h');
      expect(result.getTime()).toBe(baseDate.getTime() + 2 * 3600000);
    });

    it('adds days', () => {
      const result = DateUtils.add(baseDate, 3, 'd');
      expect(result.getTime()).toBe(baseDate.getTime() + 3 * 86400000);
    });

    it('adds weeks', () => {
      const result = DateUtils.add(baseDate, 1, 'w');
      expect(result.getTime()).toBe(baseDate.getTime() + 7 * 86400000);
    });

    it('adds months (30 days)', () => {
      const result = DateUtils.add(baseDate, 1, 'M');
      expect(result.getTime()).toBe(baseDate.getTime() + 30 * 86400000);
    });

    it('adds years (365 days)', () => {
      const result = DateUtils.add(baseDate, 1, 'y');
      expect(result.getTime()).toBe(baseDate.getTime() + 365 * 86400000);
    });

    it('defaults to ms for unknown unit', () => {
      const result = DateUtils.add(baseDate, 5000, 'unknown');
      expect(result.getTime()).toBe(baseDate.getTime() + 5000);
    });

    it('handles negative amounts (subtract)', () => {
      const result = DateUtils.add(baseDate, -1, 'd');
      expect(result.getTime()).toBe(baseDate.getTime() - 86400000);
    });

    it('does not mutate original date', () => {
      const original = baseDate.getTime();
      DateUtils.add(baseDate, 1, 'd');
      expect(baseDate.getTime()).toBe(original);
    });
  });

  // =========================================================================
  // Module structure
  // =========================================================================
  describe('module structure', () => {
    it('exports a frozen object', () => {
      expect(Object.isFrozen(DateUtils)).toBe(true);
    });

    it('has all expected methods', () => {
      const expected = [
        'format', 'formatTime', 'formatDateTime', 'toISO', 'relative',
        'formatDuration', 'formatElapsedTime', 'getTimestamp', 'getTimestampSeconds',
        'isToday', 'isYesterday', 'isPast', 'isFuture', 'add', '_parseDate',
      ];
      for (const method of expected) {
        expect(typeof DateUtils[method]).toBe('function');
      }
    });
  });
});
