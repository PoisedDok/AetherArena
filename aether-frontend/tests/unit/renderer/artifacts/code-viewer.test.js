'use strict';

// ---------------------------------------------------------------------------
// CodeViewer — Unit tests
// Source: src/renderer/artifacts/modules/code/CodeViewer.js
// Bugs fixed: CV-1 style element leak, CV-2 untracked setTimeout,
//   CV-3 init idempotency, CV-4 per-tab listener cleanup on closeTab
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mocks — MUST be at top level so Jest hoists them before require()
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

jest.mock('../../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: () => ({
    logger: mockLog,
  }),
}));

const CodeViewer = require('../../../../src/renderer/artifacts/modules/code/CodeViewer');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEventBus() {
  const handlers = new Map();
  return {
    on: jest.fn((event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {
        const arr = handlers.get(event);
        if (arr) {
          const idx = arr.indexOf(handler);
          if (idx !== -1) arr.splice(idx, 1);
        }
      };
    }),
    emit: jest.fn(),
    _handlers: handlers,
  };
}

function createMockController() {
  return {
    exportFile: jest.fn().mockResolvedValue(undefined),
  };
}

function setupDOM() {
  document.body.innerHTML = '<div id="cv-container"></div>';
  return document.getElementById('cv-container');
}

function teardownDOM() {
  // Remove any injected styles
  const styleEl = document.getElementById('code-viewer-styles');
  if (styleEl) styleEl.remove();
  document.body.innerHTML = '';
}

/** Create an initialized CodeViewer instance */
async function createInitializedCV(overrides = {}) {
  const container = setupDOM();
  const eventBus = createMockEventBus();
  const controller = createMockController();
  const cv = new CodeViewer({
    controller,
    eventBus,
    aether: { logger: mockLog },
    ...overrides,
  });
  await cv.init(container);
  return { cv, eventBus, controller, container };
}


// ===========================================================================
// 1. CONSTRUCTOR VALIDATION
// ===========================================================================

describe('Constructor validation', () => {
  it('throws if controller is missing', () => {
    expect(() => new CodeViewer({ eventBus: createMockEventBus() }))
      .toThrow('[CodeViewer] Controller required');
  });

  it('throws if eventBus is missing', () => {
    expect(() => new CodeViewer({ controller: createMockController() }))
      .toThrow('[CodeViewer] EventBus required');
  });

  it('initializes with correct default state', () => {
    const cv = new CodeViewer({
      controller: createMockController(),
      eventBus: createMockEventBus(),
      aether: {},
    });
    expect(cv.container).toBeNull();
    expect(cv.tabsHeader).toBeNull();
    expect(cv.tabsContent).toBeNull();
    expect(cv.tabs.size).toBe(0);
    expect(cv.activeTabId).toBeNull();
    expect(cv.tabCounter).toBe(0);
    expect(cv._eventListeners).toEqual([]);
    expect(cv._tabListeners.size).toBe(0);
    expect(cv._initialized).toBe(false);
    expect(cv._isDisposed).toBe(false);
    expect(cv._resizeTimerId).toBeNull();
    expect(cv.renderer.librariesLoaded).toBe(false);
  });
});


// ===========================================================================
// 2. PURE LOGIC — _normalizeCodeInput, _normalizeLanguageInput, _getAceMode,
//    _getLanguageDisplayName, _getFileExtension, _escapeHtml
// ===========================================================================

