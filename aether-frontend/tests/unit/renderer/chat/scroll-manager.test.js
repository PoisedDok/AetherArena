'use strict';

// ---------------------------------------------------------------------------
// ScrollManager.js — Comprehensive unit tests
// ---------------------------------------------------------------------------
// Source: src/renderer/chat/modules/messaging/ui/ScrollManager.js (281 lines)
// Scroll behavior — auto-scroll, sticky-to-bottom, MutationObserver,
// throttled RAF scrolling, EventBus integration.
// ---------------------------------------------------------------------------

// Logger mock: plain noop functions survive resetMocks: true
jest.mock('../../../../src/renderer/shared/utils/logger', () => {
  const noop = () => {};
  const makeLogger = () => {
    const log = {
      info: noop, warn: noop, error: noop,
      debug: noop, trace: noop,
    };
    log.child = () => log;
    return log;
  };
  return { createRendererLogger: makeLogger };
});

const ScrollManager = require('../../../../src/renderer/chat/modules/messaging/ui/ScrollManager');

describe('ScrollManager', () => {
  let contentEl;
  const savedRAF = global.requestAnimationFrame;
  const savedCAF = global.cancelAnimationFrame;

  function createEventBus() {
    const listeners = new Map();
    const cleanupFn = jest.fn();
    return {
      on: jest.fn((event, handler) => {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(handler);
        return cleanupFn;
      }),
      emit: jest.fn((event, data) => {
        const fns = listeners.get(event) || [];
        fns.forEach(h => h(data));
      }),
      off: jest.fn(),
      _cleanup: cleanupFn,
      _listeners: listeners,
    };
  }

  function setupScrollProps(el, scrollTop, scrollHeight, clientHeight) {
    Object.defineProperty(el, 'scrollTop', {
      value: scrollTop, writable: true, configurable: true,
    });
    Object.defineProperty(el, 'scrollHeight', {
      value: scrollHeight, writable: true, configurable: true,
    });
    Object.defineProperty(el, 'clientHeight', {
      value: clientHeight, writable: true, configurable: true,
    });
  }

  function flushRAF() {
    jest.advanceTimersByTime(0);
  }

  beforeEach(() => {
    jest.useFakeTimers();
    document.body.innerHTML = '';

    contentEl = document.createElement('div');
    contentEl.id = 'message-container';
    document.body.appendChild(contentEl);

    // Mock scrollTo (jsdom does not implement Element.scrollTo meaningfully)
    contentEl.scrollTo = jest.fn();

    // Default scroll properties: at bottom (sticky)
    setupScrollProps(contentEl, 500, 1000, 500);

    // rAF/cAF override so fake timers control them
    global.requestAnimationFrame = window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
    global.cancelAnimationFrame = window.cancelAnimationFrame = (id) => clearTimeout(id);
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    global.requestAnimationFrame = window.requestAnimationFrame = savedRAF;
    global.cancelAnimationFrame = window.cancelAnimationFrame = savedCAF;
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('stores contentElement from options', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      expect(mgr.contentElement).toBe(contentEl);
      mgr.dispose();
    });

    it('stores eventBus from options', () => {
      const bus = createEventBus();
      const mgr = new ScrollManager({ contentElement: contentEl, eventBus: bus });
      expect(mgr.eventBus).toBe(bus);
      mgr.dispose();
    });

    it('defaults autoScroll to true', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      expect(mgr.autoScroll).toBe(true);
      mgr.dispose();
    });

    it('accepts autoScroll: false', () => {
      const mgr = new ScrollManager({ contentElement: contentEl, autoScroll: false });
      expect(mgr.autoScroll).toBe(false);
      mgr.dispose();
    });

    it('defaults scrollThreshold to 100', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      expect(mgr._scrollThreshold).toBe(100);
      mgr.dispose();
    });

    it('accepts custom scrollThreshold', () => {
      const mgr = new ScrollManager({ contentElement: contentEl, scrollThreshold: 50 });
      expect(mgr._scrollThreshold).toBe(50);
      mgr.dispose();
    });

    it('defaults smoothScroll to true', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      expect(mgr._smoothScroll).toBe(true);
      mgr.dispose();
    });

    it('accepts smoothScroll: false', () => {
      const mgr = new ScrollManager({ contentElement: contentEl, smoothScroll: false });
      expect(mgr._smoothScroll).toBe(false);
      mgr.dispose();
    });

    it('initializes state correctly', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      expect(mgr._isSticky).toBe(true);
      expect(mgr._userHasScrolledUp).toBe(false);
      expect(mgr._isDisposed).toBe(false);
      mgr.dispose();
    });

    it('throws when contentElement is not provided', () => {
      expect(() => new ScrollManager()).toThrow('[ScrollManager] contentElement is REQUIRED');
    });

    it('throws when contentElement is null', () => {
      expect(() => new ScrollManager({ contentElement: null }))
        .toThrow('[ScrollManager] contentElement is REQUIRED');
    });

    it('sets up scroll listener on contentElement', () => {
      const addSpy = jest.spyOn(contentEl, 'addEventListener');
      const mgr = new ScrollManager({ contentElement: contentEl });

      expect(addSpy).toHaveBeenCalledWith('scroll', expect.any(Function), { passive: true });
      mgr.dispose();
    });

    it('sets up resize listener on window', () => {
      const addSpy = jest.spyOn(window, 'addEventListener');
      const mgr = new ScrollManager({ contentElement: contentEl });

      expect(addSpy).toHaveBeenCalledWith('resize', expect.any(Function), { passive: true });
      mgr.dispose();
    });

    it('creates a MutationObserver', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      expect(mgr._mutationObserver).not.toBeNull();
      mgr.dispose();
    });
  });

  // =========================================================================
  // _handleScroll — sticky detection
  // =========================================================================

  describe('_handleScroll() — sticky detection', () => {
    it('stays sticky when at bottom (within threshold)', () => {
      // scrollHeight(1000) - scrollTop(500) - clientHeight(500) = 0, which is <= 100
      const mgr = new ScrollManager({ contentElement: contentEl });
      expect(mgr._isSticky).toBe(true);

      contentEl.dispatchEvent(new Event('scroll'));
      expect(mgr._isSticky).toBe(true);
      mgr.dispose();
    });

    it('loses sticky when user scrolls up beyond threshold', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });

      // Set scrollTop so distance from bottom > threshold
      // distance = 1000 - 200 - 500 = 300 > 100
      setupScrollProps(contentEl, 200, 1000, 500);

      contentEl.dispatchEvent(new Event('scroll'));
      expect(mgr._isSticky).toBe(false);
      expect(mgr._userHasScrolledUp).toBe(true);
      mgr.dispose();
    });

    it('regains sticky when user scrolls back to bottom', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });

      // Scroll up
      setupScrollProps(contentEl, 200, 1000, 500);
      contentEl.dispatchEvent(new Event('scroll'));
      expect(mgr._isSticky).toBe(false);

      // Scroll back to bottom
      setupScrollProps(contentEl, 450, 1000, 500);
      contentEl.dispatchEvent(new Event('scroll'));
      // distance = 1000 - 450 - 500 = 50, which is <= 100
      expect(mgr._isSticky).toBe(true);
      expect(mgr._userHasScrolledUp).toBe(false);
      mgr.dispose();
    });

    it('emits scroll:scrolled-up via eventBus when sticky lost', () => {
      const bus = createEventBus();
      const mgr = new ScrollManager({ contentElement: contentEl, eventBus: bus });

      setupScrollProps(contentEl, 100, 1000, 500);
      contentEl.dispatchEvent(new Event('scroll'));

      expect(bus.emit).toHaveBeenCalledWith('scroll:scrolled-up');
      mgr.dispose();
    });

    it('emits scroll:at-bottom via eventBus when sticky regained', () => {
      const bus = createEventBus();
      const mgr = new ScrollManager({ contentElement: contentEl, eventBus: bus });

      // Lose sticky
      setupScrollProps(contentEl, 100, 1000, 500);
      contentEl.dispatchEvent(new Event('scroll'));

      // Regain sticky
      setupScrollProps(contentEl, 500, 1000, 500);
      contentEl.dispatchEvent(new Event('scroll'));

      expect(bus.emit).toHaveBeenCalledWith('scroll:at-bottom');
      mgr.dispose();
    });

    it('does not emit events when sticky state unchanged (still sticky)', () => {
      const bus = createEventBus();
      const mgr = new ScrollManager({ contentElement: contentEl, eventBus: bus });

      bus.emit.mockClear();
      contentEl.dispatchEvent(new Event('scroll'));
      contentEl.dispatchEvent(new Event('scroll'));

      // No state changes — no events
      expect(bus.emit).not.toHaveBeenCalled();
      mgr.dispose();
    });

    it('does not emit events when sticky state unchanged (still not sticky)', () => {
      const bus = createEventBus();
      const mgr = new ScrollManager({ contentElement: contentEl, eventBus: bus });

      setupScrollProps(contentEl, 100, 1000, 500);
      contentEl.dispatchEvent(new Event('scroll'));
      bus.emit.mockClear();

      // Still scrolled up
      contentEl.dispatchEvent(new Event('scroll'));
      expect(bus.emit).not.toHaveBeenCalled();
      mgr.dispose();
    });

    it('uses custom scrollThreshold for sticky detection', () => {
      const mgr = new ScrollManager({
        contentElement: contentEl,
        scrollThreshold: 10,
      });

      // distance = 1000 - 489 - 500 = 11 > 10 threshold
      setupScrollProps(contentEl, 489, 1000, 500);
      contentEl.dispatchEvent(new Event('scroll'));
      expect(mgr._isSticky).toBe(false);

      // distance = 1000 - 491 - 500 = 9 <= 10 threshold
      setupScrollProps(contentEl, 491, 1000, 500);
      contentEl.dispatchEvent(new Event('scroll'));
      expect(mgr._isSticky).toBe(true);
      mgr.dispose();
    });

    it('no-ops when disposed', () => {
      const bus = createEventBus();
      const mgr = new ScrollManager({ contentElement: contentEl, eventBus: bus });
      mgr.dispose();

      // Set up a fresh element to dispatch on (contentElement was nulled)
      expect(() => {
        mgr._handleScroll();
      }).not.toThrow();
    });

    it('works without eventBus (no emit)', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });

      setupScrollProps(contentEl, 100, 1000, 500);
      expect(() => contentEl.dispatchEvent(new Event('scroll'))).not.toThrow();
      expect(mgr._isSticky).toBe(false);
      mgr.dispose();
    });
  });

  // =========================================================================
  // _handleResize
  // =========================================================================

  describe('_handleResize()', () => {
    it('scrolls to bottom on resize when sticky and autoScroll', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      const scrollSpy = jest.spyOn(mgr, 'scrollToBottom');

      window.dispatchEvent(new Event('resize'));

      expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'auto' });
      mgr.dispose();
    });

    it('does not scroll on resize when not sticky', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      mgr._isSticky = false;
      const scrollSpy = jest.spyOn(mgr, 'scrollToBottom');

      window.dispatchEvent(new Event('resize'));

      expect(scrollSpy).not.toHaveBeenCalled();
      mgr.dispose();
    });

    it('does not scroll on resize when autoScroll disabled', () => {
      const mgr = new ScrollManager({ contentElement: contentEl, autoScroll: false });
      const scrollSpy = jest.spyOn(mgr, 'scrollToBottom');

      window.dispatchEvent(new Event('resize'));

      expect(scrollSpy).not.toHaveBeenCalled();
      mgr.dispose();
    });

    it('no-ops when disposed', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      mgr.dispose();

      expect(() => mgr._handleResize()).not.toThrow();
    });
  });

  // =========================================================================
  // MutationObserver integration
  // =========================================================================

  describe('MutationObserver', () => {
    let origMO;
    let observerCallback;
    let mockObserverInstance;

    beforeEach(() => {
      origMO = global.MutationObserver;
      mockObserverInstance = {
        observe: jest.fn(),
        disconnect: jest.fn(),
      };
      global.MutationObserver = jest.fn((cb) => {
        observerCallback = cb;
        return mockObserverInstance;
      });
    });

    afterEach(() => {
      global.MutationObserver = origMO;
    });

    it('triggers scrollToBottom when content mutates and sticky + autoScroll', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      const scrollSpy = jest.spyOn(mgr, 'scrollToBottom');

      observerCallback(); // Simulate mutation

      expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'auto' });
      mgr.dispose();
    });

    it('does NOT trigger scrollToBottom when not sticky', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      mgr._isSticky = false;
      const scrollSpy = jest.spyOn(mgr, 'scrollToBottom');

      observerCallback();

      expect(scrollSpy).not.toHaveBeenCalled();
      mgr.dispose();
    });

    it('does NOT trigger scrollToBottom when autoScroll disabled', () => {
      const mgr = new ScrollManager({ contentElement: contentEl, autoScroll: false });
      const scrollSpy = jest.spyOn(mgr, 'scrollToBottom');

      observerCallback();

      expect(scrollSpy).not.toHaveBeenCalled();
      mgr.dispose();
    });

    it('observes contentElement with correct options', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });

      expect(mockObserverInstance.observe).toHaveBeenCalledWith(contentEl, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['data-state'],
      });
      mgr.dispose();
    });

    it('disconnected on dispose', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      mgr.dispose();

      expect(mockObserverInstance.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // scrollToBottom()
  // =========================================================================

  describe('scrollToBottom()', () => {
    it('calls scrollTo on contentElement via rAF', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });

      mgr.scrollToBottom();
      flushRAF();

      expect(contentEl.scrollTo).toHaveBeenCalledWith({
        top: contentEl.scrollHeight,
        behavior: 'smooth', // default when _smoothScroll is true
      });
      mgr.dispose();
    });

    it('uses auto behavior when smoothScroll is false', () => {
      const mgr = new ScrollManager({ contentElement: contentEl, smoothScroll: false });

      mgr.scrollToBottom();
      flushRAF();

      expect(contentEl.scrollTo).toHaveBeenCalledWith({
        top: contentEl.scrollHeight,
        behavior: 'auto',
      });
      mgr.dispose();
    });

    it('uses explicit behavior option when provided', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });

      mgr.scrollToBottom({ behavior: 'auto' });
      flushRAF();

      expect(contentEl.scrollTo).toHaveBeenCalledWith({
        top: contentEl.scrollHeight,
        behavior: 'auto',
      });
      mgr.dispose();
    });

    it('resets sticky state when force is true', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      mgr._isSticky = false;
      mgr._userHasScrolledUp = true;

      mgr.scrollToBottom({ force: true });
      flushRAF();

      expect(mgr._isSticky).toBe(true);
      expect(mgr._userHasScrolledUp).toBe(false);
      mgr.dispose();
    });

    it('does NOT reset sticky state when force is not true', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      mgr._isSticky = false;

      mgr.scrollToBottom({ force: false });
      flushRAF();

      // force:false with !autoScroll would early-return; with autoScroll, it scrolls but doesn't force sticky
      // Wait — autoScroll is true by default, and force is false. So it doesn't early-return.
      // But force !== true, so sticky is not reset.
      // Actually: !force && !this.autoScroll → false && false → won't return early
      // Oh wait: autoScroll is true. !force (true) && !this.autoScroll (false) → false → won't return early
      // So it DOES scroll but does NOT reset sticky.
      expect(mgr._isSticky).toBe(false);
      mgr.dispose();
    });

    it('returns early when autoScroll is false and force is false', () => {
      const mgr = new ScrollManager({ contentElement: contentEl, autoScroll: false });

      mgr.scrollToBottom();
      flushRAF();

      expect(contentEl.scrollTo).not.toHaveBeenCalled();
      mgr.dispose();
    });

    it('scrolls when autoScroll is false but force is true', () => {
      const mgr = new ScrollManager({ contentElement: contentEl, autoScroll: false });

      mgr.scrollToBottom({ force: true });
      flushRAF();

      expect(contentEl.scrollTo).toHaveBeenCalled();
      mgr.dispose();
    });

    it('cancels pending rAF when called again', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });

      mgr.scrollToBottom({ behavior: 'smooth' });
      mgr.scrollToBottom({ behavior: 'auto' });
      flushRAF();

      // Only the second call should have executed
      expect(contentEl.scrollTo).toHaveBeenCalledTimes(1);
      expect(contentEl.scrollTo).toHaveBeenCalledWith({
        top: contentEl.scrollHeight,
        behavior: 'auto',
      });
      mgr.dispose();
    });

    it('falls back to scrollTop assignment when scrollTo throws', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      contentEl.scrollTo = jest.fn(() => {
        throw new Error('scrollTo not supported');
      });

      mgr.scrollToBottom();
      flushRAF();

      expect(contentEl.scrollTop).toBe(contentEl.scrollHeight);
      mgr.dispose();
    });

    it('returns early when contentElement is null', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      mgr.contentElement = null;

      expect(() => {
        mgr.scrollToBottom();
        flushRAF();
      }).not.toThrow();
      mgr.dispose();
    });

    it('returns early when disposed', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      mgr.dispose();

      expect(() => {
        mgr.scrollToBottom();
        flushRAF();
      }).not.toThrow();
    });

    it('clears _scrollRaf after execution', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      mgr.scrollToBottom();
      expect(mgr._scrollRaf).not.toBeNull();

      flushRAF();
      expect(mgr._scrollRaf).toBeNull();
      mgr.dispose();
    });
  });

  // =========================================================================
  // manualScrollToBottom()
  // =========================================================================

  describe('manualScrollToBottom()', () => {
    it('delegates to scrollToBottom with smooth + force', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      const spy = jest.spyOn(mgr, 'scrollToBottom');

      mgr.manualScrollToBottom();
      expect(spy).toHaveBeenCalledWith({ behavior: 'smooth', force: true });
      mgr.dispose();
    });
  });

  // =========================================================================
  // enable / disable / toggle
  // =========================================================================

  describe('enable()', () => {
    it('sets autoScroll to true', () => {
      const mgr = new ScrollManager({ contentElement: contentEl, autoScroll: false });
      expect(mgr.autoScroll).toBe(false);

      mgr.enable();
      expect(mgr.autoScroll).toBe(true);
      mgr.dispose();
    });
  });

  describe('disable()', () => {
    it('sets autoScroll to false', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      expect(mgr.autoScroll).toBe(true);

      mgr.disable();
      expect(mgr.autoScroll).toBe(false);
      mgr.dispose();
    });
  });

  describe('toggle()', () => {
    it('toggles autoScroll from true to false', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      mgr.toggle();
      expect(mgr.autoScroll).toBe(false);
      mgr.dispose();
    });

    it('toggles autoScroll from false to true', () => {
      const mgr = new ScrollManager({ contentElement: contentEl, autoScroll: false });
      mgr.toggle();
      expect(mgr.autoScroll).toBe(true);
      mgr.dispose();
    });

    it('toggles back and forth', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      mgr.toggle(); // true → false
      mgr.toggle(); // false → true
      expect(mgr.autoScroll).toBe(true);
      mgr.dispose();
    });
  });

  // =========================================================================
  // isSticky / isEnabled
  // =========================================================================

  describe('isSticky()', () => {
    it('returns true initially', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      expect(mgr.isSticky()).toBe(true);
      mgr.dispose();
    });

    it('returns false after user scrolls up', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      setupScrollProps(contentEl, 100, 1000, 500);
      contentEl.dispatchEvent(new Event('scroll'));

      expect(mgr.isSticky()).toBe(false);
      mgr.dispose();
    });
  });

  describe('isEnabled()', () => {
    it('returns true by default', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      expect(mgr.isEnabled()).toBe(true);
      mgr.dispose();
    });

    it('returns false after disable()', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      mgr.disable();
      expect(mgr.isEnabled()).toBe(false);
      mgr.dispose();
    });
  });

  // =========================================================================
  // EventBus integration
  // =========================================================================

  describe('EventBus integration', () => {
    it('registers scroll:request-bottom handler on eventBus', () => {
      const bus = createEventBus();
      const mgr = new ScrollManager({ contentElement: contentEl, eventBus: bus });

      expect(bus.on).toHaveBeenCalledWith('scroll:request-bottom', expect.any(Function));
      mgr.dispose();
    });

    it('scrolls to bottom when scroll:request-bottom event fires', () => {
      const bus = createEventBus();
      const mgr = new ScrollManager({ contentElement: contentEl, eventBus: bus });
      const scrollSpy = jest.spyOn(mgr, 'scrollToBottom');

      // Simulate event
      const handler = bus.on.mock.calls.find(c => c[0] === 'scroll:request-bottom')[1];
      handler({ behavior: 'smooth' });

      expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth' });
      mgr.dispose();
    });

    it('stores eventBus cleanup function', () => {
      const bus = createEventBus();
      const mgr = new ScrollManager({ contentElement: contentEl, eventBus: bus });

      expect(mgr._eventBusCleanup).toBe(bus._cleanup);
      mgr.dispose();
    });

    it('calls cleanup on dispose', () => {
      const bus = createEventBus();
      const mgr = new ScrollManager({ contentElement: contentEl, eventBus: bus });

      mgr.dispose();
      expect(bus._cleanup).toHaveBeenCalledTimes(1);
    });

    it('works without eventBus (no error)', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      expect(mgr._eventBusCleanup).toBeUndefined();
      mgr.dispose();
    });

    it('handles eventBus.on returning non-function', () => {
      const bus = {
        on: jest.fn(() => 'not-a-function'),
        emit: jest.fn(),
      };
      const mgr = new ScrollManager({ contentElement: contentEl, eventBus: bus });

      // Should not store non-function cleanup
      expect(mgr._eventBusCleanup).toBeUndefined();
      mgr.dispose();
    });
  });

  // =========================================================================
  // dispose()
  // =========================================================================

  describe('dispose()', () => {
    it('sets _isDisposed flag', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      mgr.dispose();
      expect(mgr._isDisposed).toBe(true);
    });

    it('cancels pending rAF', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      mgr.scrollToBottom();
      expect(mgr._scrollRaf).not.toBeNull();

      mgr.dispose();
      expect(mgr._scrollRaf).toBeNull();
    });

    it('disconnects MutationObserver', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      const observer = mgr._mutationObserver;
      const disconnectSpy = jest.spyOn(observer, 'disconnect');

      mgr.dispose();
      expect(disconnectSpy).toHaveBeenCalledTimes(1);
      expect(mgr._mutationObserver).toBeNull();
    });

    it('removes scroll listener from contentElement', () => {
      const removeSpy = jest.spyOn(contentEl, 'removeEventListener');
      const mgr = new ScrollManager({ contentElement: contentEl });

      mgr.dispose();
      expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function), expect.objectContaining({ passive: true }));
    });

    it('removes resize listener from window', () => {
      const removeSpy = jest.spyOn(window, 'removeEventListener');
      const mgr = new ScrollManager({ contentElement: contentEl });

      mgr.dispose();
      expect(removeSpy).toHaveBeenCalledWith('resize', expect.any(Function), expect.objectContaining({ passive: true }));
    });

    it('nulls contentElement', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      mgr.dispose();
      expect(mgr.contentElement).toBeNull();
    });

    it('calls eventBus cleanup', () => {
      const bus = createEventBus();
      const mgr = new ScrollManager({ contentElement: contentEl, eventBus: bus });

      mgr.dispose();
      expect(bus._cleanup).toHaveBeenCalledTimes(1);
      expect(mgr._eventBusCleanup).toBeNull();
    });

    it('safe to call dispose twice', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      mgr.dispose();
      expect(() => mgr.dispose()).not.toThrow();
    });

    it('after dispose, scrollToBottom is safe no-op', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      mgr.dispose();

      expect(() => {
        mgr.scrollToBottom();
        flushRAF();
      }).not.toThrow();
    });

    it('after dispose, _handleScroll is safe no-op', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      mgr.dispose();

      expect(() => mgr._handleScroll()).not.toThrow();
    });

    it('after dispose, _handleResize is safe no-op', () => {
      const mgr = new ScrollManager({ contentElement: contentEl });
      mgr.dispose();

      expect(() => mgr._handleResize()).not.toThrow();
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('handles scrollHeight equal to clientHeight (no scrollbar)', () => {
      setupScrollProps(contentEl, 0, 500, 500);
      const mgr = new ScrollManager({ contentElement: contentEl });

      contentEl.dispatchEvent(new Event('scroll'));
      // distance = 500 - 0 - 500 = 0 <= 100 → sticky
      expect(mgr._isSticky).toBe(true);
      mgr.dispose();
    });

    it('handles zero-dimension element', () => {
      setupScrollProps(contentEl, 0, 0, 0);
      const mgr = new ScrollManager({ contentElement: contentEl });

      contentEl.dispatchEvent(new Event('scroll'));
      // distance = 0 - 0 - 0 = 0 <= 100 → sticky
      expect(mgr._isSticky).toBe(true);
      mgr.dispose();
    });

    it('threshold exactly equal to distance from bottom', () => {
      // distance = 1000 - 400 - 500 = 100 <= 100 → sticky
      setupScrollProps(contentEl, 400, 1000, 500);
      const mgr = new ScrollManager({ contentElement: contentEl });

      contentEl.dispatchEvent(new Event('scroll'));
      expect(mgr._isSticky).toBe(true);
      mgr.dispose();
    });

    it('threshold one more than distance → not sticky', () => {
      // distance = 1000 - 399 - 500 = 101 > 100 → not sticky
      setupScrollProps(contentEl, 399, 1000, 500);
      const mgr = new ScrollManager({ contentElement: contentEl });

      contentEl.dispatchEvent(new Event('scroll'));
      expect(mgr._isSticky).toBe(false);
      mgr.dispose();
    });

    it('rapid scroll events only update state once per transition', () => {
      const bus = createEventBus();
      const mgr = new ScrollManager({ contentElement: contentEl, eventBus: bus });

      bus.emit.mockClear();

      // Multiple scrolls while still at bottom — no state change
      for (let i = 0; i < 5; i++) {
        contentEl.dispatchEvent(new Event('scroll'));
      }
      expect(bus.emit).not.toHaveBeenCalled();

      // Scroll up — one transition
      setupScrollProps(contentEl, 100, 1000, 500);
      for (let i = 0; i < 5; i++) {
        contentEl.dispatchEvent(new Event('scroll'));
      }
      expect(bus.emit).toHaveBeenCalledWith('scroll:scrolled-up');
      expect(bus.emit).toHaveBeenCalledTimes(1);
      mgr.dispose();
    });
  });

  // =========================================================================
  // Module exports
  // =========================================================================

  describe('module exports', () => {
    it('exports ScrollManager class', () => {
      expect(typeof ScrollManager).toBe('function');
      expect(ScrollManager.name).toBe('ScrollManager');
    });
  });
});
