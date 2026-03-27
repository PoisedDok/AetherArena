'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactService.finalizeArtifact/persistArtifact() (backend-validated Artifact models) --- {object, javascript_api}
 * Processing: Transform Artifact models to PostgreSQL format, call storageAPI.saveArtifact/loadArtifacts() via IPC, maintain in-memory LRU cache, transform PostgreSQL rows back to Artifact models, clear expired cache entries, dispose cleanup timer --- {9 jobs: JOB_CACHE_LOCALLY, JOB_CLEAR_STATE, JOB_DELEGATE_TO_MODULE, JOB_DISPOSE, JOB_INITIALIZE, JOB_LOAD_FROM_DB, JOB_SAVE_TO_DB, JOB_SEND_IPC, JOB_UPDATE_STATE}
 * Outgoing: storageAPI.saveArtifact/loadArtifacts() (IPC to main → backend PostgreSQL), return Artifact instances --- {database_types.artifact_record, json}
 * 
 * ARCHITECTURAL NOTE: Backend owns ALL validation. Repository is pure data proxy.
 * 
 * @module domain/artifacts/repositories/ArtifactRepository
 */

const { Artifact } = require('../models/Artifact');
const { ArtifactValidator } = require('../validators/ArtifactValidator');
const { createLogger } = require('../../../core/utils/logger');

/**
 * ArtifactRepository
 * Pure data access layer - proxies to backend without validation
 * 
 * ARCHITECTURE: Trusts backend-validated data - no business logic
 */

class ArtifactRepository {
  constructor(dependencies = {}) {
    this.storageAPI = dependencies.storageAPI; // Storage API injected via dependencies
    this.logger = dependencies.logger || createLogger({ component: 'ArtifactRepository' });
    
    // Local cache for recently accessed artifacts
    this.cache = new Map(); // artifactId -> Artifact
    this.cacheMaxSize = dependencies.cacheMaxSize || 100;
    this.cacheTTL = dependencies.cacheTTL || 5 * 60 * 1000; // 5 minutes
    
    // Start periodic cache cleanup to prevent memory leaks
    this.cleanupInterval = setInterval(() => this._cleanupExpiredCache(), 60000); // Every minute
  }

  // Default logger removed -- createLogger({ component }) used in constructor fallback

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
   * Save artifact to backend SUPABASE
   * ARCHITECTURE: Backend validates on receive - frontend just proxies
   */
  async save(artifact) {
    try {
      this._checkStorageAPI();

      // Backend will validate - frontend just sends
      const pgData = artifact.toPostgreSQLFormat();

      this.logger.debug(`Saving artifact ${artifact.id} to backend`);

      const savedData = await this.storageAPI.saveArtifact(artifact.chatId, pgData);

      const persistedArtifact = artifact.withServerId(savedData.id);
      this._cacheArtifact(persistedArtifact);

      this.logger.info(`Artifact saved: ${artifact.id} → ${savedData.id}`);
      return persistedArtifact;
    } catch (error) {
      this.logger.error(`Failed to save artifact ${artifact?.id ?? 'unknown'}:`, error);
      throw new Error(`Persistence failed: ${error.message}`);
    }
  }

  /**
   * Find artifact by ID
   */
  async findById(artifactId) {
    try {
      const cached = this._getCachedArtifact(artifactId);
      if (cached) {
        this.logger.debug(`Cache hit: ${artifactId}`);
        return cached;
      }

      throw new Error(
        `Artifact ${artifactId} not found in cache. ` +
        `Direct artifact lookup requires chatId context. ` +
        `Use findByChatId(chatId) to load artifacts into cache first.`
      );
    } catch (error) {
      if (error.message && error.message.startsWith('Artifact')) {
        throw error;
      }

      this.logger.error(`Failed to retrieve artifact ${artifactId}:`, error);
      throw error;
    }
  }

  /**
   * Find artifacts by chat ID
   * ARCHITECTURE: Backend validates chat ID - frontend trusts it
   */
  async findByChatId(chatId) {
    try {
      this._checkStorageAPI();

      this.logger.debug(`Loading artifacts for chat ${chatId}`);

      // Backend validates chat ID - load from PostgreSQL
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
    try {
      this.logger.warn('Message-based artifact lookup requires chat context');
      return [];
    } catch (error) {
      this.logger.error('Failed during message-based lookup warning:', error);
      throw error;
    }
  }

  /**
   * Find artifacts by correlation ID
   */
  async findByCorrelationId(correlationId) {
    try {
      this.logger.warn('Correlation-based artifact lookup requires chat context');
      return [];
    } catch (error) {
      this.logger.error('Failed during correlation lookup warning:', error);
      throw error;
    }
  }

  /**
   * Update artifact message link
   */
  async updateMessageLink(artifactId, messageId) {
    try {
      this._checkStorageAPI();

      if (!ArtifactValidator.isValidUUID(messageId)) {
        throw new Error(`Invalid message UUID: ${messageId}`);
      }
      if (!artifactId || typeof artifactId !== 'string') {
        throw new Error('artifactId is required to link artifact');
      }

      this.logger.debug(`Updating message link for artifacts: messageId=${messageId}`);

      // Use bulk update API
      // oldMessageId can be null since we're linking by chatId
      const result = await this.storageAPI.updateArtifactMessageId(artifactId, messageId, null);

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
    try {
      this._checkStorageAPI();

      if (!ArtifactValidator.isValidUUID(chatId)) {
        throw new Error(`Invalid chat UUID: ${chatId}`);
      }
      if (!ArtifactValidator.isValidUUID(newMessageId)) {
        throw new Error(`Invalid message UUID: ${newMessageId}`);
      }

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
    try {
      this.logger.warn(`Artifact deletion not supported: ${artifactId}`);
      return false;
    } catch (error) {
      this.logger.error(`Failed during artifact deletion warning for ${artifactId}:`, error);
      throw error;
    }
  }

  /**
   * Cache artifact
   */
  _cacheArtifact(artifact) {
    // Enforce cache size limit with LRU eviction
    if (this.cache.size >= this.cacheMaxSize) {
      // Find and remove least recently used (oldest accessedAt)
      let lruKey = null;
      let oldestAccess = Infinity;
      
      for (const [key, entry] of this.cache.entries()) {
        if (entry.accessedAt < oldestAccess) {
          oldestAccess = entry.accessedAt;
          lruKey = key;
        }
      }
      
      if (lruKey) {
        this.cache.delete(lruKey);
      }
    }

    const now = Date.now();
    this.cache.set(artifact.id, {
      artifact,
      cachedAt: now,
      accessedAt: now
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

    // Update access time for LRU tracking
    cached.accessedAt = Date.now();

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

  /**
   * Clean up expired cache entries (called periodically)
   */
  _cleanupExpiredCache() {
    const now = Date.now();
    let removedCount = 0;

    for (const [artifactId, entry] of this.cache.entries()) {
      if (now - entry.cachedAt > this.cacheTTL) {
        this.cache.delete(artifactId);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      this.logger.debug(`Cleaned up ${removedCount} expired cache entries`);
    }
  }

  /**
   * Dispose repository and cleanup resources
   */
  dispose() {
    // Clear the cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Clear cache
    this._invalidateCache();

    this.logger.debug('ArtifactRepository disposed');
  }
}

module.exports = { ArtifactRepository };
