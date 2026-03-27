'use strict';

const HealthApi = require('../../../../../src/core/communication/api/HealthApi');

function createMockCtx() {
  return {
    api: {
      get: jest.fn().mockResolvedValue({ status: 'ok' }),
      post: jest.fn(),
      put: jest.fn(),
      patch: jest.fn(),
      delete: jest.fn(),
    },
    logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
  };
}

describe('HealthApi', () => {
  let api, ctx;

  beforeEach(() => {
    ctx = createMockCtx();
    api = new HealthApi(ctx);
  });

  describe('getHealth()', () => {
    it('should GET /v1/health', async () => {
      const result = await api.getHealth();
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/health', {});
      expect(result).toEqual({ status: 'ok' });
    });

    it('should propagate API errors', async () => {
      ctx.api.get.mockRejectedValueOnce(new Error('Connection refused'));
      await expect(api.getHealth()).rejects.toThrow('Connection refused');
      expect(ctx.logger.error).toHaveBeenCalledWith(
        'GET /v1/health failed',
        expect.objectContaining({ error: 'Connection refused' })
      );
    });
  });

  describe('getSettingsHealth()', () => {
    it('should GET /v1/settings/health', async () => {
      await api.getSettingsHealth();
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/settings/health', {});
    });
  });

  describe('getServicesStatus()', () => {
    it('should GET /v1/services/status', async () => {
      ctx.api.get.mockResolvedValueOnce({ perplexica: 'running', lmstudio: 'stopped' });
      const result = await api.getServicesStatus();
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/services/status', {});
      expect(result).toEqual({ perplexica: 'running', lmstudio: 'stopped' });
    });
  });

  describe('completeOnboarding()', () => {
    it('should POST /v1/setup/complete with payload', async () => {
      const payload = { test: 'data' };
      ctx.api.post.mockResolvedValueOnce({ status: 'ok' });
      const result = await api.completeOnboarding(payload);
      expect(ctx.api.post).toHaveBeenCalledWith('/v1/setup/complete', payload, {
        timeout: 30000,
      });
      expect(result).toEqual({ status: 'ok' });
    });
  });
});
