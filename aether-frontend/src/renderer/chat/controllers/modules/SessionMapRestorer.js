'use strict';

/**
 * @.architecture
 *
 * Incoming: Session map timeline data (from TrailRestorationService via EventCoordinator) --- {session_map, object}
 * Processing: Annotate DOM message elements with sequence numbers, restore trail groups/subgroups/nodes from timeline --- {4 jobs: JOB_ANNOTATE_DOM, JOB_CREATE_GROUP, JOB_CREATE_SUBGROUP, JOB_LINK_ARTIFACT}
 * Outgoing: TrailContainerOrchestrator state mutations (groups, subgroups, nodes, artifact links) --- {state_mutation, void}
 *
 * @module renderer/chat/controllers/modules/SessionMapRestorer
 *
 * SessionMapRestorer - Session Map Timeline Restoration
 * ============================================================================
 * Extracted from ChatController monolith. Handles the complex logic of
 * restoring trail state from a backend-provided session map timeline.
 *
 * SINGLE RESPONSIBILITY: Restore trail UI state from session map data.
 * Stateless processor - all dependencies passed as method arguments.
 */

const { createRendererLogger } = require('../../../shared/utils/logger');

const logger = createRendererLogger('SessionMapRestorer');

class SessionMapRestorer {
  constructor() {
    this.log = logger.child({ scope: 'session-map-restorer' });
    this.log.debug('SessionMapRestorer initialized');
  }

  /**
   * Restore trails from a session map timeline.
   * Uses timeline sequence for correct DOM insertion.
   * @param {string} chatId - Chat ID being restored
   * @param {Object} sessionMap - Session map with timeline array
   * @param {Object} orchestrator - TrailContainerOrchestrator instance
   */
  restore(chatId, sessionMap, orchestrator) {
    if (!sessionMap || !Array.isArray(sessionMap.timeline)) {
      this.log.warn('Invalid session map structure');
      return;
    }

    if (!orchestrator) {
      this.log.warn('TrailContainerOrchestrator not available');
      return;
    }

    this.log.info('Restoring trails from session map', {
      chatId: chatId.substring(0, 8),
      timelineEvents: sessionMap.timeline?.length
    });

    // Clear ONLY this chat's trail state before restoration
    // This prevents "already exists" errors without wiping other chats
    if (orchestrator?.stateManager) {
      orchestrator.stateManager.clearChatState(chatId);
    }

    // Annotate message DOM elements with sequence numbers
    // This enables correct trail insertion based on timeline order
    const trailEvents = this._annotateAndFilterTimeline(chatId, sessionMap, orchestrator);
    if (!trailEvents || trailEvents.length === 0) {
      return;
    }

    // Process each trail event in order
    this._processTrailEvents(chatId, trailEvents, orchestrator);

    this.log.info('Session map restoration complete', {
      chatId: chatId.substring(0, 8),
      trailsRestored: trailEvents.length
    });
  }

  /**
   * Annotate DOM message elements and extract trail events from timeline.
   * @private
   * @param {string} chatId
   * @param {Object} sessionMap
   * @param {Object} orchestrator
   * @returns {Array|null} Trail events sorted by sequence, or null if none
   */
  _annotateAndFilterTimeline(chatId, sessionMap, orchestrator) {
    try {
      const messageEvents = sessionMap.timeline.filter(event => event.type === 'message');

      // Get the actual DOM container from TrailContainerOrchestrator
      const domContainer = orchestrator?.container;
      const messageElements = domContainer?.querySelectorAll('.chat-entry.message');

      // ROBUST FIX: Annotate whatever messages we CAN match, even if counts differ
      // Strict equality check was causing trails to misposition when counts mismatch
      if (messageElements && messageEvents && messageElements.length > 0 && messageEvents.length > 0) {
        const matchCount = Math.min(messageElements.length, messageEvents.length);
        let annotatedCount = 0;

        for (let i = 0; i < matchCount; i++) {
          if (messageElements[i] && messageEvents[i] && messageEvents[i].sequence !== undefined) {
            messageElements[i].dataset.sequence = messageEvents[i].sequence;
            annotatedCount++;
          }
        }

        this.log.debug('Annotated messages with sequence numbers', {
          domMessageCount: messageElements.length,
          timelineMessageCount: messageEvents.length,
          annotatedCount
        });

        if (messageElements.length !== messageEvents.length) {
          this.log.warn('Message count mismatch between DOM and timeline', {
            domCount: messageElements.length,
            timelineCount: messageEvents.length,
            diff: Math.abs(messageElements.length - messageEvents.length)
          });
        }
      }

      // Filter trail events from timeline
      const trailEvents = sessionMap.timeline
        .filter(event => event.type === 'trail')
        .sort((a, b) => a.sequence - b.sequence); // Ensure chronological order

      if (trailEvents.length === 0) {
        this.log.debug('No trail events in session map', { chatId: chatId.substring(0, 8) });
        return null;
      }

      return trailEvents;
    } catch (error) {
      this.log.error('Error during message/trail filtering', { error: error.message, stack: error.stack });
      return null;
    }
  }

