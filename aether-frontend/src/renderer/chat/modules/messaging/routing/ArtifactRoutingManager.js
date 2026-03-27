'use strict';

/**
 * @.architecture
 *
 * Incoming: Normalized artifact messages (code/console/html) --- {artifact_message, json}
 * Processing: Buffer CODE artifacts pending trail linkage, route to EventBus --- {3 jobs: JOB_BUFFER_PENDING, JOB_ENRICH_ARTIFACT, JOB_EMIT_EVENT}
 * Outgoing: EventBus 'artifact:stream' events, enriched payloads --- {event.artifact_stream, json}
 *
 * @module renderer/chat/modules/messaging/routing/ArtifactRoutingManager
 */

const { createRendererLogger } = require('../../../../shared/utils/logger');
const MessageParser = require('../utils/MessageParser');

const artifactLogger = createRendererLogger('ArtifactRoutingManager');

/**
 * ArtifactRoutingManager - Artifact Buffering & Routing
 * ======================================================
 * 
 * SINGLE RESPONSIBILITY: Route artifacts to EventBus with trail enrichment
 * 
 * ARCHITECTURE:
 * CODE artifacts arrive before trail.artifact_linked events (race condition).
 * We buffer CODE chunks until linkage arrives, then flush enriched.
 * OUTPUT artifacts don't get linkage events—route immediately.
 * 
 * RACE FIX STRATEGY:
 * 1. CODE artifact chunk arrives → buffer it
 * 2. trail.artifact_linked arrives → enrich & flush buffered chunks
 * 3. Subsequent CODE chunks → enrich & route immediately
 * 4. OUTPUT artifacts → route immediately (no linkage needed)
 * 
 * CONTRACTS:
 * - NO business logic beyond buffering
 * - Delegates enrichment to ArtifactEnrichmentManager
 * - Emits to EventBus for forwarding to artifacts window
 * 
 * @module renderer/chat/modules/messaging/routing/ArtifactRoutingManager
 */
class ArtifactRoutingManager {
  constructor(options = {}) {
    this.eventBus = options.eventBus || null;
    this.enrichmentManager = options.enrichmentManager || null;
    this.log = artifactLogger.child({ scope: 'artifact-routing-manager' });

    if (!this.eventBus) {
      throw new Error('[ArtifactRoutingManager] eventBus is REQUIRED');
    }

    if (!this.enrichmentManager) {
      throw new Error('[ArtifactRoutingManager] enrichmentManager is REQUIRED');
    }

    // artifact_id → Array<payload>
    this._pendingChunks = new Map();
    // artifact_id → timeout ID
    this._flushTimeouts = new Map();
    this._isDisposed = false;

    this.log.info('ArtifactRoutingManager initialized');
  }

  /**
   * Handle artifact message
   * @param {Object} normalized - Normalized artifact message
   */
  async handleArtifact(normalized) {
    if (this._isDisposed) {
      this.log.warn('handleArtifact called on disposed ArtifactRoutingManager');
      return;
    }

    const artifactId = normalized.artifactId;
    const artifactType = MessageParser.getArtifactType(normalized);

    // ARCHITECTURAL FIX: Buffer BOTH code and output artifacts
    // Both types now receive trail.artifact_linked events from backend
    // Output artifacts (computer:output) REQUIRE linkage for database persistence contract
    const isLinkableArtifact = artifactId && (
      artifactId.includes(':code:') || 
      artifactId.includes(':output:') || 
      normalized.type === 'code' || 
      normalized.type === 'output' ||
      normalized.type === 'console'
    );

    if (isLinkableArtifact && !this.enrichmentManager.hasMapping(artifactId)) {
      // Buffer chunk until trail linkage arrives
      this._bufferChunk(artifactId, normalized.raw);
      this.log.trace('Buffered linkable artifact chunk pending trail linkage', {
        artifactId: artifactId.substring(0, 40),
        artifactType
      });
      return;
    }

    // Enrich with trail metadata (if available)
    const enriched = this.enrichmentManager.enrich(normalized.raw);

    // Route to EventBus
    this._emitArtifact(enriched, artifactType);
  }

