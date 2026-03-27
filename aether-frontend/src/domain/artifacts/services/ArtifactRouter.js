'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactsController.loadArtifact(artifact, options) --- {artifact_types.*, object}
 * Processing: Route artifacts to correct viewers (code/output/files), determine tab switching behavior, classify artifact presentation, validate routing rules --- {4 jobs: JOB_ROUTE_BY_TYPE, JOB_VALIDATE_SCHEMA, JOB_FILTER_DATA, JOB_NORMALIZE_DATA}
 * Outgoing: Return routing decision {viewer, tab, shouldAutoSwitch, classification} --- {routing_decision, object}
 * 
 * ARCHITECTURE:
 * - Pure business logic (routing rules, classification)
 * - No I/O, no side effects
 * - Wraps existing ArtifactPresentationResolver for backward compatibility
 * - Provides extension points for new artifact types
 * - Fail-fast on invalid artifacts
 * - Testable in isolation
 * 
 * ROUTING RULES:
 * - assistant:code → code viewer
 * - computer:output → output viewer
 * - computer:console → output viewer
 * - file → files viewer
 * - Execution origin → output viewer (auto-switch)
 * - Stream final → auto-switch to appropriate viewer
 * 
 * @module domain/artifacts/services/ArtifactRouter
 */

const { resolveArtifactPresentation } = require('../utils/ArtifactPresentationResolver');
const { freeze } = Object;

// Viewer types
const VIEWERS = freeze({
  CODE: 'code',
  OUTPUT: 'output',
  FILES: 'files',
  CONSOLE: 'console'
});

// Origins that trigger auto-switch
const AUTO_SWITCH_ORIGINS = freeze(['execution', 'load-output', 'file', 'file-import']);

// Special handling rules
const ROUTING_RULES = freeze({
  // Force output viewer for these scenarios
  FORCE_OUTPUT_ORIGINS: freeze(['execution', 'load-output']),
  
  // Never auto-switch for these origins
  NO_AUTO_SWITCH_ORIGINS: freeze(['stream-chunk', 'background']),
  
  // Priority order for viewer selection
  VIEWER_PRIORITY: freeze([
    { role: 'computer', type: 'console', viewer: 'output', priority: 10 },
    { role: 'computer', type: 'output', viewer: 'output', priority: 9 },
    { role: 'computer', type: 'code', viewer: 'output', priority: 8 },
    { role: 'assistant', type: 'code', viewer: 'code', priority: 7 },
    { role: 'assistant', type: 'html', viewer: 'code', priority: 6 },
    { role: 'user', type: 'file', viewer: 'files', priority: 5 }
  ])
});

class ArtifactRouter {
  /**
   * Route artifact to appropriate viewer
   * @param {Object} artifact - Artifact to route
   * @param {Object} options - Routing options
   * @param {boolean} options.autoSwitch - Enable auto-switch
   * @param {boolean} options.forceAutoSwitch - Force auto-switch (override rules)
   * @param {boolean} options.forceOutput - Force output viewer
   * @param {string} options.origin - Origin of artifact (execution, stream, manual, etc.)
   * @param {boolean} options.isFinal - Is this the final artifact in a stream
   * @param {string} options.currentTab - Currently active tab
   * @param {string} options.chatId - Chat ID context
   * @returns {Object} Routing decision
   * @throws {Error} If artifact is invalid
   */
  static route(artifact, options = {}) {
    // FAIL FAST: Validate artifact
    this._validateArtifact(artifact);

    // Delegate to existing presentation resolver for backward compatibility
    // This ensures zero drift with current behavior
    const classification = resolveArtifactPresentation(artifact, {
      autoSwitch: options.autoSwitch,
      forceAutoSwitch: options.forceAutoSwitch,
      forceOutput: options.forceOutput,
      origin: options.origin || null,
      isFinal: Boolean(options.isFinal),
      currentTab: options.currentTab,
      chatId: options.chatId || artifact.chatId
    });

    // Enrich with additional routing metadata
    const routingDecision = this._enrichClassification(classification, options);

    return freeze(routingDecision);
  }

  /**
   * Validate artifact has required fields
   * @private
   */
  static _validateArtifact(artifact) {
    if (!artifact || typeof artifact !== 'object') {
      throw new Error('[ArtifactRouter] Artifact must be an object');
    }

    if (!artifact.id && !artifact.artifactId) {
      throw new Error('[ArtifactRouter] Artifact must have an id or artifactId');
    }

    // Relaxed validation: type and role can be inferred from classification
    // But we should at least have content or a clear indicator of what this artifact is
    if (artifact.content === undefined && !artifact.type) {
      throw new Error('[ArtifactRouter] Artifact must have content or type');
    }
  }

