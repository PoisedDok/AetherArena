'use strict';

// ---------------------------------------------------------------------------
// Mocks — MUST be at top level so Jest hoists them before require()
// ---------------------------------------------------------------------------

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  })),
}));

jest.mock('../../../src/core/events/EventTypes', () => ({
  EventTypes: {
    CHAT: {
      CREATED: 'chat:created',
      SWITCHED: 'chat:switched',
      DELETED: 'chat:deleted',
    },
  },
}));

jest.mock('../../../src/shared/utils/storage-resolver', () => ({
  resolveStorageAPI: jest.fn(() => ({})),
}));

jest.mock('../../../src/renderer/shared/components/ConfirmDialog', () => ({
  confirm: jest.fn().mockResolvedValue(true),
}));

jest.mock('../../../src/renderer/chat/modals/ChatSummaryModal', () => {
  return jest.fn().mockImplementation(() => ({
    open: jest.fn(),
    close: jest.fn(),
    destroy: jest.fn(),
    _cleanup: jest.fn(),
  }));
});

jest.mock('../../../src/renderer/chat/modals/ChatFilesModal', () => {
  return jest.fn().mockImplementation(() => ({
    open: jest.fn(),
    close: jest.fn(),
    destroy: jest.fn(),
    _cleanup: jest.fn(),
  }));
});

const SidebarManager = require('../../../src/renderer/chat/modules/sidebar/SidebarManager');
const ConfirmDialog = require('../../../src/renderer/shared/components/ConfirmDialog');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockChatService() {
  return {
    loadAllChats: jest.fn().mockResolvedValue([]),
    loadChat: jest.fn().mockResolvedValue({ id: 'chat-1', title: 'Test Chat' }),
    updateChatTitle: jest.fn().mockResolvedValue(undefined),
    deleteChat: jest.fn().mockResolvedValue(undefined),
  };
}

function createMockEventBus() {
  return {
    on: jest.fn(() => jest.fn()), // Returns cleanup function
    emit: jest.fn(),
    off: jest.fn(),
  };
}

function createMockChatWindow() {
  const element = document.createElement('div');
  element.style.position = 'relative';
  document.body.appendChild(element);

  const header = document.createElement('div');
  header.className = 'chat-window-header';
  element.appendChild(header);

  return {
    element,
    elements: { header },
  };
}

function createMockMessageOrchestrator() {
  return {
    loadChat: jest.fn().mockResolvedValue(undefined),
    createChat: jest.fn().mockResolvedValue(undefined),
    clearChat: jest.fn().mockResolvedValue(undefined),
    messageState: {
      getCurrentChatId: jest.fn().mockReturnValue('chat-1'),
    },
  };
}

function createSidebar(overrides = {}) {
  const chatWindow = overrides.chatWindow || createMockChatWindow();
  const chatService = overrides.chatService || createMockChatService();
  const eventBus = overrides.eventBus || createMockEventBus();
  const messageOrchestrator = overrides.messageOrchestrator || createMockMessageOrchestrator();

  const sm = new SidebarManager({
    chatWindow,
    chatService,
    eventBus,
    messageOrchestrator,
  });

  return { sm, chatWindow, chatService, eventBus, messageOrchestrator };
}

