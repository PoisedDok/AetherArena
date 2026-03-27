/**
 * @.architecture
 * 
 * Incoming: StreamHandler.js, MessageRepository.js, PostgreSQL queries --- {message_types.*, json | database_types.message_record, json}
 * Processing: Normalize fields, serialize for storage, add artifact references, update status --- {1 job: JOB_UPDATE_STATE}
 * Outgoing: MessageRepository.js, MessageView.js --- {message_types.*, json}
 * 
 * @module domain/chat/models/Message
 * 
 * Message.js
 * Domain model representing a single chat message
 * Pure data model with validation and transformation logic
 */

class Message {
  constructor(data = {}) {
    this.id = data.id || null;
    this.chatId = data.chatId || null;
    this.role = data.role || 'user'; // 'user' | 'assistant' | 'system'
    this.content = data.content || '';
    this.timestamp = data.timestamp || Date.now();
    this.correlationId = data.correlationId || null;
    this.parentMessageId = data.parentMessageId || null;
    this.artifactIds = Array.isArray(data.artifactIds) ? [...data.artifactIds] : [];
    this.metadata = data.metadata ? { ...data.metadata } : {};
    this.status = data.status || 'pending'; // 'pending' | 'sent' | 'streaming' | 'complete' | 'error'
    
    // Additional metadata fields from PostgreSQL schema
    this.llmModel = data.llmModel || data.llm_model || null;
    this.llmProvider = data.llmProvider || data.llm_provider || null;
    this.tokensUsed = data.tokensUsed || data.tokens_used || null;
    this.createdAt = data.createdAt || data.created_at || this.timestamp;
  }

  /**
   * Add artifact reference to this message
   */
  addArtifact(artifactId) {
    if (!artifactId || typeof artifactId !== 'string') {
      throw new Error('Artifact ID must be a non-empty string');
    }
    if (!this.artifactIds.includes(artifactId)) {
      this.artifactIds.push(artifactId);
    }
  }

  /**
   * Remove artifact reference
   */
  removeArtifact(artifactId) {
    const index = this.artifactIds.indexOf(artifactId);
    if (index > -1) {
      this.artifactIds.splice(index, 1);
    }
  }

  /**
   * Check if message has specific artifact
   */
  hasArtifact(artifactId) {
    return this.artifactIds.includes(artifactId);
  }

  /**
   * Update message status
   */
  setStatus(status) {
    const validStatuses = ['pending', 'sent', 'streaming', 'complete', 'error'];
    if (!validStatuses.includes(status)) {
      throw new Error(`Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}`);
    }
    this.status = status;
  }

  /**
   * Check if message is from user
   */
  isUser() {
    return this.role === 'user';
  }

  /**
   * Check if message is from assistant
   */
  isAssistant() {
    return this.role === 'assistant';
  }

  /**
   * Check if message is system message
   */
  isSystem() {
    return this.role === 'system';
  }

  /**
   * Check if message is complete
   */
  isComplete() {
    return this.status === 'complete';
  }

  /**
   * Check if message is streaming
   */
  isStreaming() {
    return this.status === 'streaming';
  }

  /**
   * Check if message has error
   */
  hasError() {
    return this.status === 'error';
  }

  /**
   * Get message length in characters
   */
  getLength() {
    return this.content.length;
  }

  /**
   * Get message age in milliseconds
   */
  getAge() {
    const messageTime = typeof this.timestamp === 'string' 
      ? new Date(this.timestamp).getTime() 
      : this.timestamp;
    return Date.now() - messageTime;
  }

  /**
   * Clone message with optional overrides
   */
  clone(overrides = {}) {
    return new Message({
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
      chatId: this.chatId,
      role: this.role,
      content: this.content,
      timestamp: this.timestamp,
      correlationId: this.correlationId,
      parentMessageId: this.parentMessageId,
      artifactIds: [...this.artifactIds],
      metadata: { ...this.metadata },
      status: this.status,
      llmModel: this.llmModel,
      llmProvider: this.llmProvider,
      tokensUsed: this.tokensUsed,
      createdAt: this.createdAt
    };
  }

  /**
   * Serialize to PostgreSQL schema format
   */
  toPostgresFormat() {
    return {
      id: this.id,
      role: this.role,
      content: this.content,
      llm_model: this.llmModel,
      llm_provider: this.llmProvider,
      tokens_used: this.tokensUsed,
      correlation_id: this.correlationId,
      timestamp: this.timestamp
    };
  }

  /**
   * Create from stored object
   */
  static fromJSON(data) {
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid data: must be an object');
    }
    return new Message(data);
  }

  /**
   * Create from PostgreSQL row
   */
  static fromPostgresRow(row) {
    if (!row || typeof row !== 'object') {
      throw new Error('Invalid row: must be an object');
    }
    
    return new Message({
      id: row.id,
      chatId: row.chat_id,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp || row.created_at,
      correlationId: row.correlation_id,
      llmModel: row.llm_model,
      llmProvider: row.llm_provider,
      tokensUsed: row.tokens_used,
      createdAt: row.created_at,
      status: row.status || 'complete',
      metadata: row.metadata || {}
    });
  }

  /**
   * Generate unique message ID
   */
  static generateId() {
    if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.randomUUID) {
      throw new Error('[Message] CONTRACT VIOLATION: crypto.randomUUID is required for message ID generation.');
    }
    return `msg_${globalThis.crypto.randomUUID()}`;
  }

  /**
   * Generate correlation ID for request-response pairing
   */
  static generateCorrelationId() {
    if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.randomUUID) {
      throw new Error('[Message] CONTRACT VIOLATION: crypto.randomUUID is required for correlation ID generation.');
    }
    return `corr_${globalThis.crypto.randomUUID()}`;
  }

  /**
   * Create user message
   */
  static createUser(content, chatId = null) {
    return new Message({
      id: Message.generateId(),
      chatId,
      role: 'user',
      content,
      timestamp: Date.now(),
      status: 'pending'
    });
  }

  /**
   * Create assistant message
   */
  static createAssistant(content, chatId = null, correlationId = null) {
    return new Message({
      id: Message.generateId(),
      chatId,
      role: 'assistant',
      content,
      timestamp: Date.now(),
      correlationId,
      status: 'streaming'
    });
  }

  /**
   * Create system message
   */
  static createSystem(content, chatId = null) {
    return new Message({
      id: Message.generateId(),
      chatId,
      role: 'system',
      content,
      timestamp: Date.now(),
      status: 'complete'
    });
  }
}

module.exports = { Message };
