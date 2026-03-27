/**
 * @.architecture
 *
 * Incoming: MessageState.loadChat(), ChatRepository.findById() (JSON or PostgreSQL row) --- {database_types.chat_record | json, object}
 * Processing: Immutable chat container model - stores messages array (Message instances), title/metadata management, artifact tracking (artifactIds), session linkage (sessionId), lifecycle methods (add/remove/get messages, archive/unarchive), token counting, factory methods (from JSON/PostgreSQL/create) --- {4 jobs: JOB_VALIDATE_SCHEMA, JOB_TRACK_ENTITY, JOB_UPDATE_STATE, JOB_GENERATE_SESSION_ID}
 * Outgoing: Export frozen chat instance or JSON/PostgreSQL formatted data --- {chat_types.*, Chat}
 *
 *
 * @module domain/chat/models/Chat
 */

/**
 * Chat.js
 * Domain model representing a chat conversation container
 * Manages chat metadata and message collection
 */

const { Message } = require('./Message');

class Chat {
  constructor(data = {}) {
    this.id = data.id || null;
    this.title = data.title || 'New Chat';
    this.messages = Array.isArray(data.messages) 
      ? data.messages.map(m => m instanceof Message ? m : Message.fromJSON(m))
      : [];
    this.metadata = data.metadata ? { ...data.metadata } : {};
    this.createdAt = data.createdAt || data.created_at || Date.now();
    this.updatedAt = data.updatedAt || data.updated_at || this.createdAt;
    
    // Message count from backend (for list views without loading all messages)
    this.messageCount = data.messageCount !== undefined ? data.messageCount : 
                        data.message_count !== undefined ? data.message_count :
                        this.messages.length;
    
    // Session tracking
    this.sessionId = data.sessionId || null;
    this.artifactIds = Array.isArray(data.artifactIds) ? [...data.artifactIds] : [];
    
    // Status
    this.isActive = data.isActive !== undefined ? data.isActive : true;
    this.isArchived = data.isArchived || false;
  }

  /**
   * Add message to chat
   */
  addMessage(message) {
    if (!(message instanceof Message)) {
      throw new Error('Message must be an instance of Message class');
    }
    
    // Set chat ID on message if not set
    if (!message.chatId) {
      message.chatId = this.id;
    }
    
    // Verify message belongs to this chat
    if (message.chatId !== this.id) {
      throw new Error(`Message chatId (${message.chatId}) does not match Chat id (${this.id})`);
    }
    
    this.messages.push(message);
    this.touch();
  }

  /**
   * Remove message from chat
   */
  removeMessage(messageId) {
    const index = this.messages.findIndex(m => m.id === messageId);
    if (index > -1) {
      this.messages.splice(index, 1);
      this.touch();
      return true;
    }
    return false;
  }

  /**
   * Get message by ID
   */
  getMessage(messageId) {
    return this.messages.find(m => m.id === messageId) || null;
  }

  /**
   * Get all user messages
   */
  getUserMessages() {
    return this.messages.filter(m => m.isUser());
  }

  /**
   * Get all assistant messages
   */
  getAssistantMessages() {
    return this.messages.filter(m => m.isAssistant());
  }

  /**
   * Get last message
   */
  getLastMessage() {
    return this.messages.length > 0 ? this.messages[this.messages.length - 1] : null;
  }

  /**
   * Get last user message
   */
  getLastUserMessage() {
    const userMessages = this.getUserMessages();
    return userMessages.length > 0 ? userMessages[userMessages.length - 1] : null;
  }

