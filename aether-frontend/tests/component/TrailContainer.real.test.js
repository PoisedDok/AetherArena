/**
 * @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js
 */
'use strict';

/**
 * TrailContainerOrchestrator Tests - Event-Driven Trail Rendering
 * ============================================================================
 * Legacy TrailContainerManager was removed. Trails are now rendered by
 * TrailContainerOrchestrator in response to backend trail events.
 */

const { EventTypes } = require('../../src/core/events/EventTypes');
const TrailContainerOrchestrator = require('../../src/renderer/chat/modules/trail/TrailContainerOrchestrator');

describe('TrailContainerOrchestrator - Real Trail Behavior', () => {
  let orchestrator;
  let chatContainer;
  let mockEventBus;

  function createEventBus() {
    return {
      emit: jest.fn(),
      on: jest.fn(() => () => {}),
      off: jest.fn(),
    };
  }

  /**
   * Seed the DOM with a user message entry (sequence=1) so that trail
   * timeline positioning has a valid insertion point.
   * Then create group and subgroup at sequence_in_chat=2.
   */
  function seedGroupAndSubgroup({ chatId = 'chat_aaaaaaaa', groupId = 'group_aaaaaaaaaaaa', subgroupId = 'subgroup_bbbbbbbbb' } = {}) {
    // CRITICAL: Trail positioning requires at least one chat-entry with a
    // lower data-sequence in the DOM. Simulate the user message that triggered
    // the agent execution.
    const userEntry = document.createElement('div');
    userEntry.className = 'chat-entry message';
    userEntry.dataset.sequence = '1';
    userEntry.dataset.role = 'user';
    userEntry.dataset.messageId = 'msg_user_seed';
    userEntry.textContent = 'Seed user message';
    chatContainer.appendChild(userEntry);

    orchestrator.handleGroupCreated({
      group_id: groupId,
      chat_id: chatId,
      sequence_number: 1,
      backend_id: 'backend_group_aaaaaaaa',
    });

    orchestrator.handleSubgroupCreated({
      subgroup_id: subgroupId,
      group_id: groupId,
      chat_id: chatId,
      subgroup_sequence_number: 1,
      sequence_in_chat: 2,
      nodes: [
        { node_id: 'node_writing_aaaaaaaa', type: 'writing', status: 'pending', clickable: false },
        { node_id: 'node_executing_bbbbbbbb', type: 'executing', status: 'pending', clickable: false },
        { node_id: 'node_output_cccccccc', type: 'output', status: 'pending', clickable: false },
      ],
    });

    return { chatId, groupId, subgroupId };
  }

  beforeEach(() => {
    chatContainer = document.createElement('div');
    chatContainer.id = 'chat-content';
    chatContainer.className = 'aether-chat-content';
    document.body.appendChild(chatContainer);

    mockEventBus = createEventBus();

    orchestrator = new TrailContainerOrchestrator({
      container: chatContainer,
      eventBus: mockEventBus,
      enableLogging: false,
    });
  });

  afterEach(() => {
    if (orchestrator) {
      orchestrator.destroy();
      orchestrator = null;
    }
    if (chatContainer && chatContainer.parentNode) {
      chatContainer.parentNode.removeChild(chatContainer);
    }
  });

  test('renders a trail container with 3 nodes on subgroup_created', () => {
    const { chatId, groupId, subgroupId } = seedGroupAndSubgroup();

    const trail = chatContainer.querySelector('.artifact-execution-trail-container');
    expect(trail).toBeTruthy();
    expect(trail.dataset.chatId).toBe(chatId);
    expect(trail.dataset.groupId).toBe(groupId);
    expect(trail.dataset.subgroupId).toBe(subgroupId);

    const nodes = trail.querySelectorAll('.execution-node');
    expect(nodes.length).toBe(3);

    const writingNode = trail.querySelector('[data-node-id="node_writing_aaaaaaaa"]');
    expect(writingNode).toBeTruthy();
    expect(writingNode.dataset.nodeType).toBe('writing');
  });

  test('links artifact and emits TRAIL.NODE_CLICKED on node click', () => {
    const { chatId, groupId, subgroupId } = seedGroupAndSubgroup();

    orchestrator.handleArtifactLinked({
      artifact_id: 'artifact_code_roundtrip_xxxxxxxxxxxxxxxxxxxxxxxx',
      node_id: 'node_writing_aaaaaaaa',
      subgroup_id: subgroupId,
      group_id: groupId,
      chat_id: chatId,
    });

    const node = chatContainer.querySelector('[data-node-id="node_writing_aaaaaaaa"]');
    expect(node).toBeTruthy();

    node.click();

    expect(mockEventBus.emit).toHaveBeenCalledWith(
      EventTypes.TRAIL.NODE_CLICKED,
      expect.objectContaining({
        artifactId: 'artifact_code_roundtrip_xxxxxxxxxxxxxxxxxxxxxxxx',
        artifactType: 'code',
        nodeId: 'node_writing_aaaaaaaa',
        subgroupId,
      })
    );
  });

  test('updates node status class on node_status_updated', () => {
    const { chatId, groupId, subgroupId } = seedGroupAndSubgroup();

    orchestrator.handleNodeStatusUpdated({
      node_id: 'node_writing_aaaaaaaa',
      status: 'active',
      subgroup_id: subgroupId,
      group_id: groupId,
      chat_id: chatId,
    });

    const node = chatContainer.querySelector('[data-node-id="node_writing_aaaaaaaa"]');
    expect(node).toBeTruthy();
    expect(node.classList.contains('active')).toBe(true);
  });

  test('subgroup_completed collapses the trail', () => {
    const { groupId, subgroupId } = seedGroupAndSubgroup();

    const trail = chatContainer.querySelector('.artifact-execution-trail-container');
    expect(trail).toBeTruthy();

    orchestrator.handleSubgroupCompleted({
      subgroup_id: subgroupId,
      group_id: groupId,
    });

    expect(trail.dataset.state).toBe('collapsed');
  });
});

