'use strict';

jest.mock('../../../../../src/core/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
  })
}));

const { ChatValidator } = require('../../../../../src/domain/chat/validators/ChatValidator');

describe('ChatValidator', () => {
  let validator;

  beforeEach(() => {
    validator = new ChatValidator();
  });

  describe('sanitizeTitle()', () => {
    it('escapes HTML entities', () => {
      expect(validator.sanitizeTitle('<script>alert("xss")</script>'))
        .toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;&#x2F;script&gt;');
    });

    it('escapes ampersands', () => {
      expect(validator.sanitizeTitle('a & b')).toBe('a &amp; b');
    });

    it('escapes single quotes', () => {
      expect(validator.sanitizeTitle("it's")).toBe('it&#x27;s');
    });

    it('returns empty string for null', () => {
      expect(validator.sanitizeTitle(null)).toBe('');
    });

    it('returns empty string for non-string', () => {
      expect(validator.sanitizeTitle(42)).toBe('');
    });

    it('passes through clean strings', () => {
      expect(validator.sanitizeTitle('Hello World')).toBe('Hello World');
    });
  });

  describe('sanitizeMetadata()', () => {
    it('sanitizes string values', () => {
      const result = validator.sanitizeMetadata({ name: '<b>bold</b>', count: 5 });
      expect(result.name).toBe('&lt;b&gt;bold&lt;&#x2F;b&gt;');
      expect(result.count).toBe(5);
    });

    it('returns empty object for null', () => {
      expect(validator.sanitizeMetadata(null)).toEqual({});
    });

    it('returns empty object for non-object', () => {
      expect(validator.sanitizeMetadata('string')).toEqual({});
    });

    it('preserves non-string values', () => {
      const result = validator.sanitizeMetadata({ flag: true, arr: [1, 2] });
      expect(result.flag).toBe(true);
      expect(result.arr).toEqual([1, 2]);
    });
  });

  describe('legacy deprecated methods', () => {
    it('validate() returns valid', () => {
      expect(validator.validate({})).toEqual({ valid: true });
    });

    it('validateTitle() returns valid', () => {
      expect(validator.validateTitle('test')).toEqual({ valid: true });
    });

    it('validateId() returns valid', () => {
      expect(validator.validateId('abc')).toEqual({ valid: true });
    });

    it('validateMetadata() returns valid', () => {
      expect(validator.validateMetadata({})).toEqual({ valid: true });
    });

    it('validateOrThrow() returns true', () => {
      expect(validator.validateOrThrow({})).toBe(true);
    });

    it('validateTitleOrThrow() returns true', () => {
      expect(validator.validateTitleOrThrow('x')).toBe(true);
    });

    it('validateIdOrThrow() returns true', () => {
      expect(validator.validateIdOrThrow('x')).toBe(true);
    });

    it('validateMetadataOrThrow() returns true', () => {
      expect(validator.validateMetadataOrThrow({})).toBe(true);
    });
  });
});
