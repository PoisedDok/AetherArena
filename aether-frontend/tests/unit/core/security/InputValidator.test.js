'use strict';

/**
 * InputValidator Unit Tests
 * Comprehensive tests ensuring 100% coverage
 */

const { InputValidator } = require('../../../../src/core/security/InputValidator');

describe('InputValidator', () => {
  let validator;

  beforeEach(() => {
    validator = new InputValidator();
  });

  describe('validateString', () => {
    it('should validate valid strings', () => {
      expect(() => validator.validateString('hello')).not.toThrow();
      expect(() => validator.validateString('Hello World!')).not.toThrow();
      expect(() => validator.validateString('test123')).not.toThrow();
    });

    it('should reject non-strings', () => {
      expect(() => validator.validateString(123)).toThrow();
      expect(() => validator.validateString(null)).toThrow();
      expect(() => validator.validateString(undefined)).toThrow();
      expect(() => validator.validateString({})).toThrow();
      expect(() => validator.validateString([])).toThrow();
    });

    it('should enforce min length', () => {
      expect(() => validator.validateString('ab', { minLength: 3 })).toThrow(/minimum 3/i);
      expect(() => validator.validateString('abc', { minLength: 3 })).not.toThrow();
    });

    it('should enforce max length', () => {
      expect(() => validator.validateString('abcdef', { maxLength: 5 })).toThrow(/maximum 5/i);
      expect(() => validator.validateString('abcde', { maxLength: 5 })).not.toThrow();
    });

    it('should validate against pattern', () => {
      expect(() => validator.validateString('abc123', { pattern: /^[a-z0-9]+$/ })).not.toThrow();
      expect(() => validator.validateString('ABC', { pattern: /^[a-z0-9]+$/ })).toThrow(/pattern/i);
    });

    it('should detect SQL injection attempts', () => {
      expect(() => validator.validateString('SELECT * FROM users', { noSqlInjection: true })).toThrow(/SQL injection/i);
      expect(() => validator.validateString("'; DROP TABLE users--", { noSqlInjection: true })).toThrow(/SQL injection/i);
      expect(() => validator.validateString('normal text', { noSqlInjection: true })).not.toThrow();
    });

    it('should detect command injection attempts', () => {
      expect(() => validator.validateString('test; rm -rf /', { noCommandInjection: true })).toThrow(/command injection/i);
      expect(() => validator.validateString('test && echo hacked', { noCommandInjection: true })).toThrow(/command injection/i);
      expect(() => validator.validateString('normal text', { noCommandInjection: true })).not.toThrow();
    });

    it('should detect XSS attempts', () => {
      expect(() => validator.validateString('<script>alert(1)</script>', { noXss: true })).toThrow(/XSS/i);
      expect(() => validator.validateString('javascript:alert(1)', { noXss: true })).toThrow(/XSS/i);
      expect(() => validator.validateString('normal text', { noXss: true })).not.toThrow();
    });
  });

  describe('validateNumber', () => {
    it('should validate valid numbers', () => {
      expect(() => validator.validateNumber(0)).not.toThrow();
      expect(() => validator.validateNumber(123)).not.toThrow();
      expect(() => validator.validateNumber(-456)).not.toThrow();
      expect(() => validator.validateNumber(3.14)).not.toThrow();
    });

    it('should reject non-numbers', () => {
      expect(() => validator.validateNumber('123')).toThrow();
      expect(() => validator.validateNumber(null)).toThrow();
      expect(() => validator.validateNumber(undefined)).toThrow();
      expect(() => validator.validateNumber(NaN)).toThrow();
      expect(() => validator.validateNumber(Infinity)).toThrow();
    });

    it('should enforce min value', () => {
      expect(() => validator.validateNumber(5, { min: 10 })).toThrow();
      expect(() => validator.validateNumber(10, { min: 10 })).not.toThrow();
    });

    it('should enforce max value', () => {
      expect(() => validator.validateNumber(100, { max: 50 })).toThrow();
      expect(() => validator.validateNumber(50, { max: 50 })).not.toThrow();
    });

    it('should enforce integer constraint', () => {
      expect(() => validator.validateNumber(3.14, { integer: true })).toThrow();
      expect(() => validator.validateNumber(42, { integer: true })).not.toThrow();
    });

    it('should enforce positive constraint', () => {
      expect(() => validator.validateNumber(-5, { positive: true })).toThrow();
      expect(() => validator.validateNumber(0, { positive: true })).toThrow();
      expect(() => validator.validateNumber(5, { positive: true })).not.toThrow();
    });
  });


  describe('validateArray', () => {
    it('should validate arrays', () => {
      expect(() => validator.validateArray([])).not.toThrow();
      expect(() => validator.validateArray([1, 2, 3])).not.toThrow();
    });

    it('should reject non-arrays', () => {
      expect(() => validator.validateArray('[]')).toThrow(/must be an array/i);
      expect(() => validator.validateArray({})).toThrow(/must be an array/i);
      expect(() => validator.validateArray(null)).toThrow(/must be an array/i);
    });

    it('should enforce min length', () => {
      expect(() => validator.validateArray([1], { minLength: 2 })).toThrow(/minimum 2/i);
      expect(() => validator.validateArray([1, 2], { minLength: 2 })).not.toThrow();
    });

    it('should enforce max length', () => {
      expect(() => validator.validateArray([1, 2, 3], { maxLength: 2 })).toThrow(/maximum 2/i);
      expect(() => validator.validateArray([1, 2], { maxLength: 2 })).not.toThrow();
    });

    it('should validate array elements with elementSchema', () => {
      const elementSchema = { type: 'number', min: 0 };
      
      expect(() => validator.validateArray([1, 2, 3], { elementSchema })).not.toThrow();
      expect(() => validator.validateArray([1, -1, 3], { elementSchema })).toThrow();
    });
  });

  describe('validateObject', () => {
    it('should validate objects', () => {
      expect(() => validator.validateObject({})).not.toThrow();
      expect(() => validator.validateObject({ a: 1 })).not.toThrow();
    });

    it('should reject non-objects', () => {
      expect(() => validator.validateObject(null)).toThrow(/must be an object/i);
      expect(() => validator.validateObject('object')).toThrow(/must be an object/i);
    });

    it('should validate required fields', () => {
      const schema = { required: ['name', 'age'] };
      expect(() => validator.validateObject({ name: 'John', age: 30 }, schema)).not.toThrow();
      expect(() => validator.validateObject({ name: 'John' }, schema)).toThrow(/required field/i);
    });

    it('should validate with field schema', () => {
      const schema = {
        fields: {
          name: { type: 'string', minLength: 1 },
          age: { type: 'number', min: 0 }
        }
      };
      
      expect(() => validator.validateObject({ name: 'John', age: 30 }, schema)).not.toThrow();
      expect(() => validator.validateObject({ name: '', age: 30 }, schema)).toThrow();
      expect(() => validator.validateObject({ name: 'John', age: -5 }, schema)).toThrow();
    });

    it('should detect prototype pollution attempts', () => {
      // Constructor and prototype are direct dangerous keys
      expect(() => validator.validateObject({ constructor: {} })).toThrow(/dangerous keys/i);
      expect(() => validator.validateObject({ prototype: {} })).toThrow(/dangerous keys/i);
      // __proto__ may not be detected as a direct property in all environments
      const protoTest = { constructor: { prototype: { polluted: true } } };
      expect(() => validator.validateObject(protoTest)).toThrow(/dangerous keys/i);
    });

    it('should enforce max object depth', () => {
      const deepObject = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: {} } } } } } } } } } } };
      expect(() => validator.validateObject(deepObject)).toThrow(/too deep/i);
    });
  });

  describe('validateURL', () => {
    it('should validate valid URLs', () => {
      expect(() => validator.validateURL('http://example.com')).not.toThrow();
      expect(() => validator.validateURL('https://example.com')).not.toThrow();
      expect(() => validator.validateURL('http://localhost:8080')).not.toThrow();
      expect(() => validator.validateURL('https://sub.example.com/path')).not.toThrow();
    });

    it('should reject invalid URLs', () => {
      expect(() => validator.validateURL('not-a-url')).toThrow(/invalid url/i);
      expect(() => validator.validateURL(123)).toThrow(/must be a string/i);
    });

    it('should reject dangerous protocols', () => {
      expect(() => validator.validateURL('javascript:alert(1)')).toThrow(/dangerous/i);
      expect(() => validator.validateURL('data:text/html,<script>alert(1)</script>')).toThrow(/dangerous/i);
      expect(() => validator.validateURL('vbscript:alert(1)')).toThrow(/dangerous/i);
    });

    it('should enforce allowed protocols', () => {
      expect(() => validator.validateURL('http://example.com', { protocols: ['https:'] })).toThrow(/protocol not allowed/i);
      expect(() => validator.validateURL('https://example.com', { protocols: ['https:'] })).not.toThrow();
    });
  });

  describe('validateEmail', () => {
    it('should validate valid emails', () => {
      expect(() => validator.validateEmail('user@example.com')).not.toThrow();
      expect(() => validator.validateEmail('user.name@example.com')).not.toThrow();
      expect(() => validator.validateEmail('user+tag@example.co.uk')).not.toThrow();
    });

    it('should reject invalid emails', () => {
      expect(() => validator.validateEmail('invalid')).toThrow(/invalid email/i);
      expect(() => validator.validateEmail('@example.com')).toThrow(/invalid email/i);
      expect(() => validator.validateEmail('user@')).toThrow(/invalid email/i);
      expect(() => validator.validateEmail(123)).toThrow(/must be a string/i);
    });
  });

  describe('statistics', () => {
    it('should track validation counts', () => {
      validator.validateString('test');
      validator.validateNumber(123);
      validator.validateEmail('test@example.com');
      
      const stats = validator.getStats();
      expect(stats.totalValidations).toBe(3);
      expect(stats.byType).toHaveProperty('string');
      expect(stats.byType).toHaveProperty('number');
      expect(stats.byType).toHaveProperty('email');
    });

    it('should track failures', () => {
      try {
        validator.validateString('<script>xss</script>', { noXss: true });
      } catch (e) {
        // expected
      }
      
      const stats = validator.getStats();
      expect(stats.failures).toBeGreaterThan(0);
    });

    it('should reset statistics', () => {
      validator.validateString('test');
      validator.resetStats();
      
      const stats = validator.getStats();
      expect(stats.totalValidations).toBe(0);
      expect(stats.failures).toBe(0);
    });
  });
});

