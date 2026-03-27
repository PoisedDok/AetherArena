'use strict';

/**
 * @.architecture
 * Incoming: renderer/artifacts/modules/output/OutputViewer.js --- {event.custom, json}
 * Processing: Render markdown with shared renderer, sanitize HTML, highlight code --- {5 jobs: JOB_CREATE_WRAPPER, JOB_CREATE_DOM_ELEMENT, JOB_RENDER_MARKDOWN, JOB_SANITIZE_MARKDOWN, JOB_UPDATE_DOM_ELEMENT}
 * Outgoing: renderer/artifacts/modules/output/OutputViewer.js --- {dom.artifact_panel, HTMLElement}
 */

const BaseRenderer = require('./BaseRenderer');
const { freeze } = Object;
const SharedMarkdownRenderer = require('../../../../shared/messaging/MarkdownRenderer');
const { getAether } = require('../../../../shared/bridge/AetherBridge');
let morphdom = null;
try {
  morphdom = require('morphdom');
} catch (e) {
  // Graceful degradation if morphdom is not available
}

const CONFIG = freeze({
  CLASS_NAMES: freeze({
    CONTAINER: 'markdown-renderer-container',
    CONTENT: 'markdown-content',
    CODE_COPY_BTN: 'code-copy-btn',
  }),
});

