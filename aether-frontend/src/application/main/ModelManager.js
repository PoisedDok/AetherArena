'use strict';

/**
 * @.architecture
 * 
 * Incoming: MainOrchestrator.refreshModelList calls, MainOrchestrator.probeCapabilities calls --- {lifecycle_types.method_call, string}
 * Processing: Fetch models via Endpoint HTTP methods, merge/deduplicate, cache in Map, emit EventBus events --- {4 jobs: JOB_CACHE_LOCALLY, JOB_EMIT_EVENT, JOB_HTTP_REQUEST, JOB_UPDATE_STATE}
 * Outgoing: EventBus.emit (MODEL.* events), return model arrays/capability objects --- {event_types.model_list_updated, model_types.model_array}
 * 
 * @module application/main/ModelManager
 * 
 * ModelManager - Manages LLM model detection, capabilities, and configuration
 * ============================================================================
 * Production-ready model management service.
 * 
 * Features:
 * - Multi-source model list refreshing (TOML, provider, direct)
 * - Model capability probing (vision, context window, reasoning)
 * - Vision model type detection
 * - Model search and filtering
 * - Capability caching
 */

const { EventTypes, EventPriority } = require('../../core/events/EventTypes');

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
   * Refresh model list from all sources
   * @param {string} apiBase - API base URL
   * @returns {Promise<Array>} List of available models
   */
  async refreshModelList(apiBase = '') {
    if (this.enableLogging) {
      console.log('[ModelManager] Refreshing model list...');
    }

    try {
      // Fetch from multiple sources in parallel
      const [tomlResult, providerResult, directResult] = await Promise.allSettled([
        this.endpoint.getTOMLModels(),
        this.endpoint.getModels(apiBase || null),
        this._fetchDirectModels(apiBase)
      ]);

      // Parse results
      const tomlModels = this._extractModels(tomlResult, 'toml');
      const providerModels = this._extractModels(providerResult, 'provider');
      const directModels = this._extractModels(directResult, 'direct');

      // Merge and deduplicate
      const merged = Array.from(new Set([
        ...tomlModels,
        ...providerModels,
        ...directModels
      ])).filter(Boolean).map(String).sort((a, b) => a.localeCompare(b));

      this.models = merged;

      // Emit event
      this.eventBus.emit(EventTypes.MODEL.LIST_UPDATED, {
        models: merged,
        sources: {
          toml: tomlModels.length,
          provider: providerModels.length,
          direct: directModels.length
        },
        timestamp: Date.now()
      });

      if (this.enableLogging) {
        console.log(`[ModelManager] Found ${merged.length} models (TOML: ${tomlModels.length}, Provider: ${providerModels.length}, Direct: ${directModels.length})`);
      }

      return merged;
    } catch (error) {
      console.error('[ModelManager] Error refreshing model list:', error);
      return [];
    }
  }

  /**
   * Fetch models directly from LM Studio
   * @private
   */
  async _fetchDirectModels(apiBase) {
    if (!apiBase) return [];

    try {
      const url = `${apiBase.replace(/\/$/, '')}/models`;
      const response = await fetch(url, { 
        cache: 'no-cache',
        headers: { 'Accept': 'application/json' }
      });

      if (!response.ok) return [];

      const data = await response.json();

      // Handle different response formats
      if (Array.isArray(data)) {
        return data.map(item => 
          typeof item === 'string' ? item : (item?.id || item?.name)
        ).filter(Boolean);
      }

      if (data?.data && Array.isArray(data.data)) {
        return data.data.map(item => item?.id || item?.name).filter(Boolean);
      }

      return [];
    } catch (error) {
      if (this.enableLogging) {
        console.warn('[ModelManager] Direct fetch failed:', error.message);
      }
      return [];
    }
  }

  /**
   * Extract models from Promise result
   * @private
   */
  _extractModels(result, source) {
    if (result.status !== 'fulfilled') return [];

    const value = result.value;

    // Handle array responses
    if (Array.isArray(value)) {
      return value.filter(Boolean).map(String);
    }

    // Handle object responses
    if (value && Array.isArray(value.models)) {
      return value.models.filter(Boolean).map(String);
    }

    return [];
  }

  /**
   * Probe model capabilities (vision, context window, etc)
   * @param {string} modelName - Model identifier
   * @returns {Promise<Object|null>} Capability information
   */
  async probeCapabilities(modelName) {
    if (!modelName) return null;

    if (this.enableLogging) {
      console.log(`[ModelManager] Probing capabilities for "${modelName}"...`);
    }

    try {
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
        console.log(`[ModelManager] Capabilities for "${modelName}":`, capabilities);
      }

      return capabilities;
    } catch (error) {
      console.error(`[ModelManager] Error probing capabilities for "${modelName}":`, error);
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
      console.log(`[ModelManager] Current model: ${modelName}`);
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
    if (!modelName) return null;

    // Check cache first
    const cached = this.capabilities.get(modelName);
    if (cached) {
      return cached.supports_vision || false;
    }

    // Probe capabilities
    const capabilities = await this.probeCapabilities(modelName);
    return capabilities?.supports_vision || false;
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
      console.log('[ModelManager] Cache cleared');
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
      console.log('[ModelManager] Disposed');
    }
  }
}

// Export
module.exports = ModelManager;

if (typeof window !== 'undefined') {
  window.ModelManager = ModelManager;
  console.log('📦 ModelManager loaded');
}

