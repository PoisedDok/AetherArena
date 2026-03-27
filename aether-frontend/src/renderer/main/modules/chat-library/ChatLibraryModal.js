'use strict';

/**
 * @.architecture
 * Incoming: MainApp (user opens modal), Endpoint (HTTP API) --- {user_click, api_response}
 * Processing: Display chat library with date grouping, search, CRUD operations --- {JOB_RENDER, JOB_QUERY_DB, JOB_DELETE, JOB_UPDATE}
 * Outgoing: Chat window (open selected chat), Endpoint (API calls) --- {chat_open_event, http_request}
 * 
 * @.security innerHTML audit: SAFE
 * Chat titles, dates, message counts set via textContent. innerHTML only for static UI
 * (skeletons, search bar, empty states, SVG icons). escapeHtml() helper exists for edge cases.
 * 
 * @module renderer/main/modules/chat-library/ChatLibraryModal
 */

const BaseModal = require('../../../shared/modals/BaseModal');
const Toast = require('../../../shared/components/Toast');
const ConfirmDialog = require('../../../shared/components/ConfirmDialog');
const { getAether } = require('../../../shared/bridge/AetherBridge');
const { createRendererLogger } = require('../../../shared/utils/logger');

/**
 * Chat Library Modal
 * 
 * Displays all user chats grouped by date with options to:
 * - Search/filter chats
 * - Edit chat titles
 * - Delete chats
 * - Open chat in chat window
 * - Create new chat
 */
class ChatLibraryModal extends BaseModal {
  constructor(options = {}) {
    // Extract non-serializable objects before passing to super
    const { eventBus, endpoint, chatWindow, ...baseOptions } = options;
    
    super({
      ...baseOptions,
      id: 'chat-library-modal',
      title: 'Chat Library',
      size: 'lg',
      heightPreset: 'default'
    });
    
    const aether = getAether();
    this.endpoint = endpoint || aether?.endpoint || null;
    this.chatWindow = chatWindow || null;
    this.eventBus = eventBus || null;
    
    // State
    this.chats = [];
    this.filteredChats = [];
    this.searchQuery = '';
    
    // Lifecycle tracking
    this._listeners = [];
    this._openSequence = 0;
    
    this.log = createRendererLogger('ChatLibraryModal');
    
    // Bind methods
    this._handleSearch = this._handleSearch.bind(this);
    this._handleNewChat = this._handleNewChat.bind(this);
  }

  /**
   * Render modal content
   * @private
   */
  async _renderContent() {
    if (!this.endpoint) {
      this.bodyEl.innerHTML = '<div class="modal-empty-state"><p>Endpoint not initialized</p></div>';
      return;
    }
    
    // Show skeleton loading state
    this.bodyEl.innerHTML = `
      <div class="skeleton-container">
        <div class="skeleton-row"><div class="skeleton-line skeleton-line--lg skeleton-line--thick"></div></div>
        <div class="skeleton-card"><div class="skeleton-row"><div class="skeleton-circle"></div><div class="skeleton-line skeleton-line--md" style="flex:1"></div></div><div class="skeleton-line skeleton-line--full"></div><div class="skeleton-line skeleton-line--sm"></div></div>
        <div class="skeleton-card"><div class="skeleton-row"><div class="skeleton-circle"></div><div class="skeleton-line skeleton-line--md" style="flex:1"></div></div><div class="skeleton-line skeleton-line--full"></div><div class="skeleton-line skeleton-line--sm"></div></div>
        <div class="skeleton-card"><div class="skeleton-row"><div class="skeleton-circle"></div><div class="skeleton-line skeleton-line--md" style="flex:1"></div></div><div class="skeleton-line skeleton-line--lg"></div></div>
      </div>`;
    
    const seq = ++this._openSequence;
    try {
      const response = await this.endpoint.listChats(0, 100);
      if (seq !== this._openSequence) return;
      this.chats = response.data || response || [];
      this.filteredChats = [...this.chats];
      
      this._renderUI();
    } catch (error) {
      if (seq !== this._openSequence) return;
      this.log.error('[ChatLibraryModal] Failed to load chats:', error);
      this.bodyEl.innerHTML = `
        <div class="modal-empty-state">
          <div class="modal-empty-title">Failed to Load Chats</div>
          <div class="modal-empty-text">${this._escapeHtml(error.message || 'Unknown error')}</div>
        </div>
      `;
    }
  }

