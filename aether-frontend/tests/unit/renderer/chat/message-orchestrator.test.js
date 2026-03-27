'use strict';

// ===========================================================================
// Module-level Mocks — all 20+ MessageOrchestrator dependencies
// ===========================================================================

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    debug: jest.fn(), trace: jest.fn(),
    child: jest.fn(function () { return this; }),
  })),
}));

const mockSessionBridge = {
  nextUserMessageId: jest.fn(),
};
jest.mock('../../../../src/renderer/shared/adapters/session', () => mockSessionBridge);

// --- Routing ---
const mockRouterInstance = { dispose: jest.fn() };
jest.mock('../../../../src/renderer/chat/modules/messaging/routing/MessageEventRouter', () =>
  jest.fn().mockImplementation(() => mockRouterInstance)
);

const mockArtifactRoutingInstance = { dispose: jest.fn() };
jest.mock('../../../../src/renderer/chat/modules/messaging/routing/ArtifactRoutingManager', () =>
  jest.fn().mockImplementation(() => mockArtifactRoutingInstance)
);

const mockEnrichmentInstance = { dispose: jest.fn() };
jest.mock('../../../../src/renderer/chat/modules/messaging/routing/ArtifactEnrichmentManager', () =>
  jest.fn().mockImplementation(() => mockEnrichmentInstance)
);

// --- Queue ---
const mockQueueProcessorInstance = { enqueue: jest.fn(), dispose: jest.fn() };
jest.mock('../../../../src/renderer/chat/modules/messaging/queue/MessageQueueProcessor', () =>
  jest.fn().mockImplementation(() => mockQueueProcessorInstance)
);

// --- Handlers ---
const mockAssistantHandlerInstance = { dispose: jest.fn() };
jest.mock('../../../../src/renderer/chat/modules/messaging/handlers/AssistantMessageHandler', () =>
  jest.fn().mockImplementation(() => mockAssistantHandlerInstance)
);

const mockTrailHandlerInstance = { dispose: jest.fn() };
jest.mock('../../../../src/renderer/chat/modules/messaging/handlers/TrailEventHandler', () =>
  jest.fn().mockImplementation(() => mockTrailHandlerInstance)
);

const mockControlHandlerInstance = { dispose: jest.fn() };
let capturedControlHandlerOpts = null;
jest.mock('../../../../src/renderer/chat/modules/messaging/handlers/ControlMessageHandler', () =>
  jest.fn().mockImplementation((opts) => {
    capturedControlHandlerOpts = opts;
    return mockControlHandlerInstance;
  })
);

// --- UI ---
const mockInputUIInstance = {
  setupListeners: jest.fn(), getValue: jest.fn(), clear: jest.fn(),
  clearValidation: jest.fn(), markError: jest.fn(), focus: jest.fn(),
  dispose: jest.fn(), autoResize: jest.fn(),
  inputElement: { value: '' },
};
jest.mock('../../../../src/renderer/chat/modules/messaging/ui/InputUIController', () =>
  jest.fn().mockImplementation(() => mockInputUIInstance)
);

const mockStatusBarInstance = { showError: jest.fn(), clear: jest.fn(), dispose: jest.fn() };
jest.mock('../../../../src/renderer/chat/modules/messaging/ui/StatusBarManager', () =>
  jest.fn().mockImplementation(() => mockStatusBarInstance)
);

const mockScrollInstance = { dispose: jest.fn() };
jest.mock('../../../../src/renderer/chat/modules/messaging/ui/ScrollManager', () =>
  jest.fn().mockImplementation(() => mockScrollInstance)
);

// --- Transport & Events ---
const mockIpcTransportInstance = { dispose: jest.fn() };
jest.mock('../../../../src/renderer/chat/modules/messaging/transport/IPCTransportManager', () =>
  jest.fn().mockImplementation(() => mockIpcTransportInstance)
);

const mockEventEmitterInstance = {
  emitProcessingState: jest.fn(), emitStopModeState: jest.fn(), dispose: jest.fn(),
};
jest.mock('../../../../src/renderer/chat/modules/messaging/events/EventEmissionManager', () =>
  jest.fn().mockImplementation(() => mockEventEmitterInstance)
);

// --- Lifecycle ---
const mockChatLifecycleInstance = {
  loadChat: jest.fn(), createChat: jest.fn(), dispose: jest.fn(),
};
jest.mock('../../../../src/renderer/chat/modules/messaging/lifecycle/ChatLifecycleManager', () =>
  jest.fn().mockImplementation(() => mockChatLifecycleInstance)
);

// --- Existing Modules ---
const mockMessageViewInstance = {
  init: jest.fn(), renderMessage: jest.fn(), renderMessageWithAttachments: jest.fn(),
  showTypingIndicator: jest.fn(), hideTypingIndicator: jest.fn(),
  getMessageCount: jest.fn().mockReturnValue(0), dispose: jest.fn(),
  removeMessageSequence: jest.fn(), removeMessage: jest.fn(),
};
jest.mock('../../../../src/renderer/chat/modules/messaging/MessageView', () =>
  jest.fn().mockImplementation(() => mockMessageViewInstance)
);

const mockMessageStateInstance = {
  init: jest.fn(), messages: [], currentChatId: 'chat-123',
  getCurrentChatId: jest.fn().mockReturnValue('chat-123'),
  getMessages: jest.fn().mockReturnValue([]),
  updateChatTitle: jest.fn(), dispose: jest.fn(),
};
jest.mock('../../../../src/renderer/chat/modules/messaging/MessageState', () =>
  jest.fn().mockImplementation(() => mockMessageStateInstance)
);

const mockSendControllerInstance = {
  init: jest.fn(), send: jest.fn().mockResolvedValue('req-1'),
  preflightValidate: jest.fn((c) => c), dispose: jest.fn(),
};
jest.mock('../../../../src/renderer/chat/modules/messaging/SendController', () =>
  jest.fn().mockImplementation(() => mockSendControllerInstance)
);

const mockStopControllerInstance = {
  init: jest.fn(), stop: jest.fn().mockResolvedValue(), dispose: jest.fn(),
};
jest.mock('../../../../src/renderer/chat/modules/messaging/StopController', () =>
  jest.fn().mockImplementation(() => mockStopControllerInstance)
);

const mockStreamHandlerInstance = {
  init: jest.fn(), isStreaming: jest.fn().mockReturnValue(false),
  forceFinalize: jest.fn().mockResolvedValue(), dispose: jest.fn(),
  userMessageId: null, userMessageCorrelationId: null,
};
jest.mock('../../../../src/renderer/chat/modules/messaging/StreamHandler', () =>
  jest.fn().mockImplementation(() => mockStreamHandlerInstance)
);

const mockSanitizerInstance = { dispose: jest.fn() };
jest.mock('../../../../src/renderer/shared/security/SecuritySanitizer', () =>
  jest.fn().mockImplementation(() => mockSanitizerInstance)
);

