'use strict';

/**
 * Security Modules Real Tests
 * Tests input validation, sanitization, and rate limiting
 */

const { Sanitizer } = require('../../../src/core/security');
const { InputValidator } = require('../../../src/core/security');
const { RateLimiter } = require('../../../src/core/security');

describe('Core Security Modules', () => {
  describe('Sanitizer', () => {
    let sanitizer;

    beforeEach(() => {
      sanitizer = new Sanitizer({ profile: 'strict' });
    });

    it('should sanitize HTML input', () => {
      const dirty = '<script>alert("xss")</script><p>Safe content</p>';
      const clean = sanitizer.sanitizeHtml(dirty);
      
      expect(clean).not.toContain('<script>');
      expect(clean).toContain('Safe content');
    });

    it('should remove dangerous attributes', () => {
      const dirty = '<img src="x" onerror="alert(1)">';
      const clean = sanitizer.sanitizeHtml(dirty);
      
      expect(clean).not.toContain('onerror');
    });

    it('should sanitize URLs', () => {
      const safeUrl = 'https://example.com/path';
      const dangerousUrl = 'javascript:alert(1)';
      
      expect(sanitizer.sanitizeUrl(safeUrl)).toBe(safeUrl);
      expect(sanitizer.sanitizeUrl(dangerousUrl)).not.toBe(dangerousUrl);
    });

    it('should sanitize text input', () => {
      const input = '<script>evil</script>Normal text';
      const cleaned = sanitizer.sanitizeText(input);
      
      expect(cleaned).not.toContain('<script>');
      expect(cleaned).toContain('Normal text');
    });

    it('should handle null/undefined inputs', () => {
      expect(sanitizer.sanitizeHtml(null)).toBe('');
      expect(sanitizer.sanitizeHtml(undefined)).toBe('');
      expect(sanitizer.sanitizeText(null)).toBe('');
    });
  });

  describe('Input Validator', () => {
    let validator;

    beforeEach(() => {
      validator = new InputValidator();
    });

    it('should validate strings', () => {
      expect(validator.isString('hello')).toBe(true);
      expect(validator.isString(123)).toBe(false);
      expect(validator.isString(null)).toBe(false);
    });

    it('should validate string length', () => {
      expect(validator.validateLength('hello', 1, 10)).toBe(true);
      expect(validator.validateLength('hello', 10, 20)).toBe(false);
      expect(validator.validateLength('', 1, 10)).toBe(false);
    });

    it('should validate numbers', () => {
      expect(validator.isNumber(123)).toBe(true);
      expect(validator.isNumber('123')).toBe(false);
      expect(validator.isNumber(NaN)).toBe(false);
    });

    it('should validate number ranges', () => {
      expect(validator.validateRange(5, 1, 10)).toBe(true);
      expect(validator.validateRange(15, 1, 10)).toBe(false);
      expect(validator.validateRange(-5, 1, 10)).toBe(false);
    });

    it('should validate URLs', () => {
      expect(validator.isValidUrl('https://example.com')).toBe(true);
      expect(validator.isValidUrl('http://localhost:8080')).toBe(true);
      expect(validator.isValidUrl('not-a-url')).toBe(false);
      expect(validator.isValidUrl('javascript:alert(1)')).toBe(false);
    });

    it('should validate objects', () => {
      expect(validator.isObject({})).toBe(true);
      expect(validator.isObject({ key: 'value' })).toBe(true);
      expect(validator.isObject(null)).toBe(false);
      expect(validator.isObject([])).toBe(false);
    });

    it('should validate message size', () => {
      const smallMessage = 'a'.repeat(100);
      const largeMessage = 'a'.repeat(200000);
      
      expect(validator.validateMessageSize(smallMessage, 100000)).toBe(true);
      expect(validator.validateMessageSize(largeMessage, 100000)).toBe(false);
    });
  });

  describe('Rate Limiter', () => {
    let rateLimiter;

    beforeEach(() => {
      rateLimiter = new RateLimiter({
        window: 1000, // 1 second
        maxCalls: 5   // 5 calls
      });
    });

    it('should allow requests within limit', () => {
      for (let i = 0; i < 5; i++) {
        expect(rateLimiter.tryAcquire('test')).toBe(true);
      }
    });

    it('should block requests over limit', () => {
      for (let i = 0; i < 5; i++) {
        rateLimiter.tryAcquire('test');
      }
      
      expect(rateLimiter.tryAcquire('test')).toBe(false);
    });

    it('should reset after window period', async () => {
      for (let i = 0; i < 5; i++) {
        rateLimiter.tryAcquire('test');
      }
      
      expect(rateLimiter.tryAcquire('test')).toBe(false);
      
      await new Promise(resolve => setTimeout(resolve, 1100));
      
      expect(rateLimiter.tryAcquire('test')).toBe(true);
    });

    it('should track separate keys independently', () => {
      for (let i = 0; i < 5; i++) {
        rateLimiter.tryAcquire('key1');
      }
      
      expect(rateLimiter.tryAcquire('key1')).toBe(false);
      expect(rateLimiter.tryAcquire('key2')).toBe(true);
    });

    it('should provide stats', () => {
      rateLimiter.tryAcquire('test');
      rateLimiter.tryAcquire('test');
      
      const stats = rateLimiter.getStats('test');
      expect(stats.count).toBe(2);
      expect(stats.remaining).toBe(3);
    });
  });
});

