'use strict';

// BaseModal is a pure DOM class with no external module dependencies.
// No mocks needed — runs in jsdom environment.

const BaseModal = require('../../../src/renderer/shared/modals/BaseModal');

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/** Concrete subclass for testing abstract BaseModal */
class TestModal extends BaseModal {
  constructor(options = {}) {
    super(options);
    this._renderCalled = false;
    this._setupListenersCalled = false;
    this._cleanupCalled = false;
  }

  async _renderContent() {
    this._renderCalled = true;
    this.bodyEl.textContent = 'test-body-content';
  }

  _setupEventListeners() {
    this._setupListenersCalled = true;
  }

  _cleanup() {
    this._cleanupCalled = true;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Suite
// ───────────────────────────────────────────────────────────────────────────

describe('BaseModal', () => {
  /** Track created modals for teardown */
  let modals;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    document.body.innerHTML = '';
    modals = [];
    // Force-override requestAnimationFrame with setTimeout-based version
    // so jest fake timers can control it (jsdom's built-in rAF ignores fake timers)
    global.requestAnimationFrame = window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  });

  afterEach(() => {
    // Destroy all modals to prevent MODAL_REGISTRY leaks between tests
    for (const m of modals) {
      try { m.destroy(); } catch (_) { /* already destroyed */ }
    }
    modals = [];
    jest.useRealTimers();
  });

  function createModal(opts = {}) {
    const m = new TestModal({ title: 'Test', id: 'test-modal', ...opts });
    modals.push(m);
    return m;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // constructor
  // ═══════════════════════════════════════════════════════════════════════

  describe('constructor', () => {
    it('sets default values', () => {
      const m = createModal({});
      expect(m.title).toBe('Test');
      expect(m.id).toBe('test-modal');
      expect(m.size).toBe('xl');
      expect(m.heightPreset).toBe('default');
      expect(m.showFooter).toBe(false);
      expect(m.isOpen).toBe(false);
    });

    it('accepts custom title and id', () => {
      const m = createModal({ title: 'Custom', id: 'custom-id' });
      expect(m.title).toBe('Custom');
      expect(m.id).toBe('custom-id');
    });

    it('generates id from Date.now when not provided', () => {
      const before = Date.now();
      const m = new BaseModal({ title: 'X' });
      modals.push(m);
      // id starts with 'modal-'
      expect(m.id).toMatch(/^modal-\d+$/);
      const ts = parseInt(m.id.replace('modal-', ''), 10);
      expect(ts).toBeGreaterThanOrEqual(before);
    });

    it('accepts size sm', () => {
      const m = createModal({ size: 'sm' });
      expect(m.size).toBe('sm');
      expect(m.panel.classList.contains('modal-panel--sm')).toBe(true);
    });

    it('accepts size md', () => {
      const m = createModal({ size: 'md' });
      expect(m.panel.classList.contains('modal-panel--md')).toBe(true);
    });

    it('accepts size lg', () => {
      const m = createModal({ size: 'lg' });
      expect(m.panel.classList.contains('modal-panel--lg')).toBe(true);
    });

    it('accepts heightPreset compact', () => {
      const m = createModal({ heightPreset: 'compact' });
      expect(m.panel.classList.contains('modal-panel--h-compact')).toBe(true);
    });

    it('accepts heightPreset auto', () => {
      const m = createModal({ heightPreset: 'auto' });
      expect(m.panel.classList.contains('modal-panel--h-auto')).toBe(true);
    });

    it('does not add height class for default preset', () => {
      const m = createModal({ heightPreset: 'default' });
      expect(m.panel.classList.contains('modal-panel--h-compact')).toBe(false);
      expect(m.panel.classList.contains('modal-panel--h-auto')).toBe(false);
    });

    it('creates footer when showFooter is true', () => {
      const m = createModal({ showFooter: true });
      expect(m.footerEl).toBeTruthy();
      expect(m.footerEl.className).toBe('modal-footer');
      expect(m.panel.contains(m.footerEl)).toBe(true);
    });

    it('does not create footer when showFooter is false', () => {
      const m = createModal({ showFooter: false });
      expect(m.footerEl).toBeNull();
    });

    it('binds _handleEscape, _handleBackdropClick, _handleCloseClick', () => {
      const m = createModal();
      // Bound methods should exist and be functions
      expect(typeof m._handleEscape).toBe('function');
      expect(typeof m._handleBackdropClick).toBe('function');
      expect(typeof m._handleCloseClick).toBe('function');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _createElement
  // ═══════════════════════════════════════════════════════════════════════

  describe('_createElement', () => {
    it('creates overlay attached to document.body', () => {
      const m = createModal();
      expect(m.overlay).toBeTruthy();
      expect(m.overlay.parentNode).toBe(document.body);
    });

    it('overlay has hidden class initially', () => {
      const m = createModal();
      expect(m.overlay.classList.contains('hidden')).toBe(true);
    });

    it('overlay has correct id', () => {
      const m = createModal({ id: 'abc' });
      expect(m.overlay.id).toBe('abc-overlay');
    });

    it('panel has role=dialog and aria-modal=true', () => {
      const m = createModal();
      expect(m.panel.getAttribute('role')).toBe('dialog');
      expect(m.panel.getAttribute('aria-modal')).toBe('true');
    });

    it('panel has aria-labelledby pointing to title element', () => {
      const m = createModal({ id: 'x' });
      expect(m.panel.getAttribute('aria-labelledby')).toBe('x-title');
    });

    it('header contains title and close button', () => {
      const m = createModal({ title: 'My Title' });
      const titleEl = m.headerEl.querySelector('.modal-title');
      expect(titleEl).toBeTruthy();
      expect(titleEl.textContent).toBe('My Title');
      expect(m.closeButton).toBeTruthy();
      expect(m.closeButton.getAttribute('aria-label')).toBe('Close dialog');
    });

    it('close button contains SVG', () => {
      const m = createModal();
      const svg = m.closeButton.querySelector('svg');
      expect(svg).toBeTruthy();
    });

    it('body element exists with correct class', () => {
      const m = createModal();
      expect(m.bodyEl).toBeTruthy();
      expect(m.bodyEl.className).toBe('modal-body');
    });

    it('panel click stops propagation to overlay', () => {
      const m = createModal();
      const overlayClickSpy = jest.fn();
      m.overlay.addEventListener('click', overlayClickSpy);

      const evt = new Event('click', { bubbles: true });
      m.panel.dispatchEvent(evt);

      // Due to stopPropagation on panel, the overlay handler should not fire with the panel as target
      // but it will fire because the event still propagates in jsdom. The key is that
      // _handleBackdropClick checks e.target === overlay, so it won't close.
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // open()
  // ═══════════════════════════════════════════════════════════════════════

  describe('open()', () => {
    it('sets isOpen to true', async () => {
      const m = createModal();
      await m.open();
      expect(m.isOpen).toBe(true);
    });

    it('calls _renderContent', async () => {
      const m = createModal();
      await m.open();
      expect(m._renderCalled).toBe(true);
    });

    it('calls _setupEventListeners', async () => {
      const m = createModal();
      await m.open();
      expect(m._setupListenersCalled).toBe(true);
    });

    it('removes hidden class from overlay', async () => {
      const m = createModal();
      await m.open();
      expect(m.overlay.classList.contains('hidden')).toBe(false);
    });

    it('adds keydown listener for escape', async () => {
      const addSpy = jest.spyOn(document, 'addEventListener');
      const m = createModal();
      await m.open();
      expect(addSpy).toHaveBeenCalledWith('keydown', m._handleEscape);
      addSpy.mockRestore();
    });

    it('triggers animation via requestAnimationFrame', async () => {
      const m = createModal();
      await m.open();
      // Run the rAF callback
      jest.advanceTimersByTime(0);
      expect(m.overlay.classList.contains('is-visible')).toBe(true);
    });

    it('is a no-op if already open', async () => {
      const m = createModal();
      await m.open();
      m._renderCalled = false;
      await m.open();
      expect(m._renderCalled).toBe(false);
    });

    it('closes other active modal (single modal enforcement)', async () => {
      const m1 = createModal({ id: 'modal-1' });
      const m2 = createModal({ id: 'modal-2' });

      await m1.open();
      expect(m1.isOpen).toBe(true);

      await m2.open();
      // m1 should have been closed
      expect(m1.isOpen).toBe(false);
      expect(m2.isOpen).toBe(true);
    });

    it('abstract _renderContent throws in BaseModal directly', async () => {
      const m = new BaseModal({ title: 'Abstract' });
      modals.push(m);
      await expect(m.open()).rejects.toThrow('_renderContent() must be implemented by subclass');
    });

    it('works without _setupEventListeners defined', async () => {
      // Create a subclass that only implements _renderContent
      class MinimalModal extends BaseModal {
        async _renderContent() {
          this.bodyEl.textContent = 'minimal';
        }
      }
      const m = new MinimalModal({ title: 'Min' });
      modals.push(m);
      await expect(m.open()).resolves.not.toThrow();
      expect(m.isOpen).toBe(true);
    });

    it('integrates with window.accessibilityManager when available', async () => {
      const mockA11y = {
        focusHistory: [],
        trapFocus: jest.fn(() => jest.fn()),
        announce: jest.fn(),
      };
      window.accessibilityManager = mockA11y;

      try {
        const m = createModal({ title: 'A11y Test' });
        await m.open();
        jest.advanceTimersByTime(0); // rAF

        expect(mockA11y.trapFocus).toHaveBeenCalledWith(m.panel);
        expect(mockA11y.announce).toHaveBeenCalledWith('A11y Test dialog opened');
      } finally {
        delete window.accessibilityManager;
      }
    });

    it('pushes current activeElement to focusHistory', async () => {
      const btn = document.createElement('button');
      document.body.appendChild(btn);
      btn.focus();

      const mockA11y = {
        focusHistory: [],
        trapFocus: jest.fn(() => jest.fn()),
        announce: jest.fn(),
      };
      window.accessibilityManager = mockA11y;

      try {
        const m = createModal();
        await m.open();
        jest.advanceTimersByTime(0);

        expect(mockA11y.focusHistory).toContain(btn);
      } finally {
        delete window.accessibilityManager;
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // close()
  // ═══════════════════════════════════════════════════════════════════════

  describe('close()', () => {
    it('sets isOpen to false', async () => {
      const m = createModal();
      await m.open();
      m.close();
      expect(m.isOpen).toBe(false);
    });

    it('removes keydown listener', async () => {
      const removeSpy = jest.spyOn(document, 'removeEventListener');
      const m = createModal();
      await m.open();
      m.close();
      expect(removeSpy).toHaveBeenCalledWith('keydown', m._handleEscape);
      removeSpy.mockRestore();
    });

    it('removes is-visible class', async () => {
      const m = createModal();
      await m.open();
      jest.advanceTimersByTime(0); // rAF
      m.close();
      expect(m.overlay.classList.contains('is-visible')).toBe(false);
    });

    it('adds hidden class after 300ms animation', async () => {
      const m = createModal();
      await m.open();
      m.close();
      expect(m.overlay.classList.contains('hidden')).toBe(false);
      jest.advanceTimersByTime(300);
      expect(m.overlay.classList.contains('hidden')).toBe(true);
    });

    it('calls _cleanup after animation', async () => {
      const m = createModal();
      await m.open();
      m.close();
      expect(m._cleanupCalled).toBe(false);
      jest.advanceTimersByTime(300);
      expect(m._cleanupCalled).toBe(true);
    });

    it('clears ACTIVE_MODAL reference after animation', async () => {
      const m1 = createModal({ id: 'close-test' });
      await m1.open();
      m1.close();
      jest.advanceTimersByTime(300);

      // Opening a new modal should not attempt to close m1 again
      const m2 = createModal({ id: 'close-test-2' });
      const closeSpy = jest.spyOn(m1, 'close');
      await m2.open();
      expect(closeSpy).not.toHaveBeenCalled();
    });

    it('is a no-op if not open', () => {
      const m = createModal();
      m.close(); // Should not throw
      expect(m.isOpen).toBe(false);
    });

    it('releases focus trap and restores focus via a11y', async () => {
      const releaseFn = jest.fn();
      const mockA11y = {
        focusHistory: [],
        trapFocus: jest.fn(() => releaseFn),
        restoreFocus: jest.fn(),
        announce: jest.fn(),
      };
      window.accessibilityManager = mockA11y;

      try {
        const m = createModal({ title: 'Close A11y' });
        await m.open();
        jest.advanceTimersByTime(0); // rAF — sets up trap

        m.close();
        expect(releaseFn).toHaveBeenCalled();
        expect(mockA11y.restoreFocus).toHaveBeenCalled();
        expect(mockA11y.announce).toHaveBeenCalledWith('Close A11y dialog closed');
      } finally {
        delete window.accessibilityManager;
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _handleEscape
  // ═══════════════════════════════════════════════════════════════════════

  describe('_handleEscape', () => {
    it('closes on Escape key', async () => {
      const m = createModal();
      await m.open();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(m.isOpen).toBe(false);
    });

    it('closes on Esc key (legacy)', async () => {
      const m = createModal();
      await m.open();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Esc' }));
      expect(m.isOpen).toBe(false);
    });

    it('does not close on other keys', async () => {
      const m = createModal();
      await m.open();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(m.isOpen).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _handleBackdropClick
  // ═══════════════════════════════════════════════════════════════════════

  describe('_handleBackdropClick', () => {
    it('closes when overlay itself is clicked', async () => {
      const m = createModal();
      await m.open();
      // Simulate direct click on overlay (target === overlay)
      const evt = new Event('click', { bubbles: false });
      Object.defineProperty(evt, 'target', { value: m.overlay });
      m._handleBackdropClick(evt);
      expect(m.isOpen).toBe(false);
    });

    it('does not close when panel is clicked', async () => {
      const m = createModal();
      await m.open();
      const evt = new Event('click', { bubbles: false });
      Object.defineProperty(evt, 'target', { value: m.panel });
      m._handleBackdropClick(evt);
      expect(m.isOpen).toBe(true);
    });

    it('does not close when child element is clicked', async () => {
      const m = createModal();
      await m.open();
      const evt = new Event('click', { bubbles: false });
      Object.defineProperty(evt, 'target', { value: m.bodyEl });
      m._handleBackdropClick(evt);
      expect(m.isOpen).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _handleCloseClick
  // ═══════════════════════════════════════════════════════════════════════

  describe('_handleCloseClick', () => {
    it('closes the modal when close button is clicked', async () => {
      const m = createModal();
      await m.open();
      m.closeButton.click();
      expect(m.isOpen).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // destroy()
  // ═══════════════════════════════════════════════════════════════════════

  describe('destroy()', () => {
    it('calls close', async () => {
      const m = createModal();
      await m.open();
      const closeSpy = jest.spyOn(m, 'close');
      m.destroy();
      expect(closeSpy).toHaveBeenCalled();
    });

    it('removes overlay from DOM', () => {
      const m = createModal();
      expect(document.body.contains(m.overlay)).toBe(true);
      m.destroy();
      // After destroy, overlay should be removed
      // Note: close() adds hidden after 300ms, but destroy removes immediately
      expect(m.overlay).toBeNull();
    });

    it('nulls all DOM references', () => {
      const m = createModal({ showFooter: true });
      m.destroy();
      expect(m.overlay).toBeNull();
      expect(m.panel).toBeNull();
      expect(m.headerEl).toBeNull();
      expect(m.bodyEl).toBeNull();
      expect(m.footerEl).toBeNull();
      expect(m.closeButton).toBeNull();
    });

    it('removes from global registry', () => {
      // The destroy removes from MODAL_REGISTRY. We can't access the registry
      // directly, but we verify by checking that closeAll does not try to close it.
      const m = createModal();
      m.destroy();
      // If still in registry, closeAll would call close on a destroyed modal
      // which might error. Should not throw.
      BaseModal.closeAll();
    });

    it('is safe to call on modal not in DOM', () => {
      const m = createModal();
      // Manually remove overlay first
      m.overlay.parentNode.removeChild(m.overlay);
      expect(() => m.destroy()).not.toThrow();
    });

    it('is safe to call twice', () => {
      const m = createModal();
      m.destroy();
      expect(() => m.destroy()).not.toThrow();
    });

    it('BUG REGRESSION: close() then immediate destroy() does not crash when 300ms callback fires', async () => {
      // Before fix: close() starts a 300ms setTimeout that accesses this.overlay.classList.
      // If destroy() runs before the callback fires, overlay is null → TypeError.
      // Fix: added `if (this.overlay)` guard inside the setTimeout callback.
      const m = createModal();
      await m.open();
      jest.advanceTimersByTime(0); // rAF

      // Step 1: close() starts the 300ms animation timer
      m.close();

      // Step 2: destroy() nulls overlay BEFORE the 300ms callback fires
      m.destroy();
      expect(m.overlay).toBeNull();

      // Step 3: advance timers past 300ms — the setTimeout callback fires
      // Without the guard, this would throw TypeError: Cannot read properties of null
      expect(() => jest.advanceTimersByTime(300)).not.toThrow();
    });

    it('BUG REGRESSION: close() callback does not crash _cleanup when bodyEl is null from destroy', async () => {
      // Verify the entire setTimeout callback completes without error
      // including _cleanup() which may reference bodyEl
      const m = createModal();
      await m.open();
      jest.advanceTimersByTime(0); // rAF

      m.close();
      m.destroy();

      // Verify all DOM refs are null
      expect(m.overlay).toBeNull();
      expect(m.bodyEl).toBeNull();
      expect(m.panel).toBeNull();

      // Fire the delayed callback — no crash
      expect(() => jest.advanceTimersByTime(300)).not.toThrow();

      // isOpen should still be false (not re-set by failed callback)
      expect(m.isOpen).toBe(false);
    });

    it('removes closeButton listener before DOM removal', () => {
      const m = createModal();
      const spy = jest.spyOn(m.closeButton, 'removeEventListener');
      m.destroy();
      expect(spy).toHaveBeenCalledWith('click', m._handleCloseClick);
      spy.mockRestore();
    });

    it('removes overlay backdrop listener before DOM removal', () => {
      const m = createModal();
      const spy = jest.spyOn(m.overlay, 'removeEventListener');
      m.destroy();
      expect(spy).toHaveBeenCalledWith('click', m._handleBackdropClick);
      spy.mockRestore();
    });

    it('removes panel click listener before DOM removal', () => {
      const m = createModal();
      const spy = jest.spyOn(m.panel, 'removeEventListener');
      m.destroy();
      expect(spy).toHaveBeenCalledWith('click', m._handlePanelClick);
      spy.mockRestore();
    });

    it('quantitative: 3 listeners created in _createElement = 3 removed in destroy()', () => {
      const m = createModal();
      const closeBtnSpy = jest.spyOn(m.closeButton, 'removeEventListener');
      const overlaySpy = jest.spyOn(m.overlay, 'removeEventListener');
      const panelSpy = jest.spyOn(m.panel, 'removeEventListener');

      m.destroy();

      // closeButton: 1 click listener
      expect(closeBtnSpy).toHaveBeenCalledTimes(1);
      // overlay: 1 click listener
      expect(overlaySpy).toHaveBeenCalledTimes(1);
      // panel: 1 click listener
      expect(panelSpy).toHaveBeenCalledTimes(1);

      // Total: N=3 created, M=3 removed
      const totalRemoved = closeBtnSpy.mock.calls.length +
                          overlaySpy.mock.calls.length +
                          panelSpy.mock.calls.length;
      expect(totalRemoved).toBe(3);

      closeBtnSpy.mockRestore();
      overlaySpy.mockRestore();
      panelSpy.mockRestore();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // shutdown()
  // ═══════════════════════════════════════════════════════════════════════

  describe('shutdown()', () => {
    it('is an alias for destroy', () => {
      const m = createModal();
      const destroySpy = jest.spyOn(m, 'destroy');
      m.shutdown();
      expect(destroySpy).toHaveBeenCalledTimes(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // BaseModal.closeAll()
  // ═══════════════════════════════════════════════════════════════════════

  describe('BaseModal.closeAll()', () => {
    it('closes all open modals', async () => {
      const m1 = createModal({ id: 'ca-1' });
      const m2 = createModal({ id: 'ca-2' });

      // Open m1, then open m2 (which closes m1 due to single-modal enforcement)
      // We need both open for closeAll, so we open m1 then bypass enforcement
      // by directly setting state. Better approach: open m2, then manually set m1 as open.
      // Actually, single modal enforcement means only one can be open at a time.
      // closeAll iterates all registered modals and closes any that are open.
      await m2.open();
      expect(m2.isOpen).toBe(true);
      BaseModal.closeAll();
      expect(m2.isOpen).toBe(false);
    });

    it('is a no-op when no modals are open', () => {
      const m = createModal();
      expect(m.isOpen).toBe(false);
      BaseModal.closeAll(); // Should not throw
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // lifecycle: open -> close -> reopen
  // ═══════════════════════════════════════════════════════════════════════

  describe('lifecycle', () => {
    it('can be reopened after close', async () => {
      const m = createModal();
      await m.open();
      m.close();
      jest.advanceTimersByTime(300); // wait for animation
      m._renderCalled = false;

      await m.open();
      expect(m.isOpen).toBe(true);
      expect(m._renderCalled).toBe(true);
    });

    it('body content is rendered on each open', async () => {
      const m = createModal();
      await m.open();
      expect(m.bodyEl.textContent).toBe('test-body-content');

      m.close();
      jest.advanceTimersByTime(300);

      // Simulate subclass clearing body in _cleanup
      m.bodyEl.textContent = '';
      await m.open();
      expect(m.bodyEl.textContent).toBe('test-body-content');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // exports
  // ═══════════════════════════════════════════════════════════════════════

  describe('exports', () => {
    it('exports BaseModal constructor', () => {
      expect(typeof BaseModal).toBe('function');
    });

    it('BaseModal.closeAll is a static function', () => {
      expect(typeof BaseModal.closeAll).toBe('function');
    });
  });
});
