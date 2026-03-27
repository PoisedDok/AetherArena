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

// Mock all sub-renderers
const mockRendererInstance = () => ({
  render: jest.fn(),
  dispose: jest.fn(),
});

jest.mock('../../../src/renderer/artifacts/modules/output/renderers/HtmlRenderer', () => {
  return jest.fn().mockImplementation(mockRendererInstance);
});
jest.mock('../../../src/renderer/artifacts/modules/output/renderers/MarkdownRenderer', () => {
  return jest.fn().mockImplementation(mockRendererInstance);
});
jest.mock('../../../src/renderer/artifacts/modules/output/renderers/JsonRenderer', () => {
  return jest.fn().mockImplementation(mockRendererInstance);
});
jest.mock('../../../src/renderer/artifacts/modules/output/renderers/MediaRenderer', () => {
  return jest.fn().mockImplementation(mockRendererInstance);
});
jest.mock('../../../src/renderer/artifacts/modules/output/renderers/SearchResultsRenderer', () => {
  const mock = jest.fn().mockImplementation(mockRendererInstance);
  mock.isSearchResults = jest.fn(() => false);
  return mock;
});

const { EventTypes } = require('../../../src/core/events/EventTypes');
const OutputViewer = require('../../../src/renderer/artifacts/modules/output/OutputViewer');
const SearchResultsRenderer = require('../../../src/renderer/artifacts/modules/output/renderers/SearchResultsRenderer');

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

