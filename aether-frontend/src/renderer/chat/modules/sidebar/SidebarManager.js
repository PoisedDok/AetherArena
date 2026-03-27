'use strict';

const { createRendererLogger } = require('../../../shared/utils/logger');
const SidebarRenderer = require('./SidebarRenderer');

/**
 * @.architecture
 * 
 * Incoming: User toggle button click, EventBus (CHAT.CREATED/SWITCHED/DELETED), MessageOrchestrator (chat context)
 * Processing: Delegate to ChatService (domain) for persistence, delegate to SidebarRenderer for UI
 * Outgoing: DOM (sliding sidebar), ChatService methods, MessageOrchestrator methods, EventBus
 * 
 * CLEAN ARCHITECTURE: Renderer → Domain Service (ChatService) → Repository → Infrastructure
 * 
 * @module renderer/chat/modules/sidebar/SidebarManager
 */

const { EventTypes } = require('../../../../core/events/EventTypes');
const ConfirmDialog = require('../../../shared/components/ConfirmDialog');

const { freeze } = Object;

const CONFIG = freeze({
  SIDEBAR_WIDTH: 250,
  ANIMATION_DURATION: 400,
  REFRESH_DELAY: 50,
  MAX_TITLE_LENGTH: 50,
  DEFAULT_TITLE: 'New Chat',
  EMPTY_MESSAGE: 'No chats yet. Start a new conversation!',
});

class SidebarManager {
  constructor(options = {}) {
    this.chatWindow = options.chatWindow || null;
    this.messageOrchestrator = options.messageOrchestrator || options.messageManager || null;
    this.eventBus = options.eventBus || null;
    this.endpoint = options.endpoint || null;
    this.log = createRendererLogger('SidebarManager');

    this.chatService = options.chatService || null;
    
    if (!this.chatService) {
      throw new Error('[SidebarManager] ChatService REQUIRED.');
    }

    this.isVisible = false;
    this.currentChatId = null;

    this.container = null;
    this.backdrop = null;
    this.listContainer = null;
    this.toggleBtn = null;
    
    this.summaryPanel = null;
    this.referencesPanel = null;

    this.containerHideTimer = null;
    this._longPressTimers = [];

    this._eventListeners = [];
    this._documentListeners = [];
    this._eventBusCleanups = [];
    
    this._chatItems = new Map();

    this._isDisposed = false;
    
    this._refreshInFlight = false;
    this._refreshPending = false;

    // Instantiate Renderer
    this.renderer = new SidebarRenderer({
      logger: this.log,
      config: CONFIG,
      onToggle: () => this.toggle(),
      onBackdropClick: () => this.toggle(false)
    });

    this.log.debug('constructed');
  }

  async init() {
    this.log.debug('initializing');
    try {
      this._createContainer();
      this._createToggleButton();
      this._setupEventListeners();
      this._initializeSummaryPanel();
      await this.refreshChatList();
      await this._autoShow();
      this.log.debug('initialization complete');
    } catch (error) {
      this.log.error('initialization failed', { error });
      throw error;
    }
  }

  _initializeSummaryPanel() {
    this.log.trace('sidebar panels removed in favor of floating modals');
  }

  _createContainer() {
    if (!this.chatWindow || !this.chatWindow.element) {
      this.log.error('chatWindow element not available');
      return;
    }
    const dom = this.renderer.createContainer(this.chatWindow.element);
    this.container = dom.container;
    this.backdrop = dom.backdrop;
    this.listContainer = dom.listContainer;
    this.log.trace('container created');
  }

  _createToggleButton() {
    if (this.toggleBtn) {
      this.log.trace('toggle button already exists');
      return;
    }
    if (!this.chatWindow || !this.chatWindow.elements || !this.chatWindow.elements.header) {
      this.log.error('chatWindow header not available');
      return;
    }
    this.toggleBtn = this.renderer.createToggleButton(this.chatWindow.elements.header);
    this.log.trace('toggle button created');
  }

