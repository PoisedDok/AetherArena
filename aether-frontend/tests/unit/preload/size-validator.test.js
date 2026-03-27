'use strict';

const {
  SizeValidator,
  createSizeValidator,
  DEFAULT_SIZE_LIMITS,
  calculateSize,
} = require('../../../src/preload/common/size-validator');

// ============================================================================
// DEFAULT_SIZE_LIMITS
// ============================================================================
describe('DEFAULT_SIZE_LIMITS', () => {
  it('should be a frozen object', () => {
    expect(Object.isFrozen(DEFAULT_SIZE_LIMITS)).toBe(true);
  });

  it('should have expected top-level keys', () => {
    expect(DEFAULT_SIZE_LIMITS).toHaveProperty('maxStringLength');
    expect(DEFAULT_SIZE_LIMITS).toHaveProperty('maxArrayLength');
    expect(DEFAULT_SIZE_LIMITS).toHaveProperty('maxObjectDepth');
    expect(DEFAULT_SIZE_LIMITS).toHaveProperty('channels');
  });

  it('should have channels as a frozen object', () => {
    expect(Object.isFrozen(DEFAULT_SIZE_LIMITS.channels)).toBe(true);
  });

  it('should have numeric limits', () => {
    expect(typeof DEFAULT_SIZE_LIMITS.maxStringLength).toBe('number');
    expect(typeof DEFAULT_SIZE_LIMITS.maxArrayLength).toBe('number');
    expect(typeof DEFAULT_SIZE_LIMITS.maxObjectDepth).toBe('number');
    expect(DEFAULT_SIZE_LIMITS.maxStringLength).toBe(10 * 1024 * 1024);
    expect(DEFAULT_SIZE_LIMITS.maxArrayLength).toBe(10000);
    expect(DEFAULT_SIZE_LIMITS.maxObjectDepth).toBe(10);
  });

  it('should define per-channel byte limits', () => {
    const ch = DEFAULT_SIZE_LIMITS.channels;
    expect(ch['artifacts:stream']).toBe(10 * 1024 * 1024);
    expect(ch['chat:send']).toBe(500 * 1024);
    expect(ch['chat:assistant-stream']).toBe(2 * 1024 * 1024);
    expect(ch['zoom-in']).toBe(1024);
    expect(ch['toggle-widget-mode']).toBe(1024);
  });
});

// ============================================================================
// calculateSize()
// ============================================================================
describe('calculateSize()', () => {
  it('should return 0 for null', () => {
    expect(calculateSize(null)).toBe(0);
  });

  it('should return 0 for undefined', () => {
    expect(calculateSize(undefined)).toBe(0);
  });

  it('should return 4 for boolean', () => {
    expect(calculateSize(true)).toBe(4);
    expect(calculateSize(false)).toBe(4);
  });

  it('should return 8 for number', () => {
    expect(calculateSize(0)).toBe(8);
    expect(calculateSize(42)).toBe(8);
    expect(calculateSize(3.14)).toBe(8);
    expect(calculateSize(-1)).toBe(8);
  });

  it('should return length * 2 for string (UTF-16)', () => {
    expect(calculateSize('')).toBe(0);
    expect(calculateSize('a')).toBe(2);
    expect(calculateSize('hello')).toBe(10);
    expect(calculateSize('ab')).toBe(4);
  });

  it('should sum array element sizes', () => {
    expect(calculateSize([])).toBe(0);
    expect(calculateSize([true])).toBe(4); // 1 boolean = 4
    expect(calculateSize([1, 2])).toBe(16); // 2 numbers = 16
    expect(calculateSize(['a', 'b'])).toBe(4); // 2 * (1*2) = 4
  });

  it('should sum object key sizes + value sizes', () => {
    // { a: 1 } -> key 'a' = 2, value 1 = 8 => total 10
    expect(calculateSize({ a: 1 })).toBe(10);
    // { ab: true } -> key 'ab' = 4, value true = 4 => total 8
    expect(calculateSize({ ab: true })).toBe(8);
    // empty object
    expect(calculateSize({})).toBe(0);
  });

  it('should handle nested objects recursively', () => {
    // { a: { b: 1 } } -> key 'a' = 2, inner: key 'b' = 2 + value 1 = 8 => 2 + 10 = 12
    expect(calculateSize({ a: { b: 1 } })).toBe(12);
  });

  it('should handle nested arrays recursively', () => {
    // [[1]] -> outer array wraps inner [1], inner: number 8, total 8
    expect(calculateSize([[1]])).toBe(8);
  });

  it('should return 0 for unsupported types (function, symbol)', () => {
    expect(calculateSize(() => {})).toBe(0);
    expect(calculateSize(Symbol('x'))).toBe(0);
  });
});