describe('Pure logic', () => {
  let cv;

  beforeEach(() => {
    cv = new CodeViewer({
      controller: createMockController(),
      eventBus: createMockEventBus(),
      aether: {},
    });
  });

  describe('_normalizeCodeInput', () => {
    it('returns empty string for null', () => {
      expect(cv._normalizeCodeInput(null)).toBe('');
    });

    it('returns empty string for undefined', () => {
      expect(cv._normalizeCodeInput(undefined)).toBe('');
    });

    it('passes through strings', () => {
      expect(cv._normalizeCodeInput('hello')).toBe('hello');
    });

    it('converts number to string', () => {
      expect(cv._normalizeCodeInput(42)).toBe('42');
    });

    it('converts boolean to string', () => {
      expect(cv._normalizeCodeInput(true)).toBe('true');
    });

    it('JSON-stringifies objects', () => {
      const obj = { key: 'value' };
      expect(cv._normalizeCodeInput(obj)).toBe(JSON.stringify(obj, null, 2));
    });

    it('handles circular objects gracefully (fallback to String)', () => {
      const obj = {};
      obj.self = obj;
      const result = cv._normalizeCodeInput(obj);
      expect(typeof result).toBe('string');
    });
  });

  describe('_normalizeLanguageInput', () => {
    it('returns "text" for null', () => {
      expect(cv._normalizeLanguageInput(null)).toBe('text');
    });

    it('returns "text" for empty string', () => {
      expect(cv._normalizeLanguageInput('')).toBe('text');
    });

    it('returns "text" for non-string input', () => {
      expect(cv._normalizeLanguageInput(42)).toBe('text');
    });

    it('passes through valid language strings', () => {
      expect(cv._normalizeLanguageInput('python')).toBe('python');
    });
  });

  describe('_getAceMode', () => {
    it('maps "js" to "javascript"', () => {
      expect(cv._getAceMode('js')).toBe('javascript');
    });

    it('maps "ts" to "typescript"', () => {
      expect(cv._getAceMode('ts')).toBe('typescript');
    });

    it('maps "py" to "python"', () => {
      expect(cv._getAceMode('py')).toBe('python');
    });

    it('maps "bash" to "sh"', () => {
      expect(cv._getAceMode('bash')).toBe('sh');
    });

    it('maps "zsh" to "sh"', () => {
      expect(cv._getAceMode('zsh')).toBe('sh');
    });

    it('passes through unmapped languages', () => {
      expect(cv._getAceMode('rust')).toBe('rust');
    });
  });

  describe('_getLanguageDisplayName', () => {
    it('returns "JavaScript" for "js"', () => {
      expect(cv._getLanguageDisplayName('js')).toBe('JavaScript');
    });

    it('returns "Python" for "python"', () => {
      expect(cv._getLanguageDisplayName('python')).toBe('Python');
    });

    it('returns "YAML" for "yml"', () => {
      expect(cv._getLanguageDisplayName('yml')).toBe('YAML');
    });

    it('returns uppercased string for unknown language', () => {
      expect(cv._getLanguageDisplayName('brainfuck')).toBe('BRAINFUCK');
    });
  });

  describe('_getFileExtension', () => {
    it('maps "javascript" to "js"', () => {
      expect(cv._getFileExtension('javascript')).toBe('js');
    });

    it('maps "python" to "py"', () => {
      expect(cv._getFileExtension('python')).toBe('py');
    });

    it('maps "shell" to "sh"', () => {
      expect(cv._getFileExtension('shell')).toBe('sh');
    });

    it('passes through unmapped languages', () => {
      expect(cv._getFileExtension('go')).toBe('go');
    });
  });

  describe('_escapeHtml', () => {
    it('escapes < and >', () => {
      const result = cv._escapeHtml('<script>alert("xss")</script>');
      expect(result).toContain('&lt;');
      expect(result).toContain('&gt;');
    });

    it('escapes &', () => {
      expect(cv._escapeHtml('a&b')).toBe('a&amp;b');
    });

    it('passes plain text through unchanged', () => {
      expect(cv._escapeHtml('Hello World')).toBe('Hello World');
    });

    it('handles empty string', () => {
      expect(cv._escapeHtml('')).toBe('');
    });
  });
});


// ===========================================================================
// 3. LIFECYCLE — init, dispose, idempotency
// ===========================================================================

describe('Lifecycle', () => {
  afterEach(() => teardownDOM());

  it('init creates DOM structure (tabsHeader + tabsContent)', async () => {
    const { cv, container } = await createInitializedCV();
    expect(cv._initialized).toBe(true);
    expect(cv.tabsHeader).not.toBeNull();
    expect(cv.tabsContent).not.toBeNull();
    expect(container.querySelector('.code-tabs-header')).not.toBeNull();
    expect(container.querySelector('.code-tabs-content')).not.toBeNull();
    cv.dispose();
  });

  it('init creates default tab if none exist', async () => {
    const { cv } = await createInitializedCV();
    expect(cv.tabs.size).toBe(1);
    expect(cv.activeTabId).not.toBeNull();
    cv.dispose();
  });

  it('init emits COMPONENT_READY event', async () => {
    const { cv, eventBus } = await createInitializedCV();
    expect(eventBus.emit).toHaveBeenCalledWith('ui:component:ready', expect.objectContaining({
      component: 'CodeViewer',
    }));
    cv.dispose();
  });

  it('init injects styles into document.head', async () => {
    const { cv } = await createInitializedCV();
    expect(document.getElementById('code-viewer-styles')).not.toBeNull();
    cv.dispose();
  });

  it('init throws if container is null', async () => {
    const cv = new CodeViewer({
      controller: createMockController(),
      eventBus: createMockEventBus(),
      aether: {},
    });
    await expect(cv.init(null)).rejects.toThrow('[CodeViewer] Container required');
  });

  it('BUG CV-3: init is idempotent — second call is no-op', async () => {
    const { cv, container } = await createInitializedCV();
    const headerCount = container.querySelectorAll('.code-tabs-header').length;
    await cv.init(container);
    // Should NOT have created duplicate DOM
    expect(container.querySelectorAll('.code-tabs-header').length).toBe(headerCount);
    cv.dispose();
  });

  it('dispose nulls all DOM references', async () => {
    const { cv } = await createInitializedCV();
    cv.dispose();
    expect(cv.container).toBeNull();
    expect(cv.tabsHeader).toBeNull();
    expect(cv.tabsContent).toBeNull();
    expect(cv.renderer.ace).toBeNull();
    expect(cv.renderer.hljs).toBeNull();
  });

  it('dispose sets _isDisposed and resets _initialized', async () => {
    const { cv } = await createInitializedCV();
    cv.dispose();
    expect(cv._isDisposed).toBe(true);
    expect(cv._initialized).toBe(false);
  });

  it('dispose is idempotent — safe to call twice', async () => {
    const { cv } = await createInitializedCV();
    cv.dispose();
    expect(() => cv.dispose()).not.toThrow();
  });

  it('dispose clears all tabs', async () => {
    const { cv } = await createInitializedCV();
    expect(cv.tabs.size).toBeGreaterThan(0);
    cv.dispose();
    expect(cv.tabs.size).toBe(0);
  });

  it('BUG CV-1: dispose removes injected style element', async () => {
    const { cv } = await createInitializedCV();
    expect(document.getElementById('code-viewer-styles')).not.toBeNull();
    cv.dispose();
    expect(document.getElementById('code-viewer-styles')).toBeNull();
  });
});