  _updateDOM(parent, newElement) {
    if (!parent || !newElement) return;
    const morphChildren = (oldParent, newParent) => {
      const oldChildren = Array.from(oldParent.childNodes);
      const newChildren = Array.from(newParent.childNodes);
      const max = Math.max(oldChildren.length, newChildren.length);
      
      for (let i = 0; i < max; i++) {
        const oldChild = oldChildren[i];
        const newChild = newChildren[i];
        
        if (!oldChild && newChild) {
          oldParent.appendChild(newChild.cloneNode(true));
        } else if (oldChild && !newChild) {
          oldParent.removeChild(oldChild);
        } else if (oldChild.nodeType !== newChild.nodeType || oldChild.nodeName !== newChild.nodeName) {
          oldParent.replaceChild(newChild.cloneNode(true), oldChild);
        } else if (oldChild.nodeType === Node.TEXT_NODE) {
          if (oldChild.textContent !== newChild.textContent) {
            oldChild.textContent = newChild.textContent;
          }
        } else if (oldChild.nodeType === Node.ELEMENT_NODE) {
          if (!oldChild.isEqualNode(newChild)) {
            // Update attributes
            const newAttrs = newChild.attributes;
            for (let j = oldChild.attributes.length - 1; j >= 0; j--) {
              const attrName = oldChild.attributes[j].name;
              if (!newChild.hasAttribute(attrName) && attrName !== 'value') {
                oldChild.removeAttribute(attrName);
              }
            }
            for (let j = 0; j < newAttrs.length; j++) {
              if (oldChild.getAttribute(newAttrs[j].name) !== newAttrs[j].value) {
                oldChild.setAttribute(newAttrs[j].name, newAttrs[j].value);
              }
            }
            if ('value' in newChild && oldChild.value !== newChild.value) {
              oldChild.value = newChild.value;
            }
            if ('checked' in newChild && oldChild.checked !== newChild.checked) {
              oldChild.checked = newChild.checked;
            }
            // Recurse
            morphChildren(oldChild, newChild);
          }
        }
      }
    };
    morphChildren(parent, newElement);
  }

  /**
   * Render modal UI
   * @private
   */
  _renderUI() {
    this._clearListeners();
    this.bodyEl.innerHTML = '';
    
    // Create premium search bar with integrated action button
    const searchBar = document.createElement('div');
    searchBar.className = 'modal-search-bar modal-search-with-action';
    searchBar.innerHTML = `
      <div class="modal-search-wrapper">
        <svg class="modal-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"></circle>
          <path d="m21 21-4.35-4.35"></path>
        </svg>
        <input type="text" class="modal-search-input" placeholder="Search chats..." id="chat-search-input">
      </div>
      <button class="modal-action-icon-btn modal-action-primary" title="New Chat">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
      </button>
    `;
    
    const searchInput = searchBar.querySelector('#chat-search-input');
    this._trackListener(searchInput, 'input', this._handleSearch);
    
    const newBtn = searchBar.querySelector('.modal-action-icon-btn');
    this._trackListener(newBtn, 'click', this._handleNewChat);
    
    this.bodyEl.appendChild(searchBar);
    
    // Setup event delegation for chat list actions
    this._trackListener(this.bodyEl, 'click', (e) => {
      const editBtn = e.target.closest('.chat-action-edit');
      if (editBtn) {
        e.stopPropagation();
        const card = editBtn.closest('.modal-card');
        const titleEl = card.querySelector('.modal-card-title');
        this._handleEdit(card.dataset.chatId, titleEl);
        return;
      }
      
      const deleteBtn = e.target.closest('.chat-action-delete');
      if (deleteBtn) {
        e.stopPropagation();
        const card = deleteBtn.closest('.modal-card');
        const titleEl = card.querySelector('.modal-card-title');
        this._handleDelete(card.dataset.chatId, titleEl.textContent);
        return;
      }
      
      const cardEl = e.target.closest('.modal-card');
      if (cardEl && !e.target.closest('.modal-card-title-edit')) {
        this._handleOpen(cardEl.dataset.chatId);
        return;
      }
    });
    
    // Render chat list
    this._renderChatList();
  }

