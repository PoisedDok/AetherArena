'use strict';

jest.mock('../../../src/domain/chat/services/ChatService');
jest.mock('../../../src/domain/chat/services/MessageService');

const { ChatServices } = require('../../../src/application/chat/ChatServices');
const { ChatService } = require('../../../src/domain/chat/services/ChatService');
const { MessageService } = require('../../../src/domain/chat/services/MessageService');
const { Message } = require('../../../src/domain/chat/models/Message');

describe('ChatServices', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // Constructor
  // =========================================================================
  describe('constructor', () => {
    it('creates ChatService and MessageService with deps', () => {
      const mockStorage = { load: jest.fn() };
      const mockLogger = { info: jest.fn() };

      const svc = new ChatServices({ storageAPI: mockStorage, logger: mockLogger });

      expect(ChatService).toHaveBeenCalledWith({
        storageAPI: mockStorage,
        logger: mockLogger,
      });
      expect(MessageService).toHaveBeenCalledWith({
        storageAPI: mockStorage,
        logger: mockLogger,
      });
      expect(svc.chatService).toBeDefined();
      expect(svc.messageService).toBeDefined();
    });

    it('uses injected chatService', () => {
      const custom = { getChats: jest.fn() };
      const svc = new ChatServices({ chatService: custom });
      expect(svc.chatService).toBe(custom);
    });

    it('uses injected messageService', () => {
      const custom = { getMessages: jest.fn() };
      const svc = new ChatServices({ messageService: custom });
      expect(svc.messageService).toBe(custom);
    });

    it('defaults to empty deps when no options', () => {
      expect(() => new ChatServices()).not.toThrow();
      expect(ChatService).toHaveBeenCalledWith({
        storageAPI: undefined,
        logger: undefined,
      });
    });
  });

  // =========================================================================
  // createDomainMessage
  // =========================================================================
  describe('createDomainMessage()', () => {
    let svc;

    beforeEach(() => {
      svc = new ChatServices();
    });

    it('returns same Message instance if payload is already a Message', () => {
      const existing = new Message({ id: 'msg-1', role: 'user', content: 'hello' });
      const result = svc.createDomainMessage(existing);
      expect(result).toBe(existing);
    });

    it('throws for null payload', () => {
      expect(() => svc.createDomainMessage(null))
        .toThrow('[ChatServices] Message payload must be an object');
    });

    it('throws for undefined payload', () => {
      expect(() => svc.createDomainMessage(undefined))
        .toThrow('[ChatServices] Message payload must be an object');
    });

    it('throws for string payload', () => {
      expect(() => svc.createDomainMessage('hello'))
        .toThrow('[ChatServices] Message payload must be an object');
    });

    it('throws for number payload', () => {
      expect(() => svc.createDomainMessage(42))
        .toThrow('[ChatServices] Message payload must be an object');
    });

    it('creates Message from valid object payload', () => {
      const payload = {
        id: 'msg-2',
        chatId: 'chat-1',
        role: 'assistant',
        content: 'response text',
        timestamp: 1700000000,
      };
      const result = svc.createDomainMessage(payload);
      expect(result).toBeInstanceOf(Message);
      expect(result.id).toBe('msg-2');
      expect(result.chatId).toBe('chat-1');
      expect(result.role).toBe('assistant');
      expect(result.content).toBe('response text');
      expect(result.timestamp).toBe(1700000000);
    });

    it('uses chatIdOverride when payload has no chatId', () => {
      const payload = { id: 'msg-3', role: 'user', content: 'hi' };
      const result = svc.createDomainMessage(payload, 'override-chat');
      expect(result.chatId).toBe('override-chat');
    });

    it('payload chatId takes precedence over chatIdOverride', () => {
      const payload = { id: 'msg-4', chatId: 'payload-chat', role: 'user', content: 'test' };
      const result = svc.createDomainMessage(payload, 'override-chat');
      expect(result.chatId).toBe('payload-chat');
    });

    it('maps snake_case correlation_id to correlationId', () => {
      const payload = { id: 'msg-5', role: 'user', content: 'x', correlation_id: 'corr-1' };
      const result = svc.createDomainMessage(payload);
      expect(result.correlationId).toBe('corr-1');
    });

    it('prefers camelCase correlationId over snake_case', () => {
      const payload = { id: 'msg-6', role: 'user', content: 'x', correlationId: 'camel', correlation_id: 'snake' };
      // The code does: correlation_id || correlationId — snake_case is checked first
      const result = svc.createDomainMessage(payload);
      expect(result.correlationId).toBe('snake');
    });

    it('maps snake_case llm_model to llmModel', () => {
      const payload = { id: 'msg-7', role: 'assistant', content: 'x', llm_model: 'gpt-4' };
      const result = svc.createDomainMessage(payload);
      expect(result.llmModel).toBe('gpt-4');
    });

    it('maps snake_case llm_provider to llmProvider', () => {
      const payload = { id: 'msg-8', role: 'assistant', content: 'x', llm_provider: 'openai' };
      const result = svc.createDomainMessage(payload);
      expect(result.llmProvider).toBe('openai');
    });

    it('maps snake_case tokens_used to tokensUsed', () => {
      const payload = { id: 'msg-9', role: 'assistant', content: 'x', tokens_used: 150 };
      const result = svc.createDomainMessage(payload);
      expect(result.tokensUsed).toBe(150);
    });

    it('sets default timestamp when not provided', () => {
      const before = Date.now();
      const payload = { id: 'msg-10', role: 'user', content: 'x' };
      const result = svc.createDomainMessage(payload);
      const after = Date.now();
      expect(result.timestamp).toBeGreaterThanOrEqual(before);
      expect(result.timestamp).toBeLessThanOrEqual(after);
    });

    it('sets default metadata to empty object', () => {
      const payload = { id: 'msg-11', role: 'user', content: 'x' };
      const result = svc.createDomainMessage(payload);
      expect(result.metadata).toEqual({});
    });

    it('preserves provided metadata', () => {
      const payload = { id: 'msg-12', role: 'user', content: 'x', metadata: { key: 'val' } };
      const result = svc.createDomainMessage(payload);
      expect(result.metadata).toEqual({ key: 'val' });
    });

    it('sets status to "streaming" for assistant role with no explicit status', () => {
      const payload = { id: 'msg-13', role: 'assistant', content: 'x' };
      const result = svc.createDomainMessage(payload);
      expect(result.status).toBe('streaming');
    });

    it('sets status to "pending" for user role with no explicit status', () => {
      const payload = { id: 'msg-14', role: 'user', content: 'x' };
      const result = svc.createDomainMessage(payload);
      expect(result.status).toBe('pending');
    });

    it('uses explicit status over role-based default', () => {
      const payload = { id: 'msg-15', role: 'assistant', content: 'x', status: 'complete' };
      const result = svc.createDomainMessage(payload);
      expect(result.status).toBe('complete');
    });

    it('sets parentMessageId from payload', () => {
      const payload = { id: 'msg-16', role: 'user', content: 'x', parentMessageId: 'parent-1' };
      const result = svc.createDomainMessage(payload);
      expect(result.parentMessageId).toBe('parent-1');
    });

    it('defaults parentMessageId to null', () => {
      const payload = { id: 'msg-17', role: 'user', content: 'x' };
      const result = svc.createDomainMessage(payload);
      expect(result.parentMessageId).toBeNull();
    });
  });
});
