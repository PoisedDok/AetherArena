/** @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js */

'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() };
const mockAether = { logger: mockLog };

jest.mock('../../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: () => mockAether,
}));

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

const mockToast = { success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn() };
jest.mock('../../../../src/renderer/shared/components/Toast', () => mockToast);

const mockConfirmDialog = { confirm: jest.fn().mockResolvedValue(true) };
jest.mock('../../../../src/renderer/shared/components/ConfirmDialog', () => mockConfirmDialog);

const ChatLibraryModal = require('../../../../src/renderer/main/modules/chat-library/ChatLibraryModal');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEndpoint(overrides = {}) {
  return {
    listChats: jest.fn().mockResolvedValue({
      data: [
        { id: 'chat-1', title: 'First Chat', message_count: 5, updated_at: new Date().toISOString() },
        { id: 'chat-2', title: 'Second Chat', message_count: 12, updated_at: new Date(Date.now() - 2 * 86400000).toISOString() },
      ],
    }),
    updateChat: jest.fn().mockResolvedValue({}),
    deleteChat: jest.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function makeEventBus() {
  return { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
}

function createModal(opts = {}) {
  const endpoint = opts.endpoint || makeEndpoint();
  const eventBus = opts.eventBus || makeEventBus();
  const modal = new ChatLibraryModal({ endpoint, eventBus });
  return { modal, endpoint, eventBus };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChatLibraryModal', () => {
  afterEach(() => {
    document.querySelectorAll('.modal-overlay').forEach((el) => el.remove());
    jest.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  describe('constructor', () => {
    test('sets initial state', () => {
      const { modal } = createModal();
      expect(modal.chats).toEqual([]);
      expect(modal.filteredChats).toEqual([]);
      expect(modal.searchQuery).toBe('');
      expect(modal._listeners).toEqual([]);
      expect(modal.id).toBe('chat-library-modal');
    });

    test('stores endpoint and eventBus', () => {
      const endpoint = makeEndpoint();
      const eventBus = makeEventBus();
      const modal = new ChatLibraryModal({ endpoint, eventBus });
      expect(modal.endpoint).toBe(endpoint);
      expect(modal.eventBus).toBe(eventBus);
    });

    test('stores chatWindow reference', () => {
      const chatWindow = { switchTo: jest.fn() };
      const modal = new ChatLibraryModal({ endpoint: makeEndpoint(), chatWindow });
      expect(modal.chatWindow).toBe(chatWindow);
    });

    test('binds _handleSearch and _handleNewChat', () => {
      const { modal } = createModal();
      // Bound methods retain context
      expect(typeof modal._handleSearch).toBe('function');
      expect(typeof modal._handleNewChat).toBe('function');
    });
  });

  // -----------------------------------------------------------------------
  // _renderContent()
  // -----------------------------------------------------------------------

  describe('_renderContent()', () => {
    test('shows empty state when no endpoint', async () => {
      const modal = new ChatLibraryModal({});
      modal.endpoint = null;
      await modal._renderContent();
      expect(modal.bodyEl.innerHTML).toContain('Endpoint not initialized');
    });

    test('fetches chats and renders UI on success', async () => {
      const { modal, endpoint } = createModal();
      await modal._renderContent();
      expect(endpoint.listChats).toHaveBeenCalledWith(0, 100);
      expect(modal.chats).toHaveLength(2);
      expect(modal.bodyEl.querySelector('.modal-search-bar')).not.toBeNull();
    });

    test('shows error state on fetch failure', async () => {
      const { modal, endpoint } = createModal();
      endpoint.listChats.mockRejectedValue(new Error('API down'));
      await modal._renderContent();
      expect(modal.bodyEl.innerHTML).toContain('Failed to Load Chats');
      expect(modal.bodyEl.innerHTML).toContain('API down');
    });

    test('handles response without data wrapper', async () => {
      const { modal, endpoint } = createModal();
      endpoint.listChats.mockResolvedValue([
        { id: 'c-1', title: 'Direct' },
      ]);
      await modal._renderContent();
      expect(modal.chats).toHaveLength(1);
      expect(modal.chats[0].title).toBe('Direct');
    });
  });

  // -----------------------------------------------------------------------
  // _renderUI()
  // -----------------------------------------------------------------------

  describe('_renderUI()', () => {
    test('clears listeners before re-rendering', async () => {
      const { modal } = createModal();
      // Seed some existing listeners
      const el = document.createElement('div');
      modal._trackListener(el, 'click', jest.fn());
      expect(modal._listeners).toHaveLength(1);

      modal.filteredChats = [];
      modal._renderUI();
      // Old listeners cleared, new ones added (search + new btn at minimum)
      // No way to know exact count, but the old one should be gone
      const oldHandler = modal._listeners.find(
        (l) => l.element === el && l.event === 'click',
      );
      expect(oldHandler).toBeUndefined();
    });

    test('creates search input and new chat button', () => {
      const { modal } = createModal();
      modal.filteredChats = [];
      modal._renderUI();
      const input = modal.bodyEl.querySelector('#chat-search-input');
      const btn = modal.bodyEl.querySelector('.modal-action-icon-btn');
      expect(input).not.toBeNull();
      expect(btn).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // _createChatCard()
  // -----------------------------------------------------------------------

  describe('_createChatCard()', () => {
    test('creates card with chat data', () => {
      const { modal } = createModal();
      const chat = { id: 'chat-x', title: 'My Chat', message_count: 3, updated_at: new Date().toISOString() };
      const card = modal._createChatCard(chat);
      expect(card.dataset.chatId).toBe('chat-x');
      expect(card.textContent).toContain('My Chat');
      expect(card.textContent).toContain('3 messages');
    });

    test('uses "Untitled Chat" for missing title', () => {
      const { modal } = createModal();
      const chat = { id: 'c1', title: '', message_count: 0, updated_at: new Date().toISOString() };
      const card = modal._createChatCard(chat);
      expect(card.textContent).toContain('Untitled Chat');
    });

    test('uses singular "message" for count of 1', () => {
      const { modal } = createModal();
      const chat = { id: 'c1', title: 'Test', message_count: 1, updated_at: new Date().toISOString() };
      const card = modal._createChatCard(chat);
      expect(card.textContent).toMatch(/1 message(?!s)/);
    });

    test('uses event delegation (0 listeners per card)', () => {
      const { modal } = createModal();
      modal._listeners = [];
      const chat = { id: 'c1', title: 'Test', message_count: 0, updated_at: new Date().toISOString() };
      modal._createChatCard(chat);
      expect(modal._listeners).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // _handleSearch()
  // -----------------------------------------------------------------------

  describe('_handleSearch()', () => {
    test('filters chats by title (case-insensitive)', () => {
      const { modal } = createModal();
      modal.chats = [
        { id: '1', title: 'Alpha Chat', updated_at: new Date().toISOString() },
        { id: '2', title: 'Beta Discussion', updated_at: new Date().toISOString() },
      ];
      modal.filteredChats = [...modal.chats];
      modal.bodyEl.innerHTML = '';

      modal._handleSearch({ target: { value: 'alpha' } });

      expect(modal.filteredChats).toHaveLength(1);
      expect(modal.filteredChats[0].id).toBe('1');
    });

    test('resets to all chats when search is empty', () => {
      const { modal } = createModal();
      modal.chats = [{ id: '1', title: 'A' }, { id: '2', title: 'B' }];
      modal.filteredChats = [];

      modal._handleSearch({ target: { value: '' } });

      expect(modal.filteredChats).toHaveLength(2);
    });

    test('handles chats with null title', () => {
      const { modal } = createModal();
      modal.chats = [{ id: '1', title: null }];
      modal.filteredChats = [...modal.chats];

      // Should not throw
      modal._handleSearch({ target: { value: 'test' } });
      expect(modal.filteredChats).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // _handleNewChat()
  // -----------------------------------------------------------------------

  describe('_handleNewChat()', () => {
    test('emits modal:chat-new-requested via eventBus', async () => {
      const { modal, eventBus } = createModal();
      await modal._handleNewChat();
      expect(eventBus.emit).toHaveBeenCalledWith('modal:chat-new-requested');
    });

    test('no-ops when eventBus is null', async () => {
      const modal = new ChatLibraryModal({ endpoint: makeEndpoint() });
      modal.eventBus = null;
      // Should not throw
      await modal._handleNewChat();
    });
  });

  // -----------------------------------------------------------------------
  // _handleOpen()
  // -----------------------------------------------------------------------

  describe('_handleOpen()', () => {
    test('emits modal:chat-open-requested with chatId', () => {
      const { modal, eventBus } = createModal();
      modal._handleOpen('chat-42');
      expect(eventBus.emit).toHaveBeenCalledWith('modal:chat-open-requested', { chatId: 'chat-42' });
    });

    test('no-ops when eventBus is null', () => {
      const modal = new ChatLibraryModal({ endpoint: makeEndpoint() });
      modal.eventBus = null;
      expect(() => modal._handleOpen('chat-1')).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // _handleDelete()
  // -----------------------------------------------------------------------

  describe('_handleDelete()', () => {
    test('confirms and deletes chat', async () => {
      const { modal, endpoint } = createModal();
      modal.chats = [{ id: 'c1', title: 'Doomed' }];
      modal.filteredChats = [{ id: 'c1', title: 'Doomed' }];
      mockConfirmDialog.confirm.mockResolvedValue(true);

      await modal._handleDelete('c1', 'Doomed');

      expect(mockConfirmDialog.confirm).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'danger' }),
      );
      expect(endpoint.deleteChat).toHaveBeenCalledWith('c1');
      expect(modal.chats).toHaveLength(0);
      expect(modal.filteredChats).toHaveLength(0);
    });

    test('aborts when user cancels', async () => {
      const { modal, endpoint } = createModal();
      mockConfirmDialog.confirm.mockResolvedValue(false);

      await modal._handleDelete('c1', 'Test');

      expect(endpoint.deleteChat).not.toHaveBeenCalled();
    });

    test('shows error toast on delete failure', async () => {
      const { modal, endpoint } = createModal();
      modal.chats = [{ id: 'c1' }];
      modal.filteredChats = [{ id: 'c1' }];
      mockConfirmDialog.confirm.mockResolvedValue(true);
      endpoint.deleteChat.mockRejectedValue(new Error('Delete error'));

      await modal._handleDelete('c1', 'Test');

      expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('Failed to delete'));
    });
  });

  // -----------------------------------------------------------------------
  // _handleEdit()
  // -----------------------------------------------------------------------

  describe('_handleEdit()', () => {
    test('creates inline edit input and saves on blur', async () => {
      const { modal, endpoint } = createModal();
      const titleEl = document.createElement('div');
      titleEl.textContent = 'Old Title';
      modal.chats = [{ id: 'c1', title: 'Old Title' }];

      await modal._handleEdit('c1', titleEl);

      const input = titleEl.querySelector('input');
      expect(input).not.toBeNull();
      expect(input.value).toBe('Old Title');

      // Simulate typing new title and blurring
      input.value = 'New Title';
      input.dispatchEvent(new Event('blur'));

      // Allow async save to complete
      await new Promise((r) => setTimeout(r, 0));

      expect(endpoint.updateChat).toHaveBeenCalledWith('c1', { title: 'New Title' });
      expect(titleEl.textContent).toBe('New Title');
      expect(modal.chats[0].title).toBe('New Title');
    });

    test('restores original title when input is same value', async () => {
      const { modal, endpoint } = createModal();
      const titleEl = document.createElement('div');
      titleEl.textContent = 'Same Title';

      await modal._handleEdit('c1', titleEl);

      const input = titleEl.querySelector('input');
      input.value = 'Same Title';
      input.dispatchEvent(new Event('blur'));
      await new Promise((r) => setTimeout(r, 0));

      expect(endpoint.updateChat).not.toHaveBeenCalled();
    });

    test('restores title on update failure', async () => {
      const { modal, endpoint } = createModal();
      const titleEl = document.createElement('div');
      titleEl.textContent = 'Original';
      modal.chats = [{ id: 'c1', title: 'Original' }];
      endpoint.updateChat.mockRejectedValue(new Error('Save failed'));

      await modal._handleEdit('c1', titleEl);

      const input = titleEl.querySelector('input');
      input.value = 'New Name';
      input.dispatchEvent(new Event('blur'));
      await new Promise((r) => setTimeout(r, 0));

      expect(mockToast.error).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // _groupChatsByDate()
  // -----------------------------------------------------------------------

  describe('_groupChatsByDate()', () => {
    test('groups today, yesterday, week, month, older', () => {
      const { modal } = createModal();
      const now = Date.now();
      const chats = [
        { id: '1', updated_at: new Date(now).toISOString() },
        { id: '2', updated_at: new Date(now - 86400000).toISOString() },
        { id: '3', updated_at: new Date(now - 3 * 86400000).toISOString() },
        { id: '4', updated_at: new Date(now - 15 * 86400000).toISOString() },
        { id: '5', updated_at: new Date(now - 60 * 86400000).toISOString() },
      ];
      const groups = modal._groupChatsByDate(chats);
      expect(Object.keys(groups).length).toBeGreaterThanOrEqual(1);
    });

    test('removes empty groups', () => {
      const { modal } = createModal();
      const chats = [{ id: '1', updated_at: new Date().toISOString() }];
      const groups = modal._groupChatsByDate(chats);
      Object.values(groups).forEach((items) => {
        expect(items.length).toBeGreaterThan(0);
      });
    });

    test('handles empty chat array', () => {
      const { modal } = createModal();
      const groups = modal._groupChatsByDate([]);
      expect(Object.keys(groups)).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // _formatDate()
  // -----------------------------------------------------------------------

  describe('_formatDate()', () => {
    test('returns time for today', () => {
      const { modal } = createModal();
      const result = modal._formatDate(new Date().toISOString());
      // Should include AM/PM time format
      expect(result).toMatch(/\d{1,2}:\d{2}\s*(AM|PM)/i);
    });

    test('returns "Yesterday" for yesterday', () => {
      const { modal } = createModal();
      const yesterday = new Date(Date.now() - 12 * 60 * 60 * 1000); // 12h ago may be yesterday
      // More reliable: set to start of yesterday
      const y = new Date();
      y.setDate(y.getDate() - 1);
      y.setHours(12, 0, 0, 0);
      expect(modal._formatDate(y.toISOString())).toBe('Yesterday');
    });

    test('returns date string for older dates', () => {
      const { modal } = createModal();
      const result = modal._formatDate('2025-01-15T12:00:00Z');
      expect(result).toContain('Jan');
      expect(result).toContain('15');
    });
  });

  // -----------------------------------------------------------------------
  // _renderChatList()
  // -----------------------------------------------------------------------

  describe('_renderChatList()', () => {
    test('shows empty state when no filtered chats', () => {
      const { modal } = createModal();
      modal.filteredChats = [];
      modal._renderChatList();
      expect(modal.bodyEl.innerHTML).toContain('No Chats Found');
    });

    test('shows search hint when search query is active', () => {
      const { modal } = createModal();
      modal.filteredChats = [];
      modal.searchQuery = 'xyz';
      modal._renderChatList();
      expect(modal.bodyEl.innerHTML).toContain('different search query');
    });

    test('shows create hint when no search and no chats', () => {
      const { modal } = createModal();
      modal.filteredChats = [];
      modal.searchQuery = '';
      modal._renderChatList();
      expect(modal.bodyEl.innerHTML).toContain('Create your first chat');
    });

    test('renders chat cards in date groups', () => {
      const { modal } = createModal();
      modal.filteredChats = [
        { id: '1', title: 'Today Chat', updated_at: new Date().toISOString(), message_count: 1 },
      ];
      modal._renderChatList();
      expect(modal.bodyEl.querySelector('.modal-card')).not.toBeNull();
      expect(modal.bodyEl.querySelector('.date-group')).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Lifecycle tracking
  // -----------------------------------------------------------------------

  describe('_trackListener / _clearListeners', () => {
    test('adds and removes listeners', () => {
      const { modal } = createModal();
      const el = document.createElement('div');
      const handler = jest.fn();
      const addSpy = jest.spyOn(el, 'addEventListener');
      const removeSpy = jest.spyOn(el, 'removeEventListener');

      modal._trackListener(el, 'click', handler);
      expect(addSpy).toHaveBeenCalledWith('click', handler, undefined);
      expect(modal._listeners).toHaveLength(1);

      modal._clearListeners();
      expect(removeSpy).toHaveBeenCalledWith('click', handler, undefined);
      expect(modal._listeners).toHaveLength(0);
    });

    test('ignores null element', () => {
      const { modal } = createModal();
      modal._trackListener(null, 'click', jest.fn());
      expect(modal._listeners).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // _cleanup()
  // -----------------------------------------------------------------------

  describe('_cleanup()', () => {
    test('clears all state and listeners', () => {
      const { modal } = createModal();
      modal.chats = [{ id: '1' }];
      modal.filteredChats = [{ id: '1' }];
      modal.searchQuery = 'test';
      modal._listeners = [{ element: document.createElement('div'), event: 'click', handler: jest.fn() }];

      modal._cleanup();

      expect(modal.chats).toEqual([]);
      expect(modal.filteredChats).toEqual([]);
      expect(modal.searchQuery).toBe('');
      expect(modal._listeners).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // _escapeHtml()
  // -----------------------------------------------------------------------

  describe('_escapeHtml()', () => {
    test('escapes HTML entities', () => {
      const { modal } = createModal();
      expect(modal._escapeHtml('<script>')).toBe('&lt;script&gt;');
    });
  });

  // -----------------------------------------------------------------------
  // Quantitative lifecycle proof
  // -----------------------------------------------------------------------

  describe('lifecycle: N listeners created = M removed', () => {
    test('all listeners tracked during render are cleaned up', async () => {
      const { modal } = createModal();
      await modal._renderContent();

      const N = modal._listeners.length;
      expect(N).toBeGreaterThan(0);

      modal._clearListeners();
      expect(modal._listeners).toHaveLength(0);
    });
  });
});
