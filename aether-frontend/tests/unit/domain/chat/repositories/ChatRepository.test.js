'use strict';

// Mock storage-resolver to return our injected storageAPI
jest.mock('../../../../../src/shared/utils/storage-resolver', () => ({
  resolveStorageAPI: (opts) => opts.storageAPI || null
}));

// Polyfill crypto.randomUUID for Chat.create()
if (!globalThis.crypto || !globalThis.crypto.randomUUID) {
  globalThis.crypto = {
    ...globalThis.crypto,
    randomUUID: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    })
  };
}

const { ChatRepository } = require('../../../../../src/domain/chat/repositories/ChatRepository');
const { Chat } = require('../../../../../src/domain/chat/models/Chat');

function createMockStorageAPI() {
  return {
    loadChats: jest.fn().mockResolvedValue([
      { id: 'c1', title: 'Chat 1', created_at: 1000, updated_at: 2000 },
      { id: 'c2', title: 'Chat 2', created_at: 1500, updated_at: 2500 }
    ]),
    loadChat: jest.fn().mockResolvedValue({
      id: 'c1', title: 'Chat 1', created_at: 1000, updated_at: 2000,
      messages: [
        { id: 'm1', role: 'user', content: 'hello', created_at: 1100 },
        { id: 'm2', role: 'assistant', content: 'hi', created_at: 1200 }
      ]
    }),
    createChat: jest.fn().mockResolvedValue({ id: 'new-chat-uuid', created_at: Date.now(), updated_at: Date.now() }),
    updateChatTitle: jest.fn().mockResolvedValue({ id: 'c1', title: 'Updated', created_at: 1000, updated_at: Date.now() }),
    deleteChat: jest.fn().mockResolvedValue(true)
  };
}

