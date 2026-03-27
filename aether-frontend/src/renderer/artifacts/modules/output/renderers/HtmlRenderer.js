'use strict';

/**
 * @.architecture
 * Incoming: renderer/artifacts/modules/output/OutputViewer.js --- {event.custom, json}
 * Processing: Sanitize HTML and render (iframe sandbox or direct wrapper) --- {4 jobs: JOB_CREATE_WRAPPER, JOB_CREATE_DOM_ELEMENT, JOB_SANITIZE_MARKDOWN, JOB_UPDATE_DOM_ELEMENT}
 * Outgoing: renderer/artifacts/modules/output/OutputViewer.js --- {dom.artifact_panel, HTMLElement}
 */

const BaseRenderer = require('./BaseRenderer');
const { createRendererLogger } = require('../../../../shared/utils/logger');
const SecuritySanitizer = require('../../../../shared/security/SecuritySanitizer');
const { freeze } = Object;

// HTML renderer configuration
const CONFIG = freeze({
  IFRAME: freeze({
    SANDBOX: 'allow-scripts allow-forms allow-modals allow-popups allow-presentation',
    STYLE: 'width: 100%; height: 100%; border: none; background: #ffffff;',
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
    this.log = createRendererLogger('HtmlRenderer');
    this._cleanup = [];
    
    this.safeMode = options.safeMode !== false; // Default to safe mode
    this.allowScripts = options.allowScripts === true; // Default to no scripts
    
    // Canonical sanitizer authority for output rendering paths.
    this.sanitizer = this._loadSanitizer();
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

    // Clear container ONLY if not using iframe state persistence
    if (!container.querySelector(`.${CONFIG.CLASS_NAMES.IFRAME}`)) {
      this.prepareContainer(container);
    }

      // Add container class
      container.classList.add(CONFIG.CLASS_NAMES.CONTAINER);

      // Render based on mode
      if (this.safeMode) {
        this._renderInIframe(html, container);
      } else {
        this._renderDirect(html, container);
      }

      this.log.debug('[HtmlRenderer] Rendered HTML content');

    } catch (error) {
      this.log.error('[HtmlRenderer] Render failed:', error);
      this.handleError(container, error, 'Failed to render HTML');
    }
  }

  /**
   * Render HTML in sandboxed iframe.
   *
   * Security model: the iframe sandbox attribute (no allow-same-origin)
   * provides the primary isolation boundary — the iframe cannot access the
   * parent DOM, cookies, localStorage, or any origin-scoped resource.
   * Basic sanitization (strip scripts, event handlers, dangerous URIs) is
   * defense-in-depth. DOMPurify's tag whitelist is NOT used here because it
   * strips <style>, <table>, <form>, SVG, and structural tags, destroying
   * the agent's page layout and CSS.
   *
   * @param {string} html - HTML content
   * @param {HTMLElement} container - Container element
   * @private
   */
  _renderInIframe(html, container) {
    // Canonical output sanitizer in iframe-preserving mode.
    const sanitizedHtml = this.sanitizer
      ? this.sanitizer.sanitizeOutputHtml(html, { mode: 'iframe', allowScripts: this.allowScripts })
      : this._basicSanitize(html);

    // Check if an iframe already exists to persist state
    let iframe = container.querySelector(`.${CONFIG.CLASS_NAMES.IFRAME}`);
    
    if (iframe) {
      // Phase 3: Update existing iframe via postMessage
      if (iframe.contentWindow) {
        iframe.contentWindow.postMessage({
          type: 'iframe-update-content',
          html: sanitizedHtml
        }, '*');
      }
      return;
    }

    // Cleanup previous render listeners
    for (const fn of this._cleanup) {
      try { fn(); } catch (e) { this.log.trace('[HtmlRenderer] cleanup error:', e?.message); }
    }
    this._cleanup = [];

    // Unique ID to tie postMessage back to this specific iframe instance
    const iframeId = `html-iframe-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Auto-resize script + DOM Morphing listener
    // Uses ResizeObserver and MutationObserver instead of hacky timeouts to ensure zero UI jank and instant layout snapping.
    const resizeScript = `<script>(function(){
      var id='${iframeId}';
      var lastH=0;
      function r(){
        if(!document.documentElement)return;
        var h=Math.max(document.body?document.body.scrollHeight:0,document.documentElement.scrollHeight,document.documentElement.offsetHeight);
        if(h!==lastH&&h>0){
          lastH=h;
          window.parent.postMessage({type:'iframe-resize',id:id,height:h},'*');
        }
      }
      function init(){
        if(window.ResizeObserver){
          try{
            new ResizeObserver(r).observe(document.documentElement);
            if(document.body)new ResizeObserver(r).observe(document.body);
          }catch(e){console.warn('Iframe resize observer failed:', e);}
        }
        if(window.MutationObserver){
          try{
            new MutationObserver(r).observe(document.documentElement,{childList:true,subtree:true,attributes:true,characterData:true});
          }catch(e){console.warn('Iframe mutation observer failed:', e);}
        }
        window.addEventListener('resize',r);
        window.addEventListener('load',r);
        r();
      }
      if(document.readyState==='loading'){
        window.addEventListener('DOMContentLoaded',init);
      }else{
        init();
      }
      
      // Phase 3: Listen for content updates to persist state
      window.addEventListener('message', function(e) {
        if(e.data && e.data.type === 'iframe-update-content') {
          // If morphdom was available we'd use it, but since we are in a sandboxed iframe without scripts,
          // we do a direct replacement of body content to simulate the update.
          // Note: Full morphdom would require injecting the morphdom source into the iframe.
          // For now, we update body.innerHTML which is still better than tearing down the whole iframe.
          if(document.body) {
             // Extract body content from the incoming HTML if it's a full document
             var newHtml = e.data.html;
             var bodyMatch = newHtml.match(/<body[^>]*>([\\s\\S]*)<\\/body>/i);
             if(bodyMatch) {
                newHtml = bodyMatch[1];
             }
             // Preserve our script tag
             document.body.innerHTML = newHtml + '\\n' + document.currentScript.outerHTML;
             r(); // Trigger resize check
          }
        }
      });
    })();<\/script>`;

    const fg = this._getThemeValue('--color-text-primary') || '#000000';
    const bg = this._getThemeValue('--artifacts-output-bg') || '#ffffff';
    
    // Base styles injected into the iframe document
    // We use max-content to prevent the "ratchet effect" where the iframe cannot shrink
    const baseStyles = `html{height:max-content;background:transparent;}body{margin:0;padding:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,Cantarell,sans-serif;font-size:14px;line-height:1.6;color:${fg};background:${bg};min-height:max-content;}*{box-sizing:border-box;}`;

    // Detect full HTML documents vs fragments
    const trimmed = sanitizedHtml.trim();
    const isFullDocument = /^<!DOCTYPE\b/i.test(trimmed) || /^<html[\s>]/i.test(trimmed);

    let iframeDoc;
    if (isFullDocument) {
      // Full document: inject base styles into existing <head> and resize
      // script before </body> to avoid invalid nested <html> tags.
      iframeDoc = sanitizedHtml;
      if (/<\/head>/i.test(iframeDoc)) {
        iframeDoc = iframeDoc.replace(/<\/head>/i, `<style>${baseStyles}</style></head>`);
      } else {
        // No </head> — prepend a head block
        iframeDoc = iframeDoc.replace(/(<html[^>]*>)/i, `$1<head><style>${baseStyles}</style></head>`);
      }
      if (/<\/body>/i.test(iframeDoc)) {
        iframeDoc = iframeDoc.replace(/<\/body>/i, `${resizeScript}</body>`);
      } else {
        iframeDoc += resizeScript;
      }
    } else {
      // Fragment: wrap in a full document
      iframeDoc = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>${baseStyles}</style>
</head>
<body>
  ${sanitizedHtml}
  ${resizeScript}
</body>
</html>`;
    }

    // Create iframe with srcdoc (works better with sandbox than doc.write)
    iframe = document.createElement('iframe');
    iframe.className = CONFIG.CLASS_NAMES.IFRAME;
    iframe.setAttribute('sandbox', CONFIG.IFRAME.SANDBOX);
    iframe.setAttribute('srcdoc', iframeDoc);

    // Listen for height messages from this iframe
    const onMessage = (event) => {
      if (event.data && event.data.type === 'iframe-resize' &&
          event.data.id === iframeId && typeof event.data.height === 'number') {
        // Floor at 200px min. We do NOT add a buffer here to prevent infinite resize loops.
        // If we add a buffer (e.g. + 16), the iframe's viewport grows, which increases
        // the scrollHeight inside the iframe, triggering another resize message, ad infinitum.
        iframe.style.height = `${Math.max(Math.ceil(event.data.height), 200)}px`;
      }
    };
    window.addEventListener('message', onMessage);
    this._cleanup.push(() => window.removeEventListener('message', onMessage));

    // Append iframe
    container.appendChild(iframe);

    this.log.debug('[HtmlRenderer] Rendered HTML content in iframe', { isFullDocument });
  }

  /**
   * Render HTML directly (unsafe - use with caution)
   * @param {string} html - HTML content
   * @param {HTMLElement} container - Container element
   * @private
   */
  _renderDirect(html, container) {
    const sanitizedHtml = this.sanitizer
      ? this.sanitizer.sanitizeOutputHtml(html, { mode: 'direct', allowScripts: this.allowScripts })
      : this._basicSanitize(html);

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
   * Basic HTML sanitization for iframe mode.
   * Strips scripts, event handlers, and dangerous URIs while preserving
   * all structural tags, CSS, and attributes needed for clean page rendering.
   * Safe because the iframe sandbox (no allow-same-origin) isolates content.
   * @param {string} html - HTML to sanitize
   * @returns {string}
   * @private
   */
  _basicSanitize(html) {
    if (!this.sanitizer || typeof this.sanitizer.sanitizeOutputHtml !== 'function') {
      return typeof html === 'string' ? html : '';
    }
    return this.sanitizer.sanitizeOutputHtml(html, { mode: 'iframe', allowScripts: this.allowScripts });
  }

  /**
   * Load DOMPurify sanitizer from preload-exposed window.sanitizer
   * @private
   */
  _loadSanitizer() {
    try {
      const sanitizer = new SecuritySanitizer();
      if (!sanitizer.isDOMPurifyAvailable()) {
        this.log.warn('[HtmlRenderer] DOMPurify not available, using SecuritySanitizer output fallback');
      }
      return sanitizer;
    } catch (error) {
      this.log.error('[HtmlRenderer] Failed to initialize sanitizer:', error);
      return {
        sanitizeOutputHtml: (html) => {
          if (!html || typeof html !== 'string') return '';
          return String(html).replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
        }
      };
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
        min-height: 200px;
        overflow: visible;
        background: var(--artifacts-output-bg);
      }

      .${CONFIG.CLASS_NAMES.IFRAME} {
        display: block;
        width: 100%;
        min-height: 200px;
        border: none;
        background: transparent;
      }

      .html-content-wrapper {
        padding: 16px;
        background: var(--artifacts-output-bg);
        color: var(--color-text-primary);
      }

      .${CONFIG.CLASS_NAMES.ERROR} {
        padding: 16px;
        color: var(--color-error);
        background: var(--color-error-bg);
        border: 1px solid var(--color-error-border);
        border-radius: var(--radius-sm);
      }
    `;

    this.injectStyles(styleId, styles);
  }

  /**
   * Dispose renderer
   */
  dispose() {
    if (this._isDisposed) return;
    try {
      for (const fn of this._cleanup) {
        try { fn(); } catch (e) { this.log.trace('[HtmlRenderer] cleanup error:', e?.message); }
      }
      this._cleanup = [];
      this.sanitizer = null;
    } finally {
      super.dispose();
    }
  }

  _getThemeValue(variableName) {
    if (typeof window === 'undefined' || !window.getComputedStyle) {
      return '';
    }
    const value = window.getComputedStyle(document.documentElement).getPropertyValue(variableName);
    return value ? value.trim() : '';
  }
}

// Export
module.exports = HtmlRenderer;

if (typeof window !== 'undefined') {
  window.HtmlRenderer = HtmlRenderer;
}
