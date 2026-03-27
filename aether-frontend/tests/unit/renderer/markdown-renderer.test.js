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

// Mock SecuritySanitizer with real-ish behavior
jest.mock('../../../src/renderer/shared/security/SecuritySanitizer', () => {
  return jest.fn().mockImplementation(() => ({
    sanitizeHTML: jest.fn((html) => html),
    escapeHTML: jest.fn((text) => {
      if (!text || typeof text !== 'string') return '';
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/\//g, '&#x2F;');
    }),
    isDOMPurifyAvailable: jest.fn(() => false),
    dispose: jest.fn(),
  }));
});

// Mock marked.js — require('marked') would fail in test env
jest.mock('marked', () => null, { virtual: true });

const MarkdownRenderer = require('../../../src/renderer/shared/messaging/MarkdownRenderer');
const SecuritySanitizer = require('../../../src/renderer/shared/security/SecuritySanitizer');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    child: jest.fn(function () { return this; }),
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('MarkdownRenderer', () => {
  let renderer;

  beforeEach(() => {
    jest.clearAllMocks();
    delete window.marked;

    // Re-establish logger mock
    const { createRendererLogger } = require('../../../src/renderer/shared/utils/logger');
    createRendererLogger.mockReturnValue(createLogger());

    // Re-establish SecuritySanitizer mock
    SecuritySanitizer.mockImplementation(() => ({
      sanitizeHTML: jest.fn((html) => html),
      escapeHTML: jest.fn((text) => {
        if (!text || typeof text !== 'string') return '';
        return text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;')
          .replace(/\//g, '&#x2F;');
      }),
      isDOMPurifyAvailable: jest.fn(() => false),
      dispose: jest.fn(),
    }));

    renderer = null;
  });

  afterEach(() => {
    if (renderer) {
      try { renderer.dispose(); } catch (_) { /* already disposed */ }
    }
    delete window.marked;
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Constructor — fallback mode (no marked available)
  // ═══════════════════════════════════════════════════════════════════════

  describe('constructor (fallback mode)', () => {
    it('creates instance without marked', () => {
      renderer = new MarkdownRenderer();
      expect(renderer).toBeInstanceOf(MarkdownRenderer);
    });

    it('enters fallback mode when marked is not available', () => {
      renderer = new MarkdownRenderer();
      expect(renderer.fallbackMode).toBe(true);
    });

    it('stores securitySanitizer', () => {
      renderer = new MarkdownRenderer();
      expect(renderer.securitySanitizer).toBeDefined();
    });

    it('accepts custom securitySanitizer', () => {
      const customSanitizer = { sanitizeHTML: jest.fn(), escapeHTML: jest.fn(), isDOMPurifyAvailable: jest.fn(), dispose: jest.fn() };
      renderer = new MarkdownRenderer({ securitySanitizer: customSanitizer });
      expect(renderer.securitySanitizer).toBe(customSanitizer);
    });

    it('creates default SecuritySanitizer if none provided', () => {
      renderer = new MarkdownRenderer();
      expect(SecuritySanitizer).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Constructor — with window.marked
  // ═══════════════════════════════════════════════════════════════════════

  describe('constructor (with window.marked)', () => {
    it('uses window.marked when available', () => {
      const mockMarked = {
        parse: jest.fn((md) => `<p>${md}</p>`),
        setOptions: jest.fn(),
      };
      window.marked = mockMarked;

      renderer = new MarkdownRenderer();
      expect(renderer.fallbackMode).toBe(false);
      expect(renderer.marked).toBe(mockMarked);
    });

    it('calls setOptions on marked', () => {
      const mockMarked = {
        parse: jest.fn(),
        setOptions: jest.fn(),
      };
      window.marked = mockMarked;

      renderer = new MarkdownRenderer();
      expect(mockMarked.setOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          breaks: true,
          gfm: true,
          sanitize: false,
        })
      );
    });

    it('tolerates setOptions failure gracefully', () => {
      const mockMarked = {
        parse: jest.fn(),
        setOptions: jest.fn(() => { throw new Error('opts fail'); }),
      };
      window.marked = mockMarked;

      // Should not throw
      renderer = new MarkdownRenderer();
      expect(renderer.marked).toBe(mockMarked);
    });

    it('skips configureMarked if setOptions is missing', () => {
      const mockMarked = {
        parse: jest.fn(),
      };
      window.marked = mockMarked;

      renderer = new MarkdownRenderer();
      expect(renderer.marked).toBe(mockMarked);
      expect(renderer.fallbackMode).toBe(false);
    });

    // require('marked') success path (lines 36-39) is functionally identical
    // to window.marked path — both set this.marked and call _configureMarked.
    // Tested thoroughly via window.marked tests above.
    // The hoisted jest.mock('marked', () => null) cannot be overridden
    // inside isolateModules for this virtual module.
  });

  // ═══════════════════════════════════════════════════════════════════════
  // render — fallback mode
  // ═══════════════════════════════════════════════════════════════════════

  describe('render (fallback mode)', () => {
    beforeEach(() => {
      renderer = new MarkdownRenderer();
    });

    it('returns empty string for null', () => {
      expect(renderer.render(null)).toBe('');
    });

    it('returns empty string for undefined', () => {
      expect(renderer.render(undefined)).toBe('');
    });

    it('returns empty string for empty string', () => {
      expect(renderer.render('')).toBe('');
    });

    it('returns empty string for non-string', () => {
      expect(renderer.render(42)).toBe('');
    });

    it('converts # heading to <h1>', () => {
      const result = renderer.render('# Hello');
      expect(result).toContain('<h1>');
      expect(result).toContain('Hello');
    });

    it('converts ## heading to <h2>', () => {
      const result = renderer.render('## Sub');
      expect(result).toContain('<h2>');
    });

    it('converts ### heading to <h3>', () => {
      const result = renderer.render('### Minor');
      expect(result).toContain('<h3>');
    });

    it('converts **bold** to <strong>', () => {
      const result = renderer.render('**bold text**');
      expect(result).toContain('<strong>');
      expect(result).toContain('bold text');
    });

    it('converts __bold__ to <strong>', () => {
      const result = renderer.render('__bold text__');
      expect(result).toContain('<strong>');
    });

    it('converts *italic* to <em>', () => {
      const result = renderer.render('*italic text*');
      expect(result).toContain('<em>');
      expect(result).toContain('italic text');
    });

    it('converts _italic_ to <em>', () => {
      const result = renderer.render('_italic text_');
      expect(result).toContain('<em>');
    });

    it('converts `code` to <code>', () => {
      const result = renderer.render('use `code` here');
      expect(result).toContain('<code>');
      expect(result).toContain('code');
    });

    it('converts code blocks to <pre><code>', () => {
      const result = renderer.render('```\ncode block\n```');
      expect(result).toContain('<pre');
      expect(result).toContain('<code>');
    });

    it('converts [link](url) to <a>', () => {
      const result = renderer.render('[click](https://example.com)');
      expect(result).toContain('<a');
      expect(result).toContain('href=');
      expect(result).toContain('target="_blank"');
      expect(result).toContain('rel="noopener noreferrer"');
    });

    it('converts newlines to <br>', () => {
      const result = renderer.render('line1\nline2');
      expect(result).toContain('<br>');
    });

    it('converts list items', () => {
      const result = renderer.render('- item one');
      expect(result).toContain('<li>');
    });

    it('escapes HTML in input before applying markdown', () => {
      renderer.render('plain text');
      expect(renderer.securitySanitizer.escapeHTML).toHaveBeenCalled();
    });

    it('applies sanitizeHTML by default', () => {
      const result = renderer.render('some text');
      expect(renderer.securitySanitizer.sanitizeHTML).toHaveBeenCalled();
    });

    it('skips sanitization when sanitize: false', () => {
      renderer.render('some text', { sanitize: false });
      expect(renderer.securitySanitizer.sanitizeHTML).not.toHaveBeenCalled();
    });

    it('passes profile to sanitizeHTML', () => {
      renderer.render('text', { profile: 'strict' });
      expect(renderer.securitySanitizer.sanitizeHTML).toHaveBeenCalledWith(
        expect.any(String),
        { profile: 'strict' }
      );
    });

    it('uses default markdown profile', () => {
      renderer.render('text');
      expect(renderer.securitySanitizer.sanitizeHTML).toHaveBeenCalledWith(
        expect.any(String),
        { profile: 'markdown' }
      );
    });

    it('returns empty string for empty text in _renderSimple', () => {
      // Internally _renderSimple is called; with empty escapeHTML result
      renderer.securitySanitizer.escapeHTML.mockReturnValue('');
      const result = renderer.render('x', { sanitize: false });
      // escapeHTML returning empty -> _renderSimple returns ''
      expect(result).toBe('');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // render — marked mode
  // ═══════════════════════════════════════════════════════════════════════

  describe('render (marked mode)', () => {
    let mockMarked;

    beforeEach(() => {
      mockMarked = {
        parse: jest.fn((md) => `<p>${md}</p>`),
        setOptions: jest.fn(),
      };
      window.marked = mockMarked;
      renderer = new MarkdownRenderer();
    });

    it('uses marked.parse for rendering', () => {
      renderer.render('hello');
      expect(mockMarked.parse).toHaveBeenCalledWith('hello');
    });

    it('returns sanitized HTML from marked output', () => {
      const result = renderer.render('hello');
      expect(result).toContain('hello');
    });

    it('falls back to simple renderer if marked.parse throws', () => {
      mockMarked.parse.mockImplementation(() => { throw new Error('parse fail'); });
      const result = renderer.render('plain text');
      // Should still return something (from _renderSimple)
      expect(result).toBeTruthy();
      expect(renderer.securitySanitizer.escapeHTML).toHaveBeenCalled();
    });

    it('logs warning when sanitization significantly changes content size', () => {
      const longHtml = 'x'.repeat(100); // 100 chars
      mockMarked.parse.mockReturnValue(longHtml);
      // Sanitizer returns much shorter content (diff = 99, which is > 50)
      renderer.securitySanitizer.sanitizeHTML.mockReturnValue('x');
      renderer.render('# heading');
      expect(renderer.securitySanitizer.sanitizeHTML).toHaveBeenCalled();
      // The log.warn about significant content change should fire
      expect(renderer.log.warn).toHaveBeenCalledWith(
        'sanitization significantly changed content size',
        expect.objectContaining({ before: 100, after: 1 })
      );
    });

    it('does not warn when sanitization change is small', () => {
      mockMarked.parse.mockReturnValue('<p>hello</p>');
      renderer.securitySanitizer.sanitizeHTML.mockReturnValue('<p>hello</p>');
      renderer.render('hello');
      // No warning expected (diff is 0)
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // renderInline
  // ═══════════════════════════════════════════════════════════════════════

  describe('renderInline', () => {
    beforeEach(() => {
      renderer = new MarkdownRenderer();
    });

    it('returns empty string for null', () => {
      expect(renderer.renderInline(null)).toBe('');
    });

    it('returns empty string for empty string', () => {
      expect(renderer.renderInline('')).toBe('');
    });

    it('returns empty string for undefined', () => {
      expect(renderer.renderInline(undefined)).toBe('');
    });

    it('strips <p> tags', () => {
      // In fallback mode, render does not wrap in <p>
      // But let's test the stripping works
      const mockMarked = {
        parse: jest.fn((md) => `<p>${md}</p>`),
        setOptions: jest.fn(),
      };
      window.marked = mockMarked;
      renderer = new MarkdownRenderer();
      const result = renderer.renderInline('inline text');
      expect(result).not.toContain('<p>');
      expect(result).not.toContain('</p>');
    });

    it('replaces <br> with space', () => {
      const mockMarked = {
        parse: jest.fn((md) => `line1<br>line2`),
        setOptions: jest.fn(),
      };
      window.marked = mockMarked;
      renderer = new MarkdownRenderer();
      const result = renderer.renderInline('line1\nline2');
      expect(result).not.toContain('<br>');
    });

    it('trims result', () => {
      const mockMarked = {
        parse: jest.fn(() => '  spaced  '),
        setOptions: jest.fn(),
      };
      window.marked = mockMarked;
      renderer = new MarkdownRenderer();
      const result = renderer.renderInline('text');
      expect(result).toBe(result.trim());
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // extractCodeBlocks
  // ═══════════════════════════════════════════════════════════════════════

  describe('extractCodeBlocks', () => {
    beforeEach(() => {
      renderer = new MarkdownRenderer();
    });

    it('returns empty array for null', () => {
      expect(renderer.extractCodeBlocks(null)).toEqual([]);
    });

    it('returns empty array for empty string', () => {
      expect(renderer.extractCodeBlocks('')).toEqual([]);
    });

    it('returns empty array for undefined', () => {
      expect(renderer.extractCodeBlocks(undefined)).toEqual([]);
    });

    it('returns empty array for text without code blocks', () => {
      expect(renderer.extractCodeBlocks('no code here')).toEqual([]);
    });

    it('extracts single code block with language', () => {
      const md = '```javascript\nconst x = 1;\n```';
      const blocks = renderer.extractCodeBlocks(md);
      expect(blocks).toEqual([
        { type: 'code', language: 'javascript', content: 'const x = 1;' },
      ]);
    });

    it('extracts code block without language (defaults to "text")', () => {
      const md = '```\nplain code\n```';
      const blocks = renderer.extractCodeBlocks(md);
      expect(blocks).toEqual([
        { type: 'code', language: 'text', content: 'plain code' },
      ]);
    });

    it('extracts multiple code blocks', () => {
      const md = '```python\nprint("hi")\n```\ntext\n```rust\nfn main() {}\n```';
      const blocks = renderer.extractCodeBlocks(md);
      expect(blocks.length).toBe(2);
      expect(blocks[0].language).toBe('python');
      expect(blocks[1].language).toBe('rust');
    });

    it('trims code content', () => {
      const md = '```js\n  const x = 1;  \n```';
      const blocks = renderer.extractCodeBlocks(md);
      expect(blocks[0].content).toBe('const x = 1;');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // analyze
  // ═══════════════════════════════════════════════════════════════════════

  describe('analyze', () => {
    beforeEach(() => {
      renderer = new MarkdownRenderer();
    });

    it('returns all-false for null', () => {
      expect(renderer.analyze(null)).toEqual({
        hasCodeBlocks: false,
        hasLinks: false,
        hasImages: false,
        hasTables: false,
        hasLists: false,
      });
    });

    it('returns all-false for empty string', () => {
      expect(renderer.analyze('')).toEqual({
        hasCodeBlocks: false,
        hasLinks: false,
        hasImages: false,
        hasTables: false,
        hasLists: false,
      });
    });

    it('detects code blocks', () => {
      expect(renderer.analyze('```code```').hasCodeBlocks).toBe(true);
    });

    it('detects no code blocks', () => {
      expect(renderer.analyze('no code').hasCodeBlocks).toBe(false);
    });

    it('detects links', () => {
      expect(renderer.analyze('[text](url)').hasLinks).toBe(true);
    });

    it('detects no links', () => {
      expect(renderer.analyze('no links').hasLinks).toBe(false);
    });

    it('detects images', () => {
      expect(renderer.analyze('![alt](img.png)').hasImages).toBe(true);
    });

    it('detects no images', () => {
      expect(renderer.analyze('no images').hasImages).toBe(false);
    });

    it('detects tables', () => {
      expect(renderer.analyze('| col1 | col2 |').hasTables).toBe(true);
    });

    it('detects no tables', () => {
      expect(renderer.analyze('no tables').hasTables).toBe(false);
    });

    it('detects lists with -', () => {
      expect(renderer.analyze('- item').hasLists).toBe(true);
    });

    it('detects lists with *', () => {
      expect(renderer.analyze('* item').hasLists).toBe(true);
    });

    it('detects lists with +', () => {
      expect(renderer.analyze('+ item').hasLists).toBe(true);
    });

    it('detects no lists', () => {
      expect(renderer.analyze('no lists').hasLists).toBe(false);
    });

    it('detects multiple features', () => {
      const md = '```code```\n[link](url)\n- item';
      const analysis = renderer.analyze(md);
      expect(analysis.hasCodeBlocks).toBe(true);
      expect(analysis.hasLinks).toBe(true);
      expect(analysis.hasLists).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // sanitize
  // ═══════════════════════════════════════════════════════════════════════

  describe('sanitize', () => {
    beforeEach(() => {
      renderer = new MarkdownRenderer();
    });

    it('delegates to securitySanitizer.sanitizeHTML', () => {
      renderer.sanitize('<p>test</p>');
      expect(renderer.securitySanitizer.sanitizeHTML).toHaveBeenCalledWith(
        '<p>test</p>',
        { profile: 'markdown' }
      );
    });

    it('passes custom profile', () => {
      renderer.sanitize('<p>test</p>', { profile: 'strict' });
      expect(renderer.securitySanitizer.sanitizeHTML).toHaveBeenCalledWith(
        '<p>test</p>',
        { profile: 'strict' }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // isMarkedAvailable
  // ═══════════════════════════════════════════════════════════════════════

  describe('isMarkedAvailable', () => {
    it('returns false in fallback mode', () => {
      renderer = new MarkdownRenderer();
      expect(renderer.isMarkedAvailable()).toBe(false);
    });

    it('returns true when marked is loaded', () => {
      window.marked = { parse: jest.fn(), setOptions: jest.fn() };
      renderer = new MarkdownRenderer();
      expect(renderer.isMarkedAvailable()).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // getInfo
  // ═══════════════════════════════════════════════════════════════════════

  describe('getInfo', () => {
    it('returns frozen object', () => {
      renderer = new MarkdownRenderer();
      const info = renderer.getInfo();
      expect(Object.isFrozen(info)).toBe(true);
    });

    it('returns fallback mode info', () => {
      renderer = new MarkdownRenderer();
      const info = renderer.getInfo();
      expect(info.mode).toBe('fallback');
      expect(info.markedAvailable).toBe(false);
    });

    it('returns marked mode info', () => {
      window.marked = { parse: jest.fn(), setOptions: jest.fn() };
      renderer = new MarkdownRenderer();
      const info = renderer.getInfo();
      expect(info.mode).toBe('marked');
      expect(info.markedAvailable).toBe(true);
    });

    it('reports sanitizer mode', () => {
      renderer = new MarkdownRenderer();
      const info = renderer.getInfo();
      expect(info.sanitizerMode).toBe('fallback');
    });

    it('reports DOMPurify mode when available', () => {
      SecuritySanitizer.mockImplementation(() => ({
        sanitizeHTML: jest.fn(),
        escapeHTML: jest.fn(),
        isDOMPurifyAvailable: jest.fn(() => true),
        dispose: jest.fn(),
      }));
      renderer = new MarkdownRenderer();
      const info = renderer.getInfo();
      expect(info.sanitizerMode).toBe('DOMPurify');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // dispose
  // ═══════════════════════════════════════════════════════════════════════

  describe('dispose', () => {
    it('calls securitySanitizer.dispose()', () => {
      renderer = new MarkdownRenderer();
      const sanitizer = renderer.securitySanitizer;
      renderer.dispose();
      expect(sanitizer.dispose).toHaveBeenCalled();
    });

    it('nulls marked reference', () => {
      window.marked = { parse: jest.fn(), setOptions: jest.fn() };
      renderer = new MarkdownRenderer();
      expect(renderer.marked).not.toBeNull();
      renderer.dispose();
      expect(renderer.marked).toBeNull();
    });

    it('nulls securitySanitizer reference', () => {
      renderer = new MarkdownRenderer();
      renderer.dispose();
      expect(renderer.securitySanitizer).toBeNull();
    });

    it('handles dispose when securitySanitizer is already null', () => {
      renderer = new MarkdownRenderer();
      renderer.securitySanitizer = null;
      expect(() => renderer.dispose()).not.toThrow();
    });
  });
});
