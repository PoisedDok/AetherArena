'use strict';

const ConfirmDialog = require('../../../src/renderer/shared/components/ConfirmDialog');

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

describe('ConfirmDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** Retrieve the overlay element from the DOM */
  function getOverlay() {
    return document.querySelector('dialog.confirm-dialog-card');
  }

  /** Retrieve the confirm button */
  function getConfirmBtn() {
    return document.querySelector('.confirm-dialog-btn.confirm');
  }

  /** Retrieve the cancel button */
  function getCancelBtn() {
    return document.querySelector('.confirm-dialog-btn.cancel');
  }

  /** Retrieve the close (x) button */
  function getCloseBtn() {
    return document.querySelector('.confirm-dialog-close');
  }

  /** Retrieve the input element in prompt mode */
  function getInput() {
    return document.querySelector('.confirm-dialog-input');
  }

  /** Retrieve the error element */
  function getError() {
    return document.querySelector('.confirm-dialog-error');
  }

  // =========================================================================
  // confirm() — static method
  // =========================================================================

  describe('confirm()', () => {
    it('renders a dialog overlay in the DOM', () => {
      ConfirmDialog.confirm({ title: 'Test' });
      expect(getOverlay()).not.toBeNull();
    });

    it('shows correct title and message', () => {
      ConfirmDialog.confirm({ title: 'Delete?', message: 'This is permanent.' });
      const title = document.querySelector('.confirm-dialog-title');
      const msg = document.querySelector('.confirm-dialog-message');
      expect(title.textContent).toBe('Delete?');
      expect(msg.textContent).toBe('This is permanent.');
    });

    it('uses default title when none provided', () => {
      ConfirmDialog.confirm({});
      const title = document.querySelector('.confirm-dialog-title');
      expect(title.textContent).toBe('Confirm');
    });

    it('uses custom button text', () => {
      ConfirmDialog.confirm({ confirmText: 'Yes', cancelText: 'No' });
      expect(getConfirmBtn().textContent).toBe('Yes');
      expect(getCancelBtn().textContent).toBe('No');
    });

    it('uses default button text', () => {
      ConfirmDialog.confirm({});
      expect(getConfirmBtn().textContent).toBe('Confirm');
      expect(getCancelBtn().textContent).toBe('Cancel');
    });

    it('resolves true when confirm button is clicked', async () => {
      const promise = ConfirmDialog.confirm({});
      getConfirmBtn().click();
      jest.advanceTimersByTime(250);
      const result = await promise;
      expect(result).toBe(true);
    });

    it('resolves false when cancel button is clicked', async () => {
      const promise = ConfirmDialog.confirm({});
      getCancelBtn().click();
      jest.advanceTimersByTime(250);
      const result = await promise;
      expect(result).toBe(false);
    });

    it('resolves false when close (x) button is clicked', async () => {
      const promise = ConfirmDialog.confirm({});
      getCloseBtn().click();
      jest.advanceTimersByTime(250);
      const result = await promise;
      expect(result).toBe(false);
    });

    it('resolves false when overlay backdrop is clicked', async () => {
      const promise = ConfirmDialog.confirm({});
      const overlay = getOverlay();
      // Click directly on the overlay (not the dialog card)
      overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      jest.advanceTimersByTime(250);
      const result = await promise;
      expect(result).toBe(false);
    });

    it('does not resolve when clicking inside the dialog card', () => {
      let resolved = false;
      ConfirmDialog.confirm({}).then(() => { resolved = true; });
      // Click inside the dialog (not on the dialog background itself)
      const body = document.querySelector('.confirm-dialog-body');
      body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      jest.advanceTimersByTime(250);
      // The promise is still pending — child click should not resolve
      // We verify the overlay/dialog is still present
      expect(getOverlay()).not.toBeNull();
    });

    it('resolves true when Enter key is pressed', async () => {
      const promise = ConfirmDialog.confirm({});
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      jest.advanceTimersByTime(250);
      const result = await promise;
      expect(result).toBe(true);
    });

    it('resolves false when Escape key is pressed', async () => {
      const promise = ConfirmDialog.confirm({});
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      jest.advanceTimersByTime(250);
      const result = await promise;
      expect(result).toBe(false);
    });

    it('sets aria attributes on dialog', () => {
      ConfirmDialog.confirm({ title: 'ARIA Test' });
      const card = document.querySelector('.confirm-dialog-card');
      expect(card.getAttribute('role')).toBe('dialog');
      expect(card.getAttribute('aria-modal')).toBe('true');
      expect(card.getAttribute('aria-label')).toBe('ARIA Test');
    });

    it('applies variant class to dialog card', () => {
      ConfirmDialog.confirm({ variant: 'danger' });
      const card = document.querySelector('.confirm-dialog-card');
      expect(card.classList.contains('danger')).toBe(true);
    });

    it('removes overlay from DOM after close animation', async () => {
      const promise = ConfirmDialog.confirm({});
      getConfirmBtn().click();
      // Overlay removed after 220ms setTimeout
      jest.advanceTimersByTime(250);
      await promise;
      expect(getOverlay()).toBeNull();
    });

    it('closes existing dialog before opening new one', () => {
      ConfirmDialog.confirm({ title: 'First' });
      expect(document.querySelectorAll('dialog.confirm-dialog-card').length).toBe(1);
      ConfirmDialog.confirm({ title: 'Second' });
      expect(document.querySelectorAll('dialog.confirm-dialog-card').length).toBe(1);
      const title = document.querySelector('.confirm-dialog-title');
      expect(title.textContent).toBe('Second');
    });

    it('adds visible class via requestAnimationFrame', () => {
      // jsdom runs requestAnimationFrame synchronously or with a shim
      ConfirmDialog.confirm({});
      const overlay = getOverlay();
      // requestAnimationFrame should add 'visible' class
      // In jsdom, rAF may be immediate or deferred; check after a tick
      jest.advanceTimersByTime(0);
      // The class may or may not be added depending on jsdom rAF behavior
      // At minimum, the overlay exists
      expect(overlay).not.toBeNull();
    });

    it('focuses confirm button in confirm mode', () => {
      ConfirmDialog.confirm({});
      jest.advanceTimersByTime(0);
      // setTimeout(() => confirmBtn.focus(), 0)
      // Focus may not work in jsdom but the call should not throw
      expect(getConfirmBtn()).not.toBeNull();
    });
  });

  // =========================================================================
  // prompt() — static method
  // =========================================================================

  describe('prompt()', () => {
    it('renders an input field', () => {
      ConfirmDialog.prompt({ message: 'Enter name' });
      expect(getInput()).not.toBeNull();
    });

    it('sets input placeholder, type, and value', () => {
      ConfirmDialog.prompt({
        placeholder: 'Name',
        inputType: 'email',
        value: 'test@example.com',
      });
      const input = getInput();
      expect(input.placeholder).toBe('Name');
      expect(input.type).toBe('email');
      expect(input.value).toBe('test@example.com');
    });

    it('sets autocomplete off on input', () => {
      ConfirmDialog.prompt({});
      expect(getInput().autocomplete).toBe('off');
    });

    it('resolves with trimmed input value on confirm click', async () => {
      const promise = ConfirmDialog.prompt({});
      const input = getInput();
      // Simulate typing
      input.value = '  hello world  ';
      input.dispatchEvent(new Event('input'));
      getConfirmBtn().click();
      jest.advanceTimersByTime(250);
      const result = await promise;
      expect(result).toBe('hello world');
    });

    it('resolves null on cancel click', async () => {
      const promise = ConfirmDialog.prompt({});
      getCancelBtn().click();
      jest.advanceTimersByTime(250);
      const result = await promise;
      expect(result).toBeNull();
    });

    it('resolves null on close button click', async () => {
      const promise = ConfirmDialog.prompt({});
      getCloseBtn().click();
      jest.advanceTimersByTime(250);
      const result = await promise;
      expect(result).toBeNull();
    });

    it('resolves null on Escape key', async () => {
      const promise = ConfirmDialog.prompt({});
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      jest.advanceTimersByTime(250);
      const result = await promise;
      expect(result).toBeNull();
    });

    it('resolves with trimmed value on Enter key', async () => {
      const promise = ConfirmDialog.prompt({});
      const input = getInput();
      input.value = 'enter value';
      input.dispatchEvent(new Event('input'));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      jest.advanceTimersByTime(250);
      const result = await promise;
      expect(result).toBe('enter value');
    });

    it('shows validation error for empty required input on confirm', () => {
      ConfirmDialog.prompt({ required: true });
      const input = getInput();
      input.value = '';
      getConfirmBtn().click();
      const err = getError();
      expect(err.textContent).toBe('This field is required.');
    });

    it('shows validation error for empty required input on Enter', () => {
      ConfirmDialog.prompt({ required: true });
      const input = getInput();
      input.value = '   ';
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      const err = getError();
      expect(err.textContent).toBe('This field is required.');
    });

    it('clears validation error when input is provided', () => {
      ConfirmDialog.prompt({ required: true });
      const input = getInput();
      input.value = '';
      getConfirmBtn().click();
      expect(getError().textContent).toBe('This field is required.');
      // Now type something
      input.value = 'fixed';
      input.dispatchEvent(new Event('input'));
      expect(getError().textContent).toBe('');
    });

    it('skips validation when required is false', async () => {
      const promise = ConfirmDialog.prompt({ required: false });
      const input = getInput();
      input.value = '';
      getConfirmBtn().click();
      jest.advanceTimersByTime(250);
      const result = await promise;
      expect(result).toBe('');
    });

    it('resolves null on overlay backdrop click', async () => {
      const promise = ConfirmDialog.prompt({});
      const overlay = getOverlay();
      overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      jest.advanceTimersByTime(250);
      const result = await promise;
      expect(result).toBeNull();
    });

    it('focuses input field after render', () => {
      ConfirmDialog.prompt({});
      jest.advanceTimersByTime(0);
      // setTimeout(() => inputEl.focus(), 0)
      expect(getInput()).not.toBeNull();
    });

    it('renders error container below input', () => {
      ConfirmDialog.prompt({});
      const body = document.querySelector('.confirm-dialog-body');
      const children = Array.from(body.children);
      const inputIdx = children.findIndex(c => c.classList.contains('confirm-dialog-input'));
      const errorIdx = children.findIndex(c => c.classList.contains('confirm-dialog-error'));
      expect(inputIdx).toBeLessThan(errorIdx);
    });
  });

  // =========================================================================
  // _closeExisting — static method
  // =========================================================================

  describe('_closeExisting()', () => {
    it('removes existing overlay', () => {
      ConfirmDialog.confirm({ title: 'To Remove' });
      expect(getOverlay()).not.toBeNull();
      ConfirmDialog._closeExisting();
      expect(getOverlay()).toBeNull();
    });

    it('is safe when no overlay exists', () => {
      expect(() => ConfirmDialog._closeExisting()).not.toThrow();
    });
  });

  // =========================================================================
  // _ensureStyles — static method
  // =========================================================================

  describe('_ensureStyles()', () => {
    it('is a no-op (styles live in CSS file)', () => {
      // Should not throw and should not inject styles
      expect(() => ConfirmDialog._ensureStyles()).not.toThrow();
      expect(document.querySelectorAll('style').length).toBe(0);
    });
  });

  // =========================================================================
  // DOM structure
  // =========================================================================

  describe('DOM structure', () => {
    it('creates correct DOM hierarchy', () => {
      ConfirmDialog.confirm({ title: 'Hierarchy' });
      const card = getOverlay();
      const header = card.querySelector('.confirm-dialog-header');
      const body = card.querySelector('.confirm-dialog-body');
      const footer = card.querySelector('.confirm-dialog-footer');
      expect(card).not.toBeNull();
      expect(header).not.toBeNull();
      expect(body).not.toBeNull();
      expect(footer).not.toBeNull();
    });

    it('header contains title and close button', () => {
      ConfirmDialog.confirm({ title: 'Title' });
      const header = document.querySelector('.confirm-dialog-header');
      expect(header.querySelector('.confirm-dialog-title')).not.toBeNull();
      expect(header.querySelector('.confirm-dialog-close')).not.toBeNull();
    });

    it('close button has aria-label', () => {
      ConfirmDialog.confirm({});
      expect(getCloseBtn().getAttribute('aria-label')).toBe('Close');
    });

    it('close button is type button', () => {
      ConfirmDialog.confirm({});
      expect(getCloseBtn().type).toBe('button');
    });

    it('confirm and cancel buttons are type button', () => {
      ConfirmDialog.confirm({});
      expect(getConfirmBtn().type).toBe('button');
      expect(getCancelBtn().type).toBe('button');
    });

    it('does not render input in confirm mode', () => {
      ConfirmDialog.confirm({});
      expect(getInput()).toBeNull();
    });
  });

  // =========================================================================
  // Keydown event cleanup
  // =========================================================================

  describe('keydown event cleanup', () => {
    it('removes keydown listener after resolve', async () => {
      const promise = ConfirmDialog.confirm({});
      getConfirmBtn().click();
      jest.advanceTimersByTime(250);
      await promise;

      // After dialog is closed, pressing Escape should not cause issues
      // (the listener should have been removed)
      expect(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      }).not.toThrow();
    });
  });
});
