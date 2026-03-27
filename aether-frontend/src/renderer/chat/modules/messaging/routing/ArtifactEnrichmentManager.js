'use strict';

/**
 * @.architecture
 *
 * Incoming: trail.artifact_linked events, artifact stream chunks --- {trail_event | artifact_chunk, json}
 * Processing: Store artifact→trail mappings, enrich chunks with trail metadata --- {2 jobs: JOB_STORE_MAPPING, JOB_ENRICH_PAYLOAD}
 * Outgoing: Enriched artifact payloads with node_id/subgroup_id --- {enriched_artifact, json}
 *
 * @module renderer/chat/modules/messaging/routing/ArtifactEnrichmentManager
 */

const { createRendererLogger } = require('../../../../shared/utils/logger');

const enrichmentLogger = createRendererLogger('ArtifactEnrichmentManager');

/**
 * ArtifactEnrichmentManager - Trail Metadata Enrichment
 * ======================================================
 * 
 * SINGLE RESPONSIBILITY: Enrich artifact chunks with trail linkage metadata
 * 
 * ARCHITECTURE:
 * Backend emits trail.artifact_linked events containing:
 * - artifact_id
 * - node_id
 * - subgroup_id
 * 
 * We store these mappings and inject them into artifact stream chunks
 * so downstream persistence can link artifacts to trail hierarchy.
 * 
 * CONTRACTS:
 * - NO routing logic
 * - NO rendering
 * - Pure enrichment (mapping storage + payload injection)
 * 
 * @module renderer/chat/modules/messaging/routing/ArtifactEnrichmentManager
 */
class ArtifactEnrichmentManager {
  constructor(options = {}) {
    this.log = enrichmentLogger.child({ scope: 'artifact-enrichment-manager' });
    
    // artifact_id → {node_id, subgroup_id}
    this._mappings = new Map();
    
    this.log.info('ArtifactEnrichmentManager initialized');
  }

  /**
   * Store artifact trail linkage from trail.artifact_linked event
   * @param {Object} payload - Trail event payload
   * @param {string} payload.artifact_id - Artifact ID
   * @param {string} payload.node_id - Trail node ID
   * @param {string} payload.subgroup_id - Trail subgroup ID
   */
  storeMapping(payload) {
    const { artifact_id, node_id, subgroup_id } = payload;

    if (!artifact_id || !node_id || !subgroup_id) {
      this.log.warn('Ignoring trail.artifact_linked with missing fields', {
        hasArtifactId: Boolean(artifact_id),
        hasNodeId: Boolean(node_id),
        hasSubgroupId: Boolean(subgroup_id)
      });
      return;
    }

    this._mappings.set(artifact_id, { node_id, subgroup_id });

    this.log.debug('Stored artifact trail mapping', {
      artifact_id: String(artifact_id).substring(0, 40),
      node_id: String(node_id).substring(0, 16),
      subgroup_id: String(subgroup_id).substring(0, 16),
      mapSize: this._mappings.size
    });
  }

  /**
   * Enrich artifact payload with trail metadata if mapping exists
   * @param {Object} payload - Artifact chunk payload
   * @returns {Object} Enriched payload (mutates original)
   */
  enrich(payload) {
    const artifactId = payload.artifact_id || payload.artifactId;

    if (!artifactId) {
      return payload;
    }

    const mapping = this._mappings.get(artifactId);
    if (!mapping) {
      return payload;
    }

    // Inject trail metadata
    payload.node_id = mapping.node_id;
    payload.subgroup_id = mapping.subgroup_id;

    this.log.trace('Enriched artifact with trail metadata', {
      artifact_id: String(artifactId).substring(0, 40),
      node_id: String(mapping.node_id).substring(0, 16),
      subgroup_id: String(mapping.subgroup_id).substring(0, 16)
    });

    return payload;
  }

  /**
   * Check if artifact has trail mapping
   * @param {string} artifactId - Artifact ID
   * @returns {boolean}
   */
  hasMapping(artifactId) {
    return this._mappings.has(artifactId);
  }

  /**
   * Get mapping for artifact
   * @param {string} artifactId - Artifact ID
   * @returns {Object|null} {node_id, subgroup_id} or null
   */
  getMapping(artifactId) {
    return this._mappings.get(artifactId) || null;
  }

  /**
   * Clear all mappings (on chat switch)
   */
  clear() {
    const previousSize = this._mappings.size;
    this._mappings.clear();
    this.log.debug('Cleared artifact trail mappings', { previousSize });
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    this._mappings.clear();
    this.log.info('ArtifactEnrichmentManager disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ArtifactEnrichmentManager;
}

if (typeof window !== 'undefined') {
  window.ArtifactEnrichmentManager = ArtifactEnrichmentManager;
}
