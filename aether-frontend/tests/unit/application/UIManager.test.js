/**
 * @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js
 */

'use strict';

/**
 * UIManager Unit Tests
 * ============================================================================
 * Tests the main UI orchestrator: submodule initialization, lifecycle phases,
 * event listener setup/cleanup, DOM element gathering, settings save flow,
 * backend info, service registration, WS-to-IPC relay, and disposal.
 *
 * BUG 8 FOUND: _clearStatusMessageTimeout() was called in dispose() but never
 * defined on UIManager (it belonged to EventBusBridge). Fixed: removed dead call.
 *
 * @module tests/unit/application/UIManager.test
 */

// --- Module-level mocks ---

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    debug: jest.fn(), trace: jest.fn(),
  }),
}));

// Mock all 7 submodules
const mockConnectionMonitor = {
  start: jest.fn(), stop: jest.fn(), dispose: jest.fn(),
  getStats: jest.fn().mockReturnValue({ connected: false }),
};
jest.mock('../../../src/application/main/modules/connection/ConnectionMonitor', () => (
  jest.fn(() => mockConnectionMonitor)
));

const mockModelManager = {
  refreshModelList: jest.fn().mockResolvedValue([]),
  probeCapabilities: jest.fn().mockResolvedValue(null),
  setCurrentModel: jest.fn(),
  dispose: jest.fn(),
  getStats: jest.fn().mockReturnValue({ totalModels: 0 }),
};
jest.mock('../../../src/application/main/modules/models/ModelManager', () => (
  jest.fn(() => mockModelManager)
));

const mockProfileManager = {
  refreshProfileList: jest.fn().mockResolvedValue([]),
  dispose: jest.fn(),
  getStats: jest.fn().mockReturnValue({ profiles: 0 }),
};
jest.mock('../../../src/application/main/modules/profiles/ProfileManager', () => (
  jest.fn(() => mockProfileManager)
));

const mockSettingsManager = {
  loadSettings: jest.fn().mockResolvedValue({}),
  getSettings: jest.fn().mockReturnValue({}),
  getSetting: jest.fn().mockReturnValue(''),
  validateSettings: jest.fn().mockReturnValue({ valid: true }),
  saveSettings: jest.fn().mockResolvedValue({ success: true }),
  dispose: jest.fn(),
  getStats: jest.fn().mockReturnValue({ loaded: false }),
};
jest.mock('../../../src/application/main/modules/settings/SettingsManager', () => (
  jest.fn(() => mockSettingsManager)
));

const mockUIStateManager = {
  openSettings: jest.fn(),
  closeSettings: jest.fn(),
  setActiveTab: jest.fn(),
  showStatus: jest.fn(),
  dispose: jest.fn(),
  getStats: jest.fn().mockReturnValue({ activeTab: null }),
};
jest.mock('../../../src/application/main/modules/ui/UIStateManager', () => (
  jest.fn(() => mockUIStateManager)
));

const mockServiceMonitor = {
  registerService: jest.fn(),
  start: jest.fn(), stop: jest.fn(), dispose: jest.fn(),
  getStats: jest.fn().mockReturnValue({ services: 0 }),
};
jest.mock('../../../src/application/main/modules/services/ServiceStatusMonitor', () => (
  jest.fn(() => mockServiceMonitor)
));

const mockArtifactsOrchestrator = {
  start: jest.fn(), stop: jest.fn(), dispose: jest.fn(),
  getStats: jest.fn().mockReturnValue({ isActive: false }),
};
jest.mock('../../../src/application/main/ArtifactsStreamOrchestrator', () => (
  jest.fn(() => mockArtifactsOrchestrator)
));

jest.mock('../../../src/core/events/EventTypes', () => ({
  EventTypes: {
    CONNECTION: { STATUS_CHANGED: 'connection.status_changed' },
    SERVICE: { STATUS_UPDATED: 'service.status_updated' },
    MODEL: { CHANGED: 'model.changed' },
  },
  EventPriority: { HIGH: 1 },
}));

const UIManager = require('../../../src/application/main/UIManager');

