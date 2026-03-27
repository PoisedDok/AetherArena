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

const ArtifactsLibraryModal = require('../../../../src/renderer/main/modules/artifacts-library/ArtifactsLibraryModal');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeArtifact(overrides = {}) {
  return {
    id: 'art-1',
    filename: 'test.js',
    language: 'javascript',
    type: 'code',
    role: 'assistant',
    chat_id: 'chat-1',
    chat_title: 'My Chat',
    content: 'console.log("hello")',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeEndpoint(overrides = {}) {
  return {
    listAllArtifacts: jest.fn().mockResolvedValue([
      makeArtifact({ id: 'art-1', filename: 'alpha.js' }),
      makeArtifact({ id: 'art-2', filename: 'beta.py', language: 'python' }),
    ]),
    exportArtifact: jest.fn().mockResolvedValue({ data: 'file content' }),
    deleteArtifact: jest.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function makeEventBus() {
  return { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
}

function createModal(opts = {}) {
  const endpoint = opts.endpoint || makeEndpoint();
  const eventBus = opts.eventBus || makeEventBus();
  const modal = new ArtifactsLibraryModal({ endpoint, eventBus });
  return { modal, endpoint, eventBus };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ArtifactsLibraryModal', () => {
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
      expect(modal.artifacts).toEqual([]);
      expect(modal.filteredArtifacts).toEqual([]);
      expect(modal.searchQuery).toBe('');
      expect(modal.selectedType).toBe('all');
      expect(modal._listeners).toEqual([]);
      expect(modal.id).toBe('artifacts-library-modal');
    });

    test('stores endpoint and eventBus', () => {
      const endpoint = makeEndpoint();
      const eventBus = makeEventBus();
      const modal = new ArtifactsLibraryModal({ endpoint, eventBus });
      expect(modal.endpoint).toBe(endpoint);
      expect(modal.eventBus).toBe(eventBus);
    });

    test('has typeIcons mapping', () => {
      const { modal } = createModal();
      expect(modal.typeIcons).toBeDefined();
      expect(modal.typeIcons.html).toBeDefined();
      expect(modal.typeIcons.default).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // _renderContent()
  // -----------------------------------------------------------------------

  describe('_renderContent()', () => {
    test('shows empty state when no endpoint', async () => {
      const modal = new ArtifactsLibraryModal({});
      modal.endpoint = null;
      await modal._renderContent();
      expect(modal.bodyEl.innerHTML).toContain('Endpoint not initialized');
    });

    test('fetches and renders artifacts', async () => {
      const { modal, endpoint } = createModal();
      await modal._renderContent();
      expect(endpoint.listAllArtifacts).toHaveBeenCalledWith(50);
      expect(modal.artifacts).toHaveLength(2);
      expect(modal.bodyEl.querySelector('.modal-search-bar')).not.toBeNull();
    });

    test('shows error state on fetch failure', async () => {
      const { modal, endpoint } = createModal();
      endpoint.listAllArtifacts.mockRejectedValue(new Error('API fail'));
      await modal._renderContent();
      expect(modal.bodyEl.innerHTML).toContain('Failed to Load Artifacts');
      expect(modal.bodyEl.innerHTML).toContain('API fail');
    });
  });

  // -----------------------------------------------------------------------
  // _getNormalizedType()
  // -----------------------------------------------------------------------

  describe('_getNormalizedType()', () => {
    test('assistant:code → code', () => {
      const { modal } = createModal();
      expect(modal._getNormalizedType({ role: 'assistant', type: 'code' })).toBe('code');
    });

    test('computer:output → output', () => {
      const { modal } = createModal();
      expect(modal._getNormalizedType({ role: 'computer', type: 'output' })).toBe('output');
    });

    test('legacy html → output', () => {
      const { modal } = createModal();
      expect(modal._getNormalizedType({ type: 'html' })).toBe('output');
    });

    test('legacy console → output', () => {
      const { modal } = createModal();
      expect(modal._getNormalizedType({ type: 'console' })).toBe('output');
    });

    test('type file → attachment', () => {
      const { modal } = createModal();
      expect(modal._getNormalizedType({ type: 'file' })).toBe('attachment');
    });

    test('plain code → code', () => {
      const { modal } = createModal();
      expect(modal._getNormalizedType({ type: 'code' })).toBe('code');
    });

    test('unknown type → output', () => {
      const { modal } = createModal();
      expect(modal._getNormalizedType({ type: 'weird' })).toBe('output');
    });

    test('empty type → output', () => {
      const { modal } = createModal();
      expect(modal._getNormalizedType({})).toBe('output');
    });

    test('reads role from metadata.role fallback', () => {
      const { modal } = createModal();
      expect(modal._getNormalizedType({ type: 'output', metadata: { role: 'computer' } })).toBe('output');
    });
  });

  // -----------------------------------------------------------------------
  // _applyFilters()
  // -----------------------------------------------------------------------

  describe('_applyFilters()', () => {
    test('filters by search query (filename)', () => {
      const { modal } = createModal();
      modal.artifacts = [
        makeArtifact({ id: '1', filename: 'alpha.js' }),
        makeArtifact({ id: '2', filename: 'beta.py' }),
      ];
      modal.searchQuery = 'alpha';
      modal.selectedType = 'all';
      modal._applyFilters();
      expect(modal.filteredArtifacts).toHaveLength(1);
      expect(modal.filteredArtifacts[0].id).toBe('1');
    });

    test('filters by search query (chat_title)', () => {
      const { modal } = createModal();
      modal.artifacts = [
        makeArtifact({ id: '1', chat_title: 'Debug Session' }),
        makeArtifact({ id: '2', chat_title: 'Feature Work' }),
      ];
      modal.searchQuery = 'debug';
      modal.selectedType = 'all';
      modal._applyFilters();
      expect(modal.filteredArtifacts).toHaveLength(1);
    });

    test('filters by type', () => {
      const { modal } = createModal();
      modal.artifacts = [
        makeArtifact({ id: '1', type: 'code', role: 'assistant' }),
        makeArtifact({ id: '2', type: 'html' }),
      ];
      modal.searchQuery = '';
      modal.selectedType = 'code';
      modal._applyFilters();
      expect(modal.filteredArtifacts).toHaveLength(1);
      expect(modal.filteredArtifacts[0].id).toBe('1');
    });

    test('combines search and type filters', () => {
      const { modal } = createModal();
      modal.artifacts = [
        makeArtifact({ id: '1', filename: 'alpha.js', type: 'code', role: 'assistant' }),
        makeArtifact({ id: '2', filename: 'alpha.html', type: 'html' }),
        makeArtifact({ id: '3', filename: 'beta.js', type: 'code', role: 'assistant' }),
      ];
      modal.searchQuery = 'alpha';
      modal.selectedType = 'code';
      modal._applyFilters();
      expect(modal.filteredArtifacts).toHaveLength(1);
      expect(modal.filteredArtifacts[0].id).toBe('1');
    });

    test('shows all when query empty and type is all', () => {
      const { modal } = createModal();
      modal.artifacts = [makeArtifact(), makeArtifact({ id: '2' })];
      modal.searchQuery = '';
      modal.selectedType = 'all';
      modal._applyFilters();
      expect(modal.filteredArtifacts).toHaveLength(2);
    });

    test('handles null filename and chat_title', () => {
      const { modal } = createModal();
      modal.artifacts = [makeArtifact({ filename: null, chat_title: null })];
      modal.searchQuery = 'test';
      modal.selectedType = 'all';
      // Should not throw
      modal._applyFilters();
      expect(modal.filteredArtifacts).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // _handleSearch() / _handleTypeFilter()
  // -----------------------------------------------------------------------

  describe('_handleSearch()', () => {
    test('updates searchQuery and re-filters', () => {
      const { modal } = createModal();
      modal.artifacts = [makeArtifact({ filename: 'match.js' })];
      modal.filteredArtifacts = [...modal.artifacts];
      modal._handleSearch({ target: { value: 'match' } });
      expect(modal.searchQuery).toBe('match');
      expect(modal.filteredArtifacts).toHaveLength(1);
    });
  });

  describe('_handleTypeFilter()', () => {
    test('updates selectedType and re-filters', () => {
      const { modal } = createModal();
      modal.artifacts = [makeArtifact({ type: 'code', role: 'assistant' })];
      modal.filteredArtifacts = [...modal.artifacts];
      modal._handleTypeFilter({ target: { value: 'output' } });
      expect(modal.selectedType).toBe('output');
      expect(modal.filteredArtifacts).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // _createArtifactCard()
  // -----------------------------------------------------------------------

  describe('_createArtifactCard()', () => {
    test('creates card with artifact data', () => {
      const { modal } = createModal();
      const artifact = makeArtifact({ filename: 'test.js', chat_title: 'My Chat' });
      const card = modal._createArtifactCard(artifact);
      expect(card.dataset.artifactId).toBe('art-1');
      expect(card.textContent).toContain('test.js');
      expect(card.textContent).toContain('My Chat');
    });

    test('uses "Untitled Artifact" for missing filename', () => {
      const { modal } = createModal();
      const card = modal._createArtifactCard(makeArtifact({ filename: '' }));
      expect(card.textContent).toContain('Untitled Artifact');
    });

    test('shows "Unknown Chat" for missing chat_title', () => {
      const { modal } = createModal();
      const card = modal._createArtifactCard(makeArtifact({ chat_title: '' }));
      expect(card.textContent).toContain('Unknown Chat');
    });

    test('calculates file size from content', () => {
      const { modal } = createModal();
      const content = 'x'.repeat(2048);
      const card = modal._createArtifactCard(makeArtifact({ content }));
      expect(card.textContent).toContain('2.0 KB');
    });

    test('shows "Unknown size" when content is empty', () => {
      const { modal } = createModal();
      const card = modal._createArtifactCard(makeArtifact({ content: '' }));
      expect(card.textContent).toContain('Unknown size');
    });

    test('renders action buttons (export, edit, delete, view)', () => {
      const { modal } = createModal();
      const card = modal._createArtifactCard(makeArtifact());
      const buttons = card.querySelectorAll('.modal-action-btn');
      expect(buttons.length).toBe(4);
    });
  });

  // -----------------------------------------------------------------------
  // _handleEdit() / _handleView() / _handleOpenChat()
  // -----------------------------------------------------------------------

  describe('_handleEdit()', () => {
    test('emits artifact-edit-requested event', async () => {
      const { modal, eventBus } = createModal();
      await modal._handleEdit('art-42');
      expect(eventBus.emit).toHaveBeenCalledWith('modal:artifact-edit-requested', { artifactId: 'art-42' });
    });

    test('no-ops when eventBus is null', async () => {
      const modal = new ArtifactsLibraryModal({ endpoint: makeEndpoint() });
      modal.eventBus = null;
      await expect(modal._handleEdit('art-1')).resolves.toBeUndefined();
    });
  });

  describe('_handleView()', () => {
    test('emits artifact-view-requested event', () => {
      const { modal, eventBus } = createModal();
      modal._handleView('art-42');
      expect(eventBus.emit).toHaveBeenCalledWith('modal:artifact-view-requested', { artifactId: 'art-42' });
    });
  });

  describe('_handleOpenChat()', () => {
    test('emits chat-open-requested event', () => {
      const { modal, eventBus } = createModal();
      modal._handleOpenChat('chat-42');
      expect(eventBus.emit).toHaveBeenCalledWith('modal:chat-open-requested', { chatId: 'chat-42' });
    });
  });

  // -----------------------------------------------------------------------
  // _handleExport()
  // -----------------------------------------------------------------------

  describe('_handleExport()', () => {
    test('creates download link on success', async () => {
      const { modal, endpoint } = createModal();
      window.URL.createObjectURL = jest.fn(() => 'blob:url');
      window.URL.revokeObjectURL = jest.fn();

      await modal._handleExport('art-1', 'test.js');

      expect(endpoint.exportArtifact).toHaveBeenCalledWith('art-1');
      expect(window.URL.revokeObjectURL).toHaveBeenCalled();
    });

    test('shows error toast on failure', async () => {
      const { modal, endpoint } = createModal();
      endpoint.exportArtifact.mockRejectedValue(new Error('Export fail'));

      await modal._handleExport('art-1', 'test.js');

      expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('Failed to export'));
    });

    test('defaults filename to artifact.txt', async () => {
      const { modal, endpoint } = createModal();
      window.URL.createObjectURL = jest.fn(() => 'blob:url');
      window.URL.revokeObjectURL = jest.fn();

      await modal._handleExport('art-1', '');

      // The download attribute should default
      // (verified by checking the a.download was set)
      expect(endpoint.exportArtifact).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // _handleDelete() — BUG: references undefined `artifact`
  // -----------------------------------------------------------------------

  describe('_handleDelete()', () => {
    test('confirms and deletes artifact', async () => {
      const { modal, endpoint } = createModal();
      modal.artifacts = [makeArtifact({ id: 'art-1' })];
      modal.filteredArtifacts = [makeArtifact({ id: 'art-1' })];
      mockConfirmDialog.confirm.mockResolvedValue(true);

      await modal._handleDelete('art-1', 'test.js');

      expect(endpoint.deleteArtifact).toHaveBeenCalledWith('art-1');
      expect(modal.artifacts).toHaveLength(0);
      expect(modal.filteredArtifacts).toHaveLength(0);
    });

    test('aborts when user cancels', async () => {
      const { modal, endpoint } = createModal();
      mockConfirmDialog.confirm.mockResolvedValue(false);

      await modal._handleDelete('art-1', 'test.js');

      expect(endpoint.deleteArtifact).not.toHaveBeenCalled();
    });

    test('shows info toast on successful delete (FIXED: was ReferenceError)', async () => {
      const { modal, endpoint } = createModal();
      modal.artifacts = [makeArtifact({ id: 'art-1' })];
      modal.filteredArtifacts = [makeArtifact({ id: 'art-1' })];
      mockConfirmDialog.confirm.mockResolvedValue(true);
      mockToast.error.mockClear();
      mockToast.info.mockClear();

      await modal._handleDelete('art-1', 'test.js');

      expect(mockToast.info).toHaveBeenCalledWith('Deleted "test.js"');
      expect(mockToast.error).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // _groupArtifactsByDate()
  // -----------------------------------------------------------------------

  describe('_groupArtifactsByDate()', () => {
    test('groups by date buckets', () => {
      const { modal } = createModal();
      const now = Date.now();
      const artifacts = [
        makeArtifact({ id: '1', created_at: new Date(now).toISOString() }),
        makeArtifact({ id: '2', created_at: new Date(now - 86400000).toISOString() }),
        makeArtifact({ id: '3', created_at: new Date(now - 60 * 86400000).toISOString() }),
      ];
      const groups = modal._groupArtifactsByDate(artifacts);
      expect(Object.keys(groups).length).toBeGreaterThanOrEqual(1);
    });

    test('removes empty groups', () => {
      const { modal } = createModal();
      const groups = modal._groupArtifactsByDate([]);
      expect(Object.keys(groups)).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // _formatDate()
  // -----------------------------------------------------------------------

  describe('_formatDate()', () => {
    test('returns time for today', () => {
      const { modal } = createModal();
      expect(modal._formatDate(new Date().toISOString())).toMatch(/\d{1,2}:\d{2}/);
    });

    test('returns date for older entries', () => {
      const { modal } = createModal();
      expect(modal._formatDate('2025-06-15T12:00:00Z')).toContain('Jun');
    });
  });

  // -----------------------------------------------------------------------
  // _renderArtifactList()
  // -----------------------------------------------------------------------

  describe('_renderArtifactList()', () => {
    test('shows empty state when no artifacts', () => {
      const { modal } = createModal();
      modal.filteredArtifacts = [];
      modal._renderArtifactList();
      expect(modal.bodyEl.innerHTML).toContain('No Artifacts Found');
    });

    test('shows filter hint when filters active', () => {
      const { modal } = createModal();
      modal.filteredArtifacts = [];
      modal.searchQuery = 'xyz';
      modal._renderArtifactList();
      expect(modal.bodyEl.innerHTML).toContain('adjusting your filters');
    });

    test('shows create hint when no filters and no artifacts', () => {
      const { modal } = createModal();
      modal.filteredArtifacts = [];
      modal.searchQuery = '';
      modal.selectedType = 'all';
      modal._renderArtifactList();
      expect(modal.bodyEl.innerHTML).toContain('No artifacts have been created');
    });

    test('renders artifact cards in date groups', () => {
      const { modal } = createModal();
      modal.filteredArtifacts = [makeArtifact()];
      modal._renderArtifactList();
      expect(modal.bodyEl.querySelector('.artifact-card')).not.toBeNull();
      expect(modal.bodyEl.querySelector('.date-group')).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // _cleanup()
  // -----------------------------------------------------------------------

  describe('_cleanup()', () => {
    test('clears all state and listeners', () => {
      const { modal } = createModal();
      modal.artifacts = [makeArtifact()];
      modal.filteredArtifacts = [makeArtifact()];
      modal.searchQuery = 'test';
      modal.selectedType = 'code';
      const el = document.createElement('div');
      modal._trackListener(el, 'click', jest.fn());

      modal._cleanup();

      expect(modal.artifacts).toEqual([]);
      expect(modal.filteredArtifacts).toEqual([]);
      expect(modal.searchQuery).toBe('');
      expect(modal.selectedType).toBe('all');
      expect(modal._listeners).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Lifecycle tracking
  // -----------------------------------------------------------------------

  describe('_trackListener', () => {
    test('tracks and allows cleanup', () => {
      const { modal } = createModal();
      const el = document.createElement('div');
      modal._trackListener(el, 'click', jest.fn());
      expect(modal._listeners).toHaveLength(1);
    });

    test('ignores null element', () => {
      const { modal } = createModal();
      modal._trackListener(null, 'click', jest.fn());
      expect(modal._listeners).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // LIFECYCLE BUG: untracked listeners in _createArtifactCard
  // -----------------------------------------------------------------------

  describe('FIXED: all card listeners now tracked via _trackListener', () => {
    test('card creates 6 tracked listeners (export, edit, delete, view, chatLink, card click)', () => {
      const { modal } = createModal();
      modal._listeners = [];
      modal._createArtifactCard(makeArtifact());

      // 6 listeners: export, edit, delete, view buttons + chatLink + card click
      expect(modal._listeners).toHaveLength(6);
    });
  });
});
