'use strict';

// ---------------------------------------------------------------------------
// Logger mock — self-contained in factory to avoid jest.mock hoisting issues
// ---------------------------------------------------------------------------
jest.mock('../../../../src/renderer/shared/utils/logger', () => {
  const noop = () => {};
  const makeLogger = () => {
    const log = { info: noop, warn: noop, error: noop, debug: noop, trace: noop };
    log.child = () => log;
    return log;
  };
  return { createRendererLogger: makeLogger };
});

const TrailStateManager = require(
  '../../../../src/renderer/chat/modules/trail/TrailStateManager'
);

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/**
 * Create a fresh TrailStateManager instance.
 */
function createManager(opts = {}) {
  return new TrailStateManager(opts);
}

/**
 * Build a valid createGroup payload.
 */
function groupPayload(overrides = {}) {
  return {
    group_id: 'group-1',
    chat_id: 'chat-1',
    sequence_number: 1,
    backend_id: 'backend-1',
    ...overrides,
  };
}

/**
 * Build a valid createSubgroup payload with 3 nodes.
 */
function subgroupPayload(overrides = {}) {
  return {
    subgroup_id: 'sg-1',
    group_id: 'group-1',
    chat_id: 'chat-1',
    nodes: [
      { node_id: 'node-w', type: 'writing', status: 'pending', clickable: false },
      { node_id: 'node-e', type: 'executing', status: 'pending', clickable: false },
      { node_id: 'node-o', type: 'output', status: 'pending', clickable: false },
    ],
    ...overrides,
  };
}

/**
 * Build a valid updateNodeStatus payload.
 */
function nodeStatusPayload(overrides = {}) {
  return {
    node_id: 'node-w',
    status: 'active',
    subgroup_id: 'sg-1',
    group_id: 'group-1',
    chat_id: 'chat-1',
    ...overrides,
  };
}

/**
 * Build a valid linkArtifact payload.
 */
function linkPayload(overrides = {}) {
  return {
    artifact_id: 'artifact-xyz-1234567890-abcdef12345678',
    node_id: 'node-o',
    subgroup_id: 'sg-1',
    group_id: 'group-1',
    chat_id: 'chat-1',
    ...overrides,
  };
}

/**
 * Seed a manager with a group + subgroup (common setup for node-level tests).
 */
