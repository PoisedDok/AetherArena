'use strict';

/**
 * StorageAPI Unit Tests
 * ============================================================================
 * Tests the Supabase backend storage client: chat CRUD, message CRUD,
 * artifact CRUD, traceability operations, trail hierarchy, health check,
 * error logging wrapper, and utility methods.
 *
 * @module tests/unit/infrastructure/StorageAPI.test
 */

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPut = jest.fn();
const mockDelete = jest.fn();
const mockGetCircuitBreakerState = jest.fn().mockReturnValue('closed');
const mockGetRateLimiterStats = jest.fn().mockReturnValue({ remaining: 50 });
const mockResetCircuitBreaker = jest.fn();
const mockResetRateLimiter = jest.fn();

jest.mock('../../../src/core/communication/ApiClient', () => ({
  ApiClient: jest.fn().mockImplementation(() => ({
    get: mockGet,
    post: mockPost,
    put: mockPut,
    delete: mockDelete,
    getCircuitBreakerState: mockGetCircuitBreakerState,
    getRateLimiterStats: mockGetRateLimiterStats,
    resetCircuitBreaker: mockResetCircuitBreaker,
    resetRateLimiter: mockResetRateLimiter,
  })),
}));

jest.mock('../../../src/core/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
}));

jest.mock('../../../src/core/config/defaults', () => Object.freeze({
  backend: Object.freeze({ baseUrl: 'http://127.0.0.1:8765' }),
  endpoints: Object.freeze({
    storageApi: '/v1/storage',
    storageHealth: '/health',
  }),
}));

// Config modules -- both optional, caught by try/catch in source
jest.mock('../../../src/core/config/renderer-config', () => ({
  backend: { baseUrl: 'http://127.0.0.1:8765' },
  endpoints: { storageApi: '/v1/storage', storageHealth: '/health' },
}), { virtual: true });

// ---------------------------------------------------------------------------
// Import SUT
// ---------------------------------------------------------------------------

const { StorageAPI } = require('../../../src/infrastructure/api/storage');
const { ApiClient } = require('../../../src/core/communication/ApiClient');

// ===========================================================================
// Tests
// ===========================================================================

