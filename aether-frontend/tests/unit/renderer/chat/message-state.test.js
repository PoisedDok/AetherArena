'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    debug: jest.fn(), trace: jest.fn(),
    child: jest.fn(function () { return this; }),
  })),
}));

const mockChatService = {
  getOrCreateDefaultChat: jest.fn(),
  createChat: jest.fn(),
  loadChatWithMessages: jest.fn(),
  updateChatTitle: jest.fn(),
  chatExists: jest.fn(),
  loadAllChats: jest.fn(),
};

const mockMessageService = {
  saveMessage: jest.fn(),
};

const mockCreateDomainMessage = jest.fn((msg, chatId) => ({
  ...msg,
  chatId,
  _domain: true,
}));

jest.mock('../../../../src/application/chat/ChatServices', () => ({
  ChatServices: jest.fn().mockImplementation(() => ({
    chatService: mockChatService,
    messageService: mockMessageService,
    createDomainMessage: mockCreateDomainMessage,
  })),
}));

const { createRendererLogger } = require('../../../../src/renderer/shared/utils/logger');
const MessageState = require('../../../../src/renderer/chat/modules/messaging/MessageState');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLogger() {
  return {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    debug: jest.fn(), trace: jest.fn(),
    child: jest.fn(function () { return this; }),
  };
}

