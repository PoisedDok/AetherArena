'use strict';

jest.mock('../../../../../src/core/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
  })
}));

// Must use real Message because MessageSender calls Message.createUser
const { Message } = require('../../../../../src/domain/chat/models/Message');
const { MessageSender } = require('../../../../../src/domain/chat/services/MessageSender');

function createMockRepo() {
  return {
    save: jest.fn().mockImplementation((msg) => {
      // Simulate what repo does: return cloned message with generated ID
      return Promise.resolve(msg.clone({ id: 'persisted-id-123' }));
    })
  };
}

describe('MessageSender', () => {
  describe('constructor', () => {
    it('throws when messageRepository is missing', () => {
      expect(() => new MessageSender({})).toThrow('messageRepository REQUIRED');
    });

    it('throws when dependencies is empty object', () => {
      expect(() => new MessageSender()).toThrow('messageRepository REQUIRED');
    });

    it('initializes with valid repo', () => {
      const sender = new MessageSender({ messageRepository: createMockRepo() });
      expect(sender.getStats().hasRepository).toBe(true);
    });
  });

  describe('sendMessage()', () => {
    let sender, repo;

    beforeEach(() => {
      repo = createMockRepo();
      sender = new MessageSender({ messageRepository: repo });
    });

    it('persists user message and returns payload', async () => {
      const result = await sender.sendMessage('hello', 'chat-1', 'req-1');

      // Check persisted message
      expect(result.persistedMessage).toBeTruthy();
      expect(result.persistedMessage.id).toBe('persisted-id-123');
      expect(result.persistedMessage.role).toBe('user');
      expect(result.persistedMessage.content).toBe('hello');

      // Check WebSocket payload
      expect(result.payload.role).toBe('user');
      expect(result.payload.type).toBe('message');
      expect(result.payload.id).toBe('req-1');
      expect(result.payload.content).toBe('hello');
    });

    it('calls repo.save with Message instance and chatId', async () => {
      await sender.sendMessage('test', 'chat-1', 'req-1');
      expect(repo.save).toHaveBeenCalledWith(expect.any(Message), 'chat-1');
    });

    it('sets correlationId on user message before save', async () => {
      await sender.sendMessage('test', 'chat-1', 'req-1');
      const savedMsg = repo.save.mock.calls[0][0];
      expect(savedMsg.correlationId).toBe('req-1');
    });

    it('merges options.metadata into message metadata', async () => {
      await sender.sendMessage('test', 'chat-1', 'req-1', {
        metadata: { source: 'test' }
      });
      const savedMsg = repo.save.mock.calls[0][0];
      expect(savedMsg.metadata.source).toBe('test');
    });

    it('attaches files to message metadata', async () => {
      await sender.sendMessage('test', 'chat-1', 'req-1', {
        files: [{ name: 'doc.pdf' }]
      });
      const savedMsg = repo.save.mock.calls[0][0];
      expect(savedMsg.metadata.attachments).toEqual([{ name: 'doc.pdf' }]);
    });

    it('includes files in WebSocket payload', async () => {
      const result = await sender.sendMessage('test', 'chat-1', 'req-1', {
        files: [{ name: 'doc.pdf' }]
      });
      expect(result.payload.files).toEqual([{ name: 'doc.pdf' }]);
    });

    it('includes metadata in WebSocket payload for backend persistence', async () => {
      const result = await sender.sendMessage('test', 'chat-1', 'req-1', {
        metadata: { internal: true }
      });
      expect(result.payload.metadata).toEqual({ internal: true });
    });

    it('merges extra backend options into payload', async () => {
      const result = await sender.sendMessage('test', 'chat-1', 'req-1', {
        timeout: 5000, priority: 'high'
      });
      expect(result.payload.timeout).toBe(5000);
      expect(result.payload.priority).toBe('high');
    });

    // Contract violations
    it('throws on null message', async () => {
      await expect(sender.sendMessage(null, 'c1', 'r1'))
        .rejects.toThrow('CONTRACT VIOLATION');
    });

    it('throws on empty string message', async () => {
      await expect(sender.sendMessage('', 'c1', 'r1'))
        .rejects.toThrow('CONTRACT VIOLATION');
    });

    it('throws on whitespace-only message', async () => {
      await expect(sender.sendMessage('   ', 'c1', 'r1'))
        .rejects.toThrow('CONTRACT VIOLATION');
    });

    it('throws on null chatId', async () => {
      await expect(sender.sendMessage('hello', null, 'r1'))
        .rejects.toThrow('CONTRACT VIOLATION');
    });

    it('throws on null requestId', async () => {
      await expect(sender.sendMessage('hello', 'c1', null))
        .rejects.toThrow('CONTRACT VIOLATION');
    });

    it('wraps repo errors with [MessageSender] prefix', async () => {
      repo.save.mockRejectedValue(new Error('DB connection lost'));
      await expect(sender.sendMessage('hello', 'c1', 'r1'))
        .rejects.toThrow('[MessageSender] Send failed: DB connection lost');
    });
  });

  describe('validateMessage()', () => {
    let sender;

    beforeEach(() => {
      sender = new MessageSender({ messageRepository: createMockRepo() });
    });

    it('does not throw for valid message', () => {
      expect(() => sender.validateMessage('hello')).not.toThrow();
    });

    it('throws for null', () => {
      expect(() => sender.validateMessage(null)).toThrow('non-empty string');
    });

    it('throws for number', () => {
      expect(() => sender.validateMessage(42)).toThrow('non-empty string');
    });

    it('throws for empty string', () => {
      expect(() => sender.validateMessage('')).toThrow('non-empty string');
    });

    it('throws for whitespace-only', () => {
      expect(() => sender.validateMessage('   ')).toThrow('empty or whitespace');
    });
  });

  describe('getStats()', () => {
    it('reports hasRepository=true', () => {
      const sender = new MessageSender({ messageRepository: createMockRepo() });
      expect(sender.getStats().hasRepository).toBe(true);
    });

    it('reports enableLogging default', () => {
      const sender = new MessageSender({ messageRepository: createMockRepo() });
      expect(sender.getStats().enableLogging).toBe(false);
    });
  });
});
