'use strict';

// ---------------------------------------------------------------------------
// Toast.js — Comprehensive unit tests
// ---------------------------------------------------------------------------
// Source: src/renderer/shared/components/Toast.js (178 lines)
// Pure DOM class with only static methods. Zero external dependencies.
// Key behaviors: glassmorphism toasts, auto-dismiss, stacking, click-to-dismiss.
// ---------------------------------------------------------------------------

const Toast = require('../../../src/renderer/shared/components/Toast');

describe('Toast', () => {
  const savedRAF = global.requestAnimationFrame;

  beforeEach(() => {
    jest.useFakeTimers();
    document.body.innerHTML = '';

    // jsdom's built-in rAF ignores fake timers.
    // Override so setTimeout-based fake timers control it.
    global.requestAnimationFrame = window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    global.requestAnimationFrame = window.requestAnimationFrame = savedRAF;
  });

  // Helpers
  function getContainer() {
    return document.getElementById('aether-toast-container');
  }

  function flushRAF() {
    jest.advanceTimersByTime(0);
  }

  // =========================================================================
  // success()
  // =========================================================================

  describe('success()', () => {
    it('creates a toast with success type class', () => {
      const toast = Toast.success('Saved');
      expect(toast.className).toBe('aether-toast aether-toast--success');
    });

    it('uses checkmark icon (U+2713)', () => {
      const toast = Toast.success('Done');
      const icon = toast.querySelector('.aether-toast-icon');
      expect(icon.textContent).toBe('\u2713');
    });

    it('displays the provided message', () => {
      const toast = Toast.success('File saved successfully');
      const msg = toast.querySelector('.aether-toast-message');
      expect(msg.textContent).toBe('File saved successfully');
    });

    it('uses 3000ms default duration', () => {
      const toast = Toast.success('Test');

      jest.advanceTimersByTime(2999);
      expect(toast.parentNode).not.toBeNull();

      // At 3000ms dismiss fires; after 300ms animation, toast removed
      jest.advanceTimersByTime(1 + 300);
      expect(toast.parentNode).toBeNull();
    });

    it('returns the toast HTMLDivElement', () => {
      const toast = Toast.success('Test');
      expect(toast).toBeInstanceOf(HTMLDivElement);
      expect(toast.tagName).toBe('DIV');
    });
  });

  // =========================================================================
  // error()
  // =========================================================================

  describe('error()', () => {
    it('creates a toast with error type class', () => {
      const toast = Toast.error('Failed');
      expect(toast.className).toBe('aether-toast aether-toast--error');
    });

    it('uses cross icon (U+2717)', () => {
      const toast = Toast.error('Oops');
      const icon = toast.querySelector('.aether-toast-icon');
      expect(icon.textContent).toBe('\u2717');
    });

    it('displays the provided message', () => {
      const toast = Toast.error('Connection lost');
      const msg = toast.querySelector('.aether-toast-message');
      expect(msg.textContent).toBe('Connection lost');
    });

    it('uses 4000ms default duration', () => {
      const toast = Toast.error('Err');

      jest.advanceTimersByTime(3999);
      expect(toast.parentNode).not.toBeNull();

      jest.advanceTimersByTime(1 + 300);
      expect(toast.parentNode).toBeNull();
    });
  });

  // =========================================================================
  // info()
  // =========================================================================

  describe('info()', () => {
    it('creates a toast with info type class', () => {
      const toast = Toast.info('Note');
      expect(toast.className).toBe('aether-toast aether-toast--info');
    });

    it('uses info icon (U+2139)', () => {
      const toast = Toast.info('FYI');
      const icon = toast.querySelector('.aether-toast-icon');
      expect(icon.textContent).toBe('\u2139');
    });

    it('displays the provided message', () => {
      const toast = Toast.info('Update available');
      const msg = toast.querySelector('.aether-toast-message');
      expect(msg.textContent).toBe('Update available');
    });

    it('uses 3000ms default duration', () => {
      const toast = Toast.info('Info');

      jest.advanceTimersByTime(2999);
      expect(toast.parentNode).not.toBeNull();

      jest.advanceTimersByTime(1 + 300);
      expect(toast.parentNode).toBeNull();
    });
  });

  // =========================================================================
  // warning()
  // =========================================================================

  describe('warning()', () => {
    it('creates a toast with warning type class', () => {
      const toast = Toast.warning('Caution');
      expect(toast.className).toBe('aether-toast aether-toast--warning');
    });

    it('uses warning icon (U+26A0)', () => {
      const toast = Toast.warning('Caution');
      const icon = toast.querySelector('.aether-toast-icon');
      expect(icon.textContent).toBe('\u26A0');
    });

    it('displays the provided message', () => {
      const toast = Toast.warning('Low disk space');
      const msg = toast.querySelector('.aether-toast-message');
      expect(msg.textContent).toBe('Low disk space');
    });

    it('uses 3500ms default duration', () => {
      const toast = Toast.warning('Warn');

      jest.advanceTimersByTime(3499);
      expect(toast.parentNode).not.toBeNull();

      jest.advanceTimersByTime(1 + 300);
      expect(toast.parentNode).toBeNull();
    });
  });

  // =========================================================================
  // Container lifecycle
  // =========================================================================

  describe('container lifecycle', () => {
    it('creates container on first toast when none exists', () => {
      expect(getContainer()).toBeNull();
      Toast.success('First');
      const container = getContainer();
      expect(container).not.toBeNull();
      expect(container.id).toBe('aether-toast-container');
    });

    it('appends container to document.body', () => {
      Toast.success('First');
      const container = getContainer();
      expect(container.parentNode).toBe(document.body);
    });

    it('reuses existing container for subsequent toasts', () => {
      Toast.success('First');
      const container1 = getContainer();

      Toast.success('Second');
      const container2 = getContainer();

      expect(container1).toBe(container2);
      expect(container1.children.length).toBe(2);
    });

    it('removes container when last toast is dismissed', () => {
      Toast.success('Only one', 1000);

      // Dismiss fires at 1000ms, toast removed at 1300ms
      jest.advanceTimersByTime(1000 + 300);
      expect(getContainer()).toBeNull();
    });

    it('keeps container when other toasts remain after one dismisses', () => {
      Toast.success('Short', 1000);
      Toast.success('Long', 5000);

      // Short toast dismissed
      jest.advanceTimersByTime(1000 + 300);
      const container = getContainer();
      expect(container).not.toBeNull();
      expect(container.children.length).toBe(1);
    });

    it('recreates container after previous container was removed', () => {
      Toast.success('First', 500);
      jest.advanceTimersByTime(500 + 300);
      expect(getContainer()).toBeNull();

      Toast.success('Second');
      const container = getContainer();
      expect(container).not.toBeNull();
      expect(container.id).toBe('aether-toast-container');
      expect(container.children.length).toBe(1);
    });
  });

  // =========================================================================
  // Toast DOM structure
  // =========================================================================

  describe('toast DOM structure', () => {
    it('has exactly 3 child elements (icon, message, close button)', () => {
      const toast = Toast.success('Test');
      expect(toast.children.length).toBe(3);
    });

    it('first child is icon div with correct class and content', () => {
      const toast = Toast.error('Test');
      const iconEl = toast.children[0];
      expect(iconEl.tagName).toBe('DIV');
      expect(iconEl.className).toBe('aether-toast-icon');
      expect(iconEl.textContent).toBe('\u2717');
    });

    it('second child is message div with correct class and text', () => {
      const toast = Toast.info('Hello world');
      const msgEl = toast.children[1];
      expect(msgEl.tagName).toBe('DIV');
      expect(msgEl.className).toBe('aether-toast-message');
      expect(msgEl.textContent).toBe('Hello world');
    });

    it('third child is close button with correct class and content', () => {
      const toast = Toast.warning('Test');
      const closeBtn = toast.children[2];
      expect(closeBtn.tagName).toBe('BUTTON');
      expect(closeBtn.className).toBe('aether-toast-close');
      expect(closeBtn.textContent).toBe('\u00D7');
    });

    it('toast is appended as child of the container', () => {
      const toast = Toast.success('Test');
      const container = getContainer();
      expect(toast.parentNode).toBe(container);
    });
  });

  // =========================================================================
  // Type validation in _createToast
  // =========================================================================

  describe('type validation', () => {
    it('maps each valid type to the correct CSS class', () => {
      expect(Toast.success('T').classList.contains('aether-toast--success')).toBe(true);
      expect(Toast.error('T').classList.contains('aether-toast--error')).toBe(true);
      expect(Toast.info('T').classList.contains('aether-toast--info')).toBe(true);
      expect(Toast.warning('T').classList.contains('aether-toast--warning')).toBe(true);
    });

    it('falls back to info class for invalid type string', () => {
      const toast = Toast._createToast({ message: 'X', type: 'critical', icon: '!' });
      expect(toast.className).toBe('aether-toast aether-toast--info');
    });

    it('falls back to info class for undefined type', () => {
      const toast = Toast._createToast({ message: 'X', type: undefined, icon: '!' });
      expect(toast.className).toBe('aether-toast aether-toast--info');
    });

    it('falls back to info class for null type', () => {
      const toast = Toast._createToast({ message: 'X', type: null, icon: '!' });
      expect(toast.className).toBe('aether-toast aether-toast--info');
    });

    it('falls back to info class for empty string type', () => {
      const toast = Toast._createToast({ message: 'X', type: '', icon: '!' });
      expect(toast.className).toBe('aether-toast aether-toast--info');
    });

    it('falls back to info class for numeric type', () => {
      const toast = Toast._createToast({ message: 'X', type: 42, icon: '!' });
      expect(toast.className).toBe('aether-toast aether-toast--info');
    });
  });

  // =========================================================================
  // Entrance animation via requestAnimationFrame
  // =========================================================================

  describe('entrance animation', () => {
    it('does NOT have visible class immediately after creation', () => {
      const toast = Toast.success('Test');
      expect(toast.classList.contains('aether-toast--visible')).toBe(false);
    });

    it('adds visible class after requestAnimationFrame fires', () => {
      const toast = Toast.success('Test');
      expect(toast.classList.contains('aether-toast--visible')).toBe(false);

      flushRAF();
      expect(toast.classList.contains('aether-toast--visible')).toBe(true);
    });

    it('visible class is present during the toast lifetime', () => {
      const toast = Toast.success('Test', 2000);
      flushRAF();
      expect(toast.classList.contains('aether-toast--visible')).toBe(true);

      // Midway through lifetime — still visible
      jest.advanceTimersByTime(1000);
      expect(toast.classList.contains('aether-toast--visible')).toBe(true);
    });
  });

  // =========================================================================
  // Dismiss lifecycle
  // =========================================================================

  describe('dismiss lifecycle', () => {
    it('removes visible class when auto-dismiss fires', () => {
      const toast = Toast.success('Test', 1000);
      flushRAF();
      expect(toast.classList.contains('aether-toast--visible')).toBe(true);

      // Auto-dismiss fires at 1000ms
      jest.advanceTimersByTime(1000);
      expect(toast.classList.contains('aether-toast--visible')).toBe(false);
    });

    it('keeps toast in DOM during 300ms dismiss animation', () => {
      const toast = Toast.success('Test', 1000);

      // Auto-dismiss fires at 1000ms
      jest.advanceTimersByTime(1000);
      // Toast still in DOM during animation
      expect(toast.parentNode).not.toBeNull();

      // At 299ms — still in DOM
      jest.advanceTimersByTime(299);
      expect(toast.parentNode).not.toBeNull();
    });

    it('removes toast from DOM after 300ms dismiss animation completes', () => {
      const toast = Toast.success('Test', 1000);

      jest.advanceTimersByTime(1000);
      expect(toast.parentNode).not.toBeNull();

      jest.advanceTimersByTime(300);
      expect(toast.parentNode).toBeNull();
    });

    it('removes container when toast was the last child', () => {
      Toast.success('Single', 1000);
      expect(getContainer()).not.toBeNull();

      jest.advanceTimersByTime(1000 + 300);
      expect(getContainer()).toBeNull();
    });

    it('does not remove container when other toasts remain', () => {
      Toast.success('First', 1000);
      Toast.success('Second', 5000);

      jest.advanceTimersByTime(1000 + 300);
      expect(getContainer()).not.toBeNull();
      expect(getContainer().children.length).toBe(1);
    });

    it('handles dismiss when container was already removed', () => {
      // Show a toast, manually remove container, then let dismiss fire
      const toast = Toast.success('Test', 1000);
      const container = getContainer();
      container.remove();

      // Auto-dismiss fires — should not throw
      expect(() => {
        jest.advanceTimersByTime(1000 + 300);
      }).not.toThrow();

      expect(toast.parentNode).toBeNull();
    });
  });

  // =========================================================================
  // Click-to-dismiss handlers
  // =========================================================================

  describe('click-to-dismiss', () => {
    it('dismisses toast when toast element is clicked', () => {
      const toast = Toast.success('Click me', 60000);

      toast.click();
      jest.advanceTimersByTime(300);
      expect(toast.parentNode).toBeNull();
    });

    it('dismisses toast when close button is clicked', () => {
      const toast = Toast.success('Close me', 60000);
      const closeBtn = toast.querySelector('.aether-toast-close');

      closeBtn.click();
      jest.advanceTimersByTime(300);
      expect(toast.parentNode).toBeNull();
    });

    it('close button click does not trigger toast click handler (stopPropagation)', () => {
      const toast = Toast.success('Test', 60000);
      const closeBtn = toast.querySelector('.aether-toast-close');

      const dismissSpy = jest.spyOn(Toast, '_dismissToast');

      closeBtn.click();

      // _dismissToast should be called exactly once (from close handler only)
      // Toast click handler should NOT fire due to stopPropagation
      expect(dismissSpy).toHaveBeenCalledTimes(1);
      expect(dismissSpy).toHaveBeenCalledWith(toast);

      dismissSpy.mockRestore();
    });

    it('removes container after manual click dismiss of last toast', () => {
      const toast = Toast.success('Only one', 60000);
      expect(getContainer()).not.toBeNull();

      toast.click();
      jest.advanceTimersByTime(300);
      expect(getContainer()).toBeNull();
    });

    it('keeps container after click dismiss when other toasts remain', () => {
      Toast.success('First', 60000);
      const second = Toast.success('Second', 60000);

      second.click();
      jest.advanceTimersByTime(300);

      expect(getContainer()).not.toBeNull();
      expect(getContainer().children.length).toBe(1);
    });
  });

  // =========================================================================
  // Custom duration
  // =========================================================================

  describe('custom duration', () => {
    it('success honors custom duration', () => {
      const toast = Toast.success('Quick', 500);
      jest.advanceTimersByTime(499);
      expect(toast.parentNode).not.toBeNull();

      jest.advanceTimersByTime(1 + 300);
      expect(toast.parentNode).toBeNull();
    });

    it('error honors custom duration', () => {
      const toast = Toast.error('Extended', 10000);
      jest.advanceTimersByTime(9999);
      expect(toast.parentNode).not.toBeNull();

      jest.advanceTimersByTime(1 + 300);
      expect(toast.parentNode).toBeNull();
    });

    it('info honors custom duration', () => {
      const toast = Toast.info('Brief', 100);
      jest.advanceTimersByTime(100 + 300);
      expect(toast.parentNode).toBeNull();
    });

    it('warning honors custom duration', () => {
      const toast = Toast.warning('Delayed', 7000);
      jest.advanceTimersByTime(6999);
      expect(toast.parentNode).not.toBeNull();

      jest.advanceTimersByTime(1 + 300);
      expect(toast.parentNode).toBeNull();
    });
  });

  // =========================================================================
  // Multiple toasts
  // =========================================================================

  describe('multiple toasts', () => {
    it('stacks multiple toasts in the same container', () => {
      Toast.success('A');
      Toast.error('B');
      Toast.info('C');
      Toast.warning('D');

      const container = getContainer();
      expect(container.children.length).toBe(4);
    });

    it('each stacked toast has correct type class', () => {
      const a = Toast.success('A');
      const b = Toast.error('B');
      const c = Toast.info('C');
      const d = Toast.warning('D');

      expect(a.classList.contains('aether-toast--success')).toBe(true);
      expect(b.classList.contains('aether-toast--error')).toBe(true);
      expect(c.classList.contains('aether-toast--info')).toBe(true);
      expect(d.classList.contains('aether-toast--warning')).toBe(true);
    });

    it('dismisses toasts individually by duration order', () => {
      Toast.success('Fast', 1000);
      Toast.error('Medium', 3000);
      Toast.info('Slow', 5000);

      const container = getContainer();
      expect(container.children.length).toBe(3);

      // Fast dismissed at 1300ms
      jest.advanceTimersByTime(1000 + 300);
      expect(container.children.length).toBe(2);

      // Medium dismissed at 3300ms (3000 + 300 from time 0)
      // We've already advanced 1300ms, so advance 2000 more
      jest.advanceTimersByTime(2000);
      expect(container.children.length).toBe(1);

      // Slow dismissed at 5300ms from time 0
      // We've already advanced 3300ms, advance 2000 more
      jest.advanceTimersByTime(2000);
      expect(container.children.length).toBe(0);
    });

    it('removes container after all toasts are dismissed', () => {
      Toast.success('A', 1000);
      Toast.info('B', 2000);

      jest.advanceTimersByTime(2000 + 300);
      expect(getContainer()).toBeNull();
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('handles empty string message', () => {
      const toast = Toast.success('');
      const msg = toast.querySelector('.aether-toast-message');
      expect(msg.textContent).toBe('');
    });

    it('handles very long message', () => {
      const longMsg = 'A'.repeat(5000);
      const toast = Toast.success(longMsg);
      const msg = toast.querySelector('.aether-toast-message');
      expect(msg.textContent).toBe(longMsg);
      expect(msg.textContent.length).toBe(5000);
    });

    it('handles special characters in message', () => {
      const special = '<script>alert("xss")</script>&amp;';
      const toast = Toast.success(special);
      const msg = toast.querySelector('.aether-toast-message');
      // textContent is used (not innerHTML), so it's safe — stored as text
      expect(msg.textContent).toBe(special);
    });

    it('double dismiss (manual + auto) does not throw', () => {
      const toast = Toast.success('Test', 2000);

      // Manual dismiss via click
      toast.click();
      // Auto-dismiss fires at 2000ms
      // Both 300ms animation timeouts run
      expect(() => {
        jest.runAllTimers();
      }).not.toThrow();

      expect(toast.parentNode).toBeNull();
    });

    it('double dismiss does not corrupt other toasts', () => {
      const toast1 = Toast.success('First', 1000);
      const toast2 = Toast.success('Second', 5000);

      // Manual dismiss toast1 before auto-dismiss
      toast1.click();
      // Then auto-dismiss for toast1 also fires
      jest.advanceTimersByTime(1000 + 300);

      // toast2 should still be intact
      expect(toast2.parentNode).not.toBeNull();
      expect(getContainer()).not.toBeNull();
      expect(getContainer().children.length).toBe(1);
    });

    it('rapid toast creation (10 toasts) handles correctly', () => {
      const toasts = [];
      for (let i = 0; i < 10; i++) {
        toasts.push(Toast.success(`Toast ${i}`, 100));
      }

      const container = getContainer();
      expect(container.children.length).toBe(10);

      // All dismissed
      jest.runAllTimers();
      expect(getContainer()).toBeNull();
    });

    it('duration of 0 still dismisses after next tick + 300ms animation', () => {
      const toast = Toast.success('Instant', 0);

      // setTimeout(fn, 0) fires on next tick advancement
      jest.advanceTimersByTime(0);
      // Now _dismissToast has been called, 300ms animation started
      jest.advanceTimersByTime(300);
      expect(toast.parentNode).toBeNull();
    });

    it('toast returned by public method is same element appended to container', () => {
      const toast = Toast.success('Check');
      const container = getContainer();
      const appended = container.children[0];
      expect(toast).toBe(appended);
    });

    it('container id is exactly aether-toast-container', () => {
      Toast.info('Test');
      const container = getContainer();
      expect(container.id).toBe('aether-toast-container');
    });

    it('existing container with same id is reused (not duplicated)', () => {
      // Pre-create a container manually
      const preExisting = document.createElement('div');
      preExisting.id = 'aether-toast-container';
      document.body.appendChild(preExisting);

      Toast.success('Added to existing');

      // Should find the pre-existing container, not create a new one
      const containers = document.querySelectorAll('#aether-toast-container');
      expect(containers.length).toBe(1);
      expect(containers[0]).toBe(preExisting);
      expect(preExisting.children.length).toBe(1);
    });
  });
});
