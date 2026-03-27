'use strict';

// ---------------------------------------------------------------------------
// DialogManager.js — Unit tests
// ---------------------------------------------------------------------------
// Source: src/renderer/main/modules/agents/components/dialogs/DialogManager.js (200 lines)
// Pure DOM class. Manages dialog lifecycle, listener tracking, stack.
// ---------------------------------------------------------------------------

const DialogManager = require('../../../../src/renderer/main/modules/agents/components/dialogs/DialogManager');

describe('DialogManager', () => {
  let dm;
  let logger;

  beforeEach(() => {
    jest.useFakeTimers();
    document.body.innerHTML = '';
    logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    dm = new DialogManager({ logger });

    // rAF polyfill
    global.requestAnimationFrame = window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  function makeDialog(id) {
    const el = document.createElement('div');
    el.id = id || 'dialog-' + Math.random().toString(36).slice(2);
    el.classList.add('dialog');
    return el;
  }

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('initializes empty dialog stack', () => {
      expect(dm._dialogStack).toEqual([]);
    });

    it('initializes empty dialog listeners map', () => {
      expect(dm._dialogListeners).toBeInstanceOf(Map);
      expect(dm._dialogListeners.size).toBe(0);
    });

    it('initializes empty timers array', () => {
      expect(dm._timers).toEqual([]);
    });

    it('uses provided logger', () => {
      expect(dm.logger).toBe(logger);
    });

    it('defaults logger to console when not provided', () => {
      const d = new DialogManager();
      expect(d.logger).toBe(console);
    });
  });

  // =========================================================================
  // open
  // =========================================================================

  describe('open', () => {
    it('appends dialog to document.body', () => {
      const dialog = makeDialog('d1');
      dm.open(dialog);
      expect(document.body.contains(dialog)).toBe(true);
    });

    it('pushes dialog onto stack', () => {
      const dialog = makeDialog('d1');
      dm.open(dialog);
      expect(dm._dialogStack).toHaveLength(1);
      expect(dm._dialogStack[0]).toBe(dialog);
    });

    it('initializes listener array for the dialog', () => {
      const dialog = makeDialog('d1');
      dm.open(dialog);
      expect(dm._dialogListeners.get(dialog)).toEqual([]);
    });

    it('adds visible class after requestAnimationFrame', () => {
      const dialog = makeDialog('d1');
      dm.open(dialog);
      expect(dialog.classList.contains('visible')).toBe(false);
      jest.advanceTimersByTime(0);
      expect(dialog.classList.contains('visible')).toBe(true);
    });

    it('logs dialog opened with stack depth', () => {
      dm.open(makeDialog());
      expect(logger.info).toHaveBeenCalledWith('DialogManager: Dialog opened', { stackDepth: 1 });
    });

    it('logs when opening null dialog', () => {
      dm.open(null);
      expect(logger.error).toHaveBeenCalledWith('DialogManager: Cannot open null dialog');
    });

    it('does not push null to stack', () => {
      dm.open(null);
      expect(dm._dialogStack).toHaveLength(0);
    });

    it('disables pointer events on previous dialog when stacking', () => {
      const d1 = makeDialog('d1');
      const d2 = makeDialog('d2');
      dm.open(d1);
      dm.open(d2);
      expect(d1.style.pointerEvents).toBe('none');
      expect(d1.style.filter).toBe('brightness(0.7) blur(2px)');
    });

    it('tracks stack depth correctly for nested dialogs', () => {
      dm.open(makeDialog());
      dm.open(makeDialog());
      dm.open(makeDialog());
      expect(dm._dialogStack).toHaveLength(3);
    });
  });

  // =========================================================================
  // close
  // =========================================================================

  describe('close', () => {
    it('does nothing when stack is empty', () => {
      dm.close();
      // No error thrown
      expect(dm._dialogStack).toHaveLength(0);
    });

    it('handles falsy value on stack gracefully (defensive guard)', () => {
      // Push a falsy value to test the `if (!dialog) return` branch
      dm._dialogStack.push(null);
      expect(() => dm.close()).not.toThrow();
      expect(dm._dialogStack).toHaveLength(0);
    });

    it('pops dialog from stack', () => {
      const d1 = makeDialog('d1');
      dm.open(d1);
      dm.close();
      expect(dm._dialogStack).toHaveLength(0);
    });

    it('removes visible class from dialog', () => {
      const d1 = makeDialog('d1');
      dm.open(d1);
      jest.advanceTimersByTime(0);
      expect(d1.classList.contains('visible')).toBe(true);
      dm.close();
      expect(d1.classList.contains('visible')).toBe(false);
    });

    it('sets pointer events to none on closed dialog', () => {
      const d1 = makeDialog('d1');
      dm.open(d1);
      dm.close();
      expect(d1.style.pointerEvents).toBe('none');
    });

    it('removes dialog from DOM after 200ms animation', () => {
      const d1 = makeDialog('d1');
      dm.open(d1);
      dm.close();
      // Still in DOM immediately
      expect(document.body.contains(d1)).toBe(true);
      jest.advanceTimersByTime(200);
      expect(document.body.contains(d1)).toBe(false);
    });

    it('restores pointer events on previous dialog after close', () => {
      const d1 = makeDialog('d1');
      const d2 = makeDialog('d2');
      dm.open(d1);
      dm.open(d2);
      dm.close();
      jest.advanceTimersByTime(200);
      expect(d1.style.pointerEvents).toBe('auto');
      expect(d1.style.filter).toBe('');
    });

    it('logs dialog closed with remaining stack count', () => {
      dm.open(makeDialog());
      dm.close();
      expect(logger.info).toHaveBeenCalledWith('DialogManager: Dialog closed', { stackRemaining: 0 });
    });

    it('clears tracked listeners for the closed dialog', () => {
      const d1 = makeDialog('d1');
      dm.open(d1);

      const btn = document.createElement('button');
      const handler = jest.fn();
      dm.trackListener(btn, 'click', handler);

      dm.close();
      // Listeners should be cleaned
      expect(dm._dialogListeners.has(d1)).toBe(false);
    });

    it('removes event listeners from tracked elements', () => {
      const d1 = makeDialog('d1');
      dm.open(d1);

      const btn = document.createElement('button');
      const handler = jest.fn();
      dm.trackListener(btn, 'click', handler);

      dm.close();
      btn.click();
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // trackListener
  // =========================================================================

  describe('trackListener', () => {
    it('adds event listener to element', () => {
      const d1 = makeDialog('d1');
      dm.open(d1);

      const btn = document.createElement('button');
      const handler = jest.fn();
      dm.trackListener(btn, 'click', handler);

      btn.click();
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('records listener in dialog listener map', () => {
      const d1 = makeDialog('d1');
      dm.open(d1);

      const btn = document.createElement('button');
      const handler = jest.fn();
      dm.trackListener(btn, 'click', handler, { capture: true });

      const listeners = dm._dialogListeners.get(d1);
      expect(listeners).toHaveLength(1);
      expect(listeners[0]).toEqual({
        element: btn,
        event: 'click',
        handler,
        options: { capture: true },
      });
    });

    it('does nothing when no active dialog', () => {
      const btn = document.createElement('button');
      dm.trackListener(btn, 'click', jest.fn());
      // No error, no listener added
    });

    it('logs warning for invalid parameters (null element)', () => {
      dm.open(makeDialog());
      dm.trackListener(null, 'click', jest.fn());
      expect(logger.warn).toHaveBeenCalledWith('DialogManager: Invalid listener parameters');
    });

    it('logs warning for invalid parameters (no event)', () => {
      dm.open(makeDialog());
      dm.trackListener(document.createElement('div'), '', jest.fn());
      expect(logger.warn).toHaveBeenCalledWith('DialogManager: Invalid listener parameters');
    });

    it('logs warning for invalid parameters (no handler)', () => {
      dm.open(makeDialog());
      dm.trackListener(document.createElement('div'), 'click', null);
      expect(logger.warn).toHaveBeenCalledWith('DialogManager: Invalid listener parameters');
    });

    it('creates listener array if not present for active dialog', () => {
      const d1 = makeDialog('d1');
      dm.open(d1);
      // Remove the array manually to test the || [] fallback
      dm._dialogListeners.delete(d1);

      const btn = document.createElement('button');
      dm.trackListener(btn, 'click', jest.fn());

      const listeners = dm._dialogListeners.get(d1);
      expect(listeners).toHaveLength(1);
    });
  });

  // =========================================================================
  // _clearDialogListeners
  // =========================================================================

  describe('_clearDialogListeners', () => {
    it('does nothing when dialog has no tracked listeners', () => {
      const d1 = makeDialog('d1');
      expect(() => dm._clearDialogListeners(d1)).not.toThrow();
    });

    it('removes all listeners and deletes map entry', () => {
      const d1 = makeDialog('d1');
      dm.open(d1);

      const btn1 = document.createElement('button');
      const btn2 = document.createElement('button');
      const h1 = jest.fn();
      const h2 = jest.fn();
      dm.trackListener(btn1, 'click', h1);
      dm.trackListener(btn2, 'click', h2);

      dm._clearDialogListeners(d1);

      btn1.click();
      btn2.click();
      expect(h1).not.toHaveBeenCalled();
      expect(h2).not.toHaveBeenCalled();
      expect(dm._dialogListeners.has(d1)).toBe(false);
    });

    it('handles null element in listener gracefully', () => {
      const d1 = makeDialog('d1');
      dm.open(d1);
      // Manually push a listener with null element
      dm._dialogListeners.get(d1).push({
        element: null,
        event: 'click',
        handler: jest.fn(),
        options: undefined,
      });

      expect(() => dm._clearDialogListeners(d1)).not.toThrow();
    });
  });

  // =========================================================================
  // _trackTimer
  // =========================================================================

  describe('_trackTimer', () => {
    it('adds timer id to _timers array', () => {
      dm._trackTimer(42);
      expect(dm._timers).toContain(42);
    });

    it('does not add falsy timer id', () => {
      dm._trackTimer(0);
      expect(dm._timers).toHaveLength(0);
    });

    it('does not add null timer id', () => {
      dm._trackTimer(null);
      expect(dm._timers).toHaveLength(0);
    });
  });

  // =========================================================================
  // _clearTimers
  // =========================================================================

  describe('_clearTimers', () => {
    it('clears all tracked timers', () => {
      const spy = jest.spyOn(global, 'clearTimeout');
      dm._timers = [101, 102, 103];
      dm._clearTimers();
      expect(spy).toHaveBeenCalledTimes(3);
      expect(dm._timers).toEqual([]);
    });
  });

  // =========================================================================
  // isOpen
  // =========================================================================

  describe('isOpen', () => {
    it('returns false when no dialogs', () => {
      expect(dm.isOpen()).toBe(false);
    });

    it('returns true when dialog is open', () => {
      dm.open(makeDialog());
      expect(dm.isOpen()).toBe(true);
    });

    it('returns false after all dialogs closed', () => {
      dm.open(makeDialog());
      dm.close();
      expect(dm.isOpen()).toBe(false);
    });
  });

  // =========================================================================
  // getActiveDialog
  // =========================================================================

  describe('getActiveDialog', () => {
    it('returns null when no dialogs', () => {
      expect(dm.getActiveDialog()).toBeNull();
    });

    it('returns the top dialog on stack', () => {
      const d1 = makeDialog('d1');
      const d2 = makeDialog('d2');
      dm.open(d1);
      dm.open(d2);
      expect(dm.getActiveDialog()).toBe(d2);
    });

    it('returns previous dialog after close', () => {
      const d1 = makeDialog('d1');
      const d2 = makeDialog('d2');
      dm.open(d1);
      dm.open(d2);
      dm.close();
      expect(dm.getActiveDialog()).toBe(d1);
    });
  });

  // =========================================================================
  // cleanup
  // =========================================================================

  describe('cleanup', () => {
    it('removes all dialogs from DOM', () => {
      const d1 = makeDialog('d1');
      const d2 = makeDialog('d2');
      dm.open(d1);
      dm.open(d2);
      dm.cleanup();
      expect(document.body.contains(d1)).toBe(false);
      expect(document.body.contains(d2)).toBe(false);
    });

    it('empties dialog stack', () => {
      dm.open(makeDialog());
      dm.open(makeDialog());
      dm.cleanup();
      expect(dm._dialogStack).toHaveLength(0);
    });

    it('clears all tracked listeners', () => {
      const d1 = makeDialog('d1');
      dm.open(d1);
      const btn = document.createElement('button');
      const handler = jest.fn();
      dm.trackListener(btn, 'click', handler);

      dm.cleanup();
      btn.click();
      expect(handler).not.toHaveBeenCalled();
    });

    it('clears dialog listeners map', () => {
      dm.open(makeDialog());
      dm.cleanup();
      expect(dm._dialogListeners.size).toBe(0);
    });

    it('clears all timers', () => {
      const spy = jest.spyOn(global, 'clearTimeout');
      dm._timers = [201, 202];
      dm.cleanup();
      expect(spy).toHaveBeenCalledTimes(2);
      expect(dm._timers).toEqual([]);
    });

    it('handles cleanup when already empty', () => {
      expect(() => dm.cleanup()).not.toThrow();
    });
  });

  // =========================================================================
  // Full lifecycle: open → track → close → verify cleanup
  // =========================================================================

  describe('full lifecycle', () => {
    it('creates and cleans up resources through open/track/close cycle', () => {
      const d1 = makeDialog('d1');
      dm.open(d1);

      const btn = document.createElement('button');
      const handler = jest.fn();
      dm.trackListener(btn, 'click', handler);

      expect(dm.isOpen()).toBe(true);
      expect(dm.getActiveDialog()).toBe(d1);

      dm.close();
      jest.advanceTimersByTime(200);

      expect(dm.isOpen()).toBe(false);
      expect(dm.getActiveDialog()).toBeNull();
      expect(document.body.contains(d1)).toBe(false);

      btn.click();
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
