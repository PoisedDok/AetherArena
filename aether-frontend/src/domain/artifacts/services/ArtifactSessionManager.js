'use strict';

/**
 * @.architecture
 * Incoming: ArtifactsController.receiveArtifact|ChatOrchestrator.switchChat|TraceabilityService.registerArtifact --- {event.custom, object}
 * Processing: Maintain per-chat artifact state, enforce lineage tracking, emit session telemetry --- {8 jobs: JOB_CLEAR_STATE, JOB_DELEGATE_TO_MODULE, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_INITIALIZE, JOB_ROUTE_BY_TYPE, JOB_TRACK_ENTITY, JOB_UPDATE_STATE}
 * Outgoing: EventBus.emit(EventTypes.ARTIFACTS.*) --- {event.custom, object}
 * @module domain/artifacts/services/ArtifactSessionManager
 */

const { EventTypes } = require('../../../core/events/EventTypes');
const { normalizeArtifactPayload } = require('../utils/ArtifactNormalizer');
const { createLogger } = require('../../../core/utils/logger');
const { freeze } = Object;

class ArtifactSessionManager {
  constructor(options = {}) {
    this.eventBus = options.eventBus || null;
    this.traceabilityService = options.traceabilityService || null;
    this.storageAPI = options.storageAPI || null;
    this.logger = options.logger || createLogger({ component: 'ArtifactSessionManager' });
    
    this.currentChatId = null;
    this.sessions = new Map();
    this.artifactLinks = new Map();
    this.artifactGroups = new Map();
    
    this._initialized = false;
  }
  
  // Default logger removed -- createLogger({ component }) used in constructor fallback
  
  async init() {
    try {
      if (this._initialized) {
        return;
      }

      this._initializeStorageAPI();
      this._initialized = true;
      this.logger.info('Initialized');
    } catch (error) {
      this.logger.error('Failed to initialize ArtifactSessionManager:', error);
      throw error;
    }
  }
  
  _initializeStorageAPI() {
    if (this.storageAPI) {
      return;
    }

    const globalStorage =
      typeof globalThis !== 'undefined' && globalThis.storageAPI
        ? globalThis.storageAPI
        : null;

    if (globalStorage) {
      this.storageAPI = globalStorage;
    }
  }
  
  async switchSession(chatId) {
    try {
      await this.init();

      if (this.currentChatId === chatId) {
        return this.getSessionArtifacts(chatId);
      }

      const previousChatId = this.currentChatId;
      const nextChatId = typeof chatId === 'string' && chatId.trim().length > 0 ? chatId : null;

      if (!nextChatId) {
        this.currentChatId = null;
        return { artifacts: [], groups: [] };
      }

      this.logger.info(
        `Switching session: ${previousChatId?.slice(0, 8) ?? 'none'} → ${nextChatId.slice(0, 8)}`
      );

      if (!this.sessions.has(nextChatId)) {
        await this._loadSession(nextChatId);
      }

      const sessionData = this.getSessionArtifacts(nextChatId);
      this.currentChatId = nextChatId;

      if (this.eventBus) {
        this.eventBus.emit(EventTypes.ARTIFACTS.SESSION_SWITCHED, {
          chatId: nextChatId,
          artifactCount: sessionData.artifacts.length,
          groupCount: sessionData.groups.length
        });
      }

      return sessionData;
    } catch (error) {
      this.logger.error(`Failed to switch session to ${chatId}:`, error);
      throw error;
    }
  }
  
