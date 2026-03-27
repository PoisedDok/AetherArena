/** @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js */

'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() };

const mockMemories = {
  list: jest.fn().mockResolvedValue([]),
  update: jest.fn().mockResolvedValue({}),
  delete: jest.fn().mockResolvedValue({}),
  promote: jest.fn().mockResolvedValue({}),
  demote: jest.fn().mockResolvedValue({}),
  create: jest.fn().mockResolvedValue({}),
  search: jest.fn().mockResolvedValue({ results: [] })
};

const mockAether = { logger: mockLog, memories: mockMemories };

jest.mock('../../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: () => mockAether,
}));

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

const mockToast = { success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn() };
jest.mock('../../../../src/renderer/shared/components/Toast', () => mockToast);

const mockConfirmDialog = { confirm: jest.fn().mockResolvedValue(true), prompt: jest.fn().mockResolvedValue(null) };
jest.mock('../../../../src/renderer/shared/components/ConfirmDialog', () => mockConfirmDialog);

const MemoryBrowserModal = require('../../../../src/renderer/main/modules/memory-browser/MemoryBrowserModal');
const Utils = require('../../../../src/renderer/main/modules/memory-browser/internal/MemoryBrowserUtils');
const Renderers = require('../../../../src/renderer/main/modules/memory-browser/internal/MemoryBrowserRenderers');
const Controller = require('../../../../src/renderer/main/modules/memory-browser/internal/MemoryBrowserController');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMemory(overrides = {}) {
  return {
    id: 'mem-1',
    content: 'User prefers dark mode',
    memory_type: 'preference',
    importance_score: 0.8,
    extracted_at: '2026-01-15T12:00:00Z',
    source_chat_id: null,
    ...overrides,
  };
}

