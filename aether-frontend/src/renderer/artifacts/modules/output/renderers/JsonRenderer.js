'use strict';

/**
 * @.architecture
 *
 * Incoming: OutputViewer.render() → JSON string or object --- {artifact_types.console_output, json}
 * Processing: Parse JSON, detect data shape (card/table/list), render as clean visual elements --- {3 jobs: JOB_PARSE, JOB_DETECT_SHAPE, JOB_RENDER_VISUAL}
 * Outgoing: DOM (premium card/table/list layout, zero raw JSON) --- {HTMLElement}
 *
 * Renders JSON as consumer-friendly visual content:
 *   - Flat objects → key-value cards (label: value rows)
 *   - Arrays of similar objects → clean tables
 *   - Arrays of primitives → tag pills
 *   - Nested objects → sectioned cards with block-level sub-content
 *   - Primitives → styled inline text
 * Falls back to json-formatter-js tree ONLY if smart rendering throws.
 *
 * @module renderer/artifacts/modules/output/renderers/JsonRenderer
 */

const BaseRenderer = require('./BaseRenderer');
const { createRendererLogger } = require('../../../../shared/utils/logger');

const _jfModule = require('json-formatter-js');
const JSONFormatter = _jfModule.default || _jfModule;

const _log = createRendererLogger('JsonRenderer');

const LIMITS = Object.freeze({
  MAX_DEPTH: 4,
  MAX_TABLE_ROWS: 100,
  MAX_TABLE_COLS: 10,
  MAX_STRING_DISPLAY: 500,
  MAX_CELL_STRING: 120,
  MAX_INLINE_ARRAY: 5,
  TABULAR_THRESHOLD: 0.8,
});

const UPPER_WORDS = new Set([
  'id', 'url', 'html', 'css', 'api', 'ip', 'ui', 'ux', 'os',
  'cpu', 'gpu', 'ram', 'dns', 'ssl', 'tls', 'http', 'https', 'sql',
]);

class JsonRenderer extends BaseRenderer {
  constructor(options = {}) {
    super(options);
  }

  /**
   * Render JSON data as clean visual content.
   * @param {string|Object} data - JSON string or object
   * @param {HTMLElement} container - Container element
   */
  async render(data, container) {
    try {
      let json;
      let isInvalidJson = false;
      if (typeof data === 'string') {
        try { 
          json = JSON.parse(data); 
        } catch (_) { 
          // Try Python dict fix
          try {
            let fixed = data.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (match, p1) => {
              return '"' + p1.replace(/"/g, '\\"') + '"';
            });
            fixed = fixed.replace(/\bTrue\b/g, 'true')
                         .replace(/\bFalse\b/g, 'false')
                         .replace(/\bNone\b/g, 'null');
            // Basic sanitization for unescaped newlines just in case
            let inString = false; let isEscaped = false; let sanitized = '';
            for (let i = 0; i < fixed.length; i++) {
              const char = fixed[i];
              if (inString) {
                if (char === '\n') sanitized += '\\n';
                else if (char === '\r') sanitized += '\\r';
                else if (char === '\t') sanitized += '\\t';
                else if (char === '\\') { isEscaped = !isEscaped; sanitized += char; }
                else if (char === '"' && !isEscaped) { inString = false; sanitized += char; }
                else { isEscaped = false; sanitized += char; }
              } else {
                if (char === '"') inString = true;
                sanitized += char;
              }
            }
            json = JSON.parse(sanitized);
          } catch(__) {
            json = data; isInvalidJson = true; 
          }
        }
      } else {
        json = data;
      }

      if (json === null || json === undefined) {
        this.prepareContainer(container);
        container.appendChild(this.createEmptyMessage('No data to display'));
        return;
      }

      this._injectCleanStyles();
      this.prepareContainer(container);
      // Reset fallback class from prior failed renders.
      container.classList.remove('json-renderer-container');
      container.classList.add('jc-container', 'output-renderer-surface');

      if (isInvalidJson) {
        const pre = document.createElement('pre');
        pre.className = 'jc-compact';
        pre.style.maxHeight = 'none'; // Show full content without scrolling limit
        pre.style.whiteSpace = 'pre-wrap';
        pre.style.wordBreak = 'break-word';
        pre.textContent = json;
        container.appendChild(pre);
        this.log.debug('[JsonRenderer] Rendered invalid JSON string without truncation');
        return;
      }

      try {
        const el = this._renderValue(json, 0);
        container.appendChild(el);
      } catch (smartErr) {
        this.log.warn('[JsonRenderer] Visual render failed, using tree fallback:', smartErr);
        container.innerHTML = '';
        this._injectTreeStyles();
        container.classList.remove('jc-container', 'output-renderer-surface');
        container.classList.add('json-renderer-container');
        const formatter = new JSONFormatter(json, 2, {
          hoverPreviewEnabled: true, animateOpen: true,
          animateClose: false, theme: 'aether', useToJSON: true,
        });
        container.appendChild(formatter.render());
      }

      this.log.debug('[JsonRenderer] Rendered JSON data');
    } catch (error) {
      this.log.error('[JsonRenderer] Render failed:', error);
      this.handleError(container, error, 'Unable to display this content');
    }
  }