const mockMarkdownRendererInstance = { dispose: jest.fn() };
jest.mock('../../../../src/renderer/shared/messaging/MarkdownRenderer', () =>
  jest.fn().mockImplementation(() => mockMarkdownRendererInstance)
);

const mockTrailStyleInstance = { inject: jest.fn() };
jest.mock('../../../../src/renderer/chat/modules/trail/TrailStyleManager', () =>
  jest.fn().mockImplementation(() => mockTrailStyleInstance)
);

const mockTrailOrchestratorInstance = { dispose: jest.fn(), destroy: jest.fn() };
jest.mock('../../../../src/renderer/chat/modules/trail/TrailContainerOrchestrator', () =>
  jest.fn().mockImplementation(() => mockTrailOrchestratorInstance)
);

const mockToast = { error: jest.fn() };
jest.mock('../../../../src/renderer/shared/components/Toast', () => mockToast);

// ===========================================================================
// Requires (after mocks)
// ===========================================================================

const MessageOrchestrator = require('../../../../src/renderer/chat/modules/messaging/MessageOrchestrator');
const { EventTypes } = require('../../../../src/core/events/EventTypes');

// ===========================================================================
// Helpers
// ===========================================================================

function createElements() {
  const input = document.createElement('textarea');
  input.id = 'chat-input';
  const sendBtn = document.createElement('button');
  sendBtn.id = 'send-btn';
  const content = document.createElement('div');
  content.id = 'content';
  const status = document.createElement('div');
  status.id = 'status';
  document.body.append(input, sendBtn, content, status);
  return { input, sendBtn, content, status };
}

function createChatWindow(elements) {
  return { getElements: jest.fn().mockReturnValue(elements) };
}

function createEventBus() {
  const listeners = new Map();
  return {
    emit: jest.fn(),
    on: jest.fn((event, handler) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      const cleanup = jest.fn(() => {
        const arr = listeners.get(event);
        if (arr) {
          const idx = arr.indexOf(handler);
          if (idx !== -1) arr.splice(idx, 1);
        }
      });
      return cleanup;
    }),
    off: jest.fn(),
    _listeners: listeners,
  };
}

function createIpc() {
  const listeners = new Map();
  return {
    send: jest.fn(),
    on: jest.fn((channel, handler) => {
      if (!listeners.has(channel)) listeners.set(channel, []);
      listeners.get(channel).push(handler);
      const cleanup = jest.fn(() => {
        const arr = listeners.get(channel);
        if (arr) {
          const idx = arr.indexOf(handler);
          if (idx !== -1) arr.splice(idx, 1);
        }
      });
      return cleanup;
    }),
    _listeners: listeners,
  };
}

function createFileManager(hasFiles = false) {
  return {
    hasAttachments: jest.fn().mockReturnValue(hasFiles),
    getAttachedImage: jest.fn().mockReturnValue('base64data'),
    getFileQueue: jest.fn().mockReturnValue([{ name: 'file.txt' }]),
    sendFiles: jest.fn().mockResolvedValue(),
  };
}

/** Build orchestrator + init. Returns { orch, elements, mocks }. */
async function buildInitializedOrchestrator(overrides = {}) {
  const elements = createElements();
  const chatWindow = createChatWindow(elements);
  const eventBus = createEventBus();
  const ipc = createIpc();

  // Reset all mock instances before each creation
  resetModuleMocks();

  const orch = new MessageOrchestrator({
    chatWindow,
    eventBus,
    ipc,
    storageAPI: {},
    fileManager: overrides.fileManager || null,
    config: overrides.config || { API_BASE_URL: 'http://localhost:8765' },
    ...overrides,
  });

  await orch.init();

  return {
    orch,
    elements,
    chatWindow,
    eventBus,
    ipc,
  };
}

/**
 * Reset all mock module instances to default state.
 * Uses jest.fn() re-assignment (NOT mockClear) to guarantee
 * previous mockRejectedValue / mockImplementation calls are wiped.
 */
function resetModuleMocks() {
  // Queue
  mockQueueProcessorInstance.enqueue = jest.fn();
  mockQueueProcessorInstance.dispose = jest.fn();

  // Router & handlers
  mockRouterInstance.dispose = jest.fn();
  mockArtifactRoutingInstance.dispose = jest.fn();
  mockEnrichmentInstance.dispose = jest.fn();
  mockAssistantHandlerInstance.dispose = jest.fn();
  mockTrailHandlerInstance.dispose = jest.fn();
  mockControlHandlerInstance.dispose = jest.fn();
  capturedControlHandlerOpts = null;

  // UI
  mockInputUIInstance.setupListeners = jest.fn();
  mockInputUIInstance.getValue = jest.fn();
  mockInputUIInstance.clear = jest.fn();
  mockInputUIInstance.clearValidation = jest.fn();
  mockInputUIInstance.markError = jest.fn();
  mockInputUIInstance.focus = jest.fn();
  mockInputUIInstance.autoResize = jest.fn();
  mockInputUIInstance.dispose = jest.fn();
  mockInputUIInstance.inputElement = { value: '' };

  mockStatusBarInstance.showError = jest.fn();
  mockStatusBarInstance.clear = jest.fn();
  mockStatusBarInstance.dispose = jest.fn();

  mockScrollInstance.dispose = jest.fn();

  // Transport & events
  mockIpcTransportInstance.dispose = jest.fn();
  mockEventEmitterInstance.emitProcessingState = jest.fn();
  mockEventEmitterInstance.emitStopModeState = jest.fn();
  mockEventEmitterInstance.dispose = jest.fn();

  // Lifecycle
  mockChatLifecycleInstance.loadChat = jest.fn();
  mockChatLifecycleInstance.createChat = jest.fn();
  mockChatLifecycleInstance.dispose = jest.fn();

  // View & State
  mockMessageViewInstance.init = jest.fn();
  mockMessageViewInstance.renderMessage = jest.fn();
  mockMessageViewInstance.renderMessageWithAttachments = jest.fn();
  mockMessageViewInstance.showTypingIndicator = jest.fn();
  mockMessageViewInstance.hideTypingIndicator = jest.fn();
  mockMessageViewInstance.getMessageCount = jest.fn().mockReturnValue(0);
  mockMessageViewInstance.removeMessageSequence = jest.fn();
  mockMessageViewInstance.removeMessage = jest.fn();
  mockMessageViewInstance.dispose = jest.fn();

  mockMessageStateInstance.init = jest.fn().mockResolvedValue();
  mockMessageStateInstance.messages = [];
  mockMessageStateInstance.currentChatId = 'chat-123';
  mockMessageStateInstance.getCurrentChatId = jest.fn().mockReturnValue('chat-123');
  mockMessageStateInstance.getMessages = jest.fn().mockReturnValue([]);
  mockMessageStateInstance.updateChatTitle = jest.fn();
  mockMessageStateInstance.dispose = jest.fn();

  // Controllers
  mockSendControllerInstance.init = jest.fn();
  mockSendControllerInstance.send = jest.fn().mockResolvedValue('req-1');
  mockSendControllerInstance.preflightValidate = jest.fn((c) => c);
  mockSendControllerInstance.dispose = jest.fn();

  mockStopControllerInstance.init = jest.fn();
  mockStopControllerInstance.stop = jest.fn().mockResolvedValue();
  mockStopControllerInstance.dispose = jest.fn();

  mockStreamHandlerInstance.init = jest.fn();
  mockStreamHandlerInstance.isStreaming = jest.fn().mockReturnValue(false);
  mockStreamHandlerInstance.forceFinalize = jest.fn().mockResolvedValue();
  mockStreamHandlerInstance.dispose = jest.fn();
  mockStreamHandlerInstance.userMessageId = null;
  mockStreamHandlerInstance.userMessageCorrelationId = null;

  // Shared
  mockSanitizerInstance.dispose = jest.fn();
  mockMarkdownRendererInstance.dispose = jest.fn();
  mockTrailStyleInstance.inject = jest.fn();
  mockTrailOrchestratorInstance.dispose = jest.fn();

  // Toast
  mockToast.error = jest.fn();

  // Session bridge
  mockSessionBridge.nextUserMessageId = jest.fn().mockResolvedValue('msg-id-1');
}

