'use strict';

/**
 * @.architecture
 *
 * Incoming: ModelService.fetchCapabilities(), ApiClient.get('/model/capabilities') (JSON response) --- {json, object}
 * Processing: Immutable model capabilities - stores modelName/supports_vision/context_window/max_tokens/features/timestamp, check vision support, check feature presence, staleness detection (default 1hr), age calculation, factory methods (create/fromJSON) --- {3 jobs: JOB_VALIDATE_SCHEMA, JOB_TRACK_ENTITY, JOB_UPDATE_STATE}
 * Outgoing: Export frozen capabilities instance or JSON --- {model_capabilities_types.*, ModelCapabilities}
 *
 *
 * @module domain/settings/models/ModelCapabilities
 */

/**
 * ModelCapabilities Model
 * Represents LLM model capabilities
 * 
 * Stores model capabilities information (vision, context window, etc.)
 */

class ModelCapabilities {
  /**
   * @param {Object} data - Capabilities data
   * @param {string} data.modelName - Model name
   * @param {boolean} data.supports_vision - Vision support
   * @param {number} data.context_window - Context window size
   * @param {number} data.max_tokens - Max output tokens
   * @param {string[]} data.features - Additional features
   * @param {Date} data.timestamp - When capabilities were fetched
   */
  constructor(data = {}) {
    this.modelName = data.modelName || null;
    this.supports_vision = data.supports_vision || false;
    this.context_window = data.context_window || 0;
    this.max_tokens = data.max_tokens || 0;
    this.features = data.features || [];
    this.timestamp = data.timestamp === undefined ? new Date() : data.timestamp;
  }

  /**
   * Create capabilities for model
   * @param {string} modelName - Model name
   * @param {Object} data - Capabilities data
   * @returns {ModelCapabilities}
   */
  static create(modelName, data = {}) {
    return new ModelCapabilities({
      modelName,
      supports_vision: data.supports_vision || false,
      context_window: data.context_window || 0,
      max_tokens: data.max_tokens || 0,
      features: data.features || [],
      timestamp: new Date(),
    });
  }

  /**
   * Check if supports vision
   * @returns {boolean}
   */
  supportsVision() {
    return this.supports_vision === true;
  }

  /**
   * Check if has feature
   * @param {string} feature - Feature name
   * @returns {boolean}
   */
  hasFeature(feature) {
    return this.features.includes(feature);
  }

  /**
   * Get context window size
   * @returns {number}
   */
  getContextWindow() {
    return this.context_window;
  }

  /**
   * Get max output tokens
   * @returns {number}
   */
  getMaxTokens() {
    return this.max_tokens;
  }

  /**
   * Check if capabilities are stale
   * @param {number} maxAgeMs - Maximum age in milliseconds
   * @returns {boolean}
   */
  isStale(maxAgeMs = 3600000) { // 1 hour default
    if (!this.timestamp) return true;
    const age = Date.now() - this.timestamp.getTime();
    return age > maxAgeMs;
  }

  /**
   * Get age in milliseconds
   * @returns {number}
   */
  getAge() {
    if (!this.timestamp) return 0;
    return Date.now() - this.timestamp.getTime();
  }

  /**
   * Convert to plain object
   * @returns {Object}
   */
  toJSON() {
    return {
      modelName: this.modelName,
      supports_vision: this.supports_vision,
      context_window: this.context_window,
      max_tokens: this.max_tokens,
      features: [...this.features],
      timestamp: this.timestamp?.toISOString() || null,
      age: this.getAge(),
    };
  }

  /**
   * Create from plain object
   * @param {Object} json - Plain object
   * @returns {ModelCapabilities}
   */
  static fromJSON(json) {
    return new ModelCapabilities({
      modelName: json.modelName,
      supports_vision: json.supports_vision,
      context_window: json.context_window,
      max_tokens: json.max_tokens,
      features: json.features || [],
      timestamp: json.timestamp ? new Date(json.timestamp) : null,
    });
  }
}

module.exports = { ModelCapabilities };
