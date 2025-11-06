'use strict';

/**
 * @.architecture
 * 
 * Incoming: MarkdownRenderer/MessageView/SecuritySanitizer method calls --- {html_string | url_string | attribute_value, string}
 * Processing: Load DOMPurify or fallback to HTML escaping, select sanitization profile (strict/default/permissive), sanitize HTML with DOMPurify, validate URLs against dangerous protocols (javascript/data/vbscript/file), escape attribute values, strip HTML tags, collect sanitization statistics --- {6 jobs: JOB_CLEAR_STATE, JOB_ESCAPE_HTML, JOB_GET_STATE, JOB_INITIALIZE, JOB_SANITIZE_MARKDOWN, JOB_UPDATE_STATE}
 * Outgoing: Return sanitized HTML string, validated URL, or escaped text --- {sanitized_html | validated_url | escaped_text, string}
 * 
 * 
 * @module core/security/Sanitizer
 */

const { freeze } = Object;

/**
 * Sanitization profiles
 */
const PROFILES = freeze({
  // Strict: Text only, no HTML
  strict: freeze({
    ALLOWED_TAGS: [],
    ALLOWED_ATTR: [],
    KEEP_CONTENT: true,
  }),
  
  // Default: Safe HTML subset
  default: freeze({
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'u', 's', 'code', 'pre',
      'a', 'img', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'span', 'div',
    ],
    ALLOWED_ATTR: [
      'href', 'src', 'alt', 'title', 'class',
      'target', 'rel', 'id',
    ],
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  }),
  
  // Permissive: More HTML, for rich content
  permissive: freeze({
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'u', 's', 'code', 'pre',
      'a', 'img', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'span', 'div', 'section', 'article', 'figure', 'figcaption',
      'details', 'summary', 'mark', 'small', 'sub', 'sup',
      'hr', 'abbr', 'cite', 'q', 'dfn', 'time', 'var', 'samp', 'kbd',
    ],
    ALLOWED_ATTR: [
      'href', 'src', 'alt', 'title', 'class', 'id',
      'target', 'rel', 'width', 'height',
      'data-*', 'aria-*', 'role',
    ],
    ALLOW_DATA_ATTR: true,
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|data):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  }),
});

/**
 * Sanitizer class
 */
class Sanitizer {
  constructor(options = {}) {
    this.defaultProfile = options.defaultProfile || 'default';
    this.DOMPurify = null;
    
    // Statistics
    this.stats = {
      totalSanitizations: 0,
      byProfile: new Map(),
      violations: 0,
    };
    
    // Try to load DOMPurify
    this._loadDOMPurify();
  }

  /**
   * Load DOMPurify library
   * @private
   */
  _loadDOMPurify() {
    // Try to load from window (if bundled)
    if (typeof window !== 'undefined' && window.DOMPurify) {
      this.DOMPurify = window.DOMPurify;
      return;
    }

    // Try to require (Node.js/Electron)
    try {
      const DOMPurifyModule = require('dompurify');
      
      // DOMPurify needs a DOM - use jsdom in Node
      if (typeof window === 'undefined') {
        const { JSDOM } = require('jsdom');
        const window = new JSDOM('').window;
        this.DOMPurify = DOMPurifyModule(window);
      } else {
        this.DOMPurify = DOMPurifyModule;
      }
    } catch (error) {
      console.warn('[Sanitizer] DOMPurify not available:', error.message);
      console.warn('[Sanitizer] Falling back to basic HTML escaping');
    }
  }

  /**
   * Sanitize HTML content
   * @param {string} html - HTML to sanitize
   * @param {Object} options - Sanitization options
   * @returns {string} - Sanitized HTML
   */
  sanitizeHTML(html, options = {}) {
    if (!html || typeof html !== 'string') {
      return '';
    }

    const profile = options.profile || this.defaultProfile;
    this._updateStats(profile);

    // Use DOMPurify if available
    if (this.DOMPurify) {
      return this._sanitizeWithDOMPurify(html, profile, options);
    }

    // Fallback to basic escaping
    return this._escapeHTML(html);
  }

