'use strict';

/**
 * @.architecture
 * 
 * Incoming: Context menu (View Summary / Generate Summary), chat summary bridge --- {user_click, ipc_response}
 * Processing: Display chat summary as floating centered modal --- {3 jobs: JOB_CREATE_DOM_ELEMENT, JOB_HTTP_REQUEST, JOB_RENDER}
 * Outgoing: Floating modal overlay --- {HTMLElement}
 * 
 * @module renderer/chat/modals/ChatSummaryModal
 */

const BaseModal = require('../../shared/modals/BaseModal');
const { createRendererLogger } = require('../../shared/utils/logger');
const { getAether } = require('../../shared/bridge/AetherBridge');
const ContentExporter = require('../../shared/utils/ContentExporter');

class ChatSummaryModal extends BaseModal {
  constructor(options = {}) {
    super({
      ...options,
      id: 'chat-summary-modal',
      title: 'Chat Summary'
    });

    // Scope styling to this modal panel (avoid affecting other modals)
    if (this.panel) {
      this.panel.id = this.id;
    }
    
    this.log = createRendererLogger('ChatSummaryModal');
    this.chatId = null;
    this.summaries = [];
    this.aether = options.aether || getAether();

    // Lifecycle tracking
    this._listeners = [];
    this._timers = [];
    this._requestSequence = 0;
  }

  async open(chatId) {
    if (!chatId) {
      this.log.warn('No chatId provided');
      return;
    }
    this.chatId = chatId;
    await super.open();
  }

  async _renderContent() {
    this._clearTrackedListeners();

    const title = document.createElement('h3');
    title.textContent = 'Chat Summary';
    title.className = 'cm-section-title';

    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '×';
    closeBtn.className = 'cm-action-btn cm-action-btn--close';
    closeBtn.setAttribute('aria-label', 'Close dialog');
    this._trackListener(closeBtn, 'click', () => this.close());

    this.headerEl.innerHTML = '';
    this.headerEl.appendChild(title);
    this.headerEl.appendChild(closeBtn);

    this.bodyEl.innerHTML = `
      <div class="skeleton-container">
        <div class="skeleton-card">
          <div class="skeleton-line skeleton-line--md skeleton-line--thick"></div>
          <div class="skeleton-line skeleton-line--full"></div>
          <div class="skeleton-line skeleton-line--full"></div>
          <div class="skeleton-line skeleton-line--lg"></div>
        </div>
        <div class="skeleton-card">
          <div class="skeleton-line skeleton-line--sm skeleton-line--thick"></div>
          <div class="skeleton-line skeleton-line--full"></div>
          <div class="skeleton-line skeleton-line--lg"></div>
          <div class="skeleton-row"><div class="skeleton-line skeleton-line--sm"></div><div class="skeleton-line skeleton-line--sm"></div><div class="skeleton-line skeleton-line--sm"></div></div>
        </div>
      </div>`;

    this._loadSummaryData();
  }

  /** @private */
  async _loadSummaryData() {
    const seq = ++this._requestSequence;
    try {
      const summaries = await this.aether?.chatSummaries?.list(this.chatId);
      if (seq !== this._requestSequence || !this.isOpen) return;

      this.summaries = Array.isArray(summaries) ? summaries : [];
      this.log.debug('loaded summaries', { count: this.summaries.length });

      if (this.summaries.length > 0) {
        this._displaySummaries(this.summaries);
      } else {
        this._showEmptyState();
      }
    } catch (error) {
      if (seq !== this._requestSequence || !this.isOpen) return;
      this.log.error('failed to load summaries', { error: error?.message || error, chatId: this.chatId });
      this._showError(error?.message || 'Failed to load summaries');
    }
  }

