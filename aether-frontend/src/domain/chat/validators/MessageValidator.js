/**
 * @.architecture
 *
 * Incoming: MessageService, MessageView (XSS sanitization requests) --- {message_content, string}
 * Processing: Escape/sanitize content for XSS using SecuritySanitizer --- {1 job: JOB_ESCAPE_HTML}
 * Outgoing: Sanitized content safe for DOM rendering --- {sanitized_content, string}
 *
 * ARCHITECTURE NOTE:
 * Backend owns ALL validation (content size, roles, IDs, rate limiting, business rules).
 * Frontend ONLY sanitizes for XSS security. Trust backend-validated data.
 *
 * @module domain/chat/validators/MessageValidator
 */

'use strict';

const { createLogger } = require('../../../core/utils/logger');

const log = createLogger({ component: 'MessageValidator' });

/**
 * MessageValidator
 * 
 * XSS sanitization only. All business logic validation removed per architecture.
 * Backend validates: content size, roles, status, IDs, timestamps, rate limits, etc.
 * 
 * This is a lightweight wrapper around SecuritySanitizer for XSS protection.
 */
class MessageValidator {
  constructor(config = {}) {
    this.sanitizer = null;
    this._initSanitizer();
  }

  /**
   * Initialize sanitizer (lazy load to avoid circular deps)
   * @private
   */
  _initSanitizer() {
    try {
      // Use core Sanitizer (domain may depend on core, not renderer)
      const { Sanitizer } = require('../../../core/security/Sanitizer');
      this.sanitizer = new Sanitizer();
    } catch (error) {
      // Fallback: basic HTML escape
      this.sanitizer = {
        sanitizeHTML: (text) => this._escapeHTML(text),
        sanitizeText: (text) => this._escapeHTML(text)
      };
    }
  }

  /**
   * Sanitize message content for XSS
   * ARCHITECTURE: Backend already validated - frontend just sanitizes for security
   * @param {string} content - Message content
   * @returns {string} - Sanitized content
   */
  sanitizeContent(content) {
    if (!content || typeof content !== 'string') {
      return '';
    }
    
    return this.sanitizer.sanitizeText(content);
  }

  /**
   * Sanitize HTML content for XSS
   * ARCHITECTURE: Backend already validated - frontend just sanitizes for security
   * @param {string} html - HTML content
   * @param {Object} options - Sanitization options
   * @returns {string} - Sanitized HTML
   */
  sanitizeHTML(html, options = {}) {
    if (!html || typeof html !== 'string') {
      return '';
    }
    
    return this.sanitizer.sanitizeHTML(html, options);
  }

  /**
   * Basic HTML escape fallback
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
  validate(message) {
    log.warn('validate() is deprecated - backend owns ALL validation');
    return { valid: true };
  }

  /**
   * Legacy compatibility: validateContent now just sanitizes
   * ARCHITECTURE: Backend owns validation - frontend only sanitizes
   * @deprecated Use sanitizeContent() for XSS protection
   */
  validateContent(content) {
    log.warn('validateContent() is deprecated - use sanitizeContent() for XSS only');
    return { valid: true };
  }

  /**
   * Legacy compatibility: rate limiting removed
   * ARCHITECTURE: Backend owns rate limiting
   * @deprecated Backend enforces rate limits
   */
  checkRateLimit(identifier) {
    log.warn('checkRateLimit() is deprecated - backend owns rate limiting');
    return { allowed: true };
  }

  /**
   * Legacy compatibility: validateOrThrow removed
   * @deprecated Backend owns validation
   */
  validateOrThrow(message) {
    if (!message || !message.role || !message.content) {
      throw new Error('Invalid message format');
    }
    return true;
  }

  /**
   * Legacy compatibility: validateContentOrThrow removed
   * @deprecated Backend owns validation
   */
  validateContentOrThrow(content) {
    log.warn('validateContentOrThrow() is deprecated - backend owns validation');
    return true;
  }

  /**
   * Legacy compatibility: checkRateLimitOrThrow removed
   * @deprecated Backend owns rate limiting
   */
  checkRateLimitOrThrow(identifier) {
    log.warn('checkRateLimitOrThrow() is deprecated - backend owns rate limiting');
    return { allowed: true };
  }

  /**
   * Legacy compatibility: resetRateLimit removed
   * @deprecated Backend owns rate limiting
   */
  resetRateLimit(identifier) {
    log.warn('resetRateLimit() is deprecated - backend owns rate limiting');
  }

  /**
   * Legacy compatibility: destroy method (no cleanup needed now)
   */
  destroy() {
    // No cleanup needed - no timers or state
  }
}

module.exports = { MessageValidator };