  _setupEventListeners() {
    const escapeHandler = (e) => {
      if (this.isVisible && (e.key === 'Escape' || e.key === 'Esc')) {
        this.toggle(false);
      }
    };
    window.addEventListener('keydown', escapeHandler);
    this._eventListeners.push({ element: window, event: 'keydown', handler: escapeHandler });

    if (this.eventBus) {
      const chatCreatedCleanup = this.eventBus.on(EventTypes.CHAT.CREATED, () => {
        setTimeout(() => this.refreshChatList(), CONFIG.REFRESH_DELAY);
      });
      if (typeof chatCreatedCleanup === 'function') this._eventBusCleanups.push(chatCreatedCleanup);

      const chatSwitchedSummaryCleanup = this.eventBus.on(EventTypes.CHAT.SWITCHED, (data) => {
        if (this.summaryPanel && data && data.chatId) {
          this.summaryPanel.loadSummaries(data.chatId).catch(err => {
            this.log.error('failed to load summaries', { error: err });
          });
        }
      });
      if (typeof chatSwitchedSummaryCleanup === 'function') this._eventBusCleanups.push(chatSwitchedSummaryCleanup);

      const chatSwitchedActiveCleanup = this.eventBus.on(EventTypes.CHAT.SWITCHED, (data) => {
        this.currentChatId = data.chatId;
        this.renderer.updateActiveChat(this.currentChatId);
      });
      if (typeof chatSwitchedActiveCleanup === 'function') this._eventBusCleanups.push(chatSwitchedActiveCleanup);

      const streamFinalizedCleanup = this.eventBus.on('stream:finalized', () => {
        setTimeout(() => this.refreshChatList(), CONFIG.REFRESH_DELAY);
      });
      if (typeof streamFinalizedCleanup === 'function') this._eventBusCleanups.push(streamFinalizedCleanup);
      
      const messageDeletedCleanup = this.eventBus.on('chat:message:deleted', (data) => {
        if (data?.chatId && data?.deletedMessages) {
          const item = this._chatItems.get(data.chatId);
          if (item) {
            const countSpan = item.querySelector('.aether-chat-item-info span:last-child');
            if (countSpan) {
              const currentText = countSpan.textContent || '';
              const match = currentText.match(/(\d+)/);
              if (match) {
                const currentCount = parseInt(match[1], 10);
                const newCount = Math.max(0, currentCount - data.deletedMessages);
                countSpan.textContent = `${newCount} messages`;
              }
            }
          }
        }
      });
      if (typeof messageDeletedCleanup === 'function') this._eventBusCleanups.push(messageDeletedCleanup);
    }
  }

  toggle(visible = !this.isVisible) {
    if (this._isDisposed) return;
    if (!this.container) {
      this.log.error('toggle aborted; container not available');
      return;
    }

    this.isVisible = visible;
    this.renderer.updateToggleState(this.isVisible);

    if (this.isVisible) {
      this.refreshChatList();
    } else {
      if (this.containerHideTimer) clearTimeout(this.containerHideTimer);
      this.containerHideTimer = setTimeout(() => {
        if (!this.isVisible && this.container) {
          this.container.style.display = 'none';
        }
      }, CONFIG.ANIMATION_DURATION + 20);
    }
  }

  async refreshChatList() {
    if (this._isDisposed || !this.listContainer) return;
    if (this._refreshInFlight) {
      this._refreshPending = true;
      return;
    }

    this._refreshInFlight = true;

    try {
      this.renderer.showSkeletonLoader();
      const chats = await this._getChats();

      if (this._isDisposed || !this.listContainer) return;

      this.currentChatId = this._getCurrentChatId();
      this.renderer.hideSkeletonLoader();

      if (!chats || chats.length === 0) {
        this.renderer.renderEmptyState();
      } else {
        this._renderChatList(chats);
      }
    } catch (error) {
      this.log.error('failed to refresh chat list', { error });
      if (this._isDisposed || !this.listContainer) return;
      this.renderer.hideSkeletonLoader();
      this.renderer.renderError();
    } finally {
      this._refreshInFlight = false;
      if (this._refreshPending) {
        this._refreshPending = false;
        this.refreshChatList();
      }
    }
  }

