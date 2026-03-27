'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactService/MessageService (entity registration for UI cache) --- {object, javascript_api}
 * Processing: Maintain lightweight in-memory cache for UI rendering, query backend for relationships --- {3 jobs: JOB_GET_STATE, JOB_TRACK_ENTITY, JOB_UPDATE_STATE}
 * Outgoing: Cached relationship data for UI --- {object, javascript_api}
 * 
 * ARCHITECTURE NOTE:
 * Backend owns ALL relationship management via `message_artifact_link` table.
 * Frontend ONLY maintains ephemeral session cache for UI rendering performance.
 * NO persistence - backend is source of truth. Query backend APIs when needed.
 * 
 * Previous 7-index state management + persistence removed per architecture.
 * 
 * @module domain/artifacts/services/TraceabilityService
 */

/**
 * TraceabilityService
 * 
 * Lightweight session cache for UI rendering ONLY.
 * Backend owns relationships - frontend trusts backend.
 * 
 * Maintains minimal in-memory indexes for current session's UI needs:
 * - messageArtifactsIndex: messageId → Set<artifactId> (for UI artifact lists)
 * - artifactMessageIndex: artifactId → messageId (for UI parent lookups)
 * 
 * All other indexes removed - query backend when needed.
 */
const { createLogger } = require('../../../core/utils/logger');

class TraceabilityService {
  constructor(options = {}) {
    this.storageAPI = options.storageAPI || null;
    this.logger = options.logger || createLogger({ component: 'TraceabilityService' });
    
    // Minimal UI cache (session only, no persistence)
    this.messageArtifactsIndex = new Map(); // messageId → Set<artifactId>
    this.artifactMessageIndex = new Map(); // artifactId → messageId
    
    this.logger.info('TraceabilityService: Lightweight session cache mode (backend owns relationships)');
  }

  /**
   * Link artifact to message (UI cache only)
   * ARCHITECTURE: Backend persists via message_artifact_link table
   */
  linkArtifactToMessage(artifactId, messageId) {
    if (!artifactId || !messageId) {
      this.logger.warn('Cannot link without artifactId and messageId');
      return false;
    }

    // Forward index: message → artifacts
    if (!this.messageArtifactsIndex.has(messageId)) {
      this.messageArtifactsIndex.set(messageId, new Set());
    }
    this.messageArtifactsIndex.get(messageId).add(artifactId);

    // Reverse index: artifact → message
    this.artifactMessageIndex.set(artifactId, messageId);

    this.logger.debug(`Cached link: artifact ${artifactId} → message ${messageId}`);
    return true;
  }

  /**
   * Link all artifacts associated with a correlation ID to a message
   * ARCHITECTURE: Backend handles persistence - frontend just caches for UI
   */
  async linkArtifactsToMessage(correlationId, messageId, options = {}) {
    try {
      if (!correlationId || !messageId) {
        throw new Error('Correlation ID and message ID are required');
      }

      // Query backend for artifacts by correlation ID
      // FUTURE_WORK: Dedicated /v1/artifacts/by-correlation endpoint (Section 7.2).
      // Current: returns empty; trail metadata links artifacts to messages at render time.
      this.logger.warn(`linkArtifactsToMessage: correlation-based query not yet wired (correlationId=${correlationId})`);
      
      return [];
    } catch (error) {
      this.logger.error(`Failed to link artifacts for correlation ${correlationId}:`, error);
      throw error;
    }
  }

  /**
   * Get all artifacts for a message (from UI cache)
   * ARCHITECTURE: Returns cached data - query backend if not in cache
   */
  getArtifactsForMessage(messageId) {
    const artifactIds = this.messageArtifactsIndex.get(messageId);
    if (!artifactIds) {
      this.logger.debug(`No cached artifacts for message ${messageId} - query backend if needed`);
      return [];
    }
    
    return Array.from(artifactIds);
  }

  /**
   * Get source message for an artifact (from UI cache)
   * ARCHITECTURE: Returns cached data - query backend if not in cache
   */
  getMessageForArtifact(artifactId) {
    const messageId = this.artifactMessageIndex.get(artifactId);
    if (!messageId) {
      this.logger.debug(`No cached message for artifact ${artifactId} - query backend if needed`);
      return null;
    }
    
    return messageId;
  }

