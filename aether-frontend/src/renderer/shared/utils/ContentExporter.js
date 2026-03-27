/**
 * @.architecture
 * Incoming: Consumer components (ChatSummaryPanel, ChatSummaryModal, OutputViewer, ResultsViewerDialog, SourceResultDialog) --- {summary_object, findings_block, artifact_content, method_call}
 * Processing: Generate branded HTML for PDF export, invoke IPC for Electron printToPDF, copy text to clipboard --- {3 jobs: JOB_GENERATE_HTML, JOB_IPC_INVOKE, JOB_CLIPBOARD_WRITE}
 * Outgoing: IPC (dialog:save-pdf), clipboard, Toast notifications --- {pdf_file, clipboard_text, toast_notification}
 *
 * ContentExporter - Unified content export utility
 * ============================================================================
 * Single source of truth for PDF export and clipboard copy across all output
 * surfaces. Replaces the former ResultExporter with a generic, multi-format
 * approach while preserving identical branded PDF output.
 *
 * Consumers call static methods directly — no instantiation, no state, no lifecycle.
 */

'use strict';

const { createRendererLogger } = require('./logger');
const Toast = require('../components/Toast');
const SecuritySanitizer = require('../security/SecuritySanitizer');

const log = createRendererLogger('ContentExporter');

class ContentExporter {
  static _sanitizer = null;

  static _getSanitizer() {
    if (ContentExporter._sanitizer) {
      return ContentExporter._sanitizer;
    }
    try {
      ContentExporter._sanitizer = new SecuritySanitizer();
    } catch (error) {
      log.warn('[ContentExporter] SecuritySanitizer unavailable; using string escapes only', {
        error: error?.message,
      });
      ContentExporter._sanitizer = null;
    }
    return ContentExporter._sanitizer;
  }

  static sanitizeOutputHtml(html, options = {}) {
    const sanitizer = this._getSanitizer();
    if (sanitizer && typeof sanitizer.sanitizeOutputHtml === 'function') {
      return sanitizer.sanitizeOutputHtml(html, { mode: 'direct', allowScripts: false, ...options });
    }
    return this.escapeHtml(html);
  }

  static _sanitizeOutputHtml(html, options = {}) {
    return this.sanitizeOutputHtml(html, options);
  }

  // ===========================================================================
  // Core Export Methods
  // ===========================================================================

  /**
   * Export HTML content as PDF via Electron's printToPDF.
   * Shows save dialog, generates PDF, writes file.
   * @param {string} html - Full HTML document string
   * @param {string} filename - Suggested filename (e.g., 'summary.pdf')
   * @returns {Promise<boolean>} true if saved, false if cancelled/failed
   */
  static async exportAsPdf(html, filename) {
    if (!html) {
      log.warn('[ContentExporter] exportAsPdf called with empty html');
      return false;
    }

    try {
      const ipc = typeof window !== 'undefined' && window.aether?.ipc;
      if (!ipc) {
        log.error('[ContentExporter] window.aether.ipc not available');
        Toast.error('Export not available');
        return false;
      }

      Toast.info('Preparing PDF export...');
      log.debug('[ContentExporter] Invoking dialog:save-pdf', { filename });

      const result = await ipc.invoke('dialog:save-pdf', { html, filename });

      if (result.success) {
        Toast.success('PDF exported successfully');
        log.debug('[ContentExporter] PDF saved', { filePath: result.filePath });
        return true;
      }

      // User cancelled — no error toast
      if (result.error === 'Canceled') {
        log.debug('[ContentExporter] PDF export cancelled by user');
        return false;
      }

      Toast.error('PDF export failed');
      log.error('[ContentExporter] PDF export failed', { error: result.error });
      return false;

    } catch (error) {
      Toast.error('PDF export failed');
      log.error('[ContentExporter] PDF export exception:', error);
      return false;
    }
  }