  /**
   * Flush buffered chunks for artifact (called when trail linkage arrives)
   * @param {string} artifactId - Artifact ID
   */
  flushBuffered(artifactId) {
    if (this._isDisposed) {
      this.log.warn('flushBuffered called on disposed ArtifactRoutingManager');
      return;
    }

    // Clear fallback timeout if it exists
    if (this._flushTimeouts.has(artifactId)) {
      clearTimeout(this._flushTimeouts.get(artifactId));
      this._flushTimeouts.delete(artifactId);
    }

    const buffered = this._pendingChunks.get(artifactId);
    if (!buffered || buffered.length === 0) {
      return;
    }

    this._pendingChunks.delete(artifactId);

    this.log.debug('Flushing buffered artifact chunks', {
      artifactId: artifactId.substring(0, 40),
      count: buffered.length
    });

    for (const chunk of buffered) {
      // Enrich with trail metadata
      const enriched = this.enrichmentManager.enrich(chunk);
      const artifactType = this._getArtifactTypeFromPayload(chunk);
      this._emitArtifact(enriched, artifactType);
    }
  }

  /**
   * Buffer artifact chunk
   * @private
   * @param {string} artifactId - Artifact ID
   * @param {Object} payload - Raw payload
   */
  _bufferChunk(artifactId, payload) {
    if (!this._pendingChunks.has(artifactId)) {
      this._pendingChunks.set(artifactId, []);
      
      // Set fallback timeout (500ms) to flush buffer if trail linkage doesn't arrive
      const timeoutId = setTimeout(() => {
        if (!this._isDisposed && this._pendingChunks.has(artifactId)) {
          this.log.warn('Fallback timeout reached for artifact buffer, flushing without trail linkage', {
            artifactId: artifactId.substring(0, 40)
          });
          this.flushBuffered(artifactId);
        }
      }, 500);
      this._flushTimeouts.set(artifactId, timeoutId);
    }
    this._pendingChunks.get(artifactId).push(payload);
  }

  /**
   * Emit artifact to EventBus
   * @private
   * @param {Object} payload - Enriched payload
   * @param {string} artifactType - Artifact type for logging
   */
  _emitArtifact(payload, artifactType) {
    this.eventBus.emit('artifact:stream', payload);
    
    this.log.trace('Artifact emitted to EventBus', {
      artifactType,
      hasNodeId: Boolean(payload.node_id),
      hasSubgroupId: Boolean(payload.subgroup_id)
    });
  }

  /**
   * Get artifact type from raw payload (for logging)
   * @private
   * @param {Object} payload - Raw payload
   * @returns {string}
   */
  _getArtifactTypeFromPayload(payload) {
    const normalized = MessageParser.parse(payload);
    return MessageParser.getArtifactType(normalized) || 'unknown';
  }

  /**
   * Clear all buffered chunks (on chat switch)
   */
  clear() {
    const previousSize = this._pendingChunks.size;
    
    // Clear all timeouts
    for (const timeoutId of this._flushTimeouts.values()) {
      clearTimeout(timeoutId);
    }
    this._flushTimeouts.clear();
    
    this._pendingChunks.clear();
    this.log.debug('Cleared buffered artifact chunks', { previousSize });
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    if (this._isDisposed) return;

    this._isDisposed = true;
    
    // Clear all timeouts
    for (const timeoutId of this._flushTimeouts.values()) {
      clearTimeout(timeoutId);
    }
    this._flushTimeouts.clear();
    
    this._pendingChunks.clear();
    this.eventBus = null;
    this.enrichmentManager = null;
    this.log.info('ArtifactRoutingManager disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ArtifactRoutingManager;
}

if (typeof window !== 'undefined') {
  window.ArtifactRoutingManager = ArtifactRoutingManager;
}
