'use strict';

/**
 * ArtifactsStreamOrchestrator Unit Tests
 * ============================================================================
 * Tests artifact stream orchestration: message routing, trail metadata,
 * execution context tracking, payload normalization, contract enforcement,
 * buffering/flushing, transport delegation, and cleanup.
 *
 * @module tests/unit/application/ArtifactsStreamOrchestrator.test
 */

// --- Module-level mocks ---

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    debug: jest.fn(), trace: jest.fn(),
  }),
}));

const mockRouterInstance = {
  route: jest.fn(),
};
jest.mock('../../../src/domain/artifacts/services/ArtifactMessageRouter', () => ({
  ArtifactMessageRouter: jest.fn(() => mockRouterInstance),
}));

const mockRegistryInstance = {
  register: jest.fn(),
  has: jest.fn().mockReturnValue(false),
  get: jest.fn(),
  clear: jest.fn(),
  getStats: jest.fn().mockReturnValue({ registered: 0 }),
};
jest.mock('../../../src/domain/artifacts/services/TrailMetadataRegistry', () => ({
  TrailMetadataRegistry: jest.fn(() => mockRegistryInstance),
}));

const mockTrackerInstance = {
  trackMessageStart: jest.fn(),
  trackMessageEnd: jest.fn(),
  trackCodeArtifact: jest.fn(),
  getLastCodeArtifactId: jest.fn().mockReturnValue(null),
  recordArtifact: jest.fn(),
  clear: jest.fn(),
  getStats: jest.fn().mockReturnValue({ artifacts: 0 }),
};
jest.mock('../../../src/domain/artifacts/services/ExecutionContextTracker', () => ({
  ExecutionContextTracker: jest.fn(() => mockTrackerInstance),
}));

const mockTransportInstance = {
  sendToArtifacts: jest.fn(),
  getStats: jest.fn().mockReturnValue({ sent: 0 }),
};
jest.mock('../../../src/infrastructure/artifacts/ArtifactTransport', () => ({
  ArtifactTransport: jest.fn(() => mockTransportInstance),
}));

jest.mock('../../../src/renderer/shared/contracts/artifactStream', () => ({
  normalizeArtifactStreamPayload: jest.fn((p) => ({ ...p })),
}));

const ArtifactsStreamOrchestrator = require('../../../src/application/main/ArtifactsStreamOrchestrator');

// --- Helpers ---

function createMockGuru() {
  const listeners = new Map();
  return {
    on: jest.fn((event, handler) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    }),
    off: jest.fn((event, handler) => {
      const arr = listeners.get(event) || [];
      const idx = arr.indexOf(handler);
      if (idx >= 0) arr.splice(idx, 1);
    }),
    _emit(event, data) {
      const arr = listeners.get(event) || [];
      for (const h of arr) h(data);
    },
    _listeners: listeners,
  };
}

function createMockIpc() {
  return { send: jest.fn() };
}

function validCodeMsg(overrides = {}) {
  return {
    chat_id: 'chat-1',
    message_id: 'msg-1',
    request_id: 'req-1',
    artifact_id: 'art-1',
    format: 'python',
    language: 'python',
    execution_group: 'exec-1',
    timestamp: 1700000000000,
    content: 'print("hello")',
    role: 'assistant',
    type: 'code',
    start: false,
    end: false,
    ...overrides,
  };
}

function validOutputMsg(overrides = {}) {
  return {
    chat_id: 'chat-1',
    message_id: 'msg-1',
    request_id: 'req-1',
    artifact_id: 'art-out-1',
    format: 'text',
    execution_group: 'exec-1',
    timestamp: 1700000000000,
    content: 'Hello, world!',
    role: 'computer',
    type: 'output',
    start: false,
    end: false,
    ...overrides,
  };
}

// --- Tests ---

