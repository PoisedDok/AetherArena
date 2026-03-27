'use strict';

/**
 * @.architecture
 * 
 * Incoming: EventBus (chat-reference:attach-requested-from-input), ChatService (all chats), chat summary bridge --- {event.custom, Chat[], ipc_response}
 * Processing: Display chat list with multi-select, show summary status, generate summaries if needed --- {6 jobs: JOB_CREATE_DOM_ELEMENT, JOB_HTTP_REQUEST, JOB_FILTER_DATA, JOB_EMIT_EVENT, JOB_UPDATE_DOM_ELEMENT, JOB_BACKGROUND_TASK}
 * Outgoing: EventBus (chat-reference:chats-selected with selectedChats array), DOM (modal overlay) --- {event.custom, HTMLElement}
 * 
 * @.security innerHTML audit: SAFE
 * Chat titles and dates set via textContent. innerHTML only for static UI (search bar, SVG icons,
 * checkmarks, status badges, empty states). No user data interpolated into HTML.
 * 
 * @module renderer/chat/modals/ChatSelectorModal
 */

const BaseModal = require('../../shared/modals/BaseModal');
const { createRendererLogger } = require('../../shared/utils/logger');
const { getAether } = require('../../shared/bridge/AetherBridge');

class ChatSelectorModal extends BaseModal {
  constructor(options = {}) {
    super({ ...options, id: 'chat-selector-modal', showFooter: true, maxWidth: '700px' });
    
    this.eventBus = options.eventBus;
    this.chatService = options.chatService || null; // Inject ChatService
    this.sourceChatId = null;
    this.excludeChatIds = [];
    this.chats = [];
    this.filteredChats = [];
    this.searchQuery = '';
    this.searchInput = null;
    this.selectedChatIds = new Set();
    this.chatSummaries = new Map(); // chatId -> summary data
    this.processingChats = new Set(); // chatIds being summarized
    this.addButton = null;
    this.aether = options.aether || getAether();
    
    this._handleSearch = this._handleSearch.bind(this);
    this._handleAddSelected = this._handleAddSelected.bind(this);
    
    // Lifecycle tracking
    this._listeners = [];
    this._timers = [];
    
    this.log = createRendererLogger('ChatSelectorModal');
    this._injectStyles();
  }

