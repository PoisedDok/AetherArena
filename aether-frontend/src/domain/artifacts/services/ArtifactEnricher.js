'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactsController.loadArtifact(artifact, classification) --- {artifact_types.*, object}
 * Processing: Enrich artifact with classification data (role/type/format/language), create new immutable artifact (no mutations), preserve original properties, validate enrichment --- {4 jobs: JOB_NORMALIZE_DATA, JOB_VALIDATE_SCHEMA, JOB_TRANSFORM_DATA, JOB_SANITIZE_INPUT}
 * Outgoing: Return enriched artifact copy --- {artifact_types.*, object}
 * 
 * ARCHITECTURE:
 * - Pure functional approach (no mutations to input)
 * - Creates new objects instead of modifying inputs
 * - Preserves referential integrity
 * - Testable in isolation
 * - Fail-fast on invalid inputs
 * 
 * MUTABILITY:
 * - Original artifact is NEVER modified (creates new object)
 * - Returns new object with enriched properties
 * - NOT frozen - artifacts need to be mutable for streaming (content accumulation)
 * - Shared cache used by both display and streaming layers
 * 
 * @module domain/artifacts/services/ArtifactEnricher
 */

const { freeze } = Object;

class ArtifactEnricher {
  /**
   * Enrich artifact with classification data
   * @param {Object} artifact - Original artifact (not modified)
   * @param {Object} classification - Classification from ArtifactRouter
   * @returns {Object} New enriched artifact (mutable, for streaming)
   * @throws {Error} If artifact or classification is invalid
   */
  static enrich(artifact, classification) {
    // FAIL FAST: Validate inputs
    this._validateArtifact(artifact);
    this._validateClassification(classification);

    // Create new enriched artifact (immutable)
    const enriched = {
      // Preserve all original properties
      ...artifact,
      
      // Enrich with classification data
      role: classification.role,
      type: classification.type,
      format: classification.format,
      
      // Add language if not already present and provided by classification
      language: artifact.language || classification.language || null,
      
      // Add filename if not already present and provided by classification
      filename: artifact.filename || classification.filename || null,
      
      // Add viewer information (useful for debugging/tracing)
      __viewer: classification.viewer,
      __tab: classification.tab,
      
      // Add enrichment metadata
      __enriched: true,
      __enrichedAt: Date.now(),
      __enrichedBy: 'ArtifactEnricher'
    };

    // Return enriched artifact (mutable for streaming)
    // NOTE: NOT frozen - artifacts need to be mutable for content accumulation during streaming
    return enriched;
  }

  /**
   * Enrich artifact with custom metadata
   * @param {Object} artifact - Original artifact (not modified)
   * @param {Object} metadata - Custom metadata to add
   * @returns {Object} New enriched artifact (mutable)
   * @throws {Error} If inputs are invalid
   */
  static enrichWithMetadata(artifact, metadata) {
    // FAIL FAST: Validate inputs
    this._validateArtifact(artifact);
    
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new Error('[ArtifactEnricher] Metadata must be a plain object');
    }

    // Create new enriched artifact
    const enriched = {
      ...artifact,
      metadata: {
        ...(artifact.metadata || {}),
        ...metadata,
        updatedAt: Date.now()
      }
    };

    return enriched;
  }

  /**
   * Enrich multiple artifacts (batch operation)
   * @param {Array<Object>} artifacts - Array of artifacts
   * @param {Function} enrichFn - Enrichment function (artifact => classification)
   * @returns {Array<Object>} Array of enriched artifacts
   */
  static enrichBatch(artifacts, enrichFn) {
    if (!Array.isArray(artifacts)) {
      throw new Error('[ArtifactEnricher] Artifacts must be an array');
    }

    if (typeof enrichFn !== 'function') {
      throw new Error('[ArtifactEnricher] Enrich function must be a function');
    }

    return artifacts.map((artifact, index) => {
      try {
        const classification = enrichFn(artifact, index);
        return this.enrich(artifact, classification);
      } catch (error) {
        throw new Error(
          `[ArtifactEnricher] Failed to enrich artifact at index ${index}: ${error.message}`
        );
      }
    });
  }

  /**
   * Strip enrichment metadata (for persistence)
   * @param {Object} artifact - Enriched artifact
   * @returns {Object} Artifact without internal metadata
   */
  static stripMetadata(artifact) {
    if (!artifact || typeof artifact !== 'object') {
      throw new Error('[ArtifactEnricher] Artifact must be an object');
    }

    // Create clean copy without internal metadata
    const { 
      __viewer, 
      __tab, 
      __enriched, 
      __enrichedAt, 
      __enrichedBy, 
      ...clean 
    } = artifact;

    return freeze(clean);
  }

  /**
   * Merge artifacts (for updates/patches)
   * @param {Object} base - Base artifact
   * @param {Object} updates - Updates to apply
   * @returns {Object} New merged artifact
   */
  static merge(base, updates) {
    this._validateArtifact(base);
    
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      throw new Error('[ArtifactEnricher] Updates must be a plain object');
    }

    // Create merged artifact
    const merged = {
      ...base,
      ...updates,
      
      // Preserve critical fields from base if not explicitly updated
      id: updates.id !== undefined ? updates.id : base.id,
      artifactId: updates.artifactId !== undefined ? updates.artifactId : base.artifactId,
      
      // Update timestamp
      updatedAt: Date.now()
    };

    return freeze(merged);
  }

  /**
   * Validate artifact has required structure
   * @private
   */
  static _validateArtifact(artifact) {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
      throw new Error('[ArtifactEnricher] Artifact must be a plain object');
    }

    if (!artifact.id && !artifact.artifactId) {
      throw new Error('[ArtifactEnricher] Artifact must have an id or artifactId');
    }
  }

  /**
   * Validate classification has required structure
   * @private
   */
  static _validateClassification(classification) {
    if (!classification || typeof classification !== 'object' || Array.isArray(classification)) {
      throw new Error('[ArtifactEnricher] Classification must be a plain object');
    }

    if (!classification.role || typeof classification.role !== 'string') {
      throw new Error('[ArtifactEnricher] Classification must have a role (string)');
    }

    if (!classification.type || typeof classification.type !== 'string') {
      throw new Error('[ArtifactEnricher] Classification must have a type (string)');
    }

    if (!classification.format || typeof classification.format !== 'string') {
      throw new Error('[ArtifactEnricher] Classification must have a format (string)');
    }

    if (!classification.viewer || typeof classification.viewer !== 'string') {
      throw new Error('[ArtifactEnricher] Classification must have a viewer (string)');
    }
  }

  /**
   * Check if artifact has been enriched
   * @param {Object} artifact - Artifact to check
   * @returns {boolean} True if enriched
   */
  static isEnriched(artifact) {
    if (!artifact || typeof artifact !== 'object') {
      return false;
    }

    return artifact.__enriched === true;
  }

  /**
   * Get enrichment metadata
   * @param {Object} artifact - Enriched artifact
   * @returns {Object|null} Enrichment metadata or null
   */
  static getEnrichmentMetadata(artifact) {
    if (!this.isEnriched(artifact)) {
      return null;
    }

    return freeze({
      enrichedAt: artifact.__enrichedAt,
      enrichedBy: artifact.__enrichedBy,
      viewer: artifact.__viewer,
      tab: artifact.__tab
    });
  }
}

// Export
module.exports = { ArtifactEnricher };