  async _getChats() {
    try {
      const bypassCache = this._bypassCacheOnNextRefresh || false;
      if (this._bypassCacheOnNextRefresh) {
        this._bypassCacheOnNextRefresh = false;
      }
      const chats = await this.chatService.loadAllChats({ bypassCache });
      return (chats || []).map(chat => ({
        id: chat.id,
        title: chat.title,
        updatedAt: chat.updatedAt || chat.updated_at,
        messageCount: chat.messageCount || chat.message_count || 0
      }));
    } catch (error) {
      this.log.error('failed to load chats', { error });
      throw error;
    }
  }

  _getCurrentChatId() {
    if (this.messageOrchestrator && this.messageOrchestrator.messageState) {
      return this.messageOrchestrator.messageState.getCurrentChatId();
    }
    return null;
  }

  _renderChatList(chats) {
    const currentChatIds = new Set(chats.map(c => c.id));
    
    for (const [chatId, item] of this._chatItems.entries()) {
      if (!currentChatIds.has(chatId)) {
        item.remove();
        this._chatItems.delete(chatId);
      }
    }
    
    chats.forEach(chat => {
      let item = this._chatItems.get(chat.id);
      if (!item) {
        const result = this.renderer.createChatItem(chat, this.currentChatId, {
          onClick: (id) => this._switchToChat(id),
          onDblClick: (id, titleEl) => this._renameChat(id, titleEl),
          onContextMenu: (e, chatObj) => this._showChatContextMenu(e, chatObj),
          onDelete: (id, title) => this._deleteChat(id, title),
          onTouchTimerSet: (timer) => this._longPressTimers.push(timer),
          onTouchTimerClear: (timer) => {
            this._longPressTimers = this._longPressTimers.filter(t => t !== timer);
          }
        });
        item = result.item;
        this._chatItems.set(chat.id, item);
        this.listContainer.appendChild(item);
      } else {
        if (!item.parentNode) {
          this.listContainer.appendChild(item);
        }
        this.renderer.updateChatItem(item, chat, this.currentChatId);
      }
    });
  }

