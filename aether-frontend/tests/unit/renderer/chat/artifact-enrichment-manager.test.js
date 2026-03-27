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

const ArtifactEnrichmentManager = require(
  '../../../../src/renderer/chat/modules/messaging/routing/ArtifactEnrichmentManager'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createManager() {
  return new ArtifactEnrichmentManager();
}

function storeSampleMapping(manager, artifactId = 'art-1', nodeId = 'node-1', subgroupId = 'sg-1') {
  manager.storeMapping({
    artifact_id: artifactId,
    node_id: nodeId,
    subgroup_id: subgroupId,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ArtifactEnrichmentManager', () => {
  beforeEach(() => {
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    mockLog.debug.mockClear();
    mockLog.trace.mockClear();
  });

  // =========================================================================
  // Constructor
  // =========================================================================
  describe('constructor', () => {
    test('creates with empty mappings', () => {
      const mgr = createManager();
      expect(mgr._mappings.size).toBe(0);
    });

    test('accepts empty options', () => {
      expect(() => new ArtifactEnrichmentManager({})).not.toThrow();
    });

    test('accepts no options', () => {
      expect(() => new ArtifactEnrichmentManager()).not.toThrow();
    });
  });

  // =========================================================================
  // storeMapping()
  // =========================================================================
  describe('storeMapping', () => {
    test('stores mapping with all required fields', () => {
      const mgr = createManager();

      mgr.storeMapping({
        artifact_id: 'art-1',
        node_id: 'node-1',
        subgroup_id: 'sg-1',
      });

      expect(mgr._mappings.size).toBe(1);
      expect(mgr._mappings.get('art-1')).toEqual({
        node_id: 'node-1',
        subgroup_id: 'sg-1',
      });
    });

    test('stores only node_id and subgroup_id in mapping (not artifact_id)', () => {
      const mgr = createManager();

      mgr.storeMapping({
        artifact_id: 'art-1',
        node_id: 'n1',
        subgroup_id: 's1',
        extra_field: 'ignored',
      });

      const mapping = mgr._mappings.get('art-1');
      expect(mapping).toEqual({ node_id: 'n1', subgroup_id: 's1' });
      expect(mapping).not.toHaveProperty('artifact_id');
      expect(mapping).not.toHaveProperty('extra_field');
    });

    test('overwrites mapping for same artifact_id', () => {
      const mgr = createManager();

      mgr.storeMapping({ artifact_id: 'art-1', node_id: 'n1', subgroup_id: 's1' });
      mgr.storeMapping({ artifact_id: 'art-1', node_id: 'n2', subgroup_id: 's2' });

      expect(mgr._mappings.size).toBe(1);
      expect(mgr._mappings.get('art-1')).toEqual({ node_id: 'n2', subgroup_id: 's2' });
    });

    test('stores multiple mappings for different artifact_ids', () => {
      const mgr = createManager();

      mgr.storeMapping({ artifact_id: 'art-1', node_id: 'n1', subgroup_id: 's1' });
      mgr.storeMapping({ artifact_id: 'art-2', node_id: 'n2', subgroup_id: 's2' });
      mgr.storeMapping({ artifact_id: 'art-3', node_id: 'n3', subgroup_id: 's3' });

      expect(mgr._mappings.size).toBe(3);
    });

    test('rejects when artifact_id is missing', () => {
      const mgr = createManager();

      mgr.storeMapping({ node_id: 'n1', subgroup_id: 's1' });

      expect(mgr._mappings.size).toBe(0);
      expect(mockLog.warn).toHaveBeenCalledWith(
        'Ignoring trail.artifact_linked with missing fields',
        { hasArtifactId: false, hasNodeId: true, hasSubgroupId: true }
      );
    });

    test('rejects when node_id is missing', () => {
      const mgr = createManager();

      mgr.storeMapping({ artifact_id: 'art-1', subgroup_id: 's1' });

      expect(mgr._mappings.size).toBe(0);
      expect(mockLog.warn).toHaveBeenCalledWith(
        'Ignoring trail.artifact_linked with missing fields',
        { hasArtifactId: true, hasNodeId: false, hasSubgroupId: true }
      );
    });

    test('rejects when subgroup_id is missing', () => {
      const mgr = createManager();

      mgr.storeMapping({ artifact_id: 'art-1', node_id: 'n1' });

      expect(mgr._mappings.size).toBe(0);
      expect(mockLog.warn).toHaveBeenCalledWith(
        'Ignoring trail.artifact_linked with missing fields',
        { hasArtifactId: true, hasNodeId: true, hasSubgroupId: false }
      );
    });

    test('rejects when all fields are missing', () => {
      const mgr = createManager();

      mgr.storeMapping({});

      expect(mgr._mappings.size).toBe(0);
      expect(mockLog.warn).toHaveBeenCalledWith(
        'Ignoring trail.artifact_linked with missing fields',
        { hasArtifactId: false, hasNodeId: false, hasSubgroupId: false }
      );
    });

    test('rejects null artifact_id', () => {
      const mgr = createManager();

      mgr.storeMapping({ artifact_id: null, node_id: 'n1', subgroup_id: 's1' });

      expect(mgr._mappings.size).toBe(0);
    });

    test('rejects empty string artifact_id', () => {
      const mgr = createManager();

      mgr.storeMapping({ artifact_id: '', node_id: 'n1', subgroup_id: 's1' });

      expect(mgr._mappings.size).toBe(0);
    });

    test('logs debug with truncated IDs on success', () => {
      const mgr = createManager();
      const longArtifactId = 'x'.repeat(80);
      const longNodeId = 'y'.repeat(40);
      const longSubgroupId = 'z'.repeat(40);

      mgr.storeMapping({
        artifact_id: longArtifactId,
        node_id: longNodeId,
        subgroup_id: longSubgroupId,
      });

      expect(mockLog.debug).toHaveBeenCalledWith(
        'Stored artifact trail mapping',
        {
          artifact_id: 'x'.repeat(40),
          node_id: 'y'.repeat(16),
          subgroup_id: 'z'.repeat(16),
          mapSize: 1,
        }
      );
    });

    test('logs mapSize incrementally', () => {
      const mgr = createManager();

      mgr.storeMapping({ artifact_id: 'a1', node_id: 'n1', subgroup_id: 's1' });
      mgr.storeMapping({ artifact_id: 'a2', node_id: 'n2', subgroup_id: 's2' });

      const calls = mockLog.debug.mock.calls;
      expect(calls[0][1].mapSize).toBe(1);
      expect(calls[1][1].mapSize).toBe(2);
    });
  });

  // =========================================================================
  // enrich()
  // =========================================================================
  describe('enrich', () => {
    test('enriches payload with trail metadata from stored mapping', () => {
      const mgr = createManager();
      storeSampleMapping(mgr, 'art-1', 'node-1', 'sg-1');

      const payload = { artifact_id: 'art-1', content: 'code...' };
      const result = mgr.enrich(payload);

      expect(result.node_id).toBe('node-1');
      expect(result.subgroup_id).toBe('sg-1');
      expect(result.content).toBe('code...');
    });

    test('mutates and returns the original payload object', () => {
      const mgr = createManager();
      storeSampleMapping(mgr);

      const payload = { artifact_id: 'art-1' };
      const result = mgr.enrich(payload);

      expect(result).toBe(payload);
      expect(payload.node_id).toBe('node-1');
    });

    test('supports payload.artifactId (camelCase) as fallback', () => {
      const mgr = createManager();
      storeSampleMapping(mgr, 'art-1');

      const payload = { artifactId: 'art-1' };
      const result = mgr.enrich(payload);

      expect(result.node_id).toBe('node-1');
      expect(result.subgroup_id).toBe('sg-1');
    });

    test('prefers payload.artifact_id over payload.artifactId', () => {
      const mgr = createManager();
      storeSampleMapping(mgr, 'art-snake');
      mgr.storeMapping({ artifact_id: 'art-camel', node_id: 'n-camel', subgroup_id: 'sg-camel' });

      const payload = { artifact_id: 'art-snake', artifactId: 'art-camel' };
      const result = mgr.enrich(payload);

      // artifact_id (snake_case) takes precedence due to || short-circuit
      expect(result.node_id).toBe('node-1');
    });

    test('returns payload unchanged when no artifact_id present', () => {
      const mgr = createManager();
      storeSampleMapping(mgr);

      const payload = { content: 'data' };
      const result = mgr.enrich(payload);

      expect(result).toBe(payload);
      expect(result).not.toHaveProperty('node_id');
      expect(result).not.toHaveProperty('subgroup_id');
    });

    test('returns payload unchanged when no mapping exists', () => {
      const mgr = createManager();

      const payload = { artifact_id: 'unknown-art' };
      const result = mgr.enrich(payload);

      expect(result).toBe(payload);
      expect(result).not.toHaveProperty('node_id');
      expect(result).not.toHaveProperty('subgroup_id');
    });

    test('returns payload when artifact_id is null', () => {
      const mgr = createManager();
      storeSampleMapping(mgr);

      const payload = { artifact_id: null };
      const result = mgr.enrich(payload);

      expect(result).toBe(payload);
      expect(result).not.toHaveProperty('node_id');
    });

    test('returns payload when artifact_id is empty string', () => {
      const mgr = createManager();
      storeSampleMapping(mgr);

      const payload = { artifact_id: '' };
      const result = mgr.enrich(payload);

      expect(result).toBe(payload);
      expect(result).not.toHaveProperty('node_id');
    });

    test('overwrites existing node_id/subgroup_id on payload', () => {
      const mgr = createManager();
      storeSampleMapping(mgr, 'art-1', 'correct-node', 'correct-sg');

      const payload = { artifact_id: 'art-1', node_id: 'old-node', subgroup_id: 'old-sg' };
      const result = mgr.enrich(payload);

      expect(result.node_id).toBe('correct-node');
      expect(result.subgroup_id).toBe('correct-sg');
    });

    test('logs trace when enrichment succeeds', () => {
      const mgr = createManager();
      storeSampleMapping(mgr, 'art-1', 'node-1', 'sg-1');

      mgr.enrich({ artifact_id: 'art-1' });

      expect(mockLog.trace).toHaveBeenCalledWith(
        'Enriched artifact with trail metadata',
        {
          artifact_id: 'art-1',
          node_id: 'node-1',
          subgroup_id: 'sg-1',
        }
      );
    });

    test('does not log trace when no mapping found', () => {
      const mgr = createManager();

      mgr.enrich({ artifact_id: 'unknown' });

      expect(mockLog.trace).not.toHaveBeenCalled();
    });

    test('enriches multiple payloads from same mapping', () => {
      const mgr = createManager();
      storeSampleMapping(mgr, 'art-1', 'n1', 'sg1');

      const p1 = { artifact_id: 'art-1', chunk: 1 };
      const p2 = { artifact_id: 'art-1', chunk: 2 };

      mgr.enrich(p1);
      mgr.enrich(p2);

      expect(p1.node_id).toBe('n1');
      expect(p2.node_id).toBe('n1');
    });
  });

  // =========================================================================
  // hasMapping()
  // =========================================================================
  describe('hasMapping', () => {
    test('returns true for stored artifact_id', () => {
      const mgr = createManager();
      storeSampleMapping(mgr, 'art-1');

      expect(mgr.hasMapping('art-1')).toBe(true);
    });

    test('returns false for unknown artifact_id', () => {
      const mgr = createManager();

      expect(mgr.hasMapping('nonexistent')).toBe(false);
    });

    test('returns false after clear()', () => {
      const mgr = createManager();
      storeSampleMapping(mgr, 'art-1');

      mgr.clear();

      expect(mgr.hasMapping('art-1')).toBe(false);
    });

    test('returns false after dispose()', () => {
      const mgr = createManager();
      storeSampleMapping(mgr, 'art-1');

      mgr.dispose();

      expect(mgr.hasMapping('art-1')).toBe(false);
    });

    test('returns false for undefined', () => {
      const mgr = createManager();
      storeSampleMapping(mgr);

      expect(mgr.hasMapping(undefined)).toBe(false);
    });

    test('returns false for null', () => {
      const mgr = createManager();
      storeSampleMapping(mgr);

      expect(mgr.hasMapping(null)).toBe(false);
    });
  });

  // =========================================================================
  // getMapping()
  // =========================================================================
  describe('getMapping', () => {
    test('returns mapping object for stored artifact_id', () => {
      const mgr = createManager();
      storeSampleMapping(mgr, 'art-1', 'n1', 'sg1');

      const result = mgr.getMapping('art-1');

      expect(result).toEqual({ node_id: 'n1', subgroup_id: 'sg1' });
    });

    test('returns null for unknown artifact_id', () => {
      const mgr = createManager();

      expect(mgr.getMapping('unknown')).toBeNull();
    });

    test('returns null for undefined', () => {
      const mgr = createManager();
      storeSampleMapping(mgr);

      expect(mgr.getMapping(undefined)).toBeNull();
    });

    test('returns null after clear()', () => {
      const mgr = createManager();
      storeSampleMapping(mgr, 'art-1');

      mgr.clear();

      expect(mgr.getMapping('art-1')).toBeNull();
    });

    test('returns the stored reference (not a copy)', () => {
      const mgr = createManager();
      storeSampleMapping(mgr, 'art-1', 'n1', 'sg1');

      const m1 = mgr.getMapping('art-1');
      const m2 = mgr.getMapping('art-1');

      expect(m1).toBe(m2);
    });
  });

  // =========================================================================
  // clear()
  // =========================================================================
  describe('clear', () => {
    test('removes all mappings', () => {
      const mgr = createManager();
      storeSampleMapping(mgr, 'art-1');
      storeSampleMapping(mgr, 'art-2', 'n2', 's2');

      mgr.clear();

      expect(mgr._mappings.size).toBe(0);
    });

    test('logs previous size', () => {
      const mgr = createManager();
      storeSampleMapping(mgr, 'a1');
      storeSampleMapping(mgr, 'a2', 'n2', 's2');
      mockLog.debug.mockClear();

      mgr.clear();

      expect(mockLog.debug).toHaveBeenCalledWith(
        'Cleared artifact trail mappings',
        { previousSize: 2 }
      );
    });

    test('logs previousSize 0 when already empty', () => {
      const mgr = createManager();
      mockLog.debug.mockClear();

      mgr.clear();

      expect(mockLog.debug).toHaveBeenCalledWith(
        'Cleared artifact trail mappings',
        { previousSize: 0 }
      );
    });

    test('can be called multiple times safely', () => {
      const mgr = createManager();
      storeSampleMapping(mgr);

      expect(() => {
        mgr.clear();
        mgr.clear();
      }).not.toThrow();
      expect(mgr._mappings.size).toBe(0);
    });

    test('allows new mappings after clear', () => {
      const mgr = createManager();
      storeSampleMapping(mgr, 'art-1');
      mgr.clear();

      storeSampleMapping(mgr, 'art-2', 'n2', 's2');

      expect(mgr._mappings.size).toBe(1);
      expect(mgr.hasMapping('art-2')).toBe(true);
      expect(mgr.hasMapping('art-1')).toBe(false);
    });
  });

  // =========================================================================
  // dispose()
  // =========================================================================
  describe('dispose', () => {
    test('clears all mappings', () => {
      const mgr = createManager();
      storeSampleMapping(mgr, 'art-1');
      storeSampleMapping(mgr, 'art-2', 'n2', 's2');

      mgr.dispose();

      expect(mgr._mappings.size).toBe(0);
    });

    test('can be called multiple times', () => {
      const mgr = createManager();
      storeSampleMapping(mgr);

      expect(() => {
        mgr.dispose();
        mgr.dispose();
      }).not.toThrow();
    });
  });

  // =========================================================================
  // Lifecycle integration
  // =========================================================================
  describe('lifecycle integration', () => {
    test('full lifecycle: create → store → enrich → clear → re-store → enrich → dispose', () => {
      const mgr = createManager();

      // Phase 1: store and enrich
      storeSampleMapping(mgr, 'art-1', 'n1', 'sg1');
      const p1 = mgr.enrich({ artifact_id: 'art-1', chunk: 'data' });
      expect(p1.node_id).toBe('n1');
      expect(p1.subgroup_id).toBe('sg1');

      // Phase 2: clear (chat switch)
      mgr.clear();
      const p2 = mgr.enrich({ artifact_id: 'art-1' });
      expect(p2).not.toHaveProperty('node_id');

      // Phase 3: re-store with different mapping
      storeSampleMapping(mgr, 'art-1', 'n2', 'sg2');
      const p3 = mgr.enrich({ artifact_id: 'art-1' });
      expect(p3.node_id).toBe('n2');
      expect(p3.subgroup_id).toBe('sg2');

      // Phase 4: dispose
      mgr.dispose();
      expect(mgr._mappings.size).toBe(0);
    });

    test('enrich is idempotent for same payload', () => {
      const mgr = createManager();
      storeSampleMapping(mgr, 'art-1', 'n1', 'sg1');

      const payload = { artifact_id: 'art-1' };
      mgr.enrich(payload);
      mgr.enrich(payload);

      expect(payload.node_id).toBe('n1');
      expect(payload.subgroup_id).toBe('sg1');
    });
  });

  // =========================================================================
  // Module exports
  // =========================================================================
  describe('module exports', () => {
    test('exports ArtifactEnrichmentManager constructor', () => {
      expect(typeof ArtifactEnrichmentManager).toBe('function');
    });

    test('instances have expected methods', () => {
      const mgr = createManager();
      expect(typeof mgr.storeMapping).toBe('function');
      expect(typeof mgr.enrich).toBe('function');
      expect(typeof mgr.hasMapping).toBe('function');
      expect(typeof mgr.getMapping).toBe('function');
      expect(typeof mgr.clear).toBe('function');
      expect(typeof mgr.dispose).toBe('function');
    });
  });
});
