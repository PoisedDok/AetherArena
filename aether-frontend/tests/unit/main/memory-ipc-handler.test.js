'use strict';

// ============================================================================
// Mocks
// ============================================================================

const mockIpcMain = {
  handle: jest.fn(),
  removeHandler: jest.fn(),
};

jest.mock('electron', () => ({
  app: { on: jest.fn(), whenReady: jest.fn(() => Promise.resolve()), getPath: jest.fn(() => '/tmp/test'), quit: jest.fn() },
  BrowserWindow: jest.fn(),
  ipcMain: mockIpcMain,
  ipcRenderer: { send: jest.fn(), invoke: jest.fn(), on: jest.fn() },
}), { virtual: true });

const mockChildLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};

jest.mock('../../../src/core/utils/logger', () => ({
  logger: {
    child: jest.fn(() => mockChildLogger),
  },
}));

jest.mock('../../../src/core/config', () => ({
  backend: { baseUrl: 'http://config-backend:3001' },
  api: { timeout: 10000, retries: 3, retryDelay: 500 },
  dev: { verboseLogging: false },
}));

jest.mock('../../../src/core/config/defaults', () => ({
  backend: { baseUrl: 'http://default-backend:3001' },
}));

const mockClient = {
  get: jest.fn().mockResolvedValue({ data: 'get-result' }),
  post: jest.fn().mockResolvedValue({ data: 'post-result' }),
  put: jest.fn().mockResolvedValue({ data: 'put-result' }),
  patch: jest.fn().mockResolvedValue({ data: 'patch-result' }),
  delete: jest.fn().mockResolvedValue({ data: 'delete-result' }),
};

class MockTimeoutError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'TimeoutError';
    this.isTimeoutError = true;
  }
}

jest.mock('../../../src/core/communication/ApiClient', () => ({
  ApiClient: jest.fn(() => mockClient),
  TimeoutError: MockTimeoutError,
}));

// ============================================================================
// Import after mocks
// ============================================================================

const { MemoryIpcHandler, getMemoryHandler, createMemoryHandler } = require('../../../src/main/services/MemoryIpcHandler');
const { ApiClient } = require('../../../src/core/communication/ApiClient');

// ============================================================================
// Test Suite
// ============================================================================

