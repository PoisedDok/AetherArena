'use strict';

/**
 * @.architecture
 * 
 * Incoming: Application modules (UIManager, MessageService, ArtifactService via method calls requesting IDs) --- {method_call, javascript_api}
 * Processing: Generate deterministic sequential IDs with format chatId_sequence_type, maintain ChatSession state per chat, track parent-child relationships in linkMap, store metadata for all entities, emit lifecycle events --- {7 jobs: JOB_CLEAR_STATE, JOB_EMIT_EVENT, JOB_GENERATE_SESSION_ID, JOB_GET_STATE, JOB_INITIALIZE, JOB_TRACK_ENTITY, JOB_UPDATE_STATE}
 * Outgoing: Return formatted ID strings (chatId_000001_UM pattern), emit session lifecycle events --- {session_types.session_id, string}
 * 
 * 
 * @module core/session/SessionManager
 */

const EventEmitter = require('events');

/**
 * ID type suffixes and their meanings
 */
const ID_TYPES = Object.freeze({
  USER_MESSAGE: 'UM',
  ASSISTANT_MESSAGE: 'AM',
  ASSISTANT_CODE: 'AC',
  ASSISTANT_OUTPUT: 'AO',
  ASSISTANT_HTML: 'AH',
  USER_ATTACHMENT: 'UA',
});

/**
 * Extract components from a session ID
 * @param {string} id - Session ID
 * @returns {{chatId: string, sequence: number, type: string} | null}
 */
function parseSessionId(id) {
  if (!id || typeof id !== 'string') return null;
  
  const parts = id.split('_');
  if (parts.length !== 3) return null;
  
  const [chatId, seqStr, type] = parts;
  const sequence = parseInt(seqStr, 10);
  
  if (!chatId || isNaN(sequence) || !type) return null;
  
  return { chatId, sequence, type };
}

/**
 * Compare two session IDs for ordering
 * @param {string} id1 - First ID
 * @param {string} id2 - Second ID
 * @returns {number} -1 if id1 < id2, 0 if equal, 1 if id1 > id2
 */
function compareSessionIds(id1, id2) {
  const parsed1 = parseSessionId(id1);
  const parsed2 = parseSessionId(id2);
  
  if (!parsed1 || !parsed2) return 0;
  
  // Different chats - compare chat IDs lexicographically
  if (parsed1.chatId !== parsed2.chatId) {
    return parsed1.chatId < parsed2.chatId ? -1 : 1;
  }
  
  // Same chat - compare sequences
  return parsed1.sequence - parsed2.sequence;
}

/**
 * Session state for a single chat
 */
class ChatSession {
  constructor(chatId) {
    this.chatId = chatId;
    this.sequence = 0;
    this.idMap = new Map(); // Maps generated IDs to entity metadata
    this.linkMap = new Map(); // Maps entity IDs to their parent IDs
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
  }
  
  /**
   * Generate next ID in sequence
   * @param {string} type - ID type suffix
   * @param {string} parentId - Optional parent entity ID for linking
   * @returns {string} Generated ID
   */
  nextId(type, parentId = null) {
    this.sequence++;
    this.lastActivity = Date.now();
    
    // Format: chatId_sequence_type
    const seqStr = String(this.sequence).padStart(6, '0');
    const id = `${this.chatId}_${seqStr}_${type}`;
    
    // Store metadata
    this.idMap.set(id, {
      sequence: this.sequence,
      type,
      parentId,
      createdAt: Date.now(),
    });
    
    // Store parent link
    if (parentId) {
      this.linkMap.set(id, parentId);
    }
    
    return id;
  }
  
  /**
   * Get parent ID for an entity
   * @param {string} id - Entity ID
   * @returns {string | null} Parent ID
   */
  getParent(id) {
    return this.linkMap.get(id) || null;
  }
  
  /**
   * Get all children of an entity
   * @param {string} parentId - Parent entity ID
   * @returns {string[]} Array of child IDs
   */
  getChildren(parentId) {
    const children = [];
    for (const [childId, pid] of this.linkMap.entries()) {
      if (pid === parentId) {
        children.push(childId);
      }
    }
    return children.sort(compareSessionIds);
  }
  