  /**
   * Get last assistant message
   */
  getLastAssistantMessage() {
    const assistantMessages = this.getAssistantMessages();
    return assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1] : null;
  }

  /**
   * Get message count
   */
  getMessageCount() {
    return this.messages.length;
  }

  /**
   * Get total tokens used (sum of all messages)
   */
  getTotalTokens() {
    return this.messages.reduce((sum, m) => sum + (m.tokensUsed || 0), 0);
  }

  /**
   * Check if chat is empty
   */
  isEmpty() {
    return this.messages.length === 0;
  }

  /**
   * Check if chat has user messages
   */
  hasUserMessages() {
    return this.messages.some(m => m.isUser());
  }

  /**
   * Update chat title
   */
  setTitle(title) {
    if (!title || typeof title !== 'string') {
      throw new Error('Title must be a non-empty string');
    }
    this.title = title;
    this.touch();
  }

  /**
   * Update metadata
   */
  setMetadata(key, value) {
    this.metadata[key] = value;
    this.touch();
  }

  /**
   * Get metadata value
   */
  getMetadata(key, defaultValue = null) {
    return key in this.metadata ? this.metadata[key] : defaultValue;
  }

  /**
   * Register artifact
   */
  addArtifact(artifactId) {
    if (!artifactId || typeof artifactId !== 'string') {
      throw new Error('Artifact ID must be a non-empty string');
    }
    if (!this.artifactIds.includes(artifactId)) {
      this.artifactIds.push(artifactId);
      this.touch();
    }
  }

  /**
   * Remove artifact
   */
  removeArtifact(artifactId) {
    const index = this.artifactIds.indexOf(artifactId);
    if (index > -1) {
      this.artifactIds.splice(index, 1);
      this.touch();
      return true;
    }
    return false;
  }

  /**
   * Check if chat has artifact
   */
  hasArtifact(artifactId) {
    return this.artifactIds.includes(artifactId);
  }

  /**
   * Archive chat
   */
  archive() {
    this.isArchived = true;
    this.isActive = false;
    this.touch();
  }

  /**
   * Unarchive chat
   */
  unarchive() {
    this.isArchived = false;
    this.isActive = true;
    this.touch();
  }

  /**
   * Clear all messages
   */
  clearMessages() {
    this.messages = [];
    this.touch();
  }

  /**
   * Update timestamp
   */
  touch() {
    this.updatedAt = Date.now();
  }

  /**
   * Get chat age in milliseconds
   */
  getAge() {
    return Date.now() - this.createdAt;
  }

  /**
   * Get time since last update
   */
  getTimeSinceUpdate() {
    return Date.now() - this.updatedAt;
  }

  /**
   * Clone chat with optional overrides
   */
  clone(overrides = {}) {
    return new Chat({
      ...this.toJSON(),
      ...overrides
    });
  }

  /**
   * Serialize to plain object for storage/transmission
   */
  toJSON() {
    return {
      id: this.id,
      title: this.title,
      messages: this.messages.map(m => m.toJSON()),
      messageCount: this.messageCount,
      metadata: { ...this.metadata },
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      sessionId: this.sessionId,
      artifactIds: [...this.artifactIds],
      isActive: this.isActive,
      isArchived: this.isArchived
    };
  }

  /**
   * Serialize to PostgreSQL schema format (without messages)
   */
  toPostgresFormat() {
    return {
      id: this.id,
      title: this.title,
      created_at: this.createdAt,
      updated_at: this.updatedAt
    };
  }

  /**
   * Create from stored object
   */
  static fromJSON(data) {
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid data: must be an object');
    }
    return new Chat(data);
  }

  /**
   * Create from PostgreSQL row
   */
  static fromPostgresRow(row, messages = []) {
    if (!row || typeof row !== 'object') {
      throw new Error('Invalid row: must be an object');
    }
    
    return new Chat({
      id: row.id,
      title: row.title,
      messages: messages,
      messageCount: row.message_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      isArchived: row.archived || false,
      metadata: row.metadata || {}
    });
  }

  /**
   * Generate unique chat ID
   */
  static _generateUuid() {
    if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.randomUUID) {
      throw new Error('[Chat] CONTRACT VIOLATION: crypto.randomUUID is required for chat ID generation.');
    }
    return globalThis.crypto.randomUUID();
  }

  static generateId() {
    return Chat._generateUuid();
  }

  /**
   * Create new empty chat
   */
  static create(title = 'New Chat') {
    return new Chat({
      id: Chat.generateId(),
      title,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }
}

module.exports = { Chat };