class MarkdownRenderer extends BaseRenderer {
  constructor(options = {}) {
    super(options);
    this.marked = null;
    this.hljs = null;
    this.sharedRenderer = new SharedMarkdownRenderer();
    this._cleanup = [];
    this._timers = new Set();
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

      this._resetRenderResources();
      this._injectStyles();
      this.prepareContainer(container);
      container.classList.add(CONFIG.CLASS_NAMES.CONTAINER, 'output-renderer-surface');
      container.setAttribute('role', 'region');
      container.setAttribute('aria-label', 'Markdown output');

      // Render markdown → sanitized HTML via shared renderer
      const safeHtml = this.sharedRenderer.render(markdown, { sanitize: true, profile: 'markdown' });
      
      let wrapper = container.querySelector('.markdown-content[data-renderer="markdown"]');
      let isNewWrapper = false;
      if (!wrapper) {
        this._resetRenderResources();
        this._injectStyles();
        this.prepareContainer(container);
        container.classList.add(CONFIG.CLASS_NAMES.CONTAINER, 'output-renderer-surface');
        container.setAttribute('role', 'region');
        container.setAttribute('aria-label', 'Markdown output');

        wrapper = document.createElement('div');
        wrapper.className = `${CONFIG.CLASS_NAMES.CONTENT} output-rich-content`;
        wrapper.setAttribute('data-renderer', 'markdown');
        container.appendChild(wrapper);
        isNewWrapper = true;
      } else {
        // We do NOT call _resetRenderResources() here because morphdom preserves nodes
        // and we want to preserve their attached event listeners.
      }

      // Phase 2: Incremental DOM Morphing
      if (isNewWrapper || !morphdom) {
        wrapper.innerHTML = safeHtml;
        this._enhanceWrapperNodes(wrapper);
      } else {
        // Create an off-screen node to hold the new HTML
        const tempNode = document.createElement('div');
        tempNode.className = `${CONFIG.CLASS_NAMES.CONTENT} output-rich-content`;
        tempNode.setAttribute('data-renderer', 'markdown');
        tempNode.innerHTML = safeHtml;
        
        // Morph the existing wrapper into the tempNode
        morphdom(wrapper, tempNode, {
          onBeforeElUpdated: function(fromEl, toEl) {
            // Preserve the copy button container if it exists
            if (fromEl.tagName === 'PRE' && fromEl.querySelector(`.${CONFIG.CLASS_NAMES.CODE_COPY_BTN}`)) {
              // Copy over the dataset so we don't re-highlight
              if (fromEl.querySelector('code')) {
                const toCode = toEl.querySelector('code');
                const fromCode = fromEl.querySelector('code');
                if (toCode && fromCode && fromCode.dataset.highlighted) {
                   toCode.dataset.highlighted = fromCode.dataset.highlighted;
                }
              }
            }
            return true;
          },
          onNodeAdded: (node) => {
            // If it's a completely new PRE node, we'll catch it in _enhanceWrapperNodes
            return node;
          }
        });
        
        // Enhance any new nodes that were morphed in
        this._enhanceWrapperNodes(wrapper);
      }

      // Telemetry can be emitted by outer layers; avoid chatty logs here

    } catch (error) {
      this.log.error('[MarkdownRenderer] Render failed:', error);
      this.handleError(container, error, 'Failed to render markdown');
    }
  }

  _enhanceWrapperNodes(wrapper) {
    // Syntax highlight code blocks (idempotent)
    try {
      if (this.hljs) {
        wrapper.querySelectorAll('pre code').forEach((block) => {
          if (block && block.dataset && block.dataset.highlighted === 'yes') {
            return;
          }
          this.hljs.highlightElement(block);
        });
      }
    } catch (e) { this.log.trace('[MarkdownRenderer] link processing error:', e?.message); }

    // Enhance code blocks with copy buttons
    this._attachCopyButtons(wrapper);
  }

  _loadLibraries() {
    try {
      if (typeof window !== 'undefined') {
        if (window.marked) {
          this.marked = window.marked;
        } else if (getAether()?.marked) {
          this.marked = getAether().marked;
        }
      }
      if (!this.marked) {
        try {
          const mod = require('marked');
          this.marked = (mod && (mod.marked || mod)) || null;
        } catch (e) { this.log.trace('[MarkdownRenderer] failed to load marked:', e?.message); }
      }

      if (typeof window !== 'undefined') {
        if (window.hljs) {
          this.hljs = window.hljs;
        } else if (getAether()?.hljs) {
          this.hljs = getAether().hljs;
        }
      }
      if (!this.hljs) {
        try {
          this.hljs = require('highlight.js');
        } catch (e) { this.log.trace('[MarkdownRenderer] failed to load highlight.js:', e?.message); }
      }
    } catch (error) {
      this.log.error('[MarkdownRenderer] Failed to load libraries:', error);
    }
  }

  _attachCopyButtons(wrapper) {
    try {
      const pres = wrapper.querySelectorAll('pre');
      pres.forEach((pre) => {
        // Skip if button already attached
        if (pre.querySelector(`.${CONFIG.CLASS_NAMES.CODE_COPY_BTN}`)) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = CONFIG.CLASS_NAMES.CODE_COPY_BTN;
        btn.setAttribute('aria-label', 'Copy code to clipboard');
        btn.textContent = 'Copy';
        const onClick = async () => {
          try {
            const codeEl = pre.querySelector('code');
            const text = codeEl ? codeEl.textContent || '' : pre.textContent || '';
            await navigator.clipboard.writeText(text);
            btn.textContent = 'Copied';
            this._trackTimer(() => { btn.textContent = 'Copy'; }, 1200);
          } catch (e) {
            this.log.trace('[MarkdownRenderer] copy to clipboard failed:', e?.message);
            btn.textContent = 'Failed';
            this._trackTimer(() => { btn.textContent = 'Copy'; }, 1200);
          }
        };
        btn.addEventListener('click', onClick);
        this._cleanup.push(() => btn.removeEventListener('click', onClick));
        pre.appendChild(btn);
      });
    } catch (e) { this.log.trace('[MarkdownRenderer] copy button error:', e?.message); }
  }

  _trackTimer(fn, ms) {
    const id = setTimeout(() => {
      this._timers.delete(id);
      fn();
    }, ms);
    this._timers.add(id);
    return id;
  }

  _resetRenderResources() {
    for (const fn of this._cleanup) {
      try { fn(); } catch (e) { this.log.trace('[MarkdownRenderer] cleanup error:', e?.message); }
    }
    this._cleanup = [];

    for (const id of this._timers) {
      clearTimeout(id);
    }
    this._timers.clear();
  }

  _injectStyles() {
    const styleId = 'markdown-renderer-styles';
    const styles = `
      :root {
        --md-bg: var(--artifacts-output-bg);
        --md-fg: var(--color-text-primary);
        --md-muted: var(--color-text-secondary);
        --md-code-bg: var(--artifacts-code-bg);
        --md-border: var(--color-border-base);
        --md-accent: var(--color-accent);
      }
      .${CONFIG.CLASS_NAMES.CONTAINER} {
        background: transparent;
        color: var(--md-fg);
      }
      .${CONFIG.CLASS_NAMES.CONTENT} {
        max-width: 100%;
      }
      .${CONFIG.CLASS_NAMES.CONTENT} h1,
      .${CONFIG.CLASS_NAMES.CONTENT} h2,
      .${CONFIG.CLASS_NAMES.CONTENT} h3,
      .${CONFIG.CLASS_NAMES.CONTENT} h4,
      .${CONFIG.CLASS_NAMES.CONTENT} h5,
      .${CONFIG.CLASS_NAMES.CONTENT} h6 {
        margin-top: 16px;
        margin-bottom: 8px;
        font-weight: var(--font-weight-semibold);
        line-height: 1.3;
      }
      .${CONFIG.CLASS_NAMES.CONTENT} h1:first-child,
      .${CONFIG.CLASS_NAMES.CONTENT} h2:first-child,
      .${CONFIG.CLASS_NAMES.CONTENT} h3:first-child,
      .${CONFIG.CLASS_NAMES.CONTENT} h4:first-child,
      .${CONFIG.CLASS_NAMES.CONTENT} h5:first-child,
      .${CONFIG.CLASS_NAMES.CONTENT} h6:first-child {
        margin-top: 0;
      }
      .${CONFIG.CLASS_NAMES.CONTENT} p {
        margin: 8px 0;
        line-height: 1.5;
      }
      .${CONFIG.CLASS_NAMES.CONTENT} p:first-child {
        margin-top: 0;
      }
      .${CONFIG.CLASS_NAMES.CONTENT} p:last-child {
        margin-bottom: 0;
      }
      .${CONFIG.CLASS_NAMES.CONTENT} a {
        color: var(--md-accent);
        text-decoration: none;
      }
      .${CONFIG.CLASS_NAMES.CONTENT} a:hover {
        text-decoration: underline;
      }
      .${CONFIG.CLASS_NAMES.CONTENT} code {
        padding: 2px 6px;
        background: var(--md-code-bg);
        border: 1px solid var(--md-border);
        border-radius: var(--radius-sm);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        font-size: var(--font-size-sm);
      }
      .${CONFIG.CLASS_NAMES.CONTENT} ul,
      .${CONFIG.CLASS_NAMES.CONTENT} ol {
        margin: 10px 0;
        padding-left: 1.6em;
        line-height: 1.45;
      }
      .${CONFIG.CLASS_NAMES.CONTENT} li {
        margin: 3px 0;
        line-height: 1.45;
      }
      .${CONFIG.CLASS_NAMES.CONTENT} li:first-child {
        margin-top: 0;
      }
      .${CONFIG.CLASS_NAMES.CONTENT} li:last-child {
        margin-bottom: 0;
      }
      .${CONFIG.CLASS_NAMES.CONTENT} blockquote {
        margin: 12px 0;
        padding-left: 12px;
        border-left: 3px solid var(--md-border);
        color: var(--md-muted);
        font-style: italic;
        line-height: 1.5;
      }
      .${CONFIG.CLASS_NAMES.CONTENT} pre {
        position: relative;
        padding: 14px 16px;
        background: var(--md-code-bg);
        color: var(--md-fg);
        border: 1px solid var(--md-border);
        border-radius: var(--radius-md);
        margin: 12px 0;
        line-height: 1.4;
      }
      .${CONFIG.CLASS_NAMES.CONTENT} pre code {
        background: transparent;
        padding: 0;
        display: block;
        white-space: pre;
        line-height: 1.4;
      }
      .${CONFIG.CLASS_NAMES.CONTENT}.wrap-lines pre code {
        white-space: pre-wrap;
        word-break: break-word;
      }
      .${CONFIG.CLASS_NAMES.CODE_COPY_BTN} {
        position: absolute;
        top: 8px;
        right: 8px;
        padding: 4px 8px;
        font-size: var(--font-size-xs);
        color: var(--md-fg);
        background: var(--color-surface-base);
        border: 1px solid var(--md-border);
        border-radius: var(--radius-sm);
        cursor: pointer;
      }
      .${CONFIG.CLASS_NAMES.CODE_COPY_BTN}:hover {
        background: var(--color-surface-hover);
      }
      .${CONFIG.CLASS_NAMES.CONTENT} li > ul,
      .${CONFIG.CLASS_NAMES.CONTENT} li > ol {
        margin: 4px 0;
      }
      .${CONFIG.CLASS_NAMES.CONTENT} li li {
        margin: 2px 0;
      }
      .${CONFIG.CLASS_NAMES.CONTENT} li p {
        margin: 4px 0;
      }
      .${CONFIG.CLASS_NAMES.CONTENT} li > p:only-child {
        margin: 0;
      }
      .${CONFIG.CLASS_NAMES.CONTENT} hr {
        border: none;
        border-top: 1px solid var(--md-border);
        margin: 16px 0;
      }
      .${CONFIG.CLASS_NAMES.CONTENT} strong {
        font-weight: var(--font-weight-semibold);
      }
      .${CONFIG.CLASS_NAMES.CONTENT} em {
        font-style: italic;
      }
      .${CONFIG.CLASS_NAMES.CONTENT} > *:first-child {
        margin-top: 0 !important;
      }
      .${CONFIG.CLASS_NAMES.CONTENT} > *:last-child {
        margin-bottom: 0 !important;
      }
      .${CONFIG.CLASS_NAMES.CONTENT} table {
        width: 100%;
        border-collapse: collapse;
        margin: 14px 0;
        font-size: var(--font-size-sm);
        line-height: 1.5;
        border: 1px solid var(--md-border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .${CONFIG.CLASS_NAMES.CONTENT} thead {
        background: rgba(255, 255, 255, 0.04);
      }
      .${CONFIG.CLASS_NAMES.CONTENT} th {
        padding: 10px 14px;
        text-align: left;
        font-weight: var(--font-weight-semibold);
        color: var(--md-fg);
        border-bottom: 2px solid var(--md-border);
        white-space: nowrap;
      }
      .${CONFIG.CLASS_NAMES.CONTENT} td {
        padding: 8px 14px;
        border-bottom: 1px solid var(--md-border);
        color: var(--md-fg);
        vertical-align: top;
      }
      .${CONFIG.CLASS_NAMES.CONTENT} tr:last-child td {
        border-bottom: none;
      }
      .${CONFIG.CLASS_NAMES.CONTENT} tr:hover {
        background: rgba(255, 255, 255, 0.03);
      }
      .${CONFIG.CLASS_NAMES.CONTENT} img {
        max-width: 100%;
        height: auto;
        border-radius: var(--radius-md);
        margin: 10px 0;
      }
    `;
    this.injectStyles(styleId, styles);
  }

  dispose() {
    if (this._isDisposed) return; // Guard before own cleanup
    try {
      this._resetRenderResources();
      // BUG MR-1 FIX: Release library references for GC
      this.sharedRenderer = null;
      this.marked = null;
      this.hljs = null;
    } finally {
      super.dispose();
    }
  }
}

module.exports = MarkdownRenderer;

if (typeof window !== 'undefined') {
  window.MarkdownRenderer = MarkdownRenderer;
  // Avoid noisy logs in production
}
