'use strict';

// ---------------------------------------------------------------------------
// Mocks — plain functions survive resetMocks: true
// ---------------------------------------------------------------------------

const mockLog = {
  info: () => {},
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
    getArtifactType: jest.fn().mockReturnValue('code'),
    parse: jest.fn().mockImplementation((payload) => ({
      role: payload.role || 'assistant',
      type: payload.type || 'code',
      raw: payload,
    })),
  })
);

const MessageParser = require(
  '../../../../src/renderer/chat/modules/messaging/utils/MessageParser'
);
const ArtifactRoutingManager = require(
  '../../../../src/renderer/chat/modules/messaging/routing/ArtifactRoutingManager'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createEventBus() {
  return { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
}

function createEnrichmentManager() {
  return {
    hasMapping: jest.fn().mockReturnValue(false),
    enrich: jest.fn().mockImplementation((payload) => payload),
  };
}

function createManager(overrides = {}) {
  const eventBus = createEventBus();
  const enrichmentManager = createEnrichmentManager();
  const mgr = new ArtifactRoutingManager({
    eventBus,
    enrichmentManager,
    ...overrides,
  });
  return { mgr, eventBus, enrichmentManager };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ArtifactRoutingManager', () => {
  beforeEach(() => {
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    mockLog.debug.mockClear();
    mockLog.trace.mockClear();
    MessageParser.getArtifactType.mockReturnValue('code');
    MessageParser.parse.mockImplementation((payload) => ({
      role: payload.role || 'assistant',
      type: payload.type || 'code',
      raw: payload,
    }));
  });

  // =========================================================================
  // Constructor
  // =========================================================================
  describe('constructor', () => {
    test('throws when eventBus is not provided', () => {
      expect(() => new ArtifactRoutingManager({
        enrichmentManager: createEnrichmentManager(),
      })).toThrow('[ArtifactRoutingManager] eventBus is REQUIRED');
    });

    test('throws when enrichmentManager is not provided', () => {
      expect(() => new ArtifactRoutingManager({
        eventBus: createEventBus(),
      })).toThrow('[ArtifactRoutingManager] enrichmentManager is REQUIRED');
    });

    test('throws when no options', () => {
      expect(() => new ArtifactRoutingManager()).toThrow(
        '[ArtifactRoutingManager] eventBus is REQUIRED'
      );
    });

    test('throws with null eventBus', () => {
      expect(() => new ArtifactRoutingManager({
        eventBus: null,
        enrichmentManager: createEnrichmentManager(),
      })).toThrow('[ArtifactRoutingManager] eventBus is REQUIRED');
    });

    test('throws with null enrichmentManager', () => {
      expect(() => new ArtifactRoutingManager({
        eventBus: createEventBus(),
        enrichmentManager: null,
      })).toThrow('[ArtifactRoutingManager] enrichmentManager is REQUIRED');
    });

    test('succeeds with all required dependencies', () => {
      const { mgr, eventBus, enrichmentManager } = createManager();
      expect(mgr.eventBus).toBe(eventBus);
      expect(mgr.enrichmentManager).toBe(enrichmentManager);
    });

    test('initializes with empty pending chunks', () => {
      const { mgr } = createManager();
      expect(mgr._pendingChunks.size).toBe(0);
    });
  });

  // =========================================================================
  // handleArtifact() — buffering linkable artifacts
  // =========================================================================
  describe('handleArtifact — buffering', () => {
    test('buffers code artifact when no mapping exists (artifactId with :code:)', async () => {
      const { mgr, eventBus } = createManager();

      await mgr.handleArtifact({
        artifactId: 'uuid:code:abc',
        type: 'code',
        raw: { content: 'chunk1' },
      });

      expect(mgr._pendingChunks.has('uuid:code:abc')).toBe(true);
      expect(mgr._pendingChunks.get('uuid:code:abc')).toEqual([{ content: 'chunk1' }]);
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    test('buffers output artifact when no mapping exists (artifactId with :output:)', async () => {
      const { mgr, eventBus } = createManager();

      await mgr.handleArtifact({
        artifactId: 'uuid:output:xyz',
        type: 'output',
        raw: { output: 'result' },
      });

      expect(mgr._pendingChunks.has('uuid:output:xyz')).toBe(true);
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    test('buffers artifact by type=code when no :code: in id', async () => {
      const { mgr, eventBus } = createManager();

      await mgr.handleArtifact({
        artifactId: 'some-id-without-code',
        type: 'code',
        raw: { data: 1 },
      });

      expect(mgr._pendingChunks.has('some-id-without-code')).toBe(true);
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    test('buffers artifact by type=output', async () => {
      const { mgr, eventBus } = createManager();

      await mgr.handleArtifact({
        artifactId: 'some-output-id',
        type: 'output',
        raw: {},
      });

      expect(mgr._pendingChunks.has('some-output-id')).toBe(true);
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    test('buffers artifact by type=console', async () => {
      const { mgr, eventBus } = createManager();

      await mgr.handleArtifact({
        artifactId: 'console-id',
        type: 'console',
        raw: {},
      });

      expect(mgr._pendingChunks.has('console-id')).toBe(true);
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    test('buffers multiple chunks for same artifactId', async () => {
      const { mgr } = createManager();

      await mgr.handleArtifact({ artifactId: 'a:code:1', type: 'code', raw: { c: 1 } });
      await mgr.handleArtifact({ artifactId: 'a:code:1', type: 'code', raw: { c: 2 } });
      await mgr.handleArtifact({ artifactId: 'a:code:1', type: 'code', raw: { c: 3 } });

      expect(mgr._pendingChunks.get('a:code:1')).toHaveLength(3);
    });

    test('does NOT buffer when mapping already exists', async () => {
      const { mgr, eventBus, enrichmentManager } = createManager();
      enrichmentManager.hasMapping.mockReturnValue(true);

      await mgr.handleArtifact({
        artifactId: 'art:code:1',
        type: 'code',
        raw: { content: 'data' },
      });

      // Not buffered — routed immediately
      expect(mgr._pendingChunks.size).toBe(0);
      expect(eventBus.emit).toHaveBeenCalledTimes(1);
    });

    test('does NOT buffer when artifactId is null', async () => {
      const { mgr, eventBus } = createManager();

      await mgr.handleArtifact({
        artifactId: null,
        type: 'code',
        raw: { content: 'data' },
      });

      // Not linkable (artifactId is falsy) — routes immediately
      expect(mgr._pendingChunks.size).toBe(0);
      expect(eventBus.emit).toHaveBeenCalledTimes(1);
    });

    test('does NOT buffer when artifactId is undefined', async () => {
      const { mgr, eventBus } = createManager();

      await mgr.handleArtifact({
        type: 'code',
        raw: { content: 'data' },
      });

      expect(mgr._pendingChunks.size).toBe(0);
      expect(eventBus.emit).toHaveBeenCalledTimes(1);
    });

    test('does NOT buffer non-linkable artifact type without matching id', async () => {
      const { mgr, eventBus } = createManager();

      await mgr.handleArtifact({
        artifactId: 'some-id',
        type: 'message',
        raw: {},
      });

      // Not linkable — type is 'message', not code/output/console,
      // and id doesn't contain :code: or :output:
      expect(mgr._pendingChunks.size).toBe(0);
      expect(eventBus.emit).toHaveBeenCalledTimes(1);
    });

    test('logs trace when buffering', async () => {
      const { mgr } = createManager();

      await mgr.handleArtifact({
        artifactId: 'a:code:test',
        type: 'code',
        raw: {},
      });

      expect(mockLog.trace).toHaveBeenCalledWith(
        'Buffered linkable artifact chunk pending trail linkage',
        expect.objectContaining({ artifactType: 'code' })
      );
    });
  });

  // =========================================================================
  // handleArtifact() — immediate routing
  // =========================================================================
  describe('handleArtifact — immediate routing', () => {
    test('enriches and emits when mapping exists', async () => {
      const { mgr, eventBus, enrichmentManager } = createManager();
      enrichmentManager.hasMapping.mockReturnValue(true);
      enrichmentManager.enrich.mockReturnValue({ content: 'data', node_id: 'n1' });

      await mgr.handleArtifact({
        artifactId: 'art:code:1',
        type: 'code',
        raw: { content: 'data' },
      });

      expect(enrichmentManager.enrich).toHaveBeenCalledWith({ content: 'data' });
      expect(eventBus.emit).toHaveBeenCalledWith('artifact:stream', { content: 'data', node_id: 'n1' });
    });

    test('enriches and emits for non-linkable artifacts', async () => {
      const { mgr, eventBus, enrichmentManager } = createManager();

      await mgr.handleArtifact({
        artifactId: null,
        type: 'message',
        raw: { text: 'hello' },
      });

      expect(enrichmentManager.enrich).toHaveBeenCalledWith({ text: 'hello' });
      expect(eventBus.emit).toHaveBeenCalledWith('artifact:stream', { text: 'hello' });
    });

    test('passes enriched payload to eventBus', async () => {
      const { mgr, eventBus, enrichmentManager } = createManager();
      enrichmentManager.hasMapping.mockReturnValue(true);
      const enriched = { data: 'enriched', node_id: 'n1', subgroup_id: 'sg1' };
      enrichmentManager.enrich.mockReturnValue(enriched);

      await mgr.handleArtifact({
        artifactId: 'art:code:1',
        type: 'code',
        raw: { data: 'original' },
      });

      expect(eventBus.emit).toHaveBeenCalledWith('artifact:stream', enriched);
    });

    test('logs trace on emission', async () => {
      const { mgr, enrichmentManager } = createManager();
      enrichmentManager.hasMapping.mockReturnValue(true);
      enrichmentManager.enrich.mockReturnValue({ node_id: 'n1', subgroup_id: 'sg1' });

      await mgr.handleArtifact({
        artifactId: 'art:code:1',
        type: 'code',
        raw: {},
      });

      expect(mockLog.trace).toHaveBeenCalledWith(
        'Artifact emitted to EventBus',
        { artifactType: 'code', hasNodeId: true, hasSubgroupId: true }
      );
    });
  });

  // =========================================================================
  // flushBuffered()
  // =========================================================================
  describe('flushBuffered', () => {
    test('flushes buffered chunks with enrichment', async () => {
      const { mgr, eventBus, enrichmentManager } = createManager();

      // Buffer 2 chunks
      await mgr.handleArtifact({ artifactId: 'a:code:1', type: 'code', raw: { c: 1 } });
      await mgr.handleArtifact({ artifactId: 'a:code:1', type: 'code', raw: { c: 2 } });
      expect(mgr._pendingChunks.get('a:code:1')).toHaveLength(2);

      // Flush
      mgr.flushBuffered('a:code:1');

      expect(enrichmentManager.enrich).toHaveBeenCalledTimes(2);
      expect(eventBus.emit).toHaveBeenCalledTimes(2);
      expect(mgr._pendingChunks.has('a:code:1')).toBe(false);
    });

    test('does nothing for unknown artifactId', () => {
      const { mgr, eventBus, enrichmentManager } = createManager();

      mgr.flushBuffered('nonexistent');

      expect(enrichmentManager.enrich).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    test('does nothing when buffered array is empty', () => {
      const { mgr, eventBus } = createManager();
      mgr._pendingChunks.set('art-1', []);

      mgr.flushBuffered('art-1');

      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    test('removes artifactId from _pendingChunks after flush', async () => {
      const { mgr } = createManager();

      await mgr.handleArtifact({ artifactId: 'a:code:1', type: 'code', raw: {} });
      expect(mgr._pendingChunks.has('a:code:1')).toBe(true);

      mgr.flushBuffered('a:code:1');
      expect(mgr._pendingChunks.has('a:code:1')).toBe(false);
    });

    test('logs debug with artifactId and count', async () => {
      const { mgr } = createManager();
      mockLog.debug.mockClear();

      await mgr.handleArtifact({ artifactId: 'a:code:1', type: 'code', raw: { x: 1 } });
      await mgr.handleArtifact({ artifactId: 'a:code:1', type: 'code', raw: { x: 2 } });

      mgr.flushBuffered('a:code:1');

      expect(mockLog.debug).toHaveBeenCalledWith(
        'Flushing buffered artifact chunks',
        { artifactId: 'a:code:1', count: 2 }
      );
    });

    test('emits each chunk to artifact:stream', async () => {
      const { mgr, eventBus, enrichmentManager } = createManager();

      await mgr.handleArtifact({ artifactId: 'a:code:1', type: 'code', raw: { d: 'alpha' } });
      await mgr.handleArtifact({ artifactId: 'a:code:1', type: 'code', raw: { d: 'beta' } });

      enrichmentManager.enrich.mockImplementation((p) => ({ ...p, enriched: true }));

      mgr.flushBuffered('a:code:1');

      expect(eventBus.emit).toHaveBeenCalledTimes(2);
      expect(eventBus.emit.mock.calls[0][0]).toBe('artifact:stream');
      expect(eventBus.emit.mock.calls[1][0]).toBe('artifact:stream');
    });

    test('uses _getArtifactTypeFromPayload for each chunk', async () => {
      const { mgr } = createManager();
      MessageParser.getArtifactType.mockReturnValue('console');

      await mgr.handleArtifact({ artifactId: 'a:output:1', type: 'output', raw: { out: 1 } });

      mgr.flushBuffered('a:output:1');

      expect(MessageParser.parse).toHaveBeenCalled();
      expect(MessageParser.getArtifactType).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _bufferChunk()
  // =========================================================================
  describe('_bufferChunk', () => {
    test('creates new array for first chunk', () => {
      const { mgr } = createManager();

      mgr._bufferChunk('art-1', { data: 1 });

      expect(mgr._pendingChunks.get('art-1')).toEqual([{ data: 1 }]);
    });

    test('appends to existing array for subsequent chunks', () => {
      const { mgr } = createManager();

      mgr._bufferChunk('art-1', { data: 1 });
      mgr._bufferChunk('art-1', { data: 2 });

      expect(mgr._pendingChunks.get('art-1')).toEqual([{ data: 1 }, { data: 2 }]);
    });

    test('keeps separate arrays for different artifactIds', () => {
      const { mgr } = createManager();

      mgr._bufferChunk('art-1', { a: 1 });
      mgr._bufferChunk('art-2', { b: 2 });

      expect(mgr._pendingChunks.get('art-1')).toEqual([{ a: 1 }]);
      expect(mgr._pendingChunks.get('art-2')).toEqual([{ b: 2 }]);
    });
  });

  // =========================================================================
  // _emitArtifact()
  // =========================================================================
  describe('_emitArtifact', () => {
    test('emits to artifact:stream channel', () => {
      const { mgr, eventBus } = createManager();

      mgr._emitArtifact({ content: 'test' }, 'code');

      expect(eventBus.emit).toHaveBeenCalledWith('artifact:stream', { content: 'test' });
    });

    test('logs trace with artifact type and metadata presence', () => {
      const { mgr } = createManager();

      mgr._emitArtifact({ node_id: 'n1', subgroup_id: 'sg1' }, 'console');

      expect(mockLog.trace).toHaveBeenCalledWith('Artifact emitted to EventBus', {
        artifactType: 'console',
        hasNodeId: true,
        hasSubgroupId: true,
      });
    });

    test('reports false for missing node_id/subgroup_id', () => {
      const { mgr } = createManager();

      mgr._emitArtifact({ content: 'data' }, 'code');

      expect(mockLog.trace).toHaveBeenCalledWith('Artifact emitted to EventBus', {
        artifactType: 'code',
        hasNodeId: false,
        hasSubgroupId: false,
      });
    });
  });

  // =========================================================================
  // _getArtifactTypeFromPayload()
  // =========================================================================
  describe('_getArtifactTypeFromPayload', () => {
    test('parses payload and returns artifact type', () => {
      const { mgr } = createManager();
      MessageParser.getArtifactType.mockReturnValue('html');

      const result = mgr._getArtifactTypeFromPayload({ role: 'computer', type: 'code', format: 'html' });

      expect(MessageParser.parse).toHaveBeenCalledWith({ role: 'computer', type: 'code', format: 'html' });
      expect(result).toBe('html');
    });

    test('returns "unknown" when getArtifactType returns null', () => {
      const { mgr } = createManager();
      MessageParser.getArtifactType.mockReturnValue(null);

      const result = mgr._getArtifactTypeFromPayload({});

      expect(result).toBe('unknown');
    });
  });

  // =========================================================================
  // clear()
  // =========================================================================
  describe('clear', () => {
    test('removes all pending chunks', async () => {
      const { mgr } = createManager();

      await mgr.handleArtifact({ artifactId: 'a:code:1', type: 'code', raw: {} });
      await mgr.handleArtifact({ artifactId: 'b:code:2', type: 'code', raw: {} });

      mgr.clear();

      expect(mgr._pendingChunks.size).toBe(0);
    });

    test('logs previous size', async () => {
      const { mgr } = createManager();
      mockLog.debug.mockClear();

      await mgr.handleArtifact({ artifactId: 'a:code:1', type: 'code', raw: {} });
      await mgr.handleArtifact({ artifactId: 'b:code:2', type: 'code', raw: {} });
      mockLog.debug.mockClear();

      mgr.clear();

      expect(mockLog.debug).toHaveBeenCalledWith('Cleared buffered artifact chunks', {
        previousSize: 2,
      });
    });

    test('can be called when empty', () => {
      const { mgr } = createManager();

      expect(() => mgr.clear()).not.toThrow();
    });
  });

  // =========================================================================
  // dispose()
  // =========================================================================
  describe('dispose', () => {
    test('clears pending chunks', async () => {
      const { mgr } = createManager();
      await mgr.handleArtifact({ artifactId: 'a:code:1', type: 'code', raw: {} });

      mgr.dispose();

      expect(mgr._pendingChunks.size).toBe(0);
    });

    test('nulls all references', () => {
      const { mgr } = createManager();

      mgr.dispose();

      expect(mgr.eventBus).toBeNull();
      expect(mgr.enrichmentManager).toBeNull();
    });

    test('sets _isDisposed to true', () => {
      const { mgr } = createManager();
      expect(mgr._isDisposed).toBe(false);
      mgr.dispose();
      expect(mgr._isDisposed).toBe(true);
    });

    test('is idempotent — second call is a no-op', () => {
      const { mgr } = createManager();
      mgr.dispose();
      expect(() => mgr.dispose()).not.toThrow();
      expect(mgr._isDisposed).toBe(true);
    });

    test('BUG REGRESSION: handleArtifact after dispose returns early (prevents null-ref on enrichmentManager)', async () => {
      const { mgr, enrichmentManager } = createManager();
      mgr.dispose();

      // Pre-fix: this would crash with TypeError on null enrichmentManager
      await mgr.handleArtifact({ artifactId: 'art:code:1', type: 'code', raw: {} });

      expect(enrichmentManager.hasMapping).not.toHaveBeenCalled();
      expect(mockLog.warn).toHaveBeenCalledWith(
        'handleArtifact called on disposed ArtifactRoutingManager'
      );
    });

    test('BUG REGRESSION: flushBuffered after dispose returns early (prevents null-ref on enrichmentManager)', () => {
      const { mgr, enrichmentManager } = createManager();

      // Buffer something first
      mgr._pendingChunks.set('art:code:1', [{ c: 1 }]);
      mgr.dispose();

      // Pre-fix: this would crash with TypeError on null enrichmentManager
      mgr.flushBuffered('art:code:1');

      expect(enrichmentManager.enrich).not.toHaveBeenCalled();
      expect(mockLog.warn).toHaveBeenCalledWith(
        'flushBuffered called on disposed ArtifactRoutingManager'
      );
    });
  });

  // =========================================================================
  // Lifecycle integration
  // =========================================================================
  describe('lifecycle integration', () => {
    test('full flow: buffer → linkage arrives → flush → subsequent enriched', async () => {
      const { mgr, eventBus, enrichmentManager } = createManager();

      // Phase 1: buffer (no mapping yet)
      await mgr.handleArtifact({ artifactId: 'art:code:1', type: 'code', raw: { c: 1 } });
      await mgr.handleArtifact({ artifactId: 'art:code:1', type: 'code', raw: { c: 2 } });
      expect(eventBus.emit).not.toHaveBeenCalled();

      // Phase 2: linkage arrives → flush
      enrichmentManager.hasMapping.mockReturnValue(true);
      mgr.flushBuffered('art:code:1');
      expect(eventBus.emit).toHaveBeenCalledTimes(2);

      // Phase 3: subsequent chunks route immediately
      eventBus.emit.mockClear();
      await mgr.handleArtifact({ artifactId: 'art:code:1', type: 'code', raw: { c: 3 } });
      expect(eventBus.emit).toHaveBeenCalledTimes(1);

      // Phase 4: dispose
      mgr.dispose();
      expect(mgr.eventBus).toBeNull();
    });
  });

  // =========================================================================
  // Module exports
  // =========================================================================
  describe('module exports', () => {
    test('exports ArtifactRoutingManager constructor', () => {
      expect(typeof ArtifactRoutingManager).toBe('function');
    });

    test('instances have expected methods', () => {
      const { mgr } = createManager();
      expect(typeof mgr.handleArtifact).toBe('function');
      expect(typeof mgr.flushBuffered).toBe('function');
      expect(typeof mgr.clear).toBe('function');
      expect(typeof mgr.dispose).toBe('function');
    });
  });
});
