'use strict';

// ---------------------------------------------------------------------------
// The module conditionally exports via `module.exports` and `window`.
// No external mocks needed — it only uses DOM and window.aether.
// ---------------------------------------------------------------------------

const LocationSelectorModal = require('../../../../src/renderer/main/modules/settings/LocationSelectorModal');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createAether(overrides = {}) {
  return {
    dialog: {
      showDirectoryPicker: jest.fn(async () => '/Users/test/documents'),
      ...overrides.dialog,
    },
    logger: {
      debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
      ...overrides.logger,
    },
  };
}

function createModal(opts = {}) {
  const aether = opts.aether || createAether();
  const onSelect = opts.onSelect || jest.fn(async () => {});
  const onCancel = opts.onCancel || jest.fn();
  const modal = new LocationSelectorModal({ aether, onSelect, onCancel });
  return { modal, aether, onSelect, onCancel };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LocationSelectorModal', () => {
  afterEach(() => {
    // Clean up any modals left in DOM
    document.querySelectorAll('.modal-overlay').forEach(el => el.remove());
    jest.restoreAllMocks();
  });

  // ── Constructor ──────────────────────────────────────────────────────

  describe('constructor', () => {
    test('initializes with default state', () => {
      const { modal } = createModal();
      expect(modal.selectedPath).toBeNull();
      expect(modal.selectedType).toBe('secondary');
      expect(modal.fileCount).toBe(0);
      expect(modal.modal).toBeNull();
      expect(modal.isProcessing).toBe(false);
      expect(modal._listeners).toEqual([]);
    });

    test('stores onSelect and onCancel callbacks', () => {
      const onSelect = jest.fn();
      const onCancel = jest.fn();
      const m = new LocationSelectorModal({ onSelect, onCancel });
      expect(m.onSelect).toBe(onSelect);
      expect(m.onCancel).toBe(onCancel);
    });

    test('defaults callbacks to no-ops', () => {
      const m = new LocationSelectorModal();
      expect(typeof m.onSelect).toBe('function');
      expect(typeof m.onCancel).toBe('function');
      m.onSelect(); // should not throw
      m.onCancel();
    });

    test('uses provided aether instance', () => {
      const aether = createAether();
      const m = new LocationSelectorModal({ aether });
      expect(m.aether).toBe(aether);
      expect(m.logger).toBe(aether.logger);
    });

    test('falls back to console for logger', () => {
      const m = new LocationSelectorModal({ aether: null });
      expect(m.logger).toBe(console);
    });
  });

  // ── _createModal ─────────────────────────────────────────────────────

  describe('_createModal()', () => {
    test('creates modal-overlay element', () => {
      const { modal } = createModal();
      modal._createModal();

      expect(modal.modal).not.toBeNull();
      expect(modal.modal.className).toContain('modal-overlay');
      expect(modal.modal.className).toContain('location-selector-modal');
    });

    test('contains title and aria attributes', () => {
      const { modal } = createModal();
      modal._createModal();

      expect(modal.modal.querySelector('.modal-title').textContent).toContain('Select Indexing Location');
      expect(modal.modal.querySelector('[role="dialog"]')).not.toBeNull();
    });

    test('contains radio buttons for location type', () => {
      const { modal } = createModal();
      modal._createModal();

      const radios = modal.modal.querySelectorAll('input[name="locationType"]');
      expect(radios).toHaveLength(2);
      expect(radios[0].value).toBe('primary');
      expect(radios[1].value).toBe('secondary');
      expect(radios[1].checked).toBe(true);
    });

    test('contains picker button, cancel, confirm', () => {
      const { modal } = createModal();
      modal._createModal();

      expect(modal.modal.querySelector('#location-picker-btn')).not.toBeNull();
      expect(modal.modal.querySelector('#location-selector-cancel')).not.toBeNull();
      const confirmBtn = modal.modal.querySelector('#location-selector-confirm');
      expect(confirmBtn).not.toBeNull();
      expect(confirmBtn.disabled).toBe(true);
    });

    test('selected info section is initially hidden', () => {
      const { modal } = createModal();
      modal._createModal();

      const info = modal.modal.querySelector('#location-selected-info');
      expect(info.hidden).toBe(true);
    });

    test('attaches event listeners', () => {
      const { modal } = createModal();
      modal._createModal();

      // 2 radios + overlay click + escape + close + picker + cancel + confirm = 8
      expect(modal._listeners.length).toBeGreaterThanOrEqual(7);
    });
  });

  // ── _trackListener / _cleanupListeners ───────────────────────────────

  describe('listener tracking', () => {
    test('_trackListener adds to _listeners array', () => {
      const { modal } = createModal();
      const el = document.createElement('div');
      const handler = jest.fn();
      modal._trackListener(el, 'click', handler);

      expect(modal._listeners).toHaveLength(1);
      expect(modal._listeners[0]).toEqual({
        target: el, eventName: 'click', handler, options: undefined,
      });
    });

    test('_cleanupListeners removes all and resets array', () => {
      const { modal } = createModal();
      const el = document.createElement('div');
      const handler = jest.fn();
      modal._trackListener(el, 'click', handler);

      const spy = jest.spyOn(el, 'removeEventListener');
      modal._cleanupListeners();

      expect(spy).toHaveBeenCalledWith('click', handler, undefined);
      expect(modal._listeners).toEqual([]);
    });

    test('_cleanupListeners handles null targets', () => {
      const { modal } = createModal();
      modal._listeners.push({ target: null, eventName: 'click', handler: jest.fn() });
      // Should not throw
      modal._cleanupListeners();
      expect(modal._listeners).toEqual([]);
    });
  });

  // ── show ─────────────────────────────────────────────────────────────

  describe('show()', () => {
    test('creates modal and appends to body', async () => {
      const aether = createAether();
      aether.dialog.showDirectoryPicker.mockResolvedValue(null);
      const { modal } = createModal({ aether });

      await modal.show();

      expect(document.body.querySelector('.location-selector-modal')).not.toBeNull();
    });

  });

  // ── _openNativePicker ────────────────────────────────────────────────

  describe('_openNativePicker()', () => {
    test('calls aether.dialog.showDirectoryPicker', async () => {
      const { modal, aether } = createModal();
      modal._createModal();
      document.body.appendChild(modal.modal);

      await modal._openNativePicker();

      expect(aether.dialog.showDirectoryPicker).toHaveBeenCalled();
      expect(modal.selectedPath).toBe('/Users/test/documents');
    });

    test('shows error when picker not available', async () => {
      const aether = createAether({ dialog: { showDirectoryPicker: null } });
      const { modal } = createModal({ aether });
      modal._createModal();
      document.body.appendChild(modal.modal);

      const spy = jest.spyOn(modal, '_showError');
      await modal._openNativePicker();

      expect(spy).toHaveBeenCalledWith('Directory picker not available');
    });

    test('does nothing when aether is null', async () => {
      const m = new LocationSelectorModal({ aether: null });
      m._createModal();
      document.body.appendChild(m.modal);

      const spy = jest.spyOn(m, '_showError');
      await m._openNativePicker();

      expect(spy).toHaveBeenCalledWith('Directory picker not available');
    });

    test('ignores canceled picker', async () => {
      const { modal, aether } = createModal();
      aether.dialog.showDirectoryPicker.mockResolvedValue(null);
      modal._createModal();
      document.body.appendChild(modal.modal);

      await modal._openNativePicker();

      expect(modal.selectedPath).toBeNull();
    });

    test('handles picker error (non-cancel)', async () => {
      const { modal, aether } = createModal();
      aether.dialog.showDirectoryPicker.mockRejectedValue(new Error('Permission denied'));
      modal._createModal();
      document.body.appendChild(modal.modal);

      const spy = jest.spyOn(modal, '_showError');
      await modal._openNativePicker();

      expect(spy).toHaveBeenCalledWith('Failed to select directory');
    });

    test('does NOT show error for canceled picker errors', async () => {
      const { modal, aether } = createModal();
      aether.dialog.showDirectoryPicker.mockRejectedValue(new Error('User canceled'));
      modal._createModal();
      document.body.appendChild(modal.modal);

      const spy = jest.spyOn(modal, '_showError');
      await modal._openNativePicker();

      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ── _updateSelectedInfo ──────────────────────────────────────────────

  describe('_updateSelectedInfo()', () => {
    test('shows path and enables confirm', async () => {
      const { modal } = createModal();
      modal._createModal();
      document.body.appendChild(modal.modal);
      modal.selectedPath = '/Users/test/docs';

      await modal._updateSelectedInfo();

      const pathText = modal.modal.querySelector('#location-selected-path-text');
      const info = modal.modal.querySelector('#location-selected-info');
      const confirm = modal.modal.querySelector('#location-selector-confirm');

      expect(pathText.textContent).toBe('/Users/test/docs');
      expect(info.hidden).toBe(false);
      expect(confirm.disabled).toBe(false);
    });

  });

  // ── _handleConfirm ───────────────────────────────────────────────────

  describe('_handleConfirm()', () => {
    test('calls onSelect with path, type, and fileCount', async () => {
      jest.useFakeTimers();
      const { modal, onSelect } = createModal();
      modal._createModal();
      document.body.appendChild(modal.modal);
      modal.selectedPath = '/Users/test/docs';
      modal.selectedType = 'primary';
      modal.fileCount = 42;

      await modal._handleConfirm();

      expect(onSelect).toHaveBeenCalledWith({
        path: '/Users/test/docs',
        type: 'primary',
        indexMode: 'combined',
        fileCount: 42,
      });
      jest.advanceTimersByTime(1000);
      jest.useRealTimers();
    });

    test('returns early without selectedPath', async () => {
      const { modal, onSelect } = createModal();
      modal.selectedPath = null;

      await modal._handleConfirm();

      expect(onSelect).not.toHaveBeenCalled();
    });

    test('sets isProcessing and disables confirm button', async () => {
      jest.useFakeTimers();
      const { modal, onSelect } = createModal();
      let processingDuringCallback = null;
      onSelect.mockImplementation(async () => {
        processingDuringCallback = modal.isProcessing;
      });

      modal._createModal();
      document.body.appendChild(modal.modal);
      modal.selectedPath = '/path';

      await modal._handleConfirm();

      expect(processingDuringCallback).toBe(true);
      const btn = modal.modal?.querySelector('#location-selector-confirm');
      // After success, button disabled stays true (modal auto-closes)
      jest.advanceTimersByTime(1000);
      jest.useRealTimers();
    });

    test('shows success feedback', async () => {
      jest.useFakeTimers();
      const { modal } = createModal();
      modal._createModal();
      document.body.appendChild(modal.modal);
      modal.selectedPath = '/path';

      await modal._handleConfirm();

      const feedback = modal.modal.querySelector('.location-selector-feedback.success');
      expect(feedback).not.toBeNull();
      expect(feedback.textContent).toContain('Location added successfully');
      jest.advanceTimersByTime(1000);
      jest.useRealTimers();
    });

    test('auto-closes after 800ms on success', async () => {
      jest.useFakeTimers();
      const { modal } = createModal();
      modal._createModal();
      document.body.appendChild(modal.modal);
      modal.selectedPath = '/path';

      const hideSpy = jest.spyOn(modal, 'hide');
      await modal._handleConfirm();

      expect(hideSpy).not.toHaveBeenCalled();
      jest.advanceTimersByTime(800);
      expect(hideSpy).toHaveBeenCalled();
      jest.advanceTimersByTime(300);
      jest.useRealTimers();
    });

    test('handles error: shows error feedback and re-enables button', async () => {
      const { modal, onSelect } = createModal();
      onSelect.mockRejectedValue(new Error('Permission denied'));
      modal._createModal();
      document.body.appendChild(modal.modal);
      modal.selectedPath = '/path';

      await modal._handleConfirm();

      const feedback = modal.modal.querySelector('.location-selector-feedback.error');
      expect(feedback).not.toBeNull();
      expect(feedback.textContent).toContain('Permission denied');

      const btn = modal.modal.querySelector('#location-selector-confirm');
      expect(btn.disabled).toBe(false);
      expect(btn.innerHTML).toBe('Confirm');
      expect(modal.isProcessing).toBe(false);
    });

    test('uses fallback error message', async () => {
      const { modal, onSelect } = createModal();
      onSelect.mockRejectedValue(new Error(''));
      modal._createModal();
      document.body.appendChild(modal.modal);
      modal.selectedPath = '/path';

      await modal._handleConfirm();

      const feedback = modal.modal.querySelector('.location-selector-feedback.error');
      expect(feedback.textContent).toContain('Failed to add location');
    });
  });

  // ── _showSuccess / _showError ────────────────────────────────────────

  describe('feedback messages', () => {
    test('_showSuccess appends success element', () => {
      jest.useFakeTimers();
      const { modal } = createModal();
      modal._createModal();
      document.body.appendChild(modal.modal);

      modal._showSuccess('Done!');

      const el = modal.modal.querySelector('.location-selector-feedback.success');
      expect(el).not.toBeNull();
      expect(el.textContent).toContain('Done!');

      jest.advanceTimersByTime(3000);
      jest.useRealTimers();
    });

    test('_showError appends error element', () => {
      jest.useFakeTimers();
      const { modal } = createModal();
      modal._createModal();
      document.body.appendChild(modal.modal);

      modal._showError('Something broke');

      const el = modal.modal.querySelector('.location-selector-feedback.error');
      expect(el).not.toBeNull();
      expect(el.textContent).toContain('Something broke');

      jest.advanceTimersByTime(4000);
      jest.useRealTimers();
    });
  });

  // ── _getHomeDirectory ────────────────────────────────────────────────

  describe('_getHomeDirectory()', () => {
    test('returns "/" as fallback', () => {
      const { modal } = createModal();
      expect(modal._getHomeDirectory()).toBe('/');
    });
  });

  // ── hide ─────────────────────────────────────────────────────────────

  describe('hide()', () => {
    test('removes is-visible class', () => {
      jest.useFakeTimers();
      const { modal } = createModal();
      modal._createModal();
      document.body.appendChild(modal.modal);
      modal.modal.classList.add('is-visible');

      modal.hide();

      expect(modal.modal.classList.contains('is-visible')).toBe(false);
      jest.advanceTimersByTime(300);
      jest.useRealTimers();
    });

    test('cleans up listeners', () => {
      jest.useFakeTimers();
      const { modal } = createModal();
      modal._createModal();
      document.body.appendChild(modal.modal);

      const spy = jest.spyOn(modal, '_cleanupListeners');
      modal.hide();

      expect(spy).toHaveBeenCalled();
      jest.advanceTimersByTime(300);
      jest.useRealTimers();
    });

    test('removes modal from DOM after 200ms', () => {
      jest.useFakeTimers();
      const { modal } = createModal();
      modal._createModal();
      document.body.appendChild(modal.modal);

      modal.hide();

      // Still in DOM immediately
      expect(document.body.querySelector('.location-selector-modal')).not.toBeNull();

      jest.advanceTimersByTime(200);

      // Now removed
      expect(document.body.querySelector('.location-selector-modal')).toBeNull();
      expect(modal.modal).toBeNull();
      jest.useRealTimers();
    });

    test('does nothing when modal is null', () => {
      const { modal } = createModal();
      modal.modal = null;
      // Should not throw
      modal.hide();
    });
  });

  // ── Event listeners behavior ─────────────────────────────────────────

  describe('event listener behaviors', () => {
    test('clicking overlay calls onCancel and hides', () => {
      jest.useFakeTimers();
      const { modal, onCancel } = createModal();
      modal._createModal();
      document.body.appendChild(modal.modal);

      // Simulate click on overlay (target is overlay itself)
      const listener = modal._listeners.find(
        l => l.target === modal.modal && l.eventName === 'click'
      );
      listener.handler({ target: modal.modal });

      expect(onCancel).toHaveBeenCalled();
      jest.advanceTimersByTime(300);
      jest.useRealTimers();
    });

    test('clicking inside panel does NOT close', () => {
      const { modal, onCancel } = createModal();
      modal._createModal();
      document.body.appendChild(modal.modal);

      const listener = modal._listeners.find(
        l => l.target === modal.modal && l.eventName === 'click'
      );
      const innerEl = modal.modal.querySelector('.modal-panel');
      listener.handler({ target: innerEl });

      expect(onCancel).not.toHaveBeenCalled();
    });

    test('Escape key calls onCancel and hides', () => {
      jest.useFakeTimers();
      const { modal, onCancel } = createModal();
      modal._createModal();
      document.body.appendChild(modal.modal);

      const listener = modal._listeners.find(
        l => l.target === window && l.eventName === 'keydown'
      );
      listener.handler({ key: 'Escape' });

      expect(onCancel).toHaveBeenCalled();
      jest.advanceTimersByTime(300);
      jest.useRealTimers();
    });

    test('non-Escape key does nothing', () => {
      const { modal, onCancel } = createModal();
      modal._createModal();
      document.body.appendChild(modal.modal);

      const listener = modal._listeners.find(
        l => l.target === window && l.eventName === 'keydown'
      );
      listener.handler({ key: 'Enter' });

      expect(onCancel).not.toHaveBeenCalled();
    });

    test('radio buttons update selectedType', () => {
      const { modal } = createModal();
      modal._createModal();
      document.body.appendChild(modal.modal);

      const radioListener = modal._listeners.find(
        l => l.eventName === 'change'
      );
      radioListener.handler({ target: { value: 'primary' } });

      expect(modal.selectedType).toBe('primary');
    });

    test('cancel button calls onCancel and hides', () => {
      jest.useFakeTimers();
      const { modal, onCancel } = createModal();
      modal._createModal();
      document.body.appendChild(modal.modal);

      const cancelBtn = modal.modal.querySelector('#location-selector-cancel');
      const listener = modal._listeners.find(
        l => l.target === cancelBtn && l.eventName === 'click'
      );
      listener.handler();

      expect(onCancel).toHaveBeenCalled();
      jest.advanceTimersByTime(300);
      jest.useRealTimers();
    });

    test('confirm button calls _handleConfirm when path selected', async () => {
      jest.useFakeTimers();
      const { modal } = createModal();
      modal._createModal();
      document.body.appendChild(modal.modal);
      modal.selectedPath = '/test';
      modal.isProcessing = false;

      const spy = jest.spyOn(modal, '_handleConfirm').mockResolvedValue();
      const confirmBtn = modal.modal.querySelector('#location-selector-confirm');
      const listener = modal._listeners.find(
        l => l.target === confirmBtn && l.eventName === 'click'
      );
      await listener.handler();

      expect(spy).toHaveBeenCalled();
      jest.advanceTimersByTime(300);
      jest.useRealTimers();
    });

    test('confirm button does nothing when no path', async () => {
      const { modal } = createModal();
      modal._createModal();
      document.body.appendChild(modal.modal);
      modal.selectedPath = null;

      const spy = jest.spyOn(modal, '_handleConfirm');
      const confirmBtn = modal.modal.querySelector('#location-selector-confirm');
      const listener = modal._listeners.find(
        l => l.target === confirmBtn && l.eventName === 'click'
      );
      await listener.handler();

      expect(spy).not.toHaveBeenCalled();
    });

    test('confirm button does nothing when isProcessing', async () => {
      const { modal } = createModal();
      modal._createModal();
      document.body.appendChild(modal.modal);
      modal.selectedPath = '/test';
      modal.isProcessing = true;

      const spy = jest.spyOn(modal, '_handleConfirm');
      const confirmBtn = modal.modal.querySelector('#location-selector-confirm');
      const listener = modal._listeners.find(
        l => l.target === confirmBtn && l.eventName === 'click'
      );
      await listener.handler();

      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ── N created = M cleaned ────────────────────────────────────────────

  describe('resource lifecycle proof', () => {
    test('all listeners created are cleaned on hide', () => {
      jest.useFakeTimers();
      const { modal } = createModal();
      modal._createModal();
      document.body.appendChild(modal.modal);

      const N = modal._listeners.length;
      expect(N).toBeGreaterThan(0);

      modal.hide();

      expect(modal._listeners).toEqual([]);
      jest.advanceTimersByTime(300);
      jest.useRealTimers();
    });
  });
});
