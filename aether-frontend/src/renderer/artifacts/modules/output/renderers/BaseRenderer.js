'use strict';

/**
 * @.architecture
 * 
 * Incoming: OutputViewer (delegated render calls), Subclass renderers (HtmlRenderer|JsonRenderer|MarkdownRenderer|MediaRenderer) --- {none, abstract_base_class}
 * Processing: Provide common DOM utility methods (createContainer, createElement variants), style injection tracking, error/empty message rendering, HTML escaping/sanitization --- {2 jobs: JOB_CREATE_DOM_ELEMENT, JOB_UPDATE_DOM_ELEMENT}
 * Outgoing: Subclass renderers (utility methods), DOM (styled elements) --- {dom_types.chat_entry_element, HTMLElement}
 * 
 * 
 * @module renderer/artifacts/modules/output/renderers/BaseRenderer
 */

const { freeze } = Object;
const { createRendererLogger } = require('../../../../shared/utils/logger');
const SecuritySanitizer = require('../../../../shared/security/SecuritySanitizer');
const _log = createRendererLogger('BaseRenderer');
let _outputSanitizer = null;

function getOutputSanitizer(log) {
  if (_outputSanitizer) {
    return _outputSanitizer;
  }
  try {
    _outputSanitizer = new SecuritySanitizer();
  } catch (error) {
    log?.warn?.('[BaseRenderer] Failed to initialize SecuritySanitizer fallback', { error: error?.message });
    _outputSanitizer = null;
  }
  return _outputSanitizer;
}

class BaseRenderer {
  /**
   * Create base renderer
   * @param {Object} options - Configuration options
   */
  constructor(options = {}) {
    this.log = _log;
    this.options = options;
    this.injectedStyles = new Set();
    this._isDisposed = false; // BUG BR-1 FIX: Lifecycle flag
  }

  /**
   * Render content (must be implemented by subclasses)
   * @param {*} data - Data to render
   * @param {HTMLElement} container - Container element
   * @returns {Promise<void>}
   * @abstract
   */
  async render(data, container) {
    throw new Error('[BaseRenderer] render() must be implemented by subclass');
  }