  /**
   * Copy text to clipboard with Toast feedback.
   * @param {string} text - Text to copy
   * @param {string} [label='Content'] - Label for toast message (e.g., 'Summary', 'Results')
   * @returns {Promise<boolean>} true if copied
   */
  static async copyToClipboard(text, label = 'Content') {
    if (!text) {
      log.warn('[ContentExporter] copyToClipboard called with empty text');
      return false;
    }

    try {
      await navigator.clipboard.writeText(text);
      Toast.success(`${label} copied to clipboard`);
      return true;
    } catch (error) {
      log.error('[ContentExporter] Clipboard write failed:', error);
      Toast.error('Failed to copy to clipboard');
      return false;
    }
  }

  // ===========================================================================
  // HTML Generators — Content-Type Specific
  // ===========================================================================

  /**
   * Generate branded HTML for a chat summary.
   * @param {Object} summary - Summary object from backend
   * @param {string} summary.title - Summary title
   * @param {string} summary.summary_text - Narrative summary text
   * @param {Array<string>} summary.key_points - Bulleted key points
   * @param {Object} summary.entities - {entities: {category: [names]}, topics: [strings]}
   * @param {string} summary.created_at - ISO timestamp
   * @param {string} summary.llm_model - Model used
   * @param {Object} [summary.metadata] - Optional metadata (message_count, etc.)
   * @param {string} [chatTitle='Chat'] - Chat title for the header
   * @returns {string} Full HTML document
   */
  static generateSummaryHtml(summary, chatTitle = 'Chat') {
    if (!summary) return '';

    const title = summary.title || chatTitle;
    const summaryText = summary.summary_text || '';
    const keyPoints = Array.isArray(summary.key_points) ? summary.key_points : [];
    const rawEntities = summary.entities || {};
    const categorizedEntities = rawEntities.entities || rawEntities;
    const topics = rawEntities.topics || [];
    const model = summary.llm_model || '';
    const msgCount = summary.metadata?.message_count || '';

    // Build body sections
    let bodyHtml = '';

    // Prose summary
    const prosePart = summaryText.split('\n\n')[0] || '';
    if (prosePart && !prosePart.startsWith('- ')) {
      bodyHtml += `
        <div class="section-label">Summary</div>
        <div class="summary">${this.escapeHtml(prosePart)}</div>
      `;
    }

    // Key points
    if (keyPoints.length > 0) {
      bodyHtml += `
        <div class="section-label">Key Points</div>
        <ul class="key-points">
          ${keyPoints.map(p => `<li>${this.escapeHtml(p)}</li>`).join('')}
        </ul>
      `;
    }

    // Entities
    const entityBadges = [];
    if (categorizedEntities && typeof categorizedEntities === 'object' && !Array.isArray(categorizedEntities)) {
      for (const [category, names] of Object.entries(categorizedEntities)) {
        if (category === 'topics') continue;
        if (Array.isArray(names)) {
          names.forEach(name => {
            entityBadges.push(`<span class="entity-badge">${this.escapeHtml(name)}</span>`);
          });
        }
      }
    }

    if (entityBadges.length > 0) {
      bodyHtml += `
        <div class="section-label">Entities</div>
        <div class="badges-container">${entityBadges.join(' ')}</div>
      `;
    }

    // Topics
    if (Array.isArray(topics) && topics.length > 0) {
      bodyHtml += `
        <div class="section-label">Topics</div>
        <div class="badges-container">
          ${topics.map(t => `<span class="topic-badge">${this.escapeHtml(t)}</span>`).join(' ')}
        </div>
      `;
    }

    // Metadata line
    const metaParts = [];
    if (model) metaParts.push(`Model: ${this.escapeHtml(model)}`);
    if (msgCount) metaParts.push(`${msgCount} messages`);
    if (summary.created_at) {
      metaParts.push(`Generated: ${new Date(summary.created_at).toLocaleString()}`);
    }
    if (metaParts.length > 0) {
      bodyHtml += `<div class="meta-line">${metaParts.join(' &bull; ')}</div>`;
    }

    const subtitle = `Exported from Aether Arena`;
    return this._wrapInBrandedHtml(`Chat Summary: ${this.escapeHtml(title)}`, subtitle, bodyHtml);
  }

