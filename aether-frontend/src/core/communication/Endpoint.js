'use strict';

/**
 * @.architecture
 * Incoming: Application modules (MainOrchestrator, ChatOrchestrator, SettingsManager) --- {method_call, javascript_api}
 * Processing: Facade that composes domain API modules, sets up interceptors, delegates all methods --- {3 jobs: JOB_COMPOSE_MODULES, JOB_SETUP_INTERCEPTORS, JOB_DELEGATE_METHODS}
 * Outgoing: GuruConnection.send(), ApiClient.request() --- {websocket_message | http_request, json}
 *
 * Endpoint is a thin facade (~120 lines) that:
 * 1. Constructs ApiClient (HTTP) and GuruConnection (WebSocket)
 * 2. Sets up request interceptors (auth, correlation, tracing)
 * 3. Composes 13 domain API modules and auto-delegates their methods
 * 4. Exposes utility methods (getBackendURL, getStats, dispose)
 *
 * Domain API modules (in ./api/):
 *   HealthApi, SettingsApi, AgentApi, ChatApi, ArtifactApi,
 *   MemoryApi, McpApi, SourcesApi, ModelProfileApi, FileIndexingApi,
 *   ContextApi, MessagingApi
 */

const GuruConnection = require('./GuruConnection');
const { ApiClient } = require('./ApiClient');
const { logger } = require('../utils/logger');
const { freeze } = Object;
const endpointLogger = logger.child({ module: 'Endpoint' });

// Domain API modules
const HealthApi = require('./api/HealthApi');
const SettingsApi = require('./api/SettingsApi');
const AgentApi = require('./api/AgentApi');
const ChatApi = require('./api/ChatApi');
const ArtifactApi = require('./api/ArtifactApi');
const MemoryApi = require('./api/MemoryApi');
const McpApi = require('./api/McpApi');
const SourcesApi = require('./api/SourcesApi');
const ModelProfileApi = require('./api/ModelProfileApi');
const FileIndexingApi = require('./api/FileIndexingApi');
const ContextApi = require('./api/ContextApi');
const MessagingApi = require('./api/MessagingApi');

class Endpoint {
  constructor(config) {
    if (!config) {
      throw new Error('[Endpoint] Configuration required');
    }

    this.config = config;

    // Resolve backend availability upfront so both layers share the same gate
    // from the very first instruction (before GuruConnection auto-connect fires).
    const backendAvailable = config.backendAvailable !== undefined
      ? Boolean(config.backendAvailable)
      : true;

    // Initialize WebSocket connection
    // deferConnect: if true, WebSocket won't auto-connect in constructor.
    // Caller (MainApp) must call endpoint.connection.connect() after onboarding gate.
    this.connection = new GuruConnection({
      url: config.WS_URL,
      reconnectDelay: 2000,
      pingInterval: 30000,
      healthInterval: 5000,
      enableLogging: false,
      deferConnect: config.deferConnect || false,
      backendAvailable
    });

    // Initialize HTTP client
    this.api = new ApiClient({
      baseURL: config.API_BASE_URL,
      timeout: 30000,
      retries: 2,
      retryDelay: 500,
      circuitBreaker: false,
      enableLogging: true,
      backendAvailable
    });

    // Add default interceptors
    this._setupInterceptors();

    // Compose domain API modules and auto-delegate their public methods
    this._composeModules();
  }

  // ============================================================================
  // Module Composition
  // ============================================================================

  /**
   * Compose domain API modules and bind their public methods onto this Endpoint instance.
   * This preserves the existing public API: endpoint.getHealth(), endpoint.sendUserMessage(), etc.
   * @private
   */
  _composeModules() {
    const ctx = {
      api: this.api,
      connection: this.connection,
      config: this.config,
      logger: endpointLogger
    };

    const modules = [
      new HealthApi(ctx),
      new SettingsApi(ctx),
      new AgentApi(ctx),
      new ChatApi(ctx),
      new ArtifactApi(ctx),
      new MemoryApi(ctx),
      new McpApi(ctx),
      new SourcesApi(ctx),
      new ModelProfileApi(ctx),
      new FileIndexingApi(ctx),
      new ContextApi(ctx),
      new MessagingApi(ctx),
    ];

    for (const mod of modules) {
      const proto = Object.getPrototypeOf(mod);
      for (const name of Object.getOwnPropertyNames(proto)) {
        // Skip constructor and private methods (prefixed with _)
        if (name === 'constructor' || name.startsWith('_')) continue;
        // Only bind functions
        if (typeof mod[name] !== 'function') continue;
        // Don't overwrite existing Endpoint methods (getBackendURL, getStats, dispose, etc.)
        if (this[name] !== undefined) continue;

        this[name] = mod[name].bind(mod);
      }
    }
  }

  // ============================================================================
  // Utility Methods (owned by Endpoint, not delegated)
  // ============================================================================

  /**
   * Get backend URL.
   * @returns {string}
   */
  getBackendURL() {
    return this.config.API_BASE_URL;
  }

