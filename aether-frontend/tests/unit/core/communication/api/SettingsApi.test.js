'use strict';

const SettingsApi = require('../../../../../src/core/communication/api/SettingsApi');

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

describe('SettingsApi', () => {
  let api, ctx;

  beforeEach(() => {
    ctx = createMockCtx();
    api = new SettingsApi(ctx);
  });

  // =========================================================================
  // getSettings
  // =========================================================================
  describe('getSettings()', () => {
    it('should GET /v1/settings/ with default request options', async () => {
      await api.getSettings();
      expect(ctx.api.get).toHaveBeenCalledWith(
        '/v1/settings/',
        expect.objectContaining({
          retries: 0,
          retryStatusCodes: [],
          rateCategory: 'settings',
          headers: expect.objectContaining({ 'X-Aether-Client': 'frontend-main' }),
        })
      );
    });

    it('should merge correlationId into headers', async () => {
      await api.getSettings({ correlationId: 'corr-123' });
      const callArgs = ctx.api.get.mock.calls[0][1];
      expect(callArgs.headers['X-Correlation-Id']).toBe('corr-123');
    });

    it('should propagate errors with correlation context', async () => {
      ctx.api.get.mockRejectedValueOnce(new Error('Server error'));
      await expect(api.getSettings({ correlationId: 'c1' })).rejects.toThrow('Server error');
      expect(ctx.logger.error).toHaveBeenCalledWith(
        'GET /v1/settings/ failed',
        expect.objectContaining({ correlationId: 'c1' })
      );
    });
  });

  // =========================================================================
  // setSettings
  // =========================================================================
  describe('setSettings()', () => {
    it('should POST /v1/settings/ with settings payload', async () => {
      const settings = { theme: 'dark', llm: { model: 'gpt-4' } };
      await api.setSettings(settings);
      expect(ctx.api.post).toHaveBeenCalledWith(
        '/v1/settings/',
        settings,
        expect.objectContaining({ rateCategory: 'settings' })
      );
    });

    it('should merge custom headers from options', async () => {
      await api.setSettings({}, { headers: { 'X-Custom': 'val' } });
      const callArgs = ctx.api.post.mock.calls[0][2];
      expect(callArgs.headers['X-Custom']).toBe('val');
      expect(callArgs.headers['X-Aether-Client']).toBe('frontend-main');
    });

    it('should log error and re-throw when POST fails', async () => {
      ctx.api.post.mockRejectedValueOnce(new Error('Settings save failed'));
      await expect(api.setSettings({ theme: 'dark' })).rejects.toThrow('Settings save failed');
      expect(ctx.logger.error).toHaveBeenCalledWith(
        'POST /v1/settings/ failed',
        expect.objectContaining({ error: 'Settings save failed' })
      );
    });
  });

  // =========================================================================
  // getUserPreferences
  // =========================================================================
  describe('getUserPreferences()', () => {
    it('should GET /v1/settings/user', async () => {
      await api.getUserPreferences();
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/settings/user', {});
    });
  });

  // =========================================================================
  // getAllPreferences
  // =========================================================================
  describe('getAllPreferences()', () => {
    it('should GET /v1/preferences/?user_id=default_user by default', async () => {
      ctx.api.get.mockResolvedValueOnce({ preferences: { theme: 'dark' } });
      const result = await api.getAllPreferences();
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/preferences/?user_id=default_user');
      expect(result).toEqual({ theme: 'dark' });
    });

    it('should encode userId in URL', async () => {
      ctx.api.get.mockResolvedValueOnce({ preferences: {} });
      await api.getAllPreferences('user with spaces');
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/preferences/?user_id=user%20with%20spaces');
    });

    it('should return empty object when preferences key is missing', async () => {
      ctx.api.get.mockResolvedValueOnce({});
      const result = await api.getAllPreferences();
      expect(result).toEqual({});
    });

    it('should return empty object when response is null', async () => {
      ctx.api.get.mockResolvedValueOnce(null);
      const result = await api.getAllPreferences();
      expect(result).toEqual({});
    });

    it('should log error and re-throw when GET fails', async () => {
      ctx.api.get.mockRejectedValueOnce(new Error('Prefs fetch failed'));
      await expect(api.getAllPreferences('user-42')).rejects.toThrow('Prefs fetch failed');
      expect(ctx.logger.error).toHaveBeenCalledWith(
        'GET /v1/preferences failed',
        expect.objectContaining({ error: 'Prefs fetch failed', userId: 'user-42' })
      );
    });
  });

  // =========================================================================
  // getPreference
  // =========================================================================
  describe('getPreference()', () => {
    it('should GET specific preference with encoded key', async () => {
      ctx.api.get.mockResolvedValueOnce({ preference_value: true });
      const result = await api.getPreference('auto_summarize');
      expect(ctx.api.get).toHaveBeenCalledWith(
        '/v1/preferences/auto_summarize?user_id=default_user'
      );
      expect(result).toBe(true);
    });

    it('should encode preference key with special characters', async () => {
      ctx.api.get.mockResolvedValueOnce({ preference_value: 'val' });
      await api.getPreference('key/with/slashes');
      expect(ctx.api.get).toHaveBeenCalledWith(
        '/v1/preferences/key%2Fwith%2Fslashes?user_id=default_user'
      );
    });

    it('should throw for missing preferenceKey', async () => {
      await expect(api.getPreference(null)).rejects.toThrow(
        '[Endpoint] preferenceKey is required for getPreference'
      );
    });

    it('should throw for empty preferenceKey', async () => {
      await expect(api.getPreference('')).rejects.toThrow(
        '[Endpoint] preferenceKey is required for getPreference'
      );
    });

    it('should return undefined when preference_value is missing', async () => {
      ctx.api.get.mockResolvedValueOnce({});
      const result = await api.getPreference('missing_key');
      expect(result).toBeUndefined();
    });

    it('should log error and re-throw when GET fails', async () => {
      ctx.api.get.mockRejectedValueOnce(new Error('Not found'));
      await expect(api.getPreference('missing', 'user-1')).rejects.toThrow('Not found');
      expect(ctx.logger.error).toHaveBeenCalledWith(
        'GET /v1/preferences/missing failed',
        expect.objectContaining({ error: 'Not found', preferenceKey: 'missing', userId: 'user-1' })
      );
    });
  });

  // =========================================================================
  // setPreference
  // =========================================================================
  describe('setPreference()', () => {
    it('should POST preference with encoded key', async () => {
      ctx.api.post.mockResolvedValueOnce({ status: 'ok' });
      await api.setPreference('theme', 'dark');
      expect(ctx.api.post).toHaveBeenCalledWith(
        '/v1/preferences/theme?user_id=default_user',
        { value: 'dark' }
      );
    });

    it('should NOT log the value (security: sensitive data)', async () => {
      ctx.api.post.mockRejectedValueOnce(new Error('fail'));
      await expect(api.setPreference('secret', 'my-password')).rejects.toThrow('fail');
      const logCall = ctx.logger.error.mock.calls[0][1];
      expect(logCall).not.toHaveProperty('value');
      expect(logCall.valueType).toBe('string');
    });

    it('should throw for missing preferenceKey', async () => {
      await expect(api.setPreference('', 'val')).rejects.toThrow(
        '[Endpoint] preferenceKey is required for setPreference'
      );
    });

    it('should accept custom userId', async () => {
      await api.setPreference('theme', 'light', 'user-42');
      expect(ctx.api.post).toHaveBeenCalledWith(
        '/v1/preferences/theme?user_id=user-42',
        { value: 'light' }
      );
    });
  });

  // =========================================================================
  // getUserSettingsMetadata
  // =========================================================================
  describe('getUserSettingsMetadata()', () => {
    it('should GET /v1/settings/user/metadata', async () => {
      ctx.api.get.mockResolvedValueOnce([{ key: 'theme', type: 'enum' }]);
      const result = await api.getUserSettingsMetadata();
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/settings/user/metadata', {});
      expect(result).toEqual([{ key: 'theme', type: 'enum' }]);
    });
  });
});