  // ── Shape-based dispatch ──────────────────────────────────────────

  _renderValue(data, depth) {
    if (data === null || data === undefined) return this._span('—', 'jc-null');
    if (typeof data === 'string') return this._renderString(data);
    if (typeof data === 'number') return this._span(this._formatNumber(data), 'jc-number');
    if (typeof data === 'boolean') return this._span(data ? 'Yes' : 'No', data ? 'jc-yes' : 'jc-no');

    if (depth >= LIMITS.MAX_DEPTH) return this._renderCompact(data);

    if (Array.isArray(data)) {
      if (data.length === 0) return this._span('Empty list', 'jc-null');
      if (data.every(v => typeof v !== 'object' || v === null)) return this._renderTagList(data);
      if (this._isTabular(data)) return this._renderTable(data);
      return this._renderCardList(data, depth);
    }

    const keys = Object.keys(data);
    if (keys.length === 0) return this._span('Empty', 'jc-null');
    return this._renderCard(data, depth);
  }

  // ── Primitive helpers ─────────────────────────────────────────────

  _span(text, cls) {
    const el = document.createElement('span');
    if (cls) el.className = cls;
    el.textContent = text;
    return el;
  }

  _formatNumber(n) {
    if (Number.isInteger(n) && Math.abs(n) >= 1000) {
      return n.toLocaleString();
    }
    return String(n);
  }

  _renderString(str) {
    if (this._isUrl(str)) {
      const a = document.createElement('a');
      a.className = 'jc-link output-link';
      a.href = str;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      try {
        const u = new URL(str);
        a.textContent = u.hostname + (u.pathname !== '/' ? u.pathname : '');
      } catch (_) { a.textContent = str; }
      a.title = str;
      return a;
    }
    if (str.length > LIMITS.MAX_STRING_DISPLAY) {
      const el = this._span(str.slice(0, LIMITS.MAX_STRING_DISPLAY) + '\u2026', 'jc-string');
      el.title = str;
      return el;
    }
    return this._span(str, 'jc-string');
  }

  // ── Card (object → labeled rows) ─────────────────────────────────

  _renderCard(obj, depth) {
    const card = document.createElement('div');
    card.className = 'jc-card output-card';
    if (depth > 0) card.classList.add('jc-card-nested', 'output-card-muted');

    for (const [key, value] of Object.entries(obj)) {
      if (this._isInline(value)) {
        const row = document.createElement('div');
        row.className = 'jc-row';

        const label = document.createElement('div');
        label.className = 'jc-label';
        label.textContent = this._humanize(key);
        row.appendChild(label);

        const val = document.createElement('div');
        val.className = 'jc-val';
        val.appendChild(this._renderInline(value));
        row.appendChild(val);

        card.appendChild(row);
      } else {
        const section = document.createElement('div');
        section.className = 'jc-section output-section';

        const header = document.createElement('div');
        header.className = 'jc-section-hdr';
        header.textContent = this._humanize(key);
        section.appendChild(header);

        const content = document.createElement('div');
        content.className = 'jc-section-body';
        content.appendChild(this._renderValue(value, depth + 1));
        section.appendChild(content);

        card.appendChild(section);
      }
    }

    return card;
  }

  _renderInline(value) {
    if (value === null || value === undefined) return this._span('—', 'jc-null');
    if (typeof value === 'boolean') return this._span(value ? 'Yes' : 'No', value ? 'jc-yes' : 'jc-no');
    if (typeof value === 'number') return this._span(this._formatNumber(value), 'jc-number');
    if (typeof value === 'string') return this._renderString(value);
    if (Array.isArray(value)) {
      const text = value.map(v => v === null ? '—' : String(v)).join(', ');
      return this._span(text, 'jc-string');
    }
    return this._span(JSON.stringify(value), 'jc-string');
  }

  // ── Table (array of similar objects) ──────────────────────────────

