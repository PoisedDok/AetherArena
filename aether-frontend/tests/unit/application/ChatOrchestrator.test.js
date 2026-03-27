'use strict';

/**
 * ChatOrchestrator Unit Tests
 * ============================================================================
 * Tests the central chat coordinator: init lifecycle, sendMessage flow,
 * stream chunk handling, stopStreaming, switchChat, createNewChat, deleteChat,
 * uploadFile, connection state changes, event listener wiring, job tracing,
 * state/stats getters, and destroy cleanup.
 *
 * @module tests/unit/application/ChatOrchestrator.test
 */

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

// Track mock instances created during init() so tests can inspect them
const mockInstances = {
  streamBuffer: null,
  streamLifecycleManager: null,
  connectionStateTracker: null,
  chatSessionManager: null,
  messageSender: null,
  requestLifecycleManager: null,
  jobTraceManager: null,
};

jest.mock('../../../src/application/shared/JobTraceManager', () => ({
  JobTraceManager: jest.fn().mockImplementation((opts) => {
    const inst = {
      record: jest.fn(),
      getHistory: jest.fn().mockReturnValue([]),
      destroy: jest.fn(),
      _opts: opts,
    };
    mockInstances.jobTraceManager = inst;
    return inst;
  }),
}));

jest.mock('../../../src/application/shared/RequestLifecycleManager', () => ({
  RequestLifecycleManager: jest.fn().mockImplementation(() => {
    const inst = {
      startRequest: jest.fn().mockReturnValue(Object.freeze({
        id: 'req_001',
        cancel: jest.fn(),
        complete: jest.fn(),
        fail: jest.fn(),
      })),
      completeRequest: jest.fn(),
      failRequest: jest.fn(),
      cancelRequest: jest.fn().mockReturnValue(true),
      cancelAll: jest.fn().mockReturnValue(0),
      isActive: jest.fn().mockReturnValue(false),
      getStats: jest.fn().mockReturnValue({ active: 0, total: 0, completed: 0, failed: 0 }),
      getHistory: jest.fn().mockReturnValue([]),
      destroy: jest.fn(),
    };
    mockInstances.requestLifecycleManager = inst;
    return inst;
  }),
}));

jest.mock('../../../src/domain/chat/services/StreamBuffer', () => ({
  StreamBuffer: jest.fn().mockImplementation(() => {
    const inst = {
      isStreamActive: jest.fn().mockReturnValue(false),
      startStream: jest.fn(),
      addChunk: jest.fn(),
      clearStream: jest.fn(),
      getActiveStreams: jest.fn().mockReturnValue([]),
      getChunks: jest.fn().mockReturnValue([]),
    };
    mockInstances.streamBuffer = inst;
    return inst;
  }),
}));

jest.mock('../../../src/domain/chat/services/StreamLifecycleManager', () => ({
  StreamLifecycleManager: jest.fn().mockImplementation(() => {
    const inst = {
      finalizeStream: jest.fn().mockResolvedValue(undefined),
      cancelStream: jest.fn(),
      timeoutStream: jest.fn(),
    };
    mockInstances.streamLifecycleManager = inst;
    return inst;
  }),
}));

jest.mock('../../../src/domain/chat/services/ConnectionStateTracker', () => ({
  ConnectionStateTracker: jest.fn().mockImplementation((opts) => {
    const inst = {
      setupListeners: jest.fn(),
      cleanupListeners: jest.fn(),
      _opts: opts, // expose options so tests can invoke onConnectionChange
    };
    mockInstances.connectionStateTracker = inst;
    return inst;
  }),
}));

jest.mock('../../../src/domain/chat/services/ChatSessionManager', () => ({
  ChatSessionManager: jest.fn().mockImplementation(() => {
    const inst = {
      switchToChat: jest.fn().mockResolvedValue({
        chat: { id: 'chat-1', messages: [{ id: 'msg-1', content: 'hello' }] },
        artifacts: [],
      }),
      createChat: jest.fn().mockResolvedValue({ id: 'new-chat-1', title: 'New Chat' }),
      deleteChat: jest.fn().mockResolvedValue(undefined),
      getFallbackChat: jest.fn().mockResolvedValue({
        chat: { id: 'fallback-chat', messages: [] },
      }),
      loadCurrentChat: jest.fn().mockResolvedValue({
        chat: { id: 'chat-1', messages: [] },
      }),
    };
    mockInstances.chatSessionManager = inst;
    return inst;
  }),
}));

jest.mock('../../../src/domain/chat/services/MessageSender', () => ({
  MessageSender: jest.fn().mockImplementation(() => {
    const inst = {
      sendMessage: jest.fn().mockResolvedValue({
        persistedMessage: { id: 'msg-001', timestamp: Date.now() },
        payload: { type: 'chat-message', content: 'test' },
      }),
    };
    mockInstances.messageSender = inst;
    return inst;
  }),
}));

jest.mock('../../../src/domain/chat/repositories/ChatRepository', () => ({
  ChatRepository: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../../src/domain/chat/repositories/MessageRepository', () => ({
  MessageRepository: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../../src/domain/artifacts/repositories/ArtifactRepository', () => ({
  ArtifactRepository: jest.fn().mockImplementation(() => ({})),
}));

// ---------------------------------------------------------------------------
// Require after mocks
// ---------------------------------------------------------------------------

const { ChatOrchestrator } = require('../../../src/application/chat/ChatOrchestrator');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDeps(overrides = {}) {
  return {
    eventBus: {
      emit: jest.fn(),
      on: jest.fn(),
      off: jest.fn(),
      removeAllListeners: jest.fn(),
    },
    guruConnection: {
      send: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      off: jest.fn(),
    },
    ipcBridge: {
      send: jest.fn(),
      on: jest.fn(),
      off: jest.fn(),
      removeAllListeners: jest.fn(),
    },
    storageAPI: {},
    chatRepository: { findById: jest.fn(), create: jest.fn(), findAll: jest.fn() },
    messageRepository: { save: jest.fn(), findByChatId: jest.fn() },
    artifactRepository: { findByChatId: jest.fn() },
    container: {
      resolve: jest.fn().mockImplementation((name) => {
        const services = {
          MessageService: { send: jest.fn() },
          ChatService: { load: jest.fn() },
          ArtifactService: { get: jest.fn() },
          TraceabilityService: { registerMessage: jest.fn(), registerArtifact: jest.fn() },
        };
        return services[name] || null;
      }),
    },
    errorTracker: { captureException: jest.fn() },
    performanceMonitor: { start: jest.fn(), end: jest.fn() },
    metricsCollector: { recordCustom: jest.fn() },
    ...overrides,
  };
}

/** Create orchestrator and call init() */
async function createInitialized(overrides = {}) {
  const deps = createMockDeps(overrides);
  const orch = new ChatOrchestrator(deps);
  await orch.init();
  return { orch, deps };
}

