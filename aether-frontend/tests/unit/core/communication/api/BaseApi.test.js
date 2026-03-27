'use strict';

const BaseApi = require('../../../../../src/core/communication/api/BaseApi');

/**
 * Helper: build a mock context matching Endpoint facade shape.
 */
function createMockCtx(overrides = {}) {
  return {
    api: {
      get: jest.fn().mockResolvedValue({ ok: true }),
      post: jest.fn().mockResolvedValue({ created: true }),
      put: jest.fn().mockResolvedValue({ updated: true }),
      patch: jest.fn().mockResolvedValue({ patched: true }),
      delete: jest.fn().mockResolvedValue({ deleted: true }),
    },
    logger: {
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      info: jest.fn(),
    },
    connection: overrides.connection || null,
    config: overrides.config || {},
    ...overrides,
  };
}

describe('BaseApi', () => {
  // =========================================================================
  // Constructor
  // =========================================================================
  describe('constructor', () => {
    it('should throw if ctx is null', () => {
      expect(() => new BaseApi(null)).toThrow('[BaseApi] ctx.api and ctx.logger are required');
    });

    it('should throw if ctx.api is missing', () => {
      expect(() => new BaseApi({ logger: {} })).toThrow('[BaseApi] ctx.api and ctx.logger are required');
    });

    it('should throw if ctx.logger is missing', () => {
      expect(() => new BaseApi({ api: {} })).toThrow('[BaseApi] ctx.api and ctx.logger are required');
    });

    it('should accept valid ctx with api and logger', () => {
      const ctx = createMockCtx();
      const base = new BaseApi(ctx);
      expect(base._api).toBe(ctx.api);
      expect(base._log).toBe(ctx.logger);
    });

    it('should default _connection to null when not provided', () => {
      const base = new BaseApi(createMockCtx());
      expect(base._connection).toBeNull();
    });

    it('should store connection when provided', () => {
      const conn = { send: jest.fn() };
      const base = new BaseApi(createMockCtx({ connection: conn }));
      expect(base._connection).toBe(conn);
    });

    it('should default _config to empty object when not provided', () => {
      const base = new BaseApi(createMockCtx());
      expect(base._config).toEqual({});
    });
  });

  // =========================================================================
  // _request() dispatch
  // =========================================================================
  describe('_request()', () => {
    let base, ctx;

    beforeEach(() => {
      ctx = createMockCtx();
      base = new BaseApi(ctx);
    });

    it('should dispatch GET to api.get(path, requestOptions)', async () => {
      const result = await base._request('GET', '/v1/health', { timeout: 5000 });
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/health', { timeout: 5000 });
      expect(result).toEqual({ ok: true });
    });

    it('should dispatch POST to api.post(path, body, requestOptions)', async () => {
      const body = { name: 'test' };
      const result = await base._request('POST', '/v1/items', { body, timeout: 3000 });
      expect(ctx.api.post).toHaveBeenCalledWith('/v1/items', body, { timeout: 3000 });
      expect(result).toEqual({ created: true });
    });

    it('should dispatch PUT to api.put(path, body, requestOptions)', async () => {
      const body = { title: 'updated' };
      await base._request('PUT', '/v1/items/1', { body });
      expect(ctx.api.put).toHaveBeenCalledWith('/v1/items/1', body, {});
    });

    it('should dispatch PATCH to api.patch(path, body, requestOptions)', async () => {
      const body = { status: 'done' };
      await base._request('PATCH', '/v1/items/1', { body });
      expect(ctx.api.patch).toHaveBeenCalledWith('/v1/items/1', body, {});
    });

    it('should dispatch DELETE to api.delete(path, requestOptions)', async () => {
      await base._request('DELETE', '/v1/items/1');
      expect(ctx.api.delete).toHaveBeenCalledWith('/v1/items/1', {});
    });

    it('should strip body and logContext from requestOptions', async () => {
      await base._request('GET', '/v1/test', {
        body: { ignored: true },
        logContext: { method: 'test' },
        timeout: 1000,
        headers: { 'X-Custom': 'yes' },
      });
      // body and logContext must NOT reach api.get
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/test', {
        timeout: 1000,
        headers: { 'X-Custom': 'yes' },
      });
    });

    it('should throw for unsupported HTTP method', async () => {
      await expect(base._request('OPTIONS', '/v1/test')).rejects.toThrow(
        '[BaseApi] Unsupported HTTP method: OPTIONS'
      );
    });

    it('should log error and rethrow on API failure', async () => {
      const apiError = new Error('Network timeout');
      ctx.api.get.mockRejectedValueOnce(apiError);

      await expect(base._request('GET', '/v1/fail')).rejects.toThrow('Network timeout');
      expect(ctx.logger.error).toHaveBeenCalledWith(
        'GET /v1/fail failed',
        expect.objectContaining({ error: 'Network timeout' })
      );
    });

    it('should merge logContext into error log payload', async () => {
      ctx.api.post.mockRejectedValueOnce(new Error('Bad request'));

      await expect(
        base._request('POST', '/v1/items', {
          body: {},
          logContext: { userId: 'u1', action: 'create' },
        })
      ).rejects.toThrow('Bad request');

      expect(ctx.logger.error).toHaveBeenCalledWith(
        'POST /v1/items failed',
        expect.objectContaining({
          error: 'Bad request',
          userId: 'u1',
          action: 'create',
        })
      );
    });

    it('should handle error objects without .message', async () => {
      ctx.api.get.mockRejectedValueOnce('raw string error');
      await expect(base._request('GET', '/v1/raw')).rejects.toBe('raw string error');
      expect(ctx.logger.error).toHaveBeenCalledWith(
        'GET /v1/raw failed',
        expect.objectContaining({ error: 'raw string error' })
      );
    });

    it('should default opts to empty object', async () => {
      await base._request('GET', '/v1/test');
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/test', {});
    });
  });

  // =========================================================================
  // _requireParam()
  // =========================================================================
  describe('_requireParam()', () => {
    let base;

    beforeEach(() => {
      base = new BaseApi(createMockCtx());
    });

    it('should throw for null value', () => {
      expect(() => base._requireParam(null, 'id', 'getItem')).toThrow(
        '[Endpoint] id is required for getItem'
      );
    });

    it('should throw for undefined value', () => {
      expect(() => base._requireParam(undefined, 'id', 'getItem')).toThrow(
        '[Endpoint] id is required for getItem'
      );
    });

    it('should throw for empty string', () => {
      expect(() => base._requireParam('', 'id', 'getItem')).toThrow(
        '[Endpoint] id is required for getItem'
      );
    });

    it('should throw for whitespace-only string', () => {
      expect(() => base._requireParam('   ', 'id', 'getItem')).toThrow(
        '[Endpoint] id is required for getItem'
      );
    });

    it('should throw for zero (falsy)', () => {
      expect(() => base._requireParam(0, 'count', 'setCount')).toThrow(
        '[Endpoint] count is required for setCount'
      );
    });

    it('should not throw for valid string', () => {
      expect(() => base._requireParam('abc-123', 'id', 'getItem')).not.toThrow();
    });

    it('should not throw for truthy number', () => {
      expect(() => base._requireParam(42, 'count', 'setCount')).not.toThrow();
    });

    it('should not throw for object', () => {
      expect(() => base._requireParam({ key: 'val' }, 'data', 'create')).not.toThrow();
    });
  });

  // =========================================================================
  // _requireString()
  // =========================================================================
  describe('_requireString()', () => {
    let base;

    beforeEach(() => {
      base = new BaseApi(createMockCtx());
    });

    it('should throw for non-string (number)', () => {
      expect(() => base._requireString(42, 'query', 'search')).toThrow(
        '[Endpoint] query is required for search'
      );
    });

    it('should throw for null', () => {
      expect(() => base._requireString(null, 'query', 'search')).toThrow();
    });

    it('should throw for empty string', () => {
      expect(() => base._requireString('', 'query', 'search')).toThrow();
    });

    it('should throw when trimmed length below minLength', () => {
      expect(() => base._requireString('ab', 'query', 'search', 3)).toThrow();
    });

    it('should not throw for valid string meeting minLength', () => {
      expect(() => base._requireString('hello', 'query', 'search', 3)).not.toThrow();
    });

    it('should default minLength to 1', () => {
      expect(() => base._requireString('x', 'query', 'search')).not.toThrow();
    });
  });

  // =========================================================================
  // _encodePath()
  // =========================================================================
  describe('_encodePath()', () => {
    let base;

    beforeEach(() => {
      base = new BaseApi(createMockCtx());
    });

    it('should substitute single param', () => {
      const result = base._encodePath('/v1/items/:id', { id: 'abc-123' });
      expect(result).toBe('/v1/items/abc-123');
    });

    it('should encode special characters in param values', () => {
      const result = base._encodePath('/v1/items/:id', { id: 'hello world' });
      expect(result).toBe('/v1/items/hello%20world');
    });

    it('should encode slashes to prevent path traversal', () => {
      const result = base._encodePath('/v1/items/:id', { id: '../etc/passwd' });
      expect(result).toBe('/v1/items/..%2Fetc%2Fpasswd');
    });

    it('should substitute multiple params', () => {
      const result = base._encodePath('/v1/:type/:id/details', {
        type: 'agents',
        id: 'agent-1',
      });
      expect(result).toBe('/v1/agents/agent-1/details');
    });

    it('should coerce numeric values to string', () => {
      const result = base._encodePath('/v1/items/:id', { id: 42 });
      expect(result).toBe('/v1/items/42');
    });

    it('should handle unicode characters', () => {
      const result = base._encodePath('/v1/items/:name', { name: 'caf\u00e9' });
      expect(result).toBe('/v1/items/caf%C3%A9');
    });

    it('should leave template unchanged for missing params', () => {
      const result = base._encodePath('/v1/items/:id', {});
      expect(result).toBe('/v1/items/:id');
    });
  });

  // =========================================================================
  // _buildQuery()
  // =========================================================================
  describe('_buildQuery()', () => {
    let base;

    beforeEach(() => {
      base = new BaseApi(createMockCtx());
    });

    it('should build query string from filters using mapping', () => {
      const query = base._buildQuery(
        { status: 'active', limit: 10 },
        { status: 'status_filter', limit: 'limit' }
      );
      expect(query).toContain('status_filter=active');
      expect(query).toContain('limit=10');
    });

    it('should skip undefined values', () => {
      const query = base._buildQuery(
        { status: undefined, limit: 10 },
        { status: 'status_filter', limit: 'limit' }
      );
      expect(query).toBe('limit=10');
      expect(query).not.toContain('status_filter');
    });

    it('should skip null values', () => {
      const query = base._buildQuery(
        { status: null },
        { status: 'status_filter' }
      );
      expect(query).toBe('');
    });

    it('should include zero (falsy but not null/undefined)', () => {
      const query = base._buildQuery(
        { offset: 0 },
        { offset: 'offset' }
      );
      expect(query).toBe('offset=0');
    });

    it('should include empty string', () => {
      const query = base._buildQuery(
        { search: '' },
        { search: 'q' }
      );
      expect(query).toBe('q=');
    });

    it('should include boolean false', () => {
      const query = base._buildQuery(
        { enabled: false },
        { enabled: 'enabled' }
      );
      expect(query).toBe('enabled=false');
    });

    it('should return empty string for empty filters', () => {
      const query = base._buildQuery({}, { status: 'status' });
      expect(query).toBe('');
    });
  });

  // =========================================================================
  // _pathWithQuery()
  // =========================================================================
  describe('_pathWithQuery()', () => {
    let base;

    beforeEach(() => {
      base = new BaseApi(createMockCtx());
    });

    it('should append query string to path', () => {
      expect(base._pathWithQuery('/v1/items', 'limit=10')).toBe('/v1/items?limit=10');
    });

    it('should return base path when query is empty string', () => {
      expect(base._pathWithQuery('/v1/items', '')).toBe('/v1/items');
    });
  });
});
