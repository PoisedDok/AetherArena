'use strict';

/**
 * @.architecture
 * 
 * Incoming: Application layer (UIManager.js, ModelManager.js, ProfileManager.js, SettingsManager.js) --- {method_calls, javascript_api}
 * Processing: Facade pattern - route to GuruConnection (WebSocket) or ApiClient (HTTP), create message objects, manage lifecycle, delegate requests --- {6 jobs: JOB_DELEGATE_TO_MODULE, JOB_DISPOSE, JOB_GET_STATE, JOB_HTTP_REQUEST, JOB_INITIALIZE, JOB_ROUTE_BY_TYPE}
 * Outgoing: GuruConnection.send() → Backend WebSocket, ApiClient.request() → Backend REST API --- {websocket_stream_chunk | http_request, json}
 * 
 * 
 * @module core/communication/Endpoint
 * 
 * Endpoint - Unified Communication Layer
 * ============================================================================
 * Single entry point for all frontend communication:
 * - WebSocket via GuruConnection (streaming, real-time)
 * - HTTP via ApiClient (REST, settings, health checks)
 * 
 * This centralizes all backend communication and provides a clean API
 * for the rest of the application.
 */

const GuruConnection = require('./GuruConnection');
const { ApiClient } = require('./ApiClient');
const { freeze } = Object;

class Endpoint {
  constructor(config) {
    if (!config) {
      throw new Error('[Endpoint] Configuration required');
    }

    this.config = config;
    
    // Initialize WebSocket connection
    this.connection = new GuruConnection({
      url: config.WS_URL,
      reconnectDelay: 2000,
      pingInterval: 30000,
      healthInterval: 5000,
      enableLogging: false
    });

    // Initialize HTTP client
    this.api = new ApiClient({
      baseURL: config.API_BASE_URL,
      timeout: 12000,
      retries: 2,
      retryDelay: 500,
      circuitBreaker: true,
      enableLogging: false
    });

    // Add default interceptors
    this._setupInterceptors();
  }

  // ============================================================================
  // HTTP Methods (REST API)
  // ============================================================================

  /**
   * Get backend health
   * @returns {Promise<Object>}
   */
  async getHealth() {
    return this.api.get('/v1/health');
  }

  /**
   * Get settings
   * @returns {Promise<Object>}
   */
  async getSettings() {
    return this.api.get('/v1/settings');
  }

  /**
   * Update settings
   * @param {Object} settings - Settings payload
   * @returns {Promise<Object>}
   */
  async setSettings(settings) {
    return this.api.post('/v1/settings', settings);
  }

  /**
   * Get TOML settings (preferred)
   * @returns {Promise<Object>}
   */
  async getTOMLSettings() {
    return this.api.get('/models-config/settings');
  }

  /**
   * Update TOML settings (preferred)
   * @param {Object} settings - Settings payload
   * @returns {Promise<Object>}
   */
  async setTOMLSettings(settings) {
    return this.api.post('/models-config/settings', settings);
  }

  /**
   * List available models
   * @param {string} apiBaseOverride - Optional API base override
   * @returns {Promise<Array>}
   */
  async getModels(apiBaseOverride = null) {
    const query = apiBaseOverride ? `?base=${encodeURIComponent(apiBaseOverride)}` : '';
    return this.api.get(`/v1/models${query}`);
  }

  /**
   * Get TOML models (preferred)
   * @returns {Promise<Array>}
   */
  async getTOMLModels() {
    return this.api.get('/models-config/models');
  }

  /**
   * List available profiles
   * @returns {Promise<Array>}
   */
  async getProfiles() {
    return this.api.get('/v1/profiles');
  }

  /**
   * Get model capabilities
   * @param {string} modelName - Model name
   * @returns {Promise<Object>}
   */
  async getModelCapabilities(modelName) {
    const encoded = encodeURIComponent(modelName || '');
    return this.api.get(`/v1/models/capabilities?model=${encoded}`);
  }

  /**
   * Stop current generation
   * @returns {Promise<Object>}
   */
  async stopGeneration() {
    return this.api.post('/api/stop-generation');
  }

  // ============================================================================
  // WebSocket Methods (Real-time Communication)
  // ============================================================================

