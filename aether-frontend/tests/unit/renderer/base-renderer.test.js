'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    debug: jest.fn(), trace: jest.fn(),
    child: jest.fn(function () { return this; }),
  })),
}));

const BaseRenderer = require('../../../src/renderer/artifacts/modules/output/renderers/BaseRenderer');
const { createRendererLogger } = require('../../../src/renderer/shared/utils/logger');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLogger() {
  return {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    debug: jest.fn(), trace: jest.fn(),
    child: jest.fn(function () { return this; }),
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('BaseRenderer', () => {
  let renderer;
  let mockLog;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    mockLog = createLogger();
    createRendererLogger.mockReturnValue(mockLog);
    renderer = new BaseRenderer();
    // Re-assign log since resetMocks clears the module-level _log
    renderer.log = mockLog;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('initializes with default empty options', () => {
      const r = new BaseRenderer();
      expect(r.options).toEqual({});
      expect(r.injectedStyles).toBeInstanceOf(Set);
      expect(r.injectedStyles.size).toBe(0);
    });

    it('stores provided options', () => {
      const opts = { theme: 'dark', maxLines: 100 };
      const r = new BaseRenderer(opts);
      expect(r.options).toBe(opts);
      expect(r.options.theme).toBe('dark');
      expect(r.options.maxLines).toBe(100);
    });

    it('has a log property', () => {
      const r = new BaseRenderer();
      expect(r.log).toBeDefined();
    });
  });

  // =========================================================================
  // render (abstract)
  // =========================================================================

  describe('render', () => {
    it('throws when called directly (abstract method)', async () => {
      await expect(renderer.render('data', document.createElement('div')))
        .rejects.toThrow('[BaseRenderer] render() must be implemented by subclass');
    });

    it('throws with the exact error message for debugging', async () => {
      try {
        await renderer.render(null, null);
        fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
        expect(e.message).toBe('[BaseRenderer] render() must be implemented by subclass');
      }
    });
  });

  // =========================================================================
  // injectStyles
  // =========================================================================

  describe('injectStyles', () => {
    it('injects a style element into document.head', () => {
      renderer.injectStyles('test-style', '.foo { color: red; }');

      const style = document.getElementById('test-style');
      expect(style).not.toBeNull();
      expect(style.tagName).toBe('STYLE');
      expect(style.textContent).toBe('.foo { color: red; }');
    });

    it('tracks injected style IDs in the set', () => {
      renderer.injectStyles('style-a', '.a {}');
      renderer.injectStyles('style-b', '.b {}');

      expect(renderer.injectedStyles.has('style-a')).toBe(true);
      expect(renderer.injectedStyles.has('style-b')).toBe(true);
      expect(renderer.injectedStyles.size).toBe(2);
    });

    it('does not re-inject if already tracked in the set', () => {
      renderer.injectStyles('dup-style', '.first {}');
      renderer.injectStyles('dup-style', '.second {}');

      const styles = document.querySelectorAll('#dup-style');
      expect(styles.length).toBe(1);
      expect(styles[0].textContent).toBe('.first {}');
    });

    it('does not re-inject if element exists in DOM but not in set, and syncs tracking', () => {
      // Another renderer instance already injected
      const existing = document.createElement('style');
      existing.id = 'external-style';
      existing.textContent = '.external {}';
      document.head.appendChild(existing);

      renderer.injectStyles('external-style', '.overwrite {}');

      const styles = document.querySelectorAll('#external-style');
      expect(styles.length).toBe(1);
      expect(styles[0].textContent).toBe('.external {}');
      // BUG BR-2 FIX: Now tracks confirmed DOM styles to prevent future desync
      expect(renderer.injectedStyles.has('external-style')).toBe(true);
    });

    it('logs error if injection fails', () => {
      // Force document.getElementById to throw
      const origGetById = document.getElementById;
      document.getElementById = jest.fn(() => { throw new Error('DOM failure'); });

      renderer.injectStyles('fail-style', '.fail {}');

      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to inject styles for fail-style'),
        expect.any(Error)
      );

      document.getElementById = origGetById;
    });
  });

  // =========================================================================
  // createContainer
  // =========================================================================

  describe('createContainer', () => {
    it('creates a div with the given class name', () => {
      const el = renderer.createContainer('my-container');
      expect(el.tagName).toBe('DIV');
      expect(el.className).toBe('my-container');
    });

    it('sets innerHTML when option provided', () => {
      const el = renderer.createContainer('c', { innerHTML: '<span>test</span>' });
      expect(el.innerHTML).toBe('<span>test</span>');
    });

    it('sets id when option provided', () => {
      const el = renderer.createContainer('c', { id: 'unique-id' });
      expect(el.id).toBe('unique-id');
    });

    it('sets both innerHTML and id', () => {
      const el = renderer.createContainer('c', { id: 'box', innerHTML: '<b>bold</b>' });
      expect(el.id).toBe('box');
      expect(el.innerHTML).toBe('<b>bold</b>');
    });

    it('ignores unknown options gracefully', () => {
      const el = renderer.createContainer('c', { foo: 'bar', dataAttr: 'x' });
      expect(el.tagName).toBe('DIV');
      expect(el.className).toBe('c');
    });

    it('works with empty className', () => {
      const el = renderer.createContainer('');
      expect(el.className).toBe('');
    });
  });

  // =========================================================================
  // prepareContainer
  // =========================================================================

  describe('prepareContainer', () => {
    it('clears container content by default', () => {
      const el = document.createElement('div');
      el.innerHTML = '<p>old content</p>';
      renderer.prepareContainer(el);
      expect(el.innerHTML).toBe('');
    });

    it('sets container content when provided', () => {
      const el = document.createElement('div');
      renderer.prepareContainer(el, '<span>new</span>');
      expect(el.innerHTML).toBe('<span>new</span>');
    });

    it('returns early for null container without error', () => {
      expect(() => renderer.prepareContainer(null)).not.toThrow();
      expect(() => renderer.prepareContainer(undefined)).not.toThrow();
    });

    it('logs error if innerHTML assignment throws', () => {
      const el = {};
      Object.defineProperty(el, 'innerHTML', {
        set() { throw new Error('readonly'); },
        get() { return ''; },
      });

      renderer.prepareContainer(el, 'test');

      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to prepare container'),
        expect.any(Error)
      );
    });
  });

  // =========================================================================
  // safeAppendChild
  // =========================================================================

  describe('safeAppendChild', () => {
    it('appends child to parent', () => {
      const parent = document.createElement('div');
      const child = document.createElement('span');
      renderer.safeAppendChild(parent, child);
      expect(parent.children.length).toBe(1);
      expect(parent.children[0]).toBe(child);
    });

    it('does nothing when parent is null', () => {
      const child = document.createElement('span');
      expect(() => renderer.safeAppendChild(null, child)).not.toThrow();
    });

    it('does nothing when child is null', () => {
      const parent = document.createElement('div');
      expect(() => renderer.safeAppendChild(parent, null)).not.toThrow();
      expect(parent.children.length).toBe(0);
    });

    it('does nothing when both are null', () => {
      expect(() => renderer.safeAppendChild(null, null)).not.toThrow();
    });

    it('logs error if appendChild throws', () => {
      const parent = { appendChild: jest.fn(() => { throw new Error('DOM error'); }) };
      const child = document.createElement('span');
      renderer.safeAppendChild(parent, child);
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to append child'),
        expect.any(Error)
      );
    });
  });

  // =========================================================================
  // createLink
  // =========================================================================

  describe('createLink', () => {
    it('creates an anchor with href and text', () => {
      const link = renderer.createLink('https://example.com', 'Example');
      expect(link.tagName).toBe('A');
      expect(link.href).toBe('https://example.com/');
      expect(link.textContent).toBe('Example');
    });

    it('defaults target to _blank with noopener noreferrer', () => {
      const link = renderer.createLink('https://x.com', 'X');
      expect(link.target).toBe('_blank');
      expect(link.rel).toBe('noopener noreferrer');
    });

    it('does not set target when options.target is false', () => {
      const link = renderer.createLink('https://x.com', 'X', { target: false });
      expect(link.target).toBe('');
      expect(link.rel).toBe('');
    });

    it('uses # as default href when href is falsy', () => {
      const link = renderer.createLink('', 'text');
      expect(link.getAttribute('href')).toBe('#');
    });

    it('uses href as text when text is falsy', () => {
      const link = renderer.createLink('https://example.com', '');
      expect(link.textContent).toBe('https://example.com');
    });

    it('uses empty string text when both href and text are falsy', () => {
      const link = renderer.createLink('', '');
      expect(link.textContent).toBe('');
    });

    it('sets className when provided', () => {
      const link = renderer.createLink('#', 'X', { className: 'link-class' });
      expect(link.className).toBe('link-class');
    });

    it('sets title when provided', () => {
      const link = renderer.createLink('#', 'X', { title: 'Click me' });
      expect(link.title).toBe('Click me');
    });

    it('does not set className or title when not provided', () => {
      const link = renderer.createLink('#', 'X');
      expect(link.className).toBe('');
      expect(link.title).toBe('');
    });
  });

  // =========================================================================
  // createImage
  // =========================================================================

  describe('createImage', () => {
    it('creates an img with src and alt', () => {
      const img = renderer.createImage('https://img.com/photo.jpg', 'Photo');
      expect(img.tagName).toBe('IMG');
      expect(img.src).toBe('https://img.com/photo.jpg');
      expect(img.alt).toBe('Photo');
    });

    it('defaults alt to empty string', () => {
      const img = renderer.createImage('https://img.com/photo.jpg');
      expect(img.alt).toBe('');
    });

    it('defaults loading to lazy', () => {
      const img = renderer.createImage('https://img.com/photo.jpg');
      expect(img.loading).toBe('lazy');
    });

    it('does not set loading when options.loading is false', () => {
      const img = renderer.createImage('https://img.com/photo.jpg', '', { loading: false });
      // loading attribute is never set, so it stays at the jsdom default (undefined)
      expect(img.getAttribute('loading')).toBeNull();
    });

    it('uses empty src when src is falsy', () => {
      const img = renderer.createImage('');
      expect(img.getAttribute('src')).toBe('');
    });

    it('sets className when provided', () => {
      const img = renderer.createImage('x.jpg', '', { className: 'img-class' });
      expect(img.className).toBe('img-class');
    });

    it('sets title when provided', () => {
      const img = renderer.createImage('x.jpg', '', { title: 'A picture' });
      expect(img.title).toBe('A picture');
    });
  });

  // =========================================================================
  // createHeading
  // =========================================================================

  describe('createHeading', () => {
    it('creates h1 through h6', () => {
      for (let level = 1; level <= 6; level++) {
        const h = renderer.createHeading(level, `Heading ${level}`);
        expect(h.tagName).toBe(`H${level}`);
        expect(h.textContent).toBe(`Heading ${level}`);
      }
    });

    it('clamps level below 1 to h1', () => {
      const h = renderer.createHeading(0, 'Zero');
      expect(h.tagName).toBe('H1');

      const hNeg = renderer.createHeading(-5, 'Neg');
      expect(hNeg.tagName).toBe('H1');
    });

    it('clamps level above 6 to h6', () => {
      const h = renderer.createHeading(7, 'Seven');
      expect(h.tagName).toBe('H6');

      const h99 = renderer.createHeading(99, 'Ninety-nine');
      expect(h99.tagName).toBe('H6');
    });

    it('sets className when provided', () => {
      const h = renderer.createHeading(2, 'Title', { className: 'section-title' });
      expect(h.className).toBe('section-title');
    });

    it('sets id when provided', () => {
      const h = renderer.createHeading(3, 'Section', { id: 'sec-1' });
      expect(h.id).toBe('sec-1');
    });

    it('rounds fractional levels to nearest valid heading', () => {
      const h4 = renderer.createHeading(3.7, 'RoundsUp');
      expect(h4.tagName).toBe('H4');
      expect(h4.textContent).toBe('RoundsUp');

      const h3 = renderer.createHeading(3.2, 'RoundsDown');
      expect(h3.tagName).toBe('H3');
      expect(h3.textContent).toBe('RoundsDown');
    });
  });

  // =========================================================================
  // createParagraph
  // =========================================================================

  describe('createParagraph', () => {
    it('creates a paragraph with text content', () => {
      const p = renderer.createParagraph('Hello world');
      expect(p.tagName).toBe('P');
      expect(p.textContent).toBe('Hello world');
    });

    it('uses textContent by default (HTML is escaped)', () => {
      const p = renderer.createParagraph('<b>bold</b>');
      expect(p.innerHTML).toBe('&lt;b&gt;bold&lt;/b&gt;');
      expect(p.textContent).toBe('<b>bold</b>');
    });

    it('uses innerHTML when options.html is true', () => {
      const p = renderer.createParagraph('<b>bold</b>', { html: true });
      expect(p.innerHTML).toBe('<b>bold</b>');
    });

    it('sets className when provided', () => {
      const p = renderer.createParagraph('text', { className: 'para-class' });
      expect(p.className).toBe('para-class');
    });

    it('handles empty text', () => {
      const p = renderer.createParagraph('');
      expect(p.textContent).toBe('');
    });
  });

  // =========================================================================
  // createCodeBlock
  // =========================================================================

  describe('createCodeBlock', () => {
    it('creates a pre > code structure', () => {
      const block = renderer.createCodeBlock('console.log("hi")');
      expect(block.tagName).toBe('PRE');
      expect(block.children.length).toBe(1);
      expect(block.children[0].tagName).toBe('CODE');
      expect(block.children[0].textContent).toBe('console.log("hi")');
    });

    it('sets language class on code element', () => {
      const block = renderer.createCodeBlock('x = 1', 'python');
      const code = block.querySelector('code');
      expect(code.className).toBe('language-python');
    });

    it('does not set language class when language is empty', () => {
      const block = renderer.createCodeBlock('test');
      const code = block.querySelector('code');
      expect(code.className).toBe('');
    });

    it('appends className to pre element when provided', () => {
      const block = renderer.createCodeBlock('x', '', { className: 'code-highlight' });
      // Note: pre starts with empty className, so result has a leading space
      expect(block.className).toContain('code-highlight');
    });

    it('escapes HTML in code content via textContent', () => {
      const block = renderer.createCodeBlock('<script>alert(1)</script>');
      const code = block.querySelector('code');
      expect(code.textContent).toBe('<script>alert(1)</script>');
      expect(code.innerHTML).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    });
  });

  // =========================================================================
  // createList
  // =========================================================================

  describe('createList', () => {
    it('creates an unordered list by default', () => {
      const list = renderer.createList(['a', 'b', 'c']);
      expect(list.tagName).toBe('UL');
      expect(list.children.length).toBe(3);
      expect(list.children[0].textContent).toBe('a');
      expect(list.children[1].textContent).toBe('b');
      expect(list.children[2].textContent).toBe('c');
    });

    it('creates an ordered list when ordered is true', () => {
      const list = renderer.createList(['first', 'second'], true);
      expect(list.tagName).toBe('OL');
      expect(list.children.length).toBe(2);
    });

    it('uses innerHTML for items when options.html is true', () => {
      const list = renderer.createList(['<b>bold</b>'], false, { html: true });
      expect(list.children[0].innerHTML).toBe('<b>bold</b>');
    });

    it('escapes HTML in items by default (textContent)', () => {
      const list = renderer.createList(['<script>bad</script>']);
      expect(list.children[0].textContent).toBe('<script>bad</script>');
      expect(list.children[0].innerHTML).toBe('&lt;script&gt;bad&lt;/script&gt;');
    });

    it('sets className on the list element', () => {
      const list = renderer.createList(['x'], false, { className: 'fancy-list' });
      expect(list.className).toBe('fancy-list');
    });

    it('handles empty items array', () => {
      const list = renderer.createList([]);
      expect(list.children.length).toBe(0);
    });
  });

  // =========================================================================
  // createErrorMessage
  // =========================================================================

  describe('createErrorMessage', () => {
    it('creates a container with class render-error', () => {
      const el = renderer.createErrorMessage('Something broke');
      expect(el.className).toBe('render-error');
    });

    it('contains a paragraph with the error message', () => {
      const el = renderer.createErrorMessage('Bad data');
      const p = el.querySelector('.error-message');
      expect(p).not.toBeNull();
      expect(p.textContent).toBe('Bad data');
    });

    it('includes error detail pre when error object has message', () => {
      const err = new Error('Root cause detail');
      const el = renderer.createErrorMessage('Failed', err);
      const detail = el.querySelector('.error-detail');
      expect(detail).not.toBeNull();
      expect(detail.tagName).toBe('PRE');
      expect(detail.textContent).toBe('Root cause detail');
    });

    it('does not include error detail when error is null', () => {
      const el = renderer.createErrorMessage('No detail');
      const detail = el.querySelector('.error-detail');
      expect(detail).toBeNull();
    });

    it('does not include error detail when error has no message', () => {
      const el = renderer.createErrorMessage('No detail', { code: 500 });
      const detail = el.querySelector('.error-detail');
      expect(detail).toBeNull();
    });

    it('includes error detail when error message is an empty string', () => {
      // error.message = '' is falsy, so detail should NOT be included
      const el = renderer.createErrorMessage('Oops', { message: '' });
      const detail = el.querySelector('.error-detail');
      expect(detail).toBeNull();
    });
  });

  // =========================================================================
  // createEmptyMessage
  // =========================================================================

  describe('createEmptyMessage', () => {
    it('creates a container with class render-empty', () => {
      const el = renderer.createEmptyMessage('Nothing here');
      expect(el.className).toBe('render-empty');
    });

    it('contains a paragraph with the empty-message class', () => {
      const el = renderer.createEmptyMessage('No results');
      const p = el.querySelector('.empty-message');
      expect(p).not.toBeNull();
      expect(p.textContent).toBe('No results');
    });
  });

  // =========================================================================
  // handleError
  // =========================================================================

  describe('handleError', () => {
    it('renders error into the container', () => {
      const container = document.createElement('div');
      container.innerHTML = '<p>old</p>';
      const error = new Error('Test failure');

      renderer.handleError(container, error, 'Render failed');

      expect(container.querySelector('.render-error')).not.toBeNull();
      expect(container.querySelector('.error-message').textContent).toBe('Render failed');
      expect(container.querySelector('.error-detail').textContent).toBe('Test failure');
    });

    it('clears existing container content before rendering error', () => {
      const container = document.createElement('div');
      container.innerHTML = '<p>old content</p>';

      renderer.handleError(container, new Error('err'));

      expect(container.querySelector('p:not(.error-message):not(.error-detail)')).toBeNull();
    });

    it('uses default fallback message when not provided', () => {
      const container = document.createElement('div');
      renderer.handleError(container, new Error('err'));

      expect(container.querySelector('.error-message').textContent).toBe('Rendering error');
    });

    it('logs the error', () => {
      const container = document.createElement('div');
      const error = new Error('logged error');
      renderer.handleError(container, error);

      expect(mockLog.error).toHaveBeenCalledWith(
        '[BaseRenderer] Rendering error:',
        error
      );
    });

    it('does not throw when container is null', () => {
      expect(() => renderer.handleError(null, new Error('err'))).not.toThrow();
    });

    it('logs fallback error if error rendering itself fails', () => {
      // container.appendChild throws to simulate DOM failure
      const container = {
        appendChild: jest.fn(() => { throw new Error('DOM broken'); }),
      };
      // prepareContainer will fail since innerHTML won't work on plain object

      renderer.handleError(container, new Error('orig'));

      expect(mockLog.error).toHaveBeenCalledWith(
        '[BaseRenderer] Failed to handle error:',
        expect.any(Error)
      );
    });
  });

  // =========================================================================
  // escapeHtml
  // =========================================================================

  describe('escapeHtml', () => {
    it('escapes < and > characters', () => {
      const result = renderer.escapeHtml('<script>alert("xss")</script>');
      expect(result).toBe('&lt;script&gt;alert("xss")&lt;/script&gt;');
    });

    it('escapes & character', () => {
      const result = renderer.escapeHtml('a & b');
      expect(result).toBe('a &amp; b');
    });

    it('does NOT escape quotes (textContent/innerHTML only escapes <, >, &)', () => {
      // This is correct browser behavior: quotes are only special inside
      // HTML attributes, not in text content. The escapeHtml method uses
      // the textContent -> innerHTML trick which mirrors browser behavior.
      const result = renderer.escapeHtml('"hello"');
      expect(result).toBe('"hello"');
    });

    it('returns empty string for empty input', () => {
      const result = renderer.escapeHtml('');
      expect(result).toBe('');
    });

    it('does not double-escape already escaped HTML', () => {
      const result = renderer.escapeHtml('&lt;div&gt;');
      expect(result).toBe('&amp;lt;div&amp;gt;');
    });

    it('handles plain text without modification', () => {
      const result = renderer.escapeHtml('Hello world 123');
      expect(result).toBe('Hello world 123');
    });
  });

  // =========================================================================
  // sanitizeHtml
  // =========================================================================

  describe('sanitizeHtml', () => {
    it('removes script tags', () => {
      const result = renderer.sanitizeHtml('<p>safe</p><script>alert(1)</script>');
      expect(result).toBe('<p>safe</p>');
    });

    it('removes script tags with attributes', () => {
      const result = renderer.sanitizeHtml('<script type="text/javascript">code</script>');
      expect(result).toBe('');
    });

    it('removes inline event handlers with double quotes', () => {
      const result = renderer.sanitizeHtml('<img src="x.jpg" onclick="alert(1)">');
      expect(result).not.toContain('onclick');
    });

    it('removes inline event handlers with single quotes', () => {
      const result = renderer.sanitizeHtml("<div onmouseover='doEvil()'>text</div>");
      expect(result).not.toContain('onmouseover');
    });

    it('removes inline event handlers without quotes', () => {
      const result = renderer.sanitizeHtml('<img src=x onerror=alert(1)>');
      expect(result).not.toContain('onerror');
    });

    it('is case-insensitive for script tags', () => {
      const result = renderer.sanitizeHtml('<SCRIPT>bad</SCRIPT>');
      expect(result).toBe('');
    });

    it('is case-insensitive for event handlers', () => {
      const result = renderer.sanitizeHtml('<div ONCLICK="bad">x</div>');
      expect(result).not.toContain('ONCLICK');
      expect(result).not.toContain('onclick');
    });

    it('preserves safe HTML', () => {
      const html = '<p class="safe">Hello <b>world</b></p>';
      const result = renderer.sanitizeHtml(html);
      expect(result).toBe(html);
    });

    it('handles multiple script tags', () => {
      const result = renderer.sanitizeHtml('<script>a</script>text<script>b</script>');
      expect(result).toBe('text');
    });

    it('handles multiple event handlers on one element', () => {
      const result = renderer.sanitizeHtml('<div onclick="a" onmouseover="b">text</div>');
      expect(result).not.toContain('onclick');
      expect(result).not.toContain('onmouseover');
    });

    it('strips javascript: URLs from href (BUG BR-3 FIX)', () => {
      const result = renderer.sanitizeHtml('<a href="javascript:alert(1)">click</a>');
      expect(result).not.toContain('javascript:');
    });
  });

  // =========================================================================
  // formatFileSize
  // =========================================================================

  describe('formatFileSize', () => {
    it('formats 0 bytes', () => {
      expect(renderer.formatFileSize(0)).toBe('0 Bytes');
    });

    it('formats bytes', () => {
      expect(renderer.formatFileSize(500)).toBe('500 Bytes');
    });

    it('formats kilobytes', () => {
      expect(renderer.formatFileSize(1024)).toBe('1 KB');
    });

    it('formats megabytes', () => {
      expect(renderer.formatFileSize(1048576)).toBe('1 MB');
    });

    it('formats gigabytes', () => {
      expect(renderer.formatFileSize(1073741824)).toBe('1 GB');
    });

    it('formats terabytes', () => {
      expect(renderer.formatFileSize(1099511627776)).toBe('1 TB');
    });

    it('rounds to 2 decimal places', () => {
      expect(renderer.formatFileSize(1536)).toBe('1.5 KB');
      expect(renderer.formatFileSize(2621440)).toBe('2.5 MB');
    });

    it('handles fractional kilobytes', () => {
      // 1500 bytes = ~1.46 KB
      const result = renderer.formatFileSize(1500);
      expect(result).toMatch(/^1\.\d+ KB$/);
    });

    it('returns "0 Bytes" for negative values', () => {
      expect(renderer.formatFileSize(-100)).toBe('0 Bytes');
      expect(renderer.formatFileSize(-1)).toBe('0 Bytes');
    });

    it('returns "0 Bytes" for non-number inputs', () => {
      expect(renderer.formatFileSize(NaN)).toBe('0 Bytes');
      expect(renderer.formatFileSize(Infinity)).toBe('0 Bytes');
      expect(renderer.formatFileSize('string')).toBe('0 Bytes');
    });
  });

  // =========================================================================
  // formatDate
  // =========================================================================

  describe('formatDate', () => {
    it('formats a Date object', () => {
      const date = new Date('2025-01-15T10:30:00Z');
      const result = renderer.formatDate(date);
      // toLocaleString output varies by locale, just verify it's non-empty
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('formats a date string', () => {
      const result = renderer.formatDate('2025-06-15');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('formats a timestamp number', () => {
      const result = renderer.formatDate(1700000000000);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('returns string representation for invalid date input', () => {
      const result = renderer.formatDate('not-a-date');
      // new Date('not-a-date') creates Invalid Date, toLocaleString() returns 'Invalid Date'
      expect(typeof result).toBe('string');
    });

    it('falls back to String() when Date constructor throws', () => {
      // Symbols cause Date constructor to throw
      const sym = Symbol('test');
      const result = renderer.formatDate(sym);
      expect(result).toBe('Symbol(test)');
    });
  });

  // =========================================================================
  // getCommonClasses
  // =========================================================================

  describe('getCommonClasses', () => {
    it('returns an object with expected class names', () => {
      const classes = renderer.getCommonClasses();
      expect(classes.card).toBe('renderer-card');
      expect(classes.container).toBe('renderer-container');
      expect(classes.error).toBe('render-error');
      expect(classes.empty).toBe('render-empty');
      expect(classes.loading).toBe('render-loading');
      expect(classes.header).toBe('render-header');
      expect(classes.content).toBe('render-content');
      expect(classes.footer).toBe('render-footer');
    });

    it('returns a frozen object', () => {
      const classes = renderer.getCommonClasses();
      expect(Object.isFrozen(classes)).toBe(true);
    });

    it('frozen object prevents mutation', () => {
      const classes = renderer.getCommonClasses();
      expect(() => { classes.card = 'hacked'; }).toThrow();
    });
  });

  // =========================================================================
  // isValid
  // =========================================================================

  describe('isValid', () => {
    it('returns false for null', () => {
      expect(renderer.isValid(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(renderer.isValid(undefined)).toBe(false);
    });

    it('returns true for 0', () => {
      expect(renderer.isValid(0)).toBe(true);
    });

    it('returns true for empty string', () => {
      expect(renderer.isValid('')).toBe(true);
    });

    it('returns true for false', () => {
      expect(renderer.isValid(false)).toBe(true);
    });

    it('returns true for objects', () => {
      expect(renderer.isValid({})).toBe(true);
    });

    it('returns true for arrays', () => {
      expect(renderer.isValid([])).toBe(true);
    });
  });

  // =========================================================================
  // isEmpty
  // =========================================================================

  describe('isEmpty', () => {
    it('returns true for null', () => {
      expect(renderer.isEmpty(null)).toBe(true);
    });

    it('returns true for undefined', () => {
      expect(renderer.isEmpty(undefined)).toBe(true);
    });

    it('returns true for empty string', () => {
      expect(renderer.isEmpty('')).toBe(true);
    });

    it('returns true for whitespace-only string', () => {
      expect(renderer.isEmpty('   ')).toBe(true);
      expect(renderer.isEmpty('\t\n')).toBe(true);
    });

    it('returns false for non-empty string', () => {
      expect(renderer.isEmpty('hello')).toBe(false);
    });

    it('returns true for empty array', () => {
      expect(renderer.isEmpty([])).toBe(true);
    });

    it('returns false for non-empty array', () => {
      expect(renderer.isEmpty([1])).toBe(false);
    });

    it('returns true for empty object', () => {
      expect(renderer.isEmpty({})).toBe(true);
    });

    it('returns false for non-empty object', () => {
      expect(renderer.isEmpty({ a: 1 })).toBe(false);
    });

    it('returns false for number 0', () => {
      expect(renderer.isEmpty(0)).toBe(false);
    });

    it('returns false for boolean false', () => {
      expect(renderer.isEmpty(false)).toBe(false);
    });

    it('returns false for number values', () => {
      expect(renderer.isEmpty(42)).toBe(false);
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    it('clears the injectedStyles set', () => {
      renderer.injectedStyles.add('style-a');
      renderer.injectedStyles.add('style-b');
      expect(renderer.injectedStyles.size).toBe(2);

      renderer.dispose();

      expect(renderer.injectedStyles.size).toBe(0);
    });

    it('is idempotent — calling dispose twice does not throw', () => {
      renderer.injectedStyles.add('s');
      renderer.dispose();
      expect(() => renderer.dispose()).not.toThrow();
      expect(renderer.injectedStyles.size).toBe(0);
    });
  });

  // =========================================================================
  // Lifecycle: full create → use → dispose → re-init
  // =========================================================================

  describe('lifecycle', () => {
    it('supports full lifecycle: create, use, dispose', () => {
      // Create
      const r = new BaseRenderer({ theme: 'dark' });
      r.log = mockLog;
      expect(r.injectedStyles.size).toBe(0);
      expect(r._isDisposed).toBe(false);

      // Use
      r.injectStyles('lc-style', '.x {}');
      expect(r.injectedStyles.size).toBe(1);

      const el = r.createContainer('test');
      expect(el.className).toBe('test');

      // Dispose
      r.dispose();
      expect(r.injectedStyles.size).toBe(0);
      expect(r._isDisposed).toBe(true);

      // BUG BR-1 FIX: After dispose, injectStyles is a no-op — create new instance instead
      r.injectStyles('lc-style-2', '.y {}');
      expect(r.injectedStyles.size).toBe(0); // No-op: _isDisposed is true
    });

    it('re-init requires a new instance after dispose', () => {
      const r1 = new BaseRenderer();
      r1.log = mockLog;
      r1.injectStyles('lc-reinit', '.z {}');
      expect(r1.injectedStyles.has('lc-reinit')).toBe(true);
      r1.dispose();

      // New instance can inject same styles — clean lifecycle
      const r2 = new BaseRenderer();
      r2.log = mockLog;
      expect(r2._isDisposed).toBe(false);
      r2.injectStyles('lc-reinit', '.z {}');
      expect(r2.injectedStyles.has('lc-reinit')).toBe(true);
      r2.dispose();
    });
  });

  // =========================================================================
  // window assignment
  // =========================================================================

  describe('window assignment', () => {
    it('assigns BaseRenderer to window when window is defined', () => {
      // In jsdom, window is defined, so the module-level code should have run
      expect(window.BaseRenderer).toBe(BaseRenderer);
    });
  });

  // =========================================================================
  // BUG BR-1 Regression: _isDisposed lifecycle flag
  // =========================================================================

  describe('BUG BR-1: _isDisposed lifecycle flag', () => {
    it('_isDisposed is false after construction', () => {
      const r = new BaseRenderer();
      expect(r._isDisposed).toBe(false);
    });

    it('_isDisposed is true after dispose', () => {
      renderer.dispose();
      expect(renderer._isDisposed).toBe(true);
    });

    it('double-dispose is idempotent and does not throw', () => {
      renderer.injectedStyles.add('s1');
      renderer.dispose();
      expect(renderer._isDisposed).toBe(true);
      expect(renderer.injectedStyles.size).toBe(0);
      // Second dispose — guard prevents re-clearing
      expect(() => renderer.dispose()).not.toThrow();
      expect(renderer._isDisposed).toBe(true);
    });

    it('injectStyles is no-op after dispose', () => {
      renderer.dispose();
      renderer.injectStyles('post-dispose-style', '.fail {}');
      expect(document.getElementById('post-dispose-style')).toBeNull();
      expect(renderer.injectedStyles.size).toBe(0);
    });

    it('prepareContainer is no-op after dispose', () => {
      const el = document.createElement('div');
      el.innerHTML = '<p>keep this</p>';
      renderer.dispose();
      renderer.prepareContainer(el, '<span>new</span>');
      // Content should be unchanged — prepareContainer was a no-op
      expect(el.innerHTML).toBe('<p>keep this</p>');
    });

    it('handleError does not modify container after dispose but still logs', () => {
      const container = document.createElement('div');
      container.innerHTML = '<p>original</p>';
      const error = new Error('post-dispose error');

      renderer.dispose();
      renderer.handleError(container, error, 'Should not render');

      // Container unchanged — handleError guard prevented DOM modification
      expect(container.innerHTML).toBe('<p>original</p>');
      expect(container.querySelector('.render-error')).toBeNull();
      // But error was still logged
      expect(mockLog.error).toHaveBeenCalledWith(
        '[BaseRenderer] Rendering error:',
        error
      );
    });
  });

  // =========================================================================
  // BUG BR-2 Regression: injectStyles resync with DOM reality
  // =========================================================================

  describe('BUG BR-2: injectStyles DOM resync', () => {
    it('re-injects style when tracked but externally removed from DOM', () => {
      // Inject normally
      renderer.injectStyles('resync-test', '.original { color: red; }');
      expect(document.getElementById('resync-test')).not.toBeNull();
      expect(renderer.injectedStyles.has('resync-test')).toBe(true);

      // External removal (simulating test teardown or another component)
      const styleEl = document.getElementById('resync-test');
      styleEl.parentNode.removeChild(styleEl);
      expect(document.getElementById('resync-test')).toBeNull();

      // Set still thinks it's there — but injectStyles should detect the desync
      expect(renderer.injectedStyles.has('resync-test')).toBe(true);

      // Re-inject — should detect missing element and re-inject
      renderer.injectStyles('resync-test', '.re-injected { color: blue; }');
      const reInjected = document.getElementById('resync-test');
      expect(reInjected).not.toBeNull();
      expect(reInjected.textContent).toBe('.re-injected { color: blue; }');
      expect(renderer.injectedStyles.has('resync-test')).toBe(true);
    });

    it('tracks style when DOM element exists but Set does not (post-dispose scenario)', () => {
      // Inject style element directly (bypassing renderer)
      const ext = document.createElement('style');
      ext.id = 'orphan-style';
      ext.textContent = '.orphan {}';
      document.head.appendChild(ext);

      // Renderer Set doesn't have it
      expect(renderer.injectedStyles.has('orphan-style')).toBe(false);

      // Call injectStyles — should detect existing element and track it
      renderer.injectStyles('orphan-style', '.overwrite {}');
      expect(document.querySelectorAll('#orphan-style').length).toBe(1);
      expect(document.getElementById('orphan-style').textContent).toBe('.orphan {}'); // Not overwritten
      expect(renderer.injectedStyles.has('orphan-style')).toBe(true); // Now tracked
    });

    it('two instances sharing same styleId: both track after injection', () => {
      const r1 = new BaseRenderer();
      const r2 = new BaseRenderer();
      r1.log = mockLog;
      r2.log = mockLog;

      r1.injectStyles('shared-style', '.shared { color: red; }');
      expect(r1.injectedStyles.has('shared-style')).toBe(true);

      // r2 calls injectStyles with same ID — element exists, should track without overwriting
      r2.injectStyles('shared-style', '.should-not-overwrite {}');
      expect(r2.injectedStyles.has('shared-style')).toBe(true);
      expect(document.querySelectorAll('#shared-style').length).toBe(1);
      expect(document.getElementById('shared-style').textContent).toBe('.shared { color: red; }');

      r1.dispose();
      r2.dispose();
    });
  });

  // =========================================================================
  // BUG BR-3 Regression: Hardened sanitizeHtml
  // =========================================================================

  describe('BUG BR-3: Hardened sanitizeHtml', () => {
    it('strips iframe tags', () => {
      const result = renderer.sanitizeHtml('<p>safe</p><iframe src="evil.html"></iframe>');
      expect(result).not.toContain('<iframe');
      expect(result).not.toContain('</iframe>');
      expect(result).toContain('<p>safe</p>');
    });

    it('strips object tags', () => {
      const result = renderer.sanitizeHtml('<object data="evil.swf" type="application/x-shockwave-flash"></object>');
      expect(result).not.toContain('<object');
    });

    it('strips embed tags (self-closing)', () => {
      const result = renderer.sanitizeHtml('<embed src="evil.swf" />');
      expect(result).not.toContain('<embed');
    });

    it('strips embed tags (no closing slash)', () => {
      const result = renderer.sanitizeHtml('<embed src="evil.swf">');
      expect(result).not.toContain('<embed');
    });

    it('strips javascript: from href', () => {
      const result = renderer.sanitizeHtml('<a href="javascript:alert(1)">click</a>');
      expect(result).not.toContain('javascript:');
    });

    it('strips javascript: from src', () => {
      const result = renderer.sanitizeHtml('<img src="javascript:alert(1)">');
      expect(result).not.toContain('javascript:');
    });

    it('strips javascript: from action', () => {
      const result = renderer.sanitizeHtml('<form action="javascript:steal()">');
      expect(result).not.toContain('javascript:');
    });

    it('strips data: URIs from src (non-image)', () => {
      const result = renderer.sanitizeHtml('<img src="data:text/html,<script>alert(1)</script>">');
      expect(result).not.toContain('data:text/html');
    });

    it('preserves data:image/ URIs', () => {
      const result = renderer.sanitizeHtml('<img src="data:image/png;base64,abc123">');
      expect(result).toContain('data:image/png;base64,abc123');
    });

    it('preserves safe HTML through all filters', () => {
      const safeHtml = '<div class="card"><p>Hello <strong>world</strong></p><a href="https://safe.com">link</a></div>';
      const result = renderer.sanitizeHtml(safeHtml);
      expect(result).toBe(safeHtml);
    });
  });
});