  /**
   * Update artifact-to-message link (UI cache only)
   * ARCHITECTURE: Backend handles persistence
   */
  updateArtifactMessageLink(artifactId, newMessageId) {
    if (!artifactId || !newMessageId) {
      this.logger.warn('Cannot update link without artifactId and newMessageId');
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

    // Create new link
    this.linkArtifactToMessage(artifactId, newMessageId);

    this.logger.debug(`Updated cached link: artifact ${artifactId} → message ${newMessageId}`);
    return true;
  }

  /**
   * Get statistics (from UI cache only)
   */
  getStats() {
    return {
      cachedMessages: this.messageArtifactsIndex.size,
      cachedArtifacts: this.artifactMessageIndex.size,
      note: 'Session cache only - backend owns source of truth'
    };
  }

  /**
   * Clear UI cache
   */
  clear() {
    this.messageArtifactsIndex.clear();
    this.artifactMessageIndex.clear();
    
    this.logger.info('Cleared session cache');
  }

  /**
   * Clear cache for specific chat
   */
  clearChat(chatId) {
    // Note: Without chat-level indexes, we can't efficiently clear by chat
    // Frontend should re-instantiate TraceabilityService when switching chats
    this.logger.warn(`clearChat(${chatId}): Session cache doesn't index by chat - consider re-instantiating service`);
  }

  /**
   * Legacy compatibility: registerMessage removed
   * ARCHITECTURE: Backend owns message tracking
   * @deprecated Query backend for message data
   */
  registerMessage(messageData) {
    this.logger.warn('registerMessage() is deprecated - backend owns message tracking');
    return messageData;
  }

  /**
   * Legacy compatibility: registerArtifact removed
   * ARCHITECTURE: Backend owns artifact tracking
   * @deprecated Query backend for artifact data
   */
  registerArtifact(artifactData) {
    this.logger.warn('registerArtifact() is deprecated - backend owns artifact tracking');
    return artifactData;
  }

  /**
   * Legacy compatibility: getMessage removed
   * ARCHITECTURE: Backend owns message data
   * @deprecated Query backend for message data
   */
  getMessage(messageId) {
    this.logger.warn('getMessage() is deprecated - query backend for message data');
    return null;
  }

  /**
   * Legacy compatibility: getArtifact removed
   * ARCHITECTURE: Backend owns artifact data
   * @deprecated Query backend for artifact data
   */
  getArtifact(artifactId) {
    this.logger.warn('getArtifact() is deprecated - query backend for artifact data');
    return null;
  }

  /**
   * Legacy compatibility: getMessagesByCorrelation removed
   * ARCHITECTURE: Backend owns correlation queries
   * @deprecated Query backend for correlation data
   */
  getMessagesByCorrelation(correlationId) {
    this.logger.warn('getMessagesByCorrelation() is deprecated - query backend');
    return { request: null, response: null };
  }

  /**
   * Legacy compatibility: getMessagesForChat removed
   * ARCHITECTURE: Backend owns chat queries
   * @deprecated Query backend for chat messages
   */
  getMessagesForChat(chatId) {
    this.logger.warn('getMessagesForChat() is deprecated - query backend');
    return [];
  }

  /**
   * Legacy compatibility: getArtifactsForChat removed
   * ARCHITECTURE: Backend owns chat queries
   * @deprecated Query backend for chat artifacts
   */
  getArtifactsForChat(chatId) {
    this.logger.warn('getArtifactsForChat() is deprecated - query backend');
    return [];
  }

  /**
   * Legacy compatibility: getTrace removed
   * ARCHITECTURE: Backend owns trace queries
   * @deprecated Query backend for complete trace
   */
  getTrace(messageId) {
    this.logger.warn('getTrace() is deprecated - query backend');
    return null;
  }

  /**
   * Legacy compatibility: exportAuditTrail removed
   * ARCHITECTURE: Backend owns audit exports
   * @deprecated Query backend for audit trails
   */
  exportAuditTrail(options = {}) {
    this.logger.warn('exportAuditTrail() is deprecated - query backend');
    return { trail: [] };
  }

  /**
   * Legacy compatibility: prune removed
   * ARCHITECTURE: Backend owns data retention
   * @deprecated Backend handles pruning
   */
  prune(retentionMs) {
    this.logger.warn('prune() is deprecated - backend handles data retention');
    return { prunedMessages: 0, prunedArtifacts: 0 };
  }

  /**
   * Legacy compatibility: persistence removed
   * ARCHITECTURE: Backend owns persistence via message_artifact_link table
   * @deprecated Backend handles all persistence
   */
  async forceSave() {
    this.logger.warn('forceSave() is deprecated - backend owns persistence');
  }

  /**
   * Legacy compatibility: loadForChat removed
   * ARCHITECTURE: Backend owns data loading
   * @deprecated Query backend for chat data
   */
  async loadForChat(chatId) {
    this.logger.warn('loadForChat() is deprecated - query backend for chat data');
  }
}

module.exports = { TraceabilityService };
