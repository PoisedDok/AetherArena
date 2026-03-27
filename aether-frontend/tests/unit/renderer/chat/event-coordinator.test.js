'use strict';

// ---------------------------------------------------------------------------
// Mocks — plain functions survive resetMocks: true
// ---------------------------------------------------------------------------

const mockLog = {
  info: () => {},
  warn: jest.fn(),
  error: jest.fn(),
  debug: () => {},
  trace: () => {},
};
mockLog.child = () => mockLog;

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

// Use real EventTypes — frozen constants
const { EventTypes, EventPriority } = require('../../../../src/core/events/EventTypes');

const EventCoordinator = require(
  '../../../../src/renderer/chat/controllers/coordination/EventCoordinator'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createEventBus() {
  const handlers = [];
  return {
    on: jest.fn((event, handler, options) => {
      const cleanup = jest.fn();
      handlers.push({ event, handler, options, cleanup });
      return cleanup;
    }),
    emit: jest.fn(),
    off: jest.fn(),
    _handlers: handlers,
  };
}

function getHandler(eventBus, eventName) {
  const entry = eventBus._handlers.find(h => h.event === eventName);
  return entry ? entry.handler : null;
}

function createChatController() {
  return {
    _handleTrailNodeClicked: jest.fn(),
    _restoreFromSessionMap: jest.fn(),
    _handleBackendOnline: jest.fn(),
    _handleBackendOffline: jest.fn(),
    _handleMessageDeleted: jest.fn(),
    _handleArtifactDeleted: jest.fn(),
    _handleArtifactStream: jest.fn(),
    _handleNewChatRequest: jest.fn().mockResolvedValue(undefined),
    _attachChatSummariesAsFiles: jest.fn().mockResolvedValue(undefined),
    setCurrentChatId: jest.fn(),
    setBackendConnected: jest.fn(),
  };
}

function createTrailRestorationService() {
  return {
    restoreSessionMap: jest.fn().mockResolvedValue(undefined),
  };
}

function createModules() {
  return {
    messageOrchestrator: {
      createChat: jest.fn().mockResolvedValue('new-chat-id-123'),
      loadChat: jest.fn().mockResolvedValue(undefined),
    },
    sidebarManager: {
      refreshChatList: jest.fn().mockResolvedValue(undefined),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventCoordinator', () => {
  let eventBus;
  let chatController;
  let trailRestorationService;
  let modules;
  let coordinator;

  beforeEach(() => {
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    eventBus = createEventBus();
    chatController = createChatController();
    trailRestorationService = createTrailRestorationService();
    modules = createModules();
    coordinator = new EventCoordinator({
      eventBus,
      chatController,
      trailRestorationService,
      modules,
    });
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('stores eventBus reference', () => {
      expect(coordinator.eventBus).toBe(eventBus);
    });

    it('stores chatController reference', () => {
      expect(coordinator.chatController).toBe(chatController);
    });

    it('stores trailRestorationService reference', () => {
      expect(coordinator.trailRestorationService).toBe(trailRestorationService);
    });

    it('stores modules reference', () => {
      expect(coordinator.modules).toBe(modules);
    });

    it('initializes empty listeners array', () => {
      expect(coordinator.listeners).toEqual([]);
    });

    it('throws when eventBus is not provided', () => {
      expect(() => new EventCoordinator({})).toThrow('[EventCoordinator] eventBus required');
    });

    it('throws when options is empty', () => {
      expect(() => new EventCoordinator()).toThrow('[EventCoordinator] eventBus required');
    });

    it('throws when eventBus is null', () => {
      expect(() => new EventCoordinator({ eventBus: null })).toThrow('[EventCoordinator] eventBus required');
    });

    it('accepts missing optional dependencies', () => {
      const c = new EventCoordinator({ eventBus });
      expect(c.chatController).toBeUndefined();
      expect(c.trailRestorationService).toBeUndefined();
      expect(c.modules).toBeUndefined();
    });
  });

  // =========================================================================
  // registerAll
  // =========================================================================

  describe('registerAll', () => {
    it('registers 15 event listeners total', () => {
      coordinator.registerAll();
      expect(eventBus.on).toHaveBeenCalledTimes(15);
    });

    it('returns listeners array', () => {
      const result = coordinator.registerAll();
      expect(result).toBe(coordinator.listeners);
      expect(result).toHaveLength(15);
    });

    it('stores 15 cleanup functions', () => {
      coordinator.registerAll();
      expect(coordinator.listeners).toHaveLength(15);
      coordinator.listeners.forEach(fn => {
        expect(typeof fn).toBe('function');
      });
    });

    it('registers TRAIL.NODE_CLICKED listener', () => {
      coordinator.registerAll();
      expect(eventBus.on).toHaveBeenCalledWith(
        EventTypes.TRAIL.NODE_CLICKED,
        expect.any(Function)
      );
    });

    it('registers TRAIL.SESSION_MAP_LOADED listener with HIGH priority', () => {
      coordinator.registerAll();
      expect(eventBus.on).toHaveBeenCalledWith(
        EventTypes.TRAIL.SESSION_MAP_LOADED,
        expect.any(Function),
        { priority: EventPriority.HIGH }
      );
    });

    it('registers session:restoration:requested listener', () => {
      coordinator.registerAll();
      expect(eventBus.on).toHaveBeenCalledWith(
        'session:restoration:requested',
        expect.any(Function)
      );
    });

    it('registers chat:new-requested listener', () => {
      coordinator.registerAll();
      expect(eventBus.on).toHaveBeenCalledWith(
        'chat:new-requested',
        expect.any(Function)
      );
    });
  });

  // =========================================================================
  // NODE_CLICKED handler
  // =========================================================================

  describe('NODE_CLICKED handler', () => {
    beforeEach(() => {
      coordinator.registerAll();
    });

    it('delegates to chatController._handleTrailNodeClicked', () => {
      const handler = getHandler(eventBus, EventTypes.TRAIL.NODE_CLICKED);
      const data = { nodeId: 'node-1', subgroupId: 'sg-1' };
      handler(data);
      expect(chatController._handleTrailNodeClicked).toHaveBeenCalledWith(data);
    });

    it('does nothing when chatController is null', () => {
      coordinator.chatController = null;
      const handler = getHandler(eventBus, EventTypes.TRAIL.NODE_CLICKED);
      expect(() => handler({ nodeId: 'node-1' })).not.toThrow();
    });

    it('does nothing when chatController lacks _handleTrailNodeClicked', () => {
      coordinator.chatController = {};
      const handler = getHandler(eventBus, EventTypes.TRAIL.NODE_CLICKED);
      expect(() => handler({ nodeId: 'node-1' })).not.toThrow();
    });
  });

  // =========================================================================
  // SESSION_MAP_LOADED handler
  // =========================================================================

  describe('SESSION_MAP_LOADED handler', () => {
    beforeEach(() => {
      coordinator.registerAll();
    });

    it('delegates valid payload to chatController._restoreFromSessionMap', () => {
      const handler = getHandler(eventBus, EventTypes.TRAIL.SESSION_MAP_LOADED);
      const payload = {
        chatId: 'chat-abc-123-def-456',
        sessionMap: { timeline: [1, 2, 3], metadata: { v: 1 } },
      };
      handler(payload);
      expect(chatController._restoreFromSessionMap).toHaveBeenCalledWith(
        'chat-abc-123-def-456',
        { timeline: [1, 2, 3], metadata: { v: 1 } }
      );
    });

    it('warns and returns when payload is null', () => {
      const handler = getHandler(eventBus, EventTypes.TRAIL.SESSION_MAP_LOADED);
      handler(null);
      expect(mockLog.warn).toHaveBeenCalledWith('SESSION_MAP_LOADED event missing required fields');
      expect(chatController._restoreFromSessionMap).not.toHaveBeenCalled();
    });

    it('warns and returns when payload is undefined', () => {
      const handler = getHandler(eventBus, EventTypes.TRAIL.SESSION_MAP_LOADED);
      handler(undefined);
      expect(mockLog.warn).toHaveBeenCalledWith('SESSION_MAP_LOADED event missing required fields');
    });

    it('warns and returns when payload.chatId is missing', () => {
      const handler = getHandler(eventBus, EventTypes.TRAIL.SESSION_MAP_LOADED);
      handler({ sessionMap: {} });
      expect(mockLog.warn).toHaveBeenCalledWith('SESSION_MAP_LOADED event missing required fields');
      expect(chatController._restoreFromSessionMap).not.toHaveBeenCalled();
    });

    it('warns and returns when payload.sessionMap is missing', () => {
      const handler = getHandler(eventBus, EventTypes.TRAIL.SESSION_MAP_LOADED);
      handler({ chatId: 'chat-123' });
      expect(mockLog.warn).toHaveBeenCalledWith('SESSION_MAP_LOADED event missing required fields');
      expect(chatController._restoreFromSessionMap).not.toHaveBeenCalled();
    });

    it('handles sessionMap without timeline gracefully', () => {
      const handler = getHandler(eventBus, EventTypes.TRAIL.SESSION_MAP_LOADED);
      const payload = { chatId: 'chat-abc-12345678', sessionMap: {} };
      handler(payload);
      expect(chatController._restoreFromSessionMap).toHaveBeenCalledWith('chat-abc-12345678', {});
    });

    it('catches and logs error from _restoreFromSessionMap', () => {
      chatController._restoreFromSessionMap.mockImplementation(() => {
        throw new Error('Restore failed');
      });
      const handler = getHandler(eventBus, EventTypes.TRAIL.SESSION_MAP_LOADED);
      handler({
        chatId: 'chat-abc-12345678',
        sessionMap: { timeline: [] },
      });
      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to handle SESSION_MAP_LOADED event',
        expect.objectContaining({ error: 'Restore failed' })
      );
    });

    it('does nothing when chatController is null', () => {
      coordinator.chatController = null;
      const handler = getHandler(eventBus, EventTypes.TRAIL.SESSION_MAP_LOADED);
      expect(() => handler({ chatId: 'c', sessionMap: {} })).not.toThrow();
      expect(chatController._restoreFromSessionMap).not.toHaveBeenCalled();
    });

    it('does nothing when chatController lacks _restoreFromSessionMap', () => {
      coordinator.chatController = {};
      const handler = getHandler(eventBus, EventTypes.TRAIL.SESSION_MAP_LOADED);
      expect(() => handler({ chatId: 'c', sessionMap: {} })).not.toThrow();
    });
  });

  // =========================================================================
  // session:restoration:requested handler
  // =========================================================================

  describe('session:restoration:requested handler', () => {
    beforeEach(() => {
      coordinator.registerAll();
    });

    it('delegates to trailRestorationService.restoreSessionMap', async () => {
      const handler = getHandler(eventBus, 'session:restoration:requested');
      await handler({ chatId: 'chat-abc-12345678' });
      expect(trailRestorationService.restoreSessionMap).toHaveBeenCalledWith('chat-abc-12345678');
    });

    it('warns and returns when payload is null', async () => {
      const handler = getHandler(eventBus, 'session:restoration:requested');
      await handler(null);
      expect(mockLog.warn).toHaveBeenCalledWith('Session restoration requested without chatId');
      expect(trailRestorationService.restoreSessionMap).not.toHaveBeenCalled();
    });

    it('warns and returns when payload is undefined', async () => {
      const handler = getHandler(eventBus, 'session:restoration:requested');
      await handler(undefined);
      expect(mockLog.warn).toHaveBeenCalledWith('Session restoration requested without chatId');
    });

    it('warns and returns when payload.chatId is missing', async () => {
      const handler = getHandler(eventBus, 'session:restoration:requested');
      await handler({});
      expect(mockLog.warn).toHaveBeenCalledWith('Session restoration requested without chatId');
      expect(trailRestorationService.restoreSessionMap).not.toHaveBeenCalled();
    });

    it('logs error when trailRestorationService is not set', async () => {
      coordinator.trailRestorationService = null;
      const handler = getHandler(eventBus, 'session:restoration:requested');
      await handler({ chatId: 'chat-abc-12345678' });
      expect(mockLog.error).toHaveBeenCalledWith('TrailRestorationService not initialized');
    });

    it('catches and logs error from restoreSessionMap', async () => {
      trailRestorationService.restoreSessionMap.mockRejectedValue(new Error('DB down'));
      const handler = getHandler(eventBus, 'session:restoration:requested');
      await handler({ chatId: 'chat-abc-12345678' });
      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to handle session restoration request',
        expect.objectContaining({ error: 'DB down' })
      );
    });
  });

  // =========================================================================
  // chat:new-requested handler
  // =========================================================================

  describe('chat:new-requested handler', () => {
    beforeEach(() => {
      coordinator.registerAll();
    });

    it('delegates to chatController._handleNewChatRequest', async () => {
      const handler = getHandler(eventBus, 'chat:new-requested');
      await handler();

      expect(chatController._handleNewChatRequest).toHaveBeenCalled();
    });

    it('does nothing when chatController is not set', async () => {
      coordinator.chatController = null;
      const handler = getHandler(eventBus, 'chat:new-requested');
      await handler();
      expect(mockLog.error).toHaveBeenCalledWith('ChatController not available for new chat request');
    });

    it('catches and logs error from _handleNewChatRequest', async () => {
      chatController._handleNewChatRequest.mockRejectedValue(new Error('Create failed'));
      const handler = getHandler(eventBus, 'chat:new-requested');
      await handler();
      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to create new chat',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });
  });

  // =========================================================================
  // chat:clear-requested handler
  // =========================================================================

  describe('chat:clear-requested handler', () => {
    beforeEach(() => {
      coordinator.registerAll();
    });

    it('clears messages via messageOrchestrator.messageState', () => {
      modules.messageOrchestrator.messageState = { clearMessages: jest.fn() };
      const handler = getHandler(eventBus, 'chat:clear-requested');
      handler();
      expect(modules.messageOrchestrator.messageState.clearMessages).toHaveBeenCalledTimes(1);
    });

    it('does nothing when messageOrchestrator is not set', () => {
      coordinator.modules = {};
      const handler = getHandler(eventBus, 'chat:clear-requested');
      expect(() => handler()).not.toThrow();
    });

    it('catches and logs error from clearMessages', () => {
      modules.messageOrchestrator.messageState = {
        clearMessages: jest.fn(() => { throw new Error('clear fail'); }),
      };
      const handler = getHandler(eventBus, 'chat:clear-requested');
      handler();
      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to clear chat',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });
  });

  // =========================================================================
  // chat:loaded handler
  // =========================================================================

  describe('chat:loaded handler', () => {
    beforeEach(() => {
      coordinator.registerAll();
    });

    it('sets currentChatId on chatController', () => {
      const handler = getHandler(eventBus, 'chat:loaded');
      handler({ chatId: 'loaded-chat-1' });
      expect(chatController.setCurrentChatId).toHaveBeenCalledWith('loaded-chat-1');
    });

    it('registered with HIGH priority', () => {
      expect(eventBus.on).toHaveBeenCalledWith(
        'chat:loaded',
        expect.any(Function),
        { priority: EventPriority.HIGH }
      );
    });

    it('does nothing when data is null', () => {
      const handler = getHandler(eventBus, 'chat:loaded');
      expect(() => handler(null)).not.toThrow();
      expect(chatController.setCurrentChatId).not.toHaveBeenCalled();
    });

    it('does nothing when data.chatId is missing', () => {
      const handler = getHandler(eventBus, 'chat:loaded');
      handler({});
      expect(chatController.setCurrentChatId).not.toHaveBeenCalled();
    });

    it('does nothing when chatController is null', () => {
      coordinator.chatController = null;
      const handler = getHandler(eventBus, 'chat:loaded');
      expect(() => handler({ chatId: 'x' })).not.toThrow();
    });

    it('catches and logs error from setCurrentChatId', () => {
      chatController.setCurrentChatId.mockImplementation(() => { throw new Error('set fail'); });
      const handler = getHandler(eventBus, 'chat:loaded');
      handler({ chatId: 'x' });
      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to handle chat:loaded event',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });
  });

  // =========================================================================
  // CHAT.SWITCHED handler
  // =========================================================================

  describe('CHAT.SWITCHED handler', () => {
    beforeEach(() => {
      coordinator.registerAll();
    });

    it('sets currentChatId on chatController', () => {
      const handler = getHandler(eventBus, EventTypes.CHAT.SWITCHED);
      handler({ chatId: 'switched-chat-1' });
      expect(chatController.setCurrentChatId).toHaveBeenCalledWith('switched-chat-1');
    });

    it('registered with HIGH priority', () => {
      expect(eventBus.on).toHaveBeenCalledWith(
        EventTypes.CHAT.SWITCHED,
        expect.any(Function),
        { priority: EventPriority.HIGH }
      );
    });

    it('does nothing when data is null', () => {
      const handler = getHandler(eventBus, EventTypes.CHAT.SWITCHED);
      expect(() => handler(null)).not.toThrow();
      expect(chatController.setCurrentChatId).not.toHaveBeenCalled();
    });

    it('does nothing when chatController is null', () => {
      coordinator.chatController = null;
      const handler = getHandler(eventBus, EventTypes.CHAT.SWITCHED);
      expect(() => handler({ chatId: 'x' })).not.toThrow();
    });

    it('catches and logs error', () => {
      chatController.setCurrentChatId.mockImplementation(() => { throw new Error('switch fail'); });
      const handler = getHandler(eventBus, EventTypes.CHAT.SWITCHED);
      handler({ chatId: 'x' });
      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to handle chat:switched event',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });
  });

  // =========================================================================
  // CONNECTION.BACKEND_ONLINE handler
  // =========================================================================

  describe('CONNECTION.BACKEND_ONLINE handler', () => {
    beforeEach(() => {
      coordinator.registerAll();
    });

    it('delegates to chatController._handleBackendOnline', () => {
      const handler = getHandler(eventBus, EventTypes.CONNECTION.BACKEND_ONLINE);
      const data = { url: 'http://localhost:8080' };
      handler(data);
      expect(chatController._handleBackendOnline).toHaveBeenCalledWith(data);
    });

    it('registered with HIGH priority', () => {
      expect(eventBus.on).toHaveBeenCalledWith(
        EventTypes.CONNECTION.BACKEND_ONLINE,
        expect.any(Function),
        { priority: EventPriority.HIGH }
      );
    });

    it('does nothing when chatController is null', () => {
      coordinator.chatController = null;
      const handler = getHandler(eventBus, EventTypes.CONNECTION.BACKEND_ONLINE);
      expect(() => handler({})).not.toThrow();
    });
  });

  // =========================================================================
  // CONNECTION.BACKEND_OFFLINE handler
  // =========================================================================

  describe('CONNECTION.BACKEND_OFFLINE handler', () => {
    beforeEach(() => {
      coordinator.registerAll();
    });

    it('delegates to chatController._handleBackendOffline', () => {
      const handler = getHandler(eventBus, EventTypes.CONNECTION.BACKEND_OFFLINE);
      const data = { reason: 'timeout' };
      handler(data);
      expect(chatController._handleBackendOffline).toHaveBeenCalledWith(data);
    });

    it('registered with HIGH priority', () => {
      expect(eventBus.on).toHaveBeenCalledWith(
        EventTypes.CONNECTION.BACKEND_OFFLINE,
        expect.any(Function),
        { priority: EventPriority.HIGH }
      );
    });

    it('does nothing when chatController is null', () => {
      coordinator.chatController = null;
      const handler = getHandler(eventBus, EventTypes.CONNECTION.BACKEND_OFFLINE);
      expect(() => handler({})).not.toThrow();
    });
  });

  // =========================================================================
  // CHAT.MESSAGE_DELETED handler
  // =========================================================================

  describe('CHAT.MESSAGE_DELETED handler', () => {
    beforeEach(() => {
      coordinator.registerAll();
    });

    it('delegates to chatController._handleMessageDeleted', () => {
      const handler = getHandler(eventBus, EventTypes.CHAT.MESSAGE_DELETED);
      const data = { chatId: 'c1', messageId: 'm1', deletedMessages: [], deletedArtifacts: [] };
      handler(data);
      expect(chatController._handleMessageDeleted).toHaveBeenCalledWith(data);
    });

    it('does nothing when chatController is null', () => {
      coordinator.chatController = null;
      const handler = getHandler(eventBus, EventTypes.CHAT.MESSAGE_DELETED);
      expect(() => handler({ chatId: 'c', messageId: 'm' })).not.toThrow();
    });

    it('catches and logs error from _handleMessageDeleted', () => {
      chatController._handleMessageDeleted.mockImplementation(() => {
        throw new Error('delete fail');
      });
      const handler = getHandler(eventBus, EventTypes.CHAT.MESSAGE_DELETED);
      handler({ chatId: 'c', messageId: 'm' });
      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to handle message deletion',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });
  });

  // =========================================================================
  // ARTIFACTS.ARTIFACT_DELETED handler
  // =========================================================================

  describe('ARTIFACTS.ARTIFACT_DELETED handler', () => {
    beforeEach(() => {
      coordinator.registerAll();
    });

    it('delegates to chatController._handleArtifactDeleted', () => {
      const handler = getHandler(eventBus, EventTypes.ARTIFACTS.ARTIFACT_DELETED);
      const data = { chatId: 'c1', artifactId: 'a1' };
      handler(data);
      expect(chatController._handleArtifactDeleted).toHaveBeenCalledWith(data);
    });

    it('does nothing when chatController is null', () => {
      coordinator.chatController = null;
      const handler = getHandler(eventBus, EventTypes.ARTIFACTS.ARTIFACT_DELETED);
      expect(() => handler({ chatId: 'c', artifactId: 'a' })).not.toThrow();
    });

    it('catches and logs error from _handleArtifactDeleted', () => {
      chatController._handleArtifactDeleted.mockImplementation(() => {
        throw new Error('artifact delete fail');
      });
      const handler = getHandler(eventBus, EventTypes.ARTIFACTS.ARTIFACT_DELETED);
      handler({ chatId: 'c', artifactId: 'a' });
      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to handle artifact deletion',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });
  });

  // =========================================================================
  // artifact:stream handler
  // =========================================================================

  describe('artifact:stream handler', () => {
    beforeEach(() => {
      coordinator.registerAll();
    });

    it('delegates to chatController._handleArtifactStream', () => {
      const handler = getHandler(eventBus, 'artifact:stream');
      const payload = { type: 'chunk', data: 'abc' };
      handler(payload);
      expect(chatController._handleArtifactStream).toHaveBeenCalledWith(payload);
    });

    it('does nothing when chatController is null', () => {
      coordinator.chatController = null;
      const handler = getHandler(eventBus, 'artifact:stream');
      expect(() => handler({ type: 'chunk' })).not.toThrow();
    });

    it('catches and logs error', () => {
      chatController._handleArtifactStream.mockImplementation(() => {
        throw new Error('stream fail');
      });
      const handler = getHandler(eventBus, 'artifact:stream');
      handler({ type: 'chunk' });
      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to handle artifact stream',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });
  });

  // =========================================================================
  // chat-reference:attach-requested-from-input handler
  // =========================================================================

  describe('chat-reference:attach-requested-from-input handler', () => {
    beforeEach(() => {
      coordinator.registerAll();
    });

    it('lazy-initializes ChatSelectorModal and opens it', async () => {
      const handler = getHandler(eventBus, 'chat-reference:attach-requested-from-input');
      await handler({ sourceChatId: 'src-1' });
      expect(coordinator.modules.chatSelectorModal).toBeDefined();
      expect(coordinator.modules.chatSelectorModal.open).toBeDefined();
    });

    it('reuses existing chatSelectorModal on second call', async () => {
      const mockModal = { open: jest.fn() };
      coordinator.modules.chatSelectorModal = mockModal;
      const handler = getHandler(eventBus, 'chat-reference:attach-requested-from-input');
      await handler({ sourceChatId: 'src-1' });
      expect(mockModal.open).toHaveBeenCalledWith('src-1', []);
    });

    it('catches and logs error from open', async () => {
      coordinator.modules.chatSelectorModal = {
        open: jest.fn(() => { throw new Error('modal fail'); }),
      };
      const handler = getHandler(eventBus, 'chat-reference:attach-requested-from-input');
      await handler({ sourceChatId: 'src-1' });
      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to open chat selector modal',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });
  });

  // =========================================================================
  // chat-reference:chats-selected handler
  // =========================================================================

  describe('chat-reference:chats-selected handler', () => {
    beforeEach(() => {
      coordinator.registerAll();
    });

    it('delegates to chatController._attachChatSummariesAsFiles', async () => {
      const handler = getHandler(eventBus, 'chat-reference:chats-selected');
      const chats = [{ chatId: 'a' }, { chatId: 'b' }];
      await handler({ selectedChats: chats });
      expect(chatController._attachChatSummariesAsFiles).toHaveBeenCalledWith(chats);
    });

    it('warns and returns when selectedChats is empty', async () => {
      const handler = getHandler(eventBus, 'chat-reference:chats-selected');
      await handler({ selectedChats: [] });
      expect(mockLog.warn).toHaveBeenCalledWith('No chats selected');
      expect(chatController._attachChatSummariesAsFiles).not.toHaveBeenCalled();
    });

    it('warns and returns when selectedChats is null', async () => {
      const handler = getHandler(eventBus, 'chat-reference:chats-selected');
      await handler({ selectedChats: null });
      expect(mockLog.warn).toHaveBeenCalledWith('No chats selected');
      expect(chatController._attachChatSummariesAsFiles).not.toHaveBeenCalled();
    });

    it('does nothing when chatController is null', async () => {
      coordinator.chatController = null;
      const handler = getHandler(eventBus, 'chat-reference:chats-selected');
      await handler({ selectedChats: [{ chatId: 'a' }] });
      expect(chatController._attachChatSummariesAsFiles).not.toHaveBeenCalled();
    });

    it('catches and logs error from _attachChatSummariesAsFiles', async () => {
      chatController._attachChatSummariesAsFiles.mockRejectedValue(new Error('attach fail'));
      const handler = getHandler(eventBus, 'chat-reference:chats-selected');
      await handler({ selectedChats: [{ chatId: 'a' }] });
      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to attach chat summaries',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });
  });

  // =========================================================================
  // cleanup
  // =========================================================================

  describe('cleanup', () => {
    it('calls all cleanup functions', () => {
      coordinator.registerAll();
      const cleanups = [...coordinator.listeners];
      coordinator.cleanup();
      cleanups.forEach(fn => {
        expect(fn).toHaveBeenCalled();
      });
    });

    it('empties listeners array after cleanup', () => {
      coordinator.registerAll();
      coordinator.cleanup();
      expect(coordinator.listeners).toHaveLength(0);
    });

    it('can be called when listeners is empty', () => {
      expect(() => coordinator.cleanup()).not.toThrow();
      expect(coordinator.listeners).toHaveLength(0);
    });

    it('can be called multiple times', () => {
      coordinator.registerAll();
      coordinator.cleanup();
      expect(() => coordinator.cleanup()).not.toThrow();
    });

    it('skips non-function items in listeners array', () => {
      coordinator.listeners = [jest.fn(), null, 'bad', jest.fn()];
      expect(() => coordinator.cleanup()).not.toThrow();
      expect(coordinator.listeners).toHaveLength(0);
    });
  });

  // =========================================================================
  // Module exports
  // =========================================================================

  describe('module exports', () => {
    it('exports EventCoordinator constructor', () => {
      expect(typeof EventCoordinator).toBe('function');
    });

    it('instances have registerAll and cleanup methods', () => {
      expect(typeof coordinator.registerAll).toBe('function');
      expect(typeof coordinator.cleanup).toBe('function');
    });
  });
});
