'use strict';

// ---------------------------------------------------------------------------
// InputUIController.js — Comprehensive unit tests
// ---------------------------------------------------------------------------
// Source: src/renderer/chat/modules/messaging/ui/InputUIController.js (146 lines)
// DOM input field management — auto-resize, validation UI, focus, ARIA.
// ---------------------------------------------------------------------------

// Logger mock: use plain noop functions to survive resetMocks: true
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

const InputUIController = require('../../../../src/renderer/chat/modules/messaging/ui/InputUIController');

describe('InputUIController', () => {
  let input;

  beforeEach(() => {
    document.body.innerHTML = '';
    input = document.createElement('textarea');
    input.id = 'test-input';
    document.body.appendChild(input);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('stores inputElement from options', () => {
      const ctrl = new InputUIController({ inputElement: input });
      expect(ctrl.inputElement).toBe(input);
    });

    it('throws when no options provided', () => {
      expect(() => new InputUIController())
        .toThrow('[InputUIController] inputElement is REQUIRED');
    });

    it('throws when options is empty object', () => {
      expect(() => new InputUIController({}))
        .toThrow('[InputUIController] inputElement is REQUIRED');
    });

    it('throws when inputElement is null', () => {
      expect(() => new InputUIController({ inputElement: null }))
        .toThrow('[InputUIController] inputElement is REQUIRED');
    });

    it('throws when inputElement is undefined', () => {
      expect(() => new InputUIController({ inputElement: undefined }))
        .toThrow('[InputUIController] inputElement is REQUIRED');
    });

    it('initializes log via logger.child', () => {
      const ctrl = new InputUIController({ inputElement: input });
      expect(ctrl.log).toBeDefined();
      expect(typeof ctrl.log.info).toBe('function');
      expect(typeof ctrl.log.trace).toBe('function');
    });
  });

  // =========================================================================
  // setupListeners()
  // =========================================================================

  describe('setupListeners()', () => {
    it('adds input event listener to the input element', () => {
      const addSpy = jest.spyOn(input, 'addEventListener');
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.setupListeners();

      expect(addSpy).toHaveBeenCalledWith('input', expect.any(Function));
    });

    it('adds focus event listener to the input element', () => {
      const addSpy = jest.spyOn(input, 'addEventListener');
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.setupListeners();

      expect(addSpy).toHaveBeenCalledWith('focus', expect.any(Function));
    });

    it('adds exactly 2 listeners', () => {
      const addSpy = jest.spyOn(input, 'addEventListener');
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.setupListeners();

      expect(addSpy).toHaveBeenCalledTimes(2);
    });

    it('input event triggers autoResize', () => {
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.setupListeners();

      const resizeSpy = jest.spyOn(ctrl, 'autoResize');
      input.dispatchEvent(new Event('input'));
      expect(resizeSpy).toHaveBeenCalledTimes(1);
    });

    it('focus event triggers clearValidation', () => {
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.setupListeners();

      const clearSpy = jest.spyOn(ctrl, 'clearValidation');
      input.dispatchEvent(new Event('focus'));
      expect(clearSpy).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // autoResize()
  // =========================================================================

  describe('autoResize()', () => {
    it('sets height to auto then to scrollHeight-based value', () => {
      Object.defineProperty(input, 'scrollHeight', {
        value: 80, writable: true, configurable: true,
      });

      const ctrl = new InputUIController({ inputElement: input });
      ctrl.autoResize();

      expect(input.style.height).toBe('80px');
    });

    it('caps height at 150px when scrollHeight exceeds 150', () => {
      Object.defineProperty(input, 'scrollHeight', {
        value: 300, writable: true, configurable: true,
      });

      const ctrl = new InputUIController({ inputElement: input });
      ctrl.autoResize();

      expect(input.style.height).toBe('150px');
    });

    it('uses exact scrollHeight when at 150', () => {
      Object.defineProperty(input, 'scrollHeight', {
        value: 150, writable: true, configurable: true,
      });

      const ctrl = new InputUIController({ inputElement: input });
      ctrl.autoResize();

      expect(input.style.height).toBe('150px');
    });

    it('handles scrollHeight of 0', () => {
      Object.defineProperty(input, 'scrollHeight', {
        value: 0, writable: true, configurable: true,
      });

      const ctrl = new InputUIController({ inputElement: input });
      ctrl.autoResize();

      expect(input.style.height).toBe('0px');
    });

    it('resets height to auto before measuring (allows shrink)', () => {
      const heightValues = [];
      const origSetProperty = input.style.setProperty;
      // Track style.height assignments
      let realHeight = '';
      Object.defineProperty(input.style, 'height', {
        get() { return realHeight; },
        set(v) {
          heightValues.push(v);
          realHeight = v;
        },
        configurable: true,
      });
      Object.defineProperty(input, 'scrollHeight', {
        value: 60, writable: true, configurable: true,
      });

      const ctrl = new InputUIController({ inputElement: input });
      ctrl.autoResize();

      // First assignment should be 'auto', second should be the pixel value
      expect(heightValues[0]).toBe('auto');
      expect(heightValues[1]).toBe('60px');
    });

    it('returns early when inputElement is null (after dispose)', () => {
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.dispose();

      // Should not throw
      expect(() => ctrl.autoResize()).not.toThrow();
    });
  });

  // =========================================================================
  // markError()
  // =========================================================================

  describe('markError()', () => {
    it('adds validation-error class', () => {
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.markError('Bad input');

      expect(input.classList.contains('validation-error')).toBe(true);
    });

    it('sets aria-invalid to true', () => {
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.markError('Bad input');

      expect(input.getAttribute('aria-invalid')).toBe('true');
    });

    it('sets aria-errormessage to aether-chat-status', () => {
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.markError('Bad input');

      expect(input.getAttribute('aria-errormessage')).toBe('aether-chat-status');
    });

    it('sets data-error attribute when message is truthy', () => {
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.markError('Message too long');

      expect(input.getAttribute('data-error')).toBe('Message too long');
    });

    it('does NOT set data-error when message is empty string', () => {
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.markError('');

      expect(input.hasAttribute('data-error')).toBe(false);
    });

    it('does NOT set data-error when message is null', () => {
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.markError(null);

      expect(input.hasAttribute('data-error')).toBe(false);
    });

    it('does NOT set data-error when message is undefined', () => {
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.markError(undefined);

      expect(input.hasAttribute('data-error')).toBe(false);
    });

    it('does NOT set data-error when called without arguments', () => {
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.markError();

      // message parameter is undefined -> falsy -> no data-error
      expect(input.hasAttribute('data-error')).toBe(false);
      // But class and ARIA are still set
      expect(input.classList.contains('validation-error')).toBe(true);
      expect(input.getAttribute('aria-invalid')).toBe('true');
    });

    it('returns early when inputElement is null', () => {
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.dispose();

      expect(() => ctrl.markError('error')).not.toThrow();
      // Input should NOT have the class since disposal happened
      expect(input.classList.contains('validation-error')).toBe(false);
    });
  });

  // =========================================================================
  // clearValidation()
  // =========================================================================

  describe('clearValidation()', () => {
    it('removes validation-error class', () => {
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.markError('Error');
      ctrl.clearValidation();

      expect(input.classList.contains('validation-error')).toBe(false);
    });

    it('removes aria-invalid attribute', () => {
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.markError('Error');
      ctrl.clearValidation();

      expect(input.hasAttribute('aria-invalid')).toBe(false);
    });

    it('removes aria-errormessage attribute', () => {
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.markError('Error');
      ctrl.clearValidation();

      expect(input.hasAttribute('aria-errormessage')).toBe(false);
    });

    it('removes data-error attribute', () => {
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.markError('Problem');
      expect(input.hasAttribute('data-error')).toBe(true);

      ctrl.clearValidation();
      expect(input.hasAttribute('data-error')).toBe(false);
    });

    it('is idempotent — calling without prior error does not throw', () => {
      const ctrl = new InputUIController({ inputElement: input });
      expect(() => ctrl.clearValidation()).not.toThrow();
    });

    it('returns early when inputElement is null', () => {
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.markError('Error');
      ctrl.dispose();

      expect(() => ctrl.clearValidation()).not.toThrow();
      // Error state should remain on the DOM element since dispose happened
      expect(input.classList.contains('validation-error')).toBe(true);
    });
  });

  // =========================================================================
  // clear()
  // =========================================================================

  describe('clear()', () => {
    it('sets input value to empty string', () => {
      const ctrl = new InputUIController({ inputElement: input });
      input.value = 'Hello world';
      ctrl.clear();

      expect(input.value).toBe('');
    });

    it('calls autoResize after clearing', () => {
      const ctrl = new InputUIController({ inputElement: input });
      const resizeSpy = jest.spyOn(ctrl, 'autoResize');

      input.value = 'Some text';
      ctrl.clear();

      expect(resizeSpy).toHaveBeenCalledTimes(1);
    });

    it('returns early when inputElement is null', () => {
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.dispose();

      expect(() => ctrl.clear()).not.toThrow();
    });
  });

  // =========================================================================
  // getValue()
  // =========================================================================

  describe('getValue()', () => {
    it('returns trimmed input value', () => {
      const ctrl = new InputUIController({ inputElement: input });
      input.value = '  Hello world  ';

      expect(ctrl.getValue()).toBe('Hello world');
    });

    it('returns empty string for empty input', () => {
      const ctrl = new InputUIController({ inputElement: input });
      input.value = '';

      expect(ctrl.getValue()).toBe('');
    });

    it('returns empty string for whitespace-only input', () => {
      const ctrl = new InputUIController({ inputElement: input });
      input.value = '   \t\n  ';

      expect(ctrl.getValue()).toBe('');
    });

    it('returns empty string when inputElement is null (after dispose)', () => {
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.dispose();

      expect(ctrl.getValue()).toBe('');
    });

    it('preserves inner whitespace while trimming edges', () => {
      const ctrl = new InputUIController({ inputElement: input });
      input.value = '  Hello   world  ';

      expect(ctrl.getValue()).toBe('Hello   world');
    });
  });

  // =========================================================================
  // focus()
  // =========================================================================

  describe('focus()', () => {
    it('calls focus on the input element', () => {
      const ctrl = new InputUIController({ inputElement: input });
      const focusSpy = jest.spyOn(input, 'focus');

      ctrl.focus();
      expect(focusSpy).toHaveBeenCalledTimes(1);
    });

    it('catches and handles focus() throwing', () => {
      const ctrl = new InputUIController({ inputElement: input });
      jest.spyOn(input, 'focus').mockImplementation(() => {
        throw new Error('Cannot focus detached node');
      });

      // Should not propagate the error
      expect(() => ctrl.focus()).not.toThrow();
    });

    it('returns early when inputElement is null', () => {
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.dispose();

      expect(() => ctrl.focus()).not.toThrow();
    });
  });

  // =========================================================================
  // dispose()
  // =========================================================================

  describe('dispose()', () => {
    it('sets inputElement to null', () => {
      const ctrl = new InputUIController({ inputElement: input });
      expect(ctrl.inputElement).toBe(input);

      ctrl.dispose();
      expect(ctrl.inputElement).toBeNull();
    });

    it('removes event listeners added by setupListeners', () => {
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.setupListeners();

      const removeSpy = jest.spyOn(input, 'removeEventListener');
      ctrl.dispose();

      expect(removeSpy).toHaveBeenCalledWith('input', expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith('focus', expect.any(Function));
      expect(removeSpy).toHaveBeenCalledTimes(2);
    });

    it('removed listener references match the ones that were added', () => {
      const addSpy = jest.spyOn(input, 'addEventListener');
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.setupListeners();

      // Capture the handlers that were added
      const inputHandler = addSpy.mock.calls.find(c => c[0] === 'input')[1];
      const focusHandler = addSpy.mock.calls.find(c => c[0] === 'focus')[1];

      const removeSpy = jest.spyOn(input, 'removeEventListener');
      ctrl.dispose();

      // Verify same handler references are removed
      const removedInputHandler = removeSpy.mock.calls.find(c => c[0] === 'input')[1];
      const removedFocusHandler = removeSpy.mock.calls.find(c => c[0] === 'focus')[1];

      expect(removedInputHandler).toBe(inputHandler);
      expect(removedFocusHandler).toBe(focusHandler);
    });

    it('handles dispose without setupListeners being called', () => {
      const ctrl = new InputUIController({ inputElement: input });

      // No setupListeners called — dispose should still work
      expect(() => ctrl.dispose()).not.toThrow();
      expect(ctrl.inputElement).toBeNull();
    });

    it('double dispose does not throw', () => {
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.setupListeners();

      ctrl.dispose();
      expect(() => ctrl.dispose()).not.toThrow();
    });

    it('after dispose, all methods guard safely', () => {
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.dispose();

      expect(() => ctrl.autoResize()).not.toThrow();
      expect(() => ctrl.markError('x')).not.toThrow();
      expect(() => ctrl.clearValidation()).not.toThrow();
      expect(() => ctrl.clear()).not.toThrow();
      expect(() => ctrl.focus()).not.toThrow();
      expect(ctrl.getValue()).toBe('');
    });
  });

  // =========================================================================
  // Full lifecycle
  // =========================================================================

  describe('full lifecycle', () => {
    it('create → setup → use → dispose cycle works cleanly', () => {
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.setupListeners();

      // Use: type, validate, clear
      input.value = 'Test';
      input.dispatchEvent(new Event('input'));

      ctrl.markError('Too short');
      expect(input.classList.contains('validation-error')).toBe(true);

      ctrl.clearValidation();
      expect(input.classList.contains('validation-error')).toBe(false);

      ctrl.clear();
      expect(input.value).toBe('');

      // Dispose
      ctrl.dispose();
      expect(ctrl.inputElement).toBeNull();
    });

    it('listeners do not fire after dispose', () => {
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.setupListeners();

      const resizeSpy = jest.spyOn(ctrl, 'autoResize');
      const clearSpy = jest.spyOn(ctrl, 'clearValidation');

      ctrl.dispose();

      // After dispose, listeners should be removed; dispatching events
      // should NOT trigger the controller's methods
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new Event('focus'));

      expect(resizeSpy).not.toHaveBeenCalled();
      expect(clearSpy).not.toHaveBeenCalled();
    });

    it('markError then clearValidation fully resets ARIA state', () => {
      const ctrl = new InputUIController({ inputElement: input });

      ctrl.markError('Error msg');
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(input.getAttribute('aria-errormessage')).toBe('aether-chat-status');
      expect(input.getAttribute('data-error')).toBe('Error msg');
      expect(input.classList.contains('validation-error')).toBe(true);

      ctrl.clearValidation();
      expect(input.hasAttribute('aria-invalid')).toBe(false);
      expect(input.hasAttribute('aria-errormessage')).toBe(false);
      expect(input.hasAttribute('data-error')).toBe(false);
      expect(input.classList.contains('validation-error')).toBe(false);
    });

    it('multiple markError calls overwrite data-error', () => {
      const ctrl = new InputUIController({ inputElement: input });

      ctrl.markError('First error');
      expect(input.getAttribute('data-error')).toBe('First error');

      ctrl.markError('Second error');
      expect(input.getAttribute('data-error')).toBe('Second error');
    });
  });

  // =========================================================================
  // Module exports
  // =========================================================================

  describe('module exports', () => {
    it('exports InputUIController class', () => {
      expect(typeof InputUIController).toBe('function');
      expect(InputUIController.name).toBe('InputUIController');
    });
  });

  // =========================================================================
  // BUG REGRESSIONS (IUC-1)
  // =========================================================================

  describe('bug regressions', () => {
    it('[IUC-1] constructor initializes _isDisposed and _listenersAttached', () => {
      const ctrl = new InputUIController({ inputElement: input });
      expect(ctrl._isDisposed).toBe(false);
      expect(ctrl._listenersAttached).toBe(false);
    });

    it('[IUC-1] setupListeners is idempotent (double-call does not leak)', () => {
      const ctrl = new InputUIController({ inputElement: input });
      const addSpy = jest.spyOn(input, 'addEventListener');

      ctrl.setupListeners();
      expect(addSpy).toHaveBeenCalledTimes(2); // input + focus

      addSpy.mockClear();
      ctrl.setupListeners(); // Second call — should be no-op
      expect(addSpy).not.toHaveBeenCalled();
      expect(ctrl._listenersAttached).toBe(true);
    });

    it('[IUC-1] setupListeners is no-op after dispose', () => {
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.setupListeners();
      ctrl.dispose();

      // Create a new element to check that no listeners get attached
      const newInput = document.createElement('textarea');
      ctrl.inputElement = newInput;
      ctrl._listenersAttached = false;
      const addSpy = jest.spyOn(newInput, 'addEventListener');

      ctrl.setupListeners(); // Should be blocked by _isDisposed
      expect(addSpy).not.toHaveBeenCalled();
    });

    it('[IUC-1] dispose is idempotent (double-dispose safe)', () => {
      const ctrl = new InputUIController({ inputElement: input });
      ctrl.setupListeners();
      ctrl.dispose();
      expect(() => ctrl.dispose()).not.toThrow();
      expect(ctrl._isDisposed).toBe(true);
      expect(ctrl._listenersAttached).toBe(false);
    });
  });
});