  async _loadSession(chatId) {
    try {
      this.logger.debug(`Loading session: ${chatId.slice(0,8)}`);
      
      const artifacts = this.storageAPI 
        ? await this.storageAPI.loadArtifacts(chatId)
        : [];
      const normalizedArtifacts = [];
      for (const artifact of artifacts) {
        try {
          const normalized = normalizeArtifactPayload(artifact, chatId);
          normalizedArtifacts.push(normalized);
        } catch (error) {
          this.logger.error(`[ArtifactSessionManager] Failed to normalize artifact: ${error.message}`, {
            artifactId: artifact?.id || artifact?.artifact_id || 'unknown',
            chatId: chatId.substring(0, 8)
          });
          // Skip corrupted artifacts - continue loading others
        }
      }
      const artifactCount = normalizedArtifacts.length;
      
      const session = {
        chatId,
        artifacts: new Map(),
        groups: new Map(),
        executionOrder: [],
        loadedAt: Date.now()
      };
      
      for (const artifact of normalizedArtifacts) {
        const storedArtifact = this._addArtifactToSession(session, artifact);
        this._linkArtifacts(storedArtifact);
        this._groupArtifacts(session, storedArtifact);
      }
      
      this.sessions.set(chatId, session);
      
      if (this.eventBus) {
        this.eventBus.emit(EventTypes.ARTIFACTS.SESSION_LOADED, {
          chatId,
          artifactCount
        });
      }
      
      this.logger.info(`Loaded ${artifactCount} artifacts for session ${chatId.slice(0,8)}`);
      
    } catch (error) {
      this.logger.error(`Failed to load session ${chatId}:`, error);
      throw error;
    }
  }
  
  addArtifact(artifact) {
    if (!artifact || !artifact.id) {
      this.logger.warn('Cannot add artifact without ID');
      return null;
    }
    
    const chatId = artifact.chatId || this.currentChatId;
    
    if (!chatId) {
      this.logger.warn('Cannot add artifact without chatId');
      return null;
    }
    
    if (!this.sessions.has(chatId)) {
      this.sessions.set(chatId, {
        chatId,
        artifacts: new Map(),
        groups: new Map(),
        executionOrder: [],
        loadedAt: Date.now()
      });
    }
    
    const session = this.sessions.get(chatId);
    const storedArtifact = this._addArtifactToSession(session, artifact);
    
    this._linkArtifacts(storedArtifact);
    this._groupArtifacts(session, storedArtifact);
    
    if (this.traceabilityService) {
      this.traceabilityService.registerArtifact({
        id: storedArtifact.id,
        type: storedArtifact.type,
        format: storedArtifact.format,
        sourceMessageId: storedArtifact.messageId,
        chatId: chatId,
        timestamp: storedArtifact.timestamp || Date.now(),
        status: 'active'
      });
    }
    
    if (this.eventBus) {
      this.eventBus.emit(EventTypes.ARTIFACTS.ARTIFACT_ADDED, {
        chatId,
        artifactId: storedArtifact.id,
        type: storedArtifact.type,
        artifact: storedArtifact  // Include full artifact for event handlers
      });
    }
    
    this.logger.debug(`Added artifact ${storedArtifact.id.slice(0,8)} to session ${chatId.slice(0,8)}`);
    
    return storedArtifact;
  }
  
  _addArtifactToSession(session, artifact) {
    const existing = session.artifacts.get(artifact.id);
    const sessionIndex = existing ? existing.sessionIndex : session.executionOrder.length;

    if (!existing) {
      session.executionOrder.push(artifact.id);
    }

    const enrichedArtifact = {
      ...existing,
      ...artifact,
      sessionIndex,
      addedAt: existing?.addedAt ?? Date.now(),
      category: this._categorizeArtifact(artifact)
    };
    
    session.artifacts.set(artifact.id, enrichedArtifact);
    return enrichedArtifact;
  }
  
  _categorizeArtifact(artifact) {
    // Categorize based on role and type
    // Role 'computer' indicates execution output
    // Role 'assistant' indicates agent-generated content
    
    if (artifact.role === 'computer') {
      // Computer outputs (from code execution)
      if (artifact.type === 'console') {
        return 'execution_console';
      }
      if (artifact.type === 'output' || artifact.type === 'code') {
        return 'execution_output';
      }
    }
    
    if (artifact.role === 'assistant' && artifact.type === 'code') {
      return 'code_written';
    }
    
    if (artifact.format === 'html') {
      return 'html_output';
    }
    
    if (artifact.type === 'output') {
      return 'general_output';
    }
    
    return 'unknown';
  }
  