  _displaySummaries(summaries) {
    this.bodyEl.innerHTML = '';
    
    // Wrap cards in a container so :last-child works correctly
    const cardsContainer = document.createElement('div');
    
    summaries.forEach((summary) => {
      const card = document.createElement('div');
      card.className = 'csumm-card';
      
      // Title
      if (summary.title) {
        const titleEl = document.createElement('h4');
        titleEl.textContent = summary.title;
        titleEl.className = 'csumm-card-title';
        card.appendChild(titleEl);
      }
      
      // Prose summary (extracted from summary_text first paragraph)
      const summaryText = summary.summary_text || '';
      const prosePart = summaryText.split('\n\n')[0] || '';
      if (prosePart && !prosePart.startsWith('- ')) {
        const proseEl = document.createElement('p');
        proseEl.textContent = prosePart;
        proseEl.className = 'csumm-card-prose';
        card.appendChild(proseEl);
      }
      
      // Key points
      if (summary.key_points && Array.isArray(summary.key_points) && summary.key_points.length > 0) {
        const pointsTitle = document.createElement('h5');
        pointsTitle.textContent = 'Key Points';
        pointsTitle.className = 'csumm-points-title';
        card.appendChild(pointsTitle);
        
        const pointsList = document.createElement('ul');
        pointsList.className = 'csumm-points-list';
        summary.key_points.forEach(point => {
          const li = document.createElement('li');
          li.textContent = point;
          li.className = 'csumm-points-item';
          pointsList.appendChild(li);
        });
        card.appendChild(pointsList);
      }
      
      // Entities - unwrap from DB format {"entities": {...}, "topics": [...]}
      const rawEntities = summary.entities || {};
      const categorizedEntities = rawEntities.entities || rawEntities;
      
      if (categorizedEntities && typeof categorizedEntities === 'object' && !Array.isArray(categorizedEntities)) {
        const entityBadges = [];
        for (const [category, names] of Object.entries(categorizedEntities)) {
          if (category === 'topics') continue;
          if (Array.isArray(names)) {
            names.forEach(name => {
              const safeCategory = category.replace(/[^a-z]/g, '');
              entityBadges.push(`<span class="csumm-entity-badge entity-${safeCategory}">${this._escapeHtml(name)}</span>`);
            });
          }
        }
        
        if (entityBadges.length > 0) {
          const entitiesDiv = document.createElement('div');
          entitiesDiv.className = 'csumm-badges-container';
          entitiesDiv.innerHTML = '<strong class="csumm-badge-label">Entities:</strong> ' + entityBadges.join(' ');
          card.appendChild(entitiesDiv);
        }
      }
      
      // Topics
      const topics = rawEntities.topics || [];
      if (Array.isArray(topics) && topics.length > 0) {
        const topicsDiv = document.createElement('div');
        topicsDiv.className = 'csumm-badges-container csumm-badges-container--topics';
        const topicBadges = topics.map(t =>
          `<span class="csumm-topic-badge">${this._escapeHtml(t)}</span>`
        ).join(' ');
        topicsDiv.innerHTML = '<strong class="csumm-badge-label">Topics:</strong> ' + topicBadges;
        card.appendChild(topicsDiv);
      }
      
      // Metadata
      const meta = document.createElement('div');
      meta.className = 'csumm-meta';
      const msgCount = (summary.metadata && summary.metadata.message_count) ? ` • ${summary.metadata.message_count} msgs` : '';
      meta.textContent = `Created: ${new Date(summary.created_at).toLocaleString()} • Type: ${summary.summary_type || 'auto'}${msgCount}`;
      card.appendChild(meta);
      
      cardsContainer.appendChild(card);
    });
    
    this.bodyEl.appendChild(cardsContainer);
    
    // Action buttons row
    const actionsRow = document.createElement('div');
    actionsRow.className = 'csumm-actions-row';

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy All';
    copyBtn.className = 'csumm-glass-btn';
    this._trackListener(copyBtn, 'click', async () => {
      const summary = this.summaries.length > 0 ? this.summaries[0] : null;
      if (!summary) return;
      const text = ContentExporter.summaryToPlainText(summary);
      await ContentExporter.copyToClipboard(text, 'Summary');
    });

    const exportBtn = document.createElement('button');
    exportBtn.textContent = 'Export PDF';
    exportBtn.className = 'csumm-glass-btn';
    this._trackListener(exportBtn, 'click', async () => {
      const summary = this.summaries.length > 0 ? this.summaries[0] : null;
      if (!summary) return;
      const html = ContentExporter.generateSummaryHtml(summary, summary.title || 'Chat');
      const filename = `chat_summary_${this.chatId || 'export'}.pdf`;
      await ContentExporter.exportAsPdf(html, filename);
    });

    const regenBtn = document.createElement('button');
    regenBtn.textContent = 'Regenerate';
    regenBtn.className = 'csumm-glass-btn';
    this._trackListener(regenBtn, 'click', () => this._handleRegenerate());

    actionsRow.appendChild(copyBtn);
    actionsRow.appendChild(exportBtn);
    actionsRow.appendChild(regenBtn);
    this.bodyEl.appendChild(actionsRow);
  }

