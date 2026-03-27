'use strict';

// ---------------------------------------------------------------------------
// PointerEvent polyfill (jsdom lacks PointerEvent)
// ---------------------------------------------------------------------------
if (typeof globalThis.PointerEvent === 'undefined') {
  class PointerEvent extends MouseEvent {
    constructor(type, params = {}) {
      super(type, params);
      this.pointerId = params.pointerId != null ? params.pointerId : 1;
      this.pointerType = params.pointerType || 'mouse';
      this.width = params.width || 1;
      this.height = params.height || 1;
      this.pressure = params.pressure || 0;
      this.tiltX = params.tiltX || 0;
      this.tiltY = params.tiltY || 0;
    }
  }
  globalThis.PointerEvent = PointerEvent;
}

// ---------------------------------------------------------------------------
// Element.setPointerCapture / releasePointerCapture polyfill
// ---------------------------------------------------------------------------
if (typeof Element.prototype.setPointerCapture !== 'function') {
  Element.prototype.setPointerCapture = function () {};
  Element.prototype.releasePointerCapture = function () {};
}

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

const DragResizeManager = require(
  '../../../../src/renderer/chat/modules/window/DragResizeManager'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createWindowElement() {
  const el = document.createElement('div');
  el.className = 'aether-chat-window';
  el.style.position = 'fixed';
  el.style.left = '100px';
  el.style.top = '100px';
  el.style.width = '500px';
  el.style.height = '600px';
  // Mock getBoundingClientRect
  el.getBoundingClientRect = jest.fn(() => ({
    left: 100, top: 100, right: 600, bottom: 700,
    width: 500, height: 600, x: 100, y: 100,
  }));
  // Mock offsetWidth/Height for viewport constraint calculations
  Object.defineProperty(el, 'offsetWidth', { value: 500, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: 600, configurable: true });
  document.body.appendChild(el);
  return el;
}

function createHeaderElement() {
  const el = document.createElement('div');
  el.className = 'aether-chat-header';
  return el;
}

function createChatWindow(windowEl, headerEl, isDetached = false) {
  return {
    getElements: () => ({ window: windowEl, header: headerEl }),
    isDetached,
  };
}

function createManager(overrides = {}) {
  const windowEl = createWindowElement();
  const headerEl = createHeaderElement();
  windowEl.appendChild(headerEl);
  const chatWindow = createChatWindow(windowEl, headerEl, overrides.isDetached || false);
  const mgr = new DragResizeManager({
    chatWindow,
    eventBus: overrides.eventBus || null,
    ...overrides,
  });
  return { mgr, windowEl, headerEl, chatWindow };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DragResizeManager', () => {
  let mgr, windowEl, headerEl;

  beforeEach(() => {
    jest.useFakeTimers();
    // Ensure clean state
    mockLog.info.mockClear();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    mockLog.debug.mockClear();
    mockLog.trace.mockClear();
    // Set viewport size for constraint tests
    Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 768, writable: true, configurable: true });
  });

  afterEach(() => {
    if (mgr) {
      try { mgr.dispose(); } catch (e) { /* noop */ }
      mgr = null;
    }
    if (windowEl && windowEl.parentNode) {
      windowEl.parentNode.removeChild(windowEl);
      windowEl = null;
    }
    headerEl = null;
    jest.useRealTimers();
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('initializes with default state', () => {
      mgr = new DragResizeManager();
      expect(mgr.chatWindow).toBeNull();
      expect(mgr.eventBus).toBeNull();
      expect(mgr.isDetached).toBe(false);
      expect(mgr.isDragging).toBe(false);
      expect(mgr.isResizing).toBe(false);
      expect(mgr.isMaximized).toBe(false);
      expect(mgr.element).toBeNull();
      expect(mgr.header).toBeNull();
      expect(mgr._listeners).toEqual([]);
    });

    it('accepts chatWindow and eventBus', () => {
      const chatWindow = { getElements: jest.fn() };
      const eventBus = { emit: jest.fn() };
      mgr = new DragResizeManager({ chatWindow, eventBus });
      expect(mgr.chatWindow).toBe(chatWindow);
      expect(mgr.eventBus).toBe(eventBus);
    });

    it('binds all handler methods', () => {
      mgr = new DragResizeManager();
      // Verify binding by checking the function doesn't throw without `this`
      const { handleDrag, endDrag, handleResize, endResize, onWindowResize, onViewportResize } = mgr;
      expect(typeof handleDrag).toBe('function');
      expect(typeof endDrag).toBe('function');
      expect(typeof handleResize).toBe('function');
      expect(typeof endResize).toBe('function');
      expect(typeof onWindowResize).toBe('function');
      expect(typeof onViewportResize).toBe('function');
    });

    it('initializes saved position and size', () => {
      mgr = new DragResizeManager();
      expect(mgr.savedPosition).toEqual({ left: 30, top: 30 });
      expect(mgr.savedSize).toEqual({ width: 500, height: 600 });
    });
  });

  // =========================================================================
  // init
  // =========================================================================

  describe('init', () => {
    it('throws when chatWindow is missing', async () => {
      mgr = new DragResizeManager();
      await expect(mgr.init()).rejects.toThrow('ChatWindow reference required');
    });

    it('throws when DOM elements are missing', async () => {
      const chatWindow = { getElements: () => ({ window: null, header: null }) };
      mgr = new DragResizeManager({ chatWindow });
      await expect(mgr.init()).rejects.toThrow('Required DOM elements not found');
    });

    it('initializes in attached mode by default', async () => {
      const ctx = createManager();
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;
      await mgr.init();
      expect(mgr.isDetached).toBe(false);
      expect(mgr.element).toBe(windowEl);
      expect(mgr.header).toBe(headerEl);
      // Resize handles should be created
      const handles = windowEl.querySelectorAll('.resize-handle');
      expect(handles.length).toBe(8);
    });

    it('initializes in detached mode when specified', async () => {
      const ctx = createManager({ isDetached: true });
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;
      await mgr.init({ isDetached: true });
      expect(mgr.isDetached).toBe(true);
      expect(windowEl.style.position).toBe('fixed');
      expect(parseInt(windowEl.style.left)).toBe(0);
      expect(windowEl.style.width).toBe('100vw');
    });

    it('reads isDetached from chatWindow if not in options', async () => {
      const wEl = createWindowElement();
      const hEl = createHeaderElement();
      wEl.appendChild(hEl);
      const chatWindow = createChatWindow(wEl, hEl, true);
      mgr = new DragResizeManager({ chatWindow });
      await mgr.init();
      windowEl = wEl;
      expect(mgr.isDetached).toBe(true);
    });

    it('sets initial position in attached mode', async () => {
      const ctx = createManager();
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;
      await mgr.init();
      expect(windowEl.style.position).toBe('fixed');
      expect(windowEl.style.left).toBe('30px');
      expect(windowEl.style.top).toBe('30px');
    });

    it('adds viewport resize listener in attached mode', async () => {
      const ctx = createManager();
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;
      const addSpy = jest.spyOn(window, 'addEventListener');
      await mgr.init();
      expect(addSpy).toHaveBeenCalledWith('resize', mgr.onViewportResize, { passive: true });
      addSpy.mockRestore();
    });
  });

  // =========================================================================
  // createResizeHandles
  // =========================================================================

  describe('createResizeHandles', () => {
    it('creates 8 directional handles', async () => {
      const ctx = createManager();
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;
      await mgr.init();
      const handles = windowEl.querySelectorAll('.resize-handle');
      expect(handles.length).toBe(8);
      const dirs = Array.from(handles).map(h => h.dataset.direction);
      expect(dirs).toEqual(['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se']);
    });

    it('skips creation when handles already exist', async () => {
      const ctx = createManager();
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;
      await mgr.init(); // creates handles
      const handleCountBefore = windowEl.querySelectorAll('.resize-handle').length;
      mgr.createResizeHandles(); // should skip
      const handleCountAfter = windowEl.querySelectorAll('.resize-handle').length;
      expect(handleCountAfter).toBe(handleCountBefore);
    });
  });

  // =========================================================================
  // setupDrag
  // =========================================================================

  describe('setupDrag', () => {
    it('sets header cursor to move', async () => {
      const ctx = createManager();
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;
      await mgr.init();
      expect(headerEl.style.cursor).toBe('move');
    });

    it('does nothing when header is null', () => {
      mgr = new DragResizeManager();
      mgr.header = null;
      mgr.setupDrag(); // should not throw
    });
  });

  // =========================================================================
  // startDrag / handleDrag / endDrag
  // =========================================================================

  describe('drag operations', () => {
    beforeEach(async () => {
      const ctx = createManager();
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;
      await mgr.init();
    });

    it('starts drag on header pointerdown', () => {
      const evt = new PointerEvent('pointerdown', { clientX: 200, clientY: 200, bubbles: true, button: 0 });
      headerEl.dispatchEvent(evt);
      expect(mgr.isDragging).toBe(true);
      expect(windowEl.classList.contains('dragging')).toBe(true);
      expect(headerEl.style.cursor).toBe('grabbing');
    });

    it('skips drag when detached', () => {
      mgr.isDetached = true;
      const evt = new PointerEvent('pointerdown', { clientX: 200, clientY: 200, bubbles: true });
      headerEl.dispatchEvent(evt);
      expect(mgr.isDragging).toBe(false);
    });

    it('skips drag when maximized', () => {
      mgr.isMaximized = true;
      const evt = new PointerEvent('pointerdown', { clientX: 200, clientY: 200, bubbles: true });
      headerEl.dispatchEvent(evt);
      expect(mgr.isDragging).toBe(false);
    });

    it('skips drag when clicking controls', () => {
      const controls = document.createElement('div');
      controls.className = 'aether-chat-controls';
      headerEl.appendChild(controls);
      const btn = document.createElement('button');
      controls.appendChild(btn);
      const evt = new PointerEvent('pointerdown', { bubbles: true });
      Object.defineProperty(evt, 'target', { value: btn });
      mgr.startDrag(evt);
      expect(mgr.isDragging).toBe(false);
    });

    it('skips drag when clicking resize handle', () => {
      const handle = document.createElement('div');
      handle.className = 'resize-handle';
      headerEl.appendChild(handle);
      const evt = new PointerEvent('pointerdown', { bubbles: true });
      Object.defineProperty(evt, 'target', { value: handle });
      mgr.startDrag(evt);
      expect(mgr.isDragging).toBe(false);
    });

    it('handleDrag updates position via RAF', () => {
      // Start drag via header dispatch (sets e.target properly)
      headerEl.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: 200, clientY: 200, bubbles: true,
      }));
      expect(mgr.isDragging).toBe(true);

      // Trigger move
      document.dispatchEvent(new PointerEvent('pointermove', {
        clientX: 250, clientY: 230, bubbles: true,
      }));

      // Flush RAF
      jest.advanceTimersByTime(16);

      // Position should have updated
      expect(windowEl.style.left).not.toBe('30px');
    });

    it('handleDrag returns early when not dragging', () => {
      mgr.isDragging = false;
      mgr.handleDrag(new PointerEvent('pointermove', { clientX: 100, clientY: 100 }));
      expect(mgr._pendingDragEvent).toBeNull();
    });

    it('handleDrag batches multiple events into one RAF', () => {
      headerEl.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: 200, clientY: 200, bubbles: true,
      }));
      // Fire multiple moves
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 210, clientY: 210 }));
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 220, clientY: 220 }));
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 230, clientY: 230 }));
      // Only 1 RAF should be scheduled
      expect(mgr._dragRaf).not.toBeNull();
      jest.advanceTimersByTime(16);
    });

    it('handleDrag constrains to viewport bounds', () => {
      headerEl.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: 200, clientY: 200, bubbles: true,
      }));
      // Try to drag way off screen to the right
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 5000, clientY: 200 }));
      jest.advanceTimersByTime(16);
      // Left should be constrained to maxLeft = window.innerWidth - 50 = 974
      const left = parseInt(windowEl.style.left);
      expect(left).toBeLessThanOrEqual(window.innerWidth - 50);
    });

    it('endDrag cleans up state', () => {
      headerEl.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: 200, clientY: 200, bubbles: true,
      }));
      expect(mgr.isDragging).toBe(true);

      mgr.endDrag();
      expect(mgr.isDragging).toBe(false);
      expect(windowEl.classList.contains('dragging')).toBe(false);
      expect(headerEl.style.cursor).toBe('move');
      expect(document.body.style.userSelect).toBe('');
    });

    it('endDrag returns early when not dragging', () => {
      mgr.isDragging = false;
      mgr.endDrag(); // Should not throw
    });

    it('disables text selection during drag', () => {
      headerEl.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: 200, clientY: 200, bubbles: true,
      }));
      expect(document.body.style.userSelect).toBe('none');
      mgr.endDrag();
      expect(document.body.style.userSelect).toBe('');
    });
  });

  // =========================================================================
  // startResize / handleResize / endResize
  // =========================================================================

  describe('resize operations', () => {
    beforeEach(async () => {
      const ctx = createManager();
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;
      await mgr.init();
    });

    it('starts resize on handle mousedown', () => {
      const handle = windowEl.querySelector('.resize-se');
      handle.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: 600, clientY: 700, bubbles: true,
      }));
      expect(mgr.isResizing).toBe(true);
      expect(windowEl.classList.contains('resizing')).toBe(true);
      expect(mgr.resizeState.direction).toBe('se');
    });

    it('skips resize when detached', () => {
      mgr.isDetached = true;
      mgr.startResize(new PointerEvent('pointerdown', { clientX: 600, clientY: 700 }), 'se');
      expect(mgr.isResizing).toBe(false);
    });

    it('skips resize when maximized', () => {
      mgr.isMaximized = true;
      mgr.startResize(new PointerEvent('pointerdown', { clientX: 600, clientY: 700 }), 'se');
      expect(mgr.isResizing).toBe(false);
    });

    it('handleResize updates size via RAF for SE direction', () => {
      mgr.startResize(new PointerEvent('pointerdown', {
        clientX: 600, clientY: 700, bubbles: true,
      }), 'se');
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 650, clientY: 750 }));
      jest.advanceTimersByTime(16);
      // Width should increase by 50, height by 50
      expect(parseInt(windowEl.style.width)).toBe(550);
      expect(parseInt(windowEl.style.height)).toBe(650);
    });

    it('handleResize grows north correctly', () => {
      mgr.startResize(new PointerEvent('pointerdown', {
        clientX: 300, clientY: 100, bubbles: true,
      }), 'n');
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 50 }));
      jest.advanceTimersByTime(16);
      expect(parseInt(windowEl.style.top)).toBe(50);
      expect(parseInt(windowEl.style.height)).toBe(650);
    });

    it('handleResize grows west correctly', () => {
      mgr.startResize(new PointerEvent('pointerdown', {
        clientX: 100, clientY: 400, bubbles: true,
      }), 'w');
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 50, clientY: 400 }));
      jest.advanceTimersByTime(16);
      expect(parseInt(windowEl.style.left)).toBe(50);
      expect(parseInt(windowEl.style.width)).toBe(550);
    });

    it('handleResize grows east correctly', () => {
      mgr.startResize(new PointerEvent('pointerdown', {
        clientX: 600, clientY: 400, bubbles: true,
      }), 'e');
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 700, clientY: 400 }));
      jest.advanceTimersByTime(16);
      expect(parseInt(windowEl.style.width)).toBe(600);
    });

    it('handleResize enforces minimum width 350', () => {
      mgr.startResize(new PointerEvent('pointerdown', {
        clientX: 600, clientY: 400, bubbles: true,
      }), 'e');
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 400 }));
      jest.advanceTimersByTime(16);
      expect(parseInt(windowEl.style.width)).toBe(350);
    });

    it('handleResize enforces minimum height 300', () => {
      mgr.startResize(new PointerEvent('pointerdown', {
        clientX: 300, clientY: 700, bubbles: true,
      }), 's');
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 200 }));
      jest.advanceTimersByTime(16);
      expect(parseInt(windowEl.style.height)).toBe(300);
    });

    it('handleResize adjusts left when west hits min width', () => {
      mgr.startResize(new PointerEvent('pointerdown', {
        clientX: 100, clientY: 400, bubbles: true,
      }), 'w');
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 400, clientY: 400 }));
      jest.advanceTimersByTime(16);
      expect(parseInt(windowEl.style.width)).toBe(350);
      expect(parseInt(windowEl.style.left)).toBe(100 + 500 - 350);
    });

    it('handleResize adjusts top when north hits min height', () => {
      mgr.startResize(new PointerEvent('pointerdown', {
        clientX: 300, clientY: 100, bubbles: true,
      }), 'n');
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 600 }));
      jest.advanceTimersByTime(16);
      expect(parseInt(windowEl.style.height)).toBe(300);
      expect(parseInt(windowEl.style.top)).toBe(100 + 600 - 300);
    });

    it('handleResize handles NW (diagonal) correctly', () => {
      mgr.startResize(new PointerEvent('pointerdown', {
        clientX: 100, clientY: 100, bubbles: true,
      }), 'nw');
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 50, clientY: 50 }));
      jest.advanceTimersByTime(16);
      expect(parseInt(windowEl.style.left)).toBe(50);
      expect(parseInt(windowEl.style.top)).toBe(50);
      expect(parseInt(windowEl.style.width)).toBe(550);
      expect(parseInt(windowEl.style.height)).toBe(650);
    });

    it('handleResize returns early when not resizing', () => {
      mgr.isResizing = false;
      mgr.handleResize(new PointerEvent('pointermove', { clientX: 100, clientY: 100 }));
      expect(mgr._pendingResizeEvent).toBeNull();
    });

    it('handleResize batches events into one RAF', () => {
      mgr.startResize(new PointerEvent('pointerdown', {
        clientX: 600, clientY: 700, bubbles: true,
      }), 'se');
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 610, clientY: 710 }));
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 620, clientY: 720 }));
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 630, clientY: 730 }));
      expect(mgr._resizeRaf).not.toBeNull();
      jest.advanceTimersByTime(16);
      expect(parseInt(windowEl.style.width)).toBe(530);
    });

    it('endResize cleans up state', () => {
      mgr.startResize(new PointerEvent('pointerdown', {
        clientX: 600, clientY: 700, bubbles: true,
      }), 'se');
      expect(mgr.isResizing).toBe(true);
      mgr.endResize();
      expect(mgr.isResizing).toBe(false);
      expect(windowEl.classList.contains('resizing')).toBe(false);
      expect(document.body.style.userSelect).toBe('');
    });

    it('endResize returns early when not resizing', () => {
      mgr.isResizing = false;
      mgr.endResize(); // Should not throw
    });

    it('saves position and size after resize', () => {
      mgr.startResize(new PointerEvent('pointerdown', {
        clientX: 600, clientY: 700, bubbles: true,
      }), 'se');
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 650, clientY: 750 }));
      jest.advanceTimersByTime(16);
      expect(mgr.savedSize.width).toBe(550);
      expect(mgr.savedSize.height).toBe(650);
    });
  });

  // =========================================================================
  // toggleMaximize
  // =========================================================================

  describe('toggleMaximize', () => {
    beforeEach(async () => {
      const ctx = createManager();
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;
      await mgr.init();
    });

    it('maximizes the window', () => {
      const result = mgr.toggleMaximize();
      expect(result).toBe(true);
      expect(mgr.isMaximized).toBe(true);
      expect(windowEl.classList.contains('maximized')).toBe(true);
      expect(windowEl.style.left).toBe('20px');
      expect(windowEl.style.top).toBe('20px');
      expect(parseInt(windowEl.style.width)).toBe(window.innerWidth - 40);
      expect(parseInt(windowEl.style.height)).toBe(window.innerHeight - 40);
    });

    it('saves normal bounds before maximize', () => {
      mgr.toggleMaximize();
      expect(mgr.normalBounds).toEqual({
        left: 100, top: 100, width: 500, height: 600,
      });
    });

    it('restores to normal bounds', () => {
      mgr.toggleMaximize(); // maximize
      mgr.toggleMaximize(); // restore
      expect(mgr.isMaximized).toBe(false);
      expect(windowEl.classList.contains('maximized')).toBe(false);
      expect(windowEl.style.left).toBe('100px');
      expect(windowEl.style.top).toBe('100px');
      expect(windowEl.style.width).toBe('500px');
      expect(windowEl.style.height).toBe('600px');
    });

    it('returns false when detached', () => {
      mgr.isDetached = true;
      const result = mgr.toggleMaximize();
      expect(result).toBe(false);
      expect(mgr.isMaximized).toBe(false);
    });

    it('restore handles null normalBounds', () => {
      mgr.isMaximized = true;
      mgr.normalBounds = null;
      mgr.toggleMaximize(); // restore
      expect(mgr.isMaximized).toBe(false);
      // No position change since normalBounds is null
    });
  });

  // =========================================================================
  // position
  // =========================================================================

  describe('position', () => {
    it('applies saved position and size', async () => {
      const ctx = createManager();
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;
      await mgr.init();

      mgr.savedPosition = { left: 200, top: 150 };
      mgr.savedSize = { width: 600, height: 700 };
      mgr.position();

      expect(windowEl.style.position).toBe('fixed');
      expect(windowEl.style.left).toBe('200px');
      expect(windowEl.style.top).toBe('150px');
      expect(windowEl.style.width).toBe('600px');
      expect(windowEl.style.height).toBe('700px');
    });

    it('returns early when detached', async () => {
      const ctx = createManager();
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;
      await mgr.init({ isDetached: true });

      windowEl.style.left = '0px';
      mgr.savedPosition = { left: 999, top: 999 };
      mgr.position();
      // Should not change — detached uses viewport units
      expect(windowEl.style.left).toBe('0px');
    });
  });

  // =========================================================================
  // constrainToViewport
  // =========================================================================

  describe('constrainToViewport', () => {
    beforeEach(async () => {
      const ctx = createManager();
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;
      await mgr.init();
    });

    it('constrains when window is too far right', () => {
      windowEl.getBoundingClientRect = jest.fn(() => ({
        left: 1000, top: 100, right: 1500, bottom: 700,
        width: 500, height: 600,
      }));
      mgr.constrainToViewport();
      expect(parseInt(windowEl.style.left)).toBe(window.innerWidth - 50);
    });

    it('constrains when window is too far left', () => {
      windowEl.getBoundingClientRect = jest.fn(() => ({
        left: -600, top: 100, right: -100, bottom: 700,
        width: 500, height: 600,
      }));
      mgr.constrainToViewport();
      expect(parseInt(windowEl.style.left)).toBe(50 - 500);
    });

    it('constrains when window is too far down', () => {
      windowEl.getBoundingClientRect = jest.fn(() => ({
        left: 100, top: 800, right: 600, bottom: 1400,
        width: 500, height: 600,
      }));
      mgr.constrainToViewport();
      expect(parseInt(windowEl.style.top)).toBe(window.innerHeight - 50);
    });

    it('constrains when window is too far up', () => {
      windowEl.getBoundingClientRect = jest.fn(() => ({
        left: 100, top: -700, right: 600, bottom: -100,
        width: 500, height: 600,
      }));
      mgr.constrainToViewport();
      expect(parseInt(windowEl.style.top)).toBe(50 - 600);
    });

    it('does nothing when fully visible', () => {
      windowEl.getBoundingClientRect = jest.fn(() => ({
        left: 100, top: 100, right: 600, bottom: 700,
        width: 500, height: 600,
      }));
      mgr.constrainToViewport();
      // No change
      expect(windowEl.style.left).toBe('30px'); // original position from init
    });

    it('returns early when detached', () => {
      mgr.isDetached = true;
      const spy = jest.fn();
      windowEl.getBoundingClientRect = spy;
      mgr.constrainToViewport();
      expect(spy).not.toHaveBeenCalled();
    });

    it('returns early when maximized', () => {
      mgr.isMaximized = true;
      const spy = jest.fn();
      windowEl.getBoundingClientRect = spy;
      mgr.constrainToViewport();
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // onViewportResize / onWindowResize
  // =========================================================================

  describe('onViewportResize', () => {
    it('calls constrainToViewport in attached mode', async () => {
      const ctx = createManager();
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;
      await mgr.init();
      const spy = jest.spyOn(mgr, 'constrainToViewport');
      mgr.onViewportResize();
      expect(spy).toHaveBeenCalled();
    });

    it('returns early when detached', async () => {
      const ctx = createManager();
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;
      await mgr.init({ isDetached: true });
      const spy = jest.spyOn(mgr, 'constrainToViewport');
      mgr.onViewportResize();
      expect(spy).not.toHaveBeenCalled();
    });

    it('returns early when element is null', () => {
      mgr = new DragResizeManager();
      mgr.element = null;
      mgr.onViewportResize(); // Should not throw
    });
  });

  describe('onWindowResize', () => {
    it('is a no-op in detached mode (CSS handles sizing via viewport units)', async () => {
      const ctx = createManager();
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;
      await mgr.init({ isDetached: true });
      // CSS already sets 100vw/100vh, so onWindowResize is intentionally empty
      windowEl.style.width = '100vw';
      windowEl.style.height = '100vh';
      mgr.onWindowResize();
      expect(windowEl.style.width).toBe('100vw');
      expect(windowEl.style.height).toBe('100vh');
    });

    it('returns early when not detached', async () => {
      const ctx = createManager();
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;
      await mgr.init();
      windowEl.style.width = '500px';
      mgr.onWindowResize();
      expect(windowEl.style.width).toBe('500px'); // unchanged
    });

    it('returns early when element is null', () => {
      mgr = new DragResizeManager();
      mgr.isDetached = true;
      mgr.element = null;
      mgr.onWindowResize(); // Should not throw
    });
  });

  // =========================================================================
  // getState
  // =========================================================================

  describe('getState', () => {
    it('returns frozen state object', async () => {
      const ctx = createManager();
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;
      await mgr.init();
      const state = mgr.getState();
      expect(state.isDetached).toBe(false);
      expect(state.isDragging).toBe(false);
      expect(state.isResizing).toBe(false);
      expect(state.isMaximized).toBe(false);
      expect(state.savedPosition).toEqual({ left: 30, top: 30 });
      expect(state.savedSize).toEqual({ width: 500, height: 600 });
      expect(Object.isFrozen(state)).toBe(true);
    });

    it('returns copy of position/size (not reference)', () => {
      mgr = new DragResizeManager();
      const state = mgr.getState();
      state.savedPosition.left = 999;
      expect(mgr.savedPosition.left).toBe(30); // not mutated
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    it('cancels pending drag RAF', async () => {
      const ctx = createManager();
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;
      await mgr.init();
      headerEl.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: 200, clientY: 200, bubbles: true,
      }));
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 210, clientY: 210 }));
      expect(mgr._dragRaf).not.toBeNull();
      mgr.dispose();
      expect(mgr._dragRaf).toBeNull();
    });

    it('cancels pending resize RAF', async () => {
      const ctx = createManager();
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;
      await mgr.init();
      mgr.startResize(new PointerEvent('pointerdown', {
        clientX: 600, clientY: 700, bubbles: true,
      }), 'se');
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 610, clientY: 710 }));
      expect(mgr._resizeRaf).not.toBeNull();
      mgr.dispose();
      expect(mgr._resizeRaf).toBeNull();
    });

    it('removes all tracked listeners', async () => {
      const ctx = createManager();
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;
      await mgr.init();
      expect(mgr._listeners.length).toBeGreaterThan(0);
      mgr.dispose();
      expect(mgr._listeners).toEqual([]);
    });

    it('resets state flags', async () => {
      const ctx = createManager();
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;
      await mgr.init();
      mgr.isDragging = true;
      mgr.isResizing = true;
      mgr.dispose();
      expect(mgr.isDragging).toBe(false);
      expect(mgr.isResizing).toBe(false);
    });

    it('clears DOM references', async () => {
      const ctx = createManager();
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;
      await mgr.init();
      mgr.dispose();
      expect(mgr.element).toBeNull();
      expect(mgr.header).toBeNull();
      expect(mgr.chatWindow).toBeNull();
      expect(mgr.eventBus).toBeNull();
    });

    it('re-enables text selection', async () => {
      const ctx = createManager();
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;
      await mgr.init();
      document.body.style.userSelect = 'none';
      mgr.dispose();
      expect(document.body.style.userSelect).toBe('');
    });

    it('handles listener removal errors gracefully', async () => {
      const ctx = createManager();
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;
      await mgr.init();
      // Add a listener that will fail to remove
      mgr._listeners.push({
        target: { removeEventListener: () => { throw new Error('fail'); } },
        event: 'test',
        handler: () => {},
      });
      mgr.dispose(); // Should not throw
      expect(mockLog.warn).toHaveBeenCalledWith('failed to remove registered listener', expect.any(Object));
    });
  });

  // =========================================================================
  // Full lifecycle
  // =========================================================================

  describe('full lifecycle', () => {
    it('init -> drag -> resize -> maximize -> restore -> dispose', async () => {
      const ctx = createManager();
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;

      // Init
      await mgr.init();
      expect(mgr.element).toBe(windowEl);

      // Drag
      headerEl.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: 200, clientY: 200, bubbles: true,
      }));
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 250, clientY: 230 }));
      jest.advanceTimersByTime(16);
      mgr.endDrag();
      expect(mgr.isDragging).toBe(false);

      // Resize
      mgr.startResize(new PointerEvent('pointerdown', {
        clientX: 600, clientY: 700, bubbles: true,
      }), 'se');
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 650, clientY: 750 }));
      jest.advanceTimersByTime(16);
      mgr.endResize();
      expect(mgr.isResizing).toBe(false);

      // Maximize
      mgr.toggleMaximize();
      expect(mgr.isMaximized).toBe(true);

      // Restore
      mgr.toggleMaximize();
      expect(mgr.isMaximized).toBe(false);

      // Dispose
      mgr.dispose();
      expect(mgr.element).toBeNull();
      expect(mgr._listeners).toEqual([]);
    });
  });

  // =========================================================================
  // setupDetachedMode
  // =========================================================================

  describe('setupDetachedMode', () => {
    it('sets viewport-filling styles', async () => {
      const ctx = createManager();
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;
      await mgr.init({ isDetached: true });
      expect(windowEl.style.position).toBe('fixed');
      expect(parseInt(windowEl.style.left)).toBe(0);
      expect(parseInt(windowEl.style.top)).toBe(0);
      expect(windowEl.style.width).toBe('100vw');
      expect(windowEl.style.height).toBe('100vh');
      expect(parseInt(windowEl.style.borderRadius)).toBe(0);
    });

    it('adds window resize listener', async () => {
      const ctx = createManager();
      mgr = ctx.mgr;
      windowEl = ctx.windowEl;
      headerEl = ctx.headerEl;
      await mgr.init({ isDetached: true });
      const resizeListener = mgr._listeners.find(
        l => l.target === window && l.event === 'resize'
      );
      expect(resizeListener).toBeDefined();
      expect(resizeListener.handler).toBe(mgr.onWindowResize);
    });
  });
});