// ============================================================================
// SizeValidator — constructor
// ============================================================================
describe('SizeValidator constructor', () => {
  it('should use default limits when no options provided', () => {
    const v = new SizeValidator();
    expect(v.maxStringLength).toBe(DEFAULT_SIZE_LIMITS.maxStringLength);
    expect(v.maxArrayLength).toBe(DEFAULT_SIZE_LIMITS.maxArrayLength);
    expect(v.maxObjectDepth).toBe(DEFAULT_SIZE_LIMITS.maxObjectDepth);
    expect(v.enabled).toBe(true);
    expect(v.onViolation).toBeNull();
  });

  it('should accept custom limits', () => {
    const v = new SizeValidator({
      maxStringLength: 100,
      maxArrayLength: 50,
      maxObjectDepth: 3,
    });
    expect(v.maxStringLength).toBe(100);
    expect(v.maxArrayLength).toBe(50);
    expect(v.maxObjectDepth).toBe(3);
  });

  it('should merge custom channel limits with defaults', () => {
    const v = new SizeValidator({
      channelLimits: { 'custom:channel': 999 },
    });
    // Custom channel added
    expect(v.channelLimits['custom:channel']).toBe(999);
    // Default channels still present
    expect(v.channelLimits['chat:send']).toBe(DEFAULT_SIZE_LIMITS.channels['chat:send']);
  });

  it('should allow custom channel limit to override a default', () => {
    const v = new SizeValidator({
      channelLimits: { 'chat:send': 1024 },
    });
    expect(v.channelLimits['chat:send']).toBe(1024);
  });

  it('should accept enabled=false', () => {
    const v = new SizeValidator({ enabled: false });
    expect(v.enabled).toBe(false);
  });

  it('should accept onViolation callback', () => {
    const cb = jest.fn();
    const v = new SizeValidator({ onViolation: cb });
    expect(v.onViolation).toBe(cb);
  });

  it('should initialize stats', () => {
    const v = new SizeValidator();
    expect(v.stats.totalChecks).toBe(0);
    expect(v.stats.violations).toBe(0);
    expect(v.stats.byChannel).toBeInstanceOf(Map);
    expect(v.stats.byChannel.size).toBe(0);
  });
});