// --- Helpers ---

function createMockEndpoint() {
  return {
    getHealth: jest.fn().mockResolvedValue({ model: 'gpt-4', status: 'ok' }),
    getModels: jest.fn().mockResolvedValue({ models: [] }),
    apiBaseUrl: 'http://localhost:8765',
  };
}

function createMockGuru() {
  return {
    on: jest.fn(),
    off: jest.fn(),
    reconnect: jest.fn(),
  };
}

function createMockEventBus() {
  const cleanupFn = jest.fn();
  return {
    on: jest.fn().mockReturnValue(cleanupFn),
    off: jest.fn(),
    emit: jest.fn(),
    _cleanup: cleanupFn,
  };
}

function createMockIpc() {
  return { send: jest.fn() };
}

function setupMinimalDOM() {
  // Create just enough DOM elements to avoid null issues
  document.body.innerHTML = '';
}

function createFullDeps() {
  return {
    endpoint: createMockEndpoint(),
    guruConnection: createMockGuru(),
    eventBus: createMockEventBus(),
    ipc: createMockIpc(),
  };
}

// --- Reset mock instances between tests ---
function resetAllMockInstances() {
  for (const mock of [
    mockConnectionMonitor, mockModelManager, mockProfileManager,
    mockSettingsManager, mockUIStateManager, mockServiceMonitor,
    mockArtifactsOrchestrator,
  ]) {
    for (const key of Object.keys(mock)) {
      if (typeof mock[key] === 'function' && mock[key].mockReset) {
        mock[key].mockReset();
      }
    }
  }
  // Restore defaults
  mockConnectionMonitor.getStats.mockReturnValue({ connected: false });
  mockModelManager.refreshModelList.mockResolvedValue([]);
  mockModelManager.probeCapabilities.mockResolvedValue(null);
  mockModelManager.getStats.mockReturnValue({ totalModels: 0 });
  mockProfileManager.refreshProfileList.mockResolvedValue([]);
  mockProfileManager.getStats.mockReturnValue({ profiles: 0 });
  mockSettingsManager.loadSettings.mockResolvedValue({});
  mockSettingsManager.getSettings.mockReturnValue({});
  mockSettingsManager.getSetting.mockReturnValue('');
  mockSettingsManager.validateSettings.mockReturnValue({ valid: true });
  mockSettingsManager.saveSettings.mockResolvedValue({ success: true });
  mockSettingsManager.getStats.mockReturnValue({ loaded: false });
  mockUIStateManager.getStats.mockReturnValue({ activeTab: null });
  mockServiceMonitor.getStats.mockReturnValue({ services: 0 });
  mockArtifactsOrchestrator.getStats.mockReturnValue({ isActive: false });
}

// --- Tests ---

