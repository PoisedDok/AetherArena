'use strict';

/**
 * @.architecture
 *
 * Incoming: Normalized trail events from router --- {trail_event, json}
 * Processing: Route trail events to TrailOrchestrator, store artifact mappings, flush buffers --- {3 jobs: JOB_DELEGATE_TO_MODULE, JOB_STORE_MAPPING, JOB_FLUSH_BUFFER}
 * Outgoing: TrailOrchestrator method calls, ArtifactRoutingManager flush calls --- {method_call, void}
 *
 * @module renderer/chat/modules/messaging/handlers/TrailEventHandler
 */

const { createRendererLogger } = require('../../../../shared/utils/logger');
const { EventTypes } = require('../../../../../core/events/EventTypes');

const trailHandlerLogger = createRendererLogger('TrailEventHandler');

/**
 * TrailEventHandler - Trail Event Processing
 * ===========================================
 * 
 * SINGLE RESPONSIBILITY: Handle trail.* events from backend
 * 
 * ARCHITECTURE:
 * Backend emits trail events with validated hierarchy data.
 * We route to TrailOrchestrator for DOM rendering and handle
 * artifact linkage coordination.
 * 
 * CONTRACTS:
 * - Delegates rendering to TrailOrchestrator
 * - Coordinates artifact enrichment
 * - NO business logic
 * 
 * @module renderer/chat/modules/messaging/handlers/TrailEventHandler
 */
class TrailEventHandler {
  constructor(options = {}) {
    this.eventBus = options.eventBus || null;
    this.enrichmentManager = options.enrichmentManager || null;
    this.artifactRoutingManager = options.artifactRoutingManager || null;
    this.log = trailHandlerLogger.child({ scope: 'trail-event-handler' });

    if (!this.eventBus) {
      throw new Error('[TrailEventHandler] eventBus is REQUIRED');
    }

    if (!this.enrichmentManager) {
      throw new Error('[TrailEventHandler] enrichmentManager is REQUIRED');
    }

    if (!this.artifactRoutingManager) {
      throw new Error('[TrailEventHandler] artifactRoutingManager is REQUIRED');
    }

    // Lifecycle
    this._isDisposed = false;

    this.log.info('TrailEventHandler initialized');
  }

  /**
   * Handle trail event
   * @param {Object} normalized - Normalized trail event
   */
  async handleTrailEvent(normalized) {
    if (this._isDisposed) return;

    const { type, raw } = normalized;
    // Map to EventBus event type
    const eventTypeMap = {
      'trail.group_created': EventTypes.TRAIL.GROUP_CREATED,
      'trail.subgroup_created': EventTypes.TRAIL.SUBGROUP_CREATED,
      'trail.subgroup_completed': EventTypes.TRAIL.SUBGROUP_COMPLETED,
      'trail.artifact_linked': EventTypes.TRAIL.ARTIFACT_LINKED,
      'trail.node_status_updated': EventTypes.TRAIL.NODE_STATUS_UPDATED,
      'trail.agent_message_sequence': EventTypes.TRAIL.AGENT_MESSAGE_SEQUENCE,
    };

    const eventType = eventTypeMap[type];

    if (!eventType) {
      this.log.warn('Unknown trail event type', { type });
      return;
    }

    // Handle artifact linkage (special case)
    if (type === 'trail.artifact_linked') {
      await this._handleArtifactLinked(raw);
    }

    // Emit to EventBus for TrailOrchestrator
    this.eventBus.emit(eventType, raw);
    this.log.debug('Trail event routed to EventBus', { type, eventType });
  }

  /**
   * Handle trail.artifact_linked event
   * @private
   * @param {Object} payload - Trail event payload
   */
  async _handleArtifactLinked(payload) {
    const { artifact_id } = payload;

    // Store mapping in enrichment manager
    this.enrichmentManager.storeMapping(payload);

    // Flush any buffered artifact chunks
    if (artifact_id && this.artifactRoutingManager) {
      this.artifactRoutingManager.flushBuffered(artifact_id);
      this.log.debug('Artifact trail linkage processed', {
        artifact_id: String(artifact_id).substring(0, 40)
      });
    }
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;

    this.eventBus = null;
    this.enrichmentManager = null;
    this.artifactRoutingManager = null;
    this.log.info('TrailEventHandler disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TrailEventHandler;
}

if (typeof window !== 'undefined') {
  window.TrailEventHandler = TrailEventHandler;
}
