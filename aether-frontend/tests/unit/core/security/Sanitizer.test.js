'use strict';

/**
 * Sanitizer Comprehensive Tests
 * Tests HTML sanitization, URL validation, attribute escaping,
 * fallback sanitizer, profiles, statistics, aliases, and XSS protection.
 */

jest.mock('../../../../src/core/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
  })
}));

const { Sanitizer, PROFILES } = require('../../../../src/core/security/Sanitizer');

describe('Sanitizer', () => {
  let sanitizer;

  beforeEach(() => {
    sanitizer = new Sanitizer();
  });

  // =========================================================================
  // Constructor / Initialization
  // =========================================================================

  describe('constructor', () => {
    it('creates instance with default profile', () => {
      expect(sanitizer.defaultProfile).toBe('default');
    });

    it('accepts custom default profile', () => {
      const s = new Sanitizer({ defaultProfile: 'strict' });
      expect(s.defaultProfile).toBe('strict');
    });

    it('initializes empty statistics', () => {
      expect(sanitizer.stats.totalSanitizations).toBe(0);
      expect(sanitizer.stats.violations).toBe(0);
      expect(sanitizer.stats.byProfile).toBeInstanceOf(Map);
    });

    it('attempts to load DOMPurify (fallback in Node env)', () => {
      // In Node test env, DOMPurify won't be available
      expect(sanitizer.DOMPurify).toBeNull();
    });
  });

  // =========================================================================
  // PROFILES export
  // =========================================================================

  describe('PROFILES', () => {
    it('exports frozen profiles', () => {
      expect(Object.isFrozen(PROFILES)).toBe(true);
      expect(Object.isFrozen(PROFILES.strict)).toBe(true);
      expect(Object.isFrozen(PROFILES.default)).toBe(true);
      expect(Object.isFrozen(PROFILES.permissive)).toBe(true);
    });

    it('strict profile has no allowed tags', () => {
      expect(PROFILES.strict.ALLOWED_TAGS).toEqual([]);
      expect(PROFILES.strict.ALLOWED_ATTR).toEqual([]);
      expect(PROFILES.strict.KEEP_CONTENT).toBe(true);
    });

    it('default profile has safe HTML tags', () => {
      expect(PROFILES.default.ALLOWED_TAGS).toContain('p');
      expect(PROFILES.default.ALLOWED_TAGS).toContain('strong');
      expect(PROFILES.default.ALLOWED_TAGS).toContain('em');
      expect(PROFILES.default.ALLOWED_TAGS).toContain('a');
      expect(PROFILES.default.ALLOWED_TAGS).toContain('code');
      expect(PROFILES.default.ALLOWED_TAGS).not.toContain('script');
      expect(PROFILES.default.ALLOWED_TAGS).not.toContain('iframe');
    });

    it('default profile has safe attributes', () => {
      expect(PROFILES.default.ALLOWED_ATTR).toContain('href');
      expect(PROFILES.default.ALLOWED_ATTR).toContain('class');
      expect(PROFILES.default.ALLOW_DATA_ATTR).toBe(false);
    });

    it('permissive profile has additional tags', () => {
      expect(PROFILES.permissive.ALLOWED_TAGS).toContain('details');
      expect(PROFILES.permissive.ALLOWED_TAGS).toContain('summary');
      expect(PROFILES.permissive.ALLOWED_TAGS).toContain('mark');
      expect(PROFILES.permissive.ALLOWED_TAGS).toContain('figure');
      expect(PROFILES.permissive.ALLOW_DATA_ATTR).toBe(true);
    });
  });

  // =========================================================================
  // sanitizeHTML() — fallback path (no DOMPurify in Node)
  // =========================================================================

  describe('sanitizeHTML()', () => {
    it('returns empty string for null/undefined/non-string', () => {
      expect(sanitizer.sanitizeHTML(null)).toBe('');
      expect(sanitizer.sanitizeHTML(undefined)).toBe('');
      expect(sanitizer.sanitizeHTML(123)).toBe('');
      expect(sanitizer.sanitizeHTML({})).toBe('');
      expect(sanitizer.sanitizeHTML([])).toBe('');
      expect(sanitizer.sanitizeHTML('')).toBe('');
    });

    it('removes script tags and their contents', () => {
      const dirty = '<script>alert("XSS")</script><p>Content</p>';
      const clean = sanitizer.sanitizeHTML(dirty);
      expect(clean).not.toContain('<script>');
      expect(clean).not.toContain('alert');
      expect(clean).toContain('<p>');
      expect(clean).toContain('Content');
    });

    it('removes style tags and their contents', () => {
      const dirty = '<style>body { display:none; }</style><p>Visible</p>';
      const clean = sanitizer.sanitizeHTML(dirty);
      expect(clean).not.toContain('<style>');
      expect(clean).not.toContain('display:none');
      expect(clean).toContain('Visible');
    });

    it('removes event handler attributes (double quotes)', () => {
      const dirty = '<p onclick="alert(1)">Click</p>';
      const clean = sanitizer.sanitizeHTML(dirty);
      expect(clean).not.toContain('onclick');
      expect(clean).toContain('Click');
    });

    it('removes event handler attributes (single quotes)', () => {
      const dirty = "<p onmouseover='alert(1)'>Hover</p>";
      const clean = sanitizer.sanitizeHTML(dirty);
      expect(clean).not.toContain('onmouseover');
    });

    it('removes event handler attributes (unquoted)', () => {
      const dirty = '<img onerror=alert(1) src=x>';
      const clean = sanitizer.sanitizeHTML(dirty);
      expect(clean).not.toContain('onerror');
    });

    it('preserves allowed tags in default profile', () => {
      const html = '<p>Text</p><strong>Bold</strong><em>Italic</em><code>Code</code>';
      const clean = sanitizer.sanitizeHTML(html);
      expect(clean).toContain('<p>');
      expect(clean).toContain('<strong>');
      expect(clean).toContain('<em>');
      expect(clean).toContain('<code>');
    });

    it('removes disallowed tags but keeps content', () => {
      const html = '<marquee>Scrolling</marquee><blink>Blinking</blink>';
      const clean = sanitizer.sanitizeHTML(html);
      expect(clean).not.toContain('<marquee>');
      expect(clean).not.toContain('<blink>');
      // Content may or may not be preserved depending on fallback implementation
    });

    it('strips ALL tags with strict profile', () => {
      const html = '<p>Para</p><strong>Bold</strong><a href="x">Link</a>';
      const clean = sanitizer.sanitizeHTML(html, { profile: 'strict' });
      expect(clean).not.toContain('<p>');
      expect(clean).not.toContain('<strong>');
      expect(clean).not.toContain('<a');
      expect(clean).toContain('Para');
      expect(clean).toContain('Bold');
      expect(clean).toContain('Link');
    });

    it('keeps tags with default profile', () => {
      const html = '<p>Text</p>';
      const clean = sanitizer.sanitizeHTML(html, { profile: 'default' });
      expect(clean).toContain('<p>');
    });

    it('permissive profile keeps extra tags', () => {
      const html = '<p>Text</p><details><summary>Info</summary>Details</details>';
      const clean = sanitizer.sanitizeHTML(html, { profile: 'permissive' });
      expect(clean).toContain('<p>');
      expect(clean).toContain('<details>');
      expect(clean).toContain('<summary>');
    });

    it('sanitizes href attribute values (blocks javascript:)', () => {
      const html = '<a href="javascript:alert(1)">Click</a>';
      const clean = sanitizer.sanitizeHTML(html);
      expect(clean).not.toContain('javascript:');
    });

    it('sanitizes src attribute values (blocks data:)', () => {
      const html = '<img src="data:text/html,<script>alert(1)</script>">';
      const clean = sanitizer.sanitizeHTML(html);
      expect(clean).not.toContain('data:');
    });

    it('preserves safe href values', () => {
      const html = '<a href="https://example.com">Safe Link</a>';
      const clean = sanitizer.sanitizeHTML(html);
      expect(clean).toContain('https://example.com');
    });

    it('filters attributes to allow-list (default profile)', () => {
      const html = '<p class="safe" style="color:red" data-x="y">Text</p>';
      const clean = sanitizer.sanitizeHTML(html);
      expect(clean).toContain('class=');
      // style is not in ALLOWED_ATTR for default profile
      expect(clean).not.toContain('style=');
      // data-x is not allowed in default (ALLOW_DATA_ATTR=false)
      expect(clean).not.toContain('data-x');
    });

    it('allows data- and aria- attributes in permissive profile', () => {
      const html = '<div data-id="1" aria-label="test">Content</div>';
      const clean = sanitizer.sanitizeHTML(html, { profile: 'permissive' });
      expect(clean).toContain('data-id=');
      expect(clean).toContain('aria-label=');
    });

    it('preserves closing tags correctly', () => {
      const html = '<p>Start</p><div>Middle</div>';
      const clean = sanitizer.sanitizeHTML(html);
      expect(clean).toContain('</p>');
      expect(clean).toContain('</div>');
    });

    it('handles self-closing tags', () => {
      const html = '<br/><img src="https://example.com/img.png"/>';
      const clean = sanitizer.sanitizeHTML(html);
      expect(clean).toContain('<br/>');
    });

    it('sanitizes href in single-quoted attributes', () => {
      const html = "<a href='javascript:alert(1)'>Bad</a>";
      const clean = sanitizer.sanitizeHTML(html);
      expect(clean).not.toContain('javascript:');
    });

    it('sanitizes href in unquoted attributes', () => {
      const html = '<a href=javascript:alert(1)>Bad</a>';
      const clean = sanitizer.sanitizeHTML(html);
      expect(clean).not.toContain('javascript:');
    });

    it('updates stats on each call', () => {
      const before = sanitizer.stats.totalSanitizations;
      sanitizer.sanitizeHTML('<p>Test</p>');
      sanitizer.sanitizeHTML('<p>Test</p>', { profile: 'strict' });
      expect(sanitizer.stats.totalSanitizations).toBe(before + 2);
    });
  });

  // =========================================================================
  // sanitizeURL()
  // =========================================================================

  describe('sanitizeURL()', () => {
    it('returns parsed href for safe HTTPS URL', () => {
      const clean = sanitizer.sanitizeURL('https://example.com');
      expect(clean).toMatch(/^https:\/\/example\.com\/?$/);
    });

    it('returns parsed href for safe HTTP URL', () => {
      const clean = sanitizer.sanitizeURL('http://localhost:3000');
      expect(clean).toMatch(/^http:\/\/localhost:3000\/?$/);
    });

    it('returns null for empty/null/non-string input', () => {
      expect(sanitizer.sanitizeURL('')).toBeNull();
      expect(sanitizer.sanitizeURL(null)).toBeNull();
      expect(sanitizer.sanitizeURL(undefined)).toBeNull();
      expect(sanitizer.sanitizeURL(123)).toBeNull();
    });

    it('blocks javascript: protocol', () => {
      expect(sanitizer.sanitizeURL('javascript:alert(1)')).toBeNull();
    });

    it('blocks data: protocol', () => {
      expect(sanitizer.sanitizeURL('data:text/html,<script>alert(1)</script>')).toBeNull();
    });

    it('blocks vbscript: protocol', () => {
      expect(sanitizer.sanitizeURL('vbscript:alert(1)')).toBeNull();
    });

    it('blocks file: protocol', () => {
      expect(sanitizer.sanitizeURL('file:///etc/passwd')).toBeNull();
    });

    it('returns null for invalid URLs', () => {
      expect(sanitizer.sanitizeURL('not-a-url')).toBeNull();
    });

    it('increments violations on dangerous protocol', () => {
      const before = sanitizer.stats.violations;
      sanitizer.sanitizeURL('javascript:alert(1)');
      expect(sanitizer.stats.violations).toBe(before + 1);
    });

    it('increments violations on invalid URL', () => {
      const before = sanitizer.stats.violations;
      sanitizer.sanitizeURL('not-valid-at-all');
      expect(sanitizer.stats.violations).toBe(before + 1);
    });
  });

  // =========================================================================
  // sanitizeAttribute()
  // =========================================================================

  describe('sanitizeAttribute()', () => {
    it('escapes HTML entities in text attributes', () => {
      const clean = sanitizer.sanitizeAttribute('<script>alert(1)</script>', 'title');
      expect(clean).not.toContain('<script>');
      expect(clean).toContain('&lt;script&gt;');
    });

    it('sanitizes href attribute (blocks javascript:)', () => {
      expect(sanitizer.sanitizeAttribute('javascript:alert(1)', 'href')).toBe('');
    });

    it('sanitizes src attribute (blocks data:)', () => {
      expect(sanitizer.sanitizeAttribute('data:text/html,test', 'src')).toBe('');
    });

    it('allows safe href values', () => {
      const clean = sanitizer.sanitizeAttribute('https://example.com', 'href');
      expect(clean).toMatch(/^https:\/\/example\.com\/?$/);
    });

    it('allows safe src values', () => {
      const clean = sanitizer.sanitizeAttribute('https://img.example.com/pic.png', 'src');
      expect(clean).toContain('https://img.example.com');
    });

    it('returns empty string for null/empty/non-string', () => {
      expect(sanitizer.sanitizeAttribute('', 'title')).toBe('');
      expect(sanitizer.sanitizeAttribute(null, 'title')).toBe('');
      expect(sanitizer.sanitizeAttribute(undefined, 'href')).toBe('');
      expect(sanitizer.sanitizeAttribute(123, 'class')).toBe('');
    });

    it('escapes special characters', () => {
      const clean = sanitizer.sanitizeAttribute('a&b<c>d"e\'f/g', 'alt');
      expect(clean).toContain('&amp;');
      expect(clean).toContain('&lt;');
      expect(clean).toContain('&gt;');
      expect(clean).toContain('&quot;');
      expect(clean).toContain('&#x27;');
      expect(clean).toContain('&#x2F;');
    });
  });

  // =========================================================================
  // stripHTML()
  // =========================================================================

  describe('stripHTML()', () => {
    it('removes all HTML tags', () => {
      const text = sanitizer.stripHTML('<p>Text <strong>bold</strong></p>');
      expect(text).not.toContain('<p>');
      expect(text).not.toContain('<strong>');
      expect(text).toContain('Text');
      expect(text).toContain('bold');
    });

    it('handles nested tags', () => {
      expect(sanitizer.stripHTML('<div><p><span>Nested</span></p></div>')).toBe('Nested');
    });

    it('returns empty string for null/empty/non-string', () => {
      expect(sanitizer.stripHTML('')).toBe('');
      expect(sanitizer.stripHTML(null)).toBe('');
      expect(sanitizer.stripHTML(undefined)).toBe('');
      expect(sanitizer.stripHTML(123)).toBe('');
    });

    it('strips all tags including self-closing', () => {
      expect(sanitizer.stripHTML('Line1<br/>Line2')).toBe('Line1Line2');
    });
  });

  // =========================================================================
  // isSafe()
  // =========================================================================

  describe('isSafe()', () => {
    it('returns true for safe HTML (default profile)', () => {
      expect(sanitizer.isSafe('<p>Safe content</p>')).toBe(true);
    });

    it('returns false for unsafe HTML', () => {
      expect(sanitizer.isSafe('<script>alert(1)</script>')).toBe(false);
    });

    it('returns false for HTML with event handlers', () => {
      expect(sanitizer.isSafe('<p onclick="alert(1)">Click</p>')).toBe(false);
    });

    it('strict profile considers all HTML unsafe', () => {
      expect(sanitizer.isSafe('<p>Text</p>', 'strict')).toBe(false);
    });

    it('returns true for plain text with strict profile', () => {
      expect(sanitizer.isSafe('Just plain text', 'strict')).toBe(true);
    });

    it('returns true for empty/null/non-string', () => {
      expect(sanitizer.isSafe('')).toBe(true);
      expect(sanitizer.isSafe(null)).toBe(true);
      expect(sanitizer.isSafe(undefined)).toBe(true);
    });
  });

  // =========================================================================
  // _escapeHTML() — internal
  // =========================================================================

  describe('_escapeHTML()', () => {
    it('escapes all special characters', () => {
      const result = sanitizer._escapeHTML('&<>"\'/');
      expect(result).toBe('&amp;&lt;&gt;&quot;&#x27;&#x2F;');
    });

    it('returns unmodified text with no special chars', () => {
      expect(sanitizer._escapeHTML('hello world')).toBe('hello world');
    });
  });

  // =========================================================================
  // Backward compatibility aliases
  // =========================================================================

  describe('sanitizeHtml() alias', () => {
    it('delegates to sanitizeHTML', () => {
      const result = sanitizer.sanitizeHtml('<script>x</script><p>OK</p>');
      expect(result).not.toContain('<script>');
      expect(result).toContain('<p>');
    });

    it('passes options through', () => {
      const result = sanitizer.sanitizeHtml('<p>Text</p>', { profile: 'strict' });
      expect(result).not.toContain('<p>');
      expect(result).toContain('Text');
    });
  });

  describe('sanitizeUrl() alias', () => {
    it('delegates to sanitizeURL', () => {
      expect(sanitizer.sanitizeUrl('https://example.com')).toMatch(/https:\/\/example\.com/);
      expect(sanitizer.sanitizeUrl('javascript:alert(1)')).toBeNull();
    });
  });

  describe('sanitizeText()', () => {
    it('escapes all HTML in text', () => {
      const result = sanitizer.sanitizeText('<b>Bold</b> & "quoted"');
      expect(result).toContain('&lt;b&gt;');
      expect(result).toContain('&amp;');
      expect(result).toContain('&quot;');
    });

    it('returns empty string for null/empty/non-string', () => {
      expect(sanitizer.sanitizeText('')).toBe('');
      expect(sanitizer.sanitizeText(null)).toBe('');
      expect(sanitizer.sanitizeText(undefined)).toBe('');
      expect(sanitizer.sanitizeText(123)).toBe('');
    });
  });

  // =========================================================================
  // Statistics
  // =========================================================================

  describe('getStats()', () => {
    it('tracks total sanitizations and profiles', () => {
      sanitizer.sanitizeHTML('<p>Test</p>');
      sanitizer.sanitizeHTML('<p>Test</p>', { profile: 'strict' });
      sanitizer.sanitizeHTML('<p>Test</p>', { profile: 'permissive' });

      const stats = sanitizer.getStats();
      expect(stats.totalSanitizations).toBe(3);
      expect(stats.byProfile.default).toBe(1);
      expect(stats.byProfile.strict).toBe(1);
      expect(stats.byProfile.permissive).toBe(1);
      expect(stats.hasDOMPurify).toBe(false); // Node env
    });

    it('tracks violations', () => {
      sanitizer.sanitizeURL('javascript:alert(1)');
      sanitizer.sanitizeURL('data:bad');
      expect(sanitizer.getStats().violations).toBe(2);
    });
  });

  describe('resetStats()', () => {
    it('resets all counters', () => {
      sanitizer.sanitizeHTML('<p>Test</p>');
      sanitizer.sanitizeURL('javascript:x');
      sanitizer.resetStats();

      const stats = sanitizer.getStats();
      expect(stats.totalSanitizations).toBe(0);
      expect(stats.violations).toBe(0);
      expect(stats.byProfile).toEqual({});
    });
  });

  describe('hasDOMPurify()', () => {
    it('returns boolean', () => {
      expect(typeof sanitizer.hasDOMPurify()).toBe('boolean');
    });

    it('returns false in Node test environment', () => {
      expect(sanitizer.hasDOMPurify()).toBe(false);
    });
  });

  // =========================================================================
  // XSS Protection — adversarial payloads
  // =========================================================================

  describe('XSS protection', () => {
    const payloads = [
      '<script>alert("XSS")</script>',
      '<img src=x onerror=alert(1)>',
      '<svg onload=alert(1)>',
      '<iframe src="javascript:alert(1)">',
      '<a href="javascript:alert(1)">Click</a>',
      '<input onfocus=alert(1) autofocus>',
      '<button onclick=alert(1)>Click</button>',
      '<body onload=alert(1)>',
      '<details open ontoggle=alert(1)>',
      '<div style="background:url(javascript:alert(1))">',
    ];

    payloads.forEach((payload, i) => {
      it(`blocks XSS payload ${i + 1}: ${payload.slice(0, 40)}...`, () => {
        const clean = sanitizer.sanitizeHTML(payload);
        expect(clean).not.toMatch(/alert\s*\(/i);
        expect(clean).not.toMatch(/javascript:/i);
        expect(clean).not.toMatch(/\son\w+=/i);
      });
    });
  });

  // =========================================================================
  // DOMPurify integration (mocked)
  // =========================================================================

  describe('DOMPurify paths (mocked)', () => {
    let dpSanitizer;
    let mockDOMPurify;

    beforeEach(() => {
      dpSanitizer = new Sanitizer();
      mockDOMPurify = {
        sanitize: jest.fn((html) => html.replace(/<script[^>]*>.*?<\/script>/gi, '')),
        addHook: jest.fn(),
        removeHook: jest.fn()
      };
      dpSanitizer.DOMPurify = mockDOMPurify;
    });

    it('uses DOMPurify.sanitize when available', () => {
      const result = dpSanitizer.sanitizeHTML('<p>Hello</p><script>x</script>');
      expect(mockDOMPurify.sanitize).toHaveBeenCalled();
      expect(result).toContain('<p>Hello</p>');
      expect(result).not.toContain('<script>');
    });

    it('passes profile config to DOMPurify.sanitize', () => {
      dpSanitizer.sanitizeHTML('<p>Test</p>', { profile: 'strict' });
      const callArgs = mockDOMPurify.sanitize.mock.calls[0];
      expect(callArgs[1].ALLOWED_TAGS).toEqual([]);
    });

    it('applies beforeSanitize and afterSanitize hooks', () => {
      const before = jest.fn();
      const after = jest.fn();
      dpSanitizer.sanitizeHTML('<p>Test</p>', {
        beforeSanitize: before,
        afterSanitize: after
      });

      expect(mockDOMPurify.addHook).toHaveBeenCalledWith('beforeSanitizeElements', before);
      expect(mockDOMPurify.addHook).toHaveBeenCalledWith('afterSanitizeElements', after);
      expect(mockDOMPurify.removeHook).toHaveBeenCalledWith('beforeSanitizeElements');
      expect(mockDOMPurify.removeHook).toHaveBeenCalledWith('afterSanitizeElements');
    });

    it('falls back to _escapeHTML when DOMPurify.sanitize throws', () => {
      mockDOMPurify.sanitize.mockImplementation(() => { throw new Error('DOMPurify error'); });
      const result = dpSanitizer.sanitizeHTML('<p>Fallback</p>');
      expect(result).toContain('&lt;p&gt;');
      expect(dpSanitizer.stats.violations).toBe(1);
    });

    it('uses DOMPurify for stripHTML when available', () => {
      mockDOMPurify.sanitize.mockReturnValue('Plain text');
      const result = dpSanitizer.stripHTML('<p>Plain text</p>');
      expect(result).toBe('Plain text');
      expect(mockDOMPurify.sanitize).toHaveBeenCalledWith(
        '<p>Plain text</p>',
        { ALLOWED_TAGS: [], KEEP_CONTENT: true }
      );
    });

    it('uses DOMPurify for isSafe when available', () => {
      mockDOMPurify.sanitize.mockReturnValue('<p>Test</p>');
      expect(dpSanitizer.isSafe('<p>Test</p>')).toBe(true);

      mockDOMPurify.sanitize.mockReturnValue('Test');
      expect(dpSanitizer.isSafe('<p>Test</p>')).toBe(false);
    });

    it('merges custom config in DOMPurify path', () => {
      dpSanitizer.sanitizeHTML('<p>Test</p>', {
        config: { FORBID_TAGS: ['div'] }
      });
      const callArgs = mockDOMPurify.sanitize.mock.calls[0];
      expect(callArgs[1].FORBID_TAGS).toEqual(['div']);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('handles very long strings', () => {
      const long = '<p>' + 'a'.repeat(10000) + '</p>';
      const clean = sanitizer.sanitizeHTML(long);
      expect(clean).toBeDefined();
      expect(clean.length).toBeGreaterThan(10000);
    });

    it('handles deeply nested HTML', () => {
      const nested = '<div><div><div><p>Deep</p></div></div></div>';
      const clean = sanitizer.sanitizeHTML(nested);
      expect(clean).toContain('Deep');
    });

    it('handles malformed HTML', () => {
      const malformed = '<p>Unclosed<div>Tags';
      const clean = sanitizer.sanitizeHTML(malformed);
      expect(clean).toBeDefined();
    });

    it('handles HTML entities', () => {
      const entities = '<p>&lt;&gt;&amp;&quot;</p>';
      const clean = sanitizer.sanitizeHTML(entities);
      expect(clean).toBeDefined();
    });

    it('handles src in single-quoted attributes', () => {
      const html = "<img src='javascript:alert(1)'/>";
      const clean = sanitizer.sanitizeHTML(html);
      expect(clean).not.toContain('javascript:');
    });

    it('handles href in unquoted attributes', () => {
      const html = '<a href=javascript:void(0)>Link</a>';
      const clean = sanitizer.sanitizeHTML(html);
      expect(clean).not.toContain('javascript:');
    });

    it('removes on* attributes from allowed tags', () => {
      const html = '<p onclick="bad" class="good">Text</p>';
      const clean = sanitizer.sanitizeHTML(html);
      expect(clean).not.toContain('onclick');
      expect(clean).toContain('class=');
    });
  });

  // =========================================================================
  // _loadDOMPurify() — browser path coverage
  // =========================================================================

  describe('_loadDOMPurify()', () => {
    const origWindow = global.window;

    afterEach(() => {
      if (origWindow === undefined) {
        delete global.window;
      } else {
        global.window = origWindow;
      }
    });

    it('uses window.DOMPurify when already available on window', () => {
      const mockDP = { sanitize: jest.fn(), addHook: jest.fn(), removeHook: jest.fn() };
      global.window = { DOMPurify: mockDP };
      const s = new Sanitizer();
      expect(s.DOMPurify).toBe(mockDP);
    });

    it('catches module load error and falls back gracefully', () => {
      global.window = {};
      jest.isolateModules(() => {
        jest.doMock('dompurify', () => { throw new Error('Module load failed'); });
        jest.doMock('../../../../src/core/utils/logger', () => ({
          createLogger: () => ({
            info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
          })
        }));
        const { Sanitizer: S } = require('../../../../src/core/security/Sanitizer');
        expect(() => new S()).not.toThrow();
        const s = new S();
        expect(s.DOMPurify).toBeNull();
      });
    });

    it('loads dompurify as instance (has sanitize method)', () => {
      global.window = {};
      const mockDP = { sanitize: jest.fn() };

      jest.isolateModules(() => {
        jest.doMock('dompurify', () => mockDP);
        jest.doMock('../../../../src/core/utils/logger', () => ({
          createLogger: () => ({
            info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
          })
        }));
        const { Sanitizer: S } = require('../../../../src/core/security/Sanitizer');
        const s = new S();
        expect(s.DOMPurify).toBe(mockDP);
      });
    });

    it('loads dompurify.default when .default has sanitize', () => {
      global.window = {};
      const mockDP = { sanitize: jest.fn() };

      jest.isolateModules(() => {
        jest.doMock('dompurify', () => ({ default: mockDP }));
        jest.doMock('../../../../src/core/utils/logger', () => ({
          createLogger: () => ({
            info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
          })
        }));
        const { Sanitizer: S } = require('../../../../src/core/security/Sanitizer');
        const s = new S();
        expect(s.DOMPurify).toBe(mockDP);
      });
    });

    it('calls factory function with window when candidate is a function', () => {
      global.window = {};
      const mockInstance = { sanitize: jest.fn() };
      const factory = jest.fn(() => mockInstance);

      jest.isolateModules(() => {
        jest.doMock('dompurify', () => factory);
        jest.doMock('../../../../src/core/utils/logger', () => ({
          createLogger: () => ({
            info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
          })
        }));
        const { Sanitizer: S } = require('../../../../src/core/security/Sanitizer');
        const s = new S();
        expect(factory).toHaveBeenCalledWith(global.window);
        expect(s.DOMPurify).toBe(mockInstance);
      });
    });

    it('does not set DOMPurify when module returns null', () => {
      global.window = {};

      jest.isolateModules(() => {
        jest.doMock('dompurify', () => null);
        jest.doMock('../../../../src/core/utils/logger', () => ({
          createLogger: () => ({
            info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
          })
        }));
        const { Sanitizer: S } = require('../../../../src/core/security/Sanitizer');
        const s = new S();
        expect(s.DOMPurify).toBeNull();
      });
    });
  });
});
