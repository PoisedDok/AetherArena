'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactService, MessageState (validation calls) --- {artifact_types.*, any}
 * Processing: Validate artifact schema (id/type/content/timestamp required), validate types (code/output/html/file), validate status (streaming/active/archived/deleted), validate message/chat IDs (UUID or temp format), validate content size (maxSize 10MB), validate metadata size (max 100KB), sanitize HTML content for safety --- {2 jobs: JOB_SANITIZE_MARKDOWN, JOB_VALIDATE_SCHEMA}
 * Outgoing: Return {valid, errors} object --- {validation_result_types.*, {valid:boolean, errors:string[]}}
 * 
 * 
 * @module domain/artifacts/validators/ArtifactValidator
 */

class ArtifactValidator {
  /**
   * Validate complete artifact object
   */
  static validate(artifact) {
    const errors = [];

    // Required fields
    if (!artifact || typeof artifact !== 'object') {
      return { valid: false, errors: ['Artifact must be an object'] };
    }

    if (!artifact.id || typeof artifact.id !== 'string') {
      errors.push('Artifact must have a string id');
    }

    if (!artifact.type || !this.isValidType(artifact.type)) {
      errors.push(`Artifact type must be one of: ${this.getValidTypes().join(', ')}`);
    }

    if (typeof artifact.content !== 'string') {
      errors.push('Artifact content must be a string');
    }

    if (!artifact.timestamp || typeof artifact.timestamp !== 'number') {
      errors.push('Artifact must have a numeric timestamp');
    }

    // Optional field validation
    if (artifact.sourceMessageId !== null && !this.isValidMessageId(artifact.sourceMessageId)) {
      errors.push('Source message ID must be a valid UUID or temporary ID');
    }

    if (artifact.chatId !== null && !this.isValidChatId(artifact.chatId)) {
      errors.push('Chat ID must be a valid UUID');
    }

    if (artifact.status && !this.isValidStatus(artifact.status)) {
      errors.push(`Status must be one of: ${this.getValidStatuses().join(', ')}`);
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Validate artifact type
   */
  static isValidType(type) {
    return ['code', 'output', 'html', 'file'].includes(type);
  }

  /**
   * Get valid artifact types
   */
  static getValidTypes() {
    return ['code', 'output', 'html', 'file'];
  }

  /**
   * Validate artifact status
   */
  static isValidStatus(status) {
    return ['streaming', 'active', 'archived', 'deleted'].includes(status);
  }

  /**
   * Get valid artifact statuses
   */
  static getValidStatuses() {
    return ['streaming', 'active', 'archived', 'deleted'];
  }

  /**
   * Validate message ID (UUID or temporary format)
   */
  static isValidMessageId(messageId) {
    if (typeof messageId !== 'string') return false;
    
    // Allow temporary IDs (msg_*)
    if (messageId.startsWith('msg_')) return true;
    
    // Allow PostgreSQL UUIDs
    return this.isValidUUID(messageId);
  }

  /**
   * Validate chat ID (must be UUID)
   */
  static isValidChatId(chatId) {
    if (typeof chatId !== 'string') return false;
    
    // Only allow PostgreSQL UUIDs for chat IDs
    return this.isValidUUID(chatId);
  }

  /**
   * Validate UUID format
   */
  static isValidUUID(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
  }

  /**
   * Validate artifact content
   */
  static validateContent(content, options = {}) {
    const errors = [];
    const maxSize = options.maxSize || 10 * 1024 * 1024; // 10MB default
    const allowEmpty = options.allowEmpty !== false;

    if (typeof content !== 'string') {
      errors.push('Content must be a string');
      return { valid: false, errors };
    }

    if (!allowEmpty && content.trim().length === 0) {
      errors.push('Content cannot be empty');
    }

    if (content.length > maxSize) {
      errors.push(`Content exceeds maximum size of ${maxSize} bytes`);
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Validate artifact for PostgreSQL persistence
   */
  static validateForPersistence(artifact) {
    const errors = [];

    // Must have valid chat ID
    if (!artifact.chatId || !this.isValidUUID(artifact.chatId)) {
      errors.push('Artifact must have valid chat UUID for persistence');
    }

    // Content must not be empty (unless output type)
    if (artifact.type !== 'output' && (!artifact.content || artifact.content.trim().length === 0)) {
      errors.push('Artifact content cannot be empty for persistence');
    }

    // Message ID must be UUID if present
    if (artifact.sourceMessageId && !this.isValidUUID(artifact.sourceMessageId)) {
      errors.push('Source message ID must be valid UUID for persistence (use null for temporary IDs)');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Validate artifact metadata
   */
  static validateMetadata(metadata) {
    const errors = [];

    if (metadata === null || metadata === undefined) {
      return { valid: true, errors: [] };
    }

    if (typeof metadata !== 'object') {
      errors.push('Metadata must be an object');
      return { valid: false, errors };
    }

    // Check metadata size
    try {
      const size = JSON.stringify(metadata).length;
      if (size > 100 * 1024) { // 100KB limit
        errors.push('Metadata exceeds 100KB size limit');
      }
    } catch (e) {
      errors.push('Metadata must be JSON-serializable');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Validate stream data for artifact creation
   */
  static validateStreamData(streamData) {
    const errors = [];

    if (!streamData || typeof streamData !== 'object') {
      return { valid: false, errors: ['Stream data must be an object'] };
    }

    if (!streamData.id || typeof streamData.id !== 'string') {
      errors.push('Stream data must have string id');
    }

    if (!streamData.kind || !this.isValidType(streamData.kind)) {
      errors.push('Stream data must have valid kind (type)');
    }

    if (!streamData.chatId || !this.isValidUUID(streamData.chatId)) {
      errors.push('Stream data must have valid chat UUID');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Sanitize artifact content for safe storage
   */
  static sanitizeContent(content, type) {
    if (typeof content !== 'string') return '';
    
    // For code/output, preserve as-is
    if (type === 'code' || type === 'output') {
      return content;
    }
    
    // For HTML, basic sanitization (detailed sanitization handled by security layer)
    if (type === 'html') {
      // Remove script tags
      let sanitized = content.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
      // Remove event handlers
      sanitized = sanitized.replace(/\s*on\w+\s*=\s*"[^"]*"/gi, '');
      sanitized = sanitized.replace(/\s*on\w+\s*=\s*'[^']*'/gi, '');
      return sanitized;
    }
    
    return content;
  }

  /**
   * Validate artifact file name
   */
  static validateFileName(fileName) {
    const errors = [];

    if (!fileName || typeof fileName !== 'string') {
      errors.push('File name must be a non-empty string');
      return { valid: false, errors };
    }

    // Check for invalid characters
    const invalidChars = /[<>:"|?*\x00-\x1F]/;
    if (invalidChars.test(fileName)) {
      errors.push('File name contains invalid characters');
    }

    // Check length
    if (fileName.length > 255) {
      errors.push('File name exceeds 255 characters');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}

module.exports = { ArtifactValidator };

