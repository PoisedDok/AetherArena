'use strict';

// ---------------------------------------------------------------------------
// Mocks — hoisted before require()
// ---------------------------------------------------------------------------

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    child: jest.fn(function () { return this; }),
  })),
}));

jest.mock('../../../src/application/chat/ChatServices', () => {
  return {
    ChatServices: jest.fn().mockImplementation((opts) => ({
      chatService: opts.chatService || {
        getOrCreateDefaultChat: jest.fn(),
        loadChatWithMessages: jest.fn(),
        createChat: jest.fn(),
        chatExists: jest.fn(),
        updateChatTitle: jest.fn(),
        loadAllChats: jest.fn(),
      },
      messageService: opts.messageService || {
        saveMessage: jest.fn(),
      },
      createDomainMessage: jest.fn((payload, chatId) => ({
        ...payload,
        chatId,
        toJSON: () => ({ ...payload, chatId }),
      })),
    })),
  };
});

const MessageState = require('../../../src/renderer/chat/modules/messaging/MessageState');
const { createRendererLogger } = require('../../../src/renderer/shared/utils/logger');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEventBus() {
  return {
    on: jest.fn(() => jest.fn()),
    off: jest.fn(),
    emit: jest.fn(),
  };
}

function createMockIpc() {
  return {
    send: jest.fn(),
    on: jest.fn(() => jest.fn()),
  };
}

function createMockChatService(overrides = {}) {
  return {
    getOrCreateDefaultChat: jest.fn(() => Promise.resolve({ id: 'default-chat-id' })),
    loadChatWithMessages: jest.fn((chatId) =>
      Promise.resolve({
        id: chatId,
        toJSON: () => ({
          id: chatId,
          messages: [
            {
              id: 'msg-1',
              role: 'user',
              content: 'Hello',
              timestamp: 1700000000000,
            },
          ],
        }),
      })
    ),
    createChat: jest.fn((title) => Promise.resolve({ id: `chat-${Date.now()}`, title })),
    chatExists: jest.fn(() => Promise.resolve(true)),
    updateChatTitle: jest.fn(() => Promise.resolve()),
    loadAllChats: jest.fn(() => Promise.resolve([])),
    ...overrides,
  };
}

function createMockMessageService(overrides = {}) {
  return {
    saveMessage: jest.fn((msg) =>
      Promise.resolve({
        ...msg,
        toJSON: () => ({
          id: msg.id || 'saved-msg-id',
          role: msg.role,
          content: msg.content,
          timestamp: msg.timestamp || Date.now(),
          correlation_id: msg.correlation_id || null,
        }),
      })
    ),
    ...overrides,
  };
}