// ===========================================================================
// Tests
// ===========================================================================

describe('MessageOrchestrator', () => {
  let _origCrypto;
  let _uuidCounter;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    resetModuleMocks();

    // Ensure crypto.randomUUID is available — augment, do not replace
    _uuidCounter = 0;
    if (typeof globalThis.crypto === 'undefined') {
      globalThis.crypto = {};
    }
    _origCrypto = globalThis.crypto.randomUUID;
    globalThis.crypto.randomUUID = jest.fn(() => `uuid-${++_uuidCounter}`);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    if (_origCrypto) {
      globalThis.crypto.randomUUID = _origCrypto;
    } else {
      delete globalThis.crypto.randomUUID;
    }
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('throws when chatWindow is missing', () => {
      expect(() => new MessageOrchestrator({
        eventBus: {}, ipc: {},
      })).toThrow('[MessageOrchestrator] chatWindow is REQUIRED');
    });

    it('throws when eventBus is missing', () => {
      expect(() => new MessageOrchestrator({
        chatWindow: {}, ipc: {},
      })).toThrow('[MessageOrchestrator] eventBus is REQUIRED');
    });

    it('throws when ipc is missing', () => {
      expect(() => new MessageOrchestrator({
        chatWindow: {}, eventBus: {},
      })).toThrow('[MessageOrchestrator] ipc is REQUIRED');
    });

    it('initializes state and listener tracking', () => {
      const orch = new MessageOrchestrator({
        chatWindow: {}, eventBus: {}, ipc: {},
      });
      expect(orch.isProcessing).toBe(false);
      expect(orch.isStopMode).toBe(false);
      expect(orch._eventListeners).toEqual([]);
      expect(orch._ipcListeners).toEqual([]);
    });

    it('stores optional dependencies with defaults', () => {
      const orch = new MessageOrchestrator({
        chatWindow: { id: 'cw' }, eventBus: { id: 'eb' }, ipc: { id: 'ipc' },
      });
      expect(orch.chatWindow).toEqual({ id: 'cw' });
      expect(orch.eventBus).toEqual({ id: 'eb' });
      expect(orch.ipc).toEqual({ id: 'ipc' });
      expect(orch.storageAPI).toBeNull();
      expect(orch.fileManager).toBeNull();
      expect(orch.config).toEqual({});
    });
  });

  // =========================================================================
  // init
  // =========================================================================

  describe('init', () => {
    it('initializes all modules and sets up event listeners', async () => {
      const { orch, eventBus, ipc } = await buildInitializedOrchestrator();

      // Modules initialized
      expect(mockMessageStateInstance.init).toHaveBeenCalledWith({ autoLoad: false });
      expect(mockMessageViewInstance.init).toHaveBeenCalled();
      expect(mockSendControllerInstance.init).toHaveBeenCalled();
      expect(mockStopControllerInstance.init).toHaveBeenCalled();
      expect(mockStreamHandlerInstance.init).toHaveBeenCalled();
      expect(mockInputUIInstance.setupListeners).toHaveBeenCalled();
      expect(mockTrailStyleInstance.inject).toHaveBeenCalled();

      // Event listeners registered: 2 EventBus (assistant stream + title update)
      // EventBus.on called with ASSISTANT_STREAM and 'chat:title-update-requested'
      const ebOnCalls = eventBus.on.mock.calls;
      expect(ebOnCalls.some(c => c[0] === EventTypes.CHAT.ASSISTANT_STREAM)).toBe(true);
      expect(ebOnCalls.some(c => c[0] === 'chat:title-update-requested')).toBe(true);

      // IPC listener registered: chat:request-complete
      expect(ipc.on).toHaveBeenCalledWith('chat:request-complete', expect.any(Function));

      // DOM listeners tracked
      const domListeners = orch._eventListeners.filter(l => l.type === 'dom');
      expect(domListeners).toHaveLength(2); // sendButton click, input keydown
      expect(domListeners[0].event).toBe('click');
      expect(domListeners[1].event).toBe('keydown');

      orch.dispose();
    });

    it('throws when required DOM elements are missing', async () => {
      const elements = createElements();
      const chatWindow = createChatWindow({ input: null, sendBtn: null, content: null });
      const eventBus = createEventBus();
      const ipc = createIpc();
      resetModuleMocks();

      const orch = new MessageOrchestrator({ chatWindow, eventBus, ipc });
      await expect(orch.init()).rejects.toThrow('Required DOM elements not found');
    });

    it('propagates module initialization errors', async () => {
      const elements = createElements();
      const chatWindow = createChatWindow(elements);
      const eventBus = createEventBus();
      const ipc = createIpc();
      resetModuleMocks();
      mockMessageStateInstance.init.mockRejectedValue(new Error('state init fail'));

      const orch = new MessageOrchestrator({ chatWindow, eventBus, ipc });
      await expect(orch.init()).rejects.toThrow('state init fail');
    });
  });

  // =========================================================================
  // _setupEventListeners — event routing
  // =========================================================================

  describe('_setupEventListeners', () => {
    it('routes assistant stream events to queue processor', async () => {
      const { orch, eventBus } = await buildInitializedOrchestrator();

      const assistantCall = eventBus.on.mock.calls.find(
        c => c[0] === EventTypes.CHAT.ASSISTANT_STREAM
      );
      const handler = assistantCall[1];

      const payload = { type: 'token', content: 'hello' };
      handler(payload);
      expect(mockQueueProcessorInstance.enqueue).toHaveBeenCalledWith(payload);

      orch.dispose();
    });

    it('ignores non-object assistant stream payloads', async () => {
      const { orch, eventBus } = await buildInitializedOrchestrator();

      const handler = eventBus.on.mock.calls.find(
        c => c[0] === EventTypes.CHAT.ASSISTANT_STREAM
      )[1];

      handler(null);
      handler('string');
      handler(undefined);
      expect(mockQueueProcessorInstance.enqueue).not.toHaveBeenCalled();

      orch.dispose();
    });

    it('handles IPC request-complete by resetting state and finalizing', async () => {
      const { orch, ipc } = await buildInitializedOrchestrator();

      orch.isProcessing = true;
      orch.isStopMode = true;

      const ipcCall = ipc.on.mock.calls.find(c => c[0] === 'chat:request-complete');
      const handler = ipcCall[1];

      await handler(null, { requestId: 'req-done' });

      expect(orch.isProcessing).toBe(false);
      expect(orch.isStopMode).toBe(false);
      expect(mockStreamHandlerInstance.forceFinalize).toHaveBeenCalled();

      orch.dispose();
    });

    it('handles title update event with valid payload', async () => {
      const { orch, eventBus } = await buildInitializedOrchestrator();

      const titleCall = eventBus.on.mock.calls.find(
        c => c[0] === 'chat:title-update-requested'
      );
      const handler = titleCall[1];

      await handler({ chatId: 'chat-123', title: 'My Chat' });

      expect(mockMessageStateInstance.updateChatTitle).toHaveBeenCalledWith('My Chat');
      expect(eventBus.emit).toHaveBeenCalledWith('chat:title-updated', {
        chatId: 'chat-123', title: 'My Chat',
      });

      orch.dispose();
    });

    it('rejects title update with invalid payload', async () => {
      const { orch, eventBus } = await buildInitializedOrchestrator();

      const handler = eventBus.on.mock.calls.find(
        c => c[0] === 'chat:title-update-requested'
      )[1];

      await handler(null);
      await handler({});
      await handler({ chatId: 'abc' }); // missing title

      expect(mockMessageStateInstance.updateChatTitle).not.toHaveBeenCalled();

      orch.dispose();
    });

    it('catches title update errors without crashing', async () => {
      const { orch, eventBus } = await buildInitializedOrchestrator();

      mockMessageStateInstance.updateChatTitle.mockRejectedValue(new Error('db fail'));

      const handler = eventBus.on.mock.calls.find(
        c => c[0] === 'chat:title-update-requested'
      )[1];

      // Should not throw
      await handler({ chatId: 'chat-123', title: 'Fail Title' });
      expect(mockMessageStateInstance.updateChatTitle).toHaveBeenCalledWith('Fail Title');

      orch.dispose();
    });

    it('handles title update with null messageState gracefully', async () => {
      const { orch, eventBus } = await buildInitializedOrchestrator();

      // Simulate null messageState
      orch.messageState = null;

      const handler = eventBus.on.mock.calls.find(
        c => c[0] === 'chat:title-update-requested'
      )[1];

      // Should not throw
      await handler({ chatId: 'chat-123', title: 'Some Title' });

      orch.dispose();
    });
  });

  // =========================================================================
  // DOM event triggers (_handleSend via click / keydown)
  // =========================================================================

  describe('DOM event triggers', () => {
    it('sends message on send button click', async () => {
      const { orch, elements } = await buildInitializedOrchestrator();

      mockInputUIInstance.getValue.mockReturnValue('Hello world');

      // Simulate click
      elements.sendBtn.click();

      // Yield to microtask queue (async _handleSend)
      await new Promise(r => setTimeout(r, 10));

      expect(mockSendControllerInstance.send).toHaveBeenCalledWith('Hello world', expect.objectContaining({
        chatId: 'chat-123',
      }));

      orch.dispose();
    });

    it('sends message on Enter key (no shift)', async () => {
      const { orch, elements } = await buildInitializedOrchestrator();

      mockInputUIInstance.getValue.mockReturnValue('Enter pressed');

      const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false });
      const preventSpy = jest.spyOn(event, 'preventDefault');
      elements.input.dispatchEvent(event);

      await new Promise(r => setTimeout(r, 10));

      expect(preventSpy).toHaveBeenCalled();
      expect(mockSendControllerInstance.send).toHaveBeenCalled();

      orch.dispose();
    });

    it('does NOT send on Shift+Enter (allows newline)', async () => {
      const { orch, elements } = await buildInitializedOrchestrator();

      mockInputUIInstance.getValue.mockReturnValue('Multiline');

      const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true });
      elements.input.dispatchEvent(event);

      await new Promise(r => setTimeout(r, 10));

      expect(mockSendControllerInstance.send).not.toHaveBeenCalled();

      orch.dispose();
    });

    it('does NOT send on non-Enter key', async () => {
      const { orch, elements } = await buildInitializedOrchestrator();

      const event = new KeyboardEvent('keydown', { key: 'a', shiftKey: false });
      elements.input.dispatchEvent(event);

      await new Promise(r => setTimeout(r, 10));

      expect(mockSendControllerInstance.send).not.toHaveBeenCalled();

      orch.dispose();
    });
  });

  // =========================================================================
  // _handleSend — branching logic
  // =========================================================================

  describe('_handleSend', () => {
    it('calls stop() when in stop mode', async () => {
      const { orch } = await buildInitializedOrchestrator();

      orch.isStopMode = true;

      await orch._handleSend();

      expect(mockStopControllerInstance.stop).toHaveBeenCalled();
      expect(mockSendControllerInstance.send).not.toHaveBeenCalled();

      orch.dispose();
    });

    it('ignores empty content when no file attachments', async () => {
      const { orch } = await buildInitializedOrchestrator();

      mockInputUIInstance.getValue.mockReturnValue('');

      await orch._handleSend();

      expect(mockSendControllerInstance.send).not.toHaveBeenCalled();

      orch.dispose();
    });

    it('handles file attachment flow correctly', async () => {
      const fm = createFileManager(true);
      const { orch, eventBus } = await buildInitializedOrchestrator({ fileManager: fm });

      mockInputUIInstance.getValue.mockReturnValue('See this file');

      await orch._handleSend();

      // 1. Renders user message with attachments
      expect(mockMessageViewInstance.renderMessageWithAttachments).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'user',
          content: 'See this file',
        }),
        expect.objectContaining({
          imageBase64: 'base64data',
          files: [{ name: 'file.txt' }],
        })
      );

      // 2. Scroll request emitted
      expect(eventBus.emit).toHaveBeenCalledWith('scroll:request-bottom', expect.any(Object));

      // 3. Message pushed to state
      expect(mockMessageStateInstance.messages).toHaveLength(1);
      expect(mockMessageStateInstance.messages[0].content).toBe('See this file');

      // 4. Stream handler context set
      expect(mockStreamHandlerInstance.userMessageId).toBeTruthy();
      expect(mockStreamHandlerInstance.userMessageCorrelationId).toBeTruthy();

      // 5. Input cleared
      expect(mockInputUIInstance.clear).toHaveBeenCalled();

      // 6. Processing state set
      expect(orch.isProcessing).toBe(true);
      expect(orch.isStopMode).toBe(true);

      // 7. Files sent through file manager
      expect(fm.sendFiles).toHaveBeenCalledWith(
        'See this file', 'chat-123', expect.any(String)
      );

      // 8. Message sent through send controller
      expect(mockSendControllerInstance.send).toHaveBeenCalledWith('See this file', expect.objectContaining({
        chatId: 'chat-123',
      }));

      // 9. Status bar cleared
      expect(mockStatusBarInstance.clear).toHaveBeenCalled();

      orch.dispose();
    });

    it('handles file attachment flow with empty content (uses fallback)', async () => {
      const fm = createFileManager(true);
      const { orch } = await buildInitializedOrchestrator({ fileManager: fm });

      mockInputUIInstance.getValue.mockReturnValue('');

      await orch._handleSend();

      // Empty content → normalized to '' in userMessage, 'Attached file' for send
      expect(mockMessageViewInstance.renderMessageWithAttachments).toHaveBeenCalledWith(
        expect.objectContaining({ content: '' }),
        expect.any(Object)
      );
      expect(mockSendControllerInstance.send).toHaveBeenCalledWith('Attached file', expect.any(Object));

      orch.dispose();
    });

    it('handles file attachment send failure', async () => {
      const fm = createFileManager(true);
      fm.sendFiles.mockRejectedValue(new Error('upload failed'));
      const { orch } = await buildInitializedOrchestrator({ fileManager: fm });

      mockInputUIInstance.getValue.mockReturnValue('File content');

      await orch._handleSend();

      expect(orch.isProcessing).toBe(false);
      expect(orch.isStopMode).toBe(false);
      expect(mockStatusBarInstance.showError).toHaveBeenCalledWith(
        expect.stringContaining('upload failed')
      );
      expect(mockToast.error).toHaveBeenCalledWith(
        expect.stringContaining('upload failed')
      );

      orch.dispose();
    });

    it('delegates to sendMessage for normal text', async () => {
      const { orch } = await buildInitializedOrchestrator();

      mockInputUIInstance.getValue.mockReturnValue('normal message');

      await orch._handleSend();

      expect(mockSendControllerInstance.send).toHaveBeenCalledWith('normal message', expect.objectContaining({
        chatId: 'chat-123',
      }));

      orch.dispose();
    });
  });

  // =========================================================================
  // sendMessage
  // =========================================================================

  describe('sendMessage', () => {
    it('sends message through full pipeline', async () => {
      const { orch, eventBus } = await buildInitializedOrchestrator();

      await orch.sendMessage('Hello backend');

      // Preflight validation called
      expect(mockSendControllerInstance.preflightValidate).toHaveBeenCalledWith('Hello backend');

      // Input validation cleared
      expect(mockInputUIInstance.clearValidation).toHaveBeenCalled();

      // Message rendered
      expect(mockMessageViewInstance.renderMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'user',
          content: 'Hello backend',
        })
      );

      // Scroll emitted
      expect(eventBus.emit).toHaveBeenCalledWith('scroll:request-bottom', expect.any(Object));

      // State tracking
      expect(mockMessageStateInstance.messages).toHaveLength(1);
      expect(orch.isProcessing).toBe(true);
      expect(orch.isStopMode).toBe(true);

      // Send controller called with correlation ID
      expect(mockSendControllerInstance.send).toHaveBeenCalledWith('Hello backend', {
        correlationId: expect.any(String),
        chatId: 'chat-123',
      });

      // Cleanup
      expect(mockStatusBarInstance.clear).toHaveBeenCalled();

      orch.dispose();
    });

    it('trims whitespace from content', async () => {
      const { orch } = await buildInitializedOrchestrator();

      await orch.sendMessage('  padded message  ');

      expect(mockSendControllerInstance.preflightValidate).toHaveBeenCalledWith('padded message');

      orch.dispose();
    });

    it('rejects empty/whitespace-only content', async () => {
      const { orch } = await buildInitializedOrchestrator();

      await orch.sendMessage('   ');

      expect(mockSendControllerInstance.send).not.toHaveBeenCalled();
      expect(mockMessageViewInstance.renderMessage).not.toHaveBeenCalled();

      orch.dispose();
    });

    it('handles validation error with isValidationError flag', async () => {
      const { orch } = await buildInitializedOrchestrator();

      const validationError = new Error('blocked by policy');
      validationError.isValidationError = true;
      mockSendControllerInstance.preflightValidate.mockImplementation(() => { throw validationError; });

      await orch.sendMessage('bad content');

      expect(mockInputUIInstance.markError).toHaveBeenCalledWith('blocked by policy');
      expect(mockStatusBarInstance.showError).toHaveBeenCalledWith('blocked by policy');
      expect(orch.isProcessing).toBe(false);
      expect(orch.isStopMode).toBe(false);
      expect(mockInputUIInstance.focus).toHaveBeenCalled();
      expect(mockSendControllerInstance.send).not.toHaveBeenCalled();

      orch.dispose();
    });

    it('handles generic preflight error', async () => {
      const { orch } = await buildInitializedOrchestrator();

      mockSendControllerInstance.preflightValidate.mockImplementation(() => {
        throw new Error('unexpected preflight crash');
      });

      await orch.sendMessage('some content');

      expect(mockStatusBarInstance.showError).toHaveBeenCalledWith('unexpected preflight crash');
      expect(mockToast.error).toHaveBeenCalledWith('unexpected preflight crash');
      expect(mockSendControllerInstance.send).not.toHaveBeenCalled();

      orch.dispose();
    });

    it('handles send controller failure', async () => {
      const { orch } = await buildInitializedOrchestrator();

      mockSendControllerInstance.send.mockRejectedValue(new Error('network down'));

      await orch.sendMessage('message');

      expect(orch.isProcessing).toBe(false);
      expect(orch.isStopMode).toBe(false);
      expect(mockStatusBarInstance.showError).toHaveBeenCalledWith('network down');
      expect(mockToast.error).toHaveBeenCalledWith('network down');

      orch.dispose();
    });

    it('handles send failure with isValidationError flag', async () => {
      const { orch } = await buildInitializedOrchestrator();

      const err = new Error('blocked');
      err.isValidationError = true;
      mockSendControllerInstance.send.mockRejectedValue(err);

      await orch.sendMessage('message');

      // Should route to validation error handler
      expect(mockInputUIInstance.markError).toHaveBeenCalledWith('blocked');
      expect(mockInputUIInstance.focus).toHaveBeenCalled();

      orch.dispose();
    });

    it('sets stream handler context after rendering', async () => {
      const { orch } = await buildInitializedOrchestrator();

      await orch.sendMessage('context test');

      expect(mockStreamHandlerInstance.userMessageId).toBeTruthy();
      expect(mockStreamHandlerInstance.userMessageCorrelationId).toBeTruthy();

      orch.dispose();
    });

    it('skips preflight if sendController lacks preflightValidate', async () => {
      const { orch } = await buildInitializedOrchestrator();

      orch.sendController.preflightValidate = undefined;

      await orch.sendMessage('no preflight');

      // Should proceed to send without preflight
      expect(mockSendControllerInstance.send).toHaveBeenCalled();

      orch.dispose();
    });
  });

  // =========================================================================
  // stop
  // =========================================================================

  describe('stop', () => {
    it('delegates to stopController and resets state', async () => {
      const { orch } = await buildInitializedOrchestrator();

      orch.isProcessing = true;
      orch.isStopMode = true;

      await orch.stop();

      expect(mockStopControllerInstance.stop).toHaveBeenCalled();
      expect(orch.isProcessing).toBe(false);
      expect(orch.isStopMode).toBe(false);
    });

    it('finalizes stream if actively streaming', async () => {
      const { orch } = await buildInitializedOrchestrator();

      mockStreamHandlerInstance.isStreaming.mockReturnValue(true);

      await orch.stop();

      expect(mockStreamHandlerInstance.forceFinalize).toHaveBeenCalled();

      orch.dispose();
    });

    it('does not finalize stream if not streaming', async () => {
      const { orch } = await buildInitializedOrchestrator();

      mockStreamHandlerInstance.isStreaming.mockReturnValue(false);

      await orch.stop();

      expect(mockStreamHandlerInstance.forceFinalize).not.toHaveBeenCalled();

      orch.dispose();
    });

    it('catches stop errors without crashing', async () => {
      const { orch } = await buildInitializedOrchestrator();

      mockStopControllerInstance.stop.mockRejectedValue(new Error('stop fail'));

      // Should not throw
      await orch.stop();

      orch.dispose();
    });
  });

  // =========================================================================
  // loadChat / createChat
  // =========================================================================

  describe('loadChat', () => {
    it('delegates to chatLifecycle', async () => {
      const { orch } = await buildInitializedOrchestrator();

      await orch.loadChat('chat-abc', { silent: true });

      expect(mockChatLifecycleInstance.loadChat).toHaveBeenCalledWith('chat-abc', { silent: true });

      orch.dispose();
    });
  });

  describe('createChat', () => {
    it('delegates to chatLifecycle with default title', async () => {
      const { orch } = await buildInitializedOrchestrator();

      mockChatLifecycleInstance.createChat.mockResolvedValue('new-chat-id');

      const id = await orch.createChat();

      expect(mockChatLifecycleInstance.createChat).toHaveBeenCalledWith('New Chat', {});
      expect(id).toBe('new-chat-id');

      orch.dispose();
    });

    it('delegates with custom title', async () => {
      const { orch } = await buildInitializedOrchestrator();

      mockChatLifecycleInstance.createChat.mockResolvedValue('custom-id');

      const id = await orch.createChat('Custom Title');

      expect(mockChatLifecycleInstance.createChat).toHaveBeenCalledWith('Custom Title', {});
      expect(id).toBe('custom-id');

      orch.dispose();
    });
  });

  // =========================================================================
  // setProcessing
  // =========================================================================

  describe('setProcessing', () => {
    it('sets processing state and emits event', async () => {
      const { orch } = await buildInitializedOrchestrator();

      orch.setProcessing(true);

      expect(orch.isProcessing).toBe(true);
      expect(mockEventEmitterInstance.emitProcessingState).toHaveBeenCalledWith(true);

      orch.dispose();
    });

    it('shows typing indicator when processing starts', async () => {
      const { orch } = await buildInitializedOrchestrator();

      orch.setProcessing(true);

      expect(mockMessageViewInstance.showTypingIndicator).toHaveBeenCalled();
      expect(mockMessageViewInstance.hideTypingIndicator).not.toHaveBeenCalled();

      orch.dispose();
    });

    it('hides typing indicator when processing ends', async () => {
      const { orch } = await buildInitializedOrchestrator();

      orch.setProcessing(false);

      expect(mockMessageViewInstance.hideTypingIndicator).toHaveBeenCalled();
      expect(mockMessageViewInstance.showTypingIndicator).not.toHaveBeenCalled();

      orch.dispose();
    });
  });

  // =========================================================================
  // setStopMode
  // =========================================================================

  describe('setStopMode', () => {
    it('updates state and button UI for enabled', async () => {
      const { orch, elements } = await buildInitializedOrchestrator();

      orch.setStopMode(true);

      expect(orch.isStopMode).toBe(true);
      expect(elements.sendBtn.classList.contains('stop-mode')).toBe(true);
      expect(elements.sendBtn.innerHTML).toBe('⏹');
      expect(elements.sendBtn.title).toBe('Stop generation');
      expect(mockEventEmitterInstance.emitStopModeState).toHaveBeenCalledWith(true);

      orch.dispose();
    });

    it('restores button UI for disabled', async () => {
      const { orch, elements } = await buildInitializedOrchestrator();

      orch.setStopMode(true);
      orch.setStopMode(false);

      expect(orch.isStopMode).toBe(false);
      expect(elements.sendBtn.classList.contains('stop-mode')).toBe(false);
      expect(elements.sendBtn.innerHTML).toBe('▶');
      expect(elements.sendBtn.title).toBe('Send message');

      orch.dispose();
    });

    it('handles null sendButton gracefully', async () => {
      const { orch } = await buildInitializedOrchestrator();

      orch.sendButton = null;

      // Should not throw
      orch.setStopMode(true);
      expect(orch.isStopMode).toBe(true);
      expect(mockEventEmitterInstance.emitStopModeState).toHaveBeenCalledWith(true);

      orch.dispose();
    });
  });

  // =========================================================================
  // _handleSendValidationError
  // =========================================================================

  describe('_handleSendValidationError', () => {
    it('shows error in input and status bar, resets state, focuses', async () => {
      const { orch } = await buildInitializedOrchestrator();

      orch.isProcessing = true;
      orch.isStopMode = true;

      orch._handleSendValidationError({ message: 'XSS detected' });

      expect(mockInputUIInstance.markError).toHaveBeenCalledWith('XSS detected');
      expect(mockStatusBarInstance.showError).toHaveBeenCalledWith('XSS detected');
      expect(orch.isProcessing).toBe(false);
      expect(orch.isStopMode).toBe(false);
      expect(mockInputUIInstance.focus).toHaveBeenCalled();
    });

    it('uses fallback message when error has no message', async () => {
      const { orch } = await buildInitializedOrchestrator();

      orch._handleSendValidationError({});

      expect(mockInputUIInstance.markError).toHaveBeenCalledWith('Message blocked by security policy.');

      orch.dispose();
    });

    it('handles null error gracefully', async () => {
      const { orch } = await buildInitializedOrchestrator();

      orch._handleSendValidationError(null);

      expect(mockInputUIInstance.markError).toHaveBeenCalledWith('Message blocked by security policy.');

      orch.dispose();
    });
  });

  // =========================================================================
  // _updateChatTitleIfNeeded
  // =========================================================================

  describe('_updateChatTitleIfNeeded', () => {
    it('updates title when there is exactly one message', async () => {
      const { orch, eventBus } = await buildInitializedOrchestrator();

      mockMessageStateInstance.getMessages.mockReturnValue([{ id: 'msg-1', content: 'First' }]);

      orch._updateChatTitleIfNeeded('First message content');

      expect(eventBus.emit).toHaveBeenCalledWith('chat:title-changed', {
        title: 'First message content',
      });
      expect(mockMessageStateInstance.updateChatTitle).toHaveBeenCalledWith('First message content');

      orch.dispose();
    });

    it('truncates title to 50 chars', async () => {
      const { orch, eventBus } = await buildInitializedOrchestrator();

      mockMessageStateInstance.getMessages.mockReturnValue([{ id: 'msg-1' }]);

      const longContent = 'A'.repeat(100);
      orch._updateChatTitleIfNeeded(longContent);

      const emitCall = eventBus.emit.mock.calls.find(c => c[0] === 'chat:title-changed');
      expect(emitCall[1].title).toBe('A'.repeat(50));

      orch.dispose();
    });

    it('does NOT update title when there are multiple messages', async () => {
      const { orch, eventBus } = await buildInitializedOrchestrator();

      mockMessageStateInstance.getMessages.mockReturnValue([
        { id: 'msg-1' }, { id: 'msg-2' },
      ]);

      orch._updateChatTitleIfNeeded('Second message');

      expect(eventBus.emit).not.toHaveBeenCalledWith('chat:title-changed', expect.any(Object));
      expect(mockMessageStateInstance.updateChatTitle).not.toHaveBeenCalled();

      orch.dispose();
    });

    it('does NOT update title when messages is empty', async () => {
      const { orch } = await buildInitializedOrchestrator();

      mockMessageStateInstance.getMessages.mockReturnValue([]);

      orch._updateChatTitleIfNeeded('No messages');

      expect(mockMessageStateInstance.updateChatTitle).not.toHaveBeenCalled();

      orch.dispose();
    });
  });

  // =========================================================================
  // _generateMessageId
  // =========================================================================

  describe('_generateMessageId', () => {
    it('returns ID from sessionBridge', async () => {
      const { orch } = await buildInitializedOrchestrator();

      mockSessionBridge.nextUserMessageId.mockResolvedValue('session-msg-42');

      const id = await orch._generateMessageId();

      expect(id).toBe('session-msg-42');
      expect(mockSessionBridge.nextUserMessageId).toHaveBeenCalledWith({ chatId: 'chat-123' });

      orch.dispose();
    });

    it('falls back to local ID on sessionBridge error', async () => {
      const { orch } = await buildInitializedOrchestrator();

      mockSessionBridge.nextUserMessageId.mockRejectedValue(new Error('bridge down'));

      const id = await orch._generateMessageId();

      expect(id).toMatch(/^uuid-\d+$/);

      orch.dispose();
    });

    it('uses optional chaining for messageState.getCurrentChatId', async () => {
      const { orch } = await buildInitializedOrchestrator();

      orch.messageState = null;
      mockSessionBridge.nextUserMessageId.mockResolvedValue('no-state-id');

      const id = await orch._generateMessageId();

      expect(id).toBe('no-state-id');
      expect(mockSessionBridge.nextUserMessageId).toHaveBeenCalledWith({ chatId: null });

      orch.dispose();
    });
  });

  // =========================================================================
  // _generateCorrelationId
  // =========================================================================

  describe('_generateCorrelationId', () => {
    it('returns crypto.randomUUID value', async () => {
      const { orch } = await buildInitializedOrchestrator();

      const id = orch._generateCorrelationId();

      expect(id).toMatch(/^uuid-\d+$/);

      orch.dispose();
    });

    it('throws when crypto.randomUUID is removed', async () => {
      const { orch } = await buildInitializedOrchestrator();

      const saved = crypto.randomUUID;
      delete crypto.randomUUID;

      expect(() => orch._generateCorrelationId()).toThrow('CONTRACT VIOLATION');

      crypto.randomUUID = saved;
      orch.dispose();
    });
  });

  // =========================================================================
  // getStats
  // =========================================================================

  describe('getStats', () => {
    it('returns frozen stats object', async () => {
      const { orch } = await buildInitializedOrchestrator();

      mockMessageViewInstance.getMessageCount.mockReturnValue(5);
      orch.isProcessing = true;
      orch.isStopMode = true;
      mockStreamHandlerInstance.isStreaming.mockReturnValue(true);
      mockMessageStateInstance.getCurrentChatId.mockReturnValue('chat-xyz');

      const stats = orch.getStats();

      expect(stats).toEqual({
        messageCount: 5,
        isProcessing: true,
        isStopMode: true,
        isStreaming: true,
        currentChatId: 'chat-xyz',
      });
      expect(Object.isFrozen(stats)).toBe(true);

      orch.dispose();
    });

    it('handles null sub-modules gracefully', async () => {
      const { orch } = await buildInitializedOrchestrator();

      orch.messageView = null;
      orch.streamHandler = null;
      orch.messageState = null;

      const stats = orch.getStats();

      expect(stats).toEqual({
        messageCount: 0,
        isProcessing: false,
        isStopMode: false,
        isStreaming: false,
        currentChatId: null,
      });

      // Restore for dispose
      orch.messageView = mockMessageViewInstance;
      orch.streamHandler = mockStreamHandlerInstance;
      orch.messageState = mockMessageStateInstance;
      orch.dispose();
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    it('removes all IPC listeners', async () => {
      const { orch, ipc } = await buildInitializedOrchestrator();

      expect(orch._ipcListeners).toHaveLength(2); // chat:request-complete, chat:message:failed

      orch.dispose();

      // Cleanup function was called
      expect(orch._ipcListeners).toEqual([]);
    });

    it('removes all DOM listeners', async () => {
      const { orch, elements } = await buildInitializedOrchestrator();

      const sendBtnRemoveSpy = jest.spyOn(elements.sendBtn, 'removeEventListener');
      const inputRemoveSpy = jest.spyOn(elements.input, 'removeEventListener');

      orch.dispose();

      expect(sendBtnRemoveSpy).toHaveBeenCalledWith('click', expect.any(Function));
      expect(inputRemoveSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
    });

    it('calls EventBus cleanup functions', async () => {
      const { orch, eventBus } = await buildInitializedOrchestrator();

      // EventBus.on returns cleanup functions that are stored in _eventListeners
      const eventBusCleanups = orch._eventListeners.filter(l => typeof l === 'function');
      expect(eventBusCleanups.length).toBeGreaterThanOrEqual(2); // ASSISTANT_STREAM + title-update

      orch.dispose();

      for (const cleanup of eventBusCleanups) {
        expect(cleanup).toHaveBeenCalled();
      }

      expect(orch._eventListeners).toEqual([]);
    });

    it('disposes all 20 sub-modules', async () => {
      const { orch } = await buildInitializedOrchestrator();

      orch.dispose();

      // Verify each module's dispose was called
      expect(mockQueueProcessorInstance.dispose).toHaveBeenCalled();
      expect(mockRouterInstance.dispose).toHaveBeenCalled();
      expect(mockAssistantHandlerInstance.dispose).toHaveBeenCalled();
      expect(mockTrailHandlerInstance.dispose).toHaveBeenCalled();
      expect(mockControlHandlerInstance.dispose).toHaveBeenCalled();
      expect(mockArtifactRoutingInstance.dispose).toHaveBeenCalled();
      expect(mockEnrichmentInstance.dispose).toHaveBeenCalled();
      expect(mockChatLifecycleInstance.dispose).toHaveBeenCalled();
      expect(mockInputUIInstance.dispose).toHaveBeenCalled();
      expect(mockStatusBarInstance.dispose).toHaveBeenCalled();
      expect(mockScrollInstance.dispose).toHaveBeenCalled();
      expect(mockIpcTransportInstance.dispose).toHaveBeenCalled();
      expect(mockEventEmitterInstance.dispose).toHaveBeenCalled();
      expect(mockStreamHandlerInstance.dispose).toHaveBeenCalled();
      expect(mockStopControllerInstance.dispose).toHaveBeenCalled();
      expect(mockSendControllerInstance.dispose).toHaveBeenCalled();
      expect(mockMessageStateInstance.dispose).toHaveBeenCalled();
      expect(mockMessageViewInstance.dispose).toHaveBeenCalled();
      expect(mockMarkdownRendererInstance.dispose).toHaveBeenCalled();
      expect(mockSanitizerInstance.dispose).toHaveBeenCalled();
    });

    it('handles errors in listener cleanup without crashing', async () => {
      const { orch } = await buildInitializedOrchestrator();

      // Inject a throwing cleanup function
      orch._ipcListeners.push(() => { throw new Error('ipc cleanup fail'); });
      orch._eventListeners.push(() => { throw new Error('event cleanup fail'); });

      // Should not throw
      orch.dispose();

      expect(orch._ipcListeners).toEqual([]);
      expect(orch._eventListeners).toEqual([]);
    });

    it('quantitative proof: N created = M cleaned', async () => {
      const { orch, elements } = await buildInitializedOrchestrator();

      // Count resources before dispose
      const ipcListenerCount = orch._ipcListeners.length;
      const eventListenerCount = orch._eventListeners.length;

      expect(ipcListenerCount).toBe(2); // chat:request-complete, chat:message:failed
      expect(eventListenerCount).toBe(5); // 2 DOM + 3 EventBus functions

      const sendBtnRemoveSpy = jest.spyOn(elements.sendBtn, 'removeEventListener');
      const inputRemoveSpy = jest.spyOn(elements.input, 'removeEventListener');

      orch.dispose();

      // All IPC listeners cleaned
      expect(orch._ipcListeners).toEqual([]);

      // All event listeners cleaned
      expect(orch._eventListeners).toEqual([]);

      // DOM listeners removed: 2
      expect(sendBtnRemoveSpy).toHaveBeenCalledTimes(1);
      expect(inputRemoveSpy).toHaveBeenCalledTimes(1);

      // 20 modules disposed
      const disposedModules = [
        mockQueueProcessorInstance, mockRouterInstance, mockAssistantHandlerInstance,
        mockTrailHandlerInstance, mockControlHandlerInstance, mockArtifactRoutingInstance,
        mockEnrichmentInstance, mockChatLifecycleInstance, mockInputUIInstance,
        mockStatusBarInstance, mockScrollInstance, mockIpcTransportInstance,
        mockEventEmitterInstance, mockStreamHandlerInstance, mockStopControllerInstance,
        mockSendControllerInstance, mockMessageStateInstance, mockMessageViewInstance,
        mockMarkdownRendererInstance, mockSanitizerInstance,
      ];

      for (const mod of disposedModules) {
        expect(mod.dispose).toHaveBeenCalledTimes(1);
      }
    });
  });

  // =========================================================================
  // ControlMessageHandler callbacks (lines 237-238)
  // =========================================================================

  describe('ControlMessageHandler callbacks', () => {
    it('onProcessingChange callback delegates to setProcessing', async () => {
      const { orch } = await buildInitializedOrchestrator();

      expect(capturedControlHandlerOpts).not.toBeNull();
      expect(typeof capturedControlHandlerOpts.onProcessingChange).toBe('function');

      capturedControlHandlerOpts.onProcessingChange(true);
      expect(orch.isProcessing).toBe(true);

      capturedControlHandlerOpts.onProcessingChange(false);
      expect(orch.isProcessing).toBe(false);

      orch.dispose();
    });

    it('onStopModeChange callback delegates to setStopMode', async () => {
      const { orch } = await buildInitializedOrchestrator();

      expect(typeof capturedControlHandlerOpts.onStopModeChange).toBe('function');

      capturedControlHandlerOpts.onStopModeChange(true);
      expect(orch.isStopMode).toBe(true);

      capturedControlHandlerOpts.onStopModeChange(false);
      expect(orch.isStopMode).toBe(false);

      orch.dispose();
    });
  });

  // =========================================================================
  // lifecycle
  // =========================================================================

  describe('lifecycle', () => {
    it('supports create → use → dispose cycle', async () => {
      const { orch, elements } = await buildInitializedOrchestrator();

      // Use: send a message
      mockInputUIInstance.getValue.mockReturnValue('lifecycle test');
      await orch.sendMessage('lifecycle test');
      expect(mockSendControllerInstance.send).toHaveBeenCalled();

      // Dispose
      orch.dispose();

      // Verify cleaned up
      expect(orch._eventListeners).toEqual([]);
      expect(orch._ipcListeners).toEqual([]);
    });
  });

  // =========================================================================
  // window assignment
  // =========================================================================

  describe('window assignment', () => {
    it('assigns MessageOrchestrator to window', () => {
      expect(window.MessageOrchestrator).toBe(MessageOrchestrator);
    });
  });
});