  /**
   * Get entity metadata
   * @param {string} id - Entity ID
   * @returns {object | null} Metadata
   */
  getMetadata(id) {
    return this.idMap.get(id) || null;
  }
  
  /**
   * Get full entity tree (parent and all descendants)
   * @param {string} rootId - Root entity ID
   * @returns {object} Tree structure
   */
  getTree(rootId) {
    const metadata = this.getMetadata(rootId);
    if (!metadata) return null;
    
    const children = this.getChildren(rootId).map(childId => this.getTree(childId));
    
    return {
      id: rootId,
      ...metadata,
      children,
    };
  }
  
  /**
   * Get current sequence number
   * @returns {number}
   */
  getCurrentSequence() {
    return this.sequence;
  }
  
  /**
   * Get session statistics
   * @returns {object}
   */
  getStats() {
    const typeCount = {};
    for (const [_, metadata] of this.idMap) {
      typeCount[metadata.type] = (typeCount[metadata.type] || 0) + 1;
    }
    
    return {
      chatId: this.chatId,
      totalEntities: this.idMap.size,
      currentSequence: this.sequence,
      typeCount,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      age: Date.now() - this.createdAt,
    };
  }
}

/**
 * Global session manager
 */
class SessionManager extends EventEmitter {
  constructor() {
    super();
    
    this.sessions = new Map(); // Maps chat IDs to ChatSession instances
    this.currentChatId = null;
  }
  
  /**
   * Create or get existing session
   * @param {string} chatId - Chat UUID
   * @returns {ChatSession}
   */
  getSession(chatId) {
    if (!chatId) {
      throw new Error('[SessionManager] Chat ID required');
    }
    
    if (!this.sessions.has(chatId)) {
      const session = new ChatSession(chatId);
      this.sessions.set(chatId, session);
      this.emit('session:created', { chatId });
      console.log(`[SessionManager] Created session: ${chatId}`);
    }
    
    return this.sessions.get(chatId);
  }
  
  /**
   * Set active chat session
   * @param {string} chatId - Chat UUID
   */
  setActiveChat(chatId) {
    this.currentChatId = chatId;
    this.emit('session:active', { chatId });
    console.log(`[SessionManager] Active session: ${chatId}`);
  }
  
  /**
   * Get current active session
   * @returns {ChatSession | null}
   */
  getActiveSession() {
    if (!this.currentChatId) return null;
    return this.getSession(this.currentChatId);
  }
  
  /**
   * Generate ID in active session
   * @param {string} type - ID type suffix
   * @param {string} parentId - Optional parent ID
   * @returns {string} Generated ID
   */
  nextId(type, parentId = null) {
    const session = this.getActiveSession();
    if (!session) {
      throw new Error('[SessionManager] No active chat session');
    }
    
    const id = session.nextId(type, parentId);
    this.emit('id:generated', { chatId: session.chatId, id, type, parentId });
    
    return id;
  }
  
  /**
   * Generate user message ID
   * @returns {string}
   */
  nextUserMessageId() {
    return this.nextId(ID_TYPES.USER_MESSAGE);
  }
  
  /**
   * Generate assistant message ID
   * @param {string} userMessageId - Parent user message ID
   * @returns {string}
   */
  nextAssistantMessageId(userMessageId = null) {
    return this.nextId(ID_TYPES.ASSISTANT_MESSAGE, userMessageId);
  }
  
  /**
   * Generate code artifact ID
   * @param {string} parentMessageId - Parent message ID
   * @returns {string}
   */
  nextCodeArtifactId(parentMessageId) {
    return this.nextId(ID_TYPES.ASSISTANT_CODE, parentMessageId);
  }
  
  /**
   * Generate output artifact ID
   * @param {string} parentCodeId - Parent code artifact ID
   * @returns {string}
   */
  nextOutputArtifactId(parentCodeId) {
    return this.nextId(ID_TYPES.ASSISTANT_OUTPUT, parentCodeId);
  }
  
