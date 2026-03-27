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

const TrailStateManager = require(
  '../../../../src/renderer/chat/modules/trail/TrailStateManager'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGroupPayload(overrides = {}) {
  return {
    group_id: 'group-aaa-111',
    chat_id: 'chat-bbb-222',
    sequence_number: 1,
    backend_id: 'backend-ccc-333',
    ...overrides,
  };
}

function makeSubgroupPayload(overrides = {}) {
  return {
    subgroup_id: 'subgroup-ddd-444',
    group_id: 'group-aaa-111',
    chat_id: 'chat-bbb-222',
    execution_group: 'exec-1',
    nodes: [
      { node_id: 'node-w-1', type: 'writing', sequence: 0, clickable: false },
      { node_id: 'node-e-1', type: 'executing', sequence: 1, clickable: false },
      { node_id: 'node-o-1', type: 'output', sequence: 2, clickable: false },
    ],
    ...overrides,
  };
}

function makeNodeStatusPayload(overrides = {}) {
  return {
    node_id: 'node-w-1',
    status: 'active',
    subgroup_id: 'subgroup-ddd-444',
    group_id: 'group-aaa-111',
    chat_id: 'chat-bbb-222',
    ...overrides,
  };
}

function makeLinkArtifactPayload(overrides = {}) {
  return {
    artifact_id: 'artifact-eee-555',
    node_id: 'node-w-1',
    subgroup_id: 'subgroup-ddd-444',
    group_id: 'group-aaa-111',
    chat_id: 'chat-bbb-222',
    ...overrides,
  };
}

/**
 * Seed a full hierarchy (group + subgroup) for query/mutation tests
 */
function seedHierarchy(mgr, overrides = {}) {
  mgr.createGroup(makeGroupPayload(overrides));
  mgr.createSubgroup(makeSubgroupPayload(overrides));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TrailStateManager', () => {
  let mgr;

  beforeEach(() => {
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    mockLog.debug.mockClear();
    mgr = new TrailStateManager();
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('initializes with empty groups Map', () => {
      expect(mgr.groups).toBeInstanceOf(Map);
      expect(mgr.groups.size).toBe(0);
    });

    it('initializes active context as null', () => {
      expect(mgr._currentChatId).toBeNull();
      expect(mgr._activeGroupId).toBeNull();
      expect(mgr._activeSubgroupId).toBeNull();
    });

    it('accepts empty options', () => {
      expect(() => new TrailStateManager({})).not.toThrow();
    });

    it('accepts no arguments', () => {
      expect(() => new TrailStateManager()).not.toThrow();
    });
  });

  // =========================================================================
  // createGroup
  // =========================================================================

  describe('createGroup', () => {
    it('creates group with all required fields', () => {
      const group = mgr.createGroup(makeGroupPayload());
      expect(group).toEqual({
        id: 'group-aaa-111',
        chatId: 'chat-bbb-222',
        sequence_number: 1,
        backend_id: 'backend-ccc-333',
        subgroups: [],
      });
    });

    it('stores group in correct chat Map', () => {
      mgr.createGroup(makeGroupPayload());
      const chatGroups = mgr.groups.get('chat-bbb-222');
      expect(chatGroups).toBeInstanceOf(Map);
      expect(chatGroups.has('group-aaa-111')).toBe(true);
    });

    it('initializes chat groups Map if first group for chat', () => {
      expect(mgr.groups.has('chat-bbb-222')).toBe(false);
      mgr.createGroup(makeGroupPayload());
      expect(mgr.groups.has('chat-bbb-222')).toBe(true);
    });

    it('adds to existing chat groups Map', () => {
      mgr.createGroup(makeGroupPayload());
      mgr.createGroup(makeGroupPayload({ group_id: 'group-2', sequence_number: 2 }));
      const chatGroups = mgr.groups.get('chat-bbb-222');
      expect(chatGroups.size).toBe(2);
    });

    it('updates active context (chatId, groupId)', () => {
      mgr.createGroup(makeGroupPayload());
      expect(mgr._currentChatId).toBe('chat-bbb-222');
      expect(mgr._activeGroupId).toBe('group-aaa-111');
    });

    it('returns group with empty subgroups array', () => {
      const group = mgr.createGroup(makeGroupPayload());
      expect(group.subgroups).toEqual([]);
    });

    it('is idempotent — returns existing group if already exists', () => {
      const group1 = mgr.createGroup(makeGroupPayload());
      const group2 = mgr.createGroup(makeGroupPayload());
      expect(group1).toBe(group2);
    });

    it('handles sequence_number = 0 (valid)', () => {
      const group = mgr.createGroup(makeGroupPayload({ sequence_number: 0 }));
      expect(group.sequence_number).toBe(0);
    });

    it('handles negative sequence_number', () => {
      const group = mgr.createGroup(makeGroupPayload({ sequence_number: -1 }));
      expect(group.sequence_number).toBe(-1);
    });

    it('throws on missing group_id', () => {
      expect(() => mgr.createGroup(makeGroupPayload({ group_id: null }))).toThrow('Missing required fields');
    });

    it('throws on missing chat_id', () => {
      expect(() => mgr.createGroup(makeGroupPayload({ chat_id: null }))).toThrow('Missing required fields');
    });

    it('throws on missing backend_id', () => {
      expect(() => mgr.createGroup(makeGroupPayload({ backend_id: null }))).toThrow('Missing required fields');
    });

    it('throws on sequence_number not a number (string)', () => {
      expect(() => mgr.createGroup(makeGroupPayload({ sequence_number: '1' }))).toThrow('Missing required fields');
    });

    it('throws on sequence_number undefined', () => {
      expect(() => mgr.createGroup(makeGroupPayload({ sequence_number: undefined }))).toThrow('Missing required fields');
    });

    it('throws on empty string group_id', () => {
      expect(() => mgr.createGroup(makeGroupPayload({ group_id: '' }))).toThrow('Missing required fields');
    });

    it('throws on empty string chat_id', () => {
      expect(() => mgr.createGroup(makeGroupPayload({ chat_id: '' }))).toThrow('Missing required fields');
    });

    it('throws on empty string backend_id', () => {
      expect(() => mgr.createGroup(makeGroupPayload({ backend_id: '' }))).toThrow('Missing required fields');
    });

    it('does not throw when sequence_number is NaN (typeof NaN === "number")', () => {
      // NOTE: This is a contract gap — NaN passes the typeof check.
      // Backend guarantees valid numbers so this is acceptable,
      // but the test documents the behavior.
      const group = mgr.createGroup(makeGroupPayload({ sequence_number: NaN }));
      expect(group.sequence_number).toBeNaN();
    });
  });

  // =========================================================================
  // createSubgroup
  // =========================================================================

  describe('createSubgroup', () => {
    beforeEach(() => {
      mgr.createGroup(makeGroupPayload());
    });

    it('creates subgroup with 3 nodes', () => {
      const sg = mgr.createSubgroup(makeSubgroupPayload());
      expect(sg.nodes).toHaveLength(3);
    });

    it('maps backend node structure correctly', () => {
      const sg = mgr.createSubgroup(makeSubgroupPayload());
      expect(sg.nodes[0]).toEqual(expect.objectContaining({
        id: 'node-w-1',
        type: 'writing',
        status: 'pending',
        artifactId: null,
        clickable: false,
      }));
    });

    it('adds subgroup to parent group subgroups array', () => {
      mgr.createSubgroup(makeSubgroupPayload());
      const group = mgr.groups.get('chat-bbb-222').get('group-aaa-111');
      expect(group.subgroups).toHaveLength(1);
    });

    it('defaults node status to "pending" when not provided', () => {
      const nodes = [
        { node_id: 'n1', type: 'writing', sequence: 0, clickable: false },
        { node_id: 'n2', type: 'executing', sequence: 1, clickable: false },
        { node_id: 'n3', type: 'output', sequence: 2, clickable: false },
      ];
      const sg = mgr.createSubgroup(makeSubgroupPayload({ nodes }));
      sg.nodes.forEach(n => expect(n.status).toBe('pending'));
    });

    it('preserves explicit node status from backend', () => {
      const nodes = [
        { node_id: 'n1', type: 'writing', sequence: 0, clickable: false, status: 'completed' },
        { node_id: 'n2', type: 'executing', sequence: 1, clickable: false, status: 'active' },
        { node_id: 'n3', type: 'output', sequence: 2, clickable: false, status: 'error' },
      ];
      const sg = mgr.createSubgroup(makeSubgroupPayload({ nodes }));
      expect(sg.nodes[0].status).toBe('completed');
      expect(sg.nodes[1].status).toBe('active');
      expect(sg.nodes[2].status).toBe('error');
    });

    it('defaults clickable to false when not provided', () => {
      const nodes = [
        { node_id: 'n1', type: 'writing', sequence: 0 },
        { node_id: 'n2', type: 'executing', sequence: 1 },
        { node_id: 'n3', type: 'output', sequence: 2 },
      ];
      const sg = mgr.createSubgroup(makeSubgroupPayload({ nodes }));
      sg.nodes.forEach(n => expect(n.clickable).toBe(false));
    });

    it('preserves timing data (duration_ms, started_at, completed_at)', () => {
      const nodes = [
        { node_id: 'n1', type: 'writing', sequence: 0, clickable: false, duration_ms: 1200, started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:00:01.2Z' },
        { node_id: 'n2', type: 'executing', sequence: 1, clickable: false },
        { node_id: 'n3', type: 'output', sequence: 2, clickable: false },
      ];
      const sg = mgr.createSubgroup(makeSubgroupPayload({ nodes }));
      expect(sg.nodes[0].duration_ms).toBe(1200);
      expect(sg.nodes[0].started_at).toBe('2026-01-01T00:00:00Z');
      expect(sg.nodes[0].completed_at).toBe('2026-01-01T00:00:01.2Z');
    });

    it('preserves undefined timing data when not present', () => {
      const sg = mgr.createSubgroup(makeSubgroupPayload());
      expect(sg.nodes[0].duration_ms).toBeUndefined();
      expect(sg.nodes[0].started_at).toBeUndefined();
      expect(sg.nodes[0].completed_at).toBeUndefined();
    });

    it('updates active subgroupId', () => {
      mgr.createSubgroup(makeSubgroupPayload());
      expect(mgr._activeSubgroupId).toBe('subgroup-ddd-444');
    });

    it('returns created subgroup', () => {
      const sg = mgr.createSubgroup(makeSubgroupPayload());
      expect(sg.id).toBe('subgroup-ddd-444');
      expect(sg.groupId).toBe('group-aaa-111');
    });

    it('is idempotent — returns existing subgroup', () => {
      const sg1 = mgr.createSubgroup(makeSubgroupPayload());
      const sg2 = mgr.createSubgroup(makeSubgroupPayload());
      expect(sg1).toBe(sg2);
    });

    it('creates multiple subgroups in same group', () => {
      mgr.createSubgroup(makeSubgroupPayload({ subgroup_id: 'sg-1' }));
      mgr.createSubgroup(makeSubgroupPayload({ subgroup_id: 'sg-2' }));
      const group = mgr.groups.get('chat-bbb-222').get('group-aaa-111');
      expect(group.subgroups).toHaveLength(2);
    });

    it('throws on missing subgroup_id', () => {
      expect(() => mgr.createSubgroup(makeSubgroupPayload({ subgroup_id: null }))).toThrow('Missing required fields');
    });

    it('throws on missing group_id', () => {
      expect(() => mgr.createSubgroup(makeSubgroupPayload({ group_id: null }))).toThrow('Missing required fields');
    });

    it('throws on missing chat_id', () => {
      expect(() => mgr.createSubgroup(makeSubgroupPayload({ chat_id: null }))).toThrow('Missing required fields');
    });

    it('throws when nodes is not an array', () => {
      expect(() => mgr.createSubgroup(makeSubgroupPayload({ nodes: 'not-array' }))).toThrow('nodes array with 3 nodes');
    });

    it('throws when nodes is null', () => {
      expect(() => mgr.createSubgroup(makeSubgroupPayload({ nodes: null }))).toThrow('nodes array with 3 nodes');
    });

    it('throws when nodes.length !== 3 (too few)', () => {
      const nodes = [
        { node_id: 'n1', type: 'writing', sequence: 0, clickable: false },
      ];
      expect(() => mgr.createSubgroup(makeSubgroupPayload({ nodes }))).toThrow('nodes array with 3 nodes');
    });

    it('throws when nodes.length !== 3 (too many)', () => {
      const nodes = [
        { node_id: 'n1', type: 'writing', sequence: 0, clickable: false },
        { node_id: 'n2', type: 'executing', sequence: 1, clickable: false },
        { node_id: 'n3', type: 'output', sequence: 2, clickable: false },
        { node_id: 'n4', type: 'extra', sequence: 3, clickable: false },
      ];
      expect(() => mgr.createSubgroup(makeSubgroupPayload({ nodes }))).toThrow('nodes array with 3 nodes');
    });

    it('throws when nodes is empty array', () => {
      expect(() => mgr.createSubgroup(makeSubgroupPayload({ nodes: [] }))).toThrow('nodes array with 3 nodes');
    });

    it('throws when chat does not exist', () => {
      expect(() => mgr.createSubgroup(makeSubgroupPayload({ chat_id: 'nonexistent' }))).toThrow('Chat nonexistent not found');
    });

    it('throws when group does not exist', () => {
      expect(() => mgr.createSubgroup(makeSubgroupPayload({ group_id: 'nonexistent' }))).toThrow('Group nonexistent not found');
    });
  });

  // =========================================================================
  // updateNodeStatus
  // =========================================================================

  describe('updateNodeStatus', () => {
    beforeEach(() => {
      seedHierarchy(mgr);
    });

    it('updates node status', () => {
      const node = mgr.updateNodeStatus(makeNodeStatusPayload({ status: 'active' }));
      expect(node.status).toBe('active');
    });

    it('returns updated node object', () => {
      const node = mgr.updateNodeStatus(makeNodeStatusPayload());
      expect(node.id).toBe('node-w-1');
      expect(node.type).toBe('writing');
    });

    it('persists status change in state tree', () => {
      mgr.updateNodeStatus(makeNodeStatusPayload({ status: 'completed' }));
      const sg = mgr.getSubgroup('chat-bbb-222', 'group-aaa-111', 'subgroup-ddd-444');
      const node = sg.nodes.find(n => n.id === 'node-w-1');
      expect(node.status).toBe('completed');
    });

    it('updates different nodes independently', () => {
      mgr.updateNodeStatus(makeNodeStatusPayload({ node_id: 'node-w-1', status: 'active' }));
      mgr.updateNodeStatus(makeNodeStatusPayload({ node_id: 'node-e-1', status: 'completed' }));
      const sg = mgr.getSubgroup('chat-bbb-222', 'group-aaa-111', 'subgroup-ddd-444');
      expect(sg.nodes[0].status).toBe('active');
      expect(sg.nodes[1].status).toBe('completed');
      expect(sg.nodes[2].status).toBe('pending');
    });

    it('overwrites previous status', () => {
      mgr.updateNodeStatus(makeNodeStatusPayload({ status: 'active' }));
      mgr.updateNodeStatus(makeNodeStatusPayload({ status: 'completed' }));
      const sg = mgr.getSubgroup('chat-bbb-222', 'group-aaa-111', 'subgroup-ddd-444');
      const node = sg.nodes.find(n => n.id === 'node-w-1');
      expect(node.status).toBe('completed');
    });

    it('throws on missing node_id', () => {
      expect(() => mgr.updateNodeStatus(makeNodeStatusPayload({ node_id: null }))).toThrow('Missing required fields');
    });

    it('throws on missing status', () => {
      expect(() => mgr.updateNodeStatus(makeNodeStatusPayload({ status: null }))).toThrow('Missing required fields');
    });

    it('throws on missing subgroup_id', () => {
      expect(() => mgr.updateNodeStatus(makeNodeStatusPayload({ subgroup_id: null }))).toThrow('Missing required fields');
    });

    it('throws on missing group_id', () => {
      expect(() => mgr.updateNodeStatus(makeNodeStatusPayload({ group_id: null }))).toThrow('Missing required fields');
    });

    it('throws on missing chat_id', () => {
      expect(() => mgr.updateNodeStatus(makeNodeStatusPayload({ chat_id: null }))).toThrow('Missing required fields');
    });

    it('throws when chat does not exist', () => {
      expect(() => mgr.updateNodeStatus(makeNodeStatusPayload({ chat_id: 'nope' }))).toThrow('Chat nope not found');
    });

    it('throws when group does not exist', () => {
      expect(() => mgr.updateNodeStatus(makeNodeStatusPayload({ group_id: 'nope' }))).toThrow('Group nope not found');
    });

    it('throws when subgroup does not exist', () => {
      expect(() => mgr.updateNodeStatus(makeNodeStatusPayload({ subgroup_id: 'nope' }))).toThrow('Subgroup nope not found');
    });

    it('throws when node does not exist', () => {
      expect(() => mgr.updateNodeStatus(makeNodeStatusPayload({ node_id: 'nope' }))).toThrow('Node nope not found');
    });
  });

  // =========================================================================
  // linkArtifact
  // =========================================================================

  describe('linkArtifact', () => {
    beforeEach(() => {
      seedHierarchy(mgr);
    });

    it('links artifact_id to node', () => {
      const node = mgr.linkArtifact(makeLinkArtifactPayload());
      expect(node.artifactId).toBe('artifact-eee-555');
    });

    it('sets clickable to true', () => {
      const node = mgr.linkArtifact(makeLinkArtifactPayload());
      expect(node.clickable).toBe(true);
    });

    it('returns updated node', () => {
      const node = mgr.linkArtifact(makeLinkArtifactPayload());
      expect(node.id).toBe('node-w-1');
      expect(node.type).toBe('writing');
    });

    it('persists linkage in state tree', () => {
      mgr.linkArtifact(makeLinkArtifactPayload());
      const sg = mgr.getSubgroup('chat-bbb-222', 'group-aaa-111', 'subgroup-ddd-444');
      const node = sg.nodes.find(n => n.id === 'node-w-1');
      expect(node.artifactId).toBe('artifact-eee-555');
      expect(node.clickable).toBe(true);
    });

    it('overwrites previous artifact linkage', () => {
      mgr.linkArtifact(makeLinkArtifactPayload({ artifact_id: 'first' }));
      mgr.linkArtifact(makeLinkArtifactPayload({ artifact_id: 'second' }));
      const sg = mgr.getSubgroup('chat-bbb-222', 'group-aaa-111', 'subgroup-ddd-444');
      const node = sg.nodes.find(n => n.id === 'node-w-1');
      expect(node.artifactId).toBe('second');
    });

    it('throws on missing artifact_id', () => {
      expect(() => mgr.linkArtifact(makeLinkArtifactPayload({ artifact_id: null }))).toThrow('Missing required fields');
    });

    it('throws on missing node_id', () => {
      expect(() => mgr.linkArtifact(makeLinkArtifactPayload({ node_id: null }))).toThrow('Missing required fields');
    });

    it('throws on missing subgroup_id', () => {
      expect(() => mgr.linkArtifact(makeLinkArtifactPayload({ subgroup_id: null }))).toThrow('Missing required fields');
    });

    it('throws on missing group_id', () => {
      expect(() => mgr.linkArtifact(makeLinkArtifactPayload({ group_id: null }))).toThrow('Missing required fields');
    });

    it('throws on missing chat_id', () => {
      expect(() => mgr.linkArtifact(makeLinkArtifactPayload({ chat_id: null }))).toThrow('Missing required fields');
    });

    it('throws when node does not exist', () => {
      expect(() => mgr.linkArtifact(makeLinkArtifactPayload({ node_id: 'nope' }))).toThrow('Node nope not found');
    });
  });

  // =========================================================================
  // State Queries
  // =========================================================================

  describe('getChatGroups', () => {
    it('returns Map of groups for chat', () => {
      mgr.createGroup(makeGroupPayload());
      const result = mgr.getChatGroups('chat-bbb-222');
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(1);
    });

    it('returns null for unknown chat', () => {
      expect(mgr.getChatGroups('nonexistent')).toBeNull();
    });
  });

  describe('getAllGroupsForChat', () => {
    it('returns Map of groups', () => {
      mgr.createGroup(makeGroupPayload());
      const result = mgr.getAllGroupsForChat('chat-bbb-222');
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(1);
    });

    it('returns empty Map for unknown chat', () => {
      const result = mgr.getAllGroupsForChat('nonexistent');
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });
  });

  describe('getGroup', () => {
    it('returns group for valid chat/group', () => {
      mgr.createGroup(makeGroupPayload());
      const group = mgr.getGroup('chat-bbb-222', 'group-aaa-111');
      expect(group).not.toBeNull();
      expect(group.id).toBe('group-aaa-111');
    });

    it('returns null for unknown chat', () => {
      expect(mgr.getGroup('nope', 'group-aaa-111')).toBeNull();
    });

    it('returns null for unknown group', () => {
      mgr.createGroup(makeGroupPayload());
      expect(mgr.getGroup('chat-bbb-222', 'nope')).toBeNull();
    });
  });

  describe('getSubgroup', () => {
    beforeEach(() => {
      seedHierarchy(mgr);
    });

    it('returns subgroup for valid path', () => {
      const sg = mgr.getSubgroup('chat-bbb-222', 'group-aaa-111', 'subgroup-ddd-444');
      expect(sg).not.toBeNull();
      expect(sg.id).toBe('subgroup-ddd-444');
    });

    it('returns null for unknown group', () => {
      expect(mgr.getSubgroup('chat-bbb-222', 'nope', 'subgroup-ddd-444')).toBeNull();
    });

    it('returns null for unknown subgroup', () => {
      expect(mgr.getSubgroup('chat-bbb-222', 'group-aaa-111', 'nope')).toBeNull();
    });

    it('returns null for unknown chat', () => {
      expect(mgr.getSubgroup('nope', 'group-aaa-111', 'subgroup-ddd-444')).toBeNull();
    });
  });

  describe('getNode', () => {
    beforeEach(() => {
      seedHierarchy(mgr);
    });

    it('returns node for valid path', () => {
      const node = mgr.getNode('chat-bbb-222', 'group-aaa-111', 'subgroup-ddd-444', 'node-w-1');
      expect(node).not.toBeNull();
      expect(node.id).toBe('node-w-1');
      expect(node.type).toBe('writing');
    });

    it('returns null for invalid chat (does NOT throw)', () => {
      expect(mgr.getNode('nope', 'group-aaa-111', 'subgroup-ddd-444', 'node-w-1')).toBeNull();
    });

    it('returns null for invalid group (does NOT throw)', () => {
      expect(mgr.getNode('chat-bbb-222', 'nope', 'subgroup-ddd-444', 'node-w-1')).toBeNull();
    });

    it('returns null for invalid subgroup (does NOT throw)', () => {
      expect(mgr.getNode('chat-bbb-222', 'group-aaa-111', 'nope', 'node-w-1')).toBeNull();
    });

    it('returns null for invalid node (does NOT throw)', () => {
      expect(mgr.getNode('chat-bbb-222', 'group-aaa-111', 'subgroup-ddd-444', 'nope')).toBeNull();
    });
  });

  describe('getActiveContext', () => {
    it('returns null context initially', () => {
      expect(mgr.getActiveContext()).toEqual({
        chatId: null,
        groupId: null,
        subgroupId: null,
      });
    });

    it('returns chatId and groupId after createGroup', () => {
      mgr.createGroup(makeGroupPayload());
      const ctx = mgr.getActiveContext();
      expect(ctx.chatId).toBe('chat-bbb-222');
      expect(ctx.groupId).toBe('group-aaa-111');
      expect(ctx.subgroupId).toBeNull();
    });

    it('returns subgroupId after createSubgroup', () => {
      seedHierarchy(mgr);
      const ctx = mgr.getActiveContext();
      expect(ctx.subgroupId).toBe('subgroup-ddd-444');
    });

    it('tracks last created group/subgroup', () => {
      mgr.createGroup(makeGroupPayload({ group_id: 'g1' }));
      mgr.createGroup(makeGroupPayload({ group_id: 'g2', sequence_number: 2 }));
      expect(mgr.getActiveContext().groupId).toBe('g2');
    });
  });

  // =========================================================================
  // clearChatState
  // =========================================================================

  describe('clearChatState', () => {
    it('removes all groups for chat', () => {
      seedHierarchy(mgr);
      mgr.clearChatState('chat-bbb-222');
      expect(mgr.groups.has('chat-bbb-222')).toBe(false);
    });

    it('is no-op for unknown chat', () => {
      expect(() => mgr.clearChatState('nonexistent')).not.toThrow();
    });

    it('preserves other chat state', () => {
      seedHierarchy(mgr);
      mgr.createGroup(makeGroupPayload({ chat_id: 'chat-other', group_id: 'g-other' }));
      mgr.clearChatState('chat-bbb-222');
      expect(mgr.groups.has('chat-other')).toBe(true);
      expect(mgr.groups.has('chat-bbb-222')).toBe(false);
    });

    it('allows re-creating groups after clear', () => {
      seedHierarchy(mgr);
      mgr.clearChatState('chat-bbb-222');
      mgr.createGroup(makeGroupPayload());
      expect(mgr.groups.get('chat-bbb-222').size).toBe(1);
    });
  });

  // =========================================================================
  // _getNode (private, tested via public methods)
  // =========================================================================

  describe('_getNode (internal)', () => {
    beforeEach(() => {
      seedHierarchy(mgr);
    });

    it('throws when chat not found', () => {
      expect(() => mgr._getNode('nope', 'g', 's', 'n')).toThrow('Chat nope not found');
    });

    it('throws when group not found', () => {
      expect(() => mgr._getNode('chat-bbb-222', 'nope', 's', 'n')).toThrow('Group nope not found');
    });

    it('throws when subgroup not found', () => {
      expect(() => mgr._getNode('chat-bbb-222', 'group-aaa-111', 'nope', 'n')).toThrow('Subgroup nope not found');
    });

    it('throws when node not found', () => {
      expect(() => mgr._getNode('chat-bbb-222', 'group-aaa-111', 'subgroup-ddd-444', 'nope')).toThrow('Node nope not found');
    });

    it('returns node when found', () => {
      const node = mgr._getNode('chat-bbb-222', 'group-aaa-111', 'subgroup-ddd-444', 'node-w-1');
      expect(node.id).toBe('node-w-1');
    });
  });

  // =========================================================================
  // Lifecycle / Integration
  // =========================================================================

  describe('lifecycle integration', () => {
    it('full hierarchy: create → populate → query → mutate → clear → re-create', () => {
      // 1. Create group
      const group = mgr.createGroup(makeGroupPayload());
      expect(group.subgroups).toHaveLength(0);

      // 2. Create subgroup with nodes
      const sg = mgr.createSubgroup(makeSubgroupPayload());
      expect(sg.nodes).toHaveLength(3);
      expect(sg.nodes.every(n => n.status === 'pending')).toBe(true);

      // 3. Update node statuses
      mgr.updateNodeStatus(makeNodeStatusPayload({ node_id: 'node-w-1', status: 'active' }));
      mgr.updateNodeStatus(makeNodeStatusPayload({ node_id: 'node-w-1', status: 'completed' }));
      mgr.updateNodeStatus(makeNodeStatusPayload({ node_id: 'node-e-1', status: 'active' }));

      // 4. Link artifact
      mgr.linkArtifact(makeLinkArtifactPayload({
        artifact_id: 'art-code-1',
        node_id: 'node-w-1',
      }));

      // 5. Query
      const queriedNode = mgr.getNode('chat-bbb-222', 'group-aaa-111', 'subgroup-ddd-444', 'node-w-1');
      expect(queriedNode.status).toBe('completed');
      expect(queriedNode.artifactId).toBe('art-code-1');
      expect(queriedNode.clickable).toBe(true);

      // 6. Clear
      mgr.clearChatState('chat-bbb-222');
      expect(mgr.getChatGroups('chat-bbb-222')).toBeNull();

      // 7. Re-create
      mgr.createGroup(makeGroupPayload());
      const freshGroup = mgr.getGroup('chat-bbb-222', 'group-aaa-111');
      expect(freshGroup.subgroups).toHaveLength(0);
    });

    it('multi-chat state isolation', () => {
      // Chat A
      mgr.createGroup(makeGroupPayload({ chat_id: 'chat-A', group_id: 'g-A' }));
      mgr.createSubgroup(makeSubgroupPayload({
        chat_id: 'chat-A', group_id: 'g-A', subgroup_id: 'sg-A',
      }));

      // Chat B
      mgr.createGroup(makeGroupPayload({ chat_id: 'chat-B', group_id: 'g-B' }));
      mgr.createSubgroup(makeSubgroupPayload({
        chat_id: 'chat-B', group_id: 'g-B', subgroup_id: 'sg-B',
      }));

      // Verify isolation
      expect(mgr.getChatGroups('chat-A').size).toBe(1);
      expect(mgr.getChatGroups('chat-B').size).toBe(1);
      expect(mgr.getSubgroup('chat-A', 'g-A', 'sg-A')).not.toBeNull();
      expect(mgr.getSubgroup('chat-B', 'g-B', 'sg-B')).not.toBeNull();
      expect(mgr.getSubgroup('chat-A', 'g-A', 'sg-B')).toBeNull();
      expect(mgr.getSubgroup('chat-B', 'g-B', 'sg-A')).toBeNull();

      // Clear chat A, B unaffected
      mgr.clearChatState('chat-A');
      expect(mgr.getChatGroups('chat-A')).toBeNull();
      expect(mgr.getChatGroups('chat-B').size).toBe(1);
    });

    it('multiple groups and subgroups in same chat', () => {
      mgr.createGroup(makeGroupPayload({ group_id: 'g1', sequence_number: 1 }));
      mgr.createGroup(makeGroupPayload({ group_id: 'g2', sequence_number: 2 }));

      mgr.createSubgroup(makeSubgroupPayload({ group_id: 'g1', subgroup_id: 'sg1a' }));
      mgr.createSubgroup(makeSubgroupPayload({ group_id: 'g1', subgroup_id: 'sg1b' }));
      mgr.createSubgroup(makeSubgroupPayload({ group_id: 'g2', subgroup_id: 'sg2a' }));

      const g1 = mgr.getGroup('chat-bbb-222', 'g1');
      const g2 = mgr.getGroup('chat-bbb-222', 'g2');
      expect(g1.subgroups).toHaveLength(2);
      expect(g2.subgroups).toHaveLength(1);
    });
  });

  // =========================================================================
  // BUG: Missing dispose() method
  // =========================================================================

  describe('dispose (BUG FIX)', () => {
    it('dispose() exists and clears all state', () => {
      seedHierarchy(mgr);
      expect(mgr.groups.size).toBeGreaterThan(0);

      mgr.dispose();

      expect(mgr.groups.size).toBe(0);
      expect(mgr._currentChatId).toBeNull();
      expect(mgr._activeGroupId).toBeNull();
      expect(mgr._activeSubgroupId).toBeNull();
    });

    it('dispose() is idempotent', () => {
      seedHierarchy(mgr);
      mgr.dispose();
      expect(() => mgr.dispose()).not.toThrow();
      expect(mgr.groups.size).toBe(0);
    });

    it('allows re-use after dispose (no _isDisposed guard needed for stateless manager)', () => {
      seedHierarchy(mgr);
      mgr.dispose();
      mgr.createGroup(makeGroupPayload());
      expect(mgr.groups.size).toBe(1);
    });
  });

  // =========================================================================
  // Module exports
  // =========================================================================

  describe('module exports', () => {
    it('exports TrailStateManager constructor', () => {
      expect(typeof TrailStateManager).toBe('function');
      expect(new TrailStateManager()).toBeInstanceOf(TrailStateManager);
    });

    it('instances have expected methods', () => {
      expect(typeof mgr.createGroup).toBe('function');
      expect(typeof mgr.createSubgroup).toBe('function');
      expect(typeof mgr.updateNodeStatus).toBe('function');
      expect(typeof mgr.linkArtifact).toBe('function');
      expect(typeof mgr.getChatGroups).toBe('function');
      expect(typeof mgr.getAllGroupsForChat).toBe('function');
      expect(typeof mgr.getGroup).toBe('function');
      expect(typeof mgr.getSubgroup).toBe('function');
      expect(typeof mgr.getNode).toBe('function');
      expect(typeof mgr.getActiveContext).toBe('function');
      expect(typeof mgr.clearChatState).toBe('function');
    });
  });
});
