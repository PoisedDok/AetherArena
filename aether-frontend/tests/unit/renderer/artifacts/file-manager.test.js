'use strict';

// ---------------------------------------------------------------------------
// FileManager — Unit tests
// Source: src/renderer/artifacts/modules/files/FileManager.js
// Bugs fixed: FM-1 untracked item listeners, FM-2 XSS _renderError,
//   FM-3 modal leak on dispose, FM-4 disposed guard, FM-5 redundant Array wrap
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

// Mock normalizeArtifactPayload — pass-through by default, overridable per test
const mockNormalize = jest.fn((artifact) => artifact);
jest.mock('../../../../src/application/artifacts/ArtifactNormalizer', () => ({
  normalizeArtifactPayload: (...args) => mockNormalize(...args),
}));

const FileManager = require('../../../../src/renderer/artifacts/modules/files/FileManager');

// JSDOM polyfill: scrollIntoView is not implemented
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || function () {};

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
    emit: jest.fn((event, data) => {
      const arr = handlers.get(event);
      if (arr) arr.forEach(fn => fn(data));
    }),
    _handlers: handlers,
  };
}

function createMockController() {
  return {
    loadArtifactsForChat: jest.fn().mockResolvedValue([]),
    loadArtifact: jest.fn(),
    artifactCache: new Map(),
    hasContent: false,
    _trackBackendIndex: jest.fn(),
    sessionManager: null,
  };
}

function createMockStorageAPI() {
  return {
    deleteArtifact: jest.fn().mockResolvedValue({}),
    client: {
      put: jest.fn().mockResolvedValue({}),
    },
  };
}

function setupDOM() {
  document.body.innerHTML = '<div id="fm-container"></div>';
  return document.getElementById('fm-container');
}

function teardownDOM() {
  document.body.innerHTML = '';
}

/** Create a valid code artifact with all required fields */
function createCodeArtifact(overrides = {}) {
  return {
    id: `art-code-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    role: 'assistant',
    type: 'code',
    content: 'console.log("hello");',
    format: 'javascript',
    language: 'javascript',
    filename: null,
    executionGroup: 'exec_abc_1',
    request_id: 'req-1',
    chatId: 'chat-1',
    ...overrides,
  };
}

/** Create a valid output artifact */
function createOutputArtifact(overrides = {}) {
  return {
    id: `art-out-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    role: 'computer',
    type: 'output',
    content: '<div>result</div>',
    format: 'html',
    filename: null,
    executionGroup: 'exec_abc_1',
    request_id: 'req-1',
    chatId: 'chat-1',
    ...overrides,
  };
}

