'use strict';

jest.mock('../../../../../src/core/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
  })
}));

jest.mock('../../../../../src/domain/artifacts/models/Artifact', () => ({
  Artifact: {
    fromPostgreSQLRow: jest.fn(row => ({
      id: row.artifact_id || row.id,
      chatId: row.chat_id,
      toPostgreSQLFormat: () => row
    }))
  }
}));

jest.mock('../../../../../src/domain/artifacts/validators/ArtifactValidator', () => ({
  ArtifactValidator: {
    isValidUUID: jest.fn(v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v))
  }
}));

const { ArtifactRepository } = require('../../../../../src/domain/artifacts/repositories/ArtifactRepository');

function createMockStorageAPI() {
  return {
    saveArtifact: jest.fn().mockResolvedValue({ id: 'uuid-saved' }),
    loadArtifacts: jest.fn().mockResolvedValue([]),
    updateArtifactMessageId: jest.fn().mockResolvedValue({ updated_count: 1 })
  };
}

describe('ArtifactRepository', () => {
  let repo, mockStorage;

  beforeEach(() => {
    jest.useFakeTimers();
    mockStorage = createMockStorageAPI();
    repo = new ArtifactRepository({ storageAPI: mockStorage, cacheMaxSize: 3, cacheTTL: 60000 });
  });

  afterEach(() => {
    repo.dispose();
    jest.useRealTimers();
  });

  describe('constructor', () => {
    it('initializes with empty cache', () => {
      expect(repo.getCacheStats().size).toBe(0);
    });

    it('starts cleanup interval', () => {
      expect(repo.cleanupInterval).toBeTruthy();
    });
  });

  describe('save()', () => {
    it('saves artifact via storageAPI and caches result', async () => {
      const artifact = {
        id: 'art-1',
        chatId: 'chat-1',
        toPostgreSQLFormat: () => ({ artifact_id: 'art-1' }),
        withServerId: jest.fn(id => ({ id: 'art-1', serverId: id, chatId: 'chat-1' }))
      };

      const result = await repo.save(artifact);
      expect(mockStorage.saveArtifact).toHaveBeenCalledWith('chat-1', { artifact_id: 'art-1' });
      expect(artifact.withServerId).toHaveBeenCalledWith('uuid-saved');
      expect(result.serverId).toBe('uuid-saved');
    });

    it('throws when storageAPI is missing', async () => {
      const noStorageRepo = new ArtifactRepository({});
      const artifact = { id: 'a1', toPostgreSQLFormat: () => ({}) };
      await expect(noStorageRepo.save(artifact)).rejects.toThrow('Storage API not available');
      noStorageRepo.dispose();
    });

    it('wraps storage errors', async () => {
      mockStorage.saveArtifact.mockRejectedValue(new Error('DB error'));
      const artifact = { id: 'a1', chatId: 'c1', toPostgreSQLFormat: () => ({}) };
      await expect(repo.save(artifact)).rejects.toThrow('Persistence failed');
    });
  });

  describe('findById()', () => {
    it('returns cached artifact', async () => {
      // Manually cache an artifact
      repo.cache.set('art-1', { artifact: { id: 'art-1' }, cachedAt: Date.now(), accessedAt: Date.now() });
      const result = await repo.findById('art-1');
      expect(result.id).toBe('art-1');
    });

    it('throws when artifact not in cache', async () => {
      await expect(repo.findById('nonexistent')).rejects.toThrow('not found in cache');
    });

    it('expires cached entries beyond TTL', async () => {
      repo.cache.set('art-1', {
        artifact: { id: 'art-1' },
        cachedAt: Date.now() - 120000, // 2 minutes ago, beyond 60s TTL
        accessedAt: Date.now()
      });
      await expect(repo.findById('art-1')).rejects.toThrow('not found in cache');
    });
  });

  describe('findByChatId()', () => {
    it('loads artifacts from storageAPI', async () => {
      mockStorage.loadArtifacts.mockResolvedValue([
        { id: 'row-1', artifact_id: 'a1', chat_id: 'c1' },
        { id: 'row-2', artifact_id: 'a2', chat_id: 'c1' }
      ]);

      const result = await repo.findByChatId('chat-1');
      expect(mockStorage.loadArtifacts).toHaveBeenCalledWith('chat-1');
      expect(result).toHaveLength(2);
    });

    it('caches loaded artifacts', async () => {
      mockStorage.loadArtifacts.mockResolvedValue([
        { id: 'row-1', artifact_id: 'a1', chat_id: 'c1' }
      ]);

      await repo.findByChatId('chat-1');
      expect(repo.getCacheStats().size).toBe(1);
    });

    it('wraps storage errors', async () => {
      mockStorage.loadArtifacts.mockRejectedValue(new Error('DB error'));
      await expect(repo.findByChatId('chat-1')).rejects.toThrow('Load failed');
    });
  });

  describe('findByMessageId() / findByCorrelationId()', () => {
    it('findByMessageId returns empty array', async () => {
      expect(await repo.findByMessageId('msg-1')).toEqual([]);
    });

    it('findByCorrelationId returns empty array', async () => {
      expect(await repo.findByCorrelationId('corr-1')).toEqual([]);
    });
  });

  describe('updateMessageLink()', () => {
    it('updates via storageAPI', async () => {
      const validUUID = '550e8400-e29b-41d4-a716-446655440000';
      const result = await repo.updateMessageLink('art-1', validUUID);
      expect(result).toBe(1);
      expect(mockStorage.updateArtifactMessageId).toHaveBeenCalledWith('art-1', validUUID, null);
    });

    it('throws on invalid UUID', async () => {
      await expect(repo.updateMessageLink('art-1', 'not-a-uuid')).rejects.toThrow('Invalid message UUID');
    });

    it('throws on missing artifactId', async () => {
      await expect(repo.updateMessageLink(null, '550e8400-e29b-41d4-a716-446655440000'))
        .rejects.toThrow('artifactId is required');
    });
  });

  describe('updateChatArtifactsMessageLink()', () => {
    const validChat = '550e8400-e29b-41d4-a716-446655440000';
    const validMsg = '660e8400-e29b-41d4-a716-446655440000';

    it('updates via storageAPI', async () => {
      const result = await repo.updateChatArtifactsMessageLink(validChat, null, validMsg);
      expect(result).toBe(1);
    });

    it('throws on invalid chat UUID', async () => {
      await expect(repo.updateChatArtifactsMessageLink('bad', null, validMsg))
        .rejects.toThrow('Invalid chat UUID');
    });

    it('throws on invalid message UUID', async () => {
      await expect(repo.updateChatArtifactsMessageLink(validChat, null, 'bad'))
        .rejects.toThrow('Invalid message UUID');
    });
  });

  describe('delete()', () => {
    it('returns false (not supported)', async () => {
      expect(await repo.delete('art-1')).toBe(false);
    });
  });

  describe('cache management', () => {
    it('enforces LRU eviction at cacheMaxSize', () => {
      repo._cacheArtifact({ id: 'a1' });
      repo._cacheArtifact({ id: 'a2' });
      repo._cacheArtifact({ id: 'a3' });
      // At max (3), adding one more should evict oldest
      repo._cacheArtifact({ id: 'a4' });
      expect(repo.cache.size).toBe(3);
      expect(repo.cache.has('a1')).toBe(false);
    });

    it('clearCache() clears all entries', () => {
      repo._cacheArtifact({ id: 'a1' });
      repo.clearCache();
      expect(repo.getCacheStats().size).toBe(0);
    });

    it('getCacheStats() returns correct values', () => {
      repo._cacheArtifact({ id: 'a1' });
      const stats = repo.getCacheStats();
      expect(stats.size).toBe(1);
      expect(stats.maxSize).toBe(3);
      expect(stats.avgAge).toBeGreaterThanOrEqual(0);
    });
  });

  describe('dispose()', () => {
    it('clears interval and cache', () => {
      repo._cacheArtifact({ id: 'a1' });
      repo.dispose();
      expect(repo.cleanupInterval).toBeNull();
      expect(repo.cache.size).toBe(0);
    });

    it('is safe to call twice', () => {
      repo.dispose();
      expect(() => repo.dispose()).not.toThrow();
    });
  });
});