// ============================================================================
// SizeValidator.validate()
// ============================================================================
describe('SizeValidator.validate()', () => {
  describe('when disabled', () => {
    it('should always return { valid: true }', () => {
      const v = new SizeValidator({ enabled: false });
      // Even massive payload passes
      const result = v.validate('chat:send', 'x'.repeat(10 * 1024 * 1024));
      expect(result).toEqual({ valid: true });
    });

    it('should not update stats', () => {
      const v = new SizeValidator({ enabled: false });
      v.validate('chat:send', 'hello');
      expect(v.stats.totalChecks).toBe(0);
    });
  });

  describe('depth check', () => {
    it('should pass payloads within depth limit', () => {
      const v = new SizeValidator({ maxObjectDepth: 3 });
      const payload = { a: { b: { c: 1 } } }; // depth 3
      const result = v.validate('chat:send', payload);
      expect(result.valid).toBe(true);
    });

    it('should reject payloads exceeding depth limit', () => {
      const v = new SizeValidator({ maxObjectDepth: 2 });
      const payload = { a: { b: { c: 1 } } }; // depth 3
      const result = v.validate('chat:send', payload);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('nesting depth');
      expect(result.error).toContain('2');
    });

    it('should reject deeply nested arrays', () => {
      const v = new SizeValidator({ maxObjectDepth: 2 });
      const payload = [[[1]]]; // depth 3
      const result = v.validate('test', payload);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('nesting depth');
    });

    it('should call onViolation callback on depth violation', () => {
      const cb = jest.fn();
      const v = new SizeValidator({ maxObjectDepth: 1, onViolation: cb });
      v.validate('test-ch', { a: { b: 1 } });
      expect(cb).toHaveBeenCalledWith(
        'test-ch',
        expect.stringContaining('nesting depth'),
        expect.objectContaining({ depth: 1 })
      );
    });

    it('should pass null/undefined payloads (depth=0)', () => {
      const v = new SizeValidator({ maxObjectDepth: 1 });
      expect(v.validate('ch', null).valid).toBe(true);
      expect(v.validate('ch', undefined).valid).toBe(true);
    });

    it('should pass primitive payloads', () => {
      const v = new SizeValidator({ maxObjectDepth: 1 });
      expect(v.validate('ch', 42).valid).toBe(true);
      expect(v.validate('ch', 'hello').valid).toBe(true);
      expect(v.validate('ch', true).valid).toBe(true);
    });
  });

  describe('array length check', () => {
    it('should pass arrays within limit', () => {
      const v = new SizeValidator({ maxArrayLength: 5 });
      expect(v.validate('ch', [1, 2, 3]).valid).toBe(true);
    });

    it('should reject arrays exceeding limit', () => {
      const v = new SizeValidator({ maxArrayLength: 3 });
      const result = v.validate('ch', [1, 2, 3, 4]);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Array length 4');
      expect(result.error).toContain('maximum of 3');
    });

    it('should call onViolation on array length violation', () => {
      const cb = jest.fn();
      const v = new SizeValidator({ maxArrayLength: 1, onViolation: cb });
      v.validate('arr-ch', [1, 2]);
      expect(cb).toHaveBeenCalledWith(
        'arr-ch',
        expect.stringContaining('Array length'),
        expect.objectContaining({ length: 2, max: 1 })
      );
    });

    it('should not check array length for non-array payloads', () => {
      const v = new SizeValidator({ maxArrayLength: 1 });
      // Objects with many keys should not trigger array check
      expect(v.validate('ch', { a: 1, b: 2, c: 3 }).valid).toBe(true);
    });
  });

  describe('string length check', () => {
    it('should pass strings within limit', () => {
      const v = new SizeValidator({ maxStringLength: 10 });
      expect(v.validate('ch', 'hello').valid).toBe(true);
    });

    it('should reject strings exceeding limit', () => {
      const v = new SizeValidator({ maxStringLength: 5 });
      const result = v.validate('ch', 'toolong');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('String length 7');
      expect(result.error).toContain('maximum of 5');
    });

    it('should call onViolation on string length violation', () => {
      const cb = jest.fn();
      const v = new SizeValidator({ maxStringLength: 2, onViolation: cb });
      v.validate('str-ch', 'abc');
      expect(cb).toHaveBeenCalledWith(
        'str-ch',
        expect.stringContaining('String length'),
        expect.objectContaining({ length: 3, max: 2 })
      );
    });

    it('should not check string length for non-string payloads', () => {
      const v = new SizeValidator({ maxStringLength: 1 });
      expect(v.validate('ch', 42).valid).toBe(true);
      expect(v.validate('ch', { key: 'value' }).valid).toBe(true);
    });
  });

  describe('channel size check', () => {
    it('should pass payloads within channel limit', () => {
      const v = new SizeValidator({
        channelLimits: { 'test:ch': 100 },
      });
      // Small object
      expect(v.validate('test:ch', { a: 1 }).valid).toBe(true);
    });

    it('should reject payloads exceeding channel limit', () => {
      const v = new SizeValidator({
        channelLimits: { 'tiny:ch': 4 },
      });
      // { a: 1 } = key 'a' (2 bytes) + number (8 bytes) = 10 bytes > 4
      const result = v.validate('tiny:ch', { a: 1 });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('bytes exceeds channel limit');
      expect(result).toHaveProperty('size');
    });

    it('should include size in the result for successful validation', () => {
      const v = new SizeValidator({
        channelLimits: { 'test:ch': 1000 },
      });
      const result = v.validate('test:ch', { a: 1 });
      expect(result.valid).toBe(true);
      expect(result.size).toBe(10); // key 'a' = 2, number = 8
    });

    it('should skip size check for channels without a defined limit', () => {
      const v = new SizeValidator({
        channelLimits: {}, // no channel limits at all
      });
      // Even large payload passes — no channel limit defined
      const result = v.validate('unknown:ch', 'x'.repeat(100));
      expect(result.valid).toBe(true);
      expect(result).toHaveProperty('size');
    });

    it('should call onViolation on size violation', () => {
      const cb = jest.fn();
      const v = new SizeValidator({
        channelLimits: { 'tiny:ch': 1 },
        onViolation: cb,
      });
      v.validate('tiny:ch', { a: 1 });
      expect(cb).toHaveBeenCalledWith(
        'tiny:ch',
        expect.stringContaining('exceeds channel limit'),
        expect.objectContaining({ size: 10, limit: 1 })
      );
    });
  });

  describe('validation order (depth > array > string > size)', () => {
    it('should fail on depth before array length', () => {
      const v = new SizeValidator({ maxObjectDepth: 1, maxArrayLength: 1 });
      // Payload has both depth and array issues
      const payload = [[1, 2, 3]]; // depth=2 (exceeds 1), inner array has 3 items (exceeds 1)
      const result = v.validate('ch', payload);
      expect(result.error).toContain('nesting depth');
    });

    it('should fail on array length before string length', () => {
      const v = new SizeValidator({ maxArrayLength: 1, maxStringLength: 1 });
      // Array of strings — array check comes before string check
      const result = v.validate('ch', ['ab', 'cd']);
      expect(result.error).toContain('Array length');
    });
  });
});

