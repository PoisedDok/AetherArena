/**
 * @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js
 */
'use strict';

/**
 * Trail artifact roundtrip - backend-authoritative replay model
 * ============================================================================
 * Trails are restored by replaying backend events (group_created/subgroup_created/
 * artifact_linked/etc). This test simulates reload by re-instantiating the
 * orchestrator and replaying the same event sequence, then verifying clicks
 * still emit the correct UI intent event.
 */

const { EventTypes } = require('../../src/core/events/EventTypes');
const TrailContainerOrchestrator = require('../../src/renderer/chat/modules/trail/TrailContainerOrchestrator');

function createEventBus() {
  return {
    emit: jest.fn(),
    on: jest.fn(() => () => {}),
    off: jest.fn(),
  };
}

function replayTrailEvents(orchestrator, { chatId, groupId, subgroupId, artifactId, container }) {
  // CRITICAL: Trail positioning requires at least one chat-entry with a lower
  // data-sequence in the DOM. Seed a user message entry at sequence=1.
  if (container && !container.querySelector('.chat-entry[data-sequence="1"]')) {
    const userEntry = document.createElement('div');
    userEntry.className = 'chat-entry message';
    userEntry.dataset.sequence = '1';
    userEntry.dataset.role = 'user';
    userEntry.dataset.messageId = 'msg_user_seed';
    userEntry.textContent = 'Seed user message';
    container.appendChild(userEntry);
  }

  orchestrator.handleGroupCreated({
    group_id: groupId,
    chat_id: chatId,
    sequence_number: 1,
    backend_id: 'backend_group_replay_aaaaaaaa',
  });

  orchestrator.handleSubgroupCreated({
    subgroup_id: subgroupId,
    group_id: groupId,
    chat_id: chatId,
    subgroup_sequence_number: 1,
    sequence_in_chat: 2,
    nodes: [
      { node_id: 'node_writing_replay_aaaaaaaa', type: 'writing', status: 'pending', clickable: false },
      { node_id: 'node_executing_replay_bbbbbbbb', type: 'executing', status: 'pending', clickable: false },
      { node_id: 'node_output_replay_cccccccc', type: 'output', status: 'pending', clickable: false },
    ],
  });

  orchestrator.handleArtifactLinked({
    artifact_id: artifactId,
    node_id: 'node_writing_replay_aaaaaaaa',
    subgroup_id: subgroupId,
    group_id: groupId,
    chat_id: chatId,
  });
}

describe('Trail artifact roundtrip (event replay)', () => {
  let container;

  beforeEach(() => {
    document.body.innerHTML = '<div id="chat-content" class="aether-chat-content"></div>';
    container = document.getElementById('chat-content');
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('restores node click routing after reload by replaying events', () => {
    const chatId = 'chat_roundtrip_aaaaaaaa';
    const groupId = 'group_roundtrip_bbbbbbbb';
    const subgroupId = 'subgroup_roundtrip_cccccccc';
    const artifactId = 'artifact_code_roundtrip_xxxxxxxxxxxxxxxxxxxxxxxx';

    // First run
    const eventBus1 = createEventBus();
    const orch1 = new TrailContainerOrchestrator({ container, eventBus: eventBus1, enableLogging: false });
    replayTrailEvents(orch1, { chatId, groupId, subgroupId, artifactId, container });

    const node1 = container.querySelector('[data-node-id="node_writing_replay_aaaaaaaa"]');
    expect(node1).toBeTruthy();
    node1.click();
    expect(eventBus1.emit).toHaveBeenCalledWith(
      EventTypes.TRAIL.NODE_CLICKED,
      expect.objectContaining({ artifactId, artifactType: 'code' })
    );

    orch1.destroy();

    // Simulated reload: clear DOM, replay events again
    container.innerHTML = '';
    const eventBus2 = createEventBus();
    const orch2 = new TrailContainerOrchestrator({ container, eventBus: eventBus2, enableLogging: false });
    replayTrailEvents(orch2, { chatId, groupId, subgroupId, artifactId, container });

    const node2 = container.querySelector('[data-node-id="node_writing_replay_aaaaaaaa"]');
    expect(node2).toBeTruthy();
    node2.click();
    expect(eventBus2.emit).toHaveBeenCalledWith(
      EventTypes.TRAIL.NODE_CLICKED,
      expect.objectContaining({ artifactId, artifactType: 'code' })
    );

    orch2.destroy();
  });
});

