'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactService.finalizeArtifact/linkArtifact(), MessageService.registerMessage() (method calls with entity data) --- {object, javascript_api}
 * Processing: Maintain 7 in-memory indexes (messages/artifacts/correlationIndex/messageArtifactsIndex/artifactMessageIndex/chatMessagesIndex/chatArtifactsIndex Maps), register messages/artifacts with bidirectional linkage, track entities in indexes, query lineage trees, persist to PostgreSQL via storageAPI with autoSave, clear indexes, batch operations --- {9 jobs: JOB_CLEAR_STATE, JOB_DELEGATE_TO_MODULE, JOB_GET_STATE, JOB_INITIALIZE, JOB_LOAD_FROM_DB, JOB_SAVE_TO_DB, JOB_SEND_IPC, JOB_TRACK_ENTITY, JOB_UPDATE_STATE}
 * Outgoing: storageAPI.saveTraceabilityData/loadTraceabilityData() (IPC to main → PostgreSQL), return linked entity data and lineage trees --- {object, javascript_api}
 * 
 * 
 * @module domain/artifacts/services/TraceabilityService
 */

class TraceabilityService {
  constructor(options = {}) {
    this.storageAPI = options.storageAPI || null; // PostgreSQL via IPC
    this.logger = options.logger || this._createDefaultLogger();
    this.autoSave = options.autoSave !== false;
    this.saveDebounceMs = options.saveDebounceMs || 1000; // Debounce saves
    
    // Core indexes (in-memory for performance)
    this.messages = new Map(); // messageId -> MessageData
    this.artifacts = new Map(); // artifactId -> ArtifactData
    
    // Relationship indexes (in-memory for fast lookups)
    this.correlationIndex = new Map(); // correlationId -> { requestMessageId, responseMessageId }
    this.messageArtifactsIndex = new Map(); // messageId -> Set<artifactId>
    this.artifactMessageIndex = new Map(); // artifactId -> messageId
    this.chatMessagesIndex = new Map(); // chatId -> Set<messageId>
    this.chatArtifactsIndex = new Map(); // chatId -> Set<artifactId>
    
    // Save debouncing
    this._saveTimeout = null;
    this._pendingSave = false;
    
    // Initialize storage API
    this._initializeStorageAPI();
    
    // Note: TraceabilityService is a global service tracking all chats
    // Loading is done per-chat via loadForChat() when switching chats
    // Not loading automatically to avoid errors when no chat context exists
  }
  
  /**
   * Initialize storage API (browser or Node.js environment)
   * @private
   */
  _initializeStorageAPI() {
    if (this.storageAPI) {
      return; // Already provided
    }

    // Try window.storageAPI first (browser)
    if (typeof window !== 'undefined' && window.storageAPI) {
      this.storageAPI = window.storageAPI;
      return;
    }

    // Try require (Node.js/Electron)
    try {
      this.storageAPI = require('../../../infrastructure/api/storage');
    } catch (e) {
      this.logger.warn('Storage API not available - traceability will be in-memory only:', e.message);
    }
  }

  _createDefaultLogger() {
    return {
      debug: () => {},
      info: () => {},
      warn: (...args) => console.warn('[TraceabilityService]', ...args),
      error: (...args) => console.error('[TraceabilityService]', ...args)
    };
  }

  /**
   * Register message for tracking
   */
  registerMessage(messageData) {
    if (!messageData || !messageData.id) {
      this.logger.warn('Cannot register message without ID');
      return null;
    }

    const messageId = messageData.id;
    this.messages.set(messageId, {
      id: messageId,
      chatId: messageData.chatId,
      role: messageData.role,
      correlationId: messageData.correlationId,
      timestamp: messageData.timestamp || Date.now(),
      artifactIds: messageData.artifactIds || []
    });

    // Index by chat
    if (messageData.chatId) {
      if (!this.chatMessagesIndex.has(messageData.chatId)) {
        this.chatMessagesIndex.set(messageData.chatId, new Set());
      }
      this.chatMessagesIndex.get(messageData.chatId).add(messageId);
    }

    // Index by correlation
    if (messageData.correlationId) {
      if (!this.correlationIndex.has(messageData.correlationId)) {
        this.correlationIndex.set(messageData.correlationId, {});
      }
      const corr = this.correlationIndex.get(messageData.correlationId);
      if (messageData.role === 'user') {
        corr.requestMessageId = messageId;
      } else if (messageData.role === 'assistant') {
        corr.responseMessageId = messageId;
      }
    }

    if (this.autoSave) {
      this._saveToStorage();
    }

    this.logger.debug(`Registered message: ${messageId}`);
    return messageData;
  }