  /**
   * Process each trail event and restore it via the orchestrator.
   * @private
   * @param {string} chatId
   * @param {Array} trailEvents
   * @param {Object} orchestrator
   */
  _processTrailEvents(chatId, trailEvents, orchestrator) {
    for (const trailEvent of trailEvents) {
      try {
        const groupId = trailEvent.group_id;

        // Create group in state (if not already created by previous subgroup in same group)
        if (!orchestrator.stateManager.getGroup(chatId, groupId)) {
          orchestrator.stateManager.createGroup({
            group_id: groupId,
            chat_id: chatId,
            sequence_number: trailEvent.group_sequence || 1,
            backend_id: groupId
          });
        }

        // Pass timeline sequence for DOM insertion
        // Frontend is pure renderer - backend provides perfect linear timeline
        orchestrator.handleSubgroupCreated({
          subgroup_id: trailEvent.subgroup_id,
          group_id: groupId,
          chat_id: chatId,
          execution_group: trailEvent.execution_group,
          nodes: trailEvent.nodes.map(node => ({
            node_id: node.node_id,
            type: node.type,
            sequence: node.sequence || 1,
            clickable: node.clickable !== undefined ? node.clickable : true,
            status: node.status || 'completed',
            started_at: node.started_at,
            completed_at: node.completed_at,
            duration_ms: node.duration_ms
          })),
          _restored: true,
          _timelineSequence: trailEvent.sequence, // Use timeline sequence for DOM insertion
          _duration_ms: trailEvent.duration_ms,
          subgroup_sequence: trailEvent.subgroup_sequence // For trail numbering (Trail 1, Trail 2)
        });

        // Link artifacts to nodes for clickability
        for (const node of trailEvent.nodes) {
          if (node.artifact_id) {
            orchestrator.handleArtifactLinked({
              artifact_id: node.artifact_id,
              node_id: node.node_id,
              subgroup_id: trailEvent.subgroup_id,
              group_id: groupId,
              chat_id: chatId,
              artifact_type: node.type
            });
          }
        }

        // Only emit subgroup_completed if subgroup status is "completed"
        // This ensures green tick only appears on fully completed trails (persisted correctly)
        if (orchestrator && typeof orchestrator.handleSubgroupCompleted === 'function') {
          if (trailEvent.status === 'completed') {
            orchestrator.handleSubgroupCompleted({
              subgroup_id: trailEvent.subgroup_id,
              group_id: groupId,
              chat_id: chatId,
              duration_ms: trailEvent.duration_ms
            });
          }
        }
      } catch (error) {
        this.log.error('Failed to restore trail', {
          error: error.message,
          stack: error.stack,
          subgroupId: trailEvent.subgroup_id?.substring(0, 8)
        });
      }
    }
  }

  /**
   * Dispose (no-op for stateless processor, included for interface consistency).
   */
  dispose() {
    this.log.debug('SessionMapRestorer disposed');
  }
}

module.exports = SessionMapRestorer;
