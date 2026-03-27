/**
 * @.architecture
 *
 * Incoming: ChatService, ChatView (XSS sanitization requests) --- {chat_title, string}
 * Processing: Escape title/metadata for XSS using basic escaping --- {1 job: JOB_ESCAPE_HTML}
 * Outgoing: Sanitized content safe for DOM rendering --- {sanitized_content, string}
 *
 * ARCHITECTURE NOTE:
 * Backend owns ALL validation (title length, ID formats, metadata size, types, timestamps).
 * Frontend ONLY sanitizes for XSS security. Trust backend-validated data.
 *
 * @module domain/chat/validators/ChatValidator
 */

'use strict';

const { createLogger } = require('../../../core/utils/logger');

const log = createLogger({ component: 'ChatValidator' });

/**
 * ChatValidator
 * 
 * XSS sanitization only. All business logic validation removed per architecture.
 * Backend validates: title length, ID formats, metadata size, types, timestamps, etc.
 * 
 * Lightweight wrapper for XSS protection on user-provided chat data.
 */
class ChatValidator {
  constructor(config = {}) {
    // Configuration kept for backward compatibility but not used for validation
  }

  /**
   * Sanitize chat title for XSS
   * ARCHITECTURE: Backend already validated - frontend just sanitizes for security
   * @param {string} title - Chat title
   * @returns {string} - Sanitized title
   */
  sanitizeTitle(title) {
    if (!title || typeof title !== 'string') {
      return '';
    }
    
    return this._escapeHTML(title);
  }

  /**
   * Sanitize metadata string values for XSS
   * ARCHITECTURE: Backend already validated - frontend just sanitizes for security
   * @param {Object} metadata - Metadata object
   * @returns {Object} - Metadata with sanitized string values
   */
  sanitizeMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object') {
      return {};
    }

    const sanitized = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value === 'string') {
        sanitized[key] = this._escapeHTML(value);
      } else {
        sanitized[key] = value;
      }
    }
    
    return sanitized;
  }

  /**
   * Basic HTML escape for XSS protection
   * @private
   */
  _escapeHTML(text) {
    if (!text || typeof text !== 'string') {
      return '';
    }

    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#x27;',
      '/': '&#x2F;',
    };

    return text.replace(/[&<>"'/]/g, (char) => map[char]);
  }

  /**
   * Legacy compatibility: validate method now just returns success
   * ARCHITECTURE: Backend owns validation - frontend trusts backend
   * @deprecated Use backend validation only
   */
  validate(chat) {
    log.warn('validate() is deprecated - backend owns ALL validation');
    return { valid: true };
  }

  /**
   * Legacy compatibility: validateTitle now just sanitizes
   * ARCHITECTURE: Backend owns validation - frontend only sanitizes
   * @deprecated Use sanitizeTitle() for XSS protection
   */
  validateTitle(title) {
    log.warn('validateTitle() is deprecated - use sanitizeTitle() for XSS only');
    return { valid: true };
  }

  /**
   * Legacy compatibility: validateId removed
   * ARCHITECTURE: Backend owns ID validation
   * @deprecated Backend validates IDs
   */
  validateId(id) {
    log.warn('validateId() is deprecated - backend owns ID validation');
    return { valid: true };
  }

  /**
   * Legacy compatibility: validateMetadata removed
   * ARCHITECTURE: Backend owns metadata validation
   * @deprecated Backend validates metadata
   */
  validateMetadata(metadata) {
    log.warn('validateMetadata() is deprecated - backend owns validation');
    return { valid: true };
  }

  /**
   * Legacy compatibility: validateOrThrow removed
   * @deprecated Backend owns validation
   */
  validateOrThrow(chat) {
    log.warn('validateOrThrow() is deprecated - backend owns validation');
    return true;
  }

  /**
   * Legacy compatibility: validateTitleOrThrow removed
   * @deprecated Backend owns validation
   */
  validateTitleOrThrow(title) {
    log.warn('validateTitleOrThrow() is deprecated - backend owns validation');
    return true;
  }

  /**
   * Legacy compatibility: validateIdOrThrow removed
   * @deprecated Backend owns validation
   */
  validateIdOrThrow(id) {
    log.warn('validateIdOrThrow() is deprecated - backend owns validation');
    return true;
  }

  /**
   * Legacy compatibility: validateMetadataOrThrow removed
   * @deprecated Backend owns validation
   */
  validateMetadataOrThrow(metadata) {
    log.warn('validateMetadataOrThrow() is deprecated - backend owns validation');
    return true;
  }
}

module.exports = { ChatValidator };