  _renderTable(array) {
    const wrapper = document.createElement('div');
    wrapper.className = 'jc-table-wrap output-table-wrap';

    const table = document.createElement('table');
    table.className = 'jc-table output-table';

    const allKeys = Object.keys(array[0]);
    const keys = allKeys.slice(0, LIMITS.MAX_TABLE_COLS);

    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const k of keys) {
      const th = document.createElement('th');
      th.textContent = this._humanize(k);
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const rows = array.slice(0, LIMITS.MAX_TABLE_ROWS);
    for (const item of rows) {
      const tr = document.createElement('tr');
      for (const k of keys) {
        const td = document.createElement('td');
        td.appendChild(this._renderCell(item[k]));
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrapper.appendChild(table);

    const parts = [];
    if (array.length > LIMITS.MAX_TABLE_ROWS) {
      parts.push(`${rows.length} of ${array.length} rows`);
    }
    if (allKeys.length > LIMITS.MAX_TABLE_COLS) {
      parts.push(`${keys.length} of ${allKeys.length} columns`);
    }
    if (parts.length > 0) {
      const note = document.createElement('div');
      note.className = 'jc-note output-note';
      note.textContent = 'Showing ' + parts.join(', ');
      wrapper.appendChild(note);
    }

    return wrapper;
  }

  _renderCell(val) {
    if (val === null || val === undefined) return this._span('—', 'jc-null');
    if (typeof val === 'boolean') return this._span(val ? 'Yes' : 'No', val ? 'jc-yes' : 'jc-no');
    if (typeof val === 'number') return this._span(this._formatNumber(val), 'jc-number');
    if (typeof val === 'string') {
      if (this._isUrl(val)) return this._renderString(val);
      if (val.length > LIMITS.MAX_CELL_STRING) {
        const el = this._span(val.slice(0, LIMITS.MAX_CELL_STRING) + '\u2026', 'jc-string');
        el.title = val;
        return el;
      }
      return this._span(val, 'jc-string');
    }
    if (Array.isArray(val)) {
      if (val.every(v => typeof v !== 'object' || v === null)) {
        return this._span(val.join(', '), 'jc-string');
      }
      return this._span(val.length + ' item' + (val.length !== 1 ? 's' : ''), 'jc-null');
    }
    if (typeof val === 'object') {
      const n = Object.keys(val).length;
      return this._span(n + ' field' + (n !== 1 ? 's' : ''), 'jc-null');
    }
    return this._span(String(val));
  }

  // ── Tag list (array of primitives) ────────────────────────────────

  _renderTagList(array) {
    const wrap = document.createElement('div');
    wrap.className = 'jc-tags output-pill-list';
    for (const item of array) {
      const tag = document.createElement('span');
      tag.className = 'jc-tag output-pill';
      tag.textContent = item === null ? '—' : String(item);
      wrap.appendChild(tag);
    }
    return wrap;
  }

  // ── Card list (array of different objects) ────────────────────────

  _renderCardList(array, depth) {
    const wrap = document.createElement('div');
    wrap.className = 'jc-card-list';

    const items = array.slice(0, LIMITS.MAX_TABLE_ROWS);
    for (let i = 0; i < items.length; i++) {
      const row = document.createElement('div');
      row.className = 'jc-card-list-item';

      const badge = document.createElement('span');
      badge.className = 'jc-card-list-badge';
      badge.textContent = String(i + 1);
      row.appendChild(badge);

      const content = document.createElement('div');
      content.className = 'jc-card-list-body';
      content.appendChild(this._renderValue(items[i], depth + 1));
      row.appendChild(content);

      wrap.appendChild(row);
    }

    if (array.length > LIMITS.MAX_TABLE_ROWS) {
      const note = document.createElement('div');
      note.className = 'jc-note output-note';
      note.textContent = 'Showing ' + items.length + ' of ' + array.length + ' items';
      wrap.appendChild(note);
    }

    return wrap;
  }

  // ── Compact (depth exceeded) ──────────────────────────────────────

  _renderCompact(data) {
    const str = JSON.stringify(data, null, 2);
    const display = str.length > LIMITS.MAX_STRING_DISPLAY
      ? str.slice(0, LIMITS.MAX_STRING_DISPLAY) + '\u2026'
      : str;
    const pre = document.createElement('pre');
    pre.className = 'jc-compact';
    pre.textContent = display;
    if (str.length > LIMITS.MAX_STRING_DISPLAY) {
      pre.title = 'Content truncated for display';
    }
    return pre;
  }

  // ── Detection helpers ─────────────────────────────────────────────

  _isInline(value) {
    if (value === null || value === undefined) return true;
    if (typeof value !== 'object') return true;
    if (Array.isArray(value) &&
      value.length <= LIMITS.MAX_INLINE_ARRAY &&
      value.every(v => typeof v !== 'object' || v === null)) {
      return true;
    }
    return false;
  }

  _isTabular(array) {
    if (!Array.isArray(array) || array.length === 0) return false;
    const first = array[0];
    if (!first || typeof first !== 'object' || Array.isArray(first)) return false;
    const refKeys = Object.keys(first).sort().join('\0');
    if (!refKeys) return false;
    let matching = 0;
    for (const item of array) {
      if (item && typeof item === 'object' && !Array.isArray(item) &&
        Object.keys(item).sort().join('\0') === refKeys) {
        matching++;
      }
    }
    return (matching / array.length) >= LIMITS.TABULAR_THRESHOLD;
  }

  _isUrl(str) {
    return typeof str === 'string' && /^(https?|file):\/\/.+/i.test(str);
  }

  _humanize(key) {
    return key
      .replace(/_/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .split(' ')
      .map(w => {
        const low = w.toLowerCase();
        if (UPPER_WORDS.has(low)) return w.toUpperCase();
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      })
      .join(' ');
  }

  // ── Styles ────────────────────────────────────────────────────────

  _injectCleanStyles() {
    this.injectStyles('jc-clean-styles', `
      .jc-container {
        padding: var(--spacing-md);
        font-family: var(--font-family-base, system-ui, -apple-system, sans-serif);
        font-size: var(--font-size-sm);
        line-height: 1.5;
        overflow: auto;
      }

      /* ── Card ── */
      .jc-card {
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: var(--radius-lg, 10px);
        overflow: hidden;
      }
      .jc-card-nested {
        background: rgba(255, 255, 255, 0.02);
        margin: 2px 0;
      }
      .jc-row {
        display: flex;
        padding: 10px 16px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.04);
        gap: 16px;
        align-items: baseline;
      }
      .jc-row:last-child { border-bottom: none; }
      .jc-label {
        flex: 0 0 clamp(100px, 30%, 200px);
        color: var(--color-text-secondary, #999);
        font-weight: var(--font-weight-medium, 500);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .jc-val {
        flex: 1;
        color: var(--color-text-primary, #e8e8e8);
        word-break: break-word;
        min-width: 0;
      }

      /* ── Section (block-level nested) ── */
      .jc-section {
        border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      }
      .jc-section:last-child { border-bottom: none; }
      .jc-section-hdr {
        padding: 10px 16px 6px;
        color: var(--color-text-secondary, #999);
        font-weight: var(--font-weight-semibold, 600);
        font-size: var(--font-size-xs, 12px);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .jc-section-body {
        padding: 0 16px 10px;
      }

      /* ── Table ── */
      .jc-table-wrap {
        overflow-x: auto;
        border-radius: var(--radius-lg, 10px);
        border: 1px solid rgba(255, 255, 255, 0.06);
      }
      .jc-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--font-size-sm);
      }
      .jc-table th {
        background: rgba(255, 255, 255, 0.05);
        padding: 10px 14px;
        text-align: left;
        font-weight: var(--font-weight-semibold, 600);
        color: var(--color-text-secondary, #999);
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        white-space: nowrap;
      }
      .jc-table td {
        padding: 10px 14px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.04);
        color: var(--color-text-primary, #e8e8e8);
        max-width: 300px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .jc-table tr:last-child td { border-bottom: none; }
      .jc-table tbody tr:hover {
        background: rgba(255, 255, 255, 0.03);
      }
      .jc-note {
        padding: 8px 14px;
        font-size: var(--font-size-xs, 12px);
        color: var(--color-text-tertiary, #666);
        text-align: center;
        border-top: 1px solid rgba(255, 255, 255, 0.04);
      }

      /* ── Tags ── */
      .jc-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .jc-tag {
        display: inline-block;
        padding: 4px 12px;
        background: rgba(255, 255, 255, 0.06);
        border-radius: var(--radius-full, 999px);
        font-size: var(--font-size-sm);
        color: var(--color-text-primary, #e8e8e8);
      }

      /* ── Card list ── */
      .jc-card-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm, 8px);
      }
      .jc-card-list-item {
        display: flex;
        gap: 12px;
        align-items: flex-start;
      }
      .jc-card-list-badge {
        flex: 0 0 28px;
        height: 28px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(255, 255, 255, 0.06);
        border-radius: var(--radius-full, 999px);
        font-size: var(--font-size-xs, 12px);
        color: var(--color-text-secondary, #999);
        font-weight: var(--font-weight-semibold, 600);
        margin-top: 4px;
      }
      .jc-card-list-body {
        flex: 1;
        min-width: 0;
      }

      /* ── Compact fallback ── */
      .jc-compact {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: var(--font-size-xs, 12px);
        color: var(--color-text-secondary, #999);
        padding: 10px 14px;
        background: rgba(255, 255, 255, 0.02);
        border-radius: var(--radius-md, 6px);
        white-space: pre-wrap;
        word-break: break-all;
        overflow: auto;
        max-height: 200px;
      }

      /* ── Value type colors ── */
      .jc-null { color: var(--color-text-tertiary, #666); font-style: italic; }
      .jc-number { color: var(--code-number, #b5cea8); }
      .jc-yes { color: var(--color-success, #4ec9b0); font-weight: var(--font-weight-medium, 500); }
      .jc-no { color: var(--color-text-tertiary, #666); }
      .jc-string { color: var(--color-text-primary, #e8e8e8); }
      .jc-link {
        color: var(--color-accent, #6eb0f7);
        text-decoration: none;
      }
      .jc-link:hover { text-decoration: underline; opacity: 0.85; }
    `);
  }

  /**
   * Inject json-formatter-js Aether theme CSS (tree fallback only).
   * @private
   */
  _injectTreeStyles() {
    const T = 'json-formatter-aether';
    this.injectStyles('jc-tree-styles', `
      .json-renderer-container {
        padding: 0;
        background: var(--artifacts-code-bg);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: var(--font-size-sm);
        line-height: 1.65;
        overflow: auto;
      }
      .${T}.json-formatter-row { font-family: inherit; margin-left: 0; }
      .${T} .json-formatter-row { margin-left: 0; }
      .${T} .json-formatter-row > a,
      .${T} .json-formatter-row > a:hover { text-decoration: none; color: inherit; }
      .${T} .json-formatter-row > a > .json-formatter-arrow {
        display: inline-block; width: 14px; text-align: center; font-size: 10px;
        vertical-align: middle; transition: transform 0.1s ease;
      }
      .${T} .json-formatter-row > a > .json-formatter-arrow::after {
        content: '\\25B6'; color: var(--color-text-tertiary); transition: color 0.15s ease;
      }
      .${T} .json-formatter-row.json-formatter-open > a > .json-formatter-arrow::after { content: '\\25BC'; }
      .${T} .json-formatter-row > a:hover > .json-formatter-arrow::after { color: var(--color-accent); }
      .${T} .json-formatter-row > a > .json-formatter-preview-text {
        opacity: 0; transition: opacity 0.15s ease; font-style: italic; color: var(--color-text-tertiary);
      }
      .${T} .json-formatter-row:hover > a > .json-formatter-preview-text { opacity: 0.6; }
      .${T} .json-formatter-children {
        padding-left: 20px; border-left: 1px solid rgba(255, 255, 255, 0.06); margin-left: 4px;
      }
      .${T} .json-formatter-children.json-formatter-empty { opacity: 0.5; margin-left: 14px; }
      .${T} .json-formatter-children.json-formatter-empty::after { display: none; }
      .${T} .json-formatter-key { color: var(--code-param); }
      .${T} .json-formatter-colon { color: var(--code-operator); }
      .${T} .json-formatter-bracket { color: var(--code-operator); }
      .${T} .json-formatter-string { color: var(--code-string); word-break: break-all; white-space: pre-wrap; }
      .${T} .json-formatter-number { color: var(--code-number); }
      .${T} .json-formatter-boolean { color: var(--code-builtin); }
      .${T} .json-formatter-null { color: var(--code-builtin); font-style: italic; }
      .${T} .json-formatter-undefined { color: var(--code-builtin); font-style: italic; }
      .${T} .json-formatter-function { color: var(--code-builtin); font-style: italic; }
      .${T} .json-formatter-date { color: var(--code-string); }
      .${T} .json-formatter-url { color: var(--color-accent); text-decoration: none; }
      .${T} .json-formatter-url:hover { text-decoration: underline; opacity: 0.85; }
    `);
  }

  /**
   * Dispose renderer.
   * DOM-constructed elements are GC'd when prepareContainer clears on re-render.
   */
  dispose() {
    if (this._isDisposed) return;
    super.dispose();
  }
}

module.exports = JsonRenderer;

if (typeof window !== 'undefined') {
  window.JsonRenderer = JsonRenderer;
  _log.debug('JsonRenderer loaded');
}
