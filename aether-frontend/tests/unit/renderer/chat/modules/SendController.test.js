'use strict';

if (typeof global.setImmediate === 'undefined') {
  global.setImmediate = (fn, ...args) => setTimeout(() => fn(...args), 0);
}

const SendController = require('../../../../../src/renderer/chat/modules/messaging/SendController');
const { sessionManager } = require('../../../../../src/core/session/SessionManager');

describe('SendController', () => {
  let ipcMock;
  let eventBus;

  beforeEach(() => {
    ipcMock = {
      send: jest.fn(),
    };

    eventBus = {
      events: [],
      emit: jest.fn(function (event, payload) {
        this.events.push({ event, payload });
      }),
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
    for (const chatId of sessionManager.getActiveSessions()) {
      sessionManager.clearSession(chatId);
    }
  });

  it('rejects empty content with validation error', async () => {
    sessionManager.setActiveChat('chat_validation');
    const controller = new SendController({ ipc: ipcMock, eventBus });

    await expect(controller.send('   ')).rejects.toThrow('String too short');
    expect(ipcMock.send).not.toHaveBeenCalled();
  });

  it('routes message through IPC when endpoint is unavailable', async () => {
    sessionManager.setActiveChat('chat_ipc_path');
    const correlationId = sessionManager.nextUserMessageId();

    const controller = new SendController({ ipc: ipcMock, eventBus });
    const requestId = await controller.send('Hello world', { correlationId });

    expect(requestId).toBe(correlationId);
    expect(ipcMock.send).toHaveBeenCalledWith('chat:send', expect.objectContaining({
      message: 'Hello world',
      requestId: correlationId,
      correlationId,
    }));

    // Verify both modern and legacy events fired
    const sentEvent = eventBus.events.find(({ event }) => event === 'chat:message:sent' || event === 'message:sent');
    expect(sentEvent).toBeDefined();
    expect(sentEvent.payload.requestId).toBe(correlationId);
  });

  it('forwards explicit metadata into IPC payload', async () => {
    sessionManager.setActiveChat('chat_metadata_path');
    const correlationId = sessionManager.nextUserMessageId();

    const controller = new SendController({ ipc: ipcMock, eventBus });
    await controller.send('Hello with hidden context', {
      correlationId,
      metadata: {
        source: 'proactive',
        context: { doc_research: [{ query: 'q1' }] },
      },
    });

    expect(ipcMock.send).toHaveBeenCalledWith(
      'chat:send',
      expect.objectContaining({
        requestId: correlationId,
        correlationId,
        metadata: {
          source: 'proactive',
          context: { doc_research: [{ query: 'q1' }] },
        },
      })
    );
  });

  it('generates UUID correlation ID when none provided', async () => {
    sessionManager.setActiveChat('chat_fallback');

    const controller = new SendController({ ipc: ipcMock, eventBus });
    const requestId = await controller.send('Traceable content');

    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(ipcMock.send).toHaveBeenCalledWith('chat:send', expect.objectContaining({
      correlationId: requestId,
      requestId,
    }));
  });
});


