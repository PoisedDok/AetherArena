'use strict';

const MemoryApi = require('../../../../../src/core/communication/api/MemoryApi');

function createMockCtx() {
  return {
    api: {
      get: jest.fn().mockResolvedValue({}),
      post: jest.fn().mockResolvedValue({}),
      put: jest.fn(),
      patch: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue(undefined),
    },
    logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
  };
}

describe('MemoryApi', () => {
  let api, ctx;

  beforeEach(() => {
    ctx = createMockCtx();
    api = new MemoryApi(ctx);
  });

  // =========================================================================
  // createMemory
  // =========================================================================
  describe('createMemory()', () => {
    it('should POST /v1/memory/create with data', async () => {
      const data = { content: 'User prefers dark mode', memory_type: 'preference' };
      await api.createMemory(data);
      expect(ctx.api.post).toHaveBeenCalledWith('/v1/memory/create', data, expect.any(Object));
    });

    it('should NOT include full data in logContext (security)', async () => {
      ctx.api.post.mockRejectedValueOnce(new Error('fail'));
      const data = { content: 'SECRET: password=abc123', memory_type: 'note' };
      await expect(api.createMemory(data)).rejects.toThrow('fail');
      const logCall = ctx.logger.error.mock.calls[0][1];
      expect(logCall).not.toHaveProperty('content');
      expect(logCall.memoryType).toBe('note');
    });

    it('should throw for missing content', async () => {
      await expect(api.createMemory({ memory_type: 'note' })).rejects.toThrow(
        'content and memory_type are required for createMemory'
      );
    });

    it('should throw for missing memory_type', async () => {
      await expect(api.createMemory({ content: 'hello' })).rejects.toThrow(
        'content and memory_type are required for createMemory'
      );
    });

    it('should throw for null', async () => {
      await expect(api.createMemory(null)).rejects.toThrow(
        'content and memory_type are required'
      );
    });
  });

  // =========================================================================
  // listMemories
  // =========================================================================
  describe('listMemories()', () => {
    it('should GET /v1/memory/list with default limit=50, offset=0', async () => {
      await api.listMemories();
      expect(ctx.api.get).toHaveBeenCalledWith(
        '/v1/memory/list',
        expect.objectContaining({ params: expect.objectContaining({ limit: 50, offset: 0 }) })
      );
    });

    it('should include memory_type filter', async () => {
      await api.listMemories({ memory_type: 'preference', limit: 10 });
      const opts = ctx.api.get.mock.calls[0][1];
      expect(opts.params.memory_type).toBe('preference');
      expect(opts.params.limit).toBe(10);
    });

    it('should include min_importance and max_importance', async () => {
      await api.listMemories({ min_importance: 0.5, max_importance: 1.0 });
      const opts = ctx.api.get.mock.calls[0][1];
      expect(opts.params.min_importance).toBe(0.5);
      expect(opts.params.max_importance).toBe(1.0);
    });

    it('should include source_chat_id filter', async () => {
      await api.listMemories({ source_chat_id: 'all' });
      const opts = ctx.api.get.mock.calls[0][1];
      expect(opts.params.source_chat_id).toBe('all');
    });
  });

  // =========================================================================
  // getMemory
  // =========================================================================
  describe('getMemory()', () => {
    it('should GET /v1/memory/get/:id with encoded id', async () => {
      await api.getMemory('mem-1');
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/memory/get/mem-1', expect.any(Object));
    });

    it('should throw for missing memoryId', async () => {
      await expect(api.getMemory(null)).rejects.toThrow(
        '[Endpoint] memoryId is required for getMemory'
      );
    });
  });

  // =========================================================================
  // updateMemory
  // =========================================================================
  describe('updateMemory()', () => {
    it('should PATCH /v1/memory/update/:id with updates', async () => {
      await api.updateMemory('mem-1', { content: 'updated' });
      expect(ctx.api.patch).toHaveBeenCalledWith(
        '/v1/memory/update/mem-1',
        { content: 'updated' },
        expect.any(Object)
      );
    });

    it('should throw for missing memoryId', async () => {
      await expect(api.updateMemory('', {})).rejects.toThrow(
        '[Endpoint] memoryId is required for updateMemory'
      );
    });
  });

  // =========================================================================
  // deleteMemory (void return, direct api.delete)
  // =========================================================================
  describe('deleteMemory()', () => {
    it('should DELETE /v1/memory/delete/:id (void return)', async () => {
      const result = await api.deleteMemory('mem-1');
      expect(ctx.api.delete).toHaveBeenCalledWith('/v1/memory/delete/mem-1');
      expect(result).toBeUndefined();
    });

    it('should throw for missing memoryId', async () => {
      await expect(api.deleteMemory(null)).rejects.toThrow(
        '[Endpoint] memoryId is required for deleteMemory'
      );
    });

    it('should log error with memoryId on failure', async () => {
      ctx.api.delete.mockRejectedValueOnce(new Error('DB error'));
      await expect(api.deleteMemory('mem-bad')).rejects.toThrow('DB error');
      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.stringContaining('DELETE /v1/memory/delete/mem-bad failed'),
        expect.objectContaining({ memoryId: 'mem-bad' })
      );
    });
  });

  // =========================================================================
  // searchMemories
  // =========================================================================
  describe('searchMemories()', () => {
    it('should POST /v1/search/memories with default options', async () => {
      await api.searchMemories('dark mode preference');
      expect(ctx.api.post).toHaveBeenCalledWith(
        '/v1/search/memories',
        expect.objectContaining({
          query: 'dark mode preference',
          search_type: 'vector',
          match_count: 20,
          match_threshold: 0.5,
        }),
        expect.any(Object)
      );
    });

    it('should accept custom search options', async () => {
      await api.searchMemories('test', { searchType: 'hybrid', limit: 5, threshold: 0.8 });
      expect(ctx.api.post).toHaveBeenCalledWith(
        '/v1/search/memories',
        expect.objectContaining({
          search_type: 'hybrid',
          match_count: 5,
          match_threshold: 0.8,
        }),
        expect.any(Object)
      );
    });

    it('should throw for missing query', async () => {
      await expect(api.searchMemories('')).rejects.toThrow(
        '[Endpoint] query is required for searchMemories'
      );
    });

    it('should throw for non-string query', async () => {
      await expect(api.searchMemories(42)).rejects.toThrow(
        '[Endpoint] query is required for searchMemories'
      );
    });

    it('should include queryLength in logContext (NOT the actual query)', async () => {
      ctx.api.post.mockRejectedValueOnce(new Error('timeout'));
      await expect(api.searchMemories('test query')).rejects.toThrow('timeout');
      const logMeta = ctx.logger.error.mock.calls[0][1];
      expect(logMeta.queryLength).toBe(10);
      expect(logMeta).not.toHaveProperty('query');
    });
  });

  // =========================================================================
  // getMemoryRelations
  // =========================================================================
  describe('getMemoryRelations()', () => {
    it('should GET /v1/memory/relation/list/:id', async () => {
      await api.getMemoryRelations('mem-1');
      expect(ctx.api.get).toHaveBeenCalledWith(
        '/v1/memory/relation/list/mem-1',
        expect.any(Object)
      );
    });

    it('should throw for missing memoryId', async () => {
      await expect(api.getMemoryRelations(null)).rejects.toThrow(
        '[Endpoint] memoryId is required for getMemoryRelations'
      );
    });
  });

  // =========================================================================
  // createMemoryRelation
  // =========================================================================
  describe('createMemoryRelation()', () => {
    it('should POST /v1/memory/relation/create/:id with payload', async () => {
      await api.createMemoryRelation('mem-1', 'mem-2', { relationType: 'causes', strength: 0.9 });
      expect(ctx.api.post).toHaveBeenCalledWith(
        '/v1/memory/relation/create/mem-1',
        expect.objectContaining({
          related_memory_id: 'mem-2',
          relation_type: 'causes',
          strength: 0.9,
        }),
        expect.any(Object)
      );
    });

    it('should use default relation_type and strength', async () => {
      await api.createMemoryRelation('mem-1', 'mem-2');
      const payload = ctx.api.post.mock.calls[0][1];
      expect(payload.relation_type).toBe('related_to');
      expect(payload.strength).toBe(0.5);
    });

    it('should throw when memoryId is missing', async () => {
      await expect(api.createMemoryRelation(null, 'mem-2')).rejects.toThrow(
        'memoryId and relatedMemoryId are required'
      );
    });

    it('should throw when relatedMemoryId is missing', async () => {
      await expect(api.createMemoryRelation('mem-1', '')).rejects.toThrow(
        'memoryId and relatedMemoryId are required'
      );
    });
  });
});
