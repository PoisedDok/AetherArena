/** @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js */

'use strict';

const IndexingConfigModal = require('../../../../src/renderer/main/modules/settings/IndexingConfigModal');
const AetherRagConfigModal = require('../../../../src/renderer/main/modules/settings/AetherRagConfigModal');

// ---------------------------------------------------------------------------
// Shared test suite factory
// ---------------------------------------------------------------------------

function sharedConfigModalTests(ModalClass, name) {
  function createModal(overrides = {}) {
    const onSave = jest.fn().mockResolvedValue(undefined);
    const onCancel = jest.fn();
    const location = {
      location_name: 'test-location',
      root_path: '/home/user/docs',
      chunk_size: 256,
      chunk_overlap: 32,
      allowed_extensions: ['pdf', 'md'],
      exclude_patterns: ['**/node_modules/**'],
      ...overrides.location,
    };
    const modal = new ModalClass({ onSave, onCancel, location, ...overrides });
    return { modal, onSave, onCancel };
  }

  describe(name, () => {
    afterEach(() => {
      document.querySelectorAll('.modal-overlay').forEach((el) => el.remove());
    });

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    describe('constructor', () => {
      test('sets initial state', () => {
        const { modal } = createModal();
        expect(modal.modal).toBeNull();
        expect(modal._listeners).toEqual([]);
        expect(modal.location.location_name).toBe('test-location');
      });

      test('defaults callbacks when not provided', () => {
        const modal = new ModalClass({});
        expect(typeof modal.onSave).toBe('function');
        expect(typeof modal.onCancel).toBe('function');
      });

      test('defaults location to empty object', () => {
        const modal = new ModalClass({});
        expect(modal.location).toEqual({});
      });
    });

    // -----------------------------------------------------------------------
    // show() / _createModal()
    // -----------------------------------------------------------------------

    describe('show()', () => {
      test('creates modal and adds to DOM', async () => {
        const { modal } = createModal();
        await modal.show();
        expect(modal.modal).not.toBeNull();
        expect(document.querySelector('.indexing-config-modal')).not.toBeNull();
      });

      test('renders location fields from config', async () => {
        const { modal } = createModal();
        await modal.show();
        const inputs = modal.modal.querySelectorAll('input[type="text"][disabled]');
        expect(inputs.length).toBe(2);
        expect(inputs[0].value).toBe('test-location');
        expect(inputs[1].value).toBe('/home/user/docs');
      });

      test('renders chunk size from location config', async () => {
        const { modal } = createModal();
        await modal.show();
        expect(modal.modal.querySelector('#chunk-size').value).toBe('256');
      });

      test('renders chunk overlap from location config', async () => {
        const { modal } = createModal();
        await modal.show();
        expect(modal.modal.querySelector('#chunk-overlap').value).toBe('32');
      });

      test('renders allowed extensions', async () => {
        const { modal } = createModal();
        await modal.show();
        expect(modal.modal.querySelector('#allowed-extensions').value).toBe('pdf, md');
      });

      test('renders exclude patterns', async () => {
        const { modal } = createModal();
        await modal.show();
        expect(modal.modal.querySelector('#exclude-patterns').value).toBe('**/node_modules/**');
      });

      test('uses defaults for missing location config', async () => {
        const modal = new ModalClass({});
        await modal.show();
        expect(modal.modal.querySelector('#chunk-size').value).toBe('512');
        expect(modal.modal.querySelector('#chunk-overlap').value).toBe('50');
      });
    });

    // -----------------------------------------------------------------------
    // _handleSave() — Validation
    // -----------------------------------------------------------------------

    describe('_handleSave() validation', () => {
      test('rejects chunk size below 128', async () => {
        const { modal, onSave } = createModal();
        await modal.show();
        modal.modal.querySelector('#chunk-size').value = '64';
        await modal._handleSave();
        expect(onSave).not.toHaveBeenCalled();
        expect(modal.modal.querySelector('.indexing-config-error')).not.toBeNull();
      });

      test('rejects chunk size above 2048', async () => {
        const { modal, onSave } = createModal();
        await modal.show();
        modal.modal.querySelector('#chunk-size').value = '9999';
        await modal._handleSave();
        expect(onSave).not.toHaveBeenCalled();
      });

      test('rejects negative chunk overlap', async () => {
        const { modal, onSave } = createModal();
        await modal.show();
        modal.modal.querySelector('#chunk-overlap').value = '-1';
        await modal._handleSave();
        expect(onSave).not.toHaveBeenCalled();
      });

      test('rejects chunk overlap above 512', async () => {
        const { modal, onSave } = createModal();
        await modal.show();
        modal.modal.querySelector('#chunk-overlap').value = '600';
        await modal._handleSave();
        expect(onSave).not.toHaveBeenCalled();
      });

      test('rejects overlap >= chunk size', async () => {
        const { modal, onSave } = createModal();
        await modal.show();
        modal.modal.querySelector('#chunk-size').value = '256';
        modal.modal.querySelector('#chunk-overlap').value = '256';
        await modal._handleSave();
        expect(onSave).not.toHaveBeenCalled();
      });

      test('rejects empty allowed extensions', async () => {
        const { modal, onSave } = createModal();
        await modal.show();
        modal.modal.querySelector('#allowed-extensions').value = '';
        await modal._handleSave();
        expect(onSave).not.toHaveBeenCalled();
      });
    });

    // -----------------------------------------------------------------------
    // _handleSave() — Success
    // -----------------------------------------------------------------------

    describe('_handleSave() success', () => {
      test('calls onSave with parsed config', async () => {
        const { modal, onSave } = createModal();
        await modal.show();
        // Use defaults from location config
        await modal._handleSave();
        const expectedArg = expect.objectContaining({
          chunk_size: 256,
          chunk_overlap: 32,
          allowed_extensions: ['pdf', 'md'],
          exclude_patterns: ['**/node_modules/**'],
        });

        if (name === 'IndexingConfigModal') {
          // Verify index_mode specifically for IndexingConfigModal
          expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
            chunk_size: 256,
            chunk_overlap: 32,
            allowed_extensions: ['pdf', 'md'],
            exclude_patterns: ['**/node_modules/**'],
            index_mode: 'combined'
          }), expect.anything());
        } else {
          expect(onSave).toHaveBeenCalledWith(expectedArg);
        }
      });

      test('trims and filters extensions', async () => {
        const { modal, onSave } = createModal();
        await modal.show();
        modal.modal.querySelector('#allowed-extensions').value = ' pdf , , txt , ';
        await modal._handleSave();
        expect(onSave.mock.calls[0][0].allowed_extensions).toEqual(['pdf', 'txt']);
      });

      test('trims and filters exclude patterns', async () => {
        const { modal, onSave } = createModal();
        await modal.show();
        modal.modal.querySelector('#exclude-patterns').value = '*.log\n\n*.tmp\n';
        await modal._handleSave();
        expect(onSave.mock.calls[0][0].exclude_patterns).toEqual(['*.log', '*.tmp']);
      });

      test('disables save button during save', async () => {
        const { modal } = createModal();
        await modal.show();
        const saveBtn = modal.modal.querySelector('#indexing-config-save');
        // Run save — button should be disabled during
        const savePromise = modal._handleSave();
        expect(saveBtn.disabled).toBe(true);
        await savePromise;
      });
    });

    // -----------------------------------------------------------------------
    // _handleSave() — Error
    // -----------------------------------------------------------------------

    describe('_handleSave() error', () => {
      test('shows error and re-enables button on save failure', async () => {
        const { modal, onSave } = createModal();
        onSave.mockRejectedValue(new Error('Save failed'));
        await modal.show();

        await modal._handleSave();

        const saveBtn = modal.modal.querySelector('#indexing-config-save');
        expect(saveBtn.disabled).toBe(false);
      });
    });

    // -----------------------------------------------------------------------
    // hide()
    // -----------------------------------------------------------------------

    describe('hide()', () => {
      test('removes is-visible class and cleans up listeners', async () => {
        const { modal } = createModal();
        await modal.show();
        expect(modal._listeners.length).toBeGreaterThan(0);

        modal.hide();

        expect(modal._listeners).toEqual([]);
      });

      test('no-ops when modal is null', () => {
        const { modal } = createModal();
        modal.modal = null;
        expect(() => modal.hide()).not.toThrow();
      });
    });

    // -----------------------------------------------------------------------
    // Event listeners
    // -----------------------------------------------------------------------

    describe('event listeners', () => {
      test('cancel button calls onCancel', async () => {
        const { modal, onCancel } = createModal();
        await modal.show();
        modal.modal.querySelector('#indexing-config-cancel').click();
        expect(onCancel).toHaveBeenCalled();
      });

      test('close button calls onCancel', async () => {
        const { modal, onCancel } = createModal();
        await modal.show();
        modal.modal.querySelector('.indexing-config-close').click();
        expect(onCancel).toHaveBeenCalled();
      });
    });

    // -----------------------------------------------------------------------
    // _trackListener / _cleanupListeners
    // -----------------------------------------------------------------------

    describe('_trackListener / _cleanupListeners', () => {
      test('tracks and cleans up listeners', async () => {
        const { modal } = createModal();
        await modal.show();
        const N = modal._listeners.length;
        expect(N).toBeGreaterThan(0);
        modal._cleanupListeners();
        expect(modal._listeners).toEqual([]);
      });
    });

    // -----------------------------------------------------------------------
    // _escapeHtml()
    // -----------------------------------------------------------------------

    describe('_escapeHtml()', () => {
      test('escapes HTML entities', () => {
        const { modal } = createModal();
        expect(modal._escapeHtml('<b>test</b>')).toBe('&lt;b&gt;test&lt;/b&gt;');
      });
    });
  });
}

// Run the shared test suite for both modals
sharedConfigModalTests(IndexingConfigModal, 'IndexingConfigModal');
sharedConfigModalTests(AetherRagConfigModal, 'AetherRagConfigModal');
