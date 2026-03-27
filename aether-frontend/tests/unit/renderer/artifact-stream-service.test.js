'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Module mocks (hoisted by Jest before any require())
// ═══════════════════════════════════════════════════════════════════════

jest.mock('../../../src/core/events/EventTypes', () => ({
  EventTypes: {
    ARTIFACTS: {
      STREAM_RECEIVED: 'artifacts:stream:received',
      ARTIFACT_FINALIZED: 'artifacts:artifact:finalized',
    },
  },
}));

jest.mock('../../../src/renderer/shared/contracts/artifactStream', () => ({
  normalizeArtifactStreamPayload: jest.fn(),
  resolvePhaseKindFromPayload: jest.fn(),
  getArtifactVariantKey: jest.fn(),
  MAX_ARTIFACT_SIZE: 10 * 1024 * 1024,
}));

// ═══════════════════════════════════════════════════════════════════════
// Requires (post-mock)
// ═══════════════════════════════════════════════════════════════════════

const ArtifactStreamService = require('../../../src/renderer/shared/services/artifacts/ArtifactStreamService');
const {
  normalizeArtifactStreamPayload,
  resolvePhaseKindFromPayload,
  getArtifactVariantKey,
  MAX_ARTIFACT_SIZE,
} = require('../../../src/renderer/shared/contracts/artifactStream');
const { EventTypes } = require('../../../src/core/events/EventTypes');

// ═══════════════════════════════════════════════════════════════════════
// Test data factories
// ═══════════════════════════════════════════════════════════════════════

/** Controlled normalized payload (what normalizeArtifactStreamPayload returns) */
function makeNormalized(overrides = {}) {
  return {
    id: 'art-001',
    artifact_id: 'art-001',
    artifactId: 'art-001',
    executionGroup: 'exec-group-001',
    role: 'assistant',
    type: 'code',
    kind: 'code',
    format: 'python',
    language: 'python',
    content: 'print("hello")',
    chatId: 'chat-001',
    messageId: 'msg-001',
    parentId: null,
    correlationId: null,
    requestId: 'req-001',
    recipient: null,
    start: false,
    end: false,
    timestamp: 1700000000000,
    metadata: {
      role: 'assistant',
      request_id: 'req-001',
      artifact_id: 'art-001',
    },
    ...overrides,
  };
}

/** Raw data passed to handleStream (pre-normalization) */
function makeRawData(overrides = {}) {
  return { type: 'code', content: 'print("hello")', ...overrides };
}

/** Full controller mock with all required sub-objects */
function makeController() {
  return {
    artifactCache: new Map(),
    hasContent: false,
    switchTab: jest.fn(),
    loadArtifact: jest.fn(),
    modules: {
      codeViewer: { loadCode: jest.fn() },
      outputViewer: { loadOutput: jest.fn() },
    },
    sessionStore: { addArtifact: jest.fn() },
    persistArtifact: jest.fn().mockResolvedValue({ id: 'persisted-001' }),
    artifactIndexService: { track: jest.fn() },
  };
}

function makeLogger() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    trace: jest.fn(),
  };
}

function makeEventBus() {
  return { emit: jest.fn() };
}

/** Build an artifact object matching _createArtifactRecord output for direct method tests */
function makeArtifact(overrides = {}) {
  return {
    id: 'art-001',
    request_id: 'req-001',
    artifactId: 'art-001',
    executionGroup: 'exec-group-001',
    role: 'assistant',
    type: 'code',
    rawType: 'code',
    format: 'python',
    language: 'python',
    content: 'print("hello")',
    chatId: 'chat-001',
    messageId: 'msg-001',
    parentId: null,
    correlationId: null,
    timestamp: 1700000000000,
    chunkCount: 5,
    variantKey: 'assistant:code',
    filename: 'code.python',
    node_id: null,
    subgroup_id: null,
    metadata: {
      role: 'assistant',
      request_id: 'req-001',
      artifact_id: 'art-001',
      frontend_id: 'art-001',
      variant_key: 'assistant:code',
      raw_type: 'code',
    },
    ...overrides,
  };
}

function flushPromises() {
  return new Promise(resolve => process.nextTick(resolve));
}

// ═══════════════════════════════════════════════════════════════════════
// Test suite
// ═══════════════════════════════════════════════════════════════════════

