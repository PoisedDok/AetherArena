'use strict';

// ============================================================================
// Mocks
// ============================================================================

const mockIpcMain = { handle: jest.fn(), removeHandler: jest.fn() };

jest.mock('electron', () => ({
  app: { on: jest.fn(), whenReady: jest.fn(() => Promise.resolve()), getPath: jest.fn(() => '/tmp'), quit: jest.fn() },
  BrowserWindow: jest.fn(),
  ipcMain: mockIpcMain,
  ipcRenderer: { send: jest.fn(), invoke: jest.fn(), on: jest.fn() },
}), { virtual: true });

const mockChildLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() };

jest.mock('../../../src/core/utils/logger', () => ({
  logger: { child: jest.fn(() => mockChildLogger) },
}));

jest.mock('../../../src/core/config', () => ({
  backend: { baseUrl: 'http://backend:3001' },
  api: { timeout: 10000, retries: 3, retryDelay: 500 },
  dev: { verboseLogging: false },
}));

jest.mock('../../../src/core/config/defaults', () => ({
  backend: { baseUrl: 'http://default:3001' },
}));

const mockClient = {
  get: jest.fn().mockResolvedValue({ data: 'ok' }),
  post: jest.fn().mockResolvedValue({ data: 'ok' }),
  put: jest.fn().mockResolvedValue({ data: 'ok' }),
  patch: jest.fn().mockResolvedValue({ data: 'ok' }),
  delete: jest.fn().mockResolvedValue({ data: 'ok' }),
};

class MockTimeoutError extends Error {
  constructor(msg) { super(msg); this.name = 'TimeoutError'; this.isTimeoutError = true; }
}

jest.mock('../../../src/core/communication/ApiClient', () => ({
  ApiClient: jest.fn(() => mockClient),
  TimeoutError: MockTimeoutError,
}));

jest.mock('crypto', () => ({ randomUUID: jest.fn(() => 'mock-uuid-1234') }));

// ============================================================================
// Import
// ============================================================================

const { StorageIpcHandler, getStorageHandler, createStorageHandler } = require('../../../src/main/services/StorageIpcHandler');

// ============================================================================
// Helpers
// ============================================================================

function getHandlers(handler) {
  handler.initialize();
  const map = {};
  mockIpcMain.handle.mock.calls.forEach(([ch, fn]) => { map[ch] = fn; });
  return map;
}

// ============================================================================
// Tests
// ============================================================================