describe('StorageAPI', () => {
  let api;

  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockPut.mockReset();
    mockDelete.mockReset();
    mockGetCircuitBreakerState.mockReturnValue('closed');
    mockGetRateLimiterStats.mockReturnValue({ remaining: 50 });
    api = new StorageAPI();
  });

  // =========================================================================
  // constructor
  // =========================================================================
  describe('constructor', () => {
    it('creates ApiClient with default config', () => {
      expect(ApiClient).toHaveBeenCalledWith(expect.objectContaining({
        baseURL: expect.stringContaining('/v1/storage'),
        timeout: 15000,
        retries: 3,
        circuitBreaker: true,
        rateLimiter: true,
      }));
    });

    it('uses custom options when provided', () => {
      const custom = new StorageAPI({
        baseURL: 'http://custom:9999',
        timeout: 5000,
        retries: 1,
        enableLogging: true,
      });
      expect(custom.baseURL).toBe('http://custom:9999');
      expect(custom.enableLogging).toBe(true);
    });

    it('defaults enableLogging to false', () => {
      expect(api.enableLogging).toBe(false);
    });

    it('sets healthEndpoint from defaults', () => {
      expect(api.healthEndpoint).toBe('/health');
    });

    it('allows retries=0 override', () => {
      const api0 = new StorageAPI({ retries: 0 });
      // ApiClient should have been called with retries: 0
      const lastCall = ApiClient.mock.calls[ApiClient.mock.calls.length - 1][0];
      expect(lastCall.retries).toBe(0);
    });
  });

  // =========================================================================
  // _withErrorLogging
  // =========================================================================
  describe('_withErrorLogging()', () => {
    it('returns result of successful function', async () => {
      const result = await api._withErrorLogging('test', async () => 42);
      expect(result).toBe(42);
    });

    it('logs and re-throws on error', async () => {
      const error = new Error('boom');
      await expect(
        api._withErrorLogging('testOp', async () => { throw error; })
      ).rejects.toThrow('boom');
      expect(api.log.error).toHaveBeenCalledWith('testOp failed', expect.objectContaining({
        operation: 'testOp',
        error: 'boom',
      }));
    });
  });

  // =========================================================================
  // Chat Operations
  // =========================================================================
  describe('loadChats()', () => {
    it('calls GET /chat/list and returns chats', async () => {
      const chats = [{ id: '1', title: 'Chat 1' }];
      mockGet.mockResolvedValue(chats);
      const result = await api.loadChats();
      expect(mockGet).toHaveBeenCalledWith('/chat/list');
      expect(result).toEqual(chats);
    });

    it('propagates errors', async () => {
      mockGet.mockRejectedValue(new Error('network error'));
      await expect(api.loadChats()).rejects.toThrow('network error');
    });
  });

  describe('loadChat()', () => {
    it('fetches chat and messages in parallel', async () => {
      mockGet.mockImplementation((url) => {
        if (url.includes('/chat/get/')) return Promise.resolve({ id: 'c1', title: 'Test' });
        if (url.includes('/message/list/')) return Promise.resolve([{ id: 'm1' }]);
        return Promise.resolve(null);
      });
      const result = await api.loadChat('c1');
      expect(result.id).toBe('c1');
      expect(result.messages).toEqual([{ id: 'm1' }]);
    });

    it('handles null messages gracefully', async () => {
      mockGet.mockImplementation((url) => {
        if (url.includes('/chat/get/')) return Promise.resolve({ id: 'c1' });
        if (url.includes('/message/list/')) return Promise.resolve(null);
        return Promise.resolve(null);
      });
      const result = await api.loadChat('c1');
      expect(result.messages).toEqual([]);
    });
  });

  describe('createChat()', () => {
    it('posts to /chat/create with title', async () => {
      mockPost.mockResolvedValue({ id: 'new-1', title: 'My Chat' });
      const result = await api.createChat('My Chat');
      expect(mockPost).toHaveBeenCalledWith('/chat/create', { title: 'My Chat' });
      expect(result.id).toBe('new-1');
    });

    it('uses default title when none provided', async () => {
      mockPost.mockResolvedValue({ id: 'new-2', title: 'New Chat' });
      await api.createChat();
      expect(mockPost).toHaveBeenCalledWith('/chat/create', { title: 'New Chat' });
    });
  });

  describe('updateChatTitle()', () => {
    it('puts to /chat/update/:id with new title', async () => {
      mockPut.mockResolvedValue({ id: 'c1', title: 'Updated' });
      const result = await api.updateChatTitle('c1', 'Updated');
      expect(mockPut).toHaveBeenCalledWith('/chat/update/c1', { title: 'Updated' });
      expect(result.title).toBe('Updated');
    });
  });

  describe('deleteChat()', () => {
    it('deletes /chat/delete/:id', async () => {
      mockDelete.mockResolvedValue({ success: true });
      const result = await api.deleteChat('c1');
      expect(mockDelete).toHaveBeenCalledWith('/chat/delete/c1');
      expect(result.success).toBe(true);
    });
  });

  // =========================================================================
  // Message Operations
  // =========================================================================
  describe('loadMessages()', () => {
    it('calls GET /message/list/:chatId', async () => {
      mockGet.mockResolvedValue([{ id: 'm1', content: 'Hello' }]);
      const result = await api.loadMessages('c1');
      expect(mockGet).toHaveBeenCalledWith('/message/list/c1');
      expect(result).toHaveLength(1);
    });
  });

  describe('saveMessage()', () => {
    it('posts to /message/create/:chatId with normalized payload', async () => {
      const message = {
        role: 'user',
        content: 'Hello',
        llm_model: 'gpt-4',
        llm_provider: 'openai',
        tokens_used: 100,
        correlation_id: 'corr-1',
        extra_field: 'should be excluded',
      };
      mockPost.mockResolvedValue({ id: 'saved-1' });
      await api.saveMessage('c1', message);
      expect(mockPost).toHaveBeenCalledWith('/message/create/c1', {
        role: 'user',
        content: 'Hello',
        llm_model: 'gpt-4',
        llm_provider: 'openai',
        tokens_used: 100,
        correlation_id: 'corr-1',
      });
    });
  });

  // =========================================================================
  // Artifact Operations
  // =========================================================================
  describe('loadArtifacts()', () => {
    it('calls GET /artifact/list/:chatId', async () => {
      mockGet.mockResolvedValue([{ id: 'a1', type: 'code' }]);
      const result = await api.loadArtifacts('c1');
      expect(mockGet).toHaveBeenCalledWith('/artifact/list/c1');
      expect(result).toHaveLength(1);
    });
  });

  describe('saveArtifact()', () => {
    it('posts normalized artifact payload', async () => {
      const artifact = {
        type: 'code',
        filename: 'test.js',
        content: 'console.log(1)',
        language: 'javascript',
        metadata: { size: 14 },
        artifact_id: 'art-1',
        message_id: 'msg-1',
        subgroup_id: 'sg-1',
        node_id: 'n-1',
      };
      mockPost.mockResolvedValue({ id: 'saved-a1' });
      await api.saveArtifact('c1', artifact);
      expect(mockPost).toHaveBeenCalledWith('/artifact/create/c1', expect.objectContaining({
        type: 'code',
        filename: 'test.js',
        artifact_id: 'art-1',
        message_id: 'msg-1',
        subgroup_id: 'sg-1',
        node_id: 'n-1',
      }));
    });

    it('uses camelCase fallbacks for IDs', async () => {
      const artifact = {
        type: 'output',
        filename: 'out.txt',
        content: 'result',
        artifactId: 'art-2',
        messageId: 'msg-2',
        subgroupId: 'sg-2',
        nodeId: 'n-2',
      };
      mockPost.mockResolvedValue({ id: 'saved-a2' });
      await api.saveArtifact('c1', artifact);
      const payload = mockPost.mock.calls[0][1];
      expect(payload.artifact_id).toBe('art-2');
      expect(payload.message_id).toBe('msg-2');
      expect(payload.subgroup_id).toBe('sg-2');
      expect(payload.node_id).toBe('n-2');
    });

    it('defaults subgroup_id and node_id to null', async () => {
      const artifact = { type: 'code', filename: 'f.js', content: 'x' };
      mockPost.mockResolvedValue({ id: 'saved-a3' });
      await api.saveArtifact('c1', artifact);
      const payload = mockPost.mock.calls[0][1];
      expect(payload.subgroup_id).toBeNull();
      expect(payload.node_id).toBeNull();
    });
  });

  describe('updateArtifactMessageId()', () => {
    it('puts to /artifact/link-message', async () => {
      mockPut.mockResolvedValue({ updated_count: 1 });
      const result = await api.updateArtifactMessageId('art-1', 'msg-1');
      expect(mockPut).toHaveBeenCalledWith('/artifact/link-message', {
        artifact_id: 'art-1',
        message_id: 'msg-1',
      });
      expect(result.updated_count).toBe(1);
    });

    it('includes chatId when provided', async () => {
      mockPut.mockResolvedValue({ updated_count: 1 });
      await api.updateArtifactMessageId('art-1', 'msg-1', 'c1');
      expect(mockPut).toHaveBeenCalledWith('/artifact/link-message', {
        artifact_id: 'art-1',
        message_id: 'msg-1',
        chat_id: 'c1',
      });
    });
  });

  describe('deleteArtifact()', () => {
    it('deletes /artifact/delete/:id', async () => {
      mockDelete.mockResolvedValue({ success: true });
      await api.deleteArtifact('art-1');
      expect(mockDelete).toHaveBeenCalledWith('/artifact/delete/art-1');
    });
  });

  // =========================================================================
  // Traceability Operations
  // =========================================================================
  describe('getMessageArtifacts()', () => {
    it('calls GET /artifact/list/message/:id', async () => {
      mockGet.mockResolvedValue([{ id: 'a1' }]);
      const result = await api.getMessageArtifacts('msg-1');
      expect(mockGet).toHaveBeenCalledWith('/artifact/list/message/msg-1');
      expect(result).toHaveLength(1);
    });
  });

  describe('getArtifactSource()', () => {
    it('calls GET /artifact/source/:id', async () => {
      mockGet.mockResolvedValue({ id: 'msg-1', content: 'original' });
      const result = await api.getArtifactSource('art-1');
      expect(mockGet).toHaveBeenCalledWith('/artifact/source/art-1');
      expect(result.id).toBe('msg-1');
    });
  });

  describe('getLLMMetadata()', () => {
    it('calls GET /message/llm-metadata/get/:id', async () => {
      mockGet.mockResolvedValue({ model: 'gpt-4', tokens: 500 });
      const result = await api.getLLMMetadata('msg-1');
      expect(mockGet).toHaveBeenCalledWith('/message/llm-metadata/get/msg-1');
      expect(result.model).toBe('gpt-4');
    });
  });

  describe('saveTraceabilityData()', () => {
    it('normalizes Map entries', async () => {
      const data = {
        messages: new Map([['m1', { content: 'hi' }]]),
        artifacts: new Map([['a1', { type: 'code' }]]),
      };
      mockPost.mockResolvedValue({ success: true });
      await api.saveTraceabilityData(data);
      const payload = mockPost.mock.calls[0][1];
      expect(payload.messages).toEqual([['m1', { content: 'hi' }]]);
      expect(payload.artifacts).toEqual([['a1', { type: 'code' }]]);
    });

    it('normalizes array of [key, value] pairs', async () => {
      const data = {
        messages: [['m1', { content: 'hi' }]],
        artifacts: [],
      };
      mockPost.mockResolvedValue({ success: true });
      await api.saveTraceabilityData(data);
      const payload = mockPost.mock.calls[0][1];
      expect(payload.messages).toEqual([['m1', { content: 'hi' }]]);
    });

    it('normalizes array of objects with id field', async () => {
      const data = {
        messages: [{ id: 'm1', content: 'hello', role: 'user' }],
        artifacts: [],
      };
      mockPost.mockResolvedValue({ success: true });
      await api.saveTraceabilityData(data);
      const payload = mockPost.mock.calls[0][1];
      expect(payload.messages).toEqual([['m1', { content: 'hello', role: 'user' }]]);
    });

    it('normalizes plain object entries', async () => {
      const data = {
        messages: { m1: { content: 'hi' } },
        artifacts: {},
      };
      mockPost.mockResolvedValue({ success: true });
      await api.saveTraceabilityData(data);
      const payload = mockPost.mock.calls[0][1];
      expect(payload.messages).toEqual([['m1', { content: 'hi' }]]);
    });

    it('handles null/undefined entries', async () => {
      const data = { messages: null, artifacts: undefined };
      mockPost.mockResolvedValue({ success: true });
      await api.saveTraceabilityData(data);
      const payload = mockPost.mock.calls[0][1];
      expect(payload.messages).toEqual([]);
      expect(payload.artifacts).toEqual([]);
    });

    it('handles null data', async () => {
      mockPost.mockResolvedValue({ success: true });
      await api.saveTraceabilityData(null);
      const payload = mockPost.mock.calls[0][1];
      expect(payload.version).toBe('2.0');
      expect(payload.messages).toEqual([]);
    });

    it('filters out non-pair entries from arrays', async () => {
      const data = {
        messages: [42, 'string', null, { id: 'm1', content: 'valid' }],
        artifacts: [],
      };
      mockPost.mockResolvedValue({ success: true });
      await api.saveTraceabilityData(data);
      const payload = mockPost.mock.calls[0][1];
      expect(payload.messages).toEqual([['m1', { content: 'valid' }]]);
    });

    it('filters out objects without key fields', async () => {
      const data = {
        messages: [{ noId: true, content: 'orphan' }],
        artifacts: [],
      };
      mockPost.mockResolvedValue({ success: true });
      await api.saveTraceabilityData(data);
      const payload = mockPost.mock.calls[0][1];
      expect(payload.messages).toEqual([]);
    });

    it('preserves version and timestamp from data', async () => {
      const data = { version: '3.0', timestamp: 12345, messages: [], artifacts: [] };
      mockPost.mockResolvedValue({ success: true });
      await api.saveTraceabilityData(data);
      const payload = mockPost.mock.calls[0][1];
      expect(payload.version).toBe('3.0');
      expect(payload.timestamp).toBe(12345);
    });
  });

  describe('loadTraceabilityData()', () => {
    it('calls GET /traceability/load/:chatId', async () => {
      mockGet.mockResolvedValue({ messages: [], artifacts: [] });
      const result = await api.loadTraceabilityData('c1');
      expect(mockGet).toHaveBeenCalledWith('/traceability/load/c1');
      expect(result).toHaveProperty('messages');
    });
  });

  // =========================================================================
  // Trail Hierarchy
  // =========================================================================
  describe('getTrailHierarchy()', () => {
    it('calls GET /trail/hierarchy/get/:chatId', async () => {
      mockGet.mockResolvedValue([{ id: 'g1', subgroups: [] }]);
      await api.getTrailHierarchy('c1');
      expect(mockGet).toHaveBeenCalledWith('/trail/hierarchy/get/c1');
    });
  });

  describe('getGroups()', () => {
    it('calls GET /trail/group/list/:chatId', async () => {
      mockGet.mockResolvedValue([{ id: 'g1' }]);
      await api.getGroups('c1');
      expect(mockGet).toHaveBeenCalledWith('/trail/group/list/c1');
    });
  });

  describe('getSubgroups()', () => {
    it('calls GET /trail/subgroup/list/:groupId', async () => {
      mockGet.mockResolvedValue([{ id: 'sg1' }]);
      await api.getSubgroups('g1');
      expect(mockGet).toHaveBeenCalledWith('/trail/subgroup/list/g1');
    });
  });

  describe('getNodes()', () => {
    it('calls GET /trail/node/list/:subgroupId', async () => {
      mockGet.mockResolvedValue([{ id: 'n1' }]);
      await api.getNodes('sg1');
      expect(mockGet).toHaveBeenCalledWith('/trail/node/list/sg1');
    });
  });

  describe('getSubgroupArtifacts()', () => {
    it('calls GET /trail/subgroup/artifact/list/:subgroupId', async () => {
      mockGet.mockResolvedValue([{ id: 'a1' }]);
      await api.getSubgroupArtifacts('sg1');
      expect(mockGet).toHaveBeenCalledWith('/trail/subgroup/artifact/list/sg1');
    });
  });

  // =========================================================================
  // Health Check
  // =========================================================================
  describe('healthCheck()', () => {
    it('calls GET on healthEndpoint', async () => {
      mockGet.mockResolvedValue({ status: 'ok' });
      const result = await api.healthCheck();
      expect(mockGet).toHaveBeenCalledWith('/health');
      expect(result.status).toBe('ok');
    });
  });

  describe('testConnection()', () => {
    it('returns true on successful health check', async () => {
      mockGet.mockResolvedValue({ status: 'ok' });
      const result = await api.testConnection();
      expect(result).toBe(true);
    });

    it('returns false on failed health check', async () => {
      mockGet.mockRejectedValue(new Error('connection refused'));
      const result = await api.testConnection();
      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // Utility Methods
  // =========================================================================
  describe('getStats()', () => {
    it('returns frozen stats object', () => {
      const stats = api.getStats();
      expect(Object.isFrozen(stats)).toBe(true);
      expect(stats.baseURL).toContain('/v1/storage');
      expect(stats.circuitBreaker).toBe('closed');
      expect(stats.rateLimiter).toEqual({ remaining: 50 });
    });
  });

  describe('resetCircuitBreaker()', () => {
    it('delegates to client', () => {
      api.resetCircuitBreaker();
      expect(mockResetCircuitBreaker).toHaveBeenCalled();
    });
  });

  describe('resetRateLimiter()', () => {
    it('delegates to client', () => {
      api.resetRateLimiter();
      expect(mockResetRateLimiter).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // window global export
  // =========================================================================
  describe('window global export', () => {
    it('attaches StorageAPI to window when defined', () => {
      jest.isolateModules(() => {
        jest.mock('../../../src/core/communication/ApiClient', () => ({
          ApiClient: jest.fn().mockImplementation(() => ({
            get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn(),
            getCircuitBreakerState: jest.fn(), getRateLimiterStats: jest.fn(),
            resetCircuitBreaker: jest.fn(), resetRateLimiter: jest.fn(),
          })),
        }));
        jest.mock('../../../src/core/utils/logger', () => ({
          createLogger: () => ({
            info: jest.fn(), warn: jest.fn(), error: jest.fn(),
            debug: jest.fn(), trace: jest.fn(),
          }),
        }));
        jest.mock('../../../src/core/config/defaults', () => Object.freeze({
          backend: Object.freeze({ baseUrl: 'http://127.0.0.1:8765' }),
          endpoints: Object.freeze({ storageApi: '/v1/storage', storageHealth: '/health' }),
        }));

        // Simulate window existence
        global.window = {};
        const { StorageAPI: SA } = require('../../../src/infrastructure/api/storage');
        expect(global.window.StorageAPI).toBe(SA);
        delete global.window;
      });
    });
  });
});
