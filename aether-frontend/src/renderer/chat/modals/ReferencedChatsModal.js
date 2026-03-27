'use strict';

/**
 * @.architecture
 * 
 * Incoming: Context menu (View References), chat references bridge --- {user_click, ipc_response}
 * Processing: Display referenced chats as floating centered modal with unlink options --- {4 jobs: JOB_CREATE_DOM_ELEMENT, JOB_HTTP_REQUEST, JOB_RENDER, JOB_DELETE}
 * Outgoing: Floating modal overlay, EventBus (chat-reference:deleted) --- {HTMLElement, event.custom}
 * 
 * @module renderer/chat/modals/ReferencedChatsModal
 */

const BaseModal = require('../../shared/modals/BaseModal');
const { createRendererLogger } = require('../../shared/utils/logger');
const { getAether } = require('../../shared/bridge/AetherBridge');

class ReferencedChatsModal extends BaseModal {
  constructor(options = {}) {
    super({
      ...options,
      id: 'referenced-chats-modal',
      title: 'Context Chats'
    });
    
    this.log = createRendererLogger('ReferencedChatsModal');
    this.eventBus = options.eventBus;
    this.chatId = null;
    this.references = [];
    this.aether = options.aether || getAether();

    // Lifecycle tracking
    this._listeners = [];
  }

  async open(chatId) {
    if (!chatId) {
      this.log.warn('No chatId provided');
      return;
    }
    
    this.chatId = chatId;
    super.open();
    this._renderContent();
    await this._loadReferences();
  }

  _renderContent() {
    // Clear body
    this.bodyEl.innerHTML = '';
    
    const title = document.createElement('h3');
    title.textContent = 'Context Chats';
    title.className = 'cm-section-title';
    
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '×';
    closeBtn.className = 'cm-action-btn cm-action-btn--close';
    closeBtn.setAttribute('aria-label', 'Close dialog');
    this._trackListener(closeBtn, 'click', () => this.close());
    
    this.headerEl.innerHTML = '';
    this.headerEl.appendChild(title);
    this.headerEl.appendChild(closeBtn);
    
    // Skeleton loading state (contextual to reference-card layout)
    this.bodyEl.innerHTML = `
      <div class="skeleton-container">
        <div class="skeleton-card"><div class="skeleton-line skeleton-line--lg"></div><div class="skeleton-line skeleton-line--sm"></div></div>
        <div class="skeleton-card"><div class="skeleton-line skeleton-line--md"></div><div class="skeleton-line skeleton-line--sm"></div></div>
        <div class="skeleton-card"><div class="skeleton-line skeleton-line--lg"></div><div class="skeleton-line skeleton-line--sm"></div></div>
      </div>`;
  }

  async _loadReferences() {
    try {
      const references = await this.aether?.chatReferences?.list(this.chatId);
      this.references = Array.isArray(references) ? references : [];
      
      if (this.references.length > 0) {
        this._displayReferences(this.references);
      } else {
        this._showEmptyState();
      }
    } catch (error) {
      this.log.debug('chat does not support references', { chatId: this.chatId });
      this._showEmptyState();
    }
  }

  _displayReferences(references) {
    this.bodyEl.innerHTML = '';
    
    references.forEach((ref) => {
      const card = document.createElement('div');
      card.className = 'rcm-card';
      
      // Chat info
      const info = document.createElement('div');
      info.className = 'rcm-info';
      
      const chatTitle = document.createElement('div');
      chatTitle.textContent = ref.metadata?.title || ref.target_chat_id;
      chatTitle.className = 'rcm-chat-title';
      
      const chatMeta = document.createElement('div');
      chatMeta.className = 'rcm-chat-meta';
      chatMeta.textContent = `Type: ${ref.reference_type || 'context'}`;
      
      info.appendChild(chatTitle);
      info.appendChild(chatMeta);
      
      // Unlink button
      const unlinkBtn = document.createElement('button');
      unlinkBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      `;
      unlinkBtn.className = 'rcm-unlink-btn';
      unlinkBtn.setAttribute('aria-label', 'Remove reference');
      this._trackListener(unlinkBtn, 'click', () => this._handleUnlink(ref));
      
      card.appendChild(info);
      card.appendChild(unlinkBtn);
      
      this.bodyEl.appendChild(card);
    });
  }

  _showEmptyState() {
    this.bodyEl.innerHTML = `
      <div class="csumm-empty">
        <svg class="rcm-empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path>
        </svg>
        <p class="csumm-empty-message">No context chats attached</p>
        <p class="rcm-empty-hint">Use the attach button to link related conversations</p>
      </div>
    `;
  }

  /** @private */
  _trackListener(element, event, handler, options) {
    if (!element) return;
    element.addEventListener(event, handler, options);
    this._listeners.push({ element, event, handler, options });
  }

  /**
   * Cleanup on modal close (called by BaseModal).
   * @private
   */
  _cleanup() {
    for (const { element, event, handler, options } of this._listeners) {
      element?.removeEventListener(event, handler, options);
    }
    this._listeners = [];
    this.chatId = null;
    this.references = [];
  }

  async _handleUnlink(ref) {
    try {
      await this.aether?.chatReferences?.delete(ref.source_chat_id, ref.target_chat_id);
      
      // Emit event for other components
      if (this.eventBus) {
        this.eventBus.emit('chat-reference:deleted', {
          sourceChatId: ref.source_chat_id,
          targetChatId: ref.target_chat_id
        });
      }
      
      // Reload
      await this._loadReferences();
      
      this.log.info('reference deleted', { ref });
    } catch (error) {
      this.log.error('failed to delete reference', { error, ref });
    }
  }
}

module.exports = ReferencedChatsModal;
