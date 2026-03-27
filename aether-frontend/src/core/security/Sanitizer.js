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

const { createLogger } = require('../utils/logger');
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
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|file):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
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
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|data|file):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  }),
});

/**
 * Sanitizer class
 */
class Sanitizer {
  constructor(options = {}) {
    this.log = createLogger({ component: 'Sanitizer' });
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
    try {
      // Browser/renderer: prefer window instance if present
      if (typeof window !== 'undefined') {
        if (window.DOMPurify) {
          this.DOMPurify = window.DOMPurify;
          return;
        }
        // Attempt module import; support both instance and factory patterns
        const mod = require('dompurify');
        const candidate = mod && (mod.default || mod);
        if (candidate) {
          if (typeof candidate.sanitize === 'function') {
            this.DOMPurify = candidate;
          } else if (typeof candidate === 'function') {
            this.DOMPurify = candidate(window);
          }
        }
        return;
      }
      // Node-only environments: avoid bringing jsdom into renderer bundles.
      // Fallback to escape-only behavior if no DOM available.
    } catch (error) {
      this.log.warn('DOMPurify not available, falling back to basic HTML escaping', { error: error && error.message ? error.message : String(error) });
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

    // Fallback: allow-list sanitizer preserving tags for non-strict profiles
    return this._sanitizeFallback(html, profile);
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
      this.log.error('sanitization failed', { error: error.message });
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
   * Lightweight allow-list sanitizer when DOMPurify is unavailable.
   * - Removes script/style and their contents entirely
   * - Strips event handler attributes (on*)
   * - Validates href/src URLs, dropping dangerous ones
   * - Keeps only allowed tags for the selected profile
   * @private
   */
  _sanitizeFallback(html, profile) {
    const cfg = PROFILES[profile] || PROFILES.default;

    // Remove script and style blocks completely
    let output = String(html)
      .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '');

    // Remove event handler attributes
    output = output.replace(/\son\w+\s*=\s*"(?:[^"\\]|\\.)*"/gi, '')
                   .replace(/\son\w+\s*=\s*'(?:[^'\\]|\\.)*'/gi, '')
                   .replace(/\son\w+\s*=\s*[^\s>]+/gi, '');

    // Sanitize href/src attribute values
    output = output.replace(/\s(href|src)\s*=\s*"(.*?)"/gi, (_m, name, val) => {
      const safe = this.sanitizeURL(val);
      return safe ? ` ${name}="${safe}"` : '';
    });
    output = output.replace(/\s(href|src)\s*=\s*'(.*?)'/gi, (_m, name, val) => {
      const safe = this.sanitizeURL(val);
      return safe ? ` ${name}='${safe}'` : '';
    });
    output = output.replace(/\s(href|src)\s*=\s*([^"'\s>]+)/gi, (_m, name, val) => {
      const safe = this.sanitizeURL(val);
      return safe ? ` ${name}="${safe}"` : '';
    });

    // If strict, strip all tags and keep content
    if (cfg.ALLOWED_TAGS.length === 0) {
      return output.replace(/<[^>]*>/g, '');
    }

    // Remove disallowed tags but keep their inner content
    output = output.replace(/<\/?([a-z0-9-]+)(\s[^>]*)?>/gi, (match, tagName, attrs = '') => {
      const tag = String(tagName).toLowerCase();
      if (!cfg.ALLOWED_TAGS.includes(tag)) {
        return ''; // drop tag
      }

      // Filter attributes to the allow-list
      const allowedAttr = (cfg.ALLOWED_ATTR || []);
      const attrPairs = [];
      attrs.replace(/([a-zA-Z0-9:-]+)\s*=\s*(".*?"|'.*?'|[^\s>]+)/g, (_m, attrName, attrValue) => {
        const name = String(attrName).toLowerCase();
        if (name.startsWith('on')) return;
        if (name === 'href' || name === 'src') {
          // already sanitized above; keep as-is
          attrPairs.push(`${name}=${attrValue}`);
          return;
        }
        if (allowedAttr.includes(name) || (cfg.ALLOW_DATA_ATTR && (name.startsWith('data-') || name.startsWith('aria-')))) {
          attrPairs.push(`${name}=${attrValue}`);
        }
      });

      const rebuilt = attrPairs.length ? ` ${attrPairs.join(' ')}` : '';
      // Preserve self-closing vs normal tags
      if (match.startsWith('</')) {
        return `</${tag}>`;
      }
      const selfClosing = /\/>$/.test(match);
      return selfClosing ? `<${tag}${rebuilt}/>` : `<${tag}${rebuilt}>`;
    });

    return output;
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
        this.log.warn('blocked dangerous URL protocol', { protocol: parsed.protocol });
        this.stats.violations++;
        return null;
      }

      return parsed.href;
    } catch (error) {
      this.log.warn('invalid URL', { url });
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
      // Fallback: compare with fallback sanitizer
      const sanitized = this._sanitizeFallback(html, profile);
      return sanitized === html;
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

// SECURITY: Do NOT expose Sanitizer globally.
// Consumers must use require() / DI container to access Sanitizer.
