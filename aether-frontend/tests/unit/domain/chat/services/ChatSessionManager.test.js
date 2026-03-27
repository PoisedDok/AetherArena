'use strict';

jest.mock('../../../../../src/core/utils/logger', () => ({
  createDomainLogger: () => ({ child: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }) })
}));

// Chat.create() calls crypto.randomUUID - polyfill for Node test env
if (!globalThis.crypto || !globalThis.crypto.randomUUID) {
  globalThis.crypto = {
    ...globalThis.crypto,
    randomUUID: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    })
  };
}

const { ChatSessionManager } = require('../../../../../src/domain/chat/services/ChatSessionManager');
const { Chat } = require('../../../../../src/domain/chat/models/Chat');

function createDeps(overrides = {}) {
  return {
    chatRepository: {
      findById: jest.fn().mockResolvedValue(Chat.fromPostgresRow({
        id: 'chat-1', title: 'Test Chat', created_at: Date.now()
      }, [])),
      create: jest.fn().mockImplementation((chat) => Promise.resolve(
        chat.clone({ id: 'new-chat-id', createdAt: Date.now() })
      )),
      delete: jest.fn().mockResolvedValue(true),
      findAll: jest.fn().mockResolvedValue([
        Chat.fromPostgresRow({ id: 'chat-1', title: 'Chat 1' }),
        Chat.fromPostgresRow({ id: 'chat-2', title: 'Chat 2' })
      ]),
      updateTitle: jest.fn().mockImplementation((chatId, title) => Promise.resolve(
        Chat.fromPostgresRow({ id: chatId, title })
      ))
    },
    artifactRepository: {
      findByChatId: jest.fn().mockResolvedValue([])
    },
    traceabilityService: {
      loadForChat: jest.fn().mockResolvedValue(undefined),
      registerMessage: jest.fn(),
      registerArtifact: jest.fn()
    },
    eventBus: { emit: jest.fn() },
    errorTracker: { captureException: jest.fn() },
    ...overrides
  };
}

