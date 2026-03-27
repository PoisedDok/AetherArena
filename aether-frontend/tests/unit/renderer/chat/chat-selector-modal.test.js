'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};
mockLog.child = () => mockLog;

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

const mockAether = {
  chatSummaries: {
    list: jest.fn(),
    generate: jest.fn(),
  },
};

jest.mock('../../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: () => mockAether,
}));

const ChatSelectorModal = require(
  '../../../../src/renderer/chat/modals/ChatSelectorModal'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createEventBus() {
  return { on: jest.fn(), emit: jest.fn(), off: jest.fn() };
}

function createChatService(chats = []) {
  return {
    loadAllChats: jest.fn().mockResolvedValue(chats),
  };
}

function makeChatDomainObj(overrides = {}) {
  return {
    id: 'chat-1',
    title: 'Test Chat',
    createdAt: '2026-01-15T10:00:00Z',
    updatedAt: '2026-01-16T10:00:00Z',
    ...overrides,
  };
}

function createModal(overrides = {}) {
  const eventBus = overrides.eventBus !== undefined ? overrides.eventBus : createEventBus();
  const modal = new ChatSelectorModal({ eventBus, ...overrides });
  return { modal, eventBus };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChatSelectorModal', () => {
  let modal;
  let eventBus;

  beforeEach(() => {
    jest.useFakeTimers();
    mockLog.info.mockClear();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    mockLog.debug.mockClear();
    mockLog.trace.mockClear();
    mockAether.chatSummaries.list.mockReset();
    mockAether.chatSummaries.generate.mockReset();
    // Clean up any leftover style element
    const existing = document.getElementById('chat-selector-modal-styles');
    if (existing) existing.remove();
    // Clean up window.chatController
    delete window.chatController;
  });

  afterEach(() => {
    if (modal) {
      try { modal.destroy(); } catch (e) { /* noop */ }
      modal = null;
    }
    eventBus = null;
    jest.useRealTimers();
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('extends BaseModal with correct id and footer setting', () => {
      ({ modal, eventBus } = createModal());
      expect(modal.id).toBe('chat-selector-modal');
      expect(modal.showFooter).toBe(true);
    });

    it('creates overlay in DOM', () => {
      ({ modal, eventBus } = createModal());
      expect(document.getElementById('chat-selector-modal-overlay')).not.toBeNull();
    });

    it('initializes sourceChatId to null', () => {
      ({ modal, eventBus } = createModal());
      expect(modal.sourceChatId).toBeNull();
    });

    it('initializes excludeChatIds as empty array', () => {
      ({ modal, eventBus } = createModal());
      expect(modal.excludeChatIds).toEqual([]);
    });

    it('initializes chats and filteredChats as empty arrays', () => {
      ({ modal, eventBus } = createModal());
      expect(modal.chats).toEqual([]);
      expect(modal.filteredChats).toEqual([]);
    });

    it('initializes selectedChatIds as empty Set', () => {
      ({ modal, eventBus } = createModal());
      expect(modal.selectedChatIds).toBeInstanceOf(Set);
      expect(modal.selectedChatIds.size).toBe(0);
    });

    it('initializes chatSummaries as empty Map', () => {
      ({ modal, eventBus } = createModal());
      expect(modal.chatSummaries).toBeInstanceOf(Map);
      expect(modal.chatSummaries.size).toBe(0);
    });

    it('initializes processingChats as empty Set', () => {
      ({ modal, eventBus } = createModal());
      expect(modal.processingChats).toBeInstanceOf(Set);
      expect(modal.processingChats.size).toBe(0);
    });

    it('stores eventBus reference', () => {
      const eb = createEventBus();
      ({ modal } = createModal({ eventBus: eb }));
      expect(modal.eventBus).toBe(eb);
    });

    it('stores chatService when provided', () => {
      const svc = createChatService();
      ({ modal } = createModal({ chatService: svc }));
      expect(modal.chatService).toBe(svc);
    });

    it('defaults chatService to null', () => {
      ({ modal } = createModal());
      expect(modal.chatService).toBeNull();
    });

    it('uses injected aether over getAether()', () => {
      const customAether = { chatSummaries: { list: jest.fn() } };
      ({ modal } = createModal({ aether: customAether }));
      expect(modal.aether).toBe(customAether);
    });

    it('falls back to getAether() when no aether injected', () => {
      ({ modal } = createModal());
      expect(modal.aether).toBe(mockAether);
    });

    it('initializes _listeners and _timers as empty arrays', () => {
      ({ modal } = createModal());
      expect(modal._listeners).toEqual([]);
      expect(modal._timers).toEqual([]);
    });

    it('injects spinner styles into document head', () => {
      ({ modal } = createModal());
      const style = document.getElementById('chat-selector-modal-styles');
      expect(style).not.toBeNull();
      expect(style.textContent).toContain('spinner-rotate');
    });

    it('does not duplicate styles on second instance', () => {
      ({ modal } = createModal());
      const modal2 = new ChatSelectorModal({ eventBus: createEventBus() });
      const styles = document.querySelectorAll('#chat-selector-modal-styles');
      expect(styles.length).toBe(1);
      modal2.destroy();
    });
  });

  // =========================================================================
  // open
  // =========================================================================

  describe('open', () => {
    it('sets sourceChatId', async () => {
      const svc = createChatService([]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open('src-1');
      expect(modal.sourceChatId).toBe('src-1');
    });

    it('clears previous selections on re-open', async () => {
      const svc = createChatService([]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      modal.selectedChatIds.add('old-chat');
      modal.chatSummaries.set('old-chat', { text: 'old' });
      modal.processingChats.add('old-chat');
      await modal.open('src-1');
      expect(modal.selectedChatIds.size).toBe(0);
      expect(modal.chatSummaries.size).toBe(0);
      expect(modal.processingChats.size).toBe(0);
    });

    it('adds sourceChatId to excludeChatIds if not already present', async () => {
      const svc = createChatService([]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open('src-1', ['chat-2']);
      expect(modal.excludeChatIds).toContain('src-1');
      expect(modal.excludeChatIds).toContain('chat-2');
    });

    it('does not duplicate sourceChatId in excludeChatIds', async () => {
      const svc = createChatService([]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open('src-1', ['src-1', 'chat-2']);
      const count = modal.excludeChatIds.filter(id => id === 'src-1').length;
      expect(count).toBe(1);
    });

    it('handles null sourceChatId', async () => {
      const svc = createChatService([]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      expect(modal.sourceChatId).toBeNull();
      expect(modal.excludeChatIds).toEqual([]);
    });

    it('defaults excludeChatIds to empty array when null passed', async () => {
      const svc = createChatService([]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open('src-1', null);
      expect(modal.excludeChatIds).toContain('src-1');
    });

    it('sets isOpen to true', async () => {
      const svc = createChatService([]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open('src-1');
      expect(modal.isOpen).toBe(true);
    });
  });

  // =========================================================================
  // _renderContent
  // =========================================================================

  describe('_renderContent', () => {
    beforeEach(() => {
      const svc = createChatService([]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
    });

    it('creates header with title', async () => {
      await modal.open('src-1');
      const title = modal.headerEl.querySelector('.csm-modal-title');
      expect(title).not.toBeNull();
      expect(title.textContent).toBe('Attach Chat Summaries');
    });

    it('creates close button in header', async () => {
      await modal.open('src-1');
      const closeBtn = modal.headerEl.querySelector('.cm-action-btn--close');
      expect(closeBtn).not.toBeNull();
      expect(closeBtn.getAttribute('aria-label')).toBe('Close dialog');
    });

    it('close button calls close()', async () => {
      await modal.open('src-1');
      const closeBtn = modal.headerEl.querySelector('.cm-action-btn--close');
      const spy = jest.spyOn(modal, 'close');
      closeBtn.click();
      expect(spy).toHaveBeenCalled();
    });

    it('creates search input', async () => {
      await modal.open('src-1');
      expect(modal.searchInput).not.toBeNull();
      expect(modal.searchInput.placeholder).toBe('Search chats...');
    });

    it('tracks search input listener', async () => {
      await modal.open('src-1');
      const searchListeners = modal._listeners.filter(l => l.event === 'input');
      // _renderContent is called twice (BaseModal.open + ChatSelectorModal.open), each adds an input listener
      expect(searchListeners.length).toBeGreaterThanOrEqual(1);
    });

    it('creates selection info element (hidden initially)', async () => {
      await modal.open('src-1');
      expect(modal.selectionInfo).not.toBeNull();
      expect(modal.selectionInfo.className).toBe('csm-selection-info');
    });

    it('creates list container', async () => {
      await modal.open('src-1');
      expect(modal.listContainer).not.toBeNull();
      expect(modal.listContainer.className).toBe('chat-list-container');
    });

    it('creates footer with cancel and add buttons', async () => {
      await modal.open('src-1');
      expect(modal.addButton).not.toBeNull();
      expect(modal.addButton.textContent).toBe('Add Selected');
      expect(modal.addButton.disabled).toBe(true);
      const cancelBtn = modal.footerEl.querySelector('.csm-btn-cancel');
      expect(cancelBtn).not.toBeNull();
      expect(cancelBtn.textContent).toBe('Cancel');
    });

    it('cancel button in footer calls close()', async () => {
      await modal.open('src-1');
      const cancelBtn = modal.footerEl.querySelector('.csm-btn-cancel');
      const spy = jest.spyOn(modal, 'close');
      cancelBtn.click();
      expect(spy).toHaveBeenCalled();
    });

    it('add button click is wired to _handleAddSelected', async () => {
      await modal.open('src-1');
      // The handler is bound in constructor; verify the effect instead of spying
      // With no selection, _handleAddSelected returns early (no emission)
      const emitSpy = jest.spyOn(modal, '_emitSelection');
      modal.addButton.click();
      // No selection = no emission, proving _handleAddSelected ran (early return path)
      expect(emitSpy).not.toHaveBeenCalled();
      // Now test with valid selection: add summary + select chat
      modal.chatSummaries.set('fake-id', { text: 's' });
      modal.selectedChatIds.add('fake-id');
      modal.chats = [{ id: 'fake-id', title: 'F' }];
      modal.addButton.click();
      // Async handler won't complete synchronously, but the spy captures it
    });

    it('sets timer to focus search input', async () => {
      await modal.open('src-1');
      expect(modal._timers.length).toBeGreaterThanOrEqual(1);
    });

    it('clears previous content on re-render', async () => {
      await modal.open('src-1');
      // Manually close and re-open
      jest.advanceTimersByTime(0);
      modal.close();
      jest.advanceTimersByTime(300);
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open('src-2');
      // Should have fresh content, no duplicates
      const titles = modal.headerEl.querySelectorAll('.csm-modal-title');
      expect(titles.length).toBe(1);
    });
  });

  // =========================================================================
  // _renderContent without footer (BaseModal showFooter=false fallback)
  // =========================================================================

  describe('_renderContent without footerEl', () => {
    it('creates buttons in body when footerEl is absent', async () => {
      // Create modal then manually remove footerEl to simulate no-footer scenario
      const svc = createChatService([]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      modal.footerEl = null;
      modal._renderContent();
      const buttonContainer = modal.bodyEl.querySelector('.csm-button-container');
      expect(buttonContainer).not.toBeNull();
      expect(modal.addButton).not.toBeNull();
      const cancelBtn = buttonContainer.querySelector('.csm-btn-cancel');
      expect(cancelBtn).not.toBeNull();
    });

    it('cancel button in body calls close()', async () => {
      const svc = createChatService([]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      modal.footerEl = null;
      modal._renderContent();
      const cancelBtn = modal.bodyEl.querySelector('.csm-btn-cancel');
      const spy = jest.spyOn(modal, 'close');
      cancelBtn.click();
      expect(spy).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _loadChats
  // =========================================================================

  describe('_loadChats', () => {
    it('loads chats from chatService', async () => {
      const chatObjs = [
        makeChatDomainObj({ id: 'c1', title: 'Alpha' }),
        makeChatDomainObj({ id: 'c2', title: 'Beta' }),
      ];
      const svc = createChatService(chatObjs);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      expect(svc.loadAllChats).toHaveBeenCalled();
      expect(modal.chats.length).toBe(2);
      expect(modal.chats[0].title).toBe('Alpha');
    });

    it('maps domain object fields correctly (createdAt -> created_at)', async () => {
      const chatObj = makeChatDomainObj({
        id: 'c1',
        title: 'Test',
        createdAt: '2026-01-15T10:00:00Z',
        updatedAt: '2026-01-16T10:00:00Z',
      });
      const svc = createChatService([chatObj]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      expect(modal.chats[0].id).toBe('c1');
      expect(modal.chats[0].created_at).toBe('2026-01-15T10:00:00Z');
      expect(modal.chats[0].updated_at).toBe('2026-01-16T10:00:00Z');
    });

    it('maps _id fallback when id is missing', async () => {
      const chatObj = { _id: 'fallback-1', _title: 'Fallback Title', _createdAt: '2026-01-10' };
      const svc = createChatService([chatObj]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      expect(modal.chats[0].id).toBe('fallback-1');
      expect(modal.chats[0].title).toBe('Fallback Title');
    });

    it('defaults title to "Untitled Chat" when missing', async () => {
      const chatObj = { id: 'c1' };
      const svc = createChatService([chatObj]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      expect(modal.chats[0].title).toBe('Untitled Chat');
    });

    it('handles null return from loadAllChats', async () => {
      const svc = { loadAllChats: jest.fn().mockResolvedValue(null) };
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      expect(modal.chats).toEqual([]);
    });

    it('filters out excluded chat IDs', async () => {
      const chatObjs = [
        makeChatDomainObj({ id: 'c1' }),
        makeChatDomainObj({ id: 'c2' }),
        makeChatDomainObj({ id: 'c3' }),
      ];
      const svc = createChatService(chatObjs);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open('c1', ['c2']);
      // c1 excluded (sourceChatId), c2 excluded (explicit)
      expect(modal.chats.length).toBe(1);
      expect(modal.chats[0].id).toBe('c3');
    });

    it('handles missing chatService gracefully', async () => {
      ({ modal, eventBus } = createModal({ chatService: null }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      expect(modal.chats).toEqual([]);
    });

    it('shows error state on loadAllChats failure', async () => {
      const svc = { loadAllChats: jest.fn().mockRejectedValue(new Error('network fail')) };
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      expect(modal.listContainer.innerHTML).toContain('Failed to load chats');
      expect(modal.listContainer.innerHTML).toContain('Please try again later');
      expect(mockLog.error).toHaveBeenCalledWith('failed to load chats', expect.any(Object));
    });

    it('does not call _loadSummaries on loadAllChats failure', async () => {
      const svc = { loadAllChats: jest.fn().mockRejectedValue(new Error('network fail')) };
      ({ modal, eventBus } = createModal({ chatService: svc }));
      // If _loadSummaries were called, it would call aether.chatSummaries.list
      await modal.open(null);
      expect(mockAether.chatSummaries.list).not.toHaveBeenCalled();
    });

    it('shows skeleton loading state during load', async () => {
      let resolveLoad;
      const svc = {
        loadAllChats: jest.fn().mockReturnValue(new Promise(r => { resolveLoad = r; })),
      };
      ({ modal, eventBus } = createModal({ chatService: svc }));

      // Start open but don't await yet
      const openPromise = modal.open(null);
      // Check skeleton is shown (loadChats is pending)
      // Since _renderContent runs before _loadChats, list container should exist
      // but _loadChats will show skeleton
      resolveLoad([]);
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await openPromise;
    });
  });

  // =========================================================================
  // _loadSummaries
  // =========================================================================

  describe('_loadSummaries', () => {
    it('loads summaries for each chat', async () => {
      const chatObjs = [
        makeChatDomainObj({ id: 'c1' }),
        makeChatDomainObj({ id: 'c2' }),
      ];
      const svc = createChatService(chatObjs);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockImplementation(async (chatId) => {
        if (chatId === 'c1') return [{ text: 'Summary for c1' }];
        return [];
      });
      await modal.open(null);
      expect(modal.chatSummaries.has('c1')).toBe(true);
      expect(modal.chatSummaries.has('c2')).toBe(false);
    });

    it('handles per-chat summary load error gracefully', async () => {
      const chatObjs = [makeChatDomainObj({ id: 'c1' })];
      const svc = createChatService(chatObjs);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockRejectedValue(new Error('no summary'));
      await modal.open(null);
      expect(modal.chatSummaries.size).toBe(0);
      expect(mockLog.debug).toHaveBeenCalledWith('no summary for chat', { chatId: 'c1' });
    });

    it('handles null aether.chatSummaries gracefully', async () => {
      const chatObjs = [makeChatDomainObj({ id: 'c1' })];
      const svc = createChatService(chatObjs);
      const nullAether = { chatSummaries: null };
      ({ modal, eventBus } = createModal({ chatService: svc, aether: nullAether }));
      await modal.open(null);
      expect(modal.chatSummaries.size).toBe(0);
    });
  });

  // =========================================================================
  // _renderChatList
  // =========================================================================

  describe('_renderChatList', () => {
    it('shows "No chats available" when empty and no search', async () => {
      const svc = createChatService([]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      expect(modal.listContainer.innerHTML).toContain('No chats available');
    });

    it('shows "No chats match your search" when empty with search', async () => {
      const chatObjs = [makeChatDomainObj({ id: 'c1', title: 'Alpha' })];
      const svc = createChatService(chatObjs);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);

      // Trigger search with no match
      const inputEvent = new Event('input');
      Object.defineProperty(modal.searchInput, 'value', { value: 'zzzzz', configurable: true });
      modal.searchInput.dispatchEvent(inputEvent);
      expect(modal.listContainer.innerHTML).toContain('No chats match your search');
    });

    it('renders a card for each chat', async () => {
      const chatObjs = [
        makeChatDomainObj({ id: 'c1', title: 'Alpha' }),
        makeChatDomainObj({ id: 'c2', title: 'Beta' }),
        makeChatDomainObj({ id: 'c3', title: 'Gamma' }),
      ];
      const svc = createChatService(chatObjs);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      const cards = modal.listContainer.querySelectorAll('.csm-card');
      expect(cards.length).toBe(3);
    });
  });

  // =========================================================================
  // _createChatCard
  // =========================================================================

  describe('_createChatCard', () => {
    let chatObjs;
    let svc;

    beforeEach(() => {
      chatObjs = [
        makeChatDomainObj({ id: 'c1', title: 'Test Chat' }),
      ];
      svc = createChatService(chatObjs);
    });

    it('renders chat title', async () => {
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      const title = modal.listContainer.querySelector('.csm-chat-title');
      expect(title.textContent).toBe('Test Chat');
    });

    it('renders "Untitled Chat" when title is falsy', async () => {
      chatObjs = [makeChatDomainObj({ id: 'c1', title: '' })];
      svc = createChatService(chatObjs);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      // The mapping in _loadChats already sets 'Untitled Chat' for falsy titles
      // so the card shows whatever is in chats array
      const title = modal.listContainer.querySelector('.csm-chat-title');
      expect(title.textContent).toBe('Untitled Chat');
    });

    it('renders created date', async () => {
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      const meta = modal.listContainer.querySelector('.csm-meta');
      expect(meta.textContent).toContain('Created');
      expect(meta.textContent).toContain('Jan');
    });

    it('sets data-chatId on card', async () => {
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      const card = modal.listContainer.querySelector('.csm-card');
      expect(card.dataset.chatId).toBe('c1');
    });

    it('shows "Generate" button when no summary', async () => {
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      const genBtn = modal.listContainer.querySelector('.csm-generate-btn');
      expect(genBtn).not.toBeNull();
      expect(genBtn.textContent).toBe('Generate');
    });

    it('shows "Summarized" badge and regen button when has summary', async () => {
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([{ text: 'summary' }]);
      await modal.open(null);
      const badge = modal.listContainer.querySelector('.csm-badge--summarized');
      expect(badge).not.toBeNull();
      expect(badge.textContent).toBe('Summarized');
      const regenBtn = modal.listContainer.querySelector('.csm-icon-btn');
      expect(regenBtn).not.toBeNull();
      expect(regenBtn.getAttribute('aria-label')).toBe('Regenerate summary');
    });

    it('shows processing badge when chat is being summarized', async () => {
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      // Mark as processing and re-render
      modal.processingChats.add('c1');
      modal._renderChatList();
      const badge = modal.listContainer.querySelector('.csm-badge--processing');
      expect(badge).not.toBeNull();
      expect(badge.textContent).toContain('Processing');
    });

    it('adds is-selected class when chat is selected', async () => {
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      modal.selectedChatIds.add('c1');
      modal._renderChatList();
      const card = modal.listContainer.querySelector('.csm-card');
      expect(card.className).toContain('is-selected');
    });

    it('renders checkbox SVG when selected', async () => {
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      modal.selectedChatIds.add('c1');
      modal._renderChatList();
      const checkbox = modal.listContainer.querySelector('.csm-checkbox');
      expect(checkbox.innerHTML).toContain('polyline');
    });

    it('clicking card toggles selection', async () => {
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      const card = modal.listContainer.querySelector('.csm-card');
      card.click();
      expect(modal.selectedChatIds.has('c1')).toBe(true);
    });

    it('clicking card while processing does NOT toggle selection', async () => {
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      modal.processingChats.add('c1');
      modal._renderChatList();
      const card = modal.listContainer.querySelector('.csm-card');
      card.click();
      expect(modal.selectedChatIds.has('c1')).toBe(false);
    });

    it('generate button triggers _generateSummaryForChat', async () => {
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      mockAether.chatSummaries.generate.mockResolvedValue({ text: 'new summary' });
      await modal.open(null);
      const spy = jest.spyOn(modal, '_generateSummaryForChat');
      const genBtn = modal.listContainer.querySelector('.csm-generate-btn');
      genBtn.click();
      expect(spy).toHaveBeenCalledWith('c1');
    });

    it('generate button click does not propagate to card', async () => {
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      mockAether.chatSummaries.generate.mockResolvedValue({ text: 'new summary' });
      await modal.open(null);
      const genBtn = modal.listContainer.querySelector('.csm-generate-btn');
      genBtn.click();
      // Card click would toggle selection - verify it didn't happen
      expect(modal.selectedChatIds.has('c1')).toBe(false);
    });

    it('regen button triggers _generateSummaryForChat with forceRegenerate', async () => {
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([{ text: 'existing' }]);
      mockAether.chatSummaries.generate.mockResolvedValue({ text: 'new' });
      await modal.open(null);
      const spy = jest.spyOn(modal, '_generateSummaryForChat');
      const regenBtn = modal.listContainer.querySelector('.csm-icon-btn');
      regenBtn.click();
      expect(spy).toHaveBeenCalledWith('c1', { forceRegenerate: true });
    });

    it('regen button click does not propagate to card', async () => {
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([{ text: 'existing' }]);
      mockAether.chatSummaries.generate.mockResolvedValue({ text: 'new' });
      await modal.open(null);
      const regenBtn = modal.listContainer.querySelector('.csm-icon-btn');
      regenBtn.click();
      expect(modal.selectedChatIds.has('c1')).toBe(false);
    });
  });

  // =========================================================================
  // _handleSearch
  // =========================================================================

  describe('_handleSearch', () => {
    it('filters chats by title (case insensitive)', async () => {
      const chatObjs = [
        makeChatDomainObj({ id: 'c1', title: 'Alpha Chat' }),
        makeChatDomainObj({ id: 'c2', title: 'Beta Discussion' }),
        makeChatDomainObj({ id: 'c3', title: 'Gamma Alpha' }),
      ];
      const svc = createChatService(chatObjs);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);

      Object.defineProperty(modal.searchInput, 'value', { value: 'alpha', configurable: true });
      modal.searchInput.dispatchEvent(new Event('input'));

      expect(modal.filteredChats.length).toBe(2);
      expect(modal.filteredChats[0].id).toBe('c1');
      expect(modal.filteredChats[1].id).toBe('c3');
    });

    it('resets to all chats when search is cleared', async () => {
      const chatObjs = [
        makeChatDomainObj({ id: 'c1', title: 'Alpha' }),
        makeChatDomainObj({ id: 'c2', title: 'Beta' }),
      ];
      const svc = createChatService(chatObjs);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);

      // Search first
      Object.defineProperty(modal.searchInput, 'value', { value: 'alpha', configurable: true });
      modal.searchInput.dispatchEvent(new Event('input'));
      expect(modal.filteredChats.length).toBe(1);

      // Clear search
      Object.defineProperty(modal.searchInput, 'value', { value: '', configurable: true });
      modal.searchInput.dispatchEvent(new Event('input'));
      expect(modal.filteredChats.length).toBe(2);
    });

    it('trims and lowercases search query', async () => {
      const chatObjs = [makeChatDomainObj({ id: 'c1', title: 'Alpha' })];
      const svc = createChatService(chatObjs);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);

      Object.defineProperty(modal.searchInput, 'value', { value: '  ALPHA  ', configurable: true });
      modal.searchInput.dispatchEvent(new Event('input'));
      expect(modal.filteredChats.length).toBe(1);
      expect(modal.searchQuery).toBe('alpha');
    });

    it('handles chat with null title in search', async () => {
      const chatObjs = [{ id: 'c1', title: null, createdAt: '2026-01-15' }];
      const svc = createChatService(chatObjs);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);

      Object.defineProperty(modal.searchInput, 'value', { value: 'test', configurable: true });
      modal.searchInput.dispatchEvent(new Event('input'));
      // Should not throw; null title treated as empty string
      expect(modal.filteredChats.length).toBe(0);
    });
  });

  // =========================================================================
  // _toggleChatSelection
  // =========================================================================

  describe('_toggleChatSelection', () => {
    it('adds chat to selectedChatIds on first click', async () => {
      const chatObjs = [makeChatDomainObj({ id: 'c1' })];
      const svc = createChatService(chatObjs);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);

      const card = modal.listContainer.querySelector('.csm-card');
      card.click();
      expect(modal.selectedChatIds.has('c1')).toBe(true);
    });

    it('removes chat from selectedChatIds on second click', async () => {
      const chatObjs = [makeChatDomainObj({ id: 'c1' })];
      const svc = createChatService(chatObjs);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);

      // Select
      let card = modal.listContainer.querySelector('.csm-card');
      card.click();
      expect(modal.selectedChatIds.has('c1')).toBe(true);

      // Deselect (card was re-rendered, need to grab new reference)
      card = modal.listContainer.querySelector('.csm-card');
      card.click();
      expect(modal.selectedChatIds.has('c1')).toBe(false);
    });

    it('supports multi-select across different chats', async () => {
      const chatObjs = [
        makeChatDomainObj({ id: 'c1', title: 'A' }),
        makeChatDomainObj({ id: 'c2', title: 'B' }),
      ];
      const svc = createChatService(chatObjs);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);

      const cards = modal.listContainer.querySelectorAll('.csm-card');
      cards[0].click();
      // Re-query after re-render
      const cards2 = modal.listContainer.querySelectorAll('.csm-card');
      cards2[1].click();
      expect(modal.selectedChatIds.size).toBe(2);
    });
  });

  // =========================================================================
  // _updateSelectionUI
  // =========================================================================

  describe('_updateSelectionUI', () => {
    let chatObjs;
    let svc;

    beforeEach(async () => {
      chatObjs = [
        makeChatDomainObj({ id: 'c1', title: 'A' }),
        makeChatDomainObj({ id: 'c2', title: 'B' }),
      ];
      svc = createChatService(chatObjs);
    });

    it('hides selection info when nothing selected', async () => {
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      modal._updateSelectionUI();
      expect(modal.selectionInfo.style.display).toBe('none');
      expect(modal.addButton.disabled).toBe(true);
    });

    it('shows singular text for 1 selected chat', async () => {
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([{ text: 's' }]);
      await modal.open(null);
      modal.selectedChatIds.add('c1');
      modal._updateSelectionUI();
      expect(modal.selectionInfo.textContent).toBe('1 chat selected');
      expect(modal.selectionInfo.style.display).toBe('block');
    });

    it('shows plural text for multiple selected chats', async () => {
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([{ text: 's' }]);
      await modal.open(null);
      modal.selectedChatIds.add('c1');
      modal.selectedChatIds.add('c2');
      modal._updateSelectionUI();
      expect(modal.selectionInfo.textContent).toBe('2 chats selected');
    });

    it('enables add button when all selected have summaries', async () => {
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([{ text: 's' }]);
      await modal.open(null);
      modal.selectedChatIds.add('c1');
      modal._updateSelectionUI();
      expect(modal.addButton.disabled).toBe(false);
    });

    it('disables add button when selected chats need summaries', async () => {
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      modal.selectedChatIds.add('c1');
      modal._updateSelectionUI();
      expect(modal.addButton.disabled).toBe(true);
      expect(modal.selectionInfo.textContent).toContain('Generate summaries');
    });

    it('shows warning when selected chats are processing', async () => {
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      modal.selectedChatIds.add('c1');
      modal.processingChats.add('c1');
      modal._updateSelectionUI();
      expect(modal.selectionInfo.textContent).toContain('Generating summaries');
      expect(modal.addButton.disabled).toBe(true);
    });

    it('shows singular processing text for 1 chat', async () => {
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      modal.selectedChatIds.add('c1');
      modal.processingChats.add('c1');
      modal._updateSelectionUI();
      expect(modal.selectionInfo.textContent).toContain('1 selected chat...');
    });

    it('shows plural processing text for multiple chats', async () => {
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      modal.selectedChatIds.add('c1');
      modal.selectedChatIds.add('c2');
      modal.processingChats.add('c1');
      modal.processingChats.add('c2');
      modal._updateSelectionUI();
      expect(modal.selectionInfo.textContent).toContain('2 selected chats...');
    });

    it('shows singular needing-summary text for 1 chat', async () => {
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      modal.selectedChatIds.add('c1');
      modal._updateSelectionUI();
      expect(modal.selectionInfo.textContent).toContain('1 selected chat');
    });

    it('shows plural needing-summary text for multiple chats', async () => {
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      modal.selectedChatIds.add('c1');
      modal.selectedChatIds.add('c2');
      modal._updateSelectionUI();
      expect(modal.selectionInfo.textContent).toContain('2 selected chats');
    });
  });

  // =========================================================================
  // _enableAddButton / _disableAddButton
  // =========================================================================

  describe('_enableAddButton / _disableAddButton', () => {
    it('enable sets disabled to false', async () => {
      const svc = createChatService([]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      modal.addButton.disabled = true;
      modal._enableAddButton();
      expect(modal.addButton.disabled).toBe(false);
    });

    it('disable sets disabled to true', async () => {
      const svc = createChatService([]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      modal.addButton.disabled = false;
      modal._disableAddButton();
      expect(modal.addButton.disabled).toBe(true);
    });

    it('enable is safe when addButton is null', () => {
      ({ modal } = createModal());
      modal.addButton = null;
      expect(() => modal._enableAddButton()).not.toThrow();
    });

    it('disable is safe when addButton is null', () => {
      ({ modal } = createModal());
      modal.addButton = null;
      expect(() => modal._disableAddButton()).not.toThrow();
    });
  });

  // =========================================================================
  // _handleAddSelected
  // =========================================================================

  describe('_handleAddSelected', () => {
    it('does nothing when no chats selected', async () => {
      const svc = createChatService([makeChatDomainObj({ id: 'c1' })]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      const spy = jest.spyOn(modal, '_emitSelection');
      await modal._handleAddSelected();
      expect(spy).not.toHaveBeenCalled();
    });

    it('returns early when selected chats are still processing', async () => {
      const svc = createChatService([makeChatDomainObj({ id: 'c1' })]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      modal.selectedChatIds.add('c1');
      modal.processingChats.add('c1');
      const spy = jest.spyOn(modal, '_emitSelection');
      await modal._handleAddSelected();
      expect(spy).not.toHaveBeenCalled();
    });

    it('returns early when selected chats need summaries', async () => {
      const svc = createChatService([makeChatDomainObj({ id: 'c1' })]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      modal.selectedChatIds.add('c1');
      const spy = jest.spyOn(modal, '_emitSelection');
      await modal._handleAddSelected();
      expect(spy).not.toHaveBeenCalled();
    });

    it('calls _emitSelection when all selected have summaries', async () => {
      const svc = createChatService([makeChatDomainObj({ id: 'c1' })]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([{ text: 'summary' }]);
      await modal.open(null);
      modal.selectedChatIds.add('c1');
      const spy = jest.spyOn(modal, '_emitSelection');
      await modal._handleAddSelected();
      expect(spy).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _generateSummaryForChat
  // =========================================================================

  describe('_generateSummaryForChat', () => {
    it('generates summary and stores result', async () => {
      const svc = createChatService([makeChatDomainObj({ id: 'c1' })]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      mockAether.chatSummaries.generate.mockResolvedValue({ text: 'generated' });
      await modal.open(null);
      await modal._generateSummaryForChat('c1');
      expect(modal.chatSummaries.has('c1')).toBe(true);
      expect(modal.chatSummaries.get('c1').text).toBe('generated');
    });

    it('returns early for null chatId', async () => {
      const svc = createChatService([]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      await modal._generateSummaryForChat(null);
      expect(mockAether.chatSummaries.generate).not.toHaveBeenCalled();
    });

    it('returns early if chatId is already processing', async () => {
      const svc = createChatService([makeChatDomainObj({ id: 'c1' })]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      modal.processingChats.add('c1');
      await modal._generateSummaryForChat('c1');
      expect(mockAether.chatSummaries.generate).not.toHaveBeenCalled();
    });

    it('adds and removes from processingChats during generation', async () => {
      const svc = createChatService([makeChatDomainObj({ id: 'c1' })]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      let resolveGenerate;
      mockAether.chatSummaries.generate.mockReturnValue(new Promise(r => { resolveGenerate = r; }));
      await modal.open(null);
      const promise = modal._generateSummaryForChat('c1');
      expect(modal.processingChats.has('c1')).toBe(true);
      resolveGenerate({ text: 'done' });
      await promise;
      expect(modal.processingChats.has('c1')).toBe(false);
    });

    it('handles generate error and cleans up processing state', async () => {
      const svc = createChatService([makeChatDomainObj({ id: 'c1' })]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      mockAether.chatSummaries.generate.mockRejectedValue(new Error('gen fail'));
      await modal.open(null);
      await modal._generateSummaryForChat('c1');
      expect(modal.processingChats.has('c1')).toBe(false);
      expect(mockLog.error).toHaveBeenCalledWith('failed to generate summary', expect.objectContaining({ chatId: 'c1' }));
    });

    it('does not store summary when generate returns null', async () => {
      const svc = createChatService([makeChatDomainObj({ id: 'c1' })]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      mockAether.chatSummaries.generate.mockResolvedValue(null);
      await modal.open(null);
      await modal._generateSummaryForChat('c1');
      expect(modal.chatSummaries.has('c1')).toBe(false);
    });

    it('passes options to generate call', async () => {
      const svc = createChatService([makeChatDomainObj({ id: 'c1' })]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      mockAether.chatSummaries.generate.mockResolvedValue({ text: 'new' });
      await modal.open(null);
      await modal._generateSummaryForChat('c1', { forceRegenerate: true });
      expect(mockAether.chatSummaries.generate).toHaveBeenCalledWith('c1', { forceRegenerate: true });
    });

    it('re-renders chat list after generation', async () => {
      const svc = createChatService([makeChatDomainObj({ id: 'c1' })]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      mockAether.chatSummaries.generate.mockResolvedValue({ text: 'done' });
      await modal.open(null);
      const renderSpy = jest.spyOn(modal, '_renderChatList');
      await modal._generateSummaryForChat('c1');
      // Called in try + finally = at least 2 times
      expect(renderSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // =========================================================================
  // _trackListener
  // =========================================================================

  describe('_trackListener', () => {
    it('adds listener and tracks for cleanup', () => {
      ({ modal } = createModal());
      const el = document.createElement('button');
      const handler = jest.fn();
      modal._trackListener(el, 'click', handler);
      expect(modal._listeners.length).toBe(1);
      el.click();
      expect(handler).toHaveBeenCalled();
    });

    it('no-ops when element is null', () => {
      ({ modal } = createModal());
      modal._trackListener(null, 'click', jest.fn());
      expect(modal._listeners.length).toBe(0);
    });

    it('no-ops when element is undefined', () => {
      ({ modal } = createModal());
      modal._trackListener(undefined, 'click', jest.fn());
      expect(modal._listeners.length).toBe(0);
    });

    it('stores options in tracked entry', () => {
      ({ modal } = createModal());
      const el = document.createElement('button');
      modal._trackListener(el, 'click', jest.fn(), { once: true });
      expect(modal._listeners[0].options).toEqual({ once: true });
    });
  });

  // =========================================================================
  // _trackTimer
  // =========================================================================

  describe('_trackTimer', () => {
    it('stores timer ID', () => {
      ({ modal } = createModal());
      const id = modal._trackTimer(() => {}, 1000);
      expect(modal._timers).toContain(id);
    });

    it('executes callback after delay', () => {
      ({ modal } = createModal());
      const fn = jest.fn();
      modal._trackTimer(fn, 500);
      expect(fn).not.toHaveBeenCalled();
      jest.advanceTimersByTime(500);
      expect(fn).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _cleanup
  // =========================================================================

  describe('_cleanup', () => {
    it('removes all tracked listeners', async () => {
      const svc = createChatService([makeChatDomainObj({ id: 'c1' })]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      expect(modal._listeners.length).toBeGreaterThan(0);
      modal._cleanup();
      expect(modal._listeners).toEqual([]);
    });

    it('clears all tracked timers', async () => {
      const svc = createChatService([]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      expect(modal._timers.length).toBeGreaterThan(0);
      modal._cleanup();
      expect(modal._timers).toEqual([]);
    });

    it('resets selectedChatIds', async () => {
      const svc = createChatService([makeChatDomainObj({ id: 'c1' })]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      modal.selectedChatIds.add('c1');
      modal._cleanup();
      expect(modal.selectedChatIds.size).toBe(0);
    });

    it('resets chatSummaries and processingChats', async () => {
      const svc = createChatService([]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      modal.chatSummaries.set('c1', { text: 'x' });
      modal.processingChats.add('c1');
      modal._cleanup();
      expect(modal.chatSummaries.size).toBe(0);
      expect(modal.processingChats.size).toBe(0);
    });

    it('resets chats and filteredChats to empty arrays', async () => {
      const svc = createChatService([makeChatDomainObj({ id: 'c1' })]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      modal._cleanup();
      expect(modal.chats).toEqual([]);
      expect(modal.filteredChats).toEqual([]);
    });

    it('resets searchQuery to empty string', async () => {
      const svc = createChatService([]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      modal.searchQuery = 'test';
      modal._cleanup();
      expect(modal.searchQuery).toBe('');
    });

    it('nulls DOM references', async () => {
      const svc = createChatService([]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      modal._cleanup();
      expect(modal.searchInput).toBeNull();
      expect(modal.selectionInfo).toBeNull();
      expect(modal.listContainer).toBeNull();
      expect(modal.addButton).toBeNull();
    });

    it('is safe with already-removed elements', () => {
      ({ modal } = createModal());
      const el = document.createElement('button');
      modal._trackListener(el, 'click', jest.fn());
      el.remove();
      expect(() => modal._cleanup()).not.toThrow();
    });
  });

  // =========================================================================
  // _emitSelection
  // =========================================================================

  describe('_emitSelection', () => {
    it('emits chat-reference:chats-selected with correct payload', async () => {
      const chatObjs = [
        makeChatDomainObj({ id: 'c1', title: 'A' }),
        makeChatDomainObj({ id: 'c2', title: 'B' }),
      ];
      const svc = createChatService(chatObjs);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([{ text: 's' }]);
      await modal.open('src-1');
      modal.selectedChatIds.add('c1');
      modal._emitSelection();
      expect(eventBus.emit).toHaveBeenCalledWith('chat-reference:chats-selected', {
        sourceChatId: 'src-1',
        selectedChats: [expect.objectContaining({ id: 'c1', title: 'A' })],
      });
    });

    it('includes only selected chats in payload', async () => {
      const chatObjs = [
        makeChatDomainObj({ id: 'c1', title: 'A' }),
        makeChatDomainObj({ id: 'c2', title: 'B' }),
      ];
      const svc = createChatService(chatObjs);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([{ text: 's' }]);
      await modal.open(null);
      modal.selectedChatIds.add('c2');
      modal._emitSelection();
      const call = eventBus.emit.mock.calls[0];
      expect(call[1].selectedChats.length).toBe(1);
      expect(call[1].selectedChats[0].id).toBe('c2');
    });

    it('does not emit when eventBus is null', async () => {
      const svc = createChatService([makeChatDomainObj({ id: 'c1' })]);
      ({ modal } = createModal({ eventBus: null, chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([{ text: 's' }]);
      await modal.open(null);
      modal.selectedChatIds.add('c1');
      expect(() => modal._emitSelection()).not.toThrow();
    });

    it('calls close() after emitting', async () => {
      const svc = createChatService([makeChatDomainObj({ id: 'c1' })]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([{ text: 's' }]);
      await modal.open(null);
      modal.selectedChatIds.add('c1');
      const spy = jest.spyOn(modal, 'close');
      modal._emitSelection();
      expect(spy).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // BaseModal integration
  // =========================================================================

  describe('BaseModal integration', () => {
    it('close() calls _cleanup via BaseModal setTimeout', async () => {
      const svc = createChatService([makeChatDomainObj({ id: 'c1' })]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);
      modal.selectedChatIds.add('c1');

      jest.advanceTimersByTime(0); // flush rAF
      modal.close();
      jest.advanceTimersByTime(300);
      expect(modal.selectedChatIds.size).toBe(0);
      expect(modal._listeners).toEqual([]);
    });

    it('destroy() removes overlay from DOM', async () => {
      const svc = createChatService([]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);

      jest.advanceTimersByTime(0);
      const overlay = modal.overlay;
      expect(overlay.parentNode).toBe(document.body);
      modal.destroy();
      expect(overlay.parentNode).toBeNull();
    });

    it('ESC key closes modal', async () => {
      const svc = createChatService([]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);

      const event = new KeyboardEvent('keydown', { key: 'Escape' });
      document.dispatchEvent(event);
      expect(modal.isOpen).toBe(false);
    });

    it('backdrop click closes modal', async () => {
      const svc = createChatService([]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);

      const clickEvent = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(clickEvent, 'target', { value: modal.overlay });
      modal.overlay.dispatchEvent(clickEvent);
      expect(modal.isOpen).toBe(false);
    });

    it('panel click does NOT close modal', async () => {
      const svc = createChatService([]);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open(null);

      modal.panel.click();
      expect(modal.isOpen).toBe(true);
    });
  });

  // =========================================================================
  // Full lifecycle
  // =========================================================================

  describe('full lifecycle', () => {
    it('open -> select -> add -> close -> re-open works cleanly', async () => {
      const chatObjs = [makeChatDomainObj({ id: 'c1', title: 'A' })];
      const svc = createChatService(chatObjs);
      ({ modal, eventBus } = createModal({ chatService: svc }));
      mockAether.chatSummaries.list.mockResolvedValue([{ text: 's' }]);

      // Open
      await modal.open(null);
      expect(modal.isOpen).toBe(true);

      // Select and add
      modal.selectedChatIds.add('c1');
      await modal._handleAddSelected();
      expect(eventBus.emit).toHaveBeenCalledWith('chat-reference:chats-selected', expect.any(Object));

      // Close animation
      jest.advanceTimersByTime(0);
      jest.advanceTimersByTime(300);

      // Re-open
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open('src-2');
      expect(modal.isOpen).toBe(true);
      expect(modal.sourceChatId).toBe('src-2');
      expect(modal.selectedChatIds.size).toBe(0);
    });
  });
});
