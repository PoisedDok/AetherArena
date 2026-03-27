'use strict';

const {
  ExecutionResultFormatter,
  FORMAT_CONFIG
} = require('../../../../../src/domain/artifacts/services/ExecutionResultFormatter');

describe('ExecutionResultFormatter', () => {
  describe('FORMAT_CONFIG', () => {
    it('exports frozen configuration', () => {
      expect(FORMAT_CONFIG.MAX_STRING_LENGTH).toBe(10000);
      expect(FORMAT_CONFIG.MAX_JSON_DEPTH).toBe(10);
      expect(FORMAT_CONFIG.INDENT_SIZE).toBe(2);
      expect(FORMAT_CONFIG.LABELS.SUCCESS).toBe('Execution complete');
      expect(() => { FORMAT_CONFIG.MAX_STRING_LENGTH = 1; }).toThrow();
    });
  });

  describe('format()', () => {
    it('formats null result', () => {
      const result = ExecutionResultFormatter.format(null);
      expect(result).toContain('Execution complete');
      expect(result).toContain('null');
    });

    it('formats undefined result', () => {
      const result = ExecutionResultFormatter.format(undefined);
      expect(result).toContain('Execution complete');
      expect(result).toContain('undefined');
    });

    it('formats string result', () => {
      const result = ExecutionResultFormatter.format('hello world');
      expect(result).toContain('Execution complete');
      expect(result).toContain('Output:');
      expect(result).toContain('hello world');
    });

    it('formats number result', () => {
      const result = ExecutionResultFormatter.format(42);
      expect(result).toContain('Result: 42');
    });

    it('formats boolean result', () => {
      expect(ExecutionResultFormatter.format(true)).toContain('Result: true');
      expect(ExecutionResultFormatter.format(false)).toContain('Result: false');
    });

    it('formats function result', () => {
      function myFunc() {}
      const result = ExecutionResultFormatter.format(myFunc);
      expect(result).toContain('[Function: myFunc]');
    });

    it('formats anonymous function', () => {
      const result = ExecutionResultFormatter.format(() => {});
      expect(result).toContain('[Function:');
    });

    it('formats symbol result', () => {
      const result = ExecutionResultFormatter.format(Symbol('test'));
      expect(result).toContain('Symbol(test)');
    });

    it('formats plain object as JSON', () => {
      const result = ExecutionResultFormatter.format({ a: 1, b: 'two' });
      expect(result).toContain('Result (JSON)');
      expect(result).toContain('"a": 1');
      expect(result).toContain('"b": "two"');
    });

    it('formats array with length', () => {
      const result = ExecutionResultFormatter.format([1, 2, 3]);
      expect(result).toContain('Array, length: 3');
    });

    it('formats Date as ISO string', () => {
      const date = new Date('2025-01-01T00:00:00Z');
      const result = ExecutionResultFormatter.format(date);
      expect(result).toContain('2025-01-01T00:00:00.000Z');
    });

    it('formats Error with name and message', () => {
      const err = new TypeError('something broke');
      const result = ExecutionResultFormatter.format(err);
      expect(result).toContain('TypeError: something broke');
    });

    it('formats RegExp', () => {
      const result = ExecutionResultFormatter.format(/^test$/i);
      expect(result).toContain('/^test$/i');
    });

    it('formats Map with entries', () => {
      const map = new Map([['a', 1], ['b', 2]]);
      const result = ExecutionResultFormatter.format(map);
      expect(result).toContain('Map, size: 2');
    });

    it('formats Set with values', () => {
      const set = new Set([1, 2, 3]);
      const result = ExecutionResultFormatter.format(set);
      expect(result).toContain('Set, size: 3');
    });

    it('truncates long results', () => {
      const longString = 'x'.repeat(20000);
      const result = ExecutionResultFormatter.format(longString);
      expect(result).toContain('truncated');
      // The formatted string is prefix + content, so total > 20000
      expect(result).toContain('original length:');
      expect(result).toContain('characters');
    });

    it('respects truncate=false option', () => {
      const longString = 'x'.repeat(20000);
      const result = ExecutionResultFormatter.format(longString, { truncate: false });
      expect(result).not.toContain('truncated');
    });

    it('respects custom maxLength', () => {
      const str = 'x'.repeat(200);
      const result = ExecutionResultFormatter.format(str, { maxLength: 50 });
      expect(result).toContain('truncated');
    });

    it('handles circular references gracefully', () => {
      const obj = { a: 1 };
      obj.self = obj;
      const result = ExecutionResultFormatter.format(obj);
      expect(result).toContain('Circular Reference');
    });

    it('handles objects with function values via replacer', () => {
      const obj = { fn: function myMethod() {}, value: 42 };
      const result = ExecutionResultFormatter.format(obj);
      expect(result).toContain('[Function: myMethod]');
    });

    it('handles objects with undefined values via replacer', () => {
      const obj = { a: undefined, b: 1 };
      const result = ExecutionResultFormatter.format(obj);
      expect(result).toContain('[undefined]');
    });
  });

  describe('formatBatch()', () => {
    it('throws on non-array input', () => {
      expect(() => ExecutionResultFormatter.formatBatch('not array')).toThrow('Results must be an array');
    });

    it('handles empty array', () => {
      const result = ExecutionResultFormatter.formatBatch([]);
      expect(result).toContain('No results');
    });

    it('formats multiple results with separators', () => {
      const result = ExecutionResultFormatter.formatBatch([42, 'hello', null]);
      expect(result).toContain('[1]');
      expect(result).toContain('[2]');
      expect(result).toContain('[3]');
      expect(result).toContain('---');
    });
  });

  describe('getConfig()', () => {
    it('returns copy of config', () => {
      const config = ExecutionResultFormatter.getConfig();
      expect(config.MAX_STRING_LENGTH).toBe(10000);
      // Verify it's a copy
      config.MAX_STRING_LENGTH = 999;
      expect(FORMAT_CONFIG.MAX_STRING_LENGTH).toBe(10000);
    });
  });
});