  _showChatContextMenu(event, chat) {
    if (this._isDisposed) return;
    try {
      const menuItems = [
        {
          label: 'View Summary',
          action: async () => {
            const ChatSummaryModal = require('../../modals/ChatSummaryModal');
            if (!this.chatSummaryModal) {
              this.chatSummaryModal = new ChatSummaryModal({ endpoint: this.endpoint });
            }
            this.chatSummaryModal.open(chat.id);
          }
        },
        {
          label: 'View Files',
          iconSvg: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>`,
          action: async () => {
            try {
              const ChatFilesModal = require('../../modals/ChatFilesModal');
              if (!this.chatFilesModal) {
                this.chatFilesModal = new ChatFilesModal({ 
                  eventBus: this.eventBus,
                  endpoint: this.endpoint
                });
              }
              this.chatFilesModal.open(chat.id);
            } catch (error) {
              this.log.error('Failed to open ChatFilesModal', { error });
            }
          }
        },
        {
          label: 'View Memories',
          iconSvg: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>`,
          action: async () => {
            try {
              const MemoryBrowserModal = require('../../../main/modules/memory-browser/MemoryBrowserModal');
              if (!this.memoryBrowserModal) {
                this.memoryBrowserModal = new MemoryBrowserModal({ 
                  eventBus: this.eventBus,
                  currentChatId: chat.id,
                  endpoint: this.endpoint,
                  onConfigureAgent: () => {
                    const ipc = (window.aether || window.aetherAPI)?.ipc;
                    if (ipc && typeof ipc.send === 'function') {
                      ipc.send('window:open-agents');
                    }
                  }
                });
              } else {
                this.memoryBrowserModal.currentChatId = chat.id;
              }
              this.memoryBrowserModal.activeTab = 'chat';
              if (typeof this.memoryBrowserModal.open === 'function') {
                this.memoryBrowserModal.open();
              } else if (typeof this.memoryBrowserModal.show === 'function') {
                this.memoryBrowserModal.show();
              }
            } catch (error) {
              this.log.error('Failed to open MemoryBrowserModal', { error });
            }
          }
        }
      ];

      const menu = this.renderer.showContextMenu(event, menuItems);
      
      const cleanupListeners = () => {
        document.removeEventListener('click', closeHandler);
        document.removeEventListener('keydown', escapeHandler);
        this._documentListeners = this._documentListeners.filter(
          l => l.handler !== closeHandler && l.handler !== escapeHandler
        );
      };

      const closeHandler = (e) => {
        if (!menu.contains(e.target)) {
          menu.remove();
          cleanupListeners();
        }
      };
      setTimeout(() => {
        document.addEventListener('click', closeHandler);
        this._documentListeners.push({ event: 'click', handler: closeHandler });
      }, 0);

      const escapeHandler = (e) => {
        if (e.key === 'Escape') {
          menu.remove();
          cleanupListeners();
        }
      };
      document.addEventListener('keydown', escapeHandler);
      this._documentListeners.push({ event: 'keydown', handler: escapeHandler });

      menu._cleanupListeners = cleanupListeners;

    } catch (error) {
      this.log.error('Failed to show context menu', { error, chatId: chat.id });
    }
  }

  async _switchToChat(chatId) {
    if (this._isDisposed) return;
    if (!chatId) return;

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(chatId)) {
      await this.refreshChatList();
      return;
    }

