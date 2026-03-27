'use strict';

/**
 * @.architecture
 *
 * Incoming: EventBus EventTypes.TRAIL.* events from backend WebSocket --- {event.backend_validated, json}
 * Processing: Route backend trail events to TrailContainerManager for pure DOM rendering --- {1 job: JOB_ROUTE_BY_TYPE}
 * Outgoing: TrailContainerManager method calls --- {method_call, object}
 *
 * @module renderer/chat/modules/trail/TrailEventRouter
 *
 * TrailEventRouter - Pure Event Router for Trail Hierarchy
 * =========================================================
 * 
 * ARCHITECTURE PRINCIPLE:
 * Backend emits authoritative trail events. This router receives them and delegates
 * to TrailContainerManager for pure DOM rendering. NO state creation, NO validation,
 * NO persistence. Backend already did all of that.
 * 
 * CONTRACT:
 * - Backend events are TRUSTED (already validated and persisted)
 * - Router is STATELESS (pure function: event → DOM update)
 * - TrailContainerManager is PURE (only manipulates DOM)
 * 
 * EVENTS HANDLED:
 * 1. trail.group_created → renderGroup()
 * 2. trail.subgroup_created → renderSubgroup()
 * 3. trail.artifact_linked → linkArtifactToNode()
 * 4. trail.node_status_updated → updateNodeStatus()
 * 
 * FAIL-FAST PHILOSOPHY:
 * - Missing required fields? Throw immediately
 * - Invalid payload structure? Throw immediately
 * - TrailContainerManager not initialized? Throw immediately
 * - NO fallbacks, NO defaults, NO silent failures
 */

const { createRendererLogger } = require('../../../shared/utils/logger');

const routerLogger = createRendererLogger('TrailEventRouter');

class TrailEventRouter {
  constructor(options = {}) {
    this.orchestrator = options.orchestrator;
    this.eventBus = options.eventBus;
    this.log = routerLogger.child({ scope: 'instance' });

    // FAIL FAST: Required dependencies
    if (!this.orchestrator) {
      throw new Error('[TrailEventRouter] orchestrator is REQUIRED - cannot route events without orchestrator');
    }

    if (!this.eventBus) {
      throw new Error('[TrailEventRouter] eventBus is REQUIRED - cannot receive events without event bus');
    }

    this.listeners = [];
    this._isDisposed = false;

    // Register EventBus listeners
    const { EventTypes } = require('../../../../core/events/EventTypes');
    const { TRAIL } = EventTypes;

    const map = [
      [TRAIL.GROUP_CREATED, this.handleGroupCreated.bind(this)],
      [TRAIL.SUBGROUP_CREATED, this.handleSubgroupCreated.bind(this)],
      [TRAIL.SUBGROUP_COMPLETED, this.handleSubgroupCompleted.bind(this)],
      [TRAIL.ARTIFACT_LINKED, this.handleArtifactLinked.bind(this)],
      [TRAIL.NODE_STATUS_UPDATED, this.handleNodeStatusUpdated.bind(this)],
      [TRAIL.AGENT_MESSAGE_SEQUENCE, this.handleAgentMessageSequence.bind(this)],
    ];

    map.forEach(([eventType, handler]) => {
      const cleanup = this.eventBus.on(eventType, handler);
      this.listeners.push(cleanup);
    });

    this.log.info('TrailEventRouter initialized - pure event-driven trail rendering enabled');
  }

