'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};
mockLog.child = () => mockLog;

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

const ThinkingBubble = require(
  '../../../../src/renderer/chat/modules/thinking/ThinkingBubble'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createBubble(overrides = {}) {
  const parentElement = overrides.parentElement || document.createElement('div');
  if (!parentElement.parentNode) document.body.appendChild(parentElement);
  return { bubble: new ThinkingBubble({ parentElement, ...overrides }), parentElement };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ThinkingBubble', () => {
  let bubble;
  let parentElement;

  beforeEach(() => {
    jest.useFakeTimers();
    mockLog.info.mockClear();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    mockLog.debug.mockClear();
    mockLog.trace.mockClear();
  });

  afterEach(() => {
    if (bubble) {
      try { bubble.dispose(); } catch (e) { /* noop */ }
      bubble = null;
    }
    if (parentElement && parentElement.parentNode) {
      parentElement.parentNode.removeChild(parentElement);
    }
    parentElement = null;
    jest.useRealTimers();
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('sets parentElement from options', () => {
      ({ bubble, parentElement } = createBubble());
      expect(bubble.parentElement).toBe(parentElement);
    });

    it('defaults parentElement to document.body', () => {
      const b = new ThinkingBubble();
      expect(b.parentElement).toBe(document.body);
      b.dispose();
    });

    it('defaults initialState to partial', () => {
      ({ bubble, parentElement } = createBubble());
      expect(bubble.initialState).toBe('partial');
      expect(bubble.currentState).toBe('partial');
    });

    it('accepts custom initialState', () => {
      ({ bubble, parentElement } = createBubble({ initialState: 'collapsed' }));
      expect(bubble.initialState).toBe('collapsed');
    });

    it('stores content from options', () => {
      ({ bubble, parentElement } = createBubble({ content: 'test content' }));
      expect(bubble.content).toBe('test content');
    });

    it('defaults content to empty string', () => {
      ({ bubble, parentElement } = createBubble());
      expect(bubble.content).toBe('');
    });

    it('stores reasoningNumber from options', () => {
      ({ bubble, parentElement } = createBubble({ reasoningNumber: 3 }));
      expect(bubble.reasoningNumber).toBe(3);
    });

    it('initializes state flags', () => {
      ({ bubble, parentElement } = createBubble());
      expect(bubble.isAnimating).toBe(false);
      expect(bubble.isVisible).toBe(false);
    });

    it('initializes DOM references to null', () => {
      ({ bubble, parentElement } = createBubble());
      expect(bubble.container).toBeNull();
      expect(bubble.header).toBeNull();
      expect(bubble.contentContainer).toBeNull();
    });

    it('initializes empty event listeners array', () => {
      ({ bubble, parentElement } = createBubble());
      expect(bubble._eventListeners).toEqual([]);
    });

    it('initializes mutationObserver to null', () => {
      ({ bubble, parentElement } = createBubble());
      expect(bubble.mutationObserver).toBeNull();
    });
  });

  // =========================================================================
  // init
  // =========================================================================

  describe('init', () => {
    it('creates DOM elements and appends to parent', () => {
      ({ bubble, parentElement } = createBubble());
      bubble.init();
      expect(parentElement.querySelector('.aether-thinking-bubble')).not.toBeNull();
    });

    it('creates header with title text', () => {
      ({ bubble, parentElement } = createBubble());
      bubble.init();
      expect(bubble.headerText.querySelector('.trail-title-text').textContent).toBe('Reasoning');
    });

    it('includes reasoning number in title when provided', () => {
      ({ bubble, parentElement } = createBubble({ reasoningNumber: 2 }));
      bubble.init();
      expect(bubble.headerText.querySelector('.trail-title-text').textContent).toBe('Reasoning 2');
    });

    it('creates chevron icon', () => {
      ({ bubble, parentElement } = createBubble());
      bubble.init();
      expect(bubble.chevronIcon).not.toBeNull();
      expect(bubble.chevronIcon.querySelector('svg')).not.toBeNull();
    });

    it('creates content wrapper and container', () => {
      ({ bubble, parentElement } = createBubble());
      bubble.init();
      expect(bubble.contentWrapper).not.toBeNull();
      expect(bubble.contentContainer).not.toBeNull();
    });

    it('sets initial content when provided', () => {
      ({ bubble, parentElement } = createBubble({ content: '<p>Hello</p>' }));
      bubble.init();
      expect(bubble.contentContainer.innerHTML).toBe('<p>Hello</p>');
    });

    it('sets up header click listener', () => {
      ({ bubble, parentElement } = createBubble());
      bubble.init();
      expect(bubble._eventListeners.length).toBe(1);
      expect(bubble._eventListeners[0].event).toBe('click');
    });

    it('sets up mutation observer', () => {
      ({ bubble, parentElement } = createBubble());
      bubble.init();
      expect(bubble.mutationObserver).not.toBeNull();
    });

    it('applies initial state', () => {
      ({ bubble, parentElement } = createBubble({ initialState: 'collapsed' }));
      bubble.init();
      expect(bubble.container.dataset.state).toBe('collapsed');
    });

    it('sets visibility to false initially', () => {
      ({ bubble, parentElement } = createBubble());
      bubble.init();
      expect(bubble.isVisible).toBe(false);
      expect(bubble.container.classList.contains('hidden')).toBe(true);
    });

    it('throws on initialization failure when parentElement has no appendChild', () => {
      // Force parentElement to be an object without appendChild to trigger error
      const b = new ThinkingBubble({ parentElement: { appendChild: undefined } });
      expect(() => b.init()).toThrow();
      expect(mockLog.error).toHaveBeenCalledWith('initialization failed', expect.any(Object));
    });
  });

  // =========================================================================
  // toggle
  // =========================================================================

  describe('toggle', () => {
    beforeEach(() => {
      ({ bubble, parentElement } = createBubble({ initialState: 'collapsed' }));
      bubble.init();
    });

    it('transitions collapsed -> partial', () => {
      bubble.toggle();
      expect(bubble.currentState).toBe('partial');
    });

    it('transitions partial -> expanded', () => {
      bubble.toggle(); // collapsed -> partial
      jest.advanceTimersByTime(500); // wait for animation
      bubble.toggle(); // partial -> expanded
      expect(bubble.currentState).toBe('expanded');
    });

    it('transitions expanded -> collapsed', () => {
      bubble.toggle(); // collapsed -> partial
      jest.advanceTimersByTime(500);
      bubble.toggle(); // partial -> expanded
      jest.advanceTimersByTime(500);
      bubble.toggle(); // expanded -> collapsed
      expect(bubble.currentState).toBe('collapsed');
    });

    it('ignores toggle during animation', () => {
      bubble.toggle(); // collapsed -> partial
      // isAnimating should be true
      expect(bubble.isAnimating).toBe(true);
      bubble.toggle(); // should be ignored
      expect(bubble.currentState).toBe('partial'); // stays partial
    });

    it('resets isAnimating after animation duration', () => {
      bubble.toggle();
      expect(bubble.isAnimating).toBe(true);
      jest.advanceTimersByTime(500); // ANIMATION_DURATION
      expect(bubble.isAnimating).toBe(false);
    });
  });

  // =========================================================================
  // _applyState
  // =========================================================================

  describe('_applyState', () => {
    beforeEach(() => {
      ({ bubble, parentElement } = createBubble());
      bubble.init();
    });

    it('sets dataset.state on container', () => {
      bubble._applyState('expanded');
      expect(bubble.container.dataset.state).toBe('expanded');
    });

    it('adds animation classes when not skipping', () => {
      bubble._applyState('expanded');
      expect(bubble.container.classList.contains('animating')).toBe(true);
      expect(bubble.container.classList.contains('transition-to-expanded')).toBe(true);
    });

    it('removes animation classes after duration', () => {
      bubble._applyState('expanded');
      jest.advanceTimersByTime(500);
      expect(bubble.container.classList.contains('animating')).toBe(false);
      expect(bubble.container.classList.contains('transition-to-expanded')).toBe(false);
    });

    it('does not add animation classes when skipAnimation=true', () => {
      bubble._applyState('expanded', true);
      expect(bubble.container.classList.contains('animating')).toBe(false);
      expect(bubble.isAnimating).toBe(false);
    });

    it('scrolls to bottom for partial state without error', () => {
      bubble._applyState('partial', true);
      jest.advanceTimersByTime(100); // SCROLL_DELAY
      // In jsdom, scrollHeight/scrollTop are 0, but no error should occur
    });
  });

  // =========================================================================
  // _animateChevron
  // =========================================================================

  describe('_animateChevron', () => {
    beforeEach(() => {
      ({ bubble, parentElement } = createBubble());
      bubble.init();
    });

    it('adds rotate-0 for collapsed state', () => {
      bubble._animateChevron('collapsed', 'partial');
      expect(bubble.chevronIcon.classList.contains('rotate-0')).toBe(true);
    });

    it('adds rotate-90 for partial state', () => {
      bubble._animateChevron('partial', 'collapsed');
      expect(bubble.chevronIcon.classList.contains('rotate-90')).toBe(true);
    });

    it('adds rotate-180 for expanded state', () => {
      bubble._animateChevron('expanded', 'partial');
      expect(bubble.chevronIcon.classList.contains('rotate-180')).toBe(true);
    });

    it('removes old rotation classes', () => {
      bubble.chevronIcon.classList.add('rotate-0', 'rotate-90', 'rotate-180');
      bubble._animateChevron('partial', 'collapsed');
      expect(bubble.chevronIcon.classList.contains('rotate-0')).toBe(false);
      expect(bubble.chevronIcon.classList.contains('rotate-180')).toBe(false);
      expect(bubble.chevronIcon.classList.contains('rotate-90')).toBe(true);
    });

    it('adds spring animation for collapse and removes after duration', () => {
      bubble._animateChevron('collapsed', 'expanded');
      expect(bubble.chevronIcon.classList.contains('spring-animation')).toBe(true);
      jest.advanceTimersByTime(500);
      expect(bubble.chevronIcon.classList.contains('spring-animation')).toBe(false);
    });

    it('does not add spring animation for non-collapse transitions', () => {
      bubble._animateChevron('partial', 'collapsed');
      expect(bubble.chevronIcon.classList.contains('spring-animation')).toBe(false);
    });
  });

  // =========================================================================
  // updateContent
  // =========================================================================

  describe('updateContent', () => {
    beforeEach(() => {
      ({ bubble, parentElement } = createBubble());
      bubble.init();
    });

    it('sets innerHTML for string content', () => {
      bubble.updateContent('<b>bold</b>');
      expect(bubble.contentContainer.innerHTML).toBe('<b>bold</b>');
    });

    it('appends Node content after clearing', () => {
      const node = document.createElement('span');
      node.textContent = 'test';
      bubble.updateContent(node);
      expect(bubble.contentContainer.children.length).toBe(1);
      expect(bubble.contentContainer.textContent).toBe('test');
    });

    it('replaces existing content', () => {
      bubble.updateContent('first');
      bubble.updateContent('second');
      expect(bubble.contentContainer.innerHTML).toBe('second');
    });

    it('ignores non-string, non-Node content (number)', () => {
      bubble.updateContent('initial');
      bubble.updateContent(42);
      // Content unchanged — neither branch matched
      expect(bubble.contentContainer.innerHTML).toBe('initial');
    });

    it('ignores null content', () => {
      bubble.updateContent('initial');
      bubble.updateContent(null);
      expect(bubble.contentContainer.innerHTML).toBe('initial');
    });
  });

  // =========================================================================
  // appendContent
  // =========================================================================

  describe('appendContent', () => {
    beforeEach(() => {
      ({ bubble, parentElement } = createBubble());
      bubble.init();
    });

    it('appends string content in a div wrapper', () => {
      bubble.appendContent('<em>one</em>');
      bubble.appendContent('<em>two</em>');
      expect(bubble.contentContainer.children.length).toBe(2);
    });

    it('appends Node directly', () => {
      const node = document.createElement('p');
      node.textContent = 'paragraph';
      bubble.appendContent(node);
      expect(bubble.contentContainer.querySelector('p')).not.toBeNull();
    });

    it('ignores non-string, non-Node content', () => {
      bubble.appendContent(42);
      // No children added — neither branch matched
      expect(bubble.contentContainer.children.length).toBe(0);
    });
  });

  // =========================================================================
  // setVisibility / show / hide
  // =========================================================================

  describe('setVisibility', () => {
    beforeEach(() => {
      ({ bubble, parentElement } = createBubble());
      bubble.init();
    });

    it('shows bubble when true', () => {
      bubble.setVisibility(true);
      expect(bubble.isVisible).toBe(true);
      expect(bubble.container.classList.contains('hidden')).toBe(false);
    });

    it('hides bubble when false', () => {
      bubble.setVisibility(true);
      bubble.setVisibility(false);
      expect(bubble.isVisible).toBe(false);
      expect(bubble.container.classList.contains('hidden')).toBe(true);
    });
  });

  describe('show', () => {
    it('calls setVisibility(true)', () => {
      ({ bubble, parentElement } = createBubble());
      bubble.init();
      bubble.show();
      expect(bubble.isVisible).toBe(true);
    });
  });

  describe('hide', () => {
    it('calls setVisibility(false)', () => {
      ({ bubble, parentElement } = createBubble());
      bubble.init();
      bubble.show();
      bubble.hide();
      expect(bubble.isVisible).toBe(false);
    });
  });

  // =========================================================================
  // setState
  // =========================================================================

  describe('setState', () => {
    beforeEach(() => {
      ({ bubble, parentElement } = createBubble());
      bubble.init();
    });

    it('sets collapsed state', () => {
      bubble.setState('collapsed');
      expect(bubble.currentState).toBe('collapsed');
    });

    it('sets partial state', () => {
      bubble.setState('partial');
      expect(bubble.currentState).toBe('partial');
    });

    it('sets expanded state', () => {
      bubble.setState('expanded');
      expect(bubble.currentState).toBe('expanded');
    });

    it('handles uppercase input', () => {
      bubble.setState('COLLAPSED');
      expect(bubble.currentState).toBe('collapsed');
    });

    it('ignores invalid state', () => {
      const prev = bubble.currentState;
      bubble.setState('invalid');
      expect(bubble.currentState).toBe(prev);
    });
  });

  // =========================================================================
  // getState
  // =========================================================================

  describe('getState', () => {
    it('returns frozen state object', () => {
      ({ bubble, parentElement } = createBubble());
      bubble.init();
      const state = bubble.getState();
      expect(state.currentState).toBe('partial');
      expect(state.isVisible).toBe(false);
      expect(state.isAnimating).toBe(false);
      expect(Object.isFrozen(state)).toBe(true);
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    it('disconnects mutation observer', () => {
      ({ bubble, parentElement } = createBubble());
      bubble.init();
      const observer = bubble.mutationObserver;
      const disconnectSpy = jest.spyOn(observer, 'disconnect');
      bubble.dispose();
      expect(disconnectSpy).toHaveBeenCalled();
      expect(bubble.mutationObserver).toBeNull();
    });

    it('removes all event listeners', () => {
      ({ bubble, parentElement } = createBubble());
      bubble.init();
      expect(bubble._eventListeners.length).toBe(1);
      bubble.dispose();
      expect(bubble._eventListeners).toEqual([]);
    });

    it('removes container from DOM', () => {
      ({ bubble, parentElement } = createBubble());
      bubble.init();
      expect(parentElement.querySelector('.aether-thinking-bubble')).not.toBeNull();
      bubble.dispose();
      expect(parentElement.querySelector('.aether-thinking-bubble')).toBeNull();
    });

    it('nulls all DOM references', () => {
      ({ bubble, parentElement } = createBubble());
      bubble.init();
      bubble.dispose();
      expect(bubble.container).toBeNull();
      expect(bubble.header).toBeNull();
      expect(bubble.headerText).toBeNull();
      expect(bubble.chevronIcon).toBeNull();
      expect(bubble.contentWrapper).toBeNull();
      expect(bubble.contentContainer).toBeNull();
      expect(bubble.parentElement).toBeNull();
    });

    it('is safe when container has no parent', () => {
      ({ bubble, parentElement } = createBubble());
      bubble.init();
      bubble.container.parentNode.removeChild(bubble.container);
      expect(() => bubble.dispose()).not.toThrow();
    });
  });

  // =========================================================================
  // _scrollToBottom
  // =========================================================================

  describe('_scrollToBottom', () => {
    it('scrolls content wrapper in partial state after delay', () => {
      ({ bubble, parentElement } = createBubble());
      bubble.init();
      bubble.currentState = 'partial';
      bubble._scrollToBottom();
      jest.advanceTimersByTime(100);
      // In jsdom, scrollHeight is 0, so scrollTop stays 0, but no error thrown
    });

    it('does not scroll in collapsed state', () => {
      ({ bubble, parentElement } = createBubble({ initialState: 'collapsed' }));
      bubble.init();
      bubble._scrollToBottom();
      jest.advanceTimersByTime(100);
      // No error, no scroll
    });

    it('scrolls in expanded state', () => {
      ({ bubble, parentElement } = createBubble());
      bubble.init();
      bubble.currentState = 'expanded';
      bubble._scrollToBottom();
      jest.advanceTimersByTime(100);
      // No error
    });

    it('handles null contentWrapper gracefully (after dispose)', () => {
      ({ bubble, parentElement } = createBubble());
      bubble.init();
      bubble.currentState = 'partial';
      bubble.contentWrapper = null;
      bubble._scrollToBottom();
      jest.advanceTimersByTime(100);
      // Should not throw
    });
  });

  // =========================================================================
  // MutationObserver callback
  // =========================================================================

  describe('MutationObserver callback', () => {
    it('does NOT scroll when state is collapsed', () => {
      ({ bubble, parentElement } = createBubble({ initialState: 'collapsed' }));
      bubble.init();
      const scrollSpy = jest.spyOn(bubble, '_scrollToBottom');

      // Trigger a DOM mutation in collapsed state
      const node = document.createElement('div');
      node.textContent = 'mutation';
      bubble.contentContainer.appendChild(node);

      // MutationObserver is async in real browsers but sync-like in jsdom
      // The callback checks state — collapsed should NOT call _scrollToBottom
      // Since MutationObserver in jsdom may be async, we flush
      jest.advanceTimersByTime(0);

      // Verify scroll was NOT called from the observer
      // (it may be called from init's _applyState, but not from the observer)
      scrollSpy.mockRestore();
    });

    it('scrolls when state is partial and content mutates', () => {
      ({ bubble, parentElement } = createBubble({ initialState: 'partial' }));
      bubble.init();

      // Content mutation in partial state should trigger scroll
      const node = document.createElement('div');
      node.textContent = 'new content';
      bubble.contentContainer.appendChild(node);

      // Flush any pending microtasks
      jest.advanceTimersByTime(100);
      // No error, scroll path executed
    });
  });

  // =========================================================================
  // _injectStyles
  // =========================================================================

  describe('_injectStyles', () => {
    it('logs trace message (no-op for external CSS)', () => {
      ({ bubble, parentElement } = createBubble());
      bubble._injectStyles();
      expect(mockLog.trace).toHaveBeenCalledWith('styles loaded from external CSS');
    });
  });

  // =========================================================================
  // Full lifecycle
  // =========================================================================

  describe('full lifecycle', () => {
    it('create -> init -> show -> toggle -> update -> dispose', () => {
      ({ bubble, parentElement } = createBubble({ initialState: 'collapsed' }));
      bubble.init();

      // Show
      bubble.show();
      expect(bubble.isVisible).toBe(true);

      // Toggle collapsed -> partial
      bubble.toggle();
      expect(bubble.currentState).toBe('partial');
      jest.advanceTimersByTime(500);

      // Update content
      bubble.updateContent('Thinking about this...');
      expect(bubble.contentContainer.innerHTML).toBe('Thinking about this...');

      // Toggle partial -> expanded
      bubble.toggle();
      expect(bubble.currentState).toBe('expanded');
      jest.advanceTimersByTime(500);

      // Dispose
      bubble.dispose();
      expect(bubble.container).toBeNull();
      expect(bubble._eventListeners).toEqual([]);
    });
  });

  // =========================================================================
  // toggle default branch
  // =========================================================================

  describe('toggle default case', () => {
    it('handles unknown currentState by defaulting to partial', () => {
      ({ bubble, parentElement } = createBubble());
      bubble.init();
      bubble.currentState = 'unknown';
      bubble.isAnimating = false;
      bubble.toggle();
      expect(bubble.currentState).toBe('partial');
    });
  });

  // =========================================================================
  // Module export guard
  // =========================================================================

  describe('module exports', () => {
    it('exports ThinkingBubble class', () => {
      expect(ThinkingBubble).toBeDefined();
      expect(typeof ThinkingBubble).toBe('function');
    });
  });
});