  /**
   * Send user message
   * @param {string} text - Message text
   * @param {string} id - Frontend-generated message ID (SessionManager ID)
   * @returns {string} Frontend ID
   */
  sendUserMessage(text, id = null) {
    // Validate content
    if (!text || typeof text !== 'string') {
      throw new Error('[Endpoint] Message content must be a non-empty string');
    }
    
    if (text.trim().length === 0) {
      throw new Error('[Endpoint] Message content cannot be empty');
    }
    
    // Size validation (100KB limit)
    const maxSize = 100000;
    if (text.length > maxSize) {
      throw new Error(`[Endpoint] Message exceeds maximum size of ${maxSize} characters`);
    }
    
    if (!id) {
      console.error('[Endpoint] CRITICAL: No frontend ID provided, generating fallback');
      id = `fallback_${Date.now()}`;
    }

    const message = {
      role: 'user',
      type: 'message',
      content: text,
      id,  // Frontend ID (SessionManager format)
      frontend_id: id,  // Explicit frontend ID for backend correlation
      timestamp: Date.now()
    };

    // LOG EXIT POINT: Data leaving frontend
    console.log('[Endpoint] 🚀 EXIT POINT: Sending to backend:', {
      frontend_id: id,
      contentLength: text.length,
      messageType: 'user_message',
      connected: this.connection?.ws?.readyState === WebSocket.OPEN,
      timestamp: message.timestamp
    });

    this.connection.send(message);

    return id;
  }

  /**
   * Send user message with image
   * @param {string} text - Message text
   * @param {string} imageBase64 - Base64 encoded image (without data URI prefix)
   * @param {string} id - Frontend-generated message ID
   * @returns {string} Frontend ID
   */
  sendUserMessageWithImage(text = '', imageBase64, id = null) {
    if (!imageBase64) {
      return this.sendUserMessage(text, id);
    }
    
    // Validate image
    if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
      throw new Error('[Endpoint] Image must be a non-empty base64 string');
    }
    
    // Size validation (10MB image limit)
    const maxImageSize = 10 * 1024 * 1024; // 10MB in bytes (base64 is ~1.37x original)
    if (imageBase64.length > maxImageSize) {
      throw new Error(`[Endpoint] Image exceeds maximum size of ${maxImageSize} bytes`);
    }
    
    // Validate text if provided
    if (text && typeof text !== 'string') {
      throw new Error('[Endpoint] Message text must be a string');
    }
    
    // Size validation for text (100KB limit)
    if (text && text.length > 100000) {
      throw new Error('[Endpoint] Message text exceeds maximum size of 100KB');
    }

    if (!id) {
      console.error('[Endpoint] CRITICAL: No frontend ID provided, generating fallback');
      id = `fallback_${Date.now()}`;
    }

    const message = {
      role: 'user',
      type: 'message',
      content: text,
      image: imageBase64,
      id,
      frontend_id: id,
      timestamp: Date.now()
    };

    // LOG EXIT POINT: Data with image leaving frontend
    console.log('[Endpoint] 🚀 EXIT POINT: Sending with image to backend:', {
      frontend_id: id,
      contentLength: text.length,
      hasImage: true,
      imageSize: imageBase64.length,
      messageType: 'user_message_with_image',
      timestamp: message.timestamp
    });

    this.connection.send(message);

    return id;
  }

  /**
   * Stream audio data
   * @param {ArrayBuffer} arrayBuffer - Audio data
   */
  streamAudio(arrayBuffer) {
    this.connection.streamAudio(arrayBuffer);
  }

  /**
   * Subscribe to WebSocket events
   * @param {string} event - Event name
   * @param {Function} handler - Event handler
   */
  on(event, handler) {
    this.connection.on(event, handler);
  }

  /**
   * Unsubscribe from WebSocket events
   * @param {string} event - Event name
   * @param {Function} handler - Event handler
   */
  off(event, handler) {
    this.connection.off(event, handler);
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Get backend URL
   * @returns {string}
   */
  getBackendURL() {
    return this.config.API_BASE_URL;
  }

  /**
   * Get WebSocket URL
   * @returns {string}
   */
  getWebSocketURL() {
    return this.config.WS_URL;
  }

  /**
   * Get connection stats
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
   * Dispose endpoint
   */
  dispose() {
    this.connection.dispose();
    // ApiClient doesn't need disposal
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Setup HTTP interceptors
   * @private
   */
  _setupInterceptors() {
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
        // Response interceptor can transform or log responses
        return response;
      });
    }
  }

  /**
   * Get authentication token
   * @private
   */
  _getAuthToken() {
    // TODO: Implement token management if needed
    return null;
  }
}

// Export
module.exports = Endpoint;

if (typeof window !== 'undefined') {
  window.Endpoint = Endpoint;
  console.log('📦 Endpoint loaded');
}

