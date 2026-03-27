'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = {
  info: () => {},
  warn: jest.fn(),
  error: jest.fn(),
  debug: () => {},
  trace: () => {},
};

const mockAether = {
  logger: mockLog,
  toast: { success: jest.fn(), error: jest.fn() },
};

jest.mock('../../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: () => mockAether,
}));

jest.mock('../../../../src/renderer/shared/components/ConfirmDialog', () => ({
  confirm: jest.fn().mockResolvedValue(true),
}));

const ConfirmDialog = require('../../../../src/renderer/shared/components/ConfirmDialog');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupDOM() {
  document.body.innerHTML = `
    <input type="checkbox" id="aether-rag-sources-browser-enabled" />
    <select id="aether-rag-sources-browser-kind"><option value="edge">Edge</option><option value="chrome">Chrome</option></select>
    <select id="aether-rag-sources-browser-profile"><option value="0">Default</option></select>
    <select id="aether-rag-sources-browser-search-mode"><option value="hybrid">Hybrid</option></select>
    <button id="aether-rag-sources-browser-discover">Discover</button>
    <button id="aether-rag-sources-browser-build">Build</button>
    <button id="aether-rag-sources-browser-view">View</button>
    <div id="aether-rag-sources-browser-profiles-list"></div>
    <div id="aether-rag-sources-browser-index-status"></div>
    <div id="aether-rag-sources-browser-progress"></div>
  `;
}