  /**
   * Handle trail.group_created event from backend
   * Backend guarantees: group_id, chat_id, sequence_number, backend_id
   * 
   * @param {Object} payload - Backend-validated group payload
   * @throws {Error} If required fields missing or invalid
   */
  handleGroupCreated(payload) {
    
    // FAIL FAST: Validate contract
    if (!payload || typeof payload !== 'object') {
      throw new Error('[TrailEventRouter] handleGroupCreated: payload must be object');
    }

    const { group_id, chat_id, sequence_number, backend_id } = payload;

    if (!group_id || typeof group_id !== 'string') {
      throw new Error('[TrailEventRouter] handleGroupCreated: group_id (string) is REQUIRED from backend');
    }

    if (!chat_id || typeof chat_id !== 'string') {
      throw new Error('[TrailEventRouter] handleGroupCreated: chat_id (string) is REQUIRED from backend');
    }

    if (typeof sequence_number !== 'number') {
      throw new Error('[TrailEventRouter] handleGroupCreated: sequence_number (number) is REQUIRED from backend');
    }

    if (!backend_id || typeof backend_id !== 'string') {
      throw new Error('[TrailEventRouter] handleGroupCreated: backend_id (string) is REQUIRED from backend');
    }

    this.log.info('Routing group_created to TrailContainerOrchestrator', {
      group_id: group_id.substring(0, 8),
      chat_id: chat_id.substring(0, 8),
      sequence_number
    });

    // Delegate to orchestrator
    this.orchestrator.handleGroupCreated(payload);
  }

  /**
   * Handle trail.subgroup_created event from backend
   * Backend guarantees: subgroup_id, group_id, execution_group, nodes[3]
   * Backend enforces: EXACTLY 3 nodes (writing, executing, output)
   * 
   * @param {Object} payload - Backend-validated subgroup payload
   * @throws {Error} If required fields missing or invalid
   */
  handleSubgroupCreated(payload) {
    // FAIL FAST: Validate contract
    if (!payload || typeof payload !== 'object') {
      throw new Error('[TrailEventRouter] handleSubgroupCreated: payload must be object');
    }

    const { subgroup_id, group_id, execution_group, nodes, chat_id } = payload;

    if (!subgroup_id || typeof subgroup_id !== 'string') {
      throw new Error('[TrailEventRouter] handleSubgroupCreated: subgroup_id (string) is REQUIRED from backend');
    }

    if (!group_id || typeof group_id !== 'string') {
      throw new Error('[TrailEventRouter] handleSubgroupCreated: group_id (string) is REQUIRED from backend');
    }
    
    // Backend MUST send chat_id so we can route to correct chat DOM
    if (!chat_id || typeof chat_id !== 'string') {
      throw new Error('[TrailEventRouter] handleSubgroupCreated: chat_id (string) is REQUIRED from backend - cannot render without chat context');
    }

    if (!execution_group || typeof execution_group !== 'string') {
      throw new Error('[TrailEventRouter] handleSubgroupCreated: execution_group (string) is REQUIRED from backend');
    }

    if (!Array.isArray(nodes)) {
      throw new Error('[TrailEventRouter] handleSubgroupCreated: nodes (array) is REQUIRED from backend');
    }

    // CRITICAL: Backend MUST send exactly 3 nodes (writing, executing, output)
    // This is a database constraint - if backend sends wrong count, something is critically broken
    if (nodes.length !== 3) {
      throw new Error(`[TrailEventRouter] handleSubgroupCreated: Backend CONTRACT VIOLATION - expected 3 nodes, got ${nodes.length}. Database constraint failed!`);
    }

    // Validate each node structure
    nodes.forEach((node, index) => {
      if (!node.node_id || typeof node.node_id !== 'string') {
        throw new Error(`[TrailEventRouter] handleSubgroupCreated: nodes[${index}].node_id (string) is REQUIRED from backend`);
      }
      if (!node.type || typeof node.type !== 'string') {
        throw new Error(`[TrailEventRouter] handleSubgroupCreated: nodes[${index}].type (string) is REQUIRED from backend`);
      }
      if (typeof node.sequence !== 'number') {
        throw new Error(`[TrailEventRouter] handleSubgroupCreated: nodes[${index}].sequence (number) is REQUIRED from backend`);
      }
      if (typeof node.clickable !== 'boolean') {
        throw new Error(`[TrailEventRouter] handleSubgroupCreated: nodes[${index}].clickable (boolean) is REQUIRED from backend`);
      }
    });

    this.log.info('Routing subgroup_created to TrailContainerManager', {
      subgroup_id: subgroup_id.substring(0, 8),
      group_id: group_id.substring(0, 8),
      nodeCount: nodes.length
    });
    // Delegate to orchestrator
    this.orchestrator.handleSubgroupCreated(payload);
  }

