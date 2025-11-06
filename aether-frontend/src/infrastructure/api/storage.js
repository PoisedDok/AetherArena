'use strict';

/**
 * @.architecture
 * 
 * Incoming: Repositories (.loadChats/.saveMessage/.saveArtifact/.updateArtifactMessageId calls) --- {method_calls, javascript_api}
 * Processing: Wrap ApiClient with PostgreSQL-specific operations, construct baseURL from config (backend.baseUrl + endpoints.storageApi), CRUD for chats (loadChats/loadChat/createChat/updateChatTitle/deleteChat), CRUD for messages (loadMessages/saveMessage), CRUD for artifacts (loadArtifacts/saveArtifact/updateArtifactMessageId/deleteArtifact), traceability queries (getMessageArtifacts/getArtifactSource), health check, error logging wrapper --- {4 jobs: JOB_GET_STATE, JOB_HTTP_REQUEST, JOB_LOAD_FROM_DB, JOB_SAVE_TO_DB}
 * Outgoing: ApiClient HTTP requests to backend:8765/storage/*, return Promise<json> --- {database_types.*, json}
 * 
 * 
 * @module infrastructure/api/storage
 * 
 * Storage API Client
 * ============================================================================
 * Infrastructure layer for PostgreSQL storage backend
 * Uses ApiClient for production-grade HTTP communication with:
 * - Automatic retries
 * - Circuit breaker
 * - Rate limiting
 * - Timeout handling
 */

const { ApiClient } = require('../../core/communication/ApiClient');
const config = require('../../core/config');
const { freeze } = Object;

/**
 * StorageAPI - PostgreSQL Backend Client
 */
class StorageAPI {
  constructor(options = {}) {
    // Use centralized config for baseURL
    const defaultBaseURL = `${config.backend.baseUrl}${config.endpoints.storageApi}`;
    this.baseURL = options.baseURL || defaultBaseURL;
    
    this.client = new ApiClient({
      baseURL: this.baseURL,
      timeout: options.timeout || 15000,
      retries: options.retries !== undefined ? options.retries : 3,
      retryDelay: 500,
      circuitBreaker: true,
      rateLimiter: true,
      enableLogging: options.enableLogging || false
    });
    
    this.enableLogging = options.enableLogging || false;
  }

