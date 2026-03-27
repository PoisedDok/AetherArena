'use strict';

// Mock Toast before requiring the module (it's imported at load time)
jest.mock('../../../src/renderer/shared/components/Toast', () => ({
  success: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
}));

// Mock ConfirmDialog (used for destructive disable action)
jest.mock('../../../src/renderer/shared/components/ConfirmDialog', () => ({
  confirm: jest.fn().mockResolvedValue(true),
}));

// Mock centralized config (ProactiveDaemonManager imports it for backend URL fallback)
jest.mock('../../../src/core/config', () => ({
  backend: { baseUrl: 'http://127.0.0.1:8765' },
}));

// Mock DaemonConfigModal (settings button now opens modal instead of toggling panel)
const mockModalOpen = jest.fn();
jest.mock('../../../src/renderer/main/modules/settings/DaemonConfigModal', () => {
  return jest.fn().mockImplementation((opts) => ({
    open: mockModalOpen,
    daemonName: opts.daemonName,
    daemonConfig: opts.daemonConfig,
    endpoint: opts.endpoint,
    onSave: opts.onSave,
  }));
});

const Toast = require('../../../src/renderer/shared/components/Toast');
const ConfirmDialog = require('../../../src/renderer/shared/components/ConfirmDialog');

const ProactiveDaemonManager = require(
  '../../../src/renderer/main/modules/settings/ProactiveDaemonManager'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAEMONS = ['browser', 'email', 'filesystem', 'file_indexing', 'query_generation'];

function createDaemonDOM(daemons = DAEMONS) {
  for (const daemon of daemons) {
    const slug = daemon.replace('_', '-');
    const toggleId = `daemon-${slug}-enabled`;

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.id = toggleId;
    document.body.appendChild(toggle);

    const badge = document.createElement('span');
    badge.className = 'daemon-status-badge';
    badge.dataset.daemon = daemon;
    document.body.appendChild(badge);

    const btn = document.createElement('button');
    btn.className = 'daemon-settings-btn';
    btn.dataset.daemon = daemon;
    document.body.appendChild(btn);

    const panel = document.createElement('div');
    panel.className = 'daemon-settings-panel';
    panel.dataset.daemon = daemon;
    document.body.appendChild(panel);
  }
}

/**
 * Create master toggle DOM elements (checkbox, status banner, card wrapper).
 */
function createMasterToggleDOM() {
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = 'proactive-master-enabled';
  document.body.appendChild(checkbox);

  const status = document.createElement('div');
  status.id = 'proactive-master-status';
  document.body.appendChild(status);

  const card = document.createElement('div');
  card.className = 'settings-card knowledge-card daemon-master-card';
  document.body.appendChild(card);

  return { checkbox, status, card };
}

function createStatusEl() {
  const el = document.createElement('div');
  el.id = 'settings-status';
  document.body.appendChild(el);
  return el;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ProactiveDaemonManager', () => {
  let manager;
  let mockEndpoint;
  let mockLogger;

  let mockEventBus;

  beforeEach(() => {
    document.body.innerHTML = '';
    jest.useFakeTimers();

    // Mock global fetch for proactive config API calls
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ enabled: false }),
    });

    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    mockEndpoint = {
      getFileIndexingDaemonConfig: jest.fn().mockResolvedValue({}),
      updateFileIndexingDaemonConfig: jest.fn().mockResolvedValue(undefined),
      getBackendURL: jest.fn().mockReturnValue('http://test:23816'),
      getProactiveConfig: jest.fn().mockResolvedValue({ enabled: false }),
      updateProactiveConfig: jest.fn().mockResolvedValue({}),
    };

    mockEventBus = { on: jest.fn(), emit: jest.fn() };

    manager = new ProactiveDaemonManager({
      endpoint: mockEndpoint,
      eventBus: mockEventBus,
      aether: { logger: mockLogger },
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    document.body.innerHTML = '';
    delete global.fetch;
    Toast.success.mockClear();
    Toast.error.mockClear();
    Toast.info.mockClear();
    Toast.warning.mockClear();
    mockModalOpen.mockClear();
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('stores endpoint and eventBus from options', () => {
      expect(manager.endpoint).toBe(mockEndpoint);
      expect(manager.eventBus).not.toBeNull();
    });

    it('uses aether.logger when provided', () => {
      expect(manager.logger).toBe(mockLogger);
    });

    it('falls back to console when aether has no logger', () => {
      const m = new ProactiveDaemonManager({ aether: {} });
      expect(m.logger).toBe(console);
    });

    it('falls back to console when aether is null', () => {
      const m = new ProactiveDaemonManager({});
      expect(m.logger).toBe(console);
    });

    it('uses window.aether when options.aether not provided', () => {
      window.aether = { logger: mockLogger };
      const m = new ProactiveDaemonManager({});
      expect(m.logger).toBe(mockLogger);
      delete window.aether;
    });

    it('initializes daemons list', () => {
      expect(manager.daemons).toEqual(DAEMONS);
    });

    it('initializes lifecycle flags, state, and tracking arrays', () => {
      expect(manager.currentConfig).toEqual({});
      expect(manager._masterEnabled).toBe(false);
      expect(manager._masterToggling).toBe(false);
      expect(manager._isInitialized).toBe(false);
      expect(manager._isDisposed).toBe(false);
      expect(manager._cleanups).toEqual([]);
      expect(manager._timers).toEqual([]);
    });
  });

  // =========================================================================
  // initialize
  // =========================================================================

  describe('initialize', () => {
    it('calls _fetchProactiveConfig, refreshConfig, and _attachEventListeners in order', async () => {
      const callOrder = [];
      jest.spyOn(manager, '_fetchProactiveConfig').mockImplementation(async () => {
        callOrder.push('proactive');
      });
      jest.spyOn(manager, 'refreshConfig').mockImplementation(async () => {
        callOrder.push('daemon');
      });
      jest.spyOn(manager, '_attachEventListeners').mockImplementation(() => {
        callOrder.push('listeners');
      });

      await manager.initialize();

      expect(callOrder).toEqual(['proactive', 'daemon', 'listeners']);
      expect(manager._isInitialized).toBe(true);
    });

    it('is idempotent — returns early if already initialized', async () => {
      manager._isInitialized = true;
      const spy = jest.spyOn(manager, 'refreshConfig');
      await manager.initialize();
      expect(spy).not.toHaveBeenCalled();
    });

    it('catches and logs errors during initialization', async () => {
      jest.spyOn(manager, '_fetchProactiveConfig').mockRejectedValue(new Error('net'));
      await manager.initialize();
      expect(mockLogger.error).toHaveBeenCalledWith(
        '[ProactiveDaemonManager] Initialization failed:', expect.any(Error)
      );
      expect(manager._isInitialized).toBe(false);
    });

    it('logs info on start', async () => {
      jest.spyOn(manager, '_fetchProactiveConfig').mockResolvedValue(undefined);
      jest.spyOn(manager, 'refreshConfig').mockResolvedValue(undefined);
      jest.spyOn(manager, '_attachEventListeners');
      await manager.initialize();
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[ProactiveDaemonManager] Initializing'
      );
    });
  });

  // =========================================================================
  // refreshConfig
  // =========================================================================

  describe('refreshConfig', () => {
    it('fetches config from endpoint and calls _updateUI', async () => {
      const cfg = { browser: { enabled: true } };
      mockEndpoint.getFileIndexingDaemonConfig.mockResolvedValue(cfg);
      const spy = jest.spyOn(manager, '_updateUI');

      await manager.refreshConfig();

      expect(mockEndpoint.getFileIndexingDaemonConfig).toHaveBeenCalled();
      expect(manager.currentConfig).toBe(cfg);
      expect(spy).toHaveBeenCalled();
    });

    it('logs error when fetch fails', async () => {
      mockEndpoint.getFileIndexingDaemonConfig.mockRejectedValue(
        new Error('timeout')
      );
      await manager.refreshConfig();
      expect(mockLogger.error).toHaveBeenCalledWith(
        '[ProactiveDaemonManager] Failed to fetch daemon config:',
        expect.any(Error)
      );
    });
  });

  // =========================================================================
  // _updateUI
  // =========================================================================

  describe('_updateUI', () => {
    it('sets toggle checked state based on config', () => {
      createDaemonDOM();
      manager.currentConfig = { browser: { enabled: true }, email: { enabled: false } };
      manager._updateUI();

      expect(document.getElementById('daemon-browser-enabled').checked).toBe(true);
      expect(document.getElementById('daemon-email-enabled').checked).toBe(false);
    });

    it('updates badge text and class for running daemons', () => {
      createDaemonDOM();
      manager.currentConfig = { browser: { enabled: true } };
      manager._updateUI();

      const badge = document.querySelector('.daemon-status-badge[data-daemon="browser"]');
      expect(badge.textContent).toBe('Running');
      expect(badge.classList.contains('running')).toBe(true);
    });

    it('updates badge for stopped daemons', () => {
      createDaemonDOM();
      manager.currentConfig = { browser: { enabled: false } };
      manager._updateUI();

      const badge = document.querySelector('.daemon-status-badge[data-daemon="browser"]');
      expect(badge.textContent).toBe('Stopped');
      expect(badge.classList.contains('running')).toBe(false);
    });

    it('handles missing config for daemon gracefully', () => {
      createDaemonDOM();
      manager.currentConfig = {};
      manager._updateUI();

      // All toggles should be unchecked (config.enabled is undefined → falsy)
      expect(document.getElementById('daemon-browser-enabled').checked).toBe(false);
    });

    it('handles missing DOM elements gracefully', () => {
      // No DOM elements created
      manager.currentConfig = { browser: { enabled: true } };
      expect(() => manager._updateUI()).not.toThrow();
    });

    it('uses fallback ID for file_indexing toggle', () => {
      // Create only the fallback ID element
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.id = 'file-indexing-enabled';
      document.body.appendChild(toggle);

      manager.currentConfig = { file_indexing: { enabled: true } };
      manager._updateUI();
      expect(toggle.checked).toBe(true);
    });
  });

  // =========================================================================
  // _trackListener
  // =========================================================================

  describe('_trackListener', () => {
    it('adds event listener and pushes cleanup function to _cleanups', () => {
      const el = document.createElement('div');
      const handler = jest.fn();
      const addSpy = jest.spyOn(el, 'addEventListener');

      manager._trackListener(el, 'click', handler);

      expect(addSpy).toHaveBeenCalledWith('click', handler);
      expect(manager._cleanups.length).toBe(1);
      expect(typeof manager._cleanups[0]).toBe('function');
    });

    it('cleanup function removes the listener when called', () => {
      const el = document.createElement('div');
      const handler = jest.fn();
      const removeSpy = jest.spyOn(el, 'removeEventListener');

      manager._trackListener(el, 'click', handler);
      manager._cleanups[0]();

      expect(removeSpy).toHaveBeenCalledWith('click', handler);
    });
  });

  // =========================================================================
  // _attachEventListeners
  // =========================================================================

  describe('_attachEventListeners', () => {
    it('attaches change handlers to all toggles including master', () => {
      createMasterToggleDOM();
      createDaemonDOM();
      manager._attachEventListeners();
      // 1 master toggle + 5 daemons × 1 toggle + 5 daemons × 1 settings button = 11 cleanups
      expect(manager._cleanups.length).toBe(11);
    });

    it('attaches daemon listeners only when master toggle is absent', () => {
      createDaemonDOM();
      manager._attachEventListeners();
      // 5 daemons × 1 toggle + 5 daemons × 1 settings button = 10 cleanups
      expect(manager._cleanups.length).toBe(10);
    });

    it('skips daemons without toggle elements', () => {
      // No DOM elements
      manager._attachEventListeners();
      expect(manager._cleanups.length).toBe(0);
    });

    it('master toggle change handler calls _handleMasterToggle', async () => {
      createMasterToggleDOM();
      const spy = jest.spyOn(manager, '_handleMasterToggle').mockResolvedValue(undefined);
      manager._attachEventListeners();

      const masterCb = document.getElementById('proactive-master-enabled');
      masterCb.checked = true;
      masterCb.dispatchEvent(new Event('change'));

      expect(spy).toHaveBeenCalledWith(true);
    });

    it('toggle change handler calls _handleToggle', async () => {
      createDaemonDOM();
      const spy = jest.spyOn(manager, '_handleToggle').mockResolvedValue(undefined);
      manager._attachEventListeners();

      const toggle = document.getElementById('daemon-browser-enabled');
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));

      expect(spy).toHaveBeenCalledWith('browser', true);
    });

    it('settings button click opens DaemonConfigModal', () => {
      const DaemonConfigModal = require('../../../src/renderer/main/modules/settings/DaemonConfigModal');
      createDaemonDOM();
      manager._attachEventListeners();

      mockModalOpen.mockClear();
      DaemonConfigModal.mockClear();

      const btn = document.querySelector('.daemon-settings-btn[data-daemon="browser"]');
      btn.click();

      expect(DaemonConfigModal).toHaveBeenCalledWith(
        expect.objectContaining({
          daemonName: 'browser',
          endpoint: manager.endpoint,
        })
      );
      expect(mockModalOpen).toHaveBeenCalledTimes(1);
    });

    it('settings button click does not throw when button is present', () => {
      // Create only buttons (no panels needed — modal is independent)
      for (const daemon of DAEMONS) {
        const toggle = document.createElement('input');
        toggle.id = `daemon-${daemon.replace('_', '-')}-enabled`;
        document.body.appendChild(toggle);

        const btn = document.createElement('button');
        btn.className = 'daemon-settings-btn';
        btn.dataset.daemon = daemon;
        document.body.appendChild(btn);
      }

      manager._attachEventListeners();
      const btn = document.querySelector('.daemon-settings-btn[data-daemon="browser"]');
      expect(() => btn.click()).not.toThrow();
    });
  });

  // =========================================================================
  // _handleToggle
  // =========================================================================

  describe('_handleToggle', () => {
    it('updates config and calls endpoint', async () => {
      await manager._handleToggle('browser', true);

      expect(manager.currentConfig.browser.enabled).toBe(true);
      // Enabled state flows through PATCH /v1/proactive/config (proactive_config.json),
      // NOT POST /v1/file/daemon/config (config_override.json).
      expect(mockEndpoint.updateProactiveConfig).toHaveBeenCalledWith(
        { browser_enabled: true }
      );
    });

    it('creates config entry for daemon if missing', async () => {
      manager.currentConfig = {};
      await manager._handleToggle('email', true);
      expect(manager.currentConfig.email).toEqual({ enabled: true });
    });

    it('updates existing config entry without replacing it', async () => {
      manager.currentConfig = { browser: { enabled: false, interval: 60 } };
      await manager._handleToggle('browser', true);
      expect(manager.currentConfig.browser.enabled).toBe(true);
      expect(manager.currentConfig.browser.interval).toBe(60); // preserved
    });

    it('shows success status message and clears after 3s', async () => {
      const statusEl = createStatusEl();
      await manager._handleToggle('browser', true);

      expect(statusEl.textContent).toBe('browser enabled');
      // jsdom does not resolve CSS custom properties via .style.color;
      // verify the timer was created for cleanup instead
      expect(manager._timers.length).toBe(1);

      jest.advanceTimersByTime(3000);
      expect(statusEl.textContent).toBe('');
    });

    it('shows disabled message when toggling off', async () => {
      const statusEl = createStatusEl();
      await manager._handleToggle('email', false);
      expect(statusEl.textContent).toBe('email disabled');
    });

    it('skips status update when #settings-status is missing', async () => {
      await manager._handleToggle('browser', true);
      expect(manager._timers.length).toBe(0);
    });

    it('calls _updateUI after successful toggle', async () => {
      const spy = jest.spyOn(manager, '_updateUI');
      await manager._handleToggle('browser', true);
      expect(spy).toHaveBeenCalled();
    });

    it('logs error and reverts config + UI on endpoint failure', async () => {
      // Pre-set config so revert target is explicit
      manager.currentConfig = { browser: { enabled: false, interval: 60 } };

      mockEndpoint.updateProactiveConfig.mockRejectedValueOnce(
        new Error('save failed')
      );
      const spy = jest.spyOn(manager, '_updateUI');

      await manager._handleToggle('browser', true);

      expect(mockLogger.error).toHaveBeenCalledWith(
        '[ProactiveDaemonManager] Failed to toggle browser:', expect.any(Error)
      );
      // Config must revert to previous value (false), not stay at optimistic (true)
      expect(manager.currentConfig.browser.enabled).toBe(false);
      // Other config properties must be preserved
      expect(manager.currentConfig.browser.interval).toBe(60);
      // _updateUI called for revert
      expect(spy).toHaveBeenCalled();
    });

    it('logs toggle action', async () => {
      await manager._handleToggle('filesystem', true);
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[ProactiveDaemonManager] Toggling filesystem: true'
      );
    });
  });

  // =========================================================================
  // _fetchProactiveConfig (now uses endpoint.getProactiveConfig)
  // =========================================================================

  describe('_fetchProactiveConfig', () => {
    it('fetches config and sets _masterEnabled', async () => {
      mockEndpoint.getProactiveConfig.mockResolvedValue({ enabled: true });

      await manager._fetchProactiveConfig();
      expect(mockEndpoint.getProactiveConfig).toHaveBeenCalled();
      expect(manager._masterEnabled).toBe(true);
    });

    it('sets _masterEnabled=false when API returns enabled=false', async () => {
      mockEndpoint.getProactiveConfig.mockResolvedValue({ enabled: false });

      await manager._fetchProactiveConfig();
      expect(manager._masterEnabled).toBe(false);
    });

    it('defaults to disabled on error', async () => {
      mockEndpoint.getProactiveConfig.mockRejectedValue(new Error('network'));

      await manager._fetchProactiveConfig();
      expect(manager._masterEnabled).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        '[ProactiveDaemonManager] Failed to fetch proactive config:',
        expect.any(Error)
      );
    });

    it('calls _updateMasterUI after fetching', async () => {
      const spy = jest.spyOn(manager, '_updateMasterUI');
      await manager._fetchProactiveConfig();
      expect(spy).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _updateMasterUI
  // =========================================================================

  describe('_updateMasterUI', () => {
    it('sets checkbox checked when master is enabled (idle mode)', () => {
      const { checkbox, status, card } = createMasterToggleDOM();
      manager._masterEnabled = true;
      manager._updateMasterUI('idle');

      expect(checkbox.checked).toBe(true);
      expect(status.classList.contains('is-visible')).toBe(true);
      expect(status.classList.contains('status-on')).toBe(true);
      expect(status.classList.contains('status-off')).toBe(false);
      expect(status.classList.contains('status-loading')).toBe(false);
      expect(card.classList.contains('master-disabled')).toBe(false);
    });

    it('sets checkbox unchecked and dims card when master is disabled', () => {
      const { checkbox, status, card } = createMasterToggleDOM();
      manager._masterEnabled = false;
      manager._updateMasterUI();

      expect(checkbox.checked).toBe(false);
      expect(status.classList.contains('status-off')).toBe(true);
      expect(status.classList.contains('status-on')).toBe(false);
      expect(card.classList.contains('master-disabled')).toBe(true);
    });

    it('shows "Background tasks active" text when enabled', () => {
      const { status } = createMasterToggleDOM();
      manager._masterEnabled = true;
      manager._updateMasterUI();

      expect(status.textContent).toContain('Background tasks active');
      expect(status.querySelector('.fa-circle-check')).not.toBeNull();
    });

    it('shows "All background tasks paused" text when disabled', () => {
      const { status } = createMasterToggleDOM();
      manager._masterEnabled = false;
      manager._updateMasterUI();

      expect(status.textContent).toContain('All background tasks paused');
      expect(status.querySelector('.fa-pause-circle')).not.toBeNull();
    });

    it('shows loading state with spinner when mode=loading and enabling', () => {
      const { status } = createMasterToggleDOM();
      manager._masterEnabled = true;
      manager._updateMasterUI('loading');

      expect(status.classList.contains('status-loading')).toBe(true);
      expect(status.classList.contains('status-on')).toBe(false);
      expect(status.classList.contains('status-off')).toBe(false);
      expect(status.textContent).toContain('Starting background tasks');
      expect(status.querySelector('.fa-spinner')).not.toBeNull();
    });

    it('shows loading state with spinner when mode=loading and disabling', () => {
      const { status } = createMasterToggleDOM();
      manager._masterEnabled = false;
      manager._updateMasterUI('loading');

      expect(status.classList.contains('status-loading')).toBe(true);
      expect(status.textContent).toContain('Stopping background tasks');
    });

    it('adds is-loading class to toggle pill when mode=loading', () => {
      const { checkbox } = createMasterToggleDOM();
      // Wrap checkbox in a label with the proactive-master-toggle class (like real DOM)
      const label = document.createElement('label');
      label.className = 'aether-switch proactive-master-toggle';
      checkbox.parentNode.insertBefore(label, checkbox);
      label.appendChild(checkbox);

      manager._updateMasterUI('loading');
      expect(label.classList.contains('is-loading')).toBe(true);

      manager._updateMasterUI('idle');
      expect(label.classList.contains('is-loading')).toBe(false);
    });

    it('handles missing DOM elements gracefully', () => {
      // No DOM created
      expect(() => manager._updateMasterUI()).not.toThrow();
      expect(() => manager._updateMasterUI('loading')).not.toThrow();
    });
  });

  // =========================================================================
  // _handleMasterToggle
  // =========================================================================

  describe('_handleMasterToggle', () => {
    it('calls updateProactiveConfig with enabled=true', async () => {
      await manager._handleMasterToggle(true);

      expect(mockEndpoint.updateProactiveConfig).toHaveBeenCalledWith({ enabled: true });
      expect(manager._masterEnabled).toBe(true);
    });

    it('calls updateProactiveConfig with enabled=false when disabling', async () => {
      manager._masterEnabled = true;
      await manager._handleMasterToggle(false);

      expect(mockEndpoint.updateProactiveConfig).toHaveBeenCalledWith({ enabled: false });
      expect(manager._masterEnabled).toBe(false);
    });

    it('reverts _masterEnabled on API failure', async () => {
      manager._masterEnabled = true;
      mockEndpoint.updateProactiveConfig.mockRejectedValue(new Error('network'));

      await manager._handleMasterToggle(false);

      // Should revert to previous state (true)
      expect(manager._masterEnabled).toBe(true);
      expect(mockLogger.error).toHaveBeenCalledWith(
        '[ProactiveDaemonManager] Failed to toggle master switch:',
        expect.any(Error)
      );
    });

    it('emits proactive:master-toggled event on success', async () => {
      await manager._handleMasterToggle(true);

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        'proactive:master-toggled', { enabled: true }
      );
    });

    it('does not emit event on failure', async () => {
      mockEndpoint.updateProactiveConfig.mockRejectedValue(new Error('down'));
      await manager._handleMasterToggle(true);
      expect(mockEventBus.emit).not.toHaveBeenCalled();
    });

    it('shows loading state during API call, then settles', async () => {
      createMasterToggleDOM();
      const updateSpy = jest.spyOn(manager, '_updateMasterUI');

      await manager._handleMasterToggle(true);

      expect(updateSpy).toHaveBeenCalledWith('loading');
      expect(updateSpy).toHaveBeenCalledWith('idle');
    });

    it('shows Toast.success when enabling', async () => {
      await manager._handleMasterToggle(true);
      expect(Toast.success).toHaveBeenCalledWith('Background tasks enabled');
    });

    it('shows Toast.info when disabling', async () => {
      manager._masterEnabled = true;
      await manager._handleMasterToggle(false);
      expect(Toast.info).toHaveBeenCalledWith('All background tasks stopped');
    });

    it('shows Toast.error on failure', async () => {
      mockEndpoint.updateProactiveConfig.mockRejectedValue(new Error('down'));
      await manager._handleMasterToggle(true);
      expect(Toast.error).toHaveBeenCalledWith('Failed to update background tasks');
    });

    it('guards against rapid double-toggle', async () => {
      let resolveFirst;
      mockEndpoint.updateProactiveConfig.mockImplementationOnce(() => new Promise(resolve => {
        resolveFirst = resolve;
      }));

      // Start first toggle (will hang)
      const p1 = manager._handleMasterToggle(true);

      // Second toggle should be ignored (masterToggling = true)
      await manager._handleMasterToggle(false);
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[ProactiveDaemonManager] Master toggle ignored (in flight)'
      );

      // Resolve first call
      resolveFirst({});
      await p1;

      // Guard should be released
      expect(manager._masterToggling).toBe(false);
    });

    it('resets _masterToggling even on error (finally block)', async () => {
      mockEndpoint.updateProactiveConfig.mockRejectedValue(new Error('crash'));
      await manager._handleMasterToggle(true);
      expect(manager._masterToggling).toBe(false);
    });

    it('logs toggle action', async () => {
      await manager._handleMasterToggle(true);
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[ProactiveDaemonManager] Master toggle: true'
      );
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    it('runs all tracked cleanup functions', () => {
      const el = document.createElement('div');
      const handler = jest.fn();
      const removeSpy = jest.spyOn(el, 'removeEventListener');

      // Use _trackListener to register a real cleanup
      manager._trackListener(el, 'click', handler);

      manager.dispose();
      expect(removeSpy).toHaveBeenCalledWith('click', handler);
      expect(manager._cleanups).toEqual([]);
    });

    it('clears all tracked timers', () => {
      const timerId = setTimeout(() => {}, 5000);
      manager._timers = [timerId];
      manager.dispose();
      expect(manager._timers).toEqual([]);
    });

    it('handles cleanup function throwing', () => {
      manager._cleanups = [() => { throw new Error('dom gone'); }];
      expect(() => manager.dispose()).not.toThrow();
      expect(manager._cleanups).toEqual([]);
    });

    it('resets references, state, and flags', () => {
      manager.currentConfig = { x: 1 };
      manager._masterEnabled = true;
      manager._masterToggling = true;
      manager._isInitialized = true;
      manager.dispose();

      expect(manager.currentConfig).toEqual({});
      expect(manager._masterEnabled).toBe(false);
      expect(manager._masterToggling).toBe(false);
      expect(manager.endpoint).toBeNull();
      expect(manager.eventBus).toBeNull();
      expect(manager._isInitialized).toBe(false);
      expect(manager._isDisposed).toBe(true);
    });

    it('is idempotent — double dispose does not throw', () => {
      manager.dispose();
      expect(() => manager.dispose()).not.toThrow();
    });

    it('logs info on dispose', () => {
      manager.dispose();
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[ProactiveDaemonManager] Disposed'
      );
    });
  });

  // =========================================================================
  // window assignment
  // =========================================================================

  describe('module exports', () => {
    it('assigns ProactiveDaemonManager to window', () => {
      expect(window.ProactiveDaemonManager).toBe(ProactiveDaemonManager);
    });
  });

  // =========================================================================
  // lifecycle
  // =========================================================================

  describe('lifecycle', () => {
    it('create → init → dispose → recreate', async () => {
      createMasterToggleDOM();
      createDaemonDOM();

      jest.spyOn(manager, '_fetchProactiveConfig').mockResolvedValue(undefined);
      jest.spyOn(manager, 'refreshConfig').mockResolvedValue(undefined);
      await manager.initialize();
      expect(manager._isInitialized).toBe(true);
      // 1 master + 5 daemon toggles + 5 settings buttons = 11
      expect(manager._cleanups.length).toBe(11);

      manager.dispose();
      expect(manager._isDisposed).toBe(true);
      expect(manager._cleanups).toEqual([]);
      expect(manager._masterEnabled).toBe(false);
      expect(manager.endpoint).toBeNull();

      // Recreate
      const m2 = new ProactiveDaemonManager({
        endpoint: mockEndpoint,
        aether: { logger: mockLogger },
      });
      expect(m2._isInitialized).toBe(false);
      expect(m2._isDisposed).toBe(false);
      expect(m2._masterEnabled).toBe(false);
    });
  });
});