/** Create a valid attachment artifact */
function createAttachmentArtifact(overrides = {}) {
  return {
    id: `art-file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'file',
    content: 'raw data',
    filename: 'data.csv',
    chatId: 'chat-1',
    ...overrides,
  };
}

/** Create an initialized FileManager instance for tests requiring DOM */
async function createInitializedFM(overrides = {}) {
  const container = setupDOM();
  const eventBus = createMockEventBus();
  const controller = createMockController();
  const fm = new FileManager({
    controller,
    eventBus,
    storageAPI: createMockStorageAPI(),
    ...overrides,
  });
  await fm.init(container);
  return { fm, eventBus, controller, container };
}


// ===========================================================================
// 1. CONSTRUCTOR VALIDATION
// ===========================================================================

describe('Constructor validation', () => {
  it('throws if controller is missing', () => {
    expect(() => new FileManager({ eventBus: createMockEventBus() }))
      .toThrow('[FileManager] Controller required');
  });

  it('throws if eventBus is missing', () => {
    expect(() => new FileManager({ controller: createMockController() }))
      .toThrow('[FileManager] EventBus required');
  });

  it('initializes with correct default state', () => {
    const fm = new FileManager({
      controller: createMockController(),
      eventBus: createMockEventBus(),
    });
    expect(fm.container).toBeNull();
    expect(fm.currentChatId).toBeNull();
    expect(fm.currentFilter).toBe('all');
    expect(fm.selectedArtifactId).toBeNull();
    expect(fm.artifacts).toEqual([]);
    expect(fm.groups).toEqual([]);
    expect(fm._initialized).toBe(false);
    expect(fm._isDisposed).toBe(false);
    expect(fm._itemListeners).toEqual([]);
    expect(fm._activeModalTeardown).toBeNull();
    expect(fm._updateDebounceTimer).toBeNull();
  });
});


// ===========================================================================
// 2. PURE LOGIC — _groupArtifacts, _getArtifactCategory, _generateName,
//    _generateMeta, _getGroupIndex, _applyFilter
// ===========================================================================

describe('Pure logic', () => {
  let fm;

  beforeEach(() => {
    setupDOM();
    fm = new FileManager({
      controller: createMockController(),
      eventBus: createMockEventBus(),
    });
  });

  afterEach(() => {
    fm.dispose();
    teardownDOM();
  });

  describe('_getArtifactCategory', () => {
    it('returns "code" for assistant:code', () => {
      expect(fm._getArtifactCategory({ role: 'assistant', type: 'code' })).toBe('code');
    });

    it('returns "output" for computer:output', () => {
      expect(fm._getArtifactCategory({ role: 'computer', type: 'output' })).toBe('output');
    });

    it('returns "attachment" for type:file', () => {
      expect(fm._getArtifactCategory({ type: 'file' })).toBe('attachment');
    });

    it('returns null for schema-violating combinations', () => {
      expect(fm._getArtifactCategory({ role: 'computer', type: 'code' })).toBeNull();
      expect(fm._getArtifactCategory({ role: 'assistant', type: 'output' })).toBeNull();
      expect(fm._getArtifactCategory({ role: 'user', type: 'message' })).toBeNull();
    });

    it('returns category field if already set on artifact', () => {
      expect(fm._getArtifactCategory({ category: 'custom' })).toBe('custom');
    });
  });

  describe('_generateName', () => {
    it('returns filename if present', () => {
      expect(fm._generateName({ filename: 'hello.py', role: 'assistant', type: 'code' })).toBe('hello.py');
    });

    it('returns "source_code" for code artifacts', () => {
      expect(fm._generateName({ role: 'assistant', type: 'code' })).toBe('source_code');
    });

    it('returns "execution_result" for output artifacts', () => {
      expect(fm._generateName({ role: 'computer', type: 'output' })).toBe('execution_result');
    });

    it('returns "attachment" for file artifacts', () => {
      expect(fm._generateName({ type: 'file' })).toBe('attachment');
    });

    it('returns "artifact" for unknown category', () => {
      expect(fm._generateName({ role: 'unknown', type: 'unknown' })).toBe('artifact');
    });
  });

  describe('_generateMeta', () => {
    it('shows bytes for small content', () => {
      expect(fm._generateMeta({ content: 'hi', format: 'txt' })).toBe('TXT \u2022 2 B');
    });

    it('shows KB for content > 1024 bytes', () => {
      const content = 'x'.repeat(2048);
      expect(fm._generateMeta({ content, format: 'json' })).toBe('JSON \u2022 2.0 KB');
    });

    it('falls back to language if format is missing', () => {
      expect(fm._generateMeta({ content: 'x', language: 'python' })).toBe('PYTHON \u2022 1 B');
    });

    it('falls back to "txt" if both format and language are missing', () => {
      expect(fm._generateMeta({ content: '' })).toBe('TXT \u2022 0 B');
    });
  });

  describe('_groupArtifacts', () => {
    it('groups code + output by executionGroup', () => {
      const code = createCodeArtifact({ executionGroup: 'exec_1', request_id: 'r1' });
      const output = createOutputArtifact({ executionGroup: 'exec_1', request_id: 'r1' });
      const groups = fm._groupArtifacts([code, output]);
      expect(groups).toHaveLength(1);
      expect(groups[0].codeArtifacts).toHaveLength(1);
      expect(groups[0].outputArtifacts).toHaveLength(1);
      expect(groups[0].artifacts).toHaveLength(2);
    });

    it('creates separate groups for different executionGroups', () => {
      const code1 = createCodeArtifact({ executionGroup: 'exec_1', request_id: 'r1' });
      const code2 = createCodeArtifact({ executionGroup: 'exec_2', request_id: 'r2' });
      const groups = fm._groupArtifacts([code1, code2]);
      expect(groups).toHaveLength(2);
    });

    it('creates individual groups for attachments', () => {
      const att1 = createAttachmentArtifact({ id: 'f1' });
      const att2 = createAttachmentArtifact({ id: 'f2' });
      const groups = fm._groupArtifacts([att1, att2]);
      expect(groups).toHaveLength(2);
      expect(groups[0].attachmentArtifacts).toHaveLength(1);
      expect(groups[1].attachmentArtifacts).toHaveLength(1);
    });

    it('rejects non-conforming artifacts silently', () => {
      const bad = { id: 'bad', role: 'user', type: 'message', executionGroup: 'e1', request_id: 'r1' };
      const code = createCodeArtifact();
      const groups = fm._groupArtifacts([bad, code]);
      expect(groups).toHaveLength(1);
      expect(groups[0].codeArtifacts).toHaveLength(1);
    });

    it('filters out console artifacts by rawType', () => {
      const consoleArt = createOutputArtifact({ rawType: 'console' });
      const code = createCodeArtifact();
      const groups = fm._groupArtifacts([consoleArt, code]);
      // Console artifact should be filtered, leaving only the code artifact (incomplete group)
      expect(groups).toHaveLength(1);
      expect(groups[0].outputArtifacts).toHaveLength(0);
    });

    it('filters out console artifacts by metadata.raw_type', () => {
      const consoleArt = createOutputArtifact({ metadata: { raw_type: 'console' } });
      const code = createCodeArtifact();
      const groups = fm._groupArtifacts([consoleArt, code]);
      expect(groups).toHaveLength(1);
      expect(groups[0].outputArtifacts).toHaveLength(0);
    });

    it('trims duplicate output artifacts keeping richest format', () => {
      const htmlOut = createOutputArtifact({ id: 'o1', format: 'html' });
      const textOut = createOutputArtifact({ id: 'o2', format: 'text' });
      const code = createCodeArtifact();
      const groups = fm._groupArtifacts([code, htmlOut, textOut]);
      expect(groups).toHaveLength(1);
      expect(groups[0].outputArtifacts).toHaveLength(1);
      expect(groups[0].outputArtifacts[0].format).toBe('html');
    });

    it('throws CONTRACT VIOLATION for code without executionGroup', () => {
      const bad = { id: 'c1', role: 'assistant', type: 'code', request_id: 'r1' };
      expect(() => fm._groupArtifacts([bad])).toThrow('CONTRACT VIOLATION');
    });

    it('throws CONTRACT VIOLATION for code without request_id', () => {
      const bad = { id: 'c1', role: 'assistant', type: 'code', executionGroup: 'e1' };
      expect(() => fm._groupArtifacts([bad])).toThrow('CONTRACT VIOLATION');
    });

    it('returns Array (not Map)', () => {
      const result = fm._groupArtifacts([]);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('_applyFilter', () => {
    beforeEach(() => {
      const code = createCodeArtifact({ executionGroup: 'e1', request_id: 'r1' });
      const output = createOutputArtifact({ executionGroup: 'e1', request_id: 'r1' });
      const att = createAttachmentArtifact();
      fm.groups = fm._groupArtifacts([code, output, att]);
    });

    it('"all" returns all groups', () => {
      fm.currentFilter = 'all';
      expect(fm._applyFilter()).toHaveLength(2); // 1 execution + 1 attachment
    });

    it('"code" returns only groups with code', () => {
      fm.currentFilter = 'code';
      const result = fm._applyFilter();
      expect(result).toHaveLength(1);
      expect(result[0].codeArtifacts.length).toBeGreaterThan(0);
    });

    it('"output" returns only groups with output', () => {
      fm.currentFilter = 'output';
      const result = fm._applyFilter();
      expect(result).toHaveLength(1);
      expect(result[0].outputArtifacts.length).toBeGreaterThan(0);
    });

    it('"attachment" returns only attachment groups', () => {
      fm.currentFilter = 'attachment';
      const result = fm._applyFilter();
      expect(result).toHaveLength(1);
      expect(result[0].attachmentArtifacts.length).toBeGreaterThan(0);
    });

    it('"linked" returns only groups with both code AND output', () => {
      fm.currentFilter = 'linked';
      const result = fm._applyFilter();
      expect(result).toHaveLength(1);
      expect(result[0].codeArtifacts.length).toBeGreaterThan(0);
      expect(result[0].outputArtifacts.length).toBeGreaterThan(0);
    });
  });

  describe('_getGroupIndex', () => {
    it('extracts sequence number from exec_ format', () => {
      fm.groups = [{ executionGroup: 'exec_abc_3' }];
      expect(fm._getGroupIndex(fm.groups[0])).toBe(3);
    });

    it('falls back to position-based index if not exec_ format', () => {
      fm.groups = [{ executionGroup: 'custom_group' }];
      expect(fm._getGroupIndex(fm.groups[0])).toBe(1);
    });

    it('handles missing executionGroup', () => {
      fm.groups = [{}];
      expect(fm._getGroupIndex(fm.groups[0])).toBe(1);
    });
  });
});


// ===========================================================================
// 3. LIFECYCLE — init, dispose, idempotency
// ===========================================================================

describe('Lifecycle', () => {
  afterEach(() => teardownDOM());

  it('init creates DOM structure', async () => {
    const { fm, container } = await createInitializedFM();
    expect(fm._initialized).toBe(true);
    expect(fm.headerEl).not.toBeNull();
    expect(fm.controlsEl).not.toBeNull();
    expect(fm.listEl).not.toBeNull();
    expect(container.querySelector('.file-manager-header')).not.toBeNull();
    expect(container.querySelector('.file-controls')).not.toBeNull();
    expect(container.querySelector('.file-list')).not.toBeNull();
    fm.dispose();
  });

  it('init is idempotent — second call is no-op', async () => {
    const { fm, container } = await createInitializedFM();
    const headerCount = container.querySelectorAll('.file-manager-header').length;
    await fm.init(container);
    expect(container.querySelectorAll('.file-manager-header').length).toBe(headerCount);
    fm.dispose();
  });

  it('init creates 5 filter buttons', async () => {
    const { fm, container } = await createInitializedFM();
    const filterBtns = container.querySelectorAll('.filter-btn');
    expect(filterBtns.length).toBe(5); // all, code, output, attachment, linked
    fm.dispose();
  });

  it('init emits COMPONENT_READY event', async () => {
    const { fm, eventBus } = await createInitializedFM();
    expect(eventBus.emit).toHaveBeenCalledWith('ui:component:ready', expect.objectContaining({
      component: 'FileManager',
    }));
    fm.dispose();
  });

  it('init throws if container is null', async () => {
    const fm = new FileManager({
      controller: createMockController(),
      eventBus: createMockEventBus(),
    });
    await expect(fm.init(null)).rejects.toThrow('[FileManager] Container required');
  });

  it('dispose nulls all DOM references', async () => {
    const { fm } = await createInitializedFM();
    fm.dispose();
    expect(fm.container).toBeNull();
    expect(fm.headerEl).toBeNull();
    expect(fm.controlsEl).toBeNull();
    expect(fm.listEl).toBeNull();
  });

  it('dispose sets _isDisposed = true', async () => {
    const { fm } = await createInitializedFM();
    fm.dispose();
    expect(fm._isDisposed).toBe(true);
  });

  it('dispose sets _initialized = false', async () => {
    const { fm } = await createInitializedFM();
    expect(fm._initialized).toBe(true);
    fm.dispose();
    expect(fm._initialized).toBe(false);
  });

  it('dispose is idempotent — safe to call twice', async () => {
    const { fm } = await createInitializedFM();
    fm.dispose();
    expect(() => fm.dispose()).not.toThrow();
  });

  it('dispose clears debounce timer', async () => {
    jest.useFakeTimers();
    const { fm } = await createInitializedFM();
    fm._updateDebounceTimer = setTimeout(() => {}, 5000);
    fm.dispose();
    expect(fm._updateDebounceTimer).toBeNull();
    jest.useRealTimers();
  });

  it('dispose removes all event bus subscriptions', async () => {
    const { fm } = await createInitializedFM();
    expect(fm._eventListeners.length).toBe(3); // chat_switched, artifact_finalized, session_switched
    fm.dispose();
    expect(fm._eventListeners).toEqual([]);
  });

  it('dispose cleans all DOM listeners', async () => {
    const { fm } = await createInitializedFM();
    expect(fm._domListeners.length).toBeGreaterThan(0); // filter buttons
    fm.dispose();
    expect(fm._domListeners).toEqual([]);
  });
});


// ===========================================================================
// 4. DOM OPERATIONS — renderFiles, filter change, file click, addFile
// ===========================================================================

describe('DOM operations', () => {
  let fm, eventBus, controller;

  beforeEach(async () => {
    mockNormalize.mockImplementation((artifact) => artifact);
    const result = await createInitializedFM();
    fm = result.fm;
    eventBus = result.eventBus;
    controller = result.controller;
  });

  afterEach(() => {
    fm.dispose();
    teardownDOM();
  });

  it('_renderFiles renders groups with items', () => {
    const code = createCodeArtifact({ executionGroup: 'e1', request_id: 'r1' });
    const output = createOutputArtifact({ executionGroup: 'e1', request_id: 'r1' });
    fm.artifacts = [code, output];
    fm.groups = fm._groupArtifacts([code, output]);
    fm._renderFiles();

    const items = fm.listEl.querySelectorAll('.file-item');
    expect(items.length).toBe(2);
  });

  it('_renderFiles shows empty state when no groups', () => {
    fm.groups = [];
    fm._renderFiles();
    const emptyEl = fm.listEl.querySelector('.empty-state');
    expect(emptyEl).not.toBeNull();
    expect(emptyEl.textContent).toContain('No artifacts match filter');
  });

  it('filter change updates active button and re-renders', () => {
    const code = createCodeArtifact({ executionGroup: 'e1', request_id: 'r1' });
    const output = createOutputArtifact({ executionGroup: 'e1', request_id: 'r1' });
    fm.artifacts = [code, output];
    fm.groups = fm._groupArtifacts([code, output]);
    fm._renderFiles();

    // Click "code" filter
    const codeBtn = fm.controlsEl.querySelector('[data-filter="code"]');
    codeBtn.click();
    expect(fm.currentFilter).toBe('code');
    expect(codeBtn.classList.contains('active')).toBe(true);

    // Only code items should remain
    const items = fm.listEl.querySelectorAll('.file-item');
    expect(items.length).toBe(1);
  });

  it('file item click calls controller.loadArtifact', () => {
    const code = createCodeArtifact({ executionGroup: 'e1', request_id: 'r1' });
    fm.artifacts = [code];
    fm.groups = fm._groupArtifacts([code]);
    fm._renderFiles();

    const item = fm.listEl.querySelector('.file-item');
    item.click();
    expect(controller.loadArtifact).toHaveBeenCalledTimes(1);
    expect(controller.loadArtifact).toHaveBeenCalledWith(code, { autoSwitch: true, origin: 'file-click' });
  });

  it('file item click sets active class', () => {
    const code = createCodeArtifact({ executionGroup: 'e1', request_id: 'r1' });
    fm.artifacts = [code];
    fm.groups = fm._groupArtifacts([code]);
    fm._renderFiles();

    const item = fm.listEl.querySelector('.file-item');
    item.click();
    expect(item.classList.contains('active')).toBe(true);
    expect(fm.selectedArtifactId).toBe(code.id);
  });

  it('file item click emits FILE_SELECTED event', () => {
    const code = createCodeArtifact({ executionGroup: 'e1', request_id: 'r1' });
    fm.artifacts = [code];
    fm.groups = fm._groupArtifacts([code]);
    fm._renderFiles();

    fm.listEl.querySelector('.file-item').click();
    expect(eventBus.emit).toHaveBeenCalledWith('artifacts:file:selected', { artifact: code });
  });

  it('attachment click emits artifacts:open-file instead of loadArtifact', () => {
    const att = createAttachmentArtifact({ id: 'att-1', filename: 'data.csv' });
    fm.artifacts = [att];
    fm.groups = fm._groupArtifacts([att]);
    fm._renderFiles();

    fm.listEl.querySelector('.file-item').click();
    expect(controller.loadArtifact).not.toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith('artifacts:open-file', expect.objectContaining({
      artifactId: 'att-1',
      filename: 'data.csv',
    }));
  });

  it('highlightArtifact scrolls to and marks item active', () => {
    const code = createCodeArtifact({ id: 'target-art', executionGroup: 'e1', request_id: 'r1' });
    const code2 = createCodeArtifact({ id: 'other-art', executionGroup: 'e2', request_id: 'r2' });
    fm.artifacts = [code, code2];
    fm.groups = fm._groupArtifacts([code, code2]);
    fm._renderFiles();

    fm.highlightArtifact('target-art');
    const target = fm.listEl.querySelector('[data-artifact-id="target-art"]');
    const other = fm.listEl.querySelector('[data-artifact-id="other-art"]');
    expect(target.classList.contains('active')).toBe(true);
    expect(other.classList.contains('active')).toBe(false);
  });

  it('addFile deduplicates by ID (updates existing)', () => {
    const code = createCodeArtifact({ id: 'dup-1', executionGroup: 'e1', request_id: 'r1' });
    fm.artifacts = [{ ...code, content: 'old' }];
    fm.groups = fm._groupArtifacts(fm.artifacts);

    const updated = { ...code, content: 'new' };
    fm.addFile(updated);
    expect(fm.artifacts).toHaveLength(1);
    expect(fm.artifacts[0].content).toBe('new');
  });

  it('addFile adds new artifact and emits FILE_ADDED', () => {
    const code = createCodeArtifact({ executionGroup: 'e1', request_id: 'r1' });
    fm.addFile(code);
    expect(fm.artifacts).toHaveLength(1);
    expect(eventBus.emit).toHaveBeenCalledWith('artifacts:file:added', { artifact: code });
  });

  it('addFile skips null artifact with warning', () => {
    fm.addFile(null);
    expect(fm.artifacts).toHaveLength(0);
    expect(mockLog.warn).toHaveBeenCalledWith('[FileManager] addFile called with null/undefined artifact');
  });

  it('_updateCount displays total artifact count', () => {
    const code = createCodeArtifact({ executionGroup: 'e1', request_id: 'r1' });
    const output = createOutputArtifact({ executionGroup: 'e1', request_id: 'r1' });
    fm.artifacts = [code, output];
    fm.groups = fm._groupArtifacts([code, output]);
    fm._renderFiles();

    const countEl = fm.headerEl.querySelector('.file-manager-count');
    expect(countEl.textContent).toBe('2');
  });
});


// ===========================================================================
// 5. EVENT WIRING
// ===========================================================================

describe('Event wiring', () => {
  afterEach(() => teardownDOM());

  it('CHAT_SWITCHED triggers loadFiles with correct chatId', async () => {
    const { fm, eventBus } = await createInitializedFM();
    const spy = jest.spyOn(fm, 'loadFiles').mockResolvedValue(undefined);

    eventBus.emit('artifacts:chat:switched', { chatId: 'chat-99' });
    expect(spy).toHaveBeenCalledWith('chat-99');
    fm.dispose();
  });

  it('SESSION_SWITCHED triggers loadFiles', async () => {
    const { fm, eventBus } = await createInitializedFM();
    const spy = jest.spyOn(fm, 'loadFiles').mockResolvedValue(undefined);

    eventBus.emit('artifacts:session:switched', { chatId: 'chat-77' });
    expect(spy).toHaveBeenCalledWith('chat-77');
    fm.dispose();
  });

  it('ARTIFACT_FINALIZED debounces loadFiles (300ms)', async () => {
    jest.useFakeTimers();
    const { fm, eventBus } = await createInitializedFM();
    fm.currentChatId = 'chat-1';
    const spy = jest.spyOn(fm, 'loadFiles').mockResolvedValue(undefined);

    // Fire 3 rapid events
    eventBus.emit('artifacts:artifact:finalized', { chatId: 'chat-1' });
    eventBus.emit('artifacts:artifact:finalized', { chatId: 'chat-1' });
    eventBus.emit('artifacts:artifact:finalized', { chatId: 'chat-1' });

    // Should not have called yet (debounced)
    expect(spy).not.toHaveBeenCalled();

    // Advance past debounce
    jest.advanceTimersByTime(350);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('chat-1');

    fm.dispose();
    jest.useRealTimers();
  });

  it('ARTIFACT_FINALIZED ignores events for different chatId', async () => {
    jest.useFakeTimers();
    const { fm, eventBus } = await createInitializedFM();
    fm.currentChatId = 'chat-1';
    const spy = jest.spyOn(fm, 'loadFiles').mockResolvedValue(undefined);

    eventBus.emit('artifacts:artifact:finalized', { chatId: 'chat-OTHER' });
    jest.advanceTimersByTime(350);
    expect(spy).not.toHaveBeenCalled();

    fm.dispose();
    jest.useRealTimers();
  });

  it('ARTIFACT_FINALIZED auto-detects chatId on first event', async () => {
    jest.useFakeTimers();
    const { fm, eventBus } = await createInitializedFM();
    fm.currentChatId = null; // No chat selected yet
    const spy = jest.spyOn(fm, 'loadFiles').mockResolvedValue(undefined);

    eventBus.emit('artifacts:artifact:finalized', { chatId: 'new-chat-1' });
    expect(fm.currentChatId).toBe('new-chat-1');

    jest.advanceTimersByTime(350);
    expect(spy).toHaveBeenCalledWith('new-chat-1');

    fm.dispose();
    jest.useRealTimers();
  });
});


// ===========================================================================
// 6. loadFiles — integration with controller
// ===========================================================================

describe('loadFiles', () => {
  afterEach(() => teardownDOM());

  it('shows empty state when chatId is null', async () => {
    const { fm } = await createInitializedFM();
    await fm.loadFiles(null);
    expect(fm.listEl.querySelector('.empty-state')).not.toBeNull();
    fm.dispose();
  });

  it('loads and groups artifacts from controller', async () => {
    const code = createCodeArtifact({ executionGroup: 'e1', request_id: 'r1' });
    const output = createOutputArtifact({ executionGroup: 'e1', request_id: 'r1' });
    const controller = createMockController();
    controller.loadArtifactsForChat.mockResolvedValue([code, output]);

    const { fm } = await createInitializedFM({ controller });
    await fm.loadFiles('chat-1');

    expect(fm.artifacts.length).toBe(2);
    expect(fm.groups.length).toBe(1);
    expect(fm.listEl.querySelectorAll('.file-item').length).toBe(2);
    fm.dispose();
  });

  it('handles controller load failure gracefully (logs warning, shows empty)', async () => {
    const controller = createMockController();
    controller.loadArtifactsForChat.mockRejectedValue(new Error('DB down'));

    const { fm } = await createInitializedFM({ controller });
    await fm.loadFiles('chat-1');

    // Controller failure is caught internally (not propagated to _renderError).
    // The result is zero artifacts loaded, so empty/no-match state displays.
    expect(mockLog.warn).toHaveBeenCalledWith(
      '[FileManager] Controller artifact load failed:',
      expect.any(Error)
    );
    expect(fm.artifacts.length).toBe(0);
    fm.dispose();
  });

  it('repopulates controller artifactCache after load', async () => {
    const code = createCodeArtifact({ id: 'cached-1', executionGroup: 'e1', request_id: 'r1' });
    const controller = createMockController();
    controller.loadArtifactsForChat.mockResolvedValue([code]);

    const { fm } = await createInitializedFM({ controller });
    await fm.loadFiles('chat-1');

    expect(controller.artifactCache.has('cached-1')).toBe(true);
    expect(controller.hasContent).toBe(true);
    fm.dispose();
  });

  it('skips phantom artifacts with invalid IDs from controller cache', async () => {
    const controller = createMockController();
    controller.loadArtifactsForChat.mockResolvedValue([]);
    controller.artifactCache.set('NO_ID', { id: 'NO_ID', chatId: 'chat-1' });
    controller.artifactCache.set('valid', createCodeArtifact({ id: 'valid', chatId: 'chat-1', executionGroup: 'e1', request_id: 'r1' }));

    const { fm } = await createInitializedFM({ controller });
    await fm.loadFiles('chat-1');

    // Only the valid artifact should be loaded
    expect(fm.artifacts.some(a => a.id === 'NO_ID')).toBe(false);
    expect(fm.artifacts.some(a => a.id === 'valid')).toBe(true);
    fm.dispose();
  });
});


// ===========================================================================
// 7. BUG REGRESSIONS
// ===========================================================================

// BUG FM-1 REGRESSION suite removed.
// The FileManager now uses event delegation on the list container (_trackDOMListener)
// instead of attaching individual listeners to each item element.
// Thus, _itemListeners tracking is obsolete and items do not leak listeners.

describe('BUG FM-2 REGRESSION: XSS prevented in _renderError', () => {
  afterEach(() => teardownDOM());

  it('error message is escaped (no HTML injection)', async () => {
    const { fm } = await createInitializedFM();
    fm._renderError({ message: '<img src=x onerror=alert(1)>' });

    // Should use textContent, not innerHTML
    const errorDiv = fm.listEl.querySelector('div');
    expect(errorDiv).not.toBeNull();
    expect(errorDiv.textContent).toBe('<img src=x onerror=alert(1)>');
    // Ensure the raw HTML was NOT injected
    expect(fm.listEl.querySelector('img')).toBeNull();
    fm.dispose();
  });

  it('plain error message displays correctly', async () => {
    const { fm } = await createInitializedFM();
    fm._renderError({ message: 'Something went wrong' });

    const errorDiv = fm.listEl.querySelector('div');
    expect(errorDiv.textContent).toBe('Something went wrong');
    fm.dispose();
  });
});

describe('BUG FM-3 REGRESSION: Modal closed on dispose', () => {
  afterEach(() => teardownDOM());

  it('_showEditModal sets _activeModalTeardown', async () => {
    const { fm } = await createInitializedFM();
    const artifact = createCodeArtifact();

    // Start edit modal (returns a Promise)
    const editPromise = fm._showEditModal(artifact);
    expect(fm._activeModalTeardown).not.toBeNull();
    expect(typeof fm._activeModalTeardown).toBe('function');

    // Close it manually
    fm._activeModalTeardown();
    const result = await editPromise;
    expect(result).toBeNull(); // Cancelled
    fm.dispose();
  });

  it('dispose closes open edit modal and removes document keydown listener', async () => {
    const { fm } = await createInitializedFM();
    const artifact = createCodeArtifact();

    const editPromise = fm._showEditModal(artifact);
    expect(document.querySelector('.file-manager-edit-modal')).not.toBeNull();

    fm.dispose();
    const result = await editPromise;
    expect(result).toBeNull(); // Resolved as cancelled
    expect(fm._activeModalTeardown).toBeNull();
    // Modal overlay should be removed
    expect(document.querySelector('.file-manager-modal-overlay')).toBeNull();
  });

  it('_showConfirmDialog sets _activeModalTeardown', async () => {
    const { fm } = await createInitializedFM();
    const confirmPromise = fm._showConfirmDialog('Title', 'Message');
    expect(fm._activeModalTeardown).not.toBeNull();

    fm._activeModalTeardown();
    const result = await confirmPromise;
    expect(result).toBe(false); // Cancelled
    fm.dispose();
  });

  it('dispose closes open confirm dialog', async () => {
    const { fm } = await createInitializedFM();
    const confirmPromise = fm._showConfirmDialog('Title', 'Message');

    fm.dispose();
    const result = await confirmPromise;
    expect(result).toBe(false);
    expect(document.querySelector('.file-manager-confirm-modal')).toBeNull();
  });
});

describe('BUG FM-4 REGRESSION: Disposed guard blocks operations', () => {
  afterEach(() => teardownDOM());

  it('loadFiles is no-op after dispose', async () => {
    const { fm, controller } = await createInitializedFM();
    fm.dispose();
    controller.loadArtifactsForChat.mockClear();

    await fm.loadFiles('chat-1');
    expect(controller.loadArtifactsForChat).not.toHaveBeenCalled();
  });

  it('addFile is no-op after dispose', async () => {
    const { fm } = await createInitializedFM();
    fm.dispose();

    fm.addFile(createCodeArtifact());
    // No error, artifacts unchanged
    expect(fm.artifacts).toEqual([]);
  });

  it('highlightArtifact is no-op after dispose', async () => {
    const { fm } = await createInitializedFM();
    fm.dispose();
    // Should not throw even though listEl is null
    expect(() => fm.highlightArtifact('some-id')).not.toThrow();
  });

  it('event bus callbacks are no-op after dispose', async () => {
    const { fm, eventBus } = await createInitializedFM();
    const spy = jest.spyOn(fm, 'loadFiles');
    fm.dispose();

    // Manually emit events (the cleanup should have removed handlers,
    // but test the guard as a defense-in-depth check)
    try {
      const chatSwitchedHandlers = eventBus._handlers.get('artifacts:chat:switched') || [];
      chatSwitchedHandlers.forEach(h => h({ chatId: 'test' }));
    } catch (_) { /* Expected if handlers were removed */ }

    // loadFiles should not have been invoked (disposed guard or removed handler)
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('BUG FM-5 REGRESSION: No redundant Array wrapping', () => {
  afterEach(() => teardownDOM());

  it('addFile assigns _groupArtifacts result directly (returns Array)', async () => {
    const { fm } = await createInitializedFM();
    const code = createCodeArtifact({ executionGroup: 'e1', request_id: 'r1' });
    fm.addFile(code);
    expect(Array.isArray(fm.groups)).toBe(true);
    // Verify it's the direct Array, not a re-wrapped one
    expect(fm.groups).toEqual(fm._groupArtifacts(fm.artifacts));
    fm.dispose();
  });
});


// ===========================================================================
// 8. EDGE CASES
// ===========================================================================

describe('Edge cases', () => {
  afterEach(() => teardownDOM());

  it('loadFiles with normalize failure skips corrupt artifacts', async () => {
    const controller = createMockController();
    const good = createCodeArtifact({ id: 'good', executionGroup: 'e1', request_id: 'r1' });
    const bad = { id: 'bad', corrupt: true };
    controller.loadArtifactsForChat.mockResolvedValue([good, bad]);

    // Make normalize throw for the bad artifact
    mockNormalize.mockImplementation((art) => {
      if (art.corrupt) throw new Error('Cannot normalize');
      return art;
    });

    const { fm } = await createInitializedFM({ controller });
    await fm.loadFiles('chat-1');

    expect(fm.artifacts.some(a => a.id === 'good')).toBe(true);
    expect(fm.artifacts.some(a => a.id === 'bad')).toBe(false);
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to normalize'),
      expect.any(Object)
    );
    fm.dispose();
    mockNormalize.mockImplementation((artifact) => artifact);
  });

  it('action button click does not trigger file click', async () => {
    const { fm, controller } = await createInitializedFM();
    const code = createCodeArtifact({ executionGroup: 'e1', request_id: 'r1' });
    fm.artifacts = [code];
    fm.groups = fm._groupArtifacts([code]);
    fm._renderFiles();

    // Click the export button
    const exportBtn = fm.listEl.querySelector('.file-action-export');
    exportBtn.click();

    // loadArtifact should NOT have been called (stopPropagation)
    expect(controller.loadArtifact).not.toHaveBeenCalled();
    fm.dispose();
  });

  it('_renderError sets HTML to error message', async () => {
    const { fm } = await createInitializedFM();
    const code = createCodeArtifact({ executionGroup: 'e1', request_id: 'r1' });
    fm.artifacts = [code];
    fm.groups = fm._groupArtifacts([code]);
    fm._renderFiles();

    fm._renderError({ message: 'test error' });
    expect(fm.listEl.innerHTML).toContain('test error');
    fm.dispose();
  });

  it('addFile handles normalize failure gracefully', async () => {
    mockNormalize.mockImplementationOnce(() => { throw new Error('Bad payload'); });
    const { fm } = await createInitializedFM();
    fm.addFile({ id: 'bad' });
    expect(fm.artifacts).toHaveLength(0);
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to normalize'),
      expect.any(Object)
    );
    fm.dispose();
  });

  it('modal Escape key cancels edit modal', async () => {
    const { fm } = await createInitializedFM();
    const artifact = createCodeArtifact();

    const editPromise = fm._showEditModal(artifact);

    // Simulate Escape key
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    document.dispatchEvent(event);

    const result = await editPromise;
    expect(result).toBeNull();
    fm.dispose();
  });

  it('modal Ctrl+S saves content', async () => {
    const { fm } = await createInitializedFM();
    const artifact = createCodeArtifact({ content: 'original' });

    const editPromise = fm._showEditModal(artifact);

    // Change textarea content
    const textarea = document.querySelector('.file-manager-edit-textarea');
    textarea.value = 'modified content';

    // Simulate Ctrl+S
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true });
    document.dispatchEvent(event);

    const result = await editPromise;
    expect(result).toBe('modified content');
    fm.dispose();
  });
});


// ===========================================================================
// BUG FM-7 REGRESSION: _renderEmpty uses textContent (XSS defense-in-depth)
// ===========================================================================

describe('BUG FM-7 REGRESSION: _renderEmpty XSS defense', () => {
  afterEach(() => teardownDOM());

  it('_renderEmpty escapes HTML in message (no injection)', async () => {
    const { fm } = await createInitializedFM();
    fm._renderEmpty('<script>alert("xss")</script>');

    const emptyEl = fm.listEl.querySelector('.empty-state');
    expect(emptyEl).not.toBeNull();
    // textContent should contain the raw string, NOT executed HTML
    expect(emptyEl.textContent).toBe('<script>alert("xss")</script>');
    // innerHTML should have escaped entities
    expect(emptyEl.innerHTML).not.toContain('<script>');
    fm.dispose();
  });

  it('_renderEmpty displays plain message correctly', async () => {
    const { fm } = await createInitializedFM();
    fm._renderEmpty('No artifacts found');

    const emptyEl = fm.listEl.querySelector('.empty-state');
    expect(emptyEl.textContent).toBe('No artifacts found');
    fm.dispose();
  });
});


// ===========================================================================
// BUG FM-9 REGRESSION: _renderEmpty and _renderLoading clean item listeners
// ===========================================================================

// BUG FM-9 REGRESSION suite removed.
// _itemListeners tracking is obsolete since FileManager now uses event delegation.


// ===========================================================================
// BUG FM-10 REGRESSION: dispose() resets artifact state for GC
// ===========================================================================

describe('BUG FM-10 REGRESSION: dispose resets artifact state', () => {
  afterEach(() => teardownDOM());

  it('dispose resets artifacts array to empty', async () => {
    const { fm, controller } = await createInitializedFM();
    const code = createCodeArtifact();
    const output = createOutputArtifact();
    controller.loadArtifactsForChat.mockResolvedValue([code, output]);
    await fm.loadFiles('chat-1');
    expect(fm.artifacts.length).toBeGreaterThan(0);

    fm.dispose();
    expect(fm.artifacts).toEqual([]);
  });

  it('dispose resets groups array to empty', async () => {
    const { fm, controller } = await createInitializedFM();
    const code = createCodeArtifact();
    const output = createOutputArtifact();
    controller.loadArtifactsForChat.mockResolvedValue([code, output]);
    await fm.loadFiles('chat-1');
    expect(fm.groups.length).toBeGreaterThan(0);

    fm.dispose();
    expect(fm.groups).toEqual([]);
  });

  it('dispose resets currentChatId to null', async () => {
    const { fm, controller } = await createInitializedFM();
    controller.loadArtifactsForChat.mockResolvedValue([]);
    await fm.loadFiles('chat-123');
    expect(fm.currentChatId).toBe('chat-123');

    fm.dispose();
    expect(fm.currentChatId).toBeNull();
  });

  it('dispose resets selectedArtifactId to null', async () => {
    const { fm, controller } = await createInitializedFM();
    const code = createCodeArtifact();
    const output = createOutputArtifact();
    controller.loadArtifactsForChat.mockResolvedValue([code, output]);
    await fm.loadFiles('chat-1');

    // Select an artifact
    fm.selectedArtifactId = code.id;
    expect(fm.selectedArtifactId).not.toBeNull();

    fm.dispose();
    expect(fm.selectedArtifactId).toBeNull();
  });
});


// ===========================================================================
// 9. BRANCH COVERAGE — Targeted tests for uncovered branches
// ===========================================================================

describe('SessionManager initialization', () => {
  afterEach(() => teardownDOM());

  it('skips _initializeSessionManager when sessionManager already provided', async () => {
    const mockSessionManager = { switchSession: jest.fn() };
    const { fm } = await createInitializedFM({ sessionManager: mockSessionManager });
    // sessionManager should be the one provided, not from window or controller
    expect(fm.sessionManager).toBe(mockSessionManager);
    fm.dispose();
  });

  it('falls back to window.artifactSessionManager', async () => {
    const mockWindowSM = { switchSession: jest.fn() };
    const origASM = window.artifactSessionManager;
    window.artifactSessionManager = mockWindowSM;
    try {
      const { fm } = await createInitializedFM();
      expect(fm.sessionManager).toBe(mockWindowSM);
      fm.dispose();
    } finally {
      if (origASM === undefined) delete window.artifactSessionManager;
      else window.artifactSessionManager = origASM;
    }
  });

  it('falls back to controller.sessionManager', async () => {
    const mockControllerSM = { switchSession: jest.fn() };
    const controller = createMockController();
    controller.sessionManager = mockControllerSM;
    const { fm } = await createInitializedFM({ controller });
    expect(fm.sessionManager).toBe(mockControllerSM);
    fm.dispose();
  });
});

describe('loadFiles sessionManager integration', () => {
  afterEach(() => teardownDOM());

  it('loads artifacts from sessionManager when available', async () => {
    const sessionArtifact = createCodeArtifact({ id: 'session-art', executionGroup: 'e1', request_id: 'r1' });
    const mockSM = {
      switchSession: jest.fn().mockResolvedValue({ artifacts: [sessionArtifact] }),
    };
    const controller = createMockController();
    controller.loadArtifactsForChat.mockResolvedValue([]);

    const { fm } = await createInitializedFM({ sessionManager: mockSM, controller });
    await fm.loadFiles('chat-1');

    expect(mockSM.switchSession).toHaveBeenCalledWith('chat-1');
    expect(fm.artifacts.some(a => a.id === 'session-art')).toBe(true);
    fm.dispose();
  });

  it('handles sessionManager failure gracefully', async () => {
    const mockSM = {
      switchSession: jest.fn().mockRejectedValue(new Error('Session error')),
    };
    const controller = createMockController();
    controller.loadArtifactsForChat.mockResolvedValue([]);

    const { fm } = await createInitializedFM({ sessionManager: mockSM, controller });
    await fm.loadFiles('chat-1');

    expect(mockLog.warn).toHaveBeenCalledWith(
      '[FileManager] Session manager load failed:',
      expect.any(Error)
    );
    fm.dispose();
  });

  it('session artifacts not overwritten by persisted ones', async () => {
    const sessionArt = createCodeArtifact({ id: 'shared-id', content: 'session-version', executionGroup: 'e1', request_id: 'r1' });
    const persistedArt = createCodeArtifact({ id: 'shared-id', content: 'old-version', executionGroup: 'e1', request_id: 'r1' });
    const mockSM = { switchSession: jest.fn().mockResolvedValue({ artifacts: [sessionArt] }) };
    const controller = createMockController();
    controller.loadArtifactsForChat.mockResolvedValue([persistedArt]);

    const { fm } = await createInitializedFM({ sessionManager: mockSM, controller });
    await fm.loadFiles('chat-1');

    // Session version should win (not overwritten by persisted)
    const found = fm.artifacts.find(a => a.id === 'shared-id');
    expect(found.content).toBe('session-version');
    fm.dispose();
  });
});

describe('loadFiles top-level error path', () => {
  afterEach(() => teardownDOM());

  it('renders error when loadFiles throws unexpectedly', async () => {
    const controller = createMockController();
    // Make loadArtifactsForChat throw in a way that escapes the inner try/catch
    // by making the normalizer throw after controller returns
    controller.loadArtifactsForChat.mockResolvedValue([]);
    const { fm } = await createInitializedFM({ controller });

    // Force an error in the outer try by making _groupArtifacts throw
    jest.spyOn(fm, '_groupArtifacts').mockImplementation(() => {
      throw new Error('Unexpected grouping error');
    });

    await fm.loadFiles('chat-1');
    const errorEl = fm.listEl.querySelector('div');
    expect(errorEl.textContent).toBe('Unexpected grouping error');
    fm.dispose();
  });
});

describe('Group trimming — duplicate code artifacts', () => {
  afterEach(() => teardownDOM());

  it('trims duplicate code artifacts to 1 per group', () => {
    const fm = new FileManager({
      controller: createMockController(),
      eventBus: createMockEventBus(),
    });
    mockLog.warn.mockClear(); // Clear stale calls from test setup
    const code1 = createCodeArtifact({ id: 'c1', executionGroup: 'e1', request_id: 'r1' });
    const code2 = createCodeArtifact({ id: 'c2', executionGroup: 'e1', request_id: 'r1' });
    const output = createOutputArtifact({ executionGroup: 'e1', request_id: 'r1' });
    const groups = fm._groupArtifacts([code1, code2, output]);
    expect(groups).toHaveLength(1);
    expect(groups[0].codeArtifacts).toHaveLength(1);
    expect(groups[0].artifacts).toHaveLength(2); // 1 code + 1 output
    // Verify trimming warning was logged
    const trimCalls = mockLog.warn.mock.calls.filter(c => typeof c[0] === 'string' && c[0].includes('trimming'));
    expect(trimCalls.length).toBeGreaterThan(0);
    fm.dispose();
  });
});

describe('Render group filter variants', () => {
  afterEach(() => teardownDOM());

  it('linked filter renders only groups with both code and output', async () => {
    const { fm } = await createInitializedFM();
    const code = createCodeArtifact({ executionGroup: 'e1', request_id: 'r1' });
    const output = createOutputArtifact({ executionGroup: 'e1', request_id: 'r1' });
    const codeOnly = createCodeArtifact({ executionGroup: 'e2', request_id: 'r2' });
    fm.artifacts = [code, output, codeOnly];
    fm.groups = fm._groupArtifacts([code, output, codeOnly]);
    fm.currentFilter = 'linked';
    fm._renderFiles();

    // Only the complete group should be rendered
    const groups = fm.listEl.querySelectorAll('.file-group');
    expect(groups.length).toBe(1);
    const items = fm.listEl.querySelectorAll('.file-item');
    expect(items.length).toBe(2); // code + output from linked group
    fm.dispose();
  });

  it('skips rendering empty groups after filter', async () => {
    const { fm } = await createInitializedFM();
    const att = createAttachmentArtifact();
    fm.artifacts = [att];
    fm.groups = fm._groupArtifacts([att]);
    fm.currentFilter = 'code'; // No code in attachment group
    fm._renderFiles();

    // Should show empty state, not empty groups
    expect(fm.listEl.querySelector('.empty-state')).not.toBeNull();
    fm.dispose();
  });

  it('output filter shows only output artifacts per group', async () => {
    const { fm } = await createInitializedFM();
    const code = createCodeArtifact({ executionGroup: 'e1', request_id: 'r1' });
    const output = createOutputArtifact({ executionGroup: 'e1', request_id: 'r1' });
    fm.artifacts = [code, output];
    fm.groups = fm._groupArtifacts([code, output]);
    fm.currentFilter = 'output';
    fm._renderFiles();

    const items = fm.listEl.querySelectorAll('.file-item');
    expect(items.length).toBe(1);
    fm.dispose();
  });

  it('attachment filter shows only attachment groups', async () => {
    const { fm } = await createInitializedFM();
    const code = createCodeArtifact({ executionGroup: 'e1', request_id: 'r1' });
    const output = createOutputArtifact({ executionGroup: 'e1', request_id: 'r1' });
    const att = createAttachmentArtifact();
    fm.artifacts = [code, output, att];
    fm.groups = fm._groupArtifacts([code, output, att]);
    fm.currentFilter = 'attachment';
    fm._renderFiles();

    const items = fm.listEl.querySelectorAll('.file-item');
    expect(items.length).toBe(1);
    fm.dispose();
  });
});

describe('Selected artifact highlighting on render', () => {
  afterEach(() => teardownDOM());

  it('marks item as active when selectedArtifactId matches', async () => {
    const { fm } = await createInitializedFM();
    const code = createCodeArtifact({ id: 'sel-1', executionGroup: 'e1', request_id: 'r1' });
    fm.artifacts = [code];
    fm.groups = fm._groupArtifacts([code]);
    fm.selectedArtifactId = 'sel-1';
    fm._renderFiles();

    const item = fm.listEl.querySelector('[data-artifact-id="sel-1"]');
    expect(item.classList.contains('active')).toBe(true);
    fm.dispose();
  });

  it('marks linked items with linked class', async () => {
    const { fm } = await createInitializedFM();
    const code = createCodeArtifact({ executionGroup: 'e1', request_id: 'r1' });
    const output = createOutputArtifact({ executionGroup: 'e1', request_id: 'r1' });
    fm.artifacts = [code, output];
    fm.groups = fm._groupArtifacts([code, output]);
    fm._renderFiles();

    const items = fm.listEl.querySelectorAll('.file-item');
    items.forEach(item => expect(item.classList.contains('linked')).toBe(true));
    fm.dispose();
  });
});

describe('Category icon coverage', () => {
  afterEach(() => teardownDOM());

  it('returns console icon for console category', () => {
    const fm = new FileManager({
      controller: createMockController(),
      eventBus: createMockEventBus(),
    });
    const icon = fm._getCategoryIcon('console');
    expect(icon).toContain('svg');
    expect(icon).toContain('polyline');
    fm.dispose();
  });

  it('returns console icon for execution_console', () => {
    const fm = new FileManager({
      controller: createMockController(),
      eventBus: createMockEventBus(),
    });
    expect(fm._getCategoryIcon('execution_console')).toContain('svg');
    fm.dispose();
  });

  it('returns default (output) icon for unknown category', () => {
    const fm = new FileManager({
      controller: createMockController(),
      eventBus: createMockEventBus(),
    });
    const defaultIcon = fm._getCategoryIcon('something_unknown');
    const outputIcon = fm._getCategoryIcon('output');
    expect(defaultIcon).toBe(outputIcon);
    fm.dispose();
  });

  it('returns attachment icon for file category', () => {
    const fm = new FileManager({
      controller: createMockController(),
      eventBus: createMockEventBus(),
    });
    const icon = fm._getCategoryIcon('file');
    expect(icon).toContain('svg');
    fm.dispose();
  });
});

describe('Controller error paths in _handleFileClick', () => {
  afterEach(() => teardownDOM());

  it('catches controller.loadArtifact error', async () => {
    const controller = createMockController();
    controller.loadArtifact.mockImplementation(() => { throw new Error('Load failed'); });
    const { fm } = await createInitializedFM({ controller });
    const code = createCodeArtifact({ executionGroup: 'e1', request_id: 'r1' });
    fm.artifacts = [code];
    fm.groups = fm._groupArtifacts([code]);
    fm._renderFiles();

    fm.listEl.querySelector('.file-item').click();
    expect(mockLog.error).toHaveBeenCalledWith(
      '[FileManager] controller.loadArtifact FAILED',
      expect.objectContaining({ error: 'Load failed' })
    );
    fm.dispose();
  });

  it('logs error when controller lacks loadArtifact method', async () => {
    const controller = createMockController();
    delete controller.loadArtifact;
    const { fm } = await createInitializedFM({ controller });
    const code = createCodeArtifact({ executionGroup: 'e1', request_id: 'r1' });
    fm.artifacts = [code];
    fm.groups = fm._groupArtifacts([code]);
    fm._renderFiles();

    fm.listEl.querySelector('.file-item').click();
    expect(mockLog.error).toHaveBeenCalledWith(
      '[FileManager] Controller or loadArtifact method not available',
      expect.any(Object)
    );
    fm.dispose();
  });
});

describe('Action handlers — edit and delete buttons', () => {
  afterEach(() => teardownDOM());

  it('edit button click triggers _handleEdit', async () => {
    const { fm } = await createInitializedFM();
    const code = createCodeArtifact({ executionGroup: 'e1', request_id: 'r1' });
    fm.artifacts = [code];
    fm.groups = fm._groupArtifacts([code]);
    fm._renderFiles();

    const spy = jest.spyOn(fm, '_handleEdit').mockResolvedValue(undefined);
    fm.listEl.querySelector('.file-action-edit').click();
    expect(spy).toHaveBeenCalledWith(code);
    fm.dispose();
  });

  it('delete button click triggers _handleDelete', async () => {
    const { fm } = await createInitializedFM();
    const code = createCodeArtifact({ executionGroup: 'e1', request_id: 'r1' });
    fm.artifacts = [code];
    fm.groups = fm._groupArtifacts([code]);
    fm._renderFiles();

    const spy = jest.spyOn(fm, '_handleDelete').mockResolvedValue(undefined);
    fm.listEl.querySelector('.file-action-delete').click();
    expect(spy).toHaveBeenCalledWith(code);
    fm.dispose();
  });
});

describe('Export handler', () => {
  afterEach(() => teardownDOM());

  it('creates a download link with artifact content', async () => {
    // Mock Blob and URL for jsdom
    const mockURL = 'blob:mock-url';
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = jest.fn(() => mockURL);
    URL.revokeObjectURL = jest.fn();

    try {
      const { fm, eventBus } = await createInitializedFM();
      const code = createCodeArtifact({ content: 'test-content', filename: 'test.js' });
      await fm._handleExport(code);

      expect(URL.createObjectURL).toHaveBeenCalled();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith(mockURL);
      expect(eventBus.emit).toHaveBeenCalledWith('ui:notification', expect.objectContaining({
        type: 'success',
        message: 'Artifact exported successfully',
      }));
      fm.dispose();
    } finally {
      URL.createObjectURL = origCreateObjectURL;
      URL.revokeObjectURL = origRevokeObjectURL;
    }
  });
});

describe('Edit handler full flow', () => {
  afterEach(() => teardownDOM());

  it('saves edited content via storageAPI', async () => {
    const storageAPI = createMockStorageAPI();
    const controller = createMockController();
    controller.loadArtifactsForChat.mockResolvedValue([]);
    const { fm } = await createInitializedFM({ storageAPI, controller });

    const artifact = createCodeArtifact({ id: 'edit-1', content: 'original', executionGroup: 'e1', request_id: 'r1' });
    fm.artifacts = [artifact];

    // Start edit, immediately save via Ctrl+S
    const editPromise = fm._handleEdit(artifact);
    const textarea = document.querySelector('.file-manager-edit-textarea');
    expect(textarea).not.toBeNull();
    textarea.value = 'updated content';

    // Save via Ctrl+S
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    await editPromise;

    expect(storageAPI.client.put).toHaveBeenCalledWith('/artifacts/edit-1', { content: 'updated content' });
    fm.dispose();
  });

  it('handles edit cancel (returns null)', async () => {
    const storageAPI = createMockStorageAPI();
    const { fm } = await createInitializedFM({ storageAPI });

    const artifact = createCodeArtifact({ content: 'original' });
    const editPromise = fm._handleEdit(artifact);

    // Cancel via Escape
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await editPromise;

    expect(storageAPI.client.put).not.toHaveBeenCalled();
    fm.dispose();
  });

  it('handles missing storageAPI', async () => {
    const { fm } = await createInitializedFM({ storageAPI: null });
    const artifact = createCodeArtifact({ content: 'test' });

    // Start edit, save immediately
    const editPromise = fm._handleEdit(artifact);
    const textarea = document.querySelector('.file-manager-edit-textarea');
    textarea.value = 'new';
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    await editPromise;

    expect(mockLog.error).toHaveBeenCalledWith(
      '[FileManager] Failed to update artifact:',
      expect.any(Error)
    );
    fm.dispose();
  });
});

describe('Delete handler full flow', () => {
  afterEach(() => teardownDOM());

  it('deletes artifact after confirmation', async () => {
    const storageAPI = createMockStorageAPI();
    const { fm, eventBus } = await createInitializedFM({ storageAPI });

    const artifact = createCodeArtifact({ id: 'del-1', executionGroup: 'e1', request_id: 'r1' });
    fm.artifacts = [artifact];
    fm.groups = fm._groupArtifacts([artifact]);

    const deletePromise = fm._handleDelete(artifact);

    // Confirm deletion
    const confirmBtn = document.querySelector('.btn-danger');
    expect(confirmBtn).not.toBeNull();
    confirmBtn.click();
    await deletePromise;

    expect(storageAPI.deleteArtifact).toHaveBeenCalledWith('del-1');
    expect(eventBus.emit).toHaveBeenCalledWith('artifacts:file:deleted', expect.objectContaining({
      artifactId: 'del-1',
    }));
    expect(fm.artifacts.some(a => a.id === 'del-1')).toBe(false);
    fm.dispose();
  });

  it('cancels delete when user cancels confirm dialog', async () => {
    const storageAPI = createMockStorageAPI();
    const { fm } = await createInitializedFM({ storageAPI });

    const artifact = createCodeArtifact({ id: 'keep-1' });
    fm.artifacts = [artifact];

    const deletePromise = fm._handleDelete(artifact);

    // Cancel via Escape
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await deletePromise;

    expect(storageAPI.deleteArtifact).not.toHaveBeenCalled();
    fm.dispose();
  });

  it('handles delete with missing storageAPI', async () => {
    const { fm } = await createInitializedFM({ storageAPI: null });
    const artifact = createCodeArtifact({ id: 'del-2' });
    fm.artifacts = [artifact];

    const deletePromise = fm._handleDelete(artifact);
    const confirmBtn = document.querySelector('.btn-danger');
    confirmBtn.click();
    await deletePromise;

    expect(mockLog.error).toHaveBeenCalledWith(
      '[FileManager] Failed to delete artifact:',
      expect.any(Error)
    );
    fm.dispose();
  });
});

describe('Confirm dialog branches', () => {
  afterEach(() => teardownDOM());

  it('shows detail text when provided', async () => {
    const { fm } = await createInitializedFM();
    const confirmPromise = fm._showConfirmDialog('Title', 'Message', 'Detail text here');

    const detail = document.querySelector('.file-manager-confirm-detail');
    expect(detail).not.toBeNull();
    expect(detail.textContent).toBe('Detail text here');

    // Cleanup
    fm._activeModalTeardown();
    await confirmPromise;
    fm.dispose();
  });

  it('overlay click cancels confirm dialog', async () => {
    const { fm } = await createInitializedFM();
    const confirmPromise = fm._showConfirmDialog('Title', 'Message');

    const overlay = document.querySelector('.file-manager-modal-overlay');
    // Click on overlay itself (not the panel)
    const clickEvent = new MouseEvent('click', { bubbles: true });
    Object.defineProperty(clickEvent, 'target', { value: overlay });
    overlay.dispatchEvent(clickEvent);

    const result = await confirmPromise;
    expect(result).toBe(false);
    fm.dispose();
  });

  it('Escape key cancels confirm dialog', async () => {
    const { fm } = await createInitializedFM();
    const confirmPromise = fm._showConfirmDialog('Title', 'Message');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const result = await confirmPromise;
    expect(result).toBe(false);
    fm.dispose();
  });
});

describe('Edit modal overlay click', () => {
  afterEach(() => teardownDOM());

  it('clicking overlay cancels edit modal', async () => {
    const { fm } = await createInitializedFM();
    const artifact = createCodeArtifact({ content: 'test' });
    const editPromise = fm._showEditModal(artifact);

    const overlay = document.querySelector('.file-manager-modal-overlay');
    const clickEvent = new MouseEvent('click', { bubbles: true });
    Object.defineProperty(clickEvent, 'target', { value: overlay });
    overlay.dispatchEvent(clickEvent);

    const result = await editPromise;
    expect(result).toBeNull();
    fm.dispose();
  });
});

describe('Dispose cleanup error resilience', () => {
  afterEach(() => teardownDOM());

  it('dispose survives event listener cleanup failure', async () => {
    const { fm } = await createInitializedFM();
    // Inject a throwing cleanup function
    fm._eventListeners.push(() => { throw new Error('cleanup boom'); });

    expect(() => fm.dispose()).not.toThrow();
    expect(fm._isDisposed).toBe(true);
    expect(mockLog.error).toHaveBeenCalledWith(
      '[FileManager] Failed to cleanup:',
      expect.any(Error)
    );
  });
});

describe('_injectStyles no-op', () => {
  afterEach(() => teardownDOM());

  it('returns undefined (no-op)', () => {
    const fm = new FileManager({
      controller: createMockController(),
      eventBus: createMockEventBus(),
    });
    expect(fm._injectStyles()).toBeUndefined();
    fm.dispose();
  });
});

describe('init after dispose is no-op', () => {
  afterEach(() => teardownDOM());

  it('init returns immediately after dispose', async () => {
    const container = setupDOM();
    const fm = new FileManager({
      controller: createMockController(),
      eventBus: createMockEventBus(),
    });
    await fm.init(container);
    fm.dispose();

    // Calling init again should be a no-op (disposed flag)
    await fm.init(container);
    expect(fm._initialized).toBe(false);
    expect(fm.container).toBeNull();
  });
});
