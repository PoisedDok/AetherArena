/**
 * @.architecture
 *
 * Incoming: renderer/chat/modules/messaging/MarkdownRenderer.js, window.DOMPurify --- {dom.chat_message_node, HTMLElement}
 * Processing: Sanitize markdown/HTML, escape unsafe text, detect suspicious patterns --- {3 jobs: JOB_ESCAPE_HTML, JOB_SANITIZE_MARKDOWN, JOB_VALIDATE_SCHEMA}
 * Outgoing: Sanitized HTML/text strings for renderer modules --- {sanitized_html | plain_text, string}
 */

'use strict';

const { createRendererLogger } = require('../utils/logger');

class SecuritySanitizer {
  constructor(options = {}) {
    this.DOMPurify = null;
    this.externalSanitizer = null;
    this.fallbackMode = false;
    this._isDisposed = false;
    this.log = createRendererLogger('SecuritySanitizer');

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
        FORBID_ATTR: ['onerror', 'onload', 'onclick'],
        ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|data|file):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
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
        FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
        ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|data|file):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
      },
      output_direct: {
        ALLOWED_TAGS: [
          'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          'ul', 'ol', 'li', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
          'code', 'pre', 'br', 'hr', 'strong', 'em', 'b', 'i', 'u', 'blockquote',
          'button', 'input', 'label', 'select', 'option', 'textarea',
          'canvas', 'svg', 'path', 'circle', 'rect', 'line'
        ],
        ALLOWED_ATTR: [
          'class', 'id', 'style', 'href', 'src', 'alt', 'title',
          'width', 'height', 'type', 'value', 'placeholder', 'name',
          'viewBox', 'd', 'fill', 'stroke', 'cx', 'cy', 'r', 'x', 'y',
          'target', 'rel', 'data-*'
        ],
        ALLOW_DATA_ATTR: true,
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
        FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
        ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|data|file):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
      }
    };

    this._initDOMPurify();
    this.log.debug('initialized', { mode: this.fallbackMode ? 'fallback' : 'dompurify' });
  }

  _initDOMPurify() {
    try {
      if (
        typeof window !== 'undefined' &&
        window.sanitizer &&
        typeof window.sanitizer.sanitizeHTML === 'function' &&
        typeof window.sanitizer.isAvailable === 'function' &&
        window.sanitizer.isAvailable()
      ) {
        this.externalSanitizer = window.sanitizer;
        this.log.debug('using window.sanitizer wrapper');
        return;
      }

      if (typeof window !== 'undefined' && window.DOMPurify) {
        this.DOMPurify = window.DOMPurify;
        this.log.debug('using window.DOMPurify');
        return;
      }

      const domPurifyModule = require('dompurify');
      if (domPurifyModule && typeof domPurifyModule.sanitize === 'function') {
        this.DOMPurify = domPurifyModule;
        this.log.debug('loaded DOMPurify via require');
        return;
      }

      if (typeof domPurifyModule === 'function' && typeof window !== 'undefined') {
        const instance = domPurifyModule(window);
        if (instance && typeof instance.sanitize === 'function') {
          this.DOMPurify = instance;
          this.log.debug('initialized DOMPurify factory with window');
          return;
        }
      }
    } catch (error) {
      this.log.warn('DOMPurify not available; using fallback', { error: error?.message });
    }

    this.fallbackMode = true;
  }

  sanitizeHTML(html, options = {}) {
    if (!html || typeof html !== 'string') {
      return '';
    }

    if (this.externalSanitizer) {
      try {
        if (options.config) {
          return this.externalSanitizer.sanitizeHTML(html, options.config);
        }
        return this.externalSanitizer.sanitizeHTML(html, { profile: options.profile || 'markdown' });
      } catch (error) {
        this.log.error('external sanitizer failed; falling back to escapeHTML', { error });
        return this.escapeHTML(html);
      }
    }

    if (this.fallbackMode) {
      return this.escapeHTML(html);
    }

    try {
      const profile = options.profile || 'markdown';
      const config = options.config || this.profiles[profile] || this.profiles.markdown;

      return this.DOMPurify.sanitize(html, config);
    } catch (error) {
      this.log.error('sanitization failed; falling back to escapeHTML', { error });
      return this.escapeHTML(html);
    }
  }

  /**
   * Sanitize HTML for output rendering surfaces.
   * - iframe mode: preserve layout/styles and strip only executable vectors
   * - direct mode: strip executable vectors, then apply DOMPurify profile when available
   *
   * @param {string} html
   * @param {Object} options
   * @param {'iframe'|'direct'} [options.mode='iframe']
   * @param {boolean} [options.allowScripts=false]
   * @returns {string}
   */
  sanitizeOutputHtml(html, options = {}) {
    if (!html || typeof html !== 'string') {
      return '';
    }

    const mode = options.mode === 'direct' ? 'direct' : 'iframe';
    const allowScripts = options.allowScripts === true;
    const stripEmbeddedContexts = mode === 'direct';

    const baseline = this._sanitizeDangerousMarkup(html, {
      allowScripts,
      stripEmbeddedContexts,
    });

    // In iframe mode, preserve structural/layout fidelity after baseline scrub.
    if (mode === 'iframe') {
      return baseline;
    }

    if (this.externalSanitizer) {
      try {
        return this.externalSanitizer.sanitizeHTML(baseline, { profile: 'default' });
      } catch (error) {
        this.log.error('external sanitizer failed for output HTML', { error });
        return baseline;
      }
    }

    if (this.fallbackMode || !this.DOMPurify || typeof this.DOMPurify.sanitize !== 'function') {
      return baseline;
    }

    try {
      return this.DOMPurify.sanitize(baseline, this.profiles.output_direct);
    } catch (error) {
      this.log.error('DOMPurify failed for output HTML', { error });
      return baseline;
    }
  }

  _sanitizeDangerousMarkup(html, options = {}) {
    const allowScripts = options.allowScripts === true;
    const stripEmbeddedContexts = options.stripEmbeddedContexts === true;
    let sanitized = String(html);

    if (!allowScripts) {
      sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
      sanitized = sanitized.replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '');
      sanitized = sanitized.replace(/\son\w+\s*=\s*[^\s>]*/gi, '');
      sanitized = sanitized.replace(/\sstyle\s*=\s*["'][^"']*(?:expression\s*\(|javascript:)[^"']*["']/gi, '');
      sanitized = sanitized.replace(/\sstyle\s*=\s*[^\s>]*(?:expression\s*\(|javascript:)[^\s>]*/gi, '');
    }

    if (stripEmbeddedContexts) {
      sanitized = sanitized.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '');
      sanitized = sanitized.replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '');
      sanitized = sanitized.replace(/<embed\b[^>]*\/?>/gi, '');
      sanitized = sanitized.replace(/<form\b[^<]*(?:(?!<\/form>)<[^<]*)*<\/form>/gi, '');
    }

    // Strip protocol-based script execution vectors.
    sanitized = sanitized.replace(
      /(href|src|action|formaction|xlink:href)\s*=\s*["']\s*(?:javascript|vbscript)\s*:[^"']*["']/gi,
      ''
    );
    sanitized = sanitized.replace(
      /(href|src|action|formaction|xlink:href)\s*=\s*(?:javascript|vbscript)\s*:[^\s>]*/gi,
      ''
    );

    // Block executable data URIs while preserving common media data URIs.
    sanitized = sanitized.replace(
      /(href|src|action|formaction)\s*=\s*["']\s*data\s*:\s*(?!image\/|audio\/|video\/)[^"']*["']/gi,
      ''
    );
    sanitized = sanitized.replace(
      /(href|src|action|formaction)\s*=\s*data\s*:\s*(?!image\/|audio\/|video\/)[^\s>]*/gi,
      ''
    );

    return sanitized;
  }

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

  sanitizeMarkdown(html) {
    return this.sanitizeHTML(html, { profile: 'markdown' });
  }

  sanitizeUserInput(text) {
    return this.escapeHTML(text);
  }

  validateMessage(message) {
    if (!message || typeof message !== 'object') {
      this.log.warn('validateMessage received invalid message object');
      return false;
    }

    if (!message.content || typeof message.content !== 'string') {
      this.log.warn('message content is invalid');
      return false;
    }

    const maxLength = 1000000;
    if (message.content.length > maxLength) {
      this.log.warn('message content exceeds max length', { length: message.content.length });
      return false;
    }

    const suspiciousPatterns = [
      /<script[^>]*>[\s\S]*?<\/script>/gi,
      /javascript:/gi,
      /on\w+\s*=/gi,
      /<iframe[^>]*>/gi,
      /<object[^>]*>/gi,
      /<embed[^>]*>/gi
    ];

    for (const pattern of suspiciousPatterns) {
      if (pattern.test(message.content)) {
        this.log.warn('suspicious pattern detected in message');
        return false;
      }
    }

    return true;
  }

  getProfile(profile) {
    return this.profiles[profile] || this.profiles.markdown;
  }

  isDOMPurifyAvailable() {
    return !!this.externalSanitizer || (!this.fallbackMode && !!this.DOMPurify);
  }

  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this.externalSanitizer = null;
    this.DOMPurify = null;
    this.log.trace('disposed');
  }
}

module.exports = SecuritySanitizer;