  /**
   * Get WebSocket URL.
   * @returns {string}
   */
  getWebSocketURL() {
    return this.config.WS_URL;
  }

  /**
   * Get connection stats.
   * @returns {Object}
   */
  getStats() {
    return freeze({
      websocket: this.connection.getStats(),
      http: {
        circuitBreaker: this.api.getCircuitBreakerState(),
        rateLimiter: this.api.getRateLimiterStats()
      }
    });
  }

  /**
   * Dispose endpoint (cleanup WebSocket connection).
   */
  dispose() {
    this.connection.dispose();
    // ApiClient doesn't need disposal
  }

  /**
   * Set backend availability on both HTTP (ApiClient) and WebSocket (GuruConnection) layers.
   * When false, all HTTP requests reject with BackendUnavailableError and WebSocket
   * connect/reconnect/healthCheck are silently skipped. Zero network calls, zero log spam.
   * @param {boolean} available
   */
  setBackendAvailable(available) {
    this.api.setBackendAvailable(available);
    this.connection.setBackendAvailable(available);
  }

  /**
   * @returns {boolean} Current backend availability state (from HTTP layer)
   */
  isBackendAvailable() {
    return this.api.isBackendAvailable();
  }

  // ============================================================================
  // Interceptors (owned by Endpoint, not delegated)
  // ============================================================================

  /**
   * Setup HTTP interceptors for auth, tracing, and correlation.
   * @private
   */
  _setupInterceptors() {
    // Attach trace/context headers for every request
    this.api.addRequestInterceptor((config) => {
      config.headers = config.headers || {};

      // Frontend instance identifier (stable for app lifetime)
      if (!this._frontendInstanceId) {
        this._frontendInstanceId = this._generateFrontendInstanceId();
      }
      if (!config.headers['X-Frontend-Id']) {
        config.headers['X-Frontend-Id'] = this._frontendInstanceId;
      }

      // Correlation ID per request (idempotent if already provided)
      if (!config.headers['X-Correlation-Id']) {
        config.headers['X-Correlation-Id'] = this._generateCorrelationId();
      }

      // Session ID (if available from SessionManager)
      const sessionId = this._resolveSessionId();
      if (sessionId && !config.headers['X-Session-Id']) {
        config.headers['X-Session-Id'] = sessionId;
      }

      return config;
    });

    // Add authorization header if token exists
    this.api.addRequestInterceptor((config) => {
      const token = this._getAuthToken();
      if (token) {
        config.headers['Authorization'] = `Bearer ${token}`;
      }
      return config;
    });

    // Log errors in development
    if (this.config.NODE_ENV !== 'production') {
      this.api.addResponseInterceptor((response) => {
        return response;
      });
    }
  }

  /**
   * Get authentication token.
   * @private
   */
  _getAuthToken() {
    // Desktop single-user mode: no bearer token required (auth handled by local-only binding).
    // FUTURE_WORK: Implement token management for multi-user/cloud deployment (Section 7.2).
    return null;
  }

  _generateFrontendInstanceId() {
    // CONTRACT: Frontend instance ID generation must succeed - fail-fast if crypto unavailable
    // eslint-disable-next-line no-undef
    if (typeof crypto === 'undefined' || !crypto.randomUUID) {
      throw new Error('[Endpoint] CONTRACT VIOLATION: crypto.randomUUID is required for frontend instance ID generation. Browser environment must support Web Crypto API.');
    }

    try {
      return `fe-${crypto.randomUUID()}`;
    } catch (error) {
      throw new Error(`[Endpoint] CONTRACT VIOLATION: Failed to generate frontend instance ID: ${error.message}`);
    }
  }

  _generateCorrelationId() {
    // CONTRACT: Correlation ID generation must succeed - fail-fast if crypto unavailable
    // eslint-disable-next-line no-undef
    if (typeof crypto === 'undefined' || !crypto.randomUUID) {
      throw new Error('[Endpoint] CONTRACT VIOLATION: crypto.randomUUID is required for correlation ID generation. Browser environment must support Web Crypto API.');
    }

    try {
      return crypto.randomUUID();
    } catch (error) {
      throw new Error(`[Endpoint] CONTRACT VIOLATION: Failed to generate correlation ID: ${error.message}`);
    }
  }

  _resolveSessionId() {
    // CONTRACT: Session ID resolution - return null if unavailable (optional header)
    try {
      if (typeof window !== 'undefined' && window.sessionManager && typeof window.sessionManager.getActiveSession === 'function') {
        const s = window.sessionManager.getActiveSession();
        return s && s.chatId ? s.chatId : null;
      }
    } catch (error) {
      endpointLogger.debug('Session ID unavailable', { error: error?.message });
    }
    return null;
  }
}

// Export
module.exports = Endpoint;

if (typeof window !== 'undefined') {
  window.Endpoint = Endpoint;
  endpointLogger.debug('module loaded');
}
