'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactService.finalizeArtifact/persistArtifact() (method calls with Artifact models) --- {artifact_model, javascript_object}
 * Processing: Validate via ArtifactValidator.validateForPersistence(), transform Artifact models to PostgreSQL format (artifact.toPostgreSQLFormat()), call storageAPI.saveArtifact/loadArtifacts(), maintain in-memory cache (Map: artifactId → Artifact, max 100 items, 5min TTL), transform PostgreSQL rows back to Artifact models via Artifact.fromPostgresRow(), clear expired cache entries --- {9 jobs: JOB_CACHE_LOCALLY, JOB_CLEAR_STATE, JOB_INITIALIZE, JOB_LOAD_FROM_DB, JOB_PARSE_JSON, JOB_SAVE_TO_DB, JOB_SEND_IPC, JOB_STRINGIFY_JSON, JOB_VALIDATE_SCHEMA}
 * Outgoing: storageAPI.saveArtifact/loadArtifacts() (IPC to main process → PostgreSQL), return Artifact model instances --- {artifact_model | persistence_result, javascript_object}
 * 
 * 
 * @module domain/artifacts/repositories/ArtifactRepository
 */

const { Artifact } = require('../models/Artifact');
const { ArtifactValidator } = require('../validators/ArtifactValidator');

/**
 * ArtifactRepository
 * Data access layer for artifact persistence
 * 
 * Interfaces with PostgreSQL backend via storage API
 */

class ArtifactRepository {
  constructor(dependencies = {}) {
    this.storageAPI = dependencies.storageAPI; // Storage API injected via dependencies
    this.logger = dependencies.logger || this._createDefaultLogger();
    
    // Local cache for recently accessed artifacts
    this.cache = new Map(); // artifactId -> Artifact
    this.cacheMaxSize = dependencies.cacheMaxSize || 100;
    this.cacheTTL = dependencies.cacheTTL || 5 * 60 * 1000; // 5 minutes
  }

  _createDefaultLogger() {
    return {
      debug: () => {},
      info: () => {},
      warn: (...args) => console.warn('[ArtifactRepository]', ...args),
      error: (...args) => console.error('[ArtifactRepository]', ...args)
    };
  }

  /**
   * Check if storage API is available
   */
  _checkStorageAPI() {
    if (!this.storageAPI) {
      throw new Error('Storage API not available');
    }
    if (typeof this.storageAPI.saveArtifact !== 'function') {
      throw new Error('Storage API missing saveArtifact method');
    }
    if (typeof this.storageAPI.loadArtifacts !== 'function') {
      throw new Error('Storage API missing loadArtifacts method');
    }
  }

  /**
   * Save artifact to PostgreSQL
   */
  async save(artifact) {
    this._checkStorageAPI();

    // Validate artifact for persistence
    const validation = ArtifactValidator.validateForPersistence(artifact.toJSON());
    if (!validation.valid) {
      const error = new Error(`Cannot persist artifact: ${validation.errors.join(', ')}`);
      this.logger.error('Persistence validation failed:', validation.errors);
      throw error;
    }

    try {
      // Convert to PostgreSQL format
      const pgData = artifact.toPostgreSQLFormat();

      this.logger.debug(`Saving artifact ${artifact.id} to PostgreSQL`);

      // Save via storage API
      const savedData = await this.storageAPI.saveArtifact(artifact.chatId, pgData);

      // Create updated artifact with server ID
      const persistedArtifact = artifact.withServerId(savedData.id);

      // Update cache
      this._cacheArtifact(persistedArtifact);

      this.logger.info(`Artifact saved: ${artifact.id} → ${savedData.id}`);
      return persistedArtifact;
    } catch (error) {
      this.logger.error(`Failed to save artifact ${artifact.id}:`, error);
      throw new Error(`Persistence failed: ${error.message}`);
    }
  }

  /**
   * Find artifact by ID
   */
  async findById(artifactId) {
    // Check cache first
    const cached = this._getCachedArtifact(artifactId);
    if (cached) {
      this.logger.debug(`Cache hit: ${artifactId}`);
      return cached;
    }

    // Cannot query by artifact_id directly, need to load all artifacts for chat
    // This is a limitation - artifact lookup requires chatId context
    this.logger.warn(`Direct artifact lookup by ID not supported: ${artifactId}`);
    return null;
  }

  /**
   * Find artifacts by chat ID
   */
  async findByChatId(chatId) {
    this._checkStorageAPI();

    // Validate chat ID
    if (!ArtifactValidator.isValidUUID(chatId)) {
      throw new Error(`Invalid chat UUID: ${chatId}`);
    }

    try {
      this.logger.debug(`Loading artifacts for chat ${chatId}`);

      // Load from PostgreSQL
      const rows = await this.storageAPI.loadArtifacts(chatId);

      // Convert to Artifact models
      const artifacts = rows.map(row => {
        const artifact = Artifact.fromPostgreSQLRow(row);
        this._cacheArtifact(artifact);
        return artifact;
      });

      this.logger.info(`Loaded ${artifacts.length} artifacts for chat ${chatId}`);
      return artifacts;
    } catch (error) {
      this.logger.error(`Failed to load artifacts for chat ${chatId}:`, error);
      throw new Error(`Load failed: ${error.message}`);
    }
  }