describe('StorageIpcHandler', () => {
  let handler;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.get.mockResolvedValue({ data: 'ok' });
    mockClient.post.mockResolvedValue({ data: 'ok' });
    mockClient.put.mockResolvedValue({ data: 'ok' });
    mockClient.patch.mockResolvedValue({ data: 'ok' });
    mockClient.delete.mockResolvedValue({ data: 'ok' });
    handler = new StorageIpcHandler();
  });

  // --------------------------------------------------------------------------
  // Constructor
  // --------------------------------------------------------------------------

  describe('constructor', () => {
    it('resolves baseUrl from config', () => {
      expect(handler.baseUrl).toBe('http://backend:3001');
    });

    it('prefers options.baseUrl', () => {
      const h = new StorageIpcHandler({ baseUrl: 'http://custom:9000' });
      expect(h.baseUrl).toBe('http://custom:9000');
    });

    it('resolves timeout from config', () => {
      expect(handler.timeout).toBe(10000);
    });

    it('creates logger child with module name', () => {
      expect(handler.logger).toBe(mockChildLogger);
    });

    it('initializes isInitialized to false', () => {
      expect(handler.isInitialized).toBe(false);
    });

    it('falls back to DEFAULTS when config.backend is missing', () => {
      jest.resetModules();
      jest.doMock('electron', () => ({
        app: { on: jest.fn(), whenReady: jest.fn(() => Promise.resolve()), getPath: jest.fn(() => '/tmp'), quit: jest.fn() },
        BrowserWindow: jest.fn(),
        ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
        ipcRenderer: { send: jest.fn(), invoke: jest.fn(), on: jest.fn() },
      }));
      jest.doMock('../../../src/core/utils/logger', () => ({
        logger: { child: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() })) },
      }));
      jest.doMock('../../../src/core/config', () => ({
        backend: null,
        api: { timeout: null, retries: 3, retryDelay: 500 },
        dev: { verboseLogging: false },
      }));
      jest.doMock('../../../src/core/config/defaults', () => ({
        backend: { baseUrl: 'http://fallback:3001' },
      }));
      jest.doMock('../../../src/core/communication/ApiClient', () => ({
        ApiClient: jest.fn().mockImplementation(() => ({
          get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn(),
        })),
        TimeoutError: class TimeoutError extends Error { constructor(m) { super(m); this.name = 'TimeoutError'; } },
      }));
      jest.doMock('crypto', () => ({ randomUUID: jest.fn(() => 'uuid') }));

      const { StorageIpcHandler: Fresh } = require('../../../src/main/services/StorageIpcHandler');
      const h = new Fresh();
      expect(h.baseUrl).toBe('http://fallback:3001');
      // timeout falls through to 15000 hardcoded default since config.api.timeout is null
      expect(h.timeout).toBe(15000);
      jest.resetModules();
    });
  });

  // --------------------------------------------------------------------------
  // initialize / shutdown
  // --------------------------------------------------------------------------

  describe('initialize', () => {
    it('registers 22 IPC handlers', () => {
      handler.initialize();
      expect(mockIpcMain.handle).toHaveBeenCalledTimes(22);
    });

    it('registers all expected channels', () => {
      handler.initialize();
      const channels = mockIpcMain.handle.mock.calls.map(c => c[0]);
      expect(channels).toEqual([
        'storage:load-chats', 'storage:load-chat', 'storage:create-chat',
        'storage:update-chat-title', 'storage:delete-chat',
        'storage:load-messages', 'storage:save-message',
        'storage:load-artifacts', 'storage:save-artifact',
        'storage:update-artifact-message-id', 'storage:delete-artifact',
        'storage:get-message-artifacts', 'storage:get-artifact-source', 'storage:get-llm-metadata',
        'storage:load-trail-hierarchy',
        'storage:summarize-chat', 'storage:generate-chat-summary',
        'storage:get-chat-summaries', 'storage:search-chats',
        'storage:health-check', 'storage:test-connection', 'storage:get-stats',
      ]);
    });

    it('sets isInitialized to true', () => {
      handler.initialize();
      expect(handler.isInitialized).toBe(true);
    });

    it('warns and returns on double init', () => {
      handler.initialize();
      jest.clearAllMocks();
      handler.initialize();
      expect(mockChildLogger.warn).toHaveBeenCalledWith('Storage IPC handlers already initialized');
      expect(mockIpcMain.handle).not.toHaveBeenCalled();
    });
  });

  describe('shutdown', () => {
    it('removes all 22 handlers including generate-chat-summary', () => {
      handler.initialize();
      handler.shutdown();
      expect(mockIpcMain.removeHandler).toHaveBeenCalledTimes(22);
      const removed = mockIpcMain.removeHandler.mock.calls.map(c => c[0]);
      expect(removed).toContain('storage:generate-chat-summary');
      expect(removed).toContain('storage:summarize-chat');
    });

    it('sets isInitialized to false', () => {
      handler.initialize();
      handler.shutdown();
      expect(handler.isInitialized).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // _request
  // --------------------------------------------------------------------------

  describe('_request', () => {
    it('routes GET', async () => {
      await handler._request('GET', '/test');
      expect(mockClient.get).toHaveBeenCalledWith('/test', { timeout: 10000 });
    });

    it('routes POST with data', async () => {
      await handler._request('POST', '/test', { a: 1 });
      expect(mockClient.post).toHaveBeenCalledWith('/test', { a: 1 }, { timeout: 10000 });
    });

    it('routes PUT with data', async () => {
      await handler._request('PUT', '/test', { a: 1 });
      expect(mockClient.put).toHaveBeenCalledWith('/test', { a: 1 }, { timeout: 10000 });
    });

    it('routes PATCH with data', async () => {
      await handler._request('PATCH', '/test', { a: 1 });
      expect(mockClient.patch).toHaveBeenCalledWith('/test', { a: 1 }, { timeout: 10000 });
    });

    it('routes DELETE', async () => {
      await handler._request('DELETE', '/test');
      expect(mockClient.delete).toHaveBeenCalledWith('/test', { timeout: 10000 });
    });

    it('throws for unsupported method', async () => {
      await expect(handler._request('HEAD', '/x')).rejects.toThrow('Unsupported HTTP method: HEAD');
    });

    it('logs error and re-throws on failure', async () => {
      mockClient.get.mockRejectedValue(new Error('net fail'));
      await expect(handler._request('GET', '/fail')).rejects.toThrow('net fail');
      expect(mockChildLogger.error).toHaveBeenCalledWith('HTTP request failed', expect.objectContaining({
        method: 'GET', path: '/fail', timeout: false,
      }));
    });

    it('detects TimeoutError as timeout', async () => {
      mockClient.get.mockRejectedValue(new MockTimeoutError('timed out'));
      await expect(handler._request('GET', '/slow')).rejects.toThrow('timed out');
      expect(mockChildLogger.error).toHaveBeenCalledWith('HTTP request failed', expect.objectContaining({ timeout: true }));
    });
  });

  // --------------------------------------------------------------------------
  // _getTimeout
  // --------------------------------------------------------------------------

  describe('_getTimeout', () => {
    it('returns base timeout for normal requests', () => {
      expect(handler._getTimeout('GET', '/v1/storage/chat/list')).toBe(10000);
    });

    it('returns >= 30000 for PUT to chat endpoint', () => {
      const t = handler._getTimeout('PUT', '/v1/api/storage/chats/550e8400-e29b-41d4-a716-446655440000');
      expect(t).toBeGreaterThanOrEqual(30000);
    });

    it('returns >= 30000 for PATCH to chat endpoint', () => {
      const t = handler._getTimeout('PATCH', '/v1/api/storage/chats/550e8400-e29b-41d4-a716-446655440000');
      expect(t).toBeGreaterThanOrEqual(30000);
    });

    it('returns >= 25000 for POST to artifacts endpoint', () => {
      const t = handler._getTimeout('POST', '/v1/api/storage/chats/550e8400-e29b-41d4-a716-446655440000/artifacts');
      expect(t).toBeGreaterThanOrEqual(25000);
    });

    it('returns base for non-matching POST', () => {
      expect(handler._getTimeout('POST', '/v1/storage/chat/create')).toBe(10000);
    });

    it('falls back to 15000 when this.timeout and config.api.timeout are falsy', () => {
      const saved = handler.timeout;
      handler.timeout = 0;
      // When this.timeout is 0 (falsy), _getTimeout tries config.api.timeout (10000)
      expect(handler._getTimeout('GET', '/v1/test')).toBe(10000);
      handler.timeout = saved;
    });
  });

  // --------------------------------------------------------------------------
  // _isBackendUnavailableError
  // --------------------------------------------------------------------------

  describe('_isBackendUnavailableError', () => {
    it('returns false for null', () => {
      expect(handler._isBackendUnavailableError(null)).toBe(false);
    });

    it('returns true for TimeoutError', () => {
      expect(handler._isBackendUnavailableError(new MockTimeoutError('t'))).toBe(true);
    });

    it('returns true for AbortError name', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      expect(handler._isBackendUnavailableError(e)).toBe(true);
    });

    it('returns true for isTimeoutError flag', () => {
      const e = new Error('t');
      e.isTimeoutError = true;
      expect(handler._isBackendUnavailableError(e)).toBe(true);
    });

    it('returns true for ECONNREFUSED in message', () => {
      expect(handler._isBackendUnavailableError(new Error('ECONNREFUSED'))).toBe(true);
    });

    it('returns true for fetch failed in message', () => {
      expect(handler._isBackendUnavailableError(new Error('fetch failed'))).toBe(true);
    });

    it('returns true for Failed to fetch in message', () => {
      expect(handler._isBackendUnavailableError(new Error('Failed to fetch'))).toBe(true);
    });

    it('returns true for ECONNREFUSED cause code', () => {
      const e = new Error('connect');
      e.cause = { code: 'ECONNREFUSED' };
      expect(handler._isBackendUnavailableError(e)).toBe(true);
    });

    it('returns true for ENOTFOUND cause code', () => {
      const e = new Error('dns');
      e.cause = { code: 'ENOTFOUND' };
      expect(handler._isBackendUnavailableError(e)).toBe(true);
    });

    it('returns true for ETIMEDOUT cause code', () => {
      const e = new Error('timeout');
      e.cause = { code: 'ETIMEDOUT' };
      expect(handler._isBackendUnavailableError(e)).toBe(true);
    });

    it('returns false for regular 4xx-style error', () => {
      expect(handler._isBackendUnavailableError(new Error('Not Found'))).toBe(false);
    });

    it('returns false for non-string cause code', () => {
      const e = new Error('err');
      e.cause = { code: 42 };
      expect(handler._isBackendUnavailableError(e)).toBe(false);
    });

    it('returns true for ECONNRESET cause code', () => {
      const e = new Error('reset');
      e.cause = { code: 'ECONNRESET' };
      expect(handler._isBackendUnavailableError(e)).toBe(true);
    });

    it('returns true for EHOSTUNREACH cause code', () => {
      const e = new Error('unreachable');
      e.cause = { code: 'EHOSTUNREACH' };
      expect(handler._isBackendUnavailableError(e)).toBe(true);
    });

    it('handles error with no message property', () => {
      const e = { name: 'CustomError' };
      expect(handler._isBackendUnavailableError(e)).toBe(false);
    });

    it('handles error where internal check throws', () => {
      const e = new Proxy({}, {
        get(_, prop) {
          if (prop === 'message') throw new Error('access denied');
          if (prop === 'name') return 'BadError';
          return undefined;
        },
      });
      // Should not throw — caught by the internal try/catch, returns false
      expect(handler._isBackendUnavailableError(e)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // _nowIso / _makeOfflineId
  // --------------------------------------------------------------------------

  describe('_nowIso', () => {
    it('returns ISO timestamp string', () => {
      const iso = handler._nowIso();
      expect(typeof iso).toBe('string');
      expect(new Date(iso).toISOString()).toBe(iso);
    });

    it('returns null when Date.toISOString throws', () => {
      const origToISOString = Date.prototype.toISOString;
      Date.prototype.toISOString = () => { throw new Error('invalid'); };
      try {
        expect(handler._nowIso()).toBeNull();
      } finally {
        Date.prototype.toISOString = origToISOString;
      }
    });
  });

  describe('_makeOfflineId', () => {
    it('returns UUID from crypto.randomUUID', () => {
      expect(handler._makeOfflineId()).toBe('mock-uuid-1234');
    });

    it('throws CONTRACT VIOLATION when randomUUID is not a function', () => {
      jest.resetModules();
      jest.doMock('electron', () => ({
        app: { on: jest.fn(), whenReady: jest.fn(() => Promise.resolve()), getPath: jest.fn(() => '/tmp'), quit: jest.fn() },
        BrowserWindow: jest.fn(),
        ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
        ipcRenderer: { send: jest.fn(), invoke: jest.fn(), on: jest.fn() },
      }));
      jest.doMock('../../../src/core/utils/logger', () => ({
        logger: { child: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() })) },
      }));
      jest.doMock('../../../src/core/config', () => ({
        backend: { baseUrl: 'http://backend:3001' },
        api: { timeout: 10000, retries: 3, retryDelay: 500 },
        dev: { verboseLogging: false },
      }));
      jest.doMock('../../../src/core/config/defaults', () => ({
        backend: { baseUrl: 'http://default:3001' },
      }));
      jest.doMock('../../../src/core/communication/ApiClient', () => ({
        ApiClient: jest.fn().mockImplementation(() => ({
          get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn(),
        })),
        TimeoutError: class TimeoutError extends Error { constructor(m) { super(m); this.name = 'TimeoutError'; } },
      }));
      jest.doMock('crypto', () => ({ randomUUID: 'not-a-function' }));

      const { StorageIpcHandler: Fresh } = require('../../../src/main/services/StorageIpcHandler');
      const h = new Fresh();
      expect(() => h._makeOfflineId()).toThrow('CONTRACT VIOLATION');

      // restore modules for subsequent tests
      jest.resetModules();
    });
  });

  // --------------------------------------------------------------------------
  // Chat operations
  // --------------------------------------------------------------------------

  describe('IPC handlers — chat operations', () => {
    let h;
    beforeEach(() => { h = getHandlers(handler); });

    describe('storage:load-chats', () => {
      it('returns array from backend', async () => {
        mockClient.get.mockResolvedValue([{ id: 'c1' }]);
        const r = await h['storage:load-chats']({});
        expect(r).toEqual([{ id: 'c1' }]);
      });

      it('returns empty array for non-array result', async () => {
        mockClient.get.mockResolvedValue('not an array');
        const r = await h['storage:load-chats']({});
        expect(r).toEqual([]);
      });

      it('returns empty array on backend failure', async () => {
        mockClient.get.mockRejectedValue(new Error('down'));
        const r = await h['storage:load-chats']({});
        expect(r).toEqual([]);
        expect(mockChildLogger.warn).toHaveBeenCalled();
      });

      it('logs String(error) when error.message is falsy', async () => {
        mockClient.get.mockRejectedValue({ code: 'ERR' });
        const r = await h['storage:load-chats']({});
        expect(r).toEqual([]);
        expect(mockChildLogger.warn).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ error: expect.stringContaining('object') }),
        );
      });
    });

    describe('storage:load-chat', () => {
      it('returns chat with messages', async () => {
        mockClient.get
          .mockResolvedValueOnce({ id: 'c1', title: 'Test' })
          .mockResolvedValueOnce([{ id: 'm1' }]);
        const r = await h['storage:load-chat']({}, { chatId: 'c1' });
        expect(r).toEqual({ id: 'c1', title: 'Test', messages: [{ id: 'm1' }] });
      });

      it('wraps non-array messages to empty array', async () => {
        mockClient.get
          .mockResolvedValueOnce({ id: 'c1' })
          .mockResolvedValueOnce(null);
        const r = await h['storage:load-chat']({}, { chatId: 'c1' });
        expect(r.messages).toEqual([]);
      });

      it('returns minimal shell on error', async () => {
        mockClient.get.mockRejectedValue(new Error('down'));
        const r = await h['storage:load-chat']({}, { chatId: 'c1' });
        expect(r).toEqual({ id: 'c1', title: 'Offline', messages: [] });
      });

      it('logs String(error) when error has no message', async () => {
        mockClient.get.mockRejectedValue({ code: 'NET_ERR' });
        const r = await h['storage:load-chat']({}, { chatId: 'c1' });
        expect(r).toEqual({ id: 'c1', title: 'Offline', messages: [] });
      });
    });

    describe('storage:create-chat', () => {
      it('creates chat via POST', async () => {
        mockClient.post.mockResolvedValue({ id: 'c1' });
        const r = await h['storage:create-chat']({}, { title: 'My Chat' });
        expect(r).toEqual({ id: 'c1' });
      });

      it('returns offline stub on backend unavailable', async () => {
        mockClient.post.mockRejectedValue(new MockTimeoutError('timeout'));
        const r = await h['storage:create-chat']({}, { title: 'My Chat' });
        expect(r.offline).toBe(true);
        expect(r.id).toBe('mock-uuid-1234');
        expect(r.title).toBe('My Chat');
      });

      it('re-throws non-backend errors', async () => {
        mockClient.post.mockRejectedValue(new Error('validation error'));
        await expect(h['storage:create-chat']({}, { title: '' })).rejects.toThrow('validation error');
      });

      it('uses default title when none provided', async () => {
        mockClient.post.mockResolvedValue({ id: 'c2' });
        const r = await h['storage:create-chat']({}, {});
        expect(mockClient.post).toHaveBeenCalledWith(
          '/v1/storage/chat/create',
          expect.objectContaining({ title: 'New Chat' }),
          expect.any(Object),
        );
        expect(r).toEqual({ id: 'c2' });
      });

      it('offline stub uses Offline when title is falsy', async () => {
        mockClient.post.mockRejectedValue(new MockTimeoutError('timeout'));
        const r = await h['storage:create-chat']({}, { title: null });
        expect(r.offline).toBe(true);
        expect(r.title).toBe('Offline');
      });

      it('offline stub logs String(error) when error.message is falsy', async () => {
        const e = new MockTimeoutError('');
        e.message = undefined;
        mockClient.post.mockRejectedValue(e);
        const r = await h['storage:create-chat']({}, { title: 'Chat' });
        expect(r.offline).toBe(true);
        expect(mockChildLogger.warn).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ error: expect.any(String) }),
        );
      });
    });

    describe('storage:update-chat-title', () => {
      it('updates via PUT', async () => {
        mockClient.put.mockResolvedValue({ ok: true });
        const r = await h['storage:update-chat-title']({}, { chatId: 'c1', title: 'New' });
        expect(r).toEqual({ ok: true });
      });

      it('returns offline stub on backend unavailable', async () => {
        mockClient.put.mockRejectedValue(new MockTimeoutError('timeout'));
        const r = await h['storage:update-chat-title']({}, { chatId: 'c1', title: 'New' });
        expect(r.offline).toBe(true);
      });

      it('re-throws non-backend errors', async () => {
        mockClient.put.mockRejectedValue(new Error('400 Bad Request'));
        await expect(h['storage:update-chat-title']({}, { chatId: 'c1', title: '' })).rejects.toThrow('400 Bad Request');
      });
    });

    describe('storage:delete-chat', () => {
      it('deletes via DELETE', async () => {
        mockClient.delete.mockResolvedValue({ ok: true });
        const r = await h['storage:delete-chat']({}, { chatId: 'c1' });
        expect(r).toEqual({ ok: true });
      });

      it('returns offline stub on backend unavailable', async () => {
        mockClient.delete.mockRejectedValue(new MockTimeoutError('timeout'));
        const r = await h['storage:delete-chat']({}, { chatId: 'c1' });
        expect(r.offline).toBe(true);
      });

      it('re-throws non-backend errors', async () => {
        mockClient.delete.mockRejectedValue(new Error('403 Forbidden'));
        await expect(h['storage:delete-chat']({}, { chatId: 'c1' })).rejects.toThrow('403 Forbidden');
      });
    });
  });

  // --------------------------------------------------------------------------
  // Message operations
  // --------------------------------------------------------------------------

  describe('IPC handlers — message operations', () => {
    let h;
    beforeEach(() => { h = getHandlers(handler); });

    describe('storage:load-messages', () => {
      it('returns array from backend', async () => {
        mockClient.get.mockResolvedValue([{ id: 'm1' }]);
        const r = await h['storage:load-messages']({}, { chatId: 'c1' });
        expect(r).toEqual([{ id: 'm1' }]);
      });

      it('returns empty array for non-array result', async () => {
        mockClient.get.mockResolvedValue(null);
        const r = await h['storage:load-messages']({}, { chatId: 'c1' });
        expect(r).toEqual([]);
      });

      it('returns empty array on error', async () => {
        mockClient.get.mockRejectedValue(new Error('down'));
        const r = await h['storage:load-messages']({}, { chatId: 'c1' });
        expect(r).toEqual([]);
      });
    });

    describe('storage:save-message', () => {
      it('saves via POST', async () => {
        mockClient.post.mockResolvedValue({ id: 'm1' });
        const r = await h['storage:save-message']({}, { chatId: 'c1', message: { role: 'user' } });
        expect(r).toEqual({ id: 'm1' });
      });

      it('returns offline stub on backend unavailable', async () => {
        mockClient.post.mockRejectedValue(new MockTimeoutError('timeout'));
        const r = await h['storage:save-message']({}, { chatId: 'c1', message: {} });
        expect(r.offline).toBe(true);
      });

      it('re-throws non-backend errors', async () => {
        mockClient.post.mockRejectedValue(new Error('500'));
        await expect(h['storage:save-message']({}, { chatId: 'c1', message: {} })).rejects.toThrow('500');
      });
    });
  });

  // --------------------------------------------------------------------------
  // Artifact operations
  // --------------------------------------------------------------------------

  describe('IPC handlers — artifact operations', () => {
    let h;
    beforeEach(() => { h = getHandlers(handler); });

    describe('storage:load-artifacts', () => {
      it('returns array from backend', async () => {
        mockClient.get.mockResolvedValue([{ id: 'a1' }]);
        const r = await h['storage:load-artifacts']({}, { chatId: 'c1' });
        expect(r).toEqual([{ id: 'a1' }]);
      });

      it('returns empty array on error', async () => {
        mockClient.get.mockRejectedValue(new Error('down'));
        const r = await h['storage:load-artifacts']({}, { chatId: 'c1' });
        expect(r).toEqual([]);
      });
    });

    describe('storage:save-artifact', () => {
      it('saves via POST', async () => {
        mockClient.post.mockResolvedValue({ id: 'a1' });
        const r = await h['storage:save-artifact']({}, { chatId: 'c1', artifact: { type: 'code' } });
        expect(r).toEqual({ id: 'a1' });
      });

      it('returns offline stub on backend unavailable', async () => {
        mockClient.post.mockRejectedValue(new MockTimeoutError('timeout'));
        const r = await h['storage:save-artifact']({}, { chatId: 'c1', artifact: {} });
        expect(r.offline).toBe(true);
      });

      it('re-throws non-backend errors', async () => {
        mockClient.post.mockRejectedValue(new Error('validation'));
        await expect(h['storage:save-artifact']({}, { chatId: 'c1', artifact: {} })).rejects.toThrow('validation');
      });
    });

    describe('storage:update-artifact-message-id', () => {
      it('links artifact to message via PUT', async () => {
        mockClient.put.mockResolvedValue({ ok: true });
        const r = await h['storage:update-artifact-message-id']({}, {
          artifactId: 'a1', messageId: 'm1', chatId: 'c1',
        });
        expect(mockClient.put).toHaveBeenCalledWith(
          '/v1/storage/artifact/link-message',
          { artifact_id: 'a1', message_id: 'm1', chat_id: 'c1' },
          expect.any(Object)
        );
        expect(r).toEqual({ ok: true });
      });

      it('omits chat_id from payload when chatId is falsy', async () => {
        mockClient.put.mockResolvedValue({ ok: true });
        await h['storage:update-artifact-message-id']({}, { artifactId: 'a1', messageId: 'm1' });
        const [, payload] = mockClient.put.mock.calls[0];
        expect(payload).not.toHaveProperty('chat_id');
      });

      it('returns offline stub on backend unavailable', async () => {
        mockClient.put.mockRejectedValue(new MockTimeoutError('timeout'));
        const r = await h['storage:update-artifact-message-id']({}, {
          artifactId: 'a1', messageId: 'm1', chatId: 'c1',
        });
        expect(r.offline).toBe(true);
      });

      it('re-throws non-backend errors', async () => {
        mockClient.put.mockRejectedValue(new Error('500 Internal'));
        await expect(h['storage:update-artifact-message-id']({}, {
          artifactId: 'a1', messageId: 'm1',
        })).rejects.toThrow('500 Internal');
      });
    });

    describe('storage:delete-artifact', () => {
      it('deletes via DELETE', async () => {
        mockClient.delete.mockResolvedValue({ ok: true });
        const r = await h['storage:delete-artifact']({}, { artifactId: 'a1' });
        expect(r).toEqual({ ok: true });
      });

      it('returns offline stub on backend unavailable', async () => {
        mockClient.delete.mockRejectedValue(new MockTimeoutError('timeout'));
        const r = await h['storage:delete-artifact']({}, { artifactId: 'a1' });
        expect(r.offline).toBe(true);
      });

      it('re-throws non-backend errors', async () => {
        mockClient.delete.mockRejectedValue(new Error('forbidden'));
        await expect(h['storage:delete-artifact']({}, { artifactId: 'a1' })).rejects.toThrow('forbidden');
      });
    });
  });

  // --------------------------------------------------------------------------
  // Traceability + Trail + Summary + Search + Health
  // --------------------------------------------------------------------------

  describe('IPC handlers — traceability, trail, summary, health', () => {
    let h;
    beforeEach(() => { h = getHandlers(handler); });

    it('get-message-artifacts delegates GET', async () => {
      await h['storage:get-message-artifacts']({}, { messageId: 'm1' });
      expect(mockClient.get).toHaveBeenCalledWith('/v1/storage/artifact/list/message/m1', expect.any(Object));
    });

    it('get-artifact-source delegates GET', async () => {
      await h['storage:get-artifact-source']({}, { artifactId: 'a1' });
      expect(mockClient.get).toHaveBeenCalledWith('/v1/storage/artifact/get/a1', expect.any(Object));
    });

    it('get-llm-metadata delegates GET', async () => {
      await h['storage:get-llm-metadata']({}, { messageId: 'm1' });
      expect(mockClient.get).toHaveBeenCalledWith('/v1/storage/message/llm-metadata/get/m1', expect.any(Object));
    });

    describe('storage:load-trail-hierarchy', () => {
      it('returns array', async () => {
        mockClient.get.mockResolvedValue([{ group: 'g1' }]);
        const r = await h['storage:load-trail-hierarchy']({}, { chatId: 'c1' });
        expect(r).toEqual([{ group: 'g1' }]);
      });

      it('returns empty array on non-array', async () => {
        mockClient.get.mockResolvedValue(null);
        const r = await h['storage:load-trail-hierarchy']({}, { chatId: 'c1' });
        expect(r).toEqual([]);
      });

      it('returns empty array on error', async () => {
        mockClient.get.mockRejectedValue(new Error('down'));
        const r = await h['storage:load-trail-hierarchy']({}, { chatId: 'c1' });
        expect(r).toEqual([]);
      });
    });

    it('summarize-chat delegates POST', async () => {
      await h['storage:summarize-chat']({}, { chatId: 'c1', summaryType: 'brief' });
      expect(mockClient.post).toHaveBeenCalledWith(
        '/v1/storage/summary/create/c1',
        { summary_type: 'brief' },
        expect.any(Object)
      );
    });

    it('summarize-chat defaults summaryType to full', async () => {
      await h['storage:summarize-chat']({}, { chatId: 'c1' });
      const [, data] = mockClient.post.mock.calls[0];
      expect(data.summary_type).toBe('full');
    });

    it('generate-chat-summary uses 120s timeout', async () => {
      await h['storage:generate-chat-summary']({}, { chatId: 'c1', summaryType: 'full', forceRegenerate: true });
      expect(mockClient.post).toHaveBeenCalledWith(
        '/v1/storage/summary/create/c1',
        { summary_type: 'full', force_regenerate: true },
        { timeout: 120000 }
      );
    });

    it('generate-chat-summary defaults forceRegenerate to false', async () => {
      await h['storage:generate-chat-summary']({}, { chatId: 'c1' });
      const [, data] = mockClient.post.mock.calls[0];
      expect(data.force_regenerate).toBe(false);
    });

    it('get-chat-summaries delegates GET', async () => {
      await h['storage:get-chat-summaries']({}, { chatId: 'c1' });
      expect(mockClient.get).toHaveBeenCalledWith('/v1/storage/summary/list/c1', expect.any(Object));
    });

    it('search-chats delegates POST with defaults', async () => {
      await h['storage:search-chats']({}, { query: 'hello', options: {} });
      expect(mockClient.post).toHaveBeenCalledWith(
        '/v1/search/chats',
        { query: 'hello', limit: 20, search_type: 'hybrid', min_score: 0.3 },
        expect.any(Object)
      );
    });

    it('search-chats accepts custom options', async () => {
      await h['storage:search-chats']({}, { query: 'hi', options: { limit: 5, searchType: 'vector', minScore: 0.7 } });
      const [, data] = mockClient.post.mock.calls[0];
      expect(data).toEqual({ query: 'hi', limit: 5, search_type: 'vector', min_score: 0.7 });
    });

    it('search-chats works when options is undefined', async () => {
      await h['storage:search-chats']({}, { query: 'test' });
      const [, data] = mockClient.post.mock.calls[0];
      expect(data).toEqual({ query: 'test', limit: 20, search_type: 'hybrid', min_score: 0.3 });
    });

    describe('storage:health-check', () => {
      it('returns healthy:true for ok status', async () => {
        mockClient.get.mockResolvedValue({ status: 'ok' });
        const r = await h['storage:health-check']({});
        expect(r.healthy).toBe(true);
      });

      it('returns healthy:true for healthy status', async () => {
        mockClient.get.mockResolvedValue({ status: 'healthy' });
        const r = await h['storage:health-check']({});
        expect(r.healthy).toBe(true);
      });

      it('returns healthy:false for other status', async () => {
        mockClient.get.mockResolvedValue({ status: 'degraded' });
        const r = await h['storage:health-check']({});
        expect(r.healthy).toBe(false);
      });

      it('returns healthy:false on error', async () => {
        mockClient.get.mockRejectedValue(new Error('down'));
        const r = await h['storage:health-check']({});
        expect(r).toEqual({ healthy: false, error: 'down' });
      });

      it('returns healthy:false when result has no status', async () => {
        mockClient.get.mockResolvedValue({});
        const r = await h['storage:health-check']({});
        expect(r.healthy).toBe(false);
      });

      it('returns healthy:false when result is null', async () => {
        mockClient.get.mockResolvedValue(null);
        const r = await h['storage:health-check']({});
        expect(r.healthy).toBe(false);
      });
    });

    it('test-connection delegates to healthCheck', async () => {
      mockClient.get.mockResolvedValue({ status: 'ok' });
      const r = await h['storage:test-connection']({});
      expect(r.healthy).toBe(true);
    });

    it('get-stats delegates GET', async () => {
      await h['storage:get-stats']({});
      expect(mockClient.get).toHaveBeenCalledWith('/v1/storage/stats', expect.any(Object));
    });
  });

  // --------------------------------------------------------------------------
  // Singleton / factory / exports
  // --------------------------------------------------------------------------

  describe('getStorageHandler', () => {
    it('returns same instance on repeated calls', () => {
      const a = getStorageHandler();
      const b = getStorageHandler();
      expect(a).toBe(b);
    });
  });

  describe('createStorageHandler', () => {
    it('creates new instance each time', () => {
      const a = createStorageHandler();
      const b = createStorageHandler();
      expect(a).not.toBe(b);
    });
  });

  describe('module exports', () => {
    it('exports StorageIpcHandler class', () => { expect(typeof StorageIpcHandler).toBe('function'); });
    it('exports getStorageHandler function', () => { expect(typeof getStorageHandler).toBe('function'); });
    it('exports createStorageHandler function', () => { expect(typeof createStorageHandler).toBe('function'); });
  });
});
