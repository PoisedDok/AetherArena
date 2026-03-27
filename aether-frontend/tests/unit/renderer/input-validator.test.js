'use strict';

// ---------------------------------------------------------------------------
// No mocks needed — InputValidator is pure logic, no dependencies
// ---------------------------------------------------------------------------

const { InputValidator, ValidationError } = require('../../../src/renderer/shared/security/inputValidator');

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('InputValidator', () => {

  // ═══════════════════════════════════════════════════════════════════════
  // SECURITY_PATTERNS module-level constant
  // ═══════════════════════════════════════════════════════════════════════

  describe('module exports', () => {
    it('exports InputValidator class', () => {
      expect(InputValidator).toBeDefined();
      expect(typeof InputValidator).toBe('function');
    });

    it('exports ValidationError class', () => {
      expect(ValidationError).toBeDefined();
      expect(typeof ValidationError).toBe('function');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // ValidationError
  // ═══════════════════════════════════════════════════════════════════════

  describe('ValidationError', () => {
    it('extends Error', () => {
      const err = new ValidationError('test', 'testRule');
      expect(err).toBeInstanceOf(Error);
    });

    it('sets message from constructor', () => {
      const err = new ValidationError('field is required', 'required');
      expect(err.message).toBe('field is required');
    });

    it('sets name to ValidationError', () => {
      const err = new ValidationError('msg', 'rule');
      expect(err.name).toBe('ValidationError');
    });

    it('sets rule property', () => {
      const err = new ValidationError('msg', 'minLength');
      expect(err.rule).toBe('minLength');
    });

    it('sets isValidationError flag to true', () => {
      const err = new ValidationError('msg', 'rule');
      expect(err.isValidationError).toBe(true);
    });

    it('has a stack trace', () => {
      const err = new ValidationError('msg', 'rule');
      expect(err.stack).toBeDefined();
      expect(typeof err.stack).toBe('string');
      expect(err.stack.length).toBeGreaterThan(0);
    });

    it('preserves rule as undefined when omitted', () => {
      const err = new ValidationError('msg');
      expect(err.rule).toBeUndefined();
    });

    it('can be caught as Error', () => {
      let caught = null;
      try {
        throw new ValidationError('test', 'type');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).toBeInstanceOf(ValidationError);
      expect(caught.rule).toBe('type');
      expect(caught.isValidationError).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Constructor
  // ═══════════════════════════════════════════════════════════════════════

  describe('constructor', () => {
    it('creates instance with default maxStringLength of 8000', () => {
      const v = new InputValidator();
      expect(v.maxStringLength).toBe(8000);
    });

    it('accepts custom maxStringLength', () => {
      const v = new InputValidator({ maxStringLength: 500 });
      expect(v.maxStringLength).toBe(500);
    });

    it('accepts maxStringLength of 1', () => {
      const v = new InputValidator({ maxStringLength: 1 });
      expect(v.maxStringLength).toBe(1);
    });

    it('accepts large maxStringLength', () => {
      const v = new InputValidator({ maxStringLength: 1_000_000 });
      expect(v.maxStringLength).toBe(1_000_000);
    });

    it('uses default when options is empty object', () => {
      const v = new InputValidator({});
      expect(v.maxStringLength).toBe(8000);
    });

    // BUG REGRESSION: maxStringLength: 0 was treated as falsy by || operator (fixed: now uses ??)
    it('respects maxStringLength of 0 (regression: was using || instead of ??)', () => {
      const v = new InputValidator({ maxStringLength: 0 });
      expect(v.maxStringLength).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // validateString — type checking
  // ═══════════════════════════════════════════════════════════════════════

  describe('validateString — type checking', () => {
    let validator;

    beforeEach(() => {
      validator = new InputValidator();
    });

    it('throws ValidationError for number input', () => {
      expect(() => validator.validateString(42)).toThrow(ValidationError);
      expect(() => validator.validateString(42)).toThrow('Value must be a string');
    });

    it('throws with rule "type" for non-string', () => {
      try {
        validator.validateString(42);
        throw new Error('should not reach');
      } catch (e) {
        expect(e.rule).toBe('type');
        expect(e.isValidationError).toBe(true);
      }
    });

    it('throws for null input', () => {
      expect(() => validator.validateString(null)).toThrow(ValidationError);
      expect(() => validator.validateString(null)).toThrow('Value must be a string');
    });

    it('throws for undefined input', () => {
      expect(() => validator.validateString(undefined)).toThrow(ValidationError);
    });

    it('throws for boolean input', () => {
      expect(() => validator.validateString(true)).toThrow(ValidationError);
      expect(() => validator.validateString(false)).toThrow(ValidationError);
    });

    it('throws for object input', () => {
      expect(() => validator.validateString({})).toThrow(ValidationError);
    });

    it('throws for array input', () => {
      expect(() => validator.validateString([])).toThrow(ValidationError);
    });

    it('throws for Symbol input', () => {
      expect(() => validator.validateString(Symbol('test'))).toThrow(ValidationError);
    });

    it('accepts empty string with default constraints', () => {
      expect(validator.validateString('')).toBe(true);
    });

    it('accepts normal string', () => {
      expect(validator.validateString('hello world')).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // validateString — length constraints
  // ═══════════════════════════════════════════════════════════════════════

  describe('validateString — length constraints', () => {
    let validator;

    beforeEach(() => {
      validator = new InputValidator();
    });

    // --- minLength ---

    it('throws when string shorter than minLength', () => {
      expect(() => validator.validateString('ab', { minLength: 3 }))
        .toThrow('String too short (min: 3)');
    });

    it('throws with rule "minLength"', () => {
      try {
        validator.validateString('', { minLength: 1 });
        throw new Error('should not reach');
      } catch (e) {
        expect(e.rule).toBe('minLength');
      }
    });

    it('accepts string at exact minLength', () => {
      expect(validator.validateString('abc', { minLength: 3 })).toBe(true);
    });

    it('accepts string longer than minLength', () => {
      expect(validator.validateString('abcdef', { minLength: 3 })).toBe(true);
    });

    it('minLength 0 allows empty string', () => {
      expect(validator.validateString('', { minLength: 0 })).toBe(true);
    });

    // --- maxLength ---

    it('throws when string longer than maxLength', () => {
      expect(() => validator.validateString('abcdef', { maxLength: 3 }))
        .toThrow('String too long (max: 3)');
    });

    it('throws with rule "maxLength"', () => {
      try {
        validator.validateString('abcdef', { maxLength: 3 });
        throw new Error('should not reach');
      } catch (e) {
        expect(e.rule).toBe('maxLength');
      }
    });

    it('accepts string at exact maxLength', () => {
      expect(validator.validateString('abc', { maxLength: 3 })).toBe(true);
    });

    it('accepts string shorter than maxLength', () => {
      expect(validator.validateString('ab', { maxLength: 3 })).toBe(true);
    });

    it('uses instance maxStringLength as default maxLength', () => {
      const v = new InputValidator({ maxStringLength: 5 });
      expect(v.validateString('abc')).toBe(true);
      expect(() => v.validateString('abcdef')).toThrow('String too long (max: 5)');
    });

    it('constraint maxLength overrides instance maxStringLength', () => {
      const v = new InputValidator({ maxStringLength: 100 });
      expect(() => v.validateString('abcdef', { maxLength: 3 }))
        .toThrow('String too long (max: 3)');
    });

    it('default maxLength is 8000', () => {
      const longString = 'x'.repeat(8001);
      expect(() => validator.validateString(longString))
        .toThrow('String too long (max: 8000)');
    });

    it('accepts string at exactly 8000 characters', () => {
      const exactString = 'x'.repeat(8000);
      expect(validator.validateString(exactString)).toBe(true);
    });

    // --- combined ---

    it('validates minLength before maxLength (minLength checked first)', () => {
      // String of length 2, min is 5, max is 3 (contradictory constraints)
      // minLength is checked first -> should throw minLength error
      expect(() => validator.validateString('ab', { minLength: 5, maxLength: 3 }))
        .toThrow('String too short (min: 5)');
    });

    // BUG REGRESSION: maxLength: 0 was treated as falsy by || operator (fixed: now uses ??)
    it('maxLength 0 rejects any non-empty string (regression: was using || instead of ??)', () => {
      const v = new InputValidator({ maxStringLength: 10 });
      // maxLength: 0 -> only empty string passes
      expect(() => v.validateString('a', { maxLength: 0 }))
        .toThrow('String too long (max: 0)');
      expect(v.validateString('', { maxLength: 0 })).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // validateString — SQL injection detection
  // ═══════════════════════════════════════════════════════════════════════

  describe('validateString — SQL injection detection', () => {
    let validator;

    beforeEach(() => {
      validator = new InputValidator();
    });

    it('does not check SQL injection when noSqlInjection is not set', () => {
      // SQL keywords allowed when constraint not activated
      expect(validator.validateString('SELECT * FROM users')).toBe(true);
    });

    it('detects SELECT keyword', () => {
      expect(() => validator.validateString('SELECT * FROM users', { noSqlInjection: true }))
        .toThrow('Potential SQL injection detected');
    });

    it('throws with rule "security" for SQL injection', () => {
      try {
        validator.validateString('DROP TABLE users', { noSqlInjection: true });
        throw new Error('should not reach');
      } catch (e) {
        expect(e.rule).toBe('security');
      }
    });

    it('detects INSERT keyword', () => {
      expect(() => validator.validateString('INSERT INTO table', { noSqlInjection: true }))
        .toThrow('Potential SQL injection detected');
    });

    it('detects UPDATE keyword', () => {
      expect(() => validator.validateString('UPDATE users SET', { noSqlInjection: true }))
        .toThrow('Potential SQL injection detected');
    });

    it('detects DELETE keyword', () => {
      expect(() => validator.validateString('DELETE FROM users', { noSqlInjection: true }))
        .toThrow('Potential SQL injection detected');
    });

    it('detects DROP keyword', () => {
      expect(() => validator.validateString('DROP TABLE users', { noSqlInjection: true }))
        .toThrow('Potential SQL injection detected');
    });

    it('detects CREATE keyword', () => {
      expect(() => validator.validateString('CREATE TABLE test', { noSqlInjection: true }))
        .toThrow('Potential SQL injection detected');
    });

    it('detects ALTER keyword', () => {
      expect(() => validator.validateString('ALTER TABLE test', { noSqlInjection: true }))
        .toThrow('Potential SQL injection detected');
    });

    it('detects EXEC keyword', () => {
      expect(() => validator.validateString('EXEC sp_executesql', { noSqlInjection: true }))
        .toThrow('Potential SQL injection detected');
    });

    it('detects EXECUTE keyword', () => {
      expect(() => validator.validateString('EXECUTE procedure', { noSqlInjection: true }))
        .toThrow('Potential SQL injection detected');
    });

    it('detects UNION keyword', () => {
      expect(() => validator.validateString('UNION ALL SELECT', { noSqlInjection: true }))
        .toThrow('Potential SQL injection detected');
    });

    it('detects DECLARE keyword', () => {
      expect(() => validator.validateString('DECLARE @var INT', { noSqlInjection: true }))
        .toThrow('Potential SQL injection detected');
    });

    it('detects SQL keywords case-insensitively', () => {
      expect(() => validator.validateString('select * from users', { noSqlInjection: true }))
        .toThrow('Potential SQL injection detected');
      expect(() => validator.validateString('SeLeCt * from users', { noSqlInjection: true }))
        .toThrow('Potential SQL injection detected');
    });

    it('detects SQL comment --', () => {
      expect(() => validator.validateString('admin-- comment', { noSqlInjection: true }))
        .toThrow('Potential SQL injection detected');
    });

    it('detects SQL block comment open /*', () => {
      expect(() => validator.validateString('value /* comment', { noSqlInjection: true }))
        .toThrow('Potential SQL injection detected');
    });

    it('detects SQL block comment close */', () => {
      expect(() => validator.validateString('comment */ value', { noSqlInjection: true }))
        .toThrow('Potential SQL injection detected');
    });

    it('detects semicolons (statement terminator)', () => {
      expect(() => validator.validateString('value; DROP TABLE', { noSqlInjection: true }))
        .toThrow('Potential SQL injection detected');
    });

    it('detects single quotes', () => {
      expect(() => validator.validateString("admin' OR '1'='1", { noSqlInjection: true }))
        .toThrow('Potential SQL injection detected');
    });

    it('detects double quotes', () => {
      expect(() => validator.validateString('admin" OR "1"="1', { noSqlInjection: true }))
        .toThrow('Potential SQL injection detected');
    });

    it('allows safe text when noSqlInjection is enabled', () => {
      expect(validator.validateString('hello world 123', { noSqlInjection: true })).toBe(true);
      expect(validator.validateString('my name is John', { noSqlInjection: true })).toBe(true);
      expect(validator.validateString('price is 42.50 dollars', { noSqlInjection: true })).toBe(true);
    });

    // Regex statefulness: ensure lastIndex reset works across consecutive calls
    it('handles consecutive calls correctly (lastIndex reset)', () => {
      // First call should detect
      expect(() => validator.validateString('SELECT x', { noSqlInjection: true }))
        .toThrow('Potential SQL injection detected');
      // Second call should also detect (lastIndex must be reset)
      expect(() => validator.validateString('SELECT y', { noSqlInjection: true }))
        .toThrow('Potential SQL injection detected');
      // Safe call should pass
      expect(validator.validateString('safe text', { noSqlInjection: true })).toBe(true);
      // Third detection should work
      expect(() => validator.validateString('DROP z', { noSqlInjection: true }))
        .toThrow('Potential SQL injection detected');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // validateString — Command injection detection
  // ═══════════════════════════════════════════════════════════════════════

  describe('validateString — command injection detection', () => {
    let validator;

    beforeEach(() => {
      validator = new InputValidator();
    });

    it('does not check command injection when noCommandInjection not set', () => {
      expect(validator.validateString('$(whoami)')).toBe(true);
    });

    it('detects $() subshell', () => {
      expect(() => validator.validateString('$(whoami)', { noCommandInjection: true }))
        .toThrow('Potential command injection detected');
    });

    it('throws with rule "security" for command injection', () => {
      try {
        validator.validateString('$(id)', { noCommandInjection: true });
        throw new Error('should not reach');
      } catch (e) {
        expect(e.rule).toBe('security');
      }
    });

    it('detects ${} variable expansion', () => {
      expect(() => validator.validateString('${PATH}', { noCommandInjection: true }))
        .toThrow('Potential command injection detected');
    });

    it('detects || pipe operator', () => {
      expect(() => validator.validateString('cmd || whoami', { noCommandInjection: true }))
        .toThrow('Potential command injection detected');
    });

    it('detects && chained commands', () => {
      expect(() => validator.validateString('cmd && rm -rf', { noCommandInjection: true }))
        .toThrow('Potential command injection detected');
    });

    it('detects ; command separator', () => {
      expect(() => validator.validateString('cmd; cat /etc/passwd', { noCommandInjection: true }))
        .toThrow('Potential command injection detected');
    });

    it('detects backtick execution', () => {
      expect(() => validator.validateString('`whoami`', { noCommandInjection: true }))
        .toThrow('Potential command injection detected');
    });

    it('allows safe text when noCommandInjection is enabled', () => {
      expect(validator.validateString('hello world', { noCommandInjection: true })).toBe(true);
      expect(validator.validateString('path/to/file', { noCommandInjection: true })).toBe(true);
    });

    it('handles consecutive calls correctly (lastIndex reset)', () => {
      expect(() => validator.validateString('$(cmd)', { noCommandInjection: true }))
        .toThrow('Potential command injection detected');
      expect(() => validator.validateString('$(cmd2)', { noCommandInjection: true }))
        .toThrow('Potential command injection detected');
      expect(validator.validateString('safe text', { noCommandInjection: true })).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // validateString — XSS detection
  // ═══════════════════════════════════════════════════════════════════════

  describe('validateString — XSS detection', () => {
    let validator;

    beforeEach(() => {
      validator = new InputValidator();
    });

    it('does not check XSS when noXss not set', () => {
      expect(validator.validateString('<script>alert(1)</script>')).toBe(true);
    });

    it('detects <script tag', () => {
      expect(() => validator.validateString('<script>alert(1)</script>', { noXss: true }))
        .toThrow('Potential XSS pattern detected');
    });

    it('throws with rule "security" for XSS', () => {
      try {
        validator.validateString('<script>x</script>', { noXss: true });
        throw new Error('should not reach');
      } catch (e) {
        expect(e.rule).toBe('security');
      }
    });

    it('detects javascript: protocol', () => {
      expect(() => validator.validateString('javascript:alert(1)', { noXss: true }))
        .toThrow('Potential XSS pattern detected');
    });

    it('detects onerror= attribute', () => {
      expect(() => validator.validateString('<img onerror=alert(1)>', { noXss: true }))
        .toThrow('Potential XSS pattern detected');
    });

    it('detects onload= attribute', () => {
      expect(() => validator.validateString('<body onload=alert(1)>', { noXss: true }))
        .toThrow('Potential XSS pattern detected');
    });

    it('detects <iframe tag', () => {
      expect(() => validator.validateString('<iframe src="evil.com">', { noXss: true }))
        .toThrow('Potential XSS pattern detected');
    });

    it('detects eval( call', () => {
      expect(() => validator.validateString('eval(code)', { noXss: true }))
        .toThrow('Potential XSS pattern detected');
    });

    it('detects expression( in CSS', () => {
      expect(() => validator.validateString('expression(alert(1))', { noXss: true }))
        .toThrow('Potential XSS pattern detected');
    });

    it('detects case-insensitive XSS patterns', () => {
      expect(() => validator.validateString('<SCRIPT>alert(1)</SCRIPT>', { noXss: true }))
        .toThrow('Potential XSS pattern detected');
      expect(() => validator.validateString('JAVASCRIPT:void(0)', { noXss: true }))
        .toThrow('Potential XSS pattern detected');
      expect(() => validator.validateString('<IFRAME src="x">', { noXss: true }))
        .toThrow('Potential XSS pattern detected');
    });

    it('allows safe text when noXss is enabled', () => {
      expect(validator.validateString('hello world', { noXss: true })).toBe(true);
      expect(validator.validateString('plain text with numbers 123', { noXss: true })).toBe(true);
    });

    it('handles consecutive calls correctly (lastIndex reset)', () => {
      expect(() => validator.validateString('<script>x', { noXss: true }))
        .toThrow('Potential XSS pattern detected');
      expect(() => validator.validateString('<script>y', { noXss: true }))
        .toThrow('Potential XSS pattern detected');
      expect(validator.validateString('safe', { noXss: true })).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // validateString — all constraints combined
  // ═══════════════════════════════════════════════════════════════════════

  describe('validateString — combined constraints', () => {
    let validator;

    beforeEach(() => {
      validator = new InputValidator();
    });

    it('validates all constraints together on safe input', () => {
      const result = validator.validateString('safe input text', {
        minLength: 1,
        maxLength: 100,
        noSqlInjection: true,
        noCommandInjection: true,
        noXss: true,
      });
      expect(result).toBe(true);
    });

    it('checks type before length', () => {
      // Should throw type error, not length error
      expect(() => validator.validateString(42, { minLength: 100 }))
        .toThrow('Value must be a string');
    });

    it('checks minLength before security patterns', () => {
      // Empty string with minLength:1 should throw minLength, not SQL
      expect(() => validator.validateString('', { minLength: 1, noSqlInjection: true }))
        .toThrow('String too short');
    });

    it('checks maxLength before security patterns', () => {
      // Long string should throw maxLength even if it contains SQL
      const longSqlString = 'SELECT '.repeat(2000);
      expect(() => validator.validateString(longSqlString, { maxLength: 10, noSqlInjection: true }))
        .toThrow('String too long');
    });

    it('SQL injection checked before command injection and XSS', () => {
      // String with both SQL and command injection patterns
      // SQL check comes first in code (line 49 vs 56 vs 63)
      expect(() => validator.validateString("'; $(cmd)", {
        noSqlInjection: true,
        noCommandInjection: true,
        noXss: true,
      })).toThrow('Potential SQL injection detected');
    });

    it('returns true (not truthy) on success', () => {
      const result = validator.validateString('valid', {
        minLength: 1,
        maxLength: 100,
        noSqlInjection: true,
        noCommandInjection: true,
        noXss: true,
      });
      expect(result).toBe(true);
      expect(result).not.toBe(1);
      expect(result).not.toBe('true');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // validateString — constraints edge cases
  // ═══════════════════════════════════════════════════════════════════════

  describe('validateString — constraints edge cases', () => {
    let validator;

    beforeEach(() => {
      validator = new InputValidator();
    });

    it('accepts empty constraints object', () => {
      expect(validator.validateString('hello', {})).toBe(true);
    });

    it('accepts undefined constraints (uses defaults)', () => {
      expect(validator.validateString('hello', undefined)).toBe(true);
    });

    it('accepts omitted constraints (uses defaults)', () => {
      expect(validator.validateString('hello')).toBe(true);
    });

    // BUG REGRESSION: null constraints crashed (fixed: now uses ?? guard)
    it('handles null constraints gracefully (regression: was throwing TypeError)', () => {
      expect(validator.validateString('hello', null)).toBe(true);
    });

    it('ignores unknown constraint properties', () => {
      expect(validator.validateString('hello', { customProp: true })).toBe(true);
    });

    it('treats noSqlInjection: false as not checking SQL', () => {
      expect(validator.validateString('SELECT * FROM users', { noSqlInjection: false }))
        .toBe(true);
    });

    it('treats noCommandInjection: false as not checking commands', () => {
      expect(validator.validateString('$(whoami)', { noCommandInjection: false }))
        .toBe(true);
    });

    it('treats noXss: false as not checking XSS', () => {
      expect(validator.validateString('<script>x</script>', { noXss: false }))
        .toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Adversarial security payloads — SQL injection
  // ═══════════════════════════════════════════════════════════════════════

  describe('adversarial SQL injection payloads', () => {
    let validator;

    beforeEach(() => {
      validator = new InputValidator();
    });

    const sqlPayloads = [
      { name: 'classic OR bypass', input: "' OR '1'='1" },
      { name: 'union select', input: "1 UNION SELECT username, password FROM users" },
      { name: 'comment bypass', input: "admin'--" },
      { name: 'stacked query', input: "1; DROP TABLE users" },
      { name: 'block comment injection', input: "1 /* malicious */ UNION SELECT 1" },
      { name: 'declare variable', input: "DECLARE @cmd NVARCHAR(100)" },
      { name: 'exec xp_cmdshell', input: "EXEC xp_cmdshell 'dir'" },
      { name: 'alter table', input: "ALTER TABLE users ADD admin BOOLEAN" },
      { name: 'create table', input: "CREATE TABLE exfil (data TEXT)" },
      { name: 'double quote escape', input: 'admin" OR "1"="1' },
    ];

    for (const { name, input } of sqlPayloads) {
      it(`blocks: ${name}`, () => {
        expect(() => validator.validateString(input, { noSqlInjection: true }))
          .toThrow('Potential SQL injection detected');
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Adversarial security payloads — command injection
  // ═══════════════════════════════════════════════════════════════════════

  describe('adversarial command injection payloads', () => {
    let validator;

    beforeEach(() => {
      validator = new InputValidator();
    });

    const cmdPayloads = [
      { name: 'subshell whoami', input: '$(whoami)' },
      { name: 'subshell cat passwd', input: '$(cat /etc/passwd)' },
      { name: 'variable expansion', input: '${HOME}' },
      { name: 'backtick execution', input: '`id`' },
      { name: 'or operator', input: 'false || cat /etc/passwd' },
      { name: 'and operator', input: 'true && rm -rf /' },
      { name: 'semicolon chaining', input: 'echo hello; rm -rf /' },
      { name: 'nested subshell', input: '$($(whoami))' },
      { name: 'variable in path', input: '/tmp/${USER}/exploit' },
    ];

    for (const { name, input } of cmdPayloads) {
      it(`blocks: ${name}`, () => {
        expect(() => validator.validateString(input, { noCommandInjection: true }))
          .toThrow('Potential command injection detected');
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Adversarial security payloads — XSS
  // ═══════════════════════════════════════════════════════════════════════

  describe('adversarial XSS payloads', () => {
    let validator;

    beforeEach(() => {
      validator = new InputValidator();
    });

    const xssPayloads = [
      { name: 'script tag', input: '<script>alert("xss")</script>' },
      { name: 'img onerror', input: '<img src=x onerror=alert(1)>' },
      { name: 'iframe injection', input: '<iframe src="javascript:alert(1)"></iframe>' },
      { name: 'javascript URI', input: 'javascript:alert(document.cookie)' },
      { name: 'body onload', input: '<body onload=alert(1)>' },
      { name: 'eval execution', input: 'eval("alert(1)")' },
      { name: 'CSS expression', input: 'expression(alert(1))' },
      { name: 'mixed case script', input: '<ScRiPt>alert(1)</ScRiPt>' },
      { name: 'mixed case javascript', input: 'JaVaScRiPt:alert(1)' },
      { name: 'img onload', input: '<img src=valid onload=alert(1)>' },
    ];

    for (const { name, input } of xssPayloads) {
      it(`blocks: ${name}`, () => {
        expect(() => validator.validateString(input, { noXss: true }))
          .toThrow('Potential XSS pattern detected');
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Regex statefulness — critical security test
  // ═══════════════════════════════════════════════════════════════════════

  describe('regex lastIndex statefulness', () => {
    let validator;

    beforeEach(() => {
      validator = new InputValidator();
    });

    it('SQL regex works correctly across many sequential calls', () => {
      for (let i = 0; i < 20; i++) {
        expect(() => validator.validateString('SELECT x', { noSqlInjection: true }))
          .toThrow('Potential SQL injection detected');
      }
    });

    it('command regex works correctly across many sequential calls', () => {
      for (let i = 0; i < 20; i++) {
        expect(() => validator.validateString('$(cmd)', { noCommandInjection: true }))
          .toThrow('Potential command injection detected');
      }
    });

    it('XSS regex works correctly across many sequential calls', () => {
      for (let i = 0; i < 20; i++) {
        expect(() => validator.validateString('<script>x', { noXss: true }))
          .toThrow('Potential XSS pattern detected');
      }
    });

    it('interleaved safe and unsafe calls work correctly', () => {
      for (let i = 0; i < 10; i++) {
        expect(validator.validateString('safe text', { noSqlInjection: true })).toBe(true);
        expect(() => validator.validateString('SELECT x', { noSqlInjection: true }))
          .toThrow('Potential SQL injection detected');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Multiple validators — instance isolation
  // ═══════════════════════════════════════════════════════════════════════

  describe('instance isolation', () => {
    it('different instances have independent maxStringLength', () => {
      const v1 = new InputValidator({ maxStringLength: 10 });
      const v2 = new InputValidator({ maxStringLength: 1000 });

      expect(v1.maxStringLength).toBe(10);
      expect(v2.maxStringLength).toBe(1000);

      expect(() => v1.validateString('x'.repeat(11))).toThrow('String too long (max: 10)');
      expect(v2.validateString('x'.repeat(11))).toBe(true);
    });

    it('using one validator does not affect another', () => {
      const v1 = new InputValidator();
      const v2 = new InputValidator();

      // Use v1 with SQL detection
      expect(() => v1.validateString('SELECT x', { noSqlInjection: true }))
        .toThrow('Potential SQL injection detected');

      // v2 should work independently
      expect(() => v2.validateString('SELECT y', { noSqlInjection: true }))
        .toThrow('Potential SQL injection detected');
    });
  });
});
