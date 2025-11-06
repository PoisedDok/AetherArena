/**
 * @.architecture
 *
 * Incoming: MessageService.createMessage(), MessageRepository.save() (validation calls) --- {message_types.*, any}
 * Processing: Validate message schema (content/role/ID/timestamps), track rate limit timestamps per chat (rateLimitMap), cleanup stale rate limit entries (cleanup timer), validate content size/role/status/relationships --- {5 jobs: JOB_CLEAR_STATE, JOB_DISPOSE, JOB_TRACK_ENTITY, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA}
 * Outgoing: Return {valid, errors} or {allowed, current, limit, resetIn} --- {validation_result_types.*, {valid:boolean, errors:string[]} | {allowed:boolean, limit:number}}
 *
 * @module domain/chat/validators/MessageValidator
 */

/**
 * MessageValidator.js
 * Validates message data structures and content
 * Pure validation logic extracted from SecurityManager
 */

class MessageValidator {
  constructor(config = {}) {
    this.maxMessageSize = config.maxMessageSize || 100000; // 100KB default
    this.maxMessagesPerMinute = config.maxMessagesPerMinute || 60;
    this.allowedRoles = ['user', 'assistant', 'system'];
    this.allowedStatuses = ['pending', 'sent', 'streaming', 'complete', 'error'];
    
    // Rate limiting state
    this.rateLimitMap = new Map();
    this.rateLimitCleanupInterval = 60000; // Clean up old entries every minute
    
    // Start cleanup timer
    this._startCleanup();
  }