describe('ArtifactStreamService', () => {
  let service, controller, eventBus, logger;

  beforeEach(() => {
    // resetMocks: true clears all mock fn implementations each test.
    // Re-establish contract mock defaults.
    normalizeArtifactStreamPayload.mockImplementation(() => makeNormalized());
    resolvePhaseKindFromPayload.mockReturnValue('write');
    getArtifactVariantKey.mockReturnValue('assistant:code');

    eventBus = makeEventBus();
    logger = makeLogger();
    controller = makeController();
    service = new ArtifactStreamService({ eventBus, logger });
    service.setController(controller);
  });

  // ─────────────────────────────────────────────────────────────────────
  // constructor
  // ─────────────────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('throws if eventBus is not provided', () => {
      expect(() => new ArtifactStreamService({ logger }))
        .toThrow('[ArtifactStreamService] EventBus required');
    });

    it('throws if eventBus is null', () => {
      expect(() => new ArtifactStreamService({ eventBus: null, logger }))
        .toThrow('[ArtifactStreamService] EventBus required');
    });

    it('throws if eventBus is undefined explicitly', () => {
      expect(() => new ArtifactStreamService({ eventBus: undefined, logger }))
        .toThrow('[ArtifactStreamService] EventBus required');
    });

    it('stores eventBus reference', () => {
      const svc = new ArtifactStreamService({ eventBus, logger });
      expect(svc.eventBus).toBe(eventBus);
    });

    it('stores logger reference', () => {
      const svc = new ArtifactStreamService({ eventBus, logger });
      expect(svc.log).toBe(logger);
    });

    it('falls back to console when logger is omitted', () => {
      const svc = new ArtifactStreamService({ eventBus });
      expect(svc.log).toBe(console);
    });

    it('initializes controller as null', () => {
      const svc = new ArtifactStreamService({ eventBus, logger });
      expect(svc.controller).toBeNull();
    });

    it('initializes _logThrottle as empty Map', () => {
      const svc = new ArtifactStreamService({ eventBus, logger });
      expect(svc._logThrottle).toBeInstanceOf(Map);
      expect(svc._logThrottle.size).toBe(0);
    });

    it('initializes _persistedArtifacts as empty Map', () => {
      const svc = new ArtifactStreamService({ eventBus, logger });
      expect(svc._persistedArtifacts).toBeInstanceOf(Map);
      expect(svc._persistedArtifacts.size).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // setController
  // ─────────────────────────────────────────────────────────────────────

  describe('setController', () => {
    it('sets the controller reference from null', () => {
      const svc = new ArtifactStreamService({ eventBus, logger });
      expect(svc.controller).toBeNull();
      svc.setController(controller);
      expect(svc.controller).toBe(controller);
    });

    it('replaces an existing controller', () => {
      const svc = new ArtifactStreamService({ eventBus, logger });
      const c1 = makeController();
      const c2 = makeController();
      svc.setController(c1);
      expect(svc.controller).toBe(c1);
      svc.setController(c2);
      expect(svc.controller).toBe(c2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // handleStream — preconditions
  // ─────────────────────────────────────────────────────────────────────

  describe('handleStream — preconditions', () => {
    it('throws if controller is not set', () => {
      service.controller = null;
      expect(() => service.handleStream(makeRawData()))
        .toThrow('[ArtifactStreamService] CONTRACT VIOLATION: Controller not attached');
    });

    it('calls normalizeArtifactStreamPayload with the raw data', () => {
      const raw = makeRawData({ type: 'code', content: 'x = 1' });
      service.handleStream(raw);
      expect(normalizeArtifactStreamPayload).toHaveBeenCalledWith(raw);
    });

    it('throws if normalizeArtifactStreamPayload throws', () => {
      normalizeArtifactStreamPayload.mockImplementation(() => {
        throw new Error('CONTRACT VIOLATION: bad payload');
      });
      expect(() => service.handleStream(makeRawData()))
        .toThrow('CONTRACT VIOLATION: bad payload');
    });

    it('throws if normalized payload has no chatId', () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ chatId: null })
      );
      expect(() => service.handleStream(makeRawData()))
        .toThrow('CONTRACT VIOLATION: Normalized payload missing chatId');
    });

    it('throws if normalized payload has empty string chatId', () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ chatId: '' })
      );
      expect(() => service.handleStream(makeRawData()))
        .toThrow('CONTRACT VIOLATION: Normalized payload missing chatId');
    });

    it('extracts rawType from rawData.type before normalization', () => {
      const raw = makeRawData({ type: 'console' });
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ type: 'output', content: 'log line', role: 'computer' })
      );
      getArtifactVariantKey.mockReturnValue('computer:output');

      service.handleStream(raw);

      // rawType = 'console' is passed to _createArtifactRecord
      const artifact = controller.artifactCache.get('art-001');
      expect(artifact.rawType).toBe('console');
    });

    it('defaults rawType to empty string when rawData.type is falsy', () => {
      const raw = { content: 'hello' }; // no type field
      service.handleStream(raw);
      const artifact = controller.artifactCache.get('art-001');
      expect(artifact.rawType).toBe('code'); // falls back to normalized.type because '' || normalized.type
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // handleStream — START marker handling
  // ─────────────────────────────────────────────────────────────────────

  describe('handleStream — START markers', () => {
    it('resets throttle counters on START marker', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date(1700000000000));

      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ start: true, end: false, content: null })
      );
      service.handleStream(makeRawData());

      const throttle = service._logThrottle.get('art-001');
      expect(throttle.chunkCount).toBe(0);
      expect(throttle.lastLog).toBe(1700000000000);

      jest.useRealTimers();
    });

    it('emits STREAM_RECEIVED for START markers', () => {
      const normalized = makeNormalized({ start: true, end: false, content: null });
      normalizeArtifactStreamPayload.mockReturnValue(normalized);

      service.handleStream(makeRawData());

      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.ARTIFACTS.STREAM_RECEIVED,
        { data: normalized }
      );
    });

    it('returns early for START-only markers (no content, no end)', () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ start: true, end: false, content: null })
      );

      service.handleStream(makeRawData());

      // Artifact should NOT be created in cache
      expect(controller.artifactCache.size).toBe(0);
      expect(controller.hasContent).toBe(false);
      // _trackBackendIndex should NOT be called (no track call)
      expect(controller.artifactIndexService.track).not.toHaveBeenCalled();
    });

    it('does NOT skip START+END markers (combined start/end)', () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ start: true, end: true, content: 'x = 1' })
      );

      service.handleStream(makeRawData());

      // Artifact should be created (start+end is not a start-only marker)
      expect(controller.artifactCache.size).toBe(1);
      expect(controller.hasContent).toBe(true);
    });

    it('does NOT skip START markers that have content', () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ start: true, end: false, content: 'x = 1' })
      );

      service.handleStream(makeRawData());

      expect(controller.artifactCache.size).toBe(1);
      const artifact = controller.artifactCache.get('art-001');
      expect(artifact.content).toBe('x = 1');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // handleStream — artifactId validation
  // ─────────────────────────────────────────────────────────────────────

  describe('handleStream — artifactId validation', () => {
    it('skips processing when artifactId is null', () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ artifact_id: null, content: 'hello' })
      );

      service.handleStream(makeRawData());

      expect(controller.artifactCache.size).toBe(0);
      expect(logger.error).toHaveBeenCalledWith(
        '[ArtifactStreamService] Invalid artifactId - skipping',
        expect.objectContaining({ artifactId: null })
      );
    });

    it('skips processing when artifactId is empty string', () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ artifact_id: '' })
      );

      service.handleStream(makeRawData());

      expect(controller.artifactCache.size).toBe(0);
    });

    it('skips processing when artifactId is whitespace-only', () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ artifact_id: '   ' })
      );

      service.handleStream(makeRawData());

      expect(controller.artifactCache.size).toBe(0);
      expect(logger.error).toHaveBeenCalled();
    });

    it('still emits STREAM_RECEIVED before skipping invalid artifactId', () => {
      const normalized = makeNormalized({ artifact_id: null, content: 'hello' });
      normalizeArtifactStreamPayload.mockReturnValue(normalized);

      service.handleStream(makeRawData());

      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.ARTIFACTS.STREAM_RECEIVED,
        { data: normalized }
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // handleStream — artifact cache: new artifacts
  // ─────────────────────────────────────────────────────────────────────

  describe('handleStream — artifact cache: new artifacts', () => {
    it('creates new artifact record on cache miss', () => {
      service.handleStream(makeRawData());

      expect(controller.artifactCache.size).toBe(1);
      expect(controller.artifactCache.has('art-001')).toBe(true);
    });

    it('sets controller.hasContent to true on first artifact', () => {
      expect(controller.hasContent).toBe(false);
      service.handleStream(makeRawData());
      expect(controller.hasContent).toBe(true);
    });

    it('created artifact has correct structure and field values', () => {
      service.handleStream(makeRawData());

      const artifact = controller.artifactCache.get('art-001');
      expect(artifact.id).toBe('art-001');
      expect(artifact.request_id).toBe('req-001');
      expect(artifact.artifactId).toBe('art-001');
      expect(artifact.executionGroup).toBe('exec-group-001');
      expect(artifact.role).toBe('assistant');
      expect(artifact.type).toBe('code');
      expect(artifact.format).toBe('python');
      expect(artifact.language).toBe('python');
      expect(artifact.chatId).toBe('chat-001');
      expect(artifact.variantKey).toBe('assistant:code');
      expect(artifact.filename).toBe('code.python');
      expect(artifact.node_id).toBeNull();
      expect(artifact.subgroup_id).toBeNull();
    });

    it('throws if executionGroup is missing on new artifact', () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ executionGroup: null })
      );

      expect(() => service.handleStream(makeRawData()))
        .toThrow('CONTRACT VIOLATION: executionGroup is required');
    });

    it('throws if executionGroup is a number (non-string)', () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ executionGroup: 42 })
      );

      expect(() => service.handleStream(makeRawData()))
        .toThrow('CONTRACT VIOLATION: executionGroup is required');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // handleStream — artifact cache: existing artifacts
  // ─────────────────────────────────────────────────────────────────────

  describe('handleStream — artifact cache: existing artifacts', () => {
    beforeEach(() => {
      // Seed cache with an existing artifact that has minimal fields
      const existing = makeArtifact({
        executionGroup: null,
        request_id: null,
        filename: null,
        chatId: 'chat-old',
        correlationId: null,
        node_id: null,
        subgroup_id: null,
        content: 'existing',
        chunkCount: 3,
      });
      controller.artifactCache.set('art-001', existing);
    });

    it('reuses existing artifact from cache instead of creating new', () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ executionGroup: 'exec-new', content: '+chunk' })
      );

      service.handleStream(makeRawData());

      // Should still be exactly 1 entry
      expect(controller.artifactCache.size).toBe(1);
      const artifact = controller.artifactCache.get('art-001');
      // chunkCount should increment from existing 3 to 4
      expect(artifact.chunkCount).toBe(4);
    });

    it('updates executionGroup when existing is falsy and normalized has it', () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ executionGroup: 'exec-new', content: 'x' })
      );

      service.handleStream(makeRawData());

      expect(controller.artifactCache.get('art-001').executionGroup).toBe('exec-new');
    });

    it('does NOT overwrite executionGroup when existing already has a valid string', () => {
      controller.artifactCache.get('art-001').executionGroup = 'exec-original';
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ executionGroup: 'exec-new', content: 'x' })
      );

      service.handleStream(makeRawData());

      expect(controller.artifactCache.get('art-001').executionGroup).toBe('exec-original');
    });

    it('updates request_id when existing is falsy', () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ content: 'x' })
      );

      service.handleStream(makeRawData());

      expect(controller.artifactCache.get('art-001').request_id).toBe('req-001');
    });

    it('updates filename when existing is falsy', () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ content: 'x' })
      );

      service.handleStream(makeRawData());

      expect(controller.artifactCache.get('art-001').filename).toBe('code.python');
    });

    it('updates chatId when normalized differs', () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ chatId: 'chat-new', content: 'x' })
      );

      service.handleStream(makeRawData());

      expect(controller.artifactCache.get('art-001').chatId).toBe('chat-new');
    });

    it('does NOT update chatId when normalized matches existing', () => {
      controller.artifactCache.get('art-001').chatId = 'chat-same';
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ chatId: 'chat-same', content: 'x' })
      );

      service.handleStream(makeRawData());

      expect(controller.artifactCache.get('art-001').chatId).toBe('chat-same');
    });

    it('updates correlationId when normalized differs', () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ correlationId: 'corr-new', content: 'x' })
      );

      service.handleStream(makeRawData());

      expect(controller.artifactCache.get('art-001').correlationId).toBe('corr-new');
    });

    it('updates node_id when existing is falsy and normalized has it', () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ content: 'x', node_id: 'node-001' })
      );

      service.handleStream(makeRawData());

      expect(controller.artifactCache.get('art-001').node_id).toBe('node-001');
    });

    it('does NOT overwrite node_id when existing already set', () => {
      controller.artifactCache.get('art-001').node_id = 'node-orig';
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ content: 'x', node_id: 'node-new' })
      );

      service.handleStream(makeRawData());

      expect(controller.artifactCache.get('art-001').node_id).toBe('node-orig');
    });

    it('updates subgroup_id when existing is falsy and normalized has it', () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ content: 'x', subgroup_id: 'sub-001' })
      );

      service.handleStream(makeRawData());

      expect(controller.artifactCache.get('art-001').subgroup_id).toBe('sub-001');
    });

    it('does NOT overwrite subgroup_id when existing already set', () => {
      controller.artifactCache.get('art-001').subgroup_id = 'sub-orig';
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ content: 'x', subgroup_id: 'sub-new' })
      );

      service.handleStream(makeRawData());

      expect(controller.artifactCache.get('art-001').subgroup_id).toBe('sub-orig');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // handleStream — STREAM_RECEIVED event emission
  // ─────────────────────────────────────────────────────────────────────

  describe('handleStream — event emission (STREAM_RECEIVED)', () => {
    it('emits STREAM_RECEIVED with normalized data on every call', () => {
      const normalized = makeNormalized();
      normalizeArtifactStreamPayload.mockReturnValue(normalized);

      service.handleStream(makeRawData());

      expect(eventBus.emit).toHaveBeenCalledTimes(1);
      expect(eventBus.emit).toHaveBeenCalledWith(
        'artifacts:stream:received',
        { data: normalized }
      );
    });

    it('emits STREAM_RECEIVED before any early return (start-only)', () => {
      const normalized = makeNormalized({ start: true, end: false, content: null });
      normalizeArtifactStreamPayload.mockReturnValue(normalized);

      service.handleStream(makeRawData());

      expect(eventBus.emit).toHaveBeenCalledWith(
        'artifacts:stream:received',
        { data: normalized }
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // handleStream — content accumulation
  // ─────────────────────────────────────────────────────────────────────

  describe('handleStream — content accumulation', () => {
    it('appends content to artifact and increments chunkCount', () => {
      service.handleStream(makeRawData());

      const artifact = controller.artifactCache.get('art-001');
      expect(artifact.content).toBe('print("hello")');
      expect(artifact.chunkCount).toBe(1);
    });

    it('accumulates content across multiple chunks', () => {
      // Chunk 1
      normalizeArtifactStreamPayload.mockReturnValueOnce(
        makeNormalized({ content: 'line1\n' })
      );
      service.handleStream(makeRawData({ content: 'line1\n' }));

      // Chunk 2
      normalizeArtifactStreamPayload.mockReturnValueOnce(
        makeNormalized({ content: 'line2\n' })
      );
      service.handleStream(makeRawData({ content: 'line2\n' }));

      const artifact = controller.artifactCache.get('art-001');
      expect(artifact.content).toBe('line1\nline2\n');
      expect(artifact.chunkCount).toBe(2);
    });

    it('increments throttle chunkCount alongside artifact chunkCount', () => {
      service.handleStream(makeRawData());

      const throttle = service._logThrottle.get('art-001');
      expect(throttle.chunkCount).toBe(1);
    });

    it('updates cache after content mutation', () => {
      service.handleStream(makeRawData());

      // Verify the cache holds the mutated artifact (same reference)
      const cached = controller.artifactCache.get('art-001');
      expect(cached.content).toBe('print("hello")');
      expect(cached.chunkCount).toBe(1);
    });

    it('skips content block when normalized.content is null', () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ content: null })
      );

      service.handleStream(makeRawData());

      const artifact = controller.artifactCache.get('art-001');
      expect(artifact.content).toBe(''); // Empty from _createArtifactRecord
      expect(artifact.chunkCount).toBe(0);
    });

    it('skips content block when normalized.content is empty string', () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ content: '' })
      );

      service.handleStream(makeRawData());

      const artifact = controller.artifactCache.get('art-001');
      expect(artifact.content).toBe('');
      expect(artifact.chunkCount).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // handleStream — computer code echo rejection
  // ─────────────────────────────────────────────────────────────────────

  describe('handleStream — computer code echo rejection', () => {
    it('rejects computer:code chunks when artifact.role is assistant', () => {
      // First chunk creates the artifact as assistant:code
      normalizeArtifactStreamPayload.mockReturnValueOnce(
        makeNormalized({ content: 'x = 1' })
      );
      service.handleStream(makeRawData());

      // Second chunk is computer:code echo — should be rejected
      normalizeArtifactStreamPayload.mockReturnValueOnce(
        makeNormalized({ role: 'computer', type: 'code', content: 'x = 1' })
      );
      service.handleStream(makeRawData({ type: 'code' }));

      const artifact = controller.artifactCache.get('art-001');
      // Content should NOT have been duplicated
      expect(artifact.content).toBe('x = 1');
      expect(artifact.chunkCount).toBe(1);
    });

    it('logs debug message for rejected computer code echo', () => {
      normalizeArtifactStreamPayload.mockReturnValueOnce(
        makeNormalized({ content: 'x = 1' })
      );
      service.handleStream(makeRawData());

      normalizeArtifactStreamPayload.mockReturnValueOnce(
        makeNormalized({ role: 'computer', type: 'code', content: 'x = 1' })
      );
      service.handleStream(makeRawData({ type: 'code' }));

      expect(logger.debug).toHaveBeenCalledWith(
        'Skipping role:computer code echo to prevent duplication',
        expect.objectContaining({ artifactId: expect.any(String) })
      );
    });

    it('does NOT reject computer:output chunks (different type)', () => {
      // Create artifact as assistant:code
      normalizeArtifactStreamPayload.mockReturnValueOnce(
        makeNormalized({ content: 'x = 1' })
      );
      service.handleStream(makeRawData());

      // Computer:output is NOT an echo — should accumulate
      normalizeArtifactStreamPayload.mockReturnValueOnce(
        makeNormalized({ role: 'computer', type: 'output', content: 'result', format: 'text' })
      );
      getArtifactVariantKey.mockReturnValue('computer:output');
      service.handleStream(makeRawData({ type: 'output' }));

      const artifact = controller.artifactCache.get('art-001');
      expect(artifact.content).toBe('x = 1result');
      expect(artifact.chunkCount).toBe(2);
    });

    it('does NOT reject when artifact.role matches chunk role (computer:code)', () => {
      // Create artifact as computer:code (from first computer chunk)
      normalizeArtifactStreamPayload.mockReturnValueOnce(
        makeNormalized({ role: 'computer', type: 'code', content: 'line1' })
      );
      getArtifactVariantKey.mockReturnValue('computer:code');
      service.handleStream(makeRawData({ type: 'code' }));

      // Second computer:code chunk — NOT an echo because artifact.role is also computer
      normalizeArtifactStreamPayload.mockReturnValueOnce(
        makeNormalized({ role: 'computer', type: 'code', content: 'line2' })
      );
      service.handleStream(makeRawData({ type: 'code' }));

      const artifact = controller.artifactCache.get('art-001');
      expect(artifact.content).toBe('line1line2');
      expect(artifact.chunkCount).toBe(2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // handleStream — assistant:code routing
  // ─────────────────────────────────────────────────────────────────────

  describe('handleStream — assistant:code routing', () => {
    it('first content chunk: switches to code tab and loads artifact', () => {
      service.handleStream(makeRawData());

      expect(controller.switchTab).toHaveBeenCalledWith('code');
      expect(controller.loadArtifact).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'art-001', chunkCount: 1 }),
        {
          autoSwitch: false,
          forceAutoSwitch: false,
          origin: 'stream-start',
        }
      );
    });

    it('subsequent chunks: calls loadCode on codeViewer', () => {
      // Chunk 1 — first content
      normalizeArtifactStreamPayload.mockReturnValueOnce(
        makeNormalized({ content: 'x = 1\n' })
      );
      service.handleStream(makeRawData({ content: 'x = 1\n' }));

      // Chunk 2 — subsequent content
      normalizeArtifactStreamPayload.mockReturnValueOnce(
        makeNormalized({ content: 'y = 2\n' })
      );
      service.handleStream(makeRawData({ content: 'y = 2\n' }));

      expect(controller.modules.codeViewer.loadCode).toHaveBeenCalledWith(
        'x = 1\ny = 2\n',
        'python',
        'code.python',
        'art-001'
      );
    });

    it('subsequent chunks: throws if language and format are both missing', () => {
      // Chunk 1
      normalizeArtifactStreamPayload.mockReturnValueOnce(
        makeNormalized({ content: 'x', language: null, format: null })
      );
      service.handleStream(makeRawData());

      // The created artifact has null language and null format
      // Chunk 2 should throw when trying to use codeViewer
      normalizeArtifactStreamPayload.mockReturnValueOnce(
        makeNormalized({ content: 'y', language: null, format: null })
      );

      expect(() => service.handleStream(makeRawData()))
        .toThrow('CONTRACT VIOLATION: Artifact missing language and format');
    });

    it('subsequent chunks: uses format as fallback when language is null', () => {
      normalizeArtifactStreamPayload.mockReturnValueOnce(
        makeNormalized({ content: 'x', language: null, format: 'javascript' })
      );
      service.handleStream(makeRawData());

      normalizeArtifactStreamPayload.mockReturnValueOnce(
        makeNormalized({ content: 'y', language: null, format: 'javascript' })
      );
      service.handleStream(makeRawData());

      expect(controller.modules.codeViewer.loadCode).toHaveBeenCalledWith(
        'xy',
        'javascript',
        expect.any(String),
        'art-001'
      );
    });

    it('skips loadCode gracefully when codeViewer module is null', () => {
      controller.modules.codeViewer = null;

      normalizeArtifactStreamPayload.mockReturnValueOnce(
        makeNormalized({ content: 'x' })
      );
      service.handleStream(makeRawData());

      normalizeArtifactStreamPayload.mockReturnValueOnce(
        makeNormalized({ content: 'y' })
      );
      // Should not throw
      expect(() => service.handleStream(makeRawData())).not.toThrow();
    });

    it('does not call switchTab on subsequent chunks', () => {
      normalizeArtifactStreamPayload.mockReturnValueOnce(
        makeNormalized({ content: 'x' })
      );
      service.handleStream(makeRawData());
      controller.switchTab.mockClear();

      normalizeArtifactStreamPayload.mockReturnValueOnce(
        makeNormalized({ content: 'y' })
      );
      service.handleStream(makeRawData());

      // switchTab should NOT be called again for subsequent chunks
      expect(controller.switchTab).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // handleStream — computer:output routing
  // ─────────────────────────────────────────────────────────────────────

  describe('handleStream — computer:output routing', () => {
    function setupComputerOutput(overrides = {}) {
      const normalized = makeNormalized({
        role: 'computer',
        type: 'output',
        format: 'text',
        language: null,
        content: 'execution output',
        ...overrides,
      });
      normalizeArtifactStreamPayload.mockReturnValue(normalized);
      getArtifactVariantKey.mockReturnValue('computer:output');
      return normalized;
    }

    it('first chunk: switches to output tab and loads artifact with forceOutput', () => {
      setupComputerOutput();
      service.handleStream(makeRawData({ type: 'output' }));

      expect(controller.switchTab).toHaveBeenCalledWith('output');
      expect(controller.loadArtifact).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'computer', type: 'output' }),
        {
          autoSwitch: false,
          forceAutoSwitch: false,
          forceOutput: true,
          origin: 'stream-execution',
        }
      );
    });

    it('subsequent chunks: calls loadOutput on outputViewer', () => {
      setupComputerOutput({ content: 'line1\n' });
      service.handleStream(makeRawData({ type: 'output' }));

      setupComputerOutput({ content: 'line2\n' });
      service.handleStream(makeRawData({ type: 'output' }));

      expect(controller.modules.outputViewer.loadOutput).toHaveBeenCalledWith(
        'line1\nline2\n',
        'text',
        'art-001'
      );
    });

    it('routes computer:console type to output viewer', () => {
      const normalized = makeNormalized({
        role: 'computer',
        type: 'console',
        format: 'text',
        content: 'log line',
      });
      normalizeArtifactStreamPayload.mockReturnValue(normalized);
      getArtifactVariantKey.mockReturnValue('computer:console');

      service.handleStream(makeRawData({ type: 'console' }));

      expect(controller.switchTab).toHaveBeenCalledWith('output');
    });

    it('routes computer:html type to output viewer', () => {
      const normalized = makeNormalized({
        role: 'computer',
        type: 'html',
        format: 'html',
        content: '<div>hello</div>',
      });
      normalizeArtifactStreamPayload.mockReturnValue(normalized);
      getArtifactVariantKey.mockReturnValue('computer:html');

      service.handleStream(makeRawData({ type: 'html' }));

      expect(controller.switchTab).toHaveBeenCalledWith('output');
    });

    it('skips display for assistant-only notifications (recipient: "assistant")', () => {
      setupComputerOutput({ recipient: 'assistant', content: 'internal feedback' });
      service.handleStream(makeRawData({ type: 'output' }));

      // Content is still accumulated
      const artifact = controller.artifactCache.get('art-001');
      expect(artifact.content).toBe('internal feedback');
      expect(artifact.chunkCount).toBe(1);

      // But display is skipped
      expect(controller.switchTab).not.toHaveBeenCalled();
      expect(controller.loadArtifact).not.toHaveBeenCalled();
    });

    it('logs debug when skipping assistant-only notification', () => {
      setupComputerOutput({ recipient: 'assistant' });
      service.handleStream(makeRawData({ type: 'output' }));

      expect(logger.debug).toHaveBeenCalledWith(
        '[ArtifactStreamService] Skipping assistant-only notification from UI',
        expect.objectContaining({
          artifactId: 'art-001',
          recipient: 'assistant',
        })
      );
    });

    it('displays normally when recipient is null (user-facing)', () => {
      setupComputerOutput({ recipient: null });
      service.handleStream(makeRawData({ type: 'output' }));

      expect(controller.switchTab).toHaveBeenCalledWith('output');
      expect(controller.loadArtifact).toHaveBeenCalled();
    });

    it('skips loadOutput gracefully when outputViewer module is null', () => {
      controller.modules.outputViewer = null;

      setupComputerOutput({ content: 'chunk1' });
      service.handleStream(makeRawData({ type: 'output' }));

      setupComputerOutput({ content: 'chunk2' });
      expect(() => service.handleStream(makeRawData({ type: 'output' }))).not.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // handleStream — HTML render-through
  // ─────────────────────────────────────────────────────────────────────

  describe('handleStream — HTML render-through', () => {
    const HTML_SOURCE = '<!DOCTYPE html><html><head><title>Test</title></head><body><h1>Hello</h1></body></html>';

    function seedHtmlCodeArtifact(executionGroup = 'exec-group-001') {
      controller.artifactCache.set('code-html-001', {
        id: 'code-html-001',
        artifactId: 'code-html-001',
        request_id: 'req-001',
        executionGroup,
        role: 'assistant',
        type: 'code',
        format: 'html',
        language: 'html',
        content: HTML_SOURCE,
        chatId: 'chat-001',
        chunkCount: 5,
        variantKey: 'assistant:code',
      });
    }

    function setupHtmlExecutionStatus(overrides = {}) {
      const normalized = makeNormalized({
        id: 'output-html-001',
        artifact_id: 'output-html-001',
        artifactId: 'output-html-001',
        role: 'computer',
        type: 'output',
        format: 'console',
        language: null,
        content: '[HTML executed successfully]',
        ...overrides,
      });
      normalizeArtifactStreamPayload.mockReturnValue(normalized);
      getArtifactVariantKey.mockReturnValue('computer:output');
      return normalized;
    }

    it('renders HTML code artifact content in output viewer when status message arrives', () => {
      seedHtmlCodeArtifact();
      setupHtmlExecutionStatus();
      service.handleStream(makeRawData({ type: 'console' }));

      expect(controller.switchTab).toHaveBeenCalledWith('output');
      expect(controller.modules.outputViewer.loadOutput).toHaveBeenCalledWith(
        HTML_SOURCE,
        'html',
        'output-html-001'
      );
    });

    it('sets controller.hasContent and currentArtifact on render-through', () => {
      seedHtmlCodeArtifact();
      setupHtmlExecutionStatus();
      service.handleStream(makeRawData({ type: 'console' }));

      expect(controller.hasContent).toBe(true);
      expect(controller.currentArtifact).toBeDefined();
      expect(controller.currentArtifact.content).toBe('[HTML executed successfully]');
    });

    it('does NOT call loadArtifact for HTML render-through (preserves cache)', () => {
      seedHtmlCodeArtifact();
      setupHtmlExecutionStatus();
      service.handleStream(makeRawData({ type: 'console' }));

      expect(controller.loadArtifact).not.toHaveBeenCalled();
    });

    it('falls back to loadArtifact when no matching HTML code artifact exists', () => {
      // No code artifact seeded in cache
      setupHtmlExecutionStatus();
      service.handleStream(makeRawData({ type: 'console' }));

      // Falls through to normal loadArtifact path
      expect(controller.loadArtifact).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'computer', type: 'output' }),
        expect.objectContaining({ forceOutput: true, origin: 'stream-execution' })
      );
    });

    it('falls back when execution groups do not match', () => {
      seedHtmlCodeArtifact('different-exec-group');
      setupHtmlExecutionStatus(); // default exec-group-001
      service.handleStream(makeRawData({ type: 'console' }));

      expect(controller.loadArtifact).toHaveBeenCalled();
      expect(controller.modules.outputViewer.loadOutput).not.toHaveBeenCalled();
    });

    it('falls back when code artifact has empty content', () => {
      controller.artifactCache.set('code-html-001', {
        id: 'code-html-001',
        artifactId: 'code-html-001',
        request_id: 'req-001',
        executionGroup: 'exec-group-001',
        role: 'assistant',
        type: 'code',
        format: 'html',
        language: 'html',
        content: '   ',
        chatId: 'chat-001',
        chunkCount: 0,
        variantKey: 'assistant:code',
      });

      setupHtmlExecutionStatus();
      service.handleStream(makeRawData({ type: 'console' }));

      expect(controller.loadArtifact).toHaveBeenCalled();
    });

    it('does NOT trigger render-through for non-HTML status content', () => {
      seedHtmlCodeArtifact();
      const normalized = makeNormalized({
        id: 'output-py-001',
        artifact_id: 'output-py-001',
        artifactId: 'output-py-001',
        role: 'computer',
        type: 'output',
        format: 'text',
        content: 'Hello from Python',
      });
      normalizeArtifactStreamPayload.mockReturnValue(normalized);
      getArtifactVariantKey.mockReturnValue('computer:output');
      service.handleStream(makeRawData({ type: 'output' }));

      // Normal loadArtifact path, NOT render-through
      expect(controller.loadArtifact).toHaveBeenCalled();
      expect(controller.modules.outputViewer.loadOutput).not.toHaveBeenCalled();
    });

    it('matches code artifact by language=html when format differs', () => {
      controller.artifactCache.set('code-html-001', {
        id: 'code-html-001',
        artifactId: 'code-html-001',
        request_id: 'req-001',
        executionGroup: 'exec-group-001',
        role: 'assistant',
        type: 'code',
        format: 'htm',
        language: 'html',
        content: '<p>Test</p>',
        chatId: 'chat-001',
        chunkCount: 1,
        variantKey: 'assistant:code',
      });

      setupHtmlExecutionStatus();
      service.handleStream(makeRawData({ type: 'console' }));

      expect(controller.modules.outputViewer.loadOutput).toHaveBeenCalledWith(
        '<p>Test</p>',
        'html',
        'output-html-001'
      );
    });

    it('handles null outputViewer gracefully during render-through', () => {
      seedHtmlCodeArtifact();
      controller.modules.outputViewer = null;
      setupHtmlExecutionStatus();

      expect(() => service.handleStream(makeRawData({ type: 'console' }))).not.toThrow();
      expect(controller.switchTab).toHaveBeenCalledWith('output');
    });

    it('logs warning when executionGroup is missing on output artifact', () => {
      seedHtmlCodeArtifact();
      setupHtmlExecutionStatus({ executionGroup: null });

      // executionGroup null causes CONTRACT VIOLATION in _createArtifactRecord
      // which throws before reaching render-through. Seed the artifact directly.
      const outputId = 'output-no-eg';
      controller.artifactCache.set(outputId, {
        id: outputId,
        artifactId: outputId,
        request_id: 'req-001',
        executionGroup: null,
        role: 'computer',
        type: 'output',
        content: '[HTML executed successfully]',
        chunkCount: 1,
      });

      const result = service._resolveHtmlRenderContent(controller, controller.artifactCache.get(outputId));
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        '[ArtifactStreamService] HTML status without executionGroup — cannot resolve code artifact',
        expect.objectContaining({ artifactId: outputId })
      );
    });

    it('logs info when HTML code artifact is resolved successfully', () => {
      seedHtmlCodeArtifact();
      const outputArtifact = {
        id: 'output-html-001',
        executionGroup: 'exec-group-001',
        content: '[HTML executed successfully]',
      };

      const result = service._resolveHtmlRenderContent(controller, outputArtifact);
      expect(result).toBe(HTML_SOURCE);
      expect(logger.info).toHaveBeenCalledWith(
        '[ArtifactStreamService] HTML render-through: resolved code artifact for Output tab',
        expect.objectContaining({
          codeArtifactId: 'code-html-001',
          outputArtifactId: 'output-html-001',
          executionGroup: 'exec-group-001',
          htmlLength: HTML_SOURCE.length,
        })
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // _resolveHtmlRenderContent (direct method tests)
  // ─────────────────────────────────────────────────────────────────────

  describe('_resolveHtmlRenderContent', () => {
    it('returns null for non-status content', () => {
      const artifact = { content: 'some output', executionGroup: 'eg-1' };
      expect(service._resolveHtmlRenderContent(controller, artifact)).toBeNull();
    });

    it('returns null for content with extra whitespace around status', () => {
      const artifact = { content: '  [HTML executed successfully]  ', executionGroup: 'eg-1' };
      // .trim() matches — this SHOULD resolve if code artifact exists
      controller.artifactCache.set('code-1', {
        role: 'assistant',
        type: 'code',
        format: 'html',
        executionGroup: 'eg-1',
        content: '<p>padded</p>',
      });
      expect(service._resolveHtmlRenderContent(controller, artifact)).toBe('<p>padded</p>');
    });

    it('returns null when executionGroup is undefined', () => {
      const artifact = { content: '[HTML executed successfully]', id: 'x' };
      expect(service._resolveHtmlRenderContent(controller, artifact)).toBeNull();
    });

    it('returns null when no artifacts match the criteria', () => {
      controller.artifactCache.set('code-py', {
        role: 'assistant',
        type: 'code',
        format: 'python',
        executionGroup: 'eg-1',
        content: 'print(1)',
      });
      const artifact = { content: '[HTML executed successfully]', executionGroup: 'eg-1', id: 'y' };
      expect(service._resolveHtmlRenderContent(controller, artifact)).toBeNull();
    });

    it('ignores computer:code:html artifacts (only matches assistant)', () => {
      controller.artifactCache.set('echo-html', {
        role: 'computer',
        type: 'code',
        format: 'html',
        executionGroup: 'eg-1',
        content: '<div>echo</div>',
      });
      const artifact = { content: '[HTML executed successfully]', executionGroup: 'eg-1', id: 'z' };
      expect(service._resolveHtmlRenderContent(controller, artifact)).toBeNull();
    });

    it('ignores assistant:output:html artifacts (only matches type=code)', () => {
      controller.artifactCache.set('output-html', {
        role: 'assistant',
        type: 'output',
        format: 'html',
        executionGroup: 'eg-1',
        content: '<div>not code</div>',
      });
      const artifact = { content: '[HTML executed successfully]', executionGroup: 'eg-1', id: 'w' };
      expect(service._resolveHtmlRenderContent(controller, artifact)).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // handleStream — backend index tracking
  // ─────────────────────────────────────────────────────────────────────

  describe('handleStream — backend index tracking', () => {
    it('calls artifactIndexService.track on every processed chunk', () => {
      service.handleStream(makeRawData());

      expect(controller.artifactIndexService.track).toHaveBeenCalledWith(
        'req-001',
        'assistant:code',
        'art-001'
      );
    });

    it('calls track even for end-only markers (no content)', () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ content: null, end: true })
      );

      service.handleStream(makeRawData());

      expect(controller.artifactIndexService.track).toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // handleStream — log throttling
  // ─────────────────────────────────────────────────────────────────────

  describe('handleStream — log throttling', () => {
    it('initializes throttle on first encounter of artifactId', () => {
      expect(service._logThrottle.has('art-001')).toBe(false);

      service.handleStream(makeRawData());

      expect(service._logThrottle.has('art-001')).toBe(true);
      const throttle = service._logThrottle.get('art-001');
      expect(typeof throttle.lastLog).toBe('number');
      expect(typeof throttle.chunkCount).toBe('number');
    });

    it('does NOT log trace when within 1 second throttle window', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date(1700000000000));

      // First chunk: triggers trace because lastLog starts at 0 (delta is huge)
      service.handleStream(makeRawData());
      logger.trace.mockClear(); // Clear trace from initial chunk

      // Advance 500ms — within 1s throttle window from first chunk
      jest.setSystemTime(new Date(1700000000500));
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ content: 'chunk2' })
      );
      service.handleStream(makeRawData());

      expect(logger.trace).not.toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('logs trace when more than 1 second has elapsed', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date(1700000000000));

      service.handleStream(makeRawData());

      // Advance 1001ms — past throttle window
      jest.setSystemTime(new Date(1700000001001));
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ content: 'chunk2' })
      );
      service.handleStream(makeRawData());

      expect(logger.trace).toHaveBeenCalledWith(
        '[ArtifactStreamService] Streaming progress',
        expect.objectContaining({
          artifactId: 'art-001',
          chunks: 2,
          characters: expect.any(Number),
        })
      );

      jest.useRealTimers();
    });

    it('updates lastLog timestamp after logging', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date(1700000000000));

      service.handleStream(makeRawData());

      jest.setSystemTime(new Date(1700000002000));
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ content: 'chunk2' })
      );
      service.handleStream(makeRawData());

      const throttle = service._logThrottle.get('art-001');
      expect(throttle.lastLog).toBe(1700000002000);

      jest.useRealTimers();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // handleStream — END marker: finalization
  // ─────────────────────────────────────────────────────────────────────

  describe('handleStream — END marker: finalization', () => {
    function sendEndMarker(overrides = {}) {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ end: true, content: 'final', ...overrides })
      );
      service.handleStream(makeRawData());
    }

    it('cleans up _logThrottle entry on END', () => {
      // First chunk creates throttle entry
      service.handleStream(makeRawData());
      expect(service._logThrottle.has('art-001')).toBe(true);

      // End marker removes it
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ end: true, content: 'end' })
      );
      service.handleStream(makeRawData());

      expect(service._logThrottle.has('art-001')).toBe(false);
    });

    it('marks artifact as finalized and end=true', () => {
      sendEndMarker();

      const artifact = controller.artifactCache.get('art-001');
      expect(artifact.finalized).toBe(true);
      expect(artifact.end).toBe(true);
    });

    it('adds a COPY of the artifact to sessionStore', () => {
      sendEndMarker();

      expect(controller.sessionStore.addArtifact).toHaveBeenCalledTimes(1);
      const addedArtifact = controller.sessionStore.addArtifact.mock.calls[0][0];
      const cachedArtifact = controller.artifactCache.get('art-001');

      // Should be a copy (different reference)
      expect(addedArtifact).not.toBe(cachedArtifact);
      // But same content
      expect(addedArtifact.id).toBe(cachedArtifact.id);
      expect(addedArtifact.content).toBe(cachedArtifact.content);
    });

    it('handles null sessionStore gracefully', () => {
      controller.sessionStore = null;

      expect(() => sendEndMarker()).not.toThrow();
    });

    it('logs stream completion details', () => {
      sendEndMarker();

      expect(logger.debug).toHaveBeenCalledWith(
        '[ArtifactStreamService] Stream complete',
        expect.objectContaining({
          artifactId: 'art-001',
          role: 'assistant',
          type: 'code',
          variantKey: 'assistant:code',
        })
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // handleStream — END marker: ARTIFACT_FINALIZED event
  // ─────────────────────────────────────────────────────────────────────

  describe('handleStream — END marker: ARTIFACT_FINALIZED event', () => {
    it('emits ARTIFACT_FINALIZED for assistant:code (non-console) artifacts', () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ end: true, content: 'code', role: 'assistant', type: 'code' })
      );

      service.handleStream(makeRawData({ type: 'code' }));

      expect(eventBus.emit).toHaveBeenCalledWith(
        'artifacts:artifact:finalized',
        expect.objectContaining({
          chatId: 'chat-001',
          variantKey: 'assistant:code',
          artifact: expect.objectContaining({ id: 'art-001' }),
        })
      );
    });

    it('emits ARTIFACT_FINALIZED for computer:output (non-console) artifacts', () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({
          end: true, content: 'result', role: 'computer', type: 'output', format: 'text',
        })
      );
      getArtifactVariantKey.mockReturnValue('computer:output');

      service.handleStream(makeRawData({ type: 'output' }));

      expect(eventBus.emit).toHaveBeenCalledWith(
        'artifacts:artifact:finalized',
        expect.objectContaining({
          chatId: 'chat-001',
          variantKey: 'computer:output',
        })
      );
    });

    it('does NOT emit ARTIFACT_FINALIZED for console artifacts', () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({
          end: true, content: 'log line', role: 'computer', type: 'console', format: 'text',
        })
      );
      getArtifactVariantKey.mockReturnValue('computer:console');

      // rawType = 'console' from rawData.type
      service.handleStream(makeRawData({ type: 'console' }));

      // STREAM_RECEIVED is emitted (always), but ARTIFACT_FINALIZED should NOT be
      const finalizeCalls = eventBus.emit.mock.calls.filter(
        c => c[0] === 'artifacts:artifact:finalized'
      );
      expect(finalizeCalls).toHaveLength(0);
    });

    it('does NOT emit ARTIFACT_FINALIZED for computer:code type (not in shouldNotifyFiles)', () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({
          end: true, content: 'code', role: 'computer', type: 'code',
        })
      );
      getArtifactVariantKey.mockReturnValue('computer:code');

      service.handleStream(makeRawData({ type: 'code' }));

      const finalizeCalls = eventBus.emit.mock.calls.filter(
        c => c[0] === 'artifacts:artifact:finalized'
      );
      expect(finalizeCalls).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // handleStream — END marker: persistence
  // ─────────────────────────────────────────────────────────────────────

  describe('handleStream — END marker: persistence', () => {
    it('calls persistArtifact for assistant:code on END', async () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ end: true, content: 'x = 1' })
      );

      service.handleStream(makeRawData());
      await flushPromises();

      expect(controller.persistArtifact).toHaveBeenCalledTimes(1);
    });

    it('calls persistArtifact for computer:output on END', async () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({
          end: true, content: 'output', role: 'computer', type: 'output', format: 'text',
          node_id: 'n1', subgroup_id: 's1',
        })
      );
      getArtifactVariantKey.mockReturnValue('computer:output');

      service.handleStream(makeRawData({ type: 'output' }));
      await flushPromises();

      expect(controller.persistArtifact).toHaveBeenCalledTimes(1);
    });

    it('does NOT persist console artifacts', async () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({
          end: true, content: 'log', role: 'computer', type: 'console', format: 'text',
        })
      );
      getArtifactVariantKey.mockReturnValue('computer:console');

      service.handleStream(makeRawData({ type: 'console' }));
      await flushPromises();

      expect(controller.persistArtifact).not.toHaveBeenCalled();
    });

    it('logs debug when skipping console artifact persistence', () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({
          end: true, content: 'log', role: 'computer', type: 'console', format: 'text',
        })
      );
      getArtifactVariantKey.mockReturnValue('computer:console');

      service.handleStream(makeRawData({ type: 'console' }));

      expect(logger.debug).toHaveBeenCalledWith(
        '[ArtifactStreamService] Skipping console artifact persistence',
        expect.objectContaining({
          artifactId: 'art-001',
          rawType: 'console',
        })
      );
    });

    it('does NOT persist same artifact twice (idempotency)', async () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ end: true, content: 'x' })
      );

      // First END
      service.handleStream(makeRawData());
      await flushPromises();

      // Second END for same artifact
      service.handleStream(makeRawData());
      await flushPromises();

      expect(controller.persistArtifact).toHaveBeenCalledTimes(1);
    });

    it('tracks persisted artifact in _persistedArtifacts Map', async () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ end: true, content: 'x' })
      );

      service.handleStream(makeRawData());
      await flushPromises();

      expect(service._persistedArtifacts.has('art-001')).toBe(true);
    });

    it('removes from _persistedArtifacts on failure (allows retry)', async () => {
      controller.persistArtifact.mockRejectedValue(new Error('DB down'));
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ end: true, content: 'x' })
      );

      service.handleStream(makeRawData());
      await flushPromises();

      expect(service._persistedArtifacts.has('art-001')).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        '[ArtifactStreamService] Persistence failed',
        expect.objectContaining({ artifactId: 'art-001' })
      );
    });

    it('retries persistence after a prior failure', async () => {
      // First attempt: failure
      controller.persistArtifact.mockRejectedValueOnce(new Error('DB down'));
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ end: true, content: 'x' })
      );

      service.handleStream(makeRawData());
      await flushPromises();

      expect(service._persistedArtifacts.has('art-001')).toBe(false);

      // Second attempt: success
      controller.persistArtifact.mockResolvedValueOnce({ id: 'persisted-001' });
      service.handleStream(makeRawData());
      await flushPromises();

      expect(controller.persistArtifact).toHaveBeenCalledTimes(2);
      expect(service._persistedArtifacts.has('art-001')).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // handleStream — error propagation
  // ─────────────────────────────────────────────────────────────────────

  describe('handleStream — error propagation', () => {
    it('propagates errors from normalization (fail-fast)', () => {
      normalizeArtifactStreamPayload.mockImplementation(() => {
        throw new Error('NORMALIZATION_ERROR');
      });

      expect(() => service.handleStream(makeRawData())).toThrow('NORMALIZATION_ERROR');
      expect(logger.error).toHaveBeenCalledWith(
        '[ArtifactStreamService] Stream pipeline error',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });

    it('propagates contract violation from _createArtifactRecord', () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ executionGroup: null })
      );

      expect(() => service.handleStream(makeRawData()))
        .toThrow('CONTRACT VIOLATION: executionGroup is required');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // _createArtifactRecord
  // ─────────────────────────────────────────────────────────────────────

  describe('_createArtifactRecord', () => {
    it('throws if executionGroup is null', () => {
      const normalized = makeNormalized({ executionGroup: null });
      expect(() =>
        service._createArtifactRecord(normalized, 'req-001', 'art-001', 'assistant:code', 'code')
      ).toThrow('CONTRACT VIOLATION: executionGroup is required. artifactId=art-001, requestId=req-001');
    });

    it('throws if executionGroup is empty string', () => {
      const normalized = makeNormalized({ executionGroup: '' });
      expect(() =>
        service._createArtifactRecord(normalized, 'req-001', 'art-001', 'assistant:code', 'code')
      ).toThrow('CONTRACT VIOLATION: executionGroup is required');
    });

    it('throws if executionGroup is a number', () => {
      const normalized = makeNormalized({ executionGroup: 99 });
      expect(() =>
        service._createArtifactRecord(normalized, 'req-001', 'art-001', 'assistant:code', 'code')
      ).toThrow('CONTRACT VIOLATION: executionGroup is required');
    });

    it('returns artifact with empty content and zero chunkCount', () => {
      const normalized = makeNormalized();
      const record = service._createArtifactRecord(normalized, 'req-001', 'art-001', 'assistant:code', 'code');

      expect(record.content).toBe('');
      expect(record.chunkCount).toBe(0);
    });

    it('maps all normalized fields correctly', () => {
      const normalized = makeNormalized({
        role: 'computer',
        type: 'output',
        format: 'text',
        language: null,
        chatId: 'chat-xyz',
        messageId: 'msg-xyz',
        parentId: 'parent-xyz',
        correlationId: 'corr-xyz',
        timestamp: 9999999,
      });
      const record = service._createArtifactRecord(normalized, 'req-002', 'art-002', 'computer:output', 'output');

      expect(record.id).toBe('art-001'); // From normalized.artifact_id
      expect(record.request_id).toBe('req-002');
      expect(record.artifactId).toBe('art-001');
      expect(record.role).toBe('computer');
      expect(record.type).toBe('output');
      expect(record.format).toBe('text');
      expect(record.language).toBeNull();
      expect(record.chatId).toBe('chat-xyz');
      expect(record.messageId).toBe('msg-xyz');
      expect(record.parentId).toBe('parent-xyz');
      expect(record.correlationId).toBe('corr-xyz');
      expect(record.timestamp).toBe(9999999);
      expect(record.variantKey).toBe('computer:output');
    });

    it('preserves rawType when provided', () => {
      const normalized = makeNormalized({ type: 'output' });
      const record = service._createArtifactRecord(normalized, 'req-001', 'art-001', 'computer:output', 'console');

      expect(record.rawType).toBe('console');
      expect(record.metadata.raw_type).toBe('console');
    });

    it('falls back to normalized.type when rawType is null', () => {
      const normalized = makeNormalized({ type: 'code' });
      const record = service._createArtifactRecord(normalized, 'req-001', 'art-001', 'assistant:code', null);

      expect(record.rawType).toBe('code');
      expect(record.metadata.raw_type).toBe('code');
    });

    it('sets node_id from normalized payload when present', () => {
      const normalized = makeNormalized({ node_id: 'node-abc' });
      const record = service._createArtifactRecord(normalized, 'req-001', 'art-001', 'assistant:code', 'code');

      expect(record.node_id).toBe('node-abc');
    });

    it('sets node_id to null when not in normalized payload', () => {
      const normalized = makeNormalized();
      delete normalized.node_id;
      const record = service._createArtifactRecord(normalized, 'req-001', 'art-001', 'assistant:code', 'code');

      expect(record.node_id).toBeNull();
    });

    it('sets subgroup_id from normalized payload when present', () => {
      const normalized = makeNormalized({ subgroup_id: 'sub-abc' });
      const record = service._createArtifactRecord(normalized, 'req-001', 'art-001', 'assistant:code', 'code');

      expect(record.subgroup_id).toBe('sub-abc');
    });

    it('sets subgroup_id to null when not in normalized payload', () => {
      const normalized = makeNormalized();
      delete normalized.subgroup_id;
      const record = service._createArtifactRecord(normalized, 'req-001', 'art-001', 'assistant:code', 'code');

      expect(record.subgroup_id).toBeNull();
    });

    it('builds metadata with canonical ids and variant_key', () => {
      const normalized = makeNormalized();
      const record = service._createArtifactRecord(normalized, 'req-001', 'art-001', 'assistant:code', 'code');

      expect(record.metadata).toEqual(expect.objectContaining({
        request_id: 'req-001',
        frontend_id: 'art-001',
        artifact_id: 'art-001',
        variant_key: 'assistant:code',
        raw_type: 'code',
      }));
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // _generateFilename
  // ─────────────────────────────────────────────────────────────────────

  describe('_generateFilename', () => {
    it('assistant:code → code.{format}', () => {
      expect(service._generateFilename({ role: 'assistant', type: 'code', format: 'python' }))
        .toBe('code.python');
    });

    it('assistant:code with language fallback → code.{language}', () => {
      expect(service._generateFilename({ role: 'assistant', type: 'code', language: 'javascript' }))
        .toBe('code.javascript');
    });

    it('computer:console → console.log', () => {
      expect(service._generateFilename({ role: 'computer', type: 'console', format: 'text' }))
        .toBe('console.log');
    });

    it('computer:output → output.{format}', () => {
      expect(service._generateFilename({ role: 'computer', type: 'output', format: 'text' }))
        .toBe('output.text');
    });

    it('html type → output.html', () => {
      expect(service._generateFilename({ role: 'computer', type: 'html', format: 'html' }))
        .toBe('output.html');
    });

    it('fallback for unknown role/type → {type}.{format}', () => {
      expect(service._generateFilename({ role: 'agent', type: 'json', format: 'json' }))
        .toBe('json.json');
    });

    it('defaults format to language when format is missing', () => {
      expect(service._generateFilename({ role: 'assistant', type: 'code', language: 'rust' }))
        .toBe('code.rust');
    });

    it('defaults format to txt when both format and language are missing', () => {
      expect(service._generateFilename({ role: 'assistant', type: 'code' }))
        .toBe('code.txt');
    });

    it('defaults role to artifact when role is missing', () => {
      expect(service._generateFilename({ type: 'code', format: 'py' }))
        .toBe('code.py');
    });

    it('defaults type to output when type is missing', () => {
      expect(service._generateFilename({ role: 'computer', format: 'text' }))
        .toBe('output.text');
    });

    it('handles case-insensitive role/type matching', () => {
      expect(service._generateFilename({ role: 'ASSISTANT', type: 'CODE', format: 'py' }))
        .toBe('code.py');
      expect(service._generateFilename({ role: 'Computer', type: 'Console', format: 'text' }))
        .toBe('console.log');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // _persistArtifact
  // ─────────────────────────────────────────────────────────────────────

  describe('_persistArtifact', () => {
    it('returns early if artifact is null', async () => {
      const result = await service._persistArtifact(controller, null);
      expect(result).toBeUndefined();
      expect(controller.persistArtifact).not.toHaveBeenCalled();
    });

    it('returns early if artifact.chatId is missing', async () => {
      const artifact = makeArtifact({ chatId: null });
      const result = await service._persistArtifact(controller, artifact);
      expect(result).toBeUndefined();
      expect(controller.persistArtifact).not.toHaveBeenCalled();
    });

    it('returns early if artifact.chatId is empty string', async () => {
      const artifact = makeArtifact({ chatId: '' });
      const result = await service._persistArtifact(controller, artifact);
      expect(result).toBeUndefined();
    });

    it('returns early if controller is null', async () => {
      const artifact = makeArtifact();
      const result = await service._persistArtifact(null, artifact);
      expect(result).toBeUndefined();
    });

    it('returns early if controller.persistArtifact is not a function', async () => {
      const artifact = makeArtifact();
      const badController = { persistArtifact: 'not-a-function' };
      const result = await service._persistArtifact(badController, artifact);
      expect(result).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        '[ArtifactStreamService] Controller.persistArtifact not available'
      );
    });

    it('returns null if content exceeds MAX_ARTIFACT_SIZE', async () => {
      const bigContent = 'x'.repeat(MAX_ARTIFACT_SIZE + 1);
      const artifact = makeArtifact({ content: bigContent });
      const result = await service._persistArtifact(controller, artifact);
      expect(result).toBeNull();
      expect(controller.persistArtifact).not.toHaveBeenCalled();
    });

    it('allows content exactly at MAX_ARTIFACT_SIZE', async () => {
      const exactContent = 'x'.repeat(MAX_ARTIFACT_SIZE);
      const artifact = makeArtifact({ content: exactContent });
      await service._persistArtifact(controller, artifact);
      expect(controller.persistArtifact).toHaveBeenCalled();
    });

    it('throws for output artifact missing node_id', async () => {
      const artifact = makeArtifact({
        type: 'output', role: 'computer', node_id: null, subgroup_id: 'sub-001',
      });
      await expect(service._persistArtifact(controller, artifact))
        .rejects.toThrow('CONTRACT VIOLATION: Refusing to persist output artifact without trail linkage');
    });

    it('throws for output artifact missing subgroup_id', async () => {
      const artifact = makeArtifact({
        type: 'output', role: 'computer', node_id: 'node-001', subgroup_id: null,
      });
      await expect(service._persistArtifact(controller, artifact))
        .rejects.toThrow('CONTRACT VIOLATION: Refusing to persist output artifact without trail linkage');
    });

    it('throws for output artifact missing both trail fields', async () => {
      const artifact = makeArtifact({
        type: 'output', role: 'computer', node_id: null, subgroup_id: null,
      });
      await expect(service._persistArtifact(controller, artifact))
        .rejects.toThrow('hasNodeId=false, hasSubgroupId=false');
    });

    it('does NOT throw trail linkage for code artifacts (only output requires it)', async () => {
      const artifact = makeArtifact({
        type: 'code', role: 'assistant', node_id: null, subgroup_id: null,
      });
      await service._persistArtifact(controller, artifact);
      expect(controller.persistArtifact).toHaveBeenCalled();
    });

    it('sanitizes empty string content to null', async () => {
      const artifact = makeArtifact({ content: '' });
      await service._persistArtifact(controller, artifact);

      const payload = controller.persistArtifact.mock.calls[0][0];
      expect(payload.content).toBeNull();
    });

    it('sanitizes whitespace-only content to null', async () => {
      const artifact = makeArtifact({ content: '   \n\t  ' });
      await service._persistArtifact(controller, artifact);

      const payload = controller.persistArtifact.mock.calls[0][0];
      expect(payload.content).toBeNull();
    });

    it('preserves non-empty content as-is', async () => {
      const artifact = makeArtifact({ content: 'x = 1' });
      await service._persistArtifact(controller, artifact);

      const payload = controller.persistArtifact.mock.calls[0][0];
      expect(payload.content).toBe('x = 1');
    });

    it('throws if filename is missing', async () => {
      const artifact = makeArtifact({ filename: null });
      await expect(service._persistArtifact(controller, artifact))
        .rejects.toThrow('CONTRACT VIOLATION: artifact.filename is required');
    });

    it('throws if filename is empty string', async () => {
      const artifact = makeArtifact({ filename: '' });
      await expect(service._persistArtifact(controller, artifact))
        .rejects.toThrow('CONTRACT VIOLATION: artifact.filename is required');
    });

    it('throws if artifactId is missing', async () => {
      const artifact = makeArtifact({ artifactId: null });
      await expect(service._persistArtifact(controller, artifact))
        .rejects.toThrow('CONTRACT VIOLATION: artifact.artifactId is required');
    });

    it('throws if artifactId is empty string', async () => {
      const artifact = makeArtifact({ artifactId: '' });
      await expect(service._persistArtifact(controller, artifact))
        .rejects.toThrow('CONTRACT VIOLATION: artifact.artifactId is required');
    });

    it('throws if both language and format are missing', async () => {
      const artifact = makeArtifact({ language: null, format: null });
      await expect(service._persistArtifact(controller, artifact))
        .rejects.toThrow('CONTRACT VIOLATION: artifact.language or format is required');
    });

    it('uses format as fallback when language is null', async () => {
      const artifact = makeArtifact({ language: null, format: 'html' });
      await service._persistArtifact(controller, artifact);

      const payload = controller.persistArtifact.mock.calls[0][0];
      expect(payload.language).toBe('html');
    });

    it('builds correct snake_case payload matching backend schema', async () => {
      const artifact = makeArtifact({
        type: 'code',
        filename: 'code.python',
        content: 'x = 1',
        language: 'python',
        format: 'python',
        artifactId: 'art-001',
        messageId: 'msg-001',
        chatId: 'chat-001',
        subgroup_id: null,
        node_id: null,
        executionGroup: 'exec-group-001',
        role: 'assistant',
        request_id: 'req-001',
        id: 'art-001',
        rawType: 'code',
        chunkCount: 5,
        timestamp: 1700000000000,
        metadata: { truncated: false },
      });

      await service._persistArtifact(controller, artifact);

      const payload = controller.persistArtifact.mock.calls[0][0];
      expect(payload).toEqual({
        type: 'code',
        filename: 'code.python',
        content: 'x = 1',
        language: 'python',
        artifact_id: 'art-001',
        message_id: 'msg-001',
        chat_id: 'chat-001',
        subgroup_id: null,
        node_id: null,
        execution_group: 'exec-group-001',
        metadata: {
          role: 'assistant',
          request_id: 'req-001',
          frontend_id: 'art-001',
          artifact_id: 'art-001',
          execution_group: 'exec-group-001',
          raw_type: 'code',
          format: 'python',
          chunk_count: 5,
          timestamp: 1700000000000,
          size_bytes: 5,
          truncated: false,
        },
      });
    });

    it('sets truncated from metadata.truncated when it is a boolean', async () => {
      const artifact = makeArtifact({ metadata: { truncated: true } });
      await service._persistArtifact(controller, artifact);

      const payload = controller.persistArtifact.mock.calls[0][0];
      expect(payload.metadata.truncated).toBe(true);
    });

    it('defaults truncated to false when metadata.truncated is not a boolean', async () => {
      const artifact = makeArtifact({ metadata: { truncated: 'yes' } });
      await service._persistArtifact(controller, artifact);

      const payload = controller.persistArtifact.mock.calls[0][0];
      expect(payload.metadata.truncated).toBe(false);
    });

    it('defaults truncated to false when metadata is null', async () => {
      const artifact = makeArtifact({ metadata: null });
      await service._persistArtifact(controller, artifact);

      const payload = controller.persistArtifact.mock.calls[0][0];
      expect(payload.metadata.truncated).toBe(false);
    });

    it('computes size_bytes from content string length', async () => {
      const artifact = makeArtifact({ content: '12345' });
      await service._persistArtifact(controller, artifact);

      const payload = controller.persistArtifact.mock.calls[0][0];
      expect(payload.metadata.size_bytes).toBe(5);
    });

    it('sets size_bytes to 0 when content is not a string', async () => {
      const artifact = makeArtifact({ content: null, filename: 'code.py' });
      await service._persistArtifact(controller, artifact);

      const payload = controller.persistArtifact.mock.calls[0][0];
      expect(payload.metadata.size_bytes).toBe(0);
    });

    it('returns result from controller.persistArtifact on success', async () => {
      controller.persistArtifact.mockResolvedValue({ id: 'db-001' });
      const artifact = makeArtifact();
      const result = await service._persistArtifact(controller, artifact);
      expect(result).toEqual({ id: 'db-001' });
    });

    it('logs success with artifact ID and chatId', async () => {
      controller.persistArtifact.mockResolvedValue({ id: 'db-001' });
      const artifact = makeArtifact();
      await service._persistArtifact(controller, artifact);

      expect(logger.debug).toHaveBeenCalledWith(
        '[ArtifactStreamService] Artifact persisted via controller',
        expect.objectContaining({ artifactId: 'db-001', chatId: 'chat-001' })
      );
    });

    it('propagates errors from controller.persistArtifact', async () => {
      controller.persistArtifact.mockRejectedValue(new Error('DB_ERROR'));
      const artifact = makeArtifact();

      await expect(service._persistArtifact(controller, artifact))
        .rejects.toThrow('DB_ERROR');
    });

    it('logs error before propagating persistence failure', async () => {
      controller.persistArtifact.mockRejectedValue(new Error('DB_ERROR'));
      const artifact = makeArtifact();

      await expect(service._persistArtifact(controller, artifact)).rejects.toThrow();

      expect(logger.error).toHaveBeenCalledWith(
        '[ArtifactStreamService] Backend persistence failed',
        expect.objectContaining({ artifactId: 'art-001' })
      );
    });

    it('preserves rawType in metadata.raw_type, falls back to type', async () => {
      const artifact = makeArtifact({
        rawType: 'console', type: 'output', node_id: 'n1', subgroup_id: 's1',
      });
      await service._persistArtifact(controller, artifact);

      const payload = controller.persistArtifact.mock.calls[0][0];
      expect(payload.metadata.raw_type).toBe('console');
    });

    it('falls back to artifact.type when rawType is falsy', async () => {
      const artifact = makeArtifact({ rawType: null, type: 'code' });
      await service._persistArtifact(controller, artifact);

      const payload = controller.persistArtifact.mock.calls[0][0];
      expect(payload.metadata.raw_type).toBe('code');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // _getRequestIdFromArtifact
  // ─────────────────────────────────────────────────────────────────────

  describe('_getRequestIdFromArtifact', () => {
    it('throws if artifact is null', () => {
      expect(() => service._getRequestIdFromArtifact(null))
        .toThrow('CONTRACT VIOLATION: artifact is required');
    });

    it('throws if artifact is undefined', () => {
      expect(() => service._getRequestIdFromArtifact(undefined))
        .toThrow('CONTRACT VIOLATION: artifact is required');
    });

    it('returns request_id from artifact.request_id', () => {
      expect(service._getRequestIdFromArtifact({ request_id: 'req-123' }))
        .toBe('req-123');
    });

    it('falls back to metadata.request_id', () => {
      expect(service._getRequestIdFromArtifact({
        request_id: null,
        metadata: { request_id: 'req-fallback' },
      })).toBe('req-fallback');
    });

    it('throws if request_id is missing from both locations', () => {
      expect(() => service._getRequestIdFromArtifact({ id: 'art-001' }))
        .toThrow('CONTRACT VIOLATION: artifact.request_id is required');
    });

    it('throws if request_id is a number (non-string)', () => {
      expect(() => service._getRequestIdFromArtifact({ request_id: 123 }))
        .toThrow('CONTRACT VIOLATION: artifact.request_id is required');
    });

    it('includes artifact id in error message for debugging', () => {
      expect(() => service._getRequestIdFromArtifact({ id: 'art-xyz' }))
        .toThrow('artifactId=art-xyz');
    });

    it('falls back to artifactId when id is missing in error message', () => {
      expect(() => service._getRequestIdFromArtifact({ artifactId: 'art-fallback' }))
        .toThrow('artifactId=art-fallback');
    });

    it('shows "unknown" when neither id nor artifactId exists', () => {
      expect(() => service._getRequestIdFromArtifact({}))
        .toThrow('artifactId=unknown');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // _artifactRole
  // ─────────────────────────────────────────────────────────────────────

  describe('_artifactRole', () => {
    it('throws if artifact is null', () => {
      expect(() => service._artifactRole(null))
        .toThrow('CONTRACT VIOLATION: artifact is required');
    });

    it('throws if artifact is undefined', () => {
      expect(() => service._artifactRole(undefined))
        .toThrow('CONTRACT VIOLATION: artifact is required');
    });

    it('returns lowercase role from artifact.role', () => {
      expect(service._artifactRole({ role: 'Assistant' })).toBe('assistant');
    });

    it('falls back to metadata.role', () => {
      expect(service._artifactRole({
        role: null,
        metadata: { role: 'Computer' },
      })).toBe('computer');
    });

    it('throws if role is missing from both locations', () => {
      expect(() => service._artifactRole({ id: 'art-001' }))
        .toThrow('CONTRACT VIOLATION: artifact.role is required');
    });

    it('throws if role is a number (non-string)', () => {
      expect(() => service._artifactRole({ role: 42 }))
        .toThrow('CONTRACT VIOLATION: artifact.role is required');
    });

    it('includes artifact id in error message', () => {
      expect(() => service._artifactRole({ id: 'art-xyz' }))
        .toThrow('artifactId=art-xyz');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // _trackBackendIndex
  // ─────────────────────────────────────────────────────────────────────

  describe('_trackBackendIndex', () => {
    it('delegates to artifactIndexService.track with correct args', () => {
      const artifact = makeArtifact({ request_id: 'req-abc', id: 'art-abc' });

      service._trackBackendIndex(controller, artifact, 'assistant:code');

      expect(controller.artifactIndexService.track).toHaveBeenCalledWith(
        'req-abc',
        'assistant:code',
        'art-abc'
      );
    });

    it('uses variantKeyOverride when provided', () => {
      const artifact = makeArtifact();
      getArtifactVariantKey.mockClear(); // Clear any prior calls from beforeEach setup

      service._trackBackendIndex(controller, artifact, 'custom:key');

      expect(controller.artifactIndexService.track).toHaveBeenCalledWith(
        'req-001',
        'custom:key',
        'art-001'
      );
      // getArtifactVariantKey should NOT be called when override is provided
      expect(getArtifactVariantKey).not.toHaveBeenCalled();
    });

    it('computes variantKey via getArtifactVariantKey when override is null', () => {
      const artifact = makeArtifact({ role: 'computer', type: 'output' });
      getArtifactVariantKey.mockReturnValue('computer:output');

      service._trackBackendIndex(controller, artifact, null);

      expect(getArtifactVariantKey).toHaveBeenCalledWith('computer', 'output');
      expect(controller.artifactIndexService.track).toHaveBeenCalledWith(
        'req-001',
        'computer:output',
        'art-001'
      );
    });

    it('throws if artifact has no request_id (delegates to _getRequestIdFromArtifact)', () => {
      const artifact = { id: 'art-bad', role: 'assistant', type: 'code' };

      expect(() => service._trackBackendIndex(controller, artifact, 'assistant:code'))
        .toThrow('CONTRACT VIOLATION: artifact.request_id is required');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Integration: full lifecycle (start → chunks → end)
  // ─────────────────────────────────────────────────────────────────────

  describe('integration: full stream lifecycle', () => {
    it('processes start → content chunks → end correctly', async () => {
      // START marker
      normalizeArtifactStreamPayload.mockReturnValueOnce(
        makeNormalized({ start: true, end: false, content: null })
      );
      service.handleStream(makeRawData());

      expect(controller.artifactCache.size).toBe(0); // Start-only skipped

      // Content chunk 1
      normalizeArtifactStreamPayload.mockReturnValueOnce(
        makeNormalized({ content: 'line1\n' })
      );
      service.handleStream(makeRawData({ content: 'line1\n' }));

      expect(controller.artifactCache.size).toBe(1);
      expect(controller.switchTab).toHaveBeenCalledWith('code');

      // Content chunk 2
      normalizeArtifactStreamPayload.mockReturnValueOnce(
        makeNormalized({ content: 'line2\n' })
      );
      service.handleStream(makeRawData({ content: 'line2\n' }));

      expect(controller.modules.codeViewer.loadCode).toHaveBeenCalled();

      // END marker
      normalizeArtifactStreamPayload.mockReturnValueOnce(
        makeNormalized({ end: true, content: 'line3' })
      );
      service.handleStream(makeRawData({ content: 'line3' }));
      await flushPromises();

      const artifact = controller.artifactCache.get('art-001');
      expect(artifact.finalized).toBe(true);
      expect(artifact.content).toBe('line1\nline2\nline3');
      expect(artifact.chunkCount).toBe(3);
      expect(controller.sessionStore.addArtifact).toHaveBeenCalledTimes(1);
      expect(controller.persistArtifact).toHaveBeenCalledTimes(1);
      expect(eventBus.emit).toHaveBeenCalledWith(
        'artifacts:artifact:finalized',
        expect.objectContaining({ artifact: expect.objectContaining({ id: 'art-001' }) })
      );
    });

    it('handles single-chunk artifact (start+content+end combined)', async () => {
      normalizeArtifactStreamPayload.mockReturnValue(
        makeNormalized({ start: true, end: true, content: 'one-shot code' })
      );

      service.handleStream(makeRawData());
      await flushPromises();

      const artifact = controller.artifactCache.get('art-001');
      expect(artifact.finalized).toBe(true);
      expect(artifact.content).toBe('one-shot code');
      expect(artifact.chunkCount).toBe(1);
      expect(controller.persistArtifact).toHaveBeenCalledTimes(1);
    });
  });
});
