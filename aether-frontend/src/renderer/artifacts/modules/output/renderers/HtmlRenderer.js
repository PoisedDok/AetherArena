'use strict';

/**
 * @.architecture
 * 
 * Incoming: OutputViewer.render() → HTML string or {html, content} object, window.DOMPurify --- {artifact_types.html_output, string}
 * Processing: Sanitize HTML via DOMPurify (or basic fallback), render in sandboxed iframe with allow-scripts/forms/modals/popups, write complete HTML document to iframe --- {3 jobs: JOB_CREATE_DOM_ELEMENT, JOB_SANITIZE_MARKDOWN, JOB_UPDATE_STATE}
 * Outgoing: DOM (sandboxed iframe or direct wrapper) --- {dom_types.chat_entry_element, HTMLElement}
 * 
 * 
 * @module renderer/artifacts/modules/output/renderers/HtmlRenderer
 */

const BaseRenderer = require('./BaseRenderer');
const { freeze } = Object;

// HTML renderer configuration
const CONFIG = freeze({
  IFRAME: freeze({
    SANDBOX: 'allow-scripts allow-forms allow-modals allow-popups allow-presentation',
    STYLE: 'width: 100%; height: 100%; border: none; background: white;',
  }),
  SANITIZER: freeze({
    ALLOWED_TAGS: ['div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 
                   'ul', 'ol', 'li', 'a', 'img', 'table', 'tr', 'td', 'th',
                   'code', 'pre', 'br', 'hr', 'strong', 'em', 'u', 'blockquote',
                   'button', 'input', 'label', 'select', 'option', 'textarea',
                   'canvas', 'svg', 'path', 'circle', 'rect', 'line'],
    ALLOWED_ATTR: ['class', 'id', 'style', 'href', 'src', 'alt', 'title', 
                   'width', 'height', 'type', 'value', 'placeholder', 'name',
                   'viewBox', 'd', 'fill', 'stroke', 'cx', 'cy', 'r', 'x', 'y'],
  }),
  CLASS_NAMES: freeze({
    CONTAINER: 'html-renderer-container',
    IFRAME: 'html-renderer-iframe',
    ERROR: 'html-renderer-error',
  }),
});

class HtmlRenderer extends BaseRenderer {
  /**
   * Create HTML renderer
   * @param {Object} options - Configuration options
   */
  constructor(options = {}) {
    super(options);
    
    this.safeMode = options.safeMode !== false; // Default to safe mode
    this.allowScripts = options.allowScripts === true; // Default to no scripts
    this.sanitizer = null;
    
    // Try to load DOMPurify
    this._loadSanitizer();
  }

  /**
   * Render HTML content
   * @param {string|Object} data - HTML string or object with html property
   * @param {HTMLElement} container - Container element
   */
  async render(data, container) {
    try {
      // Extract HTML string
      let html = typeof data === 'string' ? data : (data.html || data.content || '');

      if (!html || html.trim() === '') {
        const emptyEl = this.createEmptyMessage('No HTML content to display');
        this.prepareContainer(container);
        container.appendChild(emptyEl);
        return;
      }

      // Fix malformed HTML tags (backend sometimes sends incomplete tags)
      html = this._fixMalformedHtml(html);

      // Inject styles
      this._injectStyles();

      // Clear container
      this.prepareContainer(container);

      // Add container class
      container.classList.add(CONFIG.CLASS_NAMES.CONTAINER);

      // Render based on mode
      if (this.safeMode) {
        this._renderInIframe(html, container);
      } else {
        this._renderDirect(html, container);
      }

      console.log('[HtmlRenderer] Rendered HTML content');

    } catch (error) {
      console.error('[HtmlRenderer] Render failed:', error);
      this.handleError(container, error, 'Failed to render HTML');
    }
  }