  /**
   * Error logging wrapper
   * @private
   */
  async _withErrorLogging(operation, fn) {
    try {
      return await fn();
    } catch (error) {
      console.error(`[StorageAPI] ${operation} failed:`, {
        operation,
        error: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  // ==========================================================================
  // Chat Operations
  // ==========================================================================

  /**
   * Load all chats ordered by most recently updated
   * @returns {Promise<Array>}
   */
  async loadChats() {
    return this._withErrorLogging('loadChats', async () => {
      const chats = await this.client.get('/chats');
      
      if (this.enableLogging) {
        console.log(`[StorageAPI] Loaded ${chats.length} chats`);
      }
      
      return chats;
    });
  }

  /**
   * Load a specific chat with all messages
   * @param {string} chatId - Chat ID
   * @returns {Promise<Object>}
   */
  async loadChat(chatId) {
    return this._withErrorLogging('loadChat', async () => {
      // Fetch chat metadata and messages in parallel
      const [chat, messages] = await Promise.all([
        this.client.get(`/chats/${chatId}`),
        this.client.get(`/chats/${chatId}/messages`)
      ]);
      
      // Combine chat with messages
      chat.messages = messages || [];
      
      if (this.enableLogging) {
        console.log(`[StorageAPI] Loaded chat ${chatId} with ${chat.messages.length} messages`);
      }
      
      return chat;
    });
  }

  /**
   * Create a new chat
   * @param {string} title - Chat title
   * @returns {Promise<Object>}
   */
  async createChat(title = 'New Chat') {
    return this._withErrorLogging('createChat', async () => {
      const chat = await this.client.post('/chats', { title });
      
      if (this.enableLogging) {
        console.log(`[StorageAPI] Created chat ${chat.id}`);
      }
      
      return chat;
    });
  }

  /**
   * Update chat title
   * @param {string} chatId - Chat ID
   * @param {string} title - New title
   * @returns {Promise<Object>}
   */
  async updateChatTitle(chatId, title) {
    return this._withErrorLogging('updateChatTitle', async () => {
      const chat = await this.client.put(`/chats/${chatId}`, { title });
      
      if (this.enableLogging) {
        console.log(`[StorageAPI] Updated chat ${chatId} title to "${title}"`);
      }
      
      return chat;
    });
  }

  /**
   * Delete a chat and all associated messages/artifacts
   * @param {string} chatId - Chat ID
   * @returns {Promise<Object>}
   */
  async deleteChat(chatId) {
    return this._withErrorLogging('deleteChat', async () => {
      const result = await this.client.delete(`/chats/${chatId}`);
      
      if (this.enableLogging) {
        console.log(`[StorageAPI] Deleted chat ${chatId}`);
      }
      
      return result;
    });
  }

  // ==========================================================================
  // Message Operations
  // ==========================================================================

  /**
   * Load messages for a chat
   * @param {string} chatId - Chat ID
   * @returns {Promise<Array>}
   */
  async loadMessages(chatId) {
    return this._withErrorLogging('loadMessages', async () => {
      const messages = await this.client.get(`/chats/${chatId}/messages`);
      
      if (this.enableLogging) {
        console.log(`[StorageAPI] Loaded ${messages.length} messages for chat ${chatId}`);
      }
      
      return messages;
    });
  }

  /**
   * Save a message to a chat
   * @param {string} chatId - Chat ID
   * @param {Object} message - Message object
   * @returns {Promise<Object>}
   */
  async saveMessage(chatId, message) {
    return this._withErrorLogging('saveMessage', async () => {
      const payload = {
        role: message.role,
        content: message.content,
        llm_model: message.llm_model,
        llm_provider: message.llm_provider,
        tokens_used: message.tokens_used,
        correlation_id: message.correlation_id
      };
      
      const savedMessage = await this.client.post(`/chats/${chatId}/messages`, payload);
      
      if (this.enableLogging) {
        console.log(`[StorageAPI] Saved ${message.role} message ${savedMessage.id} to chat ${chatId}`);
      }
      
      return savedMessage;
    });
  }

  // ==========================================================================
  // Artifact Operations
  // ==========================================================================

  /**
   * Load artifacts for a chat
   * @param {string} chatId - Chat ID
   * @returns {Promise<Array>}
   */
  async loadArtifacts(chatId) {
    return this._withErrorLogging('loadArtifacts', async () => {
      const artifacts = await this.client.get(`/chats/${chatId}/artifacts`);
      
      if (this.enableLogging) {
        console.log(`[StorageAPI] Loaded ${artifacts.length} artifacts for chat ${chatId}`);
      }
      
      return artifacts;
    });
  }

  /**
   * Save an artifact to a chat
   * @param {string} chatId - Chat ID
   * @param {Object} artifact - Artifact object
   * @returns {Promise<Object>}
   */
  async saveArtifact(chatId, artifact) {
    return this._withErrorLogging('saveArtifact', async () => {
      const payload = {
        type: artifact.type,
        filename: artifact.filename,
        content: artifact.content,
        language: artifact.language,
        metadata: artifact.metadata,
        artifact_id: artifact.artifact_id,
        message_id: artifact.message_id
      };
      
      const savedArtifact = await this.client.post(`/chats/${chatId}/artifacts`, payload);
      
      if (this.enableLogging) {
        console.log(`[StorageAPI] Saved artifact ${savedArtifact.id} to chat ${chatId}`);
      }
      
      return savedArtifact;
    });
  }

  /**
   * Update artifacts' message_id to link artifact to persisted message
   * @param {string} artifactId - Frontend-generated artifact ID (used as identifier)
   * @param {string} messageId - PostgreSQL message UUID to link to
   * @param {string|null} chatId - Optional chat ID for additional filtering
   * @returns {Promise<Object>}
   */
  async updateArtifactMessageId(artifactId, messageId, chatId = null) {
    return this._withErrorLogging('updateArtifactMessageId', async () => {
      const payload = {
        artifact_id: artifactId,
        message_id: messageId
      };
      
      if (chatId) {
        payload.chat_id = chatId;
      }
      
      const result = await this.client.put('/artifacts/update-message-id', payload);
      
      if (this.enableLogging) {
        console.log(`[StorageAPI] Linked ${result.updated_count} artifacts to message ${messageId}`);
      }
      
      return result;
    });
  }

  /**
   * Delete an artifact
   * @param {string} artifactId - Artifact ID
   * @returns {Promise<Object>}
   */
  async deleteArtifact(artifactId) {
    return this._withErrorLogging('deleteArtifact', async () => {
      const result = await this.client.delete(`/artifacts/${artifactId}`);
      
      if (this.enableLogging) {
        console.log(`[StorageAPI] Deleted artifact ${artifactId}`);
      }
      
      return result;
    });
  }

  // ==========================================================================
  // Traceability Operations
  // ==========================================================================

  /**
   * Get all artifacts created by a specific message
   * @param {string} messageId - Message ID
   * @returns {Promise<Array>}
   */
  async getMessageArtifacts(messageId) {
    return this._withErrorLogging('getMessageArtifacts', async () => {
      const artifacts = await this.client.get(`/messages/${messageId}/artifacts`);
      
      if (this.enableLogging) {
        console.log(`[StorageAPI] Found ${artifacts.length} artifacts for message ${messageId}`);
      }
      
      return artifacts;
    });
  }

  /**
   * Get the message that created an artifact
   * @param {string} artifactId - Artifact ID
   * @returns {Promise<Object>}
   */
  async getArtifactSource(artifactId) {
    return this._withErrorLogging('getArtifactSource', async () => {
      const message = await this.client.get(`/artifacts/${artifactId}/source`);
      
      if (this.enableLogging) {
        console.log(`[StorageAPI] Found source message for artifact ${artifactId}`);
      }
      
      return message;
    });
  }

  /**
   * Get LLM metadata for a message
   * @param {string} messageId - Message ID
   * @returns {Promise<Object|null>}
   */
  async getLLMMetadata(messageId) {
    return this._withErrorLogging('getLLMMetadata', async () => {
      console.warn('[StorageAPI] getLLMMetadata not yet implemented');
      return null;
    });
  }

  // ==========================================================================
  // Health Check
  // ==========================================================================

  /**
   * Check database health
   * @returns {Promise<Object>}
   */
  async healthCheck() {
    return this._withErrorLogging('healthCheck', async () => {
      const health = await this.client.get('/health');
      
      if (this.enableLogging) {
        console.log('[StorageAPI] Health check:', health);
      }
      
      return health;
    });
  }

  /**
   * Test connection to storage API
   * @returns {Promise<boolean>}
   */
  async testConnection() {
    try {
      await this.healthCheck();
      console.log('[StorageAPI] Connection test: SUCCESS');
      return true;
    } catch (error) {
      console.error('[StorageAPI] Connection test: FAILED', error);
      return false;
    }
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Get API statistics
   * @returns {Object}
   */
  getStats() {
    return freeze({
      baseURL: this.baseURL,
      circuitBreaker: this.client.getCircuitBreakerState(),
      rateLimiter: this.client.getRateLimiterStats()
    });
  }

  /**
   * Reset circuit breaker
   */
  resetCircuitBreaker() {
    this.client.resetCircuitBreaker();
  }

  /**
   * Reset rate limiter
   */
  resetRateLimiter() {
    this.client.resetRateLimiter();
  }
}

// Export
module.exports = { StorageAPI };

if (typeof window !== 'undefined') {
  window.StorageAPI = StorageAPI;
  console.log('📦 StorageAPI loaded');
}