  _injectStyles() {
    const styleId = 'chat-selector-modal-styles';
    if (document.getElementById(styleId)) return;
    
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      @keyframes spinner-rotate {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      .spinner {
        animation: spinner-rotate 1s linear infinite;
      }
    `;
    document.head.appendChild(style);
  }

  async open(sourceChatId = null, excludeChatIds = []) {
    this.sourceChatId = sourceChatId;
    this.excludeChatIds = excludeChatIds || [];
    this.selectedChatIds.clear();
    this.chatSummaries.clear();
    this.processingChats.clear();
    
    if (this.sourceChatId && !this.excludeChatIds.includes(this.sourceChatId)) {
      this.excludeChatIds.push(this.sourceChatId);
    }
    
    super.open();
    this._renderContent();
    const loaded = await this._loadChats();
    if (loaded) {
      await this._loadSummaries();
    }
  }

  _renderContent() {
    
    // CRITICAL: Clear existing content to prevent duplicate renders
    if (this.headerEl) this.headerEl.innerHTML = '';
    if (this.bodyEl) this.bodyEl.innerHTML = '';
    if (this.footerEl) this.footerEl.innerHTML = '';
    
    // Header
    const title = document.createElement('h3');
    title.textContent = 'Attach Chat Summaries';
    title.className = 'cm-title csm-modal-title';
    
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '×';
    closeBtn.className = 'cm-action-btn cm-action-btn--close';
    closeBtn.setAttribute('aria-label', 'Close dialog');
    this._trackListener(closeBtn, 'click', () => this.close());
    
    this.headerEl.appendChild(title);
    this.headerEl.appendChild(closeBtn);
    
    // Selection info with neutral colors
    const selectionInfo = document.createElement('div');
    selectionInfo.className = 'csm-selection-info';
    this.selectionInfo = selectionInfo;
    
    // Search bar
    const searchBar = document.createElement('div');
    searchBar.className = 'csm-search-bar';
    searchBar.innerHTML = `
      <input type="text" class="csm-search-input" placeholder="Search chats..." />
      <svg class="csm-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary)" stroke-width="2">
        <circle cx="11" cy="11" r="8"></circle>
        <path d="m21 21-4.35-4.35"></path>
      </svg>
    `;
    
    this.searchInput = searchBar.querySelector('.csm-search-input');
    this._trackListener(this.searchInput, 'input', this._handleSearch);
    
    // List container - just a wrapper, body handles scrolling
    const listContainer = document.createElement('div');
    listContainer.className = 'chat-list-container';
    
    this.listContainer = listContainer;
    
    this.bodyEl.appendChild(selectionInfo);
    this.bodyEl.appendChild(searchBar);
    this.bodyEl.appendChild(listContainer);
    
    // Footer - use the modal's footer element (if it exists)
    if (this.footerEl) {
      this.footerEl.classList.add('csm-footer');
      
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.className = 'csm-btn-cancel';
      this._trackListener(cancelBtn, 'click', () => this.close());
      
      this.addButton = document.createElement('button');
      this.addButton.textContent = 'Add Selected';
      this.addButton.disabled = true;
      this.addButton.className = 'csm-btn-select';
      this._trackListener(this.addButton, 'click', this._handleAddSelected);
      
      this.footerEl.appendChild(cancelBtn);
      this.footerEl.appendChild(this.addButton);
    } else {
      // No footer element - create a fallback button container in body
      const buttonContainer = document.createElement('div');
      buttonContainer.className = 'csm-button-container';
      
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.className = 'csm-btn-cancel';
      this._trackListener(cancelBtn, 'click', () => this.close());
      
      this.addButton = document.createElement('button');
      this.addButton.textContent = 'Add Selected';
      this.addButton.disabled = true;
      this.addButton.className = 'csm-btn-select';
      this._trackListener(this.addButton, 'click', this._handleAddSelected);
      
      buttonContainer.appendChild(cancelBtn);
      buttonContainer.appendChild(this.addButton);
      this.bodyEl.appendChild(buttonContainer);
    }
    
    // Focus search input
    this._trackTimer(() => this.searchInput && this.searchInput.focus(), 100);
  }

  async _loadChats() {
    try {
      this.listContainer.innerHTML = `
        <div class="skeleton-container">
          <div class="skeleton-card"><div class="skeleton-row"><div class="skeleton-circle"></div><div class="skeleton-line skeleton-line--lg" style="flex:1"></div></div><div class="skeleton-line skeleton-line--sm"></div></div>
          <div class="skeleton-card"><div class="skeleton-row"><div class="skeleton-circle"></div><div class="skeleton-line skeleton-line--md" style="flex:1"></div></div><div class="skeleton-line skeleton-line--sm"></div></div>
          <div class="skeleton-card"><div class="skeleton-row"><div class="skeleton-circle"></div><div class="skeleton-line skeleton-line--lg" style="flex:1"></div></div><div class="skeleton-line skeleton-line--sm"></div></div>
          <div class="skeleton-card"><div class="skeleton-row"><div class="skeleton-circle"></div><div class="skeleton-line skeleton-line--md" style="flex:1"></div></div><div class="skeleton-line skeleton-line--sm"></div></div>
        </div>`;
      
      // Use ChatService to load chats
      let chats = [];
      if (this.chatService && typeof this.chatService.loadAllChats === 'function') {
        const chatObjects = await this.chatService.loadAllChats();
        // Convert Chat domain objects to plain objects for display
        chats = (chatObjects || []).map(chat => ({
          id: chat.id || chat._id,
          title: chat.title || chat._title || 'Untitled Chat',
          created_at: chat.createdAt || chat._createdAt || chat.created_at,
          updated_at: chat.updatedAt || chat._updatedAt || chat.updated_at
        }));
      } else {
        this.log.warn('ChatService not available');
      }
      
      this.chats = chats.filter(chat => !this.excludeChatIds.includes(chat.id));
      
      this.filteredChats = [...this.chats];
      this._renderChatList();
      return true;
    } catch (error) {
      this.log.error('failed to load chats', { error });
      this.listContainer.innerHTML = `
        <div class="modal-empty-state">
          <div class="modal-empty-title" style="color: var(--color-error);">Failed to load chats</div>
          <div class="modal-empty-text">Please try again later.</div>
        </div>
      `;
      return false;
    }
  }

  async _loadSummaries() {
    try {
      // Load summaries for all chats
      for (const chat of this.chats) {
        try {
          const summaries = await this.aether?.chatSummaries?.list(chat.id);
          if (summaries && summaries.length > 0) {
            this.chatSummaries.set(chat.id, summaries[0]);
          }
        } catch (error) {
          // Chat might not have summary yet
          this.log.debug('no summary for chat', { chatId: chat.id });
        }
      }
      this._renderChatList();
    } catch (error) {
      this.log.error('failed to load summaries', { error });
    }
  }

  _renderChatList() {
    this.listContainer.innerHTML = '';
    
    if (this.filteredChats.length === 0) {
      this.listContainer.innerHTML = `
        <div class="modal-empty-state">
          <div class="modal-empty-text">${this.searchQuery ? 'No chats match your search' : 'No chats available'}</div>
        </div>
      `;
      return;
    }
    
    this.filteredChats.forEach(chat => {
      const card = this._createChatCard(chat);
      this.listContainer.appendChild(card);
    });
  }

  _createChatCard(chat) {
    const isSelected = this.selectedChatIds.has(chat.id);
    const isProcessing = this.processingChats.has(chat.id);
    const hasSummary = this.chatSummaries.has(chat.id);
    
    const card = document.createElement('div');
    card.className = `csm-card${isSelected ? ' is-selected' : ''}${isProcessing ? ' is-processing' : ''}`;
    card.dataset.chatId = chat.id;
    
    this._trackListener(card, 'click', (e) => {
      if (!isProcessing) {
        this._toggleChatSelection(chat, card);
      }
    });
    
    // Checkbox
    const checkbox = document.createElement('div');
    checkbox.className = 'csm-checkbox';
    
    if (isSelected) {
      checkbox.innerHTML = `
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      `;
    }
    
    // Content
    const content = document.createElement('div');
    content.className = 'csm-card-content';
    
    const titleRow = document.createElement('div');
    titleRow.className = 'csm-title-row';
    
    const title = document.createElement('div');
    title.textContent = chat.title || 'Untitled Chat';
    title.className = 'csm-chat-title';
    
    // Summary status badge
    const statusContainer = document.createElement('div');
    statusContainer.className = 'csm-status-container';
    
    if (isProcessing) {
      statusContainer.innerHTML = `
        <span class="csm-badge csm-badge--processing">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spinner">
            <circle cx="12" cy="12" r="10"></circle>
          </svg>
          Processing
        </span>
      `;
    } else if (hasSummary) {
      const summaryBadge = document.createElement('span');
      summaryBadge.className = 'csm-badge csm-badge--summarized';
      summaryBadge.textContent = 'Summarized';
      
      const regenBtn = document.createElement('button');
      regenBtn.title = 'Regenerate summary';
      regenBtn.setAttribute('aria-label', 'Regenerate summary');
      regenBtn.className = 'csm-icon-btn';
      regenBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="23 4 23 10 17 10"></polyline>
          <polyline points="1 20 1 14 7 14"></polyline>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
        </svg>
      `;
      this._trackListener(regenBtn, 'click', (e) => {
        e.stopPropagation();
        this._generateSummaryForChat(chat.id, { forceRegenerate: true });
      });
      
      statusContainer.appendChild(summaryBadge);
      statusContainer.appendChild(regenBtn);
    } else {
      const generateBtn = document.createElement('button');
      generateBtn.textContent = 'Generate';
      generateBtn.title = 'Generate summary';
      generateBtn.className = 'csm-generate-btn';
      this._trackListener(generateBtn, 'click', (e) => {
        e.stopPropagation();
        this._generateSummaryForChat(chat.id);
      });
      
      statusContainer.appendChild(generateBtn);
    }
    
    titleRow.appendChild(title);
    titleRow.appendChild(statusContainer);
    
    const meta = document.createElement('div');
    meta.className = 'csm-meta';
    
    const date = new Date(chat.created_at || Date.now());
    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    meta.textContent = `Created ${dateStr}`;
    
    content.appendChild(titleRow);
    content.appendChild(meta);
    
    card.appendChild(checkbox);
    card.appendChild(content);
    
    return card;
  }

