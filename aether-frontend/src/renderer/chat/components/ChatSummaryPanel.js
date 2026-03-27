'use strict';

/**
 * @.architecture
 * 
 * Incoming: ChatController (chat context), chat summary bridge (preload API) --- {chat_id, chatSummaries}
 * Processing: Display auto-generated chat summaries (title, key_points, entities), regenerate button, loading states --- {4 jobs: JOB_GET_STATE, JOB_CREATE_DOM_ELEMENT, JOB_HTTP_REQUEST, JOB_UPDATE_DOM_ELEMENT}
 * Outgoing: DOM (summary panel in sidebar), IPC (storage:summarize-chat, storage:get-chat-summaries) --- {dom_types.summary_panel, HTMLElement}
 * 
 * @module renderer/chat/components/ChatSummaryPanel
 * 
 * Chat Summary Display Panel
 * ============================================================================
 * Displays auto-generated chat summaries with key points and entities.
 * Integrates into chat sidebar below chat list.
 * 
 * Features:
 * - Display full/brief/technical summaries
 * - Show key points as bulleted list
 * - Show entities with syntax highlighting
 * - Regenerate summary button
 * - Loading states
 * - Collapsible panel
 */

const { createRendererLogger } = require('../../shared/utils/logger');
const { getAether } = require('../../shared/bridge/AetherBridge');
const ContentExporter = require('../../shared/utils/ContentExporter');

class ChatSummaryPanel {
  constructor(options = {}) {
    this.chatId = null;
    this.eventBus = options.eventBus || null;
    this.container = null;
    this.log = createRendererLogger('ChatSummaryPanel');
    this.aether = options.aether || getAether();
    
    // State
    this.summaries = [];
    this.isLoading = false;
    this.isCollapsed = false;
    
    // Lifecycle
    this._listeners = [];
    this._isDisposed = false;
    
    this.log.debug('constructed');
  }

  async init(container) {
    if (!container) {
      throw new Error('[ChatSummaryPanel] Container required');
    }
    
    this.container = container;
    this._createPanel();
    this._setupEventListeners();
    
    this.log.debug('initialized');
  }

  _createPanel() {
    const panel = document.createElement('div');
    panel.className = 'chat-summary-panel';
    panel.innerHTML = `
      <div class="summary-header">
        <h4>Summary</h4>
        <div class="summary-actions">
          <button class="btn-icon summary-regenerate" title="Regenerate Summary">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="23 4 23 10 17 10"></polyline>
              <polyline points="1 20 1 14 7 14"></polyline>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
            </svg>
          </button>
          <button class="btn-icon summary-copy hidden" title="Copy Summary">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </button>
          <button class="btn-icon summary-export-pdf hidden" title="Export as PDF">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
              <line x1="12" y1="18" x2="12" y2="12"></line>
              <polyline points="9 15 12 18 15 15"></polyline>
            </svg>
          </button>
          <button class="btn-icon summary-toggle" title="Collapse">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="18 15 12 9 6 15"></polyline>
            </svg>
          </button>
        </div>
      </div>
      <div class="summary-content">
        <div class="summary-loading hidden">
          <div class="spinner"></div>
          <span>Generating summary...</span>
        </div>
        <div class="summary-empty">
          No summary yet. Click regenerate to create one.
        </div>
        <div class="summary-display hidden">
          <div class="summary-title"></div>
          <div class="summary-key-points"></div>
          <div class="summary-entities"></div>
          <div class="summary-meta"></div>
        </div>
      </div>
    `;
    
    this.container.appendChild(panel);
    this.panelEl = panel;
    
    // Cache DOM elements
    this._cacheElements();
    
    this.log.trace('panel created');
  }

  _cacheElements() {
    this.elements = {
      regenerateBtn: this.panelEl.querySelector('.summary-regenerate'),
      copyBtn: this.panelEl.querySelector('.summary-copy'),
      exportPdfBtn: this.panelEl.querySelector('.summary-export-pdf'),
      toggleBtn: this.panelEl.querySelector('.summary-toggle'),
      content: this.panelEl.querySelector('.summary-content'),
      loading: this.panelEl.querySelector('.summary-loading'),
      empty: this.panelEl.querySelector('.summary-empty'),
      display: this.panelEl.querySelector('.summary-display'),
      title: this.panelEl.querySelector('.summary-title'),
      keyPoints: this.panelEl.querySelector('.summary-key-points'),
      entities: this.panelEl.querySelector('.summary-entities'),
      meta: this.panelEl.querySelector('.summary-meta'),
    };
  }