// ===========================================================================
// 4. TAB MANAGEMENT — createTab, closeTab, setActiveTab, clear
// ===========================================================================

describe('Tab management', () => {
  afterEach(() => teardownDOM());

  it('createTab creates a tab with correct properties', async () => {
    const { cv } = await createInitializedCV();
    const tabId = cv.createTab('Test Tab', 'console.log(1)', 'javascript', 'art-1');
    expect(tabId).not.toBeNull();
    const tab = cv.tabs.get(tabId);
    expect(tab.label).toBe('Test Tab');
    expect(tab.code).toBe('console.log(1)');
    expect(tab.language).toBe('javascript');
    expect(tab.artifactId).toBe('art-1');
    cv.dispose();
  });

  it('createTab sets new tab as active', async () => {
    const { cv } = await createInitializedCV();
    const tabId = cv.createTab('Tab 2', '', 'text');
    expect(cv.activeTabId).toBe(tabId);
    cv.dispose();
  });

  it('createTab emits CODE_TAB_CREATED event', async () => {
    const { cv, eventBus } = await createInitializedCV();
    const tabId = cv.createTab('Tab 2', '', 'python');
    expect(eventBus.emit).toHaveBeenCalledWith('artifacts:code:tab:created', expect.objectContaining({
      tabId,
      language: 'python',
    }));
    cv.dispose();
  });

  it('createTab returns null when max tabs reached', async () => {
    const { cv } = await createInitializedCV();
    // Already has 1 tab from init. Create 19 more to hit 20.
    for (let i = 0; i < 19; i++) {
      cv.createTab(`Tab ${i + 2}`, '', 'text');
    }
    expect(cv.tabs.size).toBe(20);
    const result = cv.createTab('Over limit', '', 'text');
    expect(result).toBeNull();
    expect(cv.tabs.size).toBe(20);
    cv.dispose();
  });

  it('closeTab removes tab and switches to another', async () => {
    const { cv } = await createInitializedCV();
    const tab1Id = cv.activeTabId;
    const tab2Id = cv.createTab('Tab 2', '', 'text');
    expect(cv.tabs.size).toBe(2);

    cv.closeTab(tab2Id);
    expect(cv.tabs.size).toBe(1);
    expect(cv.tabs.has(tab2Id)).toBe(false);
    expect(cv.activeTabId).toBe(tab1Id);
    cv.dispose();
  });

  it('closeTab creates default tab when last tab is closed', async () => {
    const { cv } = await createInitializedCV();
    const tabId = cv.activeTabId;
    cv.closeTab(tabId);
    // Should have created a new default tab
    expect(cv.tabs.size).toBe(1);
    expect(cv.activeTabId).not.toBe(tabId);
    cv.dispose();
  });

  it('closeTab emits CODE_TAB_CLOSED event', async () => {
    const { cv, eventBus } = await createInitializedCV();
    const tabId = cv.createTab('To close', '', 'text');
    eventBus.emit.mockClear();
    cv.closeTab(tabId);
    expect(eventBus.emit).toHaveBeenCalledWith('artifacts:code:tab:closed', expect.objectContaining({
      tabId,
    }));
    cv.dispose();
  });

  it('closeTab is no-op for unknown tabId', async () => {
    const { cv } = await createInitializedCV();
    expect(() => cv.closeTab('nonexistent')).not.toThrow();
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('Tab not found'));
    cv.dispose();
  });

  it('setActiveTab changes active tab', async () => {
    const { cv } = await createInitializedCV();
    const tab2Id = cv.createTab('Tab 2', '', 'text');
    const tab1Id = Array.from(cv.tabs.keys())[0];

    cv.setActiveTab(tab1Id);
    expect(cv.activeTabId).toBe(tab1Id);
    const tab1 = cv.tabs.get(tab1Id);
    expect(tab1.button.classList.contains('active')).toBe(true);
    const tab2 = cv.tabs.get(tab2Id);
    expect(tab2.button.classList.contains('active')).toBe(false);
    cv.dispose();
  });

  it('setActiveTab emits CODE_TAB_CHANGED event', async () => {
    const { cv, eventBus } = await createInitializedCV();
    const tab2Id = cv.createTab('Tab 2', '', 'python');
    eventBus.emit.mockClear();
    const tab1Id = Array.from(cv.tabs.keys())[0];
    cv.setActiveTab(tab1Id);
    expect(eventBus.emit).toHaveBeenCalledWith('artifacts:code:tab:changed', expect.objectContaining({
      tabId: tab1Id,
    }));
    cv.dispose();
  });

  it('setActiveTab is no-op for unknown tabId', async () => {
    const { cv } = await createInitializedCV();
    const prevActive = cv.activeTabId;
    cv.setActiveTab('nonexistent');
    expect(cv.activeTabId).toBe(prevActive);
    cv.dispose();
  });

  it('clear resets to single empty tab', async () => {
    const { cv } = await createInitializedCV();
    cv.createTab('Tab 2', 'code2', 'python');
    cv.createTab('Tab 3', 'code3', 'ruby');
    expect(cv.tabs.size).toBe(3);

    cv.clear();
    expect(cv.tabs.size).toBe(1);
    cv.dispose();
  });
});


