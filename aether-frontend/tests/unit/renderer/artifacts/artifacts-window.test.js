'use strict';

const mockLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => mockLog),
}));

const mockEventTypes = {
  UI: {
    COMPONENT_READY: 'ui:component-ready',
    WINDOW_SHOWN: 'ui:window-shown',
    WINDOW_HIDDEN: 'ui:window-hidden',
    WINDOW_MOVED: 'ui:window-moved',
  },
};
jest.mock('../../../../src/core/events/EventTypes', () => ({
  EventTypes: mockEventTypes,
}));

const mockAether = {
  windowControl: { control: jest.fn() },
  jobTracer: null,
};
jest.mock('../../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: jest.fn(() => mockAether),
}));

const ArtifactsWindow = require('../../../../src/renderer/artifacts/modules/window/ArtifactsWindow');

// ================================================================
// Helpers
// ================================================================

function createEventBus() {
  return { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
}

function createController() {
  return { getStats: jest.fn() };
}

function createWindow(overrides = {}) {
  const opts = {
    controller: createController(),
    eventBus: createEventBus(),
    aether: mockAether,
    ...overrides,
  };
  return new ArtifactsWindow(opts);
}

async function flushRaf() {
  // jsdom doesn't have real RAF, but jest fake timers can help
  await new Promise(r => setTimeout(r, 0));
}

// ================================================================
// Tests
// ================================================================

describe('ArtifactsWindow', () => {
  let originalRAF, originalCAF;

  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = '';
    window.localStorage.clear();

    // Mock RAF/CAF
    originalRAF = window.requestAnimationFrame;
    originalCAF = window.cancelAnimationFrame;
    window.requestAnimationFrame = jest.fn((cb) => { cb(); return 1; });
    window.cancelAnimationFrame = jest.fn();
  });

  afterEach(() => {
    window.requestAnimationFrame = originalRAF;
    window.cancelAnimationFrame = originalCAF;
  });

  // ----------------------------------------------------------
  // 1. Constructor
  // ----------------------------------------------------------
  describe('constructor', () => {
    it('throws when controller is missing', () => {
      expect(() => new ArtifactsWindow({ eventBus: createEventBus() }))
        .toThrow('[ArtifactsWindow] Controller required');
    });

    it('throws when eventBus is missing', () => {
      expect(() => new ArtifactsWindow({ controller: createController() }))
        .toThrow('[ArtifactsWindow] EventBus required');
    });

    it('initializes all properties', () => {
      const aw = createWindow();
      expect(aw.visible).toBe(false);
      expect(aw.minimized).toBe(false);
      expect(aw.pinned).toBe(false);
      expect(aw.isStandalone).toBe(true);
      expect(aw._isDisposed).toBe(false);
      expect(aw._isInitialized).toBe(false);
      expect(aw._eventListeners).toEqual([]);
      expect(aw._dragSession).toBeNull();
      expect(aw._resizeSession).toBeNull();
    });

    it('sets size to window dimensions in standalone mode', () => {
      const aw = createWindow();
      expect(aw.size.width).toBe(window.innerWidth);
      expect(aw.size.height).toBe(window.innerHeight);
      expect(aw.position).toEqual({ x: 0, y: 0 });
    });

    it('warns when no job tracer available', () => {
      createWindow();
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('Job tracer unavailable')
      );
    });

    it('attaches provided job tracer', () => {
      const tracer = { record: jest.fn() };
      const aw = createWindow({ jobTracer: tracer });
      expect(aw.jobTracer).toBe(tracer);
    });

    it('attaches aether job tracer as fallback', () => {
      const tracer = { record: jest.fn() };
      const savedTracer = mockAether.jobTracer;
      mockAether.jobTracer = tracer;
      const aw = createWindow();
      expect(aw.jobTracer).toBe(tracer);
      mockAether.jobTracer = savedTracer;
    });
  });

  // ----------------------------------------------------------
  // 2. init
  // ----------------------------------------------------------
  describe('init', () => {
    it('creates DOM and marks initialized', async () => {
      const aw = createWindow();
      await aw.init();

      expect(aw._isInitialized).toBe(true);
      expect(aw.element).toBeTruthy();
      expect(document.body.querySelector('.artifacts-window')).toBe(aw.element);
    });

    it('emits COMPONENT_READY event', async () => {
      const eb = createEventBus();
      const aw = createWindow({ eventBus: eb });
      await aw.init();

      expect(eb.emit).toHaveBeenCalledWith('ui:component-ready', expect.objectContaining({
        component: 'ArtifactsWindow',
      }));
    });

    it('rejects double init', async () => {
      const aw = createWindow();
      await aw.init();
      await aw.init();

      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('already-initialized')
      );
    });

    it('rejects init on disposed instance', async () => {
      const aw = createWindow();
      await aw.init();
      aw.dispose();
      await aw.init();

      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('disposed instance')
      );
    });
  });

  // ----------------------------------------------------------
  // 3. DOM structure
  // ----------------------------------------------------------
  describe('_createElement', () => {
    it('creates section with correct classes in standalone mode', async () => {
      const aw = createWindow();
      await aw.init();

      expect(aw.element.tagName).toBe('SECTION');
      expect(aw.element.classList.contains('artifacts-window')).toBe(true);
      expect(aw.element.classList.contains('standalone')).toBe(true);
    });

    it('sets ARIA attributes', async () => {
      const aw = createWindow();
      await aw.init();

      expect(aw.element.getAttribute('role')).toBe('dialog');
      expect(aw.element.getAttribute('aria-label')).toBe('Workbench');
      expect(aw.element.getAttribute('aria-hidden')).toBe('true');
    });

    it('creates header with chrome and content container', async () => {
      const aw = createWindow();
      await aw.init();

      expect(aw.chrome).toBeTruthy();
      expect(aw.header).toBeTruthy();
      expect(aw.contentContainer).toBeTruthy();
      expect(aw.tabsContainer).toBeTruthy();
      expect(aw.tabsContainer.getAttribute('role')).toBe('tablist');
    });

    it('creates close button; reset button omitted in standalone mode', async () => {
      const aw = createWindow();
      await aw.init();

      expect(aw.closeButton).toBeTruthy();
      expect(aw.closeButton.getAttribute('aria-label')).toBe('Close artifacts window');
      // Reset button is NOT created in standalone mode (isStandalone=true) because
      // _handleResetFrame sets pixel values that CSS !important overrides, causing
      // state desync. See Gap 4 in window_resize_production_quality plan.
      expect(aw.resetButton).toBeNull();
    });

    it('sets header to webkit-app-region drag in standalone mode', async () => {
      const aw = createWindow();
      await aw.init();

      expect(aw.header.style.webkitAppRegion).toBe('drag');
    });

    it('does not create resize handle in standalone mode', async () => {
      const aw = createWindow();
      await aw.init();

      expect(aw.resizeHandle).toBeNull();
    });
  });

  // ----------------------------------------------------------
  // 4. show / hide / toggle
  // ----------------------------------------------------------
  describe('show / hide / toggle', () => {
    it('show makes visible and emits event', async () => {
      const eb = createEventBus();
      const aw = createWindow({ eventBus: eb });
      await aw.init();

      aw.show();
      expect(aw.visible).toBe(true);
      expect(aw.element.classList.contains('visible')).toBe(true);
      expect(aw.element.getAttribute('aria-hidden')).toBe('false');
      expect(eb.emit).toHaveBeenCalledWith('ui:window-shown', { window: 'artifacts' });
    });

    it('show is no-op when already visible', async () => {
      const eb = createEventBus();
      const aw = createWindow({ eventBus: eb });
      await aw.init();

      aw.show();
      eb.emit.mockClear();
      aw.show();
      expect(eb.emit).not.toHaveBeenCalledWith('ui:window-shown', expect.anything());
    });

    it('show is no-op when disposed', async () => {
      const aw = createWindow();
      await aw.init();
      aw.dispose();

      expect(() => aw.show()).not.toThrow();
    });

    it('hide makes invisible and emits event', async () => {
      const eb = createEventBus();
      const aw = createWindow({ eventBus: eb });
      await aw.init();
      aw.show();

      aw.hide();
      expect(aw.visible).toBe(false);
      expect(aw.element.classList.contains('hidden')).toBe(true);
      expect(aw.element.getAttribute('aria-hidden')).toBe('true');
      expect(eb.emit).toHaveBeenCalledWith('ui:window-hidden', { window: 'artifacts' });
    });

    it('hide is no-op when not visible', async () => {
      const eb = createEventBus();
      const aw = createWindow({ eventBus: eb });
      await aw.init();

      eb.emit.mockClear();
      aw.hide();
      expect(eb.emit).not.toHaveBeenCalledWith('ui:window-hidden', expect.anything());
    });

    it('toggle switches visibility', async () => {
      const aw = createWindow();
      await aw.init();

      aw.toggle();
      expect(aw.visible).toBe(true);
      aw.toggle();
      expect(aw.visible).toBe(false);
    });
  });

  // ----------------------------------------------------------
  // 5. Getters
  // ----------------------------------------------------------
  describe('getters', () => {
    it('getElement returns element', async () => {
      const aw = createWindow();
      await aw.init();
      expect(aw.getElement()).toBe(aw.element);
    });

    it('getTabsContainer returns tabs container', async () => {
      const aw = createWindow();
      await aw.init();
      expect(aw.getTabsContainer()).toBe(aw.tabsContainer);
    });

    it('getContentContainer returns content container', async () => {
      const aw = createWindow();
      await aw.init();
      expect(aw.getContentContainer()).toBe(aw.contentContainer);
    });

    it('getState returns frozen state', async () => {
      const aw = createWindow();
      await aw.init();
      aw.show();

      const state = aw.getState();
      expect(state.visible).toBe(true);
      expect(Object.isFrozen(state)).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // 6. Close handler
  // ----------------------------------------------------------
  describe('_handleClose', () => {
    it('hides and notifies main process', async () => {
      const aw = createWindow();
      await aw.init();
      aw.show();

      aw._handleClose();
      expect(aw.visible).toBe(false);
      expect(mockAether.windowControl.control).toHaveBeenCalledWith('close');
    });

    it('handles windowControl error gracefully', async () => {
      mockAether.windowControl.control.mockImplementationOnce(() => { throw new Error('ctrl err'); });
      const aw = createWindow();
      await aw.init();
      aw.show();

      aw._handleClose();
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to notify main process'),
        expect.any(Error)
      );
    });

    it('handles missing windowControl', async () => {
      const aw = createWindow({ aether: {} });
      await aw.init();
      aw.show();

      expect(() => aw._handleClose()).not.toThrow();
    });
  });

  // ----------------------------------------------------------
  // 7. Keyboard handler
  // ----------------------------------------------------------
  describe('_handleKeydown', () => {
    it('Escape hides visible window', async () => {
      const aw = createWindow();
      await aw.init();
      aw.show();

      const event = { key: 'Escape', preventDefault: jest.fn() };
      aw._handleKeydown(event);
      expect(aw.visible).toBe(false);
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('Escape does nothing when hidden', async () => {
      const aw = createWindow();
      await aw.init();

      const event = { key: 'Escape', preventDefault: jest.fn() };
      aw._handleKeydown(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('Cmd+Shift+A toggles visibility', async () => {
      const aw = createWindow();
      await aw.init();

      const event = { key: 'a', metaKey: true, shiftKey: true, preventDefault: jest.fn() };
      aw._handleKeydown(event);
      expect(aw.visible).toBe(true);
      aw._handleKeydown(event);
      expect(aw.visible).toBe(false);
    });

    it('Ctrl+Shift+A toggles visibility', async () => {
      const aw = createWindow();
      await aw.init();

      const event = { key: 'A', ctrlKey: true, shiftKey: true, preventDefault: jest.fn() };
      aw._handleKeydown(event);
      expect(aw.visible).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // 8. Pointer helpers
  // ----------------------------------------------------------
  describe('pointer helpers', () => {
    it('_isPrimaryPointer returns false for null', () => {
      const aw = createWindow();
      expect(aw._isPrimaryPointer(null)).toBe(false);
    });

    it('_isPrimaryPointer returns true for touch', () => {
      const aw = createWindow();
      expect(aw._isPrimaryPointer({ pointerType: 'touch' })).toBe(true);
    });

    it('_isPrimaryPointer returns true for button=0', () => {
      const aw = createWindow();
      expect(aw._isPrimaryPointer({ pointerType: 'mouse', button: 0 })).toBe(true);
    });

    it('_isPrimaryPointer returns false for button=2 (right click)', () => {
      const aw = createWindow();
      expect(aw._isPrimaryPointer({ pointerType: 'mouse', button: 2 })).toBe(false);
    });

    it('_isPrimaryPointer returns true for which=1', () => {
      const aw = createWindow();
      expect(aw._isPrimaryPointer({ pointerType: 'mouse', which: 1 })).toBe(true);
    });

    it('_isPrimaryPointer returns true for no indicators', () => {
      const aw = createWindow();
      expect(aw._isPrimaryPointer({ pointerType: 'mouse' })).toBe(true);
    });

    it('_resolvePointerId returns numeric id when available', () => {
      const aw = createWindow();
      expect(aw._resolvePointerId({ pointerId: 42 })).toBe(42);
    });

    it('_resolvePointerId returns "mouse" as fallback', () => {
      const aw = createWindow();
      expect(aw._resolvePointerId({})).toBe('mouse');
      expect(aw._resolvePointerId(null)).toBe('mouse');
    });

    it('_eventMatchesPointer returns false for null event', () => {
      const aw = createWindow();
      expect(aw._eventMatchesPointer(null, 42)).toBe(false);
    });

    it('_eventMatchesPointer matches mouse fallback', () => {
      const aw = createWindow();
      expect(aw._eventMatchesPointer({ pointerType: 'mouse' }, 'mouse')).toBe(true);
    });

    it('_eventMatchesPointer matches numeric pointerId', () => {
      const aw = createWindow();
      expect(aw._eventMatchesPointer({ pointerId: 42 }, 42)).toBe(true);
      expect(aw._eventMatchesPointer({ pointerId: 99 }, 42)).toBe(false);
    });
  });

  // ----------------------------------------------------------
  // 9. Pin toggle
  // ----------------------------------------------------------
  describe('_handlePinToggle', () => {
    it('toggles pinned state', async () => {
      const aw = createWindow();
      await aw.init();

      aw._handlePinToggle();
      expect(aw.pinned).toBe(true);
      expect(aw.element.classList.contains('artifacts-window--pinned')).toBe(true);

      aw._handlePinToggle();
      expect(aw.pinned).toBe(false);
      expect(aw.element.classList.contains('artifacts-window--pinned')).toBe(false);
    });
  });

  // ----------------------------------------------------------
  // 10. Reset frame
  // ----------------------------------------------------------
  describe('_handleResetFrame', () => {
    it('resets to default size and position', async () => {
      const eb = createEventBus();
      const aw = createWindow({ eventBus: eb });
      await aw.init();

      aw._handleResetFrame();
      expect(eb.emit).toHaveBeenCalledWith('ui:window-moved', expect.objectContaining({
        reason: 'reset',
      }));
    });
  });

  // ----------------------------------------------------------
  // 11. State persistence
  // ----------------------------------------------------------
  describe('state persistence', () => {
    it('persists and restores state from localStorage', async () => {
      const aw1 = createWindow();
      await aw1.init();
      aw1._persistState();

      const raw = window.localStorage.getItem('aether.artifacts.window.state.v2');
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(2);
      expect(parsed.position).toBeDefined();
      expect(parsed.size).toBeDefined();
    });

    it('handles localStorage setItem failure', async () => {
      const aw = createWindow();
      await aw.init();

      // jsdom's localStorage doesn't support jest.spyOn; override directly
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = () => { throw new Error('QuotaExceededError'); };

      aw._persistState();

      expect(mockLog.warn).toHaveBeenCalledWith(
        '[ArtifactsWindow] Failed to persist state',
        expect.objectContaining({ message: 'QuotaExceededError' })
      );

      Storage.prototype.setItem = original;
    });

    it('returns null when no persisted state', () => {
      const aw = createWindow();
      expect(aw._loadPersistedState()).toBeNull();
    });

    it('returns null when version mismatch', () => {
      window.localStorage.setItem('aether.artifacts.window.state.v2', JSON.stringify({ version: 1 }));
      const aw = createWindow();
      expect(aw._loadPersistedState()).toBeNull();
    });

    it('handles getItem parse error', () => {
      window.localStorage.setItem('aether.artifacts.window.state.v2', '{bad json');
      const aw = createWindow();
      expect(aw._loadPersistedState()).toBeNull();
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load state'),
        expect.any(Error)
      );
    });

    it('restores pinned state from localStorage', async () => {
      window.localStorage.setItem('aether.artifacts.window.state.v2', JSON.stringify({
        version: 2,
        position: { x: 100, y: 200 },
        size: { width: 800, height: 600 },
        pinned: true,
      }));

      const aw = createWindow();
      await aw.init();

      expect(aw.pinned).toBe(true);
      expect(aw.element.classList.contains('artifacts-window--pinned')).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // 12. Dispose
  // ----------------------------------------------------------
  describe('dispose', () => {
    it('removes element from DOM and nulls references', async () => {
      const aw = createWindow();
      await aw.init();
      expect(document.body.querySelector('.artifacts-window')).toBeTruthy();

      aw.dispose();
      expect(document.body.querySelector('.artifacts-window')).toBeNull();
      expect(aw.element).toBeNull();
      expect(aw.chrome).toBeNull();
      expect(aw.header).toBeNull();
      expect(aw._isDisposed).toBe(true);
      expect(aw._isInitialized).toBe(false);
    });

    it('is idempotent', async () => {
      const aw = createWindow();
      await aw.init();
      aw.dispose();
      aw.dispose();
      expect(aw._isDisposed).toBe(true);
    });

    it('handles cleanup function errors', async () => {
      const aw = createWindow();
      await aw.init();
      aw._eventListeners.push(() => { throw new Error('cleanup fail'); });

      aw.dispose();
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed cleanup'),
        expect.any(Error)
      );
    });
  });

  // ----------------------------------------------------------
  // 13. Job tracing
  // ----------------------------------------------------------
  describe('job tracing', () => {
    it('records traces when tracer is available', async () => {
      const tracer = { record: jest.fn() };
      const aw = createWindow({ jobTracer: tracer });
      await aw.init();

      expect(tracer.record).toHaveBeenCalledWith('JOB_INITIALIZE', expect.objectContaining({
        component: 'ArtifactsWindow',
      }));
    });

    it('handles tracing errors gracefully', async () => {
      const tracer = { record: jest.fn(() => { throw new Error('trace err'); }) };
      const aw = createWindow({ jobTracer: tracer });
      // Constructor calls _traceJob, which should catch the error
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('Job tracing failed'),
        expect.any(Error)
      );
    });

    it('no-ops when tracer is null', async () => {
      const aw = createWindow();
      // Should not throw even though tracer is null
      expect(() => aw._traceJob('TEST', {})).not.toThrow();
    });
  });

  // ----------------------------------------------------------
  // 14. Viewport resize (standalone)
  // ----------------------------------------------------------
  describe('standalone resize handler', () => {
    it('clamps size after init to viewport minus EDGE_MARGIN', async () => {
      // jsdom: innerWidth=1024, innerHeight=768
      // _applySize clamps: maxW = max(520, 1024-0-24) = 1000
      //                    maxH = max(360, 768-0-24) = 744
      const aw = createWindow();
      await aw.init();

      expect(aw.size.width).toBe(1000);
      expect(aw.size.height).toBe(744);
    });

    it('registers window resize listener tracked in _eventListeners', async () => {
      const aw = createWindow();
      await aw.init();

      // Standalone mode registers: closeButton click, resetButton click,
      // window resize, document keydown = at least 4 cleanup functions
      expect(aw._eventListeners.length).toBeGreaterThanOrEqual(4);
    });
  });

  // ----------------------------------------------------------
  // 15. Module export
  // ----------------------------------------------------------
  describe('module export', () => {
    it('exports ArtifactsWindow class', () => {
      expect(typeof ArtifactsWindow).toBe('function');
    });

    it('exposes on window', () => {
      expect(window.ArtifactsWindow).toBe(ArtifactsWindow);
    });
  });

  // ----------------------------------------------------------
  // 16. _suppressClickAfterDrag
  // ----------------------------------------------------------
  describe('_suppressClickAfterDrag', () => {
    it('prevents click after drag', async () => {
      const aw = createWindow();
      await aw.init();

      aw._suppressClickAfterDrag();
      // RAF callback fires synchronously in our mock, so the listener is already removed
      // Just verify no throw
      expect(() => aw._suppressClickAfterDrag()).not.toThrow();
    });

    it('no-ops when header is null', () => {
      const aw = createWindow();
      aw.header = null;
      aw._suppressClickAfterDrag();
      // Should not throw
    });
  });

  // ----------------------------------------------------------
  // 17. _emitWindowMoved
  // ----------------------------------------------------------
  describe('_emitWindowMoved', () => {
    it('emits with position and size', async () => {
      const eb = createEventBus();
      const aw = createWindow({ eventBus: eb });
      await aw.init();

      aw._emitWindowMoved('test-reason');
      expect(eb.emit).toHaveBeenCalledWith('ui:window-moved', expect.objectContaining({
        window: 'artifacts',
        reason: 'test-reason',
      }));
    });
  });

  // ----------------------------------------------------------
  // 18. _cancelOngoingInteractions
  // ----------------------------------------------------------
  describe('_cancelOngoingInteractions', () => {
    it('cancels drag session', async () => {
      const aw = createWindow();
      await aw.init();

      aw._dragSession = { pointerId: 'mouse', startX: 0, startY: 0 };
      aw._cancelOngoingInteractions();
      expect(aw._dragSession).toBeNull();
    });

    it('cancels resize session and releases pointer capture', async () => {
      const aw = createWindow();
      await aw.init();

      // Simulate having a resize handle (even though standalone mode doesn't create one)
      aw.resizeHandle = { releasePointerCapture: jest.fn() };
      aw._resizeSession = { pointerId: 42 };
      aw._resizeRaf = 123;

      aw._cancelOngoingInteractions();
      expect(aw._resizeSession).toBeNull();
      expect(aw._resizeRaf).toBeNull();
      expect(aw.resizeHandle.releasePointerCapture).toHaveBeenCalledWith(42);
    });

    it('handles releasePointerCapture failure', async () => {
      const aw = createWindow();
      await aw.init();

      aw.resizeHandle = { releasePointerCapture: jest.fn(() => { throw new Error('fail'); }) };
      aw._resizeSession = { pointerId: 42 };

      // Should not throw
      expect(() => aw._cancelOngoingInteractions()).not.toThrow();
    });
  });

  // ----------------------------------------------------------
  // 19. _applySize and _applyPosition
  // ----------------------------------------------------------
  describe('_applySize / _applyPosition', () => {
    it('clamps size to minimum', async () => {
      const aw = createWindow();
      await aw.init();

      aw._applySize(100, 100);
      expect(aw.size.width).toBeGreaterThanOrEqual(520);
      expect(aw.size.height).toBeGreaterThanOrEqual(360);
    });

    it('applies position clamped to viewport', async () => {
      const aw = createWindow();
      await aw.init();

      aw._applyPosition(-100, -100);
      expect(aw.position.x).toBeGreaterThanOrEqual(24);
      expect(aw.position.y).toBeGreaterThanOrEqual(24);
    });

    it('stores position without persisting when silently=true', async () => {
      const aw = createWindow();
      await aw.init();

      // Snapshot localStorage state before the silent position change
      const stateBefore = window.localStorage.getItem('aether.artifacts.window.state.v2');
      aw._applyPosition(50, 50, { silently: true });
      const stateAfter = window.localStorage.getItem('aether.artifacts.window.state.v2');

      // localStorage should NOT have changed (silently=true skips persistence)
      expect(stateAfter).toBe(stateBefore);
    });

    it('persists state when silently is false/unset', async () => {
      const aw = createWindow();
      await aw.init();

      aw._applyPosition(50, 50);
      // Should persist (setItem called)
      const raw = window.localStorage.getItem('aether.artifacts.window.state.v2');
      expect(raw).toBeTruthy();
    });

    it('stores position only (no style) when pinned', async () => {
      const aw = createWindow();
      await aw.init();
      aw.pinned = true;

      aw._applyPosition(200, 300);
      expect(aw.position.x).toBe(200);
      expect(aw.position.y).toBe(300);
    });
  });

  // ----------------------------------------------------------
  // 20. _createControlButton
  // ----------------------------------------------------------
  describe('_createControlButton', () => {
    it('creates button with correct attributes', async () => {
      const aw = createWindow();
      await aw.init();

      const handler = jest.fn();
      const btn = aw._createControlButton('test-id', 'Test Label', 'Click', handler, true);
      expect(btn.id).toBe('test-id');
      expect(btn.getAttribute('aria-label')).toBe('Test Label');
      expect(btn.getAttribute('aria-pressed')).toBe('false');
      expect(btn.textContent).toBe('Click');

      btn.click();
      expect(handler).toHaveBeenCalled();
    });
  });
});