  _setupEventListeners() {
    this._trackListener(this.elements.regenerateBtn, 'click', () => this._handleRegenerate());
    this._trackListener(this.elements.copyBtn, 'click', () => this._handleCopy());
    this._trackListener(this.elements.exportPdfBtn, 'click', () => this._handleExportPdf());
    this._trackListener(this.elements.toggleBtn, 'click', () => this._toggleCollapse());
  }

  /** @private */
  _trackListener(element, event, handler, options) {
    if (!element) return;
    element.addEventListener(event, handler, options);
    this._listeners.push({ element, event, handler, options });
  }

  async loadSummaries(chatId) {
    if (!chatId) {
      this._showEmpty();
      return;
    }
    
    this.chatId = chatId;
    
    try {
      this._showLoading();
      
      const summaries = await this.aether?.chatSummaries?.list(chatId);
      this.summaries = summaries || [];
      
      if (this.summaries.length > 0) {
        this._displaySummary(this.summaries[0]); // Show first summary
      } else {
        this._showEmpty();
      }
    } catch (error) {
      this.log.error('failed to load summaries', { error, chatId });
      this._showError('Failed to load summary');
    }
  }

  _displaySummary(summary) {
    // Hide loading/empty
    this.elements.loading.classList.add('hidden');
    this.elements.empty.classList.add('hidden');
    this.elements.display.classList.remove('hidden');

    // Show export actions (data available)
    this.elements.copyBtn.classList.remove('hidden');
    this.elements.exportPdfBtn.classList.remove('hidden');
    
    // Display title
    if (summary.title) {
      this.elements.title.textContent = summary.title;
      this.elements.title.style.display = 'block';
    } else {
      this.elements.title.style.display = 'none';
    }
    
    // Display prose summary (summary_text contains narrative + bullet points from backend)
    const summaryContainer = this.elements.display.querySelector('.summary-prose');
    if (!summaryContainer) {
      // Create prose element if not yet in DOM (first render after upgrade)
      const proseEl = document.createElement('div');
      proseEl.className = 'summary-prose';
      this.elements.display.insertBefore(proseEl, this.elements.keyPoints);
      this.elements.prose = proseEl;
    } else {
      this.elements.prose = summaryContainer;
    }
    
    // Extract prose from summary_text (first paragraph before bullet points)
    const summaryText = summary.summary_text || '';
    const proseText = summaryText.split('\n\n')[0] || '';
    if (proseText && !proseText.startsWith('- ')) {
      this.elements.prose.textContent = proseText;
      this.elements.prose.style.display = 'block';
    } else {
      this.elements.prose.style.display = 'none';
    }
    
    // Display key points
    if (summary.key_points && summary.key_points.length > 0) {
      const pointsList = document.createElement('ul');
      pointsList.className = 'summary-points-list';
      summary.key_points.forEach(point => {
        const li = document.createElement('li');
        li.textContent = point;
        pointsList.appendChild(li);
      });
      this.elements.keyPoints.innerHTML = '<strong>Key Points:</strong>';
      this.elements.keyPoints.appendChild(pointsList);
      this.elements.keyPoints.style.display = 'block';
    } else {
      this.elements.keyPoints.style.display = 'none';
    }
    
    // Display entities - unwrap from DB format {"entities": {...}, "topics": [...]}
    const rawEntities = summary.entities || {};
    const categorizedEntities = rawEntities.entities || rawEntities;
    const topics = rawEntities.topics || [];
    
    // Build entity badges from categorized dict {category: [names]}
    const entityBadges = [];
    if (categorizedEntities && typeof categorizedEntities === 'object' && !Array.isArray(categorizedEntities)) {
      for (const [category, names] of Object.entries(categorizedEntities)) {
        if (category === 'topics') continue; // handled separately
        if (Array.isArray(names)) {
          names.forEach(name => {
            const safeCategory = category.replace(/[^a-z]/g, '');
            entityBadges.push(`<span class="entity-badge entity-${safeCategory}">${this._escapeHtml(name)}</span>`);
          });
        }
      }
    }
    
    if (entityBadges.length > 0) {
      const entitiesDiv = document.createElement('div');
      entitiesDiv.className = 'summary-entities-list';
      entitiesDiv.innerHTML = '<strong>Entities:</strong> ' + entityBadges.join(' ');
      this.elements.entities.innerHTML = '';
      this.elements.entities.appendChild(entitiesDiv);
      this.elements.entities.style.display = 'block';
    } else {
      this.elements.entities.style.display = 'none';
    }
    
    // Display metadata
    const timeAgo = this._getTimeAgo(summary.created_at);
    const model = summary.llm_model || 'unknown';
    const msgCount = (summary.metadata && summary.metadata.message_count) || '';
    const msgInfo = msgCount ? ` • ${msgCount} msgs` : '';
    this.elements.meta.innerHTML = `
      <small class="summary-meta-text">
        Generated ${timeAgo} • ${model}${msgInfo}
      </small>
    `;
    
    this.log.trace('summary displayed', { chat_id: this.chatId });
  }

  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  _showLoading() {
    this.isLoading = true;
    this.elements.loading.classList.remove('hidden');
    this.elements.empty.classList.add('hidden');
    this.elements.display.classList.add('hidden');
    this.elements.copyBtn.classList.add('hidden');
    this.elements.exportPdfBtn.classList.add('hidden');
  }