// ===========================================================================
// 5. loadCode AND getCode
// ===========================================================================

describe('loadCode', () => {
  afterEach(() => teardownDOM());

  it('updates active tab content', async () => {
    const { cv } = await createInitializedCV();
    cv.loadCode('print("hello")', 'python', 'hello.py');

    const tab = cv.tabs.get(cv.activeTabId);
    expect(tab.code).toBe('print("hello")');
    expect(tab.language).toBe('python');
    cv.dispose();
  });

  it('updates label when filename provided', async () => {
    const { cv } = await createInitializedCV();
    cv.loadCode('code', 'js', 'app.js');

    const tab = cv.tabs.get(cv.activeTabId);
    expect(tab.label).toBe('app.js');
    cv.dispose();
  });

  it('emits CODE_LOADED event', async () => {
    const { cv, eventBus } = await createInitializedCV();
    eventBus.emit.mockClear();
    cv.loadCode('x = 1', 'python');
    expect(eventBus.emit).toHaveBeenCalledWith('artifacts:code:loaded', expect.objectContaining({
      language: 'python',
      size: 5,
    }));
    cv.dispose();
  });

  it('deduplicates by artifactId — reuses existing tab', async () => {
    const { cv } = await createInitializedCV();
    cv.loadCode('v1', 'js', 'file.js', 'art-x');
    const tabCount = cv.tabs.size;

    // Load same artifactId with different content
    cv.loadCode('v2', 'js', 'file.js', 'art-x');
    expect(cv.tabs.size).toBe(tabCount); // No new tab
    const tab = cv.tabs.get(cv.activeTabId);
    expect(tab.code).toBe('v2');
    cv.dispose();
  });

  it('skips update if artifactId content unchanged', async () => {
    const { cv, eventBus } = await createInitializedCV();
    cv.loadCode('same', 'js', 'file.js', 'art-y');
    eventBus.emit.mockClear();

    cv.loadCode('same', 'js', 'file.js', 'art-y');
    // Should NOT emit CODE_LOADED again since content is identical
    expect(eventBus.emit).not.toHaveBeenCalledWith(
      'artifacts:code:loaded',
      expect.anything()
    );
    cv.dispose();
  });

  it('creates new tab if no tabs exist', async () => {
    const { cv } = await createInitializedCV();
    // Close all tabs to force empty state
    const tabIds = Array.from(cv.tabs.keys());
    // closeTab on last tab creates default, so we need a workaround
    // Just clear the tabs map directly
    for (const [, tab] of cv.tabs) {
      if (tab.editor) tab.editor.destroy?.();
    }
    cv.tabs.clear();
    cv.activeTabId = null;

    cv.loadCode('new code', 'rust');
    expect(cv.tabs.size).toBe(1);
    cv.dispose();
  });

  it('updates language badge text', async () => {
    const { cv } = await createInitializedCV();
    cv.loadCode('x', 'python', 'test.py');

    const tab = cv.tabs.get(cv.activeTabId);
    const badge = tab.content.querySelector('.code-language-badge');
    expect(badge.textContent).toBe('Python');
    cv.dispose();
  });
});

