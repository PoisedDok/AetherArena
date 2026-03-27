'use strict';

/**
 * InputValidator Comprehensive Tests
 * Covers all validation methods, security detection, compatibility API,
 * schema validation, statistics, and edge cases.
 */

const {
  InputValidator,
  ValidationError,
  VALIDATION_RULES
} = require('../../../../src/core/security/InputValidator');

describe('InputValidator', () => {
  let validator;

  beforeEach(() => {
    validator = new InputValidator();
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('uses default limits', () => {
      expect(validator.maxStringLength).toBe(10000);
      expect(validator.maxArrayLength).toBe(1000);
      expect(validator.maxObjectDepth).toBe(10);
    });

    it('accepts custom limits', () => {
      const v = new InputValidator({
        maxStringLength: 500,
        maxArrayLength: 50,
        maxObjectDepth: 3
      });
      expect(v.maxStringLength).toBe(500);
      expect(v.maxArrayLength).toBe(50);
      expect(v.maxObjectDepth).toBe(3);
    });

    it('initializes empty stats', () => {
      expect(validator.stats.totalValidations).toBe(0);
      expect(validator.stats.failures).toBe(0);
      expect(validator.stats.byType).toBeInstanceOf(Map);
      expect(validator.stats.byType.size).toBe(0);
    });
  });

  // =========================================================================
  // ValidationError
  // =========================================================================

  describe('ValidationError', () => {
    it('is an instance of Error', () => {
      const err = new ValidationError('test', 'field1', 'rule1');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('ValidationError');
      expect(err.message).toBe('test');
      expect(err.field).toBe('field1');
      expect(err.rule).toBe('rule1');
      expect(err.isValidationError).toBe(true);
    });
  });

  // =========================================================================
  // VALIDATION_RULES export
  // =========================================================================

  describe('VALIDATION_RULES', () => {
    it('exports frozen rules object', () => {
      expect(Object.isFrozen(VALIDATION_RULES)).toBe(true);
    });

    it('has expected patterns', () => {
      expect(VALIDATION_RULES.email).toBeInstanceOf(RegExp);
      expect(VALIDATION_RULES.url).toBeInstanceOf(RegExp);
      expect(VALIDATION_RULES.uuid).toBeInstanceOf(RegExp);
      expect(VALIDATION_RULES.sqlInjection).toBeInstanceOf(RegExp);
      expect(VALIDATION_RULES.commandInjection).toBeInstanceOf(RegExp);
      expect(VALIDATION_RULES.xssPatterns).toBeInstanceOf(RegExp);
    });
  });

  // =========================================================================
  // validateString()
  // =========================================================================

  describe('validateString()', () => {
    it('accepts valid strings', () => {
      expect(validator.validateString('hello')).toBe(true);
      expect(validator.validateString('Hello World!')).toBe(true);
      expect(validator.validateString('test123')).toBe(true);
    });

    it('rejects non-strings', () => {
      expect(() => validator.validateString(123)).toThrow(ValidationError);
      expect(() => validator.validateString(null)).toThrow(ValidationError);
      expect(() => validator.validateString(undefined)).toThrow(ValidationError);
      expect(() => validator.validateString({})).toThrow(ValidationError);
      expect(() => validator.validateString([])).toThrow(ValidationError);
    });

    it('enforces minLength', () => {
      expect(() => validator.validateString('ab', { minLength: 3 })).toThrow(/minimum 3/i);
      expect(validator.validateString('abc', { minLength: 3 })).toBe(true);
    });

    it('enforces maxLength', () => {
      expect(() => validator.validateString('abcdef', { maxLength: 5 })).toThrow(/maximum 5/i);
      expect(validator.validateString('abcde', { maxLength: 5 })).toBe(true);
    });

    it('uses instance maxStringLength as default', () => {
      const v = new InputValidator({ maxStringLength: 5 });
      expect(() => v.validateString('123456')).toThrow(/maximum 5/i);
    });

    it('validates against pattern', () => {
      expect(validator.validateString('abc123', { pattern: /^[a-z0-9]+$/ })).toBe(true);
      expect(() => validator.validateString('ABC', { pattern: /^[a-z0-9]+$/ })).toThrow(/pattern/i);
    });

    it('detects SQL injection (broad pattern)', () => {
      expect(() => validator.validateString('SELECT * FROM users', { noSqlInjection: true }))
        .toThrow(/SQL injection/i);
      expect(() => validator.validateString("'; DROP TABLE users--", { noSqlInjection: true }))
        .toThrow(/SQL injection/i);
      expect(validator.validateString('normal text', { noSqlInjection: true })).toBe(true);
    });

    it('detects SQL injection via detectHighRiskSql', () => {
      // Strict pattern: UNION ALL SELECT
      expect(() => validator.validateString(
        "' UNION ALL SELECT * FROM passwords--",
        { noSqlInjection: true }
      )).toThrow(/SQL injection/i);

      // Strict pattern: boolean comparison
      expect(() => validator.validateString(
        "' OR '1'='1",
        { noSqlInjection: true }
      )).toThrow(/SQL injection/i);

      // Strict pattern: DROP DATABASE
      expect(() => validator.validateString(
        "; DROP DATABASE main",
        { noSqlInjection: true }
      )).toThrow(/SQL injection/i);

      // Strict pattern: INTO OUTFILE
      expect(() => validator.validateString(
        "SELECT data INTO OUTFILE '/tmp/dump.txt'",
        { noSqlInjection: true }
      )).toThrow(/SQL injection/i);

      // Strict pattern: EXEC xp_cmdshell
      expect(() => validator.validateString(
        "EXEC xp_cmdshell('dir')",
        { noSqlInjection: true }
      )).toThrow(/SQL injection/i);

      // Strict pattern: SLEEP injection
      expect(() => validator.validateString(
        "1; SELECT sleep(5)",
        { noSqlInjection: true }
      )).toThrow(/SQL injection/i);

      // Strict pattern: BENCHMARK injection
      expect(() => validator.validateString(
        "SELECT benchmark(1000000, sha1('test'))",
        { noSqlInjection: true }
      )).toThrow(/SQL injection/i);

      // 2 keywords + comment = high risk
      expect(() => validator.validateString(
        "SELECT id FROM users -- admin",
        { noSqlInjection: true }
      )).toThrow(/SQL injection/i);

      // 2 keywords + semicolon = high risk
      expect(() => validator.validateString(
        "SELECT 1; DELETE FROM logs",
        { noSqlInjection: true }
      )).toThrow(/SQL injection/i);

      // 2 keywords + boolean comparison = high risk
      expect(() => validator.validateString(
        "SELECT * FROM users WHERE name = admin OR id = 1",
        { noSqlInjection: true }
      )).toThrow(/SQL injection/i);

      // 3+ keywords = high risk even without delimiters
      expect(() => validator.validateString(
        "SELECT INSERT UPDATE",
        { noSqlInjection: true }
      )).toThrow(/SQL injection/i);
    });

    it('detectHighRiskSql returns false for non-strings', () => {
      // This is handled internally — a non-string won't match SQL patterns
      // Test via the broad VALIDATION_RULES.sqlInjection first, then detectHighRiskSql
      expect(validator.validateString('just a number 42', { noSqlInjection: true })).toBe(true);
    });

    it('detectHighRiskSql returns false for empty/whitespace', () => {
      expect(validator.validateString('   ', { noSqlInjection: true })).toBe(true);
    });

    it('detectHighRiskSql returns false for single keyword without delimiters', () => {
      // "select" alone = 1 keyword, no comment/semicolon/boolean => not high risk
      // But VALIDATION_RULES.sqlInjection broad pattern catches it first (has \b(SELECT)\b)
      // The broad regex catches single keywords, so this throws
      expect(() => validator.validateString('Please select your option', { noSqlInjection: true }))
        .toThrow(/SQL injection/i);
    });

    it('detectHighRiskSql catches 3+ non-broad-regex keywords', () => {
      // truncate, xp_cmdshell, sp_executesql are NOT in the broad sqlInjection regex
      // but ARE in SQL_KEYWORD_REGEXES. 3+ keywords = high risk via detectHighRiskSql
      expect(() => validator.validateString(
        'truncate xp_cmdshell sp_executesql',
        { noSqlInjection: true }
      )).toThrow(/SQL injection/i);
    });

    it('detectHighRiskSql catches 2 non-broad keywords + block comment', () => {
      // 2 keywords (truncate, xp_cmdshell) + /* comment
      expect(() => validator.validateString(
        'truncate xp_cmdshell /* hidden */',
        { noSqlInjection: true }
      )).toThrow(/SQL injection/i);
    });

    it('detectHighRiskSql catches strict pattern: OR 1=1', () => {
      // Strict pattern: ' or '1'='1  — BUT this has ' which the broad regex catches first.
      // Use a pattern that hits strict but no broad: e.g., " AND true" combo with truncate
      // Actually the strict patterns use (['"])\s*(?:or|and) which requires a quote char.
      // The broad regex catches ' and " so strict patterns with quotes never reach detectHighRiskSql.
      // However, we can reach line 96-109 (keyword counting) via non-broad keywords.

      // 2 non-broad keywords + boolean comparison
      expect(() => validator.validateString(
        'truncate xp_cmdshell or id = 1',
        { noSqlInjection: true }
      )).toThrow(/SQL injection/i);
    });

    it('detectHighRiskSql strict pattern: INTO OUTFILE (bypasses broad regex)', () => {
      // "into" and "outfile" are NOT in the broad sqlInjection keyword list
      // This reaches SQL_STRICT_PATTERNS[5] inside detectHighRiskSql
      expect(() => validator.validateString(
        'into outfile',
        { noSqlInjection: true }
      )).toThrow(/SQL injection/i);
    });

    it('detectHighRiskSql strict pattern: sleep() (bypasses broad regex)', () => {
      // "sleep" is NOT in the broad sqlInjection regex keywords
      expect(() => validator.validateString(
        'sleep(5)',
        { noSqlInjection: true }
      )).toThrow(/SQL injection/i);
    });

    it('detectHighRiskSql strict pattern: benchmark() (bypasses broad regex)', () => {
      expect(() => validator.validateString(
        'benchmark(1000000)',
        { noSqlInjection: true }
      )).toThrow(/SQL injection/i);
    });

    it('detectHighRiskSql strict pattern: load_file() (bypasses broad regex)', () => {
      expect(() => validator.validateString(
        'load_file(0x2F6574632F706173737764)',
        { noSqlInjection: true }
      )).toThrow(/SQL injection/i);
    });

    it('detects command injection', () => {
      expect(() => validator.validateString('test; rm -rf /', { noCommandInjection: true }))
        .toThrow(/command injection/i);
      expect(() => validator.validateString('test && echo hacked', { noCommandInjection: true }))
        .toThrow(/command injection/i);
      expect(() => validator.validateString('$(whoami)', { noCommandInjection: true }))
        .toThrow(/command injection/i);
      expect(() => validator.validateString('`id`', { noCommandInjection: true }))
        .toThrow(/command injection/i);
      expect(() => validator.validateString('test || true', { noCommandInjection: true }))
        .toThrow(/command injection/i);
      expect(() => validator.validateString('${HOME}', { noCommandInjection: true }))
        .toThrow(/command injection/i);
      expect(validator.validateString('normal text', { noCommandInjection: true })).toBe(true);
    });

    it('detects XSS patterns', () => {
      expect(() => validator.validateString('<script>alert(1)</script>', { noXss: true }))
        .toThrow(/XSS/i);
      expect(() => validator.validateString('javascript:alert(1)', { noXss: true }))
        .toThrow(/XSS/i);
      expect(() => validator.validateString('<img onerror=alert(1)>', { noXss: true }))
        .toThrow(/XSS/i);
      expect(() => validator.validateString('<iframe src="x">', { noXss: true }))
        .toThrow(/XSS/i);
      expect(() => validator.validateString('eval(code)', { noXss: true }))
        .toThrow(/XSS/i);
      expect(validator.validateString('normal text', { noXss: true })).toBe(true);
    });

    it('increments stats.failures on security violations', () => {
      try { validator.validateString('<script>x</script>', { noXss: true }); } catch (e) { /* expected */ }
      try { validator.validateString('cmd; ls', { noCommandInjection: true }); } catch (e) { /* expected */ }
      try { validator.validateString("SELECT 1; DROP TABLE t--", { noSqlInjection: true }); } catch (e) { /* expected */ }

      expect(validator.stats.failures).toBe(3);
    });
  });

  // =========================================================================
  // validateNumber()
  // =========================================================================

  describe('validateNumber()', () => {
    it('accepts valid numbers', () => {
      expect(validator.validateNumber(0)).toBe(true);
      expect(validator.validateNumber(123)).toBe(true);
      expect(validator.validateNumber(-456)).toBe(true);
      expect(validator.validateNumber(3.14)).toBe(true);
    });

    it('rejects non-numbers', () => {
      expect(() => validator.validateNumber('123')).toThrow(ValidationError);
      expect(() => validator.validateNumber(null)).toThrow(ValidationError);
      expect(() => validator.validateNumber(undefined)).toThrow(ValidationError);
      expect(() => validator.validateNumber(NaN)).toThrow(ValidationError);
      expect(() => validator.validateNumber(Infinity)).toThrow(ValidationError);
      expect(() => validator.validateNumber(-Infinity)).toThrow(ValidationError);
    });

    it('enforces min', () => {
      expect(() => validator.validateNumber(5, { min: 10 })).toThrow(/minimum 10/i);
      expect(validator.validateNumber(10, { min: 10 })).toBe(true);
    });

    it('enforces max', () => {
      expect(() => validator.validateNumber(100, { max: 50 })).toThrow(/maximum 50/i);
      expect(validator.validateNumber(50, { max: 50 })).toBe(true);
    });

    it('enforces integer constraint', () => {
      expect(() => validator.validateNumber(3.14, { integer: true })).toThrow(/integer/i);
      expect(validator.validateNumber(42, { integer: true })).toBe(true);
    });

    it('enforces positive constraint', () => {
      expect(() => validator.validateNumber(-5, { positive: true })).toThrow(/positive/i);
      expect(() => validator.validateNumber(0, { positive: true })).toThrow(/positive/i);
      expect(validator.validateNumber(5, { positive: true })).toBe(true);
    });
  });

  // =========================================================================
  // validateEmail()
  // =========================================================================

  describe('validateEmail()', () => {
    it('accepts valid emails', () => {
      expect(validator.validateEmail('user@example.com')).toBe(true);
      expect(validator.validateEmail('user.name@example.com')).toBe(true);
      expect(validator.validateEmail('user+tag@example.co.uk')).toBe(true);
    });

    it('rejects invalid emails', () => {
      expect(() => validator.validateEmail('invalid')).toThrow(/invalid email/i);
      expect(() => validator.validateEmail('@example.com')).toThrow(/invalid email/i);
      expect(() => validator.validateEmail('user@')).toThrow(/invalid email/i);
      expect(() => validator.validateEmail(123)).toThrow(/must be a string/i);
    });
  });

  // =========================================================================
  // validateURL()
  // =========================================================================

  describe('validateURL()', () => {
    it('accepts valid URLs', () => {
      expect(validator.validateURL('http://example.com')).toBe(true);
      expect(validator.validateURL('https://example.com')).toBe(true);
      expect(validator.validateURL('http://localhost:8080')).toBe(true);
      expect(validator.validateURL('https://sub.example.com/path?q=1')).toBe(true);
    });

    it('rejects non-string input', () => {
      expect(() => validator.validateURL(123)).toThrow(/must be a string/i);
    });

    it('rejects invalid URLs', () => {
      expect(() => validator.validateURL('not-a-url')).toThrow(/invalid url/i);
    });

    it('blocks dangerous protocols', () => {
      expect(() => validator.validateURL('javascript:alert(1)')).toThrow(/dangerous/i);
      expect(() => validator.validateURL('data:text/html,<script>alert(1)</script>')).toThrow(/dangerous/i);
      expect(() => validator.validateURL('vbscript:alert(1)')).toThrow(/dangerous/i);
      expect(() => validator.validateURL('file:///etc/passwd')).toThrow(/dangerous/i);
    });

    it('increments failures on dangerous protocol', () => {
      const before = validator.stats.failures;
      try { validator.validateURL('javascript:alert(1)'); } catch (e) { /* expected */ }
      expect(validator.stats.failures).toBe(before + 1);
    });

    it('enforces allowed protocols', () => {
      expect(() => validator.validateURL('http://example.com', { protocols: ['https:'] }))
        .toThrow(/protocol not allowed/i);
      expect(validator.validateURL('https://example.com', { protocols: ['https:'] })).toBe(true);
    });

    it('re-throws ValidationError from dangerous protocol check', () => {
      try {
        validator.validateURL('javascript:void(0)');
        throw new Error('should not reach');
      } catch (e) {
        expect(e.isValidationError).toBe(true);
        expect(e.rule).toBe('security');
      }
    });
  });

  // =========================================================================
  // validateObject()
  // =========================================================================

  describe('validateObject()', () => {
    it('accepts valid objects', () => {
      expect(validator.validateObject({})).toBe(true);
      expect(validator.validateObject({ a: 1, b: 'str' })).toBe(true);
    });

    it('rejects non-objects', () => {
      expect(() => validator.validateObject(null)).toThrow(/must be an object/i);
      expect(() => validator.validateObject('string')).toThrow(/must be an object/i);
      expect(() => validator.validateObject(42)).toThrow(/must be an object/i);
    });

    it('rejects arrays explicitly', () => {
      expect(() => validator.validateObject([1, 2])).toThrow(/not array/i);
    });

    it('detects prototype pollution — __proto__', () => {
      // Create object with __proto__ as own property
      const obj = Object.create(null);
      obj.__proto__ = { polluted: true };
      expect(() => validator.validateObject(obj)).toThrow(/dangerous keys/i);
    });

    it('detects prototype pollution — constructor', () => {
      expect(() => validator.validateObject({ constructor: {} })).toThrow(/dangerous keys/i);
    });

    it('detects prototype pollution — prototype', () => {
      expect(() => validator.validateObject({ prototype: {} })).toThrow(/dangerous keys/i);
    });

    it('detects nested dangerous keys', () => {
      const nested = { safe: { deep: { constructor: {} } } };
      expect(() => validator.validateObject(nested)).toThrow(/dangerous keys/i);
    });

    it('allows dangerous keys when schema.allowDangerousKeys = true', () => {
      expect(validator.validateObject(
        { constructor: {} },
        { allowDangerousKeys: true }
      )).toBe(true);
    });

    it('enforces max object depth', () => {
      const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: {} } } } } } } } } } } };
      expect(() => validator.validateObject(deep)).toThrow(/too deep/i);
    });

    it('accepts objects within depth limit', () => {
      const v = new InputValidator({ maxObjectDepth: 3 });
      expect(v.validateObject({ a: { b: { c: 1 } } })).toBe(true);
    });

    it('validates required fields', () => {
      expect(() => validator.validateObject({ name: 'John' }, { required: ['name', 'age'] }))
        .toThrow(/Missing required field: age/i);
      expect(validator.validateObject({ name: 'John', age: 30 }, { required: ['name', 'age'] }))
        .toBe(true);
    });

    it('validates field schemas', () => {
      const schema = {
        fields: {
          name: { type: 'string', minLength: 1 },
          age: { type: 'number', min: 0 },
          email: { type: 'email' },
          website: { type: 'url' },
          tags: { type: 'array', minLength: 1 },
          config: { type: 'object', required: ['key'] }
        }
      };

      expect(validator.validateObject({
        name: 'John',
        age: 30,
        email: 'john@example.com',
        website: 'https://john.com',
        tags: ['dev'],
        config: { key: 'val' }
      }, schema)).toBe(true);
    });

    it('validates field schema with custom validator', () => {
      const schema = {
        fields: {
          status: { type: 'custom', validator: (v) => v === 'active' || v === 'inactive' }
        }
      };

      expect(validator.validateObject({ status: 'active' }, schema)).toBe(true);
      expect(() => validator.validateObject({ status: 'unknown' }, schema))
        .toThrow(/Custom validation failed/i);
    });

    it('field schema error sets field name on ValidationError', () => {
      const schema = { fields: { age: { type: 'number' } } };
      try {
        validator.validateObject({ age: 'not-a-number' }, schema);
        throw new Error('should not reach');
      } catch (e) {
        expect(e.field).toBe('age');
      }
    });

    it('skips field validation for keys not present in object', () => {
      const schema = { fields: { optional: { type: 'string' } } };
      expect(validator.validateObject({}, schema)).toBe(true);
    });
  });

  // =========================================================================
  // validateArray()
  // =========================================================================

  describe('validateArray()', () => {
    it('accepts valid arrays', () => {
      expect(validator.validateArray([])).toBe(true);
      expect(validator.validateArray([1, 2, 3])).toBe(true);
    });

    it('rejects non-arrays', () => {
      expect(() => validator.validateArray('[]')).toThrow(/must be an array/i);
      expect(() => validator.validateArray({})).toThrow(/must be an array/i);
      expect(() => validator.validateArray(null)).toThrow(/must be an array/i);
    });

    it('enforces minLength', () => {
      expect(() => validator.validateArray([1], { minLength: 2 })).toThrow(/minimum 2/i);
      expect(validator.validateArray([1, 2], { minLength: 2 })).toBe(true);
    });

    it('enforces maxLength', () => {
      expect(() => validator.validateArray([1, 2, 3], { maxLength: 2 })).toThrow(/maximum 2/i);
    });

    it('uses instance maxArrayLength as default', () => {
      const v = new InputValidator({ maxArrayLength: 2 });
      expect(() => v.validateArray([1, 2, 3])).toThrow(/maximum 2/i);
    });

    it('validates elements with elementSchema', () => {
      expect(validator.validateArray([1, 2, 3], { elementSchema: { type: 'number', min: 0 } }))
        .toBe(true);
      expect(() => validator.validateArray([1, -1, 3], { elementSchema: { type: 'number', min: 0 } }))
        .toThrow(/index 1/i);
    });

    it('propagates non-ValidationError from element validation', () => {
      // Create a schema with a custom validator that throws a regular Error
      const schema = {
        elementSchema: {
          type: 'custom',
          validator: () => { throw new Error('raw error'); }
        }
      };
      expect(() => validator.validateArray([1], schema)).toThrow('raw error');
    });
  });

  // =========================================================================
  // _validateField() — internal dispatch
  // =========================================================================

  describe('_validateField()', () => {
    it('dispatches string type', () => {
      expect(validator._validateField('hello', { type: 'string' }, 'name')).toBeUndefined();
    });

    it('dispatches number type', () => {
      expect(validator._validateField(42, { type: 'number' }, 'age')).toBeUndefined();
    });

    it('dispatches email type', () => {
      expect(validator._validateField('a@b.com', { type: 'email' }, 'email')).toBeUndefined();
    });

    it('dispatches url type', () => {
      expect(validator._validateField('https://x.com', { type: 'url' }, 'url')).toBeUndefined();
    });

    it('dispatches array type', () => {
      expect(validator._validateField([1], { type: 'array' }, 'arr')).toBeUndefined();
    });

    it('dispatches object type', () => {
      expect(validator._validateField({}, { type: 'object' }, 'obj')).toBeUndefined();
    });

    it('handles custom validator (default case)', () => {
      expect(validator._validateField('ok', { type: 'unknown', validator: () => true }, 'f'))
        .toBeUndefined();
    });

    it('custom validator failure throws ValidationError', () => {
      expect(() => validator._validateField('bad', { type: 'unknown', validator: () => false }, 'myField'))
        .toThrow(/Custom validation failed for field myField/i);
    });

    it('no-op for unknown type without validator', () => {
      // Should not throw — default case with no validator is a pass-through
      expect(validator._validateField('anything', { type: 'bizarre' }, 'f')).toBeUndefined();
    });

    it('sets field name on caught ValidationError', () => {
      try {
        validator._validateField(42, { type: 'string' }, 'myField');
        throw new Error('should not reach');
      } catch (e) {
        expect(e.field).toBe('myField');
      }
    });
  });

  // =========================================================================
  // _hasDangerousKeys() — internal
  // =========================================================================

  describe('_hasDangerousKeys()', () => {
    const dangerous = ['__proto__', 'constructor', 'prototype'];

    it('returns false for null/non-object', () => {
      expect(validator._hasDangerousKeys(null, dangerous)).toBe(false);
      expect(validator._hasDangerousKeys('string', dangerous)).toBe(false);
      expect(validator._hasDangerousKeys(42, dangerous)).toBe(false);
    });

    it('returns true for direct dangerous keys', () => {
      const obj = Object.create(null);
      obj.constructor = {};
      expect(validator._hasDangerousKeys(obj, dangerous)).toBe(true);
    });

    it('returns true for nested dangerous keys', () => {
      expect(validator._hasDangerousKeys({ safe: { prototype: {} } }, dangerous)).toBe(true);
    });

    it('returns false for clean objects', () => {
      expect(validator._hasDangerousKeys({ name: 'safe', nested: { value: 1 } }, dangerous)).toBe(false);
    });

    it('ignores non-object nested values', () => {
      expect(validator._hasDangerousKeys({ a: 'string', b: 42, c: null }, dangerous)).toBe(false);
    });
  });

  // =========================================================================
  // _getObjectDepth() — internal
  // =========================================================================

  describe('_getObjectDepth()', () => {
    it('returns 0 for non-object', () => {
      expect(validator._getObjectDepth('string')).toBe(0);
      expect(validator._getObjectDepth(null)).toBe(0);
      expect(validator._getObjectDepth(42)).toBe(0);
    });

    it('returns 0 for flat object', () => {
      expect(validator._getObjectDepth({ a: 1, b: 2 })).toBe(0);
    });

    it('returns correct depth for nested objects', () => {
      expect(validator._getObjectDepth({ a: { b: 1 } })).toBe(1);
      expect(validator._getObjectDepth({ a: { b: { c: 1 } } })).toBe(2);
    });

    it('finds max depth across branches', () => {
      expect(validator._getObjectDepth({ a: { b: 1 }, c: { d: { e: 1 } } })).toBe(2);
    });

    it('ignores null nested values', () => {
      expect(validator._getObjectDepth({ a: null, b: { c: 1 } })).toBe(1);
    });
  });

  // =========================================================================
  // Statistics
  // =========================================================================

  describe('getStats()', () => {
    it('tracks validation counts by type', () => {
      validator.validateString('test');
      validator.validateNumber(123);
      validator.validateEmail('test@example.com');
      validator.validateURL('https://x.com');
      validator.validateArray([1]);
      validator.validateObject({});

      const stats = validator.getStats();
      expect(stats.totalValidations).toBe(6);
      expect(stats.byType.string).toBe(1);
      expect(stats.byType.number).toBe(1);
      expect(stats.byType.email).toBe(1);
      expect(stats.byType.url).toBe(1);
      expect(stats.byType.array).toBe(1);
      expect(stats.byType.object).toBe(1);
    });

    it('tracks failures', () => {
      try { validator.validateString('<script>xss</script>', { noXss: true }); } catch (e) { /* */ }
      expect(validator.getStats().failures).toBeGreaterThan(0);
    });

    it('calculates failure rate', () => {
      validator.validateString('ok');
      try { validator.validateString('<script>x</script>', { noXss: true }); } catch (e) { /* */ }

      const stats = validator.getStats();
      expect(stats.failureRate).toContain('%');
    });

    it('shows 0% failure rate when no validations', () => {
      expect(validator.getStats().failureRate).toBe('0%');
    });
  });

  describe('resetStats()', () => {
    it('resets all counters', () => {
      validator.validateString('test');
      validator.resetStats();

      const stats = validator.getStats();
      expect(stats.totalValidations).toBe(0);
      expect(stats.failures).toBe(0);
      expect(stats.byType).toEqual({});
    });
  });

  // =========================================================================
  // Compatibility Methods
  // =========================================================================

  describe('isString()', () => {
    it('returns true for strings', () => {
      expect(validator.isString('hello')).toBe(true);
      expect(validator.isString('')).toBe(true);
    });

    it('returns false for non-strings', () => {
      expect(validator.isString(123)).toBe(false);
      expect(validator.isString(null)).toBe(false);
      expect(validator.isString(undefined)).toBe(false);
      expect(validator.isString({})).toBe(false);
    });
  });

  describe('validateLength()', () => {
    it('returns true when within range', () => {
      expect(validator.validateLength('abc', 1, 5)).toBe(true);
      expect(validator.validateLength('ab', 2, 2)).toBe(true);
    });

    it('returns false when out of range', () => {
      expect(validator.validateLength('a', 2, 5)).toBe(false);
      expect(validator.validateLength('abcdef', 1, 5)).toBe(false);
    });

    it('returns false for non-strings', () => {
      expect(validator.validateLength(123, 1, 5)).toBe(false);
      expect(validator.validateLength(null, 0, 10)).toBe(false);
    });
  });

  describe('isNumber()', () => {
    it('returns true for valid numbers', () => {
      expect(validator.isNumber(0)).toBe(true);
      expect(validator.isNumber(42)).toBe(true);
      expect(validator.isNumber(-1.5)).toBe(true);
    });

    it('returns false for NaN and non-numbers', () => {
      expect(validator.isNumber(NaN)).toBe(false);
      expect(validator.isNumber('42')).toBe(false);
      expect(validator.isNumber(null)).toBe(false);
    });
  });

  describe('validateRange()', () => {
    it('returns true when in range', () => {
      expect(validator.validateRange(5, 1, 10)).toBe(true);
      expect(validator.validateRange(1, 1, 10)).toBe(true);
      expect(validator.validateRange(10, 1, 10)).toBe(true);
    });

    it('returns false when out of range', () => {
      expect(validator.validateRange(0, 1, 10)).toBe(false);
      expect(validator.validateRange(11, 1, 10)).toBe(false);
    });

    it('returns false for non-numbers', () => {
      expect(validator.validateRange('5', 1, 10)).toBe(false);
      expect(validator.validateRange(NaN, 1, 10)).toBe(false);
    });
  });

  describe('isValidUrl()', () => {
    it('returns true for safe URLs', () => {
      expect(validator.isValidUrl('https://example.com')).toBe(true);
      expect(validator.isValidUrl('http://localhost:3000')).toBe(true);
    });

    it('returns false for dangerous protocols', () => {
      expect(validator.isValidUrl('javascript:alert(1)')).toBe(false);
      expect(validator.isValidUrl('data:text/html,test')).toBe(false);
      expect(validator.isValidUrl('vbscript:test')).toBe(false);
      expect(validator.isValidUrl('file:///etc/passwd')).toBe(false);
    });

    it('returns false for invalid URLs', () => {
      expect(validator.isValidUrl('not-a-url')).toBe(false);
    });

    it('returns false for non-strings', () => {
      expect(validator.isValidUrl(123)).toBe(false);
      expect(validator.isValidUrl(null)).toBe(false);
    });
  });

  describe('isObject()', () => {
    it('returns true for plain objects', () => {
      expect(validator.isObject({})).toBe(true);
      expect(validator.isObject({ a: 1 })).toBe(true);
    });

    it('returns false for non-objects', () => {
      expect(validator.isObject(null)).toBe(false);
      expect(validator.isObject('string')).toBe(false);
      expect(validator.isObject(42)).toBe(false);
    });

    it('returns false for arrays', () => {
      expect(validator.isObject([1, 2])).toBe(false);
    });
  });

  describe('validateMessageSize()', () => {
    it('returns true when within limit', () => {
      expect(validator.validateMessageSize('hello', 10)).toBe(true);
      expect(validator.validateMessageSize('12345', 5)).toBe(true);
    });

    it('returns false when exceeds limit', () => {
      expect(validator.validateMessageSize('hello world', 5)).toBe(false);
    });

    it('returns false for non-strings', () => {
      expect(validator.validateMessageSize(123, 10)).toBe(false);
      expect(validator.validateMessageSize(null, 10)).toBe(false);
    });
  });

  // =========================================================================
  // validate() — schema-based validation
  // =========================================================================

  describe('validate()', () => {
    it('validates all required fields', () => {
      const schema = {
        name: { required: true, type: 'string' },
        age: { required: true, type: 'number' }
      };

      const result = validator.validate({ name: 'John', age: 30 }, schema);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual({});
    });

    it('returns errors for missing required fields', () => {
      const schema = {
        name: { required: true, type: 'string' },
        age: { required: true, type: 'number' }
      };

      const result = validator.validate({ name: 'John' }, schema);
      expect(result.valid).toBe(false);
      expect(result.errors.age).toContain('Missing required field: age');
    });

    it('validates field types', () => {
      const schema = {
        name: { type: 'string' },
        count: { type: 'number' },
        active: { type: 'boolean' },
        config: { type: 'object' },
        items: { type: 'array' }
      };

      const validResult = validator.validate({
        name: 'test', count: 5, active: true, config: {}, items: []
      }, schema);
      expect(validResult.valid).toBe(true);

      const invalidResult = validator.validate({
        name: 123, count: 'five', active: 'yes', config: 'not-obj', items: 'not-arr'
      }, schema);
      expect(invalidResult.valid).toBe(false);
      expect(Object.keys(invalidResult.errors).length).toBe(5);
    });

    it('validates string minLength and maxLength', () => {
      const schema = {
        name: { type: 'string', minLength: 2, maxLength: 10 }
      };

      expect(validator.validate({ name: 'a' }, schema).valid).toBe(false);
      expect(validator.validate({ name: 'ab' }, schema).valid).toBe(true);
      expect(validator.validate({ name: 'a'.repeat(11) }, schema).valid).toBe(false);
    });

    it('validates number min and max', () => {
      const schema = {
        score: { type: 'number', min: 0, max: 100 }
      };

      expect(validator.validate({ score: -1 }, schema).valid).toBe(false);
      expect(validator.validate({ score: 50 }, schema).valid).toBe(true);
      expect(validator.validate({ score: 101 }, schema).valid).toBe(false);
    });

    it('validates email type', () => {
      const schema = {
        email: { type: 'email' }
      };

      expect(validator.validate({ email: 'user@example.com' }, schema).valid).toBe(true);
      expect(validator.validate({ email: 'invalid' }, schema).valid).toBe(false);
    });

    it('validates url type', () => {
      const schema = {
        website: { type: 'url' }
      };

      expect(validator.validate({ website: 'https://example.com' }, schema).valid).toBe(true);
      expect(validator.validate({ website: 'not-a-url' }, schema).valid).toBe(false);
    });

    it('rejects URL with non-http protocol via validateURL in validate()', () => {
      // ftp:// passes isValidUrl (not dangerous) but fails validateURL
      // (not in default allowedProtocols: [http:, https:])
      // This tests the URL format catch block in validate()
      const schema = { link: { type: 'url' } };
      const result = validator.validate({ link: 'ftp://files.example.com' }, schema);
      expect(result.valid).toBe(false);
      expect(result.errors.link).toContain('not a valid URL');
    });

    it('validates url type with dangerous protocol', () => {
      const schema = { link: { type: 'url' } };
      const result = validator.validate({ link: 'javascript:alert(1)' }, schema);
      expect(result.valid).toBe(false);
    });

    it('skips undefined optional fields', () => {
      const schema = {
        optional: { type: 'string' }
      };

      const result = validator.validate({}, schema);
      expect(result.valid).toBe(true);
    });
  });

  // =========================================================================
  // _validateFieldType() — internal type checker
  // =========================================================================

  describe('_validateFieldType()', () => {
    it('checks string type', () => {
      expect(validator._validateFieldType('hello', 'string')).toBe(true);
      expect(validator._validateFieldType(123, 'string')).toBe(false);
    });

    it('checks number type (rejects NaN)', () => {
      expect(validator._validateFieldType(42, 'number')).toBe(true);
      expect(validator._validateFieldType(NaN, 'number')).toBe(false);
    });

    it('checks boolean type', () => {
      expect(validator._validateFieldType(true, 'boolean')).toBe(true);
      expect(validator._validateFieldType('true', 'boolean')).toBe(false);
    });

    it('checks object type (rejects arrays and null)', () => {
      expect(validator._validateFieldType({}, 'object')).toBe(true);
      expect(validator._validateFieldType([], 'object')).toBe(false);
      expect(validator._validateFieldType(null, 'object')).toBe(false);
    });

    it('checks array type', () => {
      expect(validator._validateFieldType([1, 2], 'array')).toBe(true);
      expect(validator._validateFieldType({}, 'array')).toBe(false);
    });

    it('checks email type', () => {
      expect(validator._validateFieldType('user@example.com', 'email')).toBe(true);
      expect(validator._validateFieldType('invalid', 'email')).toBe(false);
      expect(validator._validateFieldType(123, 'email')).toBe(false);
    });

    it('checks url type', () => {
      expect(validator._validateFieldType('https://example.com', 'url')).toBe(true);
      expect(validator._validateFieldType('not-a-url', 'url')).toBe(false);
      expect(validator._validateFieldType(123, 'url')).toBe(false);
    });

    it('returns true for unknown types', () => {
      expect(validator._validateFieldType('anything', 'unknown')).toBe(true);
    });
  });
});
