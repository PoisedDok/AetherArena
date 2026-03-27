'use strict';

// ---------------------------------------------------------------------------
// Mocks — plain functions survive resetMocks: true
// ---------------------------------------------------------------------------

const mockLog = {
  info: () => {},
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: () => {},
};
mockLog.child = () => mockLog;

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

const { EventTypes } = require('../../../../src/core/events/EventTypes');
const TrailEventHandler = require(
  '../../../../src/renderer/chat/modules/messaging/handlers/TrailEventHandler'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createEventBus() {
  return { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
}

function createEnrichmentManager() {
  return { storeMapping: jest.fn() };
}

function createArtifactRoutingManager() {
  return { flushBuffered: jest.fn() };
}

function createHandler(overrides = {}) {
  const deps = {
    eventBus: createEventBus(),
    enrichmentManager: createEnrichmentManager(),
    artifactRoutingManager: createArtifactRoutingManager(),
    ...overrides,
  };
  const handler = new TrailEventHandler(deps);
  return { handler, ...deps };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TrailEventHandler', () => {
  beforeEach(() => {
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    mockLog.debug.mockClear();
  });

  // =========================================================================
  // Constructor
  // =========================================================================
  describe('constructor', () => {
    test('throws when eventBus is not provided', () => {
      expect(() => new TrailEventHandler({
        enrichmentManager: createEnrichmentManager(),
        artifactRoutingManager: createArtifactRoutingManager(),
      })).toThrow('[TrailEventHandler] eventBus is REQUIRED');
    });

    test('throws when enrichmentManager is not provided', () => {
      expect(() => new TrailEventHandler({
        eventBus: createEventBus(),
        artifactRoutingManager: createArtifactRoutingManager(),
      })).toThrow('[TrailEventHandler] enrichmentManager is REQUIRED');
    });

    test('throws when artifactRoutingManager is not provided', () => {
      expect(() => new TrailEventHandler({
        eventBus: createEventBus(),
        enrichmentManager: createEnrichmentManager(),
      })).toThrow('[TrailEventHandler] artifactRoutingManager is REQUIRED');
    });

    test('throws when no options provided', () => {
      expect(() => new TrailEventHandler()).toThrow(
        '[TrailEventHandler] eventBus is REQUIRED'
      );
    });

    test('throws when options is empty object', () => {
      expect(() => new TrailEventHandler({})).toThrow(
        '[TrailEventHandler] eventBus is REQUIRED'
      );
    });

    test('throws with null eventBus', () => {
      expect(() => new TrailEventHandler({
        eventBus: null,
        enrichmentManager: createEnrichmentManager(),
        artifactRoutingManager: createArtifactRoutingManager(),
      })).toThrow('[TrailEventHandler] eventBus is REQUIRED');
    });

    test('throws with null enrichmentManager', () => {
      expect(() => new TrailEventHandler({
        eventBus: createEventBus(),
        enrichmentManager: null,
        artifactRoutingManager: createArtifactRoutingManager(),
      })).toThrow('[TrailEventHandler] enrichmentManager is REQUIRED');
    });

    test('throws with null artifactRoutingManager', () => {
      expect(() => new TrailEventHandler({
        eventBus: createEventBus(),
        enrichmentManager: createEnrichmentManager(),
        artifactRoutingManager: null,
      })).toThrow('[TrailEventHandler] artifactRoutingManager is REQUIRED');
    });

    test('succeeds with all required dependencies', () => {
      const { handler, eventBus, enrichmentManager, artifactRoutingManager } = createHandler();
      expect(handler.eventBus).toBe(eventBus);
      expect(handler.enrichmentManager).toBe(enrichmentManager);
      expect(handler.artifactRoutingManager).toBe(artifactRoutingManager);
    });
  });

  // =========================================================================
  // handleTrailEvent() — event type routing
  // =========================================================================
  describe('handleTrailEvent — event type routing', () => {
    const validTypes = [
      ['trail.group_created', EventTypes.TRAIL.GROUP_CREATED],
      ['trail.subgroup_created', EventTypes.TRAIL.SUBGROUP_CREATED],
      ['trail.subgroup_completed', EventTypes.TRAIL.SUBGROUP_COMPLETED],
      ['trail.artifact_linked', EventTypes.TRAIL.ARTIFACT_LINKED],
      ['trail.node_status_updated', EventTypes.TRAIL.NODE_STATUS_UPDATED],
    ];

    test.each(validTypes)(
      'maps "%s" to EventTypes.TRAIL constant and emits to eventBus',
      async (sourceType, expectedEventType) => {
        const { handler, eventBus } = createHandler();
        const raw = { someKey: 'someValue' };

        await handler.handleTrailEvent({ type: sourceType, raw });

        expect(eventBus.emit).toHaveBeenCalledWith(expectedEventType, raw);
      }
    );

    test('emits raw payload unmodified to eventBus', async () => {
      const { handler, eventBus } = createHandler();
      const raw = {
        group_id: 'g-1',
        parent_id: 'p-1',
        metadata: { nested: true },
      };

      await handler.handleTrailEvent({ type: 'trail.group_created', raw });

      expect(eventBus.emit.mock.calls[0][1]).toBe(raw);
    });

    test('logs debug after routing event', async () => {
      const { handler } = createHandler();

      await handler.handleTrailEvent({
        type: 'trail.group_created',
        raw: {},
      });

      expect(mockLog.debug).toHaveBeenCalledWith(
        'Trail event routed to EventBus',
        {
          type: 'trail.group_created',
          eventType: EventTypes.TRAIL.GROUP_CREATED,
        }
      );
    });

    test('returns early and logs warn for unknown trail event type', async () => {
      const { handler, eventBus } = createHandler();

      await handler.handleTrailEvent({ type: 'trail.unknown_event', raw: {} });

      expect(mockLog.warn).toHaveBeenCalledWith(
        'Unknown trail event type',
        { type: 'trail.unknown_event' }
      );
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    test('returns early for empty string type', async () => {
      const { handler, eventBus } = createHandler();

      await handler.handleTrailEvent({ type: '', raw: {} });

      expect(mockLog.warn).toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    test('returns early for undefined type', async () => {
      const { handler, eventBus } = createHandler();

      await handler.handleTrailEvent({ type: undefined, raw: {} });

      expect(mockLog.warn).toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    test('returns early for null type', async () => {
      const { handler, eventBus } = createHandler();

      await handler.handleTrailEvent({ type: null, raw: {} });

      expect(mockLog.warn).toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // handleTrailEvent() — trail.artifact_linked special case
  // =========================================================================
  describe('handleTrailEvent — artifact_linked special case', () => {
    test('calls _handleArtifactLinked before emitting to eventBus', async () => {
      const { handler, enrichmentManager, artifactRoutingManager, eventBus } = createHandler();
      const raw = { artifact_id: 'art-abc-123' };

      await handler.handleTrailEvent({ type: 'trail.artifact_linked', raw });

      // enrichmentManager.storeMapping called
      expect(enrichmentManager.storeMapping).toHaveBeenCalledWith(raw);

      // artifactRoutingManager.flushBuffered called
      expect(artifactRoutingManager.flushBuffered).toHaveBeenCalledWith('art-abc-123');

      // eventBus still emits
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.TRAIL.ARTIFACT_LINKED,
        raw
      );
    });

    test('does NOT call _handleArtifactLinked for non-artifact_linked types', async () => {
      const { handler, enrichmentManager, artifactRoutingManager } = createHandler();

      await handler.handleTrailEvent({
        type: 'trail.group_created',
        raw: { artifact_id: 'should-not-trigger' },
      });

      expect(enrichmentManager.storeMapping).not.toHaveBeenCalled();
      expect(artifactRoutingManager.flushBuffered).not.toHaveBeenCalled();
    });

    test('calls storeMapping with full payload', async () => {
      const { handler, enrichmentManager } = createHandler();
      const raw = {
        artifact_id: 'art-1',
        node_id: 'node-1',
        group_id: 'group-1',
        extra: 'data',
      };

      await handler.handleTrailEvent({ type: 'trail.artifact_linked', raw });

      expect(enrichmentManager.storeMapping).toHaveBeenCalledWith(raw);
      expect(enrichmentManager.storeMapping.mock.calls[0][0]).toBe(raw);
    });

    test('flushes buffered artifacts by artifact_id', async () => {
      const { handler, artifactRoutingManager } = createHandler();

      await handler.handleTrailEvent({
        type: 'trail.artifact_linked',
        raw: { artifact_id: 'my-artifact-id-here' },
      });

      expect(artifactRoutingManager.flushBuffered).toHaveBeenCalledWith(
        'my-artifact-id-here'
      );
    });

    test('does NOT flush when artifact_id is falsy (undefined)', async () => {
      const { handler, enrichmentManager, artifactRoutingManager } = createHandler();

      await handler.handleTrailEvent({
        type: 'trail.artifact_linked',
        raw: {},
      });

      // storeMapping still called
      expect(enrichmentManager.storeMapping).toHaveBeenCalled();
      // flushBuffered NOT called — artifact_id is undefined
      expect(artifactRoutingManager.flushBuffered).not.toHaveBeenCalled();
    });

    test('does NOT flush when artifact_id is null', async () => {
      const { handler, artifactRoutingManager } = createHandler();

      await handler.handleTrailEvent({
        type: 'trail.artifact_linked',
        raw: { artifact_id: null },
      });

      expect(artifactRoutingManager.flushBuffered).not.toHaveBeenCalled();
    });

    test('does NOT flush when artifact_id is empty string', async () => {
      const { handler, artifactRoutingManager } = createHandler();

      await handler.handleTrailEvent({
        type: 'trail.artifact_linked',
        raw: { artifact_id: '' },
      });

      expect(artifactRoutingManager.flushBuffered).not.toHaveBeenCalled();
    });

    test('logs debug with truncated artifact_id (max 40 chars)', async () => {
      const { handler } = createHandler();
      const longId = 'a'.repeat(80);

      await handler.handleTrailEvent({
        type: 'trail.artifact_linked',
        raw: { artifact_id: longId },
      });

      expect(mockLog.debug).toHaveBeenCalledWith(
        'Artifact trail linkage processed',
        { artifact_id: 'a'.repeat(40) }
      );
    });

    test('logs debug with short artifact_id unchanged', async () => {
      const { handler } = createHandler();

      await handler.handleTrailEvent({
        type: 'trail.artifact_linked',
        raw: { artifact_id: 'short-id' },
      });

      expect(mockLog.debug).toHaveBeenCalledWith(
        'Artifact trail linkage processed',
        { artifact_id: 'short-id' }
      );
    });

    test('handles numeric artifact_id without throwing', async () => {
      // BUG: artifact_id.substring(0, 40) throws TypeError for non-string
      // truthy values. Backend always sends strings, but defensive code
      // should not crash on unexpected types in a log statement.
      const { handler, artifactRoutingManager } = createHandler();

      await handler.handleTrailEvent({
        type: 'trail.artifact_linked',
        raw: { artifact_id: 12345 },
      });

      expect(artifactRoutingManager.flushBuffered).toHaveBeenCalledWith(12345);
    });
  });

  // =========================================================================
  // handleTrailEvent() — event bus emission order
  // =========================================================================
  describe('handleTrailEvent — emission order', () => {
    test('artifact_linked: storeMapping + flush happen BEFORE eventBus.emit', async () => {
      const callOrder = [];
      const { handler, enrichmentManager, artifactRoutingManager, eventBus } = createHandler();

      enrichmentManager.storeMapping.mockImplementation(() => callOrder.push('storeMapping'));
      artifactRoutingManager.flushBuffered.mockImplementation(() => callOrder.push('flushBuffered'));
      eventBus.emit.mockImplementation(() => callOrder.push('emit'));

      await handler.handleTrailEvent({
        type: 'trail.artifact_linked',
        raw: { artifact_id: 'art-1' },
      });

      expect(callOrder).toEqual(['storeMapping', 'flushBuffered', 'emit']);
    });
  });

  // =========================================================================
  // dispose()
  // =========================================================================
  describe('dispose', () => {
    test('nulls all references', () => {
      const { handler } = createHandler();

      handler.dispose();

      expect(handler.eventBus).toBeNull();
      expect(handler.enrichmentManager).toBeNull();
      expect(handler.artifactRoutingManager).toBeNull();
    });

    test('can be called multiple times without error', () => {
      const { handler } = createHandler();

      expect(() => {
        handler.dispose();
        handler.dispose();
      }).not.toThrow();
    });

    test('all refs remain null after double dispose', () => {
      const { handler } = createHandler();

      handler.dispose();
      handler.dispose();

      expect(handler.eventBus).toBeNull();
      expect(handler.enrichmentManager).toBeNull();
      expect(handler.artifactRoutingManager).toBeNull();
    });
  });

  // =========================================================================
  // Lifecycle integration
  // =========================================================================
  describe('lifecycle integration', () => {
    test('full lifecycle: create → handle events → dispose', async () => {
      const { handler, eventBus, enrichmentManager, artifactRoutingManager } = createHandler();

      // Handle multiple event types
      await handler.handleTrailEvent({
        type: 'trail.group_created',
        raw: { group_id: 'g1' },
      });
      await handler.handleTrailEvent({
        type: 'trail.artifact_linked',
        raw: { artifact_id: 'art-1' },
      });
      await handler.handleTrailEvent({
        type: 'trail.node_status_updated',
        raw: { node_id: 'n1', status: 'done' },
      });

      expect(eventBus.emit).toHaveBeenCalledTimes(3);
      expect(enrichmentManager.storeMapping).toHaveBeenCalledTimes(1);
      expect(artifactRoutingManager.flushBuffered).toHaveBeenCalledTimes(1);

      // Dispose
      handler.dispose();
      expect(handler.eventBus).toBeNull();
    });

    test('handles mixed valid and invalid events gracefully', async () => {
      const { handler, eventBus } = createHandler();

      await handler.handleTrailEvent({ type: 'trail.group_created', raw: {} });
      await handler.handleTrailEvent({ type: 'trail.invalid_type', raw: {} });
      await handler.handleTrailEvent({ type: 'trail.subgroup_created', raw: {} });

      // Only valid events emit
      expect(eventBus.emit).toHaveBeenCalledTimes(2);
      expect(mockLog.warn).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Module exports
  // =========================================================================
  describe('module exports', () => {
    test('exports TrailEventHandler constructor', () => {
      expect(typeof TrailEventHandler).toBe('function');
    });

    test('instances have expected methods', () => {
      const { handler } = createHandler();
      expect(typeof handler.handleTrailEvent).toBe('function');
      expect(typeof handler.dispose).toBe('function');
    });
  });

  // =========================================================================
  // BUG REGRESSIONS (TEH-1)
  // =========================================================================
  describe('bug regressions', () => {
    test('[TEH-1] constructor initializes _isDisposed to false', () => {
      const { handler } = createHandler();
      expect(handler._isDisposed).toBe(false);
    });

    test('[TEH-1] handleTrailEvent is no-op after dispose (prevents null-ref crash)', async () => {
      const { handler } = createHandler();
      handler.dispose();

      // eventBus is null post-dispose — this.eventBus.emit() would crash
      await expect(handler.handleTrailEvent({
        type: 'trail.group_created',
        raw: { group_id: 'g1' },
      })).resolves.toBeUndefined();
    });

    test('[TEH-1] handleTrailEvent ignores artifact_linked after dispose', async () => {
      const { handler } = createHandler();
      handler.dispose();

      await expect(handler.handleTrailEvent({
        type: 'trail.artifact_linked',
        raw: { artifact_id: 'art-1' },
      })).resolves.toBeUndefined();
    });

    test('[TEH-1] dispose is idempotent (double-dispose safe)', () => {
      const { handler } = createHandler();
      handler.dispose();
      expect(() => handler.dispose()).not.toThrow();
      expect(handler._isDisposed).toBe(true);
    });
  });
});