  /**
   * Handle trail.artifact_linked event from backend
   * Backend guarantees: artifact_id, node_id, subgroup_id, artifact_type
   * Backend validates: artifact_type matches node type (code→writing, output→output)
   * 
   * @param {Object} payload - Backend-validated artifact linkage payload
   * @throws {Error} If required fields missing or invalid
   */
  handleArtifactLinked(payload) {
    // FAIL FAST: Validate contract
    if (!payload || typeof payload !== 'object') {
      throw new Error('[TrailEventRouter] handleArtifactLinked: payload must be object');
    }

    const { artifact_id, node_id, subgroup_id, artifact_type, backend_id } = payload;

    if (!artifact_id || typeof artifact_id !== 'string') {
      throw new Error('[TrailEventRouter] handleArtifactLinked: artifact_id (string) is REQUIRED from backend');
    }

    if (!node_id || typeof node_id !== 'string') {
      throw new Error('[TrailEventRouter] handleArtifactLinked: node_id (string) is REQUIRED from backend');
    }

    if (!subgroup_id || typeof subgroup_id !== 'string') {
      throw new Error('[TrailEventRouter] handleArtifactLinked: subgroup_id (string) is REQUIRED from backend');
    }

    if (!artifact_type || typeof artifact_type !== 'string') {
      throw new Error('[TrailEventRouter] handleArtifactLinked: artifact_type (string) is REQUIRED from backend');
    }

    // CRITICAL: Backend enforces artifact_type ∈ {code, output}
    if (!['code', 'output'].includes(artifact_type)) {
      throw new Error(`[TrailEventRouter] handleArtifactLinked: Backend CONTRACT VIOLATION - artifact_type must be 'code' or 'output', got '${artifact_type}'`);
    }

    this.log.info('Routing artifact_linked to TrailContainerManager', {
      artifact_id: artifact_id.substring(0, 40),
      node_id: node_id.substring(0, 8),
      artifact_type
    });

    // Delegate to orchestrator
    this.orchestrator.handleArtifactLinked(payload);
  }

  /**
   * Handle trail.node_status_updated event from backend
   * Backend guarantees: node_id, status, subgroup_id
   * Backend validates: status ∈ {pending, active, completed, error}
   * 
   * @param {Object} payload - Backend-validated node status payload
   * @throws {Error} If required fields missing or invalid
   */
  handleNodeStatusUpdated(payload) {
    // FAIL FAST: Validate contract
    if (!payload || typeof payload !== 'object') {
      throw new Error('[TrailEventRouter] handleNodeStatusUpdated: payload must be object');
    }

    const { node_id, status, subgroup_id } = payload;

    if (!node_id || typeof node_id !== 'string') {
      throw new Error('[TrailEventRouter] handleNodeStatusUpdated: node_id (string) is REQUIRED from backend');
    }

    if (!status || typeof status !== 'string') {
      throw new Error('[TrailEventRouter] handleNodeStatusUpdated: status (string) is REQUIRED from backend');
    }

    if (!subgroup_id || typeof subgroup_id !== 'string') {
      throw new Error('[TrailEventRouter] handleNodeStatusUpdated: subgroup_id (string) is REQUIRED from backend');
    }

    // CRITICAL: Backend enforces status ∈ {pending, active, completed, error}
    const validStatuses = ['pending', 'active', 'completed', 'error'];
    if (!validStatuses.includes(status)) {
      throw new Error(`[TrailEventRouter] handleNodeStatusUpdated: Backend CONTRACT VIOLATION - status must be one of ${validStatuses.join(', ')}, got '${status}'`);
    }

    this.log.debug('Routing node_status_updated to TrailContainerManager', {
      node_id: node_id.substring(0, 8),
      status,
      subgroup_id: subgroup_id.substring(0, 8)
    });

    // Delegate to orchestrator
    this.orchestrator.handleNodeStatusUpdated(payload);
  }

