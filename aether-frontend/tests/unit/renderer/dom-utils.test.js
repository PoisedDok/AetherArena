'use strict';

/**
 * DOMUtils Unit Tests
 * ============================================================================
 * Adversarial tests for renderer/shared/utils/dom-utils.js.
 * Covers every exported function with:
 * - Happy path
 * - Null / missing element guards
 * - Error / exception branches
 * - Boundary conditions
 *
 * Test environment: jsdom (via tests/unit/renderer/** match in jest.config.js)
 */

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before require()
// ---------------------------------------------------------------------------

const mockLog = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => mockLog),
}));

const DOMUtils = require('../../../src/renderer/shared/utils/dom-utils');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createElement(tag = 'div', attrs = {}) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v);
  }
  return el;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DOMUtils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = '';
  });

  // =========================================================================
  // Module structure
  // =========================================================================

  describe('module exports', () => {
    it('exports a frozen object', () => {
      expect(Object.isFrozen(DOMUtils)).toBe(true);
    });

    it('exports all expected functions', () => {
      const expected = [
        'query', 'queryAll',
        'addEventListener', 'addEventListeners',
        'hasClass', 'addClass', 'removeClass', 'toggleClass',
        'show', 'hide', 'toggle', 'isVisible',
        'setText', 'clear', 'remove',
        'scrollTo', 'scrollToBottom',
        'getDimensions', 'isInViewport',
        'waitForElement',
        'debounce', 'throttle',
        'raf', 'cancelRaf',
        'copyToClipboard',
      ];
      for (const fn of expected) {
        expect(typeof DOMUtils[fn]).toBe('function');
      }
    });
  });

  // =========================================================================
  // query
  // =========================================================================

  describe('query()', () => {
    it('returns matching element', () => {
      document.body.innerHTML = '<div id="target">hi</div>';
      const el = DOMUtils.query('#target');
      expect(el).not.toBeNull();
      expect(el.textContent).toBe('hi');
    });

    it('returns null when no match', () => {
      expect(DOMUtils.query('#nonexistent')).toBeNull();
    });

    it('uses custom context', () => {
      document.body.innerHTML = '<div id="outer"><span class="inner">found</span></div><span class="inner">other</span>';
      const outer = document.getElementById('outer');
      const result = DOMUtils.query('.inner', outer);
      expect(result.textContent).toBe('found');
    });

    it('returns null on invalid selector (error branch)', () => {
      const result = DOMUtils.query('[[[invalid');
      expect(result).toBeNull();
      expect(mockLog.error).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // queryAll
  // =========================================================================

  describe('queryAll()', () => {
    it('returns array of matching elements', () => {
      document.body.innerHTML = '<div class="item">a</div><div class="item">b</div>';
      const result = DOMUtils.queryAll('.item');
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
    });

    it('returns empty array when no match', () => {
      const result = DOMUtils.queryAll('.missing');
      expect(result).toEqual([]);
    });

    it('uses custom context', () => {
      document.body.innerHTML = '<ul id="list"><li>1</li><li>2</li></ul><li>3</li>';
      const list = document.getElementById('list');
      const result = DOMUtils.queryAll('li', list);
      expect(result.length).toBe(2);
    });

    it('returns empty array on invalid selector', () => {
      const result = DOMUtils.queryAll('[[[bad');
      expect(result).toEqual([]);
      expect(mockLog.error).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // addEventListener
  // =========================================================================

  describe('addEventListener()', () => {
    it('attaches listener and returns cleanup function', () => {
      const el = document.createElement('div');
      const handler = jest.fn();
      const cleanup = DOMUtils.addEventListener(el, 'click', handler);

      el.click();
      expect(handler).toHaveBeenCalledTimes(1);

      // Cleanup removes listener
      cleanup();
      el.click();
      expect(handler).toHaveBeenCalledTimes(1); // still 1
    });

    it('returns noop when element is null', () => {
      const cleanup = DOMUtils.addEventListener(null, 'click', jest.fn());
      expect(typeof cleanup).toBe('function');
      expect(mockLog.warn).toHaveBeenCalled();
      // noop should not throw
      expect(() => cleanup()).not.toThrow();
    });

    it('returns noop when event is empty', () => {
      const el = document.createElement('div');
      const cleanup = DOMUtils.addEventListener(el, '', jest.fn());
      expect(mockLog.warn).toHaveBeenCalled();
      expect(() => cleanup()).not.toThrow();
    });

    it('returns noop when handler is not a function', () => {
      const el = document.createElement('div');
      const cleanup = DOMUtils.addEventListener(el, 'click', 'not-a-fn');
      expect(mockLog.warn).toHaveBeenCalled();
      expect(() => cleanup()).not.toThrow();
    });

    it('returns noop on addEventListener error', () => {
      const el = { addEventListener: jest.fn(() => { throw new Error('fail'); }) };
      const cleanup = DOMUtils.addEventListener(el, 'click', jest.fn());
      expect(mockLog.error).toHaveBeenCalled();
      expect(() => cleanup()).not.toThrow();
    });
  });

  // =========================================================================
  // addEventListeners
  // =========================================================================

  describe('addEventListeners()', () => {
    it('attaches multiple listeners and returns single cleanup', () => {
      const el = document.createElement('div');
      const clickHandler = jest.fn();
      const mouseoverHandler = jest.fn();

      const cleanup = DOMUtils.addEventListeners(el, {
        click: clickHandler,
        mouseover: mouseoverHandler,
      });

      el.click();
      el.dispatchEvent(new Event('mouseover'));
      expect(clickHandler).toHaveBeenCalledTimes(1);
      expect(mouseoverHandler).toHaveBeenCalledTimes(1);

      cleanup();
      el.click();
      el.dispatchEvent(new Event('mouseover'));
      expect(clickHandler).toHaveBeenCalledTimes(1);
      expect(mouseoverHandler).toHaveBeenCalledTimes(1);
    });

    it('returns cleanup even with empty events object', () => {
      const el = document.createElement('div');
      const cleanup = DOMUtils.addEventListeners(el, {});
      expect(typeof cleanup).toBe('function');
      expect(() => cleanup()).not.toThrow();
    });
  });

  // =========================================================================
  // hasClass
  // =========================================================================

  describe('hasClass()', () => {
    it('returns true when class present', () => {
      const el = createElement('div', { className: 'active focus' });
      expect(DOMUtils.hasClass(el, 'active')).toBe(true);
    });

    it('returns false when class absent', () => {
      const el = createElement('div', { className: 'active' });
      expect(DOMUtils.hasClass(el, 'hidden')).toBe(false);
    });

    it('returns false for null element', () => {
      expect(DOMUtils.hasClass(null, 'foo')).toBe(false);
    });

    it('returns false for element without classList', () => {
      expect(DOMUtils.hasClass({}, 'foo')).toBe(false);
    });
  });

  // =========================================================================
  // addClass
  // =========================================================================

  describe('addClass()', () => {
    it('adds single class', () => {
      const el = createElement('div');
      DOMUtils.addClass(el, 'active');
      expect(el.classList.contains('active')).toBe(true);
    });

    it('adds array of classes', () => {
      const el = createElement('div');
      DOMUtils.addClass(el, ['a', 'b', 'c']);
      expect(el.classList.contains('a')).toBe(true);
      expect(el.classList.contains('b')).toBe(true);
      expect(el.classList.contains('c')).toBe(true);
    });

    it('does nothing for null element', () => {
      expect(() => DOMUtils.addClass(null, 'x')).not.toThrow();
    });

    it('logs error on classList failure', () => {
      const el = { classList: { add: jest.fn(() => { throw new Error('fail'); }) } };
      DOMUtils.addClass(el, 'x');
      expect(mockLog.error).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // removeClass
  // =========================================================================

  describe('removeClass()', () => {
    it('removes single class', () => {
      const el = createElement('div', { className: 'a b' });
      DOMUtils.removeClass(el, 'a');
      expect(el.classList.contains('a')).toBe(false);
      expect(el.classList.contains('b')).toBe(true);
    });

    it('removes array of classes', () => {
      const el = createElement('div', { className: 'a b c' });
      DOMUtils.removeClass(el, ['a', 'c']);
      expect(el.classList.contains('a')).toBe(false);
      expect(el.classList.contains('b')).toBe(true);
      expect(el.classList.contains('c')).toBe(false);
    });

    it('does nothing for null element', () => {
      expect(() => DOMUtils.removeClass(null, 'x')).not.toThrow();
    });

    it('logs error on classList failure', () => {
      const el = { classList: { remove: jest.fn(() => { throw new Error('fail'); }) } };
      DOMUtils.removeClass(el, 'x');
      expect(mockLog.error).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // toggleClass
  // =========================================================================

  describe('toggleClass()', () => {
    it('toggles class on', () => {
      const el = createElement('div');
      const result = DOMUtils.toggleClass(el, 'active');
      expect(result).toBe(true);
      expect(el.classList.contains('active')).toBe(true);
    });

    it('toggles class off', () => {
      const el = createElement('div', { className: 'active' });
      const result = DOMUtils.toggleClass(el, 'active');
      expect(result).toBe(false);
      expect(el.classList.contains('active')).toBe(false);
    });

    it('forces class on with force=true', () => {
      const el = createElement('div', { className: 'active' });
      const result = DOMUtils.toggleClass(el, 'active', true);
      expect(result).toBe(true);
      expect(el.classList.contains('active')).toBe(true);
    });

    it('forces class off with force=false', () => {
      const el = createElement('div');
      const result = DOMUtils.toggleClass(el, 'active', false);
      expect(result).toBe(false);
      expect(el.classList.contains('active')).toBe(false);
    });

    it('returns false for null element', () => {
      expect(DOMUtils.toggleClass(null, 'x')).toBe(false);
    });

    it('returns false on error', () => {
      const el = { classList: { toggle: jest.fn(() => { throw new Error(); }) } };
      expect(DOMUtils.toggleClass(el, 'x')).toBe(false);
      expect(mockLog.error).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // show / hide / toggle
  // =========================================================================

  describe('show()', () => {
    it('sets display to block by default', () => {
      const el = createElement('div');
      el.style.display = 'none';
      DOMUtils.show(el);
      expect(el.style.display).toBe('block');
    });

    it('sets custom display value', () => {
      const el = createElement('div');
      DOMUtils.show(el, 'flex');
      expect(el.style.display).toBe('flex');
    });

    it('does nothing for null element', () => {
      expect(() => DOMUtils.show(null)).not.toThrow();
    });
  });

  describe('hide()', () => {
    it('sets display to none', () => {
      const el = createElement('div');
      DOMUtils.hide(el);
      expect(el.style.display).toBe('none');
    });

    it('does nothing for null element', () => {
      expect(() => DOMUtils.hide(null)).not.toThrow();
    });
  });

  describe('toggle()', () => {
    it('hides visible element when no force arg', () => {
      const el = createElement('div');
      el.style.display = 'block';
      DOMUtils.toggle(el);
      expect(el.style.display).toBe('none');
    });

    it('shows hidden element when no force arg', () => {
      const el = createElement('div');
      el.style.display = 'none';
      DOMUtils.toggle(el);
      expect(el.style.display).toBe('block');
    });

    it('forces visible with true', () => {
      const el = createElement('div');
      el.style.display = 'none';
      DOMUtils.toggle(el, true);
      expect(el.style.display).toBe('block');
    });

    it('forces hidden with false', () => {
      const el = createElement('div');
      el.style.display = 'block';
      DOMUtils.toggle(el, false);
      expect(el.style.display).toBe('none');
    });

    it('does nothing for null element', () => {
      expect(() => DOMUtils.toggle(null)).not.toThrow();
    });
  });

  // =========================================================================
  // isVisible
  // =========================================================================

  describe('isVisible()', () => {
    it('returns false for null element', () => {
      expect(DOMUtils.isVisible(null)).toBe(false);
    });

    it('returns false when display is none', () => {
      const el = createElement('div');
      document.body.appendChild(el);
      el.style.display = 'none';
      expect(DOMUtils.isVisible(el)).toBe(false);
    });

    it('returns false when visibility is hidden', () => {
      const el = createElement('div');
      document.body.appendChild(el);
      el.style.visibility = 'hidden';
      expect(DOMUtils.isVisible(el)).toBe(false);
    });

    it('returns false when opacity is 0', () => {
      const el = createElement('div');
      document.body.appendChild(el);
      el.style.opacity = '0';
      expect(DOMUtils.isVisible(el)).toBe(false);
    });

    it('returns true for default visible element', () => {
      const el = createElement('div');
      document.body.appendChild(el);
      // jsdom default: display='', visibility='', opacity='' — all !== guard values
      expect(DOMUtils.isVisible(el)).toBe(true);
    });

    it('returns false on getComputedStyle error', () => {
      // Element not in DOM + broken getComputedStyle
      const origGCS = window.getComputedStyle;
      window.getComputedStyle = jest.fn(() => { throw new Error('fail'); });
      expect(DOMUtils.isVisible(createElement('div'))).toBe(false);
      window.getComputedStyle = origGCS;
    });
  });

  // =========================================================================
  // setText / clear / remove
  // =========================================================================

  describe('setText()', () => {
    it('sets textContent', () => {
      const el = createElement('div');
      DOMUtils.setText(el, 'hello');
      expect(el.textContent).toBe('hello');
    });

    it('escapes HTML entities via textContent', () => {
      const el = createElement('div');
      DOMUtils.setText(el, '<script>alert(1)</script>');
      expect(el.innerHTML).not.toContain('<script>');
      expect(el.textContent).toBe('<script>alert(1)</script>');
    });

    it('does nothing for null element', () => {
      expect(() => DOMUtils.setText(null, 'hi')).not.toThrow();
    });
  });

  describe('clear()', () => {
    it('removes all child nodes via replaceChildren', () => {
      const el = createElement('div');
      el.appendChild(document.createElement('p'));
      el.appendChild(document.createTextNode('text'));
      expect(el.childNodes.length).toBe(2);
      DOMUtils.clear(el);
      expect(el.childNodes.length).toBe(0);
      expect(el.innerHTML).toBe('');
    });

    it('does nothing for null element', () => {
      expect(() => DOMUtils.clear(null)).not.toThrow();
    });
  });

  describe('remove()', () => {
    it('removes element from DOM', () => {
      const el = createElement('div');
      el.id = 'removeme';
      document.body.appendChild(el);
      expect(document.getElementById('removeme')).not.toBeNull();

      DOMUtils.remove(el);
      expect(document.getElementById('removeme')).toBeNull();
    });

    it('does nothing for null element', () => {
      expect(() => DOMUtils.remove(null)).not.toThrow();
    });
  });

  // =========================================================================
  // scrollTo / scrollToBottom
  // =========================================================================

  describe('scrollTo()', () => {
    it('calls scrollIntoView with default options', () => {
      const el = createElement('div');
      el.scrollIntoView = jest.fn();
      DOMUtils.scrollTo(el);
      expect(el.scrollIntoView).toHaveBeenCalledWith({
        behavior: 'smooth',
        block: 'start',
        inline: 'nearest',
      });
    });

    it('passes custom options', () => {
      const el = createElement('div');
      el.scrollIntoView = jest.fn();
      DOMUtils.scrollTo(el, { behavior: 'auto', block: 'center', inline: 'start' });
      expect(el.scrollIntoView).toHaveBeenCalledWith({
        behavior: 'auto',
        block: 'center',
        inline: 'start',
      });
    });

    it('does nothing for null element', () => {
      expect(() => DOMUtils.scrollTo(null)).not.toThrow();
    });

    it('logs error on scrollIntoView failure', () => {
      const el = { scrollIntoView: jest.fn(() => { throw new Error('fail'); }) };
      DOMUtils.scrollTo(el);
      expect(mockLog.error).toHaveBeenCalled();
    });
  });

  describe('scrollToBottom()', () => {
    it('sets scrollTop to scrollHeight', () => {
      const el = createElement('div');
      Object.defineProperty(el, 'scrollHeight', { value: 500, writable: true });
      DOMUtils.scrollToBottom(el);
      expect(el.scrollTop).toBe(500);
    });

    it('does nothing for null element', () => {
      expect(() => DOMUtils.scrollToBottom(null)).not.toThrow();
    });

    it('logs error on failure', () => {
      const el = {};
      Object.defineProperty(el, 'scrollTop', {
        set() { throw new Error('fail'); },
        get() { return 0; },
      });
      Object.defineProperty(el, 'scrollHeight', { value: 100 });
      DOMUtils.scrollToBottom(el);
      expect(mockLog.error).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // getDimensions
  // =========================================================================

  describe('getDimensions()', () => {
    it('returns zeros for null element', () => {
      const dims = DOMUtils.getDimensions(null);
      expect(dims).toEqual({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 });
    });

    it('returns getBoundingClientRect values', () => {
      const el = createElement('div');
      el.getBoundingClientRect = jest.fn(() => ({
        width: 100, height: 50, top: 10, left: 20, right: 120, bottom: 60,
      }));
      const dims = DOMUtils.getDimensions(el);
      expect(dims).toEqual({ width: 100, height: 50, top: 10, left: 20, right: 120, bottom: 60 });
    });

    it('returns zeros on getBoundingClientRect error', () => {
      const el = { getBoundingClientRect: jest.fn(() => { throw new Error('fail'); }) };
      const dims = DOMUtils.getDimensions(el);
      expect(dims).toEqual({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 });
      expect(mockLog.error).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // isInViewport
  // =========================================================================

  describe('isInViewport()', () => {
    it('returns false for null element', () => {
      expect(DOMUtils.isInViewport(null)).toBe(false);
    });

    it('returns true when fully in viewport', () => {
      const el = createElement('div');
      el.getBoundingClientRect = jest.fn(() => ({
        top: 10, left: 10, bottom: 100, right: 100,
      }));
      // Mock window dimensions
      Object.defineProperty(window, 'innerHeight', { value: 768, writable: true, configurable: true });
      Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true, configurable: true });

      expect(DOMUtils.isInViewport(el)).toBe(true);
    });

    it('returns false when element is below viewport', () => {
      const el = createElement('div');
      el.getBoundingClientRect = jest.fn(() => ({
        top: 800, left: 10, bottom: 900, right: 100,
      }));
      Object.defineProperty(window, 'innerHeight', { value: 768, writable: true, configurable: true });
      Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true, configurable: true });

      expect(DOMUtils.isInViewport(el)).toBe(false);
    });

    it('returns false when element is above viewport (negative top)', () => {
      const el = createElement('div');
      el.getBoundingClientRect = jest.fn(() => ({
        top: -100, left: 10, bottom: -50, right: 100,
      }));
      expect(DOMUtils.isInViewport(el)).toBe(false);
    });

    it('returns false when element is to the right of viewport', () => {
      const el = createElement('div');
      el.getBoundingClientRect = jest.fn(() => ({
        top: 10, left: 1100, bottom: 100, right: 1200,
      }));
      Object.defineProperty(window, 'innerHeight', { value: 768, writable: true, configurable: true });
      Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true, configurable: true });

      expect(DOMUtils.isInViewport(el)).toBe(false);
    });

    it('returns false on error', () => {
      const el = { getBoundingClientRect: jest.fn(() => { throw new Error(); }) };
      expect(DOMUtils.isInViewport(el)).toBe(false);
    });
  });

  // =========================================================================
  // waitForElement
  // =========================================================================

  describe('waitForElement()', () => {
    it('resolves immediately if element already exists', async () => {
      document.body.innerHTML = '<div id="exists">here</div>';
      const el = await DOMUtils.waitForElement('#exists');
      expect(el.textContent).toBe('here');
    });

    it('resolves when element appears via DOM mutation', async () => {
      const promise = DOMUtils.waitForElement('#later');

      // Append element after a microtask
      await Promise.resolve();
      const el = document.createElement('div');
      el.id = 'later';
      document.body.appendChild(el);

      const result = await promise;
      expect(result.id).toBe('later');
    });

    it('rejects on timeout when element never appears', async () => {
      await expect(DOMUtils.waitForElement('#never', 50)).rejects.toThrow(
        /not found within 50ms/
      );
    });
  });

  // =========================================================================
  // debounce
  // =========================================================================

  describe('debounce()', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('delays function execution', () => {
      const fn = jest.fn();
      const debounced = DOMUtils.debounce(fn, 100);

      debounced();
      expect(fn).not.toHaveBeenCalled();

      jest.advanceTimersByTime(99);
      expect(fn).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('resets timer on subsequent calls', () => {
      const fn = jest.fn();
      const debounced = DOMUtils.debounce(fn, 100);

      debounced();
      jest.advanceTimersByTime(80);
      debounced(); // resets
      jest.advanceTimersByTime(80);
      expect(fn).not.toHaveBeenCalled();

      jest.advanceTimersByTime(20);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('passes arguments to the original function', () => {
      const fn = jest.fn();
      const debounced = DOMUtils.debounce(fn, 50);

      debounced('a', 'b');
      jest.advanceTimersByTime(50);
      expect(fn).toHaveBeenCalledWith('a', 'b');
    });

    it('uses default 300ms wait', () => {
      const fn = jest.fn();
      const debounced = DOMUtils.debounce(fn);

      debounced();
      jest.advanceTimersByTime(299);
      expect(fn).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // throttle
  // =========================================================================

  describe('throttle()', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('executes immediately on first call', () => {
      const fn = jest.fn();
      const throttled = DOMUtils.throttle(fn, 100);

      throttled();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('blocks subsequent calls within limit', () => {
      const fn = jest.fn();
      const throttled = DOMUtils.throttle(fn, 100);

      throttled();
      throttled();
      throttled();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('allows call after limit expires', () => {
      const fn = jest.fn();
      const throttled = DOMUtils.throttle(fn, 100);

      throttled();
      jest.advanceTimersByTime(100);
      throttled();
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('passes arguments to the original function', () => {
      const fn = jest.fn();
      const throttled = DOMUtils.throttle(fn, 50);

      throttled('x', 'y');
      expect(fn).toHaveBeenCalledWith('x', 'y');
    });

    it('uses default 300ms limit', () => {
      const fn = jest.fn();
      const throttled = DOMUtils.throttle(fn);

      throttled();
      jest.advanceTimersByTime(299);
      throttled();
      expect(fn).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(1);
      throttled();
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // raf / cancelRaf
  // =========================================================================

  describe('raf()', () => {
    it('calls requestAnimationFrame', () => {
      const origRAF = global.requestAnimationFrame;
      global.requestAnimationFrame = jest.fn(() => 42);

      const cb = jest.fn();
      const id = DOMUtils.raf(cb);
      expect(global.requestAnimationFrame).toHaveBeenCalledWith(cb);
      expect(id).toBe(42);

      global.requestAnimationFrame = origRAF;
    });
  });

  describe('cancelRaf()', () => {
    it('calls cancelAnimationFrame', () => {
      const origCAF = global.cancelAnimationFrame;
      global.cancelAnimationFrame = jest.fn();

      DOMUtils.cancelRaf(42);
      expect(global.cancelAnimationFrame).toHaveBeenCalledWith(42);

      global.cancelAnimationFrame = origCAF;
    });
  });

  // =========================================================================
  // copyToClipboard
  // =========================================================================

  describe('copyToClipboard()', () => {
    it('uses navigator.clipboard.writeText when available', async () => {
      const writeText = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        writable: true,
        configurable: true,
      });

      const result = await DOMUtils.copyToClipboard('test text');
      expect(result).toBe(true);
      expect(writeText).toHaveBeenCalledWith('test text');
    });

    it('falls back to execCommand when clipboard API unavailable', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: undefined,
        writable: true,
        configurable: true,
      });

      // Mock execCommand
      document.execCommand = jest.fn(() => true);

      const result = await DOMUtils.copyToClipboard('fallback text');
      expect(result).toBe(true);
      expect(document.execCommand).toHaveBeenCalledWith('copy');
    });

    it('returns false when execCommand fails', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: undefined,
        writable: true,
        configurable: true,
      });
      document.execCommand = jest.fn(() => false);

      const result = await DOMUtils.copyToClipboard('fail');
      expect(result).toBe(false);
    });

    it('returns false and logs error on exception', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: jest.fn().mockRejectedValue(new Error('denied')) },
        writable: true,
        configurable: true,
      });

      const result = await DOMUtils.copyToClipboard('error');
      expect(result).toBe(false);
      expect(mockLog.error).toHaveBeenCalled();
    });
  });
});