  /**
   * Sanitize with DOMPurify
   * @param {string} html - HTML to sanitize
   * @param {string} profile - Sanitization profile
   * @param {Object} options - Additional options
   * @returns {string}
   * @private
   */
  _sanitizeWithDOMPurify(html, profile, options) {
    const config = {
      ...PROFILES[profile],
      ...options.config,
    };

    // Add hooks if provided
    if (options.beforeSanitize) {
      this.DOMPurify.addHook('beforeSanitizeElements', options.beforeSanitize);
    }
    if (options.afterSanitize) {
      this.DOMPurify.addHook('afterSanitizeElements', options.afterSanitize);
    }

    try {
      const clean = this.DOMPurify.sanitize(html, config);
      
      // Remove hooks
      if (options.beforeSanitize) {
        this.DOMPurify.removeHook('beforeSanitizeElements');
      }
      if (options.afterSanitize) {
        this.DOMPurify.removeHook('afterSanitizeElements');
      }
      
      return clean;
    } catch (error) {
      console.error('[Sanitizer] Sanitization failed:', error);
      this.stats.violations++;
      return this._escapeHTML(html);
    }
  }

  /**
   * Basic HTML escaping (fallback)
   * @param {string} text - Text to escape
   * @returns {string}
   * @private
   */
  _escapeHTML(text) {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#x27;',
      '/': '&#x2F;',
    };
    
    return text.replace(/[&<>"'/]/g, char => map[char]);
  }

  /**
   * Sanitize URL
   * @param {string} url - URL to sanitize
   * @returns {string|null} - Sanitized URL or null if unsafe
   */
  sanitizeURL(url) {
    if (!url || typeof url !== 'string') {
      return null;
    }

    try {
      const parsed = new URL(url);
      
      // Block dangerous protocols
      const dangerousProtocols = ['javascript:', 'data:', 'vbscript:', 'file:'];
      if (dangerousProtocols.includes(parsed.protocol)) {
        console.warn('[Sanitizer] Blocked dangerous URL protocol:', parsed.protocol);
        this.stats.violations++;
        return null;
      }

      return parsed.href;
    } catch (error) {
      console.warn('[Sanitizer] Invalid URL:', url);
      this.stats.violations++;
      return null;
    }
  }

  /**
   * Sanitize attribute value
   * @param {string} value - Attribute value
   * @param {string} name - Attribute name
   * @returns {string}
   */
  sanitizeAttribute(value, name) {
    if (!value || typeof value !== 'string') {
      return '';
    }

    // Special handling for URLs
    if (name === 'href' || name === 'src') {
      return this.sanitizeURL(value) || '';
    }

    // Escape HTML entities
    return this._escapeHTML(value);
  }

  /**
   * Strip all HTML tags
   * @param {string} html - HTML content
   * @returns {string} - Plain text
   */
  stripHTML(html) {
    if (!html || typeof html !== 'string') {
      return '';
    }

    if (this.DOMPurify) {
      return this.DOMPurify.sanitize(html, { ALLOWED_TAGS: [], KEEP_CONTENT: true });
    }

    // Fallback: remove tags with regex (not perfect but works)
    return html.replace(/<[^>]*>/g, '');
  }

  /**
   * Check if HTML is safe (without modifying it)
   * @param {string} html - HTML to check
   * @param {string} profile - Profile to use
   * @returns {boolean}
   */
  isSafe(html, profile = 'default') {
    if (!html || typeof html !== 'string') {
      return true;
    }

    if (!this.DOMPurify) {
      return false; // Can't verify without DOMPurify
    }

    const sanitized = this.sanitizeHTML(html, { profile });
    return sanitized === html;
  }

  /**
   * Update statistics
   * @param {string} profile - Profile used
   * @private
   */
  _updateStats(profile) {
    this.stats.totalSanitizations++;
    
    if (!this.stats.byProfile.has(profile)) {
      this.stats.byProfile.set(profile, 0);
    }
    
    this.stats.byProfile.set(
      profile,
      this.stats.byProfile.get(profile) + 1
    );
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    return {
      totalSanitizations: this.stats.totalSanitizations,
      violations: this.stats.violations,
      byProfile: Object.fromEntries(this.stats.byProfile),
      hasDOMPurify: !!this.DOMPurify,
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      totalSanitizations: 0,
      byProfile: new Map(),
      violations: 0,
    };
  }

  /**
   * Check if DOMPurify is available
   * @returns {boolean}
   */
  hasDOMPurify() {
    return !!this.DOMPurify;
  }

  // Aliases for backwards compatibility with tests
  sanitizeHtml(html, options) {
    return this.sanitizeHTML(html, options);
  }

  sanitizeUrl(url) {
    return this.sanitizeURL(url);
  }

  sanitizeText(text) {
    // Text sanitization = escape all HTML
    if (!text || typeof text !== 'string') {
      return '';
    }
    return this._escapeHTML(text);
  }
}

// Export
module.exports = { Sanitizer, PROFILES };

if (typeof window !== 'undefined') {
  window.Sanitizer = Sanitizer;
  console.log('📦 Sanitizer loaded');
}

