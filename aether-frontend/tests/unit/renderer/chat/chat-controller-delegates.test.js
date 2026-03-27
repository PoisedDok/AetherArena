'use strict';

// ---------------------------------------------------------------------------
// Module mocks — MUST precede require() calls
// ---------------------------------------------------------------------------

const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};
mockLog.child = () => mockLog;

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

jest.mock('../../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: () => ({
    ipc: { send: jest.fn() },
    chat: {},
    artifacts: { streamReady: jest.fn() },
    isDetachedWindow: false,
  }),
}));

jest.mock('../../../../src/shared/utils/storage-resolver', () => ({
  resolveStorageAPI: () => ({}),
}));

jest.mock('../../../../src/renderer/shared/adapters/session', () => ({
  setActiveChat: jest.fn(),
}));

// *** Extracted module constructor mocks ***
// Each returns a deterministic mock instance we can spy on.

const mockStreamProcessor = {
  handleAssistantStream: jest.fn(),
  handleRequestComplete: jest.fn(),
  handleEnsureVisible: jest.fn(),
  handleArtifactStream: jest.fn(),
  handleTrailNodeClicked: jest.fn(),
  resetStreamState: jest.fn(),
  dispose: jest.fn(),
  currentStreamingMessageId: null,
};
jest.mock(
  '../../../../src/renderer/chat/controllers/modules/StreamProcessor',
  () => jest.fn(() => mockStreamProcessor)
);

const mockSessionMapRestorer = {
  restore: jest.fn(),
  dispose: jest.fn(),
};
jest.mock(
  '../../../../src/renderer/chat/controllers/modules/SessionMapRestorer',
  () => jest.fn(() => mockSessionMapRestorer)
);

const mockProactiveContextHandler = {
  handle: jest.fn(),
  dispose: jest.fn(),
};
jest.mock(
  '../../../../src/renderer/chat/controllers/modules/ProactiveContextHandler',
  () => jest.fn(() => mockProactiveContextHandler)
);

const mockChatSummaryAttacher = {
  attach: jest.fn(),
  dispose: jest.fn(),
};
jest.mock(
  '../../../../src/renderer/chat/controllers/modules/ChatSummaryAttacher',
  () => jest.fn(() => mockChatSummaryAttacher)
);

const mockMessageDeletionHandler = {
  handleMessageDeleted: jest.fn(),
  handleArtifactDeleted: jest.fn(),
  dispose: jest.fn(),
};
jest.mock(
  '../../../../src/renderer/chat/controllers/modules/MessageDeletionHandler',
  () => jest.fn(() => mockMessageDeletionHandler)
);

// Modules imported but NOT used in constructor — mock to avoid side effects
jest.mock(
  '../../../../src/renderer/chat/controllers/modules/BackendHealthMonitor',
  () => jest.fn(() => ({ dispose: jest.fn(), checkAndEmit: jest.fn() }))
);

jest.mock(
  '../../../../src/renderer/chat/controllers/modules/STTInputManager',
  () =>
    jest.fn(() => ({
      dispose: jest.fn(),
      setInputElement: jest.fn(),
      handleStream: jest.fn(),
    }))
);

jest.mock(
  '../../../../src/renderer/chat/controllers/coordination/EventCoordinator',
  () => jest.fn(() => ({ registerAll: jest.fn(() => []), cleanup: jest.fn() }))
);

jest.mock('../../../../src/application/chat/TrailRestorationService', () => ({
  TrailRestorationService: jest.fn(() => ({ dispose: jest.fn() })),
}));

jest.mock('../../../../src/application/chat/ContextService', () => ({
  ContextService: jest.fn(() => ({ dispose: jest.fn() })),
}));

// Global mocks for constructor
global.BroadcastChannel = jest.fn(() => ({
  onmessage: null,
  close: jest.fn(),
  postMessage: jest.fn(),
}));

if (!global.crypto) global.crypto = {};
global.crypto.randomUUID = () => 'test-chat-uuid-1234';

// *** Lazy-loaded module mocks (used inside _initializeModules) ***
const mockChatWindowInstance = {
  init: jest.fn(),
  getElements: jest.fn(() => ({ input: null })),
  elements: { content: null },
  dispose: jest.fn(),
};
jest.mock(
  '../../../../src/renderer/chat/modules/window/ChatWindow',
  () => jest.fn(() => mockChatWindowInstance)
);

const mockDragResizeInstance = { init: jest.fn(), dispose: jest.fn() };
jest.mock(
  '../../../../src/renderer/chat/modules/window/DragResizeManager',
  () => jest.fn(() => mockDragResizeInstance)
);

const mockFileManagerInstance = { init: jest.fn(), dispose: jest.fn() };
jest.mock(
  '../../../../src/renderer/chat/modules/files/FileManager',
  () => jest.fn(() => mockFileManagerInstance)
);

const mockMessageOrchestratorInstance = {
  init: jest.fn(),
  dispose: jest.fn(),
  messageState: { chatService: null, storageAPI: null, messages: [] },
  trailOrchestrator: {},
  createChat: jest.fn(),
  loadChat: jest.fn(),
};
jest.mock(
  '../../../../src/renderer/chat/modules/messaging/MessageOrchestrator',
  () => jest.fn(() => mockMessageOrchestratorInstance)
);

const mockSidebarManagerInstance = {
  init: jest.fn(),
  dispose: jest.fn(),
  incrementChatCount: jest.fn(),
};
jest.mock(
  '../../../../src/renderer/chat/modules/sidebar/SidebarManager',
  () => jest.fn(() => mockSidebarManagerInstance)
);

const mockThinkingBubbleInstance = { init: jest.fn(), dispose: jest.fn() };
jest.mock(
  '../../../../src/renderer/chat/modules/thinking/ThinkingBubble',
  () => jest.fn(() => mockThinkingBubbleInstance)
);

const mockTrailEventRouterInstance = { dispose: jest.fn() };
jest.mock(
  '../../../../src/renderer/chat/modules/trail/TrailEventRouter',
  () => jest.fn(() => mockTrailEventRouterInstance)
);

// ---------------------------------------------------------------------------
// SUT
// ---------------------------------------------------------------------------

