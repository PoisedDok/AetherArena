/**
 * @.architecture
 *
 * Incoming: ChatService.createChat(), ChatRepository.save() (validation calls) --- {chat_types.*, any}
 * Processing: Validate chat schema (id/title/timestamps/messages/artifactIds), validate title (max 200 chars/no control chars), validate ID format (chat_timestamp_random or UUID), validate metadata JSON-serializability and size (max 10KB), validate timestamp consistency (updatedAt ≥ createdAt) --- {2 jobs: JOB_PARSE_JSON, JOB_VALIDATE_SCHEMA}
 * Outgoing: Return {valid, errors} object --- {validation_result_types.*, {valid:boolean, errors:string[]}}
 *
 *
 * @module domain/chat/validators/ChatValidator
 */

/**
 * ChatValidator.js
 * Validates chat data structures and metadata
 */

class ChatValidator {
  constructor(config = {}) {
    this.maxTitleLength = config.maxTitleLength || 200;
    this.maxMetadataSize = config.maxMetadataSize || 10000; // 10KB
  }

  /**
   * Validate chat structure
   */
  validate(chat) {
    const errors = [];

    // Null/undefined check
    if (!chat) {
      errors.push('Chat cannot be null or undefined');
      return { valid: false, errors };
    }

    // Type check
    if (typeof chat !== 'object') {
      errors.push('Chat must be an object');
      return { valid: false, errors };
    }

    // ID validation
    if (chat.id !== undefined && chat.id !== null && typeof chat.id !== 'string') {
      errors.push('Chat ID must be a string');
    }

    // Title validation
    if (chat.title === undefined || chat.title === null) {
      errors.push('Chat must have a title');
    } else if (typeof chat.title !== 'string') {
      errors.push('Chat title must be a string');
    } else if (chat.title.length === 0) {
      errors.push('Chat title cannot be empty');
    } else if (chat.title.length > this.maxTitleLength) {
      errors.push(`Chat title exceeds maximum length of ${this.maxTitleLength} characters`);
    }

    // Messages validation
    if (chat.messages !== undefined) {
      if (!Array.isArray(chat.messages)) {
        errors.push('Chat messages must be an array');
      }
    }

    // Metadata validation
    if (chat.metadata !== undefined) {
      if (typeof chat.metadata !== 'object' || chat.metadata === null) {
        errors.push('Chat metadata must be an object');
      } else {
        try {
          const metadataStr = JSON.stringify(chat.metadata);
          if (metadataStr.length > this.maxMetadataSize) {
            errors.push(`Chat metadata exceeds maximum size of ${this.maxMetadataSize} bytes`);
          }
        } catch (e) {
          errors.push('Chat metadata must be JSON-serializable');
        }
      }
    }

    // Timestamp validation
    if (chat.createdAt !== undefined) {
      if (typeof chat.createdAt !== 'number') {
        errors.push('Chat createdAt must be a number');
      } else if (chat.createdAt < 0) {
        errors.push('Chat createdAt cannot be negative');
      }
    }

    if (chat.updatedAt !== undefined) {
      if (typeof chat.updatedAt !== 'number') {
        errors.push('Chat updatedAt must be a number');
      } else if (chat.updatedAt < 0) {
        errors.push('Chat updatedAt cannot be negative');
      }
    }

    // Timestamp consistency
    if (chat.createdAt !== undefined && chat.updatedAt !== undefined) {
      if (chat.updatedAt < chat.createdAt) {
        errors.push('Chat updatedAt cannot be earlier than createdAt');
      }
    }

    // Session ID validation
    if (chat.sessionId !== undefined && chat.sessionId !== null && typeof chat.sessionId !== 'string') {
      errors.push('Chat sessionId must be a string');
    }

    // Artifact IDs validation
    if (chat.artifactIds !== undefined) {
      if (!Array.isArray(chat.artifactIds)) {
        errors.push('Chat artifactIds must be an array');
      } else {
        const invalidArtifacts = chat.artifactIds.filter(id => typeof id !== 'string');
        if (invalidArtifacts.length > 0) {
          errors.push('All artifact IDs must be strings');
        }
      }
    }

    // Boolean flags validation
    if (chat.isActive !== undefined && typeof chat.isActive !== 'boolean') {
      errors.push('Chat isActive must be a boolean');
    }

    if (chat.isArchived !== undefined && typeof chat.isArchived !== 'boolean') {
      errors.push('Chat isArchived must be a boolean');
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }

  /**
   * Validate chat title only
   */
  validateTitle(title) {
    const errors = [];

    if (title === null || title === undefined) {
      errors.push('Title is required');
      return { valid: false, errors };
    }

    if (typeof title !== 'string') {
      errors.push('Title must be a string');
      return { valid: false, errors };
    }

    if (title.length === 0) {
      errors.push('Title cannot be empty');
    }

    if (title.length > this.maxTitleLength) {
      errors.push(`Title exceeds maximum length of ${this.maxTitleLength} characters`);
    }

    // Check for invalid characters
    if (/[\x00-\x1F\x7F]/.test(title)) {
      errors.push('Title contains invalid control characters');
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }

  /**
   * Validate chat ID format
   */
  validateId(id) {
    if (!id) {
      return { valid: false, errors: ['ID is required'] };
    }

    if (typeof id !== 'string') {
      return { valid: false, errors: ['ID must be a string'] };
    }

    // Check ID format (chat_timestamp_random or UUID)
    const chatIdPattern = /^chat_\d+_[a-z0-9]+$/;
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    
    if (!chatIdPattern.test(id) && !uuidPattern.test(id)) {
      return {
        valid: false,
        errors: ['ID must be in format chat_timestamp_random or UUID']
      };
    }

    return { valid: true };
  }

  /**
   * Validate metadata object
   */
  validateMetadata(metadata) {
    const errors = [];

    if (!metadata) {
      return { valid: true }; // Metadata is optional
    }

    if (typeof metadata !== 'object' || metadata === null) {
      errors.push('Metadata must be an object');
      return { valid: false, errors };
    }

    // Check if serializable
    try {
      const metadataStr = JSON.stringify(metadata);
      if (metadataStr.length > this.maxMetadataSize) {
        errors.push(`Metadata exceeds maximum size of ${this.maxMetadataSize} bytes`);
      }
    } catch (e) {
      errors.push('Metadata must be JSON-serializable');
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }

  /**
   * Validate and throw if invalid
   */
  validateOrThrow(chat) {
    const result = this.validate(chat);
    if (!result.valid) {
      throw new Error(`Chat validation failed: ${result.errors.join(', ')}`);
    }
    return true;
  }

  /**
   * Validate title and throw if invalid
   */
  validateTitleOrThrow(title) {
    const result = this.validateTitle(title);
    if (!result.valid) {
      throw new Error(`Title validation failed: ${result.errors.join(', ')}`);
    }
    return true;
  }

  /**
   * Validate ID and throw if invalid
   */
  validateIdOrThrow(id) {
    const result = this.validateId(id);
    if (!result.valid) {
      throw new Error(`ID validation failed: ${result.errors.join(', ')}`);
    }
    return true;
  }

  /**
   * Validate metadata and throw if invalid
   */
  validateMetadataOrThrow(metadata) {
    const result = this.validateMetadata(metadata);
    if (!result.valid) {
      throw new Error(`Metadata validation failed: ${result.errors.join(', ')}`);
    }
    return true;
  }
}

module.exports = { ChatValidator };