  /**
   * Generate branded HTML for agent research findings.
   * Ported from the former ResultExporter — identical output.
   * @param {string} source - Source name (e.g., 'Web', 'Reddit')
   * @param {Object} data - Findings block with .answer and .results/.items/.sources
   * @param {string} [agentName='AI Agent'] - Agent display name
   * @returns {string} Full HTML document
   */
  static generateFindingsHtml(source, data, agentName = 'AI Agent') {
    if (!data) return '';

    const answer = data.answer || '';
    const items = Array.isArray(data.results)
      ? data.results
      : (Array.isArray(data.items) ? data.items : (Array.isArray(data.sources) ? data.sources : []));

    let bodyHtml = '';

    // Executive Summary
    if (answer) {
      bodyHtml += `
        <div class="section-label">Executive Summary</div>
        <div class="summary">${this.formatMarkdown(answer, items)}</div>
      `;
    }

    // Detailed Evidence
    if (items.length > 0) {
      bodyHtml += `
        <div class="section-label">Detailed Evidence (${items.length} items)</div>
        <div class="findings-list">
          ${items.map((item, idx) => {
            const metadata = item?.metadata || {};
            const title = item?.title || metadata.title || item?.name || `Finding #${idx + 1}`;
            const rawUrl = item?.url || metadata.url || item?.link || '';
            const safeUrl = this._getSafeExternalUrl(rawUrl);
            const excerpt = item?.content || item?.snippet || item?.description || item?.pageContent || '';
            return `
              <div class="finding-card">
                <div class="finding-title">${this.escapeHtml(title)}</div>
                <div class="finding-excerpt">${this.escapeHtml(excerpt)}</div>
                ${safeUrl ? `<div class="finding-url"><a href="${this.escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${this.escapeHtml(safeUrl)}</a></div>` : ''}
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    const subtitle = `Generated by Aether Arena`;
    return this._wrapInBrandedHtml(
      `${this.escapeHtml(agentName)} Findings: ${this.escapeHtml(source)}`,
      subtitle,
      bodyHtml
    );
  }

  /**
   * Generate branded HTML for arbitrary content (artifact output, generic text).
   * @param {*} content - String content or object (will be JSON-stringified)
   * @param {string} [title='Export'] - Document title
   * @param {string} [format='text'] - Content format: text, markdown, html, json
   * @returns {string} Full HTML document
   */
  static generateContentHtml(content, title = 'Export', format = 'text') {
    if (content == null) return '';

    let bodyHtml = '';
    const stringContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);

    switch (format) {
      case 'html':
        bodyHtml = `<div class="content-block">${this.sanitizeOutputHtml(stringContent)}</div>`;
        break;

      case 'markdown':
        bodyHtml = `
          <div class="content-block markdown-export">
            ${this._markdownToHtml(stringContent)}
          </div>
        `;
        break;

      case 'json':
        bodyHtml = `
          <div class="content-block">
            <pre class="code-block">${this.escapeHtml(stringContent)}</pre>
          </div>
        `;
        break;

      default: // text
        bodyHtml = `
          <div class="content-block">
            <pre class="code-block">${this.escapeHtml(stringContent)}</pre>
          </div>
        `;
        break;
    }

    const subtitle = 'Exported from Aether Arena';
    return this._wrapInBrandedHtml(this.escapeHtml(title), subtitle, bodyHtml);
  }

  // ===========================================================================
  // Shared HTML Wrapper
  // ===========================================================================