  _showEmpty() {
    this.isLoading = false;
    this.elements.loading.classList.add('hidden');
    this.elements.empty.classList.remove('hidden');
    this.elements.display.classList.add('hidden');
    this.elements.copyBtn.classList.add('hidden');
    this.elements.exportPdfBtn.classList.add('hidden');
  }

  _showError(message) {
    this.isLoading = false;
    this.elements.loading.classList.add('hidden');
    this.elements.empty.textContent = message;
    this.elements.empty.classList.remove('hidden');
    this.elements.display.classList.add('hidden');
    this.elements.copyBtn.classList.add('hidden');
    this.elements.exportPdfBtn.classList.add('hidden');
  }

  async _handleRegenerate() {
    if (!this.chatId || this.isLoading) {
      return;
    }
    
    try {
      this._showLoading();
      
      const summary = await this.aether?.chatSummaries?.generate(this.chatId);
      
      if (summary) {
        this.summaries = [summary];
        this._displaySummary(summary);
      } else {
        this._showError('Failed to generate summary');
      }
    } catch (error) {
      this.log.error('failed to regenerate summary', { error, chatId: this.chatId });
      this._showError('Failed to generate summary');
    }
  }

  async _handleCopy() {
    const summary = this.summaries.length > 0 ? this.summaries[0] : null;
    if (!summary) return;

    const text = ContentExporter.summaryToPlainText(summary);
    await ContentExporter.copyToClipboard(text, 'Summary');
  }

  async _handleExportPdf() {
    const summary = this.summaries.length > 0 ? this.summaries[0] : null;
    if (!summary) return;

    const html = ContentExporter.generateSummaryHtml(summary, summary.title || 'Chat');
    const filename = `chat_summary_${this.chatId || 'export'}.pdf`;
    await ContentExporter.exportAsPdf(html, filename);
  }

  _toggleCollapse() {
    this.isCollapsed = !this.isCollapsed;
    
    if (this.isCollapsed) {
      this.elements.content.classList.add('collapsed');
      this.elements.toggleBtn.querySelector('svg polyline').setAttribute('points', '6 9 12 15 18 9');
      this.elements.toggleBtn.title = 'Expand';
    } else {
      this.elements.content.classList.remove('collapsed');
      this.elements.toggleBtn.querySelector('svg polyline').setAttribute('points', '18 15 12 9 6 15');
      this.elements.toggleBtn.title = 'Collapse';
    }
  }

  _getTimeAgo(timestamp) {
    if (!timestamp) return 'unknown';
    
    const now = new Date();
    const then = new Date(timestamp);
    const seconds = Math.floor((now - then) / 1000);
    
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
    return then.toLocaleDateString();
  }

  destroy() {
    if (this._isDisposed) return;
    this._isDisposed = true;

    for (const { element, event, handler, options } of this._listeners) {
      element?.removeEventListener(event, handler, options);
    }
    this._listeners = [];

    if (this.panelEl && this.panelEl.parentNode) {
      this.panelEl.parentNode.removeChild(this.panelEl);
    }

    this.elements = null;
    this.panelEl = null;
    this.container = null;
    this.summaries = [];
    this.chatId = null;

    this.log.debug('destroyed');
  }
}

module.exports = ChatSummaryPanel;
