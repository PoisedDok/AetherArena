'use strict';

// ---------------------------------------------------------------------------
// Mocks — must be before require
// ---------------------------------------------------------------------------

jest.mock(
  '../../../../src/renderer/shared/components/Toast',
  () => ({ warning: jest.fn(), success: jest.fn(), error: jest.fn() })
);

jest.mock(
  '../../../../src/renderer/shared/utils/logger',
  () => ({
    createRendererLogger: jest.fn(() => ({
      debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    })),
  })
);

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock confirm
global.confirm = jest.fn(() => true);

const Toast = require('../../../../src/renderer/shared/components/Toast');

// The module exports a singleton instance, not the class.
const instance = require('../../../../src/renderer/main/modules/settings/UserCredentialsSettings');
const UserCredentialsSettings = instance.constructor;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetInstance(inst) {
  inst._credentials = [];
  inst._isLoading = false;
  inst._containerEl = null;
  inst._isInitialized = false;
  inst._isDisposed = false;
  inst._listeners = [];
  inst._abortControllers = [];
}

function makeFetchResponse(data, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(data),
  });
}

function mockCredentialsList() {
  return [
    { credential_key: 'openai_api_key', is_configured: true, description: 'OpenAI API key' },
    { credential_key: 'anthropic_api_key', is_configured: false, description: 'Anthropic key' },
    { credential_key: 'google_oauth_token', is_configured: true, description: 'Google OAuth' },
    { credential_key: 'weather_api_key', is_configured: false, description: 'Weather API' },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UserCredentialsSettings', () => {
  let container;

  beforeEach(() => {
    resetInstance(instance);
    mockFetch.mockReset();
    Toast.warning.mockClear();
    Toast.success.mockClear();
    Toast.error.mockClear();
    global.confirm.mockReturnValue(true);
    delete window.AETHER_CONFIG;

    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container?.remove();
    jest.restoreAllMocks();
  });

  // ── Constructor ──────────────────────────────────────────────────────

  describe('constructor', () => {
    test('initializes with empty state', () => {
      const fresh = new UserCredentialsSettings();
      expect(fresh._credentials).toEqual([]);
      expect(fresh._isLoading).toBe(false);
      expect(fresh._containerEl).toBeNull();
      expect(fresh._isInitialized).toBe(false);
      expect(fresh._isDisposed).toBe(false);
      expect(fresh._listeners).toEqual([]);
      expect(fresh._abortControllers).toEqual([]);
    });

    test('creates logger instance', () => {
      const fresh = new UserCredentialsSettings();
      expect(fresh.log).toBeDefined();
      expect(typeof fresh.log.debug).toBe('function');
    });
  });

  // ── initialize ───────────────────────────────────────────────────────

  describe('initialize()', () => {
    test('loads credentials and renders UI', async () => {
      instance._apiClient = { get: jest.fn().mockResolvedValue({ credentials: mockCredentialsList() }) };
      await instance.initialize(container);

      expect(instance._isInitialized).toBe(true);
      expect(instance._containerEl).toBe(container);
      expect(container.className).toBe('user-credentials-wrapper');
      expect(instance._credentials).toHaveLength(4);
    });

    test('renders category sections in DOM', async () => {
      instance._apiClient = { get: jest.fn().mockResolvedValue({ credentials: mockCredentialsList() }) };
      await instance.initialize(container);

      const categories = container.querySelectorAll('.credential-category');
      expect(categories.length).toBeGreaterThan(0);

      const titles = Array.from(container.querySelectorAll('.category-title')).map(el => el.textContent);
      expect(titles).toContain('LLM Providers');
    });

    test('guards against double initialization', async () => {
      instance._apiClient = { get: jest.fn().mockResolvedValue({ credentials: [] }) };
      await instance.initialize(container);

      const callCount = instance._apiClient.get.mock.calls.length;
      await instance.initialize(container);

      expect(instance._apiClient.get.mock.calls.length).toBe(callCount);
    });

    test('guards against initialization after dispose', async () => {
      instance._isDisposed = true;
      await instance.initialize(container);
      expect(instance._isInitialized).toBe(false);
    });

    test('throws without container', async () => {
      await expect(instance.initialize(null)).rejects.toThrow('Container element is required');
    });

    test('shows error toast on init failure', async () => {
      instance._apiClient = { get: jest.fn().mockRejectedValue(new Error('Network fail')) };
      await instance.initialize(container);

      expect(Toast.error).toHaveBeenCalledWith('Failed to load credentials');
      expect(instance._isInitialized).toBe(false);
    });
  });

  // ── loadCredentials ──────────────────────────────────────────────────

  describe('loadCredentials()', () => {
    test('fetches from /v1/user-credentials/list', async () => {
      instance._apiClient = { get: jest.fn().mockResolvedValue({ credentials: [] }) };
      await instance.loadCredentials();

      expect(instance._apiClient.get).toHaveBeenCalledWith(
        '/v1/user-credentials/list',
        expect.any(Object)
      );
    });

    test('uses AbortController signal', async () => {
      instance._apiClient = { get: jest.fn().mockResolvedValue({ credentials: [] }) };
      await instance.loadCredentials();

      const callArgs = instance._apiClient.get.mock.calls[0][1];
      expect(callArgs.signal).toBeDefined();
      expect(instance._abortControllers.length).toBeGreaterThan(0);
    });

    test('stores credentials from response', async () => {
      const creds = mockCredentialsList();
      instance._apiClient = { get: jest.fn().mockResolvedValue({ credentials: creds }) };
      await instance.loadCredentials();

      expect(instance._credentials).toEqual(creds);
    });

    test('defaults credentials to empty array when missing', async () => {
      instance._apiClient = { get: jest.fn().mockResolvedValue({}) };
      await instance.loadCredentials();

      expect(instance._credentials).toEqual([]);
    });

    test('guards against concurrent loads', async () => {
      instance._apiClient = { get: jest.fn().mockResolvedValue({ credentials: [] }) };
      instance._isLoading = true;
      await instance.loadCredentials();
      expect(instance._apiClient.get).not.toHaveBeenCalled();
    });

    test('resets isLoading flag on success', async () => {
      instance._apiClient = { get: jest.fn().mockResolvedValue({ credentials: [] }) };
      await instance.loadCredentials();
      expect(instance._isLoading).toBe(false);
    });

    test('resets isLoading flag on error', async () => {
      instance._apiClient = { get: jest.fn().mockRejectedValue(new Error('fail')) };
      await expect(instance.loadCredentials()).rejects.toThrow('fail');
      expect(instance._isLoading).toBe(false);
    });

    test('silently returns on AbortError', async () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      instance._apiClient = { get: jest.fn().mockRejectedValue(abortError) };

      // Should not throw
      await instance.loadCredentials();
      expect(instance._isLoading).toBe(false);
    });
  });

  // ── _renderCredentialsUI ─────────────────────────────────────────────

  describe('_renderCredentialsUI()', () => {
    test('does nothing without container', () => {
      instance._containerEl = null;
      instance._renderCredentialsUI(); // Should not throw
    });

    test('cleans up listeners before re-rendering', () => {
      instance._containerEl = container;
      const spy = jest.spyOn(instance, '_cleanupListeners');
      instance._renderCredentialsUI();
      expect(spy).toHaveBeenCalled();
    });

    test('renders credential cards for matching categories', () => {
      instance._containerEl = container;
      instance._credentials = mockCredentialsList();
      instance._renderCredentialsUI();

      const cards = container.querySelectorAll('.credential-card');
      expect(cards.length).toBe(4);
    });

    test('shows configured badge for configured credentials', () => {
      instance._containerEl = container;
      instance._credentials = [
        { credential_key: 'openai_api_key', is_configured: true, description: 'Key' },
      ];
      instance._renderCredentialsUI();

      expect(container.querySelector('.badge-success')).not.toBeNull();
      expect(container.textContent).toContain('Configured');
    });

    test('shows "Not Set" badge for unconfigured credentials', () => {
      instance._containerEl = container;
      instance._credentials = [
        { credential_key: 'openai_api_key', is_configured: false, description: 'Key' },
      ];
      instance._renderCredentialsUI();

      expect(container.querySelector('.badge-info')).not.toBeNull();
      expect(container.textContent).toContain('Not Set');
    });

    test('shows delete button only for configured credentials', () => {
      instance._containerEl = container;
      instance._credentials = [
        { credential_key: 'openai_api_key', is_configured: true, description: 'A' },
        { credential_key: 'anthropic_api_key', is_configured: false, description: 'B' },
      ];
      instance._renderCredentialsUI();

      const delBtns = container.querySelectorAll('.btn-delete');
      expect(delBtns).toHaveLength(1);
      expect(delBtns[0].dataset.key).toBe('openai_api_key');
    });

    test('attaches click listeners to set/delete buttons', () => {
      instance._containerEl = container;
      instance._credentials = [
        { credential_key: 'openai_api_key', is_configured: true, description: 'A' },
      ];
      instance._renderCredentialsUI();

      // Two listeners: one for set, one for delete
      expect(instance._listeners).toHaveLength(2);
      expect(instance._listeners[0].event).toBe('click');
      expect(instance._listeners[1].event).toBe('click');
    });

    test('skips categories with no matching credentials', () => {
      instance._containerEl = container;
      instance._credentials = [
        { credential_key: 'openai_api_key', is_configured: true, description: 'A' },
      ];
      instance._renderCredentialsUI();

      const titles = Array.from(container.querySelectorAll('.category-title')).map(el => el.textContent);
      expect(titles).toEqual(['LLM Providers']);
      expect(titles).not.toContain('Email & Calendar');
      expect(titles).not.toContain('Other Services');
    });
  });

  // ── _createCredentialCard ────────────────────────────────────────────

  describe('_createCredentialCard()', () => {
    test('creates card with formatted name', () => {
      const card = instance._createCredentialCard({
        credential_key: 'openai_api_key',
        is_configured: false,
        description: 'Your key',
      });

      expect(card.className).toContain('credential-card');
      expect(card.textContent).toContain('Openai Api Key');
    });

    test('adds "configured" class when is_configured', () => {
      const card = instance._createCredentialCard({
        credential_key: 'test_key',
        is_configured: true,
      });

      expect(card.className).toContain('configured');
    });

    test('shows "Update" for configured, "Set" for unconfigured', () => {
      const configuredCard = instance._createCredentialCard({
        credential_key: 'test_key', is_configured: true,
      });
      expect(configuredCard.querySelector('.btn-set').textContent.trim()).toBe('Update');

      const unconfiguredCard = instance._createCredentialCard({
        credential_key: 'test_key', is_configured: false,
      });
      expect(unconfiguredCard.querySelector('.btn-set').textContent.trim()).toBe('Set');
    });

    test('uses fallback description when none provided', () => {
      const card = instance._createCredentialCard({
        credential_key: 'test_key', is_configured: false,
      });
      expect(card.textContent).toContain('Secure encrypted storage.');
    });

    test('escapes HTML in credential description and rendered name', () => {
      const card = instance._createCredentialCard({
        credential_key: 'test_<img',
        is_configured: false,
        description: '<img src=x onerror=alert(1)>',
      });
      expect(card.innerHTML).toContain('&lt;img');
      expect(card.innerHTML).not.toContain('<img src=x');
      expect(card.querySelector('.credential-name').innerHTML).toContain('&lt;img');
    });
  });

  // ── _formatCredentialName ────────────────────────────────────────────

  describe('_formatCredentialName()', () => {
    test('converts snake_case to Title Case', () => {
      expect(instance._formatCredentialName('openai_api_key')).toBe('Openai Api Key');
      expect(instance._formatCredentialName('google_oauth_token')).toBe('Google Oauth Token');
    });

    test('handles single word', () => {
      expect(instance._formatCredentialName('key')).toBe('Key');
    });
  });

  // ── _saveCredential ──────────────────────────────────────────────────

  describe('_saveCredential()', () => {
    test('POSTs to /v1/user-credentials/save', async () => {
      instance._apiClient = { post: jest.fn().mockResolvedValue({ success: true }) };
      await instance._saveCredential('openai_api_key', 'sk-test-123');

      expect(instance._apiClient.post).toHaveBeenCalledWith(
        '/v1/user-credentials/save',
        {
          credential_key: 'openai_api_key',
          credential_value: 'sk-test-123',
        }
      );
    });

    test('shows success toast', async () => {
      instance._apiClient = { post: jest.fn().mockResolvedValue({}) };
      await instance._saveCredential('key', 'val');
      expect(Toast.success).toHaveBeenCalledWith('Credential encrypted and saved');
    });

    test('throws on error response', async () => {
      instance._apiClient = { post: jest.fn().mockRejectedValue(new Error('Save failed')) };
      await expect(instance._saveCredential('key', 'val')).rejects.toThrow('Save failed');
    });
  });

  // ── _deleteCredential ────────────────────────────────────────────────

  describe('_deleteCredential()', () => {
    test('sends DELETE request after confirmation', async () => {
      instance._apiClient = { 
        delete: jest.fn().mockResolvedValue({}),
        get: jest.fn().mockResolvedValue({ credentials: [] })
      };
      instance._containerEl = container;

      await instance._deleteCredential('openai_api_key');

      expect(global.confirm).toHaveBeenCalled();
      expect(instance._apiClient.delete).toHaveBeenCalledWith(
        '/v1/user-credentials/openai_api_key'
      );
      expect(Toast.success).toHaveBeenCalledWith('Credential removed');
    });

    test('cancels when user declines confirm dialog', async () => {
      global.confirm.mockReturnValue(false);
      instance._apiClient = { delete: jest.fn() };
      await instance._deleteCredential('openai_api_key');
      expect(instance._apiClient.delete).not.toHaveBeenCalled();
    });

    test('shows error toast on failure', async () => {
      instance._apiClient = { delete: jest.fn().mockRejectedValue(new Error('Failed to delete')) };
      instance._containerEl = container;

      await instance._deleteCredential('key');

      expect(Toast.error).toHaveBeenCalledWith('Failed to delete');
    });
  });

  // ── _showCredentialModal ─────────────────────────────────────────────

  describe('_showCredentialModal()', () => {
    test('creates modal overlay in document.body', () => {
      instance._showCredentialModal({
        credential_key: 'openai_api_key',
        is_configured: false,
        description: 'Test description',
      });

      const modal = document.body.querySelector('.modal-overlay');
      expect(modal).not.toBeNull();
      expect(modal.textContent).toContain('Configure Openai Api Key');
      expect(modal.textContent).toContain('Test description');

      // Cleanup
      modal.remove();
    });

    test('uses "Token" input type for token credentials', () => {
      instance._showCredentialModal({
        credential_key: 'google_oauth_token',
        is_configured: false,
      });

      const modal = document.body.querySelector('.modal-overlay');
      expect(modal.textContent).toContain('Token');
      modal.remove();
    });

    test('uses "API Key" input type for non-token credentials', () => {
      instance._showCredentialModal({
        credential_key: 'openai_api_key',
        is_configured: false,
      });

      const modal = document.body.querySelector('.modal-overlay');
      expect(modal.textContent).toContain('API Key');
      modal.remove();
    });

    test('escapes HTML in modal title and description', () => {
      instance._showCredentialModal({
        credential_key: 'openai_<img',
        is_configured: false,
        description: '<script>alert(1)</script>',
      });

      const modal = document.body.querySelector('.modal-overlay');
      expect(modal.innerHTML).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(modal.innerHTML).not.toContain('<script>alert(1)</script>');
      expect(modal.querySelector('.modal-title').innerHTML).toContain('&lt;img');
      modal.remove();
    });

    test('cancel button hides modal', () => {
      jest.useFakeTimers();
      instance._showCredentialModal({
        credential_key: 'test_key', is_configured: false,
      });

      const modal = document.body.querySelector('.modal-overlay');
      const cancelBtn = modal.querySelector('#btn-modal-cancel');
      cancelBtn.click();

      expect(modal.classList.contains('hidden')).toBe(true);
      jest.advanceTimersByTime(300);
      jest.useRealTimers();
    });

    test('close button hides modal', () => {
      jest.useFakeTimers();
      instance._showCredentialModal({
        credential_key: 'test_key', is_configured: false,
      });

      const modal = document.body.querySelector('.modal-overlay');
      const closeBtn = modal.querySelector('#btn-modal-close');
      closeBtn.click();

      expect(modal.classList.contains('hidden')).toBe(true);
      jest.advanceTimersByTime(300);
      jest.useRealTimers();
    });

    test('clicking overlay background closes modal', () => {
      jest.useFakeTimers();
      instance._showCredentialModal({
        credential_key: 'test_key', is_configured: false,
      });

      const modal = document.body.querySelector('.modal-overlay');
      // Simulate click on overlay (not on inner modal)
      modal.onclick({ target: modal });

      expect(modal.classList.contains('hidden')).toBe(true);
      jest.advanceTimersByTime(300);
      jest.useRealTimers();
    });

    test('save button warns when input is empty', async () => {
      instance._showCredentialModal({
        credential_key: 'test_key', is_configured: false,
      });

      const modal = document.body.querySelector('.modal-overlay');
      const saveBtn = modal.querySelector('#btn-modal-save');
      const input = modal.querySelector('#credential-input');
      input.value = '';

      await saveBtn.onclick();

      expect(Toast.warning).toHaveBeenCalledWith('Value is required');
      modal.remove();
    });

    test('save button calls _saveCredential and reloads', async () => {
      instance._apiClient = {
        post: jest.fn().mockResolvedValue({}),
        get: jest.fn().mockResolvedValue({ credentials: [] })
      };
      instance._containerEl = container;

      jest.useFakeTimers();
      instance._showCredentialModal({
        credential_key: 'openai_api_key', is_configured: false,
      });

      const modal = document.body.querySelector('.modal-overlay');
      const saveBtn = modal.querySelector('#btn-modal-save');
      const input = modal.querySelector('#credential-input');
      input.value = 'sk-test-key';

      await saveBtn.onclick();

      expect(instance._apiClient.post).toHaveBeenCalledWith(
        '/v1/user-credentials/save',
        expect.objectContaining({ credential_key: 'openai_api_key', credential_value: 'sk-test-key' })
      );
      expect(Toast.success).toHaveBeenCalledWith('Credential encrypted and saved');

      jest.advanceTimersByTime(300);
      jest.useRealTimers();
    });

    test('save button shows "Saving..." during save', async () => {
      let resolveSave;
      instance._apiClient = { post: jest.fn().mockReturnValue(new Promise((resolve) => { resolveSave = resolve; })) };

      instance._showCredentialModal({
        credential_key: 'test_key', is_configured: false,
      });

      const modal = document.body.querySelector('.modal-overlay');
      const saveBtn = modal.querySelector('#btn-modal-save');
      const input = modal.querySelector('#credential-input');
      input.value = 'test-value';

      const savePromise = saveBtn.onclick();
      expect(saveBtn.disabled).toBe(true);
      expect(saveBtn.textContent).toBe('Saving...');

      resolveSave({ ok: false, status: 500 }); // Trigger error path
      await savePromise;

      // On error, button re-enables but text becomes "Save" (not original)
      expect(saveBtn.disabled).toBe(false);
      modal.remove();
    });

    test('Enter key triggers save', async () => {
      instance._showCredentialModal({
        credential_key: 'test_key', is_configured: false,
      });

      const modal = document.body.querySelector('.modal-overlay');
      const input = modal.querySelector('#credential-input');
      const saveBtn = modal.querySelector('#btn-modal-save');
      const clickSpy = jest.spyOn(saveBtn, 'click');

      input.onkeydown({ key: 'Enter' });
      expect(clickSpy).toHaveBeenCalled();

      modal.remove();
    });

    test('Escape key closes modal', () => {
      jest.useFakeTimers();
      instance._showCredentialModal({
        credential_key: 'test_key', is_configured: false,
      });

      const modal = document.body.querySelector('.modal-overlay');
      const input = modal.querySelector('#credential-input');
      input.onkeydown({ key: 'Escape' });

      expect(modal.classList.contains('hidden')).toBe(true);
      jest.advanceTimersByTime(300);
      jest.useRealTimers();
    });
  });

  // ── _cleanupListeners ────────────────────────────────────────────────

  describe('_cleanupListeners()', () => {
    test('removes all tracked listeners', () => {
      const el = document.createElement('button');
      const handler = jest.fn();
      el.addEventListener('click', handler);
      instance._listeners.push({ element: el, event: 'click', handler });

      const spy = jest.spyOn(el, 'removeEventListener');
      instance._cleanupListeners();

      expect(spy).toHaveBeenCalledWith('click', handler);
      expect(instance._listeners).toEqual([]);
    });

    test('handles null elements gracefully', () => {
      instance._listeners.push({ element: null, event: 'click', handler: jest.fn() });
      // Should not throw
      instance._cleanupListeners();
      expect(instance._listeners).toEqual([]);
    });
  });

  // ── dispose ──────────────────────────────────────────────────────────

  describe('dispose()', () => {
    test('cleans up listeners', () => {
      const spy = jest.spyOn(instance, '_cleanupListeners');
      instance.dispose();
      expect(spy).toHaveBeenCalled();
    });

    test('aborts all pending requests', () => {
      const ac1 = new AbortController();
      const ac2 = new AbortController();
      instance._abortControllers = [ac1, ac2];
      const spy1 = jest.spyOn(ac1, 'abort');
      const spy2 = jest.spyOn(ac2, 'abort');

      instance.dispose();

      expect(spy1).toHaveBeenCalled();
      expect(spy2).toHaveBeenCalled();
    });

    test('nulls container reference', () => {
      instance._containerEl = container;
      instance.dispose();
      expect(instance._containerEl).toBeNull();
    });

    test('sets _isDisposed flag', () => {
      instance.dispose();
      expect(instance._isDisposed).toBe(true);
    });

    test('guards against double dispose', () => {
      instance._isDisposed = true;
      const spy = jest.spyOn(instance, '_cleanupListeners');
      instance.dispose();
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ── N created = M cleaned (lifecycle proof) ──────────────────────────

  describe('resource lifecycle proof', () => {
    test('N listeners created = N listeners cleaned', async () => {
      instance._apiClient = {
        get: jest.fn().mockResolvedValue({
          credentials: [
            { credential_key: 'openai_api_key', is_configured: true, description: 'A' },
            { credential_key: 'anthropic_api_key', is_configured: false, description: 'B' },
          ],
        })
      };

      await instance.initialize(container);

      // openai: set + delete = 2 listeners, anthropic: set only = 1 listener
      const created = instance._listeners.length;
      expect(created).toBe(3);

      instance.dispose();
      // After dispose, listeners array is emptied
      expect(instance._listeners).toEqual([]);
    });
  });
});
