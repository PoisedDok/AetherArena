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

function createContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('HtmlRenderer', () => {
  let HtmlRenderer;
  let renderer;
  let container;
  let mockLog;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';

    // Clear window.sanitizer so fallback is used
    delete window.sanitizer;

    mockLog = createLogger();
    createRendererLogger.mockReturnValue(mockLog);

    // Require fresh after mocks are re-established
    HtmlRenderer = require('../../../src/renderer/artifacts/modules/output/renderers/HtmlRenderer');
    renderer = new HtmlRenderer();
    container = createContainer();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('defaults safeMode to true', () => {
      const r = new HtmlRenderer();
      expect(r.safeMode).toBe(true);
    });

    it('defaults allowScripts to false', () => {
      const r = new HtmlRenderer();
      expect(r.allowScripts).toBe(false);
    });

    it('respects safeMode: false option', () => {
      const r = new HtmlRenderer({ safeMode: false });
      expect(r.safeMode).toBe(false);
    });

    it('respects allowScripts: true option', () => {
      const r = new HtmlRenderer({ allowScripts: true });
      expect(r.allowScripts).toBe(true);
    });

    it('initializes sanitizer', () => {
      const r = new HtmlRenderer();
      expect(r.sanitizer).toBeDefined();
      expect(typeof r.sanitizer.sanitizeHTML).toBe('function');
    });

    it('stores options from parent', () => {
      const opts = { theme: 'dark', safeMode: false };
      const r = new HtmlRenderer(opts);
      expect(r.options).toBe(opts);
    });

    it('inherits injectedStyles from BaseRenderer', () => {
      const r = new HtmlRenderer();
      expect(r.injectedStyles).toBeInstanceOf(Set);
      expect(r.injectedStyles.size).toBe(0);
    });
  });

  // =========================================================================
  // render - data extraction
  // =========================================================================

  describe('render - data extraction', () => {
    it('accepts string data', async () => {
      await renderer.render('<p>Hello</p>', container);
      // In safe mode, creates an iframe
      const iframe = container.querySelector('iframe');
      expect(iframe).not.toBeNull();
    });

    it('accepts object with html property', async () => {
      await renderer.render({ html: '<p>From html prop</p>' }, container);
      const iframe = container.querySelector('iframe');
      expect(iframe).not.toBeNull();
    });

    it('accepts object with content property', async () => {
      await renderer.render({ content: '<p>From content prop</p>' }, container);
      const iframe = container.querySelector('iframe');
      expect(iframe).not.toBeNull();
    });

    it('prefers html property over content property', async () => {
      const r = new HtmlRenderer({ safeMode: false });
      await r.render({ html: '<p>html</p>', content: '<p>content</p>' }, container);
      const wrapper = container.querySelector('.html-content-wrapper');
      expect(wrapper.innerHTML).toContain('html');
    });

    it('shows empty message for empty string', async () => {
      await renderer.render('', container);
      const empty = container.querySelector('.render-empty');
      expect(empty).not.toBeNull();
      expect(container.textContent).toContain('No HTML content to display');
    });

    it('shows empty message for whitespace-only string', async () => {
      await renderer.render('   \n\t  ', container);
      const empty = container.querySelector('.render-empty');
      expect(empty).not.toBeNull();
    });

    it('shows empty message for object with empty html', async () => {
      await renderer.render({ html: '' }, container);
      const empty = container.querySelector('.render-empty');
      expect(empty).not.toBeNull();
    });

    it('handles render error by calling handleError', async () => {
      // Passing null data triggers TypeError when accessing data.html
      await renderer.render(null, container);
      const errorEl = container.querySelector('.render-error');
      expect(errorEl).not.toBeNull();
      expect(mockLog.error).toHaveBeenCalledWith(
        '[HtmlRenderer] Render failed:',
        expect.any(Error)
      );
    });
  });

  // =========================================================================
  // render - safe mode (iframe)
  // =========================================================================

  describe('render - safe mode (iframe)', () => {
    it('creates iframe with sandbox attribute', async () => {
      await renderer.render('<p>safe</p>', container);
      const iframe = container.querySelector('iframe');
      expect(iframe).not.toBeNull();
      expect(iframe.getAttribute('sandbox')).toBe(
        'allow-scripts allow-forms allow-modals allow-popups allow-presentation'
      );
    });

    it('creates iframe with srcdoc attribute containing HTML', async () => {
      await renderer.render('<p>test content</p>', container);
      const iframe = container.querySelector('iframe');
      const srcdoc = iframe.getAttribute('srcdoc');
      expect(srcdoc).toContain('<!DOCTYPE html>');
      expect(srcdoc).toContain('test content');
    });

    it('adds container class', async () => {
      await renderer.render('<p>x</p>', container);
      expect(container.classList.contains('html-renderer-container')).toBe(true);
    });

    it('sets iframe className', async () => {
      await renderer.render('<p>x</p>', container);
      const iframe = container.querySelector('iframe');
      expect(iframe.className).toBe('html-renderer-iframe');
    });

    it('clears previous container content', async () => {
      container.innerHTML = '<p>old content</p>';
      await renderer.render('<p>new</p>', container);
      expect(container.querySelector('p')).toBeNull(); // old <p> removed
      expect(container.querySelector('iframe')).not.toBeNull();
    });
  });

  // =========================================================================
  // render - direct mode
  // =========================================================================

  describe('render - direct mode', () => {
    let directRenderer;

    beforeEach(() => {
      directRenderer = new HtmlRenderer({ safeMode: false });
    });

    it('creates a wrapper div instead of iframe', async () => {
      await directRenderer.render('<p>direct</p>', container);
      const wrapper = container.querySelector('.html-content-wrapper');
      expect(wrapper).not.toBeNull();
      expect(container.querySelector('iframe')).toBeNull();
    });

    it('renders sanitized HTML into wrapper', async () => {
      await directRenderer.render('<p>hello</p>', container);
      const wrapper = container.querySelector('.html-content-wrapper');
      expect(wrapper.innerHTML).toContain('<p>hello</p>');
    });

    it('sanitizes script tags in direct mode', async () => {
      await directRenderer.render('<p>safe</p><script>alert(1)</script>', container);
      const wrapper = container.querySelector('.html-content-wrapper');
      expect(wrapper.innerHTML).not.toContain('<script>');
      expect(wrapper.innerHTML).toContain('safe');
    });
  });

  // =========================================================================
  // _fixMalformedHtml
  // =========================================================================

  describe('_fixMalformedHtml', () => {
    it('fixes empty DOCTYPE and wraps with html tag', () => {
      // DOCTYPE fix turns '<!DOCTYPE >' into '<!DOCTYPE html>'
      // Then the wrapping logic sees DOCTYPE without <html> and wraps
      const result = renderer._fixMalformedHtml('<!DOCTYPE >');
      expect(result).toContain('<!DOCTYPE html>');
      expect(result).toContain('<html>');
      expect(result).toContain('</html>');
    });

    it('fixes case-insensitive empty DOCTYPE and wraps', () => {
      const result = renderer._fixMalformedHtml('<!doctype >');
      expect(result).toContain('<!DOCTYPE html>');
      expect(result).toContain('<html>');
    });

    it('fixes empty opening tags surrounded by newlines', () => {
      const result = renderer._fixMalformedHtml('before\n<>\nafter');
      expect(result).toBe('before\n<html>\nafter');
    });

    it('fixes empty closing tags surrounded by newlines', () => {
      const result = renderer._fixMalformedHtml('before\n</>\nafter');
      expect(result).toBe('before\n</html>\nafter');
    });

    it('wraps content after DOCTYPE when no html tag exists', () => {
      const html = '<!DOCTYPE html><head><title>T</title></head>';
      const result = renderer._fixMalformedHtml(html);
      expect(result).toContain('<html>');
      expect(result).toContain('</html>');
    });

    it('does not wrap when html tag already exists', () => {
      const html = '<!DOCTYPE html><html><body>test</body></html>';
      const result = renderer._fixMalformedHtml(html);
      // Should not double-wrap
      const htmlTagCount = (result.match(/<html>/g) || []).length;
      expect(htmlTagCount).toBe(1);
    });

    it('passes through normal HTML unchanged', () => {
      const html = '<div><p>hello</p></div>';
      const result = renderer._fixMalformedHtml(html);
      expect(result).toBe(html);
    });

    it('only matches <> when surrounded by newlines (documents limitation)', () => {
      // <> without newlines is NOT fixed
      const html = 'before<>after';
      const result = renderer._fixMalformedHtml(html);
      expect(result).toBe('before<>after');
    });
  });

  // =========================================================================
  // _basicSanitize
  // =========================================================================

  describe('_basicSanitize', () => {
    it('removes script tags when allowScripts is false', () => {
      const result = renderer._basicSanitize('<p>ok</p><script>bad</script>');
      expect(result).toBe('<p>ok</p>');
    });

    it('removes inline event handlers', () => {
      const result = renderer._basicSanitize('<img onclick="alert(1)" src="x">');
      expect(result).not.toContain('onclick');
    });

    it('removes unquoted event handlers', () => {
      const result = renderer._basicSanitize('<img onerror=alert(1) src="x">');
      expect(result).not.toContain('onerror');
    });

    it('preserves HTML when allowScripts is true', () => {
      const r = new HtmlRenderer({ allowScripts: true });
      const html = '<p>ok</p><script>code()</script>';
      const result = r._basicSanitize(html);
      expect(result).toBe(html);
    });

    it('preserves safe HTML', () => {
      const html = '<div class="test"><p>Hello</p></div>';
      const result = renderer._basicSanitize(html);
      expect(result).toBe(html);
    });
  });

  // =========================================================================
  // _loadSanitizer
  // =========================================================================

  describe('_loadSanitizer', () => {
    it('returns SecuritySanitizer-compatible API', () => {
      const r = new HtmlRenderer();
      expect(r.sanitizer).toBeDefined();
      expect(typeof r.sanitizer.sanitizeOutputHtml).toBe('function');
      expect(typeof r.sanitizer.sanitizeHTML).toBe('function');
    });

    it('sanitizeOutputHtml strips scripts in direct mode', () => {
      const r = new HtmlRenderer();
      const result = r.sanitizer.sanitizeOutputHtml('<p>ok</p><script>bad</script>', { mode: 'direct' });
      expect(result).not.toContain('<script>');
      expect(result).toContain('ok');
    });

    it('sanitizeOutputHtml keeps iframe tags in iframe mode', () => {
      const r = new HtmlRenderer();
      const result = r.sanitizer.sanitizeOutputHtml('<iframe src="x"></iframe>', { mode: 'iframe' });
      expect(result).toContain('<iframe');
    });
  });

  // =========================================================================
  // _injectStyles
  // =========================================================================

  describe('_injectStyles', () => {
    it('injects style element with id html-renderer-styles', async () => {
      await renderer.render('<p>trigger style injection</p>', container);
      const style = document.getElementById('html-renderer-styles');
      expect(style).not.toBeNull();
    });

    it('style contains expected CSS classes', async () => {
      await renderer.render('<p>x</p>', container);
      const style = document.getElementById('html-renderer-styles');
      expect(style.textContent).toContain('html-renderer-container');
      expect(style.textContent).toContain('html-renderer-iframe');
      expect(style.textContent).toContain('html-content-wrapper');
    });

    it('does not inject styles twice', async () => {
      await renderer.render('<p>first</p>', container);
      container.innerHTML = '';
      await renderer.render('<p>second</p>', container);
      const styles = document.querySelectorAll('#html-renderer-styles');
      expect(styles.length).toBe(1);
    });
  });

  // =========================================================================
  // _getThemeValue
  // =========================================================================

  describe('_getThemeValue', () => {
    it('returns empty string when CSS variable is not set', () => {
      const result = renderer._getThemeValue('--nonexistent-var');
      expect(result).toBe('');
    });

    it('returns CSS variable value when set on documentElement', () => {
      document.documentElement.style.setProperty('--test-color', '#ff0000');
      const result = renderer._getThemeValue('--test-color');
      expect(result).toBe('#ff0000');
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    it('nulls the sanitizer', () => {
      expect(renderer.sanitizer).not.toBeNull();
      renderer.dispose();
      expect(renderer.sanitizer).toBeNull();
    });

    it('clears injectedStyles from parent', () => {
      renderer.injectedStyles.add('test');
      renderer.dispose();
      expect(renderer.injectedStyles.size).toBe(0);
    });

    it('is idempotent', () => {
      renderer.dispose();
      expect(() => renderer.dispose()).not.toThrow();
    });
  });

  // =========================================================================
  // Integration: sanitization in render pipeline
  // =========================================================================

  describe('sanitization in render pipeline', () => {
    it('sanitizes user-provided script tags in iframe mode', async () => {
      await renderer.render('<p>ok</p><script>alert(1)</script>', container);
      const iframe = container.querySelector('iframe');
      const srcdoc = iframe.getAttribute('srcdoc');
      // User-provided script (alert) must be removed by sanitizer
      expect(srcdoc).not.toContain('alert(1)');
      expect(srcdoc).toContain('ok');
      // The iframe intentionally contains a resize-observer script for auto-height
      expect(srcdoc).toContain('iframe-resize');
      expect(srcdoc).toContain('ResizeObserver');
    });

    it('sanitizes event handlers in iframe mode', async () => {
      await renderer.render('<div onclick="alert(1)">text</div>', container);
      const iframe = container.querySelector('iframe');
      const srcdoc = iframe.getAttribute('srcdoc');
      expect(srcdoc).not.toContain('onclick');
    });

    it('sanitizes javascript: URLs in iframe mode', async () => {
      await renderer.render('<a href="javascript:alert(1)">link</a>', container);
      const iframe = container.querySelector('iframe');
      const srcdoc = iframe.getAttribute('srcdoc');
      expect(srcdoc).not.toContain('javascript:');
    });

    it('uses DOMPurify sanitize in direct mode when available', async () => {
      const mockDOMPurify = {
        sanitize: jest.fn(() => '<p>purified</p>'),
      };
      window.DOMPurify = mockDOMPurify;

      const r = new HtmlRenderer({ safeMode: false });
      await r.render('<p>raw</p>', container);

      expect(mockDOMPurify.sanitize).toHaveBeenCalled();
      const wrapper = container.querySelector('.html-content-wrapper');
      expect(wrapper.innerHTML).toContain('purified');
    });
  });

  // =========================================================================
  // Lifecycle
  // =========================================================================

  describe('lifecycle', () => {
    it('full create-use-dispose-recreate cycle', async () => {
      // Create
      const r = new HtmlRenderer();
      expect(r.sanitizer).not.toBeNull();

      // Use
      await r.render('<p>test</p>', container);
      expect(container.querySelector('iframe')).not.toBeNull();

      // Dispose
      r.dispose();
      expect(r.sanitizer).toBeNull();
      expect(r.injectedStyles.size).toBe(0);

      // Recreate
      const r2 = new HtmlRenderer();
      container.innerHTML = '';
      await r2.render('<p>test2</p>', container);
      expect(container.querySelector('iframe')).not.toBeNull();
    });
  });

  // =========================================================================
  // window assignment
  // =========================================================================

  describe('window assignment', () => {
    it('assigns HtmlRenderer to window', () => {
      expect(window.HtmlRenderer).toBe(HtmlRenderer);
    });
  });
});
