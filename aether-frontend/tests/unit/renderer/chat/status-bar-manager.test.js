'use strict';

// ---------------------------------------------------------------------------
// StatusBarManager.js — Comprehensive unit tests
// ---------------------------------------------------------------------------
// Source: src/renderer/chat/modules/messaging/ui/StatusBarManager.js (170 lines)
// Status bar DOM updates — connection status, typing indicators, model info.
// Timer-based auto-hide. ARIA live regions for accessibility.
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

const StatusBarManager = require('../../../../src/renderer/chat/modules/messaging/ui/StatusBarManager');

describe('StatusBarManager', () => {
  let statusEl;

  beforeEach(() => {
    jest.useFakeTimers();
    document.body.innerHTML = '';
    statusEl = document.createElement('div');
    statusEl.id = 'aether-chat-status';
    document.body.appendChild(statusEl);
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('stores statusElement from options', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      expect(mgr.statusElement).toBe(statusEl);
    });

    it('defaults statusElement to null when not provided', () => {
      const mgr = new StatusBarManager();
      expect(mgr.statusElement).toBeNull();
    });

    it('defaults statusElement to null for empty options', () => {
      const mgr = new StatusBarManager({});
      expect(mgr.statusElement).toBeNull();
    });

    it('initializes _timeout to null', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      expect(mgr._timeout).toBeNull();
    });

    it('initializes _currentVariant to null', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      expect(mgr._currentVariant).toBeNull();
    });
  });

  // =========================================================================
  // show()
  // =========================================================================

  describe('show()', () => {
    it('sets textContent to the provided message', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.show('info', 'Hello world');

      expect(statusEl.textContent).toBe('Hello world');
    });

    it('sets data-variant attribute', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.show('error', 'Something failed');

      expect(statusEl.dataset.variant).toBe('error');
    });

    it('adds visible class', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.show('info', 'Test');

      expect(statusEl.classList.contains('visible')).toBe(true);
    });

    it('sets aria-hidden to false', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.show('info', 'Test');

      expect(statusEl.getAttribute('aria-hidden')).toBe('false');
    });

    it('sets aria-live to assertive for error variant', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.show('error', 'Critical failure');

      expect(statusEl.getAttribute('aria-live')).toBe('assertive');
    });

    it('sets aria-live to polite for non-error variants', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });

      mgr.show('success', 'Saved');
      expect(statusEl.getAttribute('aria-live')).toBe('polite');

      mgr.show('info', 'Info');
      expect(statusEl.getAttribute('aria-live')).toBe('polite');

      mgr.show('processing', 'Loading...');
      expect(statusEl.getAttribute('aria-live')).toBe('polite');
    });

    it('stores current variant', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.show('success', 'Done');

      expect(mgr._currentVariant).toBe('success');
    });

    it('auto-hides after default 6000ms duration', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.show('info', 'Temporary');

      jest.advanceTimersByTime(5999);
      expect(statusEl.classList.contains('visible')).toBe(true);

      jest.advanceTimersByTime(1);
      expect(statusEl.classList.contains('visible')).toBe(false);
      expect(statusEl.textContent).toBe('');
    });

    it('auto-hides after custom duration', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.show('info', 'Quick', 1000);

      jest.advanceTimersByTime(999);
      expect(statusEl.classList.contains('visible')).toBe(true);

      jest.advanceTimersByTime(1);
      expect(statusEl.classList.contains('visible')).toBe(false);
    });

    it('does NOT auto-hide when variant is processing', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.show('processing', 'Loading...', 6000);

      jest.advanceTimersByTime(10000);
      expect(statusEl.classList.contains('visible')).toBe(true);
      expect(statusEl.textContent).toBe('Loading...');
    });

    it('does NOT auto-hide when duration is 0', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.show('info', 'Permanent', 0);

      jest.advanceTimersByTime(60000);
      expect(statusEl.classList.contains('visible')).toBe(true);
    });

    it('does NOT auto-hide when duration is negative', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.show('info', 'Negative', -1);

      jest.advanceTimersByTime(60000);
      expect(statusEl.classList.contains('visible')).toBe(true);
    });

    it('clears previous timeout when showing new message', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });

      mgr.show('info', 'First', 2000);
      jest.advanceTimersByTime(1500);
      // Replace before first auto-hide fires
      mgr.show('success', 'Second', 3000);

      // First timeout (at 2000ms) should NOT clear — it was already cancelled
      jest.advanceTimersByTime(500);
      expect(statusEl.textContent).toBe('Second');
      expect(statusEl.classList.contains('visible')).toBe(true);

      // Second timeout fires at 3000ms from the second show() call
      jest.advanceTimersByTime(2500);
      expect(statusEl.classList.contains('visible')).toBe(false);
    });

    it('returns early when statusElement is null', () => {
      const mgr = new StatusBarManager();

      // Should not throw
      expect(() => mgr.show('error', 'Test')).not.toThrow();
      expect(mgr._currentVariant).toBeNull();
    });

    it('overwrites previous status completely', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });

      mgr.show('error', 'Error occurred');
      expect(statusEl.textContent).toBe('Error occurred');
      expect(statusEl.dataset.variant).toBe('error');

      mgr.show('success', 'All good');
      expect(statusEl.textContent).toBe('All good');
      expect(statusEl.dataset.variant).toBe('success');
    });
  });

  // =========================================================================
  // clear()
  // =========================================================================

  describe('clear()', () => {
    it('removes visible class', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.show('info', 'Test');
      mgr.clear();

      expect(statusEl.classList.contains('visible')).toBe(false);
    });

    it('clears textContent', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.show('info', 'Test');
      mgr.clear();

      expect(statusEl.textContent).toBe('');
    });

    it('removes data-variant attribute', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.show('info', 'Test');
      expect(statusEl.dataset.variant).toBe('info');

      mgr.clear();
      expect(statusEl.hasAttribute('data-variant')).toBe(false);
    });

    it('sets aria-hidden to true', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.show('info', 'Test');
      mgr.clear();

      expect(statusEl.getAttribute('aria-hidden')).toBe('true');
    });

    it('removes aria-live attribute', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.show('error', 'Test');
      expect(statusEl.hasAttribute('aria-live')).toBe(true);

      mgr.clear();
      expect(statusEl.hasAttribute('aria-live')).toBe(false);
    });

    it('resets _currentVariant to null', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.show('error', 'Problem');
      expect(mgr._currentVariant).toBe('error');

      mgr.clear();
      expect(mgr._currentVariant).toBeNull();
    });

    it('clears pending auto-hide timeout', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.show('info', 'Test', 5000);

      // Clear before auto-hide fires
      mgr.clear();
      expect(mgr._timeout).toBeNull();

      // Advance past original timeout — should NOT throw or re-clear
      jest.advanceTimersByTime(10000);
      expect(statusEl.textContent).toBe('');
    });

    it('is idempotent — calling clear when already clear does not throw', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      expect(() => mgr.clear()).not.toThrow();
    });

    it('returns early when statusElement is null', () => {
      const mgr = new StatusBarManager();
      expect(() => mgr.clear()).not.toThrow();
    });
  });

  // =========================================================================
  // Convenience methods — showError, showProcessing, showSuccess, showInfo
  // =========================================================================

  describe('showError()', () => {
    it('shows with error variant and 6000ms duration', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.showError('Connection failed');

      expect(statusEl.textContent).toBe('Connection failed');
      expect(statusEl.dataset.variant).toBe('error');
      expect(statusEl.getAttribute('aria-live')).toBe('assertive');

      // Should auto-hide at 6000ms
      jest.advanceTimersByTime(5999);
      expect(statusEl.classList.contains('visible')).toBe(true);
      jest.advanceTimersByTime(1);
      expect(statusEl.classList.contains('visible')).toBe(false);
    });
  });

  describe('showProcessing()', () => {
    it('shows with processing variant and no auto-hide', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.showProcessing('Sending...');

      expect(statusEl.textContent).toBe('Sending...');
      expect(statusEl.dataset.variant).toBe('processing');
      expect(statusEl.getAttribute('aria-live')).toBe('polite');

      // Should NOT auto-hide even after long time
      jest.advanceTimersByTime(60000);
      expect(statusEl.classList.contains('visible')).toBe(true);
    });

    it('can be cleared manually', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.showProcessing('Working...');

      jest.advanceTimersByTime(5000);
      expect(statusEl.classList.contains('visible')).toBe(true);

      mgr.clear();
      expect(statusEl.classList.contains('visible')).toBe(false);
    });
  });

  describe('showSuccess()', () => {
    it('shows with success variant and 3000ms duration', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.showSuccess('Saved!');

      expect(statusEl.textContent).toBe('Saved!');
      expect(statusEl.dataset.variant).toBe('success');

      jest.advanceTimersByTime(2999);
      expect(statusEl.classList.contains('visible')).toBe(true);
      jest.advanceTimersByTime(1);
      expect(statusEl.classList.contains('visible')).toBe(false);
    });
  });

  describe('showInfo()', () => {
    it('shows with info variant and 4000ms duration', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.showInfo('Update available');

      expect(statusEl.textContent).toBe('Update available');
      expect(statusEl.dataset.variant).toBe('info');

      jest.advanceTimersByTime(3999);
      expect(statusEl.classList.contains('visible')).toBe(true);
      jest.advanceTimersByTime(1);
      expect(statusEl.classList.contains('visible')).toBe(false);
    });
  });

  // =========================================================================
  // getCurrentVariant()
  // =========================================================================

  describe('getCurrentVariant()', () => {
    it('returns null initially', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      expect(mgr.getCurrentVariant()).toBeNull();
    });

    it('returns current variant after show()', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.show('error', 'Fail');
      expect(mgr.getCurrentVariant()).toBe('error');
    });

    it('updates on each show() call', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });

      mgr.show('error', 'E');
      expect(mgr.getCurrentVariant()).toBe('error');

      mgr.show('success', 'S');
      expect(mgr.getCurrentVariant()).toBe('success');

      mgr.show('processing', 'P');
      expect(mgr.getCurrentVariant()).toBe('processing');
    });

    it('returns null after clear()', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.show('info', 'Test');
      mgr.clear();
      expect(mgr.getCurrentVariant()).toBeNull();
    });

    it('returns null after auto-hide fires', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.show('success', 'Done', 1000);

      jest.advanceTimersByTime(1000);
      expect(mgr.getCurrentVariant()).toBeNull();
    });
  });

  // =========================================================================
  // dispose()
  // =========================================================================

  describe('dispose()', () => {
    it('clears pending auto-hide timeout', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.show('info', 'Test', 5000);
      expect(mgr._timeout).not.toBeNull();

      mgr.dispose();
      expect(mgr._timeout).toBeNull();
    });

    it('nulls statusElement', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.dispose();
      expect(mgr.statusElement).toBeNull();
    });

    it('nulls _currentVariant', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.show('error', 'Problem');
      mgr.dispose();
      expect(mgr._currentVariant).toBeNull();
    });

    it('does not throw on double dispose', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.dispose();
      expect(() => mgr.dispose()).not.toThrow();
    });

    it('after dispose, show() is a safe no-op', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.dispose();

      expect(() => mgr.show('error', 'Test')).not.toThrow();
      expect(mgr._currentVariant).toBeNull();
    });

    it('after dispose, clear() is a safe no-op', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.dispose();

      expect(() => mgr.clear()).not.toThrow();
    });

    it('pending timeout does not fire after dispose', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.show('info', 'Test', 2000);

      // Mark status so we can verify clear() was NOT called after dispose
      statusEl.classList.add('visible');
      mgr.dispose();

      // Advance past the original timeout
      jest.advanceTimersByTime(5000);

      // The visible class should still be on the element because clear()
      // was never called (timeout was cancelled by dispose)
      expect(statusEl.classList.contains('visible')).toBe(true);
    });
  });

  // =========================================================================
  // Lifecycle and sequencing
  // =========================================================================

  describe('lifecycle', () => {
    it('show → clear → show cycle works correctly', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });

      mgr.show('error', 'Error!');
      expect(statusEl.textContent).toBe('Error!');

      mgr.clear();
      expect(statusEl.textContent).toBe('');

      mgr.show('success', 'Fixed!');
      expect(statusEl.textContent).toBe('Fixed!');
      expect(statusEl.dataset.variant).toBe('success');
    });

    it('processing → success transition works', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });

      mgr.showProcessing('Sending message...');
      expect(mgr.getCurrentVariant()).toBe('processing');

      // Simulate completion
      mgr.showSuccess('Message sent!');
      expect(mgr.getCurrentVariant()).toBe('success');
      expect(statusEl.textContent).toBe('Message sent!');

      // Auto-hide fires for success
      jest.advanceTimersByTime(3000);
      expect(mgr.getCurrentVariant()).toBeNull();
      expect(statusEl.classList.contains('visible')).toBe(false);
    });

    it('rapid show() calls cancel all previous timeouts', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });

      mgr.show('info', 'A', 1000);
      mgr.show('info', 'B', 1000);
      mgr.show('info', 'C', 1000);

      // Only the last timeout should matter
      jest.advanceTimersByTime(999);
      expect(statusEl.textContent).toBe('C');
      expect(statusEl.classList.contains('visible')).toBe(true);

      jest.advanceTimersByTime(1);
      expect(statusEl.classList.contains('visible')).toBe(false);
    });

    it('auto-hide timeout for first message cancelled by second show()', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      const clearSpy = jest.spyOn(mgr, 'clear');

      mgr.show('info', 'First', 1000);
      mgr.show('success', 'Second', 5000);

      // At 1000ms — first timeout should NOT fire (was cancelled)
      jest.advanceTimersByTime(1000);
      expect(clearSpy).not.toHaveBeenCalled();

      // At 5000ms from second show — should auto-hide
      jest.advanceTimersByTime(4000);
      expect(clearSpy).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('handles empty message string', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.show('info', '');

      expect(statusEl.textContent).toBe('');
      expect(statusEl.classList.contains('visible')).toBe(true);
    });

    it('handles very long message', () => {
      const longMsg = 'X'.repeat(5000);
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.show('info', longMsg);

      expect(statusEl.textContent).toBe(longMsg);
    });

    it('handles unknown variant gracefully', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.show('unknown_variant', 'Test');

      expect(statusEl.dataset.variant).toBe('unknown_variant');
      expect(statusEl.getAttribute('aria-live')).toBe('polite');
      expect(mgr.getCurrentVariant()).toBe('unknown_variant');
    });

    it('constructor without options does not throw', () => {
      expect(() => new StatusBarManager()).not.toThrow();
    });
  });

  // =========================================================================
  // Module exports
  // =========================================================================

  describe('module exports', () => {
    it('exports StatusBarManager class', () => {
      expect(typeof StatusBarManager).toBe('function');
      expect(StatusBarManager.name).toBe('StatusBarManager');
    });
  });

  // =========================================================================
  // BUG REGRESSIONS (SBM-1)
  // =========================================================================

  describe('bug regressions', () => {
    it('[SBM-1] constructor initializes _isDisposed to false', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      expect(mgr._isDisposed).toBe(false);
    });

    it('[SBM-1] show is no-op after dispose (prevents timer leak)', () => {
      jest.useFakeTimers();
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.dispose();

      // After dispose, show() should not create a new setTimeout
      mgr.show('error', 'Should not show');
      expect(mgr._timeout).toBeNull();
      expect(statusEl.textContent).toBe(''); // statusElement is null, no DOM update

      jest.useRealTimers();
    });

    it('[SBM-1] dispose is idempotent (double-dispose safe)', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.dispose();
      expect(() => mgr.dispose()).not.toThrow();
      expect(mgr._isDisposed).toBe(true);
    });

    it('[SBM-1] show after dispose does not crash even with null statusElement', () => {
      const mgr = new StatusBarManager({ statusElement: statusEl });
      mgr.dispose();
      expect(mgr.statusElement).toBeNull();

      // Should not throw
      expect(() => mgr.show('info', 'test')).not.toThrow();
    });
  });
});
