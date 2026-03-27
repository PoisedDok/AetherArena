'use strict';

/**
 * Endpoint Facade Test
 *
 * Tests the thin facade that composes 13 domain API modules and auto-delegates their methods.
 * Key areas: construction, module composition, auto-delegation, interceptors, utility methods, dispose.
 */

// Mock dependencies before require
jest.mock('../../../../src/core/communication/GuruConnection', () => {
  return jest.fn().mockImplementation((opts) => ({
    _opts: opts,
    send: jest.fn(),
    streamAudio: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
    getStats: jest.fn().mockReturnValue({ connected: true }),
    dispose: jest.fn(),
    ws: { readyState: 1 },
    connect: jest.fn(),
    setBackendAvailable: jest.fn(),
    isBackendAvailable: jest.fn().mockReturnValue(true),
  }));
});

jest.mock('../../../../src/core/communication/ApiClient', () => {
  const mockApi = {
    get: jest.fn().mockResolvedValue({}),
    post: jest.fn().mockResolvedValue({}),
    put: jest.fn().mockResolvedValue({}),
    patch: jest.fn().mockResolvedValue({}),
    delete: jest.fn().mockResolvedValue({}),
    addRequestInterceptor: jest.fn(),
    addResponseInterceptor: jest.fn(),
    getCircuitBreakerState: jest.fn().mockReturnValue('closed'),
    getRateLimiterStats: jest.fn().mockReturnValue({}),
    setBackendAvailable: jest.fn(),
    isBackendAvailable: jest.fn().mockReturnValue(true),
  };
  return { ApiClient: jest.fn().mockImplementation(() => mockApi) };
});

jest.mock('../../../../src/core/utils/logger', () => ({
  logger: {
    child: jest.fn().mockReturnValue({
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    }),
  },
}));

// Provide crypto for Node test environment (not available by default in Node <19)
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = { randomUUID: () => 'test-uuid-1234-5678-abcd-ef0123456789' };
}

const Endpoint = require('../../../../src/core/communication/Endpoint');
const GuruConnection = require('../../../../src/core/communication/GuruConnection');
const { ApiClient } = require('../../../../src/core/communication/ApiClient');

const TEST_CONFIG = Object.freeze({
  API_BASE_URL: 'http://localhost:8765',
  WS_URL: 'ws://localhost:8765/ws',
  NODE_ENV: 'test',
  deferConnect: true,
});