  /**
   * Inject CSS styles into document head if not already present
   * @param {string} styleId - Unique identifier for the style block
   * @param {string} css - CSS content to inject
   */
  injectStyles(styleId, css) {
    if (this._isDisposed) return; // BUG BR-1 FIX: No style injection after dispose
    try {
      // BUG BR-2 FIX: Resync tracking with DOM reality
      if (this.injectedStyles.has(styleId)) {
        if (document.getElementById(styleId)) {
          return; // Genuinely injected and present in DOM
        }
        // Style element was removed externally — clear tracking to allow re-injection
        this.injectedStyles.delete(styleId);
      }

      if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = css;
        document.head.appendChild(style);
      }
      // BUG BR-2 FIX: Always track — whether we just created it or it was already in DOM
      this.injectedStyles.add(styleId);
    } catch (error) {
      this.log.error(`[BaseRenderer] Failed to inject styles for ${styleId}:`, error);
    }
  }

  /**
   * Create a styled container element
   * @param {string} className - CSS class name for the container
   * @param {Object} options - Additional options
   * @returns {HTMLElement} The created container
   */
  createContainer(className, options = {}) {
    const container = document.createElement('div');
    container.className = className;

    if (options.innerHTML) {
      container.innerHTML = options.innerHTML;
    }

    if (options.id) {
      container.id = options.id;
    }

    return container;
  }

  /**
   * Clear and prepare a container for new content
   * @param {HTMLElement} container - Container to prepare
   * @param {string} content - Optional initial content
   */
  prepareContainer(container, content = '') {
    if (!container || this._isDisposed) { // BUG BR-1 FIX: Guard post-dispose
      return;
    }

    try {
      container.innerHTML = content;
    } catch (error) {
      this.log.error('[BaseRenderer] Failed to prepare container:', error);
    }
  }

  /**
   * Safely append child to parent
   * @param {HTMLElement} parent - Parent element
   * @param {HTMLElement} child - Child element to append
   */
  safeAppendChild(parent, child) {
    try {
      if (parent && child) {
        parent.appendChild(child);
      }
    } catch (error) {
      this.log.error('[BaseRenderer] Failed to append child:', error);
    }
  }

  /**
   * Create a link element with proper attributes
   * @param {string} href - Link URL
   * @param {string} text - Link text
   * @param {Object} options - Additional options
   * @returns {HTMLAnchorElement} The created link
   */
  createLink(href, text, options = {}) {
    const link = document.createElement('a');
    link.href = href || '#';
    link.textContent = text || href || '';

    if (options.target !== false) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }

    if (options.className) {
      link.className = options.className;
    }

    if (options.title) {
      link.title = options.title;
    }

    return link;
  }

  /**
   * Create an image element with proper attributes
   * @param {string} src - Image source URL
   * @param {string} alt - Alt text
   * @param {Object} options - Additional options
   * @returns {HTMLImageElement} The created image
   */
  createImage(src, alt = '', options = {}) {
    const img = document.createElement('img');
    img.src = src || '';
    img.alt = alt;

    if (options.className) {
      img.className = options.className;
    }

    if (options.loading !== false) {
      img.loading = 'lazy';
    }

    if (options.title) {
      img.title = options.title;
    }

    return img;
  }

  /**
   * Create a heading element
   * @param {number} level - Heading level (1-6)
   * @param {string} text - Heading text
   * @param {Object} options - Additional options
   * @returns {HTMLHeadingElement}
   */
  createHeading(level, text, options = {}) {
    const tag = `h${Math.max(1, Math.min(6, Math.round(level)))}`;
    const heading = document.createElement(tag);
    heading.textContent = text;

    if (options.className) {
      heading.className = options.className;
    }

    if (options.id) {
      heading.id = options.id;
    }

    return heading;
  }

  /**
   * Create a paragraph element
   * @param {string} text - Paragraph text
   * @param {Object} options - Additional options
   * @returns {HTMLParagraphElement}
   */
  createParagraph(text, options = {}) {
    const p = document.createElement('p');
    
    if (options.html) {
      p.innerHTML = text;
    } else {
      p.textContent = text;
    }

    if (options.className) {
      p.className = options.className;
    }

    return p;
  }

  /**
   * Create a code block element
   * @param {string} code - Code content
   * @param {string} language - Programming language
   * @param {Object} options - Additional options
   * @returns {HTMLElement}
   */
  createCodeBlock(code, language = '', options = {}) {
    const pre = document.createElement('pre');
    const codeEl = document.createElement('code');
    
    if (language) {
      codeEl.className = `language-${language}`;
    }

    codeEl.textContent = code;
    pre.appendChild(codeEl);

    if (options.className) {
      pre.className += ` ${options.className}`;
    }

    return pre;
  }

  /**
   * Create a list element
   * @param {Array<string>} items - List items
   * @param {boolean} ordered - Whether list is ordered
   * @param {Object} options - Additional options
   * @returns {HTMLElement}
   */
  createList(items, ordered = false, options = {}) {
    const list = document.createElement(ordered ? 'ol' : 'ul');

    for (const item of items) {
      const li = document.createElement('li');
      if (options.html) {
        li.innerHTML = item;
      } else {
        li.textContent = item;
      }
      list.appendChild(li);
    }

    if (options.className) {
      list.className = options.className;
    }

    return list;
  }

  /**
   * Create an error message element
   * @param {string} message - Error message
   * @param {Error} error - Optional error object
   * @returns {HTMLElement}
   */
  createErrorMessage(message, error = null) {
    const container = this.createContainer('render-error');
    
    const messageEl = this.createParagraph(message, { className: 'error-message' });
    container.appendChild(messageEl);

    if (error && error.message) {
      const detailEl = document.createElement('pre');
      detailEl.className = 'error-detail';
      detailEl.textContent = error.message;
      container.appendChild(detailEl);
    }

    return container;
  }

  /**
   * Create an empty state message element
   * @param {string} message - Empty state message
   * @returns {HTMLElement}
   */
  createEmptyMessage(message) {
    const container = this.createContainer('render-empty');
    const messageEl = this.createParagraph(message, { className: 'empty-message' });
    container.appendChild(messageEl);
    return container;
  }

  /**
   * Handle rendering errors gracefully
   * @param {HTMLElement} container - Container to show error in
   * @param {Error} error - The error that occurred
   * @param {string} fallbackMessage - Fallback message
   */
  handleError(container, error, fallbackMessage = 'Rendering error') {
    try {
      if (container && !this._isDisposed) { // BUG BR-1 FIX: Guard post-dispose
        const errorEl = this.createErrorMessage(fallbackMessage, error);
        this.prepareContainer(container);
        container.appendChild(errorEl);
      }
      this.log.error('[BaseRenderer] Rendering error:', error);
    } catch (fallbackError) {
      this.log.error('[BaseRenderer] Failed to handle error:', fallbackError);
    }
  }

  /**
   * Escape HTML to prevent XSS
   * @param {string} html - HTML string to escape
   * @returns {string}
   */
  escapeHtml(html) {
    const div = document.createElement('div');
    div.textContent = html;
    return div.innerHTML;
  }

  /**
   * Sanitize HTML (basic — covers common XSS vectors but NOT comprehensive)
   * @param {string} html - HTML string to sanitize
   * @returns {string}
   * @deprecated Use core/security/Sanitizer for production-grade HTML sanitization.
   */
  sanitizeHtml(html) {
    if (!html || typeof html !== 'string') {
      return '';
    }

    const sanitizer = getOutputSanitizer(this.log);
    if (sanitizer && typeof sanitizer.sanitizeOutputHtml === 'function') {
      return sanitizer.sanitizeOutputHtml(html, { mode: 'direct', allowScripts: false });
    }

    // Last-resort fallback if SecuritySanitizer cannot initialize.
    return html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
      .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
      .replace(/<embed\b[^>]*\/?>/gi, '')
      .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
      .replace(/on\w+\s*=\s*[^\s>]*/gi, '')
      .replace(/(href|src|action)\s*=\s*["']\s*javascript:/gi, '$1="')
      .replace(/(href|src)\s*=\s*["']\s*data:(?!image\/)/gi, '$1="');
  }

  /**
   * Format file size
   * @param {number} bytes - File size in bytes
   * @returns {string}
   */
  formatFileSize(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '0 Bytes';
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Format date
   * @param {Date|string|number} date - Date to format
   * @returns {string}
   */
  formatDate(date) {
    try {
      const d = date instanceof Date ? date : new Date(date);
      return d.toLocaleString();
    } catch (error) {
      return String(date);
    }
  }

  /**
   * Get common CSS classes used across renderers
   * @returns {Object}
   */
  getCommonClasses() {
    return freeze({
      card: 'renderer-card',
      container: 'renderer-container',
      error: 'render-error',
      empty: 'render-empty',
      loading: 'render-loading',
      header: 'render-header',
      content: 'render-content',
      footer: 'render-footer',
    });
  }

  /**
   * Check if value is valid
   * @param {*} value - Value to check
   * @returns {boolean}
   */
  isValid(value) {
    return value !== null && value !== undefined;
  }

  /**
   * Check if value is empty
   * @param {*} value - Value to check
   * @returns {boolean}
   */
  isEmpty(value) {
    if (!this.isValid(value)) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'object') return Object.keys(value).length === 0;
    return false;
  }

  /**
   * Dispose of renderer resources
   */
  dispose() {
    if (this._isDisposed) return; // BUG BR-1 FIX: Guard against double-dispose
    this.injectedStyles.clear();
    this._isDisposed = true; // BUG BR-1 FIX: Set lifecycle flag
  }
}

// Export
module.exports = BaseRenderer;

if (typeof window !== 'undefined') {
  window.BaseRenderer = BaseRenderer;
  _log.debug('[BaseRenderer] BaseRenderer loaded');
}