describe('ChatSessionManager', () => {
  describe('constructor', () => {
    it('throws without chatRepository', () => {
      expect(() => new ChatSessionManager({
        artifactRepository: {}, eventBus: {}
      })).toThrow('ChatRepository is required');
    });

    it('throws without artifactRepository', () => {
      expect(() => new ChatSessionManager({
        chatRepository: {}, eventBus: {}
      })).toThrow('ArtifactRepository is required');
    });

    it('throws without eventBus', () => {
      expect(() => new ChatSessionManager({
        chatRepository: {}, artifactRepository: {}
      })).toThrow('EventBus is required');
    });

    it('initializes with null currentChatId', () => {
      const mgr = new ChatSessionManager(createDeps());
      expect(mgr.getCurrentChatId()).toBeNull();
    });
  });

  describe('createChat()', () => {
    it('creates via repository and emits event', async () => {
      const deps = createDeps();
      const mgr = new ChatSessionManager(deps);

      const result = await mgr.createChat('My Chat');
      expect(deps.chatRepository.create).toHaveBeenCalledWith(expect.any(Chat));
      expect(deps.eventBus.emit).toHaveBeenCalledWith('chat:created', expect.objectContaining({
        chatId: 'new-chat-id'
      }));
      expect(result.id).toBe('new-chat-id');
    });

    it('uses default title when none provided', async () => {
      const deps = createDeps();
      const mgr = new ChatSessionManager(deps);
      await mgr.createChat();
      const chatArg = deps.chatRepository.create.mock.calls[0][0];
      expect(chatArg.title).toBe('New Chat');
    });

    it('throws on non-string title', async () => {
      const mgr = new ChatSessionManager(createDeps());
      await expect(mgr.createChat(42)).rejects.toThrow('title must be a string');
    });

    it('reports to errorTracker on failure', async () => {
      const deps = createDeps();
      deps.chatRepository.create.mockRejectedValue(new Error('DB fail'));
      const mgr = new ChatSessionManager(deps);

      await expect(mgr.createChat()).rejects.toThrow('DB fail');
      expect(deps.errorTracker.captureException).toHaveBeenCalled();
    });
  });

  describe('switchToChat()', () => {
    it('loads chat and artifacts, sets currentChatId', async () => {
      const deps = createDeps();
      const mgr = new ChatSessionManager(deps);

      const result = await mgr.switchToChat('chat-1');
      expect(deps.chatRepository.findById).toHaveBeenCalledWith('chat-1');
      expect(deps.artifactRepository.findByChatId).toHaveBeenCalledWith('chat-1');
      expect(mgr.getCurrentChatId()).toBe('chat-1');
      expect(result.chat).toBeTruthy();
      expect(result.artifacts).toEqual([]);
    });

    it('emits chat:switched event with counts', async () => {
      const deps = createDeps();
      const mgr = new ChatSessionManager(deps);

      await mgr.switchToChat('chat-1');
      expect(deps.eventBus.emit).toHaveBeenCalledWith('chat:switched', expect.objectContaining({
        chatId: 'chat-1',
        artifactCount: 0
      }));
    });

    it('registers with traceabilityService when available', async () => {
      const deps = createDeps();
      const mgr = new ChatSessionManager(deps);

      await mgr.switchToChat('chat-1');
      expect(deps.traceabilityService.loadForChat).toHaveBeenCalledWith('chat-1');
    });

    it('handles traceability errors gracefully', async () => {
      const deps = createDeps();
      deps.traceabilityService.loadForChat.mockRejectedValue(new Error('trace fail'));
      const mgr = new ChatSessionManager(deps);

      const result = await mgr.switchToChat('chat-1');
      expect(result.chat).toBeTruthy(); // still succeeds
    });

    it('throws when chat not found', async () => {
      const deps = createDeps();
      deps.chatRepository.findById.mockResolvedValue(null);
      const mgr = new ChatSessionManager(deps);

      await expect(mgr.switchToChat('nonexistent')).rejects.toThrow('not found');
    });

    it('throws on null chatId', async () => {
      const mgr = new ChatSessionManager(createDeps());
      await expect(mgr.switchToChat(null)).rejects.toThrow('chatId is required');
    });

    it('throws on empty chatId', async () => {
      const mgr = new ChatSessionManager(createDeps());
      await expect(mgr.switchToChat('')).rejects.toThrow('chatId is required');
    });
  });

  describe('deleteChat()', () => {
    it('deletes via repository and emits event', async () => {
      const deps = createDeps();
      const mgr = new ChatSessionManager(deps);

      await mgr.deleteChat('chat-1');
      expect(deps.chatRepository.delete).toHaveBeenCalledWith('chat-1');
      expect(deps.eventBus.emit).toHaveBeenCalledWith('chat:deleted', { chatId: 'chat-1' });
    });

    it('clears currentChatId if deleting current chat', async () => {
      const deps = createDeps();
      const mgr = new ChatSessionManager(deps);

      await mgr.switchToChat('chat-1');
      expect(mgr.getCurrentChatId()).toBe('chat-1');

      await mgr.deleteChat('chat-1');
      expect(mgr.getCurrentChatId()).toBeNull();
    });

    it('preserves currentChatId when deleting different chat', async () => {
      const deps = createDeps();
      const mgr = new ChatSessionManager(deps);

      await mgr.switchToChat('chat-1');
      await mgr.deleteChat('chat-2');
      expect(mgr.getCurrentChatId()).toBe('chat-1');
    });

    it('throws on null chatId', async () => {
      const mgr = new ChatSessionManager(createDeps());
      await expect(mgr.deleteChat(null)).rejects.toThrow('chatId is required');
    });
  });

  describe('loadCurrentChat()', () => {
    it('switches to most recent chat when chats exist', async () => {
      const deps = createDeps();
      const mgr = new ChatSessionManager(deps);

      await mgr.loadCurrentChat();
      expect(deps.chatRepository.findAll).toHaveBeenCalled();
      expect(deps.chatRepository.findById).toHaveBeenCalledWith('chat-1');
    });

    it('creates new chat when no chats exist', async () => {
      const deps = createDeps();
      deps.chatRepository.findAll.mockResolvedValue([]);
      // After creating, switchToChat is called with the new ID
      deps.chatRepository.findById.mockResolvedValue(
        Chat.fromPostgresRow({ id: 'new-chat-id', title: 'New Chat' }, [])
      );
      const mgr = new ChatSessionManager(deps);

      await mgr.loadCurrentChat();
      expect(deps.chatRepository.create).toHaveBeenCalled();
    });
  });

  describe('getAllChats()', () => {
    it('returns all chats from repository', async () => {
      const deps = createDeps();
      const mgr = new ChatSessionManager(deps);

      const chats = await mgr.getAllChats();
      expect(chats).toHaveLength(2);
    });
  });

  describe('updateChatTitle()', () => {
    it('updates via repository and emits event', async () => {
      const deps = createDeps();
      const mgr = new ChatSessionManager(deps);

      const result = await mgr.updateChatTitle('chat-1', 'New Title');
      expect(deps.chatRepository.updateTitle).toHaveBeenCalledWith('chat-1', 'New Title');
      expect(deps.eventBus.emit).toHaveBeenCalledWith('chat:title-updated', {
        chatId: 'chat-1', title: 'New Title'
      });
      expect(result.title).toBe('New Title');
    });

    it('throws on null chatId', async () => {
      const mgr = new ChatSessionManager(createDeps());
      await expect(mgr.updateChatTitle(null, 'x')).rejects.toThrow('chatId is required');
    });

    it('throws on null title', async () => {
      const mgr = new ChatSessionManager(createDeps());
      await expect(mgr.updateChatTitle('c1', null)).rejects.toThrow('title is required');
    });
  });

  describe('isCurrentChat()', () => {
    it('returns false when no chat loaded', () => {
      const mgr = new ChatSessionManager(createDeps());
      expect(mgr.isCurrentChat('chat-1')).toBe(false);
    });

    it('returns true for current chat', async () => {
      const mgr = new ChatSessionManager(createDeps());
      await mgr.switchToChat('chat-1');
      expect(mgr.isCurrentChat('chat-1')).toBe(true);
    });

    it('returns false for different chat', async () => {
      const mgr = new ChatSessionManager(createDeps());
      await mgr.switchToChat('chat-1');
      expect(mgr.isCurrentChat('chat-2')).toBe(false);
    });
  });

  describe('getStats()', () => {
    it('returns dependency status', () => {
      const mgr = new ChatSessionManager(createDeps());
      const stats = mgr.getStats();
      expect(stats.hasChatRepository).toBe(true);
      expect(stats.hasArtifactRepository).toBe(true);
      expect(stats.hasTraceabilityService).toBe(true);
      expect(stats.hasEventBus).toBe(true);
      expect(stats.hasErrorTracker).toBe(true);
      expect(stats.currentChatId).toBeNull();
    });
  });

  // =========================================================================
  // Error paths (coverage for catch blocks with errorTracker)
  // =========================================================================
  describe('deleteChat() error path', () => {
    it('reports to errorTracker on repository failure', async () => {
      const deps = createDeps();
      deps.chatRepository.delete.mockRejectedValue(new Error('DB fail'));
      const mgr = new ChatSessionManager(deps);

      await expect(mgr.deleteChat('chat-1')).rejects.toThrow('DB fail');
      expect(deps.errorTracker.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        'ChatSessionManager.deleteChat',
        expect.objectContaining({ chatId: 'chat-1' })
      );
    });
  });

  describe('loadCurrentChat() error path', () => {
    it('reports to errorTracker on failure', async () => {
      const deps = createDeps();
      deps.chatRepository.findAll.mockRejectedValue(new Error('findAll fail'));
      const mgr = new ChatSessionManager(deps);

      await expect(mgr.loadCurrentChat()).rejects.toThrow('findAll fail');
      expect(deps.errorTracker.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        'ChatSessionManager.loadCurrentChat'
      );
    });
  });

  describe('getFallbackChat()', () => {
    it('switches to first available chat', async () => {
      const deps = createDeps();
      const mgr = new ChatSessionManager(deps);

      const result = await mgr.getFallbackChat('deleted-chat');
      expect(deps.chatRepository.findAll).toHaveBeenCalled();
      expect(deps.chatRepository.findById).toHaveBeenCalledWith('chat-1');
      expect(result.chat).not.toBeNull();
      expect(result.chat.id).toBe('chat-1');
    });

    it('returns null when no chats remain', async () => {
      const deps = createDeps();
      deps.chatRepository.findAll.mockResolvedValue([]);
      const mgr = new ChatSessionManager(deps);

      const result = await mgr.getFallbackChat('deleted-chat');
      expect(deps.chatRepository.create).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it('throws and logs on failure', async () => {
      const deps = createDeps();
      deps.chatRepository.findAll.mockRejectedValue(new Error('fallback fail'));
      const mgr = new ChatSessionManager(deps);

      await expect(mgr.getFallbackChat('x')).rejects.toThrow('fallback fail');
    });
  });

  describe('getAllChats() error path', () => {
    it('reports to errorTracker on failure', async () => {
      const deps = createDeps();
      deps.chatRepository.findAll.mockRejectedValue(new Error('load fail'));
      const mgr = new ChatSessionManager(deps);

      await expect(mgr.getAllChats()).rejects.toThrow('load fail');
      expect(deps.errorTracker.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        'ChatSessionManager.getAllChats'
      );
    });
  });

  describe('updateChatTitle() error path', () => {
    it('reports to errorTracker on repository failure', async () => {
      const deps = createDeps();
      deps.chatRepository.updateTitle.mockRejectedValue(new Error('update fail'));
      const mgr = new ChatSessionManager(deps);

      await expect(mgr.updateChatTitle('c1', 'title')).rejects.toThrow('update fail');
      expect(deps.errorTracker.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        'ChatSessionManager.updateChatTitle',
        expect.objectContaining({ chatId: 'c1', title: 'title' })
      );
    });
  });

  describe('switchToChat() error path', () => {
    it('reports to errorTracker on repository failure', async () => {
      const deps = createDeps();
      deps.chatRepository.findById.mockRejectedValue(new Error('switch fail'));
      const mgr = new ChatSessionManager(deps);

      await expect(mgr.switchToChat('c1')).rejects.toThrow('switch fail');
      expect(deps.errorTracker.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        'ChatSessionManager.switchToChat',
        expect.objectContaining({ chatId: 'c1' })
      );
    });
  });
});
