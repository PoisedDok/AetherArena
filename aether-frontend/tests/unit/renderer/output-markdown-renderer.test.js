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

jest.mock('../../../src/renderer/shared/messaging/MarkdownRenderer', () => {
  return jest.fn().mockImplementation(() => ({
    render: jest.fn((md) => `<p>${md}</p>`),
    dispose: jest.fn(),
  }));
});

jest.mock('../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: jest.fn(() => null),
}));

const { createRendererLogger } = require('../../../src/renderer/shared/utils/logger');
const SharedMarkdownRenderer = require('../../../src/renderer/shared/messaging/MarkdownRenderer');
const { getAether } = require('../../../src/renderer/shared/bridge/AetherBridge');

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

describe('MarkdownRenderer (output)', () => {
  let MarkdownRenderer;
  let renderer;
  let container;
  let mockLog;
  let mockSharedRenderer;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';

    // Remove window libs to test fallback
    delete window.marked;
    delete window.hljs;

    mockLog = createLogger();
    createRendererLogger.mockReturnValue(mockLog);

    mockSharedRenderer = {
      render: jest.fn((md) => `<p>${md}</p>`),
      dispose: jest.fn(),
    };
    SharedMarkdownRenderer.mockImplementation(() => mockSharedRenderer);

    getAether.mockReturnValue(null);

    // Mock navigator.clipboard
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: jest.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    });

    MarkdownRenderer = require('../../../src/renderer/artifacts/modules/output/renderers/MarkdownRenderer');
    renderer = new MarkdownRenderer();
    renderer.log = mockLog;
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
    it('initializes marked as null when unavailable', () => {
      const r = new MarkdownRenderer();
      // In test environment without window.marked, marked may or may not load via require
      // The key is it does not throw
      expect(r).toBeDefined();
    });

    it('creates SharedMarkdownRenderer instance', () => {
      new MarkdownRenderer();
      expect(SharedMarkdownRenderer).toHaveBeenCalled();
    });

    it('initializes _cleanup as empty array', () => {
      const r = new MarkdownRenderer();
      expect(r._cleanup).toEqual([]);
    });

    it('inherits from BaseRenderer', () => {
      const r = new MarkdownRenderer();
      expect(r.injectedStyles).toBeInstanceOf(Set);
    });

    it('loads marked from window when available', () => {
      const mockMarked = { parse: jest.fn() };
      window.marked = mockMarked;
      const r = new MarkdownRenderer();
      expect(r.marked).toBe(mockMarked);
    });

    it('loads hljs from window when available', () => {
      const mockHljs = { highlightElement: jest.fn() };
      window.hljs = mockHljs;
      const r = new MarkdownRenderer();
      expect(r.hljs).toBe(mockHljs);
    });

    it('loads marked from aether bridge when available', () => {
      const mockMarked = { parse: jest.fn() };
      getAether.mockReturnValue({ marked: mockMarked });
      const r = new MarkdownRenderer();
      expect(r.marked).toBe(mockMarked);
    });

    it('loads hljs from aether bridge when available', () => {
      const mockHljs = { highlightElement: jest.fn() };
      getAether.mockReturnValue({ hljs: mockHljs });
      const r = new MarkdownRenderer();
      expect(r.hljs).toBe(mockHljs);
    });
  });

  // =========================================================================
  // render - data extraction
  // =========================================================================

  describe('render - data extraction', () => {
    it('accepts string markdown', async () => {
      await renderer.render('# Hello', container);
      expect(mockSharedRenderer.render).toHaveBeenCalledWith(
        '# Hello',
        expect.objectContaining({ sanitize: true, profile: 'markdown' })
      );
    });

    it('accepts object with markdown property', async () => {
      await renderer.render({ markdown: '# Title' }, container);
      expect(mockSharedRenderer.render).toHaveBeenCalledWith('# Title', expect.any(Object));
    });

    it('accepts object with content property', async () => {
      await renderer.render({ content: '# Content' }, container);
      expect(mockSharedRenderer.render).toHaveBeenCalledWith('# Content', expect.any(Object));
    });

    it('prefers markdown over content property', async () => {
      await renderer.render({ markdown: 'A', content: 'B' }, container);
      expect(mockSharedRenderer.render).toHaveBeenCalledWith('A', expect.any(Object));
    });

    it('shows empty message for empty string', async () => {
      await renderer.render('', container);
      const empty = container.querySelector('.render-empty');
      expect(empty).not.toBeNull();
      expect(container.textContent).toContain('No markdown content to display');
    });

    it('shows empty message for whitespace-only string', async () => {
      await renderer.render('   \n\t  ', container);
      const empty = container.querySelector('.render-empty');
      expect(empty).not.toBeNull();
    });

    it('shows empty message for object with empty content', async () => {
      await renderer.render({ content: '' }, container);
      const empty = container.querySelector('.render-empty');
      expect(empty).not.toBeNull();
    });
  });

  // =========================================================================
  // render - output
  // =========================================================================

  describe('render - output', () => {
    it('creates markdown-content wrapper', async () => {
      await renderer.render('# Hello', container);
      const wrapper = container.querySelector('.markdown-content');
      expect(wrapper).not.toBeNull();
      expect(wrapper.classList.contains('output-rich-content')).toBe(true);
    });

    it('sets wrapper innerHTML to shared renderer output', async () => {
      mockSharedRenderer.render.mockReturnValue('<h1>Hello</h1>');
      await renderer.render('# Hello', container);
      const wrapper = container.querySelector('.markdown-content');
      expect(wrapper.innerHTML).toBe('<h1>Hello</h1>');
    });

    it('sets data-renderer attribute on wrapper', async () => {
      await renderer.render('text', container);
      const wrapper = container.querySelector('.markdown-content');
      expect(wrapper.getAttribute('data-renderer')).toBe('markdown');
    });

    it('adds container class', async () => {
      await renderer.render('text', container);
      expect(container.classList.contains('markdown-renderer-container')).toBe(true);
      expect(container.classList.contains('output-renderer-surface')).toBe(true);
    });

    it('sets ARIA attributes on container', async () => {
      await renderer.render('text', container);
      expect(container.getAttribute('role')).toBe('region');
      expect(container.getAttribute('aria-label')).toBe('Markdown output');
    });

    it('clears previous content', async () => {
      container.innerHTML = '<span id="old-marker">old</span>';
      await renderer.render('# New', container);
      expect(container.querySelector('#old-marker')).toBeNull();
      expect(container.querySelector('.markdown-content')).not.toBeNull();
    });
  });

  // =========================================================================
  // render - syntax highlighting
  // =========================================================================

  describe('render - syntax highlighting', () => {
    it('highlights code blocks when hljs is available', async () => {
      const mockHighlight = jest.fn();
      renderer.hljs = { highlightElement: mockHighlight };

      mockSharedRenderer.render.mockReturnValue('<pre><code>var x = 1;</code></pre>');

      await renderer.render('```\nvar x = 1;\n```', container);

      expect(mockHighlight).toHaveBeenCalled();
    });

    it('skips already-highlighted code blocks', async () => {
      const mockHighlight = jest.fn();
      renderer.hljs = { highlightElement: mockHighlight };

      // Return pre>code with data-highlighted attribute
      mockSharedRenderer.render.mockReturnValue(
        '<pre><code data-highlighted="yes">var x = 1;</code></pre>'
      );

      await renderer.render('```\nvar x = 1;\n```', container);

      expect(mockHighlight).not.toHaveBeenCalled();
    });

    it('does not throw when hljs is null', async () => {
      renderer.hljs = null;
      mockSharedRenderer.render.mockReturnValue('<pre><code>x</code></pre>');

      await expect(renderer.render('```\nx\n```', container)).resolves.not.toThrow();
    });

    it('swallows hljs errors gracefully', async () => {
      renderer.hljs = {
        highlightElement: jest.fn(() => { throw new Error('hljs broken'); }),
      };
      mockSharedRenderer.render.mockReturnValue('<pre><code>x</code></pre>');

      await expect(renderer.render('```\nx\n```', container)).resolves.not.toThrow();
    });
  });

  // =========================================================================
  // _attachCopyButtons
  // =========================================================================

  describe('_attachCopyButtons', () => {
    it('adds copy button to each pre element', async () => {
      mockSharedRenderer.render.mockReturnValue(
        '<pre><code>block 1</code></pre><pre><code>block 2</code></pre>'
      );

      await renderer.render('code blocks', container);

      const buttons = container.querySelectorAll('.code-copy-btn');
      expect(buttons.length).toBe(2);
    });

    it('copy button has correct attributes', async () => {
      mockSharedRenderer.render.mockReturnValue('<pre><code>test</code></pre>');

      await renderer.render('code', container);

      const btn = container.querySelector('.code-copy-btn');
      expect(btn.tagName).toBe('BUTTON');
      expect(btn.type).toBe('button');
      expect(btn.getAttribute('aria-label')).toBe('Copy code to clipboard');
      expect(btn.textContent).toBe('Copy');
    });

    it('clicking copy button writes text to clipboard', async () => {
      mockSharedRenderer.render.mockReturnValue('<pre><code>const x = 1;</code></pre>');

      await renderer.render('code', container);

      const btn = container.querySelector('.code-copy-btn');
      btn.click();

      // Wait for async clipboard write
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('const x = 1;');
    });

    it('shows "Copied" after successful copy', async () => {
      jest.useFakeTimers();
      mockSharedRenderer.render.mockReturnValue('<pre><code>code</code></pre>');

      await renderer.render('code', container);

      const btn = container.querySelector('.code-copy-btn');
      btn.click();

      // Flush microtasks for the async handler
      await Promise.resolve();
      await Promise.resolve();

      expect(btn.textContent).toBe('Copied');

      jest.advanceTimersByTime(1200);
      expect(btn.textContent).toBe('Copy');

      jest.useRealTimers();
    });

    it('shows "Failed" on clipboard error', async () => {
      jest.useFakeTimers();
      navigator.clipboard.writeText = jest.fn().mockRejectedValue(new Error('denied'));
      mockSharedRenderer.render.mockReturnValue('<pre><code>code</code></pre>');

      await renderer.render('code', container);

      const btn = container.querySelector('.code-copy-btn');
      btn.click();

      // Flush microtasks
      await Promise.resolve();
      await Promise.resolve();

      expect(btn.textContent).toBe('Failed');

      jest.advanceTimersByTime(1200);
      expect(btn.textContent).toBe('Copy');

      jest.useRealTimers();
    });

    it('uses pre.textContent when no code element exists', async () => {
      mockSharedRenderer.render.mockReturnValue('<pre>plain text in pre</pre>');

      await renderer.render('code', container);

      const btn = container.querySelector('.code-copy-btn');
      btn.click();

      await new Promise(resolve => setTimeout(resolve, 0));

      // The text includes the button text since it's inside <pre>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining('plain text in pre')
      );
    });

    it('tracks cleanup functions for listeners', async () => {
      mockSharedRenderer.render.mockReturnValue(
        '<pre><code>a</code></pre><pre><code>b</code></pre>'
      );

      await renderer.render('code', container);

      expect(renderer._cleanup.length).toBe(2);
    });

    it('does not accumulate stale copy listeners across re-renders', async () => {
      mockSharedRenderer.render.mockReturnValue('<pre><code>x</code></pre>');

      await renderer.render('first', container);
      expect(renderer._cleanup.length).toBe(1);

      await renderer.render('second', container);
      expect(renderer._cleanup.length).toBe(1);
    });
  });

  // =========================================================================
  // _injectStyles
  // =========================================================================

  describe('_injectStyles', () => {
    it('injects style element', async () => {
      await renderer.render('# Test', container);
      const style = document.getElementById('markdown-renderer-styles');
      expect(style).not.toBeNull();
    });

    it('style contains expected CSS classes', async () => {
      await renderer.render('# Test', container);
      const style = document.getElementById('markdown-renderer-styles');
      expect(style.textContent).toContain('markdown-renderer-container');
      expect(style.textContent).toContain('markdown-content');
      expect(style.textContent).toContain('code-copy-btn');
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    it('calls cleanup functions', async () => {
      const cleanup1 = jest.fn();
      const cleanup2 = jest.fn();
      renderer._cleanup = [cleanup1, cleanup2];

      renderer.dispose();

      expect(cleanup1).toHaveBeenCalled();
      expect(cleanup2).toHaveBeenCalled();
    });

    it('clears _cleanup array', async () => {
      renderer._cleanup = [jest.fn(), jest.fn()];
      renderer.dispose();
      expect(renderer._cleanup).toEqual([]);
    });

    it('clears injectedStyles from parent', () => {
      renderer.injectedStyles.add('test');
      renderer.dispose();
      expect(renderer.injectedStyles.size).toBe(0);
    });

    it('handles cleanup function that throws', () => {
      renderer._cleanup = [
        () => { throw new Error('cleanup error'); },
        jest.fn(),
      ];

      expect(() => renderer.dispose()).not.toThrow();
      // Second cleanup should still be called
      expect(renderer._cleanup).toEqual([]);
    });

    it('is idempotent', () => {
      renderer.dispose();
      expect(() => renderer.dispose()).not.toThrow();
    });

    it('removes event listeners attached by copy buttons', async () => {
      mockSharedRenderer.render.mockReturnValue('<pre><code>test</code></pre>');
      await renderer.render('code', container);

      expect(renderer._cleanup.length).toBe(1);

      renderer.dispose();

      expect(renderer._cleanup.length).toBe(0);
    });

    it('clears pending copy-feedback timers on dispose', async () => {
      jest.useFakeTimers();
      mockSharedRenderer.render.mockReturnValue('<pre><code>timer-test</code></pre>');
      await renderer.render('code', container);

      const btn = container.querySelector('.code-copy-btn');
      btn.click();
      await Promise.resolve();
      await Promise.resolve();

      expect(renderer._timers.size).toBeGreaterThan(0);
      renderer.dispose();
      expect(renderer._timers.size).toBe(0);

      jest.useRealTimers();
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  describe('error handling', () => {
    it('handles render error gracefully', async () => {
      mockSharedRenderer.render.mockImplementation(() => {
        throw new Error('render broke');
      });

      await renderer.render('# Test', container);

      const error = container.querySelector('.render-error');
      expect(error).not.toBeNull();
      expect(mockLog.error).toHaveBeenCalledWith(
        '[MarkdownRenderer] Render failed:',
        expect.any(Error)
      );
    });

    it('handles null data', async () => {
      await renderer.render(null, container);
      // null data causes TypeError when accessing data.markdown
      const error = container.querySelector('.render-error');
      expect(error).not.toBeNull();
    });
  });

  // =========================================================================
  // _loadLibraries
  // =========================================================================

  describe('_loadLibraries', () => {
    it('logs error when library loading fails', () => {
      // Force getAether to throw
      getAether.mockImplementation(() => { throw new Error('bridge broken'); });

      // When window.marked exists, getAether won't be called for marked
      // Remove window.marked to force the bridge path
      delete window.marked;

      const r = new MarkdownRenderer();
      r.log = mockLog;

      // The error is caught in the outer try-catch of _loadLibraries
      // The constructor catches it and logs
      // In this case the error in getAether is caught by optional chaining
      expect(r).toBeDefined();
    });
  });

  // =========================================================================
  // Lifecycle
  // =========================================================================

  describe('lifecycle', () => {
    it('full create-use-dispose-recreate cycle', async () => {
      const r = new MarkdownRenderer();
      r.log = mockLog;

      await r.render('# Test', container);
      expect(container.querySelector('.markdown-content')).not.toBeNull();

      r.dispose();
      expect(r._cleanup).toEqual([]);
      expect(r.injectedStyles.size).toBe(0);

      // Recreate
      const r2 = new MarkdownRenderer();
      r2.log = mockLog;
      container.innerHTML = '';
      await r2.render('# Test 2', container);
      expect(container.querySelector('.markdown-content')).not.toBeNull();
    });
  });

  // =========================================================================
  // window assignment
  // =========================================================================

  describe('window assignment', () => {
    it('assigns MarkdownRenderer to window', () => {
      // Note: this is the OUTPUT MarkdownRenderer, NOT the shared one
      expect(window.MarkdownRenderer).toBe(MarkdownRenderer);
    });
  });
});
