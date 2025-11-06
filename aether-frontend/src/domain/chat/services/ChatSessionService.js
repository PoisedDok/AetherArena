/**
 * @.architecture
 * 
 * Incoming: ChatOrchestrator.createSession/setActiveSession() (method calls for session management) --- {request_types.session_management, method_call}
 * Processing: Create/manage chat sessions, maintain sessions Map (sessionId → session object), maintain chatToSession Map (chatId → sessionId), track artifacts per session (Set of artifactIds), set active session, persist to localStorage (autoSave), load from localStorage on init, clear sessions --- {8 jobs: JOB_CLEAR_STATE, JOB_GENERATE_SESSION_ID, JOB_GET_STATE, JOB_INITIALIZE, JOB_LOAD_FROM_DB, JOB_SAVE_TO_DB, JOB_TRACK_ENTITY, JOB_UPDATE_STATE}
 * Outgoing: localStorage (persist sessions and active session key), return session objects --- {session_object, javascript_object}
 * 
 * 
 * @module domain/chat/services/ChatSessionService
 */

class ChatSessionService {
  constructor(options = {}) {
    this.storageKey = options.storageKey || 'aether_chat_sessions';
    this.currentSessionKey = 'aether_current_session';
    this.sessions = new Map(); // sessionId → { id, chatId, artifacts: Set<artifactId>, created, updated }
    this.activeSessionId = null;
    this.chatToSession = new Map(); // chatId → sessionId
    this.logger = options.logger || this._createDefaultLogger();
    this.autoSave = options.autoSave !== false;
    
    this._loadFromStorage();
  }

  _createDefaultLogger() {
    return {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {}
    };
  }

  /**
   * Create a new chat session
   */
  createSession(chatId, metadata = {}) {
    const sessionId = this._generateSessionId();
    
    const session = {
      id: sessionId,
      chatId: chatId || this._generateChatId(),
      artifacts: new Set(),
      created: Date.now(),
      updated: Date.now(),
      metadata: {
        ...metadata,
        version: '1.0'
      }
    };
    
    this.sessions.set(sessionId, session);
    this.chatToSession.set(session.chatId, sessionId);
    
    // Set as active if no active session
    if (!this.activeSessionId) {
      this.activeSessionId = sessionId;
      this._saveActiveSession();
    }
    
    if (this.autoSave) {
      this._saveToStorage();
    }
    
    this.logger.info(`Created session: ${sessionId} for chat: ${session.chatId}`);
    return session;
  }

  /**
   * Get or create session for a chat
   */
  getOrCreateSessionForChat(chatId) {
    if (!chatId) {
      chatId = this._generateChatId();
    }
    
    // Check if session exists for this chat
    const sessionId = this.chatToSession.get(chatId);
    if (sessionId && this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId);
    }
    