  /**
   * Register artifact for tracking
   */
  registerArtifact(artifactData) {
    if (!artifactData || !artifactData.id) {
      this.logger.warn('Cannot register artifact without ID');
      return null;
    }

    const artifactId = artifactData.id;
    this.artifacts.set(artifactId, {
      id: artifactId,
      type: artifactData.type,
      format: artifactData.format,
      sourceMessageId: artifactData.sourceMessageId,
      correlationId: artifactData.correlationId,
      chatId: artifactData.chatId,
      timestamp: artifactData.timestamp || Date.now(),
      status: artifactData.status || 'active'
    });

    // Index by chat
    if (artifactData.chatId) {
      if (!this.chatArtifactsIndex.has(artifactData.chatId)) {
        this.chatArtifactsIndex.set(artifactData.chatId, new Set());
      }
      this.chatArtifactsIndex.get(artifactData.chatId).add(artifactId);
    }

    // Link to message if available
    if (artifactData.sourceMessageId) {
      this._linkArtifactToMessage(artifactId, artifactData.sourceMessageId);
    }

    if (this.autoSave) {
      this._saveToStorage();
    }

    this.logger.debug(`Registered artifact: ${artifactId} → message: ${artifactData.sourceMessageId}`);
    return artifactData;
  }

  /**
   * Link artifact to message (bidirectional)
   */
  _linkArtifactToMessage(artifactId, messageId) {
    // Forward index: message → artifacts
    if (!this.messageArtifactsIndex.has(messageId)) {
      this.messageArtifactsIndex.set(messageId, new Set());
    }
    this.messageArtifactsIndex.get(messageId).add(artifactId);

    // Reverse index: artifact → message
    this.artifactMessageIndex.set(artifactId, messageId);

    // Update message's artifact list
    const message = this.messages.get(messageId);
    if (message) {
      if (!message.artifactIds) {
        message.artifactIds = [];
      }
      if (!message.artifactIds.includes(artifactId)) {
        message.artifactIds.push(artifactId);
      }
    }
  }

  /**
   * Get message by ID
   */
  getMessage(messageId) {
    return this.messages.get(messageId) || null;
  }

  /**
   * Get artifact by ID
   */
  getArtifact(artifactId) {
    return this.artifacts.get(artifactId) || null;
  }

  /**
   * Get all artifacts for a message
   */
  getArtifactsForMessage(messageId) {
    const artifactIds = this.messageArtifactsIndex.get(messageId);
    if (!artifactIds) return [];
    
    return Array.from(artifactIds)
      .map(id => this.artifacts.get(id))
      .filter(Boolean);
  }

  /**
   * Get source message for an artifact
   */
  getMessageForArtifact(artifactId) {
    const messageId = this.artifactMessageIndex.get(artifactId);
    return messageId ? this.messages.get(messageId) : null;
  }

  /**
   * Get messages by correlation ID
   */
  getMessagesByCorrelation(correlationId) {
    const corr = this.correlationIndex.get(correlationId);
    if (!corr) return { request: null, response: null };

    return {
      request: corr.requestMessageId ? this.messages.get(corr.requestMessageId) : null,
      response: corr.responseMessageId ? this.messages.get(corr.responseMessageId) : null
    };
  }