  _linkArtifacts(artifact) {
    if (artifact.parentId) {
      if (!this.artifactLinks.has(artifact.parentId)) {
        this.artifactLinks.set(artifact.parentId, new Set());
      }
      this.artifactLinks.get(artifact.parentId).add(artifact.id);
      
      this.logger.debug(`Linked artifact ${artifact.id.slice(0,8)} to parent ${artifact.parentId.slice(0,8)}`);
    }
  }
  
  _groupArtifacts(session, artifact) {
    const messageId = artifact.messageId || artifact.correlationId;
    
    if (!messageId) {
      return;
    }
    
    if (!session.groups.has(messageId)) {
      session.groups.set(messageId, {
        messageId,
        artifacts: [],
        codeArtifacts: [],
        outputArtifacts: [],
        createdAt: Date.now()
      });
    }
    
    const group = session.groups.get(messageId);
    if (!group.artifacts.includes(artifact.id)) {
      group.artifacts.push(artifact.id);
    }
    
    const category = artifact.category || this._categorizeArtifact(artifact);
    
    if (category === 'code_written') {
      if (!group.codeArtifacts.includes(artifact.id)) {
        group.codeArtifacts.push(artifact.id);
      }
    } else if (typeof category === 'string' && (category.includes('output') || category.includes('execution'))) {
      if (!group.outputArtifacts.includes(artifact.id)) {
        group.outputArtifacts.push(artifact.id);
      }
    }
  }
  
  getSessionArtifacts(chatId) {
    const session = this.sessions.get(chatId);
    
    if (!session) {
      return { artifacts: [], groups: [] };
    }
    
    const artifacts = Array.from(session.artifacts.values())
      .sort((a, b) => a.sessionIndex - b.sessionIndex);
    
    const groups = Array.from(session.groups.values())
      .map(group => ({
        ...group,
        artifacts: group.artifacts.map(id => session.artifacts.get(id)).filter(Boolean)
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
    
    return { artifacts, groups };
  }
  
  getArtifact(artifactId, chatId = null) {
    const targetChatId = chatId || this.currentChatId;
    
    if (!targetChatId) {
      return null;
    }
    
    const session = this.sessions.get(targetChatId);
    return session ? (session.artifacts.get(artifactId) ?? null) : null;
  }
  
  getLinkedArtifacts(artifactId) {
    const linkedIds = this.artifactLinks.get(artifactId);
    
    if (!linkedIds || !this.currentChatId) {
      return [];
    }
    
    const session = this.sessions.get(this.currentChatId);
    
    if (!session) {
      return [];
    }
    
    return Array.from(linkedIds)
      .map(id => session.artifacts.get(id))
      .filter(Boolean);
  }
  
  getArtifactGroup(messageId, chatId = null) {
    const targetChatId = chatId || this.currentChatId;
    
    if (!targetChatId) {
      return null;
    }
    
    const session = this.sessions.get(targetChatId);
    
    if (!session) {
      return null;
    }
    
    const group = session.groups.get(messageId);
    
    if (!group) {
      return null;
    }
    
    return {
      ...group,
      artifacts: group.artifacts.map(id => session.artifacts.get(id)).filter(Boolean)
    };
  }
  
  getArtifactsByCategory(category, chatId = null) {
    const { artifacts } = this.getSessionArtifacts(chatId || this.currentChatId);
    return artifacts.filter(a => a.category === category);
  }
  
  clearSession(chatId) {
    this.sessions.delete(chatId);
    this.logger.info(`Cleared session ${chatId?.slice(0,8)}`);
  }
  
  clearAllSessions() {
    this.sessions.clear();
    this.artifactLinks.clear();
    this.artifactGroups.clear();
    this.currentChatId = null;
    this.logger.info('Cleared all sessions');
  }
  
  getStats() {
    return freeze({
      currentChatId: this.currentChatId,
      sessionCount: this.sessions.size,
      totalArtifacts: Array.from(this.sessions.values())
        .reduce((sum, s) => sum + s.artifacts.size, 0),
      totalLinks: Array.from(this.artifactLinks.values())
        .reduce((sum, links) => sum + links.size, 0)
    });
  }
}

module.exports = ArtifactSessionManager;

if (typeof window !== 'undefined') {
  window.ArtifactSessionManager = ArtifactSessionManager;
  // ArtifactSessionManager loaded
}