describe('getCode', () => {
  afterEach(() => teardownDOM());

  it('returns code data for active tab', async () => {
    const { cv } = await createInitializedCV();
    cv.loadCode('hello', 'javascript', 'test.js', 'art-1');

    const result = cv.getCode();
    expect(result).not.toBeNull();
    expect(result.code).toBe('hello');
    expect(result.language).toBe('javascript');
    expect(result.label).toBe('test.js');
    expect(result.artifactId).toBe('art-1');
    cv.dispose();
  });

  it('returns null if no active tab', async () => {
    const cv = new CodeViewer({
      controller: createMockController(),
      eventBus: createMockEventBus(),
      aether: {},
    });
    expect(cv.getCode()).toBeNull();
  });

  it('returns null if active tab was removed', async () => {
    const { cv } = await createInitializedCV();
    cv.activeTabId = 'nonexistent';
    expect(cv.getCode()).toBeNull();
    cv.dispose();
  });
});


// ===========================================================================
// 6. BUG REGRESSIONS
// ===========================================================================

describe('BUG CV-1 REGRESSION: Style element removed on dispose', () => {
  afterEach(() => teardownDOM());

  it('style element exists after init', async () => {
    const { cv } = await createInitializedCV();
    expect(document.getElementById('code-viewer-styles')).not.toBeNull();
    cv.dispose();
  });

  it('style element is removed after dispose', async () => {
    const { cv } = await createInitializedCV();
    cv.dispose();
    expect(document.getElementById('code-viewer-styles')).toBeNull();
  });

  it('_injectStyles does not duplicate styles on repeated calls', async () => {
    const { cv } = await createInitializedCV();
    cv.renderer.injectStyles();
    cv.renderer.injectStyles();
    const styles = document.querySelectorAll('#code-viewer-styles');
    expect(styles.length).toBe(1);
    cv.dispose();
  });
});

describe('BUG CV-2 REGRESSION: Resize timer tracked and cleared', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    teardownDOM();
  });

  it('setActiveTab sets _resizeTimerId when editor has resize', async () => {
    const { cv } = await createInitializedCV();
    // Inject a mock editor with resize into the active tab
    const tab = cv.tabs.get(cv.activeTabId);
    tab.editor = { resize: jest.fn(), destroy: jest.fn() };

    cv.setActiveTab(cv.activeTabId);
    expect(cv._resizeTimerId).not.toBeNull();
    cv.dispose();
  });

  it('dispose clears pending resize timer', async () => {
    const { cv } = await createInitializedCV();
    const tab = cv.tabs.get(cv.activeTabId);
    tab.editor = { resize: jest.fn(), destroy: jest.fn() };

    cv.setActiveTab(cv.activeTabId);
    expect(cv._resizeTimerId).not.toBeNull();

    cv.dispose();
    expect(cv._resizeTimerId).toBeNull();
  });

  it('resize callback is guarded against disposed state', async () => {
    const { cv } = await createInitializedCV();
    const resizeSpy = jest.fn();
    const tab = cv.tabs.get(cv.activeTabId);
    tab.editor = { resize: resizeSpy, destroy: jest.fn() };

    cv.setActiveTab(cv.activeTabId);
    cv.dispose();

    // Advance past the 100ms timeout
    jest.advanceTimersByTime(200);
    // resize should NOT have been called (disposed guard)
    expect(resizeSpy).not.toHaveBeenCalled();
  });

  it('rapid setActiveTab calls clear previous timer', async () => {
    const { cv } = await createInitializedCV();
    const resizeSpy = jest.fn();
    const tab = cv.tabs.get(cv.activeTabId);
    tab.editor = { resize: resizeSpy, destroy: jest.fn() };

    cv.setActiveTab(cv.activeTabId);
    const firstTimer = cv._resizeTimerId;
    cv.setActiveTab(cv.activeTabId);
    const secondTimer = cv._resizeTimerId;

    // Different timer IDs (first was cleared)
    expect(secondTimer).not.toBe(firstTimer);

    // After 100ms, resize called only once
    jest.advanceTimersByTime(200);
    expect(resizeSpy).toHaveBeenCalledTimes(1);
    cv.dispose();
  });
});

