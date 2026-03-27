'use strict';

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  })),
}));

const { AccessibilityManager, KeyboardNavigationHelper } = require('../../../src/renderer/shared/utils/accessibility');

// ============================================================================
// Helpers
// ============================================================================

/** Create a button element that passes _getFocusableElements visibility filter in jsdom. */
function createFocusableButton(text = 'Click') {
  const btn = document.createElement('button');
  btn.textContent = text;
  // jsdom has no layout engine — offsetWidth/offsetHeight are always 0.
  // Mock them so _getFocusableElements visibility filter accepts these elements.
  Object.defineProperty(btn, 'offsetWidth', { value: 100, configurable: true });
  Object.defineProperty(btn, 'offsetHeight', { value: 30, configurable: true });
  return btn;
}

/** Create a focusable input element. */
function createFocusableInput() {
  const input = document.createElement('input');
  input.type = 'text';
  Object.defineProperty(input, 'offsetWidth', { value: 200, configurable: true });
  Object.defineProperty(input, 'offsetHeight', { value: 30, configurable: true });
  return input;
}

// ============================================================================
// AccessibilityManager
// ============================================================================
describe('AccessibilityManager', () => {
  let manager;

  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    manager = new AccessibilityManager();
  });

  // --------------------------------------------------------------------------
  // Constructor / _init
  // --------------------------------------------------------------------------
  describe('constructor and _init', () => {
    it('creates announceElement with correct ARIA attributes', () => {
      expect(manager.announceElement).not.toBeNull();
      expect(manager.announceElement.getAttribute('role')).toBe('status');
      expect(manager.announceElement.getAttribute('aria-live')).toBe('polite');
      expect(manager.announceElement.getAttribute('aria-atomic')).toBe('true');
      expect(manager.announceElement.className).toBe('sr-only');
    });

    it('appends announceElement to document.body', () => {
      expect(document.body.contains(manager.announceElement)).toBe(true);
    });

    it('initializes focusHistory as empty array', () => {
      expect(manager.focusHistory).toEqual([]);
    });

    it('initializes trapStack as empty array', () => {
      expect(manager.trapStack).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // announce()
  // --------------------------------------------------------------------------
  describe('announce()', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('sets aria-live attribute to given priority', () => {
      manager.announce('Alert!', 'assertive');
      expect(manager.announceElement.getAttribute('aria-live')).toBe('assertive');
    });

    it('defaults to polite priority', () => {
      manager.announce('Update');
      expect(manager.announceElement.getAttribute('aria-live')).toBe('polite');
    });

    it('clears textContent immediately, sets message after 100ms', () => {
      manager.announceElement.textContent = 'previous';
      manager.announce('New message');

      expect(manager.announceElement.textContent).toBe('');

      jest.advanceTimersByTime(100);
      expect(manager.announceElement.textContent).toBe('New message');
    });

    it('returns early when announceElement is null', () => {
      manager.announceElement = null;
      expect(() => manager.announce('Nothing')).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // moveFocus()
  // --------------------------------------------------------------------------
  describe('moveFocus()', () => {
    it('focuses the given element', () => {
      const btn = createFocusableButton();
      document.body.appendChild(btn);

      manager.moveFocus(btn);
      expect(document.activeElement).toBe(btn);
    });

    it('saves current focus to focusHistory', () => {
      const btn1 = createFocusableButton('One');
      const btn2 = createFocusableButton('Two');
      document.body.appendChild(btn1);
      document.body.appendChild(btn2);

      btn1.focus();
      manager.moveFocus(btn2);

      expect(manager.focusHistory).toContain(btn1);
      expect(document.activeElement).toBe(btn2);
    });

    it('does not save document.body to focusHistory', () => {
      const btn = createFocusableButton();
      document.body.appendChild(btn);

      // activeElement is document.body initially
      expect(document.activeElement).toBe(document.body);
      manager.moveFocus(btn);

      expect(manager.focusHistory.length).toBe(0);
    });

    it('warns on null element', () => {
      manager.moveFocus(null);
      expect(manager.log.warn).toHaveBeenCalledWith('invalid focus element');
    });

    it('warns on element without focus method', () => {
      manager.moveFocus({ notAFocusMethod: true });
      expect(manager.log.warn).toHaveBeenCalledWith('invalid focus element');
    });
  });

  // --------------------------------------------------------------------------
  // restoreFocus()
  // --------------------------------------------------------------------------
  describe('restoreFocus()', () => {
    it('restores the last focused element from history', () => {
      const btn1 = createFocusableButton('One');
      const btn2 = createFocusableButton('Two');
      document.body.appendChild(btn1);
      document.body.appendChild(btn2);

      btn1.focus();
      manager.moveFocus(btn2);
      manager.restoreFocus();

      expect(document.activeElement).toBe(btn1);
    });

    it('does nothing when focusHistory is empty', () => {
      const before = document.activeElement;
      manager.restoreFocus();
      expect(document.activeElement).toBe(before);
    });

    it('handles popped element that no longer has focus method', () => {
      manager.focusHistory.push({ noFocus: true });
      expect(() => manager.restoreFocus()).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // trapFocus()
  // --------------------------------------------------------------------------
  describe('trapFocus()', () => {
    let container, btn1, btn2, btn3;

    beforeEach(() => {
      container = document.createElement('div');
      btn1 = createFocusableButton('First');
      btn2 = createFocusableButton('Second');
      btn3 = createFocusableButton('Third');
      container.appendChild(btn1);
      container.appendChild(btn2);
      container.appendChild(btn3);
      document.body.appendChild(container);
    });

    it('focuses the first focusable element', () => {
      manager.trapFocus(container);
      expect(document.activeElement).toBe(btn1);
    });

    it('returns a cleanup function', () => {
      const release = manager.trapFocus(container);
      expect(typeof release).toBe('function');
    });

    it('Tab from last element wraps to first', () => {
      manager.trapFocus(container);
      btn3.focus();

      const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
      const preventDefaultSpy = jest.spyOn(event, 'preventDefault');
      container.dispatchEvent(event);

      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(document.activeElement).toBe(btn1);
    });

    it('Shift+Tab from first element wraps to last', () => {
      manager.trapFocus(container);
      // Focus is on btn1 (first) after trapFocus

      const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true });
      const preventDefaultSpy = jest.spyOn(event, 'preventDefault');
      container.dispatchEvent(event);

      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(document.activeElement).toBe(btn3);
    });

    it('Tab on non-last element does not wrap', () => {
      manager.trapFocus(container);
      btn1.focus();

      const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
      const preventDefaultSpy = jest.spyOn(event, 'preventDefault');
      container.dispatchEvent(event);

      // Should not prevent default — browser handles normal tab
      expect(preventDefaultSpy).not.toHaveBeenCalled();
    });

    it('non-Tab key does nothing', () => {
      manager.trapFocus(container);
      btn3.focus();

      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
      container.dispatchEvent(event);

      // Focus unchanged
      expect(document.activeElement).toBe(btn3);
    });

    it('cleanup removes listener and trap from stack', () => {
      const release = manager.trapFocus(container);
      expect(manager.trapStack.length).toBe(1);

      release();
      expect(manager.trapStack.length).toBe(0);

      // After release, Tab should not be trapped
      btn3.focus();
      const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
      const preventDefaultSpy = jest.spyOn(event, 'preventDefault');
      container.dispatchEvent(event);
      expect(preventDefaultSpy).not.toHaveBeenCalled();
    });

    it('warns and returns no-op on null container', () => {
      const release = manager.trapFocus(null);
      expect(typeof release).toBe('function');
      expect(manager.log.warn).toHaveBeenCalledWith('invalid trap container');
    });

    it('warns and returns no-op when container has no focusable elements', () => {
      const emptyContainer = document.createElement('div');
      document.body.appendChild(emptyContainer);

      const release = manager.trapFocus(emptyContainer);
      expect(typeof release).toBe('function');
      expect(manager.log.warn).toHaveBeenCalledWith('no focusable elements in trap container');
    });
  });

  // --------------------------------------------------------------------------
  // releaseAllTraps()
  // --------------------------------------------------------------------------
  describe('releaseAllTraps()', () => {
    it('removes all trap listeners and clears trapStack', () => {
      const container1 = document.createElement('div');
      const btn1 = createFocusableButton('A');
      container1.appendChild(btn1);
      document.body.appendChild(container1);

      const container2 = document.createElement('div');
      const btn2 = createFocusableButton('B');
      container2.appendChild(btn2);
      document.body.appendChild(container2);

      manager.trapFocus(container1);
      manager.trapFocus(container2);
      expect(manager.trapStack.length).toBe(2);

      manager.releaseAllTraps();
      expect(manager.trapStack.length).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // addSkipLink()
  // --------------------------------------------------------------------------
  describe('addSkipLink()', () => {
    it('creates a skip link element prepended to body', () => {
      const target = document.createElement('main');
      target.setAttribute('tabindex', '-1');
      Object.defineProperty(target, 'scrollIntoView', { value: jest.fn() });
      document.body.appendChild(target);

      manager.addSkipLink(target, 'Skip to content');

      const skipLink = document.querySelector('.skip-link');
      expect(skipLink).not.toBeNull();
      expect(skipLink.textContent).toBe('Skip to content');
      expect(skipLink.tagName).toBe('A');
      expect(skipLink.href).toContain('#');
    });

    it('uses default label when not provided', () => {
      const target = document.createElement('main');
      Object.defineProperty(target, 'scrollIntoView', { value: jest.fn() });
      document.body.appendChild(target);

      manager.addSkipLink(target);
      const skipLink = document.querySelector('.skip-link');
      expect(skipLink.textContent).toBe('Skip to main content');
    });

    it('shows on focus, hides on blur', () => {
      const target = document.createElement('main');
      Object.defineProperty(target, 'scrollIntoView', { value: jest.fn() });
      document.body.appendChild(target);

      manager.addSkipLink(target);
      const skipLink = document.querySelector('.skip-link');

      skipLink.dispatchEvent(new Event('focus'));
      expect(skipLink.style.top).toBe('0px');

      skipLink.dispatchEvent(new Event('blur'));
      expect(skipLink.style.top).toBe('-40px');
    });

    it('click focuses and scrolls target element', () => {
      const target = document.createElement('main');
      target.setAttribute('tabindex', '-1');
      const scrollSpy = jest.fn();
      Object.defineProperty(target, 'scrollIntoView', { value: scrollSpy });
      document.body.appendChild(target);

      manager.addSkipLink(target);
      const skipLink = document.querySelector('.skip-link');

      const clickEvent = new Event('click', { bubbles: true });
      const preventDefaultSpy = jest.spyOn(clickEvent, 'preventDefault');
      skipLink.dispatchEvent(clickEvent);

      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth' });
    });

    it('does nothing when targetElement is null', () => {
      const beforeCount = document.body.children.length;
      manager.addSkipLink(null);
      // No new element added (only announceElement from constructor)
      expect(document.body.children.length).toBe(beforeCount);
    });
  });

  // --------------------------------------------------------------------------
  // setAria()
  // --------------------------------------------------------------------------
  describe('setAria()', () => {
    it('sets ARIA attributes with camelCase to kebab-case conversion', () => {
      const el = document.createElement('div');
      manager.setAria(el, { label: 'Test', describedBy: 'desc-id' });

      expect(el.getAttribute('aria-label')).toBe('Test');
      expect(el.getAttribute('aria-described-by')).toBe('desc-id');
    });

    it('converts values to strings', () => {
      const el = document.createElement('div');
      manager.setAria(el, { valueNow: 42, hidden: true });

      expect(el.getAttribute('aria-value-now')).toBe('42');
      expect(el.getAttribute('aria-hidden')).toBe('true');
    });

    it('removes attribute when value is null', () => {
      const el = document.createElement('div');
      el.setAttribute('aria-label', 'existing');
      manager.setAria(el, { label: null });

      expect(el.hasAttribute('aria-label')).toBe(false);
    });

    it('removes attribute when value is undefined', () => {
      const el = document.createElement('div');
      el.setAttribute('aria-label', 'existing');
      manager.setAria(el, { label: undefined });

      expect(el.hasAttribute('aria-label')).toBe(false);
    });

    it('does nothing when element is null', () => {
      expect(() => manager.setAria(null, { label: 'test' })).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // makeAccessibleButton()
  // --------------------------------------------------------------------------
  describe('makeAccessibleButton()', () => {
    it('sets role=button and tabindex=0', () => {
      const el = document.createElement('div');
      manager.makeAccessibleButton(el, jest.fn());

      expect(el.getAttribute('role')).toBe('button');
      expect(el.getAttribute('tabindex')).toBe('0');
    });

    it('click event triggers onClick', () => {
      const el = document.createElement('div');
      const onClick = jest.fn();
      document.body.appendChild(el);
      manager.makeAccessibleButton(el, onClick);

      el.dispatchEvent(new Event('click', { bubbles: true }));
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('Enter key triggers onClick', () => {
      const el = document.createElement('div');
      const onClick = jest.fn();
      document.body.appendChild(el);
      manager.makeAccessibleButton(el, onClick);

      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('Space key triggers onClick', () => {
      const el = document.createElement('div');
      const onClick = jest.fn();
      document.body.appendChild(el);
      manager.makeAccessibleButton(el, onClick);

      el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('other keys do not trigger onClick', () => {
      const el = document.createElement('div');
      const onClick = jest.fn();
      document.body.appendChild(el);
      manager.makeAccessibleButton(el, onClick);

      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(onClick).not.toHaveBeenCalled();
    });

    it('does nothing when element is null', () => {
      expect(() => manager.makeAccessibleButton(null, jest.fn())).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // _setupKeyboardNavigation (tested via Escape key dispatch)
  // --------------------------------------------------------------------------
  describe('keyboard navigation (Escape)', () => {
    it('dispatches accessibility:escape CustomEvent on Escape key', () => {
      const handler = jest.fn();
      document.addEventListener('accessibility:escape', handler);

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      // Each AccessibilityManager instance adds its own keydown listener to document.
      // In test suite, multiple instances exist (one per test from beforeEach),
      // so the handler fires once per active listener. Verify the event fires at all.
      expect(handler).toHaveBeenCalled();

      document.removeEventListener('accessibility:escape', handler);
    });
  });
});

// ============================================================================
// KeyboardNavigationHelper
// ============================================================================
describe('KeyboardNavigationHelper', () => {

  describe('handleArrowNavigation()', () => {
    let items;

    beforeEach(() => {
      items = [
        document.createElement('button'),
        document.createElement('button'),
        document.createElement('button'),
      ];
      items.forEach(item => {
        item.focus = jest.fn();
      });
    });

    it('ArrowDown moves to next item', () => {
      const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });
      jest.spyOn(event, 'preventDefault');

      const newIndex = KeyboardNavigationHelper.handleArrowNavigation(items, 0, event);
      expect(newIndex).toBe(1);
      expect(items[1].focus).toHaveBeenCalled();
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('ArrowRight moves to next item', () => {
      const event = new KeyboardEvent('keydown', { key: 'ArrowRight' });
      const newIndex = KeyboardNavigationHelper.handleArrowNavigation(items, 0, event);
      expect(newIndex).toBe(1);
    });

    it('ArrowUp moves to previous item', () => {
      const event = new KeyboardEvent('keydown', { key: 'ArrowUp' });
      const newIndex = KeyboardNavigationHelper.handleArrowNavigation(items, 1, event);
      expect(newIndex).toBe(0);
      expect(items[0].focus).toHaveBeenCalled();
    });

    it('ArrowLeft moves to previous item', () => {
      const event = new KeyboardEvent('keydown', { key: 'ArrowLeft' });
      const newIndex = KeyboardNavigationHelper.handleArrowNavigation(items, 1, event);
      expect(newIndex).toBe(0);
    });

    it('ArrowDown wraps from last to first', () => {
      const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });
      const newIndex = KeyboardNavigationHelper.handleArrowNavigation(items, 2, event);
      expect(newIndex).toBe(0);
      expect(items[0].focus).toHaveBeenCalled();
    });

    it('ArrowUp wraps from first to last', () => {
      const event = new KeyboardEvent('keydown', { key: 'ArrowUp' });
      const newIndex = KeyboardNavigationHelper.handleArrowNavigation(items, 0, event);
      expect(newIndex).toBe(2);
      expect(items[2].focus).toHaveBeenCalled();
    });

    it('Home goes to first item', () => {
      const event = new KeyboardEvent('keydown', { key: 'Home' });
      jest.spyOn(event, 'preventDefault');
      const newIndex = KeyboardNavigationHelper.handleArrowNavigation(items, 2, event);
      expect(newIndex).toBe(0);
      expect(items[0].focus).toHaveBeenCalled();
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('End goes to last item', () => {
      const event = new KeyboardEvent('keydown', { key: 'End' });
      jest.spyOn(event, 'preventDefault');
      const newIndex = KeyboardNavigationHelper.handleArrowNavigation(items, 0, event);
      expect(newIndex).toBe(2);
      expect(items[2].focus).toHaveBeenCalled();
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('non-navigation key does not change index or focus', () => {
      const event = new KeyboardEvent('keydown', { key: 'a' });
      const newIndex = KeyboardNavigationHelper.handleArrowNavigation(items, 1, event);
      expect(newIndex).toBe(1);
      for (const item of items) {
        expect(item.focus).not.toHaveBeenCalled();
      }
    });
  });

  describe('setupRovingTabindex()', () => {
    it('sets tabindex=0 on active item and -1 on others', () => {
      const items = [
        document.createElement('button'),
        document.createElement('button'),
        document.createElement('button'),
      ];
      KeyboardNavigationHelper.setupRovingTabindex(items, 1);

      expect(items[0].getAttribute('tabindex')).toBe('-1');
      expect(items[1].getAttribute('tabindex')).toBe('0');
      expect(items[2].getAttribute('tabindex')).toBe('-1');
    });

    it('defaults to first item active', () => {
      const items = [
        document.createElement('button'),
        document.createElement('button'),
      ];
      KeyboardNavigationHelper.setupRovingTabindex(items);

      expect(items[0].getAttribute('tabindex')).toBe('0');
      expect(items[1].getAttribute('tabindex')).toBe('-1');
    });
  });
});

// ============================================================================
// Exports and singleton
// ============================================================================
describe('module exports', () => {
  it('exports AccessibilityManager constructor', () => {
    expect(typeof AccessibilityManager).toBe('function');
  });

  it('exports KeyboardNavigationHelper constructor', () => {
    expect(typeof KeyboardNavigationHelper).toBe('function');
  });

  it('exports singleton accessibilityManager', () => {
    const mod = require('../../../src/renderer/shared/utils/accessibility');
    expect(mod.accessibilityManager).toBeInstanceOf(AccessibilityManager);
  });

  it('sets window.accessibilityManager in jsdom', () => {
    expect(window.accessibilityManager).toBeInstanceOf(AccessibilityManager);
  });

  it('sets window.KeyboardNavigationHelper in jsdom', () => {
    expect(window.KeyboardNavigationHelper).toBe(KeyboardNavigationHelper);
  });
});
