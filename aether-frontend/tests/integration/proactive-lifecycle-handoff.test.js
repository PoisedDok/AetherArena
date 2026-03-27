/** @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js */

'use strict';

const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  child: () => mockLog,
};

jest.mock('../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

jest.mock('../../src/renderer/shared/components/Toast', () => ({
  success: jest.fn(),
  error: jest.fn(),
  warning: jest.fn(),
  info: jest.fn(),
}));

const HandsfreeConversationDisplay = require('../../src/renderer/main/modules/handsfree/HandsfreeConversationDisplay');
const EventBusBridge = require('../../src/renderer/main/runtime/coordinators/EventBusBridge');
const MessageEventRouter = require('../../src/renderer/chat/modules/messaging/routing/MessageEventRouter');

function createEventBus() {
  const handlers = new Map();

  return {
    on: jest.fn((event, handler) => {
      if (!handlers.has(event)) {
        handlers.set(event, []);
      }
      handlers.get(event).push(handler);
      return () => {
        const list = handlers.get(event) || [];
        const idx = list.indexOf(handler);
        if (idx >= 0) {
          list.splice(idx, 1);
        }
      };
    }),
    off: jest.fn((event, handler) => {
      const list = handlers.get(event) || [];
      const idx = list.indexOf(handler);
      if (idx >= 0) {
        list.splice(idx, 1);
      }
    }),
    emit: jest.fn((event, payload) => {
      const list = handlers.get(event) || [];
      for (const handler of list) {
        handler(payload);
      }
    }),
    _handlers: handlers,
  };
}

function setupHandsfreeDom() {
  const overlay = document.createElement('div');
  overlay.id = 'handsfree-conversation';
  overlay.classList.add('hidden');
  document.body.appendChild(overlay);

  const container = document.createElement('div');
  container.id = 'proactive-notifications-container';
  document.body.appendChild(container);
}

describe('Proactive lifecycle integration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    setupHandsfreeDom();
    global.fetch = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    document.getElementById('handsfree-conversation')?.remove();
    document.getElementById('proactive-notifications-container')?.remove();
  });

  test('routes proactive stream to overlay and forwards click handoff to chat IPC', async () => {
    const eventBus = createEventBus();
    const aether = { ipc: { send: jest.fn() } };

    const bridge = new EventBusBridge({ eventBus, aether });
    bridge.bind();

    const apiClient = { post: jest.fn().mockResolvedValue({}) };

    const display = new HandsfreeConversationDisplay({
      eventBus,
      apiBaseUrl: 'http://localhost:8765',
      apiClient,
      proactiveTts: { enabled: false },
    });
    await display.initialize();

    const router = new MessageEventRouter({
      artifactHandler: { handleArtifact: jest.fn() },
      messageHandler: { handleMessage: jest.fn() },
      trailHandler: { handleTrailEvent: jest.fn() },
      controlHandler: { handleControl: jest.fn() },
      eventBus,
    });

    const proactiveContext = {
      sources: [{ type: 'filesystem', filename: 'research_notes.md' }],
      queries: ['transformer optimization'],
    };

    await router._handleProactiveNotification({
      raw: {
        type: 'proactive:stream-chunk',
        run_id: 'run-42',
        content: 'Consider validating your transformer experiment setup.',
        recommendation: 'Consider validating your transformer experiment setup.',
        context: proactiveContext,
      },
    });

    expect(display._currentProactiveMessage).not.toBeNull();
    expect(display._currentProactiveMessage.dataset.runId).toBe('run-42');

    await router._handleProactiveNotification({
      raw: {
        type: 'proactive:stream-end',
        run_id: 'run-42',
        context: proactiveContext,
      },
    });

    expect(display._proactiveStreamComplete).toBe(true);

    display._currentProactiveMessage.dispatchEvent(new Event('click', { bubbles: true }));

    expect(apiClient.post).toHaveBeenCalledWith(
      expect.stringContaining('/v1/proactive/run-42/feedback?feedback=clicked')
    );

    expect(aether.ipc.send).toHaveBeenCalledWith('chat:proactive-context', {
      initialMessage: 'Consider validating your transformer experiment setup.',
      runId: 'run-42',
      isProactive: true,
    });

    router.dispose();
    display.dispose();
    bridge.dispose();
  });
});
