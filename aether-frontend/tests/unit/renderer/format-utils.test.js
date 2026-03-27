'use strict';

const FormatUtils = require('../../../src/renderer/shared/utils/format-utils');

describe('FormatUtils', () => {
  // =========================================================================
  // fileSize
  // =========================================================================
  describe('fileSize()', () => {
    it('returns "0 Bytes" for zero', () => {
      expect(FormatUtils.fileSize(0)).toBe('0 Bytes');
    });

    it('returns "Invalid size" for negative bytes', () => {
      expect(FormatUtils.fileSize(-1)).toBe('Invalid size');
      expect(FormatUtils.fileSize(-999999)).toBe('Invalid size');
    });

    it('formats bytes correctly', () => {
      expect(FormatUtils.fileSize(1)).toBe('1 Bytes');
      expect(FormatUtils.fileSize(512)).toBe('512 Bytes');
      expect(FormatUtils.fileSize(1023)).toBe('1023 Bytes');
    });

    it('formats exact 1024 boundary as KB', () => {
      expect(FormatUtils.fileSize(1024)).toBe('1 KB');
    });

    it('formats KB range', () => {
      expect(FormatUtils.fileSize(1536)).toBe('1.5 KB');
      expect(FormatUtils.fileSize(10240)).toBe('10 KB');
    });

    it('formats MB range', () => {
      expect(FormatUtils.fileSize(1048576)).toBe('1 MB');
      expect(FormatUtils.fileSize(5 * 1024 * 1024)).toBe('5 MB');
    });

    it('formats GB range', () => {
      expect(FormatUtils.fileSize(1073741824)).toBe('1 GB');
    });

    it('formats TB range', () => {
      expect(FormatUtils.fileSize(1099511627776)).toBe('1 TB');
    });

    it('formats PB range (max unit)', () => {
      expect(FormatUtils.fileSize(1125899906842624)).toBe('1 PB');
    });

    it('clamps to PB for values beyond PB', () => {
      const result = FormatUtils.fileSize(1125899906842624 * 1024);
      expect(result).toContain('PB');
    });

    it('respects custom decimal places', () => {
      expect(FormatUtils.fileSize(1536, 0)).toBe('2 KB');
      expect(FormatUtils.fileSize(1536, 1)).toBe('1.5 KB');
      expect(FormatUtils.fileSize(1536, 3)).toBe('1.5 KB');
    });

    it('clamps negative decimals to 0', () => {
      expect(FormatUtils.fileSize(1536, -5)).toBe('2 KB');
    });

    it('handles NaN without crashing (NaN propagates through math)', () => {
      const result = FormatUtils.fileSize(NaN);
      expect(typeof result).toBe('string');
    });

    it('handles undefined without crashing', () => {
      const result = FormatUtils.fileSize(undefined);
      expect(typeof result).toBe('string');
    });
  });

  // =========================================================================
  // number
  // =========================================================================
  describe('number()', () => {
    it('returns "0" for zero', () => {
      expect(FormatUtils.number(0)).toBe('0');
    });

    it('returns "0" for NaN', () => {
      expect(FormatUtils.number(NaN)).toBe('0');
    });

    it('returns raw number below 1000', () => {
      expect(FormatUtils.number(1)).toBe('1');
      expect(FormatUtils.number(999)).toBe('999');
      expect(FormatUtils.number(42)).toBe('42');
    });

    it('handles negative numbers below 1000', () => {
      expect(FormatUtils.number(-5)).toBe('-5');
      expect(FormatUtils.number(-999)).toBe('-999');
    });

    it('formats thousands with K suffix', () => {
      expect(FormatUtils.number(1000)).toBe('1K');
      expect(FormatUtils.number(1500)).toBe('1.5K');
      expect(FormatUtils.number(999999)).toBe('1000K');
    });

    it('formats millions with M suffix', () => {
      expect(FormatUtils.number(1000000)).toBe('1M');
      expect(FormatUtils.number(2500000)).toBe('2.5M');
    });

    it('formats billions with B suffix', () => {
      expect(FormatUtils.number(1000000000)).toBe('1B');
    });

    it('formats trillions with T suffix', () => {
      expect(FormatUtils.number(1000000000000)).toBe('1T');
    });

    it('clamps to T for values beyond T', () => {
      const result = FormatUtils.number(1e15);
      expect(result).toContain('T');
    });

    it('handles negative large numbers', () => {
      expect(FormatUtils.number(-2500)).toBe('-2.5K');
      expect(FormatUtils.number(-1000000)).toBe('-1M');
    });

    it('respects custom decimals', () => {
      expect(FormatUtils.number(1234, 0)).toBe('1K');
      expect(FormatUtils.number(1234, 2)).toBe('1.23K');
    });

    it('clamps negative decimals to 0', () => {
      expect(FormatUtils.number(1500, -1)).toBe('2K');
    });

    it('handles undefined gracefully', () => {
      expect(FormatUtils.number(undefined)).toBe('0');
    });
  });

  // =========================================================================
  // numberWithSeparator
  // =========================================================================
  describe('numberWithSeparator()', () => {
    it('adds comma separators', () => {
      expect(FormatUtils.numberWithSeparator(1000)).toBe('1,000');
      expect(FormatUtils.numberWithSeparator(1000000)).toBe('1,000,000');
    });

    it('does not modify numbers below 1000', () => {
      expect(FormatUtils.numberWithSeparator(999)).toBe('999');
      expect(FormatUtils.numberWithSeparator(0)).toBe('0');
    });

    it('supports custom separator', () => {
      expect(FormatUtils.numberWithSeparator(1000000, '.')).toBe('1.000.000');
    });

    it('handles negative numbers', () => {
      expect(FormatUtils.numberWithSeparator(-1000)).toBe('-1,000');
    });

    it('handles non-number input via catch', () => {
      expect(FormatUtils.numberWithSeparator(null)).toBe('null');
    });
  });

  // =========================================================================
  // percentage
  // =========================================================================
  describe('percentage()', () => {
    it('formats whole percentage', () => {
      expect(FormatUtils.percentage(50)).toBe('50%');
      expect(FormatUtils.percentage(100)).toBe('100%');
      expect(FormatUtils.percentage(0)).toBe('0%');
    });

    it('formats decimal value (0-1) when isDecimal=true', () => {
      expect(FormatUtils.percentage(0.5, 0, true)).toBe('50%');
      expect(FormatUtils.percentage(1, 0, true)).toBe('100%');
      expect(FormatUtils.percentage(0.756, 1, true)).toBe('75.6%');
    });

    it('respects decimal places', () => {
      expect(FormatUtils.percentage(33.333, 2)).toBe('33.33%');
      expect(FormatUtils.percentage(33.333, 0)).toBe('33%');
    });

    it('handles negative percentage', () => {
      expect(FormatUtils.percentage(-5)).toBe('-5%');
    });

    it('handles NaN (propagates, no throw)', () => {
      expect(FormatUtils.percentage(NaN)).toBe('NaN%');
    });
  });

  // =========================================================================
  // currency
  // =========================================================================
  describe('currency()', () => {
    it('formats USD by default', () => {
      const result = FormatUtils.currency(1234.56);
      expect(result).toContain('1,234.56');
    });

    it('formats negative amounts', () => {
      const result = FormatUtils.currency(-50);
      expect(result).toContain('50');
    });

    it('formats zero', () => {
      const result = FormatUtils.currency(0);
      expect(result).toContain('0');
    });

    it('handles invalid currency code via catch', () => {
      const result = FormatUtils.currency(100, 'INVALID_CURRENCY_XYZ');
      expect(result).toContain('100');
    });
  });

  // =========================================================================
  // truncate
  // =========================================================================
  describe('truncate()', () => {
    it('returns empty string for null/undefined/empty', () => {
      expect(FormatUtils.truncate(null, 10)).toBe('');
      expect(FormatUtils.truncate(undefined, 10)).toBe('');
      expect(FormatUtils.truncate('', 10)).toBe('');
    });

    it('returns unchanged text when within maxLength', () => {
      expect(FormatUtils.truncate('hello', 5)).toBe('hello');
      expect(FormatUtils.truncate('hello', 10)).toBe('hello');
    });

    it('truncates with default ellipsis', () => {
      expect(FormatUtils.truncate('hello world', 8)).toBe('hello...');
    });

    it('truncates with custom ellipsis', () => {
      expect(FormatUtils.truncate('hello world', 8, '…')).toBe('hello w…');
    });

    it('handles maxLength exactly equal to text length', () => {
      expect(FormatUtils.truncate('hello', 5)).toBe('hello');
    });

    it('handles maxLength of 3 (just ellipsis)', () => {
      expect(FormatUtils.truncate('hello world', 3)).toBe('...');
    });

    it('handles maxLength less than ellipsis length', () => {
      // maxLength=2, ellipsis='...' (3 chars) → slice(0, -1) = slice to end, but negative
      const result = FormatUtils.truncate('hello world', 2);
      expect(typeof result).toBe('string');
    });
  });

  // =========================================================================
  // truncateMiddle
  // =========================================================================
  describe('truncateMiddle()', () => {
    it('returns empty string for null/undefined/empty', () => {
      expect(FormatUtils.truncateMiddle(null, 10)).toBe('');
      expect(FormatUtils.truncateMiddle(undefined, 10)).toBe('');
      expect(FormatUtils.truncateMiddle('', 10)).toBe('');
    });

    it('returns unchanged text when within maxLength', () => {
      expect(FormatUtils.truncateMiddle('hello', 5)).toBe('hello');
      expect(FormatUtils.truncateMiddle('hello', 10)).toBe('hello');
    });

    it('truncates in the middle with default ellipsis', () => {
      const result = FormatUtils.truncateMiddle('abcdefghij', 7);
      // charsToShow = 7 - 3 = 4, front=2, back=2
      expect(result).toBe('ab...ij');
    });

    it('handles odd charsToShow (ceil/floor split)', () => {
      const result = FormatUtils.truncateMiddle('abcdefghij', 8);
      // charsToShow = 8 - 3 = 5, front=3, back=2
      expect(result).toBe('abc...ij');
    });

    it('preserves file extension pattern', () => {
      const result = FormatUtils.truncateMiddle('very-long-filename.txt', 15);
      expect(result).toContain('...');
      expect(result).toContain('.txt');
    });
  });

  // =========================================================================
  // pluralize
  // =========================================================================
  describe('pluralize()', () => {
    it('returns singular for count=1', () => {
      expect(FormatUtils.pluralize(1, 'item')).toBe('item');
    });

    it('returns auto-plural (singular + s) for count != 1', () => {
      expect(FormatUtils.pluralize(0, 'item')).toBe('items');
      expect(FormatUtils.pluralize(2, 'item')).toBe('items');
      expect(FormatUtils.pluralize(100, 'item')).toBe('items');
    });

    it('returns explicit plural form', () => {
      expect(FormatUtils.pluralize(0, 'child', 'children')).toBe('children');
      expect(FormatUtils.pluralize(2, 'mouse', 'mice')).toBe('mice');
    });

    it('returns singular for count=1 even with explicit plural', () => {
      expect(FormatUtils.pluralize(1, 'child', 'children')).toBe('child');
    });

    it('handles negative count (not 1, so plural)', () => {
      expect(FormatUtils.pluralize(-1, 'item')).toBe('items');
    });
  });

  // =========================================================================
  // countWithWord
  // =========================================================================
  describe('countWithWord()', () => {
    it('combines count with singular word', () => {
      expect(FormatUtils.countWithWord(1, 'file')).toBe('1 file');
    });

    it('combines count with auto-plural word', () => {
      expect(FormatUtils.countWithWord(5, 'file')).toBe('5 files');
    });

    it('combines count with explicit plural', () => {
      expect(FormatUtils.countWithWord(3, 'child', 'children')).toBe('3 children');
    });

    it('handles zero count', () => {
      expect(FormatUtils.countWithWord(0, 'item')).toBe('0 items');
    });
  });

  // =========================================================================
  // boolean
  // =========================================================================
  describe('boolean()', () => {
    it('returns "Yes" for true by default', () => {
      expect(FormatUtils.boolean(true)).toBe('Yes');
    });

    it('returns "No" for false by default', () => {
      expect(FormatUtils.boolean(false)).toBe('No');
    });

    it('uses custom true/false text', () => {
      expect(FormatUtils.boolean(true, 'Enabled', 'Disabled')).toBe('Enabled');
      expect(FormatUtils.boolean(false, 'Enabled', 'Disabled')).toBe('Disabled');
    });

    it('treats falsy values as false', () => {
      expect(FormatUtils.boolean(0)).toBe('No');
      expect(FormatUtils.boolean('')).toBe('No');
      expect(FormatUtils.boolean(null)).toBe('No');
      expect(FormatUtils.boolean(undefined)).toBe('No');
    });

    it('treats truthy values as true', () => {
      expect(FormatUtils.boolean(1)).toBe('Yes');
      expect(FormatUtils.boolean('text')).toBe('Yes');
      expect(FormatUtils.boolean([])).toBe('Yes');
    });
  });

  // =========================================================================
  // phone
  // =========================================================================
  describe('phone()', () => {
    it('formats 10-digit US number', () => {
      expect(FormatUtils.phone('2125551234')).toBe('(212) 555-1234');
    });

    it('formats 10-digit with dashes/spaces stripped', () => {
      expect(FormatUtils.phone('212-555-1234')).toBe('(212) 555-1234');
      expect(FormatUtils.phone('(212) 555-1234')).toBe('(212) 555-1234');
    });

    it('formats 11-digit starting with 1', () => {
      expect(FormatUtils.phone('12125551234')).toBe('+1 (212) 555-1234');
    });

    it('returns unchanged for other lengths', () => {
      expect(FormatUtils.phone('123')).toBe('123');
      expect(FormatUtils.phone('123456789012')).toBe('123456789012');
    });

    it('returns unchanged for non-digit strings', () => {
      expect(FormatUtils.phone('not-a-number')).toBe('not-a-number');
    });

    it('handles empty string', () => {
      expect(FormatUtils.phone('')).toBe('');
    });
  });

  // =========================================================================
  // json
  // =========================================================================
  describe('json()', () => {
    it('stringifies objects with default 2-space indent', () => {
      const result = FormatUtils.json({ a: 1 });
      expect(result).toBe('{\n  "a": 1\n}');
    });

    it('stringifies arrays', () => {
      const result = FormatUtils.json([1, 2, 3]);
      expect(result).toBe('[\n  1,\n  2,\n  3\n]');
    });

    it('respects custom indent', () => {
      const result = FormatUtils.json({ a: 1 }, 4);
      expect(result).toBe('{\n    "a": 1\n}');
    });

    it('handles null', () => {
      expect(FormatUtils.json(null)).toBe('null');
    });

    it('handles primitives', () => {
      expect(FormatUtils.json(42)).toBe('42');
      expect(FormatUtils.json('hello')).toBe('"hello"');
      expect(FormatUtils.json(true)).toBe('true');
    });

    it('handles circular reference via catch', () => {
      const obj = {};
      obj.self = obj;
      const result = FormatUtils.json(obj);
      expect(result).toBe('[object Object]');
    });
  });

  // =========================================================================
  // latency
  // =========================================================================
  describe('latency()', () => {
    it('returns "N/A" for negative values', () => {
      expect(FormatUtils.latency(-1)).toBe('N/A');
      expect(FormatUtils.latency(-100)).toBe('N/A');
    });

    it('returns "<1ms" for sub-millisecond', () => {
      expect(FormatUtils.latency(0)).toBe('<1ms');
      expect(FormatUtils.latency(0.5)).toBe('<1ms');
      expect(FormatUtils.latency(0.999)).toBe('<1ms');
    });

    it('returns rounded ms for 1-999', () => {
      expect(FormatUtils.latency(1)).toBe('1ms');
      expect(FormatUtils.latency(50)).toBe('50ms');
      expect(FormatUtils.latency(999)).toBe('999ms');
      expect(FormatUtils.latency(999.9)).toBe('1000ms');
    });

    it('returns seconds for 1000+', () => {
      expect(FormatUtils.latency(1000)).toBe('1.00s');
      expect(FormatUtils.latency(1500)).toBe('1.50s');
      expect(FormatUtils.latency(60000)).toBe('60.00s');
    });

    it('handles exactly 1ms boundary', () => {
      expect(FormatUtils.latency(1)).toBe('1ms');
    });

    it('handles exactly 1000ms boundary', () => {
      expect(FormatUtils.latency(1000)).toBe('1.00s');
    });
  });

  // =========================================================================
  // fps
  // =========================================================================
  describe('fps()', () => {
    it('returns "0 FPS" for NaN', () => {
      expect(FormatUtils.fps(NaN)).toBe('0 FPS');
    });

    it('returns "0 FPS" for negative values', () => {
      expect(FormatUtils.fps(-1)).toBe('0 FPS');
    });

    it('formats normal FPS', () => {
      expect(FormatUtils.fps(0)).toBe('0 FPS');
      expect(FormatUtils.fps(30)).toBe('30 FPS');
      expect(FormatUtils.fps(60)).toBe('60 FPS');
      expect(FormatUtils.fps(59.7)).toBe('60 FPS');
    });
  });

  // =========================================================================
  // memory
  // =========================================================================
  describe('memory()', () => {
    it('delegates to fileSize', () => {
      expect(FormatUtils.memory(0)).toBe('0 Bytes');
      expect(FormatUtils.memory(1048576)).toBe('1 MB');
      expect(FormatUtils.memory(1073741824)).toBe('1 GB');
    });
  });

  // =========================================================================
  // cpu
  // =========================================================================
  describe('cpu()', () => {
    it('formats normal percentage', () => {
      expect(FormatUtils.cpu(50)).toBe('50%');
      expect(FormatUtils.cpu(0)).toBe('0%');
      expect(FormatUtils.cpu(100)).toBe('100%');
    });

    it('clamps negative to 0', () => {
      expect(FormatUtils.cpu(-10)).toBe('0%');
    });

    it('clamps above 100 to 100', () => {
      expect(FormatUtils.cpu(150)).toBe('100%');
    });

    it('rounds decimal values', () => {
      expect(FormatUtils.cpu(33.7)).toBe('34%');
    });
  });

  // =========================================================================
  // capitalize
  // =========================================================================
  describe('capitalize()', () => {
    it('returns empty for falsy input', () => {
      expect(FormatUtils.capitalize('')).toBe('');
      expect(FormatUtils.capitalize(null)).toBe('');
      expect(FormatUtils.capitalize(undefined)).toBe('');
    });

    it('capitalizes first letter, lowercases rest', () => {
      expect(FormatUtils.capitalize('hello')).toBe('Hello');
      expect(FormatUtils.capitalize('HELLO')).toBe('Hello');
      expect(FormatUtils.capitalize('hELLO')).toBe('Hello');
    });

    it('handles single character', () => {
      expect(FormatUtils.capitalize('a')).toBe('A');
    });
  });

  // =========================================================================
  // titleCase
  // =========================================================================
  describe('titleCase()', () => {
    it('returns empty for falsy input', () => {
      expect(FormatUtils.titleCase('')).toBe('');
      expect(FormatUtils.titleCase(null)).toBe('');
    });

    it('converts to title case', () => {
      expect(FormatUtils.titleCase('hello world')).toBe('Hello World');
      expect(FormatUtils.titleCase('HELLO WORLD')).toBe('Hello World');
    });

    it('handles single word', () => {
      expect(FormatUtils.titleCase('hello')).toBe('Hello');
    });
  });

  // =========================================================================
  // camelToKebab
  // =========================================================================
  describe('camelToKebab()', () => {
    it('converts camelCase to kebab-case', () => {
      expect(FormatUtils.camelToKebab('backgroundColor')).toBe('background-color');
      expect(FormatUtils.camelToKebab('fontSize')).toBe('font-size');
    });

    it('handles all lowercase (no change)', () => {
      expect(FormatUtils.camelToKebab('hello')).toBe('hello');
    });

    it('handles multiple consecutive transformations', () => {
      expect(FormatUtils.camelToKebab('borderTopLeftRadius')).toBe('border-top-left-radius');
    });

    it('handles numbers in string', () => {
      expect(FormatUtils.camelToKebab('margin2px')).toBe('margin2px');
      expect(FormatUtils.camelToKebab('test2Value')).toBe('test2-value');
    });
  });

  // =========================================================================
  // kebabToCamel
  // =========================================================================
  describe('kebabToCamel()', () => {
    it('converts kebab-case to camelCase', () => {
      expect(FormatUtils.kebabToCamel('background-color')).toBe('backgroundColor');
      expect(FormatUtils.kebabToCamel('font-size')).toBe('fontSize');
    });

    it('handles no hyphens (no change)', () => {
      expect(FormatUtils.kebabToCamel('hello')).toBe('hello');
    });

    it('handles multiple hyphens', () => {
      expect(FormatUtils.kebabToCamel('border-top-left-radius')).toBe('borderTopLeftRadius');
    });
  });

  // =========================================================================
  // padNumber
  // =========================================================================
  describe('padNumber()', () => {
    it('pads single digit to 2 by default', () => {
      expect(FormatUtils.padNumber(1)).toBe('01');
      expect(FormatUtils.padNumber(9)).toBe('09');
    });

    it('does not pad when already at length', () => {
      expect(FormatUtils.padNumber(10)).toBe('10');
      expect(FormatUtils.padNumber(99)).toBe('99');
    });

    it('pads to custom length', () => {
      expect(FormatUtils.padNumber(1, 4)).toBe('0001');
      expect(FormatUtils.padNumber(42, 5)).toBe('00042');
    });

    it('does not truncate when number exceeds length', () => {
      expect(FormatUtils.padNumber(1000, 2)).toBe('1000');
    });

    it('handles zero', () => {
      expect(FormatUtils.padNumber(0)).toBe('00');
    });
  });

  // =========================================================================
  // list
  // =========================================================================
  describe('list()', () => {
    it('returns empty for empty array', () => {
      expect(FormatUtils.list([])).toBe('');
    });

    it('returns empty for non-array', () => {
      expect(FormatUtils.list(null)).toBe('');
      expect(FormatUtils.list(undefined)).toBe('');
      expect(FormatUtils.list('not array')).toBe('');
    });

    it('returns single item unchanged', () => {
      expect(FormatUtils.list(['apple'])).toBe('apple');
    });

    it('joins two items with "and"', () => {
      expect(FormatUtils.list(['apple', 'banana'])).toBe('apple and banana');
    });

    it('joins three+ items with commas and "and"', () => {
      expect(FormatUtils.list(['apple', 'banana', 'cherry'])).toBe('apple, banana, and cherry');
    });

    it('handles four items', () => {
      expect(FormatUtils.list(['a', 'b', 'c', 'd'])).toBe('a, b, c, and d');
    });

    it('supports custom conjunction', () => {
      expect(FormatUtils.list(['a', 'b', 'c'], 'or')).toBe('a, b, or c');
      expect(FormatUtils.list(['a', 'b'], 'or')).toBe('a or b');
    });
  });

  // =========================================================================
  // Defensive catch-block coverage (wrong-type inputs)
  // =========================================================================
  describe('catch-block defense (wrong types)', () => {
    // These tests pass non-standard types to trigger the catch blocks
    // that guard each method. Verifies graceful fallback, not crashes.

    it('phone() with non-string falls back to input', () => {
      // number has no .replace method → catch fires → returns original input
      expect(() => FormatUtils.phone(12125551234)).not.toThrow();
      expect(FormatUtils.phone(12125551234)).toBe(12125551234);
    });

    it('capitalize() with non-string falls back to input', () => {
      expect(() => FormatUtils.capitalize(12345)).not.toThrow();
      expect(FormatUtils.capitalize(12345)).toBe(12345);
    });

    it('titleCase() with non-string falls back to input', () => {
      expect(() => FormatUtils.titleCase(12345)).not.toThrow();
      expect(FormatUtils.titleCase(12345)).toBe(12345);
    });

    it('camelToKebab() with non-string falls back to input', () => {
      expect(() => FormatUtils.camelToKebab(12345)).not.toThrow();
      expect(FormatUtils.camelToKebab(12345)).toBe(12345);
    });

    it('kebabToCamel() with non-string falls back to input', () => {
      expect(() => FormatUtils.kebabToCamel(12345)).not.toThrow();
      expect(FormatUtils.kebabToCamel(12345)).toBe(12345);
    });

    it('truncate() with object that passes truthiness falls back', () => {
      const obj = { length: 999 };
      expect(() => FormatUtils.truncate(obj, 5)).not.toThrow();
      // catch returns text || '' → object is truthy → returns original object
      expect(FormatUtils.truncate(obj, 5)).toBe(obj);
    });

    it('truncateMiddle() with object falls back', () => {
      const obj = { length: 999 };
      expect(() => FormatUtils.truncateMiddle(obj, 5)).not.toThrow();
      expect(FormatUtils.truncateMiddle(obj, 5)).toBe(obj);
    });

    it('pluralize() with types causing concat failure falls back', () => {
      const result = FormatUtils.pluralize(2, null);
      expect(typeof result).toBe('string');
    });

    it('countWithWord() delegates to pluralize, and both catch', () => {
      // When pluralize throws, countWithWord catches
      const result = FormatUtils.countWithWord(2, null);
      expect(typeof result).toBe('string');
    });

    it('latency() with non-number falls back', () => {
      const result = FormatUtils.latency('abc');
      expect(typeof result).toBe('string');
    });

    it('fps() with non-number falls back', () => {
      // undefined → isNaN(undefined) = true → '0 FPS' (handled in normal flow)
      // Symbol would throw, but let's use a Proxy that throws on comparison
      expect(FormatUtils.fps(undefined)).toBe('0 FPS');
    });

    it('cpu() with non-number falls back', () => {
      const result = FormatUtils.cpu('abc');
      expect(typeof result).toBe('string');
    });

    it('padNumber() with null falls back', () => {
      const result = FormatUtils.padNumber(null);
      expect(typeof result).toBe('string');
    });

    it('list() error in join falls back', () => {
      // Force an error during processing by passing items with a
      // length prop but no slice method
      const weirdArray = { length: 3, 0: 'a', 1: 'b', 2: 'c' };
      // Not a real array → fails isArray check → returns ''
      expect(FormatUtils.list(weirdArray)).toBe('');
    });
  });

  // =========================================================================
  // Module export / window global
  // =========================================================================
  describe('module structure', () => {
    it('exports a frozen object', () => {
      expect(Object.isFrozen(FormatUtils)).toBe(true);
    });

    it('has all 22 expected methods', () => {
      const expected = [
        'fileSize', 'number', 'numberWithSeparator', 'percentage', 'currency',
        'truncate', 'truncateMiddle', 'pluralize', 'countWithWord', 'boolean',
        'phone', 'json', 'latency', 'fps', 'memory', 'cpu', 'capitalize',
        'titleCase', 'camelToKebab', 'kebabToCamel', 'padNumber', 'list',
      ];
      for (const method of expected) {
        expect(typeof FormatUtils[method]).toBe('function');
      }
    });
  });
});