describe('Endpoint (Facade)', () => {
  let endpoint;

  beforeEach(() => {
    jest.clearAllMocks();
    endpoint = new Endpoint(TEST_CONFIG);
  });

  // =========================================================================
  // Construction
  // =========================================================================
  describe('constructor', () => {
    it('should throw if config is null', () => {
      expect(() => new Endpoint(null)).toThrow('[Endpoint] Configuration required');
    });

    it('should throw if config is undefined', () => {
      expect(() => new Endpoint()).toThrow('[Endpoint] Configuration required');
    });

    it('should initialize GuruConnection with correct params', () => {
      expect(GuruConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'ws://localhost:8765/ws',
          reconnectDelay: 2000,
          pingInterval: 30000,
          healthInterval: 5000,
          enableLogging: false,
          deferConnect: true,
        })
      );
    });

    it('should initialize ApiClient with correct params', () => {
      expect(ApiClient).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'http://localhost:8765',
          timeout: 30000,
          retries: 2,
          retryDelay: 500,
          circuitBreaker: false,
          enableLogging: true,
        })
      );
    });

    it('should store config on instance', () => {
      expect(endpoint.config).toBe(TEST_CONFIG);
    });

    it('should expose api (ApiClient) as public property', () => {
      expect(endpoint.api).toBeDefined();
      expect(endpoint.api.get).toBeDefined();
    });

    it('should expose connection (GuruConnection) as public property', () => {
      expect(endpoint.connection).toBeDefined();
      expect(endpoint.connection.send).toBeDefined();
    });
  });

  // =========================================================================
  // Interceptor Setup
  // =========================================================================
  describe('_setupInterceptors', () => {
    it('should register 2 request interceptors', () => {
      // Called during construction
      expect(endpoint.api.addRequestInterceptor).toHaveBeenCalledTimes(2);
    });

    it('should register response interceptor in non-production', () => {
      expect(endpoint.api.addResponseInterceptor).toHaveBeenCalledTimes(1);
    });

    it('should NOT register response interceptor in production', () => {
      jest.clearAllMocks();
      new Endpoint({ ...TEST_CONFIG, NODE_ENV: 'production' });
      // 2 request interceptors, 0 response interceptors
      expect(endpoint.api.addResponseInterceptor).not.toHaveBeenCalled();
    });

    it('request interceptor should add X-Frontend-Id header', () => {
      const interceptor = endpoint.api.addRequestInterceptor.mock.calls[0][0];
      const reqConfig = { headers: {} };
      const result = interceptor(reqConfig);
      expect(result.headers['X-Frontend-Id']).toMatch(/^fe-/);
    });

    it('request interceptor should add X-Correlation-Id header', () => {
      const interceptor = endpoint.api.addRequestInterceptor.mock.calls[0][0];
      const reqConfig = { headers: {} };
      const result = interceptor(reqConfig);
      expect(result.headers['X-Correlation-Id']).toBeDefined();
    });

    it('request interceptor should not overwrite existing X-Correlation-Id', () => {
      const interceptor = endpoint.api.addRequestInterceptor.mock.calls[0][0];
      const reqConfig = { headers: { 'X-Correlation-Id': 'custom-corr-id' } };
      const result = interceptor(reqConfig);
      expect(result.headers['X-Correlation-Id']).toBe('custom-corr-id');
    });

    it('auth interceptor should not set Authorization (desktop mode: no token)', () => {
      const authInterceptor = endpoint.api.addRequestInterceptor.mock.calls[1][0];
      const reqConfig = { headers: {} };
      const result = authInterceptor(reqConfig);
      expect(result.headers['Authorization']).toBeUndefined();
    });
  });

  // =========================================================================
  // Module Composition & Auto-Delegation
  // =========================================================================
  describe('_composeModules (auto-delegation)', () => {
    it('should delegate HealthApi methods', () => {
      expect(typeof endpoint.getHealth).toBe('function');
      expect(typeof endpoint.getSettingsHealth).toBe('function');
      expect(typeof endpoint.getServicesStatus).toBe('function');
    });

    it('should delegate SettingsApi methods', () => {
      expect(typeof endpoint.getSettings).toBe('function');
      expect(typeof endpoint.setSettings).toBe('function');
      expect(typeof endpoint.getUserPreferences).toBe('function');
      expect(typeof endpoint.getAllPreferences).toBe('function');
      expect(typeof endpoint.getPreference).toBe('function');
      expect(typeof endpoint.setPreference).toBe('function');
      expect(typeof endpoint.getUserSettingsMetadata).toBe('function');
    });

    it('should delegate AgentApi methods', () => {
      expect(typeof endpoint.listAgentConfigs).toBe('function');
      expect(typeof endpoint.updateAgentConfig).toBe('function');
      expect(typeof endpoint.runResearch).toBe('function');
      expect(typeof endpoint.createAgentJob).toBe('function');
    });

    it('should delegate ChatApi methods', () => {
      expect(typeof endpoint.listChats).toBe('function');
      expect(typeof endpoint.deleteChat).toBe('function');
      expect(typeof endpoint.listAllArtifacts).toBe('function');
      expect(typeof endpoint.searchChats).toBe('function');
    });

    it('should delegate ArtifactApi methods', () => {
      expect(typeof endpoint.getArtifact).toBe('function');
      expect(typeof endpoint.exportArtifact).toBe('function');
      expect(typeof endpoint.updateArtifact).toBe('function');
      expect(typeof endpoint.deleteArtifact).toBe('function');
    });

    it('should delegate MemoryApi methods', () => {
      expect(typeof endpoint.createMemory).toBe('function');
      expect(typeof endpoint.searchMemories).toBe('function');
      expect(typeof endpoint.createMemoryRelation).toBe('function');
    });

    it('should delegate McpApi methods', () => {
      expect(typeof endpoint.listMcpServers).toBe('function');
      expect(typeof endpoint.registerMcpServer).toBe('function');
      expect(typeof endpoint.deleteMcpServer).toBe('function');
      expect(typeof endpoint.testMcpServer).toBe('function');
    });

    it('should delegate SourcesApi methods', () => {
      expect(typeof endpoint.getSources).toBe('function');
      expect(typeof endpoint.listSources).toBe('function');
      expect(typeof endpoint.searchIndex).toBe('function');
    });

    it('should delegate ModelProfileApi methods', () => {
      expect(typeof endpoint.getModels).toBe('function');
      expect(typeof endpoint.getModelCapabilities).toBe('function');
      expect(typeof endpoint.getProfiles).toBe('function');
      expect(typeof endpoint.stopGeneration).toBe('function');
    });

    it('should delegate FileIndexingApi methods', () => {
      expect(typeof endpoint.getFileIndexingLocations).toBe('function');
      expect(typeof endpoint.triggerFileIndexingReindex).toBe('function');
      expect(typeof endpoint.restartFileIndexingDaemon).toBe('function');
    });

    it('should delegate ContextApi methods', () => {
      expect(typeof endpoint.getContextMessages).toBe('function');
      expect(typeof endpoint.getContextStatus).toBe('function');
      expect(typeof endpoint.deleteMessageGroup).toBe('function');
    });

    it('should delegate MessagingApi methods', () => {
      expect(typeof endpoint.sendUserMessage).toBe('function');
      expect(typeof endpoint.sendUserMessageWithImage).toBe('function');
      expect(typeof endpoint.streamAudio).toBe('function');
      expect(typeof endpoint.on).toBe('function');
      expect(typeof endpoint.off).toBe('function');
    });

    it('should NOT delegate private methods (prefixed with _)', () => {
      // _request, _requireParam, _encodePath, _buildQuery are BaseApi internals
      expect(endpoint._request).toBeUndefined();
      expect(endpoint._requireParam).toBeUndefined();
      expect(endpoint._encodePath).toBeUndefined();
      expect(endpoint._buildQuery).toBeUndefined();
    });

    it('should NOT overwrite Endpoint-owned methods', () => {
      // getBackendURL, getWebSocketURL, getStats, dispose are on Endpoint's own prototype
      // They should NOT be overwritten by any module
      expect(endpoint.getBackendURL()).toBe('http://localhost:8765');
      expect(endpoint.getWebSocketURL()).toBe('ws://localhost:8765/ws');
    });

    it('should bind delegated methods to their module instance', async () => {
      // Calling a delegated method should dispatch through the module's _request
      // which uses the shared ctx.api
      await endpoint.getHealth();
      expect(endpoint.api.get).toHaveBeenCalledWith('/v1/health', {});
    });
  });

  // =========================================================================
  // Utility Methods
  // =========================================================================
  describe('getBackendURL()', () => {
    it('should return API_BASE_URL from config', () => {
      expect(endpoint.getBackendURL()).toBe('http://localhost:8765');
    });
  });

  describe('getWebSocketURL()', () => {
    it('should return WS_URL from config', () => {
      expect(endpoint.getWebSocketURL()).toBe('ws://localhost:8765/ws');
    });
  });

  describe('getStats()', () => {
    it('should return frozen object with websocket and http stats', () => {
      const stats = endpoint.getStats();
      expect(stats.websocket).toEqual({ connected: true });
      expect(stats.http.circuitBreaker).toBe('closed');
      expect(stats.http.rateLimiter).toEqual({});
      // Frozen
      expect(Object.isFrozen(stats)).toBe(true);
    });
  });

  // =========================================================================
  // Dispose
  // =========================================================================
  describe('dispose()', () => {
    it('should call connection.dispose()', () => {
      endpoint.dispose();
      expect(endpoint.connection.dispose).toHaveBeenCalledTimes(1);
    });

    it('should be safe to call twice', () => {
      endpoint.dispose();
      endpoint.dispose();
      expect(endpoint.connection.dispose).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // Backend Availability Gate
  // =========================================================================
  describe('setBackendAvailable / isBackendAvailable', () => {
    it('should propagate setBackendAvailable(false) to both ApiClient and GuruConnection', () => {
      endpoint.setBackendAvailable(false);

      expect(endpoint.api.setBackendAvailable).toHaveBeenCalledWith(false);
      expect(endpoint.connection.setBackendAvailable).toHaveBeenCalledWith(false);
    });

    it('should propagate setBackendAvailable(true) to both layers', () => {
      endpoint.setBackendAvailable(true);

      expect(endpoint.api.setBackendAvailable).toHaveBeenCalledWith(true);
      expect(endpoint.connection.setBackendAvailable).toHaveBeenCalledWith(true);
    });

    it('isBackendAvailable() should delegate to ApiClient', () => {
      endpoint.api.isBackendAvailable.mockReturnValue(false);

      expect(endpoint.isBackendAvailable()).toBe(false);
      expect(endpoint.api.isBackendAvailable).toHaveBeenCalled();
    });

    it('constructor should pass backendAvailable: false to both layers', () => {
      const GuruConnection = require('../../../../src/core/communication/GuruConnection');
      const { ApiClient } = require('../../../../src/core/communication/ApiClient');

      GuruConnection.mockClear();
      ApiClient.mockClear();

      new Endpoint({
        API_BASE_URL: 'http://localhost:8765',
        WS_URL: 'ws://localhost:8765',
        backendAvailable: false,
      });

      // Verify GuruConnection received backendAvailable: false
      expect(GuruConnection).toHaveBeenCalledWith(
        expect.objectContaining({ backendAvailable: false })
      );
      // Verify ApiClient received backendAvailable: false
      expect(ApiClient).toHaveBeenCalledWith(
        expect.objectContaining({ backendAvailable: false })
      );
    });

    it('constructor should default backendAvailable to true for both layers', () => {
      const GuruConnection = require('../../../../src/core/communication/GuruConnection');
      const { ApiClient } = require('../../../../src/core/communication/ApiClient');

      GuruConnection.mockClear();
      ApiClient.mockClear();

      new Endpoint({
        API_BASE_URL: 'http://localhost:8765',
        WS_URL: 'ws://localhost:8765',
      });

      expect(GuruConnection).toHaveBeenCalledWith(
        expect.objectContaining({ backendAvailable: true })
      );
      expect(ApiClient).toHaveBeenCalledWith(
        expect.objectContaining({ backendAvailable: true })
      );
    });
  });

  // =========================================================================
  // End-to-End: Delegated method actually works through facade
  // =========================================================================
  describe('end-to-end delegation', () => {
    it('should call sendUserMessage through MessagingApi', () => {
      const result = endpoint.sendUserMessage('Hello', 'msg-id-1', 'chat-1');
      expect(endpoint.connection.send).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'user',
          content: 'Hello',
          id: 'msg-id-1',
          chat_id: 'chat-1',
        })
      );
      expect(result).toBe('msg-id-1');
    });

    it('should call getHealth through HealthApi', async () => {
      await endpoint.getHealth();
      expect(endpoint.api.get).toHaveBeenCalledWith('/v1/health', {});
    });

    it('should validate params through AgentApi', async () => {
      await expect(endpoint.updateAgentConfig(null, {})).rejects.toThrow(
        '[Endpoint] agentName is required'
      );
    });
  });
});
