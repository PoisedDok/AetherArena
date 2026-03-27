// Incoming: src/preload/main-preload.js::memoryAPI, src/main/services/IpcRouter.js --- {ipc_types.memory_request, json}
// Processing: proxy typed memory IPC commands through ApiClient with schema validation and structured logging --- {3 jobs: JOB_HTTP_REQUEST, JOB_PARSE_JSON, JOB_VALIDATE_SCHEMA}
// Outgoing: aether-backend/api/v1/endpoints/memories.py, src/preload/main-preload.js --- {Dict[str, Any], json}

'use strict';

const { ipcMain } = require('electron');
const { logger } = require('../../core/utils/logger');
const config = require('../../core/config');
const DEFAULTS = require('../../core/config/defaults');
const { ApiClient, TimeoutError } = require('../../core/communication/ApiClient');

class MemoryIpcHandler {
  constructor(options = {}) {
    const backendBase = (config && config.backend && config.backend.baseUrl)
      ? config.backend.baseUrl
      : DEFAULTS.backend.baseUrl;

    this.baseUrl = options.baseUrl || backendBase;
    this.timeout = options.timeout || config.api.timeout || 15000;
    this.logger = logger.child({ module: 'MemoryIpcHandler' });
    this.isInitialized = false;
    this.windowManager = options.windowManager || null;

    // Centralized HTTP client (architecture: reuse shared communication layer)
    this.client = new ApiClient({
      baseURL: this.baseUrl,
      timeout: this.timeout,
      retries: config.api.retries,
      retryDelay: config.api.retryDelay,
      enableLogging: config.dev.verboseLogging,
      circuitBreaker: true,
      rateLimiter: true,
    });
  }

  /**
   * Pass-through: set backend availability on the internal ApiClient.
   * Called from main/index.js when skipHealthCheck=true and no backend discovered.
   * @param {boolean} available
   */
  setBackendAvailable(available) {
    this.client.setBackendAvailable(available);
  }

