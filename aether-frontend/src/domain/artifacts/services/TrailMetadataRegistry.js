'use strict';

/**
Incoming: ArtifactsStreamOrchestrator (trail.artifact_linked events) --- {websocket.trail_event, json}
Processing: Store artifact_id → trail metadata mappings, validate contracts --- {2 jobs: JOB_TRACK_ENTITY, JOB_VALIDATE_SCHEMA}
Outgoing: Trail metadata queries for artifact enrichment --- {object, javascript_api}

ARCHITECTURAL NOTE: Backend owns trail creation. Frontend stores mappings for artifact enrichment.
*/

/**
 * TrailMetadataRegistry
 * 
 * Pure state container for trail metadata received from backend.
 * Backend emits trail.artifact_linked events BEFORE artifact content chunks.
 * This registry stores those mappings for artifact enrichment during streaming.
 * 
 * ARCHITECTURE:
 * - Domain service (pure state, no I/O)
 * - Contract enforcement: rejects incomplete payloads
 * - No transformations: stores EXACT artifact_id from backend
 * 
 * @module domain/artifacts/services/TrailMetadataRegistry
 */

const { createLogger } = require('../../../core/utils/logger');

class TrailMetadataRegistry {
  constructor(options = {}) {
    this.enableLogging = options.enableLogging || false;
    this.log = createLogger({ component: 'TrailMetadataRegistry' });
    
    // artifact_id (string) → { node_id, subgroup_id, artifact_type, timestamp }
    this._mappings = new Map();
  }

  /**
   * Register trail metadata for an artifact
   * CONTRACT: Backend MUST provide complete payload
   * 
   * @param {Object} payload - Trail linkage payload from backend
   * @param {string} payload.artifact_id - Exact artifact ID from backend
   * @param {string} payload.node_id - Trail node ID
   * @param {string} payload.subgroup_id - Trail subgroup ID
   * @param {string} payload.artifact_type - Artifact type (code/output)
   * @throws {Error} If payload is incomplete or invalid
   */
  register(payload) {
    // CONTRACT VIOLATION: Reject null/undefined payloads
    if (!payload) {
      throw new Error('[TrailMetadataRegistry] CONTRACT VIOLATION: payload is null or undefined');
    }
    
    const { artifact_id, node_id, subgroup_id, artifact_type } = payload;
    
    // CONTRACT VIOLATION: Reject incomplete payloads
    if (!artifact_id || typeof artifact_id !== 'string') {
      throw new Error(
        `[TrailMetadataRegistry] CONTRACT VIOLATION: artifact_id required. ` +
        `Received: ${typeof artifact_id}`
      );
    }
    
    if (!node_id || typeof node_id !== 'string') {
      throw new Error(
        `[TrailMetadataRegistry] CONTRACT VIOLATION: node_id required. ` +
        `artifact_id=${artifact_id.substring(0, 40)}`
      );
    }
    
    if (!subgroup_id || typeof subgroup_id !== 'string') {
      throw new Error(
        `[TrailMetadataRegistry] CONTRACT VIOLATION: subgroup_id required. ` +
        `artifact_id=${artifact_id.substring(0, 40)}, node_id=${node_id.substring(0, 16)}`
      );
    }
    
    // Store EXACT artifact_id from backend - no transformations
    this._mappings.set(artifact_id, {
      node_id,
      subgroup_id,
      artifact_type: artifact_type || null,
      timestamp: Date.now()
    });
    
    if (this.enableLogging) {
      this.log.debug('Registered trail metadata', {
        artifact_id: artifact_id.substring(0, 40),
        node_id: node_id.substring(0, 16),
        subgroup_id: subgroup_id.substring(0, 16),
        artifact_type
      });
    }
  }

  /**
   * Get trail metadata for an artifact
   * CONTRACT: Returns exact metadata or throws
   * 
   * @param {string} artifact_id - Exact artifact ID from backend
   * @returns {Object} Trail metadata { node_id, subgroup_id, artifact_type, timestamp }
   * @throws {Error} If artifact_id is not registered
   */
  get(artifact_id) {
    if (!artifact_id || typeof artifact_id !== 'string') {
      throw new Error(
        `[TrailMetadataRegistry] CONTRACT VIOLATION: artifact_id must be non-empty string. ` +
        `Received: ${typeof artifact_id}`
      );
    }
    
    if (!this._mappings.has(artifact_id)) {
      throw new Error(
        `[TrailMetadataRegistry] Trail metadata not found. ` +
        `artifact_id=${artifact_id.substring(0, 40)}. ` +
        `Backend must send trail.artifact_linked BEFORE artifact chunks.`
      );
    }
    
    return this._mappings.get(artifact_id);
  }

  /**
   * Check if trail metadata exists for an artifact
   * 
   * @param {string} artifact_id - Exact artifact ID from backend
   * @returns {boolean}
   */
  has(artifact_id) {
    if (!artifact_id || typeof artifact_id !== 'string') {
      return false;
    }
    return this._mappings.has(artifact_id);
  }

  /**
   * Get all registered artifact IDs
   * 
   * @returns {string[]} Array of artifact IDs
   */
  getRegisteredArtifactIds() {
    return Array.from(this._mappings.keys());
  }

  /**
   * Get registry statistics
   * 
   * @returns {Object} Statistics
   */
  getStats() {
    return {
      totalMappings: this._mappings.size,
      oldestMapping: this._getOldestMappingAge(),
      newestMapping: this._getNewestMappingAge()
    };
  }

  /**
   * Clear all mappings (for testing/cleanup)
   */
  clear() {
    const count = this._mappings.size;
    this._mappings.clear();
    
    if (this.enableLogging) {
      this.log.debug('Cleared mappings', { count });
    }
  }

  /**
   * Get age of oldest mapping in milliseconds
   * @private
   */
  _getOldestMappingAge() {
    if (this._mappings.size === 0) return null;
    
    const now = Date.now();
    let oldest = Infinity;
    
    for (const metadata of this._mappings.values()) {
      const age = now - metadata.timestamp;
      if (age < oldest) {
        oldest = age;
      }
    }
    
    return oldest === Infinity ? null : oldest;
  }

  /**
   * Get age of newest mapping in milliseconds
   * @private
   */
  _getNewestMappingAge() {
    if (this._mappings.size === 0) return null;
    
    const now = Date.now();
    let newest = 0;
    
    for (const metadata of this._mappings.values()) {
      const age = now - metadata.timestamp;
      if (age > newest) {
        newest = age;
      }
    }
    
    return newest;
  }
}

module.exports = { TrailMetadataRegistry };
