'use strict';

/**
 * @.architecture
 * 
 * Incoming: ModelManager.refreshModelList(), SettingsManager.setModel() (method calls for model operations) --- {model_name | api_base, string}
 * Processing: Refresh models via SettingsRepository.loadModels(), set current model (validate via SettingsValidator), probe capabilities via repository.loadCapabilities(), detect vision support, emit events (models:updated/model:changed/capabilities:probed), maintain _modelSettings state (ModelSettings instance) --- {5 jobs: JOB_EMIT_EVENT, JOB_GET_STATE, JOB_HTTP_REQUEST, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA}
 * Outgoing: SettingsRepository.loadModels/loadCapabilities() (backend queries), EventBus.emit() (events), return ModelSettings instances --- {model_settings, javascript_object}
 * 
 * 
 * @module domain/settings/services/ModelService
 */

const { ModelSettings } = require('../models/ModelSettings');
const { SettingsValidator } = require('../validators/SettingsValidator');

class ModelService {
  /**
   * @param {Object} dependencies - Injected dependencies
   * @param {Object} dependencies.repository - Settings repository
   * @param {Object} dependencies.eventBus - Event bus for events
   */
  constructor(dependencies = {}) {
    this.repository = dependencies.repository || null;
    this.eventBus = dependencies.eventBus || null;
    this._modelSettings = ModelSettings.create([]);
  }

  /**
   * Refresh model list from all sources
   * @param {string} apiBase - API base URL
   * @returns {Promise<ModelSettings>}
   */
  async refreshModels(apiBase = '') {
    if (!this.repository) {
      throw new Error('Repository not configured');
    }

    try {
      this._modelSettings = await this.repository.loadModels(apiBase);

      // Emit event
      if (this.eventBus) {
        this.eventBus.emit('models:updated', {
          models: this._modelSettings.getAvailableModels(),
          count: this._modelSettings.getModelCount(),
          timestamp: Date.now(),
        });
      }

      return this._modelSettings;
    } catch (error) {
      throw new Error(`Failed to refresh models: ${error.message}`);
    }
  }

  /**
   * Set current model
   * @param {string} modelName - Model name
   */
  setModel(modelName) {
    // Validate model name
    const validation = SettingsValidator.validateModelName(modelName);
    if (!validation.valid) {
      throw new Error(`Invalid model name: ${validation.errors.join(', ')}`);
    }

    // Check if model exists
    if (!this._modelSettings.hasModel(modelName)) {
      throw new Error(`Model "${modelName}" not found`);
    }

    const previousModel = this._modelSettings.getCurrentModel();
    
    // Update current model
    this._modelSettings.setCurrentModel(modelName);

    // Emit event
    if (this.eventBus) {
      this.eventBus.emit('model:changed', {
        model: modelName,
        previousModel,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Probe model capabilities
   * @param {string} modelName - Model name
   * @returns {Promise<Object>}
   */
  async probeCapabilities(modelName) {
    if (!this.repository) {
      throw new Error('Repository not configured');
    }

    // Validate model name
    const validation = SettingsValidator.validateModelName(modelName);
    if (!validation.valid) {
      throw new Error(`Invalid model name: ${validation.errors.join(', ')}`);
    }

    try {
      const capabilities = await this.repository.loadModelCapabilities(modelName);
      
      // Cache capabilities
      this._modelSettings.setCapabilities(modelName, capabilities.toJSON());

      // Emit event
      if (this.eventBus) {
        this.eventBus.emit('model:capabilities-updated', {
          model: modelName,
          capabilities: capabilities.toJSON(),
          timestamp: Date.now(),
        });

        // Emit vision detection event if applicable
        if (capabilities.supportsVision()) {
          this.eventBus.emit('model:vision-detected', {
            model: modelName,
            timestamp: Date.now(),
          });
        }
      }

      return capabilities.toJSON();
    } catch (error) {
      throw new Error(`Failed to probe capabilities: ${error.message}`);
    }
  }

  /**
   * Get current model
   * @returns {string|null}
   */
  getCurrentModel() {
    return this._modelSettings.getCurrentModel();
  }

  /**
   * Get all models
   * @returns {string[]}
   */
  getModels() {
    return this._modelSettings.getAvailableModels();
  }

  /**
   * Check if model exists
   * @param {string} modelName - Model name
   * @returns {boolean}
   */
  hasModel(modelName) {
    return this._modelSettings.hasModel(modelName);
  }

  /**
   * Get cached capabilities
   * @param {string} modelName - Model name
   * @returns {Object|null}
   */
  getCachedCapabilities(modelName) {
    return this._modelSettings.getCapabilities(modelName);
  }

  /**
   * Check if model supports vision
   * @param {string} modelName - Model name
   * @returns {Promise<boolean>}
   */
  async supportsVision(modelName) {
    // Check cache first
    const cached = this._modelSettings.getCapabilities(modelName);
    if (cached) {
      return cached.supports_vision || false;
    }

    // Probe capabilities
    try {
      const capabilities = await this.probeCapabilities(modelName);
      return capabilities.supports_vision || false;
    } catch (error) {
      console.error(`Failed to check vision support: ${error.message}`);
      return false;
    }
  }

  /**
   * Detect vision model type
   * @param {string} modelName - Model name
   * @returns {string}
   */
  detectVisionModelType(modelName) {
    return this._modelSettings.detectVisionModelType(modelName);
  }

  /**
   * Search models by keyword
   * @param {string} keyword - Search keyword
   * @returns {string[]}
   */
  searchModels(keyword) {
    return this._modelSettings.searchModels(keyword);
  }

  /**
   * Filter models by predicate
   * @param {Function} predicate - Filter function
   * @returns {string[]}
   */
  filterModels(predicate) {
    return this._modelSettings.filterModels(predicate);
  }

  /**
   * Get vision models
   * @returns {string[]}
   */
  getVisionModels() {
    return this._modelSettings.getVisionModels();
  }

  /**
   * Clear capabilities cache
   */
  clearCache() {
    this._modelSettings.clearCapabilitiesCache();

    if (this.eventBus) {
      this.eventBus.emit('model:cache-cleared', { timestamp: Date.now() });
    }
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStatistics() {
    return this._modelSettings.getStatistics();
  }

  /**
   * Cleanup
   */
  cleanup() {
    this._modelSettings = ModelSettings.create([]);

    if (this.eventBus) {
      this.eventBus.emit('models:cleanup', { timestamp: Date.now() });
    }
  }
}

module.exports = { ModelService };