    if (this.messageOrchestrator && typeof this.messageOrchestrator.loadChat === 'function') {
      try {
        const chat = await this.chatService.loadChat(chatId);
        if (this._isDisposed) return;

        const title = chat?.title || CONFIG.DEFAULT_TITLE;
        this._updateWindowTitle(title);

        await this.messageOrchestrator.loadChat(chatId);
        if (this._isDisposed) return;

        this.currentChatId = chatId;
        this.renderer.updateActiveChat(this.currentChatId);

      } catch (error) {
        throw error;
      }
    } else {
      throw new Error('[SidebarManager] messageOrchestrator.loadChat not available');
    }
  }

  async _deleteChat(chatId, chatTitle) {
    if (!chatId) throw new Error('[SidebarManager] deleteChat requires chatId');

    const displayTitle = chatTitle || CONFIG.DEFAULT_TITLE;
    const confirmed = await ConfirmDialog.confirm({
      title: 'Delete chat',
      message: `Delete "${displayTitle}"? This cannot be undone.`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      variant: 'danger'
    });

    if (!confirmed) return;

    try {
      const isCurrent = chatId === this.currentChatId;
      await this.chatService.deleteChat(chatId);

      if (isCurrent && this.messageOrchestrator && typeof this.messageOrchestrator.clearChat === 'function') {
        await this.messageOrchestrator.clearChat();
      }

      if (this.eventBus) {
        this.eventBus.emit(EventTypes.CHAT.DELETED, { chatId });
      }

      await this.refreshChatList();
    } catch (error) {
      this.log.error('failed to delete chat', { error });
      await this.refreshChatList();
    }
  }

  async _renameChat(chatId, titleEl) {
    const currentTitle = titleEl.textContent || CONFIG.DEFAULT_TITLE;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentTitle;
    input.className = 'sidebar-rename-input';

    titleEl.replaceWith(input);
    input.focus();
    input.select();

    const cleanupListeners = () => {
      input.removeEventListener('keydown', keydownHandler);
      input.removeEventListener('blur', commit);
      // Remove from the global tracking array to prevent detached DOM leak
      this._eventListeners = this._eventListeners.filter(l => l.element !== input);
    };

    const commit = async () => {
      cleanupListeners();
      if (this._isDisposed) return;
      const newTitle = (input.value || '').trim();
      const finalTitle = newTitle || currentTitle;

      if (finalTitle !== currentTitle) {
        try {
          await this.chatService.updateChatTitle(chatId, finalTitle);
        } catch (error) {
          this.log.error('failed to rename chat', { error });
        }
      }
      await this.refreshChatList();
    };

    const keydownHandler = (e) => {
      if (e.key === 'Enter') {
        commit();
      } else if (e.key === 'Escape') {
        cleanupListeners();
        this.refreshChatList();
      }
    };
    input.addEventListener('keydown', keydownHandler);
    this._eventListeners.push({ element: input, event: 'keydown', handler: keydownHandler });

    input.addEventListener('blur', commit);
    this._eventListeners.push({ element: input, event: 'blur', handler: commit });
  }

  _updateWindowTitle(title) {
    if (this.eventBus) {
      this.eventBus.emit('chat:title-changed', { title });
    }
  }

  async _autoShow() {
    try {
      const chats = await this._getChats();
      if (chats && chats.length > 0) {
        setTimeout(() => this.toggle(true), 100);
      }
    } catch (error) {
      this.log.error('auto-show failed', { error });
    }
  }

  getState() {
    return freeze({
      isVisible: this.isVisible,
      currentChatId: this.currentChatId,
      hasContainer: !!this.container
    });
  }

  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;

    if (this.containerHideTimer) {
      clearTimeout(this.containerHideTimer);
      this.containerHideTimer = null;
    }
    
    if (this._longPressTimers) {
      for (const timer of this._longPressTimers) {
        clearTimeout(timer);
      }
      this._longPressTimers = [];
    }

    for (const cleanup of this._eventBusCleanups) {
      try {
        if (typeof cleanup === 'function') cleanup();
      } catch (error) {
        this.log.warn('failed to cleanup EventBus listener', { error });
      }
    }
    this._eventBusCleanups = [];

    for (const { element, event, handler } of this._eventListeners) {
      try {
        if (element) element.removeEventListener(event, handler);
      } catch (error) {}
    }
    this._eventListeners = [];

    for (const { event, handler } of this._documentListeners) {
      try {
        document.removeEventListener(event, handler);
      } catch (error) {}
    }
    this._documentListeners = [];

    if (this._chatItems) {
      this._chatItems.clear();
    }

    if (this.chatSummaryModal) {
      try { this.chatSummaryModal.destroy(); } catch (e) {}
      this.chatSummaryModal = null;
    }
    if (this.chatFilesModal) {
      try { this.chatFilesModal.destroy(); } catch (e) {}
      this.chatFilesModal = null;
    }

    const contextMenu = document.querySelector('.chat-context-menu');
    if (contextMenu) contextMenu.remove();

    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    if (this.backdrop && this.backdrop.parentNode) {
      this.backdrop.parentNode.removeChild(this.backdrop);
    }
    if (this.toggleBtn && this.toggleBtn.parentNode) {
      this.toggleBtn.parentNode.removeChild(this.toggleBtn);
    }

    this.container = null;
    this.backdrop = null;
    this.listContainer = null;
    this.toggleBtn = null;
    this.chatWindow = null;
    this.messageOrchestrator = null;
    this.chatService = null;
    this.eventBus = null;
    this.renderer = null;

    this.log.debug('disposed');
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SidebarManager;
}

if (typeof window !== 'undefined') {
  window.SidebarManager = SidebarManager;
  createRendererLogger('SidebarManager').debug('module loaded');
}
