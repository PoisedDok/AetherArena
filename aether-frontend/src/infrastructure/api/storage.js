'use strict';

// Incoming: Renderer repositories & IPC bridge (storage bridge) --- {object, json}
// Processing: Normalize storage payloads, wrap backend HTTP calls, handle errors --- {4 jobs: JOB_HTTP_REQUEST, JOB_PARSE, JOB_SERIALIZE, JOB_VALIDATE_SCHEMA}
// Outgoing: Backend /v1/storage endpoints, ipcMain responders --- {http_request, json}

const { ApiClient } = require('../../core/communication/ApiClient');
const { createLogger } = require('../../core/utils/logger');
const { freeze } = Object;
const DEFAULTS = require('../../core/config/defaults');

let config = null;
try {
  config = require('../../core/config/renderer-config');
} catch (e) {
  try {
    config = require('../../core/config');
  } catch (e2) {
  }
}

/**
 * StorageAPI - Supabase Backend Client
 */
class StorageAPI {
  constructor(options = {}) {
    const fallbackBaseURL = `${DEFAULTS.backend.baseUrl}${DEFAULTS.endpoints.storageApi}`;
    let defaultBaseURL = fallbackBaseURL;
    const fallbackHealthEndpoint = DEFAULTS.endpoints.storageHealth;
    let defaultHealthEndpoint = fallbackHealthEndpoint;

    if (config && config.backend && config.backend.baseUrl && config.endpoints && config.endpoints.storageApi) {
      defaultBaseURL = `${config.backend.baseUrl}${config.endpoints.storageApi}`;
    }
    if (config && config.endpoints && config.endpoints.storageHealth) {
      defaultHealthEndpoint = config.endpoints.storageHealth;
    }

    this.baseURL = options.baseURL || defaultBaseURL;
    this.healthEndpoint = options.healthEndpoint || defaultHealthEndpoint;
    
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
    this.log = createLogger({ component: 'StorageAPI' });
  }
  /**
   * Error logging wrapper
   * @private
   */
  async _withErrorLogging(operation, fn) {
    try {
      return await fn();
    } catch (error) {
      this.log.error(`${operation} failed`, {
        operation,
        error: error.message,
        stack: error.stack
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
      const chats = await this.client.get('/chat/list');
      
      this.log.debug(`loaded ${chats.length} chats`);
      
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
        this.client.get(`/chat/get/${chatId}`),
        this.client.get(`/message/list/${chatId}`)
      ]);
      
      // Combine chat with messages
      chat.messages = messages || [];
      
      this.log.debug(`loaded chat ${chatId} with ${chat.messages.length} messages`);
      
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
      const chat = await this.client.post('/chat/create', { title });
      
      this.log.debug(`created chat ${chat.id}`);
      
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
      const chat = await this.client.put(`/chat/update/${chatId}`, { title });
      
      this.log.debug(`updated chat ${chatId} title`);
      
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
      const result = await this.client.delete(`/chat/delete/${chatId}`);
      
      this.log.debug(`deleted chat ${chatId}`);
      
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
      const messages = await this.client.get(`/message/list/${chatId}`);
      
      this.log.debug(`loaded ${messages.length} messages for chat ${chatId}`);
      
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
      
      const savedMessage = await this.client.post(`/message/create/${chatId}`, payload);
      
      this.log.debug(`saved ${message.role} message ${savedMessage.id} to chat ${chatId}`);
      
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
      const artifacts = await this.client.get(`/artifact/list/${chatId}`);
      
      this.log.debug(`loaded ${artifacts.length} artifacts for chat ${chatId}`);
      
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
        artifact_id: artifact.artifact_id || artifact.artifactId,
        message_id: artifact.message_id || artifact.messageId,
        // Trail linkage (required for output artifacts, optional for others).
        subgroup_id: artifact.subgroup_id || artifact.subgroupId || null,
        node_id: artifact.node_id || artifact.nodeId || null,
      };
      
      const savedArtifact = await this.client.post(`/artifact/create/${chatId}`, payload);
      
      this.log.debug(`saved artifact ${savedArtifact.id} to chat ${chatId}`);
      
      return savedArtifact;
    });
  }

  /**
   * Update artifacts' message_id to link artifact to persisted message
   * @param {string} artifactId - Frontend-generated artifact ID (used as identifier)
   * @param {string} messageId - Supabase message UUID to link to
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
      
      const result = await this.client.put('/artifact/link-message', payload);
      
      this.log.debug(`linked ${result.updated_count} artifacts to message ${messageId}`);
      
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
      const result = await this.client.delete(`/artifact/delete/${artifactId}`);
      
      this.log.debug(`deleted artifact ${artifactId}`);
      
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
      const artifacts = await this.client.get(`/artifact/list/message/${messageId}`);
      
      this.log.debug(`found ${artifacts.length} artifacts for message ${messageId}`);
      
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
      const message = await this.client.get(`/artifact/source/${artifactId}`);
      
      this.log.debug(`found source message for artifact ${artifactId}`);
      
      return message;
    });
  }

  /**
   * Get LLM metadata for a message
   * @param {string} messageId - Message ID
   * @returns {Promise<Object>}
   */
  async getLLMMetadata(messageId) {
    return this._withErrorLogging('getLLMMetadata', async () => {
      const metadata = await this.client.get(`/message/llm-metadata/get/${messageId}`);
      
      this.log.debug(`LLM metadata for message ${messageId}`, { metadata });
      
      return metadata;
    });
  }

  /**
   * Save traceability data (messages, artifacts, and their relationships)
   * @param {Object} data - Traceability data containing messages and artifacts maps
   * @returns {Promise<Object>}
   */
  async saveTraceabilityData(data) {
    return this._withErrorLogging('saveTraceabilityData', async () => {
      const normalizePairs = (entries, keyFields = ['id']) => {
        if (!entries) {
          return [];
        }
        if (entries instanceof Map) {
          return Array.from(entries.entries());
        }
        if (Array.isArray(entries)) {
          return entries
            .map(entry => {
              if (Array.isArray(entry) && entry.length === 2) {
                return entry;
              }
              if (entry && typeof entry === 'object') {
                const keyField = keyFields.find(field => entry[field]);
                if (!keyField) {
                  return null;
                }
                const value = { ...entry };
                keyFields.forEach(field => {
                  delete value[field];
                });
                return [entry[keyField], value];
              }
              return null;
            })
            .filter(Boolean);
        }
        if (typeof entries === 'object') {
          return Object.entries(entries);
        }
        return [];
      };

      const payload = {
        version: data?.version || '2.0',
        timestamp: data?.timestamp || Date.now(),
        messages: normalizePairs(data?.messages, ['id', 'message_id', 'messageId']),
        artifacts: normalizePairs(data?.artifacts, ['id', 'artifact_id', 'artifactId']),
        correlationIndex: normalizePairs(data?.correlationIndex, ['id', 'correlationId']),
        messageArtifactsIndex: normalizePairs(data?.messageArtifactsIndex, ['id', 'message_id', 'messageId']),
        artifactMessageIndex: normalizePairs(data?.artifactMessageIndex, ['id', 'artifact_id', 'artifactId']),
        chatMessagesIndex: normalizePairs(data?.chatMessagesIndex, ['id', 'chat_id', 'chatId']),
        chatArtifactsIndex: normalizePairs(data?.chatArtifactsIndex, ['id', 'chat_id', 'chatId'])
      };
      
      const result = await this.client.post('/traceability/save', payload);
      
      this.log.debug(`saved traceability data: ${payload.messages.length} messages, ${payload.artifacts.length} artifacts`);
      
      return result;
    });
  }

  /**
   * Load traceability data for a specific chat
   * @param {string} chatId - Chat ID
   * @returns {Promise<Object>}
   */
  async loadTraceabilityData(chatId) {
    return this._withErrorLogging('loadTraceabilityData', async () => {
      const data = await this.client.get(`/traceability/load/${chatId}`);
      
      this.log.debug(`loaded traceability data for chat ${chatId}`);
      
      return data;
    });
  }

  // ==========================================================================
  // Trail Hierarchy Operations (NEW ARCHITECTURE - Groups → Subgroups → Nodes)
  // ==========================================================================

  /**
   * Get complete trail hierarchy for a chat
   * @param {string} chatId - Chat ID
   * @returns {Promise<Array>} List of groups with nested subgroups and nodes
   */
  async getTrailHierarchy(chatId) {
    return this._withErrorLogging('getTrailHierarchy', async () => {
      const hierarchy = await this.client.get(`/trail/hierarchy/get/${chatId}`);
      
      this.log.debug(`loaded trail hierarchy for chat ${chatId}: ${hierarchy.length} groups`);
      
      return hierarchy;
    });
  }

  /**
   * Get all groups for a chat
   * @param {string} chatId - Chat ID
   * @returns {Promise<Array>} List of group records
   */
  async getGroups(chatId) {
    return this._withErrorLogging('getGroups', async () => {
      const groups = await this.client.get(`/trail/group/list/${chatId}`);
      
      this.log.debug(`loaded ${groups.length} groups for chat ${chatId}`);
      
      return groups;
    });
  }

  /**
   * Get all subgroups for a group
   * @param {string} groupId - Group UUID
   * @returns {Promise<Array>} List of subgroup records
   */
  async getSubgroups(groupId) {
    return this._withErrorLogging('getSubgroups', async () => {
      const subgroups = await this.client.get(`/trail/subgroup/list/${groupId}`);
      
      this.log.debug(`loaded ${subgroups.length} subgroups for group ${groupId}`);
      
      return subgroups;
    });
  }

  /**
   * Get all nodes for a subgroup (always exactly 3)
   * @param {string} subgroupId - Subgroup UUID
   * @returns {Promise<Array>} List of 3 node records (writing, executing, output)
   */
  async getNodes(subgroupId) {
    return this._withErrorLogging('getNodes', async () => {
      const nodes = await this.client.get(`/trail/node/list/${subgroupId}`);
      
      this.log.debug(`loaded ${nodes.length} nodes for subgroup ${subgroupId}`);
      
      return nodes;
    });
  }

  /**
   * Get artifacts for a subgroup (code + output only)
   * @param {string} subgroupId - Subgroup UUID
   * @returns {Promise<Array>} List of artifact records
   */
  async getSubgroupArtifacts(subgroupId) {
    return this._withErrorLogging('getSubgroupArtifacts', async () => {
      const artifacts = await this.client.get(`/trail/subgroup/artifact/list/${subgroupId}`);
      
      this.log.debug(`loaded ${artifacts.length} artifacts for subgroup ${subgroupId}`);
      
      return artifacts;
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
      const health = await this.client.get(this.healthEndpoint);
      
      this.log.debug('health check', { health });
      
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
      this.log.info('connection test: SUCCESS');
      return true;
    } catch (error) {
      this.log.error('connection test: FAILED', { error: error.message });
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
}
