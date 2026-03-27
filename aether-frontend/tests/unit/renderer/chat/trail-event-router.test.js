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

// Use REAL EventTypes — they are frozen constants, no need to mock
const { EventTypes } = require('../../../../src/core/events/EventTypes');

const TrailEventRouter = require(
  '../../../../src/renderer/chat/modules/trail/TrailEventRouter'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createOrchestrator() {
  return {
    handleGroupCreated: jest.fn(),
    handleSubgroupCreated: jest.fn(),
    handleSubgroupCompleted: jest.fn(),
    handleArtifactLinked: jest.fn(),
    handleNodeStatusUpdated: jest.fn(),
  };
}

function createEventBus() {
  const listeners = [];
  return {
    on: jest.fn((event, handler) => {
      const cleanup = jest.fn();
      listeners.push({ event, handler, cleanup });
      return cleanup;
    }),
    emit: jest.fn(),
    off: jest.fn(),
    _listeners: listeners,
  };
}

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
      { node_id: 'node-o-1', type: 'output', sequence: 2, clickable: true },
    ],
    ...overrides,
  };
}

function makeArtifactPayload(overrides = {}) {
  return {
    artifact_id: 'artifact-eee-555',
    node_id: 'node-w-1',
    subgroup_id: 'subgroup-ddd-444',
    artifact_type: 'code',
    backend_id: 'backend-fff-666',
    ...overrides,
  };
}

function makeNodeStatusPayload(overrides = {}) {
  return {
    node_id: 'node-w-1',
    status: 'active',
    subgroup_id: 'subgroup-ddd-444',
    ...overrides,
  };
}

function makeSubgroupCompletedPayload(overrides = {}) {
  return {
    subgroup_id: 'subgroup-ddd-444',
    group_id: 'group-aaa-111',
    chat_id: 'chat-bbb-222',
    ...overrides,
  };
}