// ============================================================================
// SizeValidator.updateStats() (tested via validate())
// ============================================================================
describe('SizeValidator stats tracking', () => {
  it('should increment totalChecks on each validate call', () => {
    const v = new SizeValidator();
    v.validate('ch', 'a');
    v.validate('ch', 'b');
    v.validate('ch', 'c');
    expect(v.stats.totalChecks).toBe(3);
  });

  it('should increment violations on failure', () => {
    const v = new SizeValidator({ maxStringLength: 1 });
    v.validate('ch', 'too long');
    expect(v.stats.violations).toBe(1);
  });

  it('should not increment violations on success', () => {
    const v = new SizeValidator();
    v.validate('ch', 'a');
    expect(v.stats.violations).toBe(0);
  });

  it('should track per-channel stats', () => {
    const v = new SizeValidator({ channelLimits: { 'a:ch': 1000, 'b:ch': 1000 } });
    v.validate('a:ch', 'x');
    v.validate('a:ch', 'y');
    v.validate('b:ch', 'z');

    expect(v.stats.byChannel.get('a:ch').checks).toBe(2);
    expect(v.stats.byChannel.get('b:ch').checks).toBe(1);
  });

  it('should track violation reasons per channel', () => {
    const v = new SizeValidator({ maxStringLength: 1, maxArrayLength: 1 });
    v.validate('ch1', 'too long'); // string_length violation
    v.validate('ch1', [1, 2]); // array_length violation

    const ch1Stats = v.stats.byChannel.get('ch1');
    expect(ch1Stats.violations).toBe(2);
    expect(ch1Stats.reasons.string_length).toBe(1);
    expect(ch1Stats.reasons.array_length).toBe(1);
  });

  it('should create channel entry on first access', () => {
    const v = new SizeValidator();
    expect(v.stats.byChannel.has('new:ch')).toBe(false);
    v.validate('new:ch', 'x');
    expect(v.stats.byChannel.has('new:ch')).toBe(true);
    expect(v.stats.byChannel.get('new:ch').checks).toBe(1);
    expect(v.stats.byChannel.get('new:ch').violations).toBe(0);
  });
});

