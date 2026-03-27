'use strict';

/**
 * @.architecture
 * 
 * Incoming: Constructor data (availableModels/currentModel/capabilities), method calls (create/setAvailableModels/setCurrentModel/searchModels/filterModels/setCapabilities/getCapabilities/clearCapabilitiesCache/getStatistics/toJSON/fromJSON), JSON data --- {method_calls, object | array | string}
 * Processing: Initialize availableModels array, currentModel string, capabilities Map, sort models alphabetically, set/get current model, validate model exists (hasModel), search models by keyword (case-insensitive includes), filter models by predicate function, get vision models (keywords: vision/vlm/smoldocling/internvl/qwen/granite/pixtral/llava), detect vision model type (internvl/qwen/smoldocling/pixtral/llava/granite, default: smoldocling), set/get/clear capabilities cache (Map with timestamp), get statistics (totalModels/currentModel/cachedCapabilities/visionModels), convert to JSON (excludes capabilities Map, includes counts) --- {10 jobs: JOB_CLEAR_STATE, JOB_GET_STATE, JOB_GET_STATE, JOB_GET_STATE, JOB_INITIALIZE, JOB_PARSE_JSON, JOB_STRINGIFY_JSON, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA}
 * Outgoing: Return values (models array, current model string, capabilities object, statistics, JSON), throw Error for invalid model --- {array | string | object | null, javascript_object | Error}
 * 
 * 
 * @module domain/settings/models/ModelSettings
 * 
 * ModelSettings Model
 * Represents LLM model settings
 * 
 * Manages model list, current selection, and capabilities
 */

class ModelSettings {
  /**
   * @param {Object} data - Model settings data
   * @param {string[]} data.availableModels - List of available models
   * @param {string|null} data.currentModel - Currently selected model
   * @param {Map} data.capabilities - Model capabilities cache
   */
  constructor(data = {}) {
    this.availableModels = data.availableModels || [];
    this.currentModel = data.currentModel || null;
    this.capabilities = data.capabilities || new Map();
  }

  /**
   * Create from model list
   * @param {string[]} models - List of available models
   * @param {string|null} currentModel - Current model
   * @returns {ModelSettings}
   */
  static create(models = [], currentModel = null) {
    return new ModelSettings({
      availableModels: models.map(String).sort((a, b) => a.localeCompare(b)),
      currentModel,
      capabilities: new Map(),
    });
  }

  /**
   * Set available models
   * @param {string[]} models - List of models
   */
  setAvailableModels(models) {
    this.availableModels = models.map(String).sort((a, b) => a.localeCompare(b));
  }

  /**
   * Set current model
   * @param {string} modelName - Model name
   */
  setCurrentModel(modelName) {
    if (!this.hasModel(modelName)) {
      throw new Error(`Model "${modelName}" not found in available models`);
    }
    this.currentModel = modelName;
  }

  /**
   * Get current model
   * @returns {string|null}
   */
  getCurrentModel() {
    return this.currentModel;
  }

  /**
   * Get all models
   * @returns {string[]}
   */
  getAvailableModels() {
    return [...this.availableModels];
  }

  /**
   * Check if model exists
   * @param {string} modelName - Model name
   * @returns {boolean}
   */
  hasModel(modelName) {
    return this.availableModels.includes(modelName);
  }

  /**
   * Search models by keyword
   * @param {string} keyword - Search keyword
   * @returns {string[]}
   */
  searchModels(keyword) {
    if (!keyword) return this.availableModels;

    const lowerKeyword = keyword.toLowerCase();
    return this.availableModels.filter(model =>
      model.toLowerCase().includes(lowerKeyword)
    );
  }

  /**
   * Filter models by predicate
   * @param {Function} predicate - Filter function
   * @returns {string[]}
   */
  filterModels(predicate) {
    return this.availableModels.filter(predicate);
  }

  /**
   * Get vision models
   * @returns {string[]}
   */
  getVisionModels() {
    const visionKeywords = ['vision', 'vlm', 'smoldocling', 'internvl', 'qwen', 'granite', 'pixtral', 'llava'];

    return this.availableModels.filter(model => {
      const lowerModel = model.toLowerCase();
      return visionKeywords.some(keyword => lowerModel.includes(keyword));
    });
  }

  /**
   * Detect vision model type from name
   * @param {string} modelName - Model name
   * @returns {string} Vision model type
   */
  detectVisionModelType(modelName) {
    if (!modelName) return 'smoldocling';

    const lowerName = modelName.toLowerCase();

    if (lowerName.includes('internvl')) return 'internvl';
    if (lowerName.includes('qwen')) return 'qwen';
    if (lowerName.includes('smoldocling')) return 'smoldocling';
    if (lowerName.includes('pixtral')) return 'pixtral';
    if (lowerName.includes('llava')) return 'llava';
    if (lowerName.includes('granite')) return 'granite';

    return 'smoldocling'; // Default
  }

  /**
   * Set model capabilities
   * @param {string} modelName - Model name
   * @param {Object} capabilities - Capabilities object
   */
  setCapabilities(modelName, capabilities) {
    this.capabilities.set(modelName, {
      ...capabilities,
      timestamp: Date.now(),
    });
  }

  /**
   * Get model capabilities
   * @param {string} modelName - Model name
   * @returns {Object|null}
   */
  getCapabilities(modelName) {
    return this.capabilities.get(modelName) || null;
  }

  /**
   * Check if capabilities are cached
   * @param {string} modelName - Model name
   * @returns {boolean}
   */
  hasCapabilities(modelName) {
    return this.capabilities.has(modelName);
  }

  /**
   * Clear capabilities cache
   */
  clearCapabilitiesCache() {
    this.capabilities.clear();
  }

  /**
   * Get model count
   * @returns {number}
   */
  getModelCount() {
    return this.availableModels.length;
  }

  /**
   * Check if has models
   * @returns {boolean}
   */
  hasModels() {
    return this.availableModels.length > 0;
  }

  /**
   * Check if current model is set
   * @returns {boolean}
   */
  hasCurrentModel() {
    return this.currentModel !== null;
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStatistics() {
    return {
      totalModels: this.availableModels.length,
      currentModel: this.currentModel,
      cachedCapabilities: this.capabilities.size,
      visionModels: this.getVisionModels().length,
    };
  }

  /**
   * Convert to plain object
   * @returns {Object}
   */
  toJSON() {
    return {
      availableModels: [...this.availableModels],
      currentModel: this.currentModel,
      capabilitiesCount: this.capabilities.size,
      visionModelsCount: this.getVisionModels().length,
    };
  }

  /**
   * Create from plain object
   * @param {Object} json - Plain object
   * @returns {ModelSettings}
   */
  static fromJSON(json) {
    return new ModelSettings({
      availableModels: json.availableModels || [],
      currentModel: json.currentModel || null,
      capabilities: new Map(),
    });
  }
}

module.exports = { ModelSettings };
