'use strict';

/**
 * @.architecture
 * 
 * Incoming: MessageView._renderContent() (markdown strings from assistant messages) --- {markdown_content, string}
 * Processing: Load marked.js (or fallback to simple regex), configure marked with GFM options, parse markdown to HTML (GFM enabled, breaks=true), extract code blocks with language detection, sanitize via SecuritySanitizer, check fallback mode state --- {4 jobs: JOB_GET_STATE, JOB_INITIALIZE, JOB_RENDER_MARKDOWN, JOB_SANITIZE_MARKDOWN}
 * Outgoing: Return sanitized HTML string --- {rendered_html, string}
 * 
 * 
 * @module renderer/chat/modules/messaging/MarkdownRenderer
 */

const SecuritySanitizer = require('./SecuritySanitizer');

class MarkdownRenderer {
  constructor(options = {}) {
    this.securitySanitizer = options.securitySanitizer || new SecuritySanitizer();
    this.marked = null;
    this.fallbackMode = false;

    // Initialize marked.js
    this._initMarked();

    console.log(`[MarkdownRenderer] Initialized in ${this.fallbackMode ? 'fallback' : 'marked.js'} mode`);
  }

  /**
   * Initialize marked.js if available
   * @private
   */
  _initMarked() {
    try {
      // Try to load from window
      if (typeof window !== 'undefined' && window.marked) {
        this.marked = window.marked;
        this._configureMarked();
        console.log('[MarkdownRenderer] Using window.marked');
        return;
      }

      // Try to require marked
      const marked = require('marked');
      if (marked) {
        this.marked = marked;
        this._configureMarked();
        console.log('[MarkdownRenderer] Loaded marked via require');
        return;
      }
    } catch (error) {
      console.warn('[MarkdownRenderer] marked.js not available, using fallback:', error.message);
    }

    this.fallbackMode = true;
  }

  /**
   * Configure marked.js with custom options
   * @private
   */
  _configureMarked() {
    if (!this.marked || !this.marked.setOptions) return;

    try {
      this.marked.setOptions({
        breaks: true, // Convert \n to <br>
        gfm: true, // GitHub Flavored Markdown
        headerIds: false, // Disable auto-generated header IDs
        mangle: false, // Don't escape email addresses
        sanitize: false, // We handle sanitization separately
        smartLists: true,
        smartypants: false,
        xhtml: false
      });

      console.log('[MarkdownRenderer] marked.js configured');
    } catch (error) {
      console.warn('[MarkdownRenderer] Failed to configure marked.js:', error);
    }
  }

  /**
   * Render markdown to HTML
   * @param {string} markdown - Markdown text
   * @param {Object} options - Rendering options
   * @param {boolean} options.sanitize - Whether to sanitize output (default: true)
   * @param {string} options.profile - Sanitization profile (default: 'markdown')
   * @returns {string} Rendered HTML
   */
  render(markdown, options = {}) {
    if (!markdown || typeof markdown !== 'string') {
      return '';
    }

    const sanitize = options.sanitize !== false;
    const profile = options.profile || 'markdown';

    let html;

    if (this.fallbackMode) {
      // Use simple fallback renderer
      html = this._renderSimple(markdown);
    } else {
      try {
        // Use marked.js
        html = this.marked.parse(markdown);
      } catch (error) {
        console.error('[MarkdownRenderer] marked.js rendering failed:', error);
        html = this._renderSimple(markdown);
      }
    }

    // Sanitize output
    if (sanitize && html) {
      html = this.securitySanitizer.sanitizeHTML(html, { profile });
    }

    return html;
  }

  /**
   * Simple markdown renderer (fallback)
   * Handles basic formatting without external dependencies
   * @private
   * @param {string} text - Markdown text
   * @returns {string} Simple HTML
   */
  _renderSimple(text) {
    if (!text) return '';

    let html = text;

    // Escape HTML first
    html = this.securitySanitizer.escapeHTML(html);

    // Headers
    html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/_(.+?)_/g, '<em>$1</em>');

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Code blocks
    html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // Line breaks
    html = html.replace(/\n/g, '<br>');

    // Lists (simple unordered)
    html = html.replace(/^[\s]*[-*]\s+(.+)$/gim, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');

    return html;
  }

  /**
   * Render inline markdown (no block elements)
   * @param {string} markdown - Inline markdown
   * @returns {string} Rendered HTML
   */
  renderInline(markdown) {
    if (!markdown) return '';

    let html = this.render(markdown, { sanitize: true });

    // Remove block-level elements for inline rendering
    html = html.replace(/<\/?p>/g, '');
    html = html.replace(/<br\s*\/?>/g, ' ');

    return html.trim();
  }

  /**
   * Extract and render code blocks separately
   * Useful for syntax highlighting integration
   * @param {string} markdown - Markdown text
   * @returns {Array} Array of { type, content, language }
   */
  extractCodeBlocks(markdown) {
    if (!markdown) return [];

    const blocks = [];
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    let match;

    while ((match = codeBlockRegex.exec(markdown)) !== null) {
      blocks.push({
        type: 'code',
        language: match[1] || 'text',
        content: match[2].trim()
      });
    }

    return blocks;
  }

  /**
   * Check if markdown contains specific elements
   * @param {string} markdown - Markdown text
   * @returns {Object} Element presence flags
   */
  analyze(markdown) {
    if (!markdown) {
      return {
        hasCodeBlocks: false,
        hasLinks: false,
        hasImages: false,
        hasTables: false,
        hasLists: false
      };
    }

    return {
      hasCodeBlocks: /```/.test(markdown),
      hasLinks: /\[.*\]\(.*\)/.test(markdown),
      hasImages: /!\[.*\]\(.*\)/.test(markdown),
      hasTables: /\|.*\|/.test(markdown),
      hasLists: /^[\s]*[-*+]\s+/m.test(markdown)
    };
  }

  /**
   * Sanitize already-rendered HTML
   * @param {string} html - HTML to sanitize
   * @param {Object} options - Sanitization options
   * @returns {string} Sanitized HTML
   */
  sanitize(html, options = {}) {
    const profile = options.profile || 'markdown';
    return this.securitySanitizer.sanitizeHTML(html, { profile });
  }

  /**
   * Check if marked.js is available
   * @returns {boolean}
   */
  isMarkedAvailable() {
    return !this.fallbackMode && !!this.marked;
  }

  /**
   * Get renderer info
   * @returns {Object}
   */
  getInfo() {
    return Object.freeze({
      mode: this.fallbackMode ? 'fallback' : 'marked',
      markedAvailable: this.isMarkedAvailable(),
      sanitizerMode: this.securitySanitizer.isDOMPurifyAvailable() ? 'DOMPurify' : 'fallback'
    });
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    if (this.securitySanitizer) {
      this.securitySanitizer.dispose();
    }
    this.marked = null;
    this.securitySanitizer = null;
    console.log('[MarkdownRenderer] Disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MarkdownRenderer;
}

if (typeof window !== 'undefined') {
  window.MarkdownRenderer = MarkdownRenderer;
  console.log('📦 MarkdownRenderer loaded');
}

