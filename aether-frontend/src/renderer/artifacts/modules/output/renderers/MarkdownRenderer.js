'use strict';

/**
 * @.architecture
 * 
 * Incoming: OutputViewer.render() → Markdown string or {markdown, content} object, window.aether.marked, window.aether.hljs --- {artifact_types.console_output, string}
 * Processing: Parse markdown to HTML via marked library (or basic regex fallback), apply syntax highlighting to code blocks via hljs --- {3 jobs: JOB_CREATE_DOM_ELEMENT, JOB_RENDER_MARKDOWN, JOB_UPDATE_STATE}
 * Outgoing: DOM (rendered HTML from markdown with syntax-highlighted code blocks) --- {dom_types.chat_entry_element, HTMLElement}
 * 
 * 
 * @module renderer/artifacts/modules/output/renderers/MarkdownRenderer
 */

const BaseRenderer = require('./BaseRenderer');
const { freeze } = Object;

const CONFIG = freeze({
  CLASS_NAMES: freeze({
    CONTAINER: 'markdown-renderer-container',
  }),
});

class MarkdownRenderer extends BaseRenderer {
  constructor(options = {}) {
    super(options);
    this.marked = null;
    this.hljs = null;
    this._loadLibraries();
  }

  async render(data, container) {
    try {
      const markdown = typeof data === 'string' ? data : (data.markdown || data.content || '');

      if (!markdown || markdown.trim() === '') {
        const emptyEl = this.createEmptyMessage('No markdown content to display');
        this.prepareContainer(container);
        container.appendChild(emptyEl);
        return;
      }

      this._injectStyles();
      this.prepareContainer(container);
      container.classList.add(CONFIG.CLASS_NAMES.CONTAINER);

      // Render markdown
      const html = this.marked ? this.marked.parse(markdown) : this._basicMarkdown(markdown);
      
      const wrapper = document.createElement('div');
      wrapper.className = 'markdown-content';
      wrapper.innerHTML = html;
      container.appendChild(wrapper);

      // Syntax highlight code blocks
      if (this.hljs) {
        wrapper.querySelectorAll('pre code').forEach((block) => {
          this.hljs.highlightElement(block);
        });
      }

      console.log('[MarkdownRenderer] Rendered markdown content');

    } catch (error) {
      console.error('[MarkdownRenderer] Render failed:', error);
      this.handleError(container, error, 'Failed to render markdown');
    }
  }

  _loadLibraries() {
    try {
      if (window.marked) {
        this.marked = window.marked;
      } else if (window.aether && window.aether.marked) {
        this.marked = window.aether.marked;
      }

      if (window.hljs) {
        this.hljs = window.hljs;
      } else if (window.aether && window.aether.hljs) {
        this.hljs = window.aether.hljs;
      }
    } catch (error) {
      console.error('[MarkdownRenderer] Failed to load libraries:', error);
    }
  }

  _basicMarkdown(text) {
    // Basic markdown conversion (fallback)
    return text
      .replace(/^### (.*$)/gim, '<h3>$1</h3>')
      .replace(/^## (.*$)/gim, '<h2>$1</h2>')
      .replace(/^# (.*$)/gim, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/```(.+?)```/gs, '<pre><code>$1</code></pre>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }

  _injectStyles() {
    const styleId = 'markdown-renderer-styles';
    const styles = `
      .${CONFIG.CLASS_NAMES.CONTAINER} {
        padding: 16px;
        background: white;
        color: #333;
        overflow: auto;
      }
      .markdown-content {
        max-width: 100%;
      }
      .markdown-content h1, .markdown-content h2, .markdown-content h3,
      .markdown-content h4, .markdown-content h5, .markdown-content h6 {
        margin-top: 24px;
        margin-bottom: 16px;
        font-weight: 600;
        line-height: 1.25;
      }
      .markdown-content p {
        margin-bottom: 16px;
        line-height: 1.6;
      }
      .markdown-content code {
        padding: 2px 6px;
        background: #f5f5f5;
        border-radius: 3px;
        font-family: 'Courier New', monospace;
        font-size: 13px;
      }
      .markdown-content pre {
        padding: 16px;
        background: #2b2b2b;
        color: #f8f8f2;
        border-radius: 6px;
        overflow-x: auto;
      }
      .markdown-content pre code {
        background: transparent;
        padding: 0;
      }
    `;
    this.injectStyles(styleId, styles);
  }
}

module.exports = MarkdownRenderer;

if (typeof window !== 'undefined') {
  window.MarkdownRenderer = MarkdownRenderer;
  console.log('📦 MarkdownRenderer loaded');
}