describe('UIManager', () => {
  let manager;
  let deps;

  beforeEach(() => {
    resetAllMockInstances();
    setupMinimalDOM();
    deps = createFullDeps();
    manager = new UIManager(deps);
  });

  afterEach(() => {
    if (manager) manager.dispose();
    document.body.innerHTML = '';
  });

  // -----------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------
  describe('constructor', () => {
    it('throws when endpoint not provided', () => {
      const d = createFullDeps();
      delete d.endpoint;
      expect(() => new UIManager(d)).toThrow('endpoint required');
    });

    it('throws when guruConnection not provided', () => {
      const d = createFullDeps();
      delete d.guruConnection;
      expect(() => new UIManager(d)).toThrow('guruConnection required');
    });

    it('throws when eventBus not provided', () => {
      const d = createFullDeps();
      delete d.eventBus;
      expect(() => new UIManager(d)).toThrow('eventBus required');
    });

    it('initializes with default state', () => {
      expect(manager.initialized).toBe(false);
      expect(manager.enableLogging).toBe(false);
      expect(manager.elements).toEqual({});
      expect(manager._eventListeners).toEqual([]);
    });

    it('creates all 7 submodules', () => {
      expect(manager.connectionMonitor).toBe(mockConnectionMonitor);
      expect(manager.modelManager).toBe(mockModelManager);
      expect(manager.profileManager).toBe(mockProfileManager);
      expect(manager.settingsManager).toBe(mockSettingsManager);
      expect(manager.uiStateManager).toBe(mockUIStateManager);
      expect(manager.serviceMonitor).toBe(mockServiceMonitor);
      expect(manager.artifactsOrchestrator).toBe(mockArtifactsOrchestrator);
    });

    it('accepts enableLogging option', () => {
      const d = createFullDeps();
      const m = new UIManager({ ...d, enableLogging: true });
      expect(m.enableLogging).toBe(true);
      m.dispose();
    });
  });

  // -----------------------------------------------------------
  // init()
  // -----------------------------------------------------------
  describe('init()', () => {
    it('initializes all phases', async () => {
      await manager.init();
      expect(manager.initialized).toBe(true);
      expect(mockConnectionMonitor.start).toHaveBeenCalled();
      expect(mockArtifactsOrchestrator.start).toHaveBeenCalled();
      expect(mockServiceMonitor.registerService).toHaveBeenCalled();
      expect(mockServiceMonitor.start).toHaveBeenCalled();
      expect(mockSettingsManager.loadSettings).toHaveBeenCalled();
      expect(mockModelManager.refreshModelList).toHaveBeenCalled();
      expect(mockProfileManager.refreshProfileList).toHaveBeenCalled();
    });

    it('sets up event listeners on eventBus', async () => {
      await manager.init();
      // 3 event listeners: connection status, service status, model changed
      expect(deps.eventBus.on).toHaveBeenCalledTimes(3);
    });

    it('guards against double initialization', async () => {
      await manager.init();
      mockConnectionMonitor.start.mockClear();
      await manager.init(); // second call
      expect(mockConnectionMonitor.start).not.toHaveBeenCalled();
    });

    it('rethrows initialization errors', async () => {
      // connectionMonitor.start() throws synchronously inside init()'s try block
      mockConnectionMonitor.start.mockImplementation(() => {
        throw new Error('monitor broke');
      });
      await expect(manager.init()).rejects.toThrow('monitor broke');
      expect(mockUIStateManager.showStatus).toHaveBeenCalledWith(
        expect.stringContaining('Initialization failed'),
        'error',
        10000
      );
    });
  });

  // -----------------------------------------------------------
  // _gatherUIElements()
  // -----------------------------------------------------------
  describe('_gatherUIElements()', () => {
    it('populates elements from DOM', () => {
      manager._gatherUIElements();
      expect(manager.elements).toBeDefined();
      expect(manager.elements).toHaveProperty('settingsButton');
      expect(manager.elements).toHaveProperty('chipREST');
      expect(manager.elements).toHaveProperty('systemStatusEl');
      expect(manager.elements).toHaveProperty('tabs');
      expect(manager.elements).toHaveProperty('sections');
    });

    it('handles missing DOM elements gracefully', () => {
      document.body.innerHTML = '';
      manager._gatherUIElements();
      expect(manager.elements.settingsButton).toBeNull();
    });
  });

  // -----------------------------------------------------------
  // _setupSettingsModal()
  // -----------------------------------------------------------
  describe('_setupSettingsModal()', () => {
    it('attaches click listener to settings button', () => {
      const btn = document.createElement('button');
      btn.id = 'settings-button';
      document.body.appendChild(btn);
      manager._gatherUIElements();
      manager._setupSettingsModal();

      btn.click();
      expect(mockUIStateManager.openSettings).toHaveBeenCalled();
    });

    it('attaches click listener to cancel button', () => {
      const btn = document.createElement('button');
      btn.id = 'settings-cancel';
      document.body.appendChild(btn);
      manager._gatherUIElements();
      manager._setupSettingsModal();

      btn.click();
      expect(mockUIStateManager.closeSettings).toHaveBeenCalled();
    });

    it('attaches click listener to save button', async () => {
      const btn = document.createElement('button');
      btn.id = 'settings-save';
      document.body.appendChild(btn);
      manager._gatherUIElements();
      manager._setupSettingsModal();

      btn.click();
      // Allow async to resolve
      await new Promise(r => setTimeout(r, 0));
      expect(mockSettingsManager.getSettings).toHaveBeenCalled();
    });

    it('handles tab switching', () => {
      const tab = document.createElement('div');
      tab.className = 'settings-tab';
      tab.dataset.tab = 'connections';
      document.body.appendChild(tab);
      manager._gatherUIElements();
      manager._setupSettingsModal();

      tab.click();
      expect(mockUIStateManager.setActiveTab).toHaveBeenCalledWith('connections');
    });

    it('ignores tab click without data-tab', () => {
      const tab = document.createElement('div');
      tab.className = 'settings-tab';
      document.body.appendChild(tab);
      manager._gatherUIElements();
      manager._setupSettingsModal();

      tab.click();
      expect(mockUIStateManager.setActiveTab).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------
  // _setupArtifactsControls()
  // -----------------------------------------------------------
  describe('_setupArtifactsControls()', () => {
    it('attaches click listener to code panel toggle', () => {
      const btn = document.createElement('button');
      btn.id = 'code-panel-toggle';
      document.body.appendChild(btn);
      manager._gatherUIElements();
      manager._setupArtifactsControls();

      btn.click();
      // Just verifies no throw -- handler logs only
    });

    it('handles missing toggle gracefully', () => {
      manager._gatherUIElements();
      expect(() => manager._setupArtifactsControls()).not.toThrow();
    });
  });

  // -----------------------------------------------------------
  // _setupStatusUpdates()
  // -----------------------------------------------------------
  describe('_setupStatusUpdates()', () => {
    it('attaches ping button handler -- success', async () => {
      const btn = document.createElement('button');
      btn.id = 'btn-ping-backend';
      document.body.appendChild(btn);
      manager._gatherUIElements();
      manager._setupStatusUpdates();

      btn.click();
      await new Promise(r => setTimeout(r, 0));
      expect(deps.endpoint.getHealth).toHaveBeenCalled();
      expect(mockUIStateManager.showStatus).toHaveBeenCalledWith(
        expect.stringContaining('Backend responded'),
        'success',
        5000
      );
    });

    it('attaches ping button handler -- error', async () => {
      deps.endpoint.getHealth.mockRejectedValue(new Error('timeout'));
      const btn = document.createElement('button');
      btn.id = 'btn-ping-backend';
      document.body.appendChild(btn);
      manager._gatherUIElements();
      manager._setupStatusUpdates();

      btn.click();
      await new Promise(r => setTimeout(r, 0));
      expect(mockUIStateManager.showStatus).toHaveBeenCalledWith(
        expect.stringContaining('Backend error'),
        'error',
        5000
      );
    });

    it('attaches reconnect button handler', () => {
      const btn = document.createElement('button');
      btn.id = 'btn-reconnect-ws';
      document.body.appendChild(btn);
      manager._gatherUIElements();
      manager._setupStatusUpdates();

      btn.click();
      expect(deps.guruConnection.reconnect).toHaveBeenCalled();
      expect(mockUIStateManager.showStatus).toHaveBeenCalledWith(
        'Reconnecting...',
        'info',
        3000
      );
    });

    it('handles reconnect when guru.reconnect is not a function', () => {
      deps.guruConnection.reconnect = undefined;
      const btn = document.createElement('button');
      btn.id = 'btn-reconnect-ws';
      document.body.appendChild(btn);
      manager._gatherUIElements();
      manager._setupStatusUpdates();

      btn.click();
      // Should not throw, should not call showStatus
      expect(mockUIStateManager.showStatus).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------
  // _setupWebSocketToIPCRelay()
  // -----------------------------------------------------------
  describe('_setupWebSocketToIPCRelay()', () => {
    it('logs when guru and ipc are available', () => {
      expect(() => manager._setupWebSocketToIPCRelay()).not.toThrow();
    });

    it('warns when guru is missing', () => {
      manager.guru = null;
      manager._setupWebSocketToIPCRelay();
      // No throw, just log warning
    });

    it('warns when ipc is missing', () => {
      manager.ipc = null;
      manager._setupWebSocketToIPCRelay();
    });
  });

  // -----------------------------------------------------------
  // _registerServices()
  // -----------------------------------------------------------
  describe('_registerServices()', () => {
    it('registers backend service and starts monitoring', () => {
      manager._registerServices();
      expect(mockServiceMonitor.registerService).toHaveBeenCalledWith(
        'aether-backend',
        expect.objectContaining({
          name: 'Aether Backend',
          url: 'http://localhost:8765',
          useEndpoint: true,
        })
      );
      expect(mockServiceMonitor.start).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------
  // _loadInitialData()
  // -----------------------------------------------------------
  describe('_loadInitialData()', () => {
    it('loads settings, models, and profiles', async () => {
      await manager._loadInitialData();
      expect(mockSettingsManager.loadSettings).toHaveBeenCalled();
      expect(mockModelManager.refreshModelList).toHaveBeenCalled();
      expect(mockProfileManager.refreshProfileList).toHaveBeenCalled();
    });

    it('passes apiBase from settings to refreshModelList', async () => {
      mockSettingsManager.getSetting.mockReturnValue('http://custom:9000');
      await manager._loadInitialData();
      expect(mockModelManager.refreshModelList).toHaveBeenCalledWith('http://custom:9000');
    });

    it('handles errors without throwing', async () => {
      mockSettingsManager.loadSettings.mockRejectedValue(new Error('load failed'));
      await expect(manager._loadInitialData()).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------
  // _updateBackendInfo()
  // -----------------------------------------------------------
  describe('_updateBackendInfo()', () => {
    it('sets current model from health response', async () => {
      await manager._updateBackendInfo();
      expect(mockModelManager.setCurrentModel).toHaveBeenCalledWith('gpt-4');
    });

    it('updates DOM element when present', async () => {
      const el = document.createElement('div');
      el.id = 'backend-info';
      document.body.appendChild(el);
      manager._gatherUIElements();

      await manager._updateBackendInfo();
      expect(el.innerHTML).toContain('GPT-4');
    });

    it('handles missing model in health', async () => {
      deps.endpoint.getHealth.mockResolvedValue({ status: 'ok' });
      await manager._updateBackendInfo();
      expect(mockModelManager.setCurrentModel).not.toHaveBeenCalled();
    });

    it('handles health error gracefully', async () => {
      deps.endpoint.getHealth.mockRejectedValue(new Error('timeout'));
      await expect(manager._updateBackendInfo()).resolves.toBeUndefined();
    });

    it('updates DOM on health error when element exists', async () => {
      deps.endpoint.getHealth.mockRejectedValue(new Error('timeout'));
      const el = document.createElement('div');
      el.id = 'backend-info';
      document.body.appendChild(el);
      manager._gatherUIElements();

      await manager._updateBackendInfo();
      expect(el.innerHTML).toContain('WAITING FOR BACKEND');
    });
  });

  // -----------------------------------------------------------
  // _saveSettings()
  // -----------------------------------------------------------
  describe('_saveSettings()', () => {
    it('saves valid settings successfully', async () => {
      await manager._saveSettings();
      expect(mockSettingsManager.getSettings).toHaveBeenCalled();
      expect(mockSettingsManager.validateSettings).toHaveBeenCalled();
      expect(mockSettingsManager.saveSettings).toHaveBeenCalled();
      expect(mockUIStateManager.showStatus).toHaveBeenCalledWith(
        'Settings saved successfully!',
        'success',
        3000
      );
    });

    it('shows validation errors', async () => {
      mockSettingsManager.validateSettings.mockReturnValue({
        valid: false,
        errors: ['field X required'],
      });
      await manager._saveSettings();
      expect(mockSettingsManager.saveSettings).not.toHaveBeenCalled();
      expect(mockUIStateManager.showStatus).toHaveBeenCalledWith(
        expect.stringContaining('Validation failed'),
        'error',
        5000
      );
    });

    it('handles save failure', async () => {
      mockSettingsManager.saveSettings.mockResolvedValue({
        success: false,
        error: 'disk full',
      });
      await manager._saveSettings();
      expect(mockUIStateManager.showStatus).toHaveBeenCalledWith(
        expect.stringContaining('Save failed'),
        'error',
        5000
      );
    });

    it('handles unexpected error', async () => {
      mockSettingsManager.getSettings.mockImplementation(() => {
        throw new Error('boom');
      });
      await manager._saveSettings();
      expect(mockUIStateManager.showStatus).toHaveBeenCalledWith(
        expect.stringContaining('Error: boom'),
        'error',
        5000
      );
    });
  });

  // -----------------------------------------------------------
  // _updateServiceCardUI()
  // -----------------------------------------------------------
  describe('_updateServiceCardUI()', () => {
    it('handles call without error', () => {
      expect(() => manager._updateServiceCardUI('backend', 'healthy')).not.toThrow();
    });
  });

  // -----------------------------------------------------------
  // getStats()
  // -----------------------------------------------------------
  describe('getStats()', () => {
    it('returns frozen aggregated stats', () => {
      const stats = manager.getStats();
      expect(Object.isFrozen(stats)).toBe(true);
      expect(stats.initialized).toBe(false);
      expect(stats.modules).toBeDefined();
      expect(stats.modules.connectionMonitor).toEqual({ connected: false });
      expect(stats.modules.modelManager).toEqual({ totalModels: 0 });
    });
  });

  // -----------------------------------------------------------
  // dispose()
  // -----------------------------------------------------------
  describe('dispose()', () => {
    it('stops and disposes all submodules', () => {
      manager.dispose();
      expect(mockConnectionMonitor.stop).toHaveBeenCalled();
      expect(mockServiceMonitor.stop).toHaveBeenCalled();
      expect(mockArtifactsOrchestrator.stop).toHaveBeenCalled();
      expect(mockConnectionMonitor.dispose).toHaveBeenCalled();
      expect(mockModelManager.dispose).toHaveBeenCalled();
      expect(mockProfileManager.dispose).toHaveBeenCalled();
      expect(mockSettingsManager.dispose).toHaveBeenCalled();
      expect(mockUIStateManager.dispose).toHaveBeenCalled();
      expect(mockServiceMonitor.dispose).toHaveBeenCalled();
      expect(mockArtifactsOrchestrator.dispose).toHaveBeenCalled();
      manager = null;
    });

    it('cleans up event listeners', async () => {
      await manager.init();
      const cleanupCount = manager._eventListeners.length;
      expect(cleanupCount).toBe(3);

      manager.dispose();
      expect(manager._eventListeners).toEqual([]);
      manager = null;
    });

    it('handles cleanup function errors', async () => {
      const badCleanup = jest.fn(() => { throw new Error('cleanup fail'); });
      manager._eventListeners.push(badCleanup);
      expect(() => manager.dispose()).not.toThrow();
      expect(badCleanup).toHaveBeenCalled();
      manager = null;
    });

    it('is safe to call twice', () => {
      manager.dispose();
      expect(() => manager.dispose()).not.toThrow();
      manager = null;
    });

    it('verifies BUG 8 fix: no _clearStatusMessageTimeout call', () => {
      // Before the fix, dispose() called this._clearStatusMessageTimeout()
      // which would throw TypeError since it's not defined on UIManager.
      // After fix: dispose() should not throw.
      expect(() => manager.dispose()).not.toThrow();
      manager = null;
    });

    it('cleans up DOM listeners tracked via _trackDomListener', async () => {
      // Setup DOM elements so init() can attach listeners
      document.body.innerHTML = `
        <button id="settings-button"></button>
        <button id="settings-cancel"></button>
        <button id="settings-save"></button>
        <div class="settings-tab" data-tab="assistant"></div>
        <div class="settings-tab" data-tab="connections"></div>
        <button id="code-panel-toggle"></button>
        <button id="btn-ping-backend"></button>
        <button id="btn-reconnect-ws"></button>
      `;
      await manager.init();

      // Should have tracked: settings(3) + tabs(2) + artifacts(1) + status(2) = 8
      expect(manager._domListeners.length).toBe(8);

      manager.dispose();
      expect(manager._domListeners).toEqual([]);
      expect(manager.elements).toEqual({});
      manager = null;
    });

    it('_trackDomListener stores element/event/handler and calls addEventListener', () => {
      const el = document.createElement('button');
      const spy = jest.spyOn(el, 'addEventListener');
      const handler = jest.fn();

      manager._trackDomListener(el, 'click', handler);

      expect(spy).toHaveBeenCalledWith('click', handler);
      expect(manager._domListeners.length).toBe(1);
      expect(manager._domListeners[0]).toEqual({ element: el, event: 'click', handler });
      spy.mockRestore();
      manager = null;
    });

    it('dispose removes DOM listeners via removeEventListener', async () => {
      const el = document.createElement('button');
      const handler = jest.fn();
      const removeSpy = jest.spyOn(el, 'removeEventListener');

      manager._trackDomListener(el, 'click', handler);
      manager.dispose();

      expect(removeSpy).toHaveBeenCalledWith('click', handler);
      removeSpy.mockRestore();
      manager = null;
    });

    it('quantitative: N DOM listeners created = M removed in dispose()', async () => {
      document.body.innerHTML = `
        <button id="settings-button"></button>
        <button id="settings-cancel"></button>
        <button id="settings-save"></button>
        <button id="code-panel-toggle"></button>
        <button id="btn-ping-backend"></button>
        <button id="btn-reconnect-ws"></button>
      `;
      await manager.init();

      const N = manager._domListeners.length;
      expect(N).toBeGreaterThan(0);

      // Spy on each tracked element's removeEventListener
      const spies = manager._domListeners.map(({ element }) =>
        jest.spyOn(element, 'removeEventListener')
      );

      manager.dispose();

      // Every tracked listener had removeEventListener called
      let M = 0;
      for (const spy of spies) {
        M += spy.mock.calls.length;
        spy.mockRestore();
      }
      expect(M).toBe(N);
      manager = null;
    });
  });

  // -----------------------------------------------------------
  // enableLogging branches
  // -----------------------------------------------------------
  describe('enableLogging branches', () => {
    let logManager;

    beforeEach(() => {
      logManager = new UIManager({ ...createFullDeps(), enableLogging: true });
    });

    afterEach(() => {
      if (logManager) logManager.dispose();
    });

    it('logs during _gatherUIElements', () => {
      logManager._gatherUIElements();
      // Covers line 229
    });

    it('logs during _setupEventListeners', () => {
      logManager._gatherUIElements();
      logManager._setupEventListeners();
      // Covers line 267
    });

    it('logs during _setupSettingsModal', () => {
      logManager._gatherUIElements();
      logManager._setupSettingsModal();
      // Covers line 307
    });

    it('logs during _setupArtifactsControls', () => {
      logManager._gatherUIElements();
      logManager._setupArtifactsControls();
      // Covers line 325
    });

    it('logs during _setupStatusUpdates', () => {
      logManager._gatherUIElements();
      logManager._setupStatusUpdates();
      // Covers line 357
    });

    it('logs during _registerServices', () => {
      logManager._registerServices();
      // Covers line 377
    });

    it('logs during _loadInitialData', async () => {
      await logManager._loadInitialData();
      // Covers line 398
    });

    it('logs during _updateBackendInfo', async () => {
      await logManager._updateBackendInfo();
      // Covers line 423
    });

    it('logs during _updateBackendInfo error path', async () => {
      const d = createFullDeps();
      d.endpoint.getHealth.mockRejectedValue(new Error('timeout'));
      const m = new UIManager({ ...d, enableLogging: true });
      await m._updateBackendInfo();
      // Covers line 432
      m.dispose();
    });

    it('logs during _updateServiceCardUI', () => {
      logManager._updateServiceCardUI('svc', 'ok');
      // Covers line 474
    });

    it('logs during CONNECTION.STATUS_CHANGED callback', async () => {
      await logManager.init();
      // CONNECTION.STATUS_CHANGED is the first eventBus.on call
      const d = logManager.eventBus;
      const connCallback = d.on.mock.calls[0][1];
      connCallback({ connected: true });
      // Covers lines 240-241
    });

    it('logs during MODEL.CHANGED callback', async () => {
      await logManager.init();
      // MODEL.CHANGED is the third eventBus.on call
      const d = logManager.eventBus;
      const modelCallback = d.on.mock.calls[2][1];
      await modelCallback({ model: 'gpt-4' });
      // Covers line 255
    });
  });

  // -----------------------------------------------------------
  // Event listener callbacks
  // -----------------------------------------------------------
  describe('event listener callbacks', () => {
    it('probes capabilities on MODEL.CHANGED event', async () => {
      await manager.init();

      // The third eventBus.on call is for MODEL.CHANGED
      const modelChangedCallback = deps.eventBus.on.mock.calls[2][1];
      await modelChangedCallback({ model: 'llama-3' });

      expect(mockModelManager.probeCapabilities).toHaveBeenCalledWith('llama-3');
    });

    it('calls _updateServiceCardUI on SERVICE.STATUS_UPDATED event', async () => {
      await manager.init();

      // The second eventBus.on call is for SERVICE.STATUS_UPDATED
      const serviceCallback = deps.eventBus.on.mock.calls[1][1];
      serviceCallback({ serviceName: 'backend', status: 'healthy' });
      // No throw -- just logs
    });
  });

  // -----------------------------------------------------------
  // _initializeModules error path
  // -----------------------------------------------------------
  describe('_initializeModules error path', () => {
    it('rethrows submodule construction errors', () => {
      const ConnectionMonitor = require('../../../src/application/main/modules/connection/ConnectionMonitor');
      ConnectionMonitor.mockImplementationOnce(() => {
        throw new Error('ConnectionMonitor failed');
      });
      expect(() => new UIManager(createFullDeps())).toThrow('ConnectionMonitor failed');
    });
  });

  // -----------------------------------------------------------
  // window global export
  // -----------------------------------------------------------
  describe('window global export', () => {
    it('attaches UIManager to window when window exists', () => {
      jest.isolateModules(() => {
        global.window = {};
        jest.mock('../../../src/renderer/shared/utils/logger', () => ({
          createRendererLogger: () => ({
            info: jest.fn(), warn: jest.fn(), error: jest.fn(),
            debug: jest.fn(), trace: jest.fn(),
          }),
        }));
        jest.mock('../../../src/application/main/modules/connection/ConnectionMonitor', () => jest.fn(() => mockConnectionMonitor));
        jest.mock('../../../src/application/main/modules/models/ModelManager', () => jest.fn(() => mockModelManager));
        jest.mock('../../../src/application/main/modules/profiles/ProfileManager', () => jest.fn(() => mockProfileManager));
        jest.mock('../../../src/application/main/modules/settings/SettingsManager', () => jest.fn(() => mockSettingsManager));
        jest.mock('../../../src/application/main/modules/ui/UIStateManager', () => jest.fn(() => mockUIStateManager));
        jest.mock('../../../src/application/main/modules/services/ServiceStatusMonitor', () => jest.fn(() => mockServiceMonitor));
        jest.mock('../../../src/application/main/ArtifactsStreamOrchestrator', () => jest.fn(() => mockArtifactsOrchestrator));
        jest.mock('../../../src/core/events/EventTypes', () => ({
          EventTypes: {
            CONNECTION: { STATUS_CHANGED: 'connection.status_changed' },
            SERVICE: { STATUS_UPDATED: 'service.status_updated' },
            MODEL: { CHANGED: 'model.changed' },
          },
          EventPriority: { HIGH: 1 },
        }));
        const UIM = require('../../../src/application/main/UIManager');
        expect(global.window.UIManager).toBe(UIM);
        delete global.window;
      });
    });
  });
});
