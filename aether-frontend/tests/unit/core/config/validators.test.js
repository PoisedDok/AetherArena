'use strict';

const {
  validateUrl, isValidUrl, validateBoolean, validatePositiveInt,
  validateFloat, validateEnum, validateLogLevel, validateSanitizerProfile,
  validateStorageBackend, validatePort, validateTimeout, validateFileSize,
  normalizeUrl, httpToWs, validateString, validateRequiredKeys, validateArrayOfType
} = require('../../../../src/core/config/validators');

describe('Config Validators', () => {
  describe('validateUrl()', () => {
    it('should accept valid HTTP URLs', () => {
      expect(validateUrl('http://localhost:8080')).toMatch(/^http/);
      expect(validateUrl('https://example.com')).toMatch(/^https/);
    });

    it('should remove trailing slash', () => {
      expect(validateUrl('http://localhost:8080/')).not.toMatch(/\/$/);
    });

    it('should reject non-HTTP protocols', () => {
      expect(() => validateUrl('ftp://example.com')).toThrow();
      expect(() => validateUrl('ws://example.com')).toThrow();
    });

    it('should reject empty/null', () => {
      expect(() => validateUrl('')).toThrow('non-empty string');
      expect(() => validateUrl(null)).toThrow('non-empty string');
    });

    it('should reject invalid URLs', () => {
      expect(() => validateUrl('not-a-url')).toThrow('Invalid URL');
    });
  });

  describe('isValidUrl()', () => {
    it('should return true for valid URLs', () => {
      expect(isValidUrl('http://localhost:8080')).toBe(true);
    });

    it('should return false for invalid URLs', () => {
      expect(isValidUrl('not-url')).toBe(false);
      expect(isValidUrl('')).toBe(false);
    });
  });

  describe('validateBoolean()', () => {
    it('should pass through booleans', () => {
      expect(validateBoolean(true)).toBe(true);
      expect(validateBoolean(false)).toBe(false);
    });

    it('should parse truthy strings', () => {
      expect(validateBoolean('true')).toBe(true);
      expect(validateBoolean('1')).toBe(true);
      expect(validateBoolean('yes')).toBe(true);
      expect(validateBoolean('on')).toBe(true);
      expect(validateBoolean('TRUE')).toBe(true);
    });

    it('should parse falsy strings', () => {
      expect(validateBoolean('false')).toBe(false);
      expect(validateBoolean('0')).toBe(false);
      expect(validateBoolean('no')).toBe(false);
      expect(validateBoolean('off')).toBe(false);
    });

    it('should use default for null/undefined', () => {
      expect(validateBoolean(null, true)).toBe(true);
      expect(validateBoolean(undefined, false)).toBe(false);
    });

    it('should coerce other values', () => {
      expect(validateBoolean(1)).toBe(true);
      expect(validateBoolean(0)).toBe(false);
    });
  });

  describe('validatePositiveInt()', () => {
    it('should parse valid integers', () => {
      expect(validatePositiveInt('42', 0)).toBe(42);
      expect(validatePositiveInt(10, 0)).toBe(10);
    });

    it('should return default for invalid', () => {
      expect(validatePositiveInt('abc', 5)).toBe(5);
      expect(validatePositiveInt(NaN, 5)).toBe(5);
      expect(validatePositiveInt(0, 5)).toBe(5); // below min=1
    });

    it('should enforce min/max bounds', () => {
      expect(validatePositiveInt(3, 5, 5, 10)).toBe(5); // below min
      expect(validatePositiveInt(15, 5, 5, 10)).toBe(5); // above max
      expect(validatePositiveInt(7, 5, 5, 10)).toBe(7);
    });
  });

  describe('validateFloat()', () => {
    it('should parse valid floats', () => {
      expect(validateFloat('3.14', 0)).toBeCloseTo(3.14);
      expect(validateFloat(2.5, 0)).toBe(2.5);
    });

    it('should return default for invalid', () => {
      expect(validateFloat('abc', 1.0)).toBe(1.0);
      expect(validateFloat(Infinity, 1.0)).toBe(1.0);
    });

    it('should enforce min/max bounds', () => {
      expect(validateFloat(-5, 0, 0, 10)).toBe(0);
      expect(validateFloat(15, 0, 0, 10)).toBe(0);
    });
  });

  describe('validateEnum()', () => {
    it('should return matching value', () => {
      expect(validateEnum('debug', ['info', 'debug', 'error'], 'info')).toBe('debug');
    });

    it('should be case insensitive', () => {
      expect(validateEnum('DEBUG', ['info', 'debug'], 'info')).toBe('debug');
    });

    it('should return default for non-matching', () => {
      expect(validateEnum('trace', ['info', 'debug'], 'info')).toBe('info');
    });

    it('should throw on empty allowedValues', () => {
      expect(() => validateEnum('x', [], 'x')).toThrow('non-empty array');
    });
  });

  describe('Specialized enum validators', () => {
    it('validateLogLevel', () => {
      expect(validateLogLevel('debug')).toBe('debug');
      expect(validateLogLevel('invalid')).toBe('info');
    });

    it('validateSanitizerProfile', () => {
      expect(validateSanitizerProfile('permissive')).toBe('permissive');
      expect(validateSanitizerProfile('invalid')).toBe('strict');
    });

    it('validateStorageBackend', () => {
      expect(validateStorageBackend('sqlite')).toBe('sqlite');
      expect(validateStorageBackend('invalid')).toBe('postgresql');
    });
  });

  describe('validatePort()', () => {
    it('should accept valid ports', () => {
      expect(validatePort(8080, 3000)).toBe(8080);
      expect(validatePort('443', 3000)).toBe(443);
    });

    it('should reject out of range', () => {
      expect(validatePort(0, 3000)).toBe(3000);
      expect(validatePort(70000, 3000)).toBe(3000);
    });
  });

  describe('validateTimeout()', () => {
    it('should accept valid timeouts', () => {
      expect(validateTimeout(5000, 3000)).toBe(5000);
    });

    it('should reject too small/large', () => {
      expect(validateTimeout(10, 3000)).toBe(3000); // below 100ms
      expect(validateTimeout(700000, 3000)).toBe(3000); // above 600000
    });
  });

  describe('validateFileSize()', () => {
    it('should accept valid sizes', () => {
      expect(validateFileSize(1048576, 1024)).toBe(1048576);
    });

    it('should reject out of range', () => {
      expect(validateFileSize(100, 1024)).toBe(1024); // below 1024
    });
  });

  describe('normalizeUrl()', () => {
    it('should remove trailing slashes', () => {
      expect(normalizeUrl('http://example.com/')).toBe('http://example.com');
      expect(normalizeUrl('http://example.com///')).toBe('http://example.com');
    });

    it('should return empty for invalid', () => {
      expect(normalizeUrl(null)).toBe('');
      expect(normalizeUrl('')).toBe('');
    });
  });

  describe('httpToWs()', () => {
    it('should convert http to ws', () => {
      expect(httpToWs('http://localhost:8080')).toBe('ws://localhost:8080');
    });

    it('should convert https to wss', () => {
      expect(httpToWs('https://example.com')).toBe('wss://example.com');
    });

    it('should throw on invalid input', () => {
      expect(() => httpToWs(null)).toThrow();
      expect(() => httpToWs('')).toThrow();
    });
  });

  describe('validateString()', () => {
    it('should return string as-is', () => {
      expect(validateString('hello')).toBe('hello');
    });

    it('should return default for null/undefined', () => {
      expect(validateString(null, 'default')).toBe('default');
      expect(validateString(undefined, 'default')).toBe('default');
    });

    it('should convert to string', () => {
      expect(validateString(42)).toBe('42');
    });

    it('should truncate to maxLength', () => {
      expect(validateString('hello world', '', 5)).toBe('hello');
    });
  });

  describe('validateRequiredKeys()', () => {
    it('should pass with all keys present', () => {
      expect(() => validateRequiredKeys({ a: 1, b: 2 }, ['a', 'b'])).not.toThrow();
    });

    it('should throw with missing keys', () => {
      expect(() => validateRequiredKeys({ a: 1 }, ['a', 'b'])).toThrow('Missing required keys: b');
    });

    it('should throw on non-object', () => {
      expect(() => validateRequiredKeys(null, ['a'])).toThrow('must be an object');
    });
  });

  describe('validateArrayOfType()', () => {
    it('should accept valid typed arrays', () => {
      expect(validateArrayOfType(['a', 'b'], 'string')).toEqual(['a', 'b']);
      expect(validateArrayOfType([1, 2], 'number')).toEqual([1, 2]);
    });

    it('should return default for non-array', () => {
      expect(validateArrayOfType('not-array', 'string', [])).toEqual([]);
    });

    it('should return default for mixed types', () => {
      expect(validateArrayOfType([1, 'two'], 'number', [0])).toEqual([0]);
    });
  });
});