  /**
   * Get all messages for a chat
   */
  getMessagesForChat(chatId) {
    const messageIds = this.chatMessagesIndex.get(chatId);
    if (!messageIds) return [];
    
    return Array.from(messageIds)
      .map(id => this.messages.get(id))
      .filter(Boolean)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Get all artifacts for a chat
   */
  getArtifactsForChat(chatId) {
    const artifactIds = this.chatArtifactsIndex.get(chatId);
    if (!artifactIds) return [];
    
    return Array.from(artifactIds)
      .map(id => this.artifacts.get(id))
      .filter(Boolean)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Get complete trace for message: message + artifacts + correlated message
   */
  getTrace(messageId) {
    const message = this.getMessage(messageId);
    if (!message) return null;

    const artifacts = this.getArtifactsForMessage(messageId);
    
    let correlatedMessage = null;
    if (message.correlationId) {
      const corr = this.getMessagesByCorrelation(message.correlationId);
      correlatedMessage = message.role === 'user' ? corr.response : corr.request;
    }

    return {
      message,
      artifacts,
      correlatedMessage
    };
  }

  /**
   * Update artifact-to-message link
   */
  updateArtifactMessageLink(artifactId, newMessageId) {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) {
      this.logger.warn(`Artifact not found: ${artifactId}`);
      return false;
    }

    // Remove old link if exists
    const oldMessageId = this.artifactMessageIndex.get(artifactId);
    if (oldMessageId) {
      const oldArtifacts = this.messageArtifactsIndex.get(oldMessageId);
      if (oldArtifacts) {
        oldArtifacts.delete(artifactId);
      }
    }

    // Update artifact data
    artifact.sourceMessageId = newMessageId;
    this.artifacts.set(artifactId, artifact);

    // Create new link
    this._linkArtifactToMessage(artifactId, newMessageId);

    if (this.autoSave) {
      this._saveToStorage();
    }

    this.logger.debug(`Updated artifact ${artifactId} link to message ${newMessageId}`);
    return true;
  }

  /**
   * Export complete audit trail
   */
  exportAuditTrail(options = {}) {
    const chatId = options.chatId;
    let messages = [];

    if (chatId) {
      messages = this.getMessagesForChat(chatId);
    } else {
      messages = Array.from(this.messages.values())
        .sort((a, b) => a.timestamp - b.timestamp);
    }

    const trail = messages.map(message => {
      const trace = this.getTrace(message.id);
      return {
        message,
        artifacts: trace.artifacts,
        correlatedMessage: trace.correlatedMessage
      };
    });

    return {
      exportedAt: Date.now(),
      version: '2.0',
      chatId: chatId || null,
      traceCount: trail.length,
      artifactCount: chatId 
        ? this.getArtifactsForChat(chatId).length 
        : this.artifacts.size,
      trail
    };
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      messages: this.messages.size,
      artifacts: this.artifacts.size,
      chats: this.chatMessagesIndex.size,
      correlations: this.correlationIndex.size,
      linkedArtifacts: this.artifactMessageIndex.size
    };
  }

  /**
   * Clear all data
   */
  clear() {
    this.messages.clear();
    this.artifacts.clear();
    this.correlationIndex.clear();
    this.messageArtifactsIndex.clear();
    this.artifactMessageIndex.clear();
    this.chatMessagesIndex.clear();
    this.chatArtifactsIndex.clear();
    
    if (this.autoSave) {
      this._saveToStorage();
    }
    
    this.logger.info('Cleared all traceability data');
  }

  /**
   * Clear data for specific chat
   */
  clearChat(chatId) {
    // Remove messages
    const messageIds = this.chatMessagesIndex.get(chatId);
    if (messageIds) {
      for (const messageId of messageIds) {
        this.messages.delete(messageId);
        this.messageArtifactsIndex.delete(messageId);
      }
      this.chatMessagesIndex.delete(chatId);
    }

    // Remove artifacts
    const artifactIds = this.chatArtifactsIndex.get(chatId);
    if (artifactIds) {
      for (const artifactId of artifactIds) {
        this.artifacts.delete(artifactId);
        this.artifactMessageIndex.delete(artifactId);
      }
      this.chatArtifactsIndex.delete(chatId);
    }

    if (this.autoSave) {
      this._saveToStorage();
    }

    this.logger.info(`Cleared traceability data for chat ${chatId}`);
  }