  /**
   * Enrich classification with routing metadata
   * @private
   */
  static _enrichClassification(classification, options) {
    return {
      // Core classification (from resolver)
      viewer: classification.viewer,
      tab: classification.tab,
      shouldAutoSwitch: classification.shouldAutoSwitch,
      role: classification.role,
      type: classification.type,
      format: classification.format,
      language: classification.language,
      filename: classification.filename,
      content: classification.content,
      
      // Additional routing metadata
      origin: options.origin || null,
      isFinal: Boolean(options.isFinal),
      currentTab: options.currentTab || null,
      
      // Routing reason (for debugging/tracing)
      routingReason: this._getRoutingReason(classification, options),
      
      // Timestamp
      timestamp: Date.now()
    };
  }

  /**
   * Get human-readable routing reason
   * @private
   */
  static _getRoutingReason(classification, options) {
    if (options.forceAutoSwitch) {
      return 'Forced auto-switch (forceAutoSwitch=true)';
    }

    if (options.forceOutput) {
      return 'Forced output viewer (forceOutput=true)';
    }

    if (classification.viewer === 'files') {
      return `File artifact (type=${classification.type})`;
    }

    if (classification.viewer === 'code') {
      return `Code artifact (role=${classification.role}, type=${classification.type})`;
    }

    if (classification.viewer === 'output') {
      if (classification.role === 'computer') {
        return `Computer output (role=computer, type=${classification.type})`;
      }
      
      if (options.origin === 'execution') {
        return 'Execution result';
      }

      if (options.origin === 'load-output') {
        return 'Output loading requested';
      }

      if (options.isFinal) {
        return 'Final artifact in stream';
      }

      return `Output artifact (type=${classification.type}, format=${classification.format})`;
    }

    // Note: resolveArtifactPresentation always returns 'files', 'code', or 'output'.
    // This fallback exists only as defense against future resolver changes.
    return `Routed to ${classification.viewer}`;
  }

  /**
   * Check if artifact should auto-switch tabs
   * @param {Object} artifact - Artifact to check
   * @param {Object} options - Routing options
   * @returns {boolean} True if should auto-switch
   */
  static shouldAutoSwitch(artifact, options = {}) {
    // Quick validation
    if (!artifact || typeof artifact !== 'object') {
      return false;
    }

    // Force auto-switch if explicitly requested
    if (options.forceAutoSwitch === true) {
      return true;
    }

    // Explicit disable
    if (options.autoSwitch === false) {
      return false;
    }

    // Never auto-switch for these origins
    if (options.origin && ROUTING_RULES.NO_AUTO_SWITCH_ORIGINS.includes(options.origin)) {
      return false;
    }

    // Auto-switch for these origins
    if (options.origin && AUTO_SWITCH_ORIGINS.includes(options.origin)) {
      return true;
    }

    // Auto-switch for final stream artifacts
    if (options.isFinal === true) {
      return true;
    }

    // Auto-switch for computer role (execution results)
    const role = (artifact.role || '').toLowerCase();
    if (role === 'computer') {
      return true;
    }

    // Default: no auto-switch
    return false;
  }

  /**
   * Get viewer for artifact (without full classification)
   * @param {Object} artifact - Artifact to check
   * @param {Object} options - Routing options
   * @returns {string} Viewer name
   */
  static getViewer(artifact, options = {}) {
    const classification = this.route(artifact, options);
    return classification.viewer;
  }

  /**
   * Check if artifact is routed to code viewer
   * @param {Object} artifact - Artifact to check
   * @param {Object} options - Routing options
   * @returns {boolean} True if routed to code viewer
   */
  static isCodeArtifact(artifact, options = {}) {
    return this.getViewer(artifact, options) === VIEWERS.CODE;
  }

  /**
   * Check if artifact is routed to output viewer
   * @param {Object} artifact - Artifact to check
   * @param {Object} options - Routing options
   * @returns {boolean} True if routed to output viewer
   */
  static isOutputArtifact(artifact, options = {}) {
    return this.getViewer(artifact, options) === VIEWERS.OUTPUT;
  }

  /**
   * Check if artifact is routed to files viewer
   * @param {Object} artifact - Artifact to check
   * @param {Object} options - Routing options
   * @returns {boolean} True if routed to files viewer
   */
  static isFileArtifact(artifact, options = {}) {
    return this.getViewer(artifact, options) === VIEWERS.FILES;
  }

  /**
   * Get supported viewers
   */
  static getViewers() {
    return { ...VIEWERS };
  }

  /**
   * Get routing rules (for display/documentation)
   */
  static getRoutingRules() {
    return { ...ROUTING_RULES };
  }
}

// Export
module.exports = { 
  ArtifactRouter,
  VIEWERS,
  ROUTING_RULES
};