  /**
   * Render chat list grouped by date
   * @private
   */
  _renderChatList() {
    const listContainer = document.createElement('div');
    listContainer.className = 'chat-list-container';
    
    if (this.filteredChats.length === 0) {
      listContainer.innerHTML = `
        <div class="modal-empty-state">
          <div class="modal-empty-title">No Chats Found</div>
          <div class="modal-empty-text">${this.searchQuery ? 'Try a different search query' : 'Create your first chat to get started'}</div>
        </div>
      `;
      const existingList = this.bodyEl.querySelector('.chat-list-container');
      if (existingList) {
        this._updateDOM(existingList, listContainer);
      } else {
        this.bodyEl.appendChild(listContainer);
      }
      return;
    }
    
    // Group chats by date
    const groups = this._groupChatsByDate(this.filteredChats);
    
    // Render each group
    for (const [groupName, chats] of Object.entries(groups)) {
      const groupEl = document.createElement('div');
      groupEl.className = 'date-group';
      
      const headerEl = document.createElement('div');
      headerEl.className = 'date-group-header';
      headerEl.textContent = groupName;
      groupEl.appendChild(headerEl);
      
      const contentEl = document.createElement('div');
      contentEl.className = 'date-group-content';
      
      chats.forEach(chat => {
        const cardEl = this._createChatCard(chat);
        contentEl.appendChild(cardEl);
      });
      
      groupEl.appendChild(contentEl);
      listContainer.appendChild(groupEl);
    }
    
    const existingList = this.bodyEl.querySelector('.chat-list-container');
    if (existingList) {
      this._updateDOM(existingList, listContainer);
    } else {
      this.bodyEl.appendChild(listContainer);
    }
  }

  /**
   * Create chat card element
   * @private
   */
  _createChatCard(chat) {
    const card = document.createElement('div');
    card.className = 'modal-card';
    card.dataset.chatId = chat.id;
    
    const header = document.createElement('div');
    header.className = 'modal-card-header';
    
    const title = document.createElement('div');
    title.className = 'modal-card-title';
    title.textContent = chat.title || 'Untitled Chat';
    
    const actions = document.createElement('div');
    actions.className = 'modal-card-actions';
    
    // Edit button
    const editBtn = document.createElement('button');
    editBtn.className = 'modal-action-btn chat-action-edit';
    editBtn.title = 'Edit';
    editBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>';
    
    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'modal-action-btn danger chat-action-delete';
    deleteBtn.title = 'Delete';
    deleteBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
    
    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);
    
    header.appendChild(title);
    header.appendChild(actions);
    
    const meta = document.createElement('div');
    meta.className = 'modal-card-meta';
    const messageCount = chat.message_count || 0;
    const date = this._formatDate(chat.updated_at || chat.created_at);
    meta.textContent = `${messageCount} ${messageCount === 1 ? 'message' : 'messages'} • ${date}`;
    
    card.appendChild(header);
    card.appendChild(meta);
    
