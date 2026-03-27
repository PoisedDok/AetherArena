'use strict';

const ModelProfileApi = require('../../../../../src/core/communication/api/ModelProfileApi');

function createMockCtx() {
  return {
    api: {
      get: jest.fn().mockResolvedValue({}),
      post: jest.fn().mockResolvedValue({}),
      put: jest.fn(),
      patch: jest.fn(),
      delete: jest.fn(),
    },
    logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
  };
}

describe('ModelProfileApi', () => {
  let api, ctx;

  beforeEach(() => {
    ctx = createMockCtx();
    api = new ModelProfileApi(ctx);
  });

  // =========================================================================
  // getModels
  // =========================================================================
  describe('getModels()', () => {
    it('should GET /v1/models without override', async () => {
      await api.getModels();
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/models', expect.any(Object));
    });

    it('should append encoded base override as query param', async () => {
      await api.getModels('http://custom:1234/v1');
      const path = ctx.api.get.mock.calls[0][0];
      expect(path).toBe('/v1/models?base=http%3A%2F%2Fcustom%3A1234%2Fv1');
    });

    it('should not append query for null override', async () => {
      await api.getModels(null);
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/models', expect.any(Object));
    });
  });

  // =========================================================================
  // getModelCapabilities
  // =========================================================================
  describe('getModelCapabilities()', () => {
    it('should GET /v1/models/capabilities with encoded model name', async () => {
      await api.getModelCapabilities('gpt-4-turbo');
      expect(ctx.api.get).toHaveBeenCalledWith(
        '/v1/models/capabilities?model=gpt-4-turbo',
        expect.any(Object)
      );
    });

    it('should encode special characters in model name', async () => {
      await api.getModelCapabilities('model/with/slashes');
      const path = ctx.api.get.mock.calls[0][0];
      expect(path).toContain('model=model%2Fwith%2Fslashes');
    });

    it('should throw CONTRACT VIOLATION for null modelName', async () => {
      await expect(api.getModelCapabilities(null)).rejects.toThrow(
        '[Endpoint] CONTRACT VIOLATION: modelName is required'
      );
    });

    it('should throw CONTRACT VIOLATION for empty string', async () => {
      await expect(api.getModelCapabilities('')).rejects.toThrow(
        '[Endpoint] CONTRACT VIOLATION: modelName is required'
      );
    });

    it('should throw CONTRACT VIOLATION for whitespace-only', async () => {
      await expect(api.getModelCapabilities('   ')).rejects.toThrow(
        '[Endpoint] CONTRACT VIOLATION: modelName is required'
      );
    });

    it('should throw CONTRACT VIOLATION for non-string', async () => {
      await expect(api.getModelCapabilities(42)).rejects.toThrow(
        '[Endpoint] CONTRACT VIOLATION: modelName is required'
      );
    });
  });

  // =========================================================================
  // getProfiles
  // =========================================================================
  describe('getProfiles()', () => {
    it('should GET /v1/profiles without refresh', async () => {
      await api.getProfiles();
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/profiles', {});
    });

    it('should append ?refresh=true when refresh=true', async () => {
      await api.getProfiles(true);
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/profiles?refresh=true', {});
    });
  });

  // =========================================================================
  // getProfileDetails
  // =========================================================================
  describe('getProfileDetails()', () => {
    it('should GET /v1/profiles/:name with encoded name', async () => {
      await api.getProfileDetails('my-profile');
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/profiles/my-profile', expect.any(Object));
    });

    it('should encode special characters', async () => {
      await api.getProfileDetails('profile with spaces');
      expect(ctx.api.get).toHaveBeenCalledWith(
        '/v1/profiles/profile%20with%20spaces',
        expect.any(Object)
      );
    });

    it('should throw CONTRACT VIOLATION for null', async () => {
      await expect(api.getProfileDetails(null)).rejects.toThrow(
        '[Endpoint] CONTRACT VIOLATION: profileName is required'
      );
    });

    it('should throw CONTRACT VIOLATION for empty string', async () => {
      await expect(api.getProfileDetails('')).rejects.toThrow(
        '[Endpoint] CONTRACT VIOLATION: profileName is required'
      );
    });

    it('should throw CONTRACT VIOLATION for non-string', async () => {
      await expect(api.getProfileDetails(123)).rejects.toThrow(
        '[Endpoint] CONTRACT VIOLATION: profileName is required'
      );
    });
  });

  // =========================================================================
  // stopGeneration
  // =========================================================================
  describe('stopGeneration()', () => {
    it('should POST /v1/stop-generation with empty payload by default', async () => {
      await api.stopGeneration();
      expect(ctx.api.post).toHaveBeenCalledWith('/v1/stop-generation', {}, {});
    });

    it('should include request_id when provided', async () => {
      await api.stopGeneration({ requestId: 'req-1' });
      expect(ctx.api.post).toHaveBeenCalledWith(
        '/v1/stop-generation',
        expect.objectContaining({ request_id: 'req-1' }),
        {}
      );
    });

    it('should include session_id when provided', async () => {
      await api.stopGeneration({ sessionId: 'sess-1' });
      expect(ctx.api.post).toHaveBeenCalledWith(
        '/v1/stop-generation',
        expect.objectContaining({ session_id: 'sess-1' }),
        {}
      );
    });

    it('should include both when provided', async () => {
      await api.stopGeneration({ requestId: 'r1', sessionId: 's1' });
      const payload = ctx.api.post.mock.calls[0][1];
      expect(payload.request_id).toBe('r1');
      expect(payload.session_id).toBe('s1');
    });
  });
});