  /**
   * Helper to register IPC handlers with source validation
   */
  _registerHandle(channel, handler) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (this.windowManager) {
        if (!this.windowManager.isValidWebContents(event.sender)) {
          this.logger.warn('IPC handle from unauthorized source', { channel });
          throw new Error('Unauthorized IPC source');
        }
      }
      return handler(event, ...args);
    });
  }

  /**
   * Initialize IPC handlers (Phase 9B, ticket #134)
   */
  initialize() {
    if (this.isInitialized) {
      this.logger.warn('Memory IPC handlers already initialized');
      return;
    }

    this.logger.info('Initializing memory IPC handlers');

    // Memory CRUD operations
    this._registerHandle('memories:create', (_, { data }) => this._createMemory(data));
    this._registerHandle('memories:list', (_, { filters }) => this._listMemories(filters));
    this._registerHandle('memories:get', (_, { memoryId }) => this._getMemory(memoryId));
    this._registerHandle('memories:update', (_, { memoryId, updates }) => this._updateMemory(memoryId, updates));
    this._registerHandle('memories:delete', (_, { memoryId }) => this._deleteMemory(memoryId));

    // Memory search
    this._registerHandle('memories:search', (_, { query, options }) => this._searchMemories(query, options));

    // Memory relations
    this._registerHandle('memories:get-relations', (_, { memoryId }) => this._getMemoryRelations(memoryId));
    this._registerHandle('memories:create-relation', (_, { memoryId, relatedMemoryId, data }) =>
      this._createMemoryRelation(memoryId, relatedMemoryId, data)
    );
    this._registerHandle('memories:delete-relation', (_, { relationId }) => this._deleteMemoryRelation(relationId));

    // Memory promotion/demotion
    this._registerHandle('memories:promote', (_, { memoryId }) => this._promoteMemory(memoryId));
    this._registerHandle('memories:demote', (_, { memoryId, chatId }) => this._demoteMemory(memoryId, chatId));

    this.isInitialized = true;
    this.logger.info('Memory IPC handlers initialized');
  }

  /**
   * Shutdown and remove handlers
   */
  shutdown() {
    this.logger.info('Shutting down memory IPC handlers');
    
    // Remove all memory IPC handlers (must match all channels from initialize)
    const handlers = [
      'memories:create',
      'memories:list',
      'memories:get',
      'memories:update',
      'memories:delete',
      'memories:search',
      'memories:get-relations',
      'memories:create-relation',
      'memories:delete-relation',
      'memories:promote',
      'memories:demote',
    ];

    handlers.forEach((channel) => {
      ipcMain.removeHandler(channel);
    });

    this.isInitialized = false;
    this.logger.info('Memory IPC handlers shut down');
  }

  /**
   * Make HTTP request to backend
   */
  async _request(method, path, data = null) {
    const url = path; // ApiClient will prefix baseURL when url is relative
    const timeout = this.timeout;

    try {
      switch (method) {
        case 'GET':
          return await this.client.get(url, { timeout });
        case 'POST':
          return await this.client.post(url, data, { timeout });
        case 'PUT':
          return await this.client.put(url, data, { timeout });
        case 'PATCH':
          return await this.client.patch(url, data, { timeout });
        case 'DELETE':
          return await this.client.delete(url, { timeout });
        default:
          throw new Error(`Unsupported HTTP method: ${method}`);
      }
    } catch (error) {
      // Suppress logging for BackendUnavailableError — expected when backend is gated off
      if (!error.isBackendUnavailableError) {
        const isTimeout = error && (error.isTimeoutError || error.name === 'AbortError' || error instanceof TimeoutError);
        this.logger.error('HTTP request failed', {
          method,
          path,
          error: error.message,
          timeoutMs: timeout,
          timeout: isTimeout,
        });
      }
      throw error;
    }
  }

  // ==========================================================================
  // Memory CRUD Operations
  // ==========================================================================

  async _createMemory(data) {
    return this._request('POST', '/v1/memory/create', data);
  }

  async _listMemories(filters = {}) {
    const params = new URLSearchParams();
    params.append('limit', filters.limit || 50);
    params.append('offset', filters.offset || 0);
    if (filters.memory_type) params.append('memory_type', filters.memory_type);
    if (filters.min_importance !== undefined) params.append('min_importance', filters.min_importance);
    if (filters.max_importance !== undefined) params.append('max_importance', filters.max_importance);
    if (filters.source_chat_id !== undefined) params.append('source_chat_id', filters.source_chat_id);

    return this.client.get(`/v1/memory/list?${params.toString()}`);
  }

  async _getMemory(memoryId) {
    return this._request('GET', `/v1/memory/get/${memoryId}`);
  }

  async _updateMemory(memoryId, updates) {
    return this._request('PATCH', `/v1/memory/update/${memoryId}`, updates);
  }

  async _deleteMemory(memoryId) {
    return this._request('DELETE', `/v1/memory/delete/${memoryId}`);
  }

  async _promoteMemory(memoryId) {
    return this._request('POST', `/v1/memory/promote/${memoryId}`, {});
  }

  async _demoteMemory(memoryId, chatId) {
    return this._request('POST', `/v1/memory/demote/${memoryId}`, { chat_id: chatId });
  }

  // ==========================================================================
  // Memory Search
  // ==========================================================================

  async _searchMemories(query, options = {}) {
    const payload = {
      query,
      search_type: options.searchType || 'vector',
      limit: options.limit || 20,
      threshold: options.threshold || 0.5
    };
    return this._request('POST', '/v1/search/memories', payload);
  }

  // ==========================================================================
  // Memory Relations
  // ==========================================================================

  async _getMemoryRelations(memoryId) {
    return this._request('GET', `/v1/memory/relation/list/${memoryId}`);
  }

  async _createMemoryRelation(memoryId, relatedMemoryId, data = {}) {
    const payload = {
      related_memory_id: relatedMemoryId,
      relation_type: data.relationType || 'related_to',
      strength: data.strength || 0.5
    };
    return this._request('POST', `/v1/memory/relation/create/${memoryId}`, payload);
  }

  async _deleteMemoryRelation(relationId) {
    return this._request('DELETE', `/v1/memory/relation/delete/${relationId}`);
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let globalHandler = null;

/**
 * Get or create global handler instance
 */
function getMemoryHandler(options = {}) {
  if (!globalHandler) {
    globalHandler = new MemoryIpcHandler(options);
  }
  return globalHandler;
}

/**
 * Create new handler instance
 */
function createMemoryHandler(options = {}) {
  return new MemoryIpcHandler(options);
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  MemoryIpcHandler,
  getMemoryHandler,
  createMemoryHandler,
};
