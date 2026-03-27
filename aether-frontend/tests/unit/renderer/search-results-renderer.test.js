'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    debug: jest.fn(), trace: jest.fn(),
    child: jest.fn(function () { return this; }),
  })),
}));

const { createRendererLogger } = require('../../../src/renderer/shared/utils/logger');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLogger() {
  return {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    debug: jest.fn(), trace: jest.fn(),
    child: jest.fn(function () { return this; }),
  };
}

function createContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function makeSearchData(overrides = {}) {
  return {
    results: [
      {
        score: 0.95,
        text: '[Title]: Search Engine\n[URL]: https://example.com\n[Last Visited]: 2025-01-15\n[Visit Count]: 42\n[Profile]: Default',
        index_name: 'history',
      },
    ],
    total_found: 1,
    search_duration_ms: 150,
    indexes_searched: ['history'],
    ...overrides,
  };
}

function makeResult(overrides = {}) {
  return {
    score: 0.85,
    text: '[Title]: Test Result\n[URL]: https://test.com',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SearchResultsRenderer', () => {
  let SearchResultsRenderer;
  let renderer;
  let container;
  let mockLog;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    mockLog = createLogger();
    createRendererLogger.mockReturnValue(mockLog);

    SearchResultsRenderer = require('../../../src/renderer/artifacts/modules/output/renderers/SearchResultsRenderer');
    renderer = new SearchResultsRenderer();
    renderer.log = mockLog;
    container = createContainer();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  // =========================================================================
  // isSearchResults (static)
  // =========================================================================

  describe('isSearchResults', () => {
    it('returns true for valid search results with score', () => {
      expect(SearchResultsRenderer.isSearchResults({
        results: [{ score: 0.5 }],
      })).toBe(true);
    });

    it('returns false for null', () => {
      expect(SearchResultsRenderer.isSearchResults(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(SearchResultsRenderer.isSearchResults(undefined)).toBe(false);
    });

    it('returns false for string', () => {
      expect(SearchResultsRenderer.isSearchResults('search')).toBe(false);
    });

    it('returns false for number', () => {
      expect(SearchResultsRenderer.isSearchResults(42)).toBe(false);
    });

    it('returns false for empty object', () => {
      expect(SearchResultsRenderer.isSearchResults({})).toBe(false);
    });

    it('returns false when results is not an array', () => {
      expect(SearchResultsRenderer.isSearchResults({ results: 'not array' })).toBe(false);
    });

    it('returns false for empty results array', () => {
      expect(SearchResultsRenderer.isSearchResults({ results: [] })).toBe(false);
    });

    it('returns false when first result has no score', () => {
      expect(SearchResultsRenderer.isSearchResults({
        results: [{ text: 'no score here' }],
      })).toBe(false);
    });

    it('returns true when score is 0 (score !== undefined)', () => {
      expect(SearchResultsRenderer.isSearchResults({
        results: [{ score: 0 }],
      })).toBe(true);
    });

    it('returns true for metadata-based web result shape', () => {
      expect(SearchResultsRenderer.isSearchResults({
        results: [{
          content: 'Summary text',
          metadata: {
            title: 'Example title',
            url: 'https://example.com/page',
          },
        }],
      })).toBe(true);
    });
  });

  // =========================================================================
  // render - data handling
  // =========================================================================

  describe('render - data handling', () => {
    it('renders from object data', async () => {
      await renderer.render(makeSearchData(), container);
      expect(container.querySelector('.search-results-header')).not.toBeNull();
      expect(container.querySelector('.search-result-card')).not.toBeNull();
      expect(container.classList.contains('output-renderer-surface')).toBe(true);
    });

    it('parses JSON string data', async () => {
      const json = JSON.stringify(makeSearchData());
      await renderer.render(json, container);
      expect(container.querySelector('.search-results-header')).not.toBeNull();
    });

    it('shows error for invalid JSON string', async () => {
      await renderer.render('not valid json', container);
      const error = container.querySelector('.render-error');
      expect(error).not.toBeNull();
      expect(mockLog.error).toHaveBeenCalledWith(
        '[SearchResultsRenderer] Render failed:',
        expect.objectContaining({ message: 'Invalid search results JSON' })
      );
    });

    it('shows error when data is not search results', async () => {
      await renderer.render({ items: [] }, container);
      const error = container.querySelector('.render-error');
      expect(error).not.toBeNull();
    });

    it('renders multiple result cards', async () => {
      const data = makeSearchData({
        results: [
          { score: 0.9, text: '[Title]: Result 1' },
          { score: 0.8, text: '[Title]: Result 2' },
          { score: 0.7, text: '[Title]: Result 3' },
        ],
        total_found: 3,
      });
      await renderer.render(data, container);
      const cards = container.querySelectorAll('.search-result-card');
      expect(cards.length).toBe(3);
    });
  });

  // =========================================================================
  // _renderHeader
  // =========================================================================

  describe('_renderHeader', () => {
    it('shows total found count', () => {
      const header = renderer._renderHeader(makeSearchData({ total_found: 42 }));
      expect(header.textContent).toContain('42');
    });

    it('pluralizes "results" for counts != 1', () => {
      const header = renderer._renderHeader(makeSearchData({ total_found: 5 }));
      expect(header.textContent).toContain('results');
    });

    it('uses singular "result" for count of 1', () => {
      const header = renderer._renderHeader(makeSearchData({ total_found: 1 }));
      // New implementation uses DOM text nodes, not <strong> wrapping
      expect(header.textContent).toContain('1 result');
      // Should NOT contain "results" (with 's') — verify singular form
      expect(header.textContent).not.toMatch(/1 results/);
    });

    it('shows search duration when provided', () => {
      const header = renderer._renderHeader(makeSearchData({ search_duration_ms: 1500 }));
      expect(header.textContent).toContain('1.50s');
    });

    it('hides duration when zero or missing', () => {
      const header = renderer._renderHeader(makeSearchData({ search_duration_ms: 0 }));
      // With zero duration, only result-count stat is rendered (no time stat)
      expect(header.textContent).not.toContain('0.00s');
    });

    it('shows indexes when provided', () => {
      const header = renderer._renderHeader(makeSearchData({
        indexes_searched: ['history', 'bookmarks'],
      }));
      expect(header.textContent).toContain('history, bookmarks');
    });

    it('hides indexes when empty', () => {
      const header = renderer._renderHeader(makeSearchData({ indexes_searched: [] }));
      // With empty indexes, only result-count and duration stats are rendered
      const statItems = header.querySelectorAll('.stat-item');
      // Should have result count + duration = 2 (no index stat)
      expect(statItems.length).toBe(2);
    });

    it('falls back to results.length when total_found missing', () => {
      const data = makeSearchData();
      delete data.total_found;
      const header = renderer._renderHeader(data);
      expect(header.textContent).toContain('1');
    });

    it('has search-results-header class', () => {
      const header = renderer._renderHeader(makeSearchData());
      expect(header.classList.contains('search-results-header')).toBe(true);
      expect(header.classList.contains('output-card')).toBe(true);
    });
  });

  // =========================================================================
  // _renderResult
  // =========================================================================

  describe('_renderResult', () => {
    it('creates a card with search-result-card class', () => {
      const card = renderer._renderResult(makeResult(), 0);
      expect(card.classList.contains('search-result-card')).toBe(true);
      expect(card.classList.contains('output-card')).toBe(true);
    });

    it('displays score as percentage', () => {
      const card = renderer._renderResult(makeResult({ score: 0.95 }), 0);
      const score = card.querySelector('.result-score');
      expect(score.textContent).toBe('95%');
    });

    it('displays score in title attribute', () => {
      const card = renderer._renderResult(makeResult({ score: 0.8567 }), 0);
      const score = card.querySelector('.result-score');
      // New implementation: title = "Relevance: <raw score>"
      expect(score.title).toBe('Relevance: 0.8567');
    });

    it('renders title from parsed text', () => {
      const card = renderer._renderResult(makeResult({
        text: '[Title]: My Page Title',
      }), 0);
      const title = card.querySelector('.result-title');
      expect(title).not.toBeNull();
      expect(title.textContent).toBe('My Page Title');
    });

    it('renders URL as link', () => {
      const card = renderer._renderResult(makeResult({
        text: '[URL]: https://example.com/page',
      }), 0);
      const url = card.querySelector('.result-url');
      expect(url).not.toBeNull();
      expect(url.tagName).toBe('A');
      expect(url.href).toBe('https://example.com/page');
      expect(url.target).toBe('_blank');
      expect(url.rel).toBe('noopener noreferrer');
    });

    it('renders last visited date', () => {
      const card = renderer._renderResult(makeResult({
        text: '[Last Visited]: 2025-01-15',
      }), 0);
      const meta = card.querySelector('.result-meta');
      expect(meta.textContent.length).toBeGreaterThan(0);
    });

    it('renders visit count', () => {
      const card = renderer._renderResult(makeResult({
        text: '[Visit Count]: 42',
      }), 0);
      const meta = card.querySelector('.result-meta');
      expect(meta.textContent).toContain('42');
      expect(meta.textContent).toContain('visits');
    });

    it('uses singular "visit" for count of 1', () => {
      const card = renderer._renderResult(makeResult({
        text: '[Visit Count]: 1',
      }), 0);
      const meta = card.querySelector('.result-meta');
      expect(meta.textContent).toContain('1 visit');
      expect(meta.textContent).not.toContain('1 visits');
    });

    it('adds has-badge class when score exists', () => {
      const card = renderer._renderResult(makeResult({ score: 0.9 }), 0);
      expect(card.querySelector('.result-content').classList.contains('has-badge')).toBe(true);
    });

    it('does not add has-badge class when no score or rank exists', () => {
      const card = renderer._renderResult(makeResult({ score: undefined, text: '[Title]: No Score' }), 0);
      expect(card.querySelector('.result-content').classList.contains('has-badge')).toBe(false);
    });

    it('renders title/url/snippet from metadata+content shape', () => {
      const card = renderer._renderResult({
        content: 'Product Engineer | AI Systems',
        metadata: {
          title: 'Krish Dokania - Product Engineer',
          url: 'https://uk.linkedin.com/in/krish-dokania',
          source: 'LinkedIn',
        },
      }, 0);

      expect(card.querySelector('.result-title').textContent).toContain('Krish Dokania');
      const url = card.querySelector('.result-url');
      expect(url).not.toBeNull();
      expect(url.href).toContain('https://uk.linkedin.com/in/krish-dokania');
      expect(url.textContent).toBe('uk.linkedin.com/in/krish-dokania');
      expect(card.querySelector('.result-snippet').textContent).toContain('Product Engineer');
      expect(card.querySelector('.result-meta').textContent).toContain('LinkedIn');
    });

    it('renders profile name', () => {
      const card = renderer._renderResult(makeResult({
        text: '[Profile]: Work Profile',
      }), 0);
      const meta = card.querySelector('.result-meta');
      expect(meta.textContent).toContain('Work Profile');
    });

    it('renders index_name badge', () => {
      const card = renderer._renderResult(makeResult({ index_name: 'history' }), 0);
      const badge = card.querySelector('.index-badge');
      expect(badge).not.toBeNull();
      expect(badge.textContent).toBe('history');
    });

    it('renders "Untitled Result" when title not in text', () => {
      const card = renderer._renderResult(makeResult({ text: '' }), 0);
      const title = card.querySelector('.result-title');
      expect(title).not.toBeNull();
      expect(title.textContent).toBe('Untitled Result');
    });

    it('omits URL when not in text', () => {
      const card = renderer._renderResult(makeResult({ text: '[Title]: Only Title' }), 0);
      const url = card.querySelector('.result-url');
      expect(url).toBeNull();
    });

    it('escapes profile name to prevent XSS', () => {
      const card = renderer._renderResult(makeResult({
        text: '[Profile]: <script>alert(1)</script>',
      }), 0);
      const meta = card.querySelector('.result-meta');
      expect(meta.innerHTML).not.toContain('<script>');
    });

    it('handles result with no text field', () => {
      const card = renderer._renderResult({ score: 0.5 }, 0);
      expect(card.classList.contains('search-result-card')).toBe(true);
      const title = card.querySelector('.result-title');
      expect(title).not.toBeNull();
      expect(title.textContent).toBe('Untitled Result');
    });
  });

  // =========================================================================
  // _parseResultText
  // =========================================================================

  describe('_parseResultText', () => {
    it('parses [Key]: Value format', () => {
      const result = renderer._parseResultText('[Title]: My Title');
      expect(result.title).toBe('My Title');
    });

    it('parses multiple lines', () => {
      const text = '[Title]: Page\n[URL]: https://x.com\n[Profile]: Main';
      const result = renderer._parseResultText(text);
      expect(result.title).toBe('Page');
      expect(result.url).toBe('https://x.com');
      expect(result.profile).toBe('Main');
    });

    it('normalizes key names (lowercase, spaces to underscores)', () => {
      const result = renderer._parseResultText('[Last Visited]: 2025-01-01\n[Visit Count]: 5');
      expect(result.last_visited).toBe('2025-01-01');
      expect(result.visit_count).toBe('5');
    });

    it('trims values', () => {
      const result = renderer._parseResultText('[Title]:   Spaced Title   ');
      expect(result.title).toBe('Spaced Title');
    });

    it('returns empty object for null input', () => {
      expect(renderer._parseResultText(null)).toEqual({});
    });

    it('returns empty object for undefined input', () => {
      expect(renderer._parseResultText(undefined)).toEqual({});
    });

    it('returns empty object for non-string input', () => {
      expect(renderer._parseResultText(42)).toEqual({});
    });

    it('returns empty object for empty string', () => {
      expect(renderer._parseResultText('')).toEqual({});
    });

    it('ignores lines without [Key]: Value format', () => {
      const text = 'plain text\n[Valid]: Key\nmore plain text';
      const result = renderer._parseResultText(text);
      expect(result.valid).toBe('Key');
      expect(Object.keys(result).length).toBe(1);
    });
  });

  // =========================================================================
  // _formatDate
  // =========================================================================

  describe('_formatDate', () => {
    it('returns "Today" for today\'s date', () => {
      const today = new Date().toISOString();
      expect(renderer._formatDate(today)).toBe('Today');
    });

    it('returns "Yesterday" for yesterday', () => {
      const yesterday = new Date(Date.now() - 86400000).toISOString();
      expect(renderer._formatDate(yesterday)).toBe('Yesterday');
    });

    it('returns "N days ago" for 2-6 days', () => {
      const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
      expect(renderer._formatDate(threeDaysAgo)).toBe('3 days ago');
    });

    it('returns "1 week ago" for exactly 7-13 days (singular)', () => {
      const oneWeekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      expect(renderer._formatDate(oneWeekAgo)).toBe('1 week ago');
    });

    it('returns "N weeks ago" for 14-29 days (plural)', () => {
      const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString();
      expect(renderer._formatDate(twoWeeksAgo)).toBe('2 weeks ago');
    });

    it('returns "1 month ago" for exactly 30-59 days (singular)', () => {
      const oneMonthAgo = new Date(Date.now() - 30 * 86400000).toISOString();
      expect(renderer._formatDate(oneMonthAgo)).toBe('1 month ago');
    });

    it('returns "N months ago" for 60-364 days (plural)', () => {
      const twoMonthsAgo = new Date(Date.now() - 60 * 86400000).toISOString();
      expect(renderer._formatDate(twoMonthsAgo)).toBe('2 months ago');
    });

    it('returns localized date string for 365+ days', () => {
      const twoYearsAgo = new Date(Date.now() - 730 * 86400000).toISOString();
      const result = renderer._formatDate(twoYearsAgo);
      // toLocaleDateString returns a string, not a relative format
      expect(typeof result).toBe('string');
      expect(result).not.toContain('ago');
    });

    it('returns input string when date parsing fails', () => {
      // Symbol will cause Date constructor to throw
      const sym = Symbol('bad');
      expect(renderer._formatDate(sym)).toBe(sym);
    });

    it('handles invalid date string gracefully', () => {
      // 'Invalid Date'.toLocaleDateString() may vary — just verify no throw
      const result = renderer._formatDate('not-a-date');
      expect(typeof result).toBe('string');
    });
  });

  // =========================================================================
  // _injectStyles
  // =========================================================================

  describe('_injectStyles', () => {
    it('injects style element', async () => {
      await renderer.render(makeSearchData(), container);
      const style = document.getElementById('search-results-renderer-styles');
      expect(style).not.toBeNull();
    });

    it('style contains expected CSS', async () => {
      await renderer.render(makeSearchData(), container);
      const style = document.getElementById('search-results-renderer-styles');
      expect(style.textContent).toContain('search-results-header');
      expect(style.textContent).toContain('search-result-card');
      expect(style.textContent).toContain('result-score');
    });
  });

  // =========================================================================
  // Full render integration
  // =========================================================================

  describe('full render integration', () => {
    it('renders complete search results with all metadata', async () => {
      const data = {
        results: [
          {
            score: 0.95,
            text: '[Title]: Example Site\n[URL]: https://example.com\n[Last Visited]: 2025-01-15\n[Visit Count]: 42\n[Profile]: Default',
            index_name: 'history',
          },
          {
            score: 0.72,
            text: '[Title]: Another Site\n[URL]: https://another.com',
            index_name: 'bookmarks',
          },
        ],
        total_found: 2,
        search_duration_ms: 250,
        indexes_searched: ['history', 'bookmarks'],
      };

      await renderer.render(data, container);

      // Header
      const header = container.querySelector('.search-results-header');
      expect(header).not.toBeNull();
      expect(header.textContent).toContain('2');
      expect(header.textContent).toContain('0.25s');
      expect(header.textContent).toContain('history, bookmarks');

      // Cards
      const cards = container.querySelectorAll('.search-result-card');
      expect(cards.length).toBe(2);

      // First card details
      const firstScore = cards[0].querySelector('.result-score');
      expect(firstScore.textContent).toBe('95%');

      const firstTitle = cards[0].querySelector('.result-title');
      expect(firstTitle.textContent).toBe('Example Site');

      const firstUrl = cards[0].querySelector('.result-url');
      expect(firstUrl.href).toBe('https://example.com/');

      const firstIndex = cards[0].querySelector('.index-badge');
      expect(firstIndex.textContent).toBe('history');
    });

    it('clears container before rendering', async () => {
      container.innerHTML = '<p>old content</p>';
      await renderer.render(makeSearchData(), container);
      expect(container.querySelector('p')).toBeNull();
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  describe('error handling', () => {
    it('logs and shows error for render failures', async () => {
      // null data causes TypeError
      await renderer.render(null, container);
      const error = container.querySelector('.render-error');
      expect(error).not.toBeNull();
      expect(mockLog.error).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Lifecycle
  // =========================================================================

  describe('lifecycle', () => {
    it('create-use-dispose cycle', async () => {
      const r = new SearchResultsRenderer();
      r.log = mockLog;

      await r.render(makeSearchData(), container);
      expect(container.querySelector('.search-result-card')).not.toBeNull();

      r.dispose();
      expect(r.injectedStyles.size).toBe(0);
    });
  });

  // =========================================================================
  // window assignment
  // =========================================================================

  describe('window assignment', () => {
    it('assigns SearchResultsRenderer to window', () => {
      expect(window.SearchResultsRenderer).toBe(SearchResultsRenderer);
    });
  });
});