  /**
   * Generate HTML artifact ID
   * @param {string} parentMessageId - Parent message ID
   * @returns {string}
   */
  nextHtmlArtifactId(parentMessageId) {
    return this.nextId(ID_TYPES.ASSISTANT_HTML, parentMessageId);
  }
  
  /**
   * Generate attachment ID
   * @param {string} userMessageId - Parent user message ID
   * @returns {string}
   */
  nextAttachmentId(userMessageId) {
    return this.nextId(ID_TYPES.USER_ATTACHMENT, userMessageId);
  }
  
  /**
   * Parse ID into components
   * @param {string} id - Session ID
   * @returns {object | null}
   */
  parseId(id) {
    return parseSessionId(id);
  }
  
  /**
   * Compare two IDs
   * @param {string} id1 - First ID
   * @param {string} id2 - Second ID
   * @returns {number}
   */
  compareIds(id1, id2) {
    return compareSessionIds(id1, id2);
  }
  
  /**
   * Get parent ID
   * @param {string} id - Entity ID
   * @returns {string | null}
   */
  getParent(id) {
    const parsed = parseSessionId(id);
    if (!parsed) return null;
    
    const session = this.sessions.get(parsed.chatId);
    if (!session) return null;
    
    return session.getParent(id);
  }
  
  /**
   * Get children IDs
   * @param {string} parentId - Parent entity ID
   * @returns {string[]}
   */
  getChildren(parentId) {
    const parsed = parseSessionId(parentId);
    if (!parsed) return [];
    
    const session = this.sessions.get(parsed.chatId);
    if (!session) return [];
    
    return session.getChildren(parentId);
  }
  
  /**
   * Get entity tree
   * @param {string} rootId - Root entity ID
   * @returns {object | null}
   */
  getTree(rootId) {
    const parsed = parseSessionId(rootId);
    if (!parsed) return null;
    
    const session = this.sessions.get(parsed.chatId);
    if (!session) return null;
    
    return session.getTree(rootId);
  }
  
  /**
   * Clear session (for cleanup/logout)
   * @param {string} chatId - Chat UUID
   */
  clearSession(chatId) {
    if (this.sessions.has(chatId)) {
      this.sessions.delete(chatId);
      this.emit('session:cleared', { chatId });
      console.log(`[SessionManager] Cleared session: ${chatId}`);
    }
    
    if (this.currentChatId === chatId) {
      this.currentChatId = null;
    }
  }
  
  /**
   * Clear all sessions
   */
  clearAll() {
    this.sessions.clear();
    this.currentChatId = null;
    this.emit('session:cleared:all');
    console.log('[SessionManager] Cleared all sessions');
  }
  
  /**
   * Get all active session IDs
   * @returns {string[]}
   */
  getActiveSessions() {
    return Array.from(this.sessions.keys());
  }
  
  /**
   * Get session statistics
   * @param {string} chatId - Chat UUID
   * @returns {object | null}
   */
  getSessionStats(chatId) {
    const session = this.sessions.get(chatId);
    return session ? session.getStats() : null;
  }
  
  /**
   * Get all statistics
   * @returns {object}
   */
  getAllStats() {
    const stats = {};
    for (const [chatId, session] of this.sessions) {
      stats[chatId] = session.getStats();
    }
    return stats;
  }
  
  /**
   * Export session data for persistence/debugging
   * @param {string} chatId - Chat UUID
   * @returns {object | null}
   */
  exportSession(chatId) {
    const session = this.sessions.get(chatId);
    if (!session) return null;
    
    return {
      chatId: session.chatId,
      sequence: session.sequence,
      entities: Array.from(session.idMap.entries()).map(([id, metadata]) => ({
        id,
        ...metadata,
        parent: session.getParent(id),
        children: session.getChildren(id),
      })),
      stats: session.getStats(),
    };
  }
}

// Singleton instance
const sessionManager = new SessionManager();

// Export
module.exports = {
  SessionManager,
  sessionManager,
  ID_TYPES,
  parseSessionId,
  compareSessionIds,
};

if (typeof window !== 'undefined') {
  window.SessionManager = SessionManager;
  window.sessionManager = sessionManager;
  window.ID_TYPES = ID_TYPES;
  console.log('📦 SessionManager loaded');
}