  /**
   * Prune old data beyond retention window
   */
  prune(retentionMs = 7 * 24 * 60 * 60 * 1000) { // 7 days default
    const cutoff = Date.now() - retentionMs;
    let prunedMessages = 0;
    let prunedArtifacts = 0;

    // Prune messages
    for (const [id, message] of this.messages.entries()) {
      if (message.timestamp < cutoff) {
        this.messages.delete(id);
        this.messageArtifactsIndex.delete(id);
        prunedMessages++;
      }
    }

    // Prune artifacts
    for (const [id, artifact] of this.artifacts.entries()) {
      if (artifact.timestamp < cutoff) {
        this.artifacts.delete(id);
        this.artifactMessageIndex.delete(id);
        prunedArtifacts++;
      }
    }

    if (this.autoSave) {
      this._saveToStorage();
    }

    this.logger.info(`Pruned ${prunedMessages} messages, ${prunedArtifacts} artifacts`);
    return { prunedMessages, prunedArtifacts };
  }

  /**
   * Save to PostgreSQL with debouncing
   * @private
   */
  _saveToStorage() {
    if (!this.storageAPI) {
      return; // Storage API not available
    }

    // Debounce saves to avoid excessive DB writes
    if (this._saveTimeout) {
      clearTimeout(this._saveTimeout);
    }

    this._pendingSave = true;
    this._saveTimeout = setTimeout(() => {
      this._performSave();
    }, this.saveDebounceMs);
  }

  /**
   * Perform actual save to PostgreSQL
   * @private
   */
  async _performSave() {
    if (!this.storageAPI || !this._pendingSave) {
      return;
    }

    this._pendingSave = false;

    try {
      // Serialize indexes to PostgreSQL-compatible format
      const data = {
        version: '2.0',
        timestamp: Date.now(),
        messages: Array.from(this.messages.entries()),
        artifacts: Array.from(this.artifacts.entries()),
        correlationIndex: Array.from(this.correlationIndex.entries()),
        messageArtifactsIndex: Array.from(this.messageArtifactsIndex.entries()).map(([k, v]) => [k, Array.from(v)]),
        artifactMessageIndex: Array.from(this.artifactMessageIndex.entries()),
        chatMessagesIndex: Array.from(this.chatMessagesIndex.entries()).map(([k, v]) => [k, Array.from(v)]),
        chatArtifactsIndex: Array.from(this.chatArtifactsIndex.entries()).map(([k, v]) => [k, Array.from(v)])
      };

      // Save via storageAPI (IPC → backend → PostgreSQL)
      if (typeof this.storageAPI.saveTraceabilityData === 'function') {
        await this.storageAPI.saveTraceabilityData(data);
        this.logger.debug('Traceability data saved to PostgreSQL');
      } else {
        this.logger.warn('storageAPI.saveTraceabilityData not available');
      }
    } catch (error) {
      this.logger.error('Failed to save traceability data to PostgreSQL:', error);
    }
  }

  /**
   * Load traceability data for a specific chat
   * @param {string} chatId - Chat ID to load
   */
  async loadForChat(chatId) {
    if (!this.storageAPI || !chatId) {
      return;
    }

    try {
      if (typeof this.storageAPI.loadTraceabilityData !== 'function') {
        return;
      }

      const data = await this.storageAPI.loadTraceabilityData(chatId);
      
      if (!data) {
        return;
      }

      // Merge data (allow tracking multiple chats)
      if (data.messages) {
        data.messages.forEach(([id, msg]) => this.messages.set(id, msg));
      }
      if (data.artifacts) {
        data.artifacts.forEach(([id, art]) => this.artifacts.set(id, art));
      }

      this.logger.info(`Loaded traceability for chat ${chatId.slice(0,8)}`);
    } catch (error) {
      this.logger.error(`Failed to load traceability for chat ${chatId}:`, error);
    }
  }

  /**
   * Load from PostgreSQL (deprecated)
   * @private
   */
  async _loadFromStorage() {
    // Deprecated - use loadForChat(chatId) instead
    this.logger.debug('_loadFromStorage called but is deprecated');
  }

  /**
   * Force immediate save (bypasses debouncing)
   */
  async forceSave() {
    if (this._saveTimeout) {
      clearTimeout(this._saveTimeout);
      this._saveTimeout = null;
    }
    await this._performSave();
  }
}

module.exports = { TraceabilityService };

