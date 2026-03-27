'use strict';

/**
 * MessageOrchestrator send flows (keyboard/button) tests
 *
 * Verifies:
 * - Enter key triggers send
 * - Click button triggers send
 * - Empty input does not trigger send (no ghost UI update)
 */
const MessageOrchestrator = require('../../../src/renderer/chat/modules/messaging/MessageOrchestrator');

function createFakeChatWindow(doc) {
  const input = doc.createElement('textarea');
  input.id = 'chat-input';
  const sendBtn = doc.createElement('button');
  sendBtn.id = 'chat-send';
  const content = doc.createElement('div');
  content.id = 'chat-content';
  const status = doc.createElement('div');
  status.id = 'aether-chat-status';
  const container = doc.createElement('div');
  container.appendChild(input);
  container.appendChild(sendBtn);
  container.appendChild(content);
  container.appendChild(status);
  doc.body.appendChild(container);

  return {
    getElements: () => ({
      input,
      sendBtn,
      content,
      status,
    }),
  };
}

function createEventBus() {
  const listeners = new Map();
  return {
    on: (event, cb) => {
      const arr = listeners.get(event) || [];
      arr.push(cb);
      listeners.set(event, arr);
      return () => {
        const curr = listeners.get(event) || [];
        listeners.set(
          event,
          curr.filter((fn) => fn !== cb)
        );
      };
    },
    emit: (event, payload) => {
      const arr = listeners.get(event) || [];
      for (const fn of arr) {
        try {
          fn(payload);
        } catch (e) {
          // ignore
        }
      }
    },
  };
}

function createIpcStub() {
  return {
    on: jest.fn(() => () => {}),
    send: jest.fn(),
  };
}

async function createTestOrchestrator() {
  const chatWindow = createFakeChatWindow(document);
  const eventBus = createEventBus();
  const ipc = createIpcStub();

  const orchestrator = new MessageOrchestrator({ chatWindow, eventBus, ipc, config: {} });

  // Wire minimal runtime state without invoking full init() (keeps this a unit test)
  const elements = chatWindow.getElements();
  orchestrator.inputElement = elements.input;
  orchestrator.sendButton = elements.sendBtn;
  orchestrator.contentElement = elements.content;
  orchestrator.statusElement = elements.status;

  orchestrator.inputUI = {
    getValue: () => orchestrator.inputElement.value,
    clear: () => { orchestrator.inputElement.value = ''; },
    clearValidation: jest.fn(),
    markError: jest.fn(),
    focus: jest.fn(),
  };

  orchestrator.messageView = {
    renderMessage: jest.fn(),
    renderMessageWithAttachments: jest.fn(),
    getMessageCount: jest.fn(() => 0),
  };

  orchestrator.messageState = {
    currentChatId: 'test-chat-id',
    messages: [],
    getMessages: () => [...orchestrator.messageState.messages],
    updateChatTitle: jest.fn(),
    getCurrentChatId: () => 'test-chat-id',
  };

  orchestrator.sendController = {
    preflightValidate: jest.fn((s) => (typeof s === 'string' ? s.trim() : '')),
    send: jest.fn().mockResolvedValue('req_test_123'),
  };

  orchestrator.stopController = { stop: jest.fn() };
  orchestrator.statusBar = { clear: jest.fn(), showError: jest.fn() };
  orchestrator.eventEmitter = { emitProcessingState: jest.fn(), emitStopModeState: jest.fn() };
  orchestrator.queueProcessor = { enqueue: jest.fn(), dispose: jest.fn() };

  // Deterministic IDs (avoid environment coupling)
  orchestrator._generateMessageId = jest.fn().mockResolvedValue('msg_test_123');
  orchestrator._generateCorrelationId = jest.fn().mockReturnValue('corr_test_123');
  orchestrator._updateChatTitleIfNeeded = jest.fn();
  orchestrator.setProcessing = jest.fn();
  orchestrator.setStopMode = jest.fn();

  orchestrator._setupEventListeners();
  return { orchestrator, chatWindow };
}

describe('MessageOrchestrator send flows', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    jest.clearAllMocks();
  });

  test('Enter key triggers send', async () => {
    const { orchestrator } = await createTestOrchestrator();

    const input = document.getElementById('chat-input');
    input.value = 'hello world';

    const evt = new KeyboardEvent('keydown', { key: 'Enter' });
    Object.defineProperty(evt, 'shiftKey', { value: false });
    input.dispatchEvent(evt);

    // Allow promises to resolve
    await new Promise((r) => setTimeout(r, 0));

    expect(orchestrator.sendController.send).toHaveBeenCalled();
    const [contentArg] = orchestrator.sendController.send.mock.calls[0];
    expect(contentArg).toBe('hello world');
  });

  test('Click button triggers send', async () => {
    const { orchestrator } = await createTestOrchestrator();

    const input = document.getElementById('chat-input');
    const sendBtn = document.getElementById('chat-send');
    input.value = 'clicked send';
    sendBtn.click();

    await new Promise((r) => setTimeout(r, 0));

    expect(orchestrator.sendController.send).toHaveBeenCalled();
    const [contentArg] = orchestrator.sendController.send.mock.calls[0];
    expect(contentArg).toBe('clicked send');
  });

  test('Empty input does not trigger send', async () => {
    const { orchestrator } = await createTestOrchestrator();

    const input = document.getElementById('chat-input');
    const sendBtn = document.getElementById('chat-send');
    input.value = '   '; // whitespace only should be trimmed to empty
    sendBtn.click();

    await new Promise((r) => setTimeout(r, 0));

    expect(orchestrator.sendController.send).not.toHaveBeenCalled();
  });
});


