'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactService.finalizeArtifact/linkArtifact(), MessageService.registerMessage() (method calls with entity data) --- {message_data | artifact_data, javascript_object}
 * Processing: Maintain 7 indexes (messages/artifacts/correlationIndex/messageArtifactsIndex/artifactMessageIndex/chatMessagesIndex/chatArtifactsIndex Maps), register messages/artifacts with bidirectional linkage, track entities in indexes, query lineage trees, persist to localStorage with autoSave, clear indexes --- {6 jobs: JOB_CLEAR_STATE, JOB_GET_STATE, JOB_LOAD_FROM_DB, JOB_SAVE_TO_DB, JOB_TRACK_ENTITY, JOB_UPDATE_STATE}
 * Outgoing: localStorage (persist indexes), return linked entity data and lineage trees --- {linked_data | lineage_tree, javascript_object}
 * 
 * 
 * @module domain/artifacts/services/TraceabilityService
 */

class TraceabilityService {
  constructor(options = {}) {
    this.storageKey = options.storageKey || 'aether_traceability';
    this.logger = options.logger || this._createDefaultLogger();
    this.autoSave = options.autoSave !== false;
    
    // Core indexes
    this.messages = new Map(); // messageId -> MessageData
    this.artifacts = new Map(); // artifactId -> ArtifactData
    
    // Relationship indexes
    this.correlationIndex = new Map(); // correlationId -> { requestMessageId, responseMessageId }
    this.messageArtifactsIndex = new Map(); // messageId -> Set<artifactId>
    this.artifactMessageIndex = new Map(); // artifactId -> messageId
    this.chatMessagesIndex = new Map(); // chatId -> Set<messageId>
    this.chatArtifactsIndex = new Map(); // chatId -> Set<artifactId>
    
    this._loadFromStorage();
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
   * Save to storage (implementation depends on environment)
   */
  _saveToStorage() {
    // In-memory only for now
    // TODO: Implement IndexedDB persistence
    return;
  }

  /**
   * Load from storage
   */
  _loadFromStorage() {
    // In-memory only for now
    // TODO: Implement IndexedDB persistence
    return;
  }
}

module.exports = { TraceabilityService };

