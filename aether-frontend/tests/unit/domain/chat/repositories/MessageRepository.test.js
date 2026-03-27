'use strict';

// Mock storage-resolver to return our injected storageAPI
jest.mock('../../../../../src/shared/utils/storage-resolver', () => ({
  resolveStorageAPI: (opts) => opts.storageAPI || null
}));

const { MessageRepository } = require('../../../../../src/domain/chat/repositories/MessageRepository');
const { Message } = require('../../../../../src/domain/chat/models/Message');

function createMockStorageAPI() {
  return {
    loadMessages: jest.fn().mockResolvedValue([
      { id: 'm1', role: 'user', content: 'hello', created_at: 1000 },
      { id: 'm2', role: 'assistant', content: 'hi', created_at: 1100, tokens_used: 50 },
      { id: 'm3', role: 'user', content: 'bye', created_at: 1200 }
    ]),
    saveMessage: jest.fn().mockResolvedValue({ id: 'saved-uuid', timestamp: Date.now() })
  };
}

describe('MessageRepository', () => {
  let repo, mockStorage;

  beforeEach(() => {
    mockStorage = createMockStorageAPI();
    repo = new MessageRepository({ storageAPI: mockStorage });
  });

  describe('constructor', () => {
    it('throws when storageAPI not available', () => {
      const badRepo = new MessageRepository({});
      expect(() => badRepo._ensureStorageAPI()).toThrow('Storage API not available');
    });
  });

  describe('findByChatId()', () => {
    it('returns Message instances from storageAPI', async () => {
      const messages = await repo.findByChatId('c1');
      expect(messages).toHaveLength(3);
      expect(messages[0]).toBeInstanceOf(Message);
      expect(messages[0].id).toBe('m1');
      expect(messages[0].role).toBe('user');
    });

    it('throws on empty chatId', async () => {
      await expect(repo.findByChatId('')).rejects.toThrow('non-empty string');
    });

    it('throws on null chatId', async () => {
      await expect(repo.findByChatId(null)).rejects.toThrow('non-empty string');
    });
  });

  describe('save()', () => {
    it('saves Message via storageAPI and returns cloned Message with server ID', async () => {
      const msg = Message.createUser('hello world', 'c1');
      msg.correlationId = 'corr-1';
      msg.llmModel = 'gpt-4';

      const result = await repo.save(msg, 'c1');
      expect(mockStorage.saveMessage).toHaveBeenCalledWith('c1', expect.objectContaining({
        role: 'user',
        content: 'hello world',
        correlation_id: 'corr-1',
        llm_model: 'gpt-4'
      }));
      expect(result).toBeInstanceOf(Message);
      expect(result.id).toBe('saved-uuid');
      expect(result.chatId).toBe('c1');
    });

    it('uses message.chatId when chatId param not provided', async () => {
      const msg = Message.createUser('test');
      msg.chatId = 'c1';

      await repo.save(msg);
      expect(mockStorage.saveMessage).toHaveBeenCalledWith('c1', expect.any(Object));
    });

    it('throws when not a Message instance', async () => {
      await expect(repo.save({ content: 'x' }, 'c1')).rejects.toThrow('Must provide Message instance');
    });

    it('throws when no chatId available', async () => {
      const msg = Message.createUser('test');
      // msg.chatId is null, no chatId param
      await expect(repo.save(msg)).rejects.toThrow('Chat ID must be provided');
    });

    it('does NOT mutate original message', async () => {
      const msg = Message.createUser('hello', 'c1');
      const originalId = msg.id;
      await repo.save(msg, 'c1');
      expect(msg.id).toBe(originalId); // unchanged
    });
  });

  describe('saveBatch()', () => {
    it('saves all messages in parallel', async () => {
      const msgs = [
        Message.createUser('a', 'c1'),
        Message.createUser('b', 'c1')
      ];
      const result = await repo.saveBatch(msgs, 'c1');
      expect(result).toHaveLength(2);
      expect(mockStorage.saveMessage).toHaveBeenCalledTimes(2);
    });

    it('throws on non-array', async () => {
      await expect(repo.saveBatch('not array', 'c1')).rejects.toThrow('must be an array');
    });

    it('throws on empty chatId', async () => {
      await expect(repo.saveBatch([], '')).rejects.toThrow('non-empty string');
    });
  });

  describe('findByRole()', () => {
    it('filters by user role', async () => {
      const msgs = await repo.findByRole('c1', 'user');
      expect(msgs).toHaveLength(2);
      expect(msgs.every(m => m.role === 'user')).toBe(true);
    });

    it('filters by assistant role', async () => {
      const msgs = await repo.findByRole('c1', 'assistant');
      expect(msgs).toHaveLength(1);
    });

    it('throws on empty role', async () => {
      await expect(repo.findByRole('c1', '')).rejects.toThrow('non-empty string');
    });
  });

  describe('findUserMessages() / findAssistantMessages()', () => {
    it('returns user messages', async () => {
      const msgs = await repo.findUserMessages('c1');
      expect(msgs.every(m => m.role === 'user')).toBe(true);
    });

    it('returns assistant messages', async () => {
      const msgs = await repo.findAssistantMessages('c1');
      expect(msgs.every(m => m.role === 'assistant')).toBe(true);
    });
  });

  describe('findByCorrelationId()', () => {
    it('filters by correlationId', async () => {
      mockStorage.loadMessages.mockResolvedValue([
        { id: 'm1', role: 'user', content: 'x', correlation_id: 'corr-1' },
        { id: 'm2', role: 'assistant', content: 'y', correlation_id: 'corr-1' },
        { id: 'm3', role: 'user', content: 'z', correlation_id: 'corr-2' }
      ]);
      const msgs = await repo.findByCorrelationId('c1', 'corr-1');
      expect(msgs).toHaveLength(2);
    });

    it('throws on empty correlationId', async () => {
      await expect(repo.findByCorrelationId('c1', '')).rejects.toThrow('non-empty string');
    });
  });

  describe('findRecent()', () => {
    it('returns last N messages', async () => {
      const msgs = await repo.findRecent('c1', 2);
      expect(msgs).toHaveLength(2);
      // Last 2 from the 3 loaded
      expect(msgs[0].id).toBe('m2');
      expect(msgs[1].id).toBe('m3');
    });

    it('throws on invalid limit', async () => {
      await expect(repo.findRecent('c1', 0)).rejects.toThrow('positive integer');
      await expect(repo.findRecent('c1', -1)).rejects.toThrow('positive integer');
      await expect(repo.findRecent('c1', 1.5)).rejects.toThrow('positive integer');
    });
  });

  describe('findByTimeRange()', () => {
    it('filters by timestamp range', async () => {
      const msgs = await repo.findByTimeRange('c1', 1050, 1150);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].id).toBe('m2');
    });

    it('throws when start > end', async () => {
      await expect(repo.findByTimeRange('c1', 2000, 1000)).rejects.toThrow('Start time cannot be after end time');
    });

    it('throws on non-number', async () => {
      await expect(repo.findByTimeRange('c1', 'now', 'later')).rejects.toThrow('must be numbers');
    });
  });

  describe('count()', () => {
    it('returns message count', async () => {
      expect(await repo.count('c1')).toBe(3);
    });
  });

  describe('getTotalTokens()', () => {
    it('sums tokens_used across messages', async () => {
      const tokens = await repo.getTotalTokens('c1');
      expect(tokens).toBe(50); // only m2 has tokens_used: 50
    });
  });

  describe('getStatistics()', () => {
    it('returns comprehensive stats', async () => {
      const stats = await repo.getStatistics('c1');
      expect(stats.total).toBe(3);
      expect(stats.user).toBe(2);
      expect(stats.assistant).toBe(1);
      expect(stats.system).toBe(0);
      expect(stats.totalTokens).toBe(50);
    });
  });

  // =========================================================================
  // countByRole
  // =========================================================================
  describe('countByRole()', () => {
    it('counts user messages', async () => {
      expect(await repo.countByRole('c1', 'user')).toBe(2);
    });

    it('counts assistant messages', async () => {
      expect(await repo.countByRole('c1', 'assistant')).toBe(1);
    });

    it('returns 0 for non-existent role', async () => {
      expect(await repo.countByRole('c1', 'system')).toBe(0);
    });
  });

  describe('findWithArtifacts()', () => {
    // Note: artifact_ids are stored in a separate messageArtifactsIndex (not in message rows).
    // Message.fromPostgresRow does NOT map artifact_ids. The ChatSessionManager enriches
    // messages with artifactIds after loading. So we mock findByChatId to return
    // pre-enriched Message objects to test the filtering logic.
    it('returns only messages with artifacts', async () => {
      const m1 = new Message({ id: 'm1', role: 'user', content: 'x', artifactIds: ['a1'] });
      const m2 = new Message({ id: 'm2', role: 'assistant', content: 'y' });
      const m3 = new Message({ id: 'm3', role: 'user', content: 'z', artifactIds: ['a2', 'a3'] });
      jest.spyOn(repo, 'findByChatId').mockResolvedValue([m1, m2, m3]);

      const msgs = await repo.findWithArtifacts('c1');
      expect(msgs).toHaveLength(2);
      expect(msgs[0].id).toBe('m1');
      expect(msgs[0].artifactIds).toEqual(['a1']);
      expect(msgs[1].id).toBe('m3');
      expect(msgs[1].artifactIds).toEqual(['a2', 'a3']);
    });

    it('returns empty when no messages have artifacts', async () => {
      const m1 = new Message({ id: 'm1', role: 'user', content: 'x' });
      jest.spyOn(repo, 'findByChatId').mockResolvedValue([m1]);
      const msgs = await repo.findWithArtifacts('c1');
      expect(msgs).toHaveLength(0);
    });
  });

  // =========================================================================
  // Error paths (catch blocks in every method)
  // =========================================================================
  describe('error paths', () => {
    beforeEach(() => {
      mockStorage.loadMessages.mockRejectedValue(new Error('storage down'));
    });

    it('findUserMessages propagates error', async () => {
      await expect(repo.findUserMessages('c1')).rejects.toThrow('storage down');
    });

    it('findAssistantMessages propagates error', async () => {
      await expect(repo.findAssistantMessages('c1')).rejects.toThrow('storage down');
    });

    it('findByCorrelationId propagates error', async () => {
      await expect(repo.findByCorrelationId('c1', 'corr-1')).rejects.toThrow('storage down');
    });

    it('findWithArtifacts propagates error', async () => {
      await expect(repo.findWithArtifacts('c1')).rejects.toThrow('storage down');
    });

    it('findByTimeRange propagates error', async () => {
      await expect(repo.findByTimeRange('c1', 100, 200)).rejects.toThrow('storage down');
    });

    it('findRecent propagates error', async () => {
      await expect(repo.findRecent('c1', 5)).rejects.toThrow('storage down');
    });

    it('count propagates error', async () => {
      await expect(repo.count('c1')).rejects.toThrow('storage down');
    });

    it('countByRole propagates error', async () => {
      await expect(repo.countByRole('c1', 'user')).rejects.toThrow('storage down');
    });

    it('getTotalTokens propagates error', async () => {
      await expect(repo.getTotalTokens('c1')).rejects.toThrow('storage down');
    });

    it('getStatistics propagates error', async () => {
      await expect(repo.getStatistics('c1')).rejects.toThrow('storage down');
    });
  });
});