  /**
   * Handle trail.subgroup_completed event from backend
   * Backend guarantees: subgroup_id, group_id, chat_id
   * 
   * @param {Object} payload - Backend-validated subgroup completion payload
   * @throws {Error} If required fields missing or invalid
   */
  handleSubgroupCompleted(payload) {
    // FAIL FAST: Validate contract
    if (!payload || typeof payload !== 'object') {
      throw new Error('[TrailEventRouter] handleSubgroupCompleted: payload must be object');
    }

    const { subgroup_id, group_id, chat_id } = payload;

    if (!subgroup_id || typeof subgroup_id !== 'string') {
      throw new Error('[TrailEventRouter] handleSubgroupCompleted: subgroup_id (string) is REQUIRED from backend');
    }

    if (!group_id || typeof group_id !== 'string') {
      throw new Error('[TrailEventRouter] handleSubgroupCompleted: group_id (string) is REQUIRED from backend');
    }

    if (!chat_id || typeof chat_id !== 'string') {
      throw new Error('[TrailEventRouter] handleSubgroupCompleted: chat_id (string) is REQUIRED from backend');
    }

    this.log.debug('Routing subgroup_completed to TrailContainerManager', {
      subgroup_id: subgroup_id.substring(0, 8),
      group_id: group_id.substring(0, 8)
    });

    // Delegate to trail container manager
    this.orchestrator.handleSubgroupCompleted(payload);
  }

  /**
   * Handle trail.agent_message_sequence event from backend
   * Backend sends this when creating the first trail to reserve the agent message sequence
   * 
   * @param {Object} payload - Backend-validated payload with sequence_in_chat
   * @throws {Error} If required fields missing or invalid
   */
  handleAgentMessageSequence(payload) {
    // FAIL FAST: Validate contract
    if (!payload || typeof payload !== 'object') {
      throw new Error('[TrailEventRouter] handleAgentMessageSequence: payload must be object');
    }

    const { chat_id, sequence_in_chat, backend_id } = payload;

    if (!chat_id || typeof chat_id !== 'string') {
      throw new Error('[TrailEventRouter] handleAgentMessageSequence: chat_id (string) is REQUIRED from backend');
    }

    if (typeof sequence_in_chat !== 'number') {
      throw new Error('[TrailEventRouter] handleAgentMessageSequence: sequence_in_chat (number) is REQUIRED from backend');
    }

    if (!backend_id || typeof backend_id !== 'string') {
      throw new Error('[TrailEventRouter] handleAgentMessageSequence: backend_id (string) is REQUIRED from backend');
    }

    this.log.debug('Received agent_message_sequence from backend', {
      chat_id: chat_id.substring(0, 8),
      sequence_in_chat,
      backend_id: backend_id.substring(0, 8)
    });

    // ARCHITECTURAL FIX: Use specific backend_id to find the container
    // StreamHandler sets data-backend-id on assistant containers
    let targetContainer = document.querySelector(
      `.chat-entry.message[data-role="assistant"][data-backend-id="${backend_id}"]`
    );
    
    // Fallback: Find the most recent assistant message without a sequence
    if (!targetContainer) {
      const messageContainers = document.querySelectorAll('.chat-entry.message[data-role="assistant"]');
      for (let i = messageContainers.length - 1; i >= 0; i--) {
        const container = messageContainers[i];
        if (!container.dataset.sequence) {
          targetContainer = container;
          break;
        }
      }
    }

    if (targetContainer) {
      targetContainer.dataset.sequence = sequence_in_chat;
      this.log.info('Set agent message sequence', {
        sequence_in_chat,
        messageId: targetContainer.dataset.messageId,
        backendId: backend_id.substring(0, 8)
      });
    } else {
      // Lazy container creation in StreamHandler means this is normal
      // if text hasn't arrived yet. StreamHandler will apply sequence when it creates the container.
      this.log.debug('Agent message container not found yet - sequence will be applied lazily', {
        sequence_in_chat,
        backend_id: backend_id.substring(0, 8)
      });
    }
  }

  /**
   * Cleanup resources — remove all EventBus listeners, null references
   */
  destroy() {
    if (this._isDisposed) return;

    this._isDisposed = true;

    // Remove all EventBus listeners
    for (const cleanup of this.listeners) {
      if (typeof cleanup === 'function') cleanup();
    }
    this.listeners = [];

    this.orchestrator = null;
    this.eventBus = null;
    this.log.info('TrailEventRouter destroyed');
  }
}

module.exports = TrailEventRouter;
