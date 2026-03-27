'use strict';

const { CodeExecutionValidator, ValidationError, EXECUTION_LIMITS } = require('../../../../../src/domain/artifacts/validators/CodeExecutionValidator');

describe('CodeExecutionValidator', () => {
  describe('validate() - happy path', () => {
    it('should accept valid JS code', () => {
      const result = CodeExecutionValidator.validate('const x = 1;', 'javascript');
      expect(result.valid).toBe(true);
      expect(result.language).toBe('javascript');
      expect(result.codeLength).toBe(12);
      expect(result.lineCount).toBe(1);
      expect(result.warnings).toEqual([]);
    });

    it('should accept "js" as language', () => {
      const result = CodeExecutionValidator.validate('let x = 1;', 'js');
      expect(result.valid).toBe(true);
    });
  });

  describe('validate() - required params', () => {
    it('should reject null code', () => {
      expect(() => CodeExecutionValidator.validate(null, 'js')).toThrow(ValidationError);
    });

    it('should reject non-string code', () => {
      expect(() => CodeExecutionValidator.validate(123, 'js')).toThrow(ValidationError);
    });

    it('should reject missing language', () => {
      expect(() => CodeExecutionValidator.validate('x=1', null)).toThrow(ValidationError);
    });
  });

  describe('Language validation', () => {
    it('should reject unsupported languages', () => {
      expect(() => CodeExecutionValidator.validate('print(1)', 'python')).toThrow(ValidationError);
      expect(() => CodeExecutionValidator.validate('puts 1', 'ruby')).toThrow(ValidationError);
    });

    it('should be case insensitive', () => {
      expect(() => CodeExecutionValidator.validate('x=1', 'JavaScript')).not.toThrow();
      expect(() => CodeExecutionValidator.validate('x=1', 'JS')).not.toThrow();
    });
  });

  describe('Length validation', () => {
    it('should reject empty code', () => {
      expect(() => CodeExecutionValidator.validate('', 'js')).toThrow(ValidationError);
    });

    it('should reject oversized code', () => {
      const big = 'x'.repeat(EXECUTION_LIMITS.MAX_CODE_LENGTH + 1);
      expect(() => CodeExecutionValidator.validate(big, 'js')).toThrow(ValidationError);
    });

    it('should reject too many lines', () => {
      const lines = Array(EXECUTION_LIMITS.MAX_LINE_COUNT + 2).fill('x=1').join('\n');
      expect(() => CodeExecutionValidator.validate(lines, 'js')).toThrow(ValidationError);
    });
  });

  describe('Security patterns', () => {
    it('should block while(true)', () => {
      expect(() => CodeExecutionValidator.validate('while(true) {}', 'js'))
        .toThrow(ValidationError);
      expect(() => CodeExecutionValidator.validate('while( true ) { x++; }', 'js'))
        .toThrow(ValidationError);
    });

    it('should block for(;;)', () => {
      expect(() => CodeExecutionValidator.validate('for(;;) { break; }', 'js'))
        .toThrow(ValidationError);
    });

    it('should block large array allocation', () => {
      expect(() => CodeExecutionValidator.validate('new Array(99999999)', 'js'))
        .toThrow(ValidationError);
    });

    it('should block document access', () => {
      expect(() => CodeExecutionValidator.validate('document.getElementById("x")', 'js'))
        .toThrow(ValidationError);
    });

    it('should block window manipulation', () => {
      expect(() => CodeExecutionValidator.validate('window.location = "http://evil.com"', 'js'))
        .toThrow(ValidationError);
    });

    it('should block fetch', () => {
      expect(() => CodeExecutionValidator.validate('fetch("http://evil.com")', 'js'))
        .toThrow(ValidationError);
    });

    it('should block XMLHttpRequest', () => {
      expect(() => CodeExecutionValidator.validate('new XMLHttpRequest()', 'js'))
        .toThrow(ValidationError);
    });

    it('should block WebSocket', () => {
      expect(() => CodeExecutionValidator.validate('new WebSocket("ws://evil")', 'js'))
        .toThrow(ValidationError);
    });

    it('should block require("fs")', () => {
      expect(() => CodeExecutionValidator.validate('require("fs")', 'js'))
        .toThrow(ValidationError);
    });

    it('should block require("child_process")', () => {
      expect(() => CodeExecutionValidator.validate('require("child_process")', 'js'))
        .toThrow(ValidationError);
    });

    it('should block eval', () => {
      expect(() => CodeExecutionValidator.validate('eval("alert(1)")', 'js'))
        .toThrow(ValidationError);
    });

    it('should block Function constructor', () => {
      expect(() => CodeExecutionValidator.validate('new Function("return 1")', 'js'))
        .toThrow(ValidationError);
    });

    it('should block __proto__ pollution', () => {
      expect(() => CodeExecutionValidator.validate('obj.__proto__.isAdmin = true', 'js'))
        .toThrow(ValidationError);
    });

    it('should allow safe code', () => {
      const safeCodes = [
        'const x = 1 + 2;',
        'function add(a, b) { return a + b; }',
        'console.log("hello");',
        '[1, 2, 3].map(x => x * 2);',
        'JSON.stringify({ a: 1 });',
        'Math.max(1, 2, 3);'
      ];
      safeCodes.forEach(code => {
        expect(() => CodeExecutionValidator.validate(code, 'js')).not.toThrow();
      });
    });
  });

  describe('ValidationError structure', () => {
    it('should include security details', () => {
      try {
        CodeExecutionValidator.validate('while(true) {}', 'js');
      } catch (e) {
        expect(e).toBeInstanceOf(ValidationError);
        expect(e.field).toBe('code');
        expect(e.rule).toBe('security');
        expect(e.details.pattern).toBeDefined();
        expect(e.details.violation).toBeDefined();
        expect(e.details.line).toBeDefined();
      }
    });
  });

  describe('EXECUTION_LIMITS', () => {
    it('should expose constants', () => {
      expect(EXECUTION_LIMITS.MAX_CODE_LENGTH).toBe(50000);
      expect(EXECUTION_LIMITS.MAX_LINE_COUNT).toBe(1000);
      expect(EXECUTION_LIMITS.SUPPORTED_LANGUAGES).toContain('javascript');
    });
  });

  describe('Utility methods', () => {
    it('should return limits', () => {
      const limits = CodeExecutionValidator.getLimits();
      expect(limits.MAX_CODE_LENGTH).toBe(50000);
    });

    it('should return dangerous pattern names', () => {
      const patterns = CodeExecutionValidator.getDangerousPatterns();
      expect(patterns).toContain('INFINITE_WHILE');
      expect(patterns).toContain('EVAL_USAGE');
      expect(patterns).toContain('PROTO_POLLUTION');
    });
  });
});
