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

const mockToast = { success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn() };
jest.mock('../../../../src/renderer/shared/components/Toast', () => mockToast);

const IndexBrowserModal = require('../../../../src/renderer/main/modules/indexes/IndexBrowserModal');
const IndexBrowserUtils = require('../../../../src/renderer/main/modules/indexes/internal/IndexBrowserUtils');

// ---------------------------------------------------------------------------
// Constants (mirror source — not exported)
// ---------------------------------------------------------------------------

const RESULTS_PER_PAGE = 20;
const SEARCH_HISTORY_KEY = 'aether-search-history';
const SEARCH_HISTORY_MAX = 10;
const UI_TEXT = {
  GROUPS: {
    AGENT_OUTPUT: 'Assistant History',
    FILE_LOCATION: 'Your Documents',
    SOURCE: 'Knowledge Base',
    SYSTEM: 'System',
    OTHER: 'Other',
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIndex(overrides = {}) {
  return {
    index_name: 'test_index',
    index_type: 'agent_output',
    chunk_count: 42,
    size: '1.2 MB',
    updated_at: '2026-01-15',
    metadata: {},
    supported_modes: ['semantic', 'bm25', 'hybrid'],
    is_searchable: true,
    ...overrides,
  };
}

function makeResult(overrides = {}) {
  return {
    text: 'Sample result text',
    score: 0.85,
    index_name: 'test_index',
    index_type: 'agent_output',
    metadata: {},
    ...overrides,
  };
}

function makeEndpoint(overrides = {}) {
  return {
    listIndexes: jest.fn().mockResolvedValue({
      indexes: [
        makeIndex({ index_name: 'research_output' }),
        makeIndex({ index_name: 'user_files', index_type: 'file_location', chunk_count: 100 }),
      ],
    }),
    getSettings: jest.fn().mockResolvedValue({
      agents: { context_retrieval: { default_top_k: 10, min_score: 0.5 } },
    }),
    searchIndexes: jest.fn().mockResolvedValue({
      results: [
        makeResult({ text: 'Multi result 1', score: 0.88, index_name: 'research_output' }),
        makeResult({ text: 'Multi result 2', score: 0.75, index_name: 'user_files' }),
      ],
      search_duration_ms: 42,
      indexes_searched: ['research_output', 'user_files'],
    }),
    ...overrides,
  };
}

function createModal(opts = {}) {
  const endpoint = opts.endpoint || makeEndpoint();
  const modal = new IndexBrowserModal({ endpoint });
  return { modal, endpoint };
}

/**
 * Create a modal in "ready to search" state.
 * isOpen = true, indexes loaded, selectedSources populated,
 * bodyEl has minimal .se container for _refreshUI.
 */
function readyModal(opts = {}) {
  const { modal, endpoint } = createModal(opts);
  modal.isOpen = true;
  modal.indexingService.indexes = [
    makeIndex({ index_name: 'research_output' }),
    makeIndex({ index_name: 'user_files', index_type: 'file_location' }),
  ];
  modal.indexingService.selectedSources = new Set(['research_output', 'user_files']);
  modal.bodyEl.innerHTML = '<div class="se" data-state="idle"></div>';
  return { modal, endpoint };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IndexBrowserModal', () => {
  afterEach(() => {
    document.querySelectorAll('.modal-overlay').forEach((el) => el.remove());
    localStorage.clear();
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // 1. Constructor
  // -----------------------------------------------------------------------

  describe('constructor', () => {
    test('sets all state properties to initial values', () => {
      const { modal } = createModal();

      expect(modal.sourcesExpanded).toBe(false);
      expect(modal.expandedResults).toBeInstanceOf(Set);
      expect(modal.expandedResults.size).toBe(0);
      expect(modal._visibleCount).toBe(RESULTS_PER_PAGE);
      expect(modal.previewResult).toBeNull();
      
      expect(modal.searchService).toBeDefined();
      expect(modal.indexingService).toBeDefined();
    });

    test('uses provided endpoint', () => {
      const endpoint = makeEndpoint();
      const modal = new IndexBrowserModal({ endpoint });
      expect(modal.endpoint).toBe(endpoint);
    });

    test('passes modal options to BaseModal', () => {
      const modal = new IndexBrowserModal({ id: 'custom-id', size: 'lg' });
      expect(modal.id).toBe('custom-id');
      expect(modal.size).toBe('lg');
      expect(modal.showFooter).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 2. Data fetching
  // -----------------------------------------------------------------------

  describe('_fetchIndexes()', () => {
    test('stores indexes from wrapped response', async () => {
      const { modal, endpoint } = createModal();
      await modal.indexingService.fetchIndexes();
      expect(modal.indexingService.indexes).toHaveLength(2);
      expect(endpoint.listIndexes).toHaveBeenCalledTimes(1);
    });

    test('handles response without indexes wrapper (bare array)', async () => {
      const { modal, endpoint } = createModal();
      endpoint.listIndexes.mockResolvedValue([makeIndex()]);
      await modal.indexingService.fetchIndexes();
      expect(modal.indexingService.indexes).toHaveLength(1);
    });

    test('handles null response', async () => {
      const { modal, endpoint } = createModal();
      endpoint.listIndexes.mockResolvedValue(null);
      await modal.indexingService.fetchIndexes();
      expect(modal.indexingService.indexes).toEqual([]);
    });
  });

  describe('_fetchSettings()', () => {
    test('stores settings on success', async () => {
      const { modal } = createModal();
      const settings = await modal._fetchSettings();
      expect(settings).not.toBeNull();
      expect(settings.agents.context_retrieval.default_top_k).toBe(10);
    });

    test('logs warning on failure and does not throw', async () => {
      const { modal, endpoint } = createModal();
      endpoint.getSettings.mockRejectedValue(new Error('Network error'));
      await modal._fetchSettings();
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load settings'),
        expect.any(Error)
      );
    });
  });

  // -----------------------------------------------------------------------
  // 3. Pure utilities
  // -----------------------------------------------------------------------

  describe('IndexBrowserUtils.escapeHtml()', () => {
    test('escapes angle brackets', () => {
      expect(IndexBrowserUtils.escapeHtml('<b>test</b>')).toBe('&lt;b&gt;test&lt;/b&gt;');
    });

    test('escapes ampersands', () => {
      expect(IndexBrowserUtils.escapeHtml('a & b')).toBe('a &amp; b');
    });

    test('handles numeric input', () => {
      expect(IndexBrowserUtils.escapeHtml(42)).toBe('42');
    });

    test('handles null and undefined', () => {
      expect(IndexBrowserUtils.escapeHtml(null)).toBe('');
      expect(IndexBrowserUtils.escapeHtml(undefined)).toBe('');
    });
  });

  describe('IndexBrowserUtils.escapeAttr()', () => {
    test('escapes double quotes', () => {
      expect(IndexBrowserUtils.escapeAttr('value="test"')).toBe('value=&quot;test&quot;');
    });

    test('escapes single quotes', () => {
      expect(IndexBrowserUtils.escapeAttr("value='test'")).toBe('value=&#39;test&#39;');
    });

    test('escapes angle brackets and ampersands', () => {
      expect(IndexBrowserUtils.escapeAttr('A & <B>')).toBe('A &amp; &lt;B&gt;');
    });

    test('handles null and undefined', () => {
      expect(IndexBrowserUtils.escapeAttr(null)).toBe('');
      expect(IndexBrowserUtils.escapeAttr(undefined)).toBe('');
    });

    test('neutralizes XSS via attribute injection', () => {
      const xss = '"><script>alert(1)</script>';
      const escaped = IndexBrowserUtils.escapeAttr(xss);
      expect(escaped).not.toContain('<script>');
      expect(escaped).toContain('&quot;');
      expect(escaped).toContain('&lt;script&gt;');
    });
  });

  describe('IndexBrowserUtils.groupIndexes()', () => {
    test('groups file_location into Filesystem', () => {
      const indexes = [
        makeIndex({ index_name: 'a', index_type: 'file_location' })
      ];
      const groups = IndexBrowserUtils.groupIndexes(indexes);
      expect(groups['Filesystem']).toHaveLength(1);
    });

    test('groups browser_history into Browser', () => {
      const groups = IndexBrowserUtils.groupIndexes([makeIndex({ index_type: 'source', source_type: 'browser_history' })]);
      expect(groups['Browser']).toHaveLength(1);
    });

    test('groups email into Email', () => {
      const groups = IndexBrowserUtils.groupIndexes([makeIndex({ index_type: 'source', source_type: 'email' })]);
      expect(groups['Email']).toHaveLength(1);
    });

    test('ignores agent_output entirely', () => {
      const groups = IndexBrowserUtils.groupIndexes([makeIndex({ index_type: 'agent_output' })]);
      expect(groups).toEqual({});
    });
  });

  describe('IndexBrowserUtils.formatGroupLabel()', () => {
    test('maps known types', () => {
      expect(IndexBrowserUtils.formatGroupLabel('agent_output')).toBe('Assistant History');
      expect(IndexBrowserUtils.formatGroupLabel('file_location')).toBe('Your Documents');
      expect(IndexBrowserUtils.formatGroupLabel('source')).toBe('Knowledge Base');
      expect(IndexBrowserUtils.formatGroupLabel('system')).toBe('System');
      expect(IndexBrowserUtils.formatGroupLabel('other')).toBe('Other');
    });

    test('capitalizes unknown types', () => {
      expect(IndexBrowserUtils.formatGroupLabel('custom_type')).toBe('Custom Type');
    });
  });

  describe('IndexBrowserUtils.formatScore()', () => {
    test('formats numeric score to percentage', () => {
      expect(IndexBrowserUtils.formatScore(0.925)).toBe('93%');
      expect(IndexBrowserUtils.formatScore(1.0)).toBe('100%');
      expect(IndexBrowserUtils.formatScore(0)).toBe('0%');
    });

    test('returns dash for non-numeric', () => {
      expect(IndexBrowserUtils.formatScore(undefined)).toBe('-');
      expect(IndexBrowserUtils.formatScore(null)).toBe('-');
      expect(IndexBrowserUtils.formatScore('high')).toBe('-');
    });
  });

  describe('IndexBrowserUtils.formatDuration()', () => {
    test('formats sub-second as ms', () => {
      expect(IndexBrowserUtils.formatDuration(42)).toBe('42ms');
      expect(IndexBrowserUtils.formatDuration(999)).toBe('999ms');
    });

    test('formats >= 1000 as seconds', () => {
      expect(IndexBrowserUtils.formatDuration(1000)).toBe('1.00s');
      expect(IndexBrowserUtils.formatDuration(1500)).toBe('1.50s');
    });

    test('returns empty string for non-number', () => {
      expect(IndexBrowserUtils.formatDuration(undefined)).toBe('');
      expect(IndexBrowserUtils.formatDuration(null)).toBe('');
    });
  });

  describe('_highlightQuery()', () => {
    test('wraps matching words in mark tags', () => {
      const { modal } = createModal();
      const result = modal._highlightQuery('The quick brown fox', 'quick fox');
      expect(result).toContain('<mark class="se-highlight">quick</mark>');
      expect(result).toContain('<mark class="se-highlight">fox</mark>');
    });

    test('is case-insensitive', () => {
      const { modal } = createModal();
      const result = modal._highlightQuery('Hello World', 'hello');
      expect(result).toContain('<mark class="se-highlight">Hello</mark>');
    });

    test('escapes HTML in text before highlighting', () => {
      const { modal } = createModal();
      const result = modal._highlightQuery('<script>alert(1)</script>', 'alert');
      expect(result).not.toContain('<script>');
      expect(result).toContain('<mark class="se-highlight">alert</mark>');
    });

    test('returns escaped text when query is empty', () => {
      const { modal } = createModal();
      expect(modal._highlightQuery('test', '')).toBe('test');
    });

    test('returns empty string when text is empty', () => {
      const { modal } = createModal();
      expect(modal._highlightQuery('', 'query')).toBe('');
    });
  });

  describe('_getResultTitle()', () => {
    test('returns file_name from metadata', () => {
      const { modal } = createModal();
      expect(modal._getResultTitle({ metadata: { file_name: 'doc.pdf' } })).toBe('doc.pdf');
    });

    test('falls back to title', () => {
      const { modal } = createModal();
      expect(modal._getResultTitle({ metadata: { title: 'My Title' } })).toBe('My Title');
    });

    test('falls back to display_name', () => {
      const { modal } = createModal();
      expect(modal._getResultTitle({ metadata: { display_name: 'Display' } })).toBe('Display');
    });

    test('derives title for agent_output type', () => {
      const { modal } = createModal();
      const result = { index_type: 'agent_output', index_name: 'agent_research_index', metadata: {} };
      expect(modal._getResultTitle(result)).toBe('research output');
    });

    test('falls back to first line of text', () => {
      const { modal } = createModal();
      const result = { text: 'Short first line\nMore content', metadata: {} };
      expect(modal._getResultTitle(result)).toBe('Short first line');
    });

    test('falls back to index_name when first line is too long', () => {
      const { modal } = createModal();
      const result = { text: 'A'.repeat(101), index_name: 'my_index', metadata: {} };
      expect(modal._getResultTitle(result)).toBe('my_index');
    });

    test('returns Untitled as last resort', () => {
      const { modal } = createModal();
      expect(modal._getResultTitle({ metadata: {} })).toBe('Untitled');
    });
  });

  describe('_getOpenTarget()', () => {
    test('returns file target for file_path', () => {
      const { modal } = createModal();
      const target = modal._getOpenTarget({ metadata: { file_path: '/home/doc.pdf' } });
      expect(target).toEqual({ type: 'file', path: '/home/doc.pdf' });
    });

    test('returns url target for url', () => {
      const { modal } = createModal();
      const target = modal._getOpenTarget({ metadata: { url: 'https://example.com' } });
      expect(target).toEqual({ type: 'url', path: 'https://example.com' });
    });

    test('prefers file_path over url', () => {
      const { modal } = createModal();
      const target = modal._getOpenTarget({
        metadata: { file_path: '/doc.pdf', url: 'https://example.com' },
      });
      expect(target.type).toBe('file');
    });

    test('returns null when no path or url', () => {
      const { modal } = createModal();
      expect(modal._getOpenTarget({ metadata: {} })).toBeNull();
      expect(modal._getOpenTarget({})).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // 4. Search history (localStorage)
  // -----------------------------------------------------------------------

  describe('_loadHistory()', () => {
    test('returns empty array when nothing stored', () => {
      const { modal } = createModal();
      expect(modal._loadHistory()).toEqual([]);
    });

    test('returns valid array from localStorage', () => {
      const { modal } = createModal();
      localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(['alpha', 'beta']));
      expect(modal._loadHistory()).toEqual(['alpha', 'beta']);
    });

    test('returns empty for non-array JSON', () => {
      const { modal } = createModal();
      localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify('not an array'));
      expect(modal._loadHistory()).toEqual([]);
    });

    test('returns empty for invalid JSON', () => {
      const { modal } = createModal();
      localStorage.setItem(SEARCH_HISTORY_KEY, '{invalid json');
      expect(modal._loadHistory()).toEqual([]);
    });

    test('filters out whitespace-only strings', () => {
      const { modal } = createModal();
      localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(['valid', '  ', '\t', 'also valid']));
      expect(modal._loadHistory()).toEqual(['valid', 'also valid']);
    });

    test('truncates to max history length', () => {
      const { modal } = createModal();
      const tooMany = Array.from({ length: 15 }, (_, i) => `query_${i}`);
      localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(tooMany));
      expect(modal._loadHistory()).toHaveLength(SEARCH_HISTORY_MAX);
    });

    test('filters out non-string entries', () => {
      const { modal } = createModal();
      localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(['valid', 42, null, true, 'also valid']));
      expect(modal._loadHistory()).toEqual(['valid', 'also valid']);
    });

    test('returns empty when localStorage throws', () => {
      const { modal } = createModal();
      jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('Access denied');
      });
      expect(modal._loadHistory()).toEqual([]);
    });
  });

  describe('_saveHistory()', () => {
    test('prepends new query', () => {
      const { modal } = createModal();
      localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(['old']));
      modal._saveHistory('new');
      const stored = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY));
      expect(stored[0]).toBe('new');
      expect(stored[1]).toBe('old');
    });

    test('deduplicates existing query by moving to front', () => {
      const { modal } = createModal();
      localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(['alpha', 'beta', 'gamma']));
      modal._saveHistory('beta');
      const stored = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY));
      expect(stored).toEqual(['beta', 'alpha', 'gamma']);
    });

    test('enforces max history length', () => {
      const { modal } = createModal();
      const existing = Array.from({ length: SEARCH_HISTORY_MAX }, (_, i) => `q${i}`);
      localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(existing));
      modal._saveHistory('brand new');
      const stored = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY));
      expect(stored).toHaveLength(SEARCH_HISTORY_MAX);
      expect(stored[0]).toBe('brand new');
    });

    test('no-ops for empty, whitespace, or null query', () => {
      const { modal } = createModal();
      const spy = jest.spyOn(Storage.prototype, 'setItem');
      modal._saveHistory('');
      modal._saveHistory('  ');
      modal._saveHistory(null);
      expect(spy).not.toHaveBeenCalled();
    });

    test('survives localStorage unavailability', () => {
      const { modal } = createModal();
      jest.spyOn(Storage.prototype, 'getItem').mockReturnValue(JSON.stringify([]));
      jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('Quota exceeded');
      });
      expect(() => modal._saveHistory('test')).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // 5. UI builders
  // -----------------------------------------------------------------------

  describe('_buildUI()', () => {
    test('returns idle state when hasSearched is false', async () => {
      const { modal } = createModal();
      modal.indexingService.indexes = [makeIndex()];
      modal.searchService.hasSearched = false;
      await modal._renderContent();
      const se = modal.bodyEl.querySelector('.se');
      expect(se.dataset.state).toBe('idle');
    });

    test('returns results state when hasSearched is true', async () => {
      const { modal } = createModal();
      modal.indexingService.indexes = [makeIndex()];
      modal.searchService.hasSearched = true;
      await modal._renderContent();
      const se = modal.bodyEl.querySelector('.se');
      expect(se.dataset.state).toBe('results');
    });
  });

  describe('_buildContent()', () => {
    test('branch: not searched — empty se-content', async () => {
      const { modal } = createModal();
      modal.searchService.hasSearched = false;
      await modal._renderContent();
      const html = modal.resultsComponent._buildContent();
      expect(html).toContain('se-content');
      expect(html).not.toContain('se-loading');
      expect(html).not.toContain('se-results-list');
      expect(html).not.toContain('se-preview');
      expect(html).not.toContain('se-empty');
    });

    test('branch: searching — loading spinner', async () => {
      const { modal } = createModal();
      modal.searchService.hasSearched = true;
      modal.searchService.isSearching = true;
      modal.indexingService.selectedSources = new Set(['a']);
      await modal._renderContent();
      const html = modal.resultsComponent._buildContent();
      expect(html).toContain('se-loading');
      expect(html).toContain('se-loading-spinner');
    });

    test('branch: preview — preview panel', async () => {
      const { modal } = createModal();
      modal.searchService.hasSearched = true;
      modal.searchService.isSearching = false;
      modal.previewResult = makeResult({ text: 'Preview text' });
      await modal._renderContent();
      const html = modal.resultsComponent._buildContent();
      expect(html).toContain('se-preview');
      expect(html).toContain('Back to results');
    });

    test('branch: no results — empty state', async () => {
      const { modal } = createModal();
      modal.searchService.hasSearched = true;
      modal.searchService.isSearching = false;
      modal.previewResult = null;
      modal.searchService.searchResults = [];
      modal.searchService.searchQuery = 'unfindable';
      await modal._renderContent();
      const html = modal.resultsComponent._buildContent();
      expect(html).toContain('se-empty');
      expect(html).toContain('No results found');
    });

    test('branch: results with pagination', async () => {
      const { modal } = createModal();
      modal.searchService.hasSearched = true;
      modal.searchService.isSearching = false;
      modal.previewResult = null;
      modal.searchService.searchResults = Array.from({ length: 25 }, (_, i) =>
        makeResult({ text: `Result ${i}`, score: 0.9 - i * 0.01 })
      );
      modal._visibleCount = RESULTS_PER_PAGE;
      modal.searchService.searchDuration = 100;
      modal.searchService.indexesSearched = ['idx_a'];
      await modal._renderContent();
      const html = modal.resultsComponent._buildContent();
      expect(html).toContain('se-results-list');
      expect(html).toContain('se-load-more');
      expect(html).toContain('se-stats');
    });
  });

  describe('_buildLoadMore()', () => {
    test('returns empty when all results visible', async () => {
      const { modal } = createModal();
      modal.searchService.searchResults = [makeResult()];
      modal._visibleCount = RESULTS_PER_PAGE;
      await modal._renderContent();
      expect(modal.resultsComponent._buildLoadMore()).toBe('');
    });

    test('shows remaining count when more results exist', async () => {
      const { modal } = createModal();
      modal.searchService.searchResults = Array.from({ length: 30 }, () => makeResult());
      modal._visibleCount = RESULTS_PER_PAGE;
      await modal._renderContent();
      const html = modal.resultsComponent._buildLoadMore();
      expect(html).toContain('Show 10 more result');
      expect(html).toContain('(20 of 30)');
    });

    test('shows partial remaining at non-page boundary', async () => {
      const { modal } = createModal();
      modal.searchService.searchResults = Array.from({ length: 25 }, () => makeResult());
      modal._visibleCount = RESULTS_PER_PAGE;
      await modal._renderContent();
      const html = modal.resultsComponent._buildLoadMore();
      expect(html).toContain('Show 5 more result');
      expect(html).toContain('(20 of 25)');
    });

    test('returns empty at exact page boundary', async () => {
      const { modal } = createModal();
      modal.searchService.searchResults = Array.from({ length: RESULTS_PER_PAGE }, () => makeResult());
      modal._visibleCount = RESULTS_PER_PAGE;
      await modal._renderContent();
      expect(modal.resultsComponent._buildLoadMore()).toBe('');
    });
  });

  describe('_buildPreview()', () => {
    test('returns empty when previewResult is null', async () => {
      const { modal } = createModal();
      modal.previewResult = null;
      await modal._renderContent();
      expect(modal.resultsComponent._buildPreview()).toBe('');
    });

    test('renders title, score, and text', async () => {
      const { modal } = createModal();
      modal.previewResult = makeResult({
        text: 'Preview body text',
        score: 0.92,
        metadata: { file_name: 'report.pdf' },
      });
      await modal._renderContent();
      const html = modal.resultsComponent._buildPreview();
      expect(html).toContain('report.pdf');
      expect(html).toContain('92%');
      expect(html).toContain('Preview body text');
    });

    test('renders metadata rows', async () => {
      const { modal } = createModal();
      modal.previewResult = makeResult({
        metadata: { file_name: 'doc.pdf', author: 'Alice', page: '5' },
      });
      await modal._renderContent();
      const html = modal.resultsComponent._buildPreview();
      expect(html).toContain('author');
      expect(html).toContain('Alice');
      expect(html).toContain('page');
    });

    test('skips null and empty metadata values', async () => {
      const { modal } = createModal();
      modal.previewResult = makeResult({
        metadata: { file_name: 'doc.pdf', blank: '', nullable: null },
      });
      await modal._renderContent();
      const html = modal.resultsComponent._buildPreview();
      expect(html).toContain('file_name');
      expect(html).not.toContain('>blank<');
      expect(html).not.toContain('>nullable<');
    });

    test('shows open button only when target exists', async () => {
      const { modal } = createModal();
      modal.previewResult = makeResult({ metadata: { file_path: '/doc.pdf' } });
      await modal._renderContent();
      expect(modal.resultsComponent._buildPreview()).toContain('se-preview-open');

      modal.previewResult = makeResult({ metadata: {} });
      await modal._renderContent();
      expect(modal.resultsComponent._buildPreview()).not.toContain('se-preview-open');
    });

    test('handles result with no text fields', async () => {
      const { modal } = createModal();
      modal.previewResult = makeResult({
        text: undefined, content: undefined, snippet: undefined,
      });
      await modal._renderContent();
      const html = modal.resultsComponent._buildPreview();
      expect(html).toContain('se-preview-text');
    });
  });

  describe('_buildRecentSearches()', () => {
    test('returns empty when no history', async () => {
      const { modal } = createModal();
      expect(modal._buildRecentSearches()).toBe('');
    });

    test('renders history chips', async () => {
      const { modal } = createModal();
      localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(['alpha', 'beta']));
      const html = modal._buildRecentSearches();
      expect(html).toContain('se-history');
      expect(html).toContain('se-history-chip');
      expect(html).toContain('alpha');
      expect(html).toContain('beta');
    });

    test('escapes XSS in history query', async () => {
      const { modal } = createModal();
      localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(['"><script>alert(1)</script>']));
      const html = modal._buildRecentSearches();
      expect(html).not.toContain('<script>');
    });

    test('renders clear button', async () => {
      const { modal } = createModal();
      localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(['query']));
      const html = modal._buildRecentSearches();
      expect(html).toContain('se-history-clear');
    });
  });

  describe('_renderContent()', () => {
    test('renders full UI on success', async () => {
      const { modal } = createModal();
      await modal._renderContent();
      expect(modal.bodyEl.querySelector('.se')).not.toBeNull();
    });

    test('shows error on fetch failure', async () => {
      const { modal, endpoint } = createModal();
      endpoint.listIndexes.mockRejectedValue(new Error('Fetch fail'));
      await modal._renderContent();
      expect(modal.bodyEl.innerHTML).toContain('Failed to Load');
    });

    test('applies pending source selection after render', async () => {
      const { modal } = createModal();
      modal._pendingSourceSelection = 'research_output';
      const spy = jest.spyOn(modal, '_preselectSource');
      await modal._renderContent();
      expect(spy).toHaveBeenCalledWith('research_output');
      expect(modal._pendingSourceSelection).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // 6. State machine / _executeSearch
  // -----------------------------------------------------------------------

  describe('searchService.executeSearch() via modal integration', () => {
    test('happy path: calls endpoint and updates state', async () => {
      const { modal, endpoint } = readyModal();

      modal.searchService.searchQuery = 'test query';
      await modal.searchService.executeSearch(
        'test query', 
        modal.indexingService.selectedSources, 
        modal._getAvailableSearchModes()
      );

      expect(endpoint.searchIndexes).toHaveBeenCalledWith({
        query: 'test query',
        index_names: expect.arrayContaining(['research_output', 'user_files']),
        top_k: 10,
        min_score: 0.0,
        mode: 'bm25',
      }, expect.objectContaining({ timeout: 30000, allowRetry: false }));
      expect(modal.searchService.searchResults).toHaveLength(2);
      expect(modal.searchService.searchDuration).toBe(42);
      expect(modal.searchService.isSearching).toBe(false);
      expect(modal.searchService.hasSearched).toBe(true);
    });

    test('empty query returns early without calling endpoint', async () => {
      const { modal, endpoint } = readyModal();
      modal.searchService.searchQuery = '';
      await modal.searchService.executeSearch(
        '', 
        modal.indexingService.selectedSources, 
        modal._getAvailableSearchModes()
      );
      expect(endpoint.searchIndexes).not.toHaveBeenCalled();
    });

    test('no selected sources shows toast and returns early', async () => {
      const { modal, endpoint } = readyModal();
      modal.indexingService.selectedSources.clear();
      modal.searchService.searchQuery = 'test';
      await modal.searchService.executeSearch(
        'test', 
        modal.indexingService.selectedSources, 
        modal._getAvailableSearchModes()
      );
      expect(mockToast.error).toHaveBeenCalledWith('Select at least one source to search.');
      expect(endpoint.searchIndexes).not.toHaveBeenCalled();
    });

    test('error path: shows toast and clears results', async () => {
      const { modal, endpoint } = readyModal();
      endpoint.searchIndexes.mockRejectedValue(new Error('Network error'));

      modal.searchService.searchQuery = 'fail query';
      await modal.searchService.executeSearch(
        'fail query', 
        modal.indexingService.selectedSources, 
        modal._getAvailableSearchModes()
      );

      expect(mockToast.error).toHaveBeenCalledWith('Search failed. Please try again.');
      expect(modal.searchService.searchResults).toEqual([]);
      expect(modal.searchService.isSearching).toBe(false);
    });

    test('saves query to search history', async () => {
      const { modal } = readyModal();
      modal.searchService.searchQuery = 'history query';

      await modal.searchService.executeSearch(
        'history query', 
        modal.indexingService.selectedSources, 
        modal._getAvailableSearchModes()
      );

      const stored = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY));
      expect(stored[0]).toBe('history query');
    });

    // -- RACE CONDITION: concurrent searches --

    test('concurrent searches: only latest results kept', async () => {
      const { modal, endpoint } = readyModal();

      let resolveFirst;
      endpoint.searchIndexes
        .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
        .mockResolvedValueOnce({
          results: [makeResult({ text: 'second result' })],
          search_duration_ms: 10,
          indexes_searched: ['idx'],
        });

      modal.searchService.searchQuery = 'slow query';
      const p1 = modal.searchService.executeSearch(
        'slow query', 
        modal.indexingService.selectedSources, 
        modal._getAvailableSearchModes()
      );

      modal.searchService.searchQuery = 'fast query';
      const p2 = modal.searchService.executeSearch(
        'fast query', 
        modal.indexingService.selectedSources, 
        modal._getAvailableSearchModes()
      );
      await p2;

      expect(modal.searchService.searchResults).toHaveLength(1);
      expect(modal.searchService.searchResults[0].text).toBe('second result');
      expect(modal.searchService.isSearching).toBe(false);

      resolveFirst({
        results: [makeResult({ text: 'stale result' })],
        search_duration_ms: 500,
        indexes_searched: ['idx'],
      });
      await p1;

      expect(modal.searchService.searchResults).toHaveLength(1);
      expect(modal.searchService.searchResults[0].text).toBe('second result');
    });

    test('concurrent searches: stale error does not show toast', async () => {
      const { modal, endpoint } = readyModal();

      let rejectFirst;
      endpoint.searchIndexes
        .mockImplementationOnce(() => new Promise((_, rej) => { rejectFirst = rej; }))
        .mockResolvedValueOnce({
          results: [makeResult({ text: 'good result' })],
          search_duration_ms: 10,
          indexes_searched: ['idx'],
        });

      modal.searchService.searchQuery = 'query one';
      const p1 = modal.searchService.executeSearch(
        'query one', 
        modal.indexingService.selectedSources, 
        modal._getAvailableSearchModes()
      );

      modal.searchService.searchQuery = 'query two';
      const p2 = modal.searchService.executeSearch(
        'query two', 
        modal.indexingService.selectedSources, 
        modal._getAvailableSearchModes()
      );
      await p2;

      rejectFirst(new Error('Timeout'));
      await p1;

      expect(mockToast.error).not.toHaveBeenCalled();
    });

    test('close() aborts in-flight search immediately without user-cancel toast', async () => {
      const { modal, endpoint } = readyModal();

      let abortReason = null;
      endpoint.searchIndexes.mockImplementation((_payload, options) => {
        return new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => {
            abortReason = options.signal.reason;
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          }, { once: true });
        });
      });

      modal.searchService.searchQuery = 'abort me';
      const pending = modal.searchService.executeSearch(
        'abort me', 
        modal.indexingService.selectedSources, 
        modal._getAvailableSearchModes()
      );
      modal.close();
      await pending;

      expect(abortReason).toBe('Modal closed');
      expect(mockToast.info).not.toHaveBeenCalledWith('Search cancelled.');
    });
  });

  // -----------------------------------------------------------------------
  // 9. show() — public API
  // -----------------------------------------------------------------------

  describe('show()', () => {
    test('shows toast error when endpoint is null', async () => {
      const modal = new IndexBrowserModal({});
      modal.endpoint = null;
      await modal.show();
      expect(mockToast.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to open search')
      );
    });

    test('does not re-open if already open', async () => {
      const { modal, endpoint } = createModal();
      modal.isOpen = true;
      jest.spyOn(modal, 'bringToFront').mockImplementation(() => {});
      await modal.show();
      expect(modal.bringToFront).toHaveBeenCalled();
      expect(endpoint.listIndexes).not.toHaveBeenCalled();
    });

    test('pre-selects source when already open with targetIndexName', async () => {
      const { modal } = createModal();
      modal.isOpen = true;
      modal.indexes = [makeIndex({ index_name: 'target' })];
      modal.selectedSources = new Set(['target']);
      jest.spyOn(modal, 'bringToFront').mockImplementation(() => {});
      jest.spyOn(modal, '_preselectSource').mockImplementation(() => {});
      await modal.show('target');
      expect(modal._preselectSource).toHaveBeenCalledWith('target');
    });

    test('sets _pendingSourceSelection and calls open()', async () => {
      const { modal } = createModal();
      jest.spyOn(modal, 'open').mockResolvedValue();
      await modal.show('research_output');
      expect(modal._pendingSourceSelection).toBe('research_output');
      expect(modal.open).toHaveBeenCalledTimes(1);
    });

    test('calls open() without pending selection when no target', async () => {
      const { modal } = createModal();
      jest.spyOn(modal, 'open').mockResolvedValue();
      await modal.show();
      expect(modal._pendingSourceSelection).toBeNull();
      expect(modal.open).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // 10. _openDocument()
  // -----------------------------------------------------------------------

  describe('_openDocument()', () => {
    afterEach(() => {
      delete mockAether.artifacts;
      delete mockAether.file;
    });

    test('no-ops when path is empty', async () => {
      const { modal } = createModal();
      await modal._openDocument('file', '');
      await modal._openDocument('file', null);
      expect(mockToast.info).not.toHaveBeenCalled();
      expect(mockToast.error).not.toHaveBeenCalled();
    });

    test('shows error when bridge is unavailable', async () => {
      const { modal } = createModal();
      await modal._openDocument('file', '/test.pdf');
      expect(mockToast.error).toHaveBeenCalledWith(
        'File opening is not available on your system.'
      );
    });

    test('opens file via bridge and shows info toast', async () => {
      const { modal } = createModal();
      const mockBridge = jest.fn();
      mockAether.artifacts = { openFile: mockBridge };

      await modal._openDocument('file', '/test.pdf');

      expect(mockBridge).toHaveBeenCalledWith('/test.pdf');
      expect(mockToast.info).toHaveBeenCalledWith('Opening file externally...');
    });

    test('opens file via FileViewerModal when aether.file.read succeeds', async () => {
      const { modal } = createModal();
      const mockBridge = jest.fn();
      mockAether.artifacts = { openFile: mockBridge };
      mockAether.file = {
        read: jest.fn().mockResolvedValue({
          success: true,
          content: 'test content',
          filename: 'test.txt',
          isBinary: false
        })
      };
      
      // Mock FileViewerModal prototype
      const FileViewerModal = require('../../../../src/renderer/chat/modals/FileViewerModal');
      const openSpy = jest.spyOn(FileViewerModal.prototype, 'open').mockResolvedValue();

      await modal._openDocument('file', '/test.txt');

      expect(mockAether.file.read).toHaveBeenCalledWith('/test.txt');
      expect(mockBridge).not.toHaveBeenCalled();
      expect(mockToast.info).toHaveBeenCalledWith('Loading file...');
      expect(openSpy).toHaveBeenCalledWith({
        filename: 'test.txt',
        content: 'test content',
        metadata: { mime_type: 'text/plain' }
      });
      
      openSpy.mockRestore();
    });

    test('opens URL via bridge and shows info toast', async () => {
      const { modal } = createModal();
      const mockBridge = jest.fn();
      mockAether.artifacts = { openFile: mockBridge };

      await modal._openDocument('url', 'https://example.com');

      expect(mockBridge).toHaveBeenCalledWith('https://example.com');
      expect(mockToast.info).toHaveBeenCalledWith('Opening link...');
    });

    test('shows error for unhandled document type', async () => {
      const { modal } = createModal();
      const mockBridge = jest.fn();
      mockAether.artifacts = { openFile: mockBridge };

      await modal._openDocument('unknown', '/file');

      expect(mockBridge).not.toHaveBeenCalled();
      expect(mockToast.error).toHaveBeenCalledWith('This file type cannot be opened directly.');
    });

    test('shows error toast when bridge throws', async () => {
      const { modal } = createModal();
      mockAether.artifacts = {
        openFile: jest.fn(() => { throw new Error('Bridge crash'); }),
      };

      await modal._openDocument('file', '/test.pdf');

      expect(mockToast.error).toHaveBeenCalledWith('Failed to open document.');
    });
  });

  // -----------------------------------------------------------------------
  // 11. _copyText() / _fallbackCopy()
  // -----------------------------------------------------------------------

  describe('_copyText()', () => {
    test('no-ops when text is empty', () => {
      const { modal } = createModal();
      modal._copyText('');
      modal._copyText(null);
      expect(mockToast.success).not.toHaveBeenCalled();
    });

    test('uses fallback directly when clipboard API unavailable', () => {
      const { modal } = createModal();
      // navigator.clipboard is undefined by default in JSDOM
      const origExec = document.execCommand;
      document.execCommand = jest.fn().mockReturnValue(true);

      modal._copyText('direct fallback');

      expect(document.execCommand).toHaveBeenCalledWith('copy');
      expect(mockToast.success).toHaveBeenCalledWith('Copied to clipboard');
      document.execCommand = origExec;
    });

    test('uses clipboard API when available', async () => {
      const { modal } = createModal();
      const writeText = jest.fn().mockResolvedValue();
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        writable: true,
        configurable: true,
      });

      modal._copyText('hello');
      await new Promise((r) => setTimeout(r, 0));

      expect(writeText).toHaveBeenCalledWith('hello');
      expect(mockToast.success).toHaveBeenCalledWith('Copied to clipboard');

      delete navigator.clipboard;
    });

    test('falls back when clipboard API rejects', async () => {
      const { modal } = createModal();
      const writeText = jest.fn().mockRejectedValue(new Error('nope'));
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        writable: true,
        configurable: true,
      });

      const origExec = document.execCommand;
      document.execCommand = jest.fn().mockReturnValue(true);
      modal._copyText('fallback text');
      await new Promise((r) => setTimeout(r, 0));

      expect(document.execCommand).toHaveBeenCalledWith('copy');
      document.execCommand = origExec;
      delete navigator.clipboard;
    });
  });

  describe('_fallbackCopy()', () => {
    let origExec;

    beforeEach(() => {
      origExec = document.execCommand;
    });

    afterEach(() => {
      document.execCommand = origExec;
    });

    test('copies via execCommand and shows toast', () => {
      const { modal } = createModal();
      document.execCommand = jest.fn().mockReturnValue(true);

      modal._fallbackCopy('text to copy');

      expect(document.execCommand).toHaveBeenCalledWith('copy');
      expect(mockToast.success).toHaveBeenCalledWith('Copied to clipboard');
    });

    test('shows error toast when execCommand throws', () => {
      const { modal } = createModal();
      document.execCommand = jest.fn().mockImplementation(() => {
        throw new Error('Not allowed');
      });

      modal._fallbackCopy('text');

      expect(mockToast.error).toHaveBeenCalledWith('Copy failed');
    });
  });

  // -----------------------------------------------------------------------
  // 12. _toggleResultExpansion()
});