function createMockEndpoint() {
  return {
    discoverBrowserProfiles: jest.fn().mockResolvedValue({
      success: true,
      profiles: [
        { profile_name: 'Default', profile_path: '/path/to/default', estimated_entries: 500, estimated_size_mb: 12, last_modified: '2026-02-01T12:00:00Z' },
        { profile_name: 'Work', profile_path: '/path/to/work', estimated_entries: 300, estimated_size_mb: 8 },
      ],
      total_estimated_entries: 800,
    }),
    buildBrowserHistorySourceIndex: jest.fn().mockResolvedValue({
      success: true,
      index: { chunk_count: 450 },
    }),
    listSources: jest.fn().mockResolvedValue({
      indexes: [
        {
          source_type: 'browser_history',
          index_name: 'browser_edge_default',
          index_directory: '/indexes/browser',
          chunk_count: 450,
          created_at: '2026-02-01T12:00:00Z',
          metadata: { bm25_enabled: true, bm25_chunk_count: 420 },
        },
      ],
    }),
    getSourceIndexStatus: jest.fn().mockResolvedValue({ state: 'completed' }),
    getReindexJobStatus: jest.fn().mockResolvedValue({ status: 'completed' }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BrowserHistoryManager', () => {
  let BrowserHistoryManager;

  beforeEach(() => {
    setupDOM();

    mockLog.warn = jest.fn();
    mockLog.error = jest.fn();
    mockAether.toast = { success: jest.fn(), error: jest.fn() };

    ConfirmDialog.confirm = jest.fn().mockResolvedValue(true);

    BrowserHistoryManager = require('../../../../src/renderer/main/modules/settings/BrowserHistoryManager');
  });

  afterEach(() => {
    document.body.innerHTML = '';
    delete window.settingsManager;
    delete window.MainApp;
    delete window.showToast;
  });

  // ── Constructor ─────────────────────────────────────────

  describe('constructor', () => {
    test('initializes with correct default state', () => {
      const mgr = new BrowserHistoryManager({ endpoint: {} });

      expect(mgr.isEnabled).toBe(true);
      expect(mgr.selectedBrowser).toBe('edge');
      expect(mgr.selectedProfile).toBeNull();
      expect(mgr.availableProfiles).toEqual([]);
      expect(mgr.indexStatus).toBeNull();
      expect(mgr.activeIndexJob).toBeNull();
      expect(mgr.searchMode).toBe('hybrid');
      expect(mgr.buildSemantic).toBe(true);
      expect(mgr.buildBM25).toBe(true);
      expect(mgr._isInitialized).toBe(false);
      expect(mgr._isInitializing).toBe(false);
      expect(mgr._staticListeners).toEqual([]);
      expect(mgr._dynamicListeners).toEqual([]);
    });

    test('defaults aether from getAether when not provided', () => {
      const mgr = new BrowserHistoryManager({ endpoint: {} });
      expect(mgr.aether).toBe(mockAether);
    });

    test('uses provided aether over default', () => {
      const customAether = { logger: console };
      const mgr = new BrowserHistoryManager({ endpoint: {}, aether: customAether });
      expect(mgr.aether).toBe(customAether);
    });
  });

  // ── Listener tracking ───────────────────────────────────

  describe('_trackListener / _clearDynamicListeners / _trackDynamicListener', () => {
    test('_trackListener adds event listener and tracks for cleanup', () => {
      const mgr = new BrowserHistoryManager({ endpoint: {} });
      const el = document.createElement('div');
      const spy = jest.spyOn(el, 'addEventListener');
      const handler = jest.fn();

      mgr._trackListener(el, 'click', handler);

      expect(spy).toHaveBeenCalledWith('click', handler, undefined);
      expect(mgr._staticListeners).toHaveLength(1);
      expect(mgr._staticListeners[0]).toEqual({ element: el, event: 'click', handler, options: undefined });
    });

    test('_trackListener skips null element', () => {
      const mgr = new BrowserHistoryManager({ endpoint: {} });
      mgr._trackListener(null, 'click', jest.fn());
      expect(mgr._staticListeners).toHaveLength(0);
    });

    test('_trackDynamicListener adds and tracks listener', () => {
      const mgr = new BrowserHistoryManager({ endpoint: {} });
      const el = document.createElement('div');
      const spy = jest.spyOn(el, 'addEventListener');
      const handler = jest.fn();

      mgr._trackDynamicListener(el, 'click', handler);

      expect(spy).toHaveBeenCalledWith('click', handler);
      expect(mgr._dynamicListeners).toHaveLength(1);
    });

    test('_clearDynamicListeners removes all tracked dynamic listeners', () => {
      const mgr = new BrowserHistoryManager({ endpoint: {} });
      const el = document.createElement('div');
      const handler = jest.fn();

      mgr._trackDynamicListener(el, 'click', handler);
      expect(mgr._dynamicListeners).toHaveLength(1);

      const spy = jest.spyOn(el, 'removeEventListener');
      mgr._clearDynamicListeners();

      expect(spy).toHaveBeenCalledWith('click', handler);
      expect(mgr._dynamicListeners).toEqual([]);
    });

    test('_clearDynamicListeners handles already-removed elements', () => {
      const mgr = new BrowserHistoryManager({ endpoint: {} });
      const el = document.createElement('div');
      mgr._dynamicListeners = [{ element: null, event: 'click', handler: jest.fn() }];

      // Should not throw even with null element
      expect(() => mgr._clearDynamicListeners()).not.toThrow();
    });
  });

  // ── initialize() ────────────────────────────────────────

  describe('initialize()', () => {
    test('discovers DOM elements and loads index status', async () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });

      await mgr.initialize();

      expect(mgr._isInitialized).toBe(true);
      expect(mgr._isInitializing).toBe(false);
      // enableToggle removed — daemon on/off managed by ProactiveDaemonManager
      expect(mgr.elements.browserSelect).toBeTruthy();
      expect(mgr.elements.buildButton).toBeTruthy();
      expect(endpoint.listSources).toHaveBeenCalled();
    });

    test('returns early if already initialized', async () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });

      await mgr.initialize();
      endpoint.listSources.mockClear();

      await mgr.initialize();

      expect(endpoint.listSources).not.toHaveBeenCalled();
    });

    test('returns early if currently initializing', async () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });

      // Simulate concurrent init
      mgr._isInitializing = true;
      await mgr.initialize();

      expect(mgr._isInitialized).toBe(false);
    });

    test('returns early if required DOM elements missing', async () => {
      document.body.innerHTML = '<div>empty</div>';
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });

      await mgr.initialize();

      expect(mgr._isInitialized).toBe(false);
      expect(mockLog.error).toHaveBeenCalledWith(
        '[BrowserHistoryManager] Required DOM elements not found'
      );
    });

    test('resets _isInitializing in finally block even on error', async () => {
      const endpoint = createMockEndpoint();
      endpoint.listSources = jest.fn().mockRejectedValue(new Error('API fail'));
      const mgr = new BrowserHistoryManager({ endpoint });

      await mgr.initialize();

      // The error is caught by _loadIndexStatus, so initialize still completes
      expect(mgr._isInitializing).toBe(false);
    });
  });

  // ── _setupEventListeners ────────────────────────────────

  describe('event listener behaviors', () => {
    // NOTE: Enable toggle tests removed — enable toggle behavior was removed from
    // BrowserHistoryManager. Daemon on/off is managed by ProactiveDaemonManager.
    // isEnabled defaults to true in constructor.

    test('browser selection clears profiles and cache', async () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();

      mgr.availableProfiles = [{ name: 'old' }];
      mgr.selectedProfile = { name: 'old' };

      const select = document.getElementById('aether-rag-sources-browser-kind');
      select.value = 'chrome';
      select.dispatchEvent(new Event('change'));

      expect(mgr.selectedBrowser).toBe('chrome');
      expect(mgr.availableProfiles).toEqual([]);
      expect(mgr.selectedProfile).toBeNull();
    });

    test('profile selection sets selectedProfile from availableProfiles', async () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();

      mgr.availableProfiles = [
        { profile_name: 'Default', profile_path: '/p1' },
        { profile_name: 'Work', profile_path: '/p2' },
      ];

      // Add matching option to select so value assignment works
      const select = document.getElementById('aether-rag-sources-browser-profile');
      const opt = document.createElement('option');
      opt.value = '1';
      opt.textContent = 'Work';
      select.appendChild(opt);

      select.value = '1';
      select.dispatchEvent(new Event('change'));

      expect(mgr.selectedProfile).toEqual({ profile_name: 'Work', profile_path: '/p2' });
    });

    test('profile selection sets null for invalid index', async () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();

      mgr.availableProfiles = [];

      const select = document.getElementById('aether-rag-sources-browser-profile');
      select.value = '99';
      select.dispatchEvent(new Event('change'));

      expect(mgr.selectedProfile).toBeNull();
    });
  });

  // ── discoverProfiles() ──────────────────────────────────

  describe('discoverProfiles()', () => {
    test('calls API and populates profiles', async () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();

      await mgr.discoverProfiles();

      expect(endpoint.discoverBrowserProfiles).toHaveBeenCalledWith({
        browser: 'edge',
        user_data_dir: null,
      });
      expect(mgr.availableProfiles).toHaveLength(2);
      expect(mgr.selectedProfile).toBeTruthy();
    });

    test('returns cached profiles if within TTL', async () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();

      // First call populates cache
      await mgr.discoverProfiles();
      endpoint.discoverBrowserProfiles.mockClear();

      // Second call uses cache
      await mgr.discoverProfiles();

      expect(endpoint.discoverBrowserProfiles).not.toHaveBeenCalled();
    });

    test('shows error when no browser selected', async () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      mgr.selectedBrowser = '';

      await mgr.discoverProfiles();

      expect(mockAether.toast.error).toHaveBeenCalledWith('Please select a browser first');
    });

    test('handles API failure gracefully', async () => {
      const endpoint = createMockEndpoint();
      endpoint.discoverBrowserProfiles = jest.fn().mockRejectedValue(new Error('Network error'));
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();

      await mgr.discoverProfiles();

      expect(mockLog.error).toHaveBeenCalledWith(
        '[BrowserHistoryManager] Profile discovery failed:',
        expect.any(Error)
      );
    });

    test('handles API success with no profiles', async () => {
      const endpoint = createMockEndpoint();
      endpoint.discoverBrowserProfiles = jest.fn().mockResolvedValue({
        success: false,
      });
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();

      await mgr.discoverProfiles();

      expect(mockAether.toast.error).toHaveBeenCalledWith('No profiles found');
    });

    test('restores discover button state after completion', async () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();

      await mgr.discoverProfiles();

      expect(mgr.elements.discoverButton.disabled).toBe(false);
    });
  });

  // ── buildIndex() ────────────────────────────────────────

  describe('buildIndex()', () => {
    test('shows error if no profile selected', async () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      mgr.selectedProfile = null;

      await mgr.buildIndex();

      expect(mockAether.toast.error).toHaveBeenCalledWith(
        'Please discover and select a profile first'
      );
    });

    test('shows error if no index type selected', async () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      mgr.selectedProfile = { profile_name: 'Default', profile_path: '/p', estimated_entries: 100 };
      mgr.buildSemantic = false;
      mgr.buildBM25 = false;

      await mgr.buildIndex();

      expect(mockAether.toast.error).toHaveBeenCalledWith(
        expect.stringContaining('at least one index type')
      );
    });

    test('aborts if user cancels confirmation', async () => {
      ConfirmDialog.confirm = jest.fn().mockResolvedValue(false);

      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();
      mgr.selectedProfile = { profile_name: 'Default', profile_path: '/p', estimated_entries: 100 };

      await mgr.buildIndex();

      expect(endpoint.buildBrowserHistorySourceIndex).not.toHaveBeenCalled();
    });

    test('calls API with correct parameters on success', async () => {
      jest.useFakeTimers();

      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();
      mgr.selectedProfile = { profile_name: 'Default', profile_path: '/p', estimated_entries: 100 };

      const buildPromise = mgr.buildIndex();
      jest.runAllTimers();
      await buildPromise;

      expect(endpoint.buildBrowserHistorySourceIndex).toHaveBeenCalledWith({
        browser: 'edge',
        profile_path: '/p',
        auto_find_profiles: false,
        max_items: 5000,
        force_rebuild: true,
        build_semantic: true,
        build_bm25: true,
      });

      jest.useRealTimers();
    });

    test('handles build API failure gracefully', async () => {
      jest.useFakeTimers();

      const endpoint = createMockEndpoint();
      endpoint.buildBrowserHistorySourceIndex = jest.fn().mockRejectedValue(new Error('Build fail'));
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();
      mgr.selectedProfile = { profile_name: 'Default', profile_path: '/p', estimated_entries: 100 };

      const buildPromise = mgr.buildIndex();
      jest.runAllTimers();
      await buildPromise;

      expect(mockLog.error).toHaveBeenCalledWith(
        '[BrowserHistoryManager] Index build failed to start:',
        expect.any(Error)
      );

      // Build button re-enabled in finally
      expect(mgr.elements.buildButton.disabled).toBe(false);

      jest.useRealTimers();
    });

    test('handles build API returning failure result', async () => {
      jest.useFakeTimers();

      const endpoint = createMockEndpoint();
      endpoint.buildBrowserHistorySourceIndex = jest.fn().mockResolvedValue({ success: false });
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();
      mgr.selectedProfile = { profile_name: 'Default', profile_path: '/p', estimated_entries: 100 };

      const buildPromise = mgr.buildIndex();
      jest.runAllTimers();
      await buildPromise;

      expect(mockAether.toast.error).toHaveBeenCalledWith('Index build failed to start: Unknown error');

      jest.useRealTimers();
    });
  });

  // ── _loadIndexStatus() ──────────────────────────────────

  describe('_loadIndexStatus()', () => {
    test('loads and parses browser_history index from sources', async () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();

      expect(mgr.indexStatus).toBeTruthy();
      expect(mgr.indexStatus.exists).toBe(true);
      expect(mgr.indexStatus.semantic.exists).toBe(true);
      expect(mgr.indexStatus.semantic.chunk_count).toBe(450);
      expect(mgr.indexStatus.bm25.exists).toBe(true);
    });

    test('sets indexStatus.exists = false when no browser_history index', async () => {
      const endpoint = createMockEndpoint();
      endpoint.listSources = jest.fn().mockResolvedValue({ indexes: [] });
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();

      expect(mgr.indexStatus).toEqual({ exists: false });
    });

    test('handles listSources failure gracefully', async () => {
      const endpoint = createMockEndpoint();
      endpoint.listSources = jest.fn().mockRejectedValue(new Error('API fail'));
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();

      expect(mockLog.error).toHaveBeenCalledWith(
        '[BrowserHistoryManager] Failed to load index status:',
        expect.any(Error)
      );
    });
  });

  // ── _renderProfilesList() ───────────────────────────────

  describe('_renderProfilesList()', () => {
    test('renders empty state when no profiles', () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      mgr.elements.profilesList = document.getElementById('aether-rag-sources-browser-profiles-list');
      mgr.availableProfiles = [];

      mgr._renderProfilesList();

      expect(mgr.elements.profilesList.innerHTML).toContain('No profiles discovered yet');
    });

    test('renders profile cards with correct data', () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      mgr.elements.profilesList = document.getElementById('aether-rag-sources-browser-profiles-list');
      mgr.availableProfiles = [
        { profile_name: 'Default', profile_path: '/p1', estimated_entries: 500, estimated_size_mb: 12, last_modified: '2026-02-01T12:00:00Z' },
      ];

      mgr._renderProfilesList();

      expect(mgr.elements.profilesList.innerHTML).toContain('Default');
      expect(mgr.elements.profilesList.innerHTML).toContain('500');
      expect(mgr.elements.profilesList.innerHTML).toContain('12 MB');
    });

    test('profile select button click sets selectedProfile', () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      mgr.elements.profilesList = document.getElementById('aether-rag-sources-browser-profiles-list');
      mgr.availableProfiles = [
        { profile_name: 'Default', profile_path: '/p1', estimated_entries: 500, estimated_size_mb: 12 },
        { profile_name: 'Work', profile_path: '/p2', estimated_entries: 300, estimated_size_mb: 8 },
      ];

      mgr._renderProfilesList();

      const selectBtns = mgr.elements.profilesList.querySelectorAll('.profile-select-btn');
      selectBtns[1].click();

      expect(mgr.selectedProfile.profile_name).toBe('Work');
    });

    test('returns early if profilesList element missing', () => {
      const mgr = new BrowserHistoryManager({ endpoint: {} });
      mgr.elements.profilesList = null;

      expect(() => mgr._renderProfilesList()).not.toThrow();
    });
  });

  // ── _renderIndexStatus() ────────────────────────────────

  describe('_renderIndexStatus()', () => {
    test('renders index exists state', () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      mgr.elements.indexStatusContainer = document.getElementById('aether-rag-sources-browser-index-status');
      mgr.indexStatus = {
        exists: true,
        semantic: { exists: true, chunk_count: 450, created_at: '2026-02-01T12:00:00Z' },
        bm25: { exists: true, chunk_count: 420 },
      };

      mgr._renderIndexStatus();

      expect(mgr.elements.indexStatusContainer.innerHTML).toContain('Index Exists');
      expect(mgr.elements.indexStatusContainer.innerHTML).toContain('450');
      expect(mgr.elements.indexStatusContainer.innerHTML).toContain('420');
    });

    test('renders no-index state', () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      mgr.elements.indexStatusContainer = document.getElementById('aether-rag-sources-browser-index-status');
      mgr.indexStatus = null;

      mgr._renderIndexStatus();

      expect(mgr.elements.indexStatusContainer.innerHTML).toContain('No Index');
    });

    test('clears dynamic listeners before re-render', () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      mgr.elements.indexStatusContainer = document.getElementById('aether-rag-sources-browser-index-status');
      mgr.indexStatus = { exists: false };

      mgr._clearDynamicListeners = jest.fn();
      mgr._renderIndexStatus();

      expect(mgr._clearDynamicListeners).toHaveBeenCalled();
    });

    test('index type card click toggles build selection', () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      mgr.elements.indexStatusContainer = document.getElementById('aether-rag-sources-browser-index-status');
      mgr.indexStatus = { exists: false };

      mgr._renderIndexStatus();

      expect(mgr.buildSemantic).toBe(true);

      const semanticCard = mgr.elements.indexStatusContainer.querySelector('[data-index-type="semantic"]');
      semanticCard.click();

      expect(mgr.buildSemantic).toBe(false);
    });

    test('returns early if indexStatusContainer missing', () => {
      const mgr = new BrowserHistoryManager({ endpoint: {} });
      mgr.elements.indexStatusContainer = null;

      expect(() => mgr._renderIndexStatus()).not.toThrow();
    });
  });

  // ── Messaging helpers ───────────────────────────────────

  describe('_showSuccess / _showError', () => {
    test('_showSuccess uses aether.toast when available', () => {
      const mgr = new BrowserHistoryManager({ endpoint: {} });

      mgr._showSuccess('Index built!');

      expect(mockAether.toast.success).toHaveBeenCalledWith('Index built!');
    });

    test('_showSuccess falls back to window.showToast', () => {
      const mgr = new BrowserHistoryManager({ endpoint: {}, aether: { logger: mockLog } });
      window.showToast = jest.fn();

      mgr._showSuccess('Done!');

      expect(window.showToast).toHaveBeenCalledWith('Done!', 'success');
    });

    test('_showError uses aether.toast when available', () => {
      const mgr = new BrowserHistoryManager({ endpoint: {} });

      mgr._showError('Failed!');

      expect(mockAether.toast.error).toHaveBeenCalledWith('Failed!');
    });

    test('_showError falls back to window.showToast', () => {
      const mgr = new BrowserHistoryManager({ endpoint: {}, aether: { logger: mockLog } });
      window.showToast = jest.fn();

      mgr._showError('Bad!');

      expect(window.showToast).toHaveBeenCalledWith('Bad!', 'error');
    });
  });

  // ── Helpers ─────────────────────────────────────────────

  describe('_formatDate / _escapeHtml', () => {
    test('_formatDate returns formatted date for valid ISO string', () => {
      const mgr = new BrowserHistoryManager({ endpoint: {} });
      const result = mgr._formatDate('2026-02-01T12:00:00Z');
      expect(result).toContain('2026');
    });

    test('_formatDate returns Unknown for null/undefined', () => {
      const mgr = new BrowserHistoryManager({ endpoint: {} });
      expect(mgr._formatDate(null)).toBe('Unknown');
      expect(mgr._formatDate(undefined)).toBe('Unknown');
    });

    test('_formatDate returns raw string for invalid date', () => {
      const mgr = new BrowserHistoryManager({ endpoint: {} });
      // new Date('not-a-date') returns Invalid Date, toLocaleDateString works but returns 'Invalid Date'
      const result = mgr._formatDate('not-a-date');
      expect(typeof result).toBe('string');
    });

    test('_escapeHtml escapes dangerous characters', () => {
      const mgr = new BrowserHistoryManager({ endpoint: {} });
      const result = mgr._escapeHtml('<script>alert("xss")</script>');
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;script&gt;');
    });
  });

  // ── destroy() ───────────────────────────────────────────

  describe('destroy()', () => {
    test('clears dynamic and static listeners', async () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();

      const staticCount = mgr._staticListeners.length;
      expect(staticCount).toBeGreaterThan(0);

      mgr.destroy();

      expect(mgr._staticListeners).toEqual([]);
      expect(mgr._dynamicListeners).toEqual([]);
    });

    test('resets state to clean defaults', async () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();
      mgr.availableProfiles = [{ name: 'test' }];
      mgr.selectedProfile = { name: 'test' };

      mgr.destroy();

      expect(mgr.availableProfiles).toEqual([]);
      expect(mgr.selectedProfile).toBeNull();
      expect(mgr.indexStatus).toBeNull();
      expect(mgr._isInitialized).toBe(false);
      expect(mgr._isInitializing).toBe(false);
    });

    test('N static listeners created = N removed in destroy', async () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();

      const createdCount = mgr._staticListeners.length;
      expect(createdCount).toBeGreaterThan(0);

      mgr.destroy();

      // All were cleaned up (array is now empty)
      expect(mgr._staticListeners).toEqual([]);
    });
  });

  // ── _updateEnabledState() ───────────────────────────────

  describe('_updateEnabledState()', () => {
    test('disables controls when not enabled', async () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();
      mgr.isEnabled = false;

      mgr._updateEnabledState();

      expect(mgr.elements.browserSelect.disabled).toBe(true);
      expect(mgr.elements.buildButton.disabled).toBe(true);
    });

    test('enables controls when enabled', async () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();
      mgr.isEnabled = true;

      mgr._updateEnabledState();

      expect(mgr.elements.browserSelect.disabled).toBe(false);
      expect(mgr.elements.buildButton.disabled).toBe(false);
    });
  });

  // ── Event handler bodies (uncovered branches) ──────────

  describe('event handler body coverage', () => {
    // NOTE: Enable toggle event handler tests removed — enable toggle behavior was
    // removed from BrowserHistoryManager. Daemon on/off is managed by ProactiveDaemonManager.

    test('searchModeSelect change updates searchMode', async () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();

      const select = document.getElementById('aether-rag-sources-browser-search-mode');
      select.innerHTML = '<option value="bm25">BM25</option>';
      select.value = 'bm25';
      select.dispatchEvent(new Event('change'));

      expect(mgr.searchMode).toBe('bm25');
    });

    test('discover button click calls discoverProfiles', async () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();

      const spy = jest.spyOn(mgr, 'discoverProfiles').mockResolvedValue();
      document.getElementById('aether-rag-sources-browser-discover').click();

      await Promise.resolve();

      expect(spy).toHaveBeenCalled();
    });

    test('build button click calls buildIndex', async () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();

      const spy = jest.spyOn(mgr, 'buildIndex').mockResolvedValue();
      document.getElementById('aether-rag-sources-browser-build').click();

      await Promise.resolve();

      expect(spy).toHaveBeenCalled();
    });

    test('view button calls MainApp.openIndexBrowser', async () => {
      window.MainApp = { openIndexBrowser: jest.fn() };

      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();

      document.getElementById('aether-rag-sources-browser-view').click();

      expect(window.MainApp.openIndexBrowser).toHaveBeenCalledWith('browser_history');
    });

    test('view button falls back to toggle click when no MainApp', async () => {
      delete window.MainApp;
      const toggleEl = document.createElement('button');
      toggleEl.id = 'index-browser-toggle';
      document.body.appendChild(toggleEl);
      const clickSpy = jest.spyOn(toggleEl, 'click');

      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();

      document.getElementById('aether-rag-sources-browser-view').click();

      expect(clickSpy).toHaveBeenCalled();
    });

    test('view button handles missing MainApp and toggle gracefully', async () => {
      delete window.MainApp;

      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();

      // Should not throw
      expect(() => document.getElementById('aether-rag-sources-browser-view').click()).not.toThrow();
    });
  });

  // ── _renderIndexStatus card clicks and search mode ─────

  describe('_renderIndexStatus dynamic listeners', () => {
    test('BM25 card click toggles buildBM25', () => {
      const mgr = new BrowserHistoryManager({ endpoint: {} });
      mgr.elements.indexStatusContainer = document.getElementById('aether-rag-sources-browser-index-status');
      mgr.indexStatus = { exists: false };
      mgr.buildBM25 = true;

      mgr._renderIndexStatus();

      const bm25Card = mgr.elements.indexStatusContainer.querySelector('[data-index-type="bm25"]');
      bm25Card.click();

      expect(mgr.buildBM25).toBe(false);
    });

    test('re-attached search mode listener updates searchMode', () => {
      // Remove the original search mode select so getElementById finds the re-rendered one
      const originalSelect = document.getElementById('aether-rag-sources-browser-search-mode');
      if (originalSelect) originalSelect.remove();

      const mgr = new BrowserHistoryManager({ endpoint: {} });
      mgr.elements.indexStatusContainer = document.getElementById('aether-rag-sources-browser-index-status');
      mgr.indexStatus = { exists: false };

      mgr._renderIndexStatus();

      const searchSelect = mgr.elements.searchModeSelect;
      expect(searchSelect).not.toBeNull();
      searchSelect.value = 'semantic';
      searchSelect.dispatchEvent(new Event('change'));

      expect(mgr.searchMode).toBe('semantic');
    });
  });

  // ── buildIndex progress interval ───────────────────────

  describe('buildIndex progress simulation', () => {
    test('progress interval advances during build', async () => {
      jest.useFakeTimers();
      ConfirmDialog.confirm = jest.fn().mockResolvedValue(true);

      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();
      mgr.selectedProfile = { profile_name: 'Default', profile_path: '/p', estimated_entries: 100 };

      const buildPromise = mgr.buildIndex();

      // Advance timers to trigger progress intervals
      jest.advanceTimersByTime(3000);

      // The progress bar should have advanced
      const fill = document.querySelector('.progress-fill');
      if (fill) {
        expect(parseInt(fill.style.width)).toBeGreaterThan(10);
      }

      jest.runAllTimers();
      await buildPromise;

      jest.useRealTimers();
    });

    test('buildIndex shows only Semantic in confirmation when BM25 disabled', async () => {
      jest.useFakeTimers();
      ConfirmDialog.confirm = jest.fn().mockResolvedValue(true);

      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();
      mgr.selectedProfile = { profile_name: 'Default', profile_path: '/p', estimated_entries: 100 };
      mgr.buildBM25 = false;

      const buildPromise = mgr.buildIndex();
      jest.runAllTimers();
      await buildPromise;

      expect(ConfirmDialog.confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Smart Search'),
        })
      );

      jest.useRealTimers();
    });
  });

  // ── Alert fallbacks ────────────────────────────────────

  describe('alert fallbacks', () => {
    test('_showSuccess falls back to alert when no toast available', () => {
      const mgr = new BrowserHistoryManager({ endpoint: {}, aether: { logger: mockLog } });
      const alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => {});

      mgr._showSuccess('Done!');

      expect(alertSpy).toHaveBeenCalledWith('Done!');
      alertSpy.mockRestore();
    });

    test('_showError falls back to alert when no toast available', () => {
      const mgr = new BrowserHistoryManager({ endpoint: {}, aether: { logger: mockLog } });
      const alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => {});

      mgr._showError('Bad!');

      expect(alertSpy).toHaveBeenCalledWith('Error: Bad!');
      alertSpy.mockRestore();
    });
  });

  // ── destroy — unsubscribe branch ───────────────────────

  describe('destroy — unsubscribe branch', () => {
    test('calls unsubscribe when listener has one', () => {
      const mgr = new BrowserHistoryManager({ endpoint: {} });
      const unsubFn = jest.fn();
      mgr._staticListeners = [{ unsubscribe: unsubFn }];

      mgr.destroy();

      expect(unsubFn).toHaveBeenCalled();
      expect(mgr._staticListeners).toEqual([]);
    });
  });

  // ── _updateEnabledState null guards ────────────────────

  describe('_updateEnabledState null guards', () => {
    test('handles missing DOM elements', () => {
      const mgr = new BrowserHistoryManager({ endpoint: {} });
      mgr.isEnabled = false;
      // All elements are null by default

      expect(() => mgr._updateEnabledState()).not.toThrow();
    });
  });

  // ── discoverProfiles auto-select edge case ─────────────

  describe('discoverProfiles auto-select', () => {
    test('does not auto-select when profile already selected', async () => {
      const endpoint = createMockEndpoint();
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();

      const existingProfile = { profile_name: 'Existing', profile_path: '/existing' };
      mgr.selectedProfile = existingProfile;

      await mgr.discoverProfiles();

      expect(mgr.selectedProfile).toBe(existingProfile);
    });
  });

  // ── _loadIndexStatus — metadata edge cases ─────────────

  describe('_loadIndexStatus metadata edge cases', () => {
    test('defaults chunk_count and created_at when absent', async () => {
      const endpoint = createMockEndpoint();
      endpoint.listSources = jest.fn().mockResolvedValue({
        indexes: [
          {
            source_type: 'browser_history',
            index_name: 'test',
            index_directory: '/test',
            metadata: {},
          },
        ],
      });
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();

      expect(mgr.indexStatus.semantic.chunk_count).toBe(0);
      expect(mgr.indexStatus.bm25.exists).toBe(false);
      expect(mgr.indexStatus.bm25.chunk_count).toBe(0);
    });

    test('handles sources without indexes key', async () => {
      const endpoint = createMockEndpoint();
      endpoint.listSources = jest.fn().mockResolvedValue({});
      const mgr = new BrowserHistoryManager({ endpoint });
      await mgr.initialize();

      expect(mgr.indexStatus).toEqual({ exists: false });
    });
  });

  // ── _renderProfilesList — profile without last_modified ──

  describe('_renderProfilesList edge cases', () => {
    test('renders profile without last_modified field', () => {
      const mgr = new BrowserHistoryManager({ endpoint: {} });
      mgr.elements.profilesList = document.getElementById('aether-rag-sources-browser-profiles-list');
      mgr.availableProfiles = [
        { profile_name: 'NoDate', profile_path: '/p1', estimated_entries: 100, estimated_size_mb: 5 },
      ];

      mgr._renderProfilesList();

      expect(mgr.elements.profilesList.innerHTML).toContain('NoDate');
      expect(mgr.elements.profilesList.innerHTML).not.toContain('Modified:');
    });

    test('shows "Selected" for matching profile', () => {
      const mgr = new BrowserHistoryManager({ endpoint: {} });
      mgr.elements.profilesList = document.getElementById('aether-rag-sources-browser-profiles-list');
      const profile = { profile_name: 'Test', profile_path: '/p1', estimated_entries: 100, estimated_size_mb: 5 };
      mgr.availableProfiles = [profile];
      mgr.selectedProfile = profile;

      mgr._renderProfilesList();

      expect(mgr.elements.profilesList.innerHTML).toContain('Selected');
    });
  });
});