  _handleSearch(event) {
    this.searchQuery = event.target.value.toLowerCase().trim();
    
    if (!this.searchQuery) {
      this.filteredChats = [...this.chats];
    } else {
      this.filteredChats = this.chats.filter(chat => {
        const title = (chat.title || '').toLowerCase();
        return title.includes(this.searchQuery);
      });
    }
    
    this._renderChatList();
  }

  _toggleChatSelection(chat, cardElement) {
    if (this.selectedChatIds.has(chat.id)) {
      this.selectedChatIds.delete(chat.id);
    } else {
      this.selectedChatIds.add(chat.id);
    }
    
    this._updateSelectionUI();
    this._renderChatList(); // Re-render to update checkboxes
  }

  _updateSelectionUI() {
    const count = this.selectedChatIds.size;
    const selectedChatIds = Array.from(this.selectedChatIds);
    const chatsNeedingSummary = selectedChatIds.filter(chatId => !this.chatSummaries.has(chatId));
    const chatsProcessing = selectedChatIds.filter(chatId => this.processingChats.has(chatId));
    
    if (count > 0) {
      this.selectionInfo.style.display = 'block';
      this.selectionInfo.textContent = `${count} chat${count > 1 ? 's' : ''} selected`;
      
      if (chatsProcessing.length > 0) {
        this.selectionInfo.textContent = `Generating summaries for ${chatsProcessing.length} selected chat${chatsProcessing.length > 1 ? 's' : ''}...`;
        this.selectionInfo.style.background = 'var(--color-warning-bg)';
        this.selectionInfo.style.borderColor = 'var(--color-warning-border)';
        this.selectionInfo.style.color = 'var(--color-warning)';
        this._disableAddButton();
      } else if (chatsNeedingSummary.length > 0) {
        this.selectionInfo.textContent = `Generate summaries for ${chatsNeedingSummary.length} selected chat${chatsNeedingSummary.length > 1 ? 's' : ''} to attach.`;
        this.selectionInfo.style.background = 'var(--color-surface-base)';
        this.selectionInfo.style.borderColor = 'var(--color-border-base)';
        this.selectionInfo.style.color = 'var(--color-text-secondary)';
        this._disableAddButton();
      } else {
        this.selectionInfo.style.background = 'var(--color-surface-base)';
        this.selectionInfo.style.borderColor = 'var(--color-border-base)';
        this.selectionInfo.style.color = 'var(--color-text-secondary)';
        this._enableAddButton();
      }
    } else {
      this.selectionInfo.style.display = 'none';
      this._disableAddButton();
    }
  }

