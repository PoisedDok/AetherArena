'use strict';

/**
 * @.architecture
 * Presentation layer for SidebarManager. Handles all DOM creation and updates.
 */
class SidebarRenderer {
  constructor(options = {}) {
    this.log = options.logger || console;
    this.config = options.config;
    
    // Callbacks
    this.onToggle = options.onToggle || (() => {});
    this.onBackdropClick = options.onBackdropClick || (() => {});
    
    // DOM Refs
    this.container = null;
    this.backdrop = null;
    this.listContainer = null;
    this.toggleBtn = null;
  }

  createContainer(windowEl) {
    const style = window.getComputedStyle(windowEl);
    if (!['relative', 'absolute', 'fixed'].includes(style.position)) {
      windowEl.style.position = 'relative';
    }

    this.container = document.createElement('div');
    this.container.className = 'aether-sidebar';

    const header = document.createElement('div');
    header.className = 'aether-sidebar-header';

    const title = document.createElement('h3');
    title.textContent = 'GURU';
    header.appendChild(title);

    const listContainer = document.createElement('div');
    listContainer.className = 'aether-chat-list-container';

    this.listContainer = document.createElement('div');
    this.listContainer.className = 'aether-chat-list';
    this.listContainer.setAttribute('role', 'list');
    this.listContainer.setAttribute('aria-label', 'Chat history');
    listContainer.appendChild(this.listContainer);

    this.container.appendChild(header);
    this.container.appendChild(listContainer);

    windowEl.insertBefore(this.container, windowEl.firstChild);

    this.backdrop = document.createElement('div');
    this.backdrop.className = 'aether-sidebar-backdrop';
    windowEl.appendChild(this.backdrop);

    this.backdrop.addEventListener('click', this.onBackdropClick);

    return {
      container: this.container,
      backdrop: this.backdrop,
      listContainer: this.listContainer
    };
  }