async function createInitializedSidebar(overrides = {}) {
  const result = createSidebar(overrides);
  await result.sm.init();
  return result;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SidebarManager', () => {
  beforeEach(() => {
    document.body.innerHTML = '';

    // Re-establish mocks after resetMocks (jest.config resetMocks: true)
    const { createRendererLogger } = require('../../../src/renderer/shared/utils/logger');
    createRendererLogger.mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
    });

    ConfirmDialog.confirm.mockResolvedValue(true);
  });

  // =========================================================================
  // Construction & Init
  // =========================================================================

  describe('construction', () => {
    it('throws when chatService is not provided', () => {
      expect(() => new SidebarManager({ chatWindow: {}, eventBus: {} }))
        .toThrow('[SidebarManager] ChatService REQUIRED');
    });

    it('accepts valid options and sets initial state', () => {
      const { sm } = createSidebar();
      expect(sm.isVisible).toBe(false);
      expect(sm.currentChatId).toBeNull();
      expect(sm._isDisposed).toBe(false);
      expect(sm._chatItems).toBeInstanceOf(Map);
      expect(sm._chatItems.size).toBe(0);
    });
  });

  describe('init', () => {
    it('creates container, toggle button, and sets up event listeners', async () => {
      const { sm, chatWindow } = await createInitializedSidebar();

      expect(sm.container).not.toBeNull();
      expect(sm.container.className).toBe('aether-sidebar');
      expect(sm.listContainer).not.toBeNull();
      expect(sm.backdrop).not.toBeNull();
      expect(sm.toggleBtn).not.toBeNull();
      expect(sm.toggleBtn.className).toBe('aether-sidebar-toggle');
      expect(chatWindow.element.contains(sm.container)).toBe(true);
    });

    it('registers EventBus subscriptions', async () => {
      const { eventBus } = await createInitializedSidebar();
      // chat:created, chat:switched (summary), chat:switched (active), stream:finalized, chat:message:deleted
      expect(eventBus.on).toHaveBeenCalledTimes(5);
    });

    it('tracks event listeners for cleanup', async () => {
      const { sm } = await createInitializedSidebar();
      // only window keydown is tracked by manager directly now = 1
      expect(sm._eventListeners.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // Toggle
  // =========================================================================

  describe('toggle', () => {
    it('shows sidebar when called with true', async () => {
      const { sm } = await createInitializedSidebar();
      sm.toggle(true);
      expect(sm.isVisible).toBe(true);
      expect(sm.container.classList.contains('visible')).toBe(true);
    });

    it('hides sidebar when called with false', async () => {
      const { sm } = await createInitializedSidebar();
      sm.toggle(true);
      sm.toggle(false);
      expect(sm.isVisible).toBe(false);
      expect(sm.container.classList.contains('visible')).toBe(false);
    });

    it('toggles visibility when called without argument', async () => {
      const { sm } = await createInitializedSidebar();
      const initialVisibility = sm.isVisible;
      sm.toggle();
      expect(sm.isVisible).toBe(!initialVisibility);
    });
  });

  // =========================================================================
  // Chat list rendering
  // =========================================================================

  describe('refreshChatList', () => {
    it('renders chat items from chatService', async () => {
      const chatService = createMockChatService();
      chatService.loadAllChats.mockResolvedValue([
        { id: 'c1', title: 'Chat One', updatedAt: '2026-01-01', messageCount: 3 },
        { id: 'c2', title: 'Chat Two', updatedAt: '2026-01-02', messageCount: 5 },
      ]);
      const { sm } = await createInitializedSidebar({ chatService });

      expect(sm._chatItems.size).toBe(2);
      expect(sm._chatItems.has('c1')).toBe(true);
      expect(sm._chatItems.has('c2')).toBe(true);
      expect(sm.listContainer.querySelectorAll('.aether-chat-item').length).toBe(2);
    });

    it('renders empty state when no chats exist', async () => {
      const chatService = createMockChatService();
      chatService.loadAllChats.mockResolvedValue([]);
      const { sm } = await createInitializedSidebar({ chatService });

      const emptyEl = sm.listContainer.querySelector('.aether-chat-list-empty');
      expect(emptyEl).not.toBeNull();
      expect(emptyEl.textContent).toBe('No chats yet. Start a new conversation!');
    });

    it('renders error state when chatService throws', async () => {
      const chatService = createMockChatService();
      // init calls loadAllChats (refreshChatList) + loadAllChats (_autoShow) = 2 calls
      chatService.loadAllChats
        .mockResolvedValueOnce([])  // 1st call: init → refreshChatList
        .mockResolvedValueOnce([])  // 2nd call: init → _autoShow
        .mockRejectedValueOnce(new Error('network error')); // 3rd call: manual refresh
      const { sm } = await createInitializedSidebar({ chatService });

      await sm.refreshChatList();

      const errorEl = sm.listContainer.querySelector('.sidebar-error-text');
      expect(errorEl).not.toBeNull();
      expect(errorEl.textContent).toBe('Failed to load chats. Please try again.');
    });

    it('updates existing items instead of recreating on second refresh', async () => {
      const chatService = createMockChatService();
      chatService.loadAllChats.mockResolvedValue([
        { id: 'c1', title: 'Chat One', updatedAt: '2026-01-01', messageCount: 3 },
      ]);
      const { sm } = await createInitializedSidebar({ chatService });

      const firstItemRef = sm._chatItems.get('c1');
      expect(firstItemRef).not.toBeNull();

      // Refresh again with updated title
      chatService.loadAllChats.mockResolvedValue([
        { id: 'c1', title: 'Updated Title', updatedAt: '2026-01-02', messageCount: 5 },
      ]);
      await sm.refreshChatList();

      // Same DOM element reference, updated content
      const secondItemRef = sm._chatItems.get('c1');
      expect(secondItemRef).toBe(firstItemRef);
      const titleEl = secondItemRef.querySelector('.aether-chat-item-title');
      expect(titleEl.textContent).toBe('Updated Title');
    });

    it('removes items for deleted chats', async () => {
      const chatService = createMockChatService();
      chatService.loadAllChats.mockResolvedValue([
        { id: 'c1', title: 'Chat One' },
        { id: 'c2', title: 'Chat Two' },
      ]);
      const { sm } = await createInitializedSidebar({ chatService });
      expect(sm._chatItems.size).toBe(2);

      // Refresh with c2 removed
      chatService.loadAllChats.mockResolvedValue([
        { id: 'c1', title: 'Chat One' },
      ]);
      await sm.refreshChatList();

      expect(sm._chatItems.size).toBe(1);
      expect(sm._chatItems.has('c2')).toBe(false);
    });
  });

  // =========================================================================
  // BUG SM-1 REGRESSION: _isDisposed lifecycle flag
  // =========================================================================

  describe('BUG SM-1 REGRESSION: _isDisposed lifecycle flag', () => {
    it('_isDisposed is false after construction', () => {
      const { sm } = createSidebar();
      expect(sm._isDisposed).toBe(false);
    });

    it('_isDisposed is true after dispose()', async () => {
      const { sm } = await createInitializedSidebar();
      sm.dispose();
      expect(sm._isDisposed).toBe(true);
    });

    it('dispose() is idempotent — second call is no-op', async () => {
      const { sm } = await createInitializedSidebar();
      const logSpy = sm.log.info;

      sm.dispose();
      expect(sm._isDisposed).toBe(true);
      const firstCallCount = logSpy.mock.calls.length;

      // Second call should be guarded — no additional log
      sm.dispose();
      expect(logSpy.mock.calls.length).toBe(firstCallCount);
    });

    it('toggle() is no-op after dispose', async () => {
      const { sm } = await createInitializedSidebar();
      sm.dispose();

      // toggle should not throw
      sm.toggle(true);
      expect(sm._isDisposed).toBe(true);
    });

    it('refreshChatList() is no-op after dispose', async () => {
      const { sm, chatService } = await createInitializedSidebar();
      sm.dispose();
      chatService.loadAllChats.mockClear();

      await sm.refreshChatList();
      expect(chatService.loadAllChats).not.toHaveBeenCalled();
    });

    it('_switchToChat() is no-op after dispose', async () => {
      const { sm, chatService } = await createInitializedSidebar();
      sm.dispose();
      chatService.loadChat.mockClear();

      await sm._switchToChat('some-chat-id');
      expect(chatService.loadChat).not.toHaveBeenCalled();
    });

    it('dispose clears all DOM event listeners', async () => {
      const { sm } = await createInitializedSidebar();
      const listenerCount = sm._eventListeners.length;
      expect(listenerCount).toBeGreaterThan(0);

      sm.dispose();
      expect(sm._eventListeners).toEqual([]);
    });

    it('dispose clears all EventBus subscriptions', async () => {
      const { sm } = await createInitializedSidebar();
      const busCleanupCount = sm._eventBusCleanups.length;
      expect(busCleanupCount).toBeGreaterThan(0);

      sm.dispose();
      expect(sm._eventBusCleanups).toEqual([]);
    });

    it('dispose clears timer', async () => {
      jest.useFakeTimers();
      const { sm } = await createInitializedSidebar();
      sm.toggle(true);
      sm.toggle(false); // This sets containerHideTimer
      expect(sm.containerHideTimer).not.toBeNull();

      sm.dispose();
      expect(sm.containerHideTimer).toBeNull();
      jest.useRealTimers();
    });

    it('dispose nullifies all external references', async () => {
      const { sm } = await createInitializedSidebar();
      sm.dispose();

      expect(sm.container).toBeNull();
      expect(sm.backdrop).toBeNull();
      expect(sm.listContainer).toBeNull();
      expect(sm.toggleBtn).toBeNull();
      expect(sm.chatWindow).toBeNull();
      expect(sm.messageOrchestrator).toBeNull();
      expect(sm.chatService).toBeNull();
      expect(sm.eventBus).toBeNull();
    });

    it('dispose removes container, backdrop, and toggle from DOM', async () => {
      const { sm, chatWindow } = await createInitializedSidebar();

      const container = sm.container;
      const backdrop = sm.backdrop;
      const toggleBtn = sm.toggleBtn;

      expect(chatWindow.element.contains(container)).toBe(true);
      expect(chatWindow.element.contains(backdrop)).toBe(true);
      expect(chatWindow.elements.header.contains(toggleBtn)).toBe(true);

      sm.dispose();

      expect(chatWindow.element.contains(container)).toBe(false);
      expect(chatWindow.element.contains(backdrop)).toBe(false);
      expect(chatWindow.elements.header.contains(toggleBtn)).toBe(false);
    });
  });

  // =========================================================================
  // BUG SM-2 REGRESSION: _renameChat commit closure guarded after dispose
  // =========================================================================

  describe('BUG SM-2 REGRESSION: _renameChat commit closure guarded after dispose', () => {
    it('commit closure does not call chatService.updateChatTitle after dispose', async () => {
      const chatService = createMockChatService();
      chatService.loadAllChats.mockResolvedValue([
        { id: 'c1', title: 'Old Title', updatedAt: '2026-01-01', messageCount: 1 },
      ]);
      const { sm } = await createInitializedSidebar({ chatService });

      // Get the title element from the rendered chat item
      const chatItem = sm._chatItems.get('c1');
      const titleEl = chatItem.querySelector('.aether-chat-item-title');
      expect(titleEl).not.toBeNull();

      // Invoke _renameChat — replaces titleEl with an input
      await sm._renameChat('c1', titleEl);

      // Find the input that replaced the title
      const input = chatItem.querySelector('.sidebar-rename-input');
      expect(input).not.toBeNull();
      input.value = 'New Title';

      // Dispose BEFORE commit fires
      sm.dispose();
      chatService.updateChatTitle.mockClear();
      chatService.loadAllChats.mockClear();

      // Manually trigger blur (JSDOM doesn't auto-trigger on DOM removal)
      input.dispatchEvent(new Event('blur'));

      // Wait for any microtasks
      await Promise.resolve();

      // chatService should NOT have been called — _isDisposed guard in commit
      expect(chatService.updateChatTitle).not.toHaveBeenCalled();
      expect(chatService.loadAllChats).not.toHaveBeenCalled();
    });

    it('commit closure works normally before dispose', async () => {
      const chatService = createMockChatService();
      chatService.loadAllChats.mockResolvedValue([
        { id: 'c1', title: 'Old Title', updatedAt: '2026-01-01', messageCount: 1 },
      ]);
      const { sm } = await createInitializedSidebar({ chatService });

      const chatItem = sm._chatItems.get('c1');
      const titleEl = chatItem.querySelector('.aether-chat-item-title');

      await sm._renameChat('c1', titleEl);

      const input = chatItem.querySelector('.sidebar-rename-input');
      input.value = 'New Title';

      chatService.updateChatTitle.mockClear();

      // Trigger blur while sidebar is alive
      input.dispatchEvent(new Event('blur'));

      // Wait for async commit
      await Promise.resolve();
      await Promise.resolve();

      expect(chatService.updateChatTitle).toHaveBeenCalledWith('c1', 'New Title');
    });
  });

  // =========================================================================
  // BUG SM-3 REGRESSION: lazily-created modals destroyed on dispose
  // =========================================================================

  describe('BUG SM-3 REGRESSION: lazily-created modals destroyed on dispose', () => {
    it('chatSummaryModal.destroy() called on dispose if modal was created', async () => {
      const { sm } = await createInitializedSidebar();

      // Simulate a lazily-created modal
      const mockModal = { destroy: jest.fn(), close: jest.fn(), open: jest.fn() };
      sm.chatSummaryModal = mockModal;

      sm.dispose();

      expect(mockModal.destroy).toHaveBeenCalledTimes(1);
      expect(sm.chatSummaryModal).toBeNull();
    });

    it('chatFilesModal.destroy() called on dispose if modal was created', async () => {
      const { sm } = await createInitializedSidebar();

      const mockModal = { destroy: jest.fn(), close: jest.fn(), open: jest.fn() };
      sm.chatFilesModal = mockModal;

      sm.dispose();

      expect(mockModal.destroy).toHaveBeenCalledTimes(1);
      expect(sm.chatFilesModal).toBeNull();
    });

    it('dispose succeeds even if no modals were created', async () => {
      const { sm } = await createInitializedSidebar();

      // Neither modal created — dispose should not throw
      expect(sm.chatSummaryModal).toBeUndefined();
      expect(sm.chatFilesModal).toBeUndefined();

      expect(() => sm.dispose()).not.toThrow();
      expect(sm._isDisposed).toBe(true);
    });

    it('dispose handles modal destroy() failure gracefully', async () => {
      const { sm } = await createInitializedSidebar();

      sm.chatSummaryModal = {
        destroy: jest.fn(() => { throw new Error('modal destroy failed'); }),
      };
      sm.chatFilesModal = {
        destroy: jest.fn(() => { throw new Error('modal destroy failed'); }),
      };

      // Should not throw — errors caught internally
      expect(() => sm.dispose()).not.toThrow();
      expect(sm._isDisposed).toBe(true);
      expect(sm.chatSummaryModal).toBeNull();
      expect(sm.chatFilesModal).toBeNull();
    });
  });

  // =========================================================================
  // BUG SM-4 REGRESSION: _showChatContextMenu guarded after dispose
  // =========================================================================

  describe('BUG SM-4 REGRESSION: _showChatContextMenu guarded after dispose', () => {
    it('_showChatContextMenu is no-op after dispose', async () => {
      const { sm } = await createInitializedSidebar();
      sm.dispose();

      // Should not throw or append menu to document.body
      const mockEvent = {
        clientX: 100,
        clientY: 200,
        preventDefault: jest.fn(),
        stopPropagation: jest.fn(),
      };
      sm._showChatContextMenu(mockEvent, { id: 'c1', title: 'Test' });

      const menu = document.querySelector('.chat-context-menu');
      expect(menu).toBeNull();
    });

    it('_showChatContextMenu creates menu when sidebar is alive', async () => {
      const { sm } = await createInitializedSidebar();

      const mockEvent = {
        clientX: 100,
        clientY: 200,
        preventDefault: jest.fn(),
        stopPropagation: jest.fn(),
      };
      sm._showChatContextMenu(mockEvent, { id: 'c1', title: 'Test' });

      const menu = document.querySelector('.chat-context-menu');
      expect(menu).not.toBeNull();
      expect(menu.querySelectorAll('.chat-context-menu-item').length).toBe(3);

      // Cleanup
      menu.remove();
    });
  });

  // =========================================================================
  // BUG SM-5 REGRESSION: context menu removed from DOM on dispose
  // =========================================================================

  describe('BUG SM-5 REGRESSION: context menu removed from DOM on dispose', () => {
    it('lingering .chat-context-menu is removed from DOM on dispose', async () => {
      const { sm } = await createInitializedSidebar();

      // Simulate an open context menu
      const fakeMenu = document.createElement('div');
      fakeMenu.className = 'chat-context-menu';
      document.body.appendChild(fakeMenu);
      expect(document.querySelector('.chat-context-menu')).not.toBeNull();

      sm.dispose();

      expect(document.querySelector('.chat-context-menu')).toBeNull();
    });

    it('dispose does not throw when no context menu exists', async () => {
      const { sm } = await createInitializedSidebar();

      expect(document.querySelector('.chat-context-menu')).toBeNull();

      expect(() => sm.dispose()).not.toThrow();
    });
  });

  // =========================================================================
  // _switchToChat
  // =========================================================================

  describe('_switchToChat', () => {
    it('validates UUID format', async () => {
      const { sm, chatService } = await createInitializedSidebar();
      chatService.loadChat.mockClear();

      await sm._switchToChat('not-a-uuid');
      expect(chatService.loadChat).not.toHaveBeenCalled();
    });

    it('loads chat via orchestrator on valid UUID', async () => {
      const { sm, messageOrchestrator, chatService } = await createInitializedSidebar();

      const validUuid = '12345678-1234-1234-1234-123456789abc';
      chatService.loadChat.mockResolvedValue({ id: validUuid, title: 'Loaded Chat' });

      await sm._switchToChat(validUuid);

      expect(chatService.loadChat).toHaveBeenCalledWith(validUuid);
      expect(messageOrchestrator.loadChat).toHaveBeenCalledWith(validUuid);
      expect(sm.currentChatId).toBe(validUuid);
    });
  });

  // =========================================================================
  // getState
  // =========================================================================

  describe('getState', () => {
    it('returns frozen state object', async () => {
      const { sm } = await createInitializedSidebar();
      const state = sm.getState();

      expect(state.isVisible).toBe(false);
      // currentChatId is set during init → refreshChatList → _getCurrentChatId
      expect(state.currentChatId).toBe('chat-1');
      expect(state.hasContainer).toBe(true);
      expect(Object.isFrozen(state)).toBe(true);
    });
  });

  // =========================================================================
  // _deleteChat
  // =========================================================================

  describe('_deleteChat', () => {
    it('deletes chat after user confirmation', async () => {
      const chatService = createMockChatService();
      chatService.loadAllChats.mockResolvedValue([
        { id: 'c1', title: 'Chat One' },
      ]);
      const { sm, eventBus } = await createInitializedSidebar({ chatService });
      ConfirmDialog.confirm.mockResolvedValue(true);
      chatService.deleteChat.mockClear();

      await sm._deleteChat('c1', 'Chat One');

      expect(chatService.deleteChat).toHaveBeenCalledWith('c1');
      expect(eventBus.emit).toHaveBeenCalledWith('chat:deleted', { chatId: 'c1' });
    });

    it('does not delete when user cancels', async () => {
      const chatService = createMockChatService();
      const { sm } = await createInitializedSidebar({ chatService });
      ConfirmDialog.confirm.mockResolvedValue(false);
      chatService.deleteChat.mockClear();

      await sm._deleteChat('c1', 'Chat One');

      expect(chatService.deleteChat).not.toHaveBeenCalled();
    });

    it('clears UI when deleting current chat', async () => {
      const chatService = createMockChatService();
      chatService.loadAllChats.mockResolvedValue([
        { id: 'c1', title: 'Current' },
      ]);
      const { sm, messageOrchestrator } = await createInitializedSidebar({ chatService });
      sm.currentChatId = 'c1';
      ConfirmDialog.confirm.mockResolvedValue(true);

      await sm._deleteChat('c1', 'Current');

      expect(messageOrchestrator.clearChat).toHaveBeenCalled();
    });

    it('throws for missing chatId', async () => {
      const { sm } = await createInitializedSidebar();
      await expect(sm._deleteChat(null)).rejects.toThrow('requires chatId');
    });
  });

  // =========================================================================
  // Escape key / Backdrop close
  // =========================================================================

  describe('keyboard and backdrop interactions', () => {
    it('escape key closes visible sidebar', async () => {
      const { sm } = await createInitializedSidebar();
      sm.toggle(true);
      expect(sm.isVisible).toBe(true);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(sm.isVisible).toBe(false);
    });

    it('escape key does nothing when sidebar hidden', async () => {
      const { sm } = await createInitializedSidebar();
      expect(sm.isVisible).toBe(false);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(sm.isVisible).toBe(false);
    });

    it('backdrop click closes sidebar', async () => {
      const { sm } = await createInitializedSidebar();
      sm.toggle(true);
      expect(sm.isVisible).toBe(true);

      sm.backdrop.click();
      expect(sm.isVisible).toBe(false);
    });
  });

  // =========================================================================
  // _formatDate
  // =========================================================================

  describe('_formatDate', () => {
    it('returns empty string for falsy input', () => {
      const { sm } = createSidebar();
      expect(sm.renderer.formatDate(null)).toBe('');
      expect(sm.renderer.formatDate(undefined)).toBe('');
      expect(sm.renderer.formatDate('')).toBe('');
    });

    it('returns empty string for invalid date', () => {
      const { sm } = createSidebar();
      expect(sm.renderer.formatDate('not-a-date')).toBe('');
    });

    it('formats valid date', () => {
      const { sm } = createSidebar();
      const result = sm.renderer.formatDate('2026-01-15');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain('15');
    });
  });

  // =========================================================================
  // _updateActiveChat
  // =========================================================================

  describe('_updateActiveChat', () => {
    it('marks only the current chat as active', async () => {
      const chatService = createMockChatService();
      chatService.loadAllChats.mockResolvedValue([
        { id: 'c1', title: 'One' },
        { id: 'c2', title: 'Two' },
      ]);
      const { sm } = await createInitializedSidebar({ chatService });

      sm.currentChatId = 'c2';
      sm.renderer.updateActiveChat(sm.currentChatId);

      const items = sm.listContainer.querySelectorAll('.aether-chat-item');
      expect(items[0].classList.contains('active')).toBe(false);
      expect(items[1].classList.contains('active')).toBe(true);
    });
  });

  // =========================================================================
  // Long-press / context menu interaction
  // =========================================================================

  describe('context menu interaction', () => {
    it('context menu is positioned at click coordinates', async () => {
      const { sm } = await createInitializedSidebar();
      const mockEvent = {
        clientX: 150,
        clientY: 250,
        preventDefault: jest.fn(),
        stopPropagation: jest.fn(),
      };
      sm._showChatContextMenu(mockEvent, { id: 'c1', title: 'Test' });

      const menu = document.querySelector('.chat-context-menu');
      expect(menu.style.left).toBe('150px');
      expect(menu.style.top).toBe('250px');

      menu.remove();
    });

    it('replaces existing context menu', async () => {
      const { sm } = await createInitializedSidebar();
      const mockEvent = {
        clientX: 100,
        clientY: 200,
        preventDefault: jest.fn(),
        stopPropagation: jest.fn(),
      };

      sm._showChatContextMenu(mockEvent, { id: 'c1', title: 'Test' });
      sm._showChatContextMenu(mockEvent, { id: 'c2', title: 'Test2' });

      const menus = document.querySelectorAll('.chat-context-menu');
      expect(menus).toHaveLength(1);

      menus[0].remove();
    });
  });

  // =========================================================================
  // _switchToChat — edge cases
  // =========================================================================

  describe('_switchToChat — edge cases', () => {
    const VALID_UUID = '00000000-0000-0000-0000-000000000001';

    it('returns early when chatId is null', async () => {
      const { sm, messageOrchestrator } = await createInitializedSidebar();
      await sm._switchToChat(null);
      expect(messageOrchestrator.loadChat).not.toHaveBeenCalled();
    });

    it('throws when messageOrchestrator.loadChat is not available', async () => {
      const { sm } = await createInitializedSidebar();
      sm.messageOrchestrator = { loadChat: null };
      await expect(sm._switchToChat(VALID_UUID)).rejects.toThrow('loadChat not available');
    });

    it('logs error and throws when loadChat fails', async () => {
      const { sm, messageOrchestrator } = await createInitializedSidebar();
      messageOrchestrator.loadChat.mockRejectedValueOnce(new Error('Load failed'));
      await expect(sm._switchToChat(VALID_UUID)).rejects.toThrow('Load failed');
    });

    it('returns early when disposed during await', async () => {
      const { sm, messageOrchestrator } = await createInitializedSidebar();
      messageOrchestrator.loadChat.mockImplementation(async () => {
        sm._isDisposed = true; // Simulate disposal during await
      });
      await sm._switchToChat(VALID_UUID);
      // Should return without updating currentChatId
      expect(sm.currentChatId).not.toBe(VALID_UUID);
    });
  });

  // =========================================================================
  // _deleteChat — delete handler on chat item
  // =========================================================================

  describe('delete handler on chat item', () => {
    it('calls _deleteChat and re-enables button after', async () => {
      const chatService = createMockChatService();
      chatService.loadAllChats.mockResolvedValue([
        { id: 'chat-del', title: 'Delete Me', created_at: new Date().toISOString() },
      ]);
      const { sm } = await createInitializedSidebar({ chatService });

      const deleteBtn = sm.container.querySelector('.aether-chat-delete-btn');
      expect(deleteBtn).not.toBeNull();

      ConfirmDialog.confirm.mockResolvedValue(true);
      chatService.deleteChat.mockResolvedValue();
      chatService.loadAllChats.mockResolvedValue([]);

      const clickEvent = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(clickEvent, 'stopPropagation', { value: jest.fn() });
      Object.defineProperty(clickEvent, 'preventDefault', { value: jest.fn() });
      deleteBtn.dispatchEvent(clickEvent);

      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      expect(chatService.deleteChat).toHaveBeenCalledWith('chat-del');
    });
  });

  // =========================================================================
  // _showChatContextMenu — context menu actions
  // =========================================================================

  describe('_showChatContextMenu', () => {
    it('creates context menu with menu items', async () => {
      const chatService = createMockChatService();
      chatService.loadAllChats.mockResolvedValue([
        { id: 'ctx-1', title: 'Context Chat', created_at: new Date().toISOString() },
      ]);
      const { sm } = await createInitializedSidebar({ chatService });

      const event = { clientX: 100, clientY: 100, preventDefault: jest.fn() };
      sm._showChatContextMenu(event, { id: 'ctx-1', title: 'Context Chat' });

      const menu = document.querySelector('.chat-context-menu');
      expect(menu).not.toBeNull();
      const items = menu.querySelectorAll('.chat-context-menu-item');
      expect(items.length).toBeGreaterThanOrEqual(2);
    });

    it('returns early when disposed', async () => {
      const { sm } = await createInitializedSidebar();
      sm._isDisposed = true;
      const event = { clientX: 0, clientY: 0, preventDefault: jest.fn() };
      sm._showChatContextMenu(event, { id: 'x' });
      expect(document.querySelector('.chat-context-menu')).toBeNull();
    });
  });

  // =========================================================================
  // _startRename — rename flow
  // =========================================================================

  describe('_renameChat — commit flow', () => {
    it('commits rename on Enter key', async () => {
      const chatService = createMockChatService();
      chatService.loadAllChats.mockResolvedValue([
        { id: 'ren-1', title: 'Old Title', created_at: new Date().toISOString() },
      ]);
      const { sm } = await createInitializedSidebar({ chatService });

      const titleEl = sm.container.querySelector('.aether-chat-item-title');
      expect(titleEl).not.toBeNull();

      sm._renameChat('ren-1', titleEl);

      const input = sm.container.querySelector('input');
      expect(input).not.toBeNull();

      input.value = 'New Title';
      const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
      input.dispatchEvent(enterEvent);

      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      expect(chatService.updateChatTitle).toHaveBeenCalledWith('ren-1', 'New Title');
    });

    it('cancels rename on Escape key', async () => {
      const chatService = createMockChatService();
      chatService.loadAllChats.mockResolvedValue([
        { id: 'ren-2', title: 'Keep Title', created_at: new Date().toISOString() },
      ]);
      const { sm } = await createInitializedSidebar({ chatService });

      const titleEl = sm.container.querySelector('.aether-chat-item-title');
      expect(titleEl).not.toBeNull();

      jest.spyOn(sm, 'refreshChatList').mockResolvedValue();
      sm._renameChat('ren-2', titleEl);

      const input = sm.container.querySelector('input');
      expect(input).not.toBeNull();

      const escEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      input.dispatchEvent(escEvent);

      await new Promise(r => setTimeout(r, 0));
      expect(sm.refreshChatList).toHaveBeenCalled();
    });

    it('handles rename API failure gracefully', async () => {
      const chatService = createMockChatService();
      chatService.loadAllChats.mockResolvedValue([
        { id: 'ren-3', title: 'Fail Title', created_at: new Date().toISOString() },
      ]);
      chatService.updateChatTitle.mockRejectedValueOnce(new Error('rename failed'));
      const { sm } = await createInitializedSidebar({ chatService });

      const titleEl = sm.container.querySelector('.aether-chat-item-title');
      expect(titleEl).not.toBeNull();

      sm._renameChat('ren-3', titleEl);

      const input = sm.container.querySelector('input');
      expect(input).not.toBeNull();

      input.value = 'Different Title';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      // Should have attempted the rename
      expect(chatService.updateChatTitle).toHaveBeenCalledWith('ren-3', 'Different Title');
      // Error is logged, not thrown
      expect(sm.log.error).toHaveBeenCalledWith('failed to rename chat', expect.anything());
    });
  });

  // =========================================================================
  // EventBus handler callbacks
  // =========================================================================

  describe('EventBus handler callbacks', () => {
    it('CHAT.CREATED handler schedules refreshChatList', async () => {
      jest.useFakeTimers();
      const { sm, eventBus } = await createInitializedSidebar();

      // Find the CHAT.CREATED handler from eventBus.on calls
      const createdCall = eventBus.on.mock.calls.find(c => c[0] === 'chat:created');
      expect(createdCall).toBeDefined();
      const handler = createdCall[1];

      jest.spyOn(sm, 'refreshChatList').mockResolvedValue();
      handler();

      // Handler uses setTimeout with CONFIG.REFRESH_DELAY (50ms)
      jest.advanceTimersByTime(60);
      expect(sm.refreshChatList).toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('CHAT.SWITCHED handler loads summaries when summaryPanel exists', async () => {
      const { sm, eventBus } = await createInitializedSidebar();

      // Both CHAT.SWITCHED handlers registered
      const switchedCalls = eventBus.on.mock.calls.filter(c => c[0] === 'chat:switched');
      expect(switchedCalls.length).toBe(2);

      // First SWITCHED handler: summary panel (lines 236-243)
      const summaryHandler = switchedCalls[0][1];
      sm.summaryPanel = { loadSummaries: jest.fn().mockResolvedValue() };
      summaryHandler({ chatId: 'sw-1' });
      expect(sm.summaryPanel.loadSummaries).toHaveBeenCalledWith('sw-1');
    });

    it('CHAT.SWITCHED handler updates currentChatId and active chat', async () => {
      const { sm, eventBus } = await createInitializedSidebar();

      const switchedCalls = eventBus.on.mock.calls.filter(c => c[0] === 'chat:switched');
      // Second SWITCHED handler: update active chat (lines 248-251)
      const activeHandler = switchedCalls[1][1];
      jest.spyOn(sm.renderer, 'updateActiveChat').mockImplementation(() => {});

      activeHandler({ chatId: 'sw-2' });
      expect(sm.currentChatId).toBe('sw-2');
      expect(sm.renderer.updateActiveChat).toHaveBeenCalled();
    });

    it('stream:finalized handler schedules refreshChatList', async () => {
      jest.useFakeTimers();
      const { sm, eventBus } = await createInitializedSidebar();

      const finalizedCall = eventBus.on.mock.calls.find(c => c[0] === 'stream:finalized');
      expect(finalizedCall).toBeDefined();
      const handler = finalizedCall[1];

      jest.spyOn(sm, 'refreshChatList').mockResolvedValue();
      handler();

      jest.advanceTimersByTime(60);
      expect(sm.refreshChatList).toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('chat:message:deleted handler deterministically updates message count in UI', async () => {
      const { sm, eventBus } = await createInitializedSidebar();
      
      // Setup a mock chat item in the cache
      const mockItem = document.createElement('div');
      mockItem.innerHTML = `<div class="aether-chat-item-info"><span>Date</span><span>10 messages</span></div>`;
      sm._chatItems.set('del-1', mockItem);

      const deletedCall = eventBus.on.mock.calls.find(c => c[0] === 'chat:message:deleted');
      expect(deletedCall).toBeDefined();
      const handler = deletedCall[1];

      handler({ chatId: 'del-1', deletedMessages: 3 });

      const countSpan = mockItem.querySelector('.aether-chat-item-info span:last-child');
      expect(countSpan.textContent).toBe('7 messages');
    });
  });

  // =========================================================================
  // _addChatItemListeners — event handler bodies
  // =========================================================================

  describe('_addChatItemListeners — event handler bodies', () => {
    async function createSidebarWithChat() {
      const chatService = createMockChatService();
      chatService.loadAllChats.mockResolvedValue([
        { id: 'item-1', title: 'My Chat', created_at: new Date().toISOString() },
      ]);
      const result = await createInitializedSidebar({ chatService });
      const chatItem = result.sm.container.querySelector('.aether-chat-item');
      const titleEl = chatItem.querySelector('.aether-chat-item-title');
      const deleteBtn = chatItem.querySelector('.aether-chat-delete-btn');
      return { ...result, chatItem, titleEl, deleteBtn };
    }

    it('click on chat item calls _switchToChat', async () => {
      const { sm, chatItem } = await createSidebarWithChat();
      jest.spyOn(sm, '_switchToChat').mockResolvedValue();

      chatItem.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(sm._switchToChat).toHaveBeenCalledWith('item-1');
    });

    it('click on delete button does NOT trigger _switchToChat', async () => {
      const { sm, deleteBtn } = await createSidebarWithChat();
      jest.spyOn(sm, '_switchToChat').mockResolvedValue();
      jest.spyOn(sm, '_deleteChat').mockResolvedValue();

      deleteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      // _switchToChat handler has `if (e.target === deleteBtn) return;`
      // NOTE: event delegation means the click handler on item sees deleteBtn as target
      expect(sm._switchToChat).not.toHaveBeenCalled();
    });

    it('dblclick on title calls _renameChat', async () => {
      const { sm, titleEl } = await createSidebarWithChat();
      jest.spyOn(sm, '_renameChat').mockResolvedValue();

      titleEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      expect(sm._renameChat).toHaveBeenCalledWith('item-1', titleEl);
    });

    it('contextmenu on chat item calls _showChatContextMenu', async () => {
      const { sm, chatItem } = await createSidebarWithChat();
      jest.spyOn(sm, '_showChatContextMenu').mockImplementation(() => {});

      chatItem.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        clientX: 50,
        clientY: 50,
      }));
      expect(sm._showChatContextMenu).toHaveBeenCalled();
    });

    it('touchstart + hold triggers context menu via long press', async () => {
      jest.useFakeTimers();
      const { sm, chatItem } = await createSidebarWithChat();
      jest.spyOn(sm, '_showChatContextMenu').mockImplementation(() => {});

      chatItem.dispatchEvent(new Event('touchstart', { bubbles: true }));
      jest.advanceTimersByTime(1100);

      expect(sm._showChatContextMenu).toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('touchend cancels long press timer', async () => {
      jest.useFakeTimers();
      const { sm, chatItem } = await createSidebarWithChat();
      jest.spyOn(sm, '_showChatContextMenu').mockImplementation(() => {});

      chatItem.dispatchEvent(new Event('touchstart', { bubbles: true }));
      chatItem.dispatchEvent(new Event('touchend', { bubbles: true }));
      jest.advanceTimersByTime(1100);

      expect(sm._showChatContextMenu).not.toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('touchmove cancels long press timer', async () => {
      jest.useFakeTimers();
      const { sm, chatItem } = await createSidebarWithChat();
      jest.spyOn(sm, '_showChatContextMenu').mockImplementation(() => {});

      chatItem.dispatchEvent(new Event('touchstart', { bubbles: true }));
      chatItem.dispatchEvent(new Event('touchmove', { bubbles: true }));
      jest.advanceTimersByTime(1100);

      expect(sm._showChatContextMenu).not.toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('delete button click calls _deleteChat with chat id and title', async () => {
      const { sm, deleteBtn } = await createSidebarWithChat();
      jest.spyOn(sm, '_deleteChat').mockResolvedValue();

      deleteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 0));

      expect(sm._deleteChat).toHaveBeenCalledWith('item-1', 'My Chat');
    });

    it('delete button is disabled during deletion and re-enabled after', async () => {
      const { sm, deleteBtn } = await createSidebarWithChat();
      let capturedDisabledState;
      jest.spyOn(sm, '_deleteChat').mockImplementation(async () => {
        capturedDisabledState = deleteBtn.disabled;
      });

      deleteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 0));

      expect(capturedDisabledState).toBe(true);
      expect(deleteBtn.disabled).toBe(false);
    });
  });

  // =========================================================================
  // Context menu actions and close handlers
  // =========================================================================

  describe('context menu — item actions and close behavior', () => {
    it('View Summary menu item opens ChatSummaryModal', async () => {
      jest.useFakeTimers();
      const chatService = createMockChatService();
      chatService.loadAllChats.mockResolvedValue([
        { id: 'ctx-a', title: 'Chat A', created_at: new Date().toISOString() },
      ]);
      const { sm } = await createInitializedSidebar({ chatService });

      const event = { clientX: 100, clientY: 100, preventDefault: jest.fn() };
      sm._showChatContextMenu(event, { id: 'ctx-a', title: 'Chat A' });

      const menuItems = document.querySelectorAll('.chat-context-menu-item');
      expect(menuItems.length).toBeGreaterThanOrEqual(2);

      // Click "View Summary" item (first item)
      menuItems[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));

      // Menu item click has a 100ms setTimeout before action
      jest.advanceTimersByTime(150);

      const ChatSummaryModal = require('../../../src/renderer/chat/modals/ChatSummaryModal');
      expect(ChatSummaryModal).toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('View Files menu item opens ChatFilesModal', async () => {
      jest.useFakeTimers();
      const chatService = createMockChatService();
      chatService.loadAllChats.mockResolvedValue([
        { id: 'ctx-b', title: 'Chat B', created_at: new Date().toISOString() },
      ]);
      const { sm } = await createInitializedSidebar({ chatService });

      const event = { clientX: 100, clientY: 100, preventDefault: jest.fn() };
      sm._showChatContextMenu(event, { id: 'ctx-b', title: 'Chat B' });

      const menuItems = document.querySelectorAll('.chat-context-menu-item');

      // Click "View Files" item (second item)
      menuItems[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));

      jest.advanceTimersByTime(150);

      const ChatFilesModal = require('../../../src/renderer/chat/modals/ChatFilesModal');
      expect(ChatFilesModal).toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('outside click closes context menu', async () => {
      jest.useFakeTimers();
      const { sm } = await createInitializedSidebar();

      const event = { clientX: 100, clientY: 100, preventDefault: jest.fn() };
      sm._showChatContextMenu(event, { id: 'out-1', title: 'Test' });

      const menu = document.querySelector('.chat-context-menu');
      expect(menu).not.toBeNull();

      // The outside click handler is registered with setTimeout(() => ..., 0)
      jest.advanceTimersByTime(10);

      // Click outside the menu
      document.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(document.querySelector('.chat-context-menu')).toBeNull();
      jest.useRealTimers();
    });

    it('Escape key closes context menu', async () => {
      const { sm } = await createInitializedSidebar();

      const event = { clientX: 100, clientY: 100, preventDefault: jest.fn() };
      sm._showChatContextMenu(event, { id: 'esc-1', title: 'Test' });

      const menu = document.querySelector('.chat-context-menu');
      expect(menu).not.toBeNull();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      expect(document.querySelector('.chat-context-menu')).toBeNull();
    });

    it('menu item click triggers action and removes menu after animation', async () => {
      jest.useFakeTimers();
      const { sm } = await createInitializedSidebar();

      const event = { clientX: 100, clientY: 100, preventDefault: jest.fn() };
      sm._showChatContextMenu(event, { id: 'anim-1', title: 'Test' });

      const menu = document.querySelector('.chat-context-menu');
      expect(menu).not.toBeNull();

      const menuItems = document.querySelectorAll('.chat-context-menu-item');
      menuItems[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));

      // 100ms delay before action, then 150ms animation before remove
      jest.advanceTimersByTime(110);
      // After action fires, menu gets fade-out animation and 150ms remove timer
      jest.advanceTimersByTime(200);

      // Menu should be removed
      expect(document.querySelector('.chat-context-menu')).toBeNull();
      jest.useRealTimers();
    });
  });

  // =========================================================================
  // Guard paths and error catches
  // =========================================================================

  describe('guard paths and error catches', () => {
    it('init() logs error and re-throws on failure', async () => {
      const { sm } = createSidebar();
      // Make _setupEventListeners throw to trigger init catch block
      sm._setupEventListeners = jest.fn(() => { throw new Error('setup fail'); });

      await expect(sm.init()).rejects.toThrow('setup fail');
      expect(sm.log.error).toHaveBeenCalledWith('initialization failed', expect.anything());
    });

    it('_createContainer returns early when chatWindow.element is null', async () => {
      const { sm } = createSidebar();
      sm.chatWindow = { element: null };
      sm._createContainer();
      expect(sm.log.error).toHaveBeenCalledWith('chatWindow element not available');
      expect(sm.container).toBeNull();
    });

    it('_createToggleButton returns early when header is not available', async () => {
      const { sm } = createSidebar();
      sm.chatWindow = { element: document.createElement('div'), elements: {} };
      sm._createToggleButton();
      expect(sm.log.error).toHaveBeenCalledWith('chatWindow header not available');
    });

    it('_createToggleButton returns early when toggle already exists', async () => {
      const { sm } = await createInitializedSidebar();
      // Toggle already exists from init
      sm._createToggleButton();
      expect(sm.log.trace).toHaveBeenCalledWith('toggle button already exists');
    });

    it('toggle button click handler calls toggle()', async () => {
      const { sm } = await createInitializedSidebar();
      jest.spyOn(sm, 'toggle');
      jest.spyOn(sm, 'refreshChatList').mockResolvedValue();

      sm.toggleBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(sm.toggle).toHaveBeenCalled();
    });

    it('toggle() returns early when container is null', async () => {
      const { sm } = await createInitializedSidebar();
      sm.container = null;
      sm.toggle(true);
      expect(sm.log.error).toHaveBeenCalledWith('toggle aborted; container not available');
    });

    it('toggle(false) clears existing containerHideTimer and sets new one', async () => {
      jest.useFakeTimers();
      const { sm } = await createInitializedSidebar();

      // Show first, then hide
      sm.toggle(true);
      sm.toggle(false);

      expect(sm.isVisible).toBe(false);

      // The timer at line 314-317 hides the container after ANIMATION_DURATION + 20
      jest.advanceTimersByTime(500);
      expect(sm.container.style.display).toBe('none');
      jest.useRealTimers();
    });

    it('_getChats resets bypassCache flag on next refresh', async () => {
      const chatService = createMockChatService();
      chatService.loadAllChats.mockResolvedValue([]);
      const { sm } = await createInitializedSidebar({ chatService });

      sm._bypassCacheOnNextRefresh = true;
      await sm._getChats();

      expect(sm._bypassCacheOnNextRefresh).toBeFalsy();
      expect(chatService.loadAllChats).toHaveBeenCalledWith(
        expect.objectContaining({ bypassCache: true })
      );
    });

    it('_getCurrentChatId returns null when messageOrchestrator has no messageState', async () => {
      const { sm } = await createInitializedSidebar();
      sm.messageOrchestrator = {};
      expect(sm._getCurrentChatId()).toBeNull();
    });

    it('_createChatItem marks active chat with active class', async () => {
      const chatService = createMockChatService();
      const messageOrchestrator = createMockMessageOrchestrator();
      // Start with no chats so init doesn't create items
      chatService.loadAllChats.mockResolvedValue([]);
      const { sm } = await createInitializedSidebar({ chatService, messageOrchestrator });

      // Mock _getCurrentChatId to return 'active-1' so refreshChatList sets it
      messageOrchestrator.messageState.getCurrentChatId.mockReturnValue('active-1');
      chatService.loadAllChats.mockResolvedValue([
        { id: 'active-1', title: 'Active Chat', created_at: new Date().toISOString() },
      ]);
      await sm.refreshChatList();

      const item = sm.container.querySelector('.aether-chat-item');
      expect(item).not.toBeNull();
      expect(item.classList.contains('active')).toBe(true);
    });

    it('_deleteChat error catch logs and refreshes', async () => {
      const chatService = createMockChatService();
      chatService.deleteChat.mockRejectedValueOnce(new Error('delete failed'));
      const { sm } = await createInitializedSidebar({ chatService });
      jest.spyOn(sm, 'refreshChatList').mockResolvedValue();

      await sm._deleteChat('del-err-1', 'Some Chat');

      expect(sm.log.error).toHaveBeenCalledWith('failed to delete chat', expect.anything());
      expect(sm.refreshChatList).toHaveBeenCalled();
    });

    it('_autoShow error is caught and logged', async () => {
      const chatService = createMockChatService();
      chatService.loadAllChats.mockResolvedValue([]);
      const { sm } = createSidebar({ chatService });

      // Make _getChats throw
      sm._getChats = jest.fn().mockRejectedValueOnce(new Error('auto fail'));

      // _autoShow is called during init, but we want to test it directly
      await sm._autoShow();
      expect(sm.log.error).toHaveBeenCalledWith('auto-show failed', expect.anything());
    });

    it('_formatDate returns empty string on invalid date', () => {
      const { sm } = createSidebar();
      expect(sm.renderer.formatDate(undefined)).toBe('');
      expect(sm.renderer.formatDate(null)).toBe('');
      expect(sm.renderer.formatDate('not-a-date')).toBe('');
    });

    it('dispose handles EventBus cleanup error gracefully', async () => {
      const eventBus = createMockEventBus();
      const throwingCleanup = jest.fn(() => { throw new Error('cleanup boom'); });
      eventBus.on.mockReturnValue(throwingCleanup);

      const { sm } = await createInitializedSidebar({ eventBus });
      // Now _eventBusCleanups contains functions that throw
      sm.dispose();

      expect(sm.log.warn).toHaveBeenCalledWith(
        'failed to cleanup EventBus listener',
        expect.anything()
      );
      expect(sm._isDisposed).toBe(true);
    });

    it('dispose handles DOM removeEventListener error gracefully', async () => {
      const { sm } = await createInitializedSidebar();

      // Sabotage one listener's element to throw on removeEventListener
      if (sm._eventListeners.length > 0) {
        sm._eventListeners[0].element = {
          removeEventListener: () => { throw new Error('remove boom'); },
        };
      }

      sm.dispose();
      // Should not throw, disposed successfully
      expect(sm._isDisposed).toBe(true);
    });

    it('_createContainer sets relative position when window element lacks it', async () => {
      const { sm } = createSidebar();
      // chatWindow.element exists but has static position
      const el = sm.chatWindow.element;
      el.style.position = 'static';
      // Force re-read by clearing and recreating container
      sm.container = null;
      sm._createContainer();
      expect(el.style.position).toBe('relative');
    });

    it('CHAT.SWITCHED summary handler logs error on loadSummaries failure', async () => {
      const { sm, eventBus } = await createInitializedSidebar();

      const switchedCalls = eventBus.on.mock.calls.filter(c => c[0] === 'chat:switched');
      const summaryHandler = switchedCalls[0][1];

      sm.summaryPanel = {
        loadSummaries: jest.fn().mockRejectedValue(new Error('summary fail')),
      };

      summaryHandler({ chatId: 'sw-err' });
      await new Promise(r => setTimeout(r, 0));

      expect(sm.log.error).toHaveBeenCalledWith('failed to load summaries', expect.anything());
    });

    it('toggle(false) clears pre-existing containerHideTimer', async () => {
      jest.useFakeTimers();
      const { sm } = await createInitializedSidebar();

      // First toggle false to set a timer
      sm.toggle(true);
      sm.toggle(false);
      const firstTimer = sm.containerHideTimer;
      expect(firstTimer).not.toBeNull();

      // Second toggle false should clear the first timer and set a new one
      sm.toggle(true);
      sm.toggle(false);
      expect(sm.containerHideTimer).not.toBe(firstTimer);
      jest.useRealTimers();
    });

    it('_updateChatItem adds active class to current chat', async () => {
      const chatService = createMockChatService();
      const messageOrchestrator = createMockMessageOrchestrator();
      chatService.loadAllChats.mockResolvedValue([
        { id: 'upd-1', title: 'Chat', created_at: new Date().toISOString() },
      ]);
      // Init with currentChatId NOT matching
      messageOrchestrator.messageState.getCurrentChatId.mockReturnValue(null);
      const { sm } = await createInitializedSidebar({ chatService, messageOrchestrator });

      const item = sm.container.querySelector('.aether-chat-item');
      expect(item.classList.contains('active')).toBe(false);

      // Now update with matching chatId
      messageOrchestrator.messageState.getCurrentChatId.mockReturnValue('upd-1');
      await sm.refreshChatList();

      expect(item.classList.contains('active')).toBe(true);
    });

    it('_showChatContextMenu error is caught', async () => {
      const { sm } = await createInitializedSidebar();

      // Force error inside try block by mocking showContextMenu to throw
      jest.spyOn(sm.renderer, 'showContextMenu').mockImplementation(() => {
        throw new Error('forced render error');
      });

      const event = { clientX: 100, clientY: 100, preventDefault: jest.fn() };
      sm._showChatContextMenu(event, { id: 'err-1' });

      expect(sm.log.error).toHaveBeenCalledWith(
        'Failed to show context menu',
        expect.objectContaining({ chatId: 'err-1' })
      );
    });
  });

  // =========================================================================
  // Quantitative resource proof
  // =========================================================================

  describe('resource tracking — quantitative proof', () => {
    it('N event listeners created = M event listeners cleaned', async () => {
      const { sm } = await createInitializedSidebar();
      const createdListeners = sm._eventListeners.length;
      const createdBusCleanups = sm._eventBusCleanups.length;
      expect(createdListeners).toBeGreaterThan(0);
      expect(createdBusCleanups).toBeGreaterThan(0);

      sm.dispose();

      expect(sm._eventListeners.length).toBe(0);
      expect(sm._eventBusCleanups.length).toBe(0);
    });

    it('all chat item cache entries cleared on dispose', async () => {
      const chatService = createMockChatService();
      chatService.loadAllChats.mockResolvedValue([
        { id: 'c1', title: 'One' },
        { id: 'c2', title: 'Two' },
        { id: 'c3', title: 'Three' },
      ]);
      const { sm } = await createInitializedSidebar({ chatService });
      expect(sm._chatItems.size).toBe(3);

      sm.dispose();
      expect(sm._chatItems.size).toBe(0);
    });
  });
});
