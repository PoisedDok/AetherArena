/**
 * @.architecture
 * Incoming: JobDetailsDialog --- {source findings block}
 * Processing: Render clean findings list with markdown summary --- {JOB_RENDER_FINDINGS}
 * Outgoing: Dialog DOM element, Copy-to-clipboard --- {formatted content}
 * 
 * SourceResultDialog - Clean Reading View for Agent Findings
 */

'use strict';

const Toast = require('../../../shared/components/Toast');
const ContentExporter = require('../../../shared/utils/ContentExporter');

class SourceResultDialog {
  /**
   * @param {Object} config - Dialog configuration
   * @param {string} config.source - Source name (Web, Reddit, etc)
   * @param {Object} config.data - Findings block
   * @param {Object} config.logger - Logger instance
   * @param {Function} config.onItemClick - Optional callback for finding item clicks
   */
  constructor(config = {}) {
    this.source = config.source;
    this.data = config.data;
    this.logger = config.logger || console;
    this.onItemClick = config.onItemClick || null;
    this._dialogElement = null;
  }

  create() {
    let answer = '';
    let items = [];
    
    if (this.data && typeof this.data === 'object') {
      answer = this.data.answer || '';
      items = Array.isArray(this.data.results) ? this.data.results : (Array.isArray(this.data.items) ? this.data.items : (Array.isArray(this.data.sources) ? this.data.sources : []));
      if (items.length === 0 && Array.isArray(this.data)) {
        items = this.data;
      }
    }

    this._dialogElement = document.createElement('div');
    this._dialogElement.className = 'tool-dialog tool-dialog-wide';
    this._dialogElement.innerHTML = `
      <div class="tool-dialog-overlay"></div>
      <div class="tool-dialog-content source-result-dialog">
        <div class="tool-dialog-header">
          <div class="header-title-group">
            <h3>Findings: ${this._escapeHtml(this.source)}</h3>
          </div>
          <div class="header-actions-v2">
            <button class="btn-text-action btn-copy-all" title="Copy all results">
              COPY
            </button>
            <button class="btn-text-action btn-export-pdf" title="Export as PDF">
              EXPORT
            </button>
            <div class="header-actions-divider"></div>
            <button class="btn-text-action btn-close-dialog" aria-label="Close">
              CLOSE
            </button>
          </div>
        </div>
        <div class="tool-dialog-body">
          <div class="source-result-reading-area">
            ${answer ? `
              <div class="source-result-answer">
                <div class="reading-label">Executive Summary</div>
                <div class="markdown-content">${this._formatMarkdown(answer, items)}</div>
              </div>
            ` : ''}

            ${items.length > 0 ? `
              <div class="source-result-items">
                <div class="reading-label">Detailed Findings (${items.length})</div>
                <div class="findings-list">
                  ${items.map((item, idx) => this._renderFindingCard(item, idx)).join('')}
                </div>
              </div>
            ` : ''}
          </div>
        </div>
      </div>
    `;

    return this._dialogElement;
  }

  _renderFindingCard(item, idx) {
    const metadata = item?.metadata || {};
    const title = item?.title || metadata.title || item?.name || `Finding #${idx + 1}`;
    const rawUrl = item?.url || metadata.url || item?.link || '';
    const safeUrl = this._getSafeExternalUrl(rawUrl);
    const excerpt = item?.content || item?.snippet || item?.description || item?.pageContent || '';
    
    return `
      <div class="finding-reading-card" data-idx="${idx}">
        <div class="finding-header">
          <div class="finding-title">${this._escapeHtml(title)}</div>
          ${safeUrl ? `<a href="${this._escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" class="finding-link-icon" title="Open in browser">VIEW SOURCE</a>` : ''}
        </div>
        <div class="finding-excerpt">${this._escapeHtml(excerpt)}</div>
        <div class="finding-footer">
          ${safeUrl ? `<div class="finding-url-wrapper"><a href="${this._escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" class="finding-url">${this._escapeHtml(safeUrl)}</a></div>` : ''}
          <button class="btn-text-action btn-copy-finding" data-index="${idx}">
            COPY
          </button>
        </div>
      </div>
    `;
  }

  setupListeners(dialogManager) {
    if (!this._dialogElement) return;

    const closeBtn = this._dialogElement.querySelector('.btn-close-dialog');
    const overlay = this._dialogElement.querySelector('.tool-dialog-overlay');
    const copyAllBtn = this._dialogElement.querySelector('.btn-copy-all');
    const exportPdfBtn = this._dialogElement.querySelector('.btn-export-pdf');

    dialogManager.trackListener(closeBtn, 'click', (e) => {
      e.stopPropagation();
      dialogManager.close();
    });
    
    dialogManager.trackListener(overlay, 'click', (e) => {
      e.stopPropagation();
      dialogManager.close();
    });

    if (copyAllBtn) {
      dialogManager.trackListener(copyAllBtn, 'click', (e) => {
        e.stopPropagation();
        this._copyAll();
      });
    }

    if (exportPdfBtn) {
      dialogManager.trackListener(exportPdfBtn, 'click', async (e) => {
        e.stopPropagation();
        const html = ContentExporter.generateFindingsHtml(this.source, this.data, 'Research Agent');
        const filename = `research_agent_${(this.source || 'export').toLowerCase()}_findings.pdf`;
        await ContentExporter.exportAsPdf(html, filename);
      });
    }

    // Handle Copy Finding buttons
    this._dialogElement.querySelectorAll('.btn-copy-finding').forEach(btn => {
      dialogManager.trackListener(btn, 'click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index);
        this._copyFinding(idx);
      });
    });