  createToggleButton(headerEl) {
    if (headerEl.querySelector('.aether-sidebar-toggle')) {
      return null;
    }

    this.toggleBtn = document.createElement('button');
    this.toggleBtn.className = 'aether-sidebar-toggle';
    this.toggleBtn.innerHTML = this.getToggleIcon(false);
    this.toggleBtn.title = 'Toggle Chat List';
    this.toggleBtn.setAttribute('aria-label', 'Toggle chat list');

    headerEl.insertBefore(this.toggleBtn, headerEl.firstChild);

    this.toggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onToggle();
    });

    return this.toggleBtn;
  }

  getToggleIcon(isOpen) {
    if (isOpen) {
      return `
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M15 6l-6 6 6 6"></path>
        </svg>
      `;
    }
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M4 7h16"></path>
        <path d="M4 12h16"></path>
        <path d="M4 17h16"></path>
      </svg>
    `;
  }

  updateToggleState(isVisible) {
    if (isVisible) {
      this.container.classList.add('visible');
      this.container.style.display = 'flex';
      if (this.backdrop) this.backdrop.classList.add('visible');
      if (this.toggleBtn) {
        this.toggleBtn.innerHTML = this.getToggleIcon(true);
        this.toggleBtn.title = 'Hide Chat List';
        this.toggleBtn.setAttribute('aria-label', 'Hide chat list');
      }
    } else {
      this.container.classList.remove('visible');
      if (this.backdrop) this.backdrop.classList.remove('visible');
      if (this.toggleBtn) {
        this.toggleBtn.innerHTML = this.getToggleIcon(false);
        this.toggleBtn.title = 'Show Chat List';
        this.toggleBtn.setAttribute('aria-label', 'Show chat list');
      }
    }
  }

  showSkeletonLoader() {
    if (!this.listContainer) return;
    
    while (this.listContainer.firstChild) {
      this.listContainer.firstChild.remove();
    }
    
    const skeleton = document.createElement('div');
    skeleton.className = 'chat-list-skeleton';
    
    for (let i = 0; i < 5; i++) {
      const item = document.createElement('div');
      item.className = 'skeleton-chat-item';
      item.innerHTML = `
        <div class="skeleton-avatar"></div>
        <div class="skeleton-content">
          <div class="skeleton-title"></div>
          <div class="skeleton-timestamp"></div>
        </div>
      `;
      skeleton.appendChild(item);
    }
    
    this.listContainer.appendChild(skeleton);
  }

  hideSkeletonLoader() {
    if (!this.listContainer) return;
    const skeleton = this.listContainer.querySelector('.chat-list-skeleton');
    if (skeleton) skeleton.remove();
  }

  renderEmptyState() {
    if (!this.listContainer) return;
    const empty = document.createElement('div');
    empty.className = 'aether-chat-list-empty';
    empty.textContent = this.config.EMPTY_MESSAGE;
    this.listContainer.appendChild(empty);
  }

  renderError() {
    if (!this.listContainer) return;
    const error = document.createElement('div');
    error.className = 'aether-chat-list-empty sidebar-error-text';
    error.textContent = 'Failed to load chats. Please try again.';
    this.listContainer.appendChild(error);
  }

  formatDate(date) {
    if (!date) return '';
    try {
      const d = new Date(date);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (error) {
      return '';
    }
  }

  createChatItem(chat, currentChatId, callbacks) {
    const item = document.createElement('div');
    item.className = 'aether-chat-item';
    item.setAttribute('role', 'listitem');
    item.dataset.chatId = chat.id;

    if (chat.id === currentChatId) {
      item.classList.add('active');
    }

    const title = document.createElement('div');
    title.className = 'aether-chat-item-title';
    title.textContent = chat.title || this.config.DEFAULT_TITLE;
    title.title = 'Double-click to rename';

    const info = document.createElement('div');
    info.className = 'aether-chat-item-info';

    const dateStr = this.formatDate(chat.updatedAt || chat.updated_at);
    const messageCount = chat.messageCount || 0;

    const dateSpan = document.createElement('span');
    dateSpan.textContent = dateStr;

    const countSpan = document.createElement('span');
    countSpan.textContent = `${messageCount} messages`;

    info.appendChild(dateSpan);
    info.appendChild(countSpan);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'aether-chat-delete-btn';
    deleteBtn.textContent = 'x';
    deleteBtn.title = 'Delete Chat';
    deleteBtn.setAttribute('aria-label', 'Delete chat');

    item.appendChild(title);
    item.appendChild(info);
    item.appendChild(deleteBtn);

    // Attach local callbacks
    item.addEventListener('click', (e) => {
      if (e.target !== deleteBtn) callbacks.onClick(chat.id);
    });
    title.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      callbacks.onDblClick(chat.id, title);
    });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      callbacks.onContextMenu(e, chat);
    });
    
    // Touch handlers
    let longPressTimer = null;
    const tsHandler = (e) => {
      longPressTimer = setTimeout(() => {
        e.preventDefault();
        callbacks.onContextMenu(e, chat);
        callbacks.onTouchTimerClear(longPressTimer);
      }, 1000);
      callbacks.onTouchTimerSet(longPressTimer);
    };
    const teHandler = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        callbacks.onTouchTimerClear(longPressTimer);
        longPressTimer = null;
      }
    };
    item.addEventListener('touchstart', tsHandler);
    item.addEventListener('touchend', teHandler);
    item.addEventListener('touchmove', teHandler);

    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      deleteBtn.disabled = true;
      deleteBtn.style.opacity = '0.5';
      try {
        await callbacks.onDelete(chat.id, chat.title);
      } finally {
        deleteBtn.disabled = false;
        deleteBtn.style.opacity = '1';
      }
    });

    // We rely on caller tracking these if needed for teardown, 
    // but typically nodes are just removed when refreshed.
    return { item, title, deleteBtn, touchStartHandler: tsHandler, touchEndHandler: teHandler };
  }

  updateChatItem(item, chat, currentChatId) {
    if (chat.id === currentChatId) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
    
    const titleEl = item.querySelector('.aether-chat-item-title');
    if (titleEl && titleEl.textContent !== chat.title) {
      titleEl.textContent = chat.title || this.config.DEFAULT_TITLE;
    }
    
    const info = item.querySelector('.aether-chat-item-info');
    if (info) {
      const dateSpan = info.querySelector('span:first-child');
      const countSpan = info.querySelector('span:last-child');
      
      if (dateSpan) {
        dateSpan.textContent = this.formatDate(chat.updatedAt || chat.updated_at);
      }
      
      if (countSpan) {
        countSpan.textContent = `${chat.messageCount || 0} messages`;
      }
    }
  }

  updateActiveChat(currentChatId) {
    if (!this.listContainer) return;
    const items = this.listContainer.querySelectorAll('.aether-chat-item');
    items.forEach(item => {
      if (item.dataset.chatId === currentChatId) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });
  }

  showContextMenu(event, menuItems) {
    const existing = document.querySelector('.chat-context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.className = 'chat-context-menu';

    menuItems.forEach(({ label, action, iconSvg }, index) => {
      const item = document.createElement('div');
      item.className = 'chat-context-menu-item';
      
      const icon = document.createElement('span');
      icon.className = 'chat-ctx-icon';
      
      if (label.includes('Summary')) {
        icon.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>`;
      } else if (label.includes('Context')) {
        icon.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>`;
      } else if (iconSvg) {
        icon.innerHTML = iconSvg;
      }
      
      const text = document.createElement('span');
      text.textContent = label;
      
      item.appendChild(icon);
      item.appendChild(text);
      
      const clickHandler = () => {
        item.style.transform = 'scale(0.95)';
        setTimeout(() => {
          try {
            action();
            menu.style.animation = 'ctxMenuFadeOut 0.15s ease forwards';
            setTimeout(() => {
              if (menu.parentNode) {
                if (menu._cleanupListeners) menu._cleanupListeners();
                menu.remove();
              }
            }, 150);
          } catch (error) {
            if (menu.parentNode) {
              if (menu._cleanupListeners) menu._cleanupListeners();
              menu.remove();
            }
          }
        }, 100);
      };
      item.addEventListener('click', clickHandler);
      
      menu.appendChild(item);
      if (index === 0) {
        const separator = document.createElement('div');
        separator.className = 'chat-ctx-separator';
        menu.appendChild(separator);
      }
    });

    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    document.body.appendChild(menu);
    
    return menu;
  }
}

module.exports = SidebarRenderer;