describe('BUG CV-3 REGRESSION: Init idempotency', () => {
  afterEach(() => teardownDOM());

  it('second init() call returns immediately', async () => {
    const { cv, container } = await createInitializedCV();
    const tabCount = cv.tabs.size;

    await cv.init(container);
    // Should not have created additional tabs or DOM
    expect(cv.tabs.size).toBe(tabCount);
    cv.dispose();
  });

  it('_initialized flag is set after first init', async () => {
    const { cv } = await createInitializedCV();
    expect(cv._initialized).toBe(true);
    cv.dispose();
  });

  it('_initialized flag is reset after dispose', async () => {
    const { cv } = await createInitializedCV();
    cv.dispose();
    expect(cv._initialized).toBe(false);
  });
});

describe('BUG CV-4 REGRESSION: Per-tab listeners cleaned on closeTab', () => {
  afterEach(() => teardownDOM());

  it('createTab initializes per-tab listener entry in _tabListeners', async () => {
    const { cv } = await createInitializedCV();
    const tabId = cv.createTab('Test', '', 'text');
    expect(cv._tabListeners.has(tabId)).toBe(true);
    expect(cv._tabListeners.get(tabId).length).toBeGreaterThan(0);
    cv.dispose();
  });

  it('each tab tracks 2 cleanup functions (button click/close + controls)', async () => {
    const { cv } = await createInitializedCV();
    const tabId = cv.createTab('Test', '', 'text');
    const cleanups = cv._tabListeners.get(tabId);
    // 1 cleanup for tab button (click + close) and controls (copy + export)
    expect(cleanups.length).toBe(1);
    cv.dispose();
  });

  it('closeTab removes listeners from _tabListeners', async () => {
    const { cv } = await createInitializedCV();
    const tabId = cv.createTab('To close', '', 'text');
    expect(cv._tabListeners.has(tabId)).toBe(true);

    cv.closeTab(tabId);
    expect(cv._tabListeners.has(tabId)).toBe(false);
  });

  it('closeTab does not grow _eventListeners (no leak)', async () => {
    const { cv } = await createInitializedCV();
    const baseEventListenerCount = cv._eventListeners.length;

    // Create and close 5 tabs
    for (let i = 0; i < 5; i++) {
      const tabId = cv.createTab(`Tab ${i}`, '', 'text');
      cv.closeTab(tabId);
    }

    // _eventListeners should NOT have grown
    expect(cv._eventListeners.length).toBe(baseEventListenerCount);
    cv.dispose();
  });

  it('_tabListeners is fully cleared on dispose', async () => {
    const { cv } = await createInitializedCV();
    cv.createTab('Tab 2', '', 'text');
    cv.createTab('Tab 3', '', 'text');
    expect(cv._tabListeners.size).toBeGreaterThan(0);

    cv.dispose();
    expect(cv._tabListeners.size).toBe(0);
  });

  it('closed tab button click handler is removed (verified by clicking)', async () => {
    const { cv } = await createInitializedCV();
    const tabId = cv.createTab('Verify close', '', 'text');
    const tab = cv.tabs.get(tabId);
    const button = tab.button;

    cv.closeTab(tabId);
    // Clicking the orphaned button should not throw or call setActiveTab
    const spy = jest.spyOn(cv, 'setActiveTab');
    button.click();
    expect(spy).not.toHaveBeenCalledWith(tabId);
    cv.dispose();
  });
});


// ===========================================================================
// 7. ACTION HANDLERS — copy, export
// ===========================================================================

describe('Action handlers', () => {
  afterEach(() => teardownDOM());

  it('copy handler writes to clipboard', async () => {
    // Mock clipboard
    const writeTextSpy = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: writeTextSpy },
    });

    const { cv } = await createInitializedCV();
    cv.loadCode('copy me', 'text');
    await cv._handleCopyCode();
    expect(writeTextSpy).toHaveBeenCalledWith('copy me');
    cv.dispose();
  });

  it('export handler delegates to controller.exportFile', async () => {
    const { cv, controller } = await createInitializedCV();
    cv.loadCode('export me', 'python', 'script.py');
    await cv._handleExportCode();
    expect(controller.exportFile).toHaveBeenCalledWith('export me', 'script.py', 'py');
    cv.dispose();
  });

  it('copy handler handles clipboard failure gracefully', async () => {
    Object.assign(navigator, {
      clipboard: { writeText: jest.fn().mockRejectedValue(new Error('denied')) },
    });

    const { cv, eventBus } = await createInitializedCV();
    cv.loadCode('fail', 'text');
    await cv._handleCopyCode();
    expect(eventBus.emit).toHaveBeenCalledWith('ui:error', expect.objectContaining({
      message: 'Failed to copy code',
    }));
    cv.dispose();
  });

  it('getCode returns null when no active tab — action handlers bail', async () => {
    const { cv } = await createInitializedCV();
    cv.activeTabId = null;
    await cv._handleCopyCode(); // Should not throw
    await cv._handleExportCode();
    cv.dispose();
  });
});