function createModal(opts = {}) {
  const eventBus = opts.eventBus || { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
  const modal = new MemoryBrowserModal({ eventBus, aether: mockAether });
  modal.isOpen = true; // Required to pass DEVELOPMENT_PROTOCOL async guards
  return { modal, eventBus };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoryBrowserModal', () => {
  afterEach(() => {
    document.querySelectorAll('.modal-overlay').forEach((el) => el.remove());
    jest.restoreAllMocks();
    mockMemories.list.mockResolvedValue([]);
    mockMemories.search.mockResolvedValue({ results: [] });
  });

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  describe('constructor', () => {
    test('sets initial state', () => {
      const { modal } = createModal();
      expect(modal.memories).toEqual([]);
      expect(modal.activeTab).toBe('all');
      expect(modal.searchQuery).toBe('');
      expect(modal.editingMemoryId).toBeNull();
      expect(modal.isCreatingMemory).toBe(false);
      expect(modal._listeners).toEqual([]);
      expect(modal._timers).toEqual([]);
      expect(modal.id).toBe('memory-browser-modal');
    });

    test('has memory scopes', () => {
      expect(Utils.MEMORY_SCOPES).toHaveLength(3);
      const ids = Utils.MEMORY_SCOPES.map((s) => s.id);
      expect(ids).toEqual(['all', 'global', 'chat']);
    });

    test('has memory type tones', () => {
      expect(Utils.MEMORY_TYPE_TONES.fact).toBe('accent');
      expect(Utils.MEMORY_TYPE_TONES.preference).toBe('warning');
      expect(Utils.MEMORY_TYPE_TONES.action_item).toBe('error');
    });
  });

  // -----------------------------------------------------------------------
  // _getScopeCount()
  // -----------------------------------------------------------------------

  describe('_getScopeCount()', () => {
    test('returns total for "all"', () => {
      const { modal } = createModal();
      modal.memories = [makeMemory(), makeMemory({ id: '2' })];
      expect(Utils.getScopeCount(modal.memories, 'all', modal.currentChatId)).toBe(2);
    });

    test('counts global memories (no source_chat_id)', () => {
      const { modal } = createModal();
      modal.memories = [
        makeMemory({ source_chat_id: null }),
        makeMemory({ id: '2', source_chat_id: 'chat-1' }),
      ];
      expect(Utils.getScopeCount(modal.memories, 'global', modal.currentChatId)).toBe(1);
    });

    test('counts chat-specific memories', () => {
      const { modal } = createModal();
      modal.memories = [
        makeMemory({ source_chat_id: null }),
        makeMemory({ id: '2', source_chat_id: 'chat-1' }),
        makeMemory({ id: '3', source_chat_id: 'chat-2' }),
      ];
      expect(Utils.getScopeCount(modal.memories, 'chat', modal.currentChatId)).toBe(2);
    });

    test('returns 0 for unknown scope', () => {
      const { modal } = createModal();
      expect(Utils.getScopeCount(modal.memories, 'unknown', modal.currentChatId)).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // _handleTabSwitch()
  // -----------------------------------------------------------------------

  describe('_handleTabSwitch()', () => {
    test('switches active tab and resets search', () => {
      const { modal } = createModal();
      modal.memories = [];
      modal.searchQuery = 'old search';
      modal._handleTabSwitch('global');
      expect(modal.activeTab).toBe('global');
      expect(modal.searchQuery).toBe('');
    });
  });

  // -----------------------------------------------------------------------
  // _handleSearch()
  // -----------------------------------------------------------------------

  describe('_handleSearch()', () => {
    test('updates search query and filters', async () => {
      jest.useFakeTimers();
      const { modal } = createModal();
      modal.isOpen = true; // Guard requires this
      modal.memories = [
        makeMemory({ content: 'dark mode preference' }),
        makeMemory({ id: '2', content: 'API key stored' }),
      ];
      modal._renderUI();

      // Mock search results
      mockMemories.search = jest.fn().mockResolvedValue({
        results: [makeMemory({ content: 'dark mode preference' })]
      });

      Controller.handleSearch(modal, 'dark');
      
      // Wait for debounce timer (300ms)
      jest.advanceTimersByTime(310);
      // Wait for promise resolution
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(modal.searchQuery).toBe('dark');
      const cards = modal.bodyEl.querySelectorAll('.memory-card');
      expect(cards).toHaveLength(1);
      expect(mockMemories.search).toHaveBeenCalledWith('dark', { searchType: 'hybrid' });
      jest.useRealTimers();
    });

    test('ignores stale search results if query has changed (Tautology check)', async () => {
      jest.useFakeTimers();
      const { modal } = createModal();
      modal.isOpen = true;
      modal.memories = [
        makeMemory({ content: 'dark mode preference' }),
        makeMemory({ id: '2', content: 'API key stored' }),
      ];
      modal._renderUI();

      let resolveFirstSearch;
      mockMemories.search = jest.fn()
        .mockImplementationOnce(() => new Promise(r => { resolveFirstSearch = r; }))
        .mockImplementationOnce(() => Promise.resolve({
          results: [makeMemory({ id: '2', content: 'API key stored' })]
        }));

      // Fire first search
      Controller.handleSearch(modal, 'dark');
      jest.advanceTimersByTime(310); // debounce fires, first search starts

      // Fire second search before first resolves
      Controller.handleSearch(modal, 'API');
      jest.advanceTimersByTime(310); // debounce fires, second search starts and resolves
      await Promise.resolve();
      await Promise.resolve();
      
      // Now resolve the first search with its results
      resolveFirstSearch({ results: [makeMemory({ content: 'dark mode preference' })] });
      await Promise.resolve();
      await Promise.resolve();

      // Ensure modal is rendering the SECOND query's results ('API'), not the FIRST ('dark')
      expect(modal.searchQuery).toBe('api');
      const cards = modal.bodyEl.querySelectorAll('.memory-card');
      expect(cards).toHaveLength(1);
      expect(cards[0].textContent).toContain('API key stored');
      jest.useRealTimers();
    });
  });

  // -----------------------------------------------------------------------
  // _renderTabContent()
  // -----------------------------------------------------------------------

  describe('_renderTabContent()', () => {
    test('shows empty state when no memories', () => {
      const { modal } = createModal();
      modal.memories = [];
      const container = document.createElement('div');
      Renderers.renderTabContent(modal, container);
      expect(container.innerHTML).toContain('No memories yet');
    });

    test('shows search hint when query active and no results', () => {
      const { modal } = createModal();
      modal.memories = [makeMemory({ content: 'hello' })];
      modal.searchQuery = 'nonexistent';
      const container = document.createElement('div');
      Renderers.renderTabContent(modal, container);
      expect(container.innerHTML).toContain('No matches found');
    });

    test('filters by scope: global', () => {
      const { modal } = createModal();
      modal.memories = [
        makeMemory({ id: '1', source_chat_id: null }),
        makeMemory({ id: '2', source_chat_id: 'chat-1' }),
      ];
      modal.activeTab = 'global';
      const container = document.createElement('div');
      Renderers.renderTabContent(modal, container);
      expect(container.querySelectorAll('.memory-card')).toHaveLength(1);
    });

    test('filters by scope: chat', () => {
      const { modal } = createModal();
      modal.memories = [
        makeMemory({ id: '1', source_chat_id: null }),
        makeMemory({ id: '2', source_chat_id: 'chat-1' }),
        makeMemory({ id: '3', source_chat_id: 'chat-2' }),
      ];
      modal.activeTab = 'chat';
      const container = document.createElement('div');
      Renderers.renderTabContent(modal, container);
      // Chat-specific tab groups by chat
      expect(container.querySelectorAll('.memory-chat-group')).toHaveLength(2);
    });

    test('filters by search query', async () => {
      const { modal } = createModal();
      modal.memories = [
        makeMemory({ id: '1', content: 'dark mode' }),
        makeMemory({ id: '2', content: 'light mode' }),
      ];
      modal.searchQuery = 'dark';
      
      // Mock search results
      modal._searchResults = [makeMemory({ id: '1', content: 'dark mode' })];
      
      const container = document.createElement('div');
      Renderers.renderTabContent(modal, container);
      expect(container.querySelectorAll('.memory-card')).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // _createMemoryCard()
  // -----------------------------------------------------------------------

  describe('_createMemoryCard()', () => {
    test('creates card with memory data', () => {
      const { modal } = createModal();
      const card = Renderers.createMemoryCard(modal, makeMemory({ content: 'Test memory' }));
      expect(card.dataset.id).toBe('mem-1');
      expect(card.textContent).toContain('Test memory');
    });

    test('shows type badge with correct tone', () => {
      const { modal } = createModal();
      const card = Renderers.createMemoryCard(modal, makeMemory({ memory_type: 'preference' }));
      const badge = card.querySelector('.memory-badge');
      expect(badge.dataset.tone).toBe('warning');
      expect(badge.textContent).toBe('preference');
    });

    test('shows importance score with tone-based coloring', () => {
      const { modal } = createModal();
      const high = Renderers.createMemoryCard(modal, makeMemory({ importance_score: 0.9 }));
      const highBadge = high.querySelector('.memory-badge-importance');
      expect(highBadge.dataset.tone).toBe('success');

      const medium = Renderers.createMemoryCard(modal, makeMemory({ importance_score: 0.5 }));
      const medBadge = medium.querySelector('.memory-badge-importance');
      expect(medBadge.dataset.tone).toBe('warning');

      const low = Renderers.createMemoryCard(modal, makeMemory({ importance_score: 0.2 }));
      const lowBadge = low.querySelector('.memory-badge-importance');
      expect(lowBadge.dataset.tone).toBe('error');
    });

    test('shows scope badge in "all" tab', () => {
      const { modal } = createModal();
      modal.activeTab = 'all';
      const card = Renderers.createMemoryCard(modal, makeMemory({ source_chat_id: 'chat-1' }));
      const scopeBadge = card.querySelector('.memory-badge-scope');
      expect(scopeBadge).not.toBeNull();
      expect(scopeBadge.textContent).toContain('Chat');
    });

    test('hides scope badge in non-"all" tabs', () => {
      const { modal } = createModal();
      modal.activeTab = 'global';
      const card = Renderers.createMemoryCard(modal, makeMemory());
      expect(card.querySelector('.memory-badge-scope')).toBeNull();
    });

    test('shows edit textarea when editing', () => {
      const { modal } = createModal();
      const mem = makeMemory({ id: 'edit-me' });
      modal.editingMemoryId = 'edit-me';
      const card = Renderers.createMemoryCard(modal, mem);
      expect(card.classList.contains('is-editing')).toBe(true);
      expect(card.querySelector('textarea')).not.toBeNull();
    });

    test('shows promote button for chat memories', () => {
      const { modal } = createModal();
      const card = Renderers.createMemoryCard(modal, makeMemory({ source_chat_id: 'chat-1' }));
      const promoteBtn = Array.from(card.querySelectorAll('.memory-btn')).find((b) =>
        b.textContent.includes('Promote'),
      );
      expect(promoteBtn).toBeDefined();
    });

    test('shows demote button for global memories', () => {
      const { modal } = createModal();
      const card = Renderers.createMemoryCard(modal, makeMemory({ source_chat_id: null }));
      const demoteBtn = Array.from(card.querySelectorAll('.memory-btn')).find((b) =>
        b.textContent.includes('Demote'),
      );
      expect(demoteBtn).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // _createButton()
  // -----------------------------------------------------------------------

  describe('_createButton()', () => {
    test('creates button with text and tone', () => {
      const btn = Renderers.createButton('Test', 'info', false);
      expect(btn.textContent).toBe('Test');
      expect(btn.dataset.tone).toBe('info');
      expect(btn.classList.contains('memory-btn')).toBe(true);
    });

    test('adds is-primary class when primary', () => {
      const btn = Renderers.createButton('Save', 'success', true);
      expect(btn.classList.contains('is-primary')).toBe(true);
    });

    test('includes icon HTML when provided', () => {
      const btn = Renderers.createButton('Action', 'info', false, '<svg></svg>');
      expect(btn.innerHTML).toContain('<svg>');
      expect(btn.textContent).toContain('Action');
    });
  });

  // -----------------------------------------------------------------------
  // _updateStats()
  // -----------------------------------------------------------------------

  describe('_updateStats()', () => {
    test('shows total/global/chat counts in all tab', () => {
      const { modal } = createModal();
      modal.memories = [
        makeMemory({ source_chat_id: null }),
        makeMemory({ id: '2', source_chat_id: 'c1' }),
        makeMemory({ id: '3', source_chat_id: null }),
      ];
      modal.statsEl = document.createElement('div');
      modal.activeTab = 'all';
      Renderers.updateStats(modal);
      expect(modal.statsEl.textContent).toContain('3 total');
      expect(modal.statsEl.textContent).toContain('2 global');
      expect(modal.statsEl.textContent).toContain('1 chat-specific');
    });

    test('shows filtered count in scoped tab', () => {
      const { modal } = createModal();
      modal.memories = [
        makeMemory({ source_chat_id: null }),
        makeMemory({ id: '2', source_chat_id: 'c1' }),
      ];
      modal.statsEl = document.createElement('div');
      modal.activeTab = 'global';
      Renderers.updateStats(modal);
      expect(modal.statsEl.textContent).toContain('Showing 1 of 2');
    });

    test('no-ops when statsEl is null', () => {
      const { modal } = createModal();
      modal.statsEl = null;
      expect(() => Renderers.updateStats(modal)).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // _renderContent()
  // -----------------------------------------------------------------------

  describe('_renderContent()', () => {
    test('fetches and renders memories', async () => {
      const { modal } = createModal();
      modal.isOpen = true; // explicitly set open
      mockMemories.list.mockResolvedValue([makeMemory()]);
      await modal._renderContent();
      
      // Wait for promise resolution
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockMemories.list).toHaveBeenCalledWith({ source_chat_id: 'all' });
      expect(modal.memories).toHaveLength(1);
      expect(modal.bodyEl.querySelector('.memory-search-input')).not.toBeNull();
    });

    test('shows error state on failure', async () => {
      const { modal } = createModal();
      modal.isOpen = true; // explicitly set open
      mockMemories.list.mockRejectedValue(new Error('API down'));
      await modal._renderContent();
      
      // Wait for promise resolution
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(modal.bodyEl.innerHTML).toContain('Failed to Load Memories');
      expect(modal.bodyEl.innerHTML).toContain('API down');
    });

    test('shows retry button on error', async () => {
      const { modal } = createModal();
      modal.isOpen = true; // explicitly set open
      mockMemories.list.mockRejectedValue(new Error('Fail'));
      await modal._renderContent();
      
      // Wait for promise resolution
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(modal.bodyEl.querySelector('[data-action="retry-memories"]')).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // _renderChatGroupedMemories()
  // -----------------------------------------------------------------------

  describe('_renderChatGroupedMemories()', () => {
    test('groups by chat_id and sorts by count', () => {
      const { modal } = createModal();
      const container = document.createElement('div');
      const memories = [
        makeMemory({ id: '1', source_chat_id: 'chat-a' }),
        makeMemory({ id: '2', source_chat_id: 'chat-b' }),
        makeMemory({ id: '3', source_chat_id: 'chat-b' }),
      ];
      Renderers.renderChatGroupedMemories(modal, container, memories);
      const groups = container.querySelectorAll('.memory-chat-group');
      expect(groups).toHaveLength(2);
      // First group should be chat-b (2 memories), then chat-a (1)
      const counts = container.querySelectorAll('.memory-chat-count');
      expect(counts[0].textContent).toContain('2 memories');
      expect(counts[1].textContent).toContain('1 memory');
    });
  });

  // -----------------------------------------------------------------------
  // _handleDeleteMemory()
  // -----------------------------------------------------------------------

  describe('_handleDeleteMemory()', () => {
    test('confirms and deletes memory', async () => {
      const { modal } = createModal();
      mockConfirmDialog.confirm.mockResolvedValue(true);
      mockMemories.list.mockResolvedValue([]);

      await Controller.handleDeleteMemory(modal, makeMemory());

      expect(mockConfirmDialog.confirm).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'danger' }),
      );
      expect(mockMemories.delete).toHaveBeenCalledWith('mem-1');
      expect(mockToast.success).toHaveBeenCalled();
    });

    test('aborts when user cancels', async () => {
      const { modal } = createModal();
      mockConfirmDialog.confirm.mockResolvedValue(false);
      mockMemories.delete.mockClear();

      await Controller.handleDeleteMemory(modal, makeMemory());

      expect(mockMemories.delete).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // _handleSaveMemory()
  // -----------------------------------------------------------------------

  describe('_handleSaveMemory()', () => {
    test('shows error when card not found', async () => {
      const { modal } = createModal();
      mockToast.error.mockClear();

      // Controller no longer looks for the card in DOM, it just attempts to update via API.
      // We simulate an API failure when ID doesn't exist instead to maintain test intent.
      mockMemories.update.mockRejectedValueOnce(new Error('Memory not found'));

      await Controller.handleSaveMemory(modal, 'nonexistent', 'content');

      expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('Memory not found'));
    });

    test('shows warning for empty content', async () => {
      // In the new architecture, the Renderer prevents empty content from reaching the Controller.
      // So this test tests the renderer's integration or the controller directly handling an empty string?
      // Wait, the Renderer prevents it AND the Controller also has a safeguard?
      // I will test the Controller's safeguard directly.
      const { modal } = createModal();
      mockToast.warning.mockClear();
      
      await Controller.handleSaveMemory(modal, 'mem-1', '   ');
      
      expect(mockToast.warning).toHaveBeenCalledWith('Memory content cannot be empty.');
    });
  });

  // -----------------------------------------------------------------------
  // _handleAddMemory() / _renderCreateForm()
  // -----------------------------------------------------------------------

  describe('_handleAddMemory()', () => {
    test('sets isCreatingMemory and renders form', () => {
      const { modal } = createModal();
      modal.memories = [];
      modal._renderUI();

      modal.isCreatingMemory = true;
      Renderers.renderCreateForm(modal);

      expect(modal.isCreatingMemory).toBe(true);
      expect(modal.bodyEl.querySelector('.memory-create-form')).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  describe('_trackListener / _clearListeners / _trackTimer', () => {
    test('tracks and clears listeners', () => {
      const { modal } = createModal();
      const el = document.createElement('div');
      modal._trackListener(el, 'click', jest.fn());
      expect(modal._listeners).toHaveLength(1);
      modal._clearListeners();
      expect(modal._listeners).toHaveLength(0);
    });

    test('ignores null element', () => {
      const { modal } = createModal();
      modal._trackListener(null, 'click', jest.fn());
      expect(modal._listeners).toHaveLength(0);
    });

    test('tracks timer', () => {
      jest.useFakeTimers();
      const { modal } = createModal();
      const fn = jest.fn();
      modal._trackTimer(fn, 100);
      expect(modal._timers).toHaveLength(1);
      jest.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalled();
      jest.useRealTimers();
    });
  });

  // -----------------------------------------------------------------------
  // _handleSaveMemory() — success & error paths
  // -----------------------------------------------------------------------

  describe('_handleSaveMemory() — extended', () => {
    test('saves memory when content is valid', async () => {
      const { modal } = createModal();
      modal.editingMemoryId = 'mem-1';
      modal.memories = [makeMemory()];
      modal._renderUI();

      mockMemories.update.mockClear();
      mockMemories.list.mockResolvedValue([makeMemory({ content: 'Updated content' })]);

      await Controller.handleSaveMemory(modal, 'mem-1', 'Updated content');

      expect(mockMemories.update).toHaveBeenCalledWith('mem-1', { content: 'Updated content' });
      expect(mockToast.success).toHaveBeenCalledWith('Memory updated successfully.');
      expect(modal.editingMemoryId).toBeNull();
    });

    test('shows error when API fails', async () => {
      const { modal } = createModal();
      modal.editingMemoryId = 'mem-1';
      modal.memories = [makeMemory()];
      modal._renderUI();

      mockMemories.update.mockRejectedValueOnce(new Error('Server error'));
      mockToast.error.mockClear();

      await Controller.handleSaveMemory(modal, 'mem-1', 'Valid content');

      expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('Server error'));
    });
  });

  // -----------------------------------------------------------------------
  // _handlePromoteMemory()
  // -----------------------------------------------------------------------

  describe('_handlePromoteMemory()', () => {
    test('promotes memory when confirmed', async () => {
      const { modal } = createModal();
      mockConfirmDialog.confirm.mockResolvedValue(true);
      mockMemories.promote.mockClear();
      mockMemories.list.mockResolvedValue([makeMemory()]);

      await Controller.handlePromoteMemory(modal, makeMemory({ source_chat_id: 'chat-1' }));

      expect(mockConfirmDialog.confirm).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Promote memory',
        confirmText: 'Promote',
      }));
      expect(mockMemories.promote).toHaveBeenCalledWith('mem-1');
      expect(mockMemories.list).toHaveBeenCalledWith({ source_chat_id: 'all' });
    });

    test('aborts when user cancels', async () => {
      const { modal } = createModal();
      mockConfirmDialog.confirm.mockResolvedValue(false);
      mockMemories.promote.mockClear();

      await Controller.handlePromoteMemory(modal, makeMemory({ source_chat_id: 'chat-1' }));

      expect(mockMemories.promote).not.toHaveBeenCalled();
    });

    test('shows error toast on API failure', async () => {
      const { modal } = createModal();
      mockConfirmDialog.confirm.mockResolvedValue(true);
      mockMemories.promote.mockRejectedValueOnce(new Error('Promote failed'));
      mockToast.error.mockClear();

      await Controller.handlePromoteMemory(modal, makeMemory({ source_chat_id: 'chat-1' }));

      expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('Promote failed'));
    });
  });

  // -----------------------------------------------------------------------
  // _handleDemoteMemory()
  // -----------------------------------------------------------------------

  describe('_handleDemoteMemory()', () => {
    test('demotes memory with provided chat ID', async () => {
      const { modal } = createModal();
      mockConfirmDialog.prompt.mockResolvedValue('chat-99');
      mockMemories.demote.mockClear();
      mockMemories.list.mockResolvedValue([makeMemory()]);

      await Controller.handleDemoteMemory(modal, makeMemory());

      expect(mockConfirmDialog.prompt).toHaveBeenCalledWith(expect.objectContaining({
        confirmText: 'Assign',
      }));
      expect(mockMemories.demote).toHaveBeenCalledWith('mem-1', 'chat-99');
      expect(mockMemories.list).toHaveBeenCalledWith({ source_chat_id: 'all' });
    });

    test('aborts when user cancels', async () => {
      const { modal } = createModal();
      mockConfirmDialog.prompt.mockResolvedValue(null);
      mockMemories.demote.mockClear();

      await Controller.handleDemoteMemory(modal, makeMemory());

      expect(mockMemories.demote).not.toHaveBeenCalled();
    });

    test('shows error toast on API failure', async () => {
      const { modal } = createModal();
      mockConfirmDialog.prompt.mockResolvedValue('chat-99');
      mockMemories.demote.mockRejectedValueOnce(new Error('Demote failed'));
      mockToast.error.mockClear();

      await Controller.handleDemoteMemory(modal, makeMemory());

      expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('Demote failed'));
    });
  });

  // -----------------------------------------------------------------------
  // _handleDeleteMemory() — error path
  // -----------------------------------------------------------------------

  describe('_handleDeleteMemory() — error path', () => {
    test('shows error toast when delete API fails', async () => {
      const { modal } = createModal();
      mockConfirmDialog.confirm.mockResolvedValue(true);
      mockMemories.delete.mockRejectedValueOnce(new Error('Delete failed'));
      mockToast.error.mockClear();

      await Controller.handleDeleteMemory(modal, makeMemory());

      expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('Delete failed'));
    });
  });

  // -----------------------------------------------------------------------
  // _renderCreateForm() — button handlers
  // -----------------------------------------------------------------------

  describe('_renderCreateForm() — interactions', () => {
    let modal;

    beforeEach(() => {
      ({ modal } = createModal());
      modal.memories = [];
      modal._renderUI();
      modal.isCreatingMemory = true;
      Renderers.renderCreateForm(modal);
    });

    test('cancel button resets isCreatingMemory and re-renders', () => {
      const cancelBtn = Array.from(modal.bodyEl.querySelectorAll('.memory-btn')).find(b =>
        b.textContent.includes('Cancel')
      );
      expect(cancelBtn).toBeDefined();

      cancelBtn.click();

      expect(modal.isCreatingMemory).toBe(false);
    });

    test('create button with empty content shows warning', async () => {
      const textarea = modal.bodyEl.querySelector('.memory-form-textarea');
      if (textarea) textarea.value = '';

      const createBtn = Array.from(modal.bodyEl.querySelectorAll('.memory-btn')).find(b =>
        b.textContent.includes('Create Memory')
      );
      mockToast.warning.mockClear();

      createBtn.click();
      await new Promise(r => setTimeout(r, 0));

      expect(mockToast.warning).toHaveBeenCalledWith('Memory content cannot be empty.');
    });

    test('create button with valid content calls create API', async () => {
      const textarea = modal.bodyEl.querySelector('.memory-form-textarea');
      if (textarea) textarea.value = 'New memory content';

      const createBtn = Array.from(modal.bodyEl.querySelectorAll('.memory-btn')).find(b =>
        b.textContent.includes('Create Memory')
      );
      mockMemories.create.mockClear();
      mockMemories.list.mockResolvedValue([makeMemory({ content: 'New memory content' })]);

      createBtn.click();
      await new Promise(r => setTimeout(r, 0));
      await Promise.resolve();

      expect(mockMemories.create).toHaveBeenCalledWith({
        content: 'New memory content',
        memory_type: 'fact',
        source_chat_id: null,
      });
      expect(mockToast.success).toHaveBeenCalledWith('Memory created successfully.');
      expect(modal.isCreatingMemory).toBe(false);
    });

    test('create button shows error on API failure', async () => {
      const textarea = modal.bodyEl.querySelector('.memory-form-textarea');
      if (textarea) textarea.value = 'Some content';

      const createBtn = Array.from(modal.bodyEl.querySelectorAll('.memory-btn')).find(b =>
        b.textContent.includes('Create Memory')
      );
      mockMemories.create.mockRejectedValueOnce(new Error('Create failed'));
      mockToast.error.mockClear();

      createBtn.click();
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      await Promise.resolve();

      expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('Create failed'));
    });
  });

  // -----------------------------------------------------------------------
  // Card action button handlers (edit, delete clicks on rendered cards)
  // -----------------------------------------------------------------------

  describe('card action button handlers', () => {
    test('edit button sets editingMemoryId and re-renders', () => {
      const { modal } = createModal();
      modal.memories = [makeMemory()];
      modal._renderUI();

      const editBtn = Array.from(modal.bodyEl.querySelectorAll('.memory-btn')).find(b =>
        b.textContent.includes('Edit')
      );
      expect(editBtn).toBeDefined();

      editBtn.click();

      expect(modal.editingMemoryId).toBe('mem-1');
      expect(modal.bodyEl.querySelector('.memory-card.is-editing')).not.toBeNull();
    });

    test('delete button calls handleDeleteMemory', async () => {
      const { modal } = createModal();
      modal.memories = [makeMemory()];
      modal._renderUI();

      mockConfirmDialog.confirm.mockResolvedValue(true);
      mockMemories.delete.mockClear();
      mockMemories.list.mockResolvedValue([]);

      const deleteBtn = Array.from(modal.bodyEl.querySelectorAll('.memory-btn')).find(b =>
        b.textContent.includes('Delete')
      );
      expect(deleteBtn).toBeDefined();

      deleteBtn.click();
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      expect(mockMemories.delete).toHaveBeenCalledWith('mem-1');
    });
  });

  describe('_cleanup()', () => {
    test('resets all state', () => {
      const { modal } = createModal();
      modal.memories = [makeMemory()];
      modal.searchQuery = 'test';
      modal.editingMemoryId = 'mem-1';
      modal.isCreatingMemory = true;
      modal.searchInput = document.createElement('input');
      modal.statsEl = document.createElement('div');
      modal._listeners = [{ element: document.createElement('div'), event: 'click', handler: jest.fn() }];
      modal._timers = [42];
      modal._searchResults = [{ id: '1' }];

      modal._cleanup();

      expect(modal.memories).toEqual([]);
      expect(modal.searchQuery).toBe('');
      expect(modal.editingMemoryId).toBeNull();
      expect(modal.isCreatingMemory).toBe(false);
      expect(modal.searchInput).toBeNull();
      expect(modal.statsEl).toBeNull();
      expect(modal._listeners).toEqual([]);
      expect(modal._timers).toEqual([]);
      expect(modal._searchResults).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // _escapeHtml()
  // -----------------------------------------------------------------------

  describe('_escapeHtml()', () => {
    test('escapes HTML entities', () => {
      expect(Utils.escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    });
  });
});
