'use strict';

const ChatApi = require('../../../../../src/core/communication/api/ChatApi');

function createMockCtx() {
  return {
    api: {
      get: jest.fn().mockResolvedValue({}),
      post: jest.fn().mockResolvedValue({}),
      put: jest.fn().mockResolvedValue({}),
      patch: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
    },
    logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
  };
}

describe('ChatApi', () => {
  let api, ctx;

  beforeEach(() => {
    ctx = createMockCtx();
    api = new ChatApi(ctx);
  });

  describe('listChats()', () => {
    it('should GET /v1/storage/chat/list with default skip=0, limit=50', async () => {
      await api.listChats();
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/storage/chat/list', { params: { skip: 0, limit: 50 } });
    });

    it('should pass custom skip and limit', async () => {
      await api.listChats(10, 25);
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/storage/chat/list', { params: { skip: 10, limit: 25 } });
    });
  });

  describe('updateChat()', () => {
    it('should PUT /v1/storage/chat/update/:id with encoded chatId', async () => {
      await api.updateChat('chat-1', { title: 'New Title' });
      expect(ctx.api.put).toHaveBeenCalledWith(
        '/v1/storage/chat/update/chat-1',
        { title: 'New Title' },
        expect.any(Object)
      );
    });

    it('should throw for missing chatId', async () => {
      await expect(api.updateChat(null, {})).rejects.toThrow('[Endpoint] chatId is required');
    });
  });

  describe('deleteChat()', () => {
    it('should DELETE /v1/storage/chat/delete/:id (void return)', async () => {
      const result = await api.deleteChat('chat-1');
      expect(ctx.api.delete).toHaveBeenCalledWith('/v1/storage/chat/delete/chat-1');
      expect(result).toBeUndefined();
    });

    it('should throw for missing chatId', async () => {
      await expect(api.deleteChat('')).rejects.toThrow('[Endpoint] chatId is required');
    });

    it('should propagate and log errors', async () => {
      ctx.api.delete.mockRejectedValueOnce(new Error('Not found'));
      await expect(api.deleteChat('bad-id')).rejects.toThrow('Not found');
      expect(ctx.logger.error).toHaveBeenCalled();
    });
  });

  describe('listChatArtifacts()', () => {
    it('should GET /v1/storage/artifact/list/:id with encoded chatId', async () => {
      await api.listChatArtifacts('chat-1');
      expect(ctx.api.get).toHaveBeenCalledWith(
        '/v1/storage/artifact/list/chat-1',
        expect.objectContaining({ params: { limit: 100, offset: 0 } })
      );
    });

    it('should include artifact_type when provided', async () => {
      await api.listChatArtifacts('chat-1', 'code', 50, 10);
      expect(ctx.api.get).toHaveBeenCalledWith(
        '/v1/storage/artifact/list/chat-1',
        expect.objectContaining({ params: { limit: 50, offset: 10, artifact_type: 'code' } })
      );
    });

    it('should throw for missing chatId', async () => {
      await expect(api.listChatArtifacts(null)).rejects.toThrow('[Endpoint] chatId is required');
    });
  });

  describe('listAllArtifacts()', () => {
    it('should aggregate artifacts from multiple chats', async () => {
      ctx.api.get
        .mockResolvedValueOnce([
          { id: 'chat-1', title: 'Chat 1' },
          { id: 'chat-2', title: 'Chat 2' },
        ]) // listChats
        .mockResolvedValueOnce([{ artifact_id: 'a1', filename: 'file1.js' }]) // chat-1 artifacts
        .mockResolvedValueOnce([{ artifact_id: 'a2', filename: 'file2.py' }]); // chat-2 artifacts

      const result = await api.listAllArtifacts(2);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(expect.objectContaining({
        artifact_id: 'a1',
        chat_id: 'chat-1',
        chat_title: 'Chat 1',
      }));
      expect(result[1]).toEqual(expect.objectContaining({
        artifact_id: 'a2',
        chat_id: 'chat-2',
        chat_title: 'Chat 2',
      }));
    });

    it('should handle response.data wrapper', async () => {
      ctx.api.get
        .mockResolvedValueOnce({ data: [{ id: 'c1', title: 'C1' }] })
        .mockResolvedValueOnce({ data: [{ artifact_id: 'a1' }] });

      const result = await api.listAllArtifacts(1);
      expect(result).toHaveLength(1);
      expect(result[0].chat_id).toBe('c1');
    });

    it('should gracefully skip chats that fail artifact fetch', async () => {
      ctx.api.get
        .mockResolvedValueOnce([
          { id: 'c1', title: 'C1' },
          { id: 'c2', title: 'C2' },
        ])
        .mockResolvedValueOnce([{ artifact_id: 'a1' }])
        .mockRejectedValueOnce(new Error('Permission denied'));

      const result = await api.listAllArtifacts(2);
      expect(result).toHaveLength(1);
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch artifacts for chat c2'),
        expect.any(Object)
      );
    });

    it('should throw when listChats itself fails', async () => {
      ctx.api.get.mockRejectedValueOnce(new Error('Server down'));
      await expect(api.listAllArtifacts()).rejects.toThrow('Server down');
    });

    it('should return empty array when no chats exist', async () => {
      ctx.api.get.mockResolvedValueOnce([]);
      const result = await api.listAllArtifacts();
      expect(result).toEqual([]);
    });
  });

  describe('summarizeChat()', () => {
    it('should POST /v1/storage/summary/create/:id', async () => {
      await api.summarizeChat('chat-1', 'brief');
      expect(ctx.api.post).toHaveBeenCalledWith(
        '/v1/storage/summary/create/chat-1',
        { summary_type: 'brief' },
        expect.any(Object)
      );
    });

    it('should default summaryType to full', async () => {
      await api.summarizeChat('chat-1');
      expect(ctx.api.post).toHaveBeenCalledWith(
        '/v1/storage/summary/create/chat-1',
        { summary_type: 'full' },
        expect.any(Object)
      );
    });

    it('should throw for missing chatId', async () => {
      await expect(api.summarizeChat(null)).rejects.toThrow('[Endpoint] chatId is required');
    });
  });

  describe('getChatSummaries()', () => {
    it('should GET /v1/storage/summary/list/:id', async () => {
      await api.getChatSummaries('chat-1');
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/storage/summary/list/chat-1', expect.any(Object));
    });

    it('should throw for missing chatId', async () => {
      await expect(api.getChatSummaries('')).rejects.toThrow('[Endpoint] chatId is required');
    });
  });

  describe('searchChats()', () => {
    it('should POST /v1/search/chats with payload', async () => {
      await api.searchChats('project deadline');
      expect(ctx.api.post).toHaveBeenCalledWith(
        '/v1/search/chats',
        expect.objectContaining({
          query: 'project deadline',
          limit: 20
        }),
        expect.any(Object)
      );
    });

    it('should accept custom options', async () => {
      await api.searchChats('test', { limit: 5, searchType: 'vector', minScore: 0.8 });
      expect(ctx.api.post).toHaveBeenCalledWith(
        '/v1/search/chats',
        expect.objectContaining({
          limit: 5
        }),
        expect.any(Object)
      );
    });

    it('should throw for missing query', async () => {
      await expect(api.searchChats('')).rejects.toThrow('[Endpoint] query is required');
    });

    it('should throw for non-string query', async () => {
      await expect(api.searchChats(123)).rejects.toThrow('[Endpoint] query is required');
    });
  });
});