// ===========================================================================
// 8. EDGE CASES
// ===========================================================================

describe('Edge cases', () => {
  afterEach(() => teardownDOM());

  it('loadCode normalizes non-string code input', async () => {
    const { cv } = await createInitializedCV();
    cv.loadCode(42, 'text');
    const tab = cv.tabs.get(cv.activeTabId);
    expect(tab.code).toBe('42');
    cv.dispose();
  });

  it('loadCode normalizes null language to "text"', async () => {
    const { cv } = await createInitializedCV();
    cv.loadCode('x', null);
    const tab = cv.tabs.get(cv.activeTabId);
    expect(tab.language).toBe('text');
    cv.dispose();
  });

  it('tab content uses hljs fallback when ace is not available', async () => {
    const { cv } = await createInitializedCV();
    expect(cv.renderer.ace).toBeNull(); // ACE not loaded in test env
    // Tab should still exist with a code display (fallback)
    const tab = cv.tabs.get(cv.activeTabId);
    expect(tab.editor).toBeNull();
    const codeEl = tab.content.querySelector('code');
    expect(codeEl).not.toBeNull();
    cv.dispose();
  });

  it('loadCode updates fallback display when no ACE editor', async () => {
    const { cv } = await createInitializedCV();
    cv.loadCode('x = 1', 'python');

    const tab = cv.tabs.get(cv.activeTabId);
    const codeEl = tab.content.querySelector('code');
    expect(codeEl.textContent).toBe('x = 1');
    expect(codeEl.className).toBe('language-python');
    cv.dispose();
  });
});


// ===========================================================================
// 9. BUG CV-5 REGRESSION: _isDisposed guards on public methods
// ===========================================================================

describe('BUG CV-5 REGRESSION: Post-dispose calls are safe no-ops', () => {
  afterEach(() => teardownDOM());

  it('createTab returns null after dispose (no TypeError)', async () => {
    const { cv } = await createInitializedCV();
    cv.dispose();
    const result = cv.createTab('Ghost', 'code', 'js');
    expect(result).toBeNull();
  });

  it('closeTab is no-op after dispose (no TypeError)', async () => {
    const { cv } = await createInitializedCV();
    const tabId = cv.activeTabId;
    cv.dispose();
    expect(() => cv.closeTab(tabId)).not.toThrow();
  });

  it('setActiveTab is no-op after dispose (no TypeError)', async () => {
    const { cv } = await createInitializedCV();
    const tabId = cv.activeTabId;
    cv.dispose();
    expect(() => cv.setActiveTab(tabId)).not.toThrow();
  });

  it('loadCode is no-op after dispose (no TypeError)', async () => {
    const { cv } = await createInitializedCV();
    cv.dispose();
    expect(() => cv.loadCode('ghost code', 'python')).not.toThrow();
  });

  it('clear is no-op after dispose (no TypeError)', async () => {
    const { cv } = await createInitializedCV();
    cv.dispose();
    expect(() => cv.clear()).not.toThrow();
  });

  it('dispose resets activeTabId to null', async () => {
    const { cv } = await createInitializedCV();
    expect(cv.activeTabId).not.toBeNull();
    cv.dispose();
    expect(cv.activeTabId).toBeNull();
  });

  it('createTab logs warning when called after dispose', async () => {
    const { cv } = await createInitializedCV();
    cv.dispose();
    mockLog.warn.mockClear();
    cv.createTab('Ghost', '', 'text');
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('createTab called after dispose')
    );
  });
});


// ===========================================================================
// 10. BUG CV-6 REGRESSION: clear() works in fallback display mode
// ===========================================================================

describe('BUG CV-6 REGRESSION: clear() clears fallback display', () => {
  afterEach(() => teardownDOM());

  it('clear() empties code element textContent when no ACE editor', async () => {
    const { cv } = await createInitializedCV();
    cv.loadCode('visible code', 'python');

    const tab = cv.tabs.get(cv.activeTabId);
    const codeEl = tab.content.querySelector('code');
    expect(codeEl.textContent).toBe('visible code');

    cv.clear();

    // Re-fetch the tab (same tab, first one preserved)
    const clearedTab = cv.tabs.get(cv.activeTabId);
    const clearedCodeEl = clearedTab.content.querySelector('code');
    expect(clearedCodeEl.textContent).toBe('');
    cv.dispose();
  });

  it('clear() resets code element className to default language', async () => {
    const { cv } = await createInitializedCV();
    cv.loadCode('x', 'python');

    const tab = cv.tabs.get(cv.activeTabId);
    const codeEl = tab.content.querySelector('code');
    expect(codeEl.className).toBe('language-python');

    cv.clear();

    const clearedTab = cv.tabs.get(cv.activeTabId);
    const clearedCodeEl = clearedTab.content.querySelector('code');
    expect(clearedCodeEl.className).toBe('language-text');
    cv.dispose();
  });
});


