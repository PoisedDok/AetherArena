'use strict';

/**
 * BaseModal tests — focuses on lifecycle bugs, not coverage farming.
 *
 * Bug: close→reopen race condition
 * Root cause: close() sets isOpen=false immediately but schedules _cleanup()
 * after 300ms via setTimeout. If open() is called within that window:
 *   1. open() sees isOpen=false → enters open path → sets isOpen=true
 *   2. _renderContent() runs, _setupEventListeners() attaches handlers
 *   3. 300ms timer fires → _cleanup() wipes the freshly created listeners
 *   4. ACTIVE_MODAL set to null even though modal is open
 * Result: modal is open with dead UI. Single-modal enforcement broken.
 *
 * Fix: setTimeout callback checks `if (this.isOpen) return;` before cleanup.
 */

const BaseModal = require('../../../../src/renderer/shared/modals/BaseModal');

// Concrete test subclass
class TestModal extends BaseModal {
  constructor(opts = {}) {
    super({ title: 'Test', id: 'test-modal', ...opts });
    this.renderCount = 0;
    this.cleanupCount = 0;
    this.listenerCount = 0;
  }

  async _renderContent() {
    this.renderCount++;
    this.bodyEl.innerHTML = '<div class="test-content">Hello</div>';
  }

  _setupEventListeners() {
    this.listenerCount++;
  }

  _cleanup() {
    this.cleanupCount++;
  }
}

describe('BaseModal', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    // Clean up any modals from DOM
    document.querySelectorAll('.modal-overlay').forEach(el => el.remove());
    jest.useRealTimers();
  });

  describe('Bug: close→reopen race condition', () => {
    it('_cleanup does NOT fire if modal was reopened within 300ms', async () => {
      const modal = new TestModal();

      // Open
      await modal.open();
      expect(modal.isOpen).toBe(true);
      expect(modal.renderCount).toBe(1);

      // Close — starts 300ms timer
      modal.close();
      expect(modal.isOpen).toBe(false);

      // Reopen within 300ms
      await modal.open();
      expect(modal.isOpen).toBe(true);
      expect(modal.renderCount).toBe(2);
      expect(modal.listenerCount).toBe(2);

      // Advance past the 300ms timer
      jest.advanceTimersByTime(350);

      // _cleanup should NOT have fired — the guard `if (this.isOpen) return` prevents it
      expect(modal.cleanupCount).toBe(0);
    });

    it('_cleanup DOES fire for normal close (no reopen)', async () => {
      const modal = new TestModal();

      await modal.open();
      modal.close();

      // Advance past 300ms
      jest.advanceTimersByTime(350);

      expect(modal.cleanupCount).toBe(1);
    });

    it('listeners survive close→reopen cycle', async () => {
      const modal = new TestModal();

      await modal.open();
      expect(modal.listenerCount).toBe(1);

      modal.close();
      await modal.open();
      expect(modal.listenerCount).toBe(2);

      // After timer fires, listeners should still be intact (not cleared by _cleanup)
      jest.advanceTimersByTime(350);
      // listenerCount unchanged — _cleanup did not run
      expect(modal.listenerCount).toBe(2);
    });

    it('ACTIVE_MODAL not nulled when modal is reopened', async () => {
      const modal = new TestModal();

      await modal.open();
      modal.close();
      await modal.open();

      jest.advanceTimersByTime(350);

      // Verify single-modal enforcement still works by opening a second modal
      const modal2 = new TestModal({ id: 'test-modal-2' });
      await modal2.open();

      // modal2 opening should have closed modal (single-modal enforcement)
      // This only works if ACTIVE_MODAL was correctly set to modal, not null
      expect(modal.isOpen).toBe(false);
      expect(modal2.isOpen).toBe(true);
    });
  });

  describe('lifecycle basics', () => {
    it('open sets isOpen and appends overlay', async () => {
      const modal = new TestModal();
      await modal.open();
      expect(modal.isOpen).toBe(true);
      expect(modal.overlay.classList.contains('hidden')).toBe(false);
    });

    it('close sets isOpen false immediately', async () => {
      const modal = new TestModal();
      await modal.open();
      modal.close();
      expect(modal.isOpen).toBe(false);
    });

    it('double open is no-op', async () => {
      const modal = new TestModal();
      await modal.open();
      await modal.open();
      expect(modal.renderCount).toBe(1);
    });

    it('double close is no-op', async () => {
      const modal = new TestModal();
      await modal.open();
      modal.close();
      modal.close();
      jest.advanceTimersByTime(350);
      expect(modal.cleanupCount).toBe(1);
    });

    it('destroy removes overlay from DOM', async () => {
      const modal = new TestModal();
      await modal.open();
      const overlayId = modal.overlay.id;
      modal.destroy();
      expect(document.getElementById(overlayId)).toBeNull();
    });

    it('ESC key closes modal', async () => {
      const modal = new TestModal();
      await modal.open();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(modal.isOpen).toBe(false);
    });

    it('backdrop click closes modal', async () => {
      const modal = new TestModal();
      await modal.open();
      // Click on overlay (not panel)
      modal.overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(modal.isOpen).toBe(false);
    });

    it('single modal enforcement: opening B closes A', async () => {
      const a = new TestModal({ id: 'modal-a' });
      const b = new TestModal({ id: 'modal-b' });
      await a.open();
      await b.open();
      expect(a.isOpen).toBe(false);
      expect(b.isOpen).toBe(true);
    });
  });
});
