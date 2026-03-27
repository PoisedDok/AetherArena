'use strict';

const MessagingApi = require('../../../../../src/core/communication/api/MessagingApi');

function createMockCtx() {
  const connection = {
    send: jest.fn(),
    streamAudio: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
    ws: { readyState: 1 }, // WebSocket.OPEN
  };
  return {
    api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
    logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
    connection,
  };
}

describe('MessagingApi', () => {
  let api, ctx;

  beforeEach(() => {
    ctx = createMockCtx();
    api = new MessagingApi(ctx);
  });

  // =========================================================================
  // sendUserMessage
  // =========================================================================
  describe('sendUserMessage()', () => {
    it('should send message via connection.send and return id', () => {
      const result = api.sendUserMessage('Hello world', 'msg-1', 'chat-1', 'corr-1');
      expect(ctx.connection.send).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'user',
          type: 'message',
          content: 'Hello world',
          id: 'msg-1',
          frontend_id: 'msg-1',
          correlation_id: 'corr-1',
          chat_id: 'chat-1',
        })
      );
      expect(result).toBe('msg-1');
    });

    it('should include timestamp in message', () => {
      const now = Date.now();
      api.sendUserMessage('test', 'id-1');
      const sentMsg = ctx.connection.send.mock.calls[0][0];
      expect(sentMsg.timestamp).toBeGreaterThanOrEqual(now);
    });

    it('should throw for non-string text', () => {
      expect(() => api.sendUserMessage(null, 'id-1')).toThrow(
        'Message content must be a non-empty string'
      );
    });

    it('should throw for empty text', () => {
      expect(() => api.sendUserMessage('', 'id-1')).toThrow(
        'Message content must be a non-empty string'
      );
    });

    it('should throw for whitespace-only text', () => {
      expect(() => api.sendUserMessage('   ', 'id-1')).toThrow(
        'Message content cannot be empty'
      );
    });

    it('should throw for text exceeding 100KB', () => {
      const longText = 'x'.repeat(100001);
      expect(() => api.sendUserMessage(longText, 'id-1')).toThrow(
        'Message exceeds maximum size of 100000 characters'
      );
    });

    it('should throw CONTRACT VIOLATION for missing id', () => {
      expect(() => api.sendUserMessage('hello', null)).toThrow(
        'CONTRACT VIOLATION: Frontend message ID is required'
      );
    });

    it('should throw CONTRACT VIOLATION for empty id', () => {
      expect(() => api.sendUserMessage('hello', '')).toThrow(
        'CONTRACT VIOLATION: Frontend message ID is required'
      );
    });

    it('should throw CONTRACT VIOLATION for whitespace-only id', () => {
      expect(() => api.sendUserMessage('hello', '   ')).toThrow(
        'CONTRACT VIOLATION: Frontend message ID is required'
      );
    });

    it('should log debug with chat_id substring and contentLength', () => {
      api.sendUserMessage('Hello world', 'id-1', 'chat-abcdefgh-1234');
      expect(ctx.logger.debug).toHaveBeenCalledWith(
        'sending user message to backend',
        expect.objectContaining({
          frontend_id: 'id-1',
          chat_id: 'chat-abc',
          contentLength: 11,
          connected: true,
        })
      );
    });

    it('should log "none" when chatId is null', () => {
      api.sendUserMessage('test', 'id-1', null);
      const logMeta = ctx.logger.debug.mock.calls[0][1];
      expect(logMeta.chat_id).toBe('none');
    });
  });

  // =========================================================================
  // sendUserMessageWithImage
  // =========================================================================
  describe('sendUserMessageWithImage()', () => {
    it('should send image message via connection.send', () => {
      const result = api.sendUserMessageWithImage('caption', 'base64data==', 'msg-2', 'chat-1');
      expect(ctx.connection.send).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'caption',
          image: 'base64data==',
          id: 'msg-2',
          frontend_id: 'msg-2',
        })
      );
      expect(result).toBe('msg-2');
    });

    it('should fall back to sendUserMessage when imageBase64 is null', () => {
      const result = api.sendUserMessageWithImage('just text', null, 'msg-3');
      const sentMsg = ctx.connection.send.mock.calls[0][0];
      expect(sentMsg.image).toBeUndefined();
      expect(sentMsg.content).toBe('just text');
      expect(result).toBe('msg-3');
    });

    it('should throw for non-string image', () => {
      expect(() => api.sendUserMessageWithImage('text', 42, 'id-1')).toThrow(
        'Image must be a non-empty base64 string'
      );
    });

    it('should throw for empty image string', () => {
      expect(() => api.sendUserMessageWithImage('text', '', 'id-1')).not.toThrow();
      // empty string is falsy, so falls back to sendUserMessage
    });

    it('should throw for image exceeding 10MB', () => {
      const bigImage = 'x'.repeat(10 * 1024 * 1024 + 1);
      expect(() => api.sendUserMessageWithImage('', bigImage, 'id-1')).toThrow(
        'Image exceeds maximum size'
      );
    });

    it('should throw for non-string text when text is provided', () => {
      expect(() => api.sendUserMessageWithImage(42, 'imgdata', 'id-1')).toThrow(
        'Message text must be a string'
      );
    });

    it('should throw for text exceeding 100KB', () => {
      const longText = 'x'.repeat(100001);
      expect(() => api.sendUserMessageWithImage(longText, 'imgdata', 'id-1')).toThrow(
        'Message text exceeds maximum size'
      );
    });

    it('should throw CONTRACT VIOLATION for missing id', () => {
      expect(() => api.sendUserMessageWithImage('text', 'imgdata', null)).toThrow(
        'CONTRACT VIOLATION: Frontend message ID is required'
      );
    });

    it('should log debug with image metadata', () => {
      api.sendUserMessageWithImage('cap', 'abc123', 'id-1', 'chat-1');
      expect(ctx.logger.debug).toHaveBeenCalledWith(
        'sending user message with image to backend',
        expect.objectContaining({
          hasImage: true,
          imageSize: 6,
        })
      );
    });
  });

  // =========================================================================
  // streamAudio
  // =========================================================================
  describe('streamAudio()', () => {
    it('should delegate to connection.streamAudio', () => {
      const buffer = new ArrayBuffer(1024);
      api.streamAudio(buffer);
      expect(ctx.connection.streamAudio).toHaveBeenCalledWith(buffer);
    });
  });

  // =========================================================================
  // on / off
  // =========================================================================
  describe('on()', () => {
    it('should delegate to connection.on', () => {
      const handler = jest.fn();
      api.on('message', handler);
      expect(ctx.connection.on).toHaveBeenCalledWith('message', handler);
    });
  });

  describe('off()', () => {
    it('should delegate to connection.off', () => {
      const handler = jest.fn();
      api.off('message', handler);
      expect(ctx.connection.off).toHaveBeenCalledWith('message', handler);
    });
  });
});
