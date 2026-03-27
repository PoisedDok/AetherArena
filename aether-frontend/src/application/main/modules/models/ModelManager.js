'use strict';

/**
 * @.architecture
 * 
 * Incoming: MainOrchestrator.refreshModelList calls, MainOrchestrator.probeCapabilities calls --- {lifecycle_types.method_call, string}
 * Processing: Fetch models via Endpoint.getModels() (backend /v1/models), cache capabilities in Map, emit EventBus events (LIST_UPDATED/CAPABILITIES_UPDATED/VISION_DETECTED/CHANGED), update state (models array/currentModel), provide getters for state/capabilities/stats, clear cache, dispose resources --- {6 jobs: JOB_CACHE_LOCALLY, JOB_CLEAR_STATE, JOB_DISPOSE, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_HTTP_REQUEST, JOB_UPDATE_STATE}
 * Outgoing: EventBus.emit (MODEL.* events), return model arrays/capability objects --- {event_types.model_list_updated, model_types.model_array}
 * 
 * @module application/main/modules/models/ModelManager
 * 
 * ModelManager - Manages LLM model detection, capabilities, and configuration
 * ============================================================================
 * Production-ready model management service.
 * 
 * Features:
 * - Backend model list refreshing (/v1/models endpoint)
 * - Model capability probing (vision, context window, reasoning)
 * - Vision model type detection
 * - Model search and filtering
 * - Capability caching
 */

const { EventTypes, EventPriority } = require('../../../../core/events/EventTypes');
const { createRendererLogger } = require('../../../../renderer/shared/utils/logger');
const _log = createRendererLogger('ModelManager');

class ModelManager {
  constructor(options = {}) {
    // Dependencies
    this.endpoint = options.endpoint || null;
    this.eventBus = options.eventBus || null;
    
    // Configuration
    this.enableLogging = options.enableLogging !== undefined ? options.enableLogging : false;
    
    // State
    this.models = [];
    this.currentModel = null;
    this.capabilities = new Map();
    
    // Validation
    if (!this.endpoint) {
      throw new Error('[ModelManager] endpoint required');
    }
    
    if (!this.eventBus) {
      throw new Error('[ModelManager] eventBus required');
    }
  }

  /**
   * Refresh model list from backend
   * CONTRACT: Backend MUST provide models via /v1/models endpoint.
   * Fail-fast: throws on backend failure, no multi-source fallbacks.
   * @param {string} apiBase - API base URL
   * @returns {Promise<Array>} List of available models
   */
  async refreshModelList(apiBase = '') {
    if (this.enableLogging) {
      _log.debug('[ModelManager] Refreshing model list...');
    }

    // CONTRACT: Backend MUST provide models - no multi-source fallbacks
    // Backend endpoint: GET /v1/models (ModelsListResponse)
    const response = await this.endpoint.getModels(apiBase || null);
    
    // CONTRACT: Backend response must be valid
    if (!response || typeof response !== 'object') {
      throw new Error('[ModelManager] CONTRACT VIOLATION: Backend returned invalid models response');
    }

    // Extract models from backend response
    const models = Array.isArray(response.models) 
      ? response.models 
      : (Array.isArray(response) ? response : []);
    
    const modelNames = models
      .filter(Boolean)
      .map(item => typeof item === 'string' ? item : (item?.id || item?.name))
      .filter(Boolean)
      .map(String)
      .sort((a, b) => a.localeCompare(b));

    this.models = modelNames;

    // Emit event
    this.eventBus.emit(EventTypes.MODEL.LIST_UPDATED, {
      models: modelNames,
      count: modelNames.length,
      timestamp: Date.now()
    });

    if (this.enableLogging) {
      _log.debug(`[ModelManager] Found ${modelNames.length} models from backend`);
    }

    return modelNames;
  }
  /**
   * Probe model capabilities (vision, context window, etc)
   * @param {string} modelName - Model identifier
   * @returns {Promise<Object|null>} Capability information
   */
  async probeCapabilities(modelName) {
    if (!modelName) return null;

    try {
      if (this.enableLogging) {
        _log.debug(`[ModelManager] Probing capabilities for "${modelName}"...`);
      }

      const capabilities = await this.endpoint.getModelCapabilities(modelName);
      
      // Cache capabilities
      this.capabilities.set(modelName, {
        ...capabilities,
        timestamp: Date.now()
      });

      // Emit event
      this.eventBus.emit(EventTypes.MODEL.CAPABILITIES_UPDATED, {
        model: modelName,
        capabilities,
        timestamp: Date.now()
      });

      // Emit vision detection event if applicable
      if (capabilities?.supports_vision) {
        this.eventBus.emit(EventTypes.MODEL.VISION_DETECTED, {
          model: modelName,
          timestamp: Date.now()
        });
      }

      if (this.enableLogging) {
        _log.debug(`[ModelManager] Capabilities for "${modelName}":`, capabilities);
      }

      return capabilities;
    } catch (error) {
      _log.error(`[ModelManager] Error probing capabilities for "${modelName}":`, error);
      return null;
    }
  }