    return card;
  }

  /**
   * Group chats by date
   * @private
   */
  _groupChatsByDate(chats) {
    const groups = {
      'Today': [],
      'Yesterday': [],
      'This Week': [],
      'This Month': [],
      'Older': []
    };
    
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const monthAgo = new Date(today);
    monthAgo.setMonth(monthAgo.getMonth() - 1);
    
    chats.forEach(chat => {
      const chatDate = new Date(chat.updated_at || chat.created_at);
      
      if (chatDate >= today) {
        groups['Today'].push(chat);
      } else if (chatDate >= yesterday) {
        groups['Yesterday'].push(chat);
      } else if (chatDate >= weekAgo) {
        groups['This Week'].push(chat);
      } else if (chatDate >= monthAgo) {
        groups['This Month'].push(chat);
      } else {
        groups['Older'].push(chat);
      }
    });
    
    // Remove empty groups
    Object.keys(groups).forEach(key => {
      if (groups[key].length === 0) {
        delete groups[key];
      }
    });
    
    return groups;
  }

  /**
   * Format date for display
   * @private
   */
  _formatDate(dateStr) {
    const date = new Date(dateStr);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    if (date >= today) {
      return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } else if (date >= new Date(today.getTime() - 86400000)) {
      return 'Yesterday';
    } else {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  }

  /**
   * Handle search input
   * @private
   */
  _handleSearch(e) {
    this.searchQuery = e.target.value.toLowerCase();
    
    if (this.searchQuery === '') {
      this.filteredChats = [...this.chats];
    } else {
      this.filteredChats = this.chats.filter(chat =>
        (chat.title || '').toLowerCase().includes(this.searchQuery)
      );
    }
    
    this._renderChatList();
  }

  /**
   * Handle new chat
   * @private
   */
  async _handleNewChat() {
    // ARCHITECTURAL FIX: Don't switch windows, emit event for parent to handle
    if (this.eventBus) {
      this.eventBus.emit('modal:chat-new-requested');
    }
    // Keep modal open so user sees what happens
  }

  /**
   * Handle chat edit
   * @private
   */
  async _handleEdit(chatId, titleElement) {
    const currentTitle = titleElement.textContent;
    
    // Create a simple inline edit input
    const originalHTML = titleElement.innerHTML;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentTitle;
    input.className = 'modal-card-title-edit';
    input.style.cssText = 'background: var(--color-surface-base); border: 1px solid var(--color-accent-border); border-radius: var(--radius-sm); padding: 4px 8px; color: var(--color-text-primary); font-size: var(--font-size-base); font-weight: var(--font-weight-semibold); width: 100%;';
    
    titleElement.innerHTML = '';
    titleElement.appendChild(input);
    input.focus();
    input.select();
    
    const handleSave = async () => {
      const newTitle = input.value.trim();
      if (newTitle && newTitle !== currentTitle) {
        try {
          await this.endpoint.updateChat(chatId, { title: newTitle });
          titleElement.textContent = newTitle;
          
          // Update in memory
          const chat = this.chats.find(c => c.id === chatId);
          if (chat) chat.title = newTitle;
        } catch (error) {
          this.log.error('[ChatLibraryModal] Failed to update chat:', error);
          Toast.error('Failed to update chat title. Please try again.');
          titleElement.innerHTML = originalHTML;
        }
      } else {
        titleElement.innerHTML = originalHTML;
      }
    };
    
    this._trackListener(input, 'blur', handleSave);
    this._trackListener(input, 'keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        titleElement.innerHTML = originalHTML;
      }
    });
  }

  /**
   * Handle chat delete
   * @private
   */
  async _handleDelete(chatId, chatTitle) {
    const confirmed = await ConfirmDialog.confirm({
      title: 'Delete chat',
      message: `Delete chat "${chatTitle}"? This cannot be undone.`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      variant: 'danger'
    });
    
    if (confirmed) {
      try {
        await this.endpoint.deleteChat(chatId);
        
        // Remove from memory
        this.chats = this.chats.filter(c => c.id !== chatId);
        this.filteredChats = this.filteredChats.filter(c => c.id !== chatId);
        
        // Re-render
        this._renderChatList();
      } catch (error) {
        this.log.error('[ChatLibraryModal] Failed to delete chat:', error);
        Toast.error('Failed to delete chat. Please try again.');
      }
    }
  }

  /**
   * Handle chat open
   * @private
   */
  _handleOpen(chatId) {
    // ARCHITECTURAL FIX: Don't switch windows, emit event for parent to handle
    if (this.eventBus) {
      this.eventBus.emit('modal:chat-open-requested', { chatId });
    }
    // Keep modal open so user sees what happens
  }

  /**
   * Cleanup
   * @private
   */
  _cleanup() {
    this._openSequence++;
    this._clearListeners();

    this.chats = [];
    this.filteredChats = [];
    this.searchQuery = '';
  }

  /** @private Remove all tracked DOM listeners */
  _clearListeners() {
    for (const { element, event, handler, options } of this._listeners) {
      element?.removeEventListener(event, handler, options);
    }
    this._listeners = [];
  }

  /** @private */
  _trackListener(element, event, handler, options) {
    if (!element) return;
    element.addEventListener(event, handler, options);
    this._listeners.push({ element, event, handler, options });
  }

  /** @private */
  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

module.exports = ChatLibraryModal;
