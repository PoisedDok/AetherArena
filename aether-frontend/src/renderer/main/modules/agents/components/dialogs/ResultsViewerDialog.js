/**
 * @.architecture
 * Incoming: Tool components, user click "View Results" --- {tool run state with results}
 * Processing: Render research results in dialog --- {JOB_RENDER_RESULTS}
 * Outgoing: Dialog DOM element --- {formatted results display}
 * 
 * ResultsViewerDialog - Display Research/Tool Results
 * 
 * Responsibilities:
 * - Render tool results in a dialog
 * - Format results by source
 * - Show result previews with links
 * - Handle empty states
 * 
 * Extracted from AgentsModal.js lines 831-896, 1510-1546
 */

'use strict';

const Toast = require('../../../../../shared/components/Toast');
const ContentExporter = require('../../../../../shared/utils/ContentExporter');

class ResultsViewerDialog {
  /**
   * @param {Object} config - Dialog configuration
   * @param {string} config.toolName - Tool name (for display)
   * @param {Object} config.results - Results object to display
   * @param {Object} config.logger - Logger instance
   */
  constructor(config = {}) {
    this.toolName = config.toolName;
    this.results = config.results;
    this.logger = config.logger || console;
    
    // DOM reference
    this._dialogElement = null;
    
    if (!this.toolName) {
      throw new Error('ResultsViewerDialog: Tool name is required');
    }
    
    if (!this.results) {
      throw new Error('ResultsViewerDialog: Results object is required');
    }
  }

  /**
   * Create and return dialog DOM element
   * @returns {HTMLElement} Dialog element
   */
  create() {
    const formattedName = this._formatAgentName(this.toolName);
    const resultsHtml = this._renderResults(this.results);

    this._dialogElement = document.createElement('div');
    this._dialogElement.className = 'tool-dialog tool-dialog-wide';
    this._dialogElement.innerHTML = `
      <div class="tool-dialog-overlay"></div>
      <div class="tool-dialog-content tool-dialog-results">
        <div class="tool-dialog-header">
          <div class="header-title-group">
            <h3><i class="fas fa-search"></i> ${this._escapeHtml(formattedName)}</h3>
          </div>
          <div class="header-actions-v2">
            <button class="btn-text-action btn-copy-all" title="Copy all results">COPY</button>
            <button class="btn-text-action btn-export-pdf" title="Export as PDF">EXPORT</button>
            <div class="header-actions-divider"></div>
            <button class="btn-text-action btn-close-dialog" aria-label="Close">CLOSE</button>
          </div>
        </div>
        <div class="tool-dialog-body">
          ${resultsHtml}
        </div>
      </div>
    `;

    return this._dialogElement;
  }

  /**
   * Setup event listeners (called by DialogManager after adding to DOM)
   * @param {DialogManager} dialogManager - DialogManager instance
   */
  setupListeners(dialogManager) {
    if (!this._dialogElement) {
      this.logger.error('ResultsViewerDialog: Cannot setup listeners, dialog not created');
      return;
    }

    const closeBtn = this._dialogElement.querySelector('.btn-close-dialog');
    const overlay = this._dialogElement.querySelector('.tool-dialog-overlay');
    const copyAllBtn = this._dialogElement.querySelector('.btn-copy-all');
    const exportPdfBtn = this._dialogElement.querySelector('.btn-export-pdf');

    // Close handlers
    dialogManager.trackListener(closeBtn, 'click', (e) => {
      e.stopPropagation();
      dialogManager.close();
    });
    dialogManager.trackListener(overlay, 'click', (e) => {
      e.stopPropagation();
      dialogManager.close();
    });

    // Copy all results as plain text
    if (copyAllBtn) {
      dialogManager.trackListener(copyAllBtn, 'click', async (e) => {
        e.stopPropagation();
        const bodyEl = this._dialogElement.querySelector('.tool-dialog-body');
        const text = bodyEl ? bodyEl.innerText : '';
        await ContentExporter.copyToClipboard(text, 'Results');
      });
    }

    // Export results as PDF
    if (exportPdfBtn) {
      dialogManager.trackListener(exportPdfBtn, 'click', async (e) => {
        e.stopPropagation();
        const resultsHtml = this._renderResults(this.results);
        const formattedName = this._formatAgentName(this.toolName);
        const html = ContentExporter.generateContentHtml(resultsHtml, `${formattedName} Results`, 'html');
        const filename = `${this.toolName.toLowerCase()}_results.pdf`;
        await ContentExporter.exportAsPdf(html, filename);
      });
    }
  }