  /**
   * Set current model
   * @param {string} modelName - Model to set as current
   */
  setCurrentModel(modelName) {
    if (!modelName) return;

    const previousModel = this.currentModel;
    this.currentModel = modelName;

    // Emit event
    this.eventBus.emit(EventTypes.MODEL.CHANGED, {
      model: modelName,
      previousModel,
      timestamp: Date.now()
    }, { priority: EventPriority.HIGH });

    if (this.enableLogging) {
      _log.debug(`[ModelManager] Current model: ${modelName}`);
    }
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
   * @returns {Array}
   */
  getModels() {
    return [...this.models];
  }

  /**
   * Get cached capabilities
   * @param {string} modelName - Model name
   * @returns {Object|null}
   */
  getCachedCapabilities(modelName) {
    return this.capabilities.get(modelName) || null;
  }

  /**
   * Check if model supports vision
   * @param {string} modelName - Model to check
   * @returns {Promise<boolean|null>} True if supports vision, null if unknown
   */
  async supportsVision(modelName) {
    try {
      if (!modelName) {
        return null;
      }

      const cached = this.capabilities.get(modelName);
      if (cached) {
        return cached.supports_vision || false;
      }

      const capabilities = await this.probeCapabilities(modelName);
      return capabilities?.supports_vision || false;
    } catch (error) {
      _log.error(`[ModelManager] Error checking vision support for "${modelName}":`, error);
      return false;
    }
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
   * Filter models by criteria
   * @param {Function} predicate - Filter function
   * @returns {Array}
   */
  filterModels(predicate) {
    return this.models.filter(predicate);
  }

  /**
   * Search models by keyword
   * @param {string} keyword - Search keyword
   * @returns {Array}
   */
  searchModels(keyword) {
    if (!keyword) return this.models;

    const lowerKeyword = keyword.toLowerCase();
    return this.models.filter(model => 
      model.toLowerCase().includes(lowerKeyword)
    );
  }

  /**
   * Get vision models
   * @returns {Array} Models that likely support vision
   */
  getVisionModels() {
    const visionKeywords = ['vision', 'vlm', 'smoldocling', 'internvl', 'qwen', 'granite', 'pixtral', 'llava'];
    
    return this.models.filter(model => {
      const lowerModel = model.toLowerCase();
      return visionKeywords.some(keyword => lowerModel.includes(keyword));
    });
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    return Object.freeze({
      totalModels: this.models.length,
      currentModel: this.currentModel,
      cachedCapabilities: this.capabilities.size,
      visionModels: this.getVisionModels().length
    });
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.capabilities.clear();
    
    if (this.enableLogging) {
      _log.debug('[ModelManager] Cache cleared');
    }
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    this.models = [];
    this.currentModel = null;
    this.capabilities.clear();
    this.endpoint = null;
    this.eventBus = null;

    if (this.enableLogging) {
      _log.debug('[ModelManager] Disposed');
    }
  }
}

// Export
module.exports = ModelManager;

if (typeof window !== 'undefined') {
  window.ModelManager = ModelManager;
  _log.debug('ModelManager loaded');
}