    // Create new session
    return this.createSession(chatId);
  }

  /**
   * Set active session
   */
  setActiveSession(sessionId) {
    if (!this.sessions.has(sessionId)) {
      this.logger.warn(`Session ${sessionId} not found, creating new session`);
      const session = this.createSession(null, { restored: true });
      sessionId = session.id;
    }
    
    this.activeSessionId = sessionId;
    this._saveActiveSession();
    
    this.logger.info(`Active session set to: ${sessionId}`);
    return this.sessions.get(sessionId);
  }

  /**
   * Get active session
   */
  getActiveSession() {
    if (!this.activeSessionId || !this.sessions.has(this.activeSessionId)) {
      // Create new session if none exists
      const session = this.createSession();
      this.activeSessionId = session.id;
      this._saveActiveSession();
      return session;
    }
    
    return this.sessions.get(this.activeSessionId);
  }

  /**
   * Register artifact to current session
   */
  registerArtifact(artifactId, sessionId = null) {
    const targetSessionId = sessionId || this.activeSessionId;
    
    if (!targetSessionId) {
      this.logger.warn('No active session, creating new one');
      const session = this.createSession();
      this.activeSessionId = session.id;
    }
    
    const session = this.sessions.get(targetSessionId || this.activeSessionId);
    if (!session) {
      this.logger.error(`Session ${targetSessionId} not found`);
      return false;
    }
    
    session.artifacts.add(artifactId);
    session.updated = Date.now();
    
    if (this.autoSave) {
      this._saveToStorage();
    }
    
    this.logger.debug(`Registered artifact ${artifactId} to session ${session.id}`);
    return true;
  }

  /**
   * Get all artifacts for a session
   */
  getSessionArtifacts(sessionId = null) {
    const targetSessionId = sessionId || this.activeSessionId;
    const session = this.sessions.get(targetSessionId);
    
    if (!session) {
      return new Set();
    }
    
    return new Set(session.artifacts);
  }

  /**
   * Check if artifact belongs to session
   */
  hasArtifact(artifactId, sessionId = null) {
    const targetSessionId = sessionId || this.activeSessionId;
    const session = this.sessions.get(targetSessionId);
    
    if (!session) {
      return false;
    }
    
    return session.artifacts.has(artifactId);
  }

  /**
   * Get session by chat ID
   */
  getSessionByChatId(chatId) {
    const sessionId = this.chatToSession.get(chatId);
    return sessionId ? this.sessions.get(sessionId) : null;
  }

  /**
   * End session (mark as inactive but preserve data)
   */
  endSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    
    session.ended = Date.now();
    session.metadata.ended = true;
    
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
      this._saveActiveSession();
    }
    
    if (this.autoSave) {
      this._saveToStorage();
    }
    
    this.logger.info(`Ended session: ${sessionId}`);
    return true;
  }

  /**
   * Delete session and all its artifacts
   */
  deleteSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    
    // Remove from maps
    this.sessions.delete(sessionId);
    this.chatToSession.delete(session.chatId);
    
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
      this._saveActiveSession();
    }
    
    if (this.autoSave) {
      this._saveToStorage();
    }
    
    this.logger.info(`Deleted session: ${sessionId} (${session.artifacts.size} artifacts)`);
    return true;
  }

  /**
   * Get all sessions
   */
  getAllSessions() {
    return Array.from(this.sessions.values()).map(session => ({
      ...session,
      artifacts: Array.from(session.artifacts)
    }));
  }

  /**
   * Clear all sessions
   */
  clearAllSessions() {
    this.sessions.clear();
    this.chatToSession.clear();
    this.activeSessionId = null;
    this.logger.info('Cleared all sessions');
  }

  /**
   * Generate unique session ID
   */
  _generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Generate unique chat ID
   */
  _generateChatId() {
    return `chat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  _saveToStorage() {
    // Stub - would need localStorage/indexedDB implementation
    return;
  }

  _saveActiveSession() {
    // Stub - would need localStorage/indexedDB implementation
    return;
  }

  _loadFromStorage() {
    // Stub - would need localStorage/indexedDB implementation
    return;
  }

  /**
   * Export session data for backup
   */
  exportSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    
    return {
      ...session,
      artifacts: Array.from(session.artifacts)
    };
  }

  /**
   * Import session data from backup
   */
  importSession(sessionData) {
    if (!sessionData || !sessionData.id) {
      return false;
    }
    
    const session = {
      ...sessionData,
      artifacts: new Set(sessionData.artifacts || [])
    };
    
    this.sessions.set(session.id, session);
    if (session.chatId) {
      this.chatToSession.set(session.chatId, session.id);
    }
    
    if (this.autoSave) {
      this._saveToStorage();
    }
    
    this.logger.info(`Imported session: ${session.id}`);
    return true;
  }

  /**
   * Validate session data
   */
  static validate(sessionData) {
    if (!sessionData || typeof sessionData !== 'object') {
      return { valid: false, error: 'Session data must be an object' };
    }
    
    if (!sessionData.id || typeof sessionData.id !== 'string') {
      return { valid: false, error: 'Session must have a valid ID' };
    }
    
    return { valid: true };
  }
}

module.exports = { ChatSessionService };