  /**
   * Find artifacts by message ID
   */
  async findByMessageId(messageId) {
    // PostgreSQL backend doesn't support direct message query
    // Need to load all artifacts and filter client-side
    this.logger.warn(`Message-based artifact lookup requires chat context`);
    return [];
  }

  /**
   * Find artifacts by correlation ID
   */
  async findByCorrelationId(correlationId) {
    // PostgreSQL backend doesn't support correlation query
    // Need to load all artifacts and filter client-side by metadata
    this.logger.warn(`Correlation-based artifact lookup requires chat context`);
    return [];
  }

  /**
   * Update artifact message link
   */
  async updateMessageLink(artifactId, messageId) {
    this._checkStorageAPI();

    // Validate message ID
    if (!ArtifactValidator.isValidUUID(messageId)) {
      throw new Error(`Invalid message UUID: ${messageId}`);
    }

    try {
      this.logger.debug(`Updating message link for artifacts: messageId=${messageId}`);

      // Use bulk update API
      // oldMessageId can be null since we're linking by chatId
      const result = await this.storageAPI.updateArtifactMessageId(null, messageId, null);

      this.logger.info(`Updated ${result.updated_count} artifact message links`);
      
      // Invalidate cache
      this._invalidateCache();

      return result.updated_count;
    } catch (error) {
      this.logger.error(`Failed to update message link:`, error);
      throw new Error(`Update failed: ${error.message}`);
    }
  }

  /**
   * Update artifacts for chat with new message link
   */
  async updateChatArtifactsMessageLink(chatId, oldMessageId, newMessageId) {
    this._checkStorageAPI();

    // Validate IDs
    if (!ArtifactValidator.isValidUUID(chatId)) {
      throw new Error(`Invalid chat UUID: ${chatId}`);
    }
    if (!ArtifactValidator.isValidUUID(newMessageId)) {
      throw new Error(`Invalid message UUID: ${newMessageId}`);
    }

    try {
      this.logger.debug(`Linking artifacts to message: chat=${chatId}, newMessageId=${newMessageId}`);

      // Use chat-based linking (links all recent NULL message_id artifacts)
      const result = await this.storageAPI.updateArtifactMessageId(oldMessageId, newMessageId, chatId);

      this.logger.info(`Linked ${result.updated_count} artifacts to message ${newMessageId}`);
      
      // Invalidate cache for this chat
      this._invalidateCacheForChat(chatId);

      return result.updated_count;
    } catch (error) {
      this.logger.error(`Failed to link artifacts:`, error);
      throw new Error(`Linking failed: ${error.message}`);
    }
  }

  /**
   * Delete artifact (soft delete)
   */
  async delete(artifactId) {
    // PostgreSQL backend doesn't support delete
    // Artifacts are immutable once saved
    this.logger.warn(`Artifact deletion not supported: ${artifactId}`);
    return false;
  }

  /**
   * Cache artifact
   */
  _cacheArtifact(artifact) {
    // Enforce cache size limit
    if (this.cache.size >= this.cacheMaxSize) {
      // Remove oldest entry
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(artifact.id, {
      artifact,
      cachedAt: Date.now()
    });
  }

  /**
   * Get cached artifact
   */
  _getCachedArtifact(artifactId) {
    const cached = this.cache.get(artifactId);
    if (!cached) return null;

    // Check TTL
    if (Date.now() - cached.cachedAt > this.cacheTTL) {
      this.cache.delete(artifactId);
      return null;
    }

    return cached.artifact;
  }

  /**
   * Invalidate entire cache
   */
  _invalidateCache() {
    const count = this.cache.size;
    this.cache.clear();
    this.logger.debug(`Invalidated cache: ${count} entries`);
  }

  /**
   * Invalidate cache for specific chat
   */
  _invalidateCacheForChat(chatId) {
    let count = 0;
    for (const [artifactId, entry] of this.cache.entries()) {
      if (entry.artifact.chatId === chatId) {
        this.cache.delete(artifactId);
        count++;
      }
    }
    this.logger.debug(`Invalidated cache for chat ${chatId}: ${count} entries`);
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    const entries = Array.from(this.cache.values());
    const now = Date.now();

    return {
      size: this.cache.size,
      maxSize: this.cacheMaxSize,
      avgAge: entries.length > 0
        ? entries.reduce((sum, e) => sum + (now - e.cachedAt), 0) / entries.length
        : 0,
      oldestEntry: entries.length > 0
        ? Math.min(...entries.map(e => e.cachedAt))
        : null
    };
  }

  /**
   * Clear cache
   */
  clearCache() {
    this._invalidateCache();
  }
}

module.exports = { ArtifactRepository };