describe('ArtifactsStreamOrchestrator', () => {
  let orch;
  let guru;
  let ipc;

  beforeEach(() => {
    guru = createMockGuru();
    ipc = createMockIpc();

    // Reset mock instances (jest resetMocks clears jest.fn() calls but not our manual instances)
    mockRouterInstance.route.mockReset();
    mockRegistryInstance.register.mockReset();
    mockRegistryInstance.has.mockReset().mockReturnValue(false);
    mockRegistryInstance.get.mockReset();
    mockRegistryInstance.clear.mockReset();
    mockRegistryInstance.getStats.mockReset().mockReturnValue({ registered: 0 });
    mockTrackerInstance.trackMessageStart.mockReset();
    mockTrackerInstance.trackMessageEnd.mockReset();
    mockTrackerInstance.trackCodeArtifact.mockReset();
    mockTrackerInstance.getLastCodeArtifactId.mockReset().mockReturnValue(null);
    mockTrackerInstance.recordArtifact.mockReset();
    mockTrackerInstance.clear.mockReset();
    mockTrackerInstance.getStats.mockReset().mockReturnValue({ artifacts: 0 });
    mockTransportInstance.sendToArtifacts.mockReset();
    mockTransportInstance.getStats.mockReset().mockReturnValue({ sent: 0 });

    orch = new ArtifactsStreamOrchestrator({ guruConnection: guru, ipc });
  });

  afterEach(() => {
    if (orch) orch.dispose();
  });

  // -----------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------
  describe('constructor', () => {
    it('throws when guruConnection not provided', () => {
      expect(() => new ArtifactsStreamOrchestrator({ ipc }))
        .toThrow('guruConnection required');
    });

    it('throws when ipc not provided', () => {
      expect(() => new ArtifactsStreamOrchestrator({ guruConnection: guru }))
        .toThrow('ipc required');
    });

    it('initializes with correct defaults', () => {
      expect(orch.guru).toBe(guru);
      expect(orch.ipc).toBe(ipc);
      expect(orch.enableLogging).toBe(false);
      expect(orch._lmcListener).toBeNull();
      expect(orch._messageListener).toBeNull();
      expect(orch._trailListener).toBeNull();
      expect(orch._pendingChunks).toBeInstanceOf(Map);
      expect(orch._pendingChunks.size).toBe(0);
    });

    it('accepts enableLogging option', () => {
      const o = new ArtifactsStreamOrchestrator({ guruConnection: guru, ipc, enableLogging: true });
      expect(o.enableLogging).toBe(true);
      o.dispose();
    });
  });

  // -----------------------------------------------------------
  // start()
  // -----------------------------------------------------------
  describe('start()', () => {
    it('registers three listeners on guru', () => {
      orch.start();
      expect(guru.on).toHaveBeenCalledTimes(3);
      expect(guru.on).toHaveBeenCalledWith('lmc', expect.any(Function));
      expect(guru.on).toHaveBeenCalledWith('message', expect.any(Function));
      expect(guru.on).toHaveBeenCalledWith('trail.artifact_linked', expect.any(Function));
    });

    it('stores listener references', () => {
      orch.start();
      expect(orch._lmcListener).toEqual(expect.any(Function));
      expect(orch._messageListener).toEqual(expect.any(Function));
      expect(orch._trailListener).toEqual(expect.any(Function));
    });

    it('throws if called twice', () => {
      orch.start();
      expect(() => orch.start()).toThrow('Already started');
    });
  });

  // -----------------------------------------------------------
  // stop()
  // -----------------------------------------------------------
  describe('stop()', () => {
    it('removes all three listeners', () => {
      orch.start();
      const lmc = orch._lmcListener;
      const msg = orch._messageListener;
      const trail = orch._trailListener;
      orch.stop();
      expect(guru.off).toHaveBeenCalledWith('lmc', lmc);
      expect(guru.off).toHaveBeenCalledWith('message', msg);
      expect(guru.off).toHaveBeenCalledWith('trail.artifact_linked', trail);
    });

    it('nulls listener references', () => {
      orch.start();
      orch.stop();
      expect(orch._lmcListener).toBeNull();
      expect(orch._messageListener).toBeNull();
      expect(orch._trailListener).toBeNull();
    });

    it('clears domain state', () => {
      orch.start();
      orch.stop();
      expect(mockTrackerInstance.clear).toHaveBeenCalled();
      expect(mockRegistryInstance.clear).toHaveBeenCalled();
    });

    it('is safe to call without start', () => {
      expect(() => orch.stop()).not.toThrow();
    });

    it('is safe to call twice', () => {
      orch.start();
      orch.stop();
      expect(() => orch.stop()).not.toThrow();
    });

    it('handles guru.off throwing', () => {
      orch.start();
      guru.off.mockImplementation(() => { throw new Error('off failed'); });
      // stop() catches the error internally
      expect(() => orch.stop()).not.toThrow();
    });
  });

  // -----------------------------------------------------------
  // _handleAssistantMessage
  // -----------------------------------------------------------
  describe('_handleAssistantMessage()', () => {
    it('skips non-assistant messages', () => {
      orch._handleAssistantMessage({ role: 'user', type: 'message' });
      expect(mockTrackerInstance.trackMessageStart).not.toHaveBeenCalled();
    });

    it('skips non-message types', () => {
      orch._handleAssistantMessage({ role: 'assistant', type: 'control' });
      expect(mockTrackerInstance.trackMessageStart).not.toHaveBeenCalled();
    });

    it('tracks valid assistant messages', () => {
      const msg = { role: 'assistant', type: 'message' };
      orch._handleAssistantMessage(msg);
      expect(mockTrackerInstance.trackMessageStart).toHaveBeenCalledWith(msg);
      expect(mockTrackerInstance.trackMessageEnd).toHaveBeenCalledWith(msg);
    });

    it('rethrows tracker errors', () => {
      mockTrackerInstance.trackMessageStart.mockImplementation(() => {
        throw new Error('track failed');
      });
      expect(() => orch._handleAssistantMessage({ role: 'assistant', type: 'message' }))
        .toThrow('track failed');
    });
  });

  // -----------------------------------------------------------
  // _handleTrailArtifactLinked
  // -----------------------------------------------------------
  describe('_handleTrailArtifactLinked()', () => {
    it('registers payload in trail registry', () => {
      const payload = { artifact_id: 'art-1', node_id: 'n1' };
      orch._handleTrailArtifactLinked(payload);
      expect(mockRegistryInstance.register).toHaveBeenCalledWith(payload);
    });

    it('flushes buffered chunks for artifact', () => {
      const chunk1 = { artifact_id: 'art-1', role: 'computer', type: 'output' };
      const chunk2 = { artifact_id: 'art-1', role: 'computer', type: 'output' };
      orch._pendingChunks.set('art-1', [chunk1, chunk2]);

      // After registration, has() returns true for flushed sends
      mockRegistryInstance.has.mockReturnValue(true);
      mockRegistryInstance.get.mockReturnValue({ node_id: 'n1', subgroup_id: 's1' });

      orch._handleTrailArtifactLinked({ artifact_id: 'art-1', node_id: 'n1' });

      expect(orch._pendingChunks.has('art-1')).toBe(false);
      expect(mockTransportInstance.sendToArtifacts).toHaveBeenCalledTimes(2);
    });

    it('does not flush when no pending chunks', () => {
      orch._handleTrailArtifactLinked({ artifact_id: 'art-none' });
      expect(mockTransportInstance.sendToArtifacts).not.toHaveBeenCalled();
    });

    it('rethrows registry errors', () => {
      mockRegistryInstance.register.mockImplementation(() => {
        throw new Error('register failed');
      });
      expect(() => orch._handleTrailArtifactLinked({ artifact_id: 'art-1' }))
        .toThrow('register failed');
    });
  });

  // -----------------------------------------------------------
  // _handleLmcMessage -- routing
  // -----------------------------------------------------------
  describe('_handleLmcMessage()', () => {
    it('routes assistant_code messages', () => {
      const msg = validCodeMsg();
      mockRouterInstance.route.mockReturnValue({
        route: 'assistant_code',
        message: msg,
        metadata: {},
      });
      // Make trail registry accept the artifact
      mockRegistryInstance.has.mockReturnValue(true);
      mockRegistryInstance.get.mockReturnValue({ node_id: 'n1', subgroup_id: 's1' });

      orch._handleLmcMessage(msg);

      expect(mockRouterInstance.route).toHaveBeenCalledWith(msg);
      expect(mockTransportInstance.sendToArtifacts).toHaveBeenCalled();
    });

    it('routes computer_output messages', () => {
      const msg = validOutputMsg();
      mockRouterInstance.route.mockReturnValue({
        route: 'computer_output',
        message: msg,
        metadata: {},
      });
      // Computer output requires trail linkage -- buffer it
      mockRegistryInstance.has.mockReturnValue(false);

      orch._handleLmcMessage(msg);

      expect(mockRouterInstance.route).toHaveBeenCalledWith(msg);
      // Should be buffered, not sent directly
      expect(orch._pendingChunks.size).toBeGreaterThan(0);
    });

    it('routes media messages', () => {
      const msg = validCodeMsg({ role: 'computer', type: 'output' });
      mockRouterInstance.route.mockReturnValue({
        route: 'media',
        message: msg,
        metadata: { mediaPayload: { type: 'image', url: 'http://img.png' } },
      });
      mockRegistryInstance.has.mockReturnValue(false);

      orch._handleLmcMessage(msg);
      expect(mockRouterInstance.route).toHaveBeenCalledWith(msg);
    });

    it('silently skips filtered messages', () => {
      mockRouterInstance.route.mockReturnValue({
        route: 'filtered',
        message: {},
        metadata: {},
      });
      orch._handleLmcMessage({});
      expect(mockTransportInstance.sendToArtifacts).not.toHaveBeenCalled();
    });

    it('handles unknown route', () => {
      mockRouterInstance.route.mockReturnValue({
        route: 'unknown',
        message: {},
        metadata: {},
      });
      // No throw, just logs
      expect(() => orch._handleLmcMessage({})).not.toThrow();
    });

    it('warns on unhandled default route', () => {
      mockRouterInstance.route.mockReturnValue({
        route: 'some_totally_new_route',
        message: {},
        metadata: {},
      });
      expect(() => orch._handleLmcMessage({})).not.toThrow();
    });

    it('rethrows routing errors', () => {
      mockRouterInstance.route.mockImplementation(() => {
        throw new Error('route failed');
      });
      expect(() => orch._handleLmcMessage({})).toThrow('route failed');
    });
  });

  // -----------------------------------------------------------
  // _processAssistantCode
  // -----------------------------------------------------------
  describe('_processAssistantCode()', () => {
    it('skips start markers without artifact_id', () => {
      orch._processAssistantCode({ start: true, end: false });
      expect(mockTransportInstance.sendToArtifacts).not.toHaveBeenCalled();
    });

    it('processes full code message', () => {
      const msg = validCodeMsg();
      mockRegistryInstance.has.mockReturnValue(true);
      mockRegistryInstance.get.mockReturnValue({ node_id: 'n1', subgroup_id: 's1' });

      orch._processAssistantCode(msg);

      expect(mockTrackerInstance.recordArtifact).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'assistant', type: 'code' }),
        { kind: 'code' }
      );
      expect(mockTransportInstance.sendToArtifacts).toHaveBeenCalled();
    });

    it('tracks non-start code artifacts', () => {
      const msg = validCodeMsg({ start: false });
      mockRegistryInstance.has.mockReturnValue(true);
      mockRegistryInstance.get.mockReturnValue({ node_id: 'n1', subgroup_id: 's1' });

      orch._processAssistantCode(msg);

      expect(mockTrackerInstance.trackCodeArtifact).toHaveBeenCalled();
    });

    it('does not call trackCodeArtifact for start markers', () => {
      const msg = validCodeMsg({ start: true, artifact_id: 'art-1' });
      mockRegistryInstance.has.mockReturnValue(true);
      mockRegistryInstance.get.mockReturnValue({ node_id: 'n1', subgroup_id: 's1' });

      orch._processAssistantCode(msg);

      expect(mockTrackerInstance.trackCodeArtifact).not.toHaveBeenCalled();
    });

    it('handles non-string content', () => {
      const msg = validCodeMsg({ content: 12345 });
      mockRegistryInstance.has.mockReturnValue(true);
      mockRegistryInstance.get.mockReturnValue({ node_id: 'n1', subgroup_id: 's1' });

      orch._processAssistantCode(msg);

      const payload = mockTransportInstance.sendToArtifacts.mock.calls[0][0];
      expect(payload.content).toBe('');
    });

    it('includes correlation_id when present', () => {
      const msg = validCodeMsg({ correlation_id: 'corr-1' });
      mockRegistryInstance.has.mockReturnValue(true);
      mockRegistryInstance.get.mockReturnValue({ node_id: 'n1', subgroup_id: 's1' });

      orch._processAssistantCode(msg);

      const payload = mockTransportInstance.sendToArtifacts.mock.calls[0][0];
      expect(payload.correlation_id).toBe('corr-1');
    });

    it('uses format as language fallback', () => {
      const msg = validCodeMsg({ language: undefined });
      mockRegistryInstance.has.mockReturnValue(true);
      mockRegistryInstance.get.mockReturnValue({ node_id: 'n1', subgroup_id: 's1' });

      orch._processAssistantCode(msg);

      const payload = mockTransportInstance.sendToArtifacts.mock.calls[0][0];
      expect(payload.language).toBe('python');
    });
  });

  // -----------------------------------------------------------
  // _processComputerOutput
  // -----------------------------------------------------------
  describe('_processComputerOutput()', () => {
    it('skips start markers without artifact_id', () => {
      orch._processComputerOutput({ start: true, end: false }, {});
      expect(mockTransportInstance.sendToArtifacts).not.toHaveBeenCalled();
    });

    it('processes full output message', () => {
      const msg = validOutputMsg();
      mockRegistryInstance.has.mockReturnValue(true);
      mockRegistryInstance.get.mockReturnValue({ node_id: 'n1', subgroup_id: 's1' });

      orch._processComputerOutput(msg, {});

      expect(mockTrackerInstance.recordArtifact).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'computer', type: 'output' }),
        { kind: 'output' }
      );
    });

    it('uses forceHtml metadata to override format', () => {
      const msg = validOutputMsg({ format: 'text' });
      mockRegistryInstance.has.mockReturnValue(true);
      mockRegistryInstance.get.mockReturnValue({ node_id: 'n1', subgroup_id: 's1' });

      orch._processComputerOutput(msg, { forceHtml: true });

      const payload = mockTransportInstance.sendToArtifacts.mock.calls[0][0];
      expect(payload.format).toBe('html');
    });

    it('preserves html format from base', () => {
      const msg = validOutputMsg({ format: 'html' });
      mockRegistryInstance.has.mockReturnValue(true);
      mockRegistryInstance.get.mockReturnValue({ node_id: 'n1', subgroup_id: 's1' });

      orch._processComputerOutput(msg, {});

      const payload = mockTransportInstance.sendToArtifacts.mock.calls[0][0];
      expect(payload.format).toBe('html');
    });

    it('links parent code artifact ID', () => {
      mockTrackerInstance.getLastCodeArtifactId.mockReturnValue('parent-code-1');
      const msg = validOutputMsg();
      mockRegistryInstance.has.mockReturnValue(true);
      mockRegistryInstance.get.mockReturnValue({ node_id: 'n1', subgroup_id: 's1' });

      orch._processComputerOutput(msg, {});

      const payload = mockTransportInstance.sendToArtifacts.mock.calls[0][0];
      expect(payload.parent_id).toBe('parent-code-1');
      expect(payload.metadata.parentArtifactId).toBe('parent-code-1');
    });

    it('falls back to messageId for parent_id when no code artifact', () => {
      mockTrackerInstance.getLastCodeArtifactId.mockReturnValue(null);
      const msg = validOutputMsg();
      mockRegistryInstance.has.mockReturnValue(true);
      mockRegistryInstance.get.mockReturnValue({ node_id: 'n1', subgroup_id: 's1' });

      orch._processComputerOutput(msg, {});

      const payload = mockTransportInstance.sendToArtifacts.mock.calls[0][0];
      expect(payload.parent_id).toBe('msg-1');
      expect(payload.metadata.parentArtifactId).toBeNull();
    });
  });

  // -----------------------------------------------------------
  // _processMediaPayload
  // -----------------------------------------------------------
  describe('_processMediaPayload()', () => {
    it('skips start markers without artifact_id', () => {
      orch._processMediaPayload({ start: true, end: false }, {});
      expect(mockTransportInstance.sendToArtifacts).not.toHaveBeenCalled();
    });

    it('processes media payload', () => {
      const msg = validCodeMsg({ role: 'computer', type: 'output' });
      const metadata = { mediaPayload: { type: 'image', url: 'http://img.png' } };
      mockRegistryInstance.has.mockReturnValue(true);
      mockRegistryInstance.get.mockReturnValue({ node_id: 'n1', subgroup_id: 's1' });

      orch._processMediaPayload(msg, metadata);

      const payload = mockTransportInstance.sendToArtifacts.mock.calls[0][0];
      expect(payload.format).toBe('auto');
      expect(payload.content).toBe(JSON.stringify(metadata.mediaPayload));
      expect(payload.metadata.source).toBe('computer-media');
    });
  });

  // -----------------------------------------------------------
  // _enrichAndSend -- buffering and enrichment
  // -----------------------------------------------------------
  describe('_enrichAndSend()', () => {
    it('buffers computer output when trail metadata missing', () => {
      mockRegistryInstance.has.mockReturnValue(false);
      const payload = { artifact_id: 'art-1', role: 'computer', type: 'output' };

      orch._enrichAndSend(payload);

      expect(orch._pendingChunks.get('art-1')).toEqual([payload]);
      expect(mockTransportInstance.sendToArtifacts).not.toHaveBeenCalled();
    });

    it('accumulates multiple buffered chunks', () => {
      mockRegistryInstance.has.mockReturnValue(false);
      const p1 = { artifact_id: 'art-1', role: 'computer', type: 'output' };
      const p2 = { artifact_id: 'art-1', role: 'computer', type: 'output' };

      orch._enrichAndSend(p1);
      orch._enrichAndSend(p2);

      expect(orch._pendingChunks.get('art-1')).toHaveLength(2);
    });

    it('enriches payload with trail metadata and sends', () => {
      mockRegistryInstance.has.mockReturnValue(true);
      mockRegistryInstance.get.mockReturnValue({ node_id: 'n1', subgroup_id: 's1' });
      const payload = { artifact_id: 'art-1', role: 'computer', type: 'output' };

      orch._enrichAndSend(payload);

      expect(payload.node_id).toBe('n1');
      expect(payload.subgroup_id).toBe('s1');
      expect(mockTransportInstance.sendToArtifacts).toHaveBeenCalledWith(payload);
    });

    it('sends assistant:code without trail requirement', () => {
      mockRegistryInstance.has.mockReturnValue(false);
      const payload = { artifact_id: 'art-1', role: 'assistant', type: 'code' };

      orch._enrichAndSend(payload);

      // assistant:code does not require trail linkage
      expect(mockTransportInstance.sendToArtifacts).toHaveBeenCalledWith(payload);
    });

    it('does not buffer computer:console without trail metadata', () => {
      mockRegistryInstance.has.mockReturnValue(false);
      const payload = { artifact_id: 'art-1', role: 'computer', type: 'console' };

      orch._enrichAndSend(payload);

      expect(orch._pendingChunks.get('art-1')).toEqual([payload]);
      expect(mockTransportInstance.sendToArtifacts).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------
  // Field resolvers -- CONTRACT VIOLATION
  // -----------------------------------------------------------
  describe('field resolvers', () => {
    describe('_resolveChatId()', () => {
      it('returns trimmed chat_id', () => {
        expect(orch._resolveChatId({ chat_id: ' chat-1 ' })).toBe('chat-1');
      });

      it('throws on missing chat_id', () => {
        expect(() => orch._resolveChatId({})).toThrow('CONTRACT VIOLATION');
        expect(() => orch._resolveChatId({ chat_id: '' })).toThrow('CONTRACT VIOLATION');
        expect(() => orch._resolveChatId({ chat_id: '   ' })).toThrow('CONTRACT VIOLATION');
        expect(() => orch._resolveChatId({ chat_id: 123 })).toThrow('CONTRACT VIOLATION');
      });

      it('includes request_id in error message when available', () => {
        expect(() => orch._resolveChatId({ request_id: 'req-x' }))
          .toThrow('backendId=req-x');
      });
    });

    describe('_resolveMessageId()', () => {
      it('returns trimmed message_id', () => {
        expect(orch._resolveMessageId({ message_id: ' msg-1 ' })).toBe('msg-1');
      });

      it('throws on missing message_id', () => {
        expect(() => orch._resolveMessageId({})).toThrow('CONTRACT VIOLATION');
        expect(() => orch._resolveMessageId({ message_id: '' })).toThrow('CONTRACT VIOLATION');
        expect(() => orch._resolveMessageId({ message_id: '   ' })).toThrow('CONTRACT VIOLATION');
      });
    });

    describe('_resolveBackendId()', () => {
      it('returns request_id', () => {
        expect(orch._resolveBackendId({ request_id: 'req-1' })).toBe('req-1');
      });

      it('throws on missing request_id', () => {
        expect(() => orch._resolveBackendId({})).toThrow('CONTRACT VIOLATION');
        expect(() => orch._resolveBackendId({ request_id: 123 })).toThrow('CONTRACT VIOLATION');
      });
    });

    describe('_resolveArtifactId()', () => {
      it('returns artifact_id', () => {
        expect(orch._resolveArtifactId({ artifact_id: 'art-1' })).toBe('art-1');
      });

      it('throws on missing artifact_id', () => {
        expect(() => orch._resolveArtifactId({})).toThrow('CONTRACT VIOLATION');
      });
    });

    describe('_resolveFormat()', () => {
      it('returns format', () => {
        expect(orch._resolveFormat({ format: 'python' })).toBe('python');
      });

      it('falls back to language', () => {
        expect(orch._resolveFormat({ language: 'javascript' })).toBe('javascript');
      });

      it('throws when neither format nor language', () => {
        expect(() => orch._resolveFormat({})).toThrow('CONTRACT VIOLATION');
      });
    });

    describe('_resolveExecutionGroup()', () => {
      it('returns execution_group', () => {
        expect(orch._resolveExecutionGroup({ execution_group: 'exec-1' })).toBe('exec-1');
      });

      it('throws on missing execution_group', () => {
        expect(() => orch._resolveExecutionGroup({})).toThrow('CONTRACT VIOLATION');
      });
    });

    describe('_resolveTimestamp()', () => {
      it('returns numeric timestamp', () => {
        expect(orch._resolveTimestamp({ timestamp: 1700000000000 })).toBe(1700000000000);
      });

      it('parses valid ISO string timestamp', () => {
        const ts = orch._resolveTimestamp({ timestamp: '2023-11-14T22:13:20.000Z' });
        expect(typeof ts).toBe('number');
        expect(ts).toBeGreaterThan(0);
      });

      it('falls back to Date.now() for invalid date strings', () => {
        const before = Date.now();
        const ts = orch._resolveTimestamp({ timestamp: 'not-a-date' });
        expect(ts).toBeGreaterThanOrEqual(before);
      });

      it('throws on missing timestamp', () => {
        expect(() => orch._resolveTimestamp({})).toThrow('CONTRACT VIOLATION');
        expect(() => orch._resolveTimestamp({ timestamp: 0 })).toThrow('CONTRACT VIOLATION');
        expect(() => orch._resolveTimestamp({ timestamp: null })).toThrow('CONTRACT VIOLATION');
      });
    });
  });

  // -----------------------------------------------------------
  // getStats()
  // -----------------------------------------------------------
  describe('getStats()', () => {
    it('returns aggregated stats when not started', () => {
      const stats = orch.getStats();
      expect(stats.isActive).toBe(false);
      expect(stats.router).toEqual({ enabled: true });
      expect(stats.trailRegistry).toEqual({ registered: 0 });
      expect(stats.contextTracker).toEqual({ artifacts: 0 });
      expect(stats.transport).toEqual({ sent: 0 });
    });

    it('reports active when started', () => {
      orch.start();
      expect(orch.getStats().isActive).toBe(true);
    });
  });

  // -----------------------------------------------------------
  // dispose()
  // -----------------------------------------------------------
  describe('dispose()', () => {
    it('stops listeners and nulls references', () => {
      orch.start();
      orch.dispose();
      expect(orch.guru).toBeNull();
      expect(orch.ipc).toBeNull();
      expect(orch._lmcListener).toBeNull();
      orch = null;
    });

    it('is safe to call twice', () => {
      orch.start();
      orch.dispose();
      expect(() => orch.dispose()).not.toThrow();
      orch = null;
    });
  });

  // -----------------------------------------------------------
  // enableLogging branches
  // -----------------------------------------------------------
  describe('enableLogging branches', () => {
    let logOrch;

    beforeEach(() => {
      logOrch = new ArtifactsStreamOrchestrator({
        guruConnection: guru,
        ipc,
        enableLogging: true,
      });
    });

    afterEach(() => {
      if (logOrch) logOrch.dispose();
    });

    it('logs during start()', () => {
      logOrch.start();
      // Covers line 99
      expect(guru.on).toHaveBeenCalledTimes(3);
    });

    it('logs during stop()', () => {
      logOrch.start();
      logOrch.stop();
      // Covers line 126
    });

    it('logs during _handleLmcMessage with unknown route', () => {
      mockRouterInstance.route.mockReturnValue({ route: 'unknown', message: {}, metadata: {} });
      logOrch._handleLmcMessage({});
      // Covers lines 214-218
    });

    it('logs during _handleLmcMessage routing', () => {
      mockRouterInstance.route.mockReturnValue({ route: 'filtered', message: {}, metadata: {} });
      logOrch._handleLmcMessage({});
      // Covers line 196
    });

    it('logs during _processAssistantCode start marker skip', () => {
      logOrch._processAssistantCode({ start: true, end: false });
      // Covers line 238
    });

    it('logs during _processComputerOutput start marker skip', () => {
      logOrch._processComputerOutput({ start: true, end: false }, {});
      // Covers line 298
    });

    it('logs during _processMediaPayload start marker skip', () => {
      logOrch._processMediaPayload({ start: true, end: false }, {});
      // Covers line 357
    });

    it('logs during _enrichAndSend buffering', () => {
      mockRegistryInstance.has.mockReturnValue(false);
      logOrch._enrichAndSend({ artifact_id: 'art-1', role: 'computer', type: 'output' });
      // Covers lines 413-416
    });

    it('logs during _handleTrailArtifactLinked flush', () => {
      logOrch._pendingChunks.set('art-1', [{ artifact_id: 'art-1', role: 'assistant', type: 'code' }]);
      mockRegistryInstance.has.mockReturnValue(true);
      mockRegistryInstance.get.mockReturnValue({ node_id: 'n1', subgroup_id: 's1' });
      logOrch._handleTrailArtifactLinked({ artifact_id: 'art-1' });
      // Covers line 152
    });

    it('logs during dispose()', () => {
      logOrch.dispose();
      // Covers line 535
      logOrch = null;
    });
  });

  // -----------------------------------------------------------
  // Integration: event-driven flow via guru._emit
  // -----------------------------------------------------------
  describe('event-driven integration', () => {
    beforeEach(() => {
      orch.start();
    });

    it('processes lmc event end-to-end', () => {
      const msg = validCodeMsg();
      mockRouterInstance.route.mockReturnValue({
        route: 'assistant_code',
        message: msg,
        metadata: {},
      });
      mockRegistryInstance.has.mockReturnValue(true);
      mockRegistryInstance.get.mockReturnValue({ node_id: 'n1', subgroup_id: 's1' });

      guru._emit('lmc', msg);

      expect(mockTransportInstance.sendToArtifacts).toHaveBeenCalled();
    });

    it('processes message event end-to-end', () => {
      guru._emit('message', { role: 'assistant', type: 'message' });
      expect(mockTrackerInstance.trackMessageStart).toHaveBeenCalled();
    });

    it('processes trail.artifact_linked event end-to-end', () => {
      guru._emit('trail.artifact_linked', { artifact_id: 'art-1', node_id: 'n1' });
      expect(mockRegistryInstance.register).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------
  // Full lifecycle
  // -----------------------------------------------------------
  describe('full lifecycle', () => {
    it('constructor → start → process → stop → dispose', () => {
      const o = new ArtifactsStreamOrchestrator({ guruConnection: guru, ipc });
      o.start();

      // Process a message
      mockRouterInstance.route.mockReturnValue({ route: 'filtered', message: {}, metadata: {} });
      o._handleLmcMessage({});

      // Get stats
      const stats = o.getStats();
      expect(stats.isActive).toBe(true);

      o.stop();
      expect(o.getStats().isActive).toBe(false);

      o.dispose();
      expect(o.guru).toBeNull();
    });
  });
});