  /**
   * Render research results
   * @param {Object} response - Results response object
   * @returns {string} HTML string
   * @private
   */
  _renderResults(response) {
    if (!response || !response.results) {
      return `
        <div class="tool-results-empty-state">
          <i class="fas fa-search-minus"></i>
          <p>No results were returned from the research engine.</p>
        </div>
      `;
    }
    
    const sources = Array.isArray(response.sources_used)
      ? response.sources_used
      : Object.keys(response.results || {});

    if (sources.length === 0) {
      return `
        <div class="tool-results-empty-state">
          <i class="fas fa-exclamation-triangle"></i>
          <p>No sources returned data for this query.</p>
        </div>
      `;
    }

    const sections = sources.map((source) => {
      const block = response.results?.[source];
      if (!block) return '';

      // Handle both {results: []} and direct [] structures
      let items = [];
      let total = 0;

      if (Array.isArray(block)) {
        items = block;
        total = block.length;
      } else if (block && typeof block === 'object') {
        items = Array.isArray(block.results) ? block.results : (Array.isArray(block.items) ? block.items : []);
        total = Number.isFinite(block.total) ? block.total : items.length;
      }
      
      if (items.length === 0) {
        return `
          <div class="result-source">
            <div class="result-source-header">
              <span class="result-source-name">${this._escapeHtml(source)}</span>
              <span class="result-source-count">0</span>
            </div>
            <div class="result-empty">No results from this source</div>
          </div>
        `;
      }
      
      const preview = items.slice(0, 10).map((item) => {
        const title = item?.title || item?.name || item?.file_name || 'Untitled';
        const url = item?.url || item?.link || item?.href || '';
        const content = item?.content || item?.chunk_text || item?.description || '';
        const excerpt = content ? content.substring(0, 180) + (content.length > 180 ? '...' : '') : '';
        
        return `
          <div class="result-item">
            <div class="result-item-title">
              ${url 
                ? `<a href="${this._escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${this._escapeHtml(title)}</a>` 
                : this._escapeHtml(title)
              }
            </div>
            ${excerpt ? `<div class="result-item-excerpt">${this._escapeHtml(excerpt)}</div>` : ''}
            ${url ? `<div class="result-item-url">${this._escapeHtml(url)}</div>` : ''}
          </div>
        `;
      }).join('');
      
      return `
        <div class="result-source">
          <div class="result-source-header">
            <span class="result-source-name">${this._escapeHtml(source)}</span>
            <span class="result-source-count">${total}</span>
          </div>
          <div class="result-items">${preview}</div>
          ${items.length > 10 ? `<div class="result-more">+ ${items.length - 10} more</div>` : ''}
        </div>
      `;
    }).join('');

    return `
      <div class="results-summary">
        <div><strong>${sources.length}</strong> sources</div>
        <div><strong>${this._calculateTotalResults(response.results)}</strong> results</div>
      </div>
      <div class="results-container">${sections}</div>
    `;
  }

  _calculateTotalResults(results) {
    if (!results) return 0;
    return Object.values(results).reduce((acc, block) => {
      if (Array.isArray(block)) return acc + block.length;
      if (block && typeof block === 'object') {
        const items = Array.isArray(block.results) ? block.results : (Array.isArray(block.items) ? block.items : []);
        return acc + (Number.isFinite(block.total) ? block.total : items.length);
      }
      return acc;
    }, 0);
  }

  /**
   * Format agent name for display
   * @param {string} agentName - Raw agent name
   * @returns {string} Formatted display name
   * @private
   */
  _formatAgentName(agentName) {
    if (!agentName) return 'Unknown';
    return String(agentName)
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Escape HTML for safe rendering
   * @param {string} text - Text to escape
   * @returns {string} Escaped HTML
   * @private
   */
  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    this._dialogElement = null;
  }
}

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ResultsViewerDialog;
}

// Global registration
if (typeof window !== 'undefined') {
  window.ResultsViewerDialog = ResultsViewerDialog;
}
