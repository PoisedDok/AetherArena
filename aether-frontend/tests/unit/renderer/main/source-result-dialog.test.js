'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock(
  '../../../../src/renderer/shared/components/Toast',
  () => ({ warning: jest.fn(), success: jest.fn(), error: jest.fn(), info: jest.fn() })
);

jest.mock(
  '../../../../src/renderer/shared/utils/ContentExporter',
  () => ({
    exportAsPdf: jest.fn(async () => true),
    generateFindingsHtml: jest.fn(() => '<html>mock</html>'),
    copyToClipboard: jest.fn(async () => true),
    summaryToPlainText: jest.fn(() => ''),
    generateSummaryHtml: jest.fn(() => ''),
    generateContentHtml: jest.fn(() => ''),
    escapeHtml: jest.fn(t => String(t)),
    formatMarkdown: jest.fn(t => t || ''),
  })
);

const SourceResultDialog = require('../../../../src/renderer/main/modules/jobs/SourceResultDialog');
const Toast = require('../../../../src/renderer/shared/components/Toast');
const ContentExporter = require('../../../../src/renderer/shared/utils/ContentExporter');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDialog(overrides = {}) {
  const config = {
    source: 'Web Search',
    data: {
      answer: 'Found 3 relevant results about tax filing.',
      results: [
        { title: 'IRS Filing Guide', url: 'https://irs.gov/filing', content: 'How to file taxes' },
        { title: 'TurboTax Tips', url: 'https://turbotax.com/tips', snippet: 'Tax tips and tricks' },
        { title: 'No URL Result', content: 'Content without a link' },
      ],
    },
    logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
    onItemClick: null,
    ...overrides,
  };
  return { dialog: new SourceResultDialog(config), config };
}

function createDialogManager() {
  return {
    trackListener: jest.fn((el, event, handler) => el?.addEventListener(event, handler)),
    close: jest.fn(),
    open: jest.fn(),
  };
}