// ============================================================================
// SizeValidator.getStats()
// ============================================================================
describe('SizeValidator.getStats()', () => {
  it('should return initial stats', () => {
    const v = new SizeValidator();
    const stats = v.getStats();
    expect(stats.totalChecks).toBe(0);
    expect(stats.violations).toBe(0);
    expect(stats.violationPercent).toBe(0);
    expect(stats.byChannel).toEqual({});
  });

  it('should compute violationPercent correctly', () => {
    const v = new SizeValidator({ maxStringLength: 3 });
    v.validate('ch', 'ok');
    v.validate('ch', 'fail!');
    // 1 success, 1 failure = 50%
    const stats = v.getStats();
    expect(stats.totalChecks).toBe(2);
    expect(stats.violations).toBe(1);
    expect(stats.violationPercent).toBe('50.00');
  });

  it('should convert byChannel Map to plain object', () => {
    const v = new SizeValidator();
    v.validate('ch-a', 'x');
    v.validate('ch-b', 'y');
    const stats = v.getStats();
    expect(typeof stats.byChannel).toBe('object');
    expect(stats.byChannel).not.toBeInstanceOf(Map);
    expect(stats.byChannel['ch-a']).toBeDefined();
    expect(stats.byChannel['ch-b']).toBeDefined();
  });

  it('should include per-channel violationPercent', () => {
    const v = new SizeValidator({ maxStringLength: 2 });
    v.validate('ch', 'a');     // pass
    v.validate('ch', 'abc');   // fail
    v.validate('ch', 'ab');    // pass
    const stats = v.getStats();
    // ch: 3 checks, 1 violation = 33.33%
    expect(stats.byChannel['ch'].violationPercent).toBe('33.33');
  });

  it('should handle zero checks per channel (no division by zero)', () => {
    // This path cannot naturally occur (byChannel entry only created on validate()),
    // but verifying the guard in the code
    const v = new SizeValidator();
    const stats = v.getStats();
    expect(stats.violationPercent).toBe(0);
  });
});

// ============================================================================
// SizeValidator.resetStats()
// ============================================================================
describe('SizeValidator.resetStats()', () => {
  it('should reset all stats to initial state', () => {
    const v = new SizeValidator({ maxStringLength: 3 });
    v.validate('ch', 'ok');     // length 2, within limit
    v.validate('ch', 'fail me'); // length 7, exceeds limit
    expect(v.stats.totalChecks).toBe(2);
    expect(v.stats.violations).toBe(1);

    v.resetStats();
    expect(v.stats.totalChecks).toBe(0);
    expect(v.stats.violations).toBe(0);
    expect(v.stats.byChannel).toBeInstanceOf(Map);
    expect(v.stats.byChannel.size).toBe(0);
  });

  it('should allow fresh stat accumulation after reset', () => {
    const v = new SizeValidator();
    v.validate('ch', 'x');
    v.resetStats();
    v.validate('ch', 'y');
    expect(v.stats.totalChecks).toBe(1);
  });
});