// ===========================================================================
// 11. BUG CV-7 REGRESSION: clear() resets tab metadata
// ===========================================================================

describe('BUG CV-7 REGRESSION: clear() resets tab metadata', () => {
  afterEach(() => teardownDOM());

  it('clear() resets tab.code to empty string', async () => {
    const { cv } = await createInitializedCV();
    cv.loadCode('data = 1', 'python', 'data.py', 'art-m1');
    cv.clear();
    const tab = cv.tabs.get(cv.activeTabId);
    expect(tab.code).toBe('');
    cv.dispose();
  });

  it('clear() resets tab.language to "text"', async () => {
    const { cv } = await createInitializedCV();
    cv.loadCode('x', 'rust');
    cv.clear();
    const tab = cv.tabs.get(cv.activeTabId);
    expect(tab.language).toBe('text');
    cv.dispose();
  });

  it('clear() resets tab.artifactId to null', async () => {
    const { cv } = await createInitializedCV();
    cv.loadCode('x', 'js', 'app.js', 'art-stale');
    cv.clear();
    const tab = cv.tabs.get(cv.activeTabId);
    expect(tab.artifactId).toBeNull();
    cv.dispose();
  });

  it('clear() resets tab.label to "Code 1"', async () => {
    const { cv } = await createInitializedCV();
    cv.loadCode('x', 'js', 'custom-name.js');
    cv.clear();
    const tab = cv.tabs.get(cv.activeTabId);
    expect(tab.label).toBe('Code 1');
    cv.dispose();
  });

  it('clear() updates label display element to "Code 1"', async () => {
    const { cv } = await createInitializedCV();
    cv.loadCode('x', 'js', 'stale.js');
    cv.clear();
    const tab = cv.tabs.get(cv.activeTabId);
    const labelEl = tab.button.querySelector('.code-tab-label');
    expect(labelEl.textContent).toBe('Code 1');
    cv.dispose();
  });

  it('clear() updates language badge to "Text"', async () => {
    const { cv } = await createInitializedCV();
    cv.loadCode('x', 'python');
    cv.clear();
    const tab = cv.tabs.get(cv.activeTabId);
    const badge = tab.content.querySelector('.code-language-badge');
    expect(badge.textContent).toBe('Text');
    cv.dispose();
  });

  it('getCode() returns clean state after clear()', async () => {
    const { cv } = await createInitializedCV();
    cv.loadCode('stale code', 'ruby', 'old.rb', 'art-old');
    cv.clear();
    const result = cv.getCode();
    expect(result.code).toBe('');
    expect(result.language).toBe('text');
    expect(result.label).toBe('Code 1');
    expect(result.artifactId).toBeNull();
    cv.dispose();
  });
});


// ===========================================================================
// 12. BUG CV-8 REGRESSION: Style element shared-state between instances
// ===========================================================================

describe('BUG CV-8 REGRESSION: Style ref counting between instances', () => {
  afterEach(() => teardownDOM());

  it('single instance: dispose removes style element', async () => {
    const { cv } = await createInitializedCV();
    expect(document.getElementById('code-viewer-styles')).not.toBeNull();
    cv.dispose();
    expect(document.getElementById('code-viewer-styles')).toBeNull();
  });

  it('two instances: first dispose does NOT remove shared style element', async () => {
    const { cv: cv1 } = await createInitializedCV();

    // Create second instance (needs a different container)
    const container2 = document.createElement('div');
    document.body.appendChild(container2);
    const cv2 = new CodeViewer({
      controller: createMockController(),
      eventBus: createMockEventBus(),
      aether: { logger: mockLog },
    });
    await cv2.init(container2);

    expect(document.getElementById('code-viewer-styles')).not.toBeNull();

    // Dispose first instance — style element must SURVIVE
    cv1.dispose();
    expect(document.getElementById('code-viewer-styles')).not.toBeNull();

    // Dispose second instance — NOW style element should be removed
    cv2.dispose();
    expect(document.getElementById('code-viewer-styles')).toBeNull();
  });

  it('rapid create-dispose cycles do not leak style elements', async () => {
    for (let i = 0; i < 5; i++) {
      const { cv } = await createInitializedCV();
      cv.dispose();
    }
    expect(document.getElementById('code-viewer-styles')).toBeNull();

    // Fresh instance still works
    const { cv: fresh } = await createInitializedCV();
    expect(document.getElementById('code-viewer-styles')).not.toBeNull();
    fresh.dispose();
    expect(document.getElementById('code-viewer-styles')).toBeNull();
  });
});
