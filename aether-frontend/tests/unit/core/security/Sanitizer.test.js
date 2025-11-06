/**
 * Sanitizer Unit Tests
 * ============================================================================
 * Comprehensive unit tests for HTML Sanitizer (100% coverage required)
 * 
 * @module tests/unit/core/security/Sanitizer
 */

const { Sanitizer, PROFILES } = require('../../../../src/core/security/Sanitizer');

describe('Sanitizer', () => {
  let sanitizer;

  beforeEach(() => {
    sanitizer = new Sanitizer();
  });

  describe('Initialization', () => {
    test('should create instance with default profile', () => {
      expect(sanitizer).toBeDefined();
      expect(sanitizer.defaultProfile).toBe('default');
    });

    test('should create instance with custom profile', () => {
      const customSanitizer = new Sanitizer({ defaultProfile: 'strict' });
      expect(customSanitizer.defaultProfile).toBe('strict');
    });

    test('should initialize statistics', () => {
      expect(sanitizer.stats).toBeDefined();
      expect(sanitizer.stats.totalSanitizations).toBe(0);
      expect(sanitizer.stats.violations).toBe(0);
    });
  });

  describe('HTML Sanitization', () => {
    test('should sanitize HTML content', () => {
      const dirty = '<p>Hello</p>';
      const clean = sanitizer.sanitizeHTML(dirty);
      
      expect(clean).toBeDefined();
      expect(typeof clean).toBe('string');
    });

    test('should remove script tags', () => {
      const dirty = '<script>alert("XSS")</script><p>Content</p>';
      const clean = sanitizer.sanitizeHTML(dirty);
      
      expect(clean).not.toContain('<script>');
      expect(clean).not.toContain('alert');
    });

    test('should remove event handlers', () => {
      const dirty = '<p onclick="alert(1)">Click me</p>';
      const clean = sanitizer.sanitizeHTML(dirty);
      
      expect(clean).not.toContain('onclick');
    });

    test('should allow safe HTML tags', () => {
      const html = '<p>Text</p><strong>Bold</strong><em>Italic</em>';
      const clean = sanitizer.sanitizeHTML(html);
      
      expect(clean).toContain('<p>');
      expect(clean).toContain('<strong>');
      expect(clean).toContain('<em>');
    });

    test('should handle empty input', () => {
      expect(sanitizer.sanitizeHTML('')).toBe('');
      expect(sanitizer.sanitizeHTML(null)).toBe('');
      expect(sanitizer.sanitizeHTML(undefined)).toBe('');
    });

    test('should handle non-string input', () => {
      expect(sanitizer.sanitizeHTML(123)).toBe('');
      expect(sanitizer.sanitizeHTML({})).toBe('');
      expect(sanitizer.sanitizeHTML([])).toBe('');
    });
  });

  describe('URL Sanitization', () => {
    test('should sanitize valid HTTPS URL', () => {
      const url = 'https://example.com';
      const clean = sanitizer.sanitizeURL(url);
      
      // URL normalization may add trailing slash
      expect(clean).toMatch(/^https:\/\/example\.com\/?$/);
    });

    test('should sanitize valid HTTP URL', () => {
      const url = 'http://localhost:3000';
      const clean = sanitizer.sanitizeURL(url);
      
      // URL normalization may add trailing slash
      expect(clean).toMatch(/^http:\/\/localhost:3000\/?$/);
    });

    test('should block javascript: protocol', () => {
      const url = 'javascript:alert(1)';
      const clean = sanitizer.sanitizeURL(url);
      
      expect(clean).toBeNull();
    });

    test('should block data: protocol', () => {
      const url = 'data:text/html,<script>alert(1)</script>';
      const clean = sanitizer.sanitizeURL(url);
      
      expect(clean).toBeNull();
    });

    test('should block vbscript: protocol', () => {
      const url = 'vbscript:alert(1)';
      const clean = sanitizer.sanitizeURL(url);
      
      expect(clean).toBeNull();
    });

    test('should block file: protocol', () => {
      const url = 'file:///etc/passwd';
      const clean = sanitizer.sanitizeURL(url);
      
      expect(clean).toBeNull();
    });

    test('should handle invalid URLs', () => {
      const invalid = 'not-a-url';
      const clean = sanitizer.sanitizeURL(invalid);
      
      expect(clean).toBeNull();
    });

    test('should handle empty URL input', () => {
      expect(sanitizer.sanitizeURL('')).toBeNull();
      expect(sanitizer.sanitizeURL(null)).toBeNull();
      expect(sanitizer.sanitizeURL(undefined)).toBeNull();
    });

    test('should increment violations on blocked URL', () => {
      const initialViolations = sanitizer.stats.violations;
      sanitizer.sanitizeURL('javascript:alert(1)');
      
      expect(sanitizer.stats.violations).toBe(initialViolations + 1);
    });
  });

  describe('Attribute Sanitization', () => {
    test('should sanitize text attributes', () => {
      const value = '<script>alert(1)</script>';
      const clean = sanitizer.sanitizeAttribute(value, 'title');
      
      expect(clean).not.toContain('<script>');
    });

    test('should sanitize href attributes', () => {
      const href = 'javascript:alert(1)';
      const clean = sanitizer.sanitizeAttribute(href, 'href');
      
      expect(clean).toBe('');
    });

    test('should sanitize src attributes', () => {
      const src = 'javascript:alert(1)';
      const clean = sanitizer.sanitizeAttribute(src, 'src');
      
      expect(clean).toBe('');
    });

    test('should allow safe href values', () => {
      const href = 'https://example.com';
      const clean = sanitizer.sanitizeAttribute(href, 'href');
      
      // URL normalization may add trailing slash
      expect(clean).toMatch(/^https:\/\/example\.com\/?$/);
    });

    test('should handle empty attribute values', () => {
      expect(sanitizer.sanitizeAttribute('', 'title')).toBe('');
      expect(sanitizer.sanitizeAttribute(null, 'title')).toBe('');
    });
  });

  describe('HTML Stripping', () => {
    test('should strip all HTML tags', () => {
      const html = '<p>Text <strong>bold</strong></p>';
      const text = sanitizer.stripHTML(html);
      
      expect(text).not.toContain('<p>');
      expect(text).not.toContain('<strong>');
      expect(text).toContain('Text');
      expect(text).toContain('bold');
    });

    test('should handle nested tags', () => {
      const html = '<div><p><span>Nested</span></p></div>';
      const text = sanitizer.stripHTML(html);
      
      expect(text).toBe('Nested');
    });

    test('should handle empty HTML', () => {
      expect(sanitizer.stripHTML('')).toBe('');
      expect(sanitizer.stripHTML(null)).toBe('');
    });
  });

  describe('Safety Check', () => {
    test('should identify safe HTML', () => {
      const safe = '<p>Safe content</p>';
      expect(sanitizer.isSafe(safe)).toBe(true);
    });

    test('should identify unsafe HTML', () => {
      const unsafe = '<script>alert(1)</script>';
      expect(sanitizer.isSafe(unsafe)).toBe(false);
    });

    test('should handle different profiles', () => {
      const html = '<p>Text</p>';
      expect(sanitizer.isSafe(html, 'default')).toBe(true);
      expect(sanitizer.isSafe(html, 'strict')).toBe(false); // Strict removes all HTML
    });

    test('should handle empty input', () => {
      expect(sanitizer.isSafe('')).toBe(true);
      expect(sanitizer.isSafe(null)).toBe(true);
    });
  });

  describe('Sanitization Profiles', () => {
    test('should use strict profile', () => {
      const html = '<p>Text</p><strong>Bold</strong>';
      const clean = sanitizer.sanitizeHTML(html, { profile: 'strict' });
      
      // Strict profile removes all HTML
      expect(clean).not.toContain('<p>');
      expect(clean).toContain('Text');
    });

    test('should use default profile', () => {
      const html = '<p>Text</p>';
      const clean = sanitizer.sanitizeHTML(html, { profile: 'default' });
      
      expect(clean).toContain('<p>');
    });

    test('should use permissive profile', () => {
      const html = '<p>Text</p><details><summary>More</summary></details>';
      const clean = sanitizer.sanitizeHTML(html, { profile: 'permissive' });
      
      expect(clean).toContain('<p>');
      expect(clean).toContain('<details>');
    });
  });

  describe('Statistics Tracking', () => {
    test('should track total sanitizations', () => {
      const initial = sanitizer.stats.totalSanitizations;
      
      sanitizer.sanitizeHTML('<p>Test 1</p>');
      sanitizer.sanitizeHTML('<p>Test 2</p>');
      
      expect(sanitizer.stats.totalSanitizations).toBe(initial + 2);
    });

    test('should track sanitizations by profile', () => {
      sanitizer.sanitizeHTML('<p>Test</p>', { profile: 'strict' });
      sanitizer.sanitizeHTML('<p>Test</p>', { profile: 'default' });
      
      const stats = sanitizer.getStats();
      expect(stats.byProfile.strict).toBeGreaterThanOrEqual(1);
      expect(stats.byProfile.default).toBeGreaterThanOrEqual(1);
    });

    test('should track violations', () => {
      const initial = sanitizer.stats.violations;
      
      sanitizer.sanitizeURL('javascript:alert(1)');
      
      expect(sanitizer.stats.violations).toBe(initial + 1);
    });

    test('should get statistics', () => {
      sanitizer.sanitizeHTML('<p>Test</p>');
      
      const stats = sanitizer.getStats();
      expect(stats).toBeDefined();
      expect(stats.totalSanitizations).toBeGreaterThan(0);
      expect(stats.byProfile).toBeDefined();
    });

    test('should reset statistics', () => {
      sanitizer.sanitizeHTML('<p>Test</p>');
      expect(sanitizer.stats.totalSanitizations).toBeGreaterThan(0);
      
      sanitizer.resetStats();
      expect(sanitizer.stats.totalSanitizations).toBe(0);
      expect(sanitizer.stats.violations).toBe(0);
    });
  });

  describe('DOMPurify Integration', () => {
    test('should check DOMPurify availability', () => {
      const hasDOMPurify = sanitizer.hasDOMPurify();
      expect(typeof hasDOMPurify).toBe('boolean');
    });

    test('should fallback to escaping if DOMPurify unavailable', () => {
      const html = '<script>alert(1)</script>';
      const clean = sanitizer.sanitizeHTML(html);
      
      // Should either use DOMPurify or escape
      expect(clean).not.toContain('<script>');
    });
  });

  describe('XSS Protection', () => {
    const xssPayloads = [
      '<script>alert("XSS")</script>',
      '<img src=x onerror=alert(1)>',
      '<svg onload=alert(1)>',
      '<iframe src="javascript:alert(1)">',
      '<object data="javascript:alert(1)">',
      '<embed src="javascript:alert(1)">',
      '<a href="javascript:alert(1)">Click</a>',
      '<form action="javascript:alert(1)">',
      '<input onfocus=alert(1) autofocus>',
      '<select onfocus=alert(1) autofocus>',
      '<textarea onfocus=alert(1) autofocus>',
      '<button onclick=alert(1)>Click</button>',
      '<body onload=alert(1)>',
      '<marquee onstart=alert(1)>',
      '<details open ontoggle=alert(1)>',
    ];

    xssPayloads.forEach((payload, index) => {
      test(`should block XSS payload ${index + 1}`, () => {
        const clean = sanitizer.sanitizeHTML(payload);
        
        // Should not contain alert or other dangerous patterns
        expect(clean).not.toMatch(/alert\s*\(/i);
        expect(clean).not.toMatch(/javascript:/i);
        expect(clean).not.toMatch(/on\w+=/i); // event handlers
      });
    });
  });

  describe('Profiles Export', () => {
    test('should export sanitization profiles', () => {
      expect(PROFILES).toBeDefined();
      expect(PROFILES.strict).toBeDefined();
      expect(PROFILES.default).toBeDefined();
      expect(PROFILES.permissive).toBeDefined();
    });

    test('should freeze profiles', () => {
      expect(Object.isFrozen(PROFILES)).toBe(true);
    });

    test('strict profile should have no allowed tags', () => {
      expect(PROFILES.strict.ALLOWED_TAGS).toEqual([]);
    });

    test('default profile should have safe tags', () => {
      expect(PROFILES.default.ALLOWED_TAGS).toContain('p');
      expect(PROFILES.default.ALLOWED_TAGS).toContain('strong');
      expect(PROFILES.default.ALLOWED_TAGS).not.toContain('script');
    });
  });

  describe('Edge Cases', () => {
    test('should handle very long strings', () => {
      const longString = '<p>' + 'a'.repeat(10000) + '</p>';
      const clean = sanitizer.sanitizeHTML(longString);
      
      expect(clean).toBeDefined();
    });

    test('should handle nested HTML', () => {
      const nested = '<div><div><div><p>Deep</p></div></div></div>';
      const clean = sanitizer.sanitizeHTML(nested);
      
      expect(clean).toContain('Deep');
    });

    test('should handle malformed HTML', () => {
      const malformed = '<p>Unclosed<div>Tags';
      const clean = sanitizer.sanitizeHTML(malformed);
      
      expect(clean).toBeDefined();
    });

    test('should handle special characters', () => {
      const special = '<p>&lt;&gt;&amp;&quot;</p>';
      const clean = sanitizer.sanitizeHTML(special);
      
      expect(clean).toBeDefined();
    });
  });
});