// ============================================================================
// SizeValidator.enable() / disable()
// ============================================================================
describe('SizeValidator.enable() / disable()', () => {
  it('should disable validation', () => {
    const v = new SizeValidator({ maxStringLength: 1 });
    v.disable();
    const result = v.validate('ch', 'long string');
    expect(result).toEqual({ valid: true });
    expect(v.enabled).toBe(false);
  });

  it('should re-enable validation', () => {
    const v = new SizeValidator({ maxStringLength: 1 });
    v.disable();
    v.enable();
    const result = v.validate('ch', 'long string');
    expect(result.valid).toBe(false);
    expect(v.enabled).toBe(true);
  });
});

// ============================================================================
// createSizeValidator()
// ============================================================================
describe('createSizeValidator()', () => {
  it('should return a SizeValidator instance', () => {
    const v = createSizeValidator();
    expect(v).toBeInstanceOf(SizeValidator);
  });

  it('should pass options to constructor', () => {
    const v = createSizeValidator({ maxStringLength: 42, enabled: false });
    expect(v.maxStringLength).toBe(42);
    expect(v.enabled).toBe(false);
  });

  it('should work with default (no) options', () => {
    const v = createSizeValidator();
    expect(v.maxStringLength).toBe(DEFAULT_SIZE_LIMITS.maxStringLength);
    expect(v.enabled).toBe(true);
  });
});

// ============================================================================
// Edge cases and integration scenarios
// ============================================================================
describe('edge cases', () => {
  it('should handle empty object payload', () => {
    const v = new SizeValidator();
    const result = v.validate('chat:send', {});
    expect(result.valid).toBe(true);
    expect(result.size).toBe(0);
  });

  it('should handle empty array payload', () => {
    const v = new SizeValidator();
    const result = v.validate('chat:send', []);
    expect(result.valid).toBe(true);
    expect(result.size).toBe(0);
  });

  it('should handle empty string payload', () => {
    const v = new SizeValidator();
    const result = v.validate('chat:send', '');
    expect(result.valid).toBe(true);
  });

  it('should handle number payload', () => {
    const v = new SizeValidator();
    const result = v.validate('chat:send', 42);
    expect(result.valid).toBe(true);
    expect(result.size).toBe(8);
  });

  it('should handle boolean payload', () => {
    const v = new SizeValidator();
    const result = v.validate('chat:send', true);
    expect(result.valid).toBe(true);
    expect(result.size).toBe(4);
  });

  it('should handle mixed nested payload', () => {
    const v = new SizeValidator({ maxObjectDepth: 5 });
    const payload = {
      type: 'message',
      data: {
        items: [1, 'two', { nested: true }],
      },
    };
    const result = v.validate('ch', payload);
    expect(result.valid).toBe(true);
    expect(typeof result.size).toBe('number');
    expect(result.size).toBeGreaterThan(0);
  });

  it('should handle depth exactly at limit', () => {
    const v = new SizeValidator({ maxObjectDepth: 3 });
    // Depth 3: { a: { b: { c: 1 } } } — value at depth 3 is a number, not an object
    const payload = { a: { b: { c: 1 } } };
    expect(v.validate('ch', payload).valid).toBe(true);
  });

  it('should reject depth one beyond limit', () => {
    const v = new SizeValidator({ maxObjectDepth: 2 });
    const payload = { a: { b: { c: 1 } } };
    expect(v.validate('ch', payload).valid).toBe(false);
  });

  it('should handle exact array length at limit', () => {
    const v = new SizeValidator({ maxArrayLength: 3 });
    expect(v.validate('ch', [1, 2, 3]).valid).toBe(true);
  });

  it('should reject array length one beyond limit', () => {
    const v = new SizeValidator({ maxArrayLength: 3 });
    expect(v.validate('ch', [1, 2, 3, 4]).valid).toBe(false);
  });

  it('should handle exact string length at limit', () => {
    const v = new SizeValidator({ maxStringLength: 5 });
    expect(v.validate('ch', 'abcde').valid).toBe(true);
  });

  it('should reject string length one beyond limit', () => {
    const v = new SizeValidator({ maxStringLength: 5 });
    expect(v.validate('ch', 'abcdef').valid).toBe(false);
  });
});
