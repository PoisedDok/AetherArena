'use strict';

/**
 * @.architecture
 * 
 * Incoming: User toggle button click, EventBus (CHAT.CREATED/SWITCHED/DELETED), window.storageAPI.loadChats(), MessageManager (current chat state) --- {database_types.chat_record[], json}
 * Processing: Query PostgreSQL for chat list, render sidebar with chat items (title, date, message count), handle toggle visibility with slide animation, implement click-to-switch, dblclick-to-rename, click-to-delete, backdrop/escape-to-close --- {7 jobs: JOB_LOAD_FROM_DB, JOB_CREATE_DOM_ELEMENT, JOB_UPDATE_STATE, JOB_SAVE_TO_DB, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_UPDATE_STATE}
 * Outgoing: DOM (sliding sidebar + backdrop overlay), MessageManager.loadChat(), window.storageAPI (update/delete), EventBus (CHAT.DELETED) --- {dom_types.chat_entry_element, HTMLElement}
 * 
 * 
 * @module renderer/chat/modules/sidebar/SidebarManager
 */

const { EventTypes } = require('../../../../core/events/EventTypes');

const { freeze } = Object;

/**
 * Sidebar configuration constants
 */
const CONFIG = freeze({
  SIDEBAR_WIDTH: 250,
  ANIMATION_DURATION: 400,
  REFRESH_DELAY: 50,
  MAX_TITLE_LENGTH: 50,
  DEFAULT_TITLE: 'New Chat',
  EMPTY_MESSAGE: 'No chats yet. Start a new conversation!',
});

/**
 * SidebarManager
 */
class SidebarManager {
  constructor(options = {}) {
    // Configuration
    this.chatWindow = options.chatWindow || null;
    this.messageManager = options.messageManager || null;
    this.eventBus = options.eventBus || null;

    // State
    this.isVisible = false;
    this.currentChatId = null;

    // DOM references
    this.container = null;
    this.backdrop = null;
    this.listContainer = null;
    this.toggleBtn = null;

    // Timers
    this.containerHideTimer = null;

    // Storage API
    this.storageAPI = null;

    // Event listener cleanup
    this._eventListeners = [];

    console.log('[SidebarManager] Constructed');
  }

