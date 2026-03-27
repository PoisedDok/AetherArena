'use strict';

const mockLog = {
  info: () => {},
  warn: jest.fn(),
  error: jest.fn(),
  debug: () => {},
  trace: () => {},
};
mockLog.child = () => mockLog;

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

const SessionMapRestorer = require(
  '../../../../src/renderer/chat/controllers/modules/SessionMapRestorer'
);

function createOrchestrator(messageCount = 2) {
  // Build DOM with message elements
  const container = document.createElement('div');
  for (let i = 0; i < messageCount; i++) {
    const el = document.createElement('div');
    el.classList.add('chat-entry', 'message');
    el.dataset.messageId = `msg-${i}`;
    container.appendChild(el);
  }

  const groups = new Map();
  const stateManager = {
    clearChatState: jest.fn(),
    getGroup: jest.fn((chatId, groupId) => groups.get(groupId) || null),
    createGroup: jest.fn((data) => {
      groups.set(data.group_id, data);
    }),
  };
  const handleSubgroupCreated = jest.fn();
  const handleArtifactLinked = jest.fn();
  const handleSubgroupCompleted = jest.fn();

  return {
    container,
    stateManager,
    handleSubgroupCreated,
    handleArtifactLinked,
    handleSubgroupCompleted,
    _groups: groups,
  };
}

function createSessionMap(trailEvents = [], messageEvents = []) {
  return {
    timeline: [
      ...messageEvents.map((m, i) => ({ type: 'message', sequence: i + 1, ...m })),
      ...trailEvents.map((t, i) => ({
        type: 'trail',
        sequence: messageEvents.length + i + 1,
        group_id: `grp-${i}`,
        subgroup_id: `sg-${i}`,
        execution_group: `exec-${i}`,
        group_sequence: 1,
        subgroup_sequence: i + 1,
        status: 'completed',
        nodes: [
          {
            node_id: `node-${i}-0`,
            type: 'code',
            sequence: 1,
            clickable: true,
            status: 'completed',
          },
        ],
        ...t,
      })),
    ],
  };
}