const ChatController = require(
  '../../../../src/renderer/chat/controllers/ChatController'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createController(overrides = {}) {
  const eventBus = {
    emit: jest.fn(),
    on: jest.fn(() => jest.fn()),
    off: jest.fn(),
  };
  const container = {
    resolve: jest.fn((key) => {
      if (key === 'endpoint') return { getHealth: jest.fn(), getBackendURL: jest.fn() };
      return null;
    }),
    register: jest.fn(),
    has: jest.fn(),
  };
  const config = {
    API_BASE_URL: 'http://localhost:8765',
    NODE_ENV: 'test',
  };

  const controller = new ChatController({
    container,
    eventBus,
    config,
    ...overrides,
  });

  return { controller, eventBus, container, config };
}

function clearAllMocks() {
  mockStreamProcessor.handleAssistantStream.mockClear();
  mockStreamProcessor.handleRequestComplete.mockClear();
  mockStreamProcessor.handleEnsureVisible.mockClear();
  mockStreamProcessor.handleArtifactStream.mockClear();
  mockStreamProcessor.handleTrailNodeClicked.mockClear();
  mockStreamProcessor.resetStreamState.mockClear();
  mockStreamProcessor.dispose.mockClear();
  mockSessionMapRestorer.restore.mockClear();
  mockSessionMapRestorer.dispose.mockClear();
  mockProactiveContextHandler.handle.mockClear();
  mockProactiveContextHandler.dispose.mockClear();
  mockChatSummaryAttacher.attach.mockClear();
  mockChatSummaryAttacher.dispose.mockClear();
  mockMessageDeletionHandler.handleMessageDeleted.mockClear();
  mockMessageDeletionHandler.handleArtifactDeleted.mockClear();
  mockMessageDeletionHandler.dispose.mockClear();
  mockLog.info.mockClear();
  mockLog.warn.mockClear();
  mockLog.error.mockClear();
  mockLog.debug.mockClear();
  mockLog.trace.mockClear();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChatController thin delegates', () => {
  beforeEach(() => {
    clearAllMocks();
  });

  // =========================================================================
  // Constructor wiring — verify modules are instantiated and stored
  // =========================================================================

  describe('constructor wiring', () => {
    it('assigns StreamProcessor instance to streamProcessor', () => {
      const { controller } = createController();
      expect(controller.streamProcessor).toBe(mockStreamProcessor);
    });

    it('assigns SessionMapRestorer instance to sessionMapRestorer', () => {
      const { controller } = createController();
      expect(controller.sessionMapRestorer).toBe(mockSessionMapRestorer);
    });

    it('assigns ProactiveContextHandler instance to proactiveContextHandler', () => {
      const { controller } = createController();
      expect(controller.proactiveContextHandler).toBe(
        mockProactiveContextHandler
      );
    });

    it('assigns ChatSummaryAttacher instance to chatSummaryAttacher', () => {
      const { controller } = createController();
      expect(controller.chatSummaryAttacher).toBe(mockChatSummaryAttacher);
    });

    it('assigns MessageDeletionHandler instance to messageDeletionHandler', () => {
      const { controller } = createController();
      expect(controller.messageDeletionHandler).toBe(
        mockMessageDeletionHandler
      );
    });

    it('binds _handleAssistantStream so "this" is preserved', () => {
      const { controller } = createController();
      const fn = controller._handleAssistantStream;
      // Call unbound — if bind worked, it still reaches the right instance
      fn({ messageId: 'msg-bind-test' });
      expect(mockStreamProcessor.handleAssistantStream).toHaveBeenCalledWith({
        messageId: 'msg-bind-test',
      });
    });

    it('binds _handleRequestComplete so "this" is preserved', () => {
      const { controller } = createController();
      const fn = controller._handleRequestComplete;
      fn({ status: 'done' });
      expect(mockStreamProcessor.handleRequestComplete).toHaveBeenCalledWith({
        status: 'done',
      });
    });

    it('binds _handleEnsureVisible so "this" is preserved', () => {
      const { controller } = createController();
      const fn = controller._handleEnsureVisible;
      fn();
      expect(mockStreamProcessor.handleEnsureVisible).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // StreamProcessor delegates — wiring proof (1 test each)
  // Each delegate is a one-liner forwarding to streamProcessor.
  // Module logic is tested in stream-processor.test.js.
  // These prove the wiring survives refactoring (method renames, arg changes).
  // =========================================================================

  describe.each([
    ['_handleAssistantStream', 'handleAssistantStream', { messageId: 'msg-1', content: 'hello' }],
    ['_handleRequestComplete', 'handleRequestComplete', { status: 'done', requestId: 'req-1' }],
    ['_handleArtifactStream', 'handleArtifactStream', { data: { id: 'art-1', content: 'chunk' } }],
    ['_handleTrailNodeClicked', 'handleTrailNodeClicked', { artifactId: 'art-1', phase: 'write' }],
  ])('%s → streamProcessor.%s', (delegateMethod, moduleMethod, testPayload) => {
    it('forwards argument by reference and calls exactly once', () => {
      const { controller } = createController();
      controller[delegateMethod](testPayload);

      expect(mockStreamProcessor[moduleMethod]).toHaveBeenCalledTimes(1);
      expect(mockStreamProcessor[moduleMethod]).toHaveBeenCalledWith(testPayload);
      // Verify identity — no cloning
      expect(mockStreamProcessor[moduleMethod].mock.calls[0][0]).toBe(testPayload);
    });
  });

  describe('_handleEnsureVisible → streamProcessor.handleEnsureVisible', () => {
    it('calls with no arguments', () => {
      const { controller } = createController();
      controller._handleEnsureVisible();

      expect(mockStreamProcessor.handleEnsureVisible).toHaveBeenCalledTimes(1);
      expect(mockStreamProcessor.handleEnsureVisible).toHaveBeenCalledWith();
    });
  });

  // =========================================================================
  // ProactiveContextHandler delegate
  // =========================================================================

  describe('_handleProactiveContext → proactiveContextHandler.handle', () => {
    it('forwards data as first argument', async () => {
      const { controller } = createController();
      const data = { contextType: 'research', content: 'findings' };
      await controller._handleProactiveContext(data);

      expect(mockProactiveContextHandler.handle).toHaveBeenCalledTimes(1);
      expect(mockProactiveContextHandler.handle.mock.calls[0][0]).toBe(data);
    });

    it('passes initialized flag from controller state', async () => {
      const { controller } = createController();
      controller.initialized = true;
      await controller._handleProactiveContext({});

      const ctx = mockProactiveContextHandler.handle.mock.calls[0][1];
      expect(ctx.initialized).toBe(true);
    });

    it('passes initialized=false when controller not initialized', async () => {
      const { controller } = createController();
      controller.initialized = false;
      await controller._handleProactiveContext({});

      const ctx = mockProactiveContextHandler.handle.mock.calls[0][1];
      expect(ctx.initialized).toBe(false);
    });

    it('passes modules reference from controller', async () => {
      const { controller } = createController();
      const modules = { chatWindow: {}, messageOrchestrator: {} };
      controller.modules = modules;
      await controller._handleProactiveContext({});

      const ctx = mockProactiveContextHandler.handle.mock.calls[0][1];
      expect(ctx.modules).toBe(modules);
    });

    it('provides onQueue callback that sets _pendingProactiveContext', async () => {
      const { controller } = createController();
      mockProactiveContextHandler.handle.mockImplementationOnce(
        async (_data, ctx) => {
          ctx.onQueue({ queued: true });
        }
      );

      await controller._handleProactiveContext({ type: 'test' });
      expect(controller._pendingProactiveContext).toEqual({ queued: true });
    });

    it('onQueue callback stores exact reference passed to it', async () => {
      const { controller } = createController();
      const queuedData = { id: 'exact-ref' };
      mockProactiveContextHandler.handle.mockImplementationOnce(
        async (_data, ctx) => {
          ctx.onQueue(queuedData);
        }
      );

      await controller._handleProactiveContext({});
      expect(controller._pendingProactiveContext).toBe(queuedData);
    });
  });

  // =========================================================================
  // SessionMapRestorer delegate
  // =========================================================================

  describe('_restoreFromSessionMap → sessionMapRestorer.restore', () => {
    it('forwards chatId, sessionMap, and trailOrchestrator from modules', () => {
      const { controller } = createController();
      const trailOrchestrator = { restoreTimeline: jest.fn() };
      controller.modules = {
        messageOrchestrator: { trailOrchestrator },
      };

      const chatId = 'chat-abc-123';
      const sessionMap = { timeline: [{ t: 1 }, { t: 2 }], metadata: { v: 2 } };
      controller._restoreFromSessionMap(chatId, sessionMap);

      expect(mockSessionMapRestorer.restore).toHaveBeenCalledTimes(1);
      expect(mockSessionMapRestorer.restore).toHaveBeenCalledWith(
        chatId,
        sessionMap,
        trailOrchestrator
      );
    });

    it('passes undefined orchestrator when messageOrchestrator is missing', () => {
      const { controller } = createController();
      controller.modules = {};

      controller._restoreFromSessionMap('chat-1', { timeline: [] });

      const orchestratorArg =
        mockSessionMapRestorer.restore.mock.calls[0][2];
      expect(orchestratorArg).toBeUndefined();
    });

    it('passes undefined orchestrator when trailOrchestrator is not set', () => {
      const { controller } = createController();
      controller.modules = { messageOrchestrator: {} };

      controller._restoreFromSessionMap('chat-2', {});

      const orchestratorArg =
        mockSessionMapRestorer.restore.mock.calls[0][2];
      expect(orchestratorArg).toBeUndefined();
    });

    it('preserves sessionMap object identity', () => {
      const { controller } = createController();
      controller.modules = { messageOrchestrator: {} };
      const sessionMap = { unique: true };

      controller._restoreFromSessionMap('c', sessionMap);
      expect(mockSessionMapRestorer.restore.mock.calls[0][1]).toBe(
        sessionMap
      );
    });
  });

  // =========================================================================
  // MessageDeletionHandler delegates (2 methods)
  // =========================================================================

  describe('_handleMessageDeleted → messageDeletionHandler.handleMessageDeleted', () => {
    it('forwards data and passes messageView + chatWindow from modules', () => {
      const { controller } = createController();
      const messageView = { removeMessage: jest.fn(), removeBubble: jest.fn() };
      const chatWindow = { scrollToBottom: jest.fn() };
      controller.modules = {
        messageOrchestrator: { messageView },
        chatWindow,
      };

      const data = {
        chatId: 'c1',
        messageId: 'm1',
        deletedMessages: ['m1'],
        deletedArtifacts: ['a1'],
      };
      controller._handleMessageDeleted(data);

      expect(
        mockMessageDeletionHandler.handleMessageDeleted
      ).toHaveBeenCalledTimes(1);
      expect(
        mockMessageDeletionHandler.handleMessageDeleted
      ).toHaveBeenCalledWith(data, {
        messageView,
        chatWindow,
      });
    });

    it('passes undefined messageView when messageOrchestrator is absent', () => {
      const { controller } = createController();
      const chatWindow = {};
      controller.modules = { chatWindow };

      controller._handleMessageDeleted({ chatId: 'c1' });

      const ctxArg =
        mockMessageDeletionHandler.handleMessageDeleted.mock.calls[0][1];
      expect(ctxArg.messageView).toBeUndefined();
      expect(ctxArg.chatWindow).toBe(chatWindow);
    });

    it('passes undefined chatWindow when chatWindow module is absent', () => {
      const { controller } = createController();
      controller.modules = { messageOrchestrator: { messageView: {} } };

      controller._handleMessageDeleted({ chatId: 'c2' });

      const ctxArg =
        mockMessageDeletionHandler.handleMessageDeleted.mock.calls[0][1];
      expect(ctxArg.chatWindow).toBeUndefined();
      expect(ctxArg.messageView).toBeDefined();
    });
  });

  describe('_handleArtifactDeleted → messageDeletionHandler.handleArtifactDeleted', () => {
    it('forwards data exactly', () => {
      const { controller } = createController();
      const data = { chatId: 'c1', artifactId: 'a1' };
      controller._handleArtifactDeleted(data);

      expect(
        mockMessageDeletionHandler.handleArtifactDeleted
      ).toHaveBeenCalledTimes(1);
      expect(
        mockMessageDeletionHandler.handleArtifactDeleted
      ).toHaveBeenCalledWith(data);
    });

    it('preserves data object identity', () => {
      const { controller } = createController();
      const data = { chatId: 'c2', artifactId: 'a2' };
      controller._handleArtifactDeleted(data);
      expect(
        mockMessageDeletionHandler.handleArtifactDeleted.mock.calls[0][0]
      ).toBe(data);
    });
  });

  // =========================================================================
  // ChatSummaryAttacher delegate
  // =========================================================================

  describe('_attachChatSummariesAsFiles → chatSummaryAttacher.attach', () => {
    it('forwards selectedChats and passes fileManager from modules', async () => {
      const { controller } = createController();
      const fileManager = { addFiles: jest.fn() };
      controller.modules = { fileManager };

      const selectedChats = [
        { id: 'c1', title: 'Chat 1', summary: 'Summary 1' },
        { id: 'c2', title: 'Chat 2', summary: 'Summary 2' },
      ];
      await controller._attachChatSummariesAsFiles(selectedChats);

      expect(mockChatSummaryAttacher.attach).toHaveBeenCalledTimes(1);
      expect(mockChatSummaryAttacher.attach).toHaveBeenCalledWith(
        selectedChats,
        fileManager
      );
    });

    it('passes undefined fileManager when module is absent', async () => {
      const { controller } = createController();
      controller.modules = {};

      await controller._attachChatSummariesAsFiles([{ id: 'c1' }]);

      const fileManagerArg =
        mockChatSummaryAttacher.attach.mock.calls[0][1];
      expect(fileManagerArg).toBeUndefined();
    });

    it('forwards empty array', async () => {
      const { controller } = createController();
      controller.modules = { fileManager: {} };

      await controller._attachChatSummariesAsFiles([]);
      expect(mockChatSummaryAttacher.attach).toHaveBeenCalledWith([], {});
    });

    it('preserves selectedChats array identity', async () => {
      const { controller } = createController();
      controller.modules = { fileManager: {} };
      const chats = [{ id: 'ref-test' }];

      await controller._attachChatSummariesAsFiles(chats);
      expect(mockChatSummaryAttacher.attach.mock.calls[0][0]).toBe(chats);
    });
  });

  // =========================================================================
  // Non-delegate methods with own logic
  // =========================================================================

  describe('_handleSttStream (non-thin — has null check + error handling)', () => {
    it('delegates to sttManager.handleStream when sttManager exists', () => {
      const { controller } = createController();
      const mockSttManager = { handleStream: jest.fn() };
      controller.sttManager = mockSttManager;

      const data = { text: 'hello world', isFinal: true };
      controller._handleSttStream(data);

      expect(mockSttManager.handleStream).toHaveBeenCalledWith(data);
      expect(mockSttManager.handleStream).toHaveBeenCalledTimes(1);
    });

    it('logs error when sttManager is null', () => {
      const { controller } = createController();
      controller.sttManager = null;

      controller._handleSttStream({ text: 'test' });

      expect(mockLog.error).toHaveBeenCalledWith(
        'STTInputManager not initialized'
      );
    });

    it('catches and logs error from handleStream without rethrowing', () => {
      const { controller } = createController();
      controller.sttManager = {
        handleStream: jest.fn(() => {
          throw new Error('STT broke');
        }),
      };

      expect(() =>
        controller._handleSttStream({ text: 'test' })
      ).not.toThrow();

      expect(mockLog.error).toHaveBeenCalledWith(
        'STT stream delegation error',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });
  });

  describe('_handleBackendOnline (non-thin — sets state directly)', () => {
    it('sets backendConnected to true', () => {
      const { controller } = createController();
      controller.backendConnected = false;

      controller._handleBackendOnline({ timestamp: 12345 });
      expect(controller.backendConnected).toBe(true);
    });

    it('logs the event data', () => {
      const { controller } = createController();
      const data = { timestamp: 99999 };
      controller._handleBackendOnline(data);
      expect(mockLog.info).toHaveBeenCalledWith(
        'Backend reported online',
        data
      );
    });
  });

  describe('_handleBackendOffline (non-thin — sets state directly)', () => {
    it('sets backendConnected to false', () => {
      const { controller } = createController();
      controller.backendConnected = true;

      controller._handleBackendOffline({ error: 'timeout' });
      expect(controller.backendConnected).toBe(false);
    });

    it('logs the event data as warning', () => {
      const { controller } = createController();
      const data = { error: 'connection refused' };
      controller._handleBackendOffline(data);
      expect(mockLog.warn).toHaveBeenCalledWith(
        'Backend reported offline',
        data
      );
    });
  });

  describe('_handleLoadSpecificChat (non-thin — has validation + error handling)', () => {
    it('delegates to sidebarManager._switchToChat with chatId', async () => {
      const { controller } = createController();
      const switchToChat = jest.fn().mockResolvedValue(undefined);
      controller.modules = {
        sidebarManager: { _switchToChat: switchToChat },
      };

      await controller._handleLoadSpecificChat({ chatId: 'chat-123' });
      expect(switchToChat).toHaveBeenCalledWith('chat-123');
    });

    it('logs warning and returns when chatId is missing', async () => {
      const { controller } = createController();
      await controller._handleLoadSpecificChat({});
      expect(mockLog.warn).toHaveBeenCalledWith(
        'Load specific chat called without chatId'
      );
    });

    it('logs warning and returns when data is null', async () => {
      const { controller } = createController();
      await controller._handleLoadSpecificChat(null);
      expect(mockLog.warn).toHaveBeenCalledWith(
        'Load specific chat called without chatId'
      );
    });

    it('logs warning and returns when data is undefined', async () => {
      const { controller } = createController();
      await controller._handleLoadSpecificChat(undefined);
      expect(mockLog.warn).toHaveBeenCalledWith(
        'Load specific chat called without chatId'
      );
    });

    it('logs error when sidebarManager is missing', async () => {
      const { controller } = createController();
      controller.modules = {};
      await controller._handleLoadSpecificChat({ chatId: 'c1' });
      expect(mockLog.error).toHaveBeenCalledWith(
        'SidebarManager not available or _switchToChat method missing'
      );
    });

    it('logs error when sidebarManager lacks _switchToChat method', async () => {
      const { controller } = createController();
      controller.modules = { sidebarManager: {} };
      await controller._handleLoadSpecificChat({ chatId: 'c1' });
      expect(mockLog.error).toHaveBeenCalledWith(
        'SidebarManager not available or _switchToChat method missing'
      );
    });

    it('catches and logs error from _switchToChat', async () => {
      const { controller } = createController();
      controller.modules = {
        sidebarManager: {
          _switchToChat: jest
            .fn()
            .mockRejectedValue(new Error('Switch failed')),
        },
      };

      await controller._handleLoadSpecificChat({ chatId: 'c1' });

      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to load specific chat',
        expect.objectContaining({
          error: expect.any(Error),
          chatId: 'c1',
        })
      );
    });
  });

  // =========================================================================
  // Public API methods that delegate
  // =========================================================================

  describe('setBackendConnected', () => {
    it('sets backendConnected to true', () => {
      const { controller } = createController();
      controller.setBackendConnected(true);
      expect(controller.backendConnected).toBe(true);
    });

    it('sets backendConnected to false', () => {
      const { controller } = createController();
      controller.backendConnected = true;
      controller.setBackendConnected(false);
      expect(controller.backendConnected).toBe(false);
    });
  });

  describe('setCurrentChatId', () => {
    it('updates currentChatId when new value differs', () => {
      const { controller } = createController();
      controller.currentChatId = 'old-chat';
      controller.setCurrentChatId('new-chat');
      expect(controller.currentChatId).toBe('new-chat');
    });

    it('does not update when chatId is same as current', () => {
      const { controller } = createController();
      controller.currentChatId = 'same-chat';
      controller.setCurrentChatId('same-chat');
      expect(controller.currentChatId).toBe('same-chat');
    });

    it('does not update when chatId is null', () => {
      const { controller } = createController();
      controller.currentChatId = 'existing';
      controller.setCurrentChatId(null);
      expect(controller.currentChatId).toBe('existing');
    });

    it('does not update when chatId is undefined', () => {
      const { controller } = createController();
      controller.currentChatId = 'existing';
      controller.setCurrentChatId(undefined);
      expect(controller.currentChatId).toBe('existing');
    });

    it('does not update when chatId is empty string', () => {
      const { controller } = createController();
      controller.currentChatId = 'existing';
      controller.setCurrentChatId('');
      expect(controller.currentChatId).toBe('existing');
    });
  });
});

// ===========================================================================
// EXTENDED COVERAGE: Constructor validation, public API, lifecycle, edge cases
// ===========================================================================

describe('ChatController — constructor validation', () => {
  beforeEach(() => clearAllMocks());

  it('throws if container option is missing', () => {
    expect(() => new ChatController({
      eventBus: { emit: jest.fn(), on: jest.fn(() => jest.fn()) },
      config: { API_BASE_URL: 'http://localhost:8765' },
    })).toThrow('[ChatController] DI container required');
  });

  it('throws if eventBus option is missing', () => {
    expect(() => new ChatController({
      container: { resolve: jest.fn() },
      config: { API_BASE_URL: 'http://localhost:8765' },
    })).toThrow('[ChatController] EventBus required');
  });

  it('throws if config option is missing', () => {
    expect(() => new ChatController({
      container: { resolve: jest.fn() },
      eventBus: { emit: jest.fn(), on: jest.fn(() => jest.fn()) },
    })).toThrow('[ChatController] Config required');
  });

  it('stores config reference', () => {
    const config = { API_BASE_URL: 'http://localhost:8765', NODE_ENV: 'test' };
    const { controller } = createController({ config });
    expect(controller.config).toBe(config);
  });

  it('stores eventBus reference', () => {
    const { controller, eventBus } = createController();
    expect(controller.eventBus).toBe(eventBus);
  });

  it('stores container reference', () => {
    const { controller, container } = createController();
    expect(controller.container).toBe(container);
  });

  it('initializes default state flags', () => {
    const { controller } = createController();
    expect(controller.initialized).toBe(false);
    expect(controller.backendConnected).toBe(false);
    expect(controller.isProcessing).toBe(false);
  });

  it('initializes currentChatId from _generateChatId', () => {
    const { controller } = createController();
    // crypto.randomUUID is mocked to return 'test-chat-uuid-1234'
    // but _generateChatId is not called in constructor — currentChatId starts null
    expect(controller.currentChatId).toBeNull();
  });

  it('initializes empty modules object', () => {
    const { controller } = createController();
    expect(controller.modules).toEqual({});
  });

  it('initializes empty IPC and event listener arrays', () => {
    const { controller } = createController();
    expect(controller._ipcListeners).toEqual([]);
    expect(controller._eventListeners).toEqual([]);
  });

  it('initializes _pendingProactiveContext as null', () => {
    const { controller } = createController();
    expect(controller._pendingProactiveContext).toBeNull();
  });

  it('creates BroadcastChannel for sidebar refresh', () => {
    const { controller } = createController();
    expect(controller.sidebarRefreshChannel).toBeDefined();
    expect(global.BroadcastChannel).toHaveBeenCalledWith('sidebar-refresh');
  });
});


describe('ChatController — sendMessage', () => {
  beforeEach(() => clearAllMocks());

  it('throws if messageOrchestrator not initialized', async () => {
    const { controller } = createController();
    controller.modules = {};
    await expect(controller.sendMessage('hello'))
      .rejects.toThrow('[ChatController] MessageOrchestrator not initialized');
  });

  it('throws for null content', async () => {
    const { controller } = createController();
    controller.modules = { messageOrchestrator: { sendMessage: jest.fn() } };
    await expect(controller.sendMessage(null))
      .rejects.toThrow('[ChatController] Invalid message content');
  });

  it('throws for empty string content', async () => {
    const { controller } = createController();
    controller.modules = { messageOrchestrator: { sendMessage: jest.fn() } };
    await expect(controller.sendMessage(''))
      .rejects.toThrow('[ChatController] Invalid message content');
  });

  it('throws for non-string content', async () => {
    const { controller } = createController();
    controller.modules = { messageOrchestrator: { sendMessage: jest.fn() } };
    await expect(controller.sendMessage(42))
      .rejects.toThrow('[ChatController] Invalid message content');
  });

  it('throws when backend is not connected', async () => {
    const { controller, eventBus } = createController();
    controller.modules = { messageOrchestrator: { sendMessage: jest.fn() } };
    controller.backendConnected = false;

    await expect(controller.sendMessage('hello'))
      .rejects.toThrow('Backend is not connected');

    const errorCall = eventBus.emit.mock.calls.find(c => c[0] === 'chat:message:error');
    expect(errorCall).toBeTruthy();
    expect(errorCall[1].content).toBe('hello');
  });

  it('delegates to messageOrchestrator.sendMessage', async () => {
    const { controller } = createController();
    const sendMsg = jest.fn().mockResolvedValue(undefined);
    controller.modules = { messageOrchestrator: { sendMessage: sendMsg } };
    controller.backendConnected = true;

    await controller.sendMessage('hello', { mode: 'chat' });
    expect(sendMsg).toHaveBeenCalledWith('hello', { mode: 'chat' });
  });

  it('sets isProcessing true before sending', async () => {
    const { controller, eventBus } = createController();
    let processingDuringSend = null;
    const sendMsg = jest.fn().mockImplementation(async () => {
      processingDuringSend = controller.isProcessing;
    });
    controller.modules = { messageOrchestrator: { sendMessage: sendMsg } };
    controller.backendConnected = true;

    await controller.sendMessage('test');
    expect(processingDuringSend).toBe(true);
  });

  it('emits MESSAGE_SENDING before and MESSAGE_SENT after', async () => {
    const { controller, eventBus } = createController();
    const sendMsg = jest.fn().mockResolvedValue(undefined);
    controller.modules = { messageOrchestrator: { sendMessage: sendMsg } };
    controller.backendConnected = true;

    await controller.sendMessage('test', { opt: 1 });

    const calls = eventBus.emit.mock.calls;
    const sendingCall = calls.find(c => c[0] === 'chat:message:sending');
    const sentCall = calls.find(c => c[0] === 'chat:message:sent');

    expect(sendingCall).toBeTruthy();
    expect(sendingCall[1]).toEqual({ content: 'test', options: { opt: 1 } });
    expect(sentCall).toBeTruthy();
    expect(sentCall[1]).toEqual({ content: 'test', options: { opt: 1 } });
  });

  it('emits MESSAGE_ERROR and rethrows on failure', async () => {
    const { controller, eventBus } = createController();
    const err = new Error('send fail');
    const sendMsg = jest.fn().mockRejectedValue(err);
    controller.modules = { messageOrchestrator: { sendMessage: sendMsg } };
    controller.backendConnected = true;

    await expect(controller.sendMessage('fail')).rejects.toThrow('send fail');

    const errorCall = eventBus.emit.mock.calls.find(c => c[0] === 'chat:message:error');
    expect(errorCall).toBeTruthy();
    expect(errorCall[1].error).toBe(err);
    expect(errorCall[1].content).toBe('fail');
  });
});


describe('ChatController — stopProcessing', () => {
  beforeEach(() => clearAllMocks());

  it('is no-op when isProcessing is false', () => {
    const { controller, eventBus } = createController();
    controller.isProcessing = false;
    controller.stopProcessing();
    expect(eventBus.emit).not.toHaveBeenCalledWith(
      expect.stringMatching(/stop/i),
      expect.anything()
    );
  });

  it('sets isProcessing to false', () => {
    const { controller } = createController();
    controller.isProcessing = true;
    controller.stopProcessing();
    expect(controller.isProcessing).toBe(false);
  });

  it('emits STOP_REQUESTED event', () => {
    const { controller, eventBus } = createController();
    controller.isProcessing = true;
    controller.stopProcessing();
    expect(eventBus.emit).toHaveBeenCalledWith(
      'chat:stop:requested',
      expect.objectContaining({ timestamp: expect.any(Number) })
    );
  });

  it('passes currentStreamingMessageId in stop event', () => {
    const { controller, eventBus } = createController();
    controller.isProcessing = true;
    mockStreamProcessor.currentStreamingMessageId = 'msg-stream-42';
    controller.stopProcessing();

    const stopCall = eventBus.emit.mock.calls.find(c => c[0] === 'chat:stop:requested');
    expect(stopCall[1].messageId).toBe('msg-stream-42');
    mockStreamProcessor.currentStreamingMessageId = null;
  });

  it('calls aether.chat.stop when available', () => {
    const stopFn = jest.fn();
    const { controller } = createController({
      aether: {
        ipc: { send: jest.fn() },
        chat: { stop: stopFn },
        isDetachedWindow: false,
      },
    });
    controller.isProcessing = true;
    controller.stopProcessing();
    expect(stopFn).toHaveBeenCalled();
  });

  it('calls streamProcessor.resetStreamState', () => {
    const { controller } = createController();
    controller.isProcessing = true;
    controller.stopProcessing();
    expect(mockStreamProcessor.resetStreamState).toHaveBeenCalledTimes(1);
  });

  it('does not throw when aether.chat.stop is missing', () => {
    const { controller } = createController({
      aether: { ipc: { send: jest.fn() }, isDetachedWindow: false },
    });
    controller.isProcessing = true;
    expect(() => controller.stopProcessing()).not.toThrow();
  });

  it('catches and logs errors without rethrowing', () => {
    const { controller, eventBus } = createController();
    controller.isProcessing = true;
    // Force error by making emit throw
    eventBus.emit.mockImplementationOnce(() => { throw new Error('emit fail'); });
    expect(() => controller.stopProcessing()).not.toThrow();
    expect(mockLog.error).toHaveBeenCalledWith(
      'Stop processing failed',
      expect.objectContaining({ error: expect.any(Error) })
    );
  });
});


describe('ChatController — getStats', () => {
  beforeEach(() => clearAllMocks());

  it('returns frozen object', () => {
    const { controller } = createController();
    const stats = controller.getStats();
    expect(Object.isFrozen(stats)).toBe(true);
  });

  it('reflects initialized state', () => {
    const { controller } = createController();
    expect(controller.getStats().initialized).toBe(false);
    controller.initialized = true;
    expect(controller.getStats().initialized).toBe(true);
  });

  it('reflects backendConnected state', () => {
    const { controller } = createController();
    controller.backendConnected = true;
    expect(controller.getStats().backendConnected).toBe(true);
  });

  it('reflects currentChatId', () => {
    const { controller } = createController();
    controller.currentChatId = 'chat-42';
    expect(controller.getStats().currentChatId).toBe('chat-42');
  });

  it('reflects isDetachedWindow', () => {
    const { controller } = createController();
    expect(controller.getStats().isDetachedWindow).toBe(controller.isDetachedWindow);
  });

  it('reflects isProcessing', () => {
    const { controller } = createController();
    controller.isProcessing = true;
    expect(controller.getStats().isProcessing).toBe(true);
  });

  it('returns module names', () => {
    const { controller } = createController();
    controller.modules = { chatWindow: {}, fileManager: {} };
    expect(controller.getStats().modules).toEqual(['chatWindow', 'fileManager']);
  });

  it('returns messageCount from messageOrchestrator', () => {
    const { controller } = createController();
    controller.modules = {
      messageOrchestrator: {
        messageState: { messages: [1, 2, 3] },
      },
    };
    expect(controller.getStats().messageCount).toBe(3);
  });

  it('returns 0 messageCount when messageOrchestrator is absent', () => {
    const { controller } = createController();
    controller.modules = {};
    expect(controller.getStats().messageCount).toBe(0);
  });

  it('returns 0 messageCount when messageState is null', () => {
    const { controller } = createController();
    controller.modules = { messageOrchestrator: {} };
    expect(controller.getStats().messageCount).toBe(0);
  });
});


describe('ChatController — _generateChatId', () => {
  beforeEach(() => clearAllMocks());

  it('returns a string from crypto.randomUUID', () => {
    const { controller } = createController();
    const id = controller._generateChatId();
    expect(id).toBe('test-chat-uuid-1234');
  });

  it('throws if crypto.randomUUID is unavailable', () => {
    const origRandomUUID = global.crypto.randomUUID;
    delete global.crypto.randomUUID;

    try {
      const { controller } = createController();
      expect(() => controller._generateChatId()).toThrow('CONTRACT VIOLATION');
    } finally {
      global.crypto.randomUUID = origRandomUUID;
    }
  });
});


describe('ChatController — _detectDetachedMode', () => {
  const origLocation = window.location;
  beforeEach(() => clearAllMocks());
  afterEach(() => {
    delete window.DETACHED_CHAT;
    // Restore location by deleting override
    Object.defineProperty(window, 'location', {
      value: origLocation,
      writable: true,
      configurable: true,
    });
  });

  it('returns true when pathname includes chat.html', () => {
    Object.defineProperty(window, 'location', {
      value: { pathname: '/path/to/chat.html' },
      writable: true,
      configurable: true,
    });
    const { controller } = createController();
    expect(controller.isDetachedWindow).toBe(true);
  });

  it('returns true when DETACHED_CHAT flag is set', () => {
    window.DETACHED_CHAT = true;
    const { controller } = createController();
    expect(controller.isDetachedWindow).toBe(true);
  });

  it('returns true when aether.isDetachedWindow is true', () => {
    const { controller } = createController({
      aether: {
        ipc: { send: jest.fn() },
        chat: {},
        isDetachedWindow: true,
      },
    });
    expect(controller.isDetachedWindow).toBe(true);
  });

  it('returns false when none of the detached indicators are set', () => {
    Object.defineProperty(window, 'location', {
      value: { pathname: '/path/to/main.html' },
      writable: true,
      configurable: true,
    });
    delete window.DETACHED_CHAT;
    const { controller } = createController({
      aether: {
        ipc: { send: jest.fn() },
        chat: {},
        isDetachedWindow: false,
      },
    });
    expect(controller.isDetachedWindow).toBe(false);
  });
});


describe('ChatController — dispose', () => {
  beforeEach(() => clearAllMocks());

  it('disposes streamProcessor', () => {
    const { controller } = createController();
    controller.dispose();
    expect(mockStreamProcessor.dispose).toHaveBeenCalledTimes(1);
  });

  it('nulls streamProcessor after dispose', () => {
    const { controller } = createController();
    controller.dispose();
    expect(controller.streamProcessor).toBeNull();
  });

  it('disposes sessionMapRestorer', () => {
    const { controller } = createController();
    controller.dispose();
    expect(mockSessionMapRestorer.dispose).toHaveBeenCalledTimes(1);
  });

  it('nulls sessionMapRestorer after dispose', () => {
    const { controller } = createController();
    controller.dispose();
    expect(controller.sessionMapRestorer).toBeNull();
  });

  it('disposes proactiveContextHandler', () => {
    const { controller } = createController();
    controller.dispose();
    expect(mockProactiveContextHandler.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes chatSummaryAttacher', () => {
    const { controller } = createController();
    controller.dispose();
    expect(mockChatSummaryAttacher.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes messageDeletionHandler', () => {
    const { controller } = createController();
    controller.dispose();
    expect(mockMessageDeletionHandler.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes modules in reverse order', () => {
    const { controller } = createController();
    const disposalOrder = [];
    controller.modules = {
      chatWindow: { dispose: jest.fn(() => disposalOrder.push('chatWindow')) },
      fileManager: { dispose: jest.fn(() => disposalOrder.push('fileManager')) },
      messageOrchestrator: { dispose: jest.fn(() => disposalOrder.push('messageOrchestrator')) },
    };

    controller.dispose();

    // Reverse of Object.keys insertion order
    expect(disposalOrder).toEqual(['messageOrchestrator', 'fileManager', 'chatWindow']);
  });

  it('clears modules object after disposal', () => {
    const { controller } = createController();
    controller.modules = { chatWindow: { dispose: jest.fn() } };
    controller.dispose();
    expect(controller.modules).toEqual({});
  });

  it('executes IPC listener cleanup functions', () => {
    const { controller } = createController();
    const cleanup1 = jest.fn();
    const cleanup2 = jest.fn();
    controller._ipcListeners = [cleanup1, cleanup2];
    controller.dispose();
    expect(cleanup1).toHaveBeenCalledTimes(1);
    expect(cleanup2).toHaveBeenCalledTimes(1);
    expect(controller._ipcListeners).toEqual([]);
  });

  it('executes event listener cleanup functions', () => {
    const { controller } = createController();
    const cleanup1 = jest.fn();
    const cleanup2 = jest.fn();
    controller._eventListeners = [cleanup1, cleanup2];
    controller.dispose();
    expect(cleanup1).toHaveBeenCalledTimes(1);
    expect(cleanup2).toHaveBeenCalledTimes(1);
    expect(controller._eventListeners).toEqual([]);
  });

  it('closes BroadcastChannel', () => {
    const { controller } = createController();
    const closeFn = controller.sidebarRefreshChannel.close;
    controller.dispose();
    expect(closeFn).toHaveBeenCalledTimes(1);
    expect(controller.sidebarRefreshChannel).toBeNull();
  });

  it('does not throw when module dispose throws', () => {
    const { controller } = createController();
    controller.modules = {
      broken: { dispose: jest.fn(() => { throw new Error('module dispose fail'); }) },
    };
    expect(() => controller.dispose()).not.toThrow();
    expect(mockLog.error).toHaveBeenCalledWith(
      'Failed to dispose module',
      expect.objectContaining({ module: 'broken' })
    );
  });

  it('does not throw when IPC cleanup throws', () => {
    const { controller } = createController();
    controller._ipcListeners = [() => { throw new Error('ipc fail'); }];
    expect(() => controller.dispose()).not.toThrow();
    expect(mockLog.error).toHaveBeenCalledWith(
      'Failed to cleanup IPC listener',
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it('does not throw when event cleanup throws', () => {
    const { controller } = createController();
    controller._eventListeners = [() => { throw new Error('event fail'); }];
    expect(() => controller.dispose()).not.toThrow();
    expect(mockLog.error).toHaveBeenCalledWith(
      'Failed to cleanup event listener',
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it('nulls healthMonitor after dispose', () => {
    const { controller } = createController();
    controller.healthMonitor = { dispose: jest.fn() };
    controller.dispose();
    expect(controller.healthMonitor).toBeNull();
  });

  it('nulls sttManager after dispose', () => {
    const { controller } = createController();
    controller.sttManager = { dispose: jest.fn() };
    controller.dispose();
    expect(controller.sttManager).toBeNull();
  });

  it('nulls eventCoordinator after dispose', () => {
    const { controller } = createController();
    controller.eventCoordinator = { registerAll: jest.fn(), cleanup: jest.fn() };
    controller.dispose();
    expect(controller.eventCoordinator).toBeNull();
  });

  it('disposes trailRestorationService when it has dispose method', () => {
    const { controller } = createController();
    const disposeFn = jest.fn();
    controller.trailRestorationService = { dispose: disposeFn };
    controller.dispose();
    expect(disposeFn).toHaveBeenCalledTimes(1);
    expect(controller.trailRestorationService).toBeNull();
  });

  it('disposes contextService when it has dispose method', () => {
    const { controller } = createController();
    const disposeFn = jest.fn();
    controller.contextService = { dispose: disposeFn };
    controller.dispose();
    expect(disposeFn).toHaveBeenCalledTimes(1);
    expect(controller.contextService).toBeNull();
  });

  it('handles missing BroadcastChannel gracefully', () => {
    const { controller } = createController();
    controller.sidebarRefreshChannel = null;
    expect(() => controller.dispose()).not.toThrow();
  });

  it('skips module dispose when module has no dispose method', () => {
    const { controller } = createController();
    controller.modules = { noDispose: { render: jest.fn() } };
    expect(() => controller.dispose()).not.toThrow();
  });
});


describe('ChatController — BroadcastChannel message handler', () => {
  beforeEach(() => clearAllMocks());

  it('handles chat_message_added by incrementing sidebar count', () => {
    const { controller } = createController();
    const incrementChatCount = jest.fn();
    controller.modules = { sidebarManager: { incrementChatCount } };

    // Simulate receiving a BroadcastChannel message
    const channelInstance = global.BroadcastChannel.mock.results[global.BroadcastChannel.mock.results.length - 1].value;
    channelInstance.onmessage({ data: { type: 'chat_message_added', chat_id: 'chat-bc-1' } });

    expect(incrementChatCount).toHaveBeenCalledWith('chat-bc-1');
  });

  it('ignores messages with unknown type', () => {
    const { controller } = createController();
    const incrementChatCount = jest.fn();
    controller.modules = { sidebarManager: { incrementChatCount } };

    const channelInstance = global.BroadcastChannel.mock.results[global.BroadcastChannel.mock.results.length - 1].value;
    channelInstance.onmessage({ data: { type: 'unknown_event' } });

    expect(incrementChatCount).not.toHaveBeenCalled();
  });

  it('ignores messages without chat_id', () => {
    const { controller } = createController();
    const incrementChatCount = jest.fn();
    controller.modules = { sidebarManager: { incrementChatCount } };

    const channelInstance = global.BroadcastChannel.mock.results[global.BroadcastChannel.mock.results.length - 1].value;
    channelInstance.onmessage({ data: { type: 'chat_message_added' } });

    expect(incrementChatCount).not.toHaveBeenCalled();
  });

  it('ignores messages when sidebarManager not initialized', () => {
    const { controller } = createController();
    controller.modules = {};

    const channelInstance = global.BroadcastChannel.mock.results[global.BroadcastChannel.mock.results.length - 1].value;
    // Should not throw
    expect(() =>
      channelInstance.onmessage({ data: { type: 'chat_message_added', chat_id: 'c1' } })
    ).not.toThrow();
  });
});

// ============================================================================
// init() orchestration (lines 182-228)
// ============================================================================

describe('ChatController init() orchestration', () => {
  beforeEach(() => {
    clearAllMocks();
  });

  function stubInitPhases(controller) {
    controller._initializeCore = jest.fn().mockResolvedValue();
    controller._registerServices = jest.fn().mockResolvedValue();
    controller._initializeModules = jest.fn().mockResolvedValue();
    controller._setupIpcListeners = jest.fn().mockResolvedValue();
    controller._initializeGlobalState = jest.fn().mockResolvedValue();
    controller._loadExistingMessages = jest.fn().mockResolvedValue();
  }

  it('executes all 6 phases in sequence and sets initialized true', async () => {
    const { controller, eventBus } = createController();
    const order = [];
    controller._initializeCore = jest.fn().mockImplementation(() => { order.push(1); });
    controller._registerServices = jest.fn().mockImplementation(() => { order.push(2); });
    controller._initializeModules = jest.fn().mockImplementation(() => { order.push(3); });
    controller._setupIpcListeners = jest.fn().mockImplementation(() => { order.push(4); });
    controller._initializeGlobalState = jest.fn().mockImplementation(() => { order.push(5); });
    controller._loadExistingMessages = jest.fn().mockImplementation(() => { order.push(6); });

    await controller.init();

    expect(order).toEqual([1, 2, 3, 4, 5, 6]);
    expect(controller.initialized).toBe(true);
  });

  it('emits SYSTEM.READY with correct payload after init', async () => {
    const { controller, eventBus } = createController();
    stubInitPhases(controller);

    await controller.init();

    expect(eventBus.emit).toHaveBeenCalledWith(
      'system:ready',
      expect.objectContaining({
        controller: 'ChatController',
        timestamp: expect.any(Number),
        isDetachedWindow: expect.any(Boolean),
      }),
      { priority: 75 }
    );
  });

  it('processes pending proactive context after init completes', async () => {
    const { controller } = createController();
    stubInitPhases(controller);
    controller._handleProactiveContext = jest.fn().mockResolvedValue();

    const pendingCtx = { topic: 'weather', content: 'Rain today' };
    controller._pendingProactiveContext = pendingCtx;

    await controller.init();

    expect(controller._handleProactiveContext).toHaveBeenCalledWith(pendingCtx);
    expect(controller._pendingProactiveContext).toBeNull();
  });

  it('does not call _handleProactiveContext when nothing pending', async () => {
    const { controller } = createController();
    stubInitPhases(controller);
    controller._handleProactiveContext = jest.fn();

    await controller.init();

    expect(controller._handleProactiveContext).not.toHaveBeenCalled();
  });

  it('emits SYSTEM.ERROR and rethrows on phase failure', async () => {
    const { controller, eventBus } = createController();
    const phaseError = new Error('Module init exploded');
    controller._initializeCore = jest.fn().mockResolvedValue();
    controller._registerServices = jest.fn().mockResolvedValue();
    controller._initializeModules = jest.fn().mockRejectedValue(phaseError);
    controller._setupIpcListeners = jest.fn();
    controller._initializeGlobalState = jest.fn();
    controller._loadExistingMessages = jest.fn();

    await expect(controller.init()).rejects.toThrow('Module init exploded');

    expect(controller.initialized).toBe(false);
    expect(eventBus.emit).toHaveBeenCalledWith(
      'system:error',
      expect.objectContaining({
        error: phaseError,
        phase: 'initialization',
        fatal: true,
        controller: 'ChatController',
      })
    );
    // Phases after failure were NOT called
    expect(controller._setupIpcListeners).not.toHaveBeenCalled();
    expect(controller._initializeGlobalState).not.toHaveBeenCalled();
    expect(controller._loadExistingMessages).not.toHaveBeenCalled();
  });

  it('early phase failure skips all remaining phases', async () => {
    const { controller } = createController();
    controller._initializeCore = jest.fn().mockRejectedValue(new Error('core fail'));
    controller._registerServices = jest.fn();
    controller._initializeModules = jest.fn();
    controller._setupIpcListeners = jest.fn();
    controller._initializeGlobalState = jest.fn();
    controller._loadExistingMessages = jest.fn();

    await expect(controller.init()).rejects.toThrow('core fail');

    expect(controller._registerServices).not.toHaveBeenCalled();
    expect(controller._initializeModules).not.toHaveBeenCalled();
  });
});

// ============================================================================
// _initializeCore (lines 472-484)
// ============================================================================

describe('ChatController _initializeCore', () => {
  const sessionBridge = require('../../../../src/renderer/shared/adapters/session');

  beforeEach(() => {
    clearAllMocks();
    // Restore sessionBridge mock since resetMocks clears it
    sessionBridge.setActiveChat.mockResolvedValue();
  });

  it('generates and sets currentChatId via crypto.randomUUID', async () => {
    const { controller } = createController();
    controller.currentChatId = null;

    await controller._initializeCore();

    expect(controller.currentChatId).toBe('test-chat-uuid-1234');
  });

  it('calls sessionBridge.setActiveChat with generated ID', async () => {
    const { controller } = createController();

    await controller._initializeCore();

    expect(sessionBridge.setActiveChat).toHaveBeenCalledWith('test-chat-uuid-1234');
  });

  it('logs warning but does not throw when setActiveChat fails', async () => {
    sessionBridge.setActiveChat.mockRejectedValue(new Error('session fail'));
    const { controller } = createController();

    await expect(controller._initializeCore()).resolves.not.toThrow();

    expect(mockLog.warn).toHaveBeenCalledWith(
      'Unable to set active session during initialization',
      expect.objectContaining({ error: 'session fail' })
    );
  });
});

// ============================================================================
// _registerServices (lines 490-497)
// ============================================================================

describe('ChatController _registerServices', () => {
  beforeEach(() => {
    clearAllMocks();
  });

  it('completes without error and logs registration', async () => {
    const { controller } = createController();

    await expect(controller._registerServices()).resolves.not.toThrow();

    expect(mockLog.debug).toHaveBeenCalledWith('Registering additional services');
    expect(mockLog.trace).toHaveBeenCalledWith('Service registration complete');
  });
});

// ============================================================================
// _initializeModules (lines 503-704)
// ============================================================================

describe('ChatController _initializeModules', () => {
  function restoreLazyMocks() {
    // Restore implementations that resetMocks may have cleared
    mockChatWindowInstance.init.mockResolvedValue();
    mockChatWindowInstance.getElements.mockReturnValue({
      input: document.createElement('input'),
    });
    mockChatWindowInstance.elements.content = document.createElement('div');
    mockDragResizeInstance.init.mockResolvedValue();
    mockFileManagerInstance.init.mockResolvedValue();
    mockMessageOrchestratorInstance.init.mockResolvedValue();
    mockSidebarManagerInstance.init.mockResolvedValue();
  }

  beforeEach(() => {
    clearAllMocks();
    restoreLazyMocks();
  });

  it('initializes all modules in dependency order', async () => {
    const { controller } = createController();
    const order = [];
    mockChatWindowInstance.init.mockImplementation(() => order.push('chatWindow'));
    mockDragResizeInstance.init.mockImplementation(() => order.push('dragResize'));
    mockFileManagerInstance.init.mockImplementation(() => order.push('fileManager'));
    mockMessageOrchestratorInstance.init.mockImplementation(() => order.push('messageOrchestrator'));
    mockSidebarManagerInstance.init.mockImplementation(() => order.push('sidebarManager'));
    mockThinkingBubbleInstance.init.mockImplementation(() => order.push('thinkingBubble'));

    await controller._initializeModules();

    expect(order).toEqual([
      'chatWindow', 'dragResize', 'fileManager', 'messageOrchestrator',
      'sidebarManager', 'thinkingBubble',
    ]);
  });

  it('assigns all 7 sub-modules to controller.modules', async () => {
    const { controller } = createController();

    await controller._initializeModules();

    expect(controller.modules.chatWindow).toBe(mockChatWindowInstance);
    expect(controller.modules.dragResizeManager).toBe(mockDragResizeInstance);
    expect(controller.modules.fileManager).toBe(mockFileManagerInstance);
    expect(controller.modules.messageOrchestrator).toBe(mockMessageOrchestratorInstance);
    expect(controller.modules.sidebarManager).toBe(mockSidebarManagerInstance);
    expect(controller.modules.thinkingBubble).toBe(mockThinkingBubbleInstance);
    expect(controller.modules.trailEventRouter).toBe(mockTrailEventRouterInstance);
  });

  it('initializes coordinator modules (health, stt, trail, context, events)', async () => {
    const { controller } = createController();

    await controller._initializeModules();

    expect(controller.healthMonitor).toBeDefined();
    expect(controller.sttManager).toBeDefined();
    expect(controller.trailRestorationService).toBeDefined();
    expect(controller.contextService).toBeDefined();
    expect(controller.eventCoordinator).toBeDefined();
  });

  it('throws CONTRACT VIOLATION when API_BASE_URL is empty', async () => {
    const { controller } = createController();
    controller.config.API_BASE_URL = '';

    await expect(controller._initializeModules()).rejects.toThrow('CONTRACT VIOLATION');
  });

  it('throws CONTRACT VIOLATION when API_BASE_URL is whitespace', async () => {
    const { controller } = createController();
    controller.config.API_BASE_URL = '   ';

    await expect(controller._initializeModules()).rejects.toThrow('CONTRACT VIOLATION');
  });

  it('throws CONTRACT VIOLATION when API_BASE_URL is missing', async () => {
    const { controller } = createController();
    delete controller.config.API_BASE_URL;

    await expect(controller._initializeModules()).rejects.toThrow('CONTRACT VIOLATION');
  });

  it('propagates ChatWindow init error and logs it', async () => {
    const { controller } = createController();
    mockChatWindowInstance.init.mockRejectedValue(new Error('ChatWindow boom'));

    await expect(controller._initializeModules()).rejects.toThrow('ChatWindow boom');
    expect(mockLog.error).toHaveBeenCalledWith(
      'ChatWindow initialization failed',
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it('passes isDetached flag to DragResizeManager.init', async () => {
    const { controller } = createController();
    controller.isDetachedWindow = true;

    await controller._initializeModules();

    expect(mockDragResizeInstance.init).toHaveBeenCalledWith({ isDetached: true });
  });

  it('sets STTInputManager input element from ChatWindow elements', async () => {
    const { controller } = createController();
    const inputEl = document.createElement('input');
    mockChatWindowInstance.getElements.mockReturnValue({ input: inputEl });

    await controller._initializeModules();

    expect(controller.sttManager.setInputElement).toHaveBeenCalledWith(inputEl);
  });

  it('skips STTInputManager input setup when ChatWindow has no input element', async () => {
    const { controller } = createController();
    mockChatWindowInstance.getElements.mockReturnValue({ input: null });

    await controller._initializeModules();

    expect(controller.sttManager.setInputElement).not.toHaveBeenCalled();
  });

  it('appends ThinkingBubble container to chat content element', async () => {
    const { controller } = createController();
    const contentEl = document.createElement('div');
    mockChatWindowInstance.elements.content = contentEl;

    await controller._initializeModules();

    const thinkingContainer = contentEl.querySelector('.aether-thinking-container');
    expect(thinkingContainer).not.toBeNull();
    expect(thinkingContainer.style.cssText).toContain('width: 100%');
    expect(thinkingContainer.style.cssText).toContain('padding: 0');
  });

  it('skips ThinkingBubble container append when content element is null', async () => {
    const { controller } = createController();
    mockChatWindowInstance.elements.content = null;

    await controller._initializeModules();

    // ThinkingBubble still initialized — just not appended to DOM
    expect(controller.modules.thinkingBubble).toBe(mockThinkingBubbleInstance);
  });

  it('stores EventCoordinator cleanup functions in _eventListeners', async () => {
    const { controller } = createController();

    await controller._initializeModules();

    expect(controller.eventCoordinator).toBeDefined();
    // registerAll returns an array (mocked as [])
    expect(Array.isArray(controller._eventListeners)).toBe(true);
  });

  it('propagates DragResizeManager init error', async () => {
    const { controller } = createController();
    mockDragResizeInstance.init.mockRejectedValue(new Error('drag fail'));

    await expect(controller._initializeModules()).rejects.toThrow('drag fail');
    expect(mockLog.error).toHaveBeenCalledWith(
      'DragResizeManager initialization failed',
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it('propagates MessageOrchestrator init error', async () => {
    const { controller } = createController();
    mockMessageOrchestratorInstance.init.mockRejectedValue(new Error('orchestrator fail'));

    await expect(controller._initializeModules()).rejects.toThrow('orchestrator fail');
    expect(mockLog.error).toHaveBeenCalledWith(
      'MessageOrchestrator initialization failed',
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it('propagates SidebarManager init error', async () => {
    const { controller } = createController();
    mockSidebarManagerInstance.init.mockRejectedValue(new Error('sidebar fail'));

    await expect(controller._initializeModules()).rejects.toThrow('sidebar fail');
    expect(mockLog.error).toHaveBeenCalledWith(
      'SidebarManager initialization failed',
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it('propagates FileManager init error', async () => {
    const { controller } = createController();
    mockFileManagerInstance.init.mockRejectedValue(new Error('file fail'));

    await expect(controller._initializeModules()).rejects.toThrow('file fail');
    expect(mockLog.error).toHaveBeenCalledWith(
      'FileManager initialization failed',
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it('propagates BackendHealthMonitor constructor error', async () => {
    const BHM = require('../../../../src/renderer/chat/controllers/modules/BackendHealthMonitor');
    BHM.mockImplementationOnce(() => { throw new Error('BHM fail'); });
    const { controller } = createController();

    await expect(controller._initializeModules()).rejects.toThrow('BHM fail');
    expect(mockLog.error).toHaveBeenCalledWith(
      'BackendHealthMonitor initialization failed',
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it('propagates STTInputManager constructor error', async () => {
    const STT = require('../../../../src/renderer/chat/controllers/modules/STTInputManager');
    STT.mockImplementationOnce(() => { throw new Error('STT fail'); });
    const { controller } = createController();

    await expect(controller._initializeModules()).rejects.toThrow('STT fail');
    expect(mockLog.error).toHaveBeenCalledWith(
      'STTInputManager initialization failed',
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it('propagates TrailRestorationService constructor error', async () => {
    const { TrailRestorationService } = require('../../../../src/application/chat/TrailRestorationService');
    TrailRestorationService.mockImplementationOnce(() => { throw new Error('TRS fail'); });
    const { controller } = createController();

    await expect(controller._initializeModules()).rejects.toThrow('TRS fail');
    expect(mockLog.error).toHaveBeenCalledWith(
      'TrailRestorationService initialization failed',
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it('propagates ContextService constructor error', async () => {
    const { ContextService } = require('../../../../src/application/chat/ContextService');
    ContextService.mockImplementationOnce(() => { throw new Error('CS fail'); });
    const { controller } = createController();

    await expect(controller._initializeModules()).rejects.toThrow('CS fail');
    expect(mockLog.error).toHaveBeenCalledWith(
      'ContextService initialization failed',
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it('propagates EventCoordinator constructor error', async () => {
    const EC = require('../../../../src/renderer/chat/controllers/coordination/EventCoordinator');
    EC.mockImplementationOnce(() => { throw new Error('EC fail'); });
    const { controller } = createController();

    await expect(controller._initializeModules()).rejects.toThrow('EC fail');
    expect(mockLog.error).toHaveBeenCalledWith(
      'EventCoordinator initialization failed',
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it('propagates ThinkingBubble constructor error', async () => {
    const TB = require('../../../../src/renderer/chat/modules/thinking/ThinkingBubble');
    TB.mockImplementationOnce(() => { throw new Error('TB fail'); });
    const { controller } = createController();

    await expect(controller._initializeModules()).rejects.toThrow('TB fail');
    expect(mockLog.error).toHaveBeenCalledWith(
      'ThinkingBubble initialization failed',
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it('propagates TrailEventRouter constructor error', async () => {
    const TER = require('../../../../src/renderer/chat/modules/trail/TrailEventRouter');
    TER.mockImplementationOnce(() => { throw new Error('TER fail'); });
    const { controller } = createController();

    await expect(controller._initializeModules()).rejects.toThrow('TER fail');
    expect(mockLog.error).toHaveBeenCalledWith(
      'TrailEventRouter initialization failed',
      expect.objectContaining({ error: expect.any(Error) })
    );
  });
});

// ============================================================================
// _setupIpcListeners (lines 720-768)
// ============================================================================

describe('ChatController _setupIpcListeners', () => {
  function createChatAPI() {
    return {
      onAssistantStream: jest.fn(() => jest.fn()),
      onRequestComplete: jest.fn(() => jest.fn()),
      onEnsureVisible: jest.fn(() => jest.fn()),
      onLoadSpecific: jest.fn(() => jest.fn()),
      onProactiveContext: jest.fn(() => jest.fn()),
      onSttStream: jest.fn(() => jest.fn()),
      onNewRequested: jest.fn(() => jest.fn()),
    };
  }

  function createControllerWithChatAPI(chatAPI) {
    return createController({
      aether: {
        ipc: { send: jest.fn() },
        chat: chatAPI,
        artifacts: { streamReady: jest.fn() },
        isDetachedWindow: false,
      },
    });
  }

  beforeEach(() => {
    clearAllMocks();
  });

  it('registers 7 IPC listeners and stores cleanup functions', async () => {
    const chatAPI = createChatAPI();
    const { controller } = createControllerWithChatAPI(chatAPI);

    await controller._setupIpcListeners();

    expect(chatAPI.onAssistantStream).toHaveBeenCalledTimes(1);
    expect(chatAPI.onRequestComplete).toHaveBeenCalledTimes(1);
    expect(chatAPI.onEnsureVisible).toHaveBeenCalledTimes(1);
    expect(chatAPI.onLoadSpecific).toHaveBeenCalledTimes(1);
    expect(chatAPI.onProactiveContext).toHaveBeenCalledTimes(1);
    expect(chatAPI.onSttStream).toHaveBeenCalledTimes(1);
    expect(chatAPI.onNewRequested).toHaveBeenCalledTimes(1);
    expect(controller._ipcListeners).toHaveLength(7);
  });

  it('throws CONTRACT VIOLATION when aether.chat is missing', async () => {
    const { controller } = createControllerWithChatAPI(null);

    await expect(controller._setupIpcListeners()).rejects.toThrow('CONTRACT VIOLATION');
  });

  it('throws CONTRACT VIOLATION when aether.chat is undefined', async () => {
    const { controller } = createController({
      aether: { ipc: { send: jest.fn() }, artifacts: { streamReady: jest.fn() }, isDetachedWindow: false },
    });

    await expect(controller._setupIpcListeners()).rejects.toThrow('CONTRACT VIOLATION');
  });

  it('onAssistantStream callback delegates to _handleAssistantStream', async () => {
    const chatAPI = createChatAPI();
    const { controller } = createControllerWithChatAPI(chatAPI);
    controller._handleAssistantStream = jest.fn();

    await controller._setupIpcListeners();

    const callback = chatAPI.onAssistantStream.mock.calls[0][0];
    callback({ chunk: 'hello' });
    expect(controller._handleAssistantStream).toHaveBeenCalledWith({ chunk: 'hello' });
  });

  it('onRequestComplete callback delegates to _handleRequestComplete', async () => {
    const chatAPI = createChatAPI();
    const { controller } = createControllerWithChatAPI(chatAPI);
    controller._handleRequestComplete = jest.fn();

    await controller._setupIpcListeners();

    const callback = chatAPI.onRequestComplete.mock.calls[0][0];
    callback({ status: 'done' });
    expect(controller._handleRequestComplete).toHaveBeenCalledWith({ status: 'done' });
  });

  it('onEnsureVisible callback delegates to _handleEnsureVisible', async () => {
    const chatAPI = createChatAPI();
    const { controller } = createControllerWithChatAPI(chatAPI);
    controller._handleEnsureVisible = jest.fn();

    await controller._setupIpcListeners();

    const callback = chatAPI.onEnsureVisible.mock.calls[0][0];
    callback();
    expect(controller._handleEnsureVisible).toHaveBeenCalledTimes(1);
  });

  it('onLoadSpecific callback delegates to _handleLoadSpecificChat', async () => {
    const chatAPI = createChatAPI();
    const { controller } = createControllerWithChatAPI(chatAPI);
    controller._handleLoadSpecificChat = jest.fn();

    await controller._setupIpcListeners();

    const callback = chatAPI.onLoadSpecific.mock.calls[0][0];
    callback({ chatId: 'specific-chat' });
    expect(controller._handleLoadSpecificChat).toHaveBeenCalledWith({ chatId: 'specific-chat' });
  });

  it('onProactiveContext callback delegates to _handleProactiveContext', async () => {
    const chatAPI = createChatAPI();
    const { controller } = createControllerWithChatAPI(chatAPI);
    controller._handleProactiveContext = jest.fn();

    await controller._setupIpcListeners();

    const callback = chatAPI.onProactiveContext.mock.calls[0][0];
    callback({ topic: 'test' });
    expect(controller._handleProactiveContext).toHaveBeenCalledWith({ topic: 'test' });
  });

  it('onSttStream callback delegates to _handleSttStream', async () => {
    const chatAPI = createChatAPI();
    const { controller } = createControllerWithChatAPI(chatAPI);
    controller._handleSttStream = jest.fn();

    await controller._setupIpcListeners();

    const callback = chatAPI.onSttStream.mock.calls[0][0];
    callback({ audio: 'data' });
    expect(controller._handleSttStream).toHaveBeenCalledWith({ audio: 'data' });
  });
});

// ============================================================================
// _initializeGlobalState (lines 774-788)
// ============================================================================

describe('ChatController _initializeGlobalState', () => {
  beforeEach(() => {
    clearAllMocks();
  });

  it('sets backendConnected true when health check passes', async () => {
    const { controller } = createController();
    controller.healthMonitor = {
      checkAndEmit: jest.fn().mockResolvedValue(true),
      dispose: jest.fn(),
    };

    await controller._initializeGlobalState();

    expect(controller.backendConnected).toBe(true);
    expect(controller.healthMonitor.checkAndEmit).toHaveBeenCalledTimes(1);
    expect(mockLog.info).toHaveBeenCalledWith('Backend health check succeeded');
  });

  it('sets backendConnected false when health check fails', async () => {
    const { controller } = createController();
    controller.healthMonitor = {
      checkAndEmit: jest.fn().mockResolvedValue(false),
      dispose: jest.fn(),
    };

    await controller._initializeGlobalState();

    expect(controller.backendConnected).toBe(false);
    expect(mockLog.warn).toHaveBeenCalledWith('Backend health check failed');
  });
});

// ============================================================================
// _loadExistingMessages (lines 794-863)
// ============================================================================

describe('ChatController _loadExistingMessages', () => {
  let controller;
  let mockOrchestrator;

  beforeEach(() => {
    clearAllMocks();
    ({ controller } = createController());
    mockOrchestrator = {
      messageState: { chatService: null, storageAPI: null },
      createChat: jest.fn().mockResolvedValue('new-chat-id'),
      loadChat: jest.fn().mockResolvedValue(),
    };
    controller.modules.messageOrchestrator = mockOrchestrator;
  });

  it('creates local chat when no persistence is available', async () => {
    await controller._loadExistingMessages();

    expect(mockOrchestrator.createChat).toHaveBeenCalledWith('New Chat');
    expect(controller.currentChatId).toBe('new-chat-id');
    expect(mockOrchestrator.loadChat).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith(
      'No chat persistence available, creating local chat'
    );
  });

  it('loads most recent chat via chatService using reduce logic', async () => {
    mockOrchestrator.messageState.chatService = {
      loadAllChats: jest.fn().mockResolvedValue([
        { id: 'chat-old', updatedAt: '2026-01-01' },
        { id: 'chat-new', updatedAt: '2026-02-10' },
      ]),
    };

    await controller._loadExistingMessages();

    expect(mockOrchestrator.loadChat).toHaveBeenCalledWith('chat-new', { reason: 'startup' });
    expect(controller.currentChatId).toBe('chat-new');
    expect(mockOrchestrator.createChat).not.toHaveBeenCalled();
  });

  it('loads first chat from storageAPI when no chatService', async () => {
    mockOrchestrator.messageState.storageAPI = {
      loadChats: jest.fn().mockResolvedValue([
        { id: 'storage-1' },
        { id: 'storage-2' },
      ]),
    };

    await controller._loadExistingMessages();

    // storageAPI path uses chats[0], not reduce
    expect(mockOrchestrator.loadChat).toHaveBeenCalledWith('storage-1', { reason: 'startup' });
    expect(controller.currentChatId).toBe('storage-1');
  });

  it('extracts ID via toJSON() when chat has that method', async () => {
    mockOrchestrator.messageState.chatService = {
      loadAllChats: jest.fn().mockResolvedValue([
        { toJSON: () => ({ id: 'json-id-42' }), updatedAt: '2026-02-10' },
      ]),
    };

    await controller._loadExistingMessages();

    expect(mockOrchestrator.loadChat).toHaveBeenCalledWith('json-id-42', { reason: 'startup' });
    expect(controller.currentChatId).toBe('json-id-42');
  });

  it('creates new chat when most recent has no ID and no toJSON', async () => {
    mockOrchestrator.messageState.chatService = {
      loadAllChats: jest.fn().mockResolvedValue([
        { updatedAt: '2026-02-10' }, // no .id, no .toJSON
      ]),
    };

    await controller._loadExistingMessages();

    expect(mockOrchestrator.createChat).toHaveBeenCalledWith('New Chat');
    expect(controller.currentChatId).toBe('new-chat-id');
    expect(mockLog.warn).toHaveBeenCalledWith('Most recent chat missing ID, creating new chat');
  });

  it('creates new chat when chats array is empty', async () => {
    mockOrchestrator.messageState.chatService = {
      loadAllChats: jest.fn().mockResolvedValue([]),
    };

    await controller._loadExistingMessages();

    expect(mockOrchestrator.createChat).toHaveBeenCalledWith('New Chat');
    expect(controller.currentChatId).toBe('new-chat-id');
    expect(mockLog.info).toHaveBeenCalledWith('No existing chats found, creating new chat');
  });

  it('falls back to createChat when loadAllChats throws', async () => {
    mockOrchestrator.messageState.chatService = {
      loadAllChats: jest.fn().mockRejectedValue(new Error('DB down')),
    };

    await controller._loadExistingMessages();

    expect(mockOrchestrator.createChat).toHaveBeenCalledWith('New Chat');
    expect(controller.currentChatId).toBe('new-chat-id');
    expect(mockLog.error).toHaveBeenCalledWith(
      'Failed to load existing messages',
      expect.objectContaining({ error: expect.any(Error) })
    );
    expect(mockLog.warn).toHaveBeenCalledWith(
      'Created fallback chat after load error',
      expect.objectContaining({ chatId: 'new-chat-id' })
    );
  });

  it('keeps pre-existing chatId when both load and fallback fail', async () => {
    controller.currentChatId = 'core-init-id';
    mockOrchestrator.messageState.chatService = {
      loadAllChats: jest.fn().mockRejectedValue(new Error('DB down')),
    };
    mockOrchestrator.createChat.mockRejectedValue(new Error('Create failed too'));

    await controller._loadExistingMessages();

    expect(controller.currentChatId).toBe('core-init-id');
    expect(mockLog.error).toHaveBeenCalledWith(
      'Failed to create fallback chat',
      expect.objectContaining({ error: expect.any(Error) })
    );
    expect(mockLog.warn).toHaveBeenCalledWith(
      'Using generated chat ID from core initialization as fallback',
      expect.objectContaining({ chatId: 'core-init-id' })
    );
  });

  it('selects most recent using all timestamp field variants', async () => {
    mockOrchestrator.messageState.chatService = {
      loadAllChats: jest.fn().mockResolvedValue([
        { id: 'a', created_at: '2026-02-01' },
        { id: 'b', updated_at: '2026-02-05' },
        { id: 'c', createdAt: '2026-02-10' },
      ]),
    };

    await controller._loadExistingMessages();

    expect(mockOrchestrator.loadChat).toHaveBeenCalledWith('c', { reason: 'startup' });
    expect(controller.currentChatId).toBe('c');
  });

  it('logs active chat session after successful load', async () => {
    mockOrchestrator.messageState.chatService = {
      loadAllChats: jest.fn().mockResolvedValue([
        { id: 'loaded-id', updatedAt: '2026-02-10' },
      ]),
    };

    await controller._loadExistingMessages();

    expect(mockLog.info).toHaveBeenCalledWith(
      'Active chat session established',
      expect.objectContaining({ chatId: 'loaded-id' })
    );
  });

  it('prefers chatService over storageAPI when both available', async () => {
    mockOrchestrator.messageState.chatService = {
      loadAllChats: jest.fn().mockResolvedValue([
        { id: 'service-chat', updatedAt: '2026-02-10' },
      ]),
    };
    mockOrchestrator.messageState.storageAPI = {
      loadChats: jest.fn().mockResolvedValue([{ id: 'storage-chat' }]),
    };

    await controller._loadExistingMessages();

    expect(mockOrchestrator.loadChat).toHaveBeenCalledWith('service-chat', { reason: 'startup' });
    expect(mockOrchestrator.messageState.storageAPI.loadChats).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Constructor callbacks (lines 106-107)
// ============================================================================

describe('ChatController constructor callbacks', () => {
  beforeEach(() => {
    clearAllMocks();
  });

  it('getChatWindow closure returns chatWindow module or null', () => {
    const StreamProcessorCtor = require(
      '../../../../src/renderer/chat/controllers/modules/StreamProcessor'
    );
    const { controller } = createController();

    const callArgs = StreamProcessorCtor.mock.calls[
      StreamProcessorCtor.mock.calls.length - 1
    ];
    const opts = callArgs[0];

    // Before chatWindow assigned — returns null
    expect(opts.getChatWindow()).toBeNull();

    // After setting chatWindow
    const fakeChatWindow = { render: jest.fn() };
    controller.modules.chatWindow = fakeChatWindow;
    expect(opts.getChatWindow()).toBe(fakeChatWindow);
  });

  it('onProcessingComplete closure sets isProcessing to false', () => {
    const StreamProcessorCtor = require(
      '../../../../src/renderer/chat/controllers/modules/StreamProcessor'
    );
    const { controller } = createController();

    const opts = StreamProcessorCtor.mock.calls[
      StreamProcessorCtor.mock.calls.length - 1
    ][0];

    controller.isProcessing = true;
    opts.onProcessingComplete();
    expect(controller.isProcessing).toBe(false);
  });
});

// ============================================================================
// BroadcastChannel constructor failure (line 176)
// ============================================================================

describe('ChatController BroadcastChannel constructor failure', () => {
  it('logs warning and continues when BroadcastChannel throws', () => {
    const originalBC = global.BroadcastChannel;
    global.BroadcastChannel = jest.fn(() => {
      throw new Error('BC not supported');
    });

    try {
      const { controller } = createController();

      expect(controller.sidebarRefreshChannel).toBeNull();
      expect(mockLog.warn).toHaveBeenCalledWith(
        'Failed to initialize BroadcastChannel',
        expect.objectContaining({ error: expect.any(Error) })
      );
    } finally {
      global.BroadcastChannel = originalBC;
    }
  });
});

// ============================================================================
// dispose — BroadcastChannel close error (line 341)
// ============================================================================

describe('ChatController dispose — BroadcastChannel close error', () => {
  beforeEach(() => {
    clearAllMocks();
  });

  it('logs error when BroadcastChannel.close() throws', () => {
    const { controller } = createController();
    const channelInstance = global.BroadcastChannel.mock.results[
      global.BroadcastChannel.mock.results.length - 1
    ].value;
    channelInstance.close.mockImplementation(() => {
      throw new Error('Already closed');
    });

    expect(() => controller.dispose()).not.toThrow();
    expect(mockLog.error).toHaveBeenCalledWith(
      'Failed to close BroadcastChannel',
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it('nulls window.sidebarRefreshChannel when it matches', () => {
    const { controller } = createController();
    const channelRef = controller.sidebarRefreshChannel;
    window.sidebarRefreshChannel = channelRef;

    controller.dispose();

    expect(window.sidebarRefreshChannel).toBeNull();
    expect(controller.sidebarRefreshChannel).toBeNull();
  });
});
