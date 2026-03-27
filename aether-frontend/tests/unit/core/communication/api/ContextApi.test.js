'use strict';

const ContextApi = require('../../../../../src/core/communication/api/ContextApi');

function createMockCtx() {
  return {
    api: {
      get: jest.fn().mockResolvedValue({}),
      post: jest.fn(),
      put: jest.fn(),
      patch: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
    },
    logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
  };
}

describe('ContextApi', () => {
  let api, ctx;

  beforeEach(() => {
    ctx = createMockCtx();
    api = new ContextApi(ctx);
  });

  describe('getContextMessages()', () => {
    it('should GET /v1/context/chats/:id/context/messages', async () => {
      await api.getContextMessages('chat-1');
      expect(ctx.api.get).toHaveBeenCalledWith(
        '/v1/context/chats/chat-1/context/messages',
        expect.any(Object)
      );
    });

    it('should encode chatId', async () => {
      await api.getContextMessages('id/with/slashes');
      expect(ctx.api.get).toHaveBeenCalledWith(
        '/v1/context/chats/id%2Fwith%2Fslashes/context/messages',
        expect.any(Object)
      );
    });

    it('should throw for missing chatId', async () => {
      await expect(api.getContextMessages(null)).rejects.toThrow(
        '[Endpoint] chatId is required for getContextMessages'
      );
    });

    it('should throw for empty chatId', async () => {
      await expect(api.getContextMessages('')).rejects.toThrow(
        '[Endpoint] chatId is required for getContextMessages'
      );
    });
  });

  describe('getContextStatus()', () => {
    it('should GET /v1/context/chats/:id/context/status', async () => {
      await api.getContextStatus('chat-1');
      expect(ctx.api.get).toHaveBeenCalledWith(
        '/v1/context/chats/chat-1/context/status',
        expect.any(Object)
      );
    });

    it('should throw for missing chatId', async () => {
      await expect(api.getContextStatus(null)).rejects.toThrow(
        '[Endpoint] chatId is required for getContextStatus'
      );
    });
  });

  describe('deleteMessageGroup()', () => {
    it('should DELETE /v1/context/chats/:chatId/messages/:messageId', async () => {
      await api.deleteMessageGroup('chat-1', 'msg-1');
      expect(ctx.api.delete).toHaveBeenCalledWith(
        '/v1/context/chats/chat-1/messages/msg-1',
        expect.any(Object)
      );
    });

    it('should encode both chatId and messageId', async () => {
      await api.deleteMessageGroup('chat/1', 'msg/1');
      expect(ctx.api.delete).toHaveBeenCalledWith(
        '/v1/context/chats/chat%2F1/messages/msg%2F1',
        expect.any(Object)
      );
    });

    it('should throw when chatId is missing', async () => {
      await expect(api.deleteMessageGroup(null, 'msg-1')).rejects.toThrow(
        'chatId and messageId are required for deleteMessageGroup'
      );
    });

    it('should throw when messageId is missing', async () => {
      await expect(api.deleteMessageGroup('chat-1', '')).rejects.toThrow(
        'chatId and messageId are required for deleteMessageGroup'
      );
    });

    it('should throw when both are missing', async () => {
      await expect(api.deleteMessageGroup(null, null)).rejects.toThrow(
        'chatId and messageId are required for deleteMessageGroup'
      );
    });
  });
});