describe('MemoryIpcHandler', () => {
  let handler;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.get.mockResolvedValue({ data: 'get-result' });
    mockClient.post.mockResolvedValue({ data: 'post-result' });
    mockClient.put.mockResolvedValue({ data: 'put-result' });
    mockClient.patch.mockResolvedValue({ data: 'patch-result' });
    mockClient.delete.mockResolvedValue({ data: 'delete-result' });
    handler = new MemoryIpcHandler();
  });

  // --------------------------------------------------------------------------
  // Constructor
  // --------------------------------------------------------------------------

  describe('constructor', () => {
    it('resolves baseUrl from config.backend.baseUrl by default', () => {
      expect(handler.baseUrl).toBe('http://config-backend:3001');
    });

    it('prefers options.baseUrl over config', () => {
      const h = new MemoryIpcHandler({ baseUrl: 'http://custom:9000' });
      expect(h.baseUrl).toBe('http://custom:9000');
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
        logger: { child: jest.fn(() => mockChildLogger) },
      }));
      jest.doMock('../../../src/core/config', () => ({
        api: { timeout: 10000, retries: 3, retryDelay: 500 },
        dev: { verboseLogging: false },
      }));
      jest.doMock('../../../src/core/config/defaults', () => ({
        backend: { baseUrl: 'http://fallback:3001' },
      }));
      jest.doMock('../../../src/core/communication/ApiClient', () => ({
        ApiClient: jest.fn(() => mockClient),
        TimeoutError: MockTimeoutError,
      }));

      const { MemoryIpcHandler: IsoHandler } = require('../../../src/main/services/MemoryIpcHandler');
      const h = new IsoHandler();
      expect(h.baseUrl).toBe('http://fallback:3001');

      jest.resetModules();
    });

    it('resolves timeout from config.api.timeout by default', () => {
      expect(handler.timeout).toBe(10000);
    });

    it('prefers options.timeout over config', () => {
      const h = new MemoryIpcHandler({ timeout: 30000 });
      expect(h.timeout).toBe(30000);
    });

    it('creates child logger with module name', () => {
      // handler was created in beforeEach — its logger is the mockChildLogger
      expect(handler.logger).toBe(mockChildLogger);
    });

    it('initializes isInitialized to false', () => {
      expect(handler.isInitialized).toBe(false);
    });

    it('creates ApiClient with correct configuration', () => {
      expect(ApiClient).toHaveBeenCalledWith({
        baseURL: 'http://config-backend:3001',
        timeout: 10000,
        retries: 3,
        retryDelay: 500,
        enableLogging: false,
        circuitBreaker: true,
        rateLimiter: true,
      });
    });
  });

  // --------------------------------------------------------------------------
  // initialize()
  // --------------------------------------------------------------------------

  describe('initialize', () => {
    it('registers 11 IPC handlers', () => {
      handler.initialize();
      expect(mockIpcMain.handle).toHaveBeenCalledTimes(11);
    });

    it('registers all expected channels', () => {
      handler.initialize();
      const channels = mockIpcMain.handle.mock.calls.map(c => c[0]);
      expect(channels).toEqual([
        'memories:create',
        'memories:list',
        'memories:get',
        'memories:update',
        'memories:delete',
        'memories:search',
        'memories:get-relations',
        'memories:create-relation',
        'memories:delete-relation',
        'memories:promote',
        'memories:demote',
      ]);
    });

    it('sets isInitialized to true', () => {
      handler.initialize();
      expect(handler.isInitialized).toBe(true);
    });

    it('logs initialization messages', () => {
      handler.initialize();
      expect(mockChildLogger.info).toHaveBeenCalledWith('Initializing memory IPC handlers');
      expect(mockChildLogger.info).toHaveBeenCalledWith('Memory IPC handlers initialized');
    });

    it('warns and returns early if already initialized', () => {
      handler.initialize();
      jest.clearAllMocks();
      handler.initialize();
      expect(mockChildLogger.warn).toHaveBeenCalledWith('Memory IPC handlers already initialized');
      expect(mockIpcMain.handle).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // shutdown()
  // --------------------------------------------------------------------------

  describe('shutdown', () => {
    it('removes all 11 handlers including promote and demote', () => {
      handler.initialize();
      handler.shutdown();
      expect(mockIpcMain.removeHandler).toHaveBeenCalledTimes(11);
    });

    it('removes correct channels', () => {
      handler.shutdown();
      const removed = mockIpcMain.removeHandler.mock.calls.map(c => c[0]);
      expect(removed).toEqual([
        'memories:create',
        'memories:list',
        'memories:get',
        'memories:update',
        'memories:delete',
        'memories:search',
        'memories:get-relations',
        'memories:create-relation',
        'memories:delete-relation',
        'memories:promote',
        'memories:demote',
      ]);
    });

    it('sets isInitialized to false', () => {
      handler.initialize();
      handler.shutdown();
      expect(handler.isInitialized).toBe(false);
    });

    it('logs shutdown messages', () => {
      handler.shutdown();
      expect(mockChildLogger.info).toHaveBeenCalledWith('Shutting down memory IPC handlers');
      expect(mockChildLogger.info).toHaveBeenCalledWith('Memory IPC handlers shut down');
    });
  });

  // --------------------------------------------------------------------------
  // IPC handler delegation tests
  // --------------------------------------------------------------------------

  describe('IPC handlers', () => {
    let handlers;

    beforeEach(() => {
      handler.initialize();
      handlers = {};
      mockIpcMain.handle.mock.calls.forEach(([channel, fn]) => {
        handlers[channel] = fn;
      });
    });

    describe('memories:create', () => {
      it('delegates to _createMemory with data', async () => {
        const result = await handlers['memories:create']({}, { data: { content: 'test' } });
        expect(mockClient.post).toHaveBeenCalledWith('/v1/memory/create', { content: 'test' }, { timeout: 10000 });
        expect(result).toEqual({ data: 'post-result' });
      });
    });

    describe('memories:list', () => {
      it('lists with default filters', async () => {
        const result = await handlers['memories:list']({}, { filters: {} });
        expect(mockClient.get).toHaveBeenCalledWith('/v1/memory/list?limit=50&offset=0');
        expect(result).toEqual({ data: 'get-result' });
      });

      it('passes custom limit and offset', async () => {
        await handlers['memories:list']({}, { filters: { limit: 10, offset: 5 } });
        expect(mockClient.get).toHaveBeenCalledWith('/v1/memory/list?limit=10&offset=5');
      });

      it('includes memory_type filter when provided', async () => {
        await handlers['memories:list']({}, { filters: { memory_type: 'semantic' } });
        expect(mockClient.get).toHaveBeenCalledWith(expect.stringContaining('memory_type=semantic'));
      });

      it('includes min_importance filter when provided', async () => {
        await handlers['memories:list']({}, { filters: { min_importance: 0.5 } });
        expect(mockClient.get).toHaveBeenCalledWith(expect.stringContaining('min_importance=0.5'));
      });

      it('includes max_importance filter when provided', async () => {
        await handlers['memories:list']({}, { filters: { max_importance: 0.9 } });
        expect(mockClient.get).toHaveBeenCalledWith(expect.stringContaining('max_importance=0.9'));
      });

      it('includes min_importance=0 (falsy but defined)', async () => {
        await handlers['memories:list']({}, { filters: { min_importance: 0 } });
        expect(mockClient.get).toHaveBeenCalledWith(expect.stringContaining('min_importance=0'));
      });
    });

    describe('memories:get', () => {
      it('gets memory by id', async () => {
        const result = await handlers['memories:get']({}, { memoryId: 'mem-1' });
        expect(mockClient.get).toHaveBeenCalledWith('/v1/memory/get/mem-1', { timeout: 10000 });
        expect(result).toEqual({ data: 'get-result' });
      });
    });

    describe('memories:update', () => {
      it('updates memory with PATCH', async () => {
        const updates = { content: 'updated' };
        const result = await handlers['memories:update']({}, { memoryId: 'mem-1', updates });
        expect(mockClient.patch).toHaveBeenCalledWith('/v1/memory/update/mem-1', updates, { timeout: 10000 });
        expect(result).toEqual({ data: 'patch-result' });
      });
    });

    describe('memories:delete', () => {
      it('deletes memory by id', async () => {
        const result = await handlers['memories:delete']({}, { memoryId: 'mem-1' });
        expect(mockClient.delete).toHaveBeenCalledWith('/v1/memory/delete/mem-1', { timeout: 10000 });
        expect(result).toEqual({ data: 'delete-result' });
      });
    });

    describe('memories:search', () => {
      it('searches with default options', async () => {
        const result = await handlers['memories:search']({}, { query: 'test', options: {} });
        expect(mockClient.post).toHaveBeenCalledWith(
          '/v1/search/memories',
          { query: 'test', search_type: 'vector', limit: 20, threshold: 0.5 },
          { timeout: 10000 }
        );
        expect(result).toEqual({ data: 'post-result' });
      });

      it('accepts custom search options', async () => {
        await handlers['memories:search']({}, {
          query: 'test',
          options: { searchType: 'keyword', limit: 5, threshold: 0.8 },
        });
        expect(mockClient.post).toHaveBeenCalledWith(
          '/v1/search/memories',
          { query: 'test', search_type: 'keyword', limit: 5, threshold: 0.8 },
          { timeout: 10000 }
        );
      });
    });

    describe('memories:get-relations', () => {
      it('gets relations for a memory', async () => {
        const result = await handlers['memories:get-relations']({}, { memoryId: 'mem-1' });
        expect(mockClient.get).toHaveBeenCalledWith('/v1/memory/relation/list/mem-1', { timeout: 10000 });
        expect(result).toEqual({ data: 'get-result' });
      });
    });

    describe('memories:create-relation', () => {
      it('creates relation with default type and strength', async () => {
        const result = await handlers['memories:create-relation']({}, {
          memoryId: 'mem-1',
          relatedMemoryId: 'mem-2',
          data: {},
        });
        expect(mockClient.post).toHaveBeenCalledWith(
          '/v1/memory/relation/create/mem-1',
          { related_memory_id: 'mem-2', relation_type: 'related_to', strength: 0.5 },
          { timeout: 10000 }
        );
        expect(result).toEqual({ data: 'post-result' });
      });

      it('accepts custom relation type and strength', async () => {
        await handlers['memories:create-relation']({}, {
          memoryId: 'mem-1',
          relatedMemoryId: 'mem-2',
          data: { relationType: 'derives_from', strength: 0.9 },
        });
        expect(mockClient.post).toHaveBeenCalledWith(
          '/v1/memory/relation/create/mem-1',
          { related_memory_id: 'mem-2', relation_type: 'derives_from', strength: 0.9 },
          { timeout: 10000 }
        );
      });
    });

    describe('memories:delete-relation', () => {
      it('deletes relation by id', async () => {
        const result = await handlers['memories:delete-relation']({}, { relationId: 'rel-1' });
        expect(mockClient.delete).toHaveBeenCalledWith('/v1/memory/relation/delete/rel-1', { timeout: 10000 });
        expect(result).toEqual({ data: 'delete-result' });
      });
    });

    describe('memories:promote', () => {
      it('promotes memory by id', async () => {
        const result = await handlers['memories:promote']({}, { memoryId: 'mem-1' });
        expect(mockClient.post).toHaveBeenCalledWith('/v1/memory/promote/mem-1', {}, { timeout: 10000 });
        expect(result).toEqual({ data: 'post-result' });
      });
    });

    describe('memories:demote', () => {
      it('demotes memory with chatId', async () => {
        const result = await handlers['memories:demote']({}, { memoryId: 'mem-1', chatId: 'chat-1' });
        expect(mockClient.post).toHaveBeenCalledWith(
          '/v1/memory/demote/mem-1',
          { chat_id: 'chat-1' },
          { timeout: 10000 }
        );
        expect(result).toEqual({ data: 'post-result' });
      });
    });
  });

  // --------------------------------------------------------------------------
  // _request() method
  // --------------------------------------------------------------------------

  describe('_request', () => {
    it('routes GET to client.get', async () => {
      await handler._request('GET', '/test');
      expect(mockClient.get).toHaveBeenCalledWith('/test', { timeout: 10000 });
    });

    it('routes POST to client.post with data', async () => {
      await handler._request('POST', '/test', { key: 'val' });
      expect(mockClient.post).toHaveBeenCalledWith('/test', { key: 'val' }, { timeout: 10000 });
    });

    it('routes PUT to client.put with data', async () => {
      await handler._request('PUT', '/test', { key: 'val' });
      expect(mockClient.put).toHaveBeenCalledWith('/test', { key: 'val' }, { timeout: 10000 });
    });

    it('routes PATCH to client.patch with data', async () => {
      await handler._request('PATCH', '/test', { key: 'val' });
      expect(mockClient.patch).toHaveBeenCalledWith('/test', { key: 'val' }, { timeout: 10000 });
    });

    it('routes DELETE to client.delete', async () => {
      await handler._request('DELETE', '/test');
      expect(mockClient.delete).toHaveBeenCalledWith('/test', { timeout: 10000 });
    });

    it('throws for unsupported HTTP method', async () => {
      await expect(handler._request('OPTIONS', '/test')).rejects.toThrow(
        'Unsupported HTTP method: OPTIONS'
      );
    });

    it('logs error with context on failure', async () => {
      mockClient.get.mockRejectedValue(new Error('network failure'));
      await expect(handler._request('GET', '/fail')).rejects.toThrow('network failure');
      expect(mockChildLogger.error).toHaveBeenCalledWith('HTTP request failed', {
        method: 'GET',
        path: '/fail',
        error: 'network failure',
        timeoutMs: 10000,
        timeout: false,
      });
    });

    it('detects TimeoutError instances', async () => {
      mockClient.get.mockRejectedValue(new MockTimeoutError('request timed out'));
      await expect(handler._request('GET', '/slow')).rejects.toThrow('request timed out');
      expect(mockChildLogger.error).toHaveBeenCalledWith('HTTP request failed', expect.objectContaining({
        timeout: true,
      }));
    });

    it('detects errors with isTimeoutError flag', async () => {
      const err = new Error('timeout');
      err.isTimeoutError = true;
      mockClient.post.mockRejectedValue(err);
      await expect(handler._request('POST', '/slow', {})).rejects.toThrow('timeout');
      expect(mockChildLogger.error).toHaveBeenCalledWith('HTTP request failed', expect.objectContaining({
        timeout: true,
      }));
    });

    it('detects AbortError by name', async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      mockClient.get.mockRejectedValue(err);
      await expect(handler._request('GET', '/aborted')).rejects.toThrow('aborted');
      expect(mockChildLogger.error).toHaveBeenCalledWith('HTTP request failed', expect.objectContaining({
        timeout: true,
      }));
    });

    it('re-throws original error after logging', async () => {
      const original = new Error('original error');
      mockClient.get.mockRejectedValue(original);
      await expect(handler._request('GET', '/fail')).rejects.toBe(original);
    });
  });

  // --------------------------------------------------------------------------
  // Singleton / factory
  // --------------------------------------------------------------------------

  describe('getMemoryHandler', () => {
    it('returns a MemoryIpcHandler instance', () => {
      const instance = getMemoryHandler();
      expect(instance).toBeInstanceOf(MemoryIpcHandler);
    });

    it('returns the same instance on repeated calls', () => {
      const a = getMemoryHandler();
      const b = getMemoryHandler();
      expect(a).toBe(b);
    });
  });

  describe('createMemoryHandler', () => {
    it('creates a new instance each time', () => {
      const a = createMemoryHandler();
      const b = createMemoryHandler();
      expect(a).not.toBe(b);
      expect(a).toBeInstanceOf(MemoryIpcHandler);
    });

    it('passes options through', () => {
      const h = createMemoryHandler({ baseUrl: 'http://test:5000', timeout: 5000 });
      expect(h.baseUrl).toBe('http://test:5000');
      expect(h.timeout).toBe(5000);
    });
  });

  // --------------------------------------------------------------------------
  // Module exports
  // --------------------------------------------------------------------------

  describe('module exports', () => {
    it('exports MemoryIpcHandler class', () => {
      expect(typeof MemoryIpcHandler).toBe('function');
    });

    it('exports getMemoryHandler function', () => {
      expect(typeof getMemoryHandler).toBe('function');
    });

    it('exports createMemoryHandler function', () => {
      expect(typeof createMemoryHandler).toBe('function');
    });
  });
});