  /**
   * Wrap body content in the branded Aether PDF template.
   * @param {string} title - Document title (already escaped)
   * @param {string} subtitle - Subtitle line below title
   * @param {string} bodyHtml - Inner HTML content (sections)
   * @returns {string} Full HTML document
   * @private
   */
  static _wrapInBrandedHtml(title, subtitle, bodyHtml) {
    const timestamp = new Date().toLocaleString();

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 800px;
      margin: 0 auto;
      padding: 40px;
    }
    .header {
      border-bottom: 2px solid #eee;
      margin-bottom: 30px;
      padding-bottom: 20px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 800;
      font-size: 18px;
      letter-spacing: -0.02em;
      color: #1a1a1a;
      margin-bottom: 8px;
    }
    .brand-icon {
      width: 20px;
      height: 20px;
      background: #007aff;
      border-radius: 4px;
      flex-shrink: 0;
    }
    .brand-aether { color: #007aff; }
    .brand-inc { color: #666; font-weight: 600; }
    .header h1 {
      margin: 0;
      font-size: 24px;
      color: #1a1a1a;
    }
    .header .meta {
      font-size: 12px;
      color: #666;
      margin-top: 10px;
    }
    .section-label {
      font-size: 14px;
      font-weight: bold;
      text-transform: uppercase;
      color: #007aff;
      letter-spacing: 0.05em;
      margin: 30px 0 15px 0;
      border-bottom: 1px solid #eee;
      padding-bottom: 5px;
    }
    .summary {
      font-size: 16px;
      background: #f9f9f9;
      padding: 20px;
      border-radius: 8px;
      border-left: 4px solid #007aff;
    }
    .key-points {
      padding-left: 24px;
      line-height: 1.8;
    }
    .key-points li {
      margin-bottom: 6px;
    }
    .badges-container {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .entity-badge, .topic-badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 13px;
      font-weight: 500;
    }
    .entity-badge {
      background: #e8f0fe;
      color: #1a73e8;
    }
    .topic-badge {
      background: #fef3e0;
      color: #e65100;
    }
    .meta-line {
      margin-top: 30px;
      font-size: 12px;
      color: #888;
    }
    .finding-card {
      margin-bottom: 20px;
      padding: 15px;
      border: 1px solid #eee;
      border-radius: 8px;
      page-break-inside: avoid;
    }
    .finding-title {
      font-weight: bold;
      font-size: 16px;
      margin-bottom: 8px;
      color: #1a1a1a;
    }
    .finding-excerpt {
      font-size: 14px;
      color: #444;
      margin-bottom: 10px;
    }
    .finding-url {
      font-size: 12px;
      color: #007aff;
      word-break: break-all;
    }
    a { color: #007aff; text-decoration: none; }
    h4 { margin-top: 20px; margin-bottom: 10px; }
    strong { color: #000; }
    .content-block {
      margin-top: 20px;
    }
    .code-block {
      background: #f5f5f5;
      padding: 20px;
      border-radius: 8px;
      font-family: "SF Mono", "Fira Code", "Consolas", monospace;
      font-size: 13px;
      line-height: 1.5;
      overflow-wrap: break-word;
      white-space: pre-wrap;
    }
    .markdown-export h1, .markdown-export h2, .markdown-export h3, .markdown-export h4 {
      color: #1a1a1a;
    }
    .markdown-export ul, .markdown-export ol {
      padding-left: 24px;
    }
    .markdown-export blockquote {
      border-left: 3px solid #007aff;
      padding-left: 16px;
      color: #555;
      margin: 16px 0;
    }
    .footer {
      margin-top: 50px;
      font-size: 11px;
      color: #999;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="brand">
      <div class="brand-icon"></div>
      <span><span class="brand-aether">Aether</span><span class="brand-inc">Inc</span></span>
    </div>
    <h1>${title}</h1>
    <div class="meta">${subtitle} &bull; ${timestamp}</div>
  </div>

  ${bodyHtml}

  <div class="footer">
    End of Document &mdash; Generated by AetherArena
  </div>
</body>
</html>`;
  }

  // ===========================================================================
  // Text Utilities
  // ===========================================================================

  /**
   * Escape HTML special characters for safe rendering.
   * @param {string} text - Raw text
   * @returns {string} Escaped HTML
   */
  static escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  static _getSafeExternalUrl(url) {
    if (!url) return '';

    try {
      const parsed = new URL(String(url).trim());
      const protocol = parsed.protocol.toLowerCase();
      if (protocol !== 'http:' && protocol !== 'https:') {
        return '';
      }
      return parsed.href;
    } catch (_error) {
      return '';
    }
  }

  /**
   * Convert markdown-style text to HTML with citation linking.
   * Ported from the former ResultExporter — identical output.
   * @param {string} text - Markdown-ish text
   * @param {Array} [items=[]] - Finding items for citation linking
   * @returns {string} HTML string
   */
  static formatMarkdown(text, items = []) {
    if (!text) return '';

    // Clean up raw URLs that clutter the text
    let cleanedText = String(text)
      .replace(/\(https?:\/\/[^\s)]+\)/g, '')
      .replace(/https?:\/\/[^\s<,]+(?=\s|<|,|$)/g, '');

    let html = this.escapeHtml(cleanedText)
      .replace(/### (.*)/g, '<h4>$1</h4>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br/>');

    // Link citations [1], [2], [Context citation: N] to finding URLs
    html = html.replace(/\[Context citation: (\d+)\]|\[(\d+)\]/g, (match, p1, p2) => {
      const idx = (p1 || p2) - 1;
      const item = items[idx];
      const rawUrl = item?.url || item?.metadata?.url || item?.link || '';
      const safeUrl = this._getSafeExternalUrl(rawUrl);

      if (safeUrl) {
        return `<a href="${this.escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer"><strong>[${idx + 1}]</strong></a>`;
      }
      return `<strong>[${idx + 1}]</strong>`;
    });

    return html;
  }

  /**
   * Convert markdown text to basic HTML for content export.
   * Handles headings, bold, italic, lists, code blocks, blockquotes.
   * @param {string} text - Markdown text
   * @returns {string} HTML string
   * @private
   */
  static _markdownToHtml(text) {
    if (!text) return '';

    let html = this.escapeHtml(text);

    // Code blocks (``` ... ```)
    html = html.replace(/```[\s\S]*?```/g, (match) => {
      const code = match.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
      return `<pre class="code-block">${code}</pre>`;
    });

    // Headings
    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Bold and italic
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Blockquotes
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

    // Unordered lists
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

    // Line breaks (preserve paragraph structure)
    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br/>');

    const wrapped = `<p>${html}</p>`;
    const sanitizer = this._getSanitizer();
    if (sanitizer && typeof sanitizer.sanitizeHTML === 'function') {
      return sanitizer.sanitizeHTML(wrapped, { profile: 'markdown' });
    }
    return wrapped;
  }

  /**
   * Extract plain text from a summary object for clipboard copy.
   * @param {Object} summary - Summary object
   * @param {string} [chatTitle='Chat'] - Chat title
   * @returns {string} Plain text representation
   */
  static summaryToPlainText(summary, chatTitle = 'Chat') {
    if (!summary) return '';

    const parts = [];

    if (summary.title || chatTitle) {
      parts.push(`Chat Summary: ${summary.title || chatTitle}`);
      parts.push('');
    }

    const summaryText = summary.summary_text || '';
    if (summaryText) {
      parts.push(summaryText);
      parts.push('');
    }

    const keyPoints = Array.isArray(summary.key_points) ? summary.key_points : [];
    if (keyPoints.length > 0) {
      parts.push('Key Points:');
      keyPoints.forEach(p => parts.push(`  - ${p}`));
      parts.push('');
    }

    const rawEntities = summary.entities || {};
    const categorizedEntities = rawEntities.entities || rawEntities;
    if (categorizedEntities && typeof categorizedEntities === 'object' && !Array.isArray(categorizedEntities)) {
      const entityNames = [];
      for (const [category, names] of Object.entries(categorizedEntities)) {
        if (category === 'topics') continue;
        if (Array.isArray(names)) {
          entityNames.push(...names);
        }
      }
      if (entityNames.length > 0) {
        parts.push(`Entities: ${entityNames.join(', ')}`);
      }
    }

    const topics = rawEntities.topics || [];
    if (Array.isArray(topics) && topics.length > 0) {
      parts.push(`Topics: ${topics.join(', ')}`);
    }

    return parts.join('\n');
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ContentExporter;
}
