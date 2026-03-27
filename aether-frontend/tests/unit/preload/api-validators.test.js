'use strict';

// Mock the logger — api-validators imports createLogger from core/utils/logger
jest.mock('../../../src/core/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

const { validators, createValidator, validateSchema } = require('../../../src/preload/common/api-validators');

// ============================================================================
// validators.string()
// ============================================================================
describe('validators.string()', () => {
  it('should accept a string value', () => {
    expect(() => validators.string('hello')).not.toThrow();
    expect(() => validators.string('')).not.toThrow();
  });

  it('should reject non-string types with TypeError', () => {
    expect(() => validators.string(42)).toThrow(TypeError);
    expect(() => validators.string(42, 'age')).toThrow('age must be a string, got number');
  });

  it('should reject null, undefined, boolean, object, array', () => {
    expect(() => validators.string(null)).toThrow(TypeError);
    expect(() => validators.string(undefined)).toThrow(TypeError);
    expect(() => validators.string(true)).toThrow(TypeError);
    expect(() => validators.string({})).toThrow(TypeError);
    expect(() => validators.string([])).toThrow(TypeError);
  });

  it('should use default fieldName in error message', () => {
    expect(() => validators.string(123)).toThrow('value must be a string, got number');
  });
});

// ============================================================================
// validators.number()
// ============================================================================
describe('validators.number()', () => {
  it('should accept finite numbers', () => {
    expect(() => validators.number(0)).not.toThrow();
    expect(() => validators.number(-1)).not.toThrow();
    expect(() => validators.number(3.14)).not.toThrow();
    expect(() => validators.number(Number.MAX_SAFE_INTEGER)).not.toThrow();
  });

  it('should reject NaN', () => {
    expect(() => validators.number(NaN, 'score')).toThrow('score must be a finite number');
  });

  it('should reject Infinity and -Infinity', () => {
    expect(() => validators.number(Infinity)).toThrow(TypeError);
    expect(() => validators.number(-Infinity)).toThrow(TypeError);
  });

  it('should reject non-number types', () => {
    expect(() => validators.number('42')).toThrow(TypeError);
    expect(() => validators.number(null)).toThrow(TypeError);
    expect(() => validators.number(undefined)).toThrow(TypeError);
    expect(() => validators.number(true)).toThrow(TypeError);
    expect(() => validators.number({})).toThrow(TypeError);
  });

  it('should use default fieldName in error message', () => {
    expect(() => validators.number('x')).toThrow('value must be a finite number, got string');
  });
});

// ============================================================================
// validators.boolean()
// ============================================================================
describe('validators.boolean()', () => {
  it('should accept true and false', () => {
    expect(() => validators.boolean(true)).not.toThrow();
    expect(() => validators.boolean(false)).not.toThrow();
  });

  it('should reject non-boolean types', () => {
    expect(() => validators.boolean(0)).toThrow(TypeError);
    expect(() => validators.boolean(1)).toThrow(TypeError);
    expect(() => validators.boolean('true')).toThrow(TypeError);
    expect(() => validators.boolean(null)).toThrow(TypeError);
    expect(() => validators.boolean(undefined)).toThrow(TypeError);
  });

  it('should include fieldName in error', () => {
    expect(() => validators.boolean(0, 'flag')).toThrow('flag must be a boolean, got number');
  });
});

// ============================================================================
// validators.function()
// ============================================================================
describe('validators.function()', () => {
  it('should accept functions', () => {
    expect(() => validators.function(() => {})).not.toThrow();
    expect(() => validators.function(function named() {})).not.toThrow();
    expect(() => validators.function(Math.max)).not.toThrow();
  });

  it('should reject non-function types', () => {
    expect(() => validators.function('fn')).toThrow(TypeError);
    expect(() => validators.function(null)).toThrow(TypeError);
    expect(() => validators.function({})).toThrow(TypeError);
    expect(() => validators.function(42)).toThrow(TypeError);
  });

  it('should include fieldName in error', () => {
    expect(() => validators.function(null, 'callback')).toThrow('callback must be a function, got object');
  });
});

// ============================================================================
// validators.object()
// ============================================================================
describe('validators.object()', () => {
  it('should accept plain objects', () => {
    expect(() => validators.object({})).not.toThrow();
    expect(() => validators.object({ key: 'value' })).not.toThrow();
  });

  it('should reject null (typeof null === "object")', () => {
    expect(() => validators.object(null)).toThrow(TypeError);
  });

  it('should reject arrays', () => {
    expect(() => validators.object([])).toThrow(TypeError);
    expect(() => validators.object([1, 2])).toThrow(TypeError);
  });

  it('should reject primitives', () => {
    expect(() => validators.object('str')).toThrow(TypeError);
    expect(() => validators.object(42)).toThrow(TypeError);
    expect(() => validators.object(true)).toThrow(TypeError);
    expect(() => validators.object(undefined)).toThrow(TypeError);
  });

  it('should include fieldName in error', () => {
    expect(() => validators.object(null, 'config')).toThrow('config must be an object');
  });
});

// ============================================================================
// validators.array()
// ============================================================================
describe('validators.array()', () => {
  it('should accept arrays', () => {
    expect(() => validators.array([])).not.toThrow();
    expect(() => validators.array([1, 'two', null])).not.toThrow();
  });

  it('should reject non-array types', () => {
    expect(() => validators.array({})).toThrow(TypeError);
    expect(() => validators.array('abc')).toThrow(TypeError);
    expect(() => validators.array(42)).toThrow(TypeError);
    expect(() => validators.array(null)).toThrow(TypeError);
    expect(() => validators.array(undefined)).toThrow(TypeError);
  });

  it('should include fieldName in error', () => {
    expect(() => validators.array('x', 'items')).toThrow('items must be an array, got string');
  });
});

// ============================================================================
// validators.enum()
// ============================================================================
describe('validators.enum()', () => {
  it('should accept values in the allowed list', () => {
    expect(() => validators.enum('a', ['a', 'b', 'c'])).not.toThrow();
    expect(() => validators.enum(1, [1, 2, 3])).not.toThrow();
  });

  it('should reject values not in the allowed list', () => {
    expect(() => validators.enum('d', ['a', 'b', 'c'])).toThrow(Error);
    expect(() => validators.enum('d', ['a', 'b', 'c'], 'mode'))
      .toThrow('mode must be one of [a, b, c], got "d"');
  });

  it('should use default fieldName', () => {
    expect(() => validators.enum('x', ['y']))
      .toThrow('value must be one of [y], got "x"');
  });
});

// ============================================================================
// validators.optional()
// ============================================================================
describe('validators.optional()', () => {
  it('should skip validation if value is undefined', () => {
    const spy = jest.fn();
    validators.optional(undefined, spy);
    expect(spy).not.toHaveBeenCalled();
  });

  it('should invoke validator if value is defined', () => {
    const spy = jest.fn();
    validators.optional('hello', spy, 'name');
    expect(spy).toHaveBeenCalledWith('hello', 'name');
  });

  it('should invoke validator for null (null !== undefined)', () => {
    const spy = jest.fn();
    validators.optional(null, spy);
    expect(spy).toHaveBeenCalledWith(null);
  });

  it('should invoke validator for falsy non-undefined values', () => {
    const spy = jest.fn();
    validators.optional(0, spy);
    expect(spy).toHaveBeenCalledWith(0);
    validators.optional('', spy);
    expect(spy).toHaveBeenCalledWith('');
    validators.optional(false, spy);
    expect(spy).toHaveBeenCalledWith(false);
  });
});

// ============================================================================
// validators.nonEmptyString()
// ============================================================================
describe('validators.nonEmptyString()', () => {
  it('should accept non-empty strings', () => {
    expect(() => validators.nonEmptyString('hello')).not.toThrow();
    expect(() => validators.nonEmptyString(' ')).not.toThrow(); // whitespace is non-empty
  });

  it('should reject empty string', () => {
    expect(() => validators.nonEmptyString('')).toThrow('must not be empty');
  });

  it('should reject non-string types (delegates to string validator)', () => {
    expect(() => validators.nonEmptyString(42)).toThrow(TypeError);
    expect(() => validators.nonEmptyString(null)).toThrow(TypeError);
  });

  it('should include fieldName', () => {
    expect(() => validators.nonEmptyString('', 'title')).toThrow('title must not be empty');
  });
});

// ============================================================================
// validators.positiveNumber()
// ============================================================================
describe('validators.positiveNumber()', () => {
  it('should accept positive numbers', () => {
    expect(() => validators.positiveNumber(1)).not.toThrow();
    expect(() => validators.positiveNumber(0.001)).not.toThrow();
    expect(() => validators.positiveNumber(Number.MAX_SAFE_INTEGER)).not.toThrow();
  });

  it('should reject zero', () => {
    expect(() => validators.positiveNumber(0)).toThrow('must be positive, got 0');
  });

  it('should reject negative numbers', () => {
    expect(() => validators.positiveNumber(-1)).toThrow('must be positive');
  });

  it('should reject non-numbers (delegates to number validator)', () => {
    expect(() => validators.positiveNumber('5')).toThrow(TypeError);
    expect(() => validators.positiveNumber(NaN)).toThrow(TypeError);
  });

  it('should include fieldName', () => {
    expect(() => validators.positiveNumber(-3, 'count')).toThrow('count must be positive, got -3');
  });
});

// ============================================================================
// validators.numberInRange()
// ============================================================================
describe('validators.numberInRange()', () => {
  it('should accept numbers within range (inclusive)', () => {
    expect(() => validators.numberInRange(5, 1, 10)).not.toThrow();
    expect(() => validators.numberInRange(1, 1, 10)).not.toThrow(); // min boundary
    expect(() => validators.numberInRange(10, 1, 10)).not.toThrow(); // max boundary
  });

  it('should reject numbers below range', () => {
    expect(() => validators.numberInRange(0, 1, 10)).toThrow('must be between 1 and 10, got 0');
  });

  it('should reject numbers above range', () => {
    expect(() => validators.numberInRange(11, 1, 10)).toThrow('must be between 1 and 10, got 11');
  });

  it('should reject non-numbers (delegates to number validator)', () => {
    expect(() => validators.numberInRange('5', 1, 10)).toThrow(TypeError);
  });

  it('should include fieldName', () => {
    expect(() => validators.numberInRange(0, 1, 10, 'port'))
      .toThrow('port must be between 1 and 10, got 0');
  });
});

// ============================================================================
// validators.url()
// ============================================================================
describe('validators.url()', () => {
  it('should accept valid URLs', () => {
    expect(() => validators.url('http://localhost:8080')).not.toThrow();
    expect(() => validators.url('https://example.com/path?q=1')).not.toThrow();
    expect(() => validators.url('ftp://files.example.com')).not.toThrow(); // URL() accepts ftp
  });

  it('should reject empty string', () => {
    expect(() => validators.url('')).toThrow('must not be empty');
  });

  it('should reject non-string', () => {
    expect(() => validators.url(42)).toThrow(TypeError);
    expect(() => validators.url(null)).toThrow(TypeError);
  });

  it('should reject invalid URL format', () => {
    expect(() => validators.url('not-a-url')).toThrow('must be a valid URL');
    expect(() => validators.url('://missing-scheme')).toThrow('must be a valid URL');
  });

  it('should include fieldName', () => {
    expect(() => validators.url('bad', 'endpoint')).toThrow('endpoint must be a valid URL');
  });
});

// ============================================================================
// validators.uuid()
// ============================================================================
describe('validators.uuid()', () => {
  it('should accept valid UUIDs (lowercase)', () => {
    expect(() => validators.uuid('550e8400-e29b-41d4-a716-446655440000')).not.toThrow();
  });

  it('should accept valid UUIDs (uppercase)', () => {
    expect(() => validators.uuid('550E8400-E29B-41D4-A716-446655440000')).not.toThrow();
  });

  it('should accept valid UUIDs (mixed case)', () => {
    expect(() => validators.uuid('550e8400-E29B-41d4-A716-446655440000')).not.toThrow();
  });

  it('should reject invalid UUID format', () => {
    expect(() => validators.uuid('not-a-uuid')).toThrow('must be a valid UUID');
    expect(() => validators.uuid('550e8400e29b41d4a716446655440000')).toThrow('must be a valid UUID'); // no hyphens
    expect(() => validators.uuid('550e8400-e29b-41d4-a716')).toThrow('must be a valid UUID'); // too short
    expect(() => validators.uuid('550e8400-e29b-41d4-a716-44665544000g')).toThrow('must be a valid UUID'); // 'g' not hex
  });

  it('should reject empty string', () => {
    expect(() => validators.uuid('')).toThrow('must not be empty');
  });

  it('should reject non-string', () => {
    expect(() => validators.uuid(123)).toThrow(TypeError);
    expect(() => validators.uuid(null)).toThrow(TypeError);
  });

  it('should include fieldName', () => {
    expect(() => validators.uuid('bad', 'sessionId')).toThrow('sessionId must be a valid UUID');
  });
});

// ============================================================================
// createValidator()
// ============================================================================
describe('createValidator()', () => {
  it('should return a function', () => {
    const v = createValidator('string');
    expect(typeof v).toBe('function');
  });

  it('should return { valid: true } for passing validation', () => {
    const v = createValidator('string');
    expect(v('hello', 'name')).toEqual({ valid: true });
  });

  it('should return { valid: false, error } for failing validation', () => {
    const v = createValidator('string');
    const result = v(42, 'name');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('name must be a string');
  });

  it('should work with number validator', () => {
    const v = createValidator('number');
    expect(v(42)).toEqual({ valid: true });
    expect(v('abc').valid).toBe(false);
  });

  it('should work with boolean validator', () => {
    const v = createValidator('boolean');
    expect(v(true)).toEqual({ valid: true });
    expect(v(0).valid).toBe(false);
  });

  it('should throw for unknown validator type', () => {
    expect(() => createValidator('nonexistent')).toThrow('Unknown validator type: nonexistent');
  });

  it('should work with object validator', () => {
    const v = createValidator('object');
    expect(v({ a: 1 })).toEqual({ valid: true });
    expect(v(null).valid).toBe(false);
  });

  it('should work with array validator', () => {
    const v = createValidator('array');
    expect(v([1, 2])).toEqual({ valid: true });
    expect(v('not array').valid).toBe(false);
  });
});

// ============================================================================
// validateSchema()
// ============================================================================
describe('validateSchema()', () => {
  describe('required fields', () => {
    it('should pass when all required fields are present', () => {
      const schema = {
        name: { required: true, type: 'string' },
        age: { required: true, type: 'number' },
      };
      expect(() => validateSchema({ name: 'Alice', age: 30 }, schema)).not.toThrow();
    });

    it('should throw when required field is undefined', () => {
      const schema = {
        name: { required: true, type: 'string' },
      };
      expect(() => validateSchema({}, schema, 'user')).toThrow('user.name is required');
    });

    it('should throw when required field is null', () => {
      const schema = {
        name: { required: true, type: 'string' },
      };
      expect(() => validateSchema({ name: null }, schema, 'user')).toThrow('user.name is required');
    });
  });

  describe('optional fields', () => {
    it('should skip validation for optional undefined fields', () => {
      const schema = {
        nickname: { required: false, type: 'string' },
      };
      expect(() => validateSchema({}, schema)).not.toThrow();
    });

    it('should skip validation for optional null fields', () => {
      const schema = {
        nickname: { required: false, type: 'string' },
      };
      expect(() => validateSchema({ nickname: null }, schema)).not.toThrow();
    });

    it('should validate optional fields when present', () => {
      const schema = {
        nickname: { required: false, type: 'string' },
      };
      expect(() => validateSchema({ nickname: 42 }, schema)).toThrow(TypeError);
    });
  });

  describe('type validation', () => {
    it('should validate string type', () => {
      const schema = { name: { required: true, type: 'string' } };
      expect(() => validateSchema({ name: 42 }, schema)).toThrow(TypeError);
    });

    it('should validate number type', () => {
      const schema = { age: { required: true, type: 'number' } };
      expect(() => validateSchema({ age: 'thirty' }, schema)).toThrow(TypeError);
    });

    it('should validate boolean type', () => {
      const schema = { active: { required: true, type: 'boolean' } };
      expect(() => validateSchema({ active: 1 }, schema)).toThrow(TypeError);
    });

    it('should validate object type', () => {
      const schema = { config: { required: true, type: 'object' } };
      expect(() => validateSchema({ config: [] }, schema)).toThrow(TypeError);
    });

    it('should validate array type', () => {
      const schema = { items: { required: true, type: 'array' } };
      expect(() => validateSchema({ items: {} }, schema)).toThrow(TypeError);
    });

    it('should default to string type when type is omitted', () => {
      const schema = { name: { required: true } };
      expect(() => validateSchema({ name: 'Alice' }, schema)).not.toThrow();
      expect(() => validateSchema({ name: 42 }, schema)).toThrow(TypeError);
    });
  });

  describe('enum validation', () => {
    it('should validate enum values', () => {
      const schema = {
        role: { required: true, type: 'enum', values: ['admin', 'user', 'guest'] },
      };
      expect(() => validateSchema({ role: 'admin' }, schema)).not.toThrow();
    });

    it('should reject invalid enum values', () => {
      const schema = {
        role: { required: true, type: 'enum', values: ['admin', 'user'] },
      };
      expect(() => validateSchema({ role: 'superadmin' }, schema, 'input'))
        .toThrow('input.role must be one of [admin, user]');
    });
  });

  describe('numberInRange validation', () => {
    it('should validate numbers within range', () => {
      const schema = {
        port: { required: true, type: 'numberInRange', min: 1, max: 65535 },
      };
      expect(() => validateSchema({ port: 8080 }, schema)).not.toThrow();
    });

    it('should reject numbers outside range', () => {
      const schema = {
        port: { required: true, type: 'numberInRange', min: 1, max: 65535 },
      };
      expect(() => validateSchema({ port: 0 }, schema, 'cfg'))
        .toThrow('cfg.port must be between 1 and 65535');
    });
  });

  describe('additional validations', () => {
    it('should enforce minLength', () => {
      const schema = {
        password: { required: true, type: 'string', minLength: 8 },
      };
      expect(() => validateSchema({ password: 'short' }, schema, 'form'))
        .toThrow('form.password length must be at least 8');
    });

    it('should pass minLength when satisfied', () => {
      const schema = {
        password: { required: true, type: 'string', minLength: 3 },
      };
      expect(() => validateSchema({ password: 'abc' }, schema)).not.toThrow();
    });

    it('should enforce maxLength', () => {
      const schema = {
        code: { required: true, type: 'string', maxLength: 4 },
      };
      expect(() => validateSchema({ code: 'ABCDE' }, schema, 'input'))
        .toThrow('input.code length must not exceed 4');
    });

    it('should pass maxLength when satisfied', () => {
      const schema = {
        code: { required: true, type: 'string', maxLength: 10 },
      };
      expect(() => validateSchema({ code: 'ABC' }, schema)).not.toThrow();
    });

    it('should enforce pattern', () => {
      const schema = {
        zipCode: { required: true, type: 'string', pattern: /^\d{5}$/ },
      };
      expect(() => validateSchema({ zipCode: 'ABCDE' }, schema, 'addr'))
        .toThrow('addr.zipCode does not match required pattern');
    });

    it('should pass pattern when matched', () => {
      const schema = {
        zipCode: { required: true, type: 'string', pattern: /^\d{5}$/ },
      };
      expect(() => validateSchema({ zipCode: '12345' }, schema)).not.toThrow();
    });
  });

  describe('unknown validator type', () => {
    it('should silently skip unknown validator types (logs warning)', () => {
      const schema = {
        custom: { required: true, type: 'unknownType' },
      };
      // The source code logs a warning and continues — does not throw
      expect(() => validateSchema({ custom: 'anything' }, schema)).not.toThrow();
    });
  });

  describe('context name', () => {
    it('should use default context name "object"', () => {
      const schema = {
        name: { required: true, type: 'string' },
      };
      expect(() => validateSchema({}, schema)).toThrow('object.name is required');
    });

    it('should use provided context name', () => {
      const schema = {
        name: { required: true, type: 'string' },
      };
      expect(() => validateSchema({}, schema, 'profile')).toThrow('profile.name is required');
    });
  });

  describe('complex schemas', () => {
    it('should validate a multi-field schema', () => {
      const schema = {
        name: { required: true, type: 'string', minLength: 1, maxLength: 100 },
        age: { required: true, type: 'number' },
        role: { required: true, type: 'enum', values: ['admin', 'user'] },
        bio: { required: false, type: 'string', maxLength: 500 },
      };
      expect(() => validateSchema(
        { name: 'Alice', age: 30, role: 'admin' },
        schema, 'user'
      )).not.toThrow();
    });

    it('should fail on first invalid field', () => {
      const schema = {
        a: { required: true, type: 'string' },
        b: { required: true, type: 'number' },
      };
      // 'a' is valid, 'b' is invalid — should throw on 'b'
      expect(() => validateSchema({ a: 'ok', b: 'not-a-number' }, schema, 'obj'))
        .toThrow(TypeError);
    });
  });
});