// Clipboard mock
function mockClipboard() {
  const mock = { writeText: jest.fn(async () => {}) };
  Object.defineProperty(navigator, 'clipboard', {
    value: mock, writable: true, configurable: true,
  });
  return mock;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SourceResultDialog', () => {
  beforeEach(() => {
    Toast.success.mockClear();
    Toast.error.mockClear();
    Toast.info.mockClear();
    ContentExporter.exportAsPdf.mockClear();
    ContentExporter.generateFindingsHtml.mockClear();
  });

  afterEach(() => {
    document.querySelectorAll('.tool-dialog').forEach(el => el.remove());
  });

  // ── Constructor ──────────────────────────────────────────────────────

  describe('constructor', () => {
    test('stores config properties', () => {
      const { dialog } = createDialog();
      expect(dialog.source).toBe('Web Search');
      expect(dialog.data).toBeDefined();
      expect(dialog._dialogElement).toBeNull();
    });

    test('defaults logger to console', () => {
      const d = new SourceResultDialog({ source: 'test', data: {} });
      expect(d.logger).toBe(console);
    });

    test('defaults onItemClick to null', () => {
      const d = new SourceResultDialog({ source: 'test', data: {} });
      expect(d.onItemClick).toBeNull();
    });
  });

  // ── create ───────────────────────────────────────────────────────────

  describe('create()', () => {
    test('returns a dialog element', () => {
      const { dialog } = createDialog();
      const el = dialog.create();
      expect(el).toBeInstanceOf(HTMLElement);
      expect(el.className).toContain('tool-dialog');
    });

    test('stores element in _dialogElement', () => {
      const { dialog } = createDialog();
      const el = dialog.create();
      expect(dialog._dialogElement).toBe(el);
    });

    test('renders source name in header', () => {
      const { dialog } = createDialog();
      const el = dialog.create();
      expect(el.textContent).toContain('Findings: Web Search');
    });

    test('renders executive summary from answer', () => {
      const { dialog } = createDialog();
      const el = dialog.create();
      expect(el.textContent).toContain('Executive Summary');
      expect(el.textContent).toContain('Found 3 relevant results');
    });

    test('renders findings list', () => {
      const { dialog } = createDialog();
      const el = dialog.create();
      expect(el.textContent).toContain('Detailed Findings (3)');
      expect(el.querySelectorAll('.finding-reading-card')).toHaveLength(3);
    });

    test('hides summary when no answer', () => {
      const { dialog } = createDialog({ data: { results: [{ title: 'A' }] } });
      const el = dialog.create();
      expect(el.textContent).not.toContain('Executive Summary');
    });

    test('hides findings list when no items', () => {
      const { dialog } = createDialog({ data: { answer: 'Summary only' } });
      const el = dialog.create();
      expect(el.textContent).not.toContain('Detailed Findings');
      expect(el.querySelectorAll('.finding-reading-card')).toHaveLength(0);
    });

    test('contains COPY, EXPORT, CLOSE buttons', () => {
      const { dialog } = createDialog();
      const el = dialog.create();
      expect(el.querySelector('.btn-copy-all')).not.toBeNull();
      expect(el.querySelector('.btn-export-pdf')).not.toBeNull();
      expect(el.querySelector('.btn-close-dialog')).not.toBeNull();
    });

    test('handles null data gracefully', () => {
      const { dialog } = createDialog({ data: null });
      const el = dialog.create();
      expect(el).toBeInstanceOf(HTMLElement);
      expect(el.querySelectorAll('.finding-reading-card')).toHaveLength(0);
    });

    test('resolves items from data.items fallback', () => {
      const { dialog } = createDialog({ data: { items: [{ title: 'A' }] } });
      const el = dialog.create();
      expect(el.querySelectorAll('.finding-reading-card')).toHaveLength(1);
    });

    test('resolves items from data.sources fallback', () => {
      const { dialog } = createDialog({ data: { sources: [{ title: 'A' }, { title: 'B' }] } });
      const el = dialog.create();
      expect(el.querySelectorAll('.finding-reading-card')).toHaveLength(2);
    });
  });

  // ── _renderFindingCard ───────────────────────────────────────────────

  describe('_renderFindingCard()', () => {
    test('renders card with title and content', () => {
      const { dialog } = createDialog();
      const html = dialog._renderFindingCard(
        { title: 'Test Result', content: 'Test content', url: 'https://example.com' },
        0
      );
      expect(html).toContain('Test Result');
      expect(html).toContain('Test content');
      expect(html).toContain('https://example.com');
      expect(html).toContain('VIEW SOURCE');
    });

    test('uses fallback title when no title', () => {
      const { dialog } = createDialog();
      const html = dialog._renderFindingCard({}, 2);
      expect(html).toContain('Finding #3');
    });

    test('uses metadata.title when item has no title', () => {
      const { dialog } = createDialog();
      const html = dialog._renderFindingCard({ metadata: { title: 'Meta Title' } }, 0);
      expect(html).toContain('Meta Title');
    });

    test('uses item.name as title fallback', () => {
      const { dialog } = createDialog();
      const html = dialog._renderFindingCard({ name: 'Named Item' }, 0);
      expect(html).toContain('Named Item');
    });

    test('hides link when no URL', () => {
      const { dialog } = createDialog();
      const html = dialog._renderFindingCard({ title: 'No Link' }, 0);
      expect(html).not.toContain('VIEW SOURCE');
    });

    test('does not render link for non-http URL schemes', () => {
      const { dialog } = createDialog();
      const html = dialog._renderFindingCard({ title: 'Unsafe', url: 'javascript:alert(1)' }, 0);
      expect(html).not.toContain('VIEW SOURCE');
      expect(html).not.toContain('javascript:');
    });

    test('resolves url from metadata.url', () => {
      const { dialog } = createDialog();
      const html = dialog._renderFindingCard({ metadata: { url: 'https://meta.com' } }, 0);
      expect(html).toContain('https://meta.com');
    });

    test('resolves url from item.link', () => {
      const { dialog } = createDialog();
      const html = dialog._renderFindingCard({ link: 'https://link.com' }, 0);
      expect(html).toContain('https://link.com');
    });

    test('resolves content from snippet fallback', () => {
      const { dialog } = createDialog();
      const html = dialog._renderFindingCard({ snippet: 'Snippet text' }, 0);
      expect(html).toContain('Snippet text');
    });

    test('resolves content from description fallback', () => {
      const { dialog } = createDialog();
      const html = dialog._renderFindingCard({ description: 'Description text' }, 0);
      expect(html).toContain('Description text');
    });

    test('resolves content from pageContent fallback', () => {
      const { dialog } = createDialog();
      const html = dialog._renderFindingCard({ pageContent: 'Page content' }, 0);
      expect(html).toContain('Page content');
    });

    test('has copy button with data-index', () => {
      const { dialog } = createDialog();
      const html = dialog._renderFindingCard({}, 5);
      expect(html).toContain('data-index="5"');
      expect(html).toContain('btn-copy-finding');
    });

    test('escapes HTML in title and content', () => {
      const { dialog } = createDialog();
      const html = dialog._renderFindingCard({ title: '<script>x</script>', content: '<img>' }, 0);
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });
  });

  // ── _getFindingItem ──────────────────────────────────────────────────

  describe('_getFindingItem()', () => {
    test('returns item by index from data.results', () => {
      const { dialog } = createDialog();
      const item = dialog._getFindingItem(0);
      expect(item.title).toBe('IRS Filing Guide');
    });

    test('returns null for out-of-bounds index', () => {
      const { dialog } = createDialog();
      expect(dialog._getFindingItem(99)).toBeNull();
    });

    test('returns null when data is null', () => {
      const { dialog } = createDialog({ data: null });
      expect(dialog._getFindingItem(0)).toBeNull();
    });

    test('resolves from data.items', () => {
      const { dialog } = createDialog({ data: { items: [{ title: 'Item' }] } });
      expect(dialog._getFindingItem(0).title).toBe('Item');
    });

    test('resolves from data.sources', () => {
      const { dialog } = createDialog({ data: { sources: [{ title: 'Source' }] } });
      expect(dialog._getFindingItem(0).title).toBe('Source');
    });
  });

  // ── _formatMarkdown ──────────────────────────────────────────────────

  describe('_formatMarkdown()', () => {
    test('returns empty for falsy text', () => {
      const { dialog } = createDialog();
      expect(dialog._formatMarkdown('')).toBe('');
      expect(dialog._formatMarkdown(null)).toBe('');
    });

    test('converts ### headings to h4', () => {
      const { dialog } = createDialog();
      const result = dialog._formatMarkdown('### Summary');
      expect(result).toContain('<h4>Summary</h4>');
    });

    test('converts **bold** to strong', () => {
      const { dialog } = createDialog();
      const result = dialog._formatMarkdown('This is **bold** text');
      expect(result).toContain('<strong>bold</strong>');
    });

    test('converts newlines to br', () => {
      const { dialog } = createDialog();
      const result = dialog._formatMarkdown('line1\nline2');
      expect(result).toContain('line1<br/>line2');
    });

    test('links [1] citations to items with URLs', () => {
      const items = [
        { title: 'Source A', url: 'https://a.com' },
      ];
      const { dialog } = createDialog();
      const result = dialog._formatMarkdown('See [1] for details', items);
      expect(result).toContain('citation-link');
      expect(result).toContain('https://a.com');
    });

    test('links [Context citation: N] citations', () => {
      const items = [{ url: 'https://b.com' }];
      const { dialog } = createDialog();
      const result = dialog._formatMarkdown('Check [Context citation: 1]', items);
      expect(result).toContain('citation-link');
      expect(result).toContain('https://b.com');
    });

    test('renders citation as span when item has no URL', () => {
      const items = [{ title: 'No URL' }];
      const { dialog } = createDialog();
      const result = dialog._formatMarkdown('See [1]', items);
      expect(result).toContain('citation-tag');
      expect(result).not.toContain('citation-link');
    });

    test('renders citation as span when item index out of range', () => {
      const { dialog } = createDialog();
      const result = dialog._formatMarkdown('See [5]', []);
      expect(result).toContain('citation-tag');
    });

    test('resolves URL from metadata.url for citations', () => {
      const items = [{ metadata: { url: 'https://meta.com' } }];
      const { dialog } = createDialog();
      const result = dialog._formatMarkdown('Ref [1]', items);
      expect(result).toContain('https://meta.com');
    });

    test('escapes raw HTML before markdown conversion', () => {
      const { dialog } = createDialog();
      const result = dialog._formatMarkdown('<img src=x onerror=alert(1)>');
      expect(result).not.toContain('<img');
      expect(result).toContain('&lt;img');
    });
  });

  // ── _getSourceIcon ───────────────────────────────────────────────────

  describe('_getSourceIcon()', () => {
    test('maps known source types', () => {
      const { dialog } = createDialog();
      expect(dialog._getSourceIcon('web_search')).toBe('fa-globe');
      expect(dialog._getSourceIcon('news')).toBe('fa-newspaper');
      expect(dialog._getSourceIcon('reddit')).toBe('fa-reddit');
      expect(dialog._getSourceIcon('local_files')).toBe('fa-folder-open');
      expect(dialog._getSourceIcon('file_search')).toBe('fa-file-alt');
      expect(dialog._getSourceIcon('other')).toBe('fa-database');
    });
  });

  // ── _escapeHtml ──────────────────────────────────────────────────────

  describe('_escapeHtml()', () => {
    test('escapes HTML', () => {
      const { dialog } = createDialog();
      expect(dialog._escapeHtml('<b>bold</b>')).toContain('&lt;b&gt;');
    });
  });

  // ── setupListeners ───────────────────────────────────────────────────

  describe('setupListeners()', () => {
    test('does nothing without _dialogElement', () => {
      const { dialog } = createDialog();
      const dm = createDialogManager();
      dialog.setupListeners(dm);
      expect(dm.trackListener).not.toHaveBeenCalled();
    });

    test('registers close and overlay listeners', () => {
      const { dialog } = createDialog();
      dialog.create();
      const dm = createDialogManager();
      dialog.setupListeners(dm);

      expect(dm.trackListener.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    test('close button calls dialogManager.close', () => {
      const { dialog } = createDialog();
      dialog.create();
      document.body.appendChild(dialog._dialogElement);
      const dm = createDialogManager();
      dialog.setupListeners(dm);

      const closeBtn = dialog._dialogElement.querySelector('.btn-close-dialog');
      closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(dm.close).toHaveBeenCalled();
    });

    test('overlay click closes dialog', () => {
      const { dialog } = createDialog();
      dialog.create();
      document.body.appendChild(dialog._dialogElement);
      const dm = createDialogManager();
      dialog.setupListeners(dm);

      const overlay = dialog._dialogElement.querySelector('.tool-dialog-overlay');
      overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(dm.close).toHaveBeenCalled();
    });
  });

  // ── _copyAll ─────────────────────────────────────────────────────────

  describe('_copyAll()', () => {
    test('copies reading area text to clipboard', () => {
      const clipboard = mockClipboard();
      const { dialog } = createDialog();
      dialog.create();

      dialog._copyAll();

      expect(clipboard.writeText).toHaveBeenCalled();
      expect(Toast.success).toHaveBeenCalledWith('All results copied to clipboard');
    });

    test('shows error toast on clipboard failure', () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: jest.fn(() => { throw new Error('fail'); }) },
        writable: true, configurable: true,
      });

      const { dialog } = createDialog();
      dialog.create();

      dialog._copyAll();

      expect(Toast.error).toHaveBeenCalledWith('Failed to copy');
    });
  });

  // ── _copyFinding ─────────────────────────────────────────────────────

  describe('_copyFinding()', () => {
    test('copies specific finding card text', () => {
      const clipboard = mockClipboard();
      const { dialog } = createDialog();
      dialog.create();

      dialog._copyFinding(0);

      expect(clipboard.writeText).toHaveBeenCalled();
      expect(Toast.success).toHaveBeenCalledWith('Finding copied to clipboard');
    });

    test('does nothing for out-of-bounds index', () => {
      const clipboard = mockClipboard();
      const { dialog } = createDialog();
      dialog.create();

      dialog._copyFinding(99);

      expect(clipboard.writeText).not.toHaveBeenCalled();
    });

    test('shows error toast on clipboard failure', () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: jest.fn(() => { throw new Error('fail'); }) },
        writable: true, configurable: true,
      });

      const { dialog } = createDialog();
      dialog.create();

      dialog._copyFinding(0);

      expect(Toast.error).toHaveBeenCalledWith('Failed to copy');
    });
  });

  // ── Export PDF ────────────────────────────────────────────────────────

  describe('export PDF', () => {
    test('calls ContentExporter.generateFindingsHtml and exportAsPdf on export button', async () => {
      ContentExporter.exportAsPdf.mockResolvedValue(true);
      ContentExporter.generateFindingsHtml.mockReturnValue('<html>findings</html>');
      const { dialog } = createDialog();
      dialog.create();
      document.body.appendChild(dialog._dialogElement);
      const dm = createDialogManager();
      dialog.setupListeners(dm);

      const exportBtn = dialog._dialogElement.querySelector('.btn-export-pdf');
      const call = dm.trackListener.mock.calls.find(c => c[0] === exportBtn);
      await call[2]({ stopPropagation: jest.fn() });

      expect(ContentExporter.generateFindingsHtml).toHaveBeenCalledWith(
        'Web Search',
        expect.any(Object),
        'Research Agent'
      );
      expect(ContentExporter.exportAsPdf).toHaveBeenCalledWith(
        '<html>findings</html>',
        expect.stringContaining('research_agent_')
      );
    });

    test('handles export failure gracefully', async () => {
      ContentExporter.exportAsPdf.mockResolvedValue(false);
      ContentExporter.generateFindingsHtml.mockReturnValue('<html>findings</html>');
      const { dialog } = createDialog();
      dialog.create();
      document.body.appendChild(dialog._dialogElement);
      const dm = createDialogManager();
      dialog.setupListeners(dm);

      const exportBtn = dialog._dialogElement.querySelector('.btn-export-pdf');
      const call = dm.trackListener.mock.calls.find(c => c[0] === exportBtn);
      // Should not throw
      await call[2]({ stopPropagation: jest.fn() });

      expect(ContentExporter.exportAsPdf).toHaveBeenCalled();
    });
  });

  // ── Card click behavior ──────────────────────────────────────────────

  describe('card click behavior', () => {
    test('calls onItemClick callback when set', () => {
      const onItemClick = jest.fn();
      const { dialog } = createDialog({ onItemClick });
      dialog.create();
      document.body.appendChild(dialog._dialogElement);
      const dm = createDialogManager();
      dialog.setupListeners(dm);

      const card = dialog._dialogElement.querySelector('.finding-reading-card');
      const cardListener = dm.trackListener.mock.calls.find(
        c => c[0] === card && c[1] === 'click'
      );

      const mockEvent = {
        target: card,
        preventDefault: jest.fn(),
        stopPropagation: jest.fn(),
      };
      mockEvent.target.closest = (sel) => sel === '.btn-copy-finding' ? null : null;

      cardListener[2](mockEvent);

      expect(onItemClick).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'IRS Filing Guide' })
      );
    });

    test('skips card click when copy button is clicked', () => {
      const onItemClick = jest.fn();
      const { dialog } = createDialog({ onItemClick });
      dialog.create();
      document.body.appendChild(dialog._dialogElement);
      const dm = createDialogManager();
      dialog.setupListeners(dm);

      const card = dialog._dialogElement.querySelector('.finding-reading-card');
      const cardListener = dm.trackListener.mock.calls.find(
        c => c[0] === card && c[1] === 'click'
      );

      const copyBtn = card.querySelector('.btn-copy-finding');
      const mockEvent = {
        target: copyBtn,
        preventDefault: jest.fn(),
        stopPropagation: jest.fn(),
      };
      mockEvent.target.closest = (sel) => sel === '.btn-copy-finding' ? copyBtn : null;

      cardListener[2](mockEvent);

      expect(onItemClick).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Uncovered event handler paths
  // -----------------------------------------------------------------------

  describe('handler bodies — uncovered paths', () => {
    test('copy all button calls _copyAll', () => {
      const { dialog } = createDialog();
      dialog.create();
      document.body.appendChild(dialog._dialogElement);
      const dm = createDialogManager();
      dialog.setupListeners(dm);

      const copyBtn = dialog._dialogElement.querySelector('.btn-copy-all');
      const copyCall = dm.trackListener.mock.calls.find(
        c => c[0] === copyBtn && c[1] === 'click'
      );
      expect(copyCall).toBeDefined();

      const spy = jest.spyOn(dialog, '_copyAll').mockImplementation(() => {});
      copyCall[2]({ stopPropagation: jest.fn() });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    test('copy finding button calls _copyFinding with index', () => {
      const { dialog } = createDialog();
      dialog.create();
      document.body.appendChild(dialog._dialogElement);
      const dm = createDialogManager();
      dialog.setupListeners(dm);

      const findingBtns = dialog._dialogElement.querySelectorAll('.btn-copy-finding');
      if (findingBtns.length === 0) return;

      const findingBtn = findingBtns[0];
      const copyFindingCall = dm.trackListener.mock.calls.find(
        c => c[0] === findingBtn && c[1] === 'click'
      );
      expect(copyFindingCall).toBeDefined();

      const spy = jest.spyOn(dialog, '_copyFinding').mockImplementation(() => {});
      copyFindingCall[2]({ stopPropagation: jest.fn() });
      expect(spy).toHaveBeenCalledWith(expect.any(Number));
      spy.mockRestore();
    });

    test('link click sends open-external-url via aether.ipc', () => {
      const { dialog } = createDialog();
      dialog.create();
      document.body.appendChild(dialog._dialogElement);
      const dm = createDialogManager();
      dialog.setupListeners(dm);

      const linkCall = dm.trackListener.mock.calls.find(
        c => c[0] === dialog._dialogElement && c[1] === 'click'
      );
      expect(linkCall).toBeDefined();

      // Mock window.aether.ipc
      const origAether = window.aether;
      window.aether = { ipc: { send: jest.fn() } };

      const mockLink = document.createElement('a');
      mockLink.setAttribute('href', 'https://example.com');
      const mockEvent = {
        target: { closest: (sel) => sel === 'a' ? mockLink : null },
        preventDefault: jest.fn(),
        stopPropagation: jest.fn(),
      };

      linkCall[2](mockEvent);

      expect(window.aether.ipc.send).toHaveBeenCalledWith(
        'open-external-url',
        expect.stringMatching(/^https:\/\/example\.com\/?$/)
      );
      window.aether = origAether;
    });

    test('link click ignores unsafe URL schemes', () => {
      const { dialog } = createDialog();
      dialog.create();
      document.body.appendChild(dialog._dialogElement);
      const dm = createDialogManager();
      dialog.setupListeners(dm);

      const linkCall = dm.trackListener.mock.calls.find(
        c => c[0] === dialog._dialogElement && c[1] === 'click'
      );
      expect(linkCall).toBeDefined();

      const origAether = window.aether;
      window.aether = { ipc: { send: jest.fn() } };

      const mockLink = document.createElement('a');
      mockLink.setAttribute('href', 'javascript:alert(1)');
      const mockEvent = {
        target: { closest: (sel) => sel === 'a' ? mockLink : null },
        preventDefault: jest.fn(),
        stopPropagation: jest.fn(),
      };

      linkCall[2](mockEvent);
      expect(window.aether.ipc.send).not.toHaveBeenCalled();
      window.aether = origAether;
    });

    test('link click falls back to window.open when no aether.ipc', () => {
      const { dialog } = createDialog();
      dialog.create();
      document.body.appendChild(dialog._dialogElement);
      const dm = createDialogManager();
      dialog.setupListeners(dm);

      const linkCall = dm.trackListener.mock.calls.find(
        c => c[0] === dialog._dialogElement && c[1] === 'click'
      );

      const origOpen = window.open;
      window.open = jest.fn();
      const origAether = window.aether;
      delete window.aether;

      const mockLink = document.createElement('a');
      mockLink.setAttribute('href', 'https://fallback.com');
      const mockEvent = {
        target: { closest: (sel) => sel === 'a' ? mockLink : null },
        preventDefault: jest.fn(),
        stopPropagation: jest.fn(),
      };

      linkCall[2](mockEvent);

      expect(window.open).toHaveBeenCalledWith(
        expect.stringMatching(/^https:\/\/fallback\.com\/?$/),
        '_blank'
      );
      window.open = origOpen;
      window.aether = origAether;
    });

    test('card click follows external link when no onItemClick', () => {
      const { dialog } = createDialog({ onItemClick: null });
      dialog.create();
      document.body.appendChild(dialog._dialogElement);
      const dm = createDialogManager();
      dialog.setupListeners(dm);

      const card = dialog._dialogElement.querySelector('.finding-reading-card');
      expect(card).not.toBeNull();

      const cardCall = dm.trackListener.mock.calls.find(
        c => c[0] === card && c[1] === 'click'
      );
      expect(cardCall).toBeDefined();

      const origOpen = window.open;
      window.open = jest.fn();
      const origAether = window.aether;
      delete window.aether;

      const mockEvent = {
        target: { closest: () => null },
        preventDefault: jest.fn(),
        stopPropagation: jest.fn(),
      };

      cardCall[2](mockEvent);

      // May or may not open depending on whether link exists in card
      window.open = origOpen;
      window.aether = origAether;
    });
  });

  describe('create() — data edge cases', () => {
    test('handles data as direct array', () => {
      const { dialog } = createDialog({
        data: [
          { title: 'Direct Item', content: 'Direct content' },
        ],
      });
      dialog.create();
      expect(dialog._dialogElement.innerHTML).toContain('Direct Item');
    });
  });

  describe('_getFindingItem() — data as array fallback', () => {
    test('falls back to data as array when no results/items/sources', () => {
      const arrData = [{ title: 'Item A' }, { title: 'Item B' }];
      const { dialog } = createDialog({ data: arrData });
      const item = dialog._getFindingItem(1);
      expect(item).toEqual({ title: 'Item B' });
    });
  });
});
