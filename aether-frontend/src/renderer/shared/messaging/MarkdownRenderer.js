/**
 * @.architecture
 *
 * Incoming: renderer/shared/utils/logger.js, renderer/shared/security/SecuritySanitizer.js --- {logging.logger | SecuritySanitizer, javascript_module}
 * Processing: Configure marked.js (GFM, breaks), render markdown to HTML, sanitize via SecuritySanitizer, fallback to regex renderer when marked unavailable --- {4 jobs: JOB_GET_STATE, JOB_INITIALIZE, JOB_RENDER_MARKDOWN, JOB_SANITIZE_MARKDOWN}
 * Outgoing: Sanitized HTML string for renderer consumers --- {sanitized_html, string}
 */

'use strict';

const { createRendererLogger } = require('../utils/logger');
const SecuritySanitizer = require('../security/SecuritySanitizer');

class MarkdownRenderer {
  constructor(options = {}) {
    this.securitySanitizer = options.securitySanitizer || new SecuritySanitizer();
    this.marked = null;
    this.fallbackMode = false;
    this._isDisposed = false;
    this.log = createRendererLogger('MarkdownRenderer');

    this._initMarked();
    this.log.debug('initialized', { mode: this.fallbackMode ? 'fallback' : 'marked' });
  }

  _initMarked() {
    try {
      if (typeof window !== 'undefined' && window.marked) {
        this.marked = window.marked;
        this._configureMarked();
        this.log.debug('using window.marked implementation');
        return;
      }

      const marked = require('marked');
      if (marked) {
        this.marked = marked;
        this._configureMarked();
        this.log.debug('loaded marked via require');
        return;
      }
    } catch (error) {
      this.log.warn('marked.js not available, falling back to simple renderer', { error: error?.message });
    }

    this.fallbackMode = true;
  }

  _configureMarked() {
    if (!this.marked) return;

    try {
      const sanitizer = this.securitySanitizer;

      /**
       * Escape raw HTML tokens instead of rendering them as real DOM.
       *
       * Why this exists:
       *   LLM responses frequently contain raw HTML fragments
       *   (e.g. <h1>Hey!</h1>) when referencing code they generated.
       *   Without this override, marked.js passes raw HTML through,
       *   and DOMPurify allows structural tags like h1-h6 — causing
       *   the chat text to render at heading size.
       *
       * Why markdown formatting is unaffected:
       *   Markdown syntax (# Heading, **bold**, - list) produces tokens
       *   handled by heading/strong/list renderers, NOT the html renderer.
       *   This override ONLY intercepts raw HTML that appears literally
       *   in the source text.
       *
       * Handles both modern (token object) and legacy (string) marked.js APIs.
       */
      const escapeRawHtml = (tokenOrHtml) => {
        const text = typeof tokenOrHtml === 'string'
          ? tokenOrHtml
          : (tokenOrHtml?.text || tokenOrHtml?.raw || String(tokenOrHtml));
        return sanitizer
          ? sanitizer.escapeHTML(text)
          : text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      };

      // Modern marked.js (v12+): use marked.use() for renderer overrides
      if (typeof this.marked.use === 'function') {
        this.marked.use({
          breaks: true,
          gfm: true,
          renderer: {
            html: escapeRawHtml,
          },
        });
      } else if (this.marked.setOptions) {
        // Legacy fallback: setOptions without renderer html override
        this.marked.setOptions({
          breaks: true,
          gfm: true,
          headerIds: false,
          mangle: false,
          sanitize: false,
          smartLists: true,
          smartypants: false,
          xhtml: false,
        });
      }
    } catch (error) {
      this.log.warn('failed to configure marked.js options', { error: error?.message });
    }
  }

  render(markdown, options = {}) {
    if (this._isDisposed) return '';
    if (!markdown || typeof markdown !== 'string') {
      return '';
    }

    const sanitize = options.sanitize !== false;
    const profile = options.profile || 'markdown';

    this.log.trace('markdown render input', {
      length: markdown.length,
      preview: markdown.substring(0, 200),
    });

    let html;

    if (this.fallbackMode) {
      html = this._renderSimple(markdown);
    } else {
      try {
        html = this.marked.parse(markdown);
      } catch (error) {
        this.log.error('marked.js rendering failed', { error });
        html = this._renderSimple(markdown);
      }
    }

    if (sanitize && html) {
      const unsanitized = html;
      html = this.securitySanitizer.sanitizeHTML(html, { profile });

      if (Math.abs(html.length - unsanitized.length) > 50) {
        this.log.warn('sanitization significantly changed content size', {
          before: unsanitized.length,
          after: html.length,
        });
      }
    }

    this.log.trace('markdown final output', {
      length: html?.length || 0,
      preview: html?.substring(0, 200),
    });

    return html;
  }

  _renderSimple(text) {
    if (!text) return '';

    let html = this.securitySanitizer.escapeHTML(text);

    html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/_(.+?)_/g, '<em>$1</em>');
    html = html.replace(/```([\s\S]*?)```/g, '<pre class="code-block"><code>$1</code></pre>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    html = html.replace(/\n/g, '<br>');
    html = html.replace(/^[\s]*[-*]\s+(.+)$/gim, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');

    return html;
  }

  renderInline(markdown) {
    if (!markdown) return '';
    let html = this.render(markdown, { sanitize: true });
    html = html.replace(/<\/?p>/g, '');
    html = html.replace(/<br\s*\/?>/g, ' ');
    return html.trim();
  }

  extractCodeBlocks(markdown) {
    if (!markdown) return [];

    const blocks = [];
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    let match;

    while ((match = codeBlockRegex.exec(markdown)) !== null) {
      blocks.push({
        type: 'code',
        language: match[1] || 'text',
        content: match[2].trim(),
      });
    }

    return blocks;
  }

  analyze(markdown) {
    if (!markdown) {
      return {
        hasCodeBlocks: false,
        hasLinks: false,
        hasImages: false,
        hasTables: false,
        hasLists: false,
      };
    }

    return {
      hasCodeBlocks: /```/.test(markdown),
      hasLinks: /\[.*\]\(.*\)/.test(markdown),
      hasImages: /!\[.*\]\(.*\)/.test(markdown),
      hasTables: /\|.*\|/.test(markdown),
      hasLists: /^[\s]*[-*+]\s+/m.test(markdown),
    };
  }

  sanitize(html, options = {}) {
    const profile = options.profile || 'markdown';
    return this.securitySanitizer.sanitizeHTML(html, { profile });
  }

  isMarkedAvailable() {
    return !this.fallbackMode && !!this.marked;
  }

  getInfo() {
    return Object.freeze({
      mode: this.fallbackMode ? 'fallback' : 'marked',
      markedAvailable: this.isMarkedAvailable(),
      sanitizerMode: this.securitySanitizer.isDOMPurifyAvailable() ? 'DOMPurify' : 'fallback',
    });
  }

  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;
    if (this.securitySanitizer) {
      this.securitySanitizer.dispose();
    }
    this.marked = null;
    this.securitySanitizer = null;
  }
}

module.exports = MarkdownRenderer;
