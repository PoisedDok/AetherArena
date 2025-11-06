'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactsController.receiveArtifact(), ChatOrchestrator.switchChat(), TraceabilityService.registerArtifact() --- {artifact_types.artifact_data, object}
 * Processing: Track artifacts per chat session, link code+output pairs, maintain artifact lineage, group by message/execution, query artifacts by session/type/link, auto-categorize artifacts, sync with TraceabilityService --- {8 jobs: JOB_CLEAR_STATE, JOB_GET_STATE, JOB_INITIALIZE, JOB_ROUTE_BY_TYPE, JOB_TRACK_ENTITY, JOB_UPDATE_STATE, JOB_EMIT_EVENT, JOB_DELEGATE_TO_MODULE}
 * Outgoing: EventBus (SESSION.ARTIFACT_ADDED, SESSION.ARTIFACTS_LOADED, SESSION.SESSION_SWITCHED), return grouped artifacts and lineage trees --- {events, object}
 * 
 * 
 * @module domain/artifacts/services/ArtifactSessionManager
 */

const { EventTypes } = require('../../../core/events/EventTypes');
const { freeze } = Object;

class ArtifactSessionManager {
  constructor(options = {}) {
    this.eventBus = options.eventBus || null;
    this.traceabilityService = options.traceabilityService || null;
    this.storageAPI = options.storageAPI || null;
    this.logger = options.logger || this._createDefaultLogger();
    
    this.currentChatId = null;
    this.sessions = new Map();
    this.artifactLinks = new Map();
    this.artifactGroups = new Map();
    
    this._initialized = false;
  }
  
  _createDefaultLogger() {
    return {
      debug: (...args) => console.log('[ArtifactSessionManager]', ...args),
      info: (...args) => console.log('[ArtifactSessionManager]', ...args),
      warn: (...args) => console.warn('[ArtifactSessionManager]', ...args),
      error: (...args) => console.error('[ArtifactSessionManager]', ...args)
    };
  }
  
  async init() {
    if (this._initialized) {
      return;
    }
    
    this._initializeStorageAPI();
    this._initialized = true;
    this.logger.info('Initialized');
  }
  
  _initializeStorageAPI() {
    if (this.storageAPI) {
      return;
    }
    
    if (typeof window !== 'undefined' && window.storageAPI) {
      this.storageAPI = window.storageAPI;
    }
  }
  
  async switchSession(chatId) {
    if (this.currentChatId === chatId) {
      return this.getSessionArtifacts(chatId);
    }
    
    this.logger.info(`Switching session: ${this.currentChatId?.slice(0,8)} → ${chatId?.slice(0,8)}`);
    this.currentChatId = chatId;
    
    if (!chatId) {
      return { artifacts: [], groups: [] };
    }
    
    if (!this.sessions.has(chatId)) {
      await this._loadSession(chatId);
    }
    
    const sessionData = this.getSessionArtifacts(chatId);
    
    if (this.eventBus) {
      this.eventBus.emit(EventTypes.ARTIFACTS.SESSION_SWITCHED, {
        chatId,
        artifactCount: sessionData.artifacts.length,
        groupCount: sessionData.groups.length
      });
    }
    
    return sessionData;
  }
  
  async _loadSession(chatId) {
    try {
      this.logger.debug(`Loading session: ${chatId.slice(0,8)}`);
      
      const artifacts = this.storageAPI 
        ? await this.storageAPI.loadArtifacts(chatId)
        : [];
      
      const session = {
        chatId,
        artifacts: new Map(),
        groups: new Map(),
        executionOrder: [],
        loadedAt: Date.now()
      };
      
      for (const artifact of artifacts) {
        this._addArtifactToSession(session, artifact);
      }
      
      this.sessions.set(chatId, session);
      
      if (this.eventBus) {
        this.eventBus.emit(EventTypes.ARTIFACTS.SESSION_LOADED, {
          chatId,
          artifactCount: artifacts.length
        });
      }
      
      this.logger.info(`Loaded ${artifacts.length} artifacts for session ${chatId.slice(0,8)}`);
      
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
    this._addArtifactToSession(session, artifact);
    
    this._linkArtifacts(artifact);
    this._groupArtifacts(session, artifact);
    
    if (this.traceabilityService) {
      this.traceabilityService.registerArtifact({
        id: artifact.id,
        type: artifact.type,
        format: artifact.format,
        sourceMessageId: artifact.messageId,
        chatId: chatId,
        timestamp: artifact.timestamp || Date.now(),
        status: 'active'
      });
    }
    
    if (this.eventBus) {
      this.eventBus.emit(EventTypes.ARTIFACTS.ARTIFACT_ADDED, {
        chatId,
        artifactId: artifact.id,
        type: artifact.type
      });
    }
    
    this.logger.debug(`Added artifact ${artifact.id.slice(0,8)} to session ${chatId.slice(0,8)}`);
    
    return artifact;
  }
  
  _addArtifactToSession(session, artifact) {
    const enrichedArtifact = {
      ...artifact,
      sessionIndex: session.executionOrder.length,
      addedAt: Date.now(),
      category: this._categorizeArtifact(artifact)
    };
    
    session.artifacts.set(artifact.id, enrichedArtifact);
    session.executionOrder.push(artifact.id);
  }
  
  _categorizeArtifact(artifact) {
    if (artifact.role === 'assistant' && artifact.type === 'code') {
      return 'code_written';
    }
    
    if (artifact.role === 'computer' && artifact.type === 'console') {
      return 'execution_console';
    }
    
    if (artifact.role === 'computer' && artifact.type === 'code') {
      return 'execution_output';
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
    group.artifacts.push(artifact.id);
    
    if (artifact.category === 'code_written') {
      group.codeArtifacts.push(artifact.id);
    } else if (artifact.category.includes('output') || artifact.category.includes('execution')) {
      group.outputArtifacts.push(artifact.id);
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
    return session ? session.artifacts.get(artifactId) : null;
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
  console.log('📦 ArtifactSessionManager loaded');
}

