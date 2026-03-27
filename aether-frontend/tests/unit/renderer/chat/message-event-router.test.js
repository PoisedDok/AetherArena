'use strict';

// ---------------------------------------------------------------------------
// Mocks — plain functions survive resetMocks: true
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

jest.mock(
  '../../../../src/renderer/chat/modules/messaging/utils/MessageParser',
  () => ({
    parse: jest.fn(),
    isArtifact: jest.fn().mockReturnValue(false),
    isAssistantMessage: jest.fn().mockReturnValue(false),
    isTrailEvent: jest.fn().mockReturnValue(false),
    isControlMessage: jest.fn().mockReturnValue(false),
    isProactiveNotification: jest.fn().mockReturnValue(false),
    isHandsfreeEvent: jest.fn().mockReturnValue(false),
    getArtifactType: jest.fn().mockReturnValue('code'),
  })
);

const MessageParser = require(
  '../../../../src/renderer/chat/modules/messaging/utils/MessageParser'
);
const MessageEventRouter = require(
  '../../../../src/renderer/chat/modules/messaging/routing/MessageEventRouter'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createArtifactHandler() {
  return { handleArtifact: jest.fn().mockResolvedValue(undefined) };
}
function createMessageHandler() {
  return { handleMessage: jest.fn().mockResolvedValue(undefined) };
}
function createTrailHandler() {
  return { handleTrailEvent: jest.fn().mockResolvedValue(undefined) };
}
function createControlHandler() {
  return { handleControl: jest.fn().mockResolvedValue(undefined) };
}
function createEventBus() {
  return { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
}

function createRouter(overrides = {}) {
  const deps = {
    artifactHandler: createArtifactHandler(),
    messageHandler: createMessageHandler(),
    trailHandler: createTrailHandler(),
    controlHandler: createControlHandler(),
    eventBus: createEventBus(),
    ...overrides,
  };
  const router = new MessageEventRouter(deps);
  return { router, ...deps };
}

/**
 * Reset all MessageParser mocks to default (nothing matches).
 */
function resetParserMocks() {
  MessageParser.parse.mockReturnValue({
    role: 'unknown', type: 'unknown', raw: {},
    content: null, requestId: null, artifactId: null,
  });
  MessageParser.isArtifact.mockReturnValue(false);
  MessageParser.isAssistantMessage.mockReturnValue(false);
  MessageParser.isTrailEvent.mockReturnValue(false);
  MessageParser.isControlMessage.mockReturnValue(false);
  MessageParser.isProactiveNotification.mockReturnValue(false);
  MessageParser.isHandsfreeEvent.mockReturnValue(false);
  MessageParser.getArtifactType.mockReturnValue('code');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessageEventRouter', () => {
  beforeEach(() => {
    mockLog.info.mockClear();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    mockLog.debug.mockClear();
    mockLog.trace.mockClear();
    resetParserMocks();
  });

  // =========================================================================
  // Constructor
  // =========================================================================
  describe('constructor', () => {
    test('throws when artifactHandler is missing', () => {
      expect(() => new MessageEventRouter({
        messageHandler: createMessageHandler(),
        trailHandler: createTrailHandler(),
        controlHandler: createControlHandler(),
        eventBus: createEventBus(),
      })).toThrow('[MessageEventRouter] artifactHandler is REQUIRED');
    });

    test('throws when messageHandler is missing', () => {
      expect(() => new MessageEventRouter({
        artifactHandler: createArtifactHandler(),
        trailHandler: createTrailHandler(),
        controlHandler: createControlHandler(),
        eventBus: createEventBus(),
      })).toThrow('[MessageEventRouter] messageHandler is REQUIRED');
    });

    test('throws when trailHandler is missing', () => {
      expect(() => new MessageEventRouter({
        artifactHandler: createArtifactHandler(),
        messageHandler: createMessageHandler(),
        controlHandler: createControlHandler(),
        eventBus: createEventBus(),
      })).toThrow('[MessageEventRouter] trailHandler is REQUIRED');
    });

    test('throws when controlHandler is missing', () => {
      expect(() => new MessageEventRouter({
        artifactHandler: createArtifactHandler(),
        messageHandler: createMessageHandler(),
        trailHandler: createTrailHandler(),
        eventBus: createEventBus(),
      })).toThrow('[MessageEventRouter] controlHandler is REQUIRED');
    });

    test('throws when eventBus is missing', () => {
      expect(() => new MessageEventRouter({
        artifactHandler: createArtifactHandler(),
        messageHandler: createMessageHandler(),
        trailHandler: createTrailHandler(),
        controlHandler: createControlHandler(),
      })).toThrow('[MessageEventRouter] eventBus is REQUIRED');
    });

    test('succeeds with all dependencies', () => {
      const deps = {
        artifactHandler: createArtifactHandler(),
        messageHandler: createMessageHandler(),
        trailHandler: createTrailHandler(),
        controlHandler: createControlHandler(),
        eventBus: createEventBus(),
      };
      const router = new MessageEventRouter(deps);
      expect(router.artifactHandler).toBe(deps.artifactHandler);
      expect(router.messageHandler).toBe(deps.messageHandler);
      expect(router.trailHandler).toBe(deps.trailHandler);
      expect(router.controlHandler).toBe(deps.controlHandler);
      expect(router.eventBus).toBe(deps.eventBus);
    });
  });

  // =========================================================================
  // route() — parse failure
  // =========================================================================
  describe('route — parse failure', () => {
    test('warns and returns when parse returns null', async () => {
      const { router } = createRouter();
      MessageParser.parse.mockReturnValue(null);

      await router.route({ foo: 'bar' });

      expect(mockLog.warn).toHaveBeenCalledWith('Ignoring unparseable message', {
        payload: { foo: 'bar' },
      });
    });

    test('does not call any handler when parse fails', async () => {
      const { router, artifactHandler, messageHandler, trailHandler, controlHandler } = createRouter();
      MessageParser.parse.mockReturnValue(null);

      await router.route({});

      expect(artifactHandler.handleArtifact).not.toHaveBeenCalled();
      expect(messageHandler.handleMessage).not.toHaveBeenCalled();
      expect(trailHandler.handleTrailEvent).not.toHaveBeenCalled();
      expect(controlHandler.handleControl).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // route() — artifact routing
  // =========================================================================
  describe('route — artifact routing', () => {
    test('routes to artifactHandler when isArtifact returns true', async () => {
      const { router, artifactHandler } = createRouter();
      const normalized = { role: 'assistant', type: 'code', artifactId: 'a1', raw: {} };
      MessageParser.parse.mockReturnValue(normalized);
      MessageParser.isArtifact.mockReturnValue(true);

      await router.route({ role: 'assistant', type: 'code' });

      expect(artifactHandler.handleArtifact).toHaveBeenCalledWith(normalized);
    });

    test('does not route to other handlers when artifact matches', async () => {
      const { router, messageHandler, trailHandler, controlHandler } = createRouter();
      MessageParser.parse.mockReturnValue({ role: 'assistant', type: 'code', raw: {} });
      MessageParser.isArtifact.mockReturnValue(true);

      await router.route({});

      expect(messageHandler.handleMessage).not.toHaveBeenCalled();
      expect(trailHandler.handleTrailEvent).not.toHaveBeenCalled();
      expect(controlHandler.handleControl).not.toHaveBeenCalled();
    });

    test('logs trace with artifact type and id', async () => {
      const { router } = createRouter();
      MessageParser.parse.mockReturnValue({ artifactId: 'art-1', raw: {} });
      MessageParser.isArtifact.mockReturnValue(true);
      MessageParser.getArtifactType.mockReturnValue('console');

      await router.route({});

      expect(mockLog.trace).toHaveBeenCalledWith('Routing to artifact handler', {
        type: 'console',
        artifactId: 'art-1',
      });
    });
  });

  // =========================================================================
  // route() — assistant message routing
  // =========================================================================
  describe('route — assistant message routing', () => {
    test('routes to messageHandler when isAssistantMessage returns true', async () => {
      const { router, messageHandler } = createRouter();
      const normalized = { role: 'assistant', type: 'message', requestId: 'r1', content: 'hi', raw: {} };
      MessageParser.parse.mockReturnValue(normalized);
      MessageParser.isAssistantMessage.mockReturnValue(true);

      await router.route({});

      expect(messageHandler.handleMessage).toHaveBeenCalledWith(normalized);
    });

    test('logs trace with requestId and hasContent', async () => {
      const { router } = createRouter();
      MessageParser.parse.mockReturnValue({ requestId: 'req-1', content: 'text', raw: {} });
      MessageParser.isAssistantMessage.mockReturnValue(true);

      await router.route({});

      expect(mockLog.trace).toHaveBeenCalledWith('Routing to message handler', {
        requestId: 'req-1',
        hasContent: true,
      });
    });

    test('logs hasContent=false when content is null', async () => {
      const { router } = createRouter();
      MessageParser.parse.mockReturnValue({ requestId: 'r1', content: null, raw: {} });
      MessageParser.isAssistantMessage.mockReturnValue(true);

      await router.route({});

      expect(mockLog.trace).toHaveBeenCalledWith('Routing to message handler', {
        requestId: 'r1',
        hasContent: false,
      });
    });
  });

  // =========================================================================
  // route() — trail event routing
  // =========================================================================
  describe('route — trail event routing', () => {
    test('routes to trailHandler when isTrailEvent returns true', async () => {
      const { router, trailHandler } = createRouter();
      const normalized = { role: 'server', type: 'trail.group_created', raw: {} };
      MessageParser.parse.mockReturnValue(normalized);
      MessageParser.isTrailEvent.mockReturnValue(true);

      await router.route({});

      expect(trailHandler.handleTrailEvent).toHaveBeenCalledWith(normalized);
    });

    test('logs trace with eventType', async () => {
      const { router } = createRouter();
      MessageParser.parse.mockReturnValue({ type: 'trail.subgroup_created', raw: {} });
      MessageParser.isTrailEvent.mockReturnValue(true);

      await router.route({});

      expect(mockLog.trace).toHaveBeenCalledWith('Routing to trail handler', {
        eventType: 'trail.subgroup_created',
      });
    });
  });

  // =========================================================================
  // route() — control message routing
  // =========================================================================
  describe('route — control message routing', () => {
    test('routes to controlHandler when isControlMessage returns true', async () => {
      const { router, controlHandler } = createRouter();
      const normalized = { role: 'server', type: 'completion', raw: {} };
      MessageParser.parse.mockReturnValue(normalized);
      MessageParser.isControlMessage.mockReturnValue(true);

      await router.route({});

      expect(controlHandler.handleControl).toHaveBeenCalledWith(normalized);
    });

    test('logs trace with controlType', async () => {
      const { router } = createRouter();
      MessageParser.parse.mockReturnValue({ type: 'stopped', raw: {} });
      MessageParser.isControlMessage.mockReturnValue(true);

      await router.route({});

      expect(mockLog.trace).toHaveBeenCalledWith('Routing to control handler', {
        controlType: 'stopped',
      });
    });
  });

  // =========================================================================
  // route() — proactive notification routing
  // =========================================================================
  describe('route — proactive notification routing', () => {
    test('routes to _handleProactiveNotification when isProactiveNotification', async () => {
      const { router, eventBus } = createRouter();
      MessageParser.parse.mockReturnValue({
        type: 'proactive:stream-chunk',
        content: 'notification text',
        raw: { type: 'proactive:stream-chunk', content: 'text', run_id: 'r1' },
      });
      MessageParser.isProactiveNotification.mockReturnValue(true);

      await router.route({});

      expect(eventBus.emit).toHaveBeenCalled();
    });

    test('logs trace for proactive notification', async () => {
      const { router } = createRouter();
      MessageParser.parse.mockReturnValue({
        type: 'proactive:stream-chunk',
        content: 'text',
        raw: { type: 'proactive:stream-chunk', content: 'text' },
      });
      MessageParser.isProactiveNotification.mockReturnValue(true);

      await router.route({});

      expect(mockLog.trace).toHaveBeenCalledWith(
        'Routing to EventBus (proactive notification)',
        expect.objectContaining({ type: 'proactive:stream-chunk' })
      );
    });
  });

  // =========================================================================
  // route() — handsfree event routing
  // =========================================================================
  describe('route — handsfree event routing', () => {
    test('logs trace and returns for handsfree events', async () => {
      const { router, artifactHandler, messageHandler, controlHandler } = createRouter();
      MessageParser.parse.mockReturnValue({ type: 'wake-word-detected', raw: {} });
      MessageParser.isHandsfreeEvent.mockReturnValue(true);

      await router.route({});

      expect(mockLog.trace).toHaveBeenCalledWith('Handsfree event (handled by MainApp)', {
        type: 'wake-word-detected',
      });
      expect(artifactHandler.handleArtifact).not.toHaveBeenCalled();
      expect(messageHandler.handleMessage).not.toHaveBeenCalled();
      expect(controlHandler.handleControl).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // route() — unknown message type
  // =========================================================================
  describe('route — unknown message type', () => {
    test('logs warn for unknown type when no handler matches', async () => {
      const { router } = createRouter();
      MessageParser.parse.mockReturnValue({ role: 'alien', type: 'mystery', raw: {} });

      await router.route({});

      expect(mockLog.warn).toHaveBeenCalledWith('Unknown message type - no handler', {
        role: 'alien',
        type: 'mystery',
      });
    });
  });

  // =========================================================================
  // route() — routing priority order
  // =========================================================================
  describe('route — routing priority', () => {
    test('artifact takes priority over all others', async () => {
      const { router, artifactHandler, messageHandler, controlHandler } = createRouter();
      MessageParser.parse.mockReturnValue({ raw: {} });
      MessageParser.isArtifact.mockReturnValue(true);
      MessageParser.isAssistantMessage.mockReturnValue(true);
      MessageParser.isControlMessage.mockReturnValue(true);

      await router.route({});

      expect(artifactHandler.handleArtifact).toHaveBeenCalledTimes(1);
      expect(messageHandler.handleMessage).not.toHaveBeenCalled();
      expect(controlHandler.handleControl).not.toHaveBeenCalled();
    });

    test('assistant message takes priority over trail/control', async () => {
      const { router, messageHandler, trailHandler, controlHandler } = createRouter();
      MessageParser.parse.mockReturnValue({ raw: {} });
      MessageParser.isAssistantMessage.mockReturnValue(true);
      MessageParser.isTrailEvent.mockReturnValue(true);
      MessageParser.isControlMessage.mockReturnValue(true);

      await router.route({});

      expect(messageHandler.handleMessage).toHaveBeenCalledTimes(1);
      expect(trailHandler.handleTrailEvent).not.toHaveBeenCalled();
      expect(controlHandler.handleControl).not.toHaveBeenCalled();
    });

    test('trail takes priority over control', async () => {
      const { router, trailHandler, controlHandler } = createRouter();
      MessageParser.parse.mockReturnValue({ raw: {} });
      MessageParser.isTrailEvent.mockReturnValue(true);
      MessageParser.isControlMessage.mockReturnValue(true);

      await router.route({});

      expect(trailHandler.handleTrailEvent).toHaveBeenCalledTimes(1);
      expect(controlHandler.handleControl).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _handleProactiveNotification() — stream-chunk
  // =========================================================================
  describe('_handleProactiveNotification — stream-chunk', () => {
    test('emits proactive:stream-chunk for type proactive:stream-chunk', async () => {
      const { router, eventBus } = createRouter();
      const normalized = {
        raw: {
          type: 'proactive:stream-chunk',
          content: 'Chunk text',
          run_id: 'run-1',
          context: { source: 'test' },
          recommendation: 'Full rec',
        },
      };

      await router._handleProactiveNotification(normalized);

      expect(eventBus.emit).toHaveBeenCalledWith('proactive:stream-chunk', expect.objectContaining({
        content: 'Chunk text',
        chunk: 'Chunk text',
        run_id: 'run-1',
        context: { source: 'test' },
        recommendation: 'Full rec',
      }));
    });

    test('emits proactive:stream-chunk for type proactive-stream-chunk (hyphenated)', async () => {
      const { router, eventBus } = createRouter();

      await router._handleProactiveNotification({
        raw: { type: 'proactive-stream-chunk', content: 'text' },
      });

      expect(eventBus.emit).toHaveBeenCalledWith('proactive:stream-chunk', expect.objectContaining({
        content: 'text',
      }));
    });

    test('uses recommendation as fallback when content is missing', async () => {
      const { router, eventBus } = createRouter();

      await router._handleProactiveNotification({
        raw: { type: 'proactive:stream-chunk', recommendation: 'Rec text' },
      });

      expect(eventBus.emit.mock.calls[0][1].content).toBe('Rec text');
    });

    test('uses empty string when both content and recommendation missing', async () => {
      const { router, eventBus } = createRouter();

      await router._handleProactiveNotification({
        raw: { type: 'proactive:stream-chunk' },
      });

      expect(eventBus.emit.mock.calls[0][1].content).toBe('');
    });
  });

  // =========================================================================
  // _handleProactiveNotification() — stream-end
  // =========================================================================
  describe('_handleProactiveNotification — stream-end', () => {
    test('emits proactive:stream-end with run_id and context', async () => {
      const { router, eventBus } = createRouter();

      await router._handleProactiveNotification({
        raw: {
          type: 'proactive:stream-end',
          run_id: 'run-1',
          context: { src: 'a' },
        },
      });

      expect(eventBus.emit).toHaveBeenCalledWith(
        'proactive:stream-end',
        expect.objectContaining({
          run_id: 'run-1',
          context: { src: 'a' },
        })
      );
    });

    test('emits for hyphenated type proactive-stream-end', async () => {
      const { router, eventBus } = createRouter();

      await router._handleProactiveNotification({
        raw: { type: 'proactive-stream-end', run_id: 'r2' },
      });

      expect(eventBus.emit).toHaveBeenCalledWith('proactive:stream-end', expect.objectContaining({
        run_id: 'r2',
      }));
    });
  });

  // =========================================================================
  // _handleProactiveNotification() — intervention
  // =========================================================================
  describe('_handleProactiveNotification — intervention', () => {
    test('emits both stream-chunk and stream-end for intervention', async () => {
      const { router, eventBus } = createRouter();

      await router._handleProactiveNotification({
        raw: {
          type: 'proactive:intervention',
          content: 'Intervention text',
          run_id: 'run-1',
          context: { x: 1 },
          recommendation: 'Full recommendation',
        },
      });

      expect(eventBus.emit).toHaveBeenCalledTimes(2);
      expect(eventBus.emit.mock.calls[0][0]).toBe('proactive:stream-chunk');
      expect(eventBus.emit.mock.calls[0][1].content).toBe('Intervention text');
      expect(eventBus.emit.mock.calls[1][0]).toBe('proactive:stream-end');
    });

    test('emits for hyphenated type proactive-intervention', async () => {
      const { router, eventBus } = createRouter();

      await router._handleProactiveNotification({
        raw: { type: 'proactive-intervention', content: 'text' },
      });

      expect(eventBus.emit).toHaveBeenCalledTimes(2);
    });

    test('uses recommendation as fallback content for intervention', async () => {
      const { router, eventBus } = createRouter();

      await router._handleProactiveNotification({
        raw: { type: 'proactive:intervention', recommendation: 'Rec only' },
      });

      expect(eventBus.emit.mock.calls[0][1].content).toBe('Rec only');
    });
  });

  // =========================================================================
  // _handleProactiveNotification() — edge cases
  // =========================================================================
  describe('_handleProactiveNotification — edge cases', () => {
    test('warns when eventBus is null', async () => {
      const { router } = createRouter();
      router.eventBus = null;

      await router._handleProactiveNotification({ raw: { type: 'proactive:stream-chunk' } });

      expect(mockLog.warn).toHaveBeenCalledWith('EventBus not available for proactive notification');
    });

    test('catches and logs errors during handling', async () => {
      const { router, eventBus } = createRouter();
      eventBus.emit.mockImplementation(() => { throw new Error('emit failed'); });

      await router._handleProactiveNotification({
        raw: { type: 'proactive:stream-chunk', content: 'text' },
      });

      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to handle proactive notification',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });

    test('does nothing for unknown proactive subtype (no emit)', async () => {
      const { router, eventBus } = createRouter();

      await router._handleProactiveNotification({
        raw: { type: 'proactive:unknown-subtype' },
      });

      expect(eventBus.emit).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // dispose()
  // =========================================================================
  describe('dispose', () => {
    test('nulls all handler references', () => {
      const { router } = createRouter();

      router.dispose();

      expect(router.artifactHandler).toBeNull();
      expect(router.messageHandler).toBeNull();
      expect(router.trailHandler).toBeNull();
      expect(router.controlHandler).toBeNull();
      expect(router.eventBus).toBeNull();
    });

    test('sets _isDisposed to true', () => {
      const { router } = createRouter();
      expect(router._isDisposed).toBe(false);
      router.dispose();
      expect(router._isDisposed).toBe(true);
    });

    test('is idempotent — second call is a no-op', () => {
      const { router } = createRouter();
      router.dispose();

      // Second dispose should not throw or re-log
      expect(() => router.dispose()).not.toThrow();
      expect(router._isDisposed).toBe(true);
    });

    test('BUG REGRESSION: route after dispose returns early (prevents null-ref crash on handlers)', async () => {
      const { router, artifactHandler } = createRouter();
      router.dispose();

      // This would crash pre-fix: artifactHandler is null, route would call null.handleArtifact()
      await router.route({ role: 'assistant', type: 'artifact:start', artifact_id: 'a1' });

      // Guard returns early — handler never called
      expect(artifactHandler.handleArtifact).not.toHaveBeenCalled();
      expect(mockLog.warn).toHaveBeenCalledWith(
        'route called on disposed MessageEventRouter'
      );
    });
  });

  // =========================================================================
  // Module exports
  // =========================================================================
  describe('module exports', () => {
    test('exports MessageEventRouter constructor', () => {
      expect(typeof MessageEventRouter).toBe('function');
    });

    test('instances have expected methods', () => {
      const { router } = createRouter();
      expect(typeof router.route).toBe('function');
      expect(typeof router.dispose).toBe('function');
    });
  });
});