    // Handle Link Clicks (Global within dialog)
    dialogManager.trackListener(this._dialogElement, 'click', (e) => {
      const link = e.target.closest('a');
      const safeUrl = this._getSafeExternalUrl(link?.getAttribute('href'));
      if (link && safeUrl) {
        e.preventDefault();
        e.stopPropagation();

        if (window.aether?.ipc) {
          window.aether.ipc.send('open-external-url', safeUrl);
        } else {
          window.open(safeUrl, '_blank');
        }
      }
    });

    // Handle Card Clicks (to open link or trigger callback)
    this._dialogElement.querySelectorAll('.finding-reading-card').forEach(card => {
      dialogManager.trackListener(card, 'click', (e) => {
        // If they clicked the copy button, don't trigger card click
        if (e.target.closest('.btn-copy-finding')) return;
        
        const idx = parseInt(card.dataset.idx);
        const item = this._getFindingItem(idx);

        // Priority 1: Custom callback
        if (this.onItemClick && item) {
          e.preventDefault();
          e.stopPropagation();
          this.onItemClick(item);
          return;
        }

        // Priority 2: External link
        const link = card.querySelector('.finding-link-icon') || card.querySelector('.finding-url');
        const safeUrl = this._getSafeExternalUrl(link?.getAttribute('href'));
        
        if (safeUrl) {
          e.preventDefault();
          e.stopPropagation();
          if (window.aether?.ipc) {
            window.aether.ipc.send('open-external-url', safeUrl);
          } else {
            window.open(safeUrl, '_blank');
          }
        }
      });
    });
  }

  _getFindingItem(idx) {
    if (!this.data) return null;
    let items = [];
    if (typeof this.data === 'object') {
      items = Array.isArray(this.data.results) ? this.data.results : (Array.isArray(this.data.items) ? this.data.items : (Array.isArray(this.data.sources) ? this.data.sources : []));
      if (items.length === 0 && Array.isArray(this.data)) {
        items = this.data;
      }
    }
    return items[idx] || null;
  }

  _copyAll() {
    try {
      const text = this._dialogElement.querySelector('.source-result-reading-area').innerText;
      navigator.clipboard.writeText(text);
      Toast.success('All results copied to clipboard');
    } catch (err) {
      this.logger.error('Copy failed:', err);
      Toast.error('Failed to copy');
    }
  }

  _copyFinding(idx) {
    try {
      const cards = this._dialogElement.querySelectorAll('.finding-reading-card');
      const card = cards[idx];
      if (card) {
        const text = card.innerText;
        navigator.clipboard.writeText(text);
        Toast.success('Finding copied to clipboard');
      }
    } catch (err) {
      this.logger.error('Copy failed:', err);
      Toast.error('Failed to copy');
    }
  }

  _getSourceIcon(source) {
    const s = source.toLowerCase();
    if (s.includes('web')) return 'fa-globe';
    if (s.includes('news')) return 'fa-newspaper';
    if (s.includes('reddit')) return 'fa-reddit';
    if (s.includes('local')) return 'fa-folder-open';
    if (s.includes('file')) return 'fa-file-alt';
    return 'fa-database';
  }

  _formatMarkdown(text, items = []) {
    if (!text) return '';
    
    // Basic formatting
    let html = this._escapeHtml(text)
      .replace(/### (.*)/g, '<h4>$1</h4>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br/>');

    // Handle [Context citation: N] or similar patterns
    // Some agents might output [1], [2] or (1), (2)
    const citationRegex = /\[Context citation: (\d+)\]|\[(\d+)\]/g;
    
    html = html.replace(citationRegex, (match, p1, p2) => {
      const n = p1 || p2;
      const idx = parseInt(n) - 1;
      const item = items[idx];
      
      if (item) {
        const metadata = item.metadata || {};
        const rawUrl = item.url || metadata.url || item.link || '';
        const safeUrl = this._getSafeExternalUrl(rawUrl);
        if (safeUrl) {
          return `<a href="${this._escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" class="citation-link" title="Source: ${this._escapeHtml(item.title || 'View Finding')}">[${n}]</a>`;
        }
      }
      return `<span class="citation-tag">[${n}]</span>`;
    });

    return html;
  }

  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
  }

  _getSafeExternalUrl(url) {
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
}

if (typeof window !== 'undefined') {
  window.SourceResultDialog = SourceResultDialog;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SourceResultDialog;
}