function makeAgentSequencePayload(overrides = {}) {
  return {
    chat_id: 'chat-bbb-222',
    sequence_in_chat: 5,
    backend_id: 'backend-ggg-777',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TrailEventRouter', () => {
  let orchestrator;
  let eventBus;
  let router;

  beforeEach(() => {
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    mockLog.debug.mockClear();
    orchestrator = createOrchestrator();
    eventBus = createEventBus();
    router = new TrailEventRouter({ orchestrator, eventBus });
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('stores orchestrator reference', () => {
      expect(router.orchestrator).toBe(orchestrator);
    });

    it('stores eventBus reference', () => {
      expect(router.eventBus).toBe(eventBus);
    });

    it('throws when orchestrator is not provided', () => {
      expect(() => new TrailEventRouter({ eventBus })).toThrow('orchestrator is REQUIRED');
    });

    it('throws when eventBus is not provided', () => {
      expect(() => new TrailEventRouter({ orchestrator })).toThrow('eventBus is REQUIRED');
    });

    it('throws when no options provided', () => {
      expect(() => new TrailEventRouter()).toThrow('orchestrator is REQUIRED');
    });

    it('throws when options is empty object', () => {
      expect(() => new TrailEventRouter({})).toThrow('orchestrator is REQUIRED');
    });

    it('registers 6 EventBus listeners', () => {
      expect(eventBus.on).toHaveBeenCalledTimes(6);
    });

    it('stores 6 cleanup functions in listeners array', () => {
      expect(router.listeners).toHaveLength(6);
      router.listeners.forEach(cleanup => {
        expect(typeof cleanup).toBe('function');
      });
    });

    it('registers listener for GROUP_CREATED', () => {
      expect(eventBus.on).toHaveBeenCalledWith(
        EventTypes.TRAIL.GROUP_CREATED,
        expect.any(Function)
      );
    });

    it('registers listener for SUBGROUP_CREATED', () => {
      expect(eventBus.on).toHaveBeenCalledWith(
        EventTypes.TRAIL.SUBGROUP_CREATED,
        expect.any(Function)
      );
    });

    it('registers listener for SUBGROUP_COMPLETED', () => {
      expect(eventBus.on).toHaveBeenCalledWith(
        EventTypes.TRAIL.SUBGROUP_COMPLETED,
        expect.any(Function)
      );
    });

    it('registers listener for ARTIFACT_LINKED', () => {
      expect(eventBus.on).toHaveBeenCalledWith(
        EventTypes.TRAIL.ARTIFACT_LINKED,
        expect.any(Function)
      );
    });

    it('registers listener for NODE_STATUS_UPDATED', () => {
      expect(eventBus.on).toHaveBeenCalledWith(
        EventTypes.TRAIL.NODE_STATUS_UPDATED,
        expect.any(Function)
      );
    });

    it('registers listener for AGENT_MESSAGE_SEQUENCE', () => {
      expect(eventBus.on).toHaveBeenCalledWith(
        EventTypes.TRAIL.AGENT_MESSAGE_SEQUENCE,
        expect.any(Function)
      );
    });
  });

  // =========================================================================
  // handleGroupCreated
  // =========================================================================

  describe('handleGroupCreated', () => {
    it('delegates valid payload to orchestrator', () => {
      const payload = makeGroupPayload();
      router.handleGroupCreated(payload);
      expect(orchestrator.handleGroupCreated).toHaveBeenCalledWith(payload);
    });

    it('delegates once per call', () => {
      router.handleGroupCreated(makeGroupPayload());
      expect(orchestrator.handleGroupCreated).toHaveBeenCalledTimes(1);
    });

    it('throws when payload is null', () => {
      expect(() => router.handleGroupCreated(null)).toThrow('payload must be object');
    });

    it('throws when payload is undefined', () => {
      expect(() => router.handleGroupCreated(undefined)).toThrow('payload must be object');
    });

    it('throws when payload is string', () => {
      expect(() => router.handleGroupCreated('bad')).toThrow('payload must be object');
    });

    it('throws when payload is array', () => {
      expect(() => router.handleGroupCreated([])).toThrow('group_id (string) is REQUIRED');
    });

    it('throws when group_id is missing', () => {
      expect(() => router.handleGroupCreated(makeGroupPayload({ group_id: null }))).toThrow('group_id (string) is REQUIRED');
    });

    it('throws when group_id is not a string', () => {
      expect(() => router.handleGroupCreated(makeGroupPayload({ group_id: 123 }))).toThrow('group_id (string) is REQUIRED');
    });

    it('throws when group_id is empty string', () => {
      expect(() => router.handleGroupCreated(makeGroupPayload({ group_id: '' }))).toThrow('group_id (string) is REQUIRED');
    });

    it('throws when chat_id is missing', () => {
      expect(() => router.handleGroupCreated(makeGroupPayload({ chat_id: null }))).toThrow('chat_id (string) is REQUIRED');
    });

    it('throws when chat_id is not a string', () => {
      expect(() => router.handleGroupCreated(makeGroupPayload({ chat_id: 42 }))).toThrow('chat_id (string) is REQUIRED');
    });

    it('throws when sequence_number is not a number', () => {
      expect(() => router.handleGroupCreated(makeGroupPayload({ sequence_number: '1' }))).toThrow('sequence_number (number) is REQUIRED');
    });

    it('throws when sequence_number is undefined', () => {
      expect(() => router.handleGroupCreated(makeGroupPayload({ sequence_number: undefined }))).toThrow('sequence_number (number) is REQUIRED');
    });

    it('accepts sequence_number = 0 (valid number)', () => {
      expect(() => router.handleGroupCreated(makeGroupPayload({ sequence_number: 0 }))).not.toThrow();
    });

    it('throws when backend_id is missing', () => {
      expect(() => router.handleGroupCreated(makeGroupPayload({ backend_id: null }))).toThrow('backend_id (string) is REQUIRED');
    });

    it('throws when backend_id is empty string', () => {
      expect(() => router.handleGroupCreated(makeGroupPayload({ backend_id: '' }))).toThrow('backend_id (string) is REQUIRED');
    });

    it('does not delegate when validation fails', () => {
      try { router.handleGroupCreated(null); } catch (e) { /* expected */ }
      expect(orchestrator.handleGroupCreated).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // handleSubgroupCreated
  // =========================================================================

  describe('handleSubgroupCreated', () => {
    it('delegates valid payload to orchestrator', () => {
      const payload = makeSubgroupPayload();
      router.handleSubgroupCreated(payload);
      expect(orchestrator.handleSubgroupCreated).toHaveBeenCalledWith(payload);
    });

    it('throws when payload is null', () => {
      expect(() => router.handleSubgroupCreated(null)).toThrow('payload must be object');
    });

    it('throws when payload is not an object', () => {
      expect(() => router.handleSubgroupCreated(42)).toThrow('payload must be object');
    });

    it('throws when subgroup_id is missing', () => {
      expect(() => router.handleSubgroupCreated(makeSubgroupPayload({ subgroup_id: null }))).toThrow('subgroup_id (string) is REQUIRED');
    });

    it('throws when subgroup_id is not a string', () => {
      expect(() => router.handleSubgroupCreated(makeSubgroupPayload({ subgroup_id: 123 }))).toThrow('subgroup_id (string) is REQUIRED');
    });

    it('throws when group_id is missing', () => {
      expect(() => router.handleSubgroupCreated(makeSubgroupPayload({ group_id: null }))).toThrow('group_id (string) is REQUIRED');
    });

    it('throws when chat_id is missing', () => {
      expect(() => router.handleSubgroupCreated(makeSubgroupPayload({ chat_id: null }))).toThrow('chat_id (string) is REQUIRED');
    });

    it('throws when execution_group is missing', () => {
      expect(() => router.handleSubgroupCreated(makeSubgroupPayload({ execution_group: null }))).toThrow('execution_group (string) is REQUIRED');
    });

    it('throws when nodes is not an array', () => {
      expect(() => router.handleSubgroupCreated(makeSubgroupPayload({ nodes: 'bad' }))).toThrow('nodes (array) is REQUIRED');
    });

    it('throws when nodes is null', () => {
      expect(() => router.handleSubgroupCreated(makeSubgroupPayload({ nodes: null }))).toThrow('nodes (array) is REQUIRED');
    });

    it('throws when nodes.length !== 3 (too few)', () => {
      const nodes = [
        { node_id: 'n1', type: 'writing', sequence: 0, clickable: false },
      ];
      expect(() => router.handleSubgroupCreated(makeSubgroupPayload({ nodes }))).toThrow('expected 3 nodes, got 1');
    });

    it('throws when nodes.length !== 3 (too many)', () => {
      const nodes = [
        { node_id: 'n1', type: 'writing', sequence: 0, clickable: false },
        { node_id: 'n2', type: 'executing', sequence: 1, clickable: false },
        { node_id: 'n3', type: 'output', sequence: 2, clickable: false },
        { node_id: 'n4', type: 'extra', sequence: 3, clickable: false },
      ];
      expect(() => router.handleSubgroupCreated(makeSubgroupPayload({ nodes }))).toThrow('expected 3 nodes, got 4');
    });

    it('throws when nodes is empty array', () => {
      expect(() => router.handleSubgroupCreated(makeSubgroupPayload({ nodes: [] }))).toThrow('expected 3 nodes, got 0');
    });

    // Node structure validation
    it('throws when node.node_id is missing', () => {
      const nodes = [
        { type: 'writing', sequence: 0, clickable: false },
        { node_id: 'n2', type: 'executing', sequence: 1, clickable: false },
        { node_id: 'n3', type: 'output', sequence: 2, clickable: false },
      ];
      expect(() => router.handleSubgroupCreated(makeSubgroupPayload({ nodes }))).toThrow('nodes[0].node_id (string) is REQUIRED');
    });

    it('throws when node.type is missing', () => {
      const nodes = [
        { node_id: 'n1', sequence: 0, clickable: false },
        { node_id: 'n2', type: 'executing', sequence: 1, clickable: false },
        { node_id: 'n3', type: 'output', sequence: 2, clickable: false },
      ];
      expect(() => router.handleSubgroupCreated(makeSubgroupPayload({ nodes }))).toThrow('nodes[0].type (string) is REQUIRED');
    });

    it('throws when node.sequence is not a number', () => {
      const nodes = [
        { node_id: 'n1', type: 'writing', sequence: '0', clickable: false },
        { node_id: 'n2', type: 'executing', sequence: 1, clickable: false },
        { node_id: 'n3', type: 'output', sequence: 2, clickable: false },
      ];
      expect(() => router.handleSubgroupCreated(makeSubgroupPayload({ nodes }))).toThrow('nodes[0].sequence (number) is REQUIRED');
    });

    it('throws when node.clickable is not a boolean', () => {
      const nodes = [
        { node_id: 'n1', type: 'writing', sequence: 0, clickable: 'yes' },
        { node_id: 'n2', type: 'executing', sequence: 1, clickable: false },
        { node_id: 'n3', type: 'output', sequence: 2, clickable: false },
      ];
      expect(() => router.handleSubgroupCreated(makeSubgroupPayload({ nodes }))).toThrow('nodes[0].clickable (boolean) is REQUIRED');
    });

    it('validates node at index 2 (not just index 0)', () => {
      const nodes = [
        { node_id: 'n1', type: 'writing', sequence: 0, clickable: false },
        { node_id: 'n2', type: 'executing', sequence: 1, clickable: false },
        { node_id: 'n3', type: 'output', clickable: false }, // missing sequence
      ];
      expect(() => router.handleSubgroupCreated(makeSubgroupPayload({ nodes }))).toThrow('nodes[2].sequence (number) is REQUIRED');
    });

    it('does not delegate when validation fails', () => {
      try { router.handleSubgroupCreated(null); } catch (e) { /* expected */ }
      expect(orchestrator.handleSubgroupCreated).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // handleArtifactLinked
  // =========================================================================

  describe('handleArtifactLinked', () => {
    it('delegates valid payload to orchestrator', () => {
      const payload = makeArtifactPayload();
      router.handleArtifactLinked(payload);
      expect(orchestrator.handleArtifactLinked).toHaveBeenCalledWith(payload);
    });

    it('throws when payload is null', () => {
      expect(() => router.handleArtifactLinked(null)).toThrow('payload must be object');
    });

    it('throws when artifact_id is missing', () => {
      expect(() => router.handleArtifactLinked(makeArtifactPayload({ artifact_id: null }))).toThrow('artifact_id (string) is REQUIRED');
    });

    it('throws when artifact_id is not a string', () => {
      expect(() => router.handleArtifactLinked(makeArtifactPayload({ artifact_id: 42 }))).toThrow('artifact_id (string) is REQUIRED');
    });

    it('throws when node_id is missing', () => {
      expect(() => router.handleArtifactLinked(makeArtifactPayload({ node_id: null }))).toThrow('node_id (string) is REQUIRED');
    });

    it('throws when subgroup_id is missing', () => {
      expect(() => router.handleArtifactLinked(makeArtifactPayload({ subgroup_id: null }))).toThrow('subgroup_id (string) is REQUIRED');
    });

    it('throws when artifact_type is missing', () => {
      expect(() => router.handleArtifactLinked(makeArtifactPayload({ artifact_type: null }))).toThrow('artifact_type (string) is REQUIRED');
    });

    it('throws when artifact_type is invalid (not code/output)', () => {
      expect(() => router.handleArtifactLinked(makeArtifactPayload({ artifact_type: 'html' }))).toThrow("artifact_type must be 'code' or 'output', got 'html'");
    });

    it('accepts artifact_type "code"', () => {
      expect(() => router.handleArtifactLinked(makeArtifactPayload({ artifact_type: 'code' }))).not.toThrow();
    });

    it('accepts artifact_type "output"', () => {
      expect(() => router.handleArtifactLinked(makeArtifactPayload({ artifact_type: 'output' }))).not.toThrow();
    });

    it('does not delegate when validation fails', () => {
      try { router.handleArtifactLinked(null); } catch (e) { /* expected */ }
      expect(orchestrator.handleArtifactLinked).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // handleNodeStatusUpdated
  // =========================================================================

  describe('handleNodeStatusUpdated', () => {
    it('delegates valid payload to orchestrator', () => {
      const payload = makeNodeStatusPayload();
      router.handleNodeStatusUpdated(payload);
      expect(orchestrator.handleNodeStatusUpdated).toHaveBeenCalledWith(payload);
    });

    it('throws when payload is null', () => {
      expect(() => router.handleNodeStatusUpdated(null)).toThrow('payload must be object');
    });

    it('throws when node_id is missing', () => {
      expect(() => router.handleNodeStatusUpdated(makeNodeStatusPayload({ node_id: null }))).toThrow('node_id (string) is REQUIRED');
    });

    it('throws when status is missing', () => {
      expect(() => router.handleNodeStatusUpdated(makeNodeStatusPayload({ status: null }))).toThrow('status (string) is REQUIRED');
    });

    it('throws when subgroup_id is missing', () => {
      expect(() => router.handleNodeStatusUpdated(makeNodeStatusPayload({ subgroup_id: null }))).toThrow('subgroup_id (string) is REQUIRED');
    });

    it('throws when status is invalid', () => {
      expect(() => router.handleNodeStatusUpdated(makeNodeStatusPayload({ status: 'unknown' }))).toThrow("status must be one of pending, active, completed, error, got 'unknown'");
    });

    it('accepts status "pending"', () => {
      expect(() => router.handleNodeStatusUpdated(makeNodeStatusPayload({ status: 'pending' }))).not.toThrow();
    });

    it('accepts status "active"', () => {
      expect(() => router.handleNodeStatusUpdated(makeNodeStatusPayload({ status: 'active' }))).not.toThrow();
    });

    it('accepts status "completed"', () => {
      expect(() => router.handleNodeStatusUpdated(makeNodeStatusPayload({ status: 'completed' }))).not.toThrow();
    });

    it('accepts status "error"', () => {
      expect(() => router.handleNodeStatusUpdated(makeNodeStatusPayload({ status: 'error' }))).not.toThrow();
    });

    it('does not delegate when validation fails', () => {
      try { router.handleNodeStatusUpdated(null); } catch (e) { /* expected */ }
      expect(orchestrator.handleNodeStatusUpdated).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // handleSubgroupCompleted
  // =========================================================================

  describe('handleSubgroupCompleted', () => {
    it('delegates valid payload to orchestrator', () => {
      const payload = makeSubgroupCompletedPayload();
      router.handleSubgroupCompleted(payload);
      expect(orchestrator.handleSubgroupCompleted).toHaveBeenCalledWith(payload);
    });

    it('throws when payload is null', () => {
      expect(() => router.handleSubgroupCompleted(null)).toThrow('payload must be object');
    });

    it('throws when subgroup_id is missing', () => {
      expect(() => router.handleSubgroupCompleted(makeSubgroupCompletedPayload({ subgroup_id: null }))).toThrow('subgroup_id (string) is REQUIRED');
    });

    it('throws when group_id is missing', () => {
      expect(() => router.handleSubgroupCompleted(makeSubgroupCompletedPayload({ group_id: null }))).toThrow('group_id (string) is REQUIRED');
    });

    it('throws when chat_id is missing', () => {
      expect(() => router.handleSubgroupCompleted(makeSubgroupCompletedPayload({ chat_id: null }))).toThrow('chat_id (string) is REQUIRED');
    });

    it('does not delegate when validation fails', () => {
      try { router.handleSubgroupCompleted(null); } catch (e) { /* expected */ }
      expect(orchestrator.handleSubgroupCompleted).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // handleAgentMessageSequence
  // =========================================================================

  describe('handleAgentMessageSequence', () => {
    afterEach(() => {
      document.body.innerHTML = '';
    });

    it('throws when payload is null', () => {
      expect(() => router.handleAgentMessageSequence(null)).toThrow('payload must be object');
    });

    it('throws when chat_id is missing', () => {
      expect(() => router.handleAgentMessageSequence(makeAgentSequencePayload({ chat_id: null }))).toThrow('chat_id (string) is REQUIRED');
    });

    it('throws when sequence_in_chat is not a number', () => {
      expect(() => router.handleAgentMessageSequence(makeAgentSequencePayload({ sequence_in_chat: '5' }))).toThrow('sequence_in_chat (number) is REQUIRED');
    });

    it('throws when backend_id is missing', () => {
      expect(() => router.handleAgentMessageSequence(makeAgentSequencePayload({ backend_id: null }))).toThrow('backend_id (string) is REQUIRED');
    });

    it('sets sequence on element found by data-backend-id', () => {
      document.body.innerHTML = `
        <div class="chat-entry message" data-role="assistant" data-backend-id="backend-ggg-777" data-message-id="msg-1"></div>
      `;
      router.handleAgentMessageSequence(makeAgentSequencePayload());
      const el = document.querySelector('[data-backend-id="backend-ggg-777"]');
      expect(el.dataset.sequence).toBe('5');
    });

    it('falls back to most recent assistant message without sequence', () => {
      document.body.innerHTML = `
        <div class="chat-entry message" data-role="assistant" data-sequence="1" data-message-id="old"></div>
        <div class="chat-entry message" data-role="assistant" data-message-id="new"></div>
      `;
      router.handleAgentMessageSequence(makeAgentSequencePayload({ backend_id: 'no-match' }));
      const el = document.querySelector('[data-message-id="new"]');
      expect(el.dataset.sequence).toBe('5');
    });

    it('does not set sequence on already-sequenced messages in fallback', () => {
      document.body.innerHTML = `
        <div class="chat-entry message" data-role="assistant" data-sequence="1" data-message-id="old"></div>
      `;
      router.handleAgentMessageSequence(makeAgentSequencePayload({ backend_id: 'no-match' }));
      const el = document.querySelector('[data-message-id="old"]');
      expect(el.dataset.sequence).toBe('1'); // unchanged
    });

    it('handles no matching container gracefully (logs debug)', () => {
      document.body.innerHTML = '';
      expect(() => router.handleAgentMessageSequence(makeAgentSequencePayload())).not.toThrow();
    });

    it('accepts sequence_in_chat = 0', () => {
      document.body.innerHTML = `
        <div class="chat-entry message" data-role="assistant" data-backend-id="backend-ggg-777"></div>
      `;
      expect(() => router.handleAgentMessageSequence(makeAgentSequencePayload({ sequence_in_chat: 0 }))).not.toThrow();
      const el = document.querySelector('[data-backend-id="backend-ggg-777"]');
      expect(el.dataset.sequence).toBe('0');
    });

    it('prefers exact backend_id match over fallback', () => {
      document.body.innerHTML = `
        <div class="chat-entry message" data-role="assistant" data-message-id="fallback"></div>
        <div class="chat-entry message" data-role="assistant" data-backend-id="backend-ggg-777" data-message-id="exact"></div>
      `;
      router.handleAgentMessageSequence(makeAgentSequencePayload());
      const exact = document.querySelector('[data-message-id="exact"]');
      const fallback = document.querySelector('[data-message-id="fallback"]');
      expect(exact.dataset.sequence).toBe('5');
      expect(fallback.dataset.sequence).toBeUndefined();
    });
  });

  // =========================================================================
  // EventBus integration — handlers fire via registered listeners
  // =========================================================================

  describe('EventBus listener integration', () => {
    it('GROUP_CREATED listener delegates to handleGroupCreated', () => {
      const listener = eventBus._listeners.find(l => l.event === EventTypes.TRAIL.GROUP_CREATED);
      expect(listener).toBeDefined();
      const payload = makeGroupPayload();
      listener.handler(payload);
      expect(orchestrator.handleGroupCreated).toHaveBeenCalledWith(payload);
    });

    it('SUBGROUP_CREATED listener delegates to handleSubgroupCreated', () => {
      const listener = eventBus._listeners.find(l => l.event === EventTypes.TRAIL.SUBGROUP_CREATED);
      const payload = makeSubgroupPayload();
      listener.handler(payload);
      expect(orchestrator.handleSubgroupCreated).toHaveBeenCalledWith(payload);
    });

    it('ARTIFACT_LINKED listener delegates to handleArtifactLinked', () => {
      const listener = eventBus._listeners.find(l => l.event === EventTypes.TRAIL.ARTIFACT_LINKED);
      const payload = makeArtifactPayload();
      listener.handler(payload);
      expect(orchestrator.handleArtifactLinked).toHaveBeenCalledWith(payload);
    });

    it('NODE_STATUS_UPDATED listener delegates to handleNodeStatusUpdated', () => {
      const listener = eventBus._listeners.find(l => l.event === EventTypes.TRAIL.NODE_STATUS_UPDATED);
      const payload = makeNodeStatusPayload();
      listener.handler(payload);
      expect(orchestrator.handleNodeStatusUpdated).toHaveBeenCalledWith(payload);
    });

    it('SUBGROUP_COMPLETED listener delegates to handleSubgroupCompleted', () => {
      const listener = eventBus._listeners.find(l => l.event === EventTypes.TRAIL.SUBGROUP_COMPLETED);
      const payload = makeSubgroupCompletedPayload();
      listener.handler(payload);
      expect(orchestrator.handleSubgroupCompleted).toHaveBeenCalledWith(payload);
    });
  });

  // =========================================================================
  // destroy — BUG: Does not clean up listeners or null orchestrator
  // =========================================================================

  describe('destroy (BUG FIXES)', () => {
    it('calls all cleanup functions from listeners array', () => {
      const cleanups = [...router.listeners];
      router.destroy();
      cleanups.forEach(cleanup => {
        expect(cleanup).toHaveBeenCalled();
      });
    });

    it('empties listeners array after cleanup', () => {
      router.destroy();
      expect(router.listeners).toHaveLength(0);
    });

    it('nulls orchestrator reference (was referencing wrong property)', () => {
      router.destroy();
      expect(router.orchestrator).toBeNull();
    });

    it('nulls eventBus reference', () => {
      router.destroy();
      expect(router.eventBus).toBeNull();
    });

    it('can be called multiple times without error', () => {
      router.destroy();
      expect(() => router.destroy()).not.toThrow();
    });
  });

  // =========================================================================
  // Module exports
  // =========================================================================

  describe('module exports', () => {
    it('exports TrailEventRouter constructor', () => {
      expect(typeof TrailEventRouter).toBe('function');
    });

    it('instances have expected handler methods', () => {
      expect(typeof router.handleGroupCreated).toBe('function');
      expect(typeof router.handleSubgroupCreated).toBe('function');
      expect(typeof router.handleSubgroupCompleted).toBe('function');
      expect(typeof router.handleArtifactLinked).toBe('function');
      expect(typeof router.handleNodeStatusUpdated).toBe('function');
      expect(typeof router.handleAgentMessageSequence).toBe('function');
      expect(typeof router.destroy).toBe('function');
    });
  });
});