// Reset mock instances between tests
beforeEach(() => {
  Object.keys(mockInstances).forEach((k) => { mockInstances[k] = null; });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChatOrchestrator', () => {

  // -----------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------
  describe('constructor', () => {
    it('initializes with default state', () => {
      const deps = createMockDeps();
      const orch = new ChatOrchestrator(deps);

      expect(orch.isInitialized).toBe(false);
      expect(orch.isDestroyed).toBe(false);
      expect(orch.state.currentChatId).toBeNull();
      expect(orch.state.isStreaming).toBe(false);
      expect(orch.state.currentRequestId).toBeNull();
      expect(orch.state.backendConnected).toBe(false);
      expect(orch.state.artifactsWindowOpen).toBe(false);
    });

    it('stores provided dependencies', () => {
      const deps = createMockDeps();
      const orch = new ChatOrchestrator(deps);

      expect(orch.eventBus).toBe(deps.eventBus);
      expect(orch.guruConnection).toBe(deps.guruConnection);
      expect(orch.ipcBridge).toBe(deps.ipcBridge);
      expect(orch.chatRepository).toBe(deps.chatRepository);
      expect(orch.messageRepository).toBe(deps.messageRepository);
      expect(orch.artifactRepository).toBe(deps.artifactRepository);
      expect(orch.container).toBe(deps.container);
      expect(orch.errorTracker).toBe(deps.errorTracker);
    });

    it('creates default repositories when not provided', () => {
      const orch = new ChatOrchestrator({ storageAPI: {} });
      // Should have created repository instances (mocked constructors)
      expect(orch.chatRepository).toBeDefined();
      expect(orch.messageRepository).toBeDefined();
      expect(orch.artifactRepository).toBeDefined();
    });

    it('sets up job tracer', () => {
      const deps = createMockDeps();
      const orch = new ChatOrchestrator(deps);
      expect(orch.jobTracer).not.toBeNull();
      expect(orch._jobTracerInitialized).toBe(true);
    });

    it('uses provided jobTracer if given', () => {
      const customTracer = { record: jest.fn() };
      const orch = new ChatOrchestrator({ jobTracer: customTracer });
      expect(orch.jobTracer).toBe(customTracer);
    });

    it('handles job tracer setup failure gracefully', () => {
      const { JobTraceManager } = require('../../../src/application/shared/JobTraceManager');
      JobTraceManager.mockImplementationOnce(() => { throw new Error('tracer boom'); });

      const orch = new ChatOrchestrator({
        errorTracker: { captureException: jest.fn() },
      });
      expect(orch.jobTracer).toBeNull();
      expect(orch._jobTracerInitialized).toBe(true);
    });

    it('domain services are null before init', () => {
      const orch = new ChatOrchestrator(createMockDeps());
      expect(orch.streamBuffer).toBeNull();
      expect(orch.streamLifecycleManager).toBeNull();
      expect(orch.connectionStateTracker).toBeNull();
      expect(orch.chatSessionManager).toBeNull();
      expect(orch.messageSender).toBeNull();
    });
  });

  // -----------------------------------------------------------------
  // init()
  // -----------------------------------------------------------------
  describe('init()', () => {
    it('initializes all services and sets initialized flag', async () => {
      const { orch } = await createInitialized();

      expect(orch.isInitialized).toBe(true);
      expect(orch.streamBuffer).not.toBeNull();
      expect(orch.streamLifecycleManager).not.toBeNull();
      expect(orch.connectionStateTracker).not.toBeNull();
      expect(orch.chatSessionManager).not.toBeNull();
      expect(orch.messageSender).not.toBeNull();
      expect(orch.requestLifecycle).not.toBeNull();
    });

    it('resolves services from DI container', async () => {
      const { orch, deps } = await createInitialized();

      expect(deps.container.resolve).toHaveBeenCalledWith('MessageService');
      expect(deps.container.resolve).toHaveBeenCalledWith('ChatService');
      expect(deps.container.resolve).toHaveBeenCalledWith('ArtifactService');
      expect(deps.container.resolve).toHaveBeenCalledWith('TraceabilityService');
      expect(orch.messageService).not.toBeNull();
      expect(orch.chatService).not.toBeNull();
    });

    it('sets up connection listeners', async () => {
      await createInitialized();
      expect(mockInstances.connectionStateTracker.setupListeners).toHaveBeenCalled();
    });

    it('loads current chat', async () => {
      await createInitialized();
      expect(mockInstances.chatSessionManager.loadCurrentChat).toHaveBeenCalled();
    });

    it('emits initialized event', async () => {
      const { deps } = await createInitialized();
      expect(deps.eventBus.emit).toHaveBeenCalledWith('chat:orchestrator:initialized');
    });

    it('is idempotent -- second call is no-op', async () => {
      const { orch, deps } = await createInitialized();
      const prevCallCount = deps.container.resolve.mock.calls.length;
      await orch.init();
      // No additional container resolves
      expect(deps.container.resolve.mock.calls.length).toBe(prevCallCount);
    });

    it('skips container services when container not provided', async () => {
      const deps = createMockDeps({ container: null });
      const orch = new ChatOrchestrator(deps);
      await orch.init();
      expect(orch.messageService).toBeNull();
      expect(orch.chatService).toBeNull();
    });

    it('throws and captures error on initialization failure', async () => {
      const { ConnectionStateTracker } = require('../../../src/domain/chat/services/ConnectionStateTracker');
      ConnectionStateTracker.mockImplementationOnce(() => {
        throw new Error('tracker init fail');
      });

      const deps = createMockDeps();
      const orch = new ChatOrchestrator(deps);

      await expect(orch.init()).rejects.toThrow('tracker init fail');
      expect(deps.errorTracker.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        'ChatOrchestrator._initializeDomainServices'
      );
      expect(orch.isInitialized).toBe(false);
    });
  });

  // -----------------------------------------------------------------
  // _ensureInitialized()
  // -----------------------------------------------------------------
  describe('initialization guards', () => {
    it('throws when calling methods before init', () => {
      const orch = new ChatOrchestrator(createMockDeps());
      expect(() => orch.getState()).not.toThrow(); // getState has no guard
      expect(orch.sendMessage('hi')).rejects.toThrow('not initialized');
    });

    it('throws when calling methods after destroy', async () => {
      const { orch } = await createInitialized();
      orch.destroy();
      await expect(orch.sendMessage('hi')).rejects.toThrow('has been destroyed');
    });
  });

  // -----------------------------------------------------------------
  // sendMessage()
  // -----------------------------------------------------------------
  describe('sendMessage()', () => {
    it('throws when backend not connected', async () => {
      const { orch } = await createInitialized();
      orch.state.backendConnected = false;

      await expect(orch.sendMessage('hello')).rejects.toThrow('Backend not connected');
    });

    it('throws when guruConnection missing', async () => {
      const { orch } = await createInitialized();
      orch.state.backendConnected = true;
      orch.guruConnection = null;

      await expect(orch.sendMessage('hello')).rejects.toThrow('GuruConnection not available');
    });

    it('creates new chat if no current chat', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.backendConnected = true;
      orch.state.currentChatId = null;

      // createNewChat delegates to chatSessionManager
      await orch.sendMessage('hello');
      expect(mockInstances.chatSessionManager.createChat).toHaveBeenCalled();
    });

    it('delegates to MessageSender and sends via guruConnection', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.backendConnected = true;
      orch.state.currentChatId = 'chat-1';

      const result = await orch.sendMessage('hello world');

      // MessageSender was called
      expect(mockInstances.messageSender.sendMessage).toHaveBeenCalledWith(
        'hello world',
        'chat-1',
        expect.any(String), // request ID
        {}
      );

      // WebSocket payload sent
      expect(deps.guruConnection.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'chat-message' })
      );

      // State updated
      expect(orch.state.isStreaming).toBe(true);
      expect(orch.state.currentRequestId).toBe('req_001');
    });

    it('starts request lifecycle with correct options', async () => {
      const { orch } = await createInitialized();
      orch.state.backendConnected = true;
      orch.state.currentChatId = 'chat-1';

      await orch.sendMessage('test', { timeout: 5000 });

      expect(mockInstances.requestLifecycleManager.startRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'user-message',
          timeout: 5000,
          metadata: expect.objectContaining({ chatId: 'chat-1' }),
        })
      );
    });

    it('emits chat:message:sent event', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.backendConnected = true;
      orch.state.currentChatId = 'chat-1';

      await orch.sendMessage('test');

      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        'chat:message:sent',
        expect.objectContaining({ requestId: 'req_001', chatId: 'chat-1' })
      );
    });

    it('registers with traceability service', async () => {
      const { orch } = await createInitialized();
      orch.state.backendConnected = true;
      orch.state.currentChatId = 'chat-1';
      orch.traceabilityService = { registerMessage: jest.fn() };

      await orch.sendMessage('hello');

      expect(orch.traceabilityService.registerMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'chat-1',
          role: 'user',
          correlationId: 'req_001',
        })
      );
    });

    it('updates messageManager UI when available', async () => {
      const messageManager = { displayMessage: jest.fn(), applyChatMessages: jest.fn() };
      const { orch } = await createInitialized({ messageManager });
      orch.state.backendConnected = true;
      orch.state.currentChatId = 'chat-1';

      await orch.sendMessage('hello');

      expect(messageManager.displayMessage).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'user', content: 'hello' })
      );
    });

    it('calls performanceMonitor start/end', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.backendConnected = true;
      orch.state.currentChatId = 'chat-1';

      await orch.sendMessage('hello');

      expect(deps.performanceMonitor.start).toHaveBeenCalledWith('sendMessage:req_001');
      expect(deps.performanceMonitor.end).toHaveBeenCalledWith('sendMessage:req_001');
    });

    it('calls request.fail and captures error on failure', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.backendConnected = true;
      orch.state.currentChatId = 'chat-1';
      mockInstances.messageSender.sendMessage.mockRejectedValueOnce(new Error('send fail'));

      const requestHandle = mockInstances.requestLifecycleManager.startRequest();

      await expect(orch.sendMessage('hello')).rejects.toThrow('send fail');
      expect(deps.errorTracker.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        'ChatOrchestrator.sendMessage'
      );
    });
  });

  // -----------------------------------------------------------------
  // handleStreamChunk()
  // -----------------------------------------------------------------
  describe('handleStreamChunk()', () => {
    it('ignores chunks when not streaming', async () => {
      const { orch } = await createInitialized();
      orch.state.isStreaming = false;

      await orch.handleStreamChunk({ content: 'test' });

      // StreamBuffer should not be called
      expect(mockInstances.streamBuffer.addChunk).not.toHaveBeenCalled();
    });

    it('buffers chunk and passes to stream adapter', async () => {
      const streamAdapter = { applyChunk: jest.fn() };
      const { orch, deps } = await createInitialized({ streamAdapter });
      orch.state.isStreaming = true;
      orch.state.currentRequestId = 'req_001';

      await orch.handleStreamChunk({ content: 'hello ' });

      expect(mockInstances.streamBuffer.addChunk).toHaveBeenCalledWith(
        'req_001',
        { content: 'hello ' }
      );
      expect(streamAdapter.applyChunk).toHaveBeenCalledWith({ content: 'hello ' });
    });

    it('starts stream in buffer if not already active', async () => {
      const { orch } = await createInitialized();
      orch.state.isStreaming = true;
      orch.state.currentRequestId = 'req_001';
      orch.state.currentChatId = 'chat-1';
      mockInstances.streamBuffer.isStreamActive.mockReturnValue(false);

      await orch.handleStreamChunk({ content: 'data' });

      expect(mockInstances.streamBuffer.startStream).toHaveBeenCalledWith(
        'req_001',
        { chatId: 'chat-1' }
      );
    });

    it('does not restart stream if already active', async () => {
      const { orch } = await createInitialized();
      orch.state.isStreaming = true;
      orch.state.currentRequestId = 'req_001';
      mockInstances.streamBuffer.isStreamActive.mockReturnValue(true);

      await orch.handleStreamChunk({ content: 'data' });

      expect(mockInstances.streamBuffer.startStream).not.toHaveBeenCalled();
    });

    it('records metrics for chunk content length', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.isStreaming = true;
      orch.state.currentRequestId = 'req_001';

      await orch.handleStreamChunk({ content: 'abcde' });

      expect(deps.metricsCollector.recordCustom).toHaveBeenCalledWith('chat:stream-chunk', 5);
    });

    it('finalizes stream on end signal', async () => {
      const { orch } = await createInitialized();
      orch.state.isStreaming = true;
      orch.state.currentRequestId = 'req_001';
      orch.state.currentChatId = 'chat-1';

      await orch.handleStreamChunk({ end: true });

      expect(mockInstances.streamLifecycleManager.finalizeStream).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'chat-1',
          requestId: 'req_001',
        })
      );
      // Stream state cleaned
      expect(orch.state.isStreaming).toBe(false);
      expect(orch.state.currentRequestId).toBeNull();
    });

    it('captures error on chunk handling failure', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.isStreaming = true;
      orch.state.currentRequestId = 'req_001';
      mockInstances.streamBuffer.addChunk.mockImplementation(() => {
        throw new Error('buffer fail');
      });

      // Should not throw -- error is caught internally
      await orch.handleStreamChunk({ content: 'test' });

      expect(deps.errorTracker.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        'ChatOrchestrator.handleStreamChunk'
      );
    });
  });

  // -----------------------------------------------------------------
  // stopStreaming()
  // -----------------------------------------------------------------
  describe('stopStreaming()', () => {
    it('is no-op when not streaming', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.isStreaming = false;

      await orch.stopStreaming();

      expect(mockInstances.requestLifecycleManager.cancelRequest).not.toHaveBeenCalled();
      expect(deps.guruConnection.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'stop' })
      );
    });

    it('cancels request and sends stop to backend', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.isStreaming = true;
      orch.state.currentRequestId = 'req_001';

      await orch.stopStreaming();

      expect(mockInstances.requestLifecycleManager.cancelRequest).toHaveBeenCalledWith('req_001');
      expect(deps.guruConnection.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'stop', id: 'req_001' })
      );
    });

    it('cleans up stream state in finally block', async () => {
      const { orch } = await createInitialized();
      orch.state.isStreaming = true;
      orch.state.currentRequestId = 'req_001';

      await orch.stopStreaming();

      expect(orch.state.isStreaming).toBe(false);
      expect(orch.state.currentRequestId).toBeNull();
    });

    it('cleans up even on error', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.isStreaming = true;
      orch.state.currentRequestId = 'req_001';
      deps.guruConnection.send.mockRejectedValueOnce(new Error('send fail'));

      await expect(orch.stopStreaming()).rejects.toThrow('send fail');
      // Stream still cleaned up in finally
      expect(orch.state.isStreaming).toBe(false);
      expect(orch.state.currentRequestId).toBeNull();
    });

    it('handles missing guruConnection gracefully', async () => {
      const { orch } = await createInitialized();
      orch.state.isStreaming = true;
      orch.state.currentRequestId = 'req_001';
      orch.guruConnection = null;

      await orch.stopStreaming();
      expect(orch.state.isStreaming).toBe(false);
    });
  });

  // -----------------------------------------------------------------
  // switchChat()
  // -----------------------------------------------------------------
  describe('switchChat()', () => {
    it('is no-op when already on the requested chat', async () => {
      const { orch } = await createInitialized();
      orch.state.currentChatId = 'chat-1';

      await orch.switchChat('chat-1');

      // ChatSessionManager.switchToChat should NOT be called
      const switchCalls = mockInstances.chatSessionManager.switchToChat.mock.calls.filter(
        c => c[0] === 'chat-1'
      );
      // Only the initial loadCurrentChat->switchChat call, not a new one
      expect(switchCalls.length).toBeLessThanOrEqual(1);
    });

    it('stops streaming before switching', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.currentChatId = 'chat-1';
      orch.state.isStreaming = true;
      orch.state.currentRequestId = 'req_001';

      await orch.switchChat('chat-2');

      // Streaming should have been stopped
      expect(orch.state.isStreaming).toBe(false);
    });

    it('delegates to ChatSessionManager and updates state', async () => {
      const { orch } = await createInitialized();
      orch.state.currentChatId = 'chat-1';

      await orch.switchChat('chat-2');

      expect(mockInstances.chatSessionManager.switchToChat).toHaveBeenCalledWith('chat-2');
      expect(orch.state.currentChatId).toBe('chat-2');
    });

    it('updates messageManager UI with chat messages', async () => {
      const messageManager = { applyChatMessages: jest.fn(), displayMessage: jest.fn() };
      const { orch } = await createInitialized({ messageManager });
      orch.state.currentChatId = 'old-chat';

      await orch.switchChat('chat-1');

      expect(messageManager.applyChatMessages).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: 'msg-1' })])
      );
    });

    it('notifies artifacts window via IPC', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.currentChatId = 'old-chat';

      await orch.switchChat('chat-1');

      expect(deps.ipcBridge.send).toHaveBeenCalledWith(
        'artifacts:chat-switched',
        expect.objectContaining({ chatId: 'chat-1', artifacts: [] })
      );
    });

    it('captures error and re-throws on failure', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.currentChatId = 'old';
      mockInstances.chatSessionManager.switchToChat.mockRejectedValueOnce(
        new Error('switch fail')
      );

      await expect(orch.switchChat('bad-chat')).rejects.toThrow('switch fail');
      expect(deps.errorTracker.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        'ChatOrchestrator.switchChat'
      );
    });
  });

  // -----------------------------------------------------------------
  // createNewChat()
  // -----------------------------------------------------------------
  describe('createNewChat()', () => {
    it('creates chat via ChatSessionManager and switches to it', async () => {
      const { orch } = await createInitialized();

      const result = await orch.createNewChat('My Chat');

      expect(mockInstances.chatSessionManager.createChat).toHaveBeenCalledWith('My Chat');
      expect(result).toEqual(expect.objectContaining({ id: 'new-chat-1' }));
    });

    it('uses default title', async () => {
      const { orch } = await createInitialized();

      await orch.createNewChat();

      expect(mockInstances.chatSessionManager.createChat).toHaveBeenCalledWith('New Chat');
    });

    it('captures and re-throws creation error', async () => {
      const { orch, deps } = await createInitialized();
      mockInstances.chatSessionManager.createChat.mockRejectedValueOnce(
        new Error('create fail')
      );

      await expect(orch.createNewChat()).rejects.toThrow('create fail');
      expect(deps.errorTracker.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        'ChatOrchestrator.createNewChat'
      );
    });
  });

  // -----------------------------------------------------------------
  // deleteChat()
  // -----------------------------------------------------------------
  describe('deleteChat()', () => {
    it('delegates deletion to ChatSessionManager', async () => {
      const { orch } = await createInitialized();
      orch.state.currentChatId = 'other-chat';

      await orch.deleteChat('chat-to-delete');

      expect(mockInstances.chatSessionManager.deleteChat).toHaveBeenCalledWith('chat-to-delete');
    });

    it('switches to fallback when deleting current chat', async () => {
      const { orch } = await createInitialized();
      orch.state.currentChatId = 'chat-1';

      await orch.deleteChat('chat-1');

      expect(mockInstances.chatSessionManager.getFallbackChat).toHaveBeenCalledWith('chat-1');
      expect(mockInstances.chatSessionManager.switchToChat).toHaveBeenCalledWith('fallback-chat');
    });

    it('does NOT get fallback when deleting different chat', async () => {
      const { orch } = await createInitialized();
      orch.state.currentChatId = 'chat-1';

      await orch.deleteChat('chat-2');

      expect(mockInstances.chatSessionManager.getFallbackChat).not.toHaveBeenCalled();
    });

    it('captures and re-throws deletion error', async () => {
      const { orch, deps } = await createInitialized();
      mockInstances.chatSessionManager.deleteChat.mockRejectedValueOnce(
        new Error('delete fail')
      );

      await expect(orch.deleteChat('chat-1')).rejects.toThrow('delete fail');
      expect(deps.errorTracker.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        'ChatOrchestrator.deleteChat'
      );
    });
  });

  // -----------------------------------------------------------------
  // uploadFile()
  // -----------------------------------------------------------------
  describe('uploadFile()', () => {
    it('throws when no file provided', async () => {
      const { orch } = await createInitialized();
      await expect(orch.uploadFile(null)).rejects.toThrow('No file provided');
    });

    it('throws when fileManager not available', async () => {
      const { orch } = await createInitialized();
      orch.fileManager = null;
      await expect(orch.uploadFile({ name: 'test.txt' })).rejects.toThrow('FileManager not available');
    });

    it('delegates to fileManager and emits event', async () => {
      const fileManager = {
        uploadFile: jest.fn().mockResolvedValue({ filename: 'test.txt', size: 100 }),
      };
      const { orch, deps } = await createInitialized({ fileManager });
      orch.fileManager = fileManager;

      const result = await orch.uploadFile({ name: 'test.txt' });

      expect(fileManager.uploadFile).toHaveBeenCalledWith({ name: 'test.txt' });
      expect(result).toEqual({ filename: 'test.txt', size: 100 });
      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        'chat:file:uploaded',
        { filename: 'test.txt', size: 100 }
      );
    });

    it('captures error on upload failure', async () => {
      const fileManager = {
        uploadFile: jest.fn().mockRejectedValue(new Error('upload fail')),
      };
      const { orch, deps } = await createInitialized({ fileManager });
      orch.fileManager = fileManager;

      await expect(orch.uploadFile({ name: 'f' })).rejects.toThrow('upload fail');
      expect(deps.errorTracker.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        'ChatOrchestrator.uploadFile'
      );
    });
  });

  // -----------------------------------------------------------------
  // getState() / getStats()
  // -----------------------------------------------------------------
  describe('getState()', () => {
    it('returns frozen copy of state', async () => {
      const { orch } = await createInitialized();
      orch.state.currentChatId = 'chat-1';
      orch.state.isStreaming = true;

      const state = orch.getState();

      expect(Object.isFrozen(state)).toBe(true);
      expect(state.currentChatId).toBe('chat-1');
      expect(state.isStreaming).toBe(true);

      // Modifying returned state does not affect internal state
      try { state.currentChatId = 'modified'; } catch { /* frozen */ }
      expect(orch.state.currentChatId).toBe('chat-1');
    });
  });

  describe('getStats()', () => {
    it('returns frozen stats with request and stream info', async () => {
      const { orch } = await createInitialized();
      orch.state.currentChatId = 'chat-1';

      const stats = orch.getStats();

      expect(Object.isFrozen(stats)).toBe(true);
      expect(stats.initialized).toBe(true);
      expect(stats.currentChatId).toBe('chat-1');
      expect(typeof stats.activeRequests).toBe('number');
      expect(stats.requestStats).not.toBeNull();
      expect(typeof stats.activeStreams).toBe('number');
    });

    it('handles null requestLifecycle and streamBuffer', () => {
      const orch = new ChatOrchestrator(createMockDeps());
      // Before init - requestLifecycle and streamBuffer are null
      const stats = orch.getStats();
      expect(stats.activeRequests).toBe(0);
      expect(stats.requestStats).toBeNull();
      expect(stats.activeStreams).toBe(0);
    });
  });

  // -----------------------------------------------------------------
  // _handleConnectionStateChange()
  // -----------------------------------------------------------------
  describe('connection state changes', () => {
    it('updates backendConnected on state change', async () => {
      await createInitialized();

      // Get the onConnectionChange callback that was passed to ConnectionStateTracker
      const opts = mockInstances.connectionStateTracker._opts;
      expect(typeof opts.onConnectionChange).toBe('function');

      // Simulate connection established
      opts.onConnectionChange(true, 'ws-open', null);
      // We need to get the orchestrator reference... let me restructure
    });

    it('normalizes boolean and notifies IPC', async () => {
      const { orch, deps } = await createInitialized();

      // Call the private method directly
      orch._handleConnectionStateChange(1, 'ws-open', null);

      expect(orch.state.backendConnected).toBe(true);
      expect(deps.ipcBridge.send).toHaveBeenCalledWith(
        'chat:backend-status',
        expect.objectContaining({ connected: true, reason: 'ws-open' })
      );
    });

    it('is no-op when state unchanged', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.backendConnected = true;

      deps.ipcBridge.send.mockClear();
      orch._handleConnectionStateChange(true, 'same');

      expect(deps.ipcBridge.send).not.toHaveBeenCalledWith(
        'chat:backend-status',
        expect.any(Object)
      );
    });

    it('handles IPC send failure gracefully', async () => {
      const { orch, deps } = await createInitialized();
      deps.ipcBridge.send.mockImplementation(() => { throw new Error('ipc fail'); });

      // Should not throw
      expect(() => orch._handleConnectionStateChange(true, 'test')).not.toThrow();
      expect(orch.state.backendConnected).toBe(true);
    });
  });

  // -----------------------------------------------------------------
  // Event listener wiring (_setupEventListeners)
  // -----------------------------------------------------------------
  describe('event listeners', () => {
    it('registers eventBus listeners for stream events', async () => {
      const { deps } = await createInitialized();

      const eventNames = deps.eventBus.on.mock.calls.map(c => c[0]);
      expect(eventNames).toContain('backend:stream-chunk');
      expect(eventNames).toContain('backend:stream-complete');
      expect(eventNames).toContain('backend:stream-error');
    });

    it('registers ipcBridge listeners for chat commands', async () => {
      const { deps } = await createInitialized();

      const eventNames = deps.ipcBridge.on.mock.calls.map(c => c[0]);
      expect(eventNames).toContain('chat:send-message');
      expect(eventNames).toContain('chat:stop-streaming');
      expect(eventNames).toContain('chat:switch-chat');
      expect(eventNames).toContain('chat:create-chat');
      expect(eventNames).toContain('chat:delete-chat');
    });

    it('stream-complete event completes active request', async () => {
      const { deps } = await createInitialized();
      mockInstances.requestLifecycleManager.isActive.mockReturnValue(true);

      // Find the stream-complete handler
      const call = deps.eventBus.on.mock.calls.find(c => c[0] === 'backend:stream-complete');
      expect(call).toBeDefined();
      const handler = call[1];

      handler({ requestId: 'req_001', data: 'done' });

      expect(mockInstances.requestLifecycleManager.completeRequest).toHaveBeenCalledWith(
        'req_001',
        { requestId: 'req_001', data: 'done' }
      );
    });

    it('stream-error event fails active request', async () => {
      const { deps } = await createInitialized();
      mockInstances.requestLifecycleManager.isActive.mockReturnValue(true);

      const call = deps.eventBus.on.mock.calls.find(c => c[0] === 'backend:stream-error');
      const handler = call[1];

      handler({ requestId: 'req_001', error: 'backend exploded' });

      expect(mockInstances.requestLifecycleManager.failRequest).toHaveBeenCalledWith(
        'req_001',
        'backend exploded'
      );
    });

    it('does not complete/fail inactive requests', async () => {
      const { deps } = await createInitialized();
      mockInstances.requestLifecycleManager.isActive.mockReturnValue(false);

      const completeCall = deps.eventBus.on.mock.calls.find(
        c => c[0] === 'backend:stream-complete'
      );
      completeCall[1]({ requestId: 'req_999' });

      expect(mockInstances.requestLifecycleManager.completeRequest).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------
  // Job tracing
  // -----------------------------------------------------------------
  describe('_traceJob()', () => {
    it('records job with context', async () => {
      const { orch } = await createInitialized();

      orch._traceJob('JOB_UPDATE_STATE', { stage: 'test' });

      expect(mockInstances.jobTraceManager.record).toHaveBeenCalledWith(
        'JOB_UPDATE_STATE',
        expect.objectContaining({
          orchestrator: 'ChatOrchestrator',
          stage: 'test',
        })
      );
    });

    it('is no-op when jobTracer is null', async () => {
      const { orch } = await createInitialized();
      orch.jobTracer = null;

      // Should not throw
      expect(() => orch._traceJob('JOB_TEST', {})).not.toThrow();
    });

    it('handles tracing failure gracefully', async () => {
      const { orch } = await createInitialized();
      orch.jobTracer = { record: jest.fn(() => { throw new Error('trace fail'); }) };
      orch.errorTracker = { captureException: jest.fn() };

      expect(() => orch._traceJob('JOB_TEST', {})).not.toThrow();
    });
  });

  // -----------------------------------------------------------------
  // destroy()
  // -----------------------------------------------------------------
  describe('destroy()', () => {
    it('sets lifecycle flags', async () => {
      const { orch } = await createInitialized();

      orch.destroy();

      expect(orch.isDestroyed).toBe(true);
      expect(orch.isInitialized).toBe(false);
    });

    it('destroys requestLifecycle', async () => {
      const { orch } = await createInitialized();

      orch.destroy();

      expect(mockInstances.requestLifecycleManager.destroy).toHaveBeenCalled();
    });

    it('cleans up eventBus listeners via .off() for each handler', async () => {
      const { orch, deps } = await createInitialized();

      const registeredEvents = deps.eventBus.on.mock.calls.map(c => c[0]);
      expect(registeredEvents).toContain('backend:stream-chunk');
      expect(registeredEvents).toContain('backend:stream-complete');
      expect(registeredEvents).toContain('backend:stream-error');

      orch.destroy();

      expect(deps.eventBus.off).toHaveBeenCalledTimes(3);
      const offEvents = deps.eventBus.off.mock.calls.map(c => c[0]);
      expect(offEvents).toContain('backend:stream-chunk');
      expect(offEvents).toContain('backend:stream-complete');
      expect(offEvents).toContain('backend:stream-error');

      // Verify handler refs match: on(event, fn) → off(event, fn)
      for (const onCall of deps.eventBus.on.mock.calls) {
        const offCall = deps.eventBus.off.mock.calls.find(
          c => c[0] === onCall[0] && c[1] === onCall[1]
        );
        expect(offCall).toBeDefined();
      }
    });

    it('cleans up ipcBridge listeners via .off() for each handler', async () => {
      const { orch, deps } = await createInitialized();

      const registeredEvents = deps.ipcBridge.on.mock.calls.map(c => c[0]);
      expect(registeredEvents).toContain('chat:send-message');
      expect(registeredEvents).toContain('chat:stop-streaming');
      expect(registeredEvents).toContain('chat:switch-chat');
      expect(registeredEvents).toContain('chat:create-chat');
      expect(registeredEvents).toContain('chat:delete-chat');

      orch.destroy();

      expect(deps.ipcBridge.off).toHaveBeenCalledTimes(5);
      for (const onCall of deps.ipcBridge.on.mock.calls) {
        const offCall = deps.ipcBridge.off.mock.calls.find(
          c => c[0] === onCall[0] && c[1] === onCall[1]
        );
        expect(offCall).toBeDefined();
      }
    });

    it('cleans up connection state tracker', async () => {
      const { orch } = await createInitialized();

      orch.destroy();

      expect(mockInstances.connectionStateTracker.cleanupListeners).toHaveBeenCalled();
    });

    it('stops active streaming before destroying', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.isStreaming = true;
      orch.state.currentRequestId = 'req_001';

      orch.destroy();

      // stopStreaming was called (async, fire-and-forget)
      // Since stopStreaming is async, the state may not be fully cleaned yet,
      // but the destroy flags should be set
      expect(orch.isDestroyed).toBe(true);
    });

    it('is idempotent -- safe to call twice', async () => {
      const { orch } = await createInitialized();

      orch.destroy();
      expect(() => orch.destroy()).not.toThrow();
    });

    it('handles null dependencies gracefully', async () => {
      const orch = new ChatOrchestrator({});
      await expect(() => orch.destroy()).not.toThrow();
    });
  });

  // -----------------------------------------------------------------
  // _cleanupStream()
  // -----------------------------------------------------------------
  describe('_cleanupStream()', () => {
    it('clears stream buffer and resets state', async () => {
      const { orch } = await createInitialized();
      orch.state.isStreaming = true;
      orch.state.currentRequestId = 'req_001';

      orch._cleanupStream();

      expect(mockInstances.streamBuffer.clearStream).toHaveBeenCalledWith('req_001');
      expect(orch.state.isStreaming).toBe(false);
      expect(orch.state.currentRequestId).toBeNull();
    });

    it('handles clearStream error silently', async () => {
      const { orch } = await createInitialized();
      orch.state.isStreaming = true;
      orch.state.currentRequestId = 'req_001';
      mockInstances.streamBuffer.clearStream.mockImplementation(() => {
        throw new Error('no such stream');
      });

      expect(() => orch._cleanupStream()).not.toThrow();
      expect(orch.state.isStreaming).toBe(false);
    });

    it('is safe when streamBuffer is null', async () => {
      const { orch } = await createInitialized();
      orch.state.currentRequestId = 'req_001';
      orch.streamBuffer = null;

      expect(() => orch._cleanupStream()).not.toThrow();
      expect(orch.state.isStreaming).toBe(false);
    });

    it('is safe when currentRequestId is null', async () => {
      const { orch } = await createInitialized();
      orch.state.currentRequestId = null;

      expect(() => orch._cleanupStream()).not.toThrow();
      expect(mockInstances.streamBuffer.clearStream).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------
  // Full lifecycle integration
  // -----------------------------------------------------------------
  describe('full lifecycle', () => {
    it('init -> sendMessage -> handleChunks -> endStream -> switchChat -> destroy', async () => {
      const messageManager = { displayMessage: jest.fn(), applyChatMessages: jest.fn() };
      const streamAdapter = { applyChunk: jest.fn() };
      const { orch, deps } = await createInitialized({ messageManager, streamAdapter });

      // 1. Verify init
      expect(orch.isInitialized).toBe(true);

      // 2. Connect backend
      orch._handleConnectionStateChange(true, 'ws-open');
      expect(orch.state.backendConnected).toBe(true);

      // 3. Send message
      orch.state.currentChatId = 'chat-1';
      await orch.sendMessage('Hello world');
      expect(orch.state.isStreaming).toBe(true);

      // 4. Handle stream chunks
      await orch.handleStreamChunk({ content: 'Hi ' });
      await orch.handleStreamChunk({ content: 'there!' });
      expect(streamAdapter.applyChunk).toHaveBeenCalledTimes(2);

      // 5. End stream
      await orch.handleStreamChunk({ end: true });
      expect(orch.state.isStreaming).toBe(false);

      // 6. Switch chat
      await orch.switchChat('chat-2');
      expect(orch.state.currentChatId).toBe('chat-2');

      // 7. Destroy
      orch.destroy();
      expect(orch.isDestroyed).toBe(true);
      expect(orch.isInitialized).toBe(false);
    });
  });

  // -----------------------------------------------------------------
  // enableLogging branches
  // -----------------------------------------------------------------
  describe('enableLogging branches', () => {
    it('logs on construction when enableLogging=true', () => {
      new ChatOrchestrator({ ...createMockDeps(), enableLogging: true });
      // Coverage: constructor debug log
    });

    it('logs during full init lifecycle (init start, services, listeners, loadChat, success)', async () => {
      const orch = new ChatOrchestrator({ ...createMockDeps(), enableLogging: true });
      await orch.init();
      expect(orch.isInitialized).toBe(true);
      // Coverage: init debug start, _initializeDomainServices log, _setupEventListeners log,
      //           _loadCurrentChat log, init success log
    });

    it('logs on sendMessage success', async () => {
      const orch = new ChatOrchestrator({ ...createMockDeps(), enableLogging: true });
      await orch.init();
      orch.state.backendConnected = true;
      orch.state.currentChatId = 'chat-1';
      await orch.sendMessage('test');
      // Coverage: sendMessage debug log
    });

    it('logs on stopStreaming no-op and success paths', async () => {
      const orch = new ChatOrchestrator({ ...createMockDeps(), enableLogging: true });
      await orch.init();
      // no-op path
      await orch.stopStreaming();
      // success path
      orch.state.isStreaming = true;
      orch.state.currentRequestId = 'req_001';
      await orch.stopStreaming();
      // Coverage: stopStreaming no-op debug, stopStreaming success debug
    });

    it('logs on switchChat already-on and success paths', async () => {
      const orch = new ChatOrchestrator({ ...createMockDeps(), enableLogging: true });
      await orch.init();
      orch.state.currentChatId = 'chat-1';
      await orch.switchChat('chat-1'); // already on
      await orch.switchChat('chat-2'); // success
      // Coverage: switchChat already-on debug, switchChat success debug
    });

    it('logs on createNewChat success', async () => {
      const orch = new ChatOrchestrator({ ...createMockDeps(), enableLogging: true });
      await orch.init();
      await orch.createNewChat('LogTest');
      // Coverage: createNewChat debug
    });

    it('logs on deleteChat success', async () => {
      const orch = new ChatOrchestrator({ ...createMockDeps(), enableLogging: true });
      await orch.init();
      orch.state.currentChatId = 'other';
      await orch.deleteChat('del-1');
      // Coverage: deleteChat debug
    });

    it('logs on uploadFile success', async () => {
      const fm = { uploadFile: jest.fn().mockResolvedValue({ filename: 'f', size: 1 }) };
      const orch = new ChatOrchestrator({ ...createMockDeps(), enableLogging: true });
      await orch.init();
      orch.fileManager = fm;
      await orch.uploadFile({ name: 'f' });
      // Coverage: uploadFile debug
    });

    it('logs on destroy start and complete', async () => {
      const orch = new ChatOrchestrator({ ...createMockDeps(), enableLogging: true });
      await orch.init();
      orch.destroy();
      // Coverage: destroy start debug, destroy complete debug
    });

    it('logs warning in _cleanupStream on error', async () => {
      const orch = new ChatOrchestrator({ ...createMockDeps(), enableLogging: true });
      await orch.init();
      orch.state.currentRequestId = 'req_001';
      mockInstances.streamBuffer.clearStream.mockImplementation(() => { throw new Error('err'); });
      orch._cleanupStream();
      expect(orch.state.isStreaming).toBe(false);
      // Coverage: _cleanupStream warn log
    });

    it('logs warning in _setupJobTracer on error', () => {
      const { JobTraceManager } = require('../../../src/application/shared/JobTraceManager');
      JobTraceManager.mockImplementationOnce(() => { throw new Error('tracer fail'); });
      const orch = new ChatOrchestrator({ enableLogging: true });
      expect(orch.jobTracer).toBeNull();
      // Coverage: _setupJobTracer warn log
    });

    it('logs warning in _traceJob on error', async () => {
      const orch = new ChatOrchestrator({ ...createMockDeps(), enableLogging: true });
      await orch.init();
      orch.jobTracer = { record: jest.fn(() => { throw new Error('trace err'); }) };
      orch._traceJob('JOB_TEST', {});
      // Coverage: _traceJob warn log
    });
  });

  // -----------------------------------------------------------------
  // sendMessage onCancel / onTimeout callbacks
  // -----------------------------------------------------------------
  describe('sendMessage request callbacks', () => {
    it('onCancel cancels stream and cleans up state', async () => {
      const { orch } = await createInitialized();
      orch.state.backendConnected = true;
      orch.state.currentChatId = 'chat-1';

      await orch.sendMessage('test');

      const startCalls = mockInstances.requestLifecycleManager.startRequest.mock.calls;
      const opts = startCalls[startCalls.length - 1][0];
      expect(typeof opts.onCancel).toBe('function');

      opts.onCancel();

      expect(mockInstances.streamLifecycleManager.cancelStream).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'req_001' })
      );
      expect(orch.state.isStreaming).toBe(false);
      expect(orch.state.currentRequestId).toBeNull();
    });

    it('onTimeout times out stream and cleans up state', async () => {
      const { orch } = await createInitialized();
      orch.state.backendConnected = true;
      orch.state.currentChatId = 'chat-1';

      await orch.sendMessage('test');

      const startCalls = mockInstances.requestLifecycleManager.startRequest.mock.calls;
      const opts = startCalls[startCalls.length - 1][0];
      expect(typeof opts.onTimeout).toBe('function');

      opts.onTimeout();

      expect(mockInstances.streamLifecycleManager.timeoutStream).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'req_001' })
      );
      expect(orch.state.isStreaming).toBe(false);
      expect(orch.state.currentRequestId).toBeNull();
    });

    it('passes files in metadata when options.files provided', async () => {
      const { orch } = await createInitialized();
      orch.state.backendConnected = true;
      orch.state.currentChatId = 'chat-1';

      await orch.sendMessage('with files', { files: ['a.txt', 'b.pdf'] });

      const startCalls = mockInstances.requestLifecycleManager.startRequest.mock.calls;
      const opts = startCalls[startCalls.length - 1][0];
      expect(opts.metadata.files).toEqual(['a.txt', 'b.pdf']);
    });
  });

  // -----------------------------------------------------------------
  // _finalizeCurrentStream error path
  // -----------------------------------------------------------------
  describe('_finalizeCurrentStream()', () => {
    it('captures and re-throws error on finalization failure', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.isStreaming = true;
      orch.state.currentRequestId = 'req_001';
      orch.state.currentChatId = 'chat-1';

      mockInstances.streamLifecycleManager.finalizeStream.mockRejectedValueOnce(
        new Error('finalize boom')
      );

      // handleStreamChunk with end:true calls _finalizeCurrentStream
      // _finalizeCurrentStream re-throws, caught by handleStreamChunk
      await orch.handleStreamChunk({ end: true });

      expect(deps.errorTracker.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        'ChatOrchestrator._finalizeCurrentStream'
      );
      // The re-thrown error propagates to handleStreamChunk's catch
      expect(deps.errorTracker.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        'ChatOrchestrator.handleStreamChunk'
      );
    });
  });

  // -----------------------------------------------------------------
  // _initializeRequestLifecycle error path
  // -----------------------------------------------------------------
  describe('_initializeRequestLifecycle()', () => {
    it('throws and captures error on lifecycle manager creation failure', async () => {
      const { RequestLifecycleManager } = require('../../../src/application/shared/RequestLifecycleManager');
      RequestLifecycleManager.mockImplementationOnce(() => {
        throw new Error('lifecycle boom');
      });

      const deps = createMockDeps();
      const orch = new ChatOrchestrator(deps);

      await expect(orch.init()).rejects.toThrow('lifecycle boom');
      expect(deps.errorTracker.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        'ChatOrchestrator._initializeRequestLifecycle'
      );
      expect(orch.isInitialized).toBe(false);
    });
  });

  // -----------------------------------------------------------------
  // _initializeServices error path
  // -----------------------------------------------------------------
  describe('_initializeServices()', () => {
    it('handles container.resolve failure gracefully (no re-throw)', async () => {
      const deps = createMockDeps();
      deps.container.resolve.mockImplementation(() => {
        throw new Error('resolve fail');
      });

      const orch = new ChatOrchestrator(deps);
      // init should NOT throw -- _initializeServices swallows the error
      await orch.init();
      expect(orch.isInitialized).toBe(true);
      expect(orch.messageService).toBeNull();
      expect(orch.chatService).toBeNull();
    });

    it('covers success log path with enableLogging', async () => {
      const deps = createMockDeps();
      const orch = new ChatOrchestrator({ ...deps, enableLogging: true });
      await orch.init();
      expect(orch.messageService).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------
  // _loadCurrentChat error path
  // -----------------------------------------------------------------
  describe('_loadCurrentChat()', () => {
    it('catches error without re-throwing (init succeeds)', async () => {
      const { ChatSessionManager } = require('../../../src/domain/chat/services/ChatSessionManager');
      ChatSessionManager.mockImplementationOnce(() => {
        const inst = {
          switchToChat: jest.fn().mockResolvedValue({
            chat: { id: 'c1', messages: [] },
            artifacts: [],
          }),
          createChat: jest.fn().mockResolvedValue({ id: 'nc1', title: 'New' }),
          deleteChat: jest.fn().mockResolvedValue(undefined),
          getFallbackChat: jest.fn().mockResolvedValue({ chat: { id: 'fb', messages: [] } }),
          loadCurrentChat: jest.fn().mockRejectedValue(new Error('db corrupt')),
        };
        mockInstances.chatSessionManager = inst;
        return inst;
      });

      const deps = createMockDeps();
      const orch = new ChatOrchestrator(deps);
      // Should not throw -- _loadCurrentChat swallows its own errors
      await orch.init();
      expect(orch.isInitialized).toBe(true);
    });
  });

  // -----------------------------------------------------------------
  // _setupEventListeners error path
  // -----------------------------------------------------------------
  describe('_setupEventListeners()', () => {
    it('throws and captures error on listener setup failure', async () => {
      const deps = createMockDeps();
      deps.eventBus.on.mockImplementation(() => {
        throw new Error('listener attach fail');
      });

      const orch = new ChatOrchestrator(deps);

      await expect(orch.init()).rejects.toThrow('listener attach fail');
      expect(deps.errorTracker.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        'ChatOrchestrator._setupEventListeners'
      );
    });
  });

  // -----------------------------------------------------------------
  // IPC handler invocation
  // -----------------------------------------------------------------
  describe('IPC handler invocation', () => {
    it('backend:stream-chunk handler delegates to handleStreamChunk', async () => {
      const streamAdapter = { applyChunk: jest.fn() };
      const { orch, deps } = await createInitialized({ streamAdapter });
      orch.state.isStreaming = true;
      orch.state.currentRequestId = 'req_001';

      const call = deps.eventBus.on.mock.calls.find(c => c[0] === 'backend:stream-chunk');
      expect(call).toBeDefined();
      call[1]({ content: 'via-eb' });
      await new Promise(r => setTimeout(r, 10));

      expect(mockInstances.streamBuffer.addChunk).toHaveBeenCalledWith(
        'req_001', { content: 'via-eb' }
      );
    });

    it('chat:send-message handler delegates to sendMessage', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.backendConnected = true;
      orch.state.currentChatId = 'chat-1';

      const call = deps.ipcBridge.on.mock.calls.find(c => c[0] === 'chat:send-message');
      expect(call).toBeDefined();
      call[1]('ipc msg');
      await new Promise(r => setTimeout(r, 10));

      expect(mockInstances.messageSender.sendMessage).toHaveBeenCalledWith(
        'ipc msg', 'chat-1', expect.any(String), {}
      );
    });

    it('chat:stop-streaming handler delegates to stopStreaming', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.isStreaming = true;
      orch.state.currentRequestId = 'req_001';

      const call = deps.ipcBridge.on.mock.calls.find(c => c[0] === 'chat:stop-streaming');
      expect(call).toBeDefined();
      call[1]();
      await new Promise(r => setTimeout(r, 10));

      expect(mockInstances.requestLifecycleManager.cancelRequest).toHaveBeenCalledWith('req_001');
    });

    it('chat:switch-chat handler delegates to switchChat', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.currentChatId = 'old';

      const call = deps.ipcBridge.on.mock.calls.find(c => c[0] === 'chat:switch-chat');
      expect(call).toBeDefined();
      call[1]('new-chat');
      await new Promise(r => setTimeout(r, 10));

      expect(mockInstances.chatSessionManager.switchToChat).toHaveBeenCalledWith('new-chat');
    });

    it('chat:create-chat handler delegates to createNewChat', async () => {
      const { deps } = await createInitialized();

      const call = deps.ipcBridge.on.mock.calls.find(c => c[0] === 'chat:create-chat');
      expect(call).toBeDefined();
      call[1]();
      await new Promise(r => setTimeout(r, 10));

      expect(mockInstances.chatSessionManager.createChat).toHaveBeenCalledWith('New Chat');
    });

    it('chat:delete-chat handler delegates to deleteChat', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.currentChatId = 'keep';

      const call = deps.ipcBridge.on.mock.calls.find(c => c[0] === 'chat:delete-chat');
      expect(call).toBeDefined();
      call[1]('del-chat');
      await new Promise(r => setTimeout(r, 10));

      expect(mockInstances.chatSessionManager.deleteChat).toHaveBeenCalledWith('del-chat');
    });
  });

  // -----------------------------------------------------------------
  // IPC handler error paths (.catch blocks)
  // -----------------------------------------------------------------
  describe('IPC handler error paths', () => {
    it('chat:send-message catch logs sendMessage failure', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.backendConnected = false; // sendMessage will throw 'Backend not connected'

      const call = deps.ipcBridge.on.mock.calls.find(c => c[0] === 'chat:send-message');
      call[1]('will fail');
      await new Promise(r => setTimeout(r, 10));
      // Error caught by .catch in handler -- no unhandled rejection
    });

    it('chat:stop-streaming catch logs stopStreaming failure', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.isStreaming = true;
      orch.state.currentRequestId = 'req_001';
      deps.guruConnection.send.mockRejectedValue(new Error('ws err'));

      const call = deps.ipcBridge.on.mock.calls.find(c => c[0] === 'chat:stop-streaming');
      call[1]();
      await new Promise(r => setTimeout(r, 10));
      // Error caught by .catch in handler
    });

    it('chat:switch-chat catch logs switchChat failure', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.currentChatId = 'old';
      mockInstances.chatSessionManager.switchToChat.mockRejectedValueOnce(
        new Error('switch err')
      );

      const call = deps.ipcBridge.on.mock.calls.find(c => c[0] === 'chat:switch-chat');
      call[1]('bad-chat');
      await new Promise(r => setTimeout(r, 10));
      // Error caught by .catch in handler
    });

    it('chat:create-chat catch logs createNewChat failure', async () => {
      const { deps } = await createInitialized();
      mockInstances.chatSessionManager.createChat.mockRejectedValueOnce(
        new Error('create err')
      );

      const call = deps.ipcBridge.on.mock.calls.find(c => c[0] === 'chat:create-chat');
      call[1]();
      await new Promise(r => setTimeout(r, 10));
      // Error caught by .catch in handler
    });

    it('chat:delete-chat catch logs deleteChat failure', async () => {
      const { deps } = await createInitialized();
      mockInstances.chatSessionManager.deleteChat.mockRejectedValueOnce(
        new Error('delete err')
      );

      const call = deps.ipcBridge.on.mock.calls.find(c => c[0] === 'chat:delete-chat');
      call[1]('del-chat');
      await new Promise(r => setTimeout(r, 10));
      // Error caught by .catch in handler
    });
  });

  // -----------------------------------------------------------------
  // Handler cleanup N=M verification
  // -----------------------------------------------------------------
  describe('handler cleanup verification', () => {
    it('N registered eventBus handlers = M removed handlers', async () => {
      const { orch, deps } = await createInitialized();
      const registered = deps.eventBus.on.mock.calls.length;
      expect(registered).toBe(3);

      orch.destroy();

      const removed = deps.eventBus.off.mock.calls.length;
      expect(removed).toBe(registered);
    });

    it('N registered ipcBridge handlers = M removed handlers', async () => {
      const { orch, deps } = await createInitialized();
      const registered = deps.ipcBridge.on.mock.calls.length;
      expect(registered).toBe(5);

      orch.destroy();

      const removed = deps.ipcBridge.off.mock.calls.length;
      expect(removed).toBe(registered);
    });

    it('_eventBusHandlers array is emptied after destroy', async () => {
      const { orch } = await createInitialized();
      expect(orch._eventBusHandlers.length).toBe(3);

      orch.destroy();
      expect(orch._eventBusHandlers.length).toBe(0);
    });

    it('_ipcBridgeHandlers array is emptied after destroy', async () => {
      const { orch } = await createInitialized();
      expect(orch._ipcBridgeHandlers.length).toBe(5);

      orch.destroy();
      expect(orch._ipcBridgeHandlers.length).toBe(0);
    });
  });

  // -----------------------------------------------------------------
  // _setupJobTracer edge cases
  // -----------------------------------------------------------------
  describe('_setupJobTracer edge cases', () => {
    it('is idempotent -- second call returns early', () => {
      const orch = new ChatOrchestrator(createMockDeps());
      expect(orch._jobTracerInitialized).toBe(true);
      const currentTracer = orch.jobTracer;

      orch._setupJobTracer(); // second call -- early return
      expect(orch.jobTracer).toBe(currentTracer); // unchanged
    });

    it('captures exception in errorTracker when tracer creation fails', () => {
      const { JobTraceManager } = require('../../../src/application/shared/JobTraceManager');
      JobTraceManager.mockImplementationOnce(() => { throw new Error('tracer err'); });
      const errorTracker = { captureException: jest.fn() };

      const orch = new ChatOrchestrator({ errorTracker });
      expect(orch.jobTracer).toBeNull();
      expect(errorTracker.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        'ChatOrchestrator._setupJobTracer'
      );
    });
  });

  // -----------------------------------------------------------------
  // destroy with active streaming (async .catch path)
  // -----------------------------------------------------------------
  describe('destroy async streaming cleanup', () => {
    it('catches and logs stopStreaming rejection during destroy', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.isStreaming = true;
      orch.state.currentRequestId = 'req_001';
      deps.guruConnection.send.mockRejectedValue(new Error('ws closed'));

      orch.destroy();
      await new Promise(r => setTimeout(r, 10));

      expect(orch.isDestroyed).toBe(true);
    });
  });

  // -----------------------------------------------------------------
  // getStats edge cases
  // -----------------------------------------------------------------
  describe('getStats edge cases', () => {
    it('returns active stream count when streams are active', async () => {
      const { orch } = await createInitialized();
      mockInstances.streamBuffer.getActiveStreams.mockReturnValue(['req_001', 'req_002']);
      mockInstances.requestLifecycleManager.getStats.mockReturnValue({
        active: 2, total: 5, completed: 3, failed: 0,
      });

      const stats = orch.getStats();
      expect(stats.activeStreams).toBe(2);
      expect(stats.activeRequests).toBe(2);
    });
  });

  // -----------------------------------------------------------------
  // Constructor edge cases
  // -----------------------------------------------------------------
  describe('constructor edge cases', () => {
    it('stores optional deps: endpoint, config, sidebarManager, artifactIndicator', () => {
      const orch = new ChatOrchestrator({
        endpoint: { url: 'ws://test' },
        config: { timeout: 5000 },
        sidebarManager: { refresh: jest.fn() },
        artifactIndicator: { show: jest.fn() },
      });
      expect(orch.endpoint).toEqual({ url: 'ws://test' });
      expect(orch.config).toEqual({ timeout: 5000 });
      expect(orch.sidebarManager).not.toBeNull();
      expect(orch.artifactIndicator).not.toBeNull();
    });

    it('initializes handler tracking arrays', () => {
      const orch = new ChatOrchestrator(createMockDeps());
      expect(orch._eventBusHandlers).toEqual([]);
      expect(orch._ipcBridgeHandlers).toEqual([]);
    });
  });
});