  /**
   * Initialize sidebar
   */
  async init() {
    console.log('[SidebarManager] Initializing...');

    try {
      // Initialize storage API
      this._initStorageAPI();

      // Inject styles
      this._injectStyles();

      // Create DOM elements
      this._createContainer();
      this._createToggleButton();

      // Setup event listeners
      this._setupEventListeners();

      // Load and display chat list
      await this.refreshChatList();

      // Auto-show if chats exist
      await this._autoShow();

      console.log('[SidebarManager] Initialization complete');
    } catch (error) {
      console.error('[SidebarManager] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Initialize storage API
   * @private
   */
  _initStorageAPI() {
    if (typeof window !== 'undefined' && window.storageAPI) {
      this.storageAPI = window.storageAPI;
      console.log('[SidebarManager] Storage API available');
    } else {
      console.warn('[SidebarManager] Storage API not available - limited functionality');
    }
  }

  /**
   * Inject styles
   * @private
   */
  _injectStyles() {
    if (document.getElementById('sidebar-manager-styles')) {
      console.log('[SidebarManager] Styles already injected');
      return;
    }

    const style = document.createElement('style');
    style.id = 'sidebar-manager-styles';
    style.textContent = `
      .aether-sidebar {
        position: absolute;
        left: 0;
        top: 0;
        width: ${CONFIG.SIDEBAR_WIDTH}px;
        height: 100%;
        background: rgba(10, 10, 10, 0.90);
        backdrop-filter: blur(20px) saturate(150%);
        -webkit-backdrop-filter: blur(20px) saturate(150%);
        border-right: 1px solid rgba(255, 255, 255, 0.15);
        box-shadow: 2px 0 20px rgba(0, 0, 0, 0.6);
        display: flex;
        flex-direction: column;
        color: #e5e7eb;
        font-family: var(--font-family-base, 'Inter', -apple-system, sans-serif);
        z-index: 1999;
        transform: translateX(-100%);
        opacity: 0;
        transition: transform ${CONFIG.ANIMATION_DURATION}ms cubic-bezier(0.22, 1, 0.36, 1), 
                    opacity 350ms ease;
        will-change: transform, opacity;
      }
      
      .aether-sidebar.visible {
        transform: translateX(0);
        opacity: 1;
      }
      
      .aether-sidebar-backdrop {
        position: absolute;
        left: ${CONFIG.SIDEBAR_WIDTH}px;
        top: 0;
        right: 0;
        bottom: 0;
        background: rgba(2, 6, 23, 0.35);
        z-index: 1995;
        opacity: 0;
        visibility: hidden;
        transition: opacity 350ms ease;
        pointer-events: none;
      }
      
      .aether-sidebar-backdrop.visible {
        opacity: 1;
        visibility: visible;
        pointer-events: auto;
      }
      
      .aether-sidebar-toggle {
        position: absolute;
        top: 16px;
        left: 10px;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: #e5e7eb;
        width: 28px;
        height: 28px;
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        z-index: 3000;
        font-size: 16px;
        transition: all 0.2s ease;
      }
      
      .aether-sidebar-toggle:hover {
        background: rgba(255, 255, 255, 0.12);
        color: #fff;
        transform: scale(1.05);
      }
      
      .aether-sidebar-header {
        padding: 16px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.04);
        -webkit-app-region: no-drag;
        position: relative;
        z-index: 2001;
        pointer-events: auto;
      }
      
      .aether-sidebar-header h3 {
        margin: 0;
        color: #f3f3f3;
        font-size: 15px;
        font-weight: 600;
        letter-spacing: 0.5px;
        pointer-events: none;
      }
      
      .aether-chat-list-container {
        flex: 1;
        overflow-y: auto;
        padding: 12px;
      }
      
      .aether-chat-list-container::-webkit-scrollbar {
        width: 6px;
      }
      
      .aether-chat-list-container::-webkit-scrollbar-track {
        background: rgba(255, 255, 255, 0.02);
        border-radius: 3px;
      }
      
      .aether-chat-list-container::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.15);
        border-radius: 3px;
      }
      
      .aether-chat-list-container::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.25);
      }
      
      .aether-chat-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      
      .aether-chat-item {
        padding: 12px 14px;
        background: rgba(255, 255, 255, 0.04);
        border-radius: 8px;
        cursor: pointer;
        position: relative;
        border-left: 3px solid transparent;
        border: 1px solid rgba(255, 255, 255, 0.08);
        transition: all 0.2s ease;
      }
      
      .aether-chat-item:hover {
        background: rgba(255, 255, 255, 0.08);
        border-color: rgba(255, 255, 255, 0.15);
        transform: translateX(2px);
      }
      
      .aether-chat-item.active {
        background: rgba(255, 255, 255, 0.12);
        border-left: 3px solid rgba(255, 255, 255, 0.6);
        border-color: rgba(255, 255, 255, 0.25);
        box-shadow: 0 2px 8px rgba(255, 255, 255, 0.1);
      }
      
      .aether-chat-item-title {
        font-size: 13px;
        margin-bottom: 4px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        padding-right: 24px;
        color: #f3f3f3;
        font-weight: 500;
      }
      
      .aether-chat-item-info {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        color: rgba(255, 255, 255, 0.45);
      }
      
      .aether-chat-delete-btn {
        position: absolute;
        top: 10px;
        right: 10px;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.15);
        color: rgba(255, 255, 255, 0.85);
        border-radius: 6px;
        width: 22px;
        height: 22px;
        line-height: 20px;
        font-size: 16px;
        cursor: pointer;
        opacity: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s ease;
      }
      
      .aether-chat-item:hover .aether-chat-delete-btn {
        opacity: 1;
      }
      
      .aether-chat-delete-btn:hover {
        background: rgba(255, 50, 50, 0.15);
        border-color: rgba(255, 50, 50, 0.3);
        color: #ff6b6b;
      }
      
      .aether-chat-list-empty {
        padding: 20px 0;
        text-align: center;
        color: rgba(255, 255, 255, 0.4);
        font-style: italic;
        font-size: 13px;
      }
    `;

    document.head.appendChild(style);
    console.log('[SidebarManager] Styles injected');
  }

  /**
   * Create sidebar container
   * @private
   */
  _createContainer() {
    if (!this.chatWindow || !this.chatWindow.element) {
      console.error('[SidebarManager] ChatWindow element not available');
      return;
    }

    // Ensure chat window is a positioning context
    const windowEl = this.chatWindow.element;
    const style = window.getComputedStyle(windowEl);
    if (!['relative', 'absolute', 'fixed'].includes(style.position)) {
      windowEl.style.position = 'relative';
    }

    // Create sidebar container
    this.container = document.createElement('div');
    this.container.className = 'aether-sidebar';

    // Create header
    const header = document.createElement('div');
    header.className = 'aether-sidebar-header';

    const title = document.createElement('h3');
    title.textContent = 'GURU';
    header.appendChild(title);

    // Create list container
    const listContainer = document.createElement('div');
    listContainer.className = 'aether-chat-list-container';

    const chatList = document.createElement('div');
    chatList.className = 'aether-chat-list';
    listContainer.appendChild(chatList);

    // Assemble sidebar
    this.container.appendChild(header);
    this.container.appendChild(listContainer);

    // Insert as first child
    windowEl.insertBefore(this.container, windowEl.firstChild);

    this.listContainer = chatList;

    // Create backdrop
    this.backdrop = document.createElement('div');
    this.backdrop.className = 'aether-sidebar-backdrop';
    windowEl.appendChild(this.backdrop);

    console.log('[SidebarManager] Container created');
  }

  /**
   * Create toggle button
   * @private
   */
  _createToggleButton() {
    if (!this.chatWindow || !this.chatWindow.elements || !this.chatWindow.elements.header) {
      console.error('[SidebarManager] ChatWindow header not available');
      return;
    }

    const header = this.chatWindow.elements.header;

    // Check if button already exists
    if (header.querySelector('.aether-sidebar-toggle')) {
      console.log('[SidebarManager] Toggle button already exists');
      return;
    }

    // Create toggle button
    this.toggleBtn = document.createElement('button');
    this.toggleBtn.className = 'aether-sidebar-toggle';
    this.toggleBtn.textContent = '☰';
    this.toggleBtn.title = 'Toggle Chat List';
    this.toggleBtn.setAttribute('aria-label', 'Toggle chat list');

    // Insert before title
    const titleEl = header.querySelector('.aether-chat-title');
    if (titleEl) {
      header.insertBefore(this.toggleBtn, titleEl);
      // Add margin to title to prevent overlap
      titleEl.style.marginLeft = '35px';
    } else {
      header.appendChild(this.toggleBtn);
    }

    // Add click listener
    const toggleHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggle();
    };

    this.toggleBtn.addEventListener('click', toggleHandler);
    this._eventListeners.push({ element: this.toggleBtn, event: 'click', handler: toggleHandler });

    console.log('[SidebarManager] Toggle button created');
  }

  /**
   * Setup event listeners
   * @private
   */
  _setupEventListeners() {
    // Backdrop click to close
    if (this.backdrop) {
      const backdropHandler = () => this.toggle(false);
      this.backdrop.addEventListener('click', backdropHandler);
      this._eventListeners.push({ element: this.backdrop, event: 'click', handler: backdropHandler });
    }

    // Escape key to close
    const escapeHandler = (e) => {
      if (this.isVisible && (e.key === 'Escape' || e.key === 'Esc')) {
        this.toggle(false);
      }
    };
    window.addEventListener('keydown', escapeHandler);
    this._eventListeners.push({ element: window, event: 'keydown', handler: escapeHandler });

    if (this.eventBus) {
      this.eventBus.on(EventTypes.CHAT.CREATED, () => {
        console.log('[SidebarManager] Chat created - refreshing list');
        setTimeout(() => this.refreshChatList(), CONFIG.REFRESH_DELAY);
      });

      this.eventBus.on(EventTypes.CHAT.SWITCHED, (data) => {
        console.log('[SidebarManager] Chat switched:', data.chatId);
        this.currentChatId = data.chatId;
        this._updateActiveChat();
      });
    }

    console.log('[SidebarManager] Event listeners setup');
  }

  /**
   * Toggle sidebar visibility
   * @param {boolean} [visible] - Force visibility state
   */
  toggle(visible = !this.isVisible) {
    console.log(`[SidebarManager] Toggling: ${this.isVisible} → ${visible}`);

    if (!this.container) {
      console.error('[SidebarManager] Container not available');
      return;
    }

    this.isVisible = visible;

    if (visible) {
      // Show sidebar
      this.container.classList.add('visible');
      this.container.style.display = 'flex';

      if (this.backdrop) {
        this.backdrop.classList.add('visible');
      }

      // Update toggle button
      if (this.toggleBtn) {
        this.toggleBtn.textContent = '←';
        this.toggleBtn.title = 'Hide Chat List';
      }

      // Refresh chat list
      this.refreshChatList();
    } else {
      // Hide sidebar
      this.container.classList.remove('visible');

      // Defer display: none until after animation
      if (this.containerHideTimer) {
        clearTimeout(this.containerHideTimer);
      }
      this.containerHideTimer = setTimeout(() => {
        if (!this.isVisible && this.container) {
          this.container.style.display = 'none';
        }
      }, CONFIG.ANIMATION_DURATION + 20);

      if (this.backdrop) {
        this.backdrop.classList.remove('visible');
      }

      // Update toggle button
      if (this.toggleBtn) {
        this.toggleBtn.textContent = '☰';
        this.toggleBtn.title = 'Show Chat List';
      }
    }

    console.log('[SidebarManager] Toggle complete');
  }

  /**
   * Refresh chat list from storage
   */
  async refreshChatList() {
    if (!this.listContainer) {
      console.error('[SidebarManager] List container not available');
      return;
    }

    try {
      console.log('[SidebarManager] Refreshing chat list...');

      // Clear current list
      this.listContainer.innerHTML = '';

      // Get chats from storage
      const chats = await this._getChats();

      // Get current chat ID
      this.currentChatId = this._getCurrentChatId();

      console.log(`[SidebarManager] Loaded ${chats.length} chats, current: ${this.currentChatId}`);

      // Display empty state or chat list
      if (!chats || chats.length === 0) {
        this._renderEmptyState();
      } else {
        this._renderChatList(chats);
      }

      console.log('[SidebarManager] Chat list refreshed');
    } catch (error) {
      console.error('[SidebarManager] Failed to refresh chat list:', error);
      this._renderError();
    }
  }

  /**
   * Get chats from storage
   * @private
   * @returns {Promise<Array>}
   */
  async _getChats() {
    if (!this.storageAPI) {
      console.warn('[SidebarManager] Storage API not available');
      return [];
    }

    try {
      const chats = await this.storageAPI.loadChats();
      return chats || [];
    } catch (error) {
      console.error('[SidebarManager] Failed to load chats:', error);
      return [];
    }
  }

  /**
   * Get current chat ID
   * @private
   * @returns {string|null}
   */
  _getCurrentChatId() {
    if (this.messageManager && this.messageManager._state) {
      return this.messageManager._state.getCurrentChatId();
    }
    return null;
  }

  /**
   * Render empty state
   * @private
   */
  _renderEmptyState() {
    const empty = document.createElement('div');
    empty.className = 'aether-chat-list-empty';
    empty.textContent = CONFIG.EMPTY_MESSAGE;
    this.listContainer.appendChild(empty);
  }

  /**
   * Render error state
   * @private
   */
  _renderError() {
    const error = document.createElement('div');
    error.className = 'aether-chat-list-empty';
    error.textContent = 'Failed to load chats. Please try again.';
    error.style.color = 'rgba(255, 100, 100, 0.8)';
    this.listContainer.appendChild(error);
  }

  /**
   * Render chat list
   * @private
   * @param {Array} chats
   */
  _renderChatList(chats) {
    chats.forEach(chat => {
      const item = this._createChatItem(chat);
      this.listContainer.appendChild(item);
    });
  }

  /**
   * Create chat item element
   * @private
   * @param {Object} chat
   * @returns {HTMLElement}
   */
  _createChatItem(chat) {
    const item = document.createElement('div');
    item.className = 'aether-chat-item';
    item.dataset.chatId = chat.id;

    // Mark active chat
    if (chat.id === this.currentChatId) {
      item.classList.add('active');
    }

    // Create title
    const title = document.createElement('div');
    title.className = 'aether-chat-item-title';
    title.textContent = chat.title || CONFIG.DEFAULT_TITLE;
    title.title = 'Double-click to rename';

    // Create info
    const info = document.createElement('div');
    info.className = 'aether-chat-item-info';

    const date = this._formatDate(chat.updatedAt || chat.updated_at);
    const messageCount = chat.messageCount || chat.message_count || 0;

    const dateSpan = document.createElement('span');
    dateSpan.textContent = date;

    const countSpan = document.createElement('span');
    countSpan.textContent = `${messageCount} messages`;

    info.appendChild(dateSpan);
    info.appendChild(countSpan);

    // Create delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'aether-chat-delete-btn';
    deleteBtn.textContent = '×';
    deleteBtn.title = 'Delete Chat';
    deleteBtn.setAttribute('aria-label', 'Delete chat');

    // Assemble item
    item.appendChild(title);
    item.appendChild(info);
    item.appendChild(deleteBtn);

    // Add event listeners
    this._addChatItemListeners(item, chat, title, deleteBtn);

    return item;
  }

  /**
   * Add event listeners to chat item
   * @private
   */
  _addChatItemListeners(item, chat, titleEl, deleteBtn) {
    // Click to switch chat
    const clickHandler = (e) => {
      if (e.target === deleteBtn) return;
      this._switchToChat(chat.id);
    };
    item.addEventListener('click', clickHandler);

    // Double-click to rename
    const dblClickHandler = async (e) => {
      e.stopPropagation();
      await this._renameChat(chat.id, titleEl);
    };
    titleEl.addEventListener('dblclick', dblClickHandler);

    const deleteHandler = async (e) => {
      e.stopPropagation();
      e.preventDefault();
      
      deleteBtn.disabled = true;
      deleteBtn.style.opacity = '0.5';
      
      try {
        await this._deleteChat(chat.id);
      } finally {
        deleteBtn.disabled = false;
        deleteBtn.style.opacity = '1';
      }
    };
    deleteBtn.addEventListener('click', deleteHandler);
  }

  /**
   * Switch to chat
   * @private
   * @param {string} chatId
   */
  async _switchToChat(chatId) {
    console.log(`[SidebarManager] Switching to chat: ${chatId}`);

    if (!chatId) {
      console.warn('[SidebarManager] Invalid chat ID');
      return;
    }

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(chatId)) {
      console.error('[SidebarManager] Invalid UUID format:', chatId);
      await this.refreshChatList(); // Refresh to remove invalid entries
      return;
    }

    // Use MessageManager to load chat
    if (this.messageManager && typeof this.messageManager.loadChat === 'function') {
      try {
        // Load chat via MessageManager (handles MessageState and MessageView)
        await this.messageManager.loadChat(chatId);

        // Update active chat in UI
        this.currentChatId = chatId;
        this._updateActiveChat();

        console.log('[SidebarManager] Chat switched successfully');
      } catch (error) {
        console.error('[SidebarManager] Failed to switch chat:', error);
      }
    } else {
      console.error('[SidebarManager] MessageManager not available or missing loadChat method');
    }
  }

  /**
   * Delete chat
   * @private
   * @param {string} chatId
   */
  async _deleteChat(chatId) {
    console.log(`[SidebarManager] Deleting chat: ${chatId}`);

    if (!chatId) {
      console.warn('[SidebarManager] Invalid chat ID');
      return;
    }

    if (!this.storageAPI) {
      console.error('[SidebarManager] Storage API not available');
      return;
    }

    try {
      const isCurrent = chatId === this.currentChatId;

      await this.storageAPI.deleteChat(chatId);
      console.log('[SidebarManager] Chat deleted from storage');

      if (isCurrent && this.messageManager && this.messageManager._state) {
        await this.messageManager._state.createChat(CONFIG.DEFAULT_TITLE);
      }

      if (this.eventBus) {
        this.eventBus.emit(EventTypes.CHAT.DELETED, { chatId });
      }

      await this.refreshChatList();

      console.log('[SidebarManager] Chat deletion complete');
    } catch (error) {
      console.error('[SidebarManager] Failed to delete chat:', error);
      await this.refreshChatList();
    }
  }

  /**
   * Rename chat
   * @private
   * @param {string} chatId
   * @param {HTMLElement} titleEl
   */
  async _renameChat(chatId, titleEl) {
    console.log(`[SidebarManager] Renaming chat: ${chatId}`);

    const currentTitle = titleEl.textContent || CONFIG.DEFAULT_TITLE;

    // Create input
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentTitle;
    input.style.cssText = `
      width: 100%;
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 3px;
      padding: 2px 4px;
      font-size: 13px;
      font-family: inherit;
    `;

    // Replace title with input
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    // Commit rename
    const commit = async () => {
      const newTitle = (input.value || '').trim();
      const finalTitle = newTitle || currentTitle;

      if (finalTitle !== currentTitle && this.storageAPI) {
        try {
          await this.storageAPI.updateChatTitle(chatId, finalTitle);
          console.log(`[SidebarManager] Chat renamed: "${currentTitle}" → "${finalTitle}"`);
        } catch (error) {
          console.error('[SidebarManager] Failed to rename chat:', error);
        }
      }

      // Refresh list
      await this.refreshChatList();
    };

    // Event handlers
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        commit();
      } else if (e.key === 'Escape') {
        this.refreshChatList();
      }
    });

    input.addEventListener('blur', commit);
  }

  /**
   * Update active chat in UI
   * @private
   */
  _updateActiveChat() {
    if (!this.listContainer) return;

    // Remove active class from all items
    const items = this.listContainer.querySelectorAll('.aether-chat-item');
    items.forEach(item => {
      const chatId = item.dataset.chatId;
      if (chatId === this.currentChatId) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });
  }

  /**
   * Format date for display
   * @private
   * @param {string|Date} date
   * @returns {string}
   */
  _formatDate(date) {
    if (!date) return '';

    try {
      const d = new Date(date);
      if (isNaN(d.getTime())) return '';

      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (error) {
      return '';
    }
  }

  /**
   * Auto-show sidebar if chats exist
   * @private
   */
  async _autoShow() {
    try {
      const chats = await this._getChats();
      if (chats && chats.length > 0) {
        console.log('[SidebarManager] Auto-showing sidebar - found chats');
        setTimeout(() => this.toggle(true), 100);
      }
    } catch (error) {
      console.error('[SidebarManager] Auto-show failed:', error);
    }
  }

  /**
   * Get sidebar state
   * @returns {Object}
   */
  getState() {
    return freeze({
      isVisible: this.isVisible,
      currentChatId: this.currentChatId,
      hasContainer: !!this.container
    });
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    console.log('[SidebarManager] Disposing...');

    // Clear timers
    if (this.containerHideTimer) {
      clearTimeout(this.containerHideTimer);
      this.containerHideTimer = null;
    }

    // Remove event listeners
    for (const { element, event, handler } of this._eventListeners) {
      element.removeEventListener(event, handler);
    }
    this._eventListeners = [];

    // Remove DOM elements
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }

    if (this.backdrop && this.backdrop.parentNode) {
      this.backdrop.parentNode.removeChild(this.backdrop);
    }

    if (this.toggleBtn && this.toggleBtn.parentNode) {
      this.toggleBtn.parentNode.removeChild(this.toggleBtn);
    }

    // Clear references
    this.container = null;
    this.backdrop = null;
    this.listContainer = null;
    this.toggleBtn = null;
    this.chatWindow = null;
    this.messageManager = null;
    this.eventBus = null;
    this.storageAPI = null;

    console.log('[SidebarManager] Disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SidebarManager;
}

if (typeof window !== 'undefined') {
  window.SidebarManager = SidebarManager;
  console.log('📦 SidebarManager loaded');
}