function createEventBus() {
  return { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
}

function createIpc() {
  return { send: jest.fn() };
}

function createState(overrides = {}) {
  const mockLog = createLogger();
  createRendererLogger.mockReturnValue(mockLog);

  const opts = {
    eventBus: createEventBus(),
    ipc: createIpc(),
    ...overrides,
  };

  const state = new MessageState(opts);
  state.log = mockLog;
  return state;
}

function makeSavedMessage(overrides = {}) {
  return {
    toJSON: () => ({
      id: 'msg-001',
      role: 'user',
      content: 'Hello',
      timestamp: 1700000000000,
      correlation_id: 'corr-1',
      ...overrides,
    }),
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('MessageState', () => {
  let state;

  beforeEach(() => {
    jest.clearAllMocks();
    // Ensure crypto.randomUUID exists in test env
    if (typeof globalThis.crypto === 'undefined') {
      globalThis.crypto = {};
    }
    if (!globalThis.crypto.randomUUID) {
      globalThis.crypto.randomUUID = jest.fn(() => 'uuid-' + Math.random().toString(36).slice(2, 10));
    }

    state = createState();
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('initializes with null currentChatId', () => {
      expect(state.currentChatId).toBeNull();
    });

    it('initializes with empty messages array', () => {
      expect(state.messages).toEqual([]);
    });

    it('stores eventBus', () => {
      expect(state.eventBus).toBeDefined();
      expect(typeof state.eventBus.emit).toBe('function');
    });

    it('stores ipc', () => {
      expect(state.ipc).toBeDefined();
      expect(typeof state.ipc.send).toBe('function');
    });

    it('creates chatService and messageService from ChatServices', () => {
      expect(state.chatService).toBe(mockChatService);
      expect(state.messageService).toBe(mockMessageService);
    });

    it('stores artifactsAPI when provided', () => {
      const artifactsAPI = { switchChat: jest.fn() };
      const s = createState({ artifactsAPI });
      expect(s.artifactsAPI).toBe(artifactsAPI);
    });

    it('extracts artifactsAPI from aether when direct option not provided', () => {
      const artifacts = { switchChat: jest.fn() };
      const s = createState({ aether: { artifacts } });
      expect(s.artifactsAPI).toBe(artifacts);
    });
  });

  // =========================================================================
  // init
  // =========================================================================

  describe('init', () => {
    it('loads chat by chatId when provided as string', async () => {
      mockChatService.loadChatWithMessages.mockResolvedValue({
        id: 'chat-123',
        messages: [],
      });

      await state.init('chat-123');

      expect(mockChatService.loadChatWithMessages).toHaveBeenCalledWith('chat-123');
      expect(state.currentChatId).toBe('chat-123');
    });

    it('loads chat by chatId from options object', async () => {
      mockChatService.loadChatWithMessages.mockResolvedValue({
        id: 'chat-456',
        messages: [],
      });

      await state.init({ chatId: 'chat-456' });

      expect(mockChatService.loadChatWithMessages).toHaveBeenCalledWith('chat-456');
    });

    it('ensures default chat when no chatId provided', async () => {
      mockChatService.getOrCreateDefaultChat.mockResolvedValue({ id: 'default-chat' });
      mockChatService.loadChatWithMessages.mockResolvedValue({
        id: 'default-chat',
        messages: [],
      });

      await state.init();

      expect(mockChatService.getOrCreateDefaultChat).toHaveBeenCalled();
    });

    it('skips auto-load when autoLoad is false', async () => {
      await state.init({ autoLoad: false });

      expect(mockChatService.getOrCreateDefaultChat).not.toHaveBeenCalled();
      expect(mockChatService.loadChatWithMessages).not.toHaveBeenCalled();
      expect(state.currentChatId).toBeNull();
      expect(state.messages).toEqual([]);
    });

    it('throws on initialization failure (via loadChat path)', async () => {
      mockChatService.loadChatWithMessages.mockRejectedValue(new Error('DB down'));

      await expect(state.init({ chatId: 'fail-chat' })).rejects.toThrow('DB down');
    });
  });

  // =========================================================================
  // ensureDefaultChat
  // =========================================================================

  describe('ensureDefaultChat', () => {
    it('loads existing default chat', async () => {
      mockChatService.getOrCreateDefaultChat.mockResolvedValue({ id: 'default-1' });
      mockChatService.loadChatWithMessages.mockResolvedValue({
        id: 'default-1',
        messages: [],
      });

      const id = await state.ensureDefaultChat();

      expect(id).toBe('default-1');
      expect(state.currentChatId).toBe('default-1');
    });

    it('generates local chat ID when service returns no id', async () => {
      mockChatService.getOrCreateDefaultChat.mockResolvedValue({});

      const id = await state.ensureDefaultChat();

      expect(id).toBeDefined();
      expect(state.messages).toEqual([]);
    });

    it('generates local chat ID on error', async () => {
      mockChatService.getOrCreateDefaultChat.mockRejectedValue(new Error('fail'));

      const id = await state.ensureDefaultChat();

      expect(id).toBeDefined();
      expect(state.currentChatId).toBe(id);
    });
  });

  // =========================================================================
  // createChat
  // =========================================================================

  describe('createChat', () => {
    it('creates chat and updates state', async () => {
      mockChatService.createChat.mockResolvedValue({ id: 'new-chat-1' });

      const id = await state.createChat('My Chat');

      expect(id).toBe('new-chat-1');
      expect(state.currentChatId).toBe('new-chat-1');
      expect(state.messages).toEqual([]);
    });

    it('emits chat:created event', async () => {
      mockChatService.createChat.mockResolvedValue({ id: 'new-chat-2' });

      await state.createChat('Test Chat');

      expect(state.eventBus.emit).toHaveBeenCalledWith('chat:created', {
        chatId: 'new-chat-2',
        title: 'Test Chat',
      });
    });

    it('uses "New Chat" as default title', async () => {
      mockChatService.createChat.mockResolvedValue({ id: 'c-1' });

      await state.createChat();

      expect(mockChatService.createChat).toHaveBeenCalledWith('New Chat');
    });

    it('throws on service failure', async () => {
      mockChatService.createChat.mockRejectedValue(new Error('create failed'));

      await expect(state.createChat('X')).rejects.toThrow('create failed');
    });

    it('notifies artifacts of chat switch', async () => {
      const artifactsAPI = { switchChat: jest.fn() };
      const s = createState({ artifactsAPI });
      mockChatService.createChat.mockResolvedValue({ id: 'art-chat' });

      await s.createChat();

      expect(artifactsAPI.switchChat).toHaveBeenCalledWith('art-chat');
    });

    it('does not emit event when eventBus is null', async () => {
      const s = createState({ eventBus: null });
      mockChatService.createChat.mockResolvedValue({ id: 'no-bus' });

      await s.createChat('X');

      // No throw — eventBus guard works
      expect(s.currentChatId).toBe('no-bus');
    });
  });

  // =========================================================================
  // loadChat
  // =========================================================================

  describe('loadChat', () => {
    it('loads chat with messages', async () => {
      mockChatService.loadChatWithMessages.mockResolvedValue({
        id: 'loaded-chat',
        messages: [
          { id: 'm1', role: 'user', content: 'Hi', timestamp: 1000 },
        ],
      });

      const chat = await state.loadChat('loaded-chat');

      expect(chat).toBeDefined();
      expect(state.currentChatId).toBe('loaded-chat');
      expect(state.messages.length).toBe(1);
    });

    it('returns early for null chatId', async () => {
      const result = await state.loadChat(null);

      expect(result).toBeUndefined();
      expect(mockChatService.loadChatWithMessages).not.toHaveBeenCalled();
    });

    it('returns early for empty chatId', async () => {
      const result = await state.loadChat('');

      expect(result).toBeUndefined();
    });

    it('returns early when chat not found', async () => {
      mockChatService.loadChatWithMessages.mockResolvedValue(null);

      const result = await state.loadChat('missing');

      expect(result).toBeUndefined();
    });

    it('throws on load failure', async () => {
      mockChatService.loadChatWithMessages.mockRejectedValue(new Error('load fail'));

      await expect(state.loadChat('x')).rejects.toThrow('load fail');
    });
  });

  // =========================================================================
  // switchChat
  // =========================================================================

  describe('switchChat', () => {
    it('does nothing when switching to same chat', async () => {
      state.currentChatId = 'same';

      await state.switchChat('same');

      expect(mockChatService.loadChatWithMessages).not.toHaveBeenCalled();
    });

    it('loads new chat and emits events', async () => {
      state.currentChatId = 'old';
      mockChatService.loadChatWithMessages.mockResolvedValue({
        id: 'new',
        messages: [],
      });

      await state.switchChat('new');

      expect(state.eventBus.emit).toHaveBeenCalledWith('chat:switched', { chatId: 'new' });
    });

    it('sends IPC message when ipc available', async () => {
      state.currentChatId = 'old';
      mockChatService.loadChatWithMessages.mockResolvedValue({
        id: 'new',
        messages: [],
      });

      await state.switchChat('new');

      expect(state.ipc.send).toHaveBeenCalledWith('chat:switch-to-chat', { chatId: 'new' });
    });

    it('throws on switch failure', async () => {
      state.currentChatId = 'old';
      mockChatService.loadChatWithMessages.mockRejectedValue(new Error('switch fail'));

      await expect(state.switchChat('new')).rejects.toThrow('switch fail');
    });
  });

  // =========================================================================
  // saveMessage
  // =========================================================================

  describe('saveMessage', () => {
    beforeEach(() => {
      state.currentChatId = 'chat-100';
      mockChatService.chatExists.mockResolvedValue(true);
    });

    it('saves valid message and normalizes', async () => {
      mockMessageService.saveMessage.mockResolvedValue(makeSavedMessage());

      const result = await state.saveMessage({ role: 'user', content: 'Hello' });

      expect(result).toBeDefined();
      expect(result.id).toBe('msg-001');
      expect(result.role).toBe('user');
      expect(result.content).toBe('Hello');
      expect(result.timestamp).toBe(1700000000000);
    });

    it('appends message to local state', async () => {
      mockMessageService.saveMessage.mockResolvedValue(makeSavedMessage());

      await state.saveMessage({ role: 'user', content: 'Test' });

      expect(state.messages.length).toBe(1);
      expect(state.messages[0].id).toBe('msg-001');
    });

    it('emits message:saved event', async () => {
      mockMessageService.saveMessage.mockResolvedValue(makeSavedMessage());

      await state.saveMessage({ role: 'user', content: 'Test' });

      expect(state.eventBus.emit).toHaveBeenCalledWith('message:saved', {
        chatId: 'chat-100',
        messageId: 'msg-001',
      });
    });

    it('returns null for null message', async () => {
      const result = await state.saveMessage(null);
      expect(result).toBeNull();
    });

    it('returns null for message without role', async () => {
      const result = await state.saveMessage({ content: 'no role' });
      expect(result).toBeNull();
    });

    it('returns null for message without content', async () => {
      const result = await state.saveMessage({ role: 'user' });
      expect(result).toBeNull();
    });

    it('returns null when no currentChatId', async () => {
      state.currentChatId = null;
      const result = await state.saveMessage({ role: 'user', content: 'test' });
      expect(result).toBeNull();
    });

    it('falls back to local message on service error', async () => {
      mockChatService.chatExists.mockResolvedValue(true);
      mockMessageService.saveMessage.mockRejectedValue(new Error('DB write fail'));

      // id must be provided because _generateMessageId throws by design
      const msg = { role: 'user', content: 'local fallback', id: 'local-1', timestamp: 9999 };
      const result = await state.saveMessage(msg);

      expect(result).toBeDefined();
      expect(result.role).toBe('user');
      expect(result.content).toBe('local fallback');
      expect(result.id).toBe('local-1');
      expect(state.messages.length).toBe(1);
    });
  });

  // =========================================================================
  // updateMessage
  // =========================================================================

  describe('updateMessage', () => {
    it('updates existing message in local state', async () => {
      state.messages = [{ id: 'msg-1', role: 'user', content: 'old' }];

      await state.updateMessage('msg-1', { content: 'new' });

      expect(state.messages[0].content).toBe('new');
    });

    it('does nothing for non-existent message', async () => {
      state.messages = [{ id: 'msg-1', role: 'user', content: 'old' }];

      await state.updateMessage('non-existent', { content: 'nope' });

      expect(state.messages[0].content).toBe('old');
    });
  });

  // =========================================================================
  // updateChatTitle
  // =========================================================================

  describe('updateChatTitle', () => {
    it('updates title via chatService', async () => {
      state.currentChatId = 'chat-1';

      await state.updateChatTitle('New Title');

      expect(mockChatService.updateChatTitle).toHaveBeenCalledWith('chat-1', 'New Title');
    });

    it('does nothing when no currentChatId', async () => {
      state.currentChatId = null;

      await state.updateChatTitle('Title');

      expect(mockChatService.updateChatTitle).not.toHaveBeenCalled();
    });

    it('handles service error gracefully (no throw)', async () => {
      state.currentChatId = 'chat-1';
      mockChatService.updateChatTitle.mockRejectedValue(new Error('fail'));

      await expect(state.updateChatTitle('X')).resolves.not.toThrow();
    });
  });

  // =========================================================================
  // ensureChatExists
  // =========================================================================

  describe('ensureChatExists', () => {
    it('returns true when chat exists', async () => {
      state.currentChatId = 'existing';
      mockChatService.chatExists.mockResolvedValue(true);

      const result = await state.ensureChatExists();

      expect(result).toBe(true);
    });

    it('creates chat when not exists, emits migration event', async () => {
      state.currentChatId = 'local-id';
      mockChatService.chatExists.mockResolvedValue(false);
      mockChatService.createChat.mockResolvedValue({ id: 'persisted-id' });

      const result = await state.ensureChatExists();

      expect(result).toBe(true);
      expect(state.currentChatId).toBe('persisted-id');
      expect(state.eventBus.emit).toHaveBeenCalledWith('chat:migrated', {
        oldId: 'local-id',
        newId: 'persisted-id',
      });
    });

    it('returns false when no currentChatId', async () => {
      state.currentChatId = null;

      const result = await state.ensureChatExists();

      expect(result).toBe(false);
    });

    it('returns false on service error', async () => {
      state.currentChatId = 'err';
      mockChatService.chatExists.mockRejectedValue(new Error('fail'));

      const result = await state.ensureChatExists();

      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // getChats
  // =========================================================================

  describe('getChats', () => {
    it('returns chats from chatService', async () => {
      const chats = [{ id: '1' }, { id: '2' }];
      mockChatService.loadAllChats.mockResolvedValue(chats);

      const result = await state.getChats();

      expect(result).toEqual(chats);
    });

    it('returns empty array when service returns null', async () => {
      mockChatService.loadAllChats.mockResolvedValue(null);

      const result = await state.getChats();

      expect(result).toEqual([]);
    });

    it('returns empty array on error', async () => {
      mockChatService.loadAllChats.mockRejectedValue(new Error('fail'));

      const result = await state.getChats();

      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // _normalizeMessage
  // =========================================================================

  describe('_normalizeMessage', () => {
    it('normalizes plain message object', () => {
      const result = state._normalizeMessage({
        id: 'id-1',
        role: 'user',
        content: 'Hello',
        timestamp: 1700000000000,
        correlation_id: 'corr-1',
      });

      expect(result).toEqual({
        id: 'id-1',
        role: 'user',
        content: 'Hello',
        timestamp: 1700000000000,
        correlation_id: 'corr-1',
        metadata: {},
      });
    });

    it('normalizes message with toJSON method', () => {
      const result = state._normalizeMessage(makeSavedMessage());

      expect(result.id).toBe('msg-001');
      expect(result.role).toBe('user');
    });

    it('parses string timestamp', () => {
      const result = state._normalizeMessage({
        id: 'id-1',
        role: 'user',
        content: 'x',
        timestamp: '2025-01-15T00:00:00Z',
      });

      expect(typeof result.timestamp).toBe('number');
    });

    it('throws for null message', () => {
      expect(() => state._normalizeMessage(null))
        .toThrow('CONTRACT VIOLATION: Message must be non-null');
    });

    it('throws for message without id', () => {
      expect(() => state._normalizeMessage({
        role: 'user',
        content: 'x',
        timestamp: 1000,
      })).toThrow('CONTRACT VIOLATION: Message must have id');
    });

    it('throws for message with non-string id', () => {
      expect(() => state._normalizeMessage({
        id: 123,
        role: 'user',
        content: 'x',
        timestamp: 1000,
      })).toThrow('CONTRACT VIOLATION: Message must have id');
    });

    it('throws for message without timestamp', () => {
      expect(() => state._normalizeMessage({
        id: 'id-1',
        role: 'user',
        content: 'x',
      })).toThrow('CONTRACT VIOLATION: Message must have timestamp');
    });

    it('defaults content to empty string', () => {
      const result = state._normalizeMessage({
        id: 'id-1',
        role: 'user',
        timestamp: 1000,
      });
      expect(result.content).toBe('');
    });

    it('defaults correlation_id to null', () => {
      const result = state._normalizeMessage({
        id: 'id-1',
        role: 'user',
        content: 'x',
        timestamp: 1000,
      });
      expect(result.correlation_id).toBeNull();
    });

    it('throws for toJSON message without id', () => {
      expect(() => state._normalizeMessage({
        toJSON: () => ({ role: 'user', timestamp: 1000 }),
      })).toThrow('CONTRACT VIOLATION: Message must have id');
    });

    it('throws for toJSON message without timestamp', () => {
      expect(() => state._normalizeMessage({
        toJSON: () => ({ id: 'x', role: 'user' }),
      })).toThrow('CONTRACT VIOLATION: Message must have timestamp');
    });
  });

  // =========================================================================
  // _normalizeMessages
  // =========================================================================

  describe('_normalizeMessages', () => {
    it('normalizes array of messages', () => {
      const result = state._normalizeMessages([
        { id: 'a', role: 'user', content: 'A', timestamp: 1000 },
        { id: 'b', role: 'assistant', content: 'B', timestamp: 2000 },
      ]);

      expect(result.length).toBe(2);
      expect(result[0].id).toBe('a');
      expect(result[1].id).toBe('b');
    });

    it('returns empty array for non-array input', () => {
      expect(state._normalizeMessages(null)).toEqual([]);
      expect(state._normalizeMessages('not array')).toEqual([]);
      expect(state._normalizeMessages(42)).toEqual([]);
    });
  });

  // =========================================================================
  // _deriveTitleFromMessages
  // =========================================================================

  describe('_deriveTitleFromMessages', () => {
    it('returns "New Chat" when no messages', () => {
      state.messages = [];
      expect(state._deriveTitleFromMessages()).toBe('New Chat');
    });

    it('uses first user message content (up to 50 chars)', () => {
      state.messages = [
        { role: 'assistant', content: 'Welcome' },
        { role: 'user', content: 'How do I configure X?' },
      ];
      expect(state._deriveTitleFromMessages()).toBe('How do I configure X?');
    });

    it('truncates long messages to 50 characters', () => {
      const longContent = 'A'.repeat(100);
      state.messages = [{ role: 'user', content: longContent }];
      expect(state._deriveTitleFromMessages()).toBe('A'.repeat(50));
    });

    it('returns "New Chat" when first user message is empty', () => {
      state.messages = [{ role: 'user', content: '   ' }];
      expect(state._deriveTitleFromMessages()).toBe('New Chat');
    });

    it('returns "New Chat" when only assistant messages exist', () => {
      state.messages = [{ role: 'assistant', content: 'Hello' }];
      expect(state._deriveTitleFromMessages()).toBe('New Chat');
    });
  });

  // =========================================================================
  // _toDomainMessage
  // =========================================================================

  describe('_toDomainMessage', () => {
    it('calls createDomainMessage with message and chatId', () => {
      state.currentChatId = 'chat-99';
      const msg = { role: 'user', content: 'test' };

      const result = state._toDomainMessage(msg);

      expect(mockCreateDomainMessage).toHaveBeenCalledWith(msg, 'chat-99');
      expect(result._domain).toBe(true);
    });

    it('throws when _createDomainMessage is not available', () => {
      state._createDomainMessage = null;

      expect(() => state._toDomainMessage({ role: 'user', content: 'x' }))
        .toThrow('Domain message factory not available');
    });
  });

  // =========================================================================
  // _notifyArtifactsOfChatSwitch
  // =========================================================================

  describe('_notifyArtifactsOfChatSwitch', () => {
    it('calls artifactsAPI.switchChat when available', () => {
      const artifactsAPI = { switchChat: jest.fn() };
      state.artifactsAPI = artifactsAPI;

      state._notifyArtifactsOfChatSwitch('chat-x');

      expect(artifactsAPI.switchChat).toHaveBeenCalledWith('chat-x');
    });

    it('falls back to IPC when no artifactsAPI', () => {
      state.artifactsAPI = null;

      state._notifyArtifactsOfChatSwitch('chat-y');

      expect(state.ipc.send).toHaveBeenCalledWith('artifacts:switch-chat', 'chat-y');
    });

    it('does nothing when neither artifactsAPI nor ipc', () => {
      state.artifactsAPI = null;
      state.ipc = null;

      expect(() => state._notifyArtifactsOfChatSwitch('chat-z')).not.toThrow();
    });
  });

  // =========================================================================
  // _generateLocalChatId / _generateMessageId
  // =========================================================================

  describe('_generateLocalChatId', () => {
    it('returns a UUID string', () => {
      const id = state._generateLocalChatId();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('throws when crypto.randomUUID is not available', () => {
      const original = crypto.randomUUID;
      delete crypto.randomUUID;

      expect(() => state._generateLocalChatId())
        .toThrow('CONTRACT VIOLATION: crypto.randomUUID is required');

      crypto.randomUUID = original;
    });
  });

  describe('_generateMessageId', () => {
    it('throws because SessionBridge is required', () => {
      expect(() => state._generateMessageId())
        .toThrow('SessionBridge is REQUIRED for message ID generation');
    });
  });

  // =========================================================================
  // getMessages / getCurrentChatId / clearMessages
  // =========================================================================

  describe('getters', () => {
    it('getMessages returns a copy of messages', () => {
      state.messages = [{ id: '1' }, { id: '2' }];
      const result = state.getMessages();
      expect(result).toEqual([{ id: '1' }, { id: '2' }]);
      expect(result).not.toBe(state.messages);
    });

    it('getCurrentChatId returns current chat ID', () => {
      state.currentChatId = 'abc';
      expect(state.getCurrentChatId()).toBe('abc');
    });

    it('clearMessages empties the array', () => {
      state.messages = [{ id: '1' }];
      state.clearMessages();
      expect(state.messages).toEqual([]);
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    it('clears messages', () => {
      state.messages = [{ id: '1' }];
      state.dispose();
      expect(state.messages).toEqual([]);
    });

    it('nulls currentChatId', () => {
      state.currentChatId = 'x';
      state.dispose();
      expect(state.currentChatId).toBeNull();
    });

    it('nulls eventBus', () => {
      state.dispose();
      expect(state.eventBus).toBeNull();
    });

    it('nulls ipc', () => {
      state.dispose();
      expect(state.ipc).toBeNull();
    });

    it('is idempotent', () => {
      state.dispose();
      expect(() => state.dispose()).not.toThrow();
    });
  });

  // =========================================================================
  // _applyLoadedChat
  // =========================================================================

  describe('_applyLoadedChat', () => {
    it('applies chat state and emits events', async () => {
      await state._applyLoadedChat({
        id: 'loaded-1',
        messages: [
          { id: 'm1', role: 'user', content: 'Hi', timestamp: 1000 },
        ],
      });

      expect(state.currentChatId).toBe('loaded-1');
      expect(state.messages.length).toBe(1);
      expect(state.eventBus.emit).toHaveBeenCalledWith('chat:loaded', {
        chatId: 'loaded-1',
        messageCount: 1,
      });
      expect(state.eventBus.emit).toHaveBeenCalledWith('chat:switched', {
        chatId: 'loaded-1',
        messageCount: 1,
        artifactCount: 0,
      });
    });

    it('supports toJSON on chat object', async () => {
      await state._applyLoadedChat({
        toJSON: () => ({ id: 'json-chat', messages: [] }),
      });

      expect(state.currentChatId).toBe('json-chat');
    });

    it('does nothing for null chat', async () => {
      await state._applyLoadedChat(null);
      expect(state.currentChatId).toBeNull();
    });

    it('skips events when emitLoaded is false', async () => {
      await state._applyLoadedChat(
        { id: 'silent', messages: [] },
        { emitLoaded: false }
      );

      expect(state.currentChatId).toBe('silent');
      expect(state.eventBus.emit).not.toHaveBeenCalledWith(
        'chat:loaded',
        expect.anything()
      );
    });
  });

  // =========================================================================
  // _createLocalMessage
  // =========================================================================

  describe('_createLocalMessage', () => {
    it('preserves message properties including pre-set id', () => {
      const msg = { role: 'user', content: 'local', id: 'pre-set', timestamp: 5000 };
      const result = state._createLocalMessage(msg);
      expect(result.role).toBe('user');
      expect(result.content).toBe('local');
      expect(result.id).toBe('pre-set');
      expect(result.timestamp).toBe(5000);
    });

    it('preserves existing timestamp', () => {
      const msg = { role: 'user', content: 'x', id: 'has-id', timestamp: 999 };
      const result = state._createLocalMessage(msg);
      expect(result.timestamp).toBe(999);
    });

    it('generates timestamp when missing (but id must be present)', () => {
      const before = Date.now();
      const msg = { role: 'user', content: 'x', id: 'has-id' };
      const result = state._createLocalMessage(msg);
      const after = Date.now();
      expect(result.timestamp).toBeGreaterThanOrEqual(before);
      expect(result.timestamp).toBeLessThanOrEqual(after);
    });

    it('throws when id is missing (calls _generateMessageId which throws)', () => {
      const msg = { role: 'user', content: 'x' };
      expect(() => state._createLocalMessage(msg))
        .toThrow('SessionBridge is REQUIRED');
    });
  });

  // =========================================================================
  // Lifecycle
  // =========================================================================

  describe('lifecycle', () => {
    it('full create-init-use-dispose cycle', async () => {
      mockChatService.getOrCreateDefaultChat.mockResolvedValue({ id: 'lc-chat' });
      mockChatService.loadChatWithMessages.mockResolvedValue({
        id: 'lc-chat',
        messages: [
          { id: 'm1', role: 'user', content: 'Hi', timestamp: 1000 },
        ],
      });
      mockChatService.chatExists.mockResolvedValue(true);
      mockMessageService.saveMessage.mockResolvedValue(makeSavedMessage());

      // Init
      await state.init();
      expect(state.currentChatId).toBe('lc-chat');
      expect(state.messages.length).toBe(1);

      // Use
      await state.saveMessage({ role: 'user', content: 'Hello' });
      expect(state.messages.length).toBe(2);

      // Dispose
      state.dispose();
      expect(state.messages).toEqual([]);
      expect(state.currentChatId).toBeNull();
    });
  });
});