  _enableAddButton() {
    if (!this.addButton) return;
    this.addButton.disabled = false;
  }

  _disableAddButton() {
    if (!this.addButton) return;
    this.addButton.disabled = true;
  }

  async _handleAddSelected() {
    if (this.selectedChatIds.size === 0) return;
    
    this.log.debug('adding selected chats', { 
      count: this.selectedChatIds.size,
      chatIds: Array.from(this.selectedChatIds)
    });
    
    const chatsNeedingSummary = Array.from(this.selectedChatIds).filter(
      chatId => !this.chatSummaries.has(chatId)
    );
    const chatsProcessing = Array.from(this.selectedChatIds).filter(
      chatId => this.processingChats.has(chatId)
    );
    
    if (chatsProcessing.length > 0) {
      this._updateSelectionUI();
      return;
    }
    
    if (chatsNeedingSummary.length > 0) {
      this._updateSelectionUI();
      return;
    }
    
    // All chats have summaries, proceed immediately
    this._emitSelection();
  }

  async _generateSummaryForChat(chatId, options = {}) {
    if (!chatId || this.processingChats.has(chatId)) {
      return;
    }
    
    this.processingChats.add(chatId);
    this._renderChatList();
    this._updateSelectionUI();
    
    try {
      this.log.debug('generating summary', { chatId, options });
      const summary = await this.aether?.chatSummaries?.generate(chatId, options);
      if (summary) {
        this.chatSummaries.set(chatId, summary);
      }
    } catch (error) {
      this.log.error('failed to generate summary', { chatId, error });
    } finally {
      this.processingChats.delete(chatId);
      this._renderChatList();
      this._updateSelectionUI();
    }
  }

  /**
   * Track an event listener for deterministic cleanup.
   * @private
   */
  _trackListener(element, event, handler, options) {
    if (!element) return;
    element.addEventListener(event, handler, options);
    this._listeners.push({ element, event, handler, options });
  }

  /**
   * Track a timer for deterministic cleanup.
   * @private
   */
  _trackTimer(fn, ms) {
    const id = setTimeout(fn, ms);
    this._timers.push(id);
    return id;
  }

  /**
   * Cleanup on modal close (called by BaseModal).
   * Removes all tracked listeners, clears timers, resets state.
   * @private
   */
  _cleanup() {
    // Remove all tracked listeners
    for (const { element, event, handler, options } of this._listeners) {
      element?.removeEventListener(event, handler, options);
    }
    this._listeners = [];

    // Clear all tracked timers
    for (const id of this._timers) {
      clearTimeout(id);
    }
    this._timers = [];

    // Reset state
    this.selectedChatIds.clear();
    this.chatSummaries.clear();
    this.processingChats.clear();
    this.chats = [];
    this.filteredChats = [];
    this.searchQuery = '';

    // Clear DOM references
    this.searchInput = null;
    this.selectionInfo = null;
    this.listContainer = null;
    this.addButton = null;
  }

  _emitSelection() {
    const selectedChats = this.chats.filter(chat => 
      this.selectedChatIds.has(chat.id)
    );
    
    this.log.debug('emitting selection', { 
      count: selectedChats.length, 
      selectedChats: selectedChats.map(c => ({ id: c.id, title: c.title }))
    });
    
    if (this.eventBus) {
      // Emit single event with all selected chats
      this.eventBus.emit('chat-reference:chats-selected', {
        sourceChatId: this.sourceChatId,
        selectedChats: selectedChats
      });
    }
    
    this.close();
  }
}

module.exports = ChatSelectorModal;
