'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactsController._trackBackendIndex(artifact, variantKey) --- {artifact_types.*, object}
 * Processing: Manage backend artifact index (requestId → variantKey → artifactId mapping), track artifact variants, enable deduplication lookups --- {3 jobs: JOB_UPDATE_STATE, JOB_TRACK_ENTITY, JOB_ROUTE_BY_TYPE}
 * Outgoing: Return artifactId for requestId+variant or null --- {string | null}
 * 
 * ARCHITECTURE:
 * - Manages Map<requestId, Map<variantKey, artifactId>> structure
 * - Encapsulates backend artifact indexing logic
 * - Provides clean API for tracking and lookup
 * - Testable in isolation
 * - No I/O, pure state management
 * 
 * PURPOSE:
 * - Track which artifact variants exist for each request
 * - Enable deduplication (find existing artifact for request+variant)
 * - Support tab switching (find appropriate artifact for current tab)
 * 
 * @module domain/artifacts/services/ArtifactIndexService
 */

const { freeze } = Object;

class ArtifactIndexService {
  constructor() {
    // Map<requestId, Map<variantKey, artifactId>>
    this.index = new Map();
  }

  /**
   * Track artifact in backend index
   * @param {string} requestId - Request ID
   * @param {string} variantKey - Variant key (e.g., "assistant:code", "computer:output")
   * @param {string} artifactId - Artifact ID
   */
  track(requestId, variantKey, artifactId) {
    // FAIL FAST: Validate inputs
    if (!requestId || typeof requestId !== 'string') {
      throw new Error('[ArtifactIndexService] requestId must be a non-empty string');
    }

    if (!variantKey || typeof variantKey !== 'string') {
      throw new Error('[ArtifactIndexService] variantKey must be a non-empty string');
    }

    if (!artifactId || typeof artifactId !== 'string') {
      throw new Error('[ArtifactIndexService] artifactId must be a non-empty string');
    }

    // Create variant map if it doesn't exist
    if (!this.index.has(requestId)) {
      this.index.set(requestId, new Map());
    }

    // Track artifact
    this.index.get(requestId).set(variantKey, artifactId);
  }

  /**
   * Find artifact ID by request ID and variant key
   * @param {string} requestId - Request ID
   * @param {string} variantKey - Variant key
   * @returns {string|null} Artifact ID or null if not found
   */
  find(requestId, variantKey) {
    if (!requestId || !variantKey) {
      return null;
    }

    const variantMap = this.index.get(requestId);
    if (!variantMap) {
      return null;
    }

    return variantMap.get(variantKey) || null;
  }

  /**
   * Get all variants for a request ID
   * @param {string} requestId - Request ID
   * @returns {Map<string, string>|null} Map of variantKey → artifactId or null
   */
  getVariants(requestId) {
    if (!requestId) {
      return null;
    }

    return this.index.get(requestId) || null;
  }

  /**
   * Check if request ID is tracked
   * @param {string} requestId - Request ID
   * @returns {boolean} True if tracked
   */
  has(requestId) {
    return this.index.has(requestId);
  }

  /**
   * Remove request ID from index
   * @param {string} requestId - Request ID
   * @returns {boolean} True if removed, false if not found
   */
  remove(requestId) {
    return this.index.delete(requestId);
  }

  /**
   * Clear entire index
   */
  clear() {
    this.index.clear();
  }

  /**
   * Get index size (number of tracked request IDs)
   * @returns {number} Number of tracked requests
   */
  size() {
    return this.index.size;
  }

  /**
   * Get all request IDs
   * @returns {Array<string>} Array of request IDs
   */
  getRequestIds() {
    return Array.from(this.index.keys());
  }

  /**
   * Get index statistics
   * @returns {Object} Statistics
   */
  getStats() {
    const totalVariants = Array.from(this.index.values())
      .reduce((sum, variantMap) => sum + variantMap.size, 0);

    return freeze({
      totalRequests: this.index.size,
      totalVariants,
      averageVariantsPerRequest: this.index.size > 0 
        ? (totalVariants / this.index.size).toFixed(2)
        : 0
    });
  }
}

// Export
module.exports = { ArtifactIndexService };