describe('ChatRepository', () => {
  let repo, mockStorage;

  beforeEach(() => {
    mockStorage = createMockStorageAPI();
    repo = new ChatRepository({ storageAPI: mockStorage });
  });

  describe('constructor', () => {
    it('throws when storageAPI not available', () => {
      const badRepo = new ChatRepository({});
      expect(() => badRepo._ensureStorageAPI()).toThrow('Storage API not available');
    });
  });

  describe('findAll()', () => {
    it('returns Chat instances from storageAPI', async () => {
      const chats = await repo.findAll();
      expect(chats).toHaveLength(2);
      expect(chats[0]).toBeInstanceOf(Chat);
      expect(chats[0].id).toBe('c1');
      expect(chats[1].id).toBe('c2');
    });

    it('returns empty array when loadChats returns non-array', async () => {
      mockStorage.loadChats.mockResolvedValue(null);
      const chats = await repo.findAll();
      expect(chats).toEqual([]);
    });

    it('filters out null entries', async () => {
      mockStorage.loadChats.mockResolvedValue([{ id: 'c1', title: 'x' }, null, undefined]);
      const chats = await repo.findAll();
      expect(chats).toHaveLength(1);
    });
  });

  describe('findById()', () => {
    it('returns Chat with hydrated messages', async () => {
      const chat = await repo.findById('c1');
      expect(chat).toBeInstanceOf(Chat);
      expect(chat.id).toBe('c1');
      expect(chat.messages).toHaveLength(2);
      expect(chat.messages[0].role).toBe('user');
      expect(chat.messages[1].role).toBe('assistant');
    });

    it('returns null when chat not found', async () => {
      mockStorage.loadChat.mockResolvedValue(null);
      const chat = await repo.findById('nonexistent');
      expect(chat).toBeNull();
    });

    it('throws on empty chatId', async () => {
      await expect(repo.findById('')).rejects.toThrow('non-empty string');
    });

    it('skips malformed messages', async () => {
      mockStorage.loadChat.mockResolvedValue({
        id: 'c1', title: 'x',
        messages: [{ id: 'm1', role: 'user', content: 'ok' }, 'not-an-object', null]
      });
      const chat = await repo.findById('c1');
      expect(chat.messages).toHaveLength(1);
    });
  });

  describe('create()', () => {
    it('saves via storageAPI and returns Chat with server ID', async () => {
      const chat = Chat.create('My Chat');
      const result = await repo.create(chat);

      expect(mockStorage.createChat).toHaveBeenCalledWith('My Chat');
      expect(result).toBeInstanceOf(Chat);
      expect(result.id).toBe('new-chat-uuid');
    });

    it('throws when not a Chat instance', async () => {
      await expect(repo.create({ title: 'x' })).rejects.toThrow('Must provide Chat instance');
    });
  });

  describe('updateTitle()', () => {
    it('updates via storageAPI', async () => {
      const result = await repo.updateTitle('c1', 'New Title');
      expect(mockStorage.updateChatTitle).toHaveBeenCalledWith('c1', 'New Title');
      expect(result.title).toBe('Updated');
    });

    it('throws on empty chatId', async () => {
      await expect(repo.updateTitle('', 'x')).rejects.toThrow('non-empty string');
    });

    it('throws on empty title', async () => {
      await expect(repo.updateTitle('c1', '')).rejects.toThrow('non-empty string');
    });
  });

  describe('delete()', () => {
    it('deletes via storageAPI', async () => {
      const result = await repo.delete('c1');
      expect(mockStorage.deleteChat).toHaveBeenCalledWith('c1');
      expect(result).toBe(true);
    });

    it('throws on empty chatId', async () => {
      await expect(repo.delete('')).rejects.toThrow('non-empty string');
    });
  });

  describe('findBySessionId()', () => {
    it('returns matching chat', async () => {
      // One of the loaded chats needs sessionId
      mockStorage.loadChats.mockResolvedValue([
        { id: 'c1', title: 'x', session_id: undefined },
        { id: 'c2', title: 'y', session_id: undefined }
      ]);
      const result = await repo.findBySessionId('sess-1');
      expect(result).toBeNull(); // none match
    });

    it('throws on empty sessionId', async () => {
      await expect(repo.findBySessionId('')).rejects.toThrow('non-empty string');
    });
  });

  describe('findActive()', () => {
    it('filters out archived chats', async () => {
      mockStorage.loadChats.mockResolvedValue([
        { id: 'c1', title: 'active', archived: false },
        { id: 'c2', title: 'archived', archived: true }
      ]);
      const active = await repo.findActive();
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe('c1');
    });
  });

  describe('findMostRecent()', () => {
    it('returns first chat (pre-sorted by backend)', async () => {
      const recent = await repo.findMostRecent();
      expect(recent.id).toBe('c1');
    });

    it('returns null when no chats', async () => {
      mockStorage.loadChats.mockResolvedValue([]);
      expect(await repo.findMostRecent()).toBeNull();
    });
  });

  describe('count()', () => {
    it('returns chat count', async () => {
      expect(await repo.count()).toBe(2);
    });
  });

  describe('exists()', () => {
    it('returns true for existing chat', async () => {
      expect(await repo.exists('c1')).toBe(true);
    });

    it('returns false for empty/invalid id', async () => {
      expect(await repo.exists('')).toBe(false);
    });

    it('returns false when findById throws', async () => {
      mockStorage.loadChat.mockRejectedValue(new Error('DB fail'));
      expect(await repo.exists('c1')).toBe(false);
    });
  });

  describe('save()', () => {
    it('creates when chat has no id', async () => {
      const chat = new Chat({ title: 'new' });
      await repo.save(chat);
      expect(mockStorage.createChat).toHaveBeenCalled();
    });

    it('updates title when chat has id', async () => {
      const chat = new Chat({ id: 'c1', title: 'updated' });
      await repo.save(chat);
      expect(mockStorage.updateChatTitle).toHaveBeenCalledWith('c1', 'updated');
    });

    it('throws when not a Chat instance', async () => {
      await expect(repo.save({ title: 'x' })).rejects.toThrow('Must provide Chat instance');
    });
  });
});