describe('SessionMapRestorer', () => {
  let restorer;

  beforeEach(() => {
    restorer = new SessionMapRestorer();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
  });

  // =========================================================================
  // restore - guard clauses
  // =========================================================================

  describe('restore guard clauses', () => {
    it('returns when sessionMap is null', () => {
      restorer.restore('chat-1', null, createOrchestrator());
      expect(mockLog.warn).toHaveBeenCalledWith('Invalid session map structure');
    });

    it('returns when timeline is not an array', () => {
      restorer.restore('chat-1', { timeline: 'not-array' }, createOrchestrator());
      expect(mockLog.warn).toHaveBeenCalledWith('Invalid session map structure');
    });

    it('returns when orchestrator is null', () => {
      restorer.restore('chat-1', { timeline: [] }, null);
      expect(mockLog.warn).toHaveBeenCalledWith('TrailContainerOrchestrator not available');
    });

    it('returns early when no trail events in timeline', () => {
      const orchestrator = createOrchestrator();
      restorer.restore('chat-1', { timeline: [{ type: 'message', sequence: 1 }] }, orchestrator);
      expect(orchestrator.handleSubgroupCreated).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // restore - annotation and trail processing
  // =========================================================================

  describe('restore trail processing', () => {
    it('annotates DOM messages with sequence numbers', () => {
      const orchestrator = createOrchestrator(2);
      const sessionMap = createSessionMap(
        [{ nodes: [{ node_id: 'n1', type: 'code', sequence: 1, status: 'completed' }] }],
        [{}, {}] // 2 message events
      );

      restorer.restore('chat-12345678', sessionMap, orchestrator);

      const messages = orchestrator.container.querySelectorAll('.chat-entry.message');
      expect(messages[0].dataset.sequence).toBe('1');
      expect(messages[1].dataset.sequence).toBe('2');
    });

    it('creates group in stateManager when not already present', () => {
      const orchestrator = createOrchestrator(0);
      const sessionMap = createSessionMap([{
        group_id: 'grp-new',
        subgroup_id: 'sg-new',
        nodes: [{ node_id: 'n1', type: 'code', sequence: 1, status: 'completed' }],
      }]);

      restorer.restore('chat-12345678', sessionMap, orchestrator);

      expect(orchestrator.stateManager.createGroup).toHaveBeenCalledWith(expect.objectContaining({
        group_id: 'grp-new',
        chat_id: 'chat-12345678',
      }));
    });

    it('does not re-create existing group', () => {
      const orchestrator = createOrchestrator(0);
      orchestrator._groups.set('grp-existing', { group_id: 'grp-existing' });
      orchestrator.stateManager.getGroup.mockReturnValue({ group_id: 'grp-existing' });

      const sessionMap = createSessionMap([{
        group_id: 'grp-existing',
        nodes: [{ node_id: 'n1', type: 'code', sequence: 1, status: 'completed' }],
      }]);

      restorer.restore('chat-12345678', sessionMap, orchestrator);

      expect(orchestrator.stateManager.createGroup).not.toHaveBeenCalled();
    });

    it('calls handleSubgroupCreated with correct structure', () => {
      const orchestrator = createOrchestrator(0);
      const sessionMap = createSessionMap([{
        group_id: 'grp-1',
        subgroup_id: 'sg-1',
        execution_group: 'exec-1',
        subgroup_sequence: 3,
        sequence: 10,
        duration_ms: 500,
        status: 'completed',
        nodes: [
          { node_id: 'n1', type: 'code', sequence: 1, clickable: false, status: 'completed', duration_ms: 100 },
        ],
      }]);

      restorer.restore('chat-12345678', sessionMap, orchestrator);

      expect(orchestrator.handleSubgroupCreated).toHaveBeenCalledWith(expect.objectContaining({
        subgroup_id: 'sg-1',
        group_id: 'grp-1',
        chat_id: 'chat-12345678',
        execution_group: 'exec-1',
        _restored: true,
        _timelineSequence: 10,
        _duration_ms: 500,
        subgroup_sequence: 3,
      }));

      const passedNodes = orchestrator.handleSubgroupCreated.mock.calls[0][0].nodes;
      expect(passedNodes[0]).toEqual({
        node_id: 'n1',
        type: 'code',
        sequence: 1,
        clickable: false,
        status: 'completed',
        started_at: undefined,
        completed_at: undefined,
        duration_ms: 100,
      });
    });

    it('links artifacts to nodes when artifact_id is present', () => {
      const orchestrator = createOrchestrator(0);
      const sessionMap = createSessionMap([{
        group_id: 'grp-1',
        subgroup_id: 'sg-1',
        nodes: [
          { node_id: 'n1', type: 'code', artifact_id: 'art-1', sequence: 1, status: 'completed' },
          { node_id: 'n2', type: 'output', sequence: 2, status: 'completed' }, // no artifact
        ],
      }]);

      restorer.restore('chat-12345678', sessionMap, orchestrator);

      expect(orchestrator.handleArtifactLinked).toHaveBeenCalledTimes(1);
      expect(orchestrator.handleArtifactLinked).toHaveBeenCalledWith(expect.objectContaining({
        artifact_id: 'art-1',
        node_id: 'n1',
        subgroup_id: 'sg-1',
        group_id: 'grp-1',
        artifact_type: 'code',
      }));
    });

    it('calls handleSubgroupCompleted only for completed trails', () => {
      const orchestrator = createOrchestrator(0);
      const sessionMap = createSessionMap([
        {
          group_id: 'grp-1', subgroup_id: 'sg-done', status: 'completed',
          nodes: [{ node_id: 'n1', type: 'code', sequence: 1, status: 'completed' }],
        },
        {
          group_id: 'grp-2', subgroup_id: 'sg-pending', status: 'pending',
          nodes: [{ node_id: 'n2', type: 'code', sequence: 1, status: 'pending' }],
        },
      ]);

      restorer.restore('chat-12345678', sessionMap, orchestrator);

      expect(orchestrator.handleSubgroupCompleted).toHaveBeenCalledTimes(1);
      expect(orchestrator.handleSubgroupCompleted).toHaveBeenCalledWith(expect.objectContaining({
        subgroup_id: 'sg-done',
      }));
    });

    it('handles multiple trail events in order', () => {
      const orchestrator = createOrchestrator(0);
      const sessionMap = createSessionMap([
        {
          group_id: 'grp-a', subgroup_id: 'sg-a', sequence: 5,
          nodes: [{ node_id: 'na', type: 'code', sequence: 1, status: 'completed' }],
        },
        {
          group_id: 'grp-b', subgroup_id: 'sg-b', sequence: 3,
          nodes: [{ node_id: 'nb', type: 'output', sequence: 1, status: 'completed' }],
        },
      ]);

      restorer.restore('chat-12345678', sessionMap, orchestrator);

      // Trail events are sorted by sequence, so sg-b (seq 3) should be processed first
      const calls = orchestrator.handleSubgroupCreated.mock.calls;
      expect(calls).toHaveLength(2);
    });
  });

  // =========================================================================
  // _annotateAndFilterTimeline - edge cases
  // =========================================================================

  describe('annotation edge cases', () => {
    it('handles DOM/timeline count mismatch without crashing', () => {
      const orchestrator = createOrchestrator(3); // 3 DOM messages
      const sessionMap = createSessionMap(
        [{ nodes: [{ node_id: 'n1', type: 'code', sequence: 1, status: 'completed' }] }],
        [{}, {}] // only 2 timeline messages
      );

      restorer.restore('chat-12345678', sessionMap, orchestrator);

      expect(mockLog.warn).toHaveBeenCalledWith(
        'Message count mismatch between DOM and timeline',
        expect.objectContaining({ domCount: 3, timelineCount: 2 })
      );
      // Still annotates the minimum number
      const messages = orchestrator.container.querySelectorAll('.chat-entry.message');
      expect(messages[0].dataset.sequence).toBe('1');
      expect(messages[1].dataset.sequence).toBe('2');
      expect(messages[2].dataset.sequence).toBeUndefined();
    });

    it('handles zero DOM messages', () => {
      const orchestrator = createOrchestrator(0);
      const sessionMap = createSessionMap(
        [{ nodes: [{ node_id: 'n1', type: 'code', sequence: 1, status: 'completed' }] }],
        [{}]
      );

      restorer.restore('chat-12345678', sessionMap, orchestrator);
      expect(orchestrator.handleSubgroupCreated).toHaveBeenCalled(); // Still processes trails
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  describe('error handling', () => {
    it('catches per-trail errors without stopping the loop', () => {
      const orchestrator = createOrchestrator(0);
      orchestrator.handleSubgroupCreated
        .mockImplementationOnce(() => { throw new Error('Subgroup error'); })
        .mockImplementationOnce(() => {});

      const sessionMap = createSessionMap([
        {
          group_id: 'grp-fail', subgroup_id: 'sg-fail',
          nodes: [{ node_id: 'n1', type: 'code', sequence: 1, status: 'completed' }],
        },
        {
          group_id: 'grp-ok', subgroup_id: 'sg-ok',
          nodes: [{ node_id: 'n2', type: 'output', sequence: 1, status: 'completed' }],
        },
      ]);

      restorer.restore('chat-12345678', sessionMap, orchestrator);

      expect(mockLog.error).toHaveBeenCalledWith('Failed to restore trail', expect.objectContaining({
        error: 'Subgroup error',
      }));
      // Second trail still processed
      expect(orchestrator.handleSubgroupCreated).toHaveBeenCalledTimes(2);
    });

    it('clears chat state before restoration', () => {
      const orchestrator = createOrchestrator(0);
      const sessionMap = createSessionMap([{
        nodes: [{ node_id: 'n1', type: 'code', sequence: 1, status: 'completed' }],
      }]);

      restorer.restore('chat-12345678', sessionMap, orchestrator);

      expect(orchestrator.stateManager.clearChatState).toHaveBeenCalledWith('chat-12345678');
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    it('does not throw', () => {
      expect(() => restorer.dispose()).not.toThrow();
    });
  });
});
