'use strict';

/**
 * @.architecture
 * 
 * Incoming: MarkdownRenderer.sanitize(), MessageView._renderContent() (HTML strings needing sanitization) --- {html_content, string}
 * Processing: Load DOMPurify (or fallback), apply sanitization profiles (strict/markdown/permissive), validate messages (check length max 1MB, detect suspicious patterns like <script>/javascript:/onclick), escape HTML entities, forbid dangerous tags/attrs --- {5 jobs: JOB_SANITIZE_MARKDOWN, JOB_VALIDATE_SCHEMA, JOB_ESCAPE_HTML, JOB_UPDATE_STATE, JOB_GET_STATE}
 * Outgoing: Return sanitized HTML or escaped text --- {sanitized_html, string}
 * 
 * 
 * @module renderer/chat/modules/messaging/SecuritySanitizer
 */

class SecuritySanitizer {
  constructor(options = {}) {
    this.DOMPurify = null;
    this.fallbackMode = false;

    // Sanitization profiles
    this.profiles = {
      strict: {
        ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'code', 'pre', 'a'],
        ALLOWED_ATTR: ['href', 'target'],
        ALLOW_DATA_ATTR: false
      },
      markdown: {
        ALLOWED_TAGS: [
          'p', 'br', 'strong', 'em', 'code', 'pre',
          'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          'ul', 'ol', 'li', 'blockquote', 'hr',
          'table', 'thead', 'tbody', 'tr', 'th', 'td',
          'a', 'span', 'div'
        ],
        ALLOWED_ATTR: ['href', 'target', 'class', 'id', 'data-language'],
        ALLOW_DATA_ATTR: true,
        FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed'],
        FORBID_ATTR: ['onerror', 'onload', 'onclick']
      },
      permissive: {
        ALLOWED_TAGS: [
          'p', 'br', 'strong', 'em', 'code', 'pre',
          'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          'ul', 'ol', 'li', 'blockquote', 'hr',
          'table', 'thead', 'tbody', 'tr', 'th', 'td',
          'a', 'img', 'span', 'div', 'section', 'article'
        ],
        ALLOWED_ATTR: ['href', 'target', 'class', 'id', 'src', 'alt', 'title', 'data-*'],
        ALLOW_DATA_ATTR: true,
        FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
        FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover']
      }
    };

    // Initialize DOMPurify
    this._initDOMPurify();

    console.log(`[SecuritySanitizer] Initialized in ${this.fallbackMode ? 'fallback' : 'DOMPurify'} mode`);
  }

  /**
   * Initialize DOMPurify if available
   * @private
   */
  _initDOMPurify() {
    try {
      // Try to load DOMPurify from window
      if (typeof window !== 'undefined' && window.DOMPurify) {
        this.DOMPurify = window.DOMPurify;
        console.log('[SecuritySanitizer] Using window.DOMPurify');
        return;
      }

      // Try to require DOMPurify
      const DOMPurify = require('dompurify');
      if (DOMPurify) {
        this.DOMPurify = DOMPurify;
        console.log('[SecuritySanitizer] Loaded DOMPurify via require');
        return;
      }
    } catch (error) {
      console.warn('[SecuritySanitizer] DOMPurify not available, using fallback:', error.message);
    }

    this.fallbackMode = true;
  }

  /**
   * Sanitize HTML content
   * @param {string} html - HTML content to sanitize
   * @param {Object} options - Sanitization options
   * @param {string} options.profile - Sanitization profile (strict|markdown|permissive)
   * @param {Object} options.config - Custom DOMPurify config
   * @returns {string} Sanitized HTML
   */
  sanitizeHTML(html, options = {}) {
    if (!html || typeof html !== 'string') {
      return '';
    }

    // If no DOMPurify, fallback to escaping
    if (this.fallbackMode) {
      return this.escapeHTML(html);
    }

    try {
      const profile = options.profile || 'markdown';
      const config = options.config || this.profiles[profile] || this.profiles.markdown;

      const sanitized = this.DOMPurify.sanitize(html, config);
      return sanitized;
    } catch (error) {
      console.error('[SecuritySanitizer] Sanitization failed:', error);
      return this.escapeHTML(html);
    }
  }

  /**
   * Escape HTML entities (fallback method)
   * @param {string} text - Text to escape
   * @returns {string} Escaped HTML
   */
  escapeHTML(text) {
    if (!text || typeof text !== 'string') {
      return '';
    }

    const entityMap = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
      '/': '&#x2F;'
    };

    return text.replace(/[&<>"'\/]/g, (char) => entityMap[char]);
  }

  /**
   * Sanitize markdown-rendered HTML
   * @param {string} html - Markdown-rendered HTML
   * @returns {string} Sanitized HTML
   */
  sanitizeMarkdown(html) {
    return this.sanitizeHTML(html, { profile: 'markdown' });
  }

  /**
   * Sanitize user input text
   * @param {string} text - User input text
   * @returns {string} Sanitized text
   */
  sanitizeUserInput(text) {
    return this.escapeHTML(text);
  }

  /**
   * Validate message object for security issues
   * @param {Object} message - Message object
   * @returns {boolean} Whether message is valid
   */
  validateMessage(message) {
    if (!message || typeof message !== 'object') {
      console.warn('[SecuritySanitizer] Invalid message object');
      return false;
    }

    // Check required fields
    if (!message.content || typeof message.content !== 'string') {
      console.warn('[SecuritySanitizer] Message content is invalid');
      return false;
    }

    // Check content length (prevent DoS)
    const maxLength = 1000000; // 1MB
    if (message.content.length > maxLength) {
      console.warn('[SecuritySanitizer] Message content exceeds max length');
      return false;
    }

    // Check for suspicious patterns
    const suspiciousPatterns = [
      /<script[^>]*>[\s\S]*?<\/script>/gi,
      /javascript:/gi,
      /on\w+\s*=/gi, // Event handlers
      /<iframe[^>]*>/gi,
      /<object[^>]*>/gi,
      /<embed[^>]*>/gi
    ];

    for (const pattern of suspiciousPatterns) {
      if (pattern.test(message.content)) {
        console.warn('[SecuritySanitizer] Suspicious pattern detected in message');
        return false;
      }
    }

    return true;
  }

  /**
   * Get sanitization config for profile
   * @param {string} profile - Profile name
   * @returns {Object} Sanitization config
   */
  getProfile(profile) {
    return this.profiles[profile] || this.profiles.markdown;
  }

  /**
   * Check if DOMPurify is available
   * @returns {boolean}
   */
  isDOMPurifyAvailable() {
    return !this.fallbackMode && !!this.DOMPurify;
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    this.DOMPurify = null;
    console.log('[SecuritySanitizer] Disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SecuritySanitizer;
}

if (typeof window !== 'undefined') {
  window.SecuritySanitizer = SecuritySanitizer;
  console.log('📦 SecuritySanitizer loaded');
}