  /**
   * Validate message structure and content
   */
  validate(message) {
    const errors = [];

    // Null/undefined check
    if (!message) {
      errors.push('Message cannot be null or undefined');
      return { valid: false, errors };
    }

    // Type check
    if (typeof message !== 'object') {
      errors.push('Message must be an object');
      return { valid: false, errors };
    }

    // Required fields
    if (message.content === null || message.content === undefined) {
      errors.push('Message must have a content field');
    }

    // Content type validation
    if (message.content !== undefined && typeof message.content !== 'string') {
      errors.push('Message content must be a string');
    }

    // Content empty validation
    if (typeof message.content === 'string' && message.content.trim().length === 0) {
      errors.push('Message content cannot be empty');
    }

    // Content size validation
    if (typeof message.content === 'string' && message.content.length > this.maxMessageSize) {
      errors.push(`Message content exceeds maximum size of ${this.maxMessageSize} characters`);
    }

    // Role validation - role is required
    if (!message.role) {
      errors.push('Message must have a role');
    } else if (!this.allowedRoles.includes(message.role)) {
      errors.push(`Invalid message role: ${message.role}. Allowed: ${this.allowedRoles.join(', ')}`);
    }

    // Status validation
    if (message.status && !this.allowedStatuses.includes(message.status)) {
      errors.push(`Invalid message status: ${message.status}. Allowed: ${this.allowedStatuses.join(', ')}`);
    }

    // ID validation
    if (message.id !== undefined && message.id !== null && typeof message.id !== 'string') {
      errors.push('Message ID must be a string');
    }

    // Chat ID validation
    if (message.chatId !== undefined && message.chatId !== null && typeof message.chatId !== 'string') {
      errors.push('Message chatId must be a string');
    }

    // Timestamp validation
    if (message.timestamp !== undefined) {
      if (typeof message.timestamp !== 'number') {
        errors.push('Message timestamp must be a number');
      } else if (message.timestamp < 0) {
        errors.push('Message timestamp cannot be negative');
      } else if (message.timestamp > Date.now() + 60000) {
        errors.push('Message timestamp cannot be in the future');
      }
    }

    // Correlation ID validation
    if (message.correlationId !== undefined && message.correlationId !== null) {
      if (typeof message.correlationId !== 'string') {
        errors.push('Message correlationId must be a string');
      }
    }

    // Parent message ID validation
    if (message.parentMessageId !== undefined && message.parentMessageId !== null) {
      if (typeof message.parentMessageId !== 'string') {
        errors.push('Message parentMessageId must be a string');
      }
    }

    // Artifact IDs validation
    if (message.artifactIds !== undefined) {
      if (!Array.isArray(message.artifactIds)) {
        errors.push('Message artifactIds must be an array');
      } else {
        const invalidArtifacts = message.artifactIds.filter(id => typeof id !== 'string');
        if (invalidArtifacts.length > 0) {
          errors.push('All artifact IDs must be strings');
        }
      }
    }

    // Metadata validation
    if (message.metadata !== undefined && typeof message.metadata !== 'object') {
      errors.push('Message metadata must be an object');
    }

    // LLM model validation
    if (message.llmModel !== undefined && message.llmModel !== null && typeof message.llmModel !== 'string') {
      errors.push('Message llmModel must be a string');
    }

    // LLM provider validation
    if (message.llmProvider !== undefined && message.llmProvider !== null && typeof message.llmProvider !== 'string') {
      errors.push('Message llmProvider must be a string');
    }

    // Tokens used validation
    if (message.tokensUsed !== undefined && message.tokensUsed !== null) {
      if (typeof message.tokensUsed !== 'number') {
        errors.push('Message tokensUsed must be a number');
      } else if (message.tokensUsed < 0) {
        errors.push('Message tokensUsed cannot be negative');
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }

  /**
   * Validate message content only
   */
  validateContent(content) {
    const errors = [];

    if (content === null || content === undefined) {
      errors.push('Content cannot be null or undefined');
      return { valid: false, errors };
    }

    if (typeof content !== 'string') {
      errors.push('Content must be a string');
      return { valid: false, errors };
    }

    if (content.length === 0) {
      errors.push('Content cannot be empty');
    }

    if (content.length > this.maxMessageSize) {
      errors.push(`Content exceeds maximum size of ${this.maxMessageSize} characters`);
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }

  /**
   * Validate message role
   */
  validateRole(role) {
    if (!role) {
      return { valid: false, errors: ['Role is required'] };
    }

    if (typeof role !== 'string') {
      return { valid: false, errors: ['Role must be a string'] };
    }

    if (!this.allowedRoles.includes(role)) {
      return {
        valid: false,
        errors: [`Invalid role: ${role}. Allowed: ${this.allowedRoles.join(', ')}`]
      };
    }

    return { valid: true };
  }

  /**
   * Validate message ID format
   */
  validateId(id) {
    if (!id) {
      return { valid: false, errors: ['ID is required'] };
    }

    if (typeof id !== 'string') {
      return { valid: false, errors: ['ID must be a string'] };
    }

    // Check ID format (msg_timestamp_random or UUID)
    const msgIdPattern = /^msg_\d+_[a-z0-9]+$/;
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    
    if (!msgIdPattern.test(id) && !uuidPattern.test(id)) {
      return {
        valid: false,
        errors: ['ID must be in format msg_timestamp_random or UUID']
      };
    }

    return { valid: true };
  }

  /**
   * Validate correlation ID format
   */
  validateCorrelationId(correlationId) {
    if (!correlationId) {
      return { valid: false, errors: ['Correlation ID is required'] };
    }

    if (typeof correlationId !== 'string') {
      return { valid: false, errors: ['Correlation ID must be a string'] };
    }

    // Check correlation ID format (corr_timestamp_random or UUID)
    const corrIdPattern = /^corr_\d+_[a-z0-9]+$/;
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    
    if (!corrIdPattern.test(correlationId) && !uuidPattern.test(correlationId)) {
      return {
        valid: false,
        errors: ['Correlation ID must be in format corr_timestamp_random or UUID']
      };
    }

    return { valid: true };
  }

  /**
   * Check rate limit for identifier (e.g., session ID)
   */
  checkRateLimit(identifier) {
    const now = Date.now();
    const window = 60000; // 1 minute window
    
    // Get or create rate limit entry
    let entry = this.rateLimitMap.get(identifier);
    if (!entry) {
      entry = { timestamps: [], firstRequest: now };
      this.rateLimitMap.set(identifier, entry);
    }

    // Remove timestamps outside the window
    entry.timestamps = entry.timestamps.filter(ts => now - ts < window);

    // Check if within limit
    if (entry.timestamps.length >= this.maxMessagesPerMinute) {
      const oldestTimestamp = entry.timestamps[0];
      const resetIn = window - (now - oldestTimestamp);
      
      return {
        allowed: false,
        current: entry.timestamps.length,
        limit: this.maxMessagesPerMinute,
        resetIn: Math.ceil(resetIn / 1000) // seconds
      };
    }

    // Add current timestamp
    entry.timestamps.push(now);
    this.rateLimitMap.set(identifier, entry);

    return {
      allowed: true,
      current: entry.timestamps.length,
      limit: this.maxMessagesPerMinute,
      remaining: this.maxMessagesPerMinute - entry.timestamps.length
    };
  }

  /**
   * Reset rate limit for identifier
   */
  resetRateLimit(identifier) {
    this.rateLimitMap.delete(identifier);
  }

  /**
   * Clear all rate limit entries
   */
  clearRateLimits() {
    this.rateLimitMap.clear();
  }

  /**
   * Start cleanup timer for old rate limit entries
   */
  _startCleanup() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
    }

    this._cleanupTimer = setInterval(() => {
      const now = Date.now();
      const window = 60000;
      
      for (const [identifier, entry] of this.rateLimitMap.entries()) {
        // Remove entries with no recent activity
        entry.timestamps = entry.timestamps.filter(ts => now - ts < window);
        
        if (entry.timestamps.length === 0) {
          this.rateLimitMap.delete(identifier);
        }
      }
    }, this.rateLimitCleanupInterval);
  }

  /**
   * Stop cleanup timer
   */
  destroy() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    this.rateLimitMap.clear();
  }

  /**
   * Validate message and throw if invalid
   */
  validateOrThrow(message) {
    const result = this.validate(message);
    if (!result.valid) {
      throw new Error(`Message validation failed: ${result.errors.join(', ')}`);
    }
    return true;
  }

  /**
   * Validate content and throw if invalid
   */
  validateContentOrThrow(content) {
    const result = this.validateContent(content);
    if (!result.valid) {
      throw new Error(`Content validation failed: ${result.errors.join(', ')}`);
    }
    return true;
  }

  /**
   * Validate role and throw if invalid
   */
  validateRoleOrThrow(role) {
    const result = this.validateRole(role);
    if (!result.valid) {
      throw new Error(`Role validation failed: ${result.errors.join(', ')}`);
    }
    return true;
  }

  /**
   * Check rate limit and throw if exceeded
   */
  checkRateLimitOrThrow(identifier) {
    const result = this.checkRateLimit(identifier);
    if (!result.allowed) {
      throw new Error(
        `Rate limit exceeded: ${result.current}/${result.limit} messages per minute. ` +
        `Resets in ${result.resetIn} seconds.`
      );
    }
    return result;
  }
}

module.exports = { MessageValidator };

