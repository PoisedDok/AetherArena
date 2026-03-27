'use strict';

/**
Incoming: ArtifactsStreamOrchestrator (message/artifact lifecycle events) --- {websocket.stream_event, json}
Processing: Track current streaming context, link code→output artifacts --- {2 jobs: JOB_TRACK_ENTITY, JOB_UPDATE_STATE}
Outgoing: Context queries for parent artifact linking --- {object, javascript_api}

ARCHITECTURAL NOTE: Open-interpreter emits code THEN output. Track code ID for output parent linking.
*/

/**
 * ExecutionContextTracker
 * 
 * Tracks execution context during streaming:
 * - Current streaming message ID
 * - Current chat ID
 * - Last code artifact ID (for linking outputs to code)
 * 
 * ARCHITECTURE:
 * - Domain service (pure state, no I/O)
 * - Stateful: maintains current execution context
 * - Contract enforcement: fails fast on missing required fields
 * 
 * EXECUTION MODEL:
 * Backend sends:
 * 1. assistant message start (with message_id)
 * 2. assistant:code (code block)
 * 3. computer:output (execution result)
 * 4. assistant message end
 * 
 * This tracker maintains context between steps 2→3 for parent linking.
 * 
 * @module domain/artifacts/services/ExecutionContextTracker
 */

const { createLogger } = require('../../../core/utils/logger');

class ExecutionContextTracker {
  constructor(options = {}) {
    this.enableLogging = options.enableLogging || false;
    this.log = createLogger({ component: 'ExecutionContextTracker' });
    
    // Current streaming context
    this._currentStreamingMessageId = null;
    this._currentChatId = null;
    this._lastCodeArtifactId = null;
    
    // Artifact registry: artifact_id → metadata
    this._artifactRegistry = new Map();
  }

  /**
   * Track assistant message start
   * CONTRACT: Backend MUST provide message_id and chat_id
   * 
   * @param {Object} message - Assistant message payload
   * @param {string} message.message_id - Message ID from backend
   * @param {string} message.chat_id - Chat ID from backend
   * @param {boolean} message.start - Start marker
   * @throws {Error} If message_id or chat_id missing
   */
  trackMessageStart(message) {
    if (!message || typeof message !== 'object') {
      throw new Error('[ExecutionContextTracker] CONTRACT VIOLATION: message must be object');
    }
    
    if (!message.start) {
      return; // Not a start marker
    }
    
    // CONTRACT: Backend MUST send chat_id (snake_case) - no fallbacks
    if (!message.chat_id || typeof message.chat_id !== 'string' || message.chat_id.trim().length === 0) {
      throw new Error(
        '[ExecutionContextTracker] CONTRACT VIOLATION: message.chat_id required for start marker'
      );
    }
    
    const chatId = message.chat_id.trim();
    
    this._currentChatId = chatId;
    
    // message_id may not be available on start marker if backend hasn't persisted yet
    if (message.message_id && typeof message.message_id === 'string') {
      this._currentStreamingMessageId = message.message_id;
      this._lastCodeArtifactId = null;
      
      if (this.enableLogging) {
        this.log.debug('Message stream started', {
          message_id: message.message_id,
          chat_id: chatId
        });
      }
    }
  }

  /**
   * Track assistant message end
   * 
   * @param {Object} message - Assistant message payload
   * @param {boolean} message.end - End marker
   */
  trackMessageEnd(message) {
    if (!message || typeof message !== 'object') {
      return;
    }
    
    if (!message.end) {
      return; // Not an end marker
    }
    
    if (this.enableLogging) {
      this.log.debug('Message stream ended', {
        message_id: this._currentStreamingMessageId
      });
    }
    
    this._currentStreamingMessageId = null;
    this._lastCodeArtifactId = null;
  }

  /**
   * Track code artifact
   * Updates last code artifact ID for output parent linking
   * 
   * @param {Object} artifact - Code artifact payload
   * @param {string} artifact.artifact_id - Artifact ID
   * @param {boolean} artifact.start - Start marker (skip if true)
   */
  trackCodeArtifact(artifact) {
    if (!artifact || typeof artifact !== 'object') {
      return;
    }
    
    // Don't track start markers (no artifact_id yet)
    if (artifact.start) {
      return;
    }
    
    const artifactId = artifact.artifact_id || artifact.artifactId;
    if (artifactId && typeof artifactId === 'string') {
      this._lastCodeArtifactId = artifactId;
      
      if (this.enableLogging) {
        this.log.debug('Code artifact tracked', {
          artifact_id: artifactId.substring(0, 40)
        });
      }
    }
  }

  /**
   * Record artifact metadata
   * 
   * @param {Object} artifact - Artifact payload
   * @param {string} artifact.id - Frontend artifact ID
   * @param {string} artifact.requestId - Backend request ID
   * @param {string} artifact.messageId - Message ID
   * @param {string} artifact.parentId - Parent artifact/message ID
   * @param {Object} extras - Additional metadata
   */
  recordArtifact(artifact, extras = {}) {
    if (!artifact || !artifact.id) {
      throw new Error('[ExecutionContextTracker] CONTRACT VIOLATION: artifact.id required');
    }
    
    if (!artifact.requestId) {
      throw new Error(
        `[ExecutionContextTracker] CONTRACT VIOLATION: artifact.requestId required. ` +
        `artifact.id=${artifact.id}`
      );
    }
    
    this._artifactRegistry.set(artifact.id, {
      kind: extras.kind || artifact.type,
      messageId: artifact.messageId,
      parentId: artifact.parentId,
      requestId: artifact.requestId,
      timestamp: artifact.timestamp || Date.now()
    });
  }

  /**
   * Get current streaming message ID
   * 
   * @returns {string|null} Current message ID or null
   */
  getCurrentMessageId() {
    return this._currentStreamingMessageId;
  }

  /**
   * Get current chat ID
   * 
   * @returns {string|null} Current chat ID or null
   */
  getCurrentChatId() {
    return this._currentChatId;
  }

  /**
   * Get last code artifact ID
   * Used for linking output artifacts to their source code
   * 
   * @returns {string|null} Last code artifact ID or null
   */
  getLastCodeArtifactId() {
    return this._lastCodeArtifactId;
  }

  /**
   * Get artifact metadata
   * 
   * @param {string} artifactId - Frontend artifact ID
   * @returns {Object|null} Artifact metadata or null if not found
   */
  getArtifactMetadata(artifactId) {
    return this._artifactRegistry.get(artifactId) || null;
  }

  /**
   * Check if artifact exists in registry
   * 
   * @param {string} artifactId - Frontend artifact ID
   * @returns {boolean}
   */
  hasArtifact(artifactId) {
    return this._artifactRegistry.has(artifactId);
  }

  /**
   * Get tracker statistics
   * 
   * @returns {Object} Statistics
   */
  getStats() {
    return {
      currentMessageId: this._currentStreamingMessageId,
      currentChatId: this._currentChatId,
      lastCodeArtifactId: this._lastCodeArtifactId,
      registeredArtifacts: this._artifactRegistry.size
    };
  }

  /**
   * Clear all state (for testing/cleanup)
   */
  clear() {
    this._currentStreamingMessageId = null;
    this._currentChatId = null;
    this._lastCodeArtifactId = null;
    
    const artifactCount = this._artifactRegistry.size;
    this._artifactRegistry.clear();
    
    if (this.enableLogging) {
      this.log.debug('Cleared state', { artifactCount });
    }
  }
}

module.exports = { ExecutionContextTracker };