function seedManager(mgr) {
  mgr.createGroup(groupPayload());
  mgr.createSubgroup(subgroupPayload());
  return mgr;
}

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe('TrailStateManager', () => {

  // =========================================================================
  // constructor
  // =========================================================================
  describe('constructor', () => {
    it('initializes empty groups Map', () => {
      const mgr = createManager();
      expect(mgr.groups).toBeInstanceOf(Map);
      expect(mgr.groups.size).toBe(0);
    });

    it('initializes active context to null', () => {
      const mgr = createManager();
      expect(mgr._currentChatId).toBeNull();
      expect(mgr._activeGroupId).toBeNull();
      expect(mgr._activeSubgroupId).toBeNull();
    });

    it('has a log property', () => {
      const mgr = createManager();
      expect(mgr.log).toBeDefined();
      expect(typeof mgr.log.info).toBe('function');
    });
  });

  // =========================================================================
  // clearChatState
  // =========================================================================
  describe('clearChatState', () => {
    it('deletes chat groups from the map', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());
      expect(mgr.groups.has('chat-1')).toBe(true);

      mgr.clearChatState('chat-1');
      expect(mgr.groups.has('chat-1')).toBe(false);
    });

    it('does not throw when chat has no state', () => {
      const mgr = createManager();
      expect(() => mgr.clearChatState('nonexistent')).not.toThrow();
    });

    it('leaves other chats untouched', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());
      mgr.createGroup(groupPayload({ chat_id: 'chat-2', group_id: 'g2' }));

      mgr.clearChatState('chat-1');
      expect(mgr.groups.has('chat-1')).toBe(false);
      expect(mgr.groups.has('chat-2')).toBe(true);
    });
  });

  // =========================================================================
  // createGroup
  // =========================================================================
  describe('createGroup', () => {
    it('throws when group_id is missing', () => {
      const mgr = createManager();
      expect(() => mgr.createGroup(groupPayload({ group_id: '' }))).toThrow('Missing required fields');
    });

    it('throws when chat_id is missing', () => {
      const mgr = createManager();
      expect(() => mgr.createGroup(groupPayload({ chat_id: '' }))).toThrow('Missing required fields');
    });

    it('throws when sequence_number is not a number', () => {
      const mgr = createManager();
      expect(() => mgr.createGroup(groupPayload({ sequence_number: '1' }))).toThrow('Missing required fields');
    });

    it('throws when backend_id is missing', () => {
      const mgr = createManager();
      expect(() => mgr.createGroup(groupPayload({ backend_id: '' }))).toThrow('Missing required fields');
    });

    it('creates a new chat groups map if one does not exist', () => {
      const mgr = createManager();
      expect(mgr.groups.has('chat-1')).toBe(false);

      mgr.createGroup(groupPayload());
      expect(mgr.groups.has('chat-1')).toBe(true);
      expect(mgr.groups.get('chat-1')).toBeInstanceOf(Map);
    });

    it('creates the group state object', () => {
      const mgr = createManager();
      const group = mgr.createGroup(groupPayload());

      expect(group).toEqual({
        id: 'group-1',
        chatId: 'chat-1',
        sequence_number: 1,
        backend_id: 'backend-1',
        subgroups: [],
      });
    });

    it('stores the group in the chat groups map', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());

      const chatGroups = mgr.groups.get('chat-1');
      expect(chatGroups.has('group-1')).toBe(true);
    });

    it('sets active context to the new group', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());

      expect(mgr._currentChatId).toBe('chat-1');
      expect(mgr._activeGroupId).toBe('group-1');
    });

    it('returns existing group idempotently when called twice with same group_id', () => {
      const mgr = createManager();
      const first = mgr.createGroup(groupPayload());
      const second = mgr.createGroup(groupPayload());

      expect(second).toBe(first); // same reference
    });

    it('supports multiple groups in the same chat', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());
      mgr.createGroup(groupPayload({ group_id: 'group-2', sequence_number: 2, backend_id: 'backend-2' }));

      const chatGroups = mgr.groups.get('chat-1');
      expect(chatGroups.size).toBe(2);
      expect(chatGroups.has('group-1')).toBe(true);
      expect(chatGroups.has('group-2')).toBe(true);
    });

    it('supports groups across different chats', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());
      mgr.createGroup(groupPayload({ chat_id: 'chat-2', group_id: 'group-x' }));

      expect(mgr.groups.size).toBe(2);
      expect(mgr.groups.get('chat-1').has('group-1')).toBe(true);
      expect(mgr.groups.get('chat-2').has('group-x')).toBe(true);
    });
  });

  // =========================================================================
  // createSubgroup
  // =========================================================================
  describe('createSubgroup', () => {
    it('throws when subgroup_id is missing', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());
      expect(() => mgr.createSubgroup(subgroupPayload({ subgroup_id: '' }))).toThrow('Missing required fields');
    });

    it('throws when group_id is missing', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());
      expect(() => mgr.createSubgroup(subgroupPayload({ group_id: '' }))).toThrow('Missing required fields');
    });

    it('throws when chat_id is missing', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());
      expect(() => mgr.createSubgroup(subgroupPayload({ chat_id: '' }))).toThrow('Missing required fields');
    });

    it('throws when nodes is null', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());
      expect(() => mgr.createSubgroup(subgroupPayload({ nodes: null }))).toThrow('nodes array with 3 nodes');
    });

    it('throws when nodes is not an array', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());
      expect(() => mgr.createSubgroup(subgroupPayload({ nodes: 'bad' }))).toThrow('nodes array with 3 nodes');
    });

    it('throws when nodes array length is not 3', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());
      expect(() => mgr.createSubgroup(subgroupPayload({
        nodes: [{ node_id: 'n1', type: 'writing' }],
      }))).toThrow('nodes array with 3 nodes');
    });

    it('throws when chat does not exist', () => {
      const mgr = createManager();
      expect(() => mgr.createSubgroup(subgroupPayload({ chat_id: 'missing-chat' }))).toThrow('Chat missing-chat not found');
    });

    it('throws when group does not exist in chat', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());
      expect(() => mgr.createSubgroup(subgroupPayload({ group_id: 'missing-group' }))).toThrow('Group missing-group not found');
    });

    it('creates a subgroup with mapped nodes', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());

      const sg = mgr.createSubgroup(subgroupPayload());

      expect(sg.id).toBe('sg-1');
      expect(sg.groupId).toBe('group-1');
      expect(sg.nodes).toHaveLength(3);
      expect(sg.nodes[0]).toEqual({
        id: 'node-w',
        type: 'writing',
        status: 'pending',
        artifactId: null,
        clickable: false,
        duration_ms: undefined,
        started_at: undefined,
        completed_at: undefined,
      });
    });

    it('maps timing data from backend nodes', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());

      const sg = mgr.createSubgroup(subgroupPayload({
        nodes: [
          { node_id: 'n1', type: 'writing', status: 'completed', clickable: true, duration_ms: 500, started_at: 1000, completed_at: 1500 },
          { node_id: 'n2', type: 'executing', status: 'active' },
          { node_id: 'n3', type: 'output', status: 'pending' },
        ],
      }));

      expect(sg.nodes[0].duration_ms).toBe(500);
      expect(sg.nodes[0].started_at).toBe(1000);
      expect(sg.nodes[0].completed_at).toBe(1500);
    });

    it('defaults node status to "pending" when not provided', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());

      const sg = mgr.createSubgroup(subgroupPayload({
        nodes: [
          { node_id: 'n1', type: 'writing' },
          { node_id: 'n2', type: 'executing' },
          { node_id: 'n3', type: 'output' },
        ],
      }));

      sg.nodes.forEach(n => expect(n.status).toBe('pending'));
    });

    it('defaults node clickable to false when not provided', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());

      const sg = mgr.createSubgroup(subgroupPayload({
        nodes: [
          { node_id: 'n1', type: 'writing' },
          { node_id: 'n2', type: 'executing' },
          { node_id: 'n3', type: 'output' },
        ],
      }));

      sg.nodes.forEach(n => expect(n.clickable).toBe(false));
    });

    it('adds subgroup to group.subgroups array', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());
      mgr.createSubgroup(subgroupPayload());

      const group = mgr.groups.get('chat-1').get('group-1');
      expect(group.subgroups).toHaveLength(1);
      expect(group.subgroups[0].id).toBe('sg-1');
    });

    it('sets _activeSubgroupId', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());
      mgr.createSubgroup(subgroupPayload());

      expect(mgr._activeSubgroupId).toBe('sg-1');
    });

    it('returns existing subgroup idempotently when called twice', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());
      const first = mgr.createSubgroup(subgroupPayload());
      const second = mgr.createSubgroup(subgroupPayload());

      expect(second).toBe(first);
    });

    it('supports multiple subgroups in the same group', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());
      mgr.createSubgroup(subgroupPayload());
      mgr.createSubgroup(subgroupPayload({ subgroup_id: 'sg-2' }));

      const group = mgr.groups.get('chat-1').get('group-1');
      expect(group.subgroups).toHaveLength(2);
    });
  });

  // =========================================================================
  // updateNodeStatus
  // =========================================================================
  describe('updateNodeStatus', () => {
    it('throws when node_id is missing', () => {
      const mgr = seedManager(createManager());
      expect(() => mgr.updateNodeStatus(nodeStatusPayload({ node_id: '' }))).toThrow('Missing required fields');
    });

    it('throws when status is missing', () => {
      const mgr = seedManager(createManager());
      expect(() => mgr.updateNodeStatus(nodeStatusPayload({ status: '' }))).toThrow('Missing required fields');
    });

    it('throws when subgroup_id is missing', () => {
      const mgr = seedManager(createManager());
      expect(() => mgr.updateNodeStatus(nodeStatusPayload({ subgroup_id: '' }))).toThrow('Missing required fields');
    });

    it('throws when group_id is missing', () => {
      const mgr = seedManager(createManager());
      expect(() => mgr.updateNodeStatus(nodeStatusPayload({ group_id: '' }))).toThrow('Missing required fields');
    });

    it('throws when chat_id is missing', () => {
      const mgr = seedManager(createManager());
      expect(() => mgr.updateNodeStatus(nodeStatusPayload({ chat_id: '' }))).toThrow('Missing required fields');
    });

    it('updates the node status', () => {
      const mgr = seedManager(createManager());

      const node = mgr.updateNodeStatus(nodeStatusPayload({ status: 'active' }));
      expect(node.status).toBe('active');
    });

    it('returns the updated node', () => {
      const mgr = seedManager(createManager());

      const node = mgr.updateNodeStatus(nodeStatusPayload({ status: 'completed' }));
      expect(node.id).toBe('node-w');
      expect(node.status).toBe('completed');
    });

    it('throws when node path is invalid (via _getNode)', () => {
      const mgr = seedManager(createManager());
      expect(() => mgr.updateNodeStatus(nodeStatusPayload({ node_id: 'nonexistent' }))).toThrow('Node nonexistent not found');
    });
  });

  // =========================================================================
  // linkArtifact
  // =========================================================================
  describe('linkArtifact', () => {
    it('throws when artifact_id is missing', () => {
      const mgr = seedManager(createManager());
      expect(() => mgr.linkArtifact(linkPayload({ artifact_id: '' }))).toThrow('Missing required fields');
    });

    it('throws when node_id is missing', () => {
      const mgr = seedManager(createManager());
      expect(() => mgr.linkArtifact(linkPayload({ node_id: '' }))).toThrow('Missing required fields');
    });

    it('throws when subgroup_id is missing', () => {
      const mgr = seedManager(createManager());
      expect(() => mgr.linkArtifact(linkPayload({ subgroup_id: '' }))).toThrow('Missing required fields');
    });

    it('throws when group_id is missing', () => {
      const mgr = seedManager(createManager());
      expect(() => mgr.linkArtifact(linkPayload({ group_id: '' }))).toThrow('Missing required fields');
    });

    it('throws when chat_id is missing', () => {
      const mgr = seedManager(createManager());
      expect(() => mgr.linkArtifact(linkPayload({ chat_id: '' }))).toThrow('Missing required fields');
    });

    it('sets artifactId on the node', () => {
      const mgr = seedManager(createManager());

      const node = mgr.linkArtifact(linkPayload());
      expect(node.artifactId).toBe('artifact-xyz-1234567890-abcdef12345678');
    });

    it('sets clickable to true', () => {
      const mgr = seedManager(createManager());

      const node = mgr.linkArtifact(linkPayload());
      expect(node.clickable).toBe(true);
    });

    it('returns the updated node', () => {
      const mgr = seedManager(createManager());

      const node = mgr.linkArtifact(linkPayload());
      expect(node.id).toBe('node-o');
    });

    it('throws when node path is invalid (via _getNode)', () => {
      const mgr = seedManager(createManager());
      expect(() => mgr.linkArtifact(linkPayload({ node_id: 'nonexistent' }))).toThrow('Node nonexistent not found');
    });
  });

  // =========================================================================
  // getChatGroups
  // =========================================================================
  describe('getChatGroups', () => {
    it('returns the groups map for a chat', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());

      const result = mgr.getChatGroups('chat-1');
      expect(result).toBeInstanceOf(Map);
      expect(result.has('group-1')).toBe(true);
    });

    it('returns null for an unknown chat', () => {
      const mgr = createManager();
      expect(mgr.getChatGroups('nonexistent')).toBeNull();
    });
  });

  // =========================================================================
  // getAllGroupsForChat
  // =========================================================================
  describe('getAllGroupsForChat', () => {
    it('returns the groups map for a chat', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());

      const result = mgr.getAllGroupsForChat('chat-1');
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(1);
    });

    it('returns empty Map for an unknown chat', () => {
      const mgr = createManager();
      const result = mgr.getAllGroupsForChat('nonexistent');
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });
  });

  // =========================================================================
  // getGroup
  // =========================================================================
  describe('getGroup', () => {
    it('returns the group when it exists', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());

      const group = mgr.getGroup('chat-1', 'group-1');
      expect(group).not.toBeNull();
      expect(group.id).toBe('group-1');
    });

    it('returns null when chat does not exist', () => {
      const mgr = createManager();
      expect(mgr.getGroup('nonexistent', 'group-1')).toBeNull();
    });

    it('returns null when group does not exist in chat', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());

      expect(mgr.getGroup('chat-1', 'nonexistent')).toBeNull();
    });
  });

  // =========================================================================
  // getSubgroup
  // =========================================================================
  describe('getSubgroup', () => {
    it('returns the subgroup when it exists', () => {
      const mgr = seedManager(createManager());

      const sg = mgr.getSubgroup('chat-1', 'group-1', 'sg-1');
      expect(sg).not.toBeNull();
      expect(sg.id).toBe('sg-1');
    });

    it('returns null when group does not exist', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());

      expect(mgr.getSubgroup('chat-1', 'nonexistent', 'sg-1')).toBeNull();
    });

    it('returns null when subgroup does not exist', () => {
      const mgr = seedManager(createManager());
      expect(mgr.getSubgroup('chat-1', 'group-1', 'nonexistent')).toBeNull();
    });

    it('returns null when chat does not exist (via getGroup returning null)', () => {
      const mgr = createManager();
      expect(mgr.getSubgroup('nonexistent', 'group-1', 'sg-1')).toBeNull();
    });
  });

  // =========================================================================
  // getNode (public)
  // =========================================================================
  describe('getNode', () => {
    it('returns the node when full path is valid', () => {
      const mgr = seedManager(createManager());

      const node = mgr.getNode('chat-1', 'group-1', 'sg-1', 'node-w');
      expect(node).not.toBeNull();
      expect(node.id).toBe('node-w');
      expect(node.type).toBe('writing');
    });

    it('returns null when chat does not exist', () => {
      const mgr = seedManager(createManager());
      expect(mgr.getNode('nonexistent', 'group-1', 'sg-1', 'node-w')).toBeNull();
    });

    it('returns null when group does not exist', () => {
      const mgr = seedManager(createManager());
      expect(mgr.getNode('chat-1', 'nonexistent', 'sg-1', 'node-w')).toBeNull();
    });

    it('returns null when subgroup does not exist', () => {
      const mgr = seedManager(createManager());
      expect(mgr.getNode('chat-1', 'group-1', 'nonexistent', 'node-w')).toBeNull();
    });

    it('returns null when node does not exist', () => {
      const mgr = seedManager(createManager());
      expect(mgr.getNode('chat-1', 'group-1', 'sg-1', 'nonexistent')).toBeNull();
    });
  });

  // =========================================================================
  // getActiveContext
  // =========================================================================
  describe('getActiveContext', () => {
    it('returns all-null context on fresh manager', () => {
      const mgr = createManager();
      expect(mgr.getActiveContext()).toEqual({
        chatId: null,
        groupId: null,
        subgroupId: null,
      });
    });

    it('reflects context after creating group', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());

      expect(mgr.getActiveContext()).toEqual({
        chatId: 'chat-1',
        groupId: 'group-1',
        subgroupId: null,
      });
    });

    it('reflects context after creating subgroup', () => {
      const mgr = seedManager(createManager());

      expect(mgr.getActiveContext()).toEqual({
        chatId: 'chat-1',
        groupId: 'group-1',
        subgroupId: 'sg-1',
      });
    });
  });

  // =========================================================================
  // _getNode (private — tested via exceptions for full branch coverage)
  // =========================================================================
  describe('_getNode', () => {
    it('throws when chat is not found', () => {
      const mgr = createManager();
      expect(() => mgr._getNode('missing', 'g', 's', 'n')).toThrow('Chat missing not found');
    });

    it('throws when group is not found', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());
      expect(() => mgr._getNode('chat-1', 'missing', 's', 'n')).toThrow('Group missing not found');
    });

    it('throws when subgroup is not found', () => {
      const mgr = createManager();
      mgr.createGroup(groupPayload());
      expect(() => mgr._getNode('chat-1', 'group-1', 'missing', 'n')).toThrow('Subgroup missing not found');
    });

    it('throws when node is not found', () => {
      const mgr = seedManager(createManager());
      expect(() => mgr._getNode('chat-1', 'group-1', 'sg-1', 'missing')).toThrow('Node missing not found');
    });

    it('returns the node when full path is valid', () => {
      const mgr = seedManager(createManager());
      const node = mgr._getNode('chat-1', 'group-1', 'sg-1', 'node-e');
      expect(node.id).toBe('node-e');
      expect(node.type).toBe('executing');
    });
  });

  // =========================================================================
  // Integration
  // =========================================================================
  describe('integration', () => {
    it('full lifecycle: create → mutate → query → clear', () => {
      const mgr = createManager();

      // 1. Create group
      const group = mgr.createGroup(groupPayload());
      expect(group.subgroups).toHaveLength(0);

      // 2. Create subgroup with 3 nodes
      const sg = mgr.createSubgroup(subgroupPayload());
      expect(sg.nodes).toHaveLength(3);
      expect(group.subgroups).toHaveLength(1);

      // 3. Update writing node to active
      mgr.updateNodeStatus(nodeStatusPayload({ node_id: 'node-w', status: 'active' }));
      expect(mgr.getNode('chat-1', 'group-1', 'sg-1', 'node-w').status).toBe('active');

      // 4. Complete writing node
      mgr.updateNodeStatus(nodeStatusPayload({ node_id: 'node-w', status: 'completed' }));
      expect(mgr.getNode('chat-1', 'group-1', 'sg-1', 'node-w').status).toBe('completed');

      // 5. Link artifact to output node
      mgr.linkArtifact(linkPayload({ node_id: 'node-o' }));
      const outputNode = mgr.getNode('chat-1', 'group-1', 'sg-1', 'node-o');
      expect(outputNode.artifactId).toBe('artifact-xyz-1234567890-abcdef12345678');
      expect(outputNode.clickable).toBe(true);

      // 6. Query state
      expect(mgr.getChatGroups('chat-1').size).toBe(1);
      expect(mgr.getGroup('chat-1', 'group-1')).toBe(group);
      expect(mgr.getSubgroup('chat-1', 'group-1', 'sg-1')).toBe(sg);
      expect(mgr.getActiveContext()).toEqual({
        chatId: 'chat-1',
        groupId: 'group-1',
        subgroupId: 'sg-1',
      });

      // 7. Clear state
      mgr.clearChatState('chat-1');
      expect(mgr.getChatGroups('chat-1')).toBeNull();
      expect(mgr.groups.size).toBe(0);
    });

    it('multi-chat isolation', () => {
      const mgr = createManager();

      mgr.createGroup(groupPayload());
      mgr.createSubgroup(subgroupPayload());

      mgr.createGroup(groupPayload({ chat_id: 'chat-2', group_id: 'g2' }));
      mgr.createSubgroup(subgroupPayload({ chat_id: 'chat-2', group_id: 'g2', subgroup_id: 'sg-2' }));

      // Both chats have independent state
      expect(mgr.groups.size).toBe(2);
      expect(mgr.getChatGroups('chat-1').size).toBe(1);
      expect(mgr.getChatGroups('chat-2').size).toBe(1);

      // Clearing one does not affect the other
      mgr.clearChatState('chat-1');
      expect(mgr.getChatGroups('chat-1')).toBeNull();
      expect(mgr.getChatGroups('chat-2').size).toBe(1);
    });

    it('idempotent create does not duplicate data', () => {
      const mgr = createManager();

      mgr.createGroup(groupPayload());
      mgr.createGroup(groupPayload()); // idempotent

      mgr.createSubgroup(subgroupPayload());
      mgr.createSubgroup(subgroupPayload()); // idempotent

      const chatGroups = mgr.getChatGroups('chat-1');
      expect(chatGroups.size).toBe(1);
      expect(chatGroups.get('group-1').subgroups).toHaveLength(1);
    });
  });
});
