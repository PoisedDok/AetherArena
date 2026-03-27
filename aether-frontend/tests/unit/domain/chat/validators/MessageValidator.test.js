'use strict';

const { MessageValidator } = require('../../../../../src/domain/chat/validators/MessageValidator');

describe('MessageValidator', () => {
  let validator;

  beforeEach(() => {
    validator = new MessageValidator();
  });

  describe('Constructor', () => {
    it('should initialize with sanitizer', () => {
      expect(validator.sanitizer).toBeDefined();
    });
  });

  describe('sanitizeContent()', () => {
    it('should return empty string for null/undefined', () => {
      expect(validator.sanitizeContent(null)).toBe('');
      expect(validator.sanitizeContent(undefined)).toBe('');
    });

    it('should return empty string for non-string', () => {
      expect(validator.sanitizeContent(123)).toBe('');
    });

    it('should sanitize string content', () => {
      const result = validator.sanitizeContent('hello world');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('sanitizeHTML()', () => {
    it('should return empty string for null/undefined', () => {
      expect(validator.sanitizeHTML(null)).toBe('');
      expect(validator.sanitizeHTML(undefined)).toBe('');
    });

    it('should return empty string for non-string', () => {
      expect(validator.sanitizeHTML(123)).toBe('');
    });

    it('should sanitize HTML content', () => {
      const result = validator.sanitizeHTML('<b>bold</b>');
      expect(typeof result).toBe('string');
    });
  });

  describe('_escapeHTML() fallback', () => {
    it('should escape dangerous characters', () => {
      const result = validator._escapeHTML('<script>alert("xss")</script>');
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;');
      expect(result).toContain('&gt;');
      expect(result).toContain('&quot;');
    });

    it('should escape ampersands', () => {
      expect(validator._escapeHTML('a & b')).toContain('&amp;');
    });

    it('should escape single quotes', () => {
      expect(validator._escapeHTML("it's")).toContain('&#x27;');
    });

    it('should escape forward slashes', () => {
      expect(validator._escapeHTML('a/b')).toContain('&#x2F;');
    });

    it('should return empty for null/non-string', () => {
      expect(validator._escapeHTML(null)).toBe('');
      expect(validator._escapeHTML(123)).toBe('');
    });
  });

  describe('Legacy compatibility methods', () => {
    it('validate() should return valid: true', () => {
      expect(validator.validate({ content: 'test' })).toEqual({ valid: true });
    });

    it('validateContent() should return valid: true', () => {
      expect(validator.validateContent('test')).toEqual({ valid: true });
    });

    it('checkRateLimit() should return allowed: true', () => {
      expect(validator.checkRateLimit('user-1')).toEqual({ allowed: true });
    });

    it('validateOrThrow() should return true for valid message', () => {
      expect(validator.validateOrThrow({ role: 'user', content: 'test' })).toBe(true);
    });

    it('validateOrThrow() should throw for invalid message', () => {
      expect(() => validator.validateOrThrow({ content: 'test' })).toThrow('Invalid message format');
    });

    it('validateContentOrThrow() should return true', () => {
      expect(validator.validateContentOrThrow('test')).toBe(true);
    });

    it('checkRateLimitOrThrow() should return allowed: true', () => {
      expect(validator.checkRateLimitOrThrow('user-1')).toEqual({ allowed: true });
    });
  });

  describe('destroy()', () => {
    it('should not throw', () => {
      expect(() => validator.destroy()).not.toThrow();
    });
  });
});
