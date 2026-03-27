'use strict';

// ---------------------------------------------------------------------------
// ResultsViewerDialog.js — Unit tests
// ---------------------------------------------------------------------------
// Source: src/renderer/main/modules/agents/components/dialogs/ResultsViewerDialog.js (242 lines)
// Standalone dialog. Renders research results by source with previews, links.
// Complex _renderResults with multiple response shapes, item field fallbacks.
// ---------------------------------------------------------------------------

jest.mock(
  '../../../../src/renderer/shared/components/Toast',
  () => ({})
);

const ResultsViewerDialog = require(
  '../../../../src/renderer/main/modules/agents/components/dialogs/ResultsViewerDialog'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseHtml(htmlStr) {
  const container = document.createElement('div');
  container.innerHTML = htmlStr.trim();
  return container;
}

function createDialog(overrides = {}) {
  return new ResultsViewerDialog({
    toolName: 'research',
    results: { results: {}, sources_used: [] },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ResultsViewerDialog', () => {
  let dialog;
  let logger;

  beforeEach(() => {
    logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('stores toolName from config', () => {
      const d = createDialog({ toolName: 'research' });
      expect(d.toolName).toBe('research');
    });

    it('stores results from config', () => {
      const results = { results: { src: [] } };
      const d = createDialog({ results });
      expect(d.results).toBe(results);
    });

    it('stores logger from config', () => {
      const d = createDialog({ logger });
      expect(d.logger).toBe(logger);
    });

    it('defaults logger to console when not provided', () => {
      const d = new ResultsViewerDialog({
        toolName: 'x',
        results: { results: {} },
      });
      expect(d.logger).toBe(console);
    });

    it('initializes _dialogElement to null', () => {
      const d = createDialog();
      expect(d._dialogElement).toBeNull();
    });

    it('throws when toolName is missing', () => {
      expect(() => new ResultsViewerDialog({ results: {} }))
        .toThrow('ResultsViewerDialog: Tool name is required');
    });

    it('throws when toolName is empty string', () => {
      expect(() => new ResultsViewerDialog({ toolName: '', results: {} }))
        .toThrow('ResultsViewerDialog: Tool name is required');
    });

    it('throws when results is missing', () => {
      expect(() => new ResultsViewerDialog({ toolName: 'x' }))
        .toThrow('ResultsViewerDialog: Results object is required');
    });

    it('throws when results is null', () => {
      expect(() => new ResultsViewerDialog({ toolName: 'x', results: null }))
        .toThrow('ResultsViewerDialog: Results object is required');
    });
  });

  // =========================================================================
  // create()
  // =========================================================================

  describe('create()', () => {
    beforeEach(() => {
      dialog = createDialog({
        toolName: 'research',
        results: { results: { perplexica: [{ title: 'Test', url: 'http://a.com' }] }, sources_used: ['perplexica'] },
        logger,
      });
    });

    it('returns an HTMLElement', () => {
      const el = dialog.create();
      expect(el).toBeInstanceOf(HTMLElement);
    });

    it('sets _dialogElement reference', () => {
      dialog.create();
      expect(dialog._dialogElement).not.toBeNull();
    });

    it('has tool-dialog and tool-dialog-wide classes', () => {
      const el = dialog.create();
      expect(el.classList.contains('tool-dialog')).toBe(true);
      expect(el.classList.contains('tool-dialog-wide')).toBe(true);
    });

    it('renders overlay', () => {
      const el = dialog.create();
      expect(el.querySelector('.tool-dialog-overlay')).not.toBeNull();
    });

    it('renders header with formatted tool name', () => {
      const el = dialog.create();
      const header = el.querySelector('.tool-dialog-header h3');
      expect(header).not.toBeNull();
      expect(header.textContent).toContain('Research');
    });

    it('renders fa-search icon in header', () => {
      const el = dialog.create();
      expect(el.querySelector('.tool-dialog-header .fa-search')).not.toBeNull();
    });

    it('renders close button with aria-label', () => {
      const el = dialog.create();
      const closeBtn = el.querySelector('.btn-close-dialog');
      expect(closeBtn).not.toBeNull();
      expect(closeBtn.getAttribute('aria-label')).toBe('Close');
    });

    it('renders dialog body with results', () => {
      const el = dialog.create();
      expect(el.querySelector('.tool-dialog-body')).not.toBeNull();
    });

    it('formats multi-word tool name', () => {
      const d = createDialog({ toolName: 'deep_research' });
      const el = d.create();
      expect(el.querySelector('h3').textContent).toContain('Deep Research');
    });

    it('escapes HTML in tool name', () => {
      const d = createDialog({ toolName: '<script>xss</script>' });
      const el = d.create();
      expect(el.innerHTML).not.toContain('<script>xss');
    });
  });

  // =========================================================================
  // setupListeners()
  // =========================================================================

  describe('setupListeners()', () => {
    it('logs error when dialog not yet created', () => {
      dialog = createDialog({ logger });
      // Don't call create()
      dialog.setupListeners({});
      expect(logger.error).toHaveBeenCalledWith(
        'ResultsViewerDialog: Cannot setup listeners, dialog not created'
      );
    });

    it('calls dialogManager.trackListener for close button', () => {
      dialog = createDialog({ logger });
      dialog.create();
      const mgr = { trackListener: jest.fn(), close: jest.fn() };
      dialog.setupListeners(mgr);

      expect(mgr.trackListener).toHaveBeenCalledTimes(4);
      // First call: close button
      const [closeEl, closeEvent] = mgr.trackListener.mock.calls[0];
      expect(closeEl.classList.contains('btn-close-dialog')).toBe(true);
      expect(closeEvent).toBe('click');
    });

    it('calls dialogManager.trackListener for overlay', () => {
      dialog = createDialog({ logger });
      dialog.create();
      const mgr = { trackListener: jest.fn(), close: jest.fn() };
      dialog.setupListeners(mgr);

      const [overlayEl, overlayEvent] = mgr.trackListener.mock.calls[1];
      expect(overlayEl.classList.contains('tool-dialog-overlay')).toBe(true);
      expect(overlayEvent).toBe('click');
    });

    it('close button handler calls dialogManager.close()', () => {
      dialog = createDialog({ logger });
      dialog.create();
      const mgr = { trackListener: jest.fn(), close: jest.fn() };
      dialog.setupListeners(mgr);

      // Execute the close handler (now expects event with stopPropagation)
      const closeHandler = mgr.trackListener.mock.calls[0][2];
      closeHandler({ stopPropagation: jest.fn() });
      expect(mgr.close).toHaveBeenCalledTimes(1);
    });

    it('overlay click handler calls dialogManager.close()', () => {
      dialog = createDialog({ logger });
      dialog.create();
      const mgr = { trackListener: jest.fn(), close: jest.fn() };
      dialog.setupListeners(mgr);

      const overlayHandler = mgr.trackListener.mock.calls[1][2];
      overlayHandler({ stopPropagation: jest.fn() });
      expect(mgr.close).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // _renderResults()
  // =========================================================================

  describe('_renderResults()', () => {
    beforeEach(() => {
      dialog = createDialog({ logger });
    });

    describe('empty states', () => {
      it('returns empty state when response is null', () => {
        const html = dialog._renderResults(null);
        const dom = parseHtml(html);
        expect(dom.querySelector('.tool-results-empty-state')).not.toBeNull();
        expect(dom.textContent).toContain('No results were returned');
      });

      it('returns empty state when response is undefined', () => {
        const html = dialog._renderResults(undefined);
        expect(parseHtml(html).querySelector('.tool-results-empty-state')).not.toBeNull();
      });

      it('returns empty state when response has no results property', () => {
        const html = dialog._renderResults({});
        expect(parseHtml(html).querySelector('.tool-results-empty-state')).not.toBeNull();
      });

      it('returns empty state when response.results is null', () => {
        const html = dialog._renderResults({ results: null });
        expect(parseHtml(html).querySelector('.tool-results-empty-state')).not.toBeNull();
      });

      it('returns "no sources" state when sources array is empty', () => {
        const html = dialog._renderResults({ results: {}, sources_used: [] });
        const dom = parseHtml(html);
        expect(dom.querySelector('.tool-results-empty-state')).not.toBeNull();
        expect(dom.textContent).toContain('No sources returned data');
      });

      it('returns "no sources" when results has no keys and no sources_used', () => {
        const html = dialog._renderResults({ results: {} });
        const dom = parseHtml(html);
        expect(dom.textContent).toContain('No sources returned data');
      });
    });

    describe('sources derivation', () => {
      it('uses sources_used array when provided', () => {
        const response = {
          results: { perplexica: [{ title: 'A' }], searxng: [{ title: 'B' }] },
          sources_used: ['perplexica'],
        };
        const html = dialog._renderResults(response);
        const dom = parseHtml(html);
        const names = Array.from(dom.querySelectorAll('.result-source-name')).map(el => el.textContent);
        expect(names).toEqual(['perplexica']);
      });

      it('falls back to Object.keys(results) when sources_used is not an array', () => {
        const response = {
          results: { alpha: [{ title: 'A' }], beta: [{ title: 'B' }] },
          sources_used: 'not-array',
        };
        const html = dialog._renderResults(response);
        const dom = parseHtml(html);
        const names = Array.from(dom.querySelectorAll('.result-source-name')).map(el => el.textContent);
        expect(names).toContain('alpha');
        expect(names).toContain('beta');
      });

      it('falls back to Object.keys when sources_used is missing', () => {
        const response = {
          results: { src1: [{ title: 'T' }] },
        };
        const html = dialog._renderResults(response);
        expect(parseHtml(html).querySelector('.result-source-name').textContent).toBe('src1');
      });
    });

    describe('block formats', () => {
      it('handles block as direct array', () => {
        const response = {
          results: { src: [{ title: 'Item A' }, { title: 'Item B' }] },
          sources_used: ['src'],
        };
        const dom = parseHtml(dialog._renderResults(response));
        expect(dom.querySelectorAll('.result-item').length).toBe(2);
        expect(dom.querySelector('.result-source-count').textContent).toBe('2');
      });

      it('handles block as object with .results array', () => {
        const response = {
          results: { src: { results: [{ title: 'R1' }], total: 5 } },
          sources_used: ['src'],
        };
        const dom = parseHtml(dialog._renderResults(response));
        expect(dom.querySelectorAll('.result-item').length).toBe(1);
        expect(dom.querySelector('.result-source-count').textContent).toBe('5');
      });

      it('handles block as object with .items array', () => {
        const response = {
          results: { src: { items: [{ title: 'I1' }, { title: 'I2' }] } },
          sources_used: ['src'],
        };
        const dom = parseHtml(dialog._renderResults(response));
        expect(dom.querySelectorAll('.result-item').length).toBe(2);
      });

      it('uses block.total when present and finite', () => {
        const response = {
          results: { src: { results: [{ title: 'A' }], total: 42 } },
          sources_used: ['src'],
        };
        const dom = parseHtml(dialog._renderResults(response));
        expect(dom.querySelector('.result-source-count').textContent).toBe('42');
      });

      it('falls back to items.length when block.total is not finite', () => {
        const response = {
          results: { src: { results: [{ title: 'A' }, { title: 'B' }], total: NaN } },
          sources_used: ['src'],
        };
        const dom = parseHtml(dialog._renderResults(response));
        expect(dom.querySelector('.result-source-count').textContent).toBe('2');
      });

      it('renders empty source when block has no items', () => {
        const response = {
          results: { src: { results: [], total: 0 } },
          sources_used: ['src'],
        };
        const dom = parseHtml(dialog._renderResults(response));
        expect(dom.querySelector('.result-empty')).not.toBeNull();
        expect(dom.querySelector('.result-empty').textContent).toBe('No results from this source');
        expect(dom.querySelector('.result-source-count').textContent).toBe('0');
      });

      it('renders empty source for block as empty array', () => {
        const response = {
          results: { src: [] },
          sources_used: ['src'],
        };
        const dom = parseHtml(dialog._renderResults(response));
        expect(dom.querySelector('.result-empty')).not.toBeNull();
      });

      it('skips source when block is null/undefined in results', () => {
        const response = {
          results: { src: null },
          sources_used: ['src'],
        };
        const html = dialog._renderResults(response);
        // block is null, returns '' for this source, but summary still shows
        expect(html).toContain('results-summary');
      });

      it('handles block as object with neither results nor items', () => {
        const response = {
          results: { src: { total: 10 } },
          sources_used: ['src'],
        };
        const dom = parseHtml(dialog._renderResults(response));
        // items defaults to [], so renders empty source
        expect(dom.querySelector('.result-empty')).not.toBeNull();
      });
    });

    describe('item rendering', () => {
      it('renders item title', () => {
        const response = {
          results: { src: [{ title: 'My Title' }] },
          sources_used: ['src'],
        };
        const dom = parseHtml(dialog._renderResults(response));
        // .trim() required: template literal indentation adds whitespace around bare text nodes
        expect(dom.querySelector('.result-item-title').textContent.trim()).toBe('My Title');
      });

      it('falls back to item.name for title', () => {
        const response = {
          results: { src: [{ name: 'Named Item' }] },
          sources_used: ['src'],
        };
        expect(parseHtml(dialog._renderResults(response)).querySelector('.result-item-title').textContent.trim())
          .toBe('Named Item');
      });

      it('falls back to item.file_name for title', () => {
        const response = {
          results: { src: [{ file_name: 'document.pdf' }] },
          sources_used: ['src'],
        };
        expect(parseHtml(dialog._renderResults(response)).querySelector('.result-item-title').textContent.trim())
          .toBe('document.pdf');
      });

      it('uses "Untitled" when no title field', () => {
        const response = {
          results: { src: [{}] },
          sources_used: ['src'],
        };
        expect(parseHtml(dialog._renderResults(response)).querySelector('.result-item-title').textContent.trim())
          .toBe('Untitled');
      });

      it('renders title as link when url present', () => {
        const response = {
          results: { src: [{ title: 'Link', url: 'http://example.com' }] },
          sources_used: ['src'],
        };
        const dom = parseHtml(dialog._renderResults(response));
        const link = dom.querySelector('.result-item-title a');
        expect(link).not.toBeNull();
        expect(link.getAttribute('href')).toBe('http://example.com');
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
        expect(link.textContent).toBe('Link');
      });

      it('falls back to item.link for url', () => {
        const response = {
          results: { src: [{ title: 'T', link: 'http://link.com' }] },
          sources_used: ['src'],
        };
        expect(parseHtml(dialog._renderResults(response)).querySelector('a').getAttribute('href'))
          .toBe('http://link.com');
      });

      it('falls back to item.href for url', () => {
        const response = {
          results: { src: [{ title: 'T', href: 'http://href.com' }] },
          sources_used: ['src'],
        };
        expect(parseHtml(dialog._renderResults(response)).querySelector('a').getAttribute('href'))
          .toBe('http://href.com');
      });

      it('renders plain title when no url', () => {
        const response = {
          results: { src: [{ title: 'No Link' }] },
          sources_used: ['src'],
        };
        const dom = parseHtml(dialog._renderResults(response));
        expect(dom.querySelector('.result-item-title a')).toBeNull();
        expect(dom.querySelector('.result-item-title').textContent.trim()).toBe('No Link');
      });

      it('renders excerpt from content', () => {
        const response = {
          results: { src: [{ title: 'T', content: 'Some content text' }] },
          sources_used: ['src'],
        };
        const dom = parseHtml(dialog._renderResults(response));
        expect(dom.querySelector('.result-item-excerpt').textContent).toBe('Some content text');
      });

      it('falls back to chunk_text for content', () => {
        const response = {
          results: { src: [{ title: 'T', chunk_text: 'Chunk text here' }] },
          sources_used: ['src'],
        };
        expect(parseHtml(dialog._renderResults(response)).querySelector('.result-item-excerpt').textContent)
          .toBe('Chunk text here');
      });

      it('falls back to description for content', () => {
        const response = {
          results: { src: [{ title: 'T', description: 'Desc here' }] },
          sources_used: ['src'],
        };
        expect(parseHtml(dialog._renderResults(response)).querySelector('.result-item-excerpt').textContent)
          .toBe('Desc here');
      });

      it('truncates excerpt to 180 chars with ellipsis', () => {
        const longContent = 'A'.repeat(200);
        const response = {
          results: { src: [{ title: 'T', content: longContent }] },
          sources_used: ['src'],
        };
        const dom = parseHtml(dialog._renderResults(response));
        const excerpt = dom.querySelector('.result-item-excerpt').textContent;
        expect(excerpt.length).toBe(183); // 180 + '...'
        expect(excerpt.endsWith('...')).toBe(true);
      });

      it('does not add ellipsis for content <= 180 chars', () => {
        const response = {
          results: { src: [{ title: 'T', content: 'Short content' }] },
          sources_used: ['src'],
        };
        const excerpt = parseHtml(dialog._renderResults(response)).querySelector('.result-item-excerpt').textContent;
        expect(excerpt).toBe('Short content');
        expect(excerpt.endsWith('...')).toBe(false);
      });

      it('omits excerpt when no content', () => {
        const response = {
          results: { src: [{ title: 'T' }] },
          sources_used: ['src'],
        };
        expect(parseHtml(dialog._renderResults(response)).querySelector('.result-item-excerpt')).toBeNull();
      });

      it('renders URL in result-item-url when url present', () => {
        const response = {
          results: { src: [{ title: 'T', url: 'http://a.com/page' }] },
          sources_used: ['src'],
        };
        expect(parseHtml(dialog._renderResults(response)).querySelector('.result-item-url').textContent)
          .toBe('http://a.com/page');
      });

      it('omits URL display when no url', () => {
        const response = {
          results: { src: [{ title: 'T' }] },
          sources_used: ['src'],
        };
        expect(parseHtml(dialog._renderResults(response)).querySelector('.result-item-url')).toBeNull();
      });
    });

    describe('pagination (>10 items)', () => {
      it('shows at most 10 items', () => {
        const items = Array.from({ length: 15 }, (_, i) => ({ title: `Item ${i}` }));
        const response = { results: { src: items }, sources_used: ['src'] };
        const dom = parseHtml(dialog._renderResults(response));
        expect(dom.querySelectorAll('.result-item').length).toBe(10);
      });

      it('shows "+N more" indicator when >10 items', () => {
        const items = Array.from({ length: 15 }, (_, i) => ({ title: `Item ${i}` }));
        const response = { results: { src: items }, sources_used: ['src'] };
        const dom = parseHtml(dialog._renderResults(response));
        expect(dom.querySelector('.result-more').textContent).toContain('+ 5 more');
      });

      it('does not show "more" when exactly 10 items', () => {
        const items = Array.from({ length: 10 }, (_, i) => ({ title: `Item ${i}` }));
        const response = { results: { src: items }, sources_used: ['src'] };
        expect(parseHtml(dialog._renderResults(response)).querySelector('.result-more')).toBeNull();
      });

      it('does not show "more" when less than 10 items', () => {
        const response = { results: { src: [{ title: 'A' }] }, sources_used: ['src'] };
        expect(parseHtml(dialog._renderResults(response)).querySelector('.result-more')).toBeNull();
      });
    });

    describe('summary section', () => {
      it('shows source count in summary', () => {
        const response = {
          results: { a: [{ title: 'A' }], b: [{ title: 'B' }] },
          sources_used: ['a', 'b'],
        };
        const dom = parseHtml(dialog._renderResults(response));
        expect(dom.querySelector('.results-summary').textContent).toContain('2');
        expect(dom.querySelector('.results-summary').textContent).toContain('sources');
      });

      it('shows total result count in summary', () => {
        const response = {
          results: { a: [{ title: '1' }, { title: '2' }], b: [{ title: '3' }] },
          sources_used: ['a', 'b'],
        };
        const dom = parseHtml(dialog._renderResults(response));
        expect(dom.querySelector('.results-summary').textContent).toContain('3');
        expect(dom.querySelector('.results-summary').textContent).toContain('results');
      });
    });

    describe('HTML escaping', () => {
      it('escapes source name', () => {
        const response = {
          results: { '<script>': [{ title: 'T' }] },
          sources_used: ['<script>'],
        };
        const html = dialog._renderResults(response);
        expect(html).not.toContain('<script>');
        // The source name is escaped in the rendered HTML
      });

      it('escapes item title', () => {
        const response = {
          results: { s: [{ title: '<b>bold</b>' }] },
          sources_used: ['s'],
        };
        const html = dialog._renderResults(response);
        expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
      });

      it('escapes URL in href attribute', () => {
        const response = {
          results: { s: [{ title: 'T', url: 'http://x.com?q=<script>' }] },
          sources_used: ['s'],
        };
        const html = dialog._renderResults(response);
        expect(html).not.toContain('url: <script>');
      });
    });
  });

  // =========================================================================
  // _calculateTotalResults()
  // =========================================================================

  describe('_calculateTotalResults()', () => {
    beforeEach(() => {
      dialog = createDialog({ logger });
    });

    it('returns 0 for null', () => {
      expect(dialog._calculateTotalResults(null)).toBe(0);
    });

    it('returns 0 for empty object', () => {
      expect(dialog._calculateTotalResults({})).toBe(0);
    });

    it('counts array block length', () => {
      expect(dialog._calculateTotalResults({ a: [1, 2, 3] })).toBe(3);
    });

    it('uses block.total when finite', () => {
      expect(dialog._calculateTotalResults({ a: { results: [1], total: 10 } })).toBe(10);
    });

    it('falls back to items length when total not finite', () => {
      expect(dialog._calculateTotalResults({ a: { results: [1, 2], total: NaN } })).toBe(2);
    });

    it('uses block.items when block.results is not an array', () => {
      expect(dialog._calculateTotalResults({ a: { items: [1, 2, 3] } })).toBe(3);
    });

    it('sums across multiple sources', () => {
      expect(dialog._calculateTotalResults({
        a: [1, 2],
        b: { results: [1], total: 5 },
        c: { items: [1, 2, 3] },
      })).toBe(10); // 2 + 5 + 3
    });

    it('ignores non-object, non-array values', () => {
      expect(dialog._calculateTotalResults({ a: 'string', b: 42, c: null })).toBe(0);
    });

    it('handles mixed blocks with some empty', () => {
      expect(dialog._calculateTotalResults({
        a: [],
        b: { results: [] },
        c: [{ x: 1 }],
      })).toBe(1);
    });
  });

  // =========================================================================
  // _formatAgentName()
  // =========================================================================

  describe('_formatAgentName()', () => {
    beforeEach(() => {
      dialog = createDialog();
    });

    it('capitalizes single word', () => {
      expect(dialog._formatAgentName('research')).toBe('Research');
    });

    it('replaces underscores with spaces and capitalizes', () => {
      expect(dialog._formatAgentName('deep_research')).toBe('Deep Research');
    });

    it('returns "Unknown" for empty string', () => {
      expect(dialog._formatAgentName('')).toBe('Unknown');
    });

    it('returns "Unknown" for null', () => {
      expect(dialog._formatAgentName(null)).toBe('Unknown');
    });

    it('returns "Unknown" for undefined', () => {
      expect(dialog._formatAgentName(undefined)).toBe('Unknown');
    });
  });

  // =========================================================================
  // _escapeHtml()
  // =========================================================================

  describe('_escapeHtml()', () => {
    beforeEach(() => {
      dialog = createDialog();
    });

    it('escapes < and >', () => {
      expect(dialog._escapeHtml('<div>')).toContain('&lt;');
      expect(dialog._escapeHtml('<div>')).toContain('&gt;');
    });

    it('escapes &', () => {
      expect(dialog._escapeHtml('A & B')).toContain('&amp;');
    });

    it('passes through safe text', () => {
      expect(dialog._escapeHtml('Hello World')).toBe('Hello World');
    });

    it('converts numbers to string', () => {
      expect(dialog._escapeHtml(42)).toBe('42');
    });
  });

  // =========================================================================
  // cleanup()
  // =========================================================================

  describe('cleanup()', () => {
    it('nulls _dialogElement', () => {
      dialog = createDialog();
      dialog.create();
      expect(dialog._dialogElement).not.toBeNull();
      dialog.cleanup();
      expect(dialog._dialogElement).toBeNull();
    });

    it('does not throw when called without create()', () => {
      dialog = createDialog();
      expect(() => dialog.cleanup()).not.toThrow();
    });

    it('idempotent — can be called twice', () => {
      dialog = createDialog();
      dialog.create();
      dialog.cleanup();
      dialog.cleanup();
      expect(dialog._dialogElement).toBeNull();
    });
  });

  // =========================================================================
  // Integration
  // =========================================================================

  describe('integration', () => {
    it('full workflow: create, setupListeners, cleanup', () => {
      dialog = createDialog({
        toolName: 'research',
        results: {
          results: { perplexica: [{ title: 'Result', url: 'http://x.com', content: 'Content text' }] },
          sources_used: ['perplexica'],
        },
        logger,
      });

      const el = dialog.create();
      expect(el.querySelector('.result-item')).not.toBeNull();

      const mgr = { trackListener: jest.fn(), close: jest.fn() };
      dialog.setupListeners(mgr);
      expect(mgr.trackListener).toHaveBeenCalledTimes(4);

      dialog.cleanup();
      expect(dialog._dialogElement).toBeNull();
    });

    it('multi-source rendering', () => {
      dialog = createDialog({
        results: {
          results: {
            perplexica: [{ title: 'AI Result', url: 'http://a.com' }],
            searxng: [{ title: 'Fast Result 1' }, { title: 'Fast Result 2' }],
            local: { results: [{ title: 'Local Doc', file_name: 'doc.pdf' }], total: 1 },
          },
          sources_used: ['perplexica', 'searxng', 'local'],
        },
      });

      const el = dialog.create();
      const sources = el.querySelectorAll('.result-source');
      expect(sources.length).toBe(3);
      expect(el.querySelectorAll('.result-item').length).toBe(4); // 1 + 2 + 1
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('source in sources_used but not in results returns empty string for that section', () => {
      dialog = createDialog({
        results: {
          results: { a: [{ title: 'A' }] },
          sources_used: ['a', 'missing'],
        },
      });
      const el = dialog.create();
      // 'missing' source returns '' from the map, only 'a' renders
      expect(el.querySelectorAll('.result-source').length).toBe(1);
    });

    it('item with all fields renders completely', () => {
      dialog = createDialog({
        results: {
          results: { src: [{ title: 'T', url: 'http://u.com', content: 'C' }] },
          sources_used: ['src'],
        },
      });
      const el = dialog.create();
      const item = el.querySelector('.result-item');
      expect(item.querySelector('a')).not.toBeNull();
      expect(item.querySelector('.result-item-excerpt')).not.toBeNull();
      expect(item.querySelector('.result-item-url')).not.toBeNull();
    });

    it('item with no fields renders "Untitled" with no excerpt/url', () => {
      dialog = createDialog({
        results: {
          results: { src: [{}] },
          sources_used: ['src'],
        },
      });
      const el = dialog.create();
      const item = el.querySelector('.result-item');
      expect(item.querySelector('.result-item-title').textContent.trim()).toBe('Untitled');
      expect(item.querySelector('.result-item-excerpt')).toBeNull();
      expect(item.querySelector('.result-item-url')).toBeNull();
    });
  });
});
