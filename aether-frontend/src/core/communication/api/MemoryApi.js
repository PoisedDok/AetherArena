'use strict';

/**
 * @.architecture
 * Incoming: Endpoint facade, MemoryManager, UIManager --- {method_call, javascript_api}
 * Processing: Dispatch memory CRUD, search, and relation HTTP requests --- {2 jobs: JOB_HTTP_REQUEST, JOB_VALIDATE_SCHEMA}
 * Outgoing: ApiClient -> /v1/memory/*, /v1/search/memories --- {http_request, json}
 *
 * @module core/communication/api/MemoryApi
 */

const BaseApi = require('./BaseApi');

class MemoryApi extends BaseApi {
  /**
   * Create memory.
   * Security: full data object is NOT logged to prevent sensitive content leakage.
   * @param {Object} data - { content, memory_type, importance_score, metadata, tags, expires_at }
   * @returns {Promise<Object>} Created memory
   */
  async createMemory(data) {
    if (!data || !data.content || !data.memory_type) {
      throw new Error('[Endpoint] content and memory_type are required for createMemory');
    }
    return this._request('POST', '/v1/memory/create', {
      body: data,
      logContext: { memoryType: data.memory_type }
    });
  }

  /**
   * List memories.
   * @param {Object} [filters] - { memory_type, min_importance, max_importance, limit, offset }
   * @returns {Promise<Array>} List of memories
   */
  async listMemories(filters = {}) {
    const params = {
      limit: filters.limit || 50,
      offset: filters.offset || 0
    };
    if (filters.memory_type) params.memory_type = filters.memory_type;
    if (filters.min_importance !== undefined) params.min_importance = filters.min_importance;
    if (filters.max_importance !== undefined) params.max_importance = filters.max_importance;
    if (filters.source_chat_id !== undefined) params.source_chat_id = filters.source_chat_id;

    return this._request('GET', '/v1/memory/list', { params, logContext: { filters } });
  }

  /**
   * Get memory by ID.
   * @param {string} memoryId - Memory UUID (REQUIRED)
   * @returns {Promise<Object>} Memory object
   */
  async getMemory(memoryId) {
    this._requireParam(memoryId, 'memoryId', 'getMemory');
    const path = this._encodePath('/v1/memory/get/:id', { id: memoryId });
    return this._request('GET', path, { logContext: { memoryId } });
  }

  /**
   * Update memory.
   * @param {string} memoryId - Memory UUID (REQUIRED)
   * @param {Object} updates - { content, importance_score, metadata, expires_at }
   * @returns {Promise<Object>} Updated memory
   */
  async updateMemory(memoryId, updates) {
    this._requireParam(memoryId, 'memoryId', 'updateMemory');
    const path = this._encodePath('/v1/memory/update/:id', { id: memoryId });
    return this._request('PATCH', path, { body: updates, logContext: { memoryId } });
  }

  /**
   * Delete memory.
   * @param {string} memoryId - Memory UUID (REQUIRED)
   * @returns {Promise<void>}
   */
  async deleteMemory(memoryId) {
    this._requireParam(memoryId, 'memoryId', 'deleteMemory');
    const path = this._encodePath('/v1/memory/delete/:id', { id: memoryId });
    try {
      await this._api.delete(path);
    } catch (error) {
      if (!error.isBackendUnavailableError) {
        this._log.error(`DELETE /v1/memory/delete/${memoryId} failed`, {
          error: error?.message || error,
          memoryId
        });
      }
      throw error;
    }
  }

  /**
   * Search memories (vector + hybrid search).
   * @param {string} query - Search query (REQUIRED)
   * @param {Object} [options] - { searchType, limit, threshold }
   * @returns {Promise<Object>} Search results { query, results, total_count }
   */
  async searchMemories(query, options = {}) {
    this._requireString(query, 'query', 'searchMemories');
    const payload = {
      query,
      search_type: options.searchType || 'vector',
      match_count: options.limit || 20,
      match_threshold: options.threshold || 0.5
    };
    return this._request('POST', '/v1/search/memories', {
      body: payload,
      logContext: { queryLength: query.length }
    });
  }

  /**
   * Get memory relations.
   * @param {string} memoryId - Memory UUID (REQUIRED)
   * @returns {Promise<Array>} List of memory relations
   */
  async getMemoryRelations(memoryId) {
    this._requireParam(memoryId, 'memoryId', 'getMemoryRelations');
    const path = this._encodePath('/v1/memory/relation/list/:id', { id: memoryId });
    return this._request('GET', path, { logContext: { memoryId } });
  }

  /**
   * Create memory relation.
   * @param {string} memoryId - Source memory UUID (REQUIRED)
   * @param {string} relatedMemoryId - Target memory UUID (REQUIRED)
   * @param {Object} [data] - { relationType, strength }
   * @returns {Promise<Object>} Created relation
   */
  async createMemoryRelation(memoryId, relatedMemoryId, data = {}) {
    if (!memoryId || !relatedMemoryId) {
      throw new Error('[Endpoint] memoryId and relatedMemoryId are required for createMemoryRelation');
    }
    const path = this._encodePath('/v1/memory/relation/create/:id', { id: memoryId });
    const payload = {
      related_memory_id: relatedMemoryId,
      relation_type: data.relationType || 'related_to',
      strength: data.strength || 0.5
    };
    return this._request('POST', path, {
      body: payload,
      logContext: { memoryId, relatedMemoryId }
    });
  }
}

module.exports = MemoryApi;
