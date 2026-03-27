'use strict';

/**
 * DaemonController Unit Tests
 * ============================================================================
 * Tests constructor, updateEnabledState (start/stop daemon, error handling,
 * toggle revert), loadDaemonStatus (sync toggle, starting-state heuristic),
 * renderDaemonBanner (first render, update, controls locked), dispose
 * (timer cleanup, listener removal), _awaitDaemonStatusTransition (polling),
 * _restartDaemon (confirm dialog, restart API, timer), _handleDaemonControlError
 * (403 lock, non-403 pass-through), _formatUptime.
 *
 * @module tests/unit/renderer/main/daemon-controller.test
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../../../../src/renderer/shared/components/ConfirmDialog', () => ({
  confirm: jest.fn().mockResolvedValue(true),
}));

const ConfirmDialog = require('../../../../src/renderer/shared/components/ConfirmDialog');
const DaemonController = require('../../../../src/renderer/main/modules/settings/modules/DaemonController');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockLogger = {
  trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
};

function createController(overrides = {}) {
  // Build DOM: card > card-content > [enableToggle, addButton]
  const card = document.createElement('div');
  card.className = 'settings-card';
  const content = document.createElement('div');
  content.className = 'card-content';
  card.appendChild(content);

  const enableToggle = document.createElement('input');
  enableToggle.type = 'checkbox';
  enableToggle.checked = false;
  enableToggle.disabled = false;
  content.appendChild(enableToggle);

  const addButton = document.createElement('button');
  addButton.id = 'add-location-btn';
  content.appendChild(addButton);
  document.body.appendChild(card);

  let isEnabled = false;
  let daemonStatus = null;

  const opts = {
    endpoint: {
      startFileIndexingDaemon: jest.fn().mockResolvedValue({ success: true }),
      stopFileIndexingDaemon: jest.fn().mockResolvedValue({ success: true }),
      getFileIndexingDaemonStatus: jest.fn().mockResolvedValue({ running: false }),
      restartFileIndexingDaemon: jest.fn().mockResolvedValue({ success: true }),
    },
    getElements: jest.fn(() => ({ enableToggle, addButton })),
    getIsEnabled: jest.fn(() => isEnabled),
    setIsEnabled: jest.fn((v) => { isEnabled = v; }),
    getDaemonStatus: jest.fn(() => daemonStatus),
    setDaemonStatus: jest.fn((s) => { daemonStatus = s; }),
    loadLocations: jest.fn().mockResolvedValue(undefined),
    showSuccess: jest.fn(),
    showError: jest.fn(),
    logger: mockLogger,
    ...overrides,
  };

  const ctrl = new DaemonController(opts);

  return {
    ctrl,
    enableToggle,
    addButton,
    get isEnabled() { return isEnabled; },
    set isEnabled(v) { isEnabled = v; },
    get daemonStatus() { return daemonStatus; },
    set daemonStatus(v) { daemonStatus = v; },
    opts,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DaemonController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('stores dependencies', () => {
      const { ctrl, opts } = createController();
      expect(ctrl.endpoint).toBe(opts.endpoint);
      expect(ctrl.getElements).toBe(opts.getElements);
      expect(ctrl.logger).toBe(mockLogger);
    });

    it('defaults logger to console', () => {
      const c = new DaemonController({});
      expect(c.logger).toBe(console);
    });

    it('initialises state', () => {
      const { ctrl } = createController();
      expect(ctrl._isDisposed).toBe(false);
      expect(ctrl._isChangingState).toBe(false);
      expect(ctrl._daemonStartRequestedAt).toBe(0);
      expect(ctrl._daemonControlsLocked).toBe(false);
      expect(ctrl._daemonBannerListeners).toEqual([]);
      expect(ctrl._restartTimerId).toBeNull();
    });
  });

  // =========================================================================
  // _formatUptime
  // =========================================================================

  describe('_formatUptime', () => {
    it('formats seconds', () => {
      const { ctrl } = createController();
      expect(ctrl._formatUptime(45)).toBe('45s');
    });

    it('formats minutes', () => {
      const { ctrl } = createController();
      expect(ctrl._formatUptime(300)).toBe('5m');
    });

    it('formats hours', () => {
      const { ctrl } = createController();
      expect(ctrl._formatUptime(7260)).toBe('2h 1m');
    });

    it('formats days', () => {
      const { ctrl } = createController();
      expect(ctrl._formatUptime(90000)).toBe('1d 1h');
    });
  });

  // =========================================================================
  // _handleDaemonControlError
  // =========================================================================

  describe('_handleDaemonControlError', () => {
    it('returns false for non-403 errors', () => {
      const { ctrl } = createController();
      expect(ctrl._handleDaemonControlError(new Error('fail'))).toBe(false);
    });

    it('returns false for 500 status', () => {
      const { ctrl } = createController();
      expect(ctrl._handleDaemonControlError({ status: 500 })).toBe(false);
    });

    it('locks controls on 403', () => {
      const { ctrl, enableToggle } = createController();
      const result = ctrl._handleDaemonControlError({ status: 403 });
      expect(result).toBe(true);
      expect(ctrl._daemonControlsLocked).toBe(true);
      expect(enableToggle.disabled).toBe(true);
    });

    it('handles 403 with response.status', () => {
      const { ctrl } = createController();
      const result = ctrl._handleDaemonControlError({ response: { status: 403 } });
      expect(result).toBe(true);
    });

    it('disables banner restart button on 403', () => {
      const { ctrl } = createController();
      ctrl._daemonBannerButtons = { restart: document.createElement('button') };
      ctrl._handleDaemonControlError({ status: 403 });
      expect(ctrl._daemonBannerButtons.restart.disabled).toBe(true);
    });

    it('handles missing enableToggle on 403', () => {
      const { ctrl } = createController({
        getElements: jest.fn(() => ({ enableToggle: null, addButton: null })),
      });
      expect(ctrl._handleDaemonControlError({ status: 403 })).toBe(true);
    });
  });

  // =========================================================================
  // loadDaemonStatus
  // =========================================================================

  describe('loadDaemonStatus', () => {
    it('fetches status and renders banner', async () => {
      const { ctrl, opts } = createController();
      opts.endpoint.getFileIndexingDaemonStatus.mockResolvedValue({ running: true });

      await ctrl.loadDaemonStatus();

      expect(opts.endpoint.getFileIndexingDaemonStatus).toHaveBeenCalledTimes(1);
      expect(opts.setDaemonStatus).toHaveBeenCalledWith({ running: true });
    });

    it('syncs toggle when status changes', async () => {
      const { ctrl, opts, enableToggle } = createController();
      enableToggle.checked = false;
      opts.endpoint.getFileIndexingDaemonStatus.mockResolvedValue({ running: true });

      await ctrl.loadDaemonStatus();

      expect(enableToggle.checked).toBe(true);
      expect(opts.setIsEnabled).toHaveBeenCalledWith(true);
    });

    it('does not sync toggle when _isChangingState', async () => {
      const { ctrl, opts, enableToggle } = createController();
      ctrl._isChangingState = true;
      enableToggle.checked = false;
      opts.endpoint.getFileIndexingDaemonStatus.mockResolvedValue({ running: true });

      await ctrl.loadDaemonStatus();

      expect(enableToggle.checked).toBe(false);
    });

    it('does not sync toggle when already matching', async () => {
      const { ctrl, opts, enableToggle } = createController();
      enableToggle.checked = false;
      opts.endpoint.getFileIndexingDaemonStatus.mockResolvedValue({ running: false });

      await ctrl.loadDaemonStatus();

      expect(opts.setIsEnabled).not.toHaveBeenCalled();
    });

    it('preserves starting UI state within 20s window', async () => {
      const { ctrl, opts } = createController();
      ctrl._daemonStartRequestedAt = Date.now() - 5000;
      opts.endpoint.getFileIndexingDaemonStatus.mockResolvedValue({ running: false });

      await ctrl.loadDaemonStatus();

      expect(opts.setDaemonStatus).toHaveBeenCalledWith(expect.objectContaining({
        running: false,
        _ui_state: 'starting',
      }));
    });

    it('does not preserve starting state after 20s', async () => {
      const { ctrl, opts } = createController();
      ctrl._daemonStartRequestedAt = Date.now() - 25000;
      opts.endpoint.getFileIndexingDaemonStatus.mockResolvedValue({ running: false });

      await ctrl.loadDaemonStatus();

      // setDaemonStatus called first with raw status (no _ui_state),
      // then NOT called again with _ui_state: 'starting'
      const calls = opts.setDaemonStatus.mock.calls;
      const lastCall = calls[calls.length - 1][0];
      expect(lastCall._ui_state).toBeUndefined();
    });

    it('handles API error gracefully', async () => {
      const { ctrl, opts } = createController();
      opts.endpoint.getFileIndexingDaemonStatus.mockRejectedValue(new Error('net fail'));

      await ctrl.loadDaemonStatus();

      expect(opts.setDaemonStatus).toHaveBeenCalledWith({ running: false, error: 'net fail' });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[DaemonController] Failed to load daemon status:',
        expect.any(Error)
      );
    });

    it('does not sync toggle without enableToggle element', async () => {
      const { ctrl, opts } = createController({
        getElements: jest.fn(() => ({ enableToggle: null, addButton: null })),
      });
      opts.endpoint.getFileIndexingDaemonStatus.mockResolvedValue({ running: true });

      await ctrl.loadDaemonStatus();

      expect(opts.setIsEnabled).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // renderDaemonBanner
  // =========================================================================

  describe('renderDaemonBanner', () => {
    it('creates banner on first render with slot', () => {
      const slot = document.createElement('div');
      slot.id = 'file-indexing-daemon-banner-slot';
      document.body.appendChild(slot);

      const { ctrl } = createController();
      ctrl.getDaemonStatus = jest.fn(() => ({ running: true, uptime_seconds: 120 }));

      ctrl.renderDaemonBanner();

      const banner = document.getElementById('file-indexing-daemon-banner');
      expect(banner).not.toBeNull();
      expect(banner.className).toContain('daemon-running');
      expect(banner.textContent).toContain('Running');
      expect(banner.textContent).toContain('Uptime: 2m');
    });

    it('creates banner without slot via card-content fallback', () => {
      const { ctrl } = createController();
      ctrl.getDaemonStatus = jest.fn(() => ({ running: false }));

      ctrl.renderDaemonBanner();

      const banner = document.getElementById('file-indexing-daemon-banner');
      expect(banner).not.toBeNull();
      expect(banner.className).toContain('daemon-stopped');
    });

    it('shows starting state', () => {
      const { ctrl } = createController();
      ctrl.getDaemonStatus = jest.fn(() => ({ running: false, _ui_state: 'starting' }));

      ctrl.renderDaemonBanner();

      const banner = document.getElementById('file-indexing-daemon-banner');
      expect(banner.className).toContain('daemon-starting');
      expect(banner.textContent).toContain('Starting');
    });

    it('hides banner when no status', () => {
      const { ctrl } = createController();
      ctrl.getDaemonStatus = jest.fn(() => null);

      ctrl.renderDaemonBanner();

      const banner = document.getElementById('file-indexing-daemon-banner');
      expect(banner.style.display).toBe('none');
    });

    it('updates existing banner without recreating', () => {
      const { ctrl } = createController();
      ctrl.getDaemonStatus = jest.fn(() => ({ running: true, uptime_seconds: 60 }));
      ctrl.renderDaemonBanner(); // first render

      ctrl.getDaemonStatus = jest.fn(() => ({ running: false }));
      ctrl.renderDaemonBanner(); // update

      const statusEl = document.querySelector('[data-daemon-status]');
      expect(statusEl.textContent).toBe('Stopped');
    });

    it('shows uptime on running, hides on stopped in update', () => {
      const { ctrl } = createController();
      ctrl.getDaemonStatus = jest.fn(() => ({ running: true, uptime_seconds: 300 }));
      ctrl.renderDaemonBanner();

      const uptimeEl = document.querySelector('[data-daemon-uptime]');
      expect(uptimeEl.style.display).toBe('inline');

      ctrl.getDaemonStatus = jest.fn(() => ({ running: false }));
      ctrl.renderDaemonBanner();
      expect(uptimeEl.style.display).toBe('none');
    });

    it('disables restart when controls locked', () => {
      const { ctrl } = createController();
      ctrl.getDaemonStatus = jest.fn(() => ({ running: true }));
      ctrl._daemonControlsLocked = true;

      ctrl.renderDaemonBanner();

      const restartBtn = document.querySelector('#daemon-restart-btn');
      expect(restartBtn.disabled).toBe(true);
    });

    it('shows N/A uptime when uptime_seconds missing', () => {
      const { ctrl } = createController();
      ctrl.getDaemonStatus = jest.fn(() => ({ running: true }));
      ctrl.renderDaemonBanner();

      const banner = document.getElementById('file-indexing-daemon-banner');
      expect(banner.textContent).toContain('N/A');
    });

    it('banner without slot or card-content creates detached banner (not in document)', () => {
      const { ctrl } = createController({
        getElements: jest.fn(() => ({ enableToggle: null, addButton: null })),
      });
      ctrl.getDaemonStatus = jest.fn(() => ({ running: false }));
      ctrl.renderDaemonBanner();

      // Banner element was created internally but NOT inserted into document
      // because neither slot nor card-content ancestor was found
      const bannerInDoc = document.getElementById('file-indexing-daemon-banner');
      expect(bannerInDoc).toBeNull();
      // But buttons were still cached internally (first render ran)
      expect(ctrl._daemonBannerButtons).not.toBeNull();
      expect(ctrl._daemonBannerButtons.restart).toBeTruthy();
    });
  });

  // =========================================================================
  // updateEnabledState
  // =========================================================================

  describe('updateEnabledState', () => {
    it('returns early when disposed', async () => {
      const { ctrl, opts } = createController();
      ctrl._isDisposed = true;
      await ctrl.updateEnabledState();
      expect(opts.endpoint.startFileIndexingDaemon).not.toHaveBeenCalled();
    });

    it('returns early when already changing state', async () => {
      const { ctrl, opts } = createController();
      ctrl._isChangingState = true;
      await ctrl.updateEnabledState();
      expect(opts.endpoint.startFileIndexingDaemon).not.toHaveBeenCalled();
    });

    // --- START DAEMON ---

    it('starts daemon successfully', async () => {
      const { ctrl, opts, addButton } = createController();
      opts.getIsEnabled.mockReturnValue(true);
      opts.endpoint.getFileIndexingDaemonStatus.mockResolvedValue({ running: true });

      await ctrl.updateEnabledState();

      expect(opts.endpoint.startFileIndexingDaemon).toHaveBeenCalledTimes(1);
      expect(opts.showSuccess).toHaveBeenCalledWith('Daemon started successfully');
      expect(opts.loadLocations).toHaveBeenCalledWith(true);
      expect(opts.loadLocations).toHaveBeenCalledTimes(1);
      expect(ctrl._isChangingState).toBe(false);
    });

    it('start failure reverts toggle', async () => {
      const { ctrl, opts, enableToggle } = createController();
      enableToggle.checked = true;
      opts.getIsEnabled.mockReturnValue(true);
      opts.endpoint.startFileIndexingDaemon.mockResolvedValue({ success: false, message: 'no resources' });

      await ctrl.updateEnabledState();

      expect(opts.showError).toHaveBeenCalledWith('no resources');
      expect(enableToggle.checked).toBe(false);
      expect(opts.setIsEnabled).toHaveBeenCalledWith(false);
    });

    it('start failure uses default message', async () => {
      const { ctrl, opts } = createController();
      opts.getIsEnabled.mockReturnValue(true);
      opts.endpoint.startFileIndexingDaemon.mockResolvedValue({ success: false });

      await ctrl.updateEnabledState();

      expect(opts.showError).toHaveBeenCalledWith('Failed to start daemon');
    });

    it('start failure handles missing enableToggle', async () => {
      const { ctrl, opts } = createController({
        getElements: jest.fn(() => ({ enableToggle: null, addButton: null })),
      });
      opts.getIsEnabled.mockReturnValue(true);
      opts.endpoint.startFileIndexingDaemon.mockResolvedValue({ success: false });

      await ctrl.updateEnabledState();
      expect(ctrl._isChangingState).toBe(false);
    });

    // --- STOP DAEMON ---

    it('stops daemon successfully', async () => {
      const { ctrl, opts, enableToggle } = createController();
      opts.getIsEnabled.mockReturnValue(false);
      enableToggle.disabled = false;
      opts.endpoint.getFileIndexingDaemonStatus.mockResolvedValue({ running: false });

      await ctrl.updateEnabledState();

      expect(ConfirmDialog.confirm).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Stop indexing daemon',
        variant: 'danger',
      }));
      expect(opts.endpoint.stopFileIndexingDaemon).toHaveBeenCalledTimes(1);
      expect(opts.showSuccess).toHaveBeenCalledWith('Daemon stopped successfully');
      expect(enableToggle.disabled).toBe(false);
    });

    it('stop cancelled by user reverts toggle', async () => {
      const { ctrl, opts, enableToggle } = createController();
      opts.getIsEnabled.mockReturnValue(false);
      ConfirmDialog.confirm.mockResolvedValueOnce(false);

      await ctrl.updateEnabledState();

      expect(enableToggle.checked).toBe(true);
      expect(opts.setIsEnabled).toHaveBeenCalledWith(true);
      expect(opts.endpoint.stopFileIndexingDaemon).not.toHaveBeenCalled();
      expect(ctrl._isChangingState).toBe(false); // finally block resets even on early return
    });

    it('stop failure reverts toggle', async () => {
      const { ctrl, opts, enableToggle } = createController();
      opts.getIsEnabled.mockReturnValue(false);
      opts.endpoint.stopFileIndexingDaemon.mockResolvedValue({ success: false, message: 'busy' });

      await ctrl.updateEnabledState();

      expect(opts.showError).toHaveBeenCalledWith('busy');
      expect(enableToggle.checked).toBe(true);
      expect(opts.setIsEnabled).toHaveBeenCalledWith(true);
    });

    it('stop failure uses default message', async () => {
      const { ctrl, opts } = createController();
      opts.getIsEnabled.mockReturnValue(false);
      opts.endpoint.stopFileIndexingDaemon.mockResolvedValue({ success: false });

      await ctrl.updateEnabledState();

      expect(opts.showError).toHaveBeenCalledWith('Failed to stop daemon');
    });

    it('stop handles missing enableToggle for cancel path', async () => {
      const { ctrl, opts } = createController({
        getElements: jest.fn(() => ({ enableToggle: null, addButton: null })),
      });
      opts.getIsEnabled.mockReturnValue(false);
      ConfirmDialog.confirm.mockResolvedValueOnce(false);

      await ctrl.updateEnabledState();
      expect(ctrl._isChangingState).toBe(false);
    });

    it('stop handles missing enableToggle for failure', async () => {
      const { ctrl, opts } = createController({
        getElements: jest.fn(() => ({ enableToggle: null, addButton: null })),
      });
      opts.getIsEnabled.mockReturnValue(false);
      opts.endpoint.stopFileIndexingDaemon.mockResolvedValue({ success: false });

      await ctrl.updateEnabledState();
      expect(ctrl._isChangingState).toBe(false);
    });

    // --- UI UPDATE ---

    it('updates card opacity and button disabled after success', async () => {
      const { ctrl, opts, addButton } = createController();
      opts.getIsEnabled.mockReturnValue(true);
      opts.endpoint.getFileIndexingDaemonStatus.mockResolvedValue({ running: true });

      await ctrl.updateEnabledState();

      const card = addButton.closest('.settings-card');
      expect(card.style.opacity).toBe('1');
      expect(addButton.disabled).toBe(false);
    });

    it('dims card when disabled after stop', async () => {
      const { ctrl, opts, addButton } = createController();
      opts.getIsEnabled
        .mockReturnValueOnce(false) // initial call
        .mockReturnValue(false); // after stop
      opts.endpoint.getFileIndexingDaemonStatus.mockResolvedValue({ running: false });

      await ctrl.updateEnabledState();

      const card = addButton.closest('.settings-card');
      expect(card.style.opacity).toBe('0.6');
      expect(addButton.disabled).toBe(true);
    });

    it('handles missing addButton closest card', async () => {
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = true;
      const { ctrl, opts } = createController({
        getElements: jest.fn(() => ({
          enableToggle: toggle,
          addButton: document.createElement('button'), // not in DOM, no card
        })),
      });
      opts.getIsEnabled.mockReturnValue(true);
      opts.endpoint.getFileIndexingDaemonStatus.mockResolvedValue({ running: true });

      await ctrl.updateEnabledState();
      expect(ctrl._isChangingState).toBe(false);
    });

    // --- ERROR PATH ---

    it('handles API exception with non-403 error', async () => {
      const { ctrl, opts, enableToggle } = createController();
      opts.getIsEnabled.mockReturnValue(true);
      opts.endpoint.startFileIndexingDaemon.mockRejectedValue(new Error('network'));

      await ctrl.updateEnabledState();

      expect(opts.showError).toHaveBeenCalledWith('Failed to start daemon: network');
      expect(enableToggle.checked).toBe(false); // reverted: !currentEnabled where currentEnabled=true
      expect(ctrl._isChangingState).toBe(false);
    });

    it('handles API exception with 403 error', async () => {
      const { ctrl, opts } = createController();
      opts.getIsEnabled.mockReturnValue(true);
      opts.endpoint.startFileIndexingDaemon.mockRejectedValue({ status: 403, message: 'forbidden' });

      await ctrl.updateEnabledState();

      expect(ctrl._daemonControlsLocked).toBe(true);
      // showError called by _handleDaemonControlError, not the generic fallback
      expect(opts.showError).toHaveBeenCalledWith(
        'File indexing daemon controls are blocked by backend security policy (HTTP 403).'
      );
    });

    it('error path handles missing enableToggle', async () => {
      const { ctrl, opts } = createController({
        getElements: jest.fn(() => ({ enableToggle: null, addButton: null })),
      });
      opts.getIsEnabled.mockReturnValue(true);
      opts.endpoint.startFileIndexingDaemon.mockRejectedValue(new Error('fail'));

      await ctrl.updateEnabledState();
      expect(ctrl._isChangingState).toBe(false);
    });
  });

  // =========================================================================
  // _awaitDaemonStatusTransition
  // =========================================================================

  describe('_awaitDaemonStatusTransition', () => {
    it('resolves when target status reached', async () => {
      const { ctrl, opts } = createController();
      opts.endpoint.getFileIndexingDaemonStatus.mockResolvedValue({ running: true });

      const promise = ctrl._awaitDaemonStatusTransition({
        targetRunning: true, timeoutMs: 5000, pollIntervalMs: 100,
      });

      // First poll returns target state immediately
      await promise;
      expect(opts.endpoint.getFileIndexingDaemonStatus).toHaveBeenCalledTimes(1);
    });

    it('polls until target reached', async () => {
      const { ctrl, opts } = createController();
      opts.endpoint.getFileIndexingDaemonStatus
        .mockResolvedValueOnce({ running: false })
        .mockResolvedValueOnce({ running: false })
        .mockResolvedValue({ running: true });

      const promise = ctrl._awaitDaemonStatusTransition({
        targetRunning: true, timeoutMs: 5000, pollIntervalMs: 100,
      });

      // Advance timers for each poll interval
      await jest.advanceTimersByTimeAsync(100);
      await jest.advanceTimersByTimeAsync(100);
      await promise;

      expect(opts.endpoint.getFileIndexingDaemonStatus).toHaveBeenCalledTimes(3);
    });

    it('ignores transient errors during polling', async () => {
      const { ctrl, opts } = createController();
      opts.endpoint.getFileIndexingDaemonStatus
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValue({ running: true });

      const promise = ctrl._awaitDaemonStatusTransition({
        targetRunning: true, timeoutMs: 5000, pollIntervalMs: 100,
      });

      await jest.advanceTimersByTimeAsync(100);
      await promise;

      expect(opts.endpoint.getFileIndexingDaemonStatus).toHaveBeenCalledTimes(2);
    });

    it('times out when status never changes', async () => {
      const { ctrl, opts } = createController();
      opts.endpoint.getFileIndexingDaemonStatus.mockResolvedValue({ running: false });

      // Use a very short timeout for testing
      const promise = ctrl._awaitDaemonStatusTransition({
        targetRunning: true, timeoutMs: 250, pollIntervalMs: 100,
      });

      // Advance past timeout
      await jest.advanceTimersByTimeAsync(100);
      await jest.advanceTimersByTimeAsync(100);
      await jest.advanceTimersByTimeAsync(100);
      await promise;

      // Should have polled multiple times then resolved (timeout, not throw)
      expect(opts.endpoint.getFileIndexingDaemonStatus.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // _restartDaemon
  // =========================================================================

  describe('_restartDaemon', () => {
    it('cancels when user declines confirm', async () => {
      const { ctrl, opts } = createController();
      ConfirmDialog.confirm.mockResolvedValueOnce(false);

      await ctrl._restartDaemon();

      expect(opts.endpoint.restartFileIndexingDaemon).not.toHaveBeenCalled();
    });

    it('restarts successfully and schedules status reload', async () => {
      const { ctrl, opts } = createController();

      // Create banner so restart button exists
      ctrl.getDaemonStatus = jest.fn(() => ({ running: true }));
      ctrl.renderDaemonBanner();

      await ctrl._restartDaemon();

      expect(opts.endpoint.restartFileIndexingDaemon).toHaveBeenCalledTimes(1);
      expect(opts.showSuccess).toHaveBeenCalledWith('Daemon restart requested successfully');
      expect(ctrl._restartTimerId).not.toBeNull();

      // Advance 3s timer
      opts.endpoint.getFileIndexingDaemonStatus.mockResolvedValue({ running: true });
      await jest.advanceTimersByTimeAsync(3000);

      expect(ctrl._restartTimerId).toBeNull();
      expect(opts.loadLocations).toHaveBeenCalledTimes(1);
    });

    it('restart failure shows error', async () => {
      const { ctrl, opts } = createController();
      opts.endpoint.restartFileIndexingDaemon.mockResolvedValue({ success: false, message: 'busy' });

      await ctrl._restartDaemon();

      expect(opts.showError).toHaveBeenCalledWith('busy');
    });

    it('restart failure uses default message', async () => {
      const { ctrl, opts } = createController();
      opts.endpoint.restartFileIndexingDaemon.mockResolvedValue({ success: false });

      await ctrl._restartDaemon();

      expect(opts.showError).toHaveBeenCalledWith('Restart failed');
    });

    it('restart API exception handled', async () => {
      const { ctrl, opts } = createController();
      opts.endpoint.restartFileIndexingDaemon.mockRejectedValue(new Error('net'));

      await ctrl._restartDaemon();

      expect(opts.showError).toHaveBeenCalledWith('Failed to restart daemon: net');
    });

    it('restart API 403 locks controls', async () => {
      const { ctrl, opts } = createController();
      opts.endpoint.restartFileIndexingDaemon.mockRejectedValue({ status: 403, message: 'forbidden' });

      await ctrl._restartDaemon();

      expect(ctrl._daemonControlsLocked).toBe(true);
    });

    it('restart button disabled during operation', async () => {
      const { ctrl } = createController();
      ctrl.getDaemonStatus = jest.fn(() => ({ running: true }));
      ctrl.renderDaemonBanner();

      const restartBtn = document.querySelector('#daemon-restart-btn');
      expect(restartBtn).not.toBeNull();

      // Start restart (will complete synchronously in test)
      await ctrl._restartDaemon();

      // After finally block, button re-enabled
      expect(restartBtn.disabled).toBe(false);
      expect(restartBtn.innerHTML).toContain('Restart');
    });

    it('restart timer callback guards against disposed state', async () => {
      const { ctrl, opts } = createController();

      await ctrl._restartDaemon();
      expect(ctrl._restartTimerId).not.toBeNull();

      // Dispose before timer fires
      ctrl.endpoint = null;
      await jest.advanceTimersByTimeAsync(3000);

      // loadDaemonStatus should not have been called (guarded by !this.endpoint)
      // Note: loadDaemonStatus would throw if called since endpoint is null
      expect(ctrl._restartTimerId).toBeNull();
    });

    it('restart timer callback handles error', async () => {
      const { ctrl, opts } = createController();

      await ctrl._restartDaemon();

      // loadDaemonStatus catches its own errors, so make loadLocations throw
      // to exercise the timer callback's catch block
      opts.loadLocations.mockRejectedValue(new Error('timer fail'));
      opts.endpoint.getFileIndexingDaemonStatus.mockResolvedValue({ running: true });
      await jest.advanceTimersByTimeAsync(3000);

      expect(mockLogger.error).toHaveBeenCalledWith(
        '[DaemonController] Post-restart status load failed:',
        expect.any(Error)
      );
    });

    it('handles missing restart button in DOM', async () => {
      const { ctrl, opts } = createController();
      // Don't render banner — no restart button in DOM
      await ctrl._restartDaemon();

      // Should not throw despite missing button
      expect(opts.endpoint.restartFileIndexingDaemon).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    it('sets _isDisposed flag', () => {
      const { ctrl } = createController();
      ctrl.dispose();
      expect(ctrl._isDisposed).toBe(true);
    });

    it('is idempotent', () => {
      const { ctrl } = createController();
      ctrl.dispose();
      ctrl.dispose();
      expect(ctrl._isDisposed).toBe(true);
    });

    it('clears restart timer', () => {
      const { ctrl } = createController();
      ctrl._restartTimerId = setTimeout(() => {}, 5000);
      ctrl.dispose();
      expect(ctrl._restartTimerId).toBeNull();
    });

    it('removes banner listeners', () => {
      const { ctrl } = createController();
      const btn = document.createElement('button');
      const handler = jest.fn();
      btn.addEventListener('click', handler);
      ctrl._daemonBannerListeners.push({ element: btn, event: 'click', handler });

      ctrl.dispose();

      btn.click();
      expect(handler).not.toHaveBeenCalled();
      expect(ctrl._daemonBannerListeners).toEqual([]);
    });

    it('handles already-removed element in listeners gracefully', () => {
      const { ctrl } = createController();
      ctrl._daemonBannerListeners.push({ element: null, event: 'click', handler: jest.fn() });
      ctrl.dispose();
      expect(ctrl._isDisposed).toBe(true);
      expect(ctrl._daemonBannerListeners).toEqual([]);
      expect(ctrl.endpoint).toBeNull();
    });

    it('nulls all closures', () => {
      const { ctrl } = createController();
      ctrl.dispose();
      expect(ctrl.endpoint).toBeNull();
      expect(ctrl.getElements).toBeNull();
      expect(ctrl.getIsEnabled).toBeNull();
      expect(ctrl.setIsEnabled).toBeNull();
      expect(ctrl.getDaemonStatus).toBeNull();
      expect(ctrl.setDaemonStatus).toBeNull();
      expect(ctrl.loadLocations).toBeNull();
      expect(ctrl.showSuccess).toBeNull();
      expect(ctrl.showError).toBeNull();
    });
  });

  // =========================================================================
  // Dispose-during-operation safety (bug fix verification)
  // =========================================================================
  // These tests verify that disposing the controller during an active async
  // operation does not cause TypeErrors from null closure access. Before the
  // fix, several of these would crash (catch block accessed getElements/
  // showError after dispose nulled them) and _isChangingState would be
  // permanently stuck at true, locking the toggle forever.

  describe('dispose-during-operation safety', () => {
    it('updateEnabledState: _isChangingState resets via finally even when dispose fires during async', async () => {
      const { ctrl, opts } = createController();
      opts.getIsEnabled.mockReturnValue(true);

      // Simulate: async API call triggers dispose (user navigated away) then fails
      opts.endpoint.startFileIndexingDaemon.mockImplementation(async () => {
        ctrl.dispose(); // closures nulled
        throw new Error('connection lost');
      });

      await ctrl.updateEnabledState();

      // Critical: _isChangingState MUST be false after the operation.
      // Before fix: catch block called this.getElements() → null → TypeError,
      // _isChangingState stayed true permanently. Toggle permanently locked.
      expect(ctrl._isChangingState).toBe(false);
      // Catch block should have returned early due to _isDisposed guard
      expect(opts.showError).not.toHaveBeenCalled();
    });

    it('_awaitDaemonStatusTransition: exits polling cleanly when disposed mid-poll', async () => {
      const { ctrl, opts } = createController();
      let pollCount = 0;

      opts.endpoint.getFileIndexingDaemonStatus.mockImplementation(async () => {
        pollCount++;
        if (pollCount === 2) ctrl.dispose();
        return { running: false }; // never reaches target
      });

      const promise = ctrl._awaitDaemonStatusTransition({
        targetRunning: true, timeoutMs: 60000, pollIntervalMs: 100,
      });

      await jest.advanceTimersByTimeAsync(100);
      await jest.advanceTimersByTimeAsync(100);
      await promise;

      // Before fix: would poll 600 times (60s timeout / 100ms interval),
      // each generating a TypeError from null endpoint access
      // After fix: exits cleanly after 2 polls
      expect(pollCount).toBe(2);
    });

    it('loadDaemonStatus: no-op after dispose (prevents null setDaemonStatus call)', async () => {
      const { ctrl, opts } = createController();
      ctrl.dispose();

      await ctrl.loadDaemonStatus();

      // Before fix: would call this.endpoint.getFileIndexingDaemonStatus() → null → TypeError
      expect(opts.endpoint.getFileIndexingDaemonStatus).not.toHaveBeenCalled();
    });

    it('loadDaemonStatus: bails cleanly when disposed during API call', async () => {
      const { ctrl, opts } = createController();

      opts.endpoint.getFileIndexingDaemonStatus.mockImplementation(async () => {
        ctrl.dispose(); // nulls setDaemonStatus, getDaemonStatus, getElements
        throw new Error('connection reset');
      });

      // Before fix: catch block called this.setDaemonStatus() → null → TypeError
      await ctrl.loadDaemonStatus();

      // setDaemonStatus NOT called in catch — dispose guard prevented it
      const callsAfterDispose = opts.setDaemonStatus.mock.calls;
      expect(callsAfterDispose.length).toBe(0);
    });

    it('renderDaemonBanner: no-op after dispose (prevents null getElements call)', () => {
      const { ctrl } = createController();
      ctrl.dispose();

      // Before fix: would call this.getElements() → null → TypeError
      ctrl.renderDaemonBanner();

      // No banner created (method returned early)
      expect(document.getElementById('file-indexing-daemon-banner')).toBeNull();
    });

    it('_handleDaemonControlError: returns false after dispose (prevents null getElements call)', () => {
      const { ctrl, opts } = createController();
      ctrl.dispose();

      // Before fix: would call this.getElements() → null → TypeError
      const result = ctrl._handleDaemonControlError({ status: 403 });

      expect(result).toBe(false);
      // showError NOT called — guard prevented access to null closure
      expect(opts.showError).not.toHaveBeenCalled();
    });

    it('_restartDaemon: no-op after dispose (prevents null endpoint call)', async () => {
      const { ctrl } = createController();
      ctrl.dispose();

      await ctrl._restartDaemon();

      // Before fix: would call ConfirmDialog.confirm → then this.endpoint.restartFileIndexingDaemon → null → TypeError
      expect(ConfirmDialog.confirm).not.toHaveBeenCalled();
    });
  });
});
