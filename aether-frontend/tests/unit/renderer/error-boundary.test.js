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

const ErrorBoundary = require('../../../src/renderer/shared/components/ErrorBoundary');

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

describe('ErrorBoundary', () => {
  let container;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    // Clean DOM
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    // Dedicated container to isolate DOM assertions
    container = document.createElement('div');
    container.id = 'test-container';
    document.body.appendChild(container);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('sets default values', () => {
      const eb = new ErrorBoundary();
      expect(eb.eventBus).toBeNull();
      expect(eb.container).toBe(document.body);
      expect(eb.onError).toBeNull();
      expect(eb.showUI).toBe(true);
      expect(eb.errorHistory).toEqual([]);
      expect(eb.isActive).toBe(true);
      expect(eb.hasRenderedUI).toBe(false);
      expect(eb.errorContainer).toBeNull();
      expect(eb.toastContainer).toBeNull();
      expect(eb._listeners).toEqual([]);
      expect(eb._timers).toEqual([]);
    });

    it('accepts custom options', () => {
      const eventBus = { emit: jest.fn() };
      const onError = jest.fn();
      const eb = new ErrorBoundary({
        eventBus,
        container,
        onError,
        showUI: false,
      });
      expect(eb.eventBus).toBe(eventBus);
      expect(eb.container).toBe(container);
      expect(eb.onError).toBe(onError);
      expect(eb.showUI).toBe(false);
    });

    it('defaults showUI to true when not provided', () => {
      const eb = new ErrorBoundary({});
      expect(eb.showUI).toBe(true);
    });
  });

  // =========================================================================
  // init
  // =========================================================================

  describe('init()', () => {
    it('attaches global error and unhandledrejection listeners', () => {
      const addSpy = jest.spyOn(window, 'addEventListener');
      const eb = new ErrorBoundary({ container, showUI: false });
      eb.init();
      expect(addSpy).toHaveBeenCalledWith('error', eb._handleWindowError);
      expect(addSpy).toHaveBeenCalledWith('unhandledrejection', eb._handleUnhandledRejection);
      expect(eb._listeners.length).toBe(2);
      eb.dispose();
      addSpy.mockRestore();
    });

    it('injects styles when showUI is true', () => {
      const eb = new ErrorBoundary({ container, showUI: true });
      eb.init();
      expect(document.getElementById('error-boundary-styles')).not.toBeNull();
      eb.dispose();
    });

    it('does not inject styles when showUI is false', () => {
      const eb = new ErrorBoundary({ container, showUI: false });
      eb.init();
      expect(document.getElementById('error-boundary-styles')).toBeNull();
      eb.dispose();
    });

    it('does not duplicate styles on repeated init', () => {
      const eb = new ErrorBoundary({ container, showUI: true });
      eb.init();
      eb.init();
      const styles = document.querySelectorAll('#error-boundary-styles');
      expect(styles.length).toBe(1);
      eb.dispose();
    });
  });

  // =========================================================================
  // _handleWindowError
  // =========================================================================

  describe('_handleWindowError()', () => {
    it('processes error event with correct fields', () => {
      const eb = new ErrorBoundary({ container, showUI: false });
      const spy = jest.fn();
      eb.onError = spy;
      eb.init();

      const errorEvent = new ErrorEvent('error', {
        message: 'test error',
        filename: 'test.js',
        lineno: 42,
        colno: 7,
        error: new Error('test error'),
      });
      window.dispatchEvent(errorEvent);

      expect(spy).toHaveBeenCalledTimes(1);
      const captured = spy.mock.calls[0][0];
      expect(captured.message).toBe('test error');
      expect(captured.filename).toBe('test.js');
      expect(captured.lineno).toBe(42);
      expect(captured.colno).toBe(7);
      expect(typeof captured.timestamp).toBe('number');
      eb.dispose();
    });

    it('does nothing when inactive', () => {
      const eb = new ErrorBoundary({ container, showUI: false });
      const spy = jest.fn();
      eb.onError = spy;
      eb.init();
      eb.deactivate();

      window.dispatchEvent(new ErrorEvent('error', { message: 'ignored' }));
      expect(spy).not.toHaveBeenCalled();
      eb.dispose();
    });

    it('uses fallback values for missing event properties', () => {
      const eb = new ErrorBoundary({ container, showUI: false });
      const spy = jest.fn();
      eb.onError = spy;
      eb.init();

      // Dispatch minimal ErrorEvent (no optional properties)
      window.dispatchEvent(new ErrorEvent('error'));

      expect(spy).toHaveBeenCalledTimes(1);
      const captured = spy.mock.calls[0][0];
      expect(captured.message).toBe('Unknown error');
      expect(captured.filename).toBe('unknown');
      expect(captured.lineno).toBe(0);
      expect(captured.colno).toBe(0);
      expect(captured.stack).toBe('');
      eb.dispose();
    });
  });

  // =========================================================================
  // _handleUnhandledRejection
  // =========================================================================

  describe('_handleUnhandledRejection()', () => {
    it('processes unhandled rejection', () => {
      const eb = new ErrorBoundary({ container, showUI: false });
      const spy = jest.fn();
      eb.onError = spy;
      eb.init();

      const reason = new Error('promise rejected');
      // PromiseRejectionEvent might not be available in jsdom, use custom event
      const event = new Event('unhandledrejection');
      event.reason = reason;
      window.dispatchEvent(event);

      expect(spy).toHaveBeenCalledTimes(1);
      const captured = spy.mock.calls[0][0];
      expect(captured.message).toBe('promise rejected');
      expect(captured.stack).toBe(reason.stack);
      eb.dispose();
    });

    it('handles string rejection reason', () => {
      const eb = new ErrorBoundary({ container, showUI: false });
      const spy = jest.fn();
      eb.onError = spy;
      eb.init();

      const event = new Event('unhandledrejection');
      event.reason = 'string error';
      window.dispatchEvent(event);

      expect(spy).toHaveBeenCalledTimes(1);
      const captured = spy.mock.calls[0][0];
      expect(captured.message).toBe('string error');
      eb.dispose();
    });

    it('handles null rejection reason', () => {
      const eb = new ErrorBoundary({ container, showUI: false });
      const spy = jest.fn();
      eb.onError = spy;
      eb.init();

      const event = new Event('unhandledrejection');
      event.reason = null;
      window.dispatchEvent(event);

      expect(spy).toHaveBeenCalledTimes(1);
      const captured = spy.mock.calls[0][0];
      // String(null) === 'null' — truthy, so fallback 'Unhandled rejection' is unreachable
      expect(captured.message).toBe('null');
      eb.dispose();
    });

    it('does nothing when inactive', () => {
      const eb = new ErrorBoundary({ container, showUI: false });
      const spy = jest.fn();
      eb.onError = spy;
      eb.init();
      eb.deactivate();

      const event = new Event('unhandledrejection');
      event.reason = new Error('ignored');
      window.dispatchEvent(event);
      expect(spy).not.toHaveBeenCalled();
      eb.dispose();
    });
  });

  // =========================================================================
  // captureError
  // =========================================================================

  describe('captureError()', () => {
    it('manually captures an Error object', () => {
      const eb = new ErrorBoundary({ container, showUI: false });
      const spy = jest.fn();
      eb.onError = spy;
      eb.captureError(new Error('manual error'), { type: 'render', severity: 'high' });
      expect(spy).toHaveBeenCalledTimes(1);
      const captured = spy.mock.calls[0][0];
      expect(captured.message).toBe('manual error');
      expect(captured.type).toBe('render');
      expect(captured.severity).toBe('high');
    });

    it('captures a plain string as error', () => {
      const eb = new ErrorBoundary({ container, showUI: false });
      const spy = jest.fn();
      eb.onError = spy;
      eb.captureError('plain string error');
      expect(spy).toHaveBeenCalledTimes(1);
      const captured = spy.mock.calls[0][0];
      expect(captured.message).toBe('plain string error');
    });

    it('uses default type and severity when context is empty', () => {
      const eb = new ErrorBoundary({ container, showUI: false });
      const spy = jest.fn();
      eb.onError = spy;
      eb.captureError(new Error('test'));
      const captured = spy.mock.calls[0][0];
      expect(captured.type).toBe('unknown');
      expect(captured.severity).toBe('medium');
    });

    it('does nothing when inactive', () => {
      const eb = new ErrorBoundary({ container, showUI: false });
      const spy = jest.fn();
      eb.onError = spy;
      eb.deactivate();
      eb.captureError(new Error('ignored'));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _processError
  // =========================================================================

  describe('_processError()', () => {
    it('adds error to history', () => {
      const eb = new ErrorBoundary({ container, showUI: false });
      eb.captureError(new Error('e1'));
      eb.captureError(new Error('e2'));
      expect(eb.errorHistory.length).toBe(2);
    });

    it('trims history to MAX_ERROR_HISTORY', () => {
      const eb = new ErrorBoundary({ container, showUI: false });
      for (let i = 0; i < 55; i++) {
        eb.captureError(new Error(`e${i}`));
      }
      expect(eb.errorHistory.length).toBe(50);
      // Oldest should be trimmed
      expect(eb.errorHistory[0].message).toBe('e5');
    });

    it('calls onError handler and catches handler errors', () => {
      const eb = new ErrorBoundary({ container, showUI: false });
      eb.onError = jest.fn(() => { throw new Error('handler crash'); });
      // Should not throw
      expect(() => eb.captureError(new Error('test'))).not.toThrow();
      expect(eb.onError).toHaveBeenCalledTimes(1);
    });

    it('emits error:captured via eventBus', () => {
      const eventBus = { emit: jest.fn() };
      const eb = new ErrorBoundary({ container, showUI: false, eventBus });
      eb.captureError(new Error('bus test'));
      expect(eventBus.emit).toHaveBeenCalledWith('error:captured', expect.objectContaining({ message: 'bus test' }));
    });

    it('catches eventBus emission errors', () => {
      const eventBus = { emit: jest.fn(() => { throw new Error('emit fail'); }) };
      const eb = new ErrorBoundary({ container, showUI: false, eventBus });
      expect(() => eb.captureError(new Error('test'))).not.toThrow();
      expect(eventBus.emit).toHaveBeenCalledTimes(1);
    });

    it('does not call eventBus or onError when not provided', () => {
      const eb = new ErrorBoundary({ container, showUI: false });
      // No eventBus, no onError — should not throw
      expect(() => eb.captureError(new Error('test'))).not.toThrow();
    });
  });

  // =========================================================================
  // _renderOverlay (critical errors)
  // =========================================================================

  describe('_renderOverlay()', () => {
    it('renders overlay for critical severity error', () => {
      const eb = new ErrorBoundary({ container, showUI: true });
      eb.init();
      eb.captureError(new Error('critical!'), { severity: 'critical' });
      expect(container.querySelector('.error-overlay')).not.toBeNull();
      expect(eb.hasRenderedUI).toBe(true);
      eb.dispose();
    });

    it('shows error message in overlay', () => {
      const eb = new ErrorBoundary({ container, showUI: true });
      eb.init();
      eb.captureError(new Error('critical msg'), { severity: 'critical' });
      const overlay = container.querySelector('.error-overlay');
      expect(overlay.textContent).toContain('critical msg');
      eb.dispose();
    });

    it('removes existing overlay before rendering new one', () => {
      const eb = new ErrorBoundary({ container, showUI: true });
      eb.init();
      eb.captureError(new Error('first'), { severity: 'critical' });
      eb.captureError(new Error('second'), { severity: 'critical' });
      const overlays = container.querySelectorAll('.error-overlay');
      expect(overlays.length).toBe(1);
      expect(overlays[0].textContent).toContain('second');
      eb.dispose();
    });

    it('does not show stack trace when __DEV__ is falsy', () => {
      window.__DEV__ = false;
      const eb = new ErrorBoundary({ container, showUI: true });
      eb.init();
      eb.captureError(new Error('no stack'), { severity: 'critical' });
      const overlay = container.querySelector('.error-overlay');
      expect(overlay.querySelector('.error-stack')).toBeNull();
      eb.dispose();
      delete window.__DEV__;
    });

    it('shows stack trace when __DEV__ is true', () => {
      window.__DEV__ = true;
      const eb = new ErrorBoundary({ container, showUI: true });
      eb.init();
      const err = new Error('dev error');
      err.stack = 'Error: dev error\n    at test.js:1:1';
      eb.captureError(err, { severity: 'critical' });
      const overlay = container.querySelector('.error-overlay');
      expect(overlay.querySelector('.error-stack')).not.toBeNull();
      eb.dispose();
      delete window.__DEV__;
    });

    it('reload button triggers window.location.reload', () => {
      const eb = new ErrorBoundary({ container, showUI: true });
      eb.init();
      eb.captureError(new Error('reload test'), { severity: 'critical' });
      const reloadBtn = container.querySelector('#error-reload-btn');
      expect(reloadBtn).not.toBeNull();
      // jsdom does not support location.reload, but we can spy on it
      const reloadSpy = jest.fn();
      Object.defineProperty(window, 'location', {
        value: { reload: reloadSpy },
        writable: true,
        configurable: true,
      });
      reloadBtn.click();
      expect(reloadSpy).toHaveBeenCalled();
      eb.dispose();
    });

    it('dismiss button clears UI', () => {
      const eb = new ErrorBoundary({ container, showUI: true });
      eb.init();
      eb.captureError(new Error('dismiss test'), { severity: 'critical' });
      const dismissBtn = container.querySelector('#error-dismiss-btn');
      expect(dismissBtn).not.toBeNull();
      dismissBtn.click();
      expect(eb.hasRenderedUI).toBe(false);
      expect(eb.errorContainer).toBeNull();
      eb.dispose();
    });
  });

  // =========================================================================
  // _renderToast (non-critical errors)
  // =========================================================================

  describe('_renderToast()', () => {
    it('renders toast for non-critical error', () => {
      const eb = new ErrorBoundary({ container, showUI: true });
      eb.init();
      eb.captureError(new Error('warning'), { severity: 'medium' });
      expect(container.querySelector('.error-toast')).not.toBeNull();
      eb.dispose();
    });

    it('creates toast container on first toast', () => {
      const eb = new ErrorBoundary({ container, showUI: true });
      eb.init();
      expect(eb.toastContainer).toBeNull();
      eb.captureError(new Error('first toast'));
      expect(eb.toastContainer).not.toBeNull();
      expect(eb.toastContainer.className).toBe('error-boundary-container');
      eb.dispose();
    });

    it('reuses toast container for subsequent toasts', () => {
      const eb = new ErrorBoundary({ container, showUI: true });
      eb.init();
      eb.captureError(new Error('toast 1'));
      eb.captureError(new Error('toast 2'));
      const containers = container.querySelectorAll('.error-boundary-container');
      expect(containers.length).toBe(1);
      const toasts = container.querySelectorAll('.error-toast');
      expect(toasts.length).toBe(2);
      eb.dispose();
    });

    it('auto-removes toast after ERROR_DISPLAY_DURATION', () => {
      const eb = new ErrorBoundary({ container, showUI: true });
      eb.init();
      eb.captureError(new Error('auto-remove'));
      expect(container.querySelectorAll('.error-toast').length).toBe(1);
      jest.advanceTimersByTime(5000);
      expect(container.querySelectorAll('.error-toast').length).toBe(0);
      eb.dispose();
    });

    it('clicking toast removes it and clears timer', () => {
      const eb = new ErrorBoundary({ container, showUI: true });
      eb.init();
      eb.captureError(new Error('click me'));
      const toast = container.querySelector('.error-toast');
      expect(toast).not.toBeNull();
      toast.click();
      expect(container.querySelectorAll('.error-toast').length).toBe(0);
      eb.dispose();
    });

    it('does not render toast when showUI is false', () => {
      const eb = new ErrorBoundary({ container, showUI: false });
      eb.init();
      eb.captureError(new Error('hidden'));
      expect(container.querySelector('.error-toast')).toBeNull();
      eb.dispose();
    });
  });

  // =========================================================================
  // clearUI
  // =========================================================================

  describe('clearUI()', () => {
    it('removes error overlay', () => {
      const eb = new ErrorBoundary({ container, showUI: true });
      eb.init();
      eb.captureError(new Error('clear me'), { severity: 'critical' });
      expect(container.querySelector('.error-overlay')).not.toBeNull();
      eb.clearUI();
      expect(container.querySelector('.error-overlay')).toBeNull();
      expect(eb.errorContainer).toBeNull();
      expect(eb.hasRenderedUI).toBe(false);
      eb.dispose();
    });

    it('clears toast container innerHTML', () => {
      const eb = new ErrorBoundary({ container, showUI: true });
      eb.init();
      eb.captureError(new Error('toast clear'));
      expect(container.querySelectorAll('.error-toast').length).toBe(1);
      eb.clearUI();
      expect(container.querySelectorAll('.error-toast').length).toBe(0);
      eb.dispose();
    });

    it('is safe to call when no UI has been rendered', () => {
      const eb = new ErrorBoundary({ container, showUI: false });
      expect(() => eb.clearUI()).not.toThrow();
    });
  });

  // =========================================================================
  // getErrorHistory / clearHistory
  // =========================================================================

  describe('getErrorHistory()', () => {
    it('returns a copy of error history', () => {
      const eb = new ErrorBoundary({ container, showUI: false });
      eb.captureError(new Error('h1'));
      eb.captureError(new Error('h2'));
      const history = eb.getErrorHistory();
      expect(history.length).toBe(2);
      // Verify it's a copy
      history.push({});
      expect(eb.errorHistory.length).toBe(2);
    });
  });

  describe('clearHistory()', () => {
    it('empties error history', () => {
      const eb = new ErrorBoundary({ container, showUI: false });
      eb.captureError(new Error('h1'));
      expect(eb.errorHistory.length).toBe(1);
      eb.clearHistory();
      expect(eb.errorHistory.length).toBe(0);
    });
  });

  // =========================================================================
  // deactivate / activate
  // =========================================================================

  describe('deactivate() / activate()', () => {
    it('deactivate sets isActive to false', () => {
      const eb = new ErrorBoundary({ container, showUI: false });
      eb.deactivate();
      expect(eb.isActive).toBe(false);
    });

    it('activate sets isActive to true', () => {
      const eb = new ErrorBoundary({ container, showUI: false });
      eb.deactivate();
      eb.activate();
      expect(eb.isActive).toBe(true);
    });

    it('errors are ignored while deactivated', () => {
      const eb = new ErrorBoundary({ container, showUI: false });
      const spy = jest.fn();
      eb.onError = spy;
      eb.deactivate();
      eb.captureError(new Error('off'));
      expect(spy).not.toHaveBeenCalled();
      eb.activate();
      eb.captureError(new Error('on'));
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // _escapeHTML
  // =========================================================================

  describe('_escapeHTML()', () => {
    it('escapes HTML special characters', () => {
      const eb = new ErrorBoundary({ container, showUI: false });
      const escaped = eb._escapeHTML('<script>alert("xss")</script>');
      expect(escaped).not.toContain('<script>');
      expect(escaped).toContain('&lt;script&gt;');
    });

    it('returns empty string for empty input', () => {
      const eb = new ErrorBoundary({ container, showUI: false });
      expect(eb._escapeHTML('')).toBe('');
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose()', () => {
    it('clears all timers', () => {
      const eb = new ErrorBoundary({ container, showUI: true });
      eb.init();
      eb.captureError(new Error('timer test'));
      expect(eb._timers.length).toBeGreaterThan(0);
      eb.dispose();
      expect(eb._timers.length).toBe(0);
    });

    it('removes all event listeners', () => {
      const eb = new ErrorBoundary({ container, showUI: false });
      eb.init();
      expect(eb._listeners.length).toBe(2);
      eb.dispose();
      expect(eb._listeners.length).toBe(0);
    });

    it('clears UI and references', () => {
      const eb = new ErrorBoundary({ container, showUI: true });
      eb.init();
      eb.captureError(new Error('dispose'), { severity: 'critical' });
      eb.dispose();
      expect(eb.eventBus).toBeNull();
      expect(eb.container).toBeNull();
      expect(eb.onError).toBeNull();
      expect(eb.errorHistory).toEqual([]);
      expect(eb.hasRenderedUI).toBe(false);
    });

    it('global error events are no longer captured after dispose', () => {
      const spy = jest.fn();
      const eb = new ErrorBoundary({ container, showUI: false });
      eb.onError = spy;
      eb.init();
      eb.dispose();

      // Dispatch error after dispose
      window.dispatchEvent(new ErrorEvent('error', { message: 'post-dispose' }));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // exports
  // =========================================================================

  describe('exports', () => {
    it('exports ErrorBoundary class', () => {
      expect(typeof ErrorBoundary).toBe('function');
      expect(new ErrorBoundary()).toBeInstanceOf(ErrorBoundary);
    });

    it('sets window.ErrorBoundary', () => {
      expect(window.ErrorBoundary).toBe(ErrorBoundary);
    });
  });
});