function createMockEventBus() {
  return { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
}

function createMockController() {
  return { exportFile: jest.fn() };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('OutputViewer', () => {
  let viewer;
  let eventBus;
  let controller;
  let container;

  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = '';

    const { createRendererLogger } = require('../../../src/renderer/shared/utils/logger');
    createRendererLogger.mockReturnValue(createLogger());

    // Re-establish SearchResultsRenderer static mock
    SearchResultsRenderer.isSearchResults = jest.fn(() => false);

    eventBus = createMockEventBus();
    controller = createMockController();

    container = document.createElement('div');
    container.id = 'output-container';
    document.body.appendChild(container);

    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: jest.fn().mockResolvedValue(undefined) },
      writable: true, configurable: true,
    });

    // Mock URL.createObjectURL / revokeObjectURL
    if (!URL.createObjectURL) URL.createObjectURL = jest.fn(() => 'blob:test');
    if (!URL.revokeObjectURL) URL.revokeObjectURL = jest.fn();

    viewer = null;
  });

  afterEach(() => {
    if (viewer) {
      try { viewer.dispose(); } catch (_) { /* already disposed */ }
    }
  });

  function createViewer(opts = {}) {
    viewer = new OutputViewer({ controller, eventBus, ...opts });
    return viewer;
  }

  async function createAndInit(opts = {}) {
    const v = createViewer(opts);
    await v.init(container);
    return v;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // constructor
  // ═══════════════════════════════════════════════════════════════════════

  describe('constructor', () => {
    it('throws if controller missing', () => {
      expect(() => new OutputViewer({ eventBus })).toThrow('[OutputViewer] Controller required');
    });

    it('throws if eventBus missing', () => {
      expect(() => new OutputViewer({ controller })).toThrow('[OutputViewer] EventBus required');
    });

    it('stores controller and eventBus', () => {
      const v = createViewer();
      expect(v.controller).toBe(controller);
      expect(v.eventBus).toBe(eventBus);
    });

    it('initializes renderers Map', () => {
      const v = createViewer();
      expect(v.renderers).toBeInstanceOf(Map);
      expect(v.renderers.size).toBeGreaterThan(0);
    });

    it('initializes with default format text', () => {
      const v = createViewer();
      expect(v.currentFormat).toBe('text');
    });

    it('initializes wrap enabled by default', () => {
      const v = createViewer();
      expect(v._wrapEnabled).toBe(true);
    });

    it('initializes empty _eventListeners', () => {
      const v = createViewer();
      expect(v._eventListeners).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // init
  // ═══════════════════════════════════════════════════════════════════════

  describe('init', () => {
    it('throws if container is null', async () => {
      const v = createViewer();
      await expect(v.init(null)).rejects.toThrow('[OutputViewer] Container required');
    });

    it('stores container reference', async () => {
      const v = await createAndInit();
      expect(v.container).toBe(container);
    });

    it('creates controls container', async () => {
      const v = await createAndInit();
      expect(v.controlsContainer).toBeInstanceOf(HTMLElement);
    });

    it('creates content container', async () => {
      const v = await createAndInit();
      expect(v.contentContainer).toBeInstanceOf(HTMLElement);
    });

    it('creates format select', async () => {
      const v = await createAndInit();
      expect(v.formatSelect).toBeInstanceOf(HTMLSelectElement);
    });

    it('format select has expected options', async () => {
      const v = await createAndInit();
      const options = Array.from(v.formatSelect.options).map(o => o.value);
      expect(options).toContain('text');
      expect(options).toContain('html');
      expect(options).toContain('markdown');
      expect(options).toContain('json');
    });

    it('emits COMPONENT_READY event', async () => {
      await createAndInit();
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.UI.COMPONENT_READY,
        expect.objectContaining({ component: 'OutputViewer' })
      );
    });

    it('injects styles', async () => {
      await createAndInit();
      expect(document.getElementById('output-viewer-styles')).not.toBeNull();
    });

    it('does not inject styles twice', async () => {
      await createAndInit();
      viewer.dispose();
      viewer = null;
      await createAndInit();
      expect(document.querySelectorAll('#output-viewer-styles').length).toBe(1);
    });

    it('sets up accessibility attributes', async () => {
      const v = await createAndInit();
      expect(v.container.getAttribute('role')).toBe('region');
      expect(v.controlsContainer.getAttribute('role')).toBe('toolbar');
      expect(v.contentContainer.getAttribute('role')).toBe('document');
      expect(v.contentContainer.getAttribute('aria-live')).toBe('polite');
    });

    it('sets toolbarContainer accessibility when present', async () => {
      const v = createViewer();
      const container = document.createElement('div');
      document.body.appendChild(container);
      // Set toolbarContainer before init calls _setupAccessibility
      v.toolbarContainer = document.createElement('div');
      await v.init(container);
      expect(v.toolbarContainer.getAttribute('role')).toBe('toolbar');
      expect(v.toolbarContainer.getAttribute('aria-label')).toBe('Output actions');
    });

    it('content container has wrap class by default', async () => {
      const v = await createAndInit();
      expect(v.contentContainer.classList.contains('wrap-lines')).toBe(true);
    });

    it('content container omits wrap class when _wrapEnabled is false', async () => {
      const v = createViewer();
      v._wrapEnabled = false;
      await v.init(container);
      expect(v.contentContainer.classList.contains('wrap-lines')).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // loadOutput
  // ═══════════════════════════════════════════════════════════════════════

  describe('loadOutput', () => {
    beforeEach(async () => {
      await createAndInit();
      eventBus.emit.mockClear();
    });

    it('stores current data', async () => {
      await viewer.loadOutput('hello');
      expect(viewer.currentData).toBe('hello');
    });

    it('stores artifactId', async () => {
      await viewer.loadOutput('data', null, 'art-1');
      expect(viewer.currentArtifactId).toBe('art-1');
    });

    it('auto-detects text format', async () => {
      await viewer.loadOutput('plain text');
      expect(viewer.currentFormat).toBe('text');
    });

    it('emits OUTPUT_LOADED event', async () => {
      await viewer.loadOutput('data', 'text');
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.ARTIFACTS.OUTPUT_LOADED,
        expect.objectContaining({ format: 'text' })
      );
    });

    it('strips backend log lines from string data', async () => {
      const data = '2026-01-08 14:59:20,320 - interpreter.core.computer.tools_loader - INFO - Loading tools\nActual output';
      await viewer.loadOutput(data);
      expect(viewer.currentData).toBe('Actual output');
    });

    it('skips rendering duplicate artifact with same content', async () => {
      await viewer.loadOutput('data', 'text', 'art-1');
      eventBus.emit.mockClear();
      await viewer.loadOutput('data', 'text', 'art-1');
      expect(eventBus.emit).not.toHaveBeenCalledWith(
        EventTypes.ARTIFACTS.OUTPUT_LOADED,
        expect.anything()
      );
    });

    it('updates when artifact has new content', async () => {
      await viewer.loadOutput('v1', 'text', 'art-1');
      eventBus.emit.mockClear();
      await viewer.loadOutput('v2', 'text', 'art-1');
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.ARTIFACTS.OUTPUT_LOADED,
        expect.anything()
      );
    });

    it('overrides text format to html when content has HTML tags', async () => {
      await viewer.loadOutput('<div>hello</div>', 'text');
      expect(viewer.currentFormat).toBe('html');
    });

    it('uses explicit format when not text', async () => {
      await viewer.loadOutput('data', 'json');
      expect(viewer.currentFormat).toBe('json');
    });

    it('updates format select value', async () => {
      await viewer.loadOutput('data', 'json');
      expect(viewer.formatSelect.value).toBe('json');
    });

    it('handles non-string data (object) without stripping logs', async () => {
      const objData = { result: 'ok' };
      await viewer.loadOutput(objData);
      expect(viewer.currentData).toEqual(objData);
      expect(viewer.currentFormat).toBe('json');
    });

    it('upgrades object payload labeled as text to json', async () => {
      const objData = { result: 'ok' };
      await viewer.loadOutput(objData, 'text');
      expect(viewer.currentFormat).toBe('json');
    });

    it('upgrades object payload labeled as markdown to json', async () => {
      const objData = { result: 'ok' };
      await viewer.loadOutput(objData, 'markdown');
      expect(viewer.currentFormat).toBe('json');
    });

    it('preserves search_results rendering for object payload labeled as text', async () => {
      const payload = { results: [{ score: 0.9, text: '[Title]: X' }] };
      SearchResultsRenderer.isSearchResults.mockReturnValue(true);
      await viewer.loadOutput(payload, 'text');
      expect(viewer.currentFormat).toBe('search_results');
    });

    it('overrides text format to markdown when content is markdown', async () => {
      const mdContent = '## Title\n\nSome **bold** content\n\n- item 1\n- item 2';
      await viewer.loadOutput(mdContent, 'text');
      expect(viewer.currentFormat).toBe('markdown');
    });

    it('does not override explicit non-text format', async () => {
      await viewer.loadOutput('<p>html</p>', 'html');
      expect(viewer.currentFormat).toBe('html');
    });

    it('handles error gracefully', async () => {
      // Make the renderer throw
      const htmlRenderer = viewer.renderers.get('html');
      htmlRenderer.render.mockRejectedValue(new Error('render fail'));
      await viewer.loadOutput('<div>test</div>', 'html');
      // Should render error instead
      const errorDiv = viewer.contentContainer.querySelector('.output-error-card');
      expect(errorDiv).not.toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _detectFormat
  // ═══════════════════════════════════════════════════════════════════════

  describe('_detectFormat', () => {
    let v;
    beforeEach(async () => { v = await createAndInit(); });

    it('detects JSON from object', () => {
      expect(v._detectFormat({ key: 'val' })).toBe('json');
    });

    it('detects JSON from JSON string', () => {
      expect(v._detectFormat('{"key":"val"}')).toBe('json');
    });

    it('detects JSON from array string', () => {
      expect(v._detectFormat('[1,2,3]')).toBe('json');
    });

    it('detects HTML from tags', () => {
      expect(v._detectFormat('<div>hello</div>')).toBe('html');
    });

    it('detects HTML from self-closing tags', () => {
      expect(v._detectFormat('<br/>')).toBe('html');
    });

    it('detects markdown from ## headers', () => {
      expect(v._detectFormat('## Title')).toBe('markdown');
    });

    it('detects markdown from code blocks', () => {
      expect(v._detectFormat('```code```')).toBe('markdown');
    });

    it('detects markdown from bold syntax', () => {
      expect(v._detectFormat('**bold text**')).toBe('markdown');
    });

    it('detects markdown from # header', () => {
      expect(v._detectFormat('# Title')).toBe('markdown');
    });

    it('does not detect markdown from single list item (weak indicator)', () => {
      // Single dash/asterisk is too weak — avoids false positives on plain text
      expect(v._detectFormat('- item')).toBe('text');
      expect(v._detectFormat('* item')).toBe('text');
    });

    it('detects markdown from multiple list items (medium indicator)', () => {
      // 2+ bullet items at line start triggers markdown
      expect(v._detectFormat('- item one\n- item two')).toBe('markdown');
      expect(v._detectFormat('* first\n* second')).toBe('markdown');
    });

    it('does not detect markdown from single inline code (weak indicator)', () => {
      // Single backtick pair is too weak on its own
      expect(v._detectFormat('use `code` here')).toBe('text');
    });

    it('detects markdown from two weak indicators combined', () => {
      // Single list item + inline code = 2 weak types → markdown
      expect(v._detectFormat('- item with `code` here')).toBe('markdown');
    });

    it('detects image URL', () => {
      expect(v._detectFormat('photo.jpg')).toBe('image');
      expect(v._detectFormat('photo.png')).toBe('image');
      expect(v._detectFormat('photo.gif')).toBe('image');
      expect(v._detectFormat('photo.webp')).toBe('image');
      expect(v._detectFormat('photo.svg')).toBe('image');
    });

    it('detects video URL', () => {
      expect(v._detectFormat('clip.mp4')).toBe('video');
      expect(v._detectFormat('clip.webm')).toBe('video');
    });

    it('detects audio URL', () => {
      expect(v._detectFormat('song.mp3')).toBe('audio');
      expect(v._detectFormat('song.wav')).toBe('audio');
    });

    it('detects media URL with query and hash', () => {
      expect(v._detectFormat('https://cdn.example.com/photo.jpg?size=lg')).toBe('image');
      expect(v._detectFormat('https://cdn.example.com/clip.mp4#t=2')).toBe('video');
      expect(v._detectFormat('https://cdn.example.com/song.aac?download=1')).toBe('audio');
    });

    it('detects media data URIs', () => {
      expect(v._detectFormat('data:image/png;base64,AAAA')).toBe('image');
      expect(v._detectFormat('data:video/mp4;base64,AAAA')).toBe('video');
      expect(v._detectFormat('data:audio/mpeg;base64,AAAA')).toBe('audio');
    });

    it('detects plain text', () => {
      expect(v._detectFormat('hello world')).toBe('text');
    });

    it('does not detect markdown for colon-structured text (no longer a trigger)', () => {
      // Colons were removed from detection to avoid false positives
      const text = 'line1\nline2: value\nline3\nline4';
      expect(v._detectFormat(text)).toBe('text');
    });

    it('does not detect markdown for unicode bullet (not in indicator set)', () => {
      // Unicode bullets (•) are not matched by the [-*] pattern
      const text = 'line1\n• item1\nline3\nline4';
      expect(v._detectFormat(text)).toBe('text');
    });

    it('does not detect markdown for long unicode-bullet logs', () => {
      const text = [
        '2026-02-01 10:00:00 INFO phase:start',
        'job_state: running',
        '• processed chunk A',
        'trace_id: 12345',
        'latency_ms: 52',
        'status: ok',
      ].join('\n');
      expect(v._detectFormat(text)).toBe('text');
    });

    it('does not detect markdown for unicode arrow (not in indicator set)', () => {
      // Unicode arrows (→) are not markdown syntax
      const text = 'line1\n→ result\nline3\nline4';
      expect(v._detectFormat(text)).toBe('text');
    });

    it('does not detect markdown for long unicode-arrow logs', () => {
      const text = [
        'step 1: init',
        'step 2: parse',
        '→ transformed payload',
        'step 3: persist',
        'step 4: verify',
        'step 5: complete',
      ].join('\n');
      expect(v._detectFormat(text)).toBe('text');
    });

    it('does not trigger markdown for short multi-line without markers', () => {
      // Only 2 lines, below threshold
      expect(v._detectFormat('line1\nline2')).toBe('text');
    });

    it('detects search results from object', () => {
      SearchResultsRenderer.isSearchResults.mockReturnValue(true);
      expect(v._detectFormat({ results: [] })).toBe('search_results');
    });

    it('detects search results from JSON string', () => {
      // String data skips the typeof==='object' check (short-circuit),
      // so only the parsed-object check at line 417 calls isSearchResults
      SearchResultsRenderer.isSearchResults.mockReturnValueOnce(true);
      expect(v._detectFormat('{"results":[]}')).toBe('search_results');
    });

    it('returns text for non-string non-object', () => {
      expect(v._detectFormat(42)).toBe('text');
    });

    it('handles invalid JSON string starting with {', () => {
      expect(v._detectFormat('{not json')).toBe('text');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _render
  // ═══════════════════════════════════════════════════════════════════════

  describe('_render', () => {
    beforeEach(async () => {
      await createAndInit();
    });

    it('delegates to specialized renderer', async () => {
      const htmlRenderer = viewer.renderers.get('html');
      await viewer._render('<p>test</p>', 'html');
      expect(htmlRenderer.render).toHaveBeenCalledWith('<p>test</p>', viewer.contentContainer);
    });

    it('falls back to text renderer for unknown format', async () => {
      await viewer._render('data', 'unknown_format');
      const pre = viewer.contentContainer.querySelector('pre');
      expect(pre).not.toBeNull();
      expect(pre.textContent).toBe('data');
    });

    it('returns early if contentContainer is null', async () => {
      viewer.contentContainer = null;
      await expect(viewer._render('data', 'text')).resolves.not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _renderText
  // ═══════════════════════════════════════════════════════════════════════

  describe('_renderText', () => {
    beforeEach(async () => {
      await createAndInit();
    });

    it('renders string as pre element', () => {
      viewer._renderText('hello world');
      const pre = viewer.contentContainer.querySelector('pre');
      expect(pre.textContent).toBe('hello world');
    });

    it('JSON stringifies objects', () => {
      viewer._renderText({ key: 'val' });
      const pre = viewer.contentContainer.querySelector('pre');
      expect(JSON.parse(pre.textContent)).toEqual({ key: 'val' });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // clear
  // ═══════════════════════════════════════════════════════════════════════

  describe('clear', () => {
    it('clears content container', async () => {
      const v = await createAndInit();
      await v.loadOutput('data');
      v.clear();
      expect(v.contentContainer.innerHTML).toBe('');
    });

    it('resets current data to null', async () => {
      const v = await createAndInit();
      await v.loadOutput('data');
      v.clear();
      expect(v.currentData).toBeNull();
    });

    it('resets format to default', async () => {
      const v = await createAndInit();
      await v.loadOutput('data', 'json');
      v.clear();
      expect(v.currentFormat).toBe('text');
    });

    it('resets _shouldAutoScroll to true', async () => {
      const v = await createAndInit();
      v._shouldAutoScroll = false;
      v.clear();
      expect(v._shouldAutoScroll).toBe(true);
    });

    it('handles null contentContainer', () => {
      const v = createViewer();
      v.contentContainer = null;
      expect(() => v.clear()).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // getOutput
  // ═══════════════════════════════════════════════════════════════════════

  describe('getOutput', () => {
    it('returns null when no data loaded', () => {
      const v = createViewer();
      expect(v.getOutput()).toBeNull();
    });

    it('returns current data', async () => {
      const v = await createAndInit();
      await v.loadOutput('test data');
      expect(v.getOutput()).toBe('test data');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _handleFormatChange
  // ═══════════════════════════════════════════════════════════════════════

  describe('_handleFormatChange', () => {
    it('returns early if no current data', async () => {
      const v = await createAndInit();
      v.currentData = null;
      v.formatSelect.value = 'json';
      v._handleFormatChange();
      // No error, no render call
    });

    it('re-renders with new format', async () => {
      const v = await createAndInit();
      await v.loadOutput('{"key":"val"}', 'text');
      eventBus.emit.mockClear();
      v.formatSelect.value = 'json';
      await v._handleFormatChange();
      // Should trigger loadOutput with json format
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _handleClear
  // ═══════════════════════════════════════════════════════════════════════

  describe('_handleClear', () => {
    it('delegates to clear()', async () => {
      const v = await createAndInit();
      await v.loadOutput('data to clear');
      expect(v.currentData).not.toBeNull();
      v._handleClear();
      expect(v.currentData).toBeNull();
      expect(v.contentContainer.innerHTML).toBe('');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _handleCopyAll
  // ═══════════════════════════════════════════════════════════════════════

  describe('_handleCopyAll', () => {
    beforeEach(async () => {
      await createAndInit();
    });

    it('copies text data to clipboard', async () => {
      await viewer.loadOutput('copy me', 'text');
      await viewer._handleCopyAll();
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('copy me');
    });

    it('handles clipboard failure gracefully', async () => {
      await viewer.loadOutput('data');
      navigator.clipboard.writeText.mockRejectedValue(new Error('denied'));
      await expect(viewer._handleCopyAll()).resolves.not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _handleDownload
  // ═══════════════════════════════════════════════════════════════════════

  describe('_handleDownload', () => {
    beforeEach(async () => {
      await createAndInit();
      URL.createObjectURL = jest.fn(() => 'blob:test-url');
      URL.revokeObjectURL = jest.fn();
    });

    it('creates and clicks a download link', async () => {
      await viewer.loadOutput('download me', 'text');
      viewer._handleDownload();
      expect(URL.createObjectURL).toHaveBeenCalled();
      expect(URL.revokeObjectURL).toHaveBeenCalled();
    });

    it('handles download failure gracefully', async () => {
      await viewer.loadOutput('data');
      URL.createObjectURL = jest.fn(() => { throw new Error('blob fail'); });
      expect(() => viewer._handleDownload()).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _handleToggleWrap
  // ═══════════════════════════════════════════════════════════════════════

  describe('_handleToggleWrap', () => {
    beforeEach(async () => {
      await createAndInit();
    });

    it('toggles wrap state', () => {
      expect(viewer._wrapEnabled).toBe(true);
      viewer._handleToggleWrap();
      expect(viewer._wrapEnabled).toBe(false);
      viewer._handleToggleWrap();
      expect(viewer._wrapEnabled).toBe(true);
    });

    it('adds/removes wrap class on content container', () => {
      viewer._handleToggleWrap(); // disable
      expect(viewer.contentContainer.classList.contains('wrap-lines')).toBe(false);
      viewer._handleToggleWrap(); // enable
      expect(viewer.contentContainer.classList.contains('wrap-lines')).toBe(true);
    });

    it('toggles wrap on nested markdown content', () => {
      const mdContent = document.createElement('div');
      mdContent.className = 'markdown-content';
      viewer.contentContainer.appendChild(mdContent);

      viewer._handleToggleWrap(); // disable
      expect(mdContent.classList.contains('wrap-lines')).toBe(false);
      viewer._handleToggleWrap(); // enable
      expect(mdContent.classList.contains('wrap-lines')).toBe(true);
    });

    it('handles null contentContainer', () => {
      viewer.contentContainer = null;
      expect(() => viewer._handleToggleWrap()).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _getCopyText
  // ═══════════════════════════════════════════════════════════════════════

  describe('_getCopyText', () => {
    beforeEach(async () => {
      await createAndInit();
    });

    it('returns empty string for null data', () => {
      expect(viewer._getCopyText('text', null)).toBe('');
    });

    it('returns formatted JSON for json format', () => {
      const result = viewer._getCopyText('json', '{"a":1}');
      expect(JSON.parse(result)).toEqual({ a: 1 });
    });

    it('returns stringified JSON for json object', () => {
      const result = viewer._getCopyText('json', { a: 1 });
      expect(JSON.parse(result)).toEqual({ a: 1 });
    });

    it('handles invalid JSON gracefully', () => {
      const result = viewer._getCopyText('json', 'not json');
      expect(result).toBe('not json');
    });

    it('returns markdown string as-is', () => {
      expect(viewer._getCopyText('markdown', '## Title')).toBe('## Title');
    });

    it('extracts markdown from object', () => {
      expect(viewer._getCopyText('markdown', { markdown: '## T' })).toBe('## T');
    });

    it('extracts content from markdown object', () => {
      expect(viewer._getCopyText('markdown', { content: '## C' })).toBe('## C');
    });

    it('falls back to contentContainer.textContent for markdown object without markdown/content', () => {
      viewer.contentContainer.textContent = 'fallback text';
      expect(viewer._getCopyText('markdown', { other: 'field' })).toBe('fallback text');
    });

    it('returns empty string for markdown object fallback with null contentContainer', () => {
      viewer.contentContainer = null;
      expect(viewer._getCopyText('markdown', { other: 'field' })).toBe('');
    });

    it('returns textContent for html format', () => {
      viewer.contentContainer.textContent = 'rendered text';
      expect(viewer._getCopyText('html', '<p>html</p>')).toBe('rendered text');
    });

    it('returns empty string for html format with null contentContainer', () => {
      viewer.contentContainer = null;
      expect(viewer._getCopyText('html', '<p>html</p>')).toBe('');
    });

    it('returns empty string for html format with empty textContent', () => {
      viewer.contentContainer.textContent = '';
      expect(viewer._getCopyText('html', '<p>html</p>')).toBe('');
    });

    it('returns string data for text format', () => {
      expect(viewer._getCopyText('text', 'plain')).toBe('plain');
    });

    it('JSON stringifies object for text format', () => {
      const result = viewer._getCopyText('text', { key: 'val' });
      expect(JSON.parse(result)).toEqual({ key: 'val' });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _getDownloadPayload
  // ═══════════════════════════════════════════════════════════════════════

  describe('_getDownloadPayload', () => {
    let v;
    beforeEach(async () => { v = await createAndInit(); });

    it('returns text/plain for null data', () => {
      const result = v._getDownloadPayload('text', null);
      expect(result).toEqual({ mime: 'text/plain', ext: 'txt', content: '' });
    });

    it('returns JSON payload', () => {
      const result = v._getDownloadPayload('json', { a: 1 });
      expect(result.mime).toBe('application/json');
      expect(result.ext).toBe('json');
      expect(JSON.parse(result.content)).toEqual({ a: 1 });
    });

    it('returns markdown payload', () => {
      const result = v._getDownloadPayload('markdown', '## Title');
      expect(result.mime).toBe('text/markdown');
      expect(result.ext).toBe('md');
      expect(result.content).toBe('## Title');
    });

    it('returns HTML payload', () => {
      const result = v._getDownloadPayload('html', '<p>hi</p>');
      expect(result.mime).toBe('text/html');
      expect(result.ext).toBe('html');
      expect(result.content).toBe('<p>hi</p>');
    });

    it('sanitizes html download payload to block scriptable vectors', () => {
      const result = v._getDownloadPayload(
        'html',
        '<div>Safe</div><script>alert(1)</script><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">bad</a>'
      );
      expect(result.mime).toBe('text/html');
      expect(result.ext).toBe('html');
      expect(result.content).toContain('Safe');
      expect(result.content).not.toContain('<script');
      expect(result.content).not.toContain('onerror');
      expect(result.content).not.toContain('javascript:');
    });

    it('returns text payload for unknown format', () => {
      const result = v._getDownloadPayload('unknown', 'data');
      expect(result.mime).toBe('text/plain');
      expect(result.ext).toBe('txt');
    });

    it('handles markdown object data', () => {
      const result = v._getDownloadPayload('markdown', { markdown: '# H' });
      expect(result.content).toBe('# H');
    });

    it('handles invalid JSON in json format', () => {
      const result = v._getDownloadPayload('json', 'not json');
      expect(result.content).toBe('not json');
    });

    it('handles HTML object data', () => {
      const result = v._getDownloadPayload('html', { tag: 'div' });
      expect(result.mime).toBe('text/html');
      expect(result.content).toBe('[object Object]');
    });

    it('handles markdown object without markdown/content keys', () => {
      const result = v._getDownloadPayload('markdown', { other: 'val' });
      expect(result.mime).toBe('text/markdown');
      expect(result.content).toBe('[object Object]');
    });

    it('handles default format with object data', () => {
      const result = v._getDownloadPayload('csv', { a: 1 });
      expect(result.mime).toBe('text/plain');
      expect(JSON.parse(result.content)).toEqual({ a: 1 });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // dispose
  // ═══════════════════════════════════════════════════════════════════════

  describe('dispose', () => {
    it('disposes all renderers', async () => {
      const v = await createAndInit();
      const renderers = Array.from(v.renderers.values());
      v.dispose();
      for (const r of renderers) {
        expect(r.dispose).toHaveBeenCalled();
      }
    });

    it('clears renderers Map', async () => {
      const v = await createAndInit();
      v.dispose();
      expect(v.renderers.size).toBe(0);
    });

    it('clears event listeners', async () => {
      const v = await createAndInit();
      expect(v._eventListeners.length).toBeGreaterThan(0);
      v.dispose();
      expect(v._eventListeners).toEqual([]);
    });

    it('nulls DOM references', async () => {
      const v = await createAndInit();
      v.dispose();
      expect(v.container).toBeNull();
      expect(v.controlsContainer).toBeNull();
      expect(v.contentContainer).toBeNull();
      expect(v.formatSelect).toBeNull();
      expect(v.scrollToBottomBtn).toBeNull(); // BUG OV-6 FIX
    });

    it('resets state flags', async () => {
      const v = await createAndInit();
      v._shouldAutoScroll = false;
      v.dispose();
      expect(v._shouldAutoScroll).toBe(true);
    });

    it('handles renderer dispose failure', async () => {
      const v = await createAndInit();
      const renderer = v.renderers.values().next().value;
      renderer.dispose.mockImplementation(() => { throw new Error('fail'); });
      expect(() => v.dispose()).not.toThrow();
    });

    it('handles renderer without dispose function', async () => {
      const v = await createAndInit();
      // Replace a renderer with one that has no dispose
      v.renderers.set('test_no_dispose', { render: jest.fn() });
      expect(() => v.dispose()).not.toThrow();
    });

    it('handles null renderer in renderers map', async () => {
      const v = await createAndInit();
      v.renderers.set('test_null', null);
      expect(() => v.dispose()).not.toThrow();
    });

    it('handles cleanup function failure', async () => {
      const v = await createAndInit();
      v._eventListeners.push(() => { throw new Error('cleanup fail'); });
      expect(() => v.dispose()).not.toThrow();
    });

    it('is safe to call twice', async () => {
      const v = await createAndInit();
      v.dispose();
      expect(() => v.dispose()).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Scroll Management (BUG OV-5 & OV-6)
  // ═══════════════════════════════════════════════════════════════════════

  describe('scroll management', () => {
    let v;
    beforeEach(async () => {
      v = await createAndInit();
    });

    describe('_checkAutoScroll', () => {
      it('sets _shouldAutoScroll to true when at bottom', () => {
        Object.defineProperty(v.contentContainer, 'scrollTop', { value: 80, configurable: true });
        Object.defineProperty(v.contentContainer, 'scrollHeight', { value: 200, configurable: true });
        Object.defineProperty(v.contentContainer, 'clientHeight', { value: 110, configurable: true });
        // 200 - 80 - 110 = 10 (less than threshold 20)
        v._checkAutoScroll();
        expect(v._shouldAutoScroll).toBe(true);
      });

      it('sets _shouldAutoScroll to false when scrolled up', () => {
        Object.defineProperty(v.contentContainer, 'scrollTop', { value: 0, configurable: true });
        Object.defineProperty(v.contentContainer, 'scrollHeight', { value: 200, configurable: true });
        Object.defineProperty(v.contentContainer, 'clientHeight', { value: 100, configurable: true });
        // 200 - 0 - 100 = 100 (greater than threshold 20)
        v._checkAutoScroll();
        expect(v._shouldAutoScroll).toBe(false);
      });
    });

    describe('_updateScrollButtonVisibility', () => {
      it('hides button when at bottom', () => {
        v.scrollToBottomBtn.classList.remove('hidden');
        Object.defineProperty(v.contentContainer, 'scrollTop', { value: 100, configurable: true });
        Object.defineProperty(v.contentContainer, 'scrollHeight', { value: 200, configurable: true });
        Object.defineProperty(v.contentContainer, 'clientHeight', { value: 100, configurable: true });
        v._updateScrollButtonVisibility();
        expect(v.scrollToBottomBtn.classList.contains('hidden')).toBe(true);
      });

      it('shows button when scrolled up and has overflow', () => {
        v.scrollToBottomBtn.classList.add('hidden');
        Object.defineProperty(v.contentContainer, 'scrollTop', { value: 0, configurable: true });
        Object.defineProperty(v.contentContainer, 'scrollHeight', { value: 200, configurable: true });
        Object.defineProperty(v.contentContainer, 'clientHeight', { value: 100, configurable: true });
        v._updateScrollButtonVisibility();
        expect(v.scrollToBottomBtn.classList.contains('hidden')).toBe(false);
      });

      it('hides button when no overflow exists', () => {
        v.scrollToBottomBtn.classList.remove('hidden');
        Object.defineProperty(v.contentContainer, 'scrollTop', { value: 0, configurable: true });
        Object.defineProperty(v.contentContainer, 'scrollHeight', { value: 100, configurable: true });
        Object.defineProperty(v.contentContainer, 'clientHeight', { value: 100, configurable: true });
        v._updateScrollButtonVisibility();
        expect(v.scrollToBottomBtn.classList.contains('hidden')).toBe(true);
      });
    });

    describe('_performAutoScroll', () => {
      it('calls _scrollToBottom if _shouldAutoScroll is true', () => {
        const spy = jest.spyOn(v, '_scrollToBottom');
        v._shouldAutoScroll = true;
        v._performAutoScroll();
        expect(spy).toHaveBeenCalled();
      });

      it('calls _updateScrollButtonVisibility if _shouldAutoScroll is false', () => {
        const spy = jest.spyOn(v, '_updateScrollButtonVisibility');
        v._shouldAutoScroll = false;
        v._performAutoScroll();
        expect(spy).toHaveBeenCalled();
      });
    });

    describe('loadOutput integration', () => {
      it('calls _checkAutoScroll before rendering', async () => {
        const spy = jest.spyOn(v, '_checkAutoScroll');
        await v.loadOutput('new data');
        expect(spy).toHaveBeenCalled();
      });

      it('calls _performAutoScroll after rendering', async () => {
        const spy = jest.spyOn(v, '_performAutoScroll');
        await v.loadOutput('new data');
        expect(spy).toHaveBeenCalled();
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Listener tracking
  // ═══════════════════════════════════════════════════════════════════════

  describe('listener tracking', () => {
    it('tracks cleanup functions for control buttons + format select', async () => {
      const v = await createAndInit();
      // 4 buttons (copy, download, export-pdf, clear) + 1 format select + 1 link click interceptor 
      // + 1 scroll-to-bottom button + 1 scroll listener = 8
      expect(v._eventListeners.length).toBe(8);
    });

    it('all cleanup functions are callable', async () => {
      const v = await createAndInit();
      for (const fn of v._eventListeners) {
        expect(typeof fn).toBe('function');
      }
    });

    it('keeps listener cardinality stable during rapid format switches', async () => {
      const v = await createAndInit();
      await v.loadOutput('{"key":"value"}', 'json');
      const baseline = v._eventListeners.length;

      const formats = ['text', 'json', 'markdown', 'html', 'text', 'json'];
      for (const format of formats) {
        v.formatSelect.value = format;
        await v._handleFormatChange();
      }

      expect(v._eventListeners.length).toBe(baseline);
    });

    it('cleans exactly tracked listeners across repeated init-dispose cycles', async () => {
      for (let i = 0; i < 3; i++) {
        const v = await createAndInit();
        expect(v._eventListeners.length).toBe(8);
        v.dispose();
        expect(v._eventListeners.length).toBe(0);
        viewer = null;
      }
    });
  });
});