function createMessageState(overrides = {}) {
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    child: jest.fn(function () { return this; }),
  };
  createRendererLogger.mockReturnValue(mockLogger);

  const chatService = overrides.chatService || createMockChatService();
  const messageService = overrides.messageService || createMockMessageService();
  const eventBus = overrides.eventBus || createMockEventBus();
  const ipc = overrides.ipc || createMockIpc();

  // Provide crypto.randomUUID if missing
  if (typeof globalThis.crypto === 'undefined') {
    globalThis.crypto = { randomUUID: () => `${Date.now()}-${Math.random().toString(36).substr(2, 9)}` };
  } else if (!globalThis.crypto.randomUUID) {
    globalThis.crypto.randomUUID = () => `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  const ms = new MessageState({
    eventBus,
    ipc,
    chatService,
    messageService,
    ...overrides,
  });

  return { ms, chatService, messageService, eventBus, ipc, log: mockLogger };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  jest.restoreAllMocks();
});

// ===========================================================================
// TEST SUITE
// ===========================================================================

describe('MessageState', () => {
  // =========================================================================
  // Construction
  // =========================================================================
  describe('construction', () => {
    test('creates instance with default state', () => {
      const { ms } = createMessageState();
      expect(ms).toBeInstanceOf(MessageState);
      expect(ms._isDisposed).toBe(false);
      expect(ms.currentChatId).toBeNull();
      expect(ms.messages).toEqual([]);
    });

    test('accepts injected dependencies', () => {
      const eventBus = createMockEventBus();
      const ipc = createMockIpc();
      const { ms } = createMessageState({ eventBus, ipc });
      expect(ms.eventBus).toBe(eventBus);
      expect(ms.ipc).toBe(ipc);
    });
  });

  // =========================================================================
  // init
  // =========================================================================
  describe('init', () => {
    test('init with autoLoad:false sets empty state', async () => {
      const { ms } = createMessageState();
      await ms.init({ autoLoad: false });
      expect(ms.currentChatId).toBeNull();
      expect(ms.messages).toEqual([]);
    });

    test('init with chatId loads that chat', async () => {
      const { ms, chatService } = createMessageState();
      await ms.init({ chatId: 'test-chat-1', autoLoad: true });
      expect(chatService.loadChatWithMessages).toHaveBeenCalledWith('test-chat-1');
      expect(ms.currentChatId).toBe('test-chat-1');
    });

    test('init with autoLoad and no chatId ensures default chat', async () => {
      const { ms, chatService } = createMessageState();
      await ms.init({ autoLoad: true });
      expect(chatService.getOrCreateDefaultChat).toHaveBeenCalled();
    });

    test('init with string argument treats it as chatId', async () => {
      const { ms, chatService } = createMessageState();
      await ms.init('string-chat-id');
      expect(chatService.loadChatWithMessages).toHaveBeenCalledWith('string-chat-id');
    });
  });

  // =========================================================================
  // createChat
  // =========================================================================
  describe('createChat', () => {
    test('creates chat and sets currentChatId', async () => {
      const chatId = 'new-chat-id';
      const { ms, chatService, eventBus } = createMessageState({
        chatService: createMockChatService({
          createChat: jest.fn(() => Promise.resolve({ id: chatId })),
        }),
      });
      await ms.init({ autoLoad: false });

      const result = await ms.createChat('My Chat');
      expect(result).toBe(chatId);
      expect(ms.currentChatId).toBe(chatId);
      expect(ms.messages).toEqual([]);
      expect(eventBus.emit).toHaveBeenCalledWith('chat:created', { chatId, title: 'My Chat' });
    });

    test('throws on service failure', async () => {
      const { ms } = createMessageState({
        chatService: createMockChatService({
          createChat: jest.fn(() => Promise.reject(new Error('DB error'))),
        }),
      });
      await ms.init({ autoLoad: false });
      await expect(ms.createChat('Fail')).rejects.toThrow('DB error');
    });
  });

  // =========================================================================
  // loadChat
  // =========================================================================
  describe('loadChat', () => {
    test('loads chat and normalizes messages', async () => {
      const { ms } = createMessageState();
      await ms.init({ autoLoad: false });
      await ms.loadChat('load-1');
      expect(ms.currentChatId).toBe('load-1');
      expect(ms.messages.length).toBe(1);
      expect(ms.messages[0].id).toBe('msg-1');
      expect(ms.messages[0].role).toBe('user');
    });

    test('returns early for null chatId', async () => {
      const { ms, chatService } = createMessageState();
      await ms.init({ autoLoad: false });
      await ms.loadChat(null);
      expect(chatService.loadChatWithMessages).not.toHaveBeenCalled();
    });

    test('emits chat:loaded and chat:switched', async () => {
      const { ms, eventBus } = createMessageState();
      await ms.init({ autoLoad: false });
      await ms.loadChat('emit-test');
      expect(eventBus.emit).toHaveBeenCalledWith('chat:loaded', expect.objectContaining({ chatId: 'emit-test' }));
      expect(eventBus.emit).toHaveBeenCalledWith('chat:switched', expect.objectContaining({ chatId: 'emit-test' }));
    });
  });

  // =========================================================================
  // switchChat
  // =========================================================================
  describe('switchChat', () => {
    test('loads new chat and emits events', async () => {
      const { ms, eventBus, ipc } = createMessageState();
      await ms.init({ autoLoad: false });
      ms.currentChatId = 'old-chat';
      await ms.switchChat('new-chat');
      expect(ms.currentChatId).toBe('new-chat');
      expect(ipc.send).toHaveBeenCalledWith('chat:switch-to-chat', { chatId: 'new-chat' });
    });

    test('no-ops if already on the same chat', async () => {
      const { ms, chatService } = createMessageState();
      await ms.init({ autoLoad: false });
      ms.currentChatId = 'same-chat';
      await ms.switchChat('same-chat');
      expect(chatService.loadChatWithMessages).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // saveMessage
  // =========================================================================
  describe('saveMessage', () => {
    test('saves message via domain service', async () => {
      const { ms, messageService } = createMessageState();
      await ms.init({ autoLoad: false });
      ms.currentChatId = 'save-chat';

      const result = await ms.saveMessage({
        id: 'save-1',
        role: 'user',
        content: 'Test message',
        timestamp: 1700000000000,
      });
      expect(result).not.toBeNull();
      expect(result.id).toBeDefined();
      expect(ms.messages.length).toBe(1);
    });

    test('returns null for invalid message', async () => {
      const { ms } = createMessageState();
      await ms.init({ autoLoad: false });
      ms.currentChatId = 'save-chat';
      const result = await ms.saveMessage({ role: 'user' }); // missing content
      expect(result).toBeNull();
    });

    test('returns null when no chatId', async () => {
      const { ms } = createMessageState();
      await ms.init({ autoLoad: false });
      const result = await ms.saveMessage({ id: 's1', role: 'user', content: 'hi' });
      expect(result).toBeNull();
    });

    test('falls back to local message on service failure', async () => {
      const { ms } = createMessageState({
        messageService: createMockMessageService({
          saveMessage: jest.fn(() => Promise.reject(new Error('save failed'))),
        }),
      });
      await ms.init({ autoLoad: false });
      ms.currentChatId = 'fail-save-chat';
      const result = await ms.saveMessage({
        id: 'local-1',
        role: 'user',
        content: 'fallback',
        timestamp: 1700000000000,
      });
      expect(result).not.toBeNull();
      expect(result.id).toBe('local-1');
    });
  });

  // =========================================================================
  // updateMessage
  // =========================================================================
  describe('updateMessage', () => {
    test('updates message in local state', async () => {
      const { ms } = createMessageState();
      await ms.init({ autoLoad: false });
      ms.messages.push({ id: 'upd-1', role: 'user', content: 'Original' });
      await ms.updateMessage('upd-1', { content: 'Updated' });
      expect(ms.messages[0].content).toBe('Updated');
    });

    test('no-op for non-existent messageId', async () => {
      const { ms } = createMessageState();
      await ms.init({ autoLoad: false });
      await ms.updateMessage('no-such-id', { content: 'nope' });
      expect(ms.messages.length).toBe(0);
    });
  });

  // =========================================================================
  // updateChatTitle
  // =========================================================================
  describe('updateChatTitle', () => {
    test('delegates to chatService', async () => {
      const { ms, chatService } = createMessageState();
      await ms.init({ autoLoad: false });
      ms.currentChatId = 'title-chat';
      await ms.updateChatTitle('New Title');
      expect(chatService.updateChatTitle).toHaveBeenCalledWith('title-chat', 'New Title');
    });

    test('no-op when no currentChatId', async () => {
      const { ms, chatService } = createMessageState();
      await ms.init({ autoLoad: false });
      await ms.updateChatTitle('Title');
      expect(chatService.updateChatTitle).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // ensureChatExists
  // =========================================================================
  describe('ensureChatExists', () => {
    test('returns true if chat exists', async () => {
      const { ms } = createMessageState();
      await ms.init({ autoLoad: false });
      ms.currentChatId = 'exists-chat';
      const result = await ms.ensureChatExists();
      expect(result).toBe(true);
    });

    test('creates chat if not found', async () => {
      const newChatId = 'migrated-chat';
      const { ms, chatService, eventBus } = createMessageState({
        chatService: createMockChatService({
          chatExists: jest.fn(() => Promise.resolve(false)),
          createChat: jest.fn(() => Promise.resolve({ id: newChatId })),
        }),
      });
      await ms.init({ autoLoad: false });
      ms.currentChatId = 'old-local-id';
      const result = await ms.ensureChatExists();
      expect(result).toBe(true);
      expect(ms.currentChatId).toBe(newChatId);
      expect(eventBus.emit).toHaveBeenCalledWith('chat:migrated', { oldId: 'old-local-id', newId: newChatId });
    });

    test('returns false when no chatId', async () => {
      const { ms } = createMessageState();
      await ms.init({ autoLoad: false });
      expect(await ms.ensureChatExists()).toBe(false);
    });
  });

  // =========================================================================
  // getChats
  // =========================================================================
  describe('getChats', () => {
    test('delegates to chatService.loadAllChats', async () => {
      const { ms, chatService } = createMessageState({
        chatService: createMockChatService({
          loadAllChats: jest.fn(() => Promise.resolve([{ id: 'c1' }, { id: 'c2' }])),
        }),
      });
      const result = await ms.getChats();
      expect(result).toEqual([{ id: 'c1' }, { id: 'c2' }]);
    });

    test('returns empty array on failure', async () => {
      const { ms } = createMessageState({
        chatService: createMockChatService({
          loadAllChats: jest.fn(() => Promise.reject(new Error('fail'))),
        }),
      });
      const result = await ms.getChats();
      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // _normalizeMessage
  // =========================================================================
  describe('_normalizeMessage', () => {
    test('normalizes plain object', () => {
      const { ms } = createMessageState();
      const result = ms._normalizeMessage({
        id: 'n1',
        role: 'user',
        content: 'Hello',
        timestamp: 1700000000000,
        correlation_id: 'corr-1',
      });
      expect(result).toEqual({
        id: 'n1',
        role: 'user',
        content: 'Hello',
        timestamp: 1700000000000,
        correlation_id: 'corr-1',
        metadata: {},
      });
    });

    test('normalizes object with toJSON', () => {
      const { ms } = createMessageState();
      const result = ms._normalizeMessage({
        toJSON: () => ({
          id: 'n2',
          role: 'assistant',
          content: 'Hi',
          timestamp: '2024-01-01T00:00:00Z',
          correlation_id: null,
        }),
      });
      expect(result.id).toBe('n2');
      expect(typeof result.timestamp).toBe('number');
    });

    test('throws on null message', () => {
      const { ms } = createMessageState();
      expect(() => ms._normalizeMessage(null)).toThrow('CONTRACT VIOLATION');
    });

    test('throws on message without id', () => {
      const { ms } = createMessageState();
      expect(() => ms._normalizeMessage({ role: 'user', content: 'hi', timestamp: 1 })).toThrow('Message must have id');
    });

    test('throws on message without timestamp', () => {
      const { ms } = createMessageState();
      expect(() => ms._normalizeMessage({ id: 'x', role: 'user', content: 'hi' })).toThrow('Message must have timestamp');
    });
  });

  // =========================================================================
  // _normalizeMessages
  // =========================================================================
  describe('_normalizeMessages', () => {
    test('normalizes array of valid messages', () => {
      const { ms } = createMessageState();
      const result = ms._normalizeMessages([
        { id: 'a', role: 'user', content: 'hi', timestamp: 1 },
        { id: 'b', role: 'assistant', content: 'hello', timestamp: 2 },
      ]);
      expect(result.length).toBe(2);
    });

    test('returns empty array for non-array', () => {
      const { ms } = createMessageState();
      expect(ms._normalizeMessages(null)).toEqual([]);
      expect(ms._normalizeMessages('string')).toEqual([]);
    });
  });

  // =========================================================================
  // _deriveTitleFromMessages
  // =========================================================================
  describe('_deriveTitleFromMessages', () => {
    test('returns New Chat for empty messages', () => {
      const { ms } = createMessageState();
      expect(ms._deriveTitleFromMessages()).toBe('New Chat');
    });

    test('derives title from first user message', () => {
      const { ms } = createMessageState();
      ms.messages = [
        { id: '1', role: 'assistant', content: 'Welcome' },
        { id: '2', role: 'user', content: 'How do I fix my database?' },
      ];
      expect(ms._deriveTitleFromMessages()).toBe('How do I fix my database?');
    });

    test('truncates at 50 chars', () => {
      const { ms } = createMessageState();
      ms.messages = [
        { id: '1', role: 'user', content: 'A'.repeat(100) },
      ];
      const title = ms._deriveTitleFromMessages();
      expect(title.length).toBe(50);
    });
  });

  // =========================================================================
  // getMessages / getCurrentChatId / clearMessages
  // =========================================================================
  describe('accessors', () => {
    test('getMessages returns copy', () => {
      const { ms } = createMessageState();
      ms.messages.push({ id: '1' });
      const result = ms.getMessages();
      expect(result).toEqual([{ id: '1' }]);
      result.push({ id: '2' });
      expect(ms.messages.length).toBe(1); // original not mutated
    });

    test('getCurrentChatId returns current chat', () => {
      const { ms } = createMessageState();
      ms.currentChatId = 'test-chat';
      expect(ms.getCurrentChatId()).toBe('test-chat');
    });

    test('clearMessages empties array', () => {
      const { ms } = createMessageState();
      ms.messages.push({ id: '1' });
      ms.clearMessages();
      expect(ms.messages).toEqual([]);
    });
  });

  // =========================================================================
  // _generateLocalChatId
  // =========================================================================
  describe('_generateLocalChatId', () => {
    test('returns a UUID string', () => {
      const { ms } = createMessageState();
      const id = ms._generateLocalChatId();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // MS-1: _isDisposed lifecycle guards
  // =========================================================================
  describe('MS-1: _isDisposed lifecycle guards', () => {
    test('init is no-op after dispose', async () => {
      const { ms, chatService } = createMessageState();
      ms.dispose();
      await ms.init({ chatId: 'x' }); // should not throw
      expect(chatService.loadChatWithMessages).not.toHaveBeenCalled();
    });

    test('createChat returns null after dispose', async () => {
      const { ms, chatService } = createMessageState();
      ms.dispose();
      const result = await ms.createChat('test');
      expect(result).toBeNull();
      expect(chatService.createChat).not.toHaveBeenCalled();
    });

    test('loadChat is no-op after dispose', async () => {
      const { ms, chatService } = createMessageState();
      ms.dispose();
      await ms.loadChat('x');
      expect(chatService.loadChatWithMessages).not.toHaveBeenCalled();
    });

    test('switchChat is no-op after dispose', async () => {
      const { ms, chatService } = createMessageState();
      ms.dispose();
      await ms.switchChat('x');
      expect(chatService.loadChatWithMessages).not.toHaveBeenCalled();
    });

    test('saveMessage returns null after dispose', async () => {
      const { ms } = createMessageState();
      ms.dispose();
      const result = await ms.saveMessage({ id: 'x', role: 'user', content: 'hi' });
      expect(result).toBeNull();
    });

    test('updateMessage is no-op after dispose', async () => {
      const { ms } = createMessageState();
      ms.messages = [{ id: 'u1', content: 'old' }];
      ms.dispose();
      await ms.updateMessage('u1', { content: 'new' });
      // messages was cleared by dispose, so nothing to verify further
    });

    test('updateChatTitle is no-op after dispose', async () => {
      const { ms, chatService } = createMessageState();
      ms.currentChatId = 'chat-1';
      ms.dispose();
      await ms.updateChatTitle('Title');
      expect(chatService.updateChatTitle).not.toHaveBeenCalled();
    });

    test('ensureChatExists returns false after dispose', async () => {
      const { ms } = createMessageState();
      ms.currentChatId = 'chat-1';
      ms.dispose();
      const result = await ms.ensureChatExists();
      expect(result).toBe(false);
    });

    test('getChats returns empty after dispose', async () => {
      const { ms } = createMessageState();
      ms.dispose();
      const result = await ms.getChats();
      expect(result).toEqual([]);
    });

    test('ensureDefaultChat returns null after dispose', async () => {
      const { ms } = createMessageState();
      ms.dispose();
      const result = await ms.ensureDefaultChat();
      expect(result).toBeNull();
    });

    test('dispose is idempotent', () => {
      const { ms } = createMessageState();
      ms.dispose();
      ms.dispose(); // should not throw
      expect(ms._isDisposed).toBe(true);
    });
  });

  // =========================================================================
  // MS-2: domain service references nulled in dispose
  // =========================================================================
  describe('MS-2: domain refs nulled in dispose', () => {
    test('all domain references are nulled', () => {
      const { ms } = createMessageState();
      expect(ms.chatService).not.toBeNull();
      expect(ms.messageService).not.toBeNull();
      expect(ms._createDomainMessage).not.toBeNull();

      ms.dispose();

      expect(ms.chatService).toBeNull();
      expect(ms.messageService).toBeNull();
      expect(ms._createDomainMessage).toBeNull();
      expect(ms.artifactsAPI).toBeNull();
      expect(ms.eventBus).toBeNull();
      expect(ms.ipc).toBeNull();
      expect(ms.currentChatId).toBeNull();
      expect(ms.messages).toEqual([]);
    });
  });

  // =========================================================================
  // Quantitative resource proof
  // =========================================================================
  describe('quantitative resource proof', () => {
    test('all state cleaned on dispose', async () => {
      const { ms } = createMessageState();
      await ms.init({ autoLoad: false });
      ms.currentChatId = 'proof-chat';
      ms.messages.push({ id: 'p1', role: 'user', content: 'hi' });

      ms.dispose();

      expect(ms.currentChatId).toBeNull();
      expect(ms.messages).toEqual([]);
      expect(ms.eventBus).toBeNull();
      expect(ms.ipc).toBeNull();
      expect(ms.chatService).toBeNull();
      expect(ms.messageService).toBeNull();
      expect(ms._createDomainMessage).toBeNull();
      expect(ms.artifactsAPI).toBeNull();
      expect(ms._isDisposed).toBe(true);
    });
  });
});