  /**
   * Render HTML in sandboxed iframe
   * @param {string} html - HTML content
   * @param {HTMLElement} container - Container element
   * @private
   */
  _renderInIframe(html, container) {
    // Sanitize HTML if sanitizer available
    const sanitizedHtml = this.sanitizer ? this.sanitizer.sanitize(html) : this._basicSanitize(html);

    // Create complete HTML document
    const iframeDoc = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      body {
        margin: 0;
        padding: 16px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
        font-size: 14px;
        line-height: 1.6;
        color: #333;
        background: white;
      }
      * {
        box-sizing: border-box;
      }
    </style>
  </head>
  <body>
    ${sanitizedHtml}
  </body>
</html>`;

    // Create iframe with srcdoc (works better with sandbox than doc.write)
    const iframe = document.createElement('iframe');
    iframe.className = CONFIG.CLASS_NAMES.IFRAME;
    iframe.setAttribute('sandbox', CONFIG.IFRAME.SANDBOX);
    iframe.setAttribute('style', CONFIG.IFRAME.STYLE);
    iframe.setAttribute('srcdoc', iframeDoc);

    // Append iframe
    container.appendChild(iframe);

    console.log('[HtmlRenderer] Rendered HTML content');
  }

  /**
   * Render HTML directly (unsafe - use with caution)
   * @param {string} html - HTML content
   * @param {HTMLElement} container - Container element
   * @private
   */
  _renderDirect(html, container) {
    // Sanitize HTML
    const sanitizedHtml = this.sanitizer ? this.sanitizer.sanitize(html) : this._basicSanitize(html);

    // Create content wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'html-content-wrapper';
    wrapper.innerHTML = sanitizedHtml;

    // Append to container
    container.appendChild(wrapper);
  }

  /**
   * Fix malformed HTML tags that backend sometimes sends
   * @param {string} html - HTML to fix
   * @returns {string}
   * @private
   */
  _fixMalformedHtml(html) {
    // Fix malformed DOCTYPE
    html = html.replace(/<!DOCTYPE\s*>/gi, '<!DOCTYPE html>');
    
    // Fix empty opening tags like <>
    html = html.replace(/\n<>\n/g, '\n<html>\n');
    
    // Fix empty closing tags like </>
    html = html.replace(/\n<\/>\n/g, '\n</html>\n');
    
    // If DOCTYPE exists but no <html> tag, wrap content
    if (html.includes('<!DOCTYPE') && !html.includes('<html')) {
      const doctypeEnd = html.indexOf('>') + 1;
      html = html.substring(0, doctypeEnd) + '\n<html>\n' + html.substring(doctypeEnd) + '\n</html>';
    }
    
    return html;
  }
  
  /**
   * Basic HTML sanitization (fallback when DOMPurify not available)
   * @param {string} html - HTML to sanitize
   * @returns {string}
   * @private
   */
  _basicSanitize(html) {
    if (!this.allowScripts) {
      // Remove script tags
      html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
      
      // Remove inline event handlers
      html = html.replace(/on\w+\s*=\s*["'][^"']*["']/gi, '');
      html = html.replace(/on\w+\s*=\s*[^\s>]*/gi, '');
    }

    return html;
  }

  /**
   * Load DOMPurify sanitizer
   * @private
   */
  _loadSanitizer() {
    try {
      // Try to load from window
      if (window.DOMPurify) {
        this.sanitizer = window.DOMPurify;
        console.log('✅ [HtmlRenderer] DOMPurify loaded from window');
      } else if (window.aether && window.aether.DOMPurify) {
        this.sanitizer = window.aether.DOMPurify;
        console.log('✅ [HtmlRenderer] DOMPurify loaded from window.aether');
      } else {
        console.warn('⚠️ [HtmlRenderer] DOMPurify not available, using basic sanitization');
      }
    } catch (error) {
      console.error('[HtmlRenderer] Failed to load DOMPurify:', error);
    }
  }

  /**
   * Inject styles
   * @private
   */
  _injectStyles() {
    const styleId = 'html-renderer-styles';

    const styles = `
      .${CONFIG.CLASS_NAMES.CONTAINER} {
        width: 100%;
        height: 100%;
        overflow: auto;
        background: white;
      }

      .${CONFIG.CLASS_NAMES.IFRAME} {
        display: block;
      }

      .html-content-wrapper {
        padding: 16px;
        background: white;
        color: #333;
      }

      .${CONFIG.CLASS_NAMES.ERROR} {
        padding: 16px;
        color: #d32f2f;
        background: #ffebee;
        border: 1px solid #ef9a9a;
        border-radius: 4px;
      }
    `;

    this.injectStyles(styleId, styles);
  }

  /**
   * Dispose renderer
   */
  dispose() {
    super.dispose();
    this.sanitizer = null;
  }
}

// Export
module.exports = HtmlRenderer;

if (typeof window !== 'undefined') {
  window.HtmlRenderer = HtmlRenderer;
  console.log('📦 HtmlRenderer loaded');
}