  _showEmptyState() {
    this.bodyEl.innerHTML = '';
    
    const emptyState = document.createElement('div');
    emptyState.className = 'csumm-empty';
    
    const message = document.createElement('p');
    message.textContent = 'No summary available yet.';
    message.className = 'csumm-empty-message';
    
    const genBtn = document.createElement('button');
    genBtn.textContent = 'Generate Summary';
    genBtn.className = 'csumm-glass-btn csumm-glass-btn--inline';
    this._trackListener(genBtn, 'click', () => this._handleRegenerate());
    
    emptyState.appendChild(message);
    emptyState.appendChild(genBtn);
    this.bodyEl.appendChild(emptyState);
  }

  _showError() {
    this.bodyEl.innerHTML = `
      <div class="modal-empty-state">
        <div class="modal-empty-title cm-error-title">Failed to load summary</div>
        <div class="modal-empty-text">Please try again later.</div>
      </div>
    `;
  }

  async _handleRegenerate() {
    const seq = ++this._requestSequence;
    try {
      this.bodyEl.innerHTML = '';
      const generating = document.createElement('div');
      generating.className = 'csumm-generating';
      
      const spinner = document.createElement('div');
      spinner.className = 'csumm-spinner';
      
      const message = document.createElement('p');
      message.textContent = 'Generating summary...';
      message.className = 'csumm-generating-msg';
      
      const hint = document.createElement('p');
      hint.textContent = 'This may take a few seconds';
      hint.className = 'csumm-generating-hint';
      
      generating.appendChild(spinner);
      generating.appendChild(message);
      generating.appendChild(hint);
      this.bodyEl.appendChild(generating);
      
      await this.aether?.chatSummaries?.generate(this.chatId);
      if (seq !== this._requestSequence || !this.isOpen) return;
      
      await new Promise(resolve => setTimeout(resolve, 500));
      if (seq !== this._requestSequence || !this.isOpen) return;
      
      await this._loadSummaryData();
      
      this.log.info('summary regenerated', { chatId: this.chatId });
    } catch (error) {
      if (seq !== this._requestSequence || !this.isOpen) return;
      this.log.error('failed to regenerate summary', { error, chatId: this.chatId });
      this._showError();
    }
  }

  /** @private */
  _trackListener(element, event, handler, options) {
    if (!element) return;
    element.addEventListener(event, handler, options);
    this._listeners.push({ element, event, handler, options });
  }

  /** @private */
  _clearTrackedListeners() {
    for (const { element, event, handler, options } of this._listeners) {
      element?.removeEventListener(event, handler, options);
    }
    this._listeners = [];
  }

  /** @private */
  _trackTimer(fn, ms) {
    const id = setTimeout(fn, ms);
    this._timers.push(id);
    return id;
  }

  _cleanup() {
    this._requestSequence++;
    this._clearTrackedListeners();

    for (const id of this._timers) {
      clearTimeout(id);
    }
    this._timers = [];

    this.chatId = null;
    this.summaries = [];
  }

  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

module.exports = ChatSummaryModal;
