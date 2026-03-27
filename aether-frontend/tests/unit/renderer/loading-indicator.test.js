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

const LoadingIndicator = require('../../../src/renderer/shared/components/LoadingIndicator');

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

describe('LoadingIndicator', () => {
  let container;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    document.body.innerHTML = '';
    document.head.innerHTML = '';
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
      const li = new LoadingIndicator();
      expect(li.container).toBe(document.body);
      expect(li.style).toBe('spinner');
      expect(li.size).toBe('medium');
      expect(li.message).toBe('');
      expect(li.overlay).toBe(false);
      expect(li.color).toBe('var(--color-accent)');
      expect(li.isVisible).toBe(false);
      expect(li.progress).toBeNull();
      expect(li.element).toBeNull();
      expect(li.progressBar).toBeNull();
      expect(li.messageElement).toBeNull();
    });

    it('accepts custom options', () => {
      const li = new LoadingIndicator({
        container,
        style: 'pulse',
        size: 'large',
        message: 'Loading...',
        overlay: true,
        color: 'red',
      });
      expect(li.container).toBe(container);
      expect(li.style).toBe('pulse');
      expect(li.size).toBe('large');
      expect(li.message).toBe('Loading...');
      expect(li.overlay).toBe(true);
      expect(li.color).toBe('red');
    });

    it('defaults overlay to false when not specified', () => {
      const li = new LoadingIndicator({});
      expect(li.overlay).toBe(false);
    });
  });

  // =========================================================================
  // init()
  // =========================================================================

  describe('init()', () => {
    it('injects styles to document head', () => {
      const li = new LoadingIndicator({ container });
      li.init();
      expect(document.getElementById('loading-indicator-styles')).not.toBeNull();
      li.dispose();
    });

    it('does not duplicate styles on repeated init', () => {
      const li = new LoadingIndicator({ container });
      li.init();
      li.init();
      expect(document.querySelectorAll('#loading-indicator-styles').length).toBe(1);
      li.dispose();
    });

    it('creates element in container', () => {
      const li = new LoadingIndicator({ container });
      li.init();
      expect(li.element).not.toBeNull();
      expect(container.querySelector('.loading-indicator')).not.toBeNull();
      li.dispose();
    });

    it('element starts hidden', () => {
      const li = new LoadingIndicator({ container });
      li.init();
      expect(li.element.style.display).toBe('none');
      li.dispose();
    });

    it('element has correct accessibility attributes', () => {
      const li = new LoadingIndicator({ container });
      li.init();
      expect(li.element.getAttribute('role')).toBe('status');
      expect(li.element.getAttribute('aria-live')).toBe('polite');
      expect(li.element.getAttribute('aria-label')).toBe('Loading');
      li.dispose();
    });

    it('element has correct size class', () => {
      const li = new LoadingIndicator({ container, size: 'small' });
      li.init();
      expect(li.element.classList.contains('size-small')).toBe(true);
      li.dispose();
    });

    it('adds overlay class when overlay option is true', () => {
      const li = new LoadingIndicator({ container, overlay: true });
      li.init();
      expect(li.element.classList.contains('loading-overlay')).toBe(true);
      li.dispose();
    });

    it('does not add overlay class when overlay is false', () => {
      const li = new LoadingIndicator({ container, overlay: false });
      li.init();
      expect(li.element.classList.contains('loading-overlay')).toBe(false);
      li.dispose();
    });

    it('creates message element when message is provided', () => {
      const li = new LoadingIndicator({ container, message: 'Please wait' });
      li.init();
      expect(li.messageElement).not.toBeNull();
      expect(li.messageElement.textContent).toBe('Please wait');
      expect(li.messageElement.className).toBe('loading-message');
      li.dispose();
    });

    it('does not create message element when message is empty', () => {
      const li = new LoadingIndicator({ container, message: '' });
      li.init();
      expect(li.messageElement).toBeNull();
      li.dispose();
    });

    it('creates progress bar container', () => {
      const li = new LoadingIndicator({ container });
      li.init();
      expect(li.progressBar).not.toBeNull();
      expect(li.progressBar.className).toBe('loading-progress');
      li.dispose();
    });

    it('progress bar is hidden when progress is null', () => {
      const li = new LoadingIndicator({ container });
      li.init();
      expect(li.progressBar.style.display).toBe('none');
      li.dispose();
    });
  });

  // =========================================================================
  // _createLoader() — style-specific elements
  // =========================================================================

  describe('_createLoader()', () => {
    it('creates spinner loader by default', () => {
      const li = new LoadingIndicator({ container, style: 'spinner' });
      li.init();
      expect(container.querySelector('.loading-spinner')).not.toBeNull();
      li.dispose();
    });

    it('creates pulse loader', () => {
      const li = new LoadingIndicator({ container, style: 'pulse' });
      li.init();
      expect(container.querySelector('.loading-pulse')).not.toBeNull();
      li.dispose();
    });

    it('creates dots loader', () => {
      const li = new LoadingIndicator({ container, style: 'dots' });
      li.init();
      const dots = container.querySelector('.loading-dots');
      expect(dots).not.toBeNull();
      expect(dots.children.length).toBe(3);
      li.dispose();
    });

    it('creates skeleton loader', () => {
      const li = new LoadingIndicator({ container, style: 'skeleton' });
      li.init();
      expect(container.querySelector('.loading-skeleton')).not.toBeNull();
      li.dispose();
    });

    it('defaults to spinner for unknown style', () => {
      const li = new LoadingIndicator({ container, style: 'nonexistent' });
      li.init();
      expect(container.querySelector('.loading-spinner')).not.toBeNull();
      li.dispose();
    });

    it('spinner has 4 child divs', () => {
      const li = new LoadingIndicator({ container, style: 'spinner' });
      li.init();
      const spinner = container.querySelector('.loading-spinner');
      expect(spinner.children.length).toBe(4);
      li.dispose();
    });
  });

  // =========================================================================
  // show()
  // =========================================================================

  describe('show()', () => {
    it('makes element visible', () => {
      const li = new LoadingIndicator({ container });
      li.init();
      li.show();
      expect(li.isVisible).toBe(true);
      expect(li.element.style.display).toBe('flex');
      expect(li.element.classList.contains('visible')).toBe(true);
      li.dispose();
    });

    it('auto-initializes if element does not exist', () => {
      const li = new LoadingIndicator({ container });
      // No init() call
      li.show();
      expect(li.element).not.toBeNull();
      expect(li.isVisible).toBe(true);
      li.dispose();
    });

    it('updates message when provided', () => {
      const li = new LoadingIndicator({ container, message: 'initial' });
      li.init();
      li.show('updated message');
      expect(li.messageElement.textContent).toBe('updated message');
      expect(li.message).toBe('updated message');
      li.dispose();
    });

    it('does not update message when null is passed', () => {
      const li = new LoadingIndicator({ container, message: 'keep me' });
      li.init();
      li.show(null);
      expect(li.messageElement.textContent).toBe('keep me');
      li.dispose();
    });

    it('updates progress when provided', () => {
      const li = new LoadingIndicator({ container });
      li.init();
      li.show(null, 50);
      expect(li.progress).toBe(50);
      li.dispose();
    });

    it('does not update progress when null is passed', () => {
      const li = new LoadingIndicator({ container });
      li.init();
      li.show(null, null);
      expect(li.progress).toBeNull();
      li.dispose();
    });
  });

  // =========================================================================
  // hide()
  // =========================================================================

  describe('hide()', () => {
    it('removes visible class immediately', () => {
      const li = new LoadingIndicator({ container });
      li.init();
      li.show();
      li.hide();
      expect(li.element.classList.contains('visible')).toBe(false);
      li.dispose();
    });

    it('sets display none after animation delay', () => {
      const li = new LoadingIndicator({ container });
      li.init();
      li.show();
      li.hide();
      // Still display flex during animation
      expect(li.element.style.display).toBe('flex');
      jest.advanceTimersByTime(300);
      expect(li.element.style.display).toBe('none');
      expect(li.isVisible).toBe(false);
      li.dispose();
    });

    it('is safe to call when element does not exist', () => {
      const li = new LoadingIndicator({ container });
      expect(() => li.hide()).not.toThrow();
    });

    it('handles element being removed during animation timeout', () => {
      const li = new LoadingIndicator({ container });
      li.init();
      li.show();
      li.hide();
      // Remove element before timer fires
      li.element.remove();
      li.element = null;
      jest.advanceTimersByTime(300);
      // Should not throw
    });
  });

  // =========================================================================
  // setProgress()
  // =========================================================================

  describe('setProgress()', () => {
    it('shows progress bar when value is set', () => {
      const li = new LoadingIndicator({ container });
      li.init();
      li.setProgress(50);
      expect(li.progress).toBe(50);
      expect(li.progressBar.style.display).toBe('block');
      li.dispose();
    });

    it('sets progress bar width correctly', () => {
      const li = new LoadingIndicator({ container });
      li.init();
      li.setProgress(75);
      const bar = li.progressBar.querySelector('.loading-progress-bar');
      expect(bar.style.width).toBe('75%');
      li.dispose();
    });

    it('clamps progress to 0-100 range', () => {
      const li = new LoadingIndicator({ container });
      li.init();
      li.setProgress(-10);
      const bar = li.progressBar.querySelector('.loading-progress-bar');
      expect(bar.style.width).toBe('0%');
      li.setProgress(200);
      expect(bar.style.width).toBe('100%');
      li.dispose();
    });

    it('hides progress bar when null', () => {
      const li = new LoadingIndicator({ container });
      li.init();
      li.setProgress(50);
      expect(li.progressBar.style.display).toBe('block');
      li.setProgress(null);
      expect(li.progressBar.style.display).toBe('none');
      li.dispose();
    });

    it('is safe when progressBar does not exist', () => {
      const li = new LoadingIndicator({ container });
      // No init, no progressBar
      expect(() => li.setProgress(50)).not.toThrow();
    });
  });

  // =========================================================================
  // setMessage()
  // =========================================================================

  describe('setMessage()', () => {
    it('updates message and messageElement', () => {
      const li = new LoadingIndicator({ container, message: 'old' });
      li.init();
      li.setMessage('new message');
      expect(li.message).toBe('new message');
      expect(li.messageElement.textContent).toBe('new message');
      li.dispose();
    });

    it('stores message even without messageElement', () => {
      const li = new LoadingIndicator({ container });
      // No message, so no messageElement
      li.init();
      li.setMessage('no element');
      expect(li.message).toBe('no element');
      li.dispose();
    });
  });

  // =========================================================================
  // toggle()
  // =========================================================================

  describe('toggle()', () => {
    it('shows when passed true', () => {
      const li = new LoadingIndicator({ container });
      li.init();
      li.toggle(true);
      expect(li.isVisible).toBe(true);
      li.dispose();
    });

    it('hides when passed false', () => {
      const li = new LoadingIndicator({ container });
      li.init();
      li.show();
      li.toggle(false);
      jest.advanceTimersByTime(300);
      expect(li.isVisible).toBe(false);
      li.dispose();
    });
  });

  // =========================================================================
  // isShowing()
  // =========================================================================

  describe('isShowing()', () => {
    it('returns false initially', () => {
      const li = new LoadingIndicator({ container });
      expect(li.isShowing()).toBe(false);
    });

    it('returns true after show()', () => {
      const li = new LoadingIndicator({ container });
      li.show();
      expect(li.isShowing()).toBe(true);
      li.dispose();
    });

    it('returns false after hide() animation completes', () => {
      const li = new LoadingIndicator({ container });
      li.show();
      li.hide();
      jest.advanceTimersByTime(300);
      expect(li.isShowing()).toBe(false);
      li.dispose();
    });
  });

  // =========================================================================
  // dispose()
  // =========================================================================

  describe('dispose()', () => {
    it('removes element from DOM', () => {
      const li = new LoadingIndicator({ container });
      li.init();
      expect(container.querySelector('.loading-indicator')).not.toBeNull();
      li.dispose();
      expect(container.querySelector('.loading-indicator')).toBeNull();
    });

    it('nulls out references', () => {
      const li = new LoadingIndicator({ container });
      li.init();
      li.dispose();
      expect(li.element).toBeNull();
      expect(li.progressBar).toBeNull();
      expect(li.messageElement).toBeNull();
      expect(li.container).toBeNull();
    });

    it('is safe to call when element does not exist', () => {
      const li = new LoadingIndicator({ container });
      expect(() => li.dispose()).not.toThrow();
    });

    it('is safe to call twice', () => {
      const li = new LoadingIndicator({ container });
      li.init();
      li.dispose();
      expect(() => li.dispose()).not.toThrow();
    });
  });

  // =========================================================================
  // exports
  // =========================================================================

  describe('exports', () => {
    it('exports LoadingIndicator class', () => {
      expect(typeof LoadingIndicator).toBe('function');
      expect(new LoadingIndicator()).toBeInstanceOf(LoadingIndicator);
    });

    it('sets window.LoadingIndicator', () => {
      expect(window.LoadingIndicator).toBe(LoadingIndicator);
    });
  });
});
