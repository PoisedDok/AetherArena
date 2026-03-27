// Incoming: src/preload/chat-preload/storageAPI.js, src/main/services/IpcRouter.js --- {ipc_types.storage_request, json}
// Processing: proxy typed storage IPC commands through ApiClient with schema validation and structured logging --- {3 jobs: JOB_HTTP_REQUEST, JOB_PARSE_JSON, JOB_VALIDATE_SCHEMA}
// Outgoing: aether-backend/api/v1/endpoints/storage.py, src/preload/chat-preload/storageAPI.js --- {Dict[str, Any], json}

'use strict';

const { ipcMain } = require('electron');
const { logger } = require('../../core/utils/logger');
const config = require('../../core/config');
const DEFAULTS = require('../../core/config/defaults');
const { ApiClient, TimeoutError, BackendUnavailableError } = require('../../core/communication/ApiClient');
const { randomUUID } = require('crypto');

class StorageIpcHandler {
  constructor(options = {}) {
    const backendBase = (config && config.backend && config.backend.baseUrl)
      ? config.backend.baseUrl
      : DEFAULTS.backend.baseUrl;

    this.baseUrl = options.baseUrl || backendBase;
    this.timeout = options.timeout || config.api.timeout || 15000;
    this.logger = logger.child({ module: 'StorageIpcHandler' });
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
   * Initialize IPC handlers
   */
  initialize() {
    if (this.isInitialized) {
      this.logger.warn('Storage IPC handlers already initialized');
      return;
    }

    this.logger.info('Initializing storage IPC handlers');

    // Chat operations
    this._registerHandle('storage:load-chats', () => this._loadChats());
    this._registerHandle('storage:load-chat', (_, { chatId }) => this._loadChat(chatId));
    this._registerHandle('storage:create-chat', (_, { title }) => this._createChat(title));
    this._registerHandle('storage:update-chat-title', (_, { chatId, title }) => this._updateChatTitle(chatId, title));
    this._registerHandle('storage:delete-chat', (_, { chatId }) => this._deleteChat(chatId));

    // Message operations
    this._registerHandle('storage:load-messages', (_, { chatId }) => this._loadMessages(chatId));
    this._registerHandle('storage:save-message', (_, { chatId, message }) => this._saveMessage(chatId, message));

    // Artifact operations
    this._registerHandle('storage:load-artifacts', (_, { chatId }) => this._loadArtifacts(chatId));
    this._registerHandle('storage:save-artifact', (_, { chatId, artifact }) => this._saveArtifact(chatId, artifact));
    this._registerHandle('storage:update-artifact-message-id', (_, { artifactId, messageId, chatId }) => 
      this._updateArtifactMessageId(artifactId, messageId, chatId)
    );
    this._registerHandle('storage:delete-artifact', (_, { artifactId }) => this._deleteArtifact(artifactId));

    // Traceability operations
    this._registerHandle('storage:get-message-artifacts', (_, { messageId }) => this._getMessageArtifacts(messageId));
    this._registerHandle('storage:get-artifact-source', (_, { artifactId }) => this._getArtifactSource(artifactId));
    this._registerHandle('storage:get-llm-metadata', (_, { messageId }) => this._getLLMMetadata(messageId));

    // Trail hierarchy operations (NEW ARCHITECTURE - replaces legacy trail_states)
    // See contracts/README.md (Trail hierarchy + invariants)
    this._registerHandle('storage:load-trail-hierarchy', (_, { chatId }) => this._loadTrailHierarchy(chatId));

    // Chat summary operations (Phase 9B, ticket #133)
    this._registerHandle('storage:summarize-chat', (_, { chatId, summaryType }) =>
      this._summarizeChat(chatId, summaryType)
    );
    this._registerHandle('storage:generate-chat-summary', (_, { chatId, summaryType, forceRegenerate }) =>
      this._generateChatSummary(chatId, summaryType, forceRegenerate)
    );
    this._registerHandle('storage:get-chat-summaries', (_, { chatId }) =>
      this._getChatSummaries(chatId)
    );
    this._registerHandle('storage:search-chats', (_, { query, options }) =>
      this._searchChats(query, options)
    );

    // Health operations
    this._registerHandle('storage:health-check', () => this._healthCheck());
    this._registerHandle('storage:test-connection', () => this._testConnection());
    this._registerHandle('storage:get-stats', () => this._getStats());

    this.isInitialized = true;
    this.logger.info('Storage IPC handlers initialized');
  }

  /**
   * Shutdown and remove handlers
   */
  shutdown() {
    this.logger.info('Shutting down storage IPC handlers');
    
    // Remove all storage IPC handlers
    const handlers = [
      'storage:load-chats',
      'storage:load-chat',
      'storage:create-chat',
      'storage:update-chat-title',
      'storage:delete-chat',
      'storage:load-messages',
      'storage:save-message',
      'storage:load-artifacts',
      'storage:save-artifact',
      'storage:update-artifact-message-id',
      'storage:delete-artifact',
      'storage:get-message-artifacts',
      'storage:get-artifact-source',
      'storage:get-llm-metadata',
      'storage:load-trail-hierarchy',
      'storage:summarize-chat',
      'storage:generate-chat-summary',
      'storage:get-chat-summaries',
      'storage:search-chats',
      'storage:health-check',
      'storage:test-connection',
      'storage:get-stats',
    ];

    handlers.forEach((channel) => {
      ipcMain.removeHandler(channel);
    });

    this.isInitialized = false;
    this.logger.info('Storage IPC handlers shut down');
  }

  /**
   * Make HTTP request to backend
   */
  async _request(method, path, data = null) {
    const url = path; // ApiClient will prefix baseURL when url is relative
    const timeout = this._getTimeout(method, path);

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

  /**
   * Determine per-endpoint timeout budget to avoid premature aborts
   */
  _getTimeout(method, path) {
    // Base from config with sane default
    const base = this.timeout || config.api.timeout || 15000;

    // Chat title update occasionally competes with interpreter pipeline; give it more room
    if ((method === 'PUT' || method === 'PATCH') && /^\/v1\/api\/storage\/chats\/[0-9a-f-]+$/i.test(path)) {
      return Math.max(base, 30000);
    }

    // Artifact save operations can be heavier
    if ((method === 'POST') && /^\/v1\/api\/storage\/chats\/[0-9a-f-]+\/artifacts$/i.test(path)) {
      return Math.max(base, 25000);
    }

    return base;
  }

  /**
   * Heuristic: detect backend-unavailable/network errors (as opposed to valid backend responses like 4xx).
   * @private
   */
  _isBackendUnavailableError(error) {
    try {
      if (!error) return false;
      // BackendUnavailableError from ApiClient (centralized gate)
      if (error.isBackendUnavailableError) return true;
      if (error && (error.isTimeoutError || error.name === 'AbortError' || error instanceof TimeoutError)) {
        return true;
      }

      const msg = String(error.message || '');
      if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('Failed to fetch')) {
        return true;
      }

      const causeCode = error?.cause?.code;
      if (typeof causeCode === 'string') {
        const offlineCodes = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EHOSTUNREACH', 'ETIMEDOUT']);
        if (offlineCodes.has(causeCode)) {
          return true;
        }
      }
    } catch (e) {
      // ignore
    }
    return false;
  }

  _nowIso() {
    try {
      return new Date().toISOString();
    } catch (e) {
      return null;
    }
  }

  _makeOfflineId() {
    if (typeof randomUUID !== 'function') {
      throw new Error('[StorageIpcHandler] CONTRACT VIOLATION: crypto.randomUUID is required for offline chat ID generation.');
    }
    return randomUUID();
  }

  // ==========================================================================
  // Chat Operations
  // ==========================================================================

  async _loadChats() {
    try {
      const result = await this._request('GET', '/v1/storage/chat/list');
      return Array.isArray(result) ? result : [];
    } catch (error) {
      // Offline-safe: allow renderer to boot with empty chat list
      this.logger.warn('Backend unavailable: returning empty chat list', {
        error: error?.message || String(error),
      });
      return [];
    }
  }

  async _loadChat(chatId) {
    try {
      const [chat, messages] = await Promise.all([
        this._request('GET', `/v1/storage/chat/get/${chatId}`),
        this._request('GET', `/v1/storage/message/list/${chatId}`),
      ]);

      return {
        ...chat,
        messages: Array.isArray(messages) ? messages : [],
      };
    } catch (error) {
      // Offline-safe: return a minimal shell to keep UI stable
      this.logger.warn('Backend unavailable: returning minimal chat shell', {
        chatId,
        error: error?.message || String(error),
      });
      return {
        id: chatId,
        title: 'Offline',
        messages: [],
      };
    }
  }

  async _createChat(title = 'New Chat') {
    try {
      return await this._request('POST', '/v1/storage/chat/create', { title });
    } catch (error) {
      if (!this._isBackendUnavailableError(error)) {
        throw error;
      }

      // Offline-safe: return a minimal chat stub so the renderer can continue UX flows.
      const now = this._nowIso();
      const chatId = this._makeOfflineId();
      this.logger.warn('Backend unavailable: returning offline chat stub', {
        chatId,
        error: error?.message || String(error),
      });
      return {
        id: chatId,
        title: String(title || 'Offline'),
        created_at: now,
        updated_at: now,
        offline: true,
      };
    }
  }

  async _updateChatTitle(chatId, title) {
    try {
      return await this._request('PUT', `/v1/storage/chat/update/${chatId}`, { title });
    } catch (error) {
      if (!this._isBackendUnavailableError(error)) {
        throw error;
      }
      this.logger.warn('Backend unavailable: skipping chat title update', {
        chatId,
        error: error?.message || String(error),
      });
      return { ok: false, offline: true, chatId };
    }
  }

  async _deleteChat(chatId) {
    try {
      return await this._request('DELETE', `/v1/storage/chat/delete/${chatId}`);
    } catch (error) {
      if (!this._isBackendUnavailableError(error)) {
        throw error;
      }
      this.logger.warn('Backend unavailable: skipping chat delete', {
        chatId,
        error: error?.message || String(error),
      });
      return { ok: false, offline: true, chatId };
    }
  }

  // ==========================================================================
  // Message Operations
  // ==========================================================================

  async _loadMessages(chatId) {
    try {
      const result = await this._request('GET', `/v1/storage/message/list/${chatId}`);
      return Array.isArray(result) ? result : [];
    } catch (error) {
      this.logger.warn('Backend unavailable: returning empty messages list', {
        chatId,
        error: error?.message || String(error),
      });
      return [];
    }
  }

  async _saveMessage(chatId, message) {
    try {
      return await this._request('POST', `/v1/storage/message/create/${chatId}`, message);
    } catch (error) {
      if (!this._isBackendUnavailableError(error)) {
        throw error;
      }
      this.logger.warn('Backend unavailable: skipping message save', {
        chatId,
        error: error?.message || String(error),
      });
      return { ok: false, offline: true, chatId };
    }
  }

  // ==========================================================================
  // Artifact Operations
  // ==========================================================================

  async _loadArtifacts(chatId) {
    try {
      const result = await this._request('GET', `/v1/storage/artifact/list/${chatId}`);
      return Array.isArray(result) ? result : [];
    } catch (error) {
      this.logger.warn('Backend unavailable: returning empty artifacts list', {
        chatId,
        error: error?.message || String(error),
      });
      return [];
    }
  }

  async _saveArtifact(chatId, artifact) {
    try {
      return await this._request('POST', `/v1/storage/artifact/create/${chatId}`, artifact);
    } catch (error) {
      if (!this._isBackendUnavailableError(error)) {
        throw error;
      }
      this.logger.warn('Backend unavailable: skipping artifact save', {
        chatId,
        error: error?.message || String(error),
      });
      return { ok: false, offline: true, chatId };
    }
  }

  async _updateArtifactMessageId(artifactId, messageId, chatId) {
    const payload = {
      artifact_id: artifactId,
      message_id: messageId,
    };

    if (chatId) {
      payload.chat_id = chatId;
    }

    try {
      return await this._request('PUT', `/v1/storage/artifact/link-message`, payload);
    } catch (error) {
      if (!this._isBackendUnavailableError(error)) {
        throw error;
      }
      this.logger.warn('Backend unavailable: skipping artifact message link', {
        artifactId,
        messageId,
        chatId,
        error: error?.message || String(error),
      });
      return { ok: false, offline: true, artifactId, messageId, chatId };
    }
  }

  async _deleteArtifact(artifactId) {
    try {
      return await this._request('DELETE', `/v1/storage/artifact/delete/${artifactId}`);
    } catch (error) {
      if (!this._isBackendUnavailableError(error)) {
        throw error;
      }
      this.logger.warn('Backend unavailable: skipping artifact delete', {
        artifactId,
        error: error?.message || String(error),
      });
      return { ok: false, offline: true, artifactId };
    }
  }

  // ==========================================================================
  // Traceability Operations
  // ==========================================================================

  async _getMessageArtifacts(messageId) {
    return this._request('GET', `/v1/storage/artifact/list/message/${messageId}`);
  }

  async _getArtifactSource(artifactId) {
    // CRITICAL FIX: Changed from /source (returns message) to direct artifact endpoint (returns artifact with content)
    return this._request('GET', `/v1/storage/artifact/get/${artifactId}`);
  }

  async _getLLMMetadata(messageId) {
    return this._request('GET', `/v1/storage/message/llm-metadata/get/${messageId}`);
  }

  // =============================================================================
  // Trail Hierarchy Operations (NEW ARCHITECTURE)
  // =============================================================================

  /**
   * Load trail hierarchy for chat (groups → subgroups → nodes)
   * See contracts/README.md (Trail hierarchy + invariants)
   * @param {string} chatId - Chat UUID
   * @returns {Promise<Array>} Trail hierarchy structure
   */
  async _loadTrailHierarchy(chatId) {
    try {
      const result = await this._request('GET', `/v1/storage/trail/hierarchy/get/${chatId}`);
      return Array.isArray(result) ? result : [];
    } catch (error) {
      this.logger.warn('Backend unavailable: returning empty trail hierarchy', {
        chatId,
        error: error?.message || String(error),
      });
      return [];
    }
  }

  // ==========================================================================
  // Trail State Operations REMOVED
  // ==========================================================================
  // Legacy trail state persistence removed - backend persists trails automatically
  // via WebSocket events in trail_service.py. Frontend loads trails from:
  //   GET /v1/storage/trail/hierarchy/get/{chatId}

  // ==========================================================================
  // Chat Summary Operations (Phase 9B, ticket #133)
  // ==========================================================================
  
  async _generateChatSummary(chatId, summaryType = 'full', forceRegenerate = false) {
    // ARCHITECTURE NOTE: Summary generation uses LLM and can take 30-60 seconds.
    // Use extended timeout (120s) to prevent premature client-side timeout.
    // FUTURE_WORK: Migrate to async job queue + WebSocket progress notification (Section 7.2).
    return this.client.post(`/v1/storage/summary/create/${chatId}`, {
      summary_type: summaryType,
      force_regenerate: Boolean(forceRegenerate)
    }, {
      timeout: 120000  // 120 seconds for LLM operations
    });
  }
  async _summarizeChat(chatId, summaryType = 'full') {
    return this._request('POST', `/v1/storage/summary/create/${chatId}`, {
      summary_type: summaryType
    });
  }

  async _getChatSummaries(chatId) {
    return this._request('GET', `/v1/storage/summary/list/${chatId}`);
  }

  async _searchChats(query, options = {}) {
    return this._request('POST', '/v1/search/chats', {
      query,
      limit: options.limit || 20,
      search_type: options.searchType || 'hybrid',
      min_score: options.minScore || 0.3
    });
  }

  // ==========================================================================
  // Health Operations
  // ==========================================================================

  async _healthCheck() {
    try {
      const result = await this._request('GET', '/v1/health');
      const status = String(result?.status || '').toLowerCase();
      const healthy = status === 'healthy' || status === 'ok';
      return { healthy, ...result };
    } catch (error) {
      return { healthy: false, error: error.message };
    }
  }

  async _testConnection() {
    return this._healthCheck();
  }

  async _getStats() {
    return this._request('GET', '/v1/storage/stats');
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let globalHandler = null;

/**
 * Get or create global handler instance
 */
function getStorageHandler(options = {}) {
  if (!globalHandler) {
    globalHandler = new StorageIpcHandler(options);
  }
  return globalHandler;
}

/**
 * Create new handler instance
 */
function createStorageHandler(options = {}) {
  return new StorageIpcHandler(options);
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  StorageIpcHandler,
  getStorageHandler,
  createStorageHandler,
};
