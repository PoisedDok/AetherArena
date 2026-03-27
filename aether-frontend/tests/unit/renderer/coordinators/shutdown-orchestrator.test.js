'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = {
  info: () => {},
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: () => {},
};
mockLog.child = () => mockLog;

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

// Real DEFAULTS — frozen constants, safe to use directly
const DEFAULTS = require('../../../../src/core/config/defaults');

const ShutdownOrchestrator = require(
  '../../../../src/renderer/main/modules/shutdown/ShutdownOrchestrator'
);

// ---------------------------------------------------------------------------
// DOM setup helper
// ---------------------------------------------------------------------------

function setupShutdownDOM() {
  document.body.innerHTML = `
    <div id="shutdown-overlay" class="hidden">
      <div id="shutdown-icon"></div>
      <div id="shutdown-title"></div>
      <div id="shutdown-subtitle"></div>
      <div id="shutdown-progress-fill"></div>
      <div id="shutdown-elapsed"></div>
      <div id="shutdown-steps">
        <div class="shutdown-step" data-step="websocket">
          <span class="step-status"></span>
        </div>
        <div class="shutdown-step" data-step="backend">
          <span class="step-status"></span>
        </div>
        <div class="shutdown-step" data-step="docker">
          <span class="step-status"></span>
        </div>
        <div class="shutdown-step" data-step="cleanup">
          <span class="step-status"></span>
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createEndpoint(url = 'http://test-backend:9999') {
  return {
    getBackendURL: jest.fn(() => url),
  };
}

function createGuruConnection() {
  return {
    disconnect: jest.fn(),
    close: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ShutdownOrchestrator', () => {
  let orchestrator;
  let endpoint;
  let guruConnection;
  let originalFetch;
  let originalAether;
  let originalGuruConnection;
  let originalEndpoint;
  let originalClose;

  beforeEach(() => {
    jest.useFakeTimers();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    mockLog.debug.mockClear();

    endpoint = createEndpoint();
    guruConnection = createGuruConnection();
    orchestrator = new ShutdownOrchestrator({ endpoint, guruConnection });

    // Save and mock window globals
    originalFetch = global.fetch;
    originalAether = window.aether;
    originalGuruConnection = window.guruConnection;
    originalEndpoint = window.endpoint;
    originalClose = window.close;

    global.fetch = jest.fn();
    window.aether = { ipc: { send: jest.fn() } };
    window.guruConnection = null;
    window.endpoint = null;
    window.close = jest.fn();

    // AbortSignal.timeout may not exist in jsdom — provide a polyfill
    if (!AbortSignal.timeout) {
      AbortSignal.timeout = (ms) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), ms);
        return controller.signal;
      };
    }

    setupShutdownDOM();
  });

  afterEach(() => {
    if (orchestrator._elapsedInterval) {
      clearInterval(orchestrator._elapsedInterval);
    }
    global.fetch = originalFetch;
    window.aether = originalAether;
    window.guruConnection = originalGuruConnection;
    window.endpoint = originalEndpoint;
    window.close = originalClose;
    document.body.innerHTML = '';
    jest.useRealTimers();
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('stores endpoint reference', () => {
      expect(orchestrator.endpoint).toBe(endpoint);
    });

    it('stores guruConnection reference', () => {
      expect(orchestrator.guruConnection).toBe(guruConnection);
    });

    it('defaults endpoint to null', () => {
      const o = new ShutdownOrchestrator();
      expect(o.endpoint).toBeNull();
    });

    it('defaults guruConnection to null', () => {
      const o = new ShutdownOrchestrator();
      expect(o.guruConnection).toBeNull();
    });

    it('initializes _isRunning to false', () => {
      expect(orchestrator._isRunning).toBe(false);
    });

    it('initializes DOM element refs to null', () => {
      expect(orchestrator._overlay).toBeNull();
      expect(orchestrator._title).toBeNull();
      expect(orchestrator._subtitle).toBeNull();
      expect(orchestrator._icon).toBeNull();
      expect(orchestrator._progressFill).toBeNull();
      expect(orchestrator._elapsedEl).toBeNull();
      expect(orchestrator._stepsContainer).toBeNull();
    });

    it('initializes timer state to null', () => {
      expect(orchestrator._startTime).toBeNull();
      expect(orchestrator._elapsedInterval).toBeNull();
    });
  });

  // =========================================================================
  // _resolveElements
  // =========================================================================

  describe('_resolveElements', () => {
    it('resolves all DOM elements by ID', () => {
      orchestrator._resolveElements();
      expect(orchestrator._overlay).toBe(document.getElementById('shutdown-overlay'));
      expect(orchestrator._title).toBe(document.getElementById('shutdown-title'));
      expect(orchestrator._subtitle).toBe(document.getElementById('shutdown-subtitle'));
      expect(orchestrator._icon).toBe(document.getElementById('shutdown-icon'));
      expect(orchestrator._progressFill).toBe(document.getElementById('shutdown-progress-fill'));
      expect(orchestrator._elapsedEl).toBe(document.getElementById('shutdown-elapsed'));
      expect(orchestrator._stepsContainer).toBe(document.getElementById('shutdown-steps'));
    });

    it('handles missing DOM elements gracefully', () => {
      document.body.innerHTML = '';
      orchestrator._resolveElements();
      expect(orchestrator._overlay).toBeNull();
    });
  });

  // =========================================================================
  // _show
  // =========================================================================

  describe('_show', () => {
    beforeEach(() => {
      orchestrator._resolveElements();
    });

    it('removes hidden class from overlay', () => {
      orchestrator._show('quit');
      expect(orchestrator._overlay.classList.contains('hidden')).toBe(false);
    });

    it('sets quit title text', () => {
      orchestrator._show('quit');
      expect(orchestrator._title.textContent).toBe('Shutting Down');
    });

    it('sets restart title text', () => {
      orchestrator._show('restart');
      expect(orchestrator._title.textContent).toBe('Restarting Aether');
    });

    it('sets quit subtitle text', () => {
      orchestrator._show('quit');
      expect(orchestrator._subtitle.textContent).toBe('Please wait while services are stopped safely...');
    });

    it('sets restart subtitle text', () => {
      orchestrator._show('restart');
      expect(orchestrator._subtitle.textContent).toBe('Restarting services — this will take a moment...');
    });

    it('toggles is-restart class on icon for restart mode', () => {
      orchestrator._show('restart');
      expect(orchestrator._icon.classList.contains('is-restart')).toBe(true);
    });

    it('sets restart SVG on icon for restart mode', () => {
      orchestrator._show('restart');
      expect(orchestrator._icon.innerHTML).toContain('svg');
    });

    it('does not set restart class on icon for quit mode', () => {
      orchestrator._show('quit');
      expect(orchestrator._icon.classList.contains('is-restart')).toBe(false);
    });

    it('toggles is-restart class on progress fill', () => {
      orchestrator._show('restart');
      expect(orchestrator._progressFill.classList.contains('is-restart')).toBe(true);
    });

    it('resets all step classes', () => {
      const steps = orchestrator._stepsContainer.querySelectorAll('.shutdown-step');
      steps[0].classList.add('active', 'done', 'error');
      orchestrator._show('quit');
      expect(steps[0].classList.contains('active')).toBe(false);
      expect(steps[0].classList.contains('done')).toBe(false);
      expect(steps[0].classList.contains('error')).toBe(false);
    });

    it('clears step status text', () => {
      const statusEl = orchestrator._stepsContainer.querySelector('.step-status');
      statusEl.textContent = 'previous';
      orchestrator._show('quit');
      expect(statusEl.textContent).toBe('');
    });

    it('returns early when overlay is null', () => {
      orchestrator._overlay = null;
      expect(() => orchestrator._show('quit')).not.toThrow();
    });

    it('handles null title/subtitle/icon/progressFill/stepsContainer', () => {
      orchestrator._title = null;
      orchestrator._subtitle = null;
      orchestrator._icon = null;
      orchestrator._progressFill = null;
      orchestrator._stepsContainer = null;
      expect(() => orchestrator._show('quit')).not.toThrow();
    });
  });

  // =========================================================================
  // _showComplete
  // =========================================================================

  describe('_showComplete', () => {
    beforeEach(() => {
      orchestrator._resolveElements();
    });

    it('sets complete SVG on icon', () => {
      orchestrator._showComplete(false);
      expect(orchestrator._icon.innerHTML).toContain('polyline');
    });

    it('adds is-complete class on icon', () => {
      orchestrator._showComplete(false);
      expect(orchestrator._icon.classList.contains('is-complete')).toBe(true);
    });

    it('removes is-restart class on icon', () => {
      orchestrator._icon.classList.add('is-restart');
      orchestrator._showComplete(false);
      expect(orchestrator._icon.classList.contains('is-restart')).toBe(false);
    });

    it('sets quit complete title', () => {
      orchestrator._showComplete(false);
      expect(orchestrator._title.textContent).toBe('Shutdown Complete');
    });

    it('sets restart complete title', () => {
      orchestrator._showComplete(true);
      expect(orchestrator._title.textContent).toBe('Restarting...');
    });

    it('sets quit complete subtitle', () => {
      orchestrator._showComplete(false);
      expect(orchestrator._subtitle.textContent).toBe('All services stopped. Goodbye.');
    });

    it('sets restart complete subtitle', () => {
      orchestrator._showComplete(true);
      expect(orchestrator._subtitle.textContent).toBe('Relaunching Aether now.');
    });

    it('adds is-complete class on progress fill', () => {
      orchestrator._showComplete(false);
      expect(orchestrator._progressFill.classList.contains('is-complete')).toBe(true);
    });

    it('handles null elements', () => {
      orchestrator._icon = null;
      orchestrator._title = null;
      orchestrator._subtitle = null;
      orchestrator._progressFill = null;
      orchestrator._elapsedEl = null;
      expect(() => orchestrator._showComplete(false)).not.toThrow();
    });

    it('stops the elapsed timer', () => {
      orchestrator._startTimer();
      expect(orchestrator._elapsedInterval).not.toBeNull();

      orchestrator._showComplete(false);

      expect(orchestrator._elapsedInterval).toBeNull();
    });

    it('shows frozen "Completed in Xs" instead of ticking timer', () => {
      orchestrator._startTime = Date.now() - 3500; // simulate 3.5s elapsed
      orchestrator._showComplete(false);

      const el = document.getElementById('shutdown-elapsed');
      expect(el.textContent).toMatch(/^Completed in \d+\.\ds$/);
      expect(el.textContent).not.toContain('elapsed');
    });
  });

  // =========================================================================
  // _showExitingState
  // =========================================================================

  describe('_showExitingState', () => {
    beforeEach(() => {
      orchestrator._resolveElements();
    });

    it('sets quit exiting title', () => {
      orchestrator._showExitingState(false);
      expect(orchestrator._title.textContent).toBe('Closing\u2026');
    });

    it('sets restart exiting title', () => {
      orchestrator._showExitingState(true);
      expect(orchestrator._title.textContent).toBe('Relaunching\u2026');
    });

    it('sets quit exiting subtitle', () => {
      orchestrator._showExitingState(false);
      expect(orchestrator._subtitle.textContent).toContain('process to exit');
    });

    it('sets restart exiting subtitle', () => {
      orchestrator._showExitingState(true);
      expect(orchestrator._subtitle.textContent).toContain('process to restart');
    });

    it('adds is-exiting class and removes is-complete from icon', () => {
      orchestrator._icon.classList.add('is-complete');
      orchestrator._showExitingState(false);
      expect(orchestrator._icon.classList.contains('is-exiting')).toBe(true);
      expect(orchestrator._icon.classList.contains('is-complete')).toBe(false);
    });

    it('sets spinning SVG on icon', () => {
      orchestrator._showExitingState(false);
      expect(orchestrator._icon.innerHTML).toContain('spin-slow');
    });

    it('clears elapsed text', () => {
      orchestrator._elapsedEl.textContent = 'Completed in 3.5s';
      orchestrator._showExitingState(false);
      expect(orchestrator._elapsedEl.textContent).toBe('');
    });

    it('dims the steps container', () => {
      orchestrator._showExitingState(false);
      expect(orchestrator._stepsContainer.classList.contains('is-dimmed')).toBe(true);
    });

    it('handles null elements', () => {
      orchestrator._icon = null;
      orchestrator._title = null;
      orchestrator._subtitle = null;
      orchestrator._elapsedEl = null;
      orchestrator._stepsContainer = null;
      expect(() => orchestrator._showExitingState(false)).not.toThrow();
    });
  });

  // =========================================================================
  // _stopTimer
  // =========================================================================

  describe('_stopTimer', () => {
    it('clears the interval and nulls the reference', () => {
      orchestrator._startTimer();
      expect(orchestrator._elapsedInterval).not.toBeNull();

      orchestrator._stopTimer();

      expect(orchestrator._elapsedInterval).toBeNull();
    });

    it('is safe to call when no timer is running', () => {
      expect(() => orchestrator._stopTimer()).not.toThrow();
      expect(orchestrator._elapsedInterval).toBeNull();
    });
  });

  // =========================================================================
  // _activateStep / _completeStep / _setStepStatus
  // =========================================================================

  describe('step methods', () => {
    beforeEach(() => {
      orchestrator._resolveElements();
    });

    it('_activateStep adds active class', () => {
      orchestrator._activateStep('websocket');
      const step = document.querySelector('[data-step="websocket"]');
      expect(step.classList.contains('active')).toBe(true);
    });

    it('_activateStep handles unknown step gracefully', () => {
      expect(() => orchestrator._activateStep('unknown')).not.toThrow();
    });

    it('_activateStep returns early when stepsContainer is null', () => {
      orchestrator._stepsContainer = null;
      expect(() => orchestrator._activateStep('websocket')).not.toThrow();
    });

    it('_completeStep removes active and adds done', () => {
      const step = document.querySelector('[data-step="backend"]');
      step.classList.add('active');
      orchestrator._completeStep('backend');
      expect(step.classList.contains('active')).toBe(false);
      expect(step.classList.contains('done')).toBe(true);
    });

    it('_completeStep sets status text to "done" when empty', () => {
      orchestrator._completeStep('backend');
      const statusEl = document.querySelector('[data-step="backend"] .step-status');
      expect(statusEl.textContent).toBe('done');
    });

    it('_completeStep does not overwrite existing status text', () => {
      const statusEl = document.querySelector('[data-step="backend"] .step-status');
      statusEl.textContent = '5s';
      orchestrator._completeStep('backend');
      expect(statusEl.textContent).toBe('5s');
    });

    it('_completeStep returns early when stepsContainer is null', () => {
      orchestrator._stepsContainer = null;
      expect(() => orchestrator._completeStep('backend')).not.toThrow();
    });

    it('_completeStep handles unknown step gracefully', () => {
      expect(() => orchestrator._completeStep('unknown')).not.toThrow();
    });

    it('_setStepStatus sets status text', () => {
      orchestrator._setStepStatus('docker', '3s');
      const statusEl = document.querySelector('[data-step="docker"] .step-status');
      expect(statusEl.textContent).toBe('3s');
    });

    it('_setStepStatus returns early when stepsContainer is null', () => {
      orchestrator._stepsContainer = null;
      expect(() => orchestrator._setStepStatus('docker', '3s')).not.toThrow();
    });

    it('_setStepStatus handles unknown step', () => {
      expect(() => orchestrator._setStepStatus('unknown', 'x')).not.toThrow();
    });

    it('_completeStep handles step with no .step-status child', () => {
      // Remove the .step-status child from a step
      const step = document.querySelector('[data-step="websocket"]');
      const statusEl = step.querySelector('.step-status');
      statusEl.remove();
      expect(() => orchestrator._completeStep('websocket')).not.toThrow();
      expect(step.classList.contains('done')).toBe(true);
    });

    it('_setStepStatus handles step with no .step-status child', () => {
      const step = document.querySelector('[data-step="docker"]');
      const statusEl = step.querySelector('.step-status');
      statusEl.remove();
      expect(() => orchestrator._setStepStatus('docker', '3s')).not.toThrow();
    });
  });

  // =========================================================================
  // _setProgress
  // =========================================================================

  describe('_setProgress', () => {
    beforeEach(() => {
      orchestrator._resolveElements();
    });

    it('sets width style on progress fill', () => {
      orchestrator._setProgress(50);
      expect(orchestrator._progressFill.style.width).toBe('50%');
    });

    it('handles 0%', () => {
      orchestrator._setProgress(0);
      expect(orchestrator._progressFill.style.width).toBe('0%');
    });

    it('handles 100%', () => {
      orchestrator._setProgress(100);
      expect(orchestrator._progressFill.style.width).toBe('100%');
    });

    it('does nothing when progressFill is null', () => {
      orchestrator._progressFill = null;
      expect(() => orchestrator._setProgress(50)).not.toThrow();
    });
  });

  // =========================================================================
  // _startTimer
  // =========================================================================

  describe('_startTimer', () => {
    it('sets _startTime', () => {
      orchestrator._resolveElements();
      orchestrator._startTimer();
      expect(orchestrator._startTime).toBeTruthy();
    });

    it('sets _elapsedInterval', () => {
      orchestrator._resolveElements();
      orchestrator._startTimer();
      expect(orchestrator._elapsedInterval).not.toBeNull();
    });

    it('updates elapsed text on interval tick', () => {
      orchestrator._resolveElements();
      orchestrator._startTimer();
      jest.advanceTimersByTime(200);
      const el = document.getElementById('shutdown-elapsed');
      expect(el.textContent).toMatch(/\d+\.\ds elapsed/);
    });

    it('handles null _elapsedEl gracefully on tick', () => {
      orchestrator._startTimer();
      // _elapsedEl is null because _resolveElements wasn't called
      expect(() => jest.advanceTimersByTime(200)).not.toThrow();
    });
  });

  // =========================================================================
  // _sleep
  // =========================================================================

  describe('_sleep', () => {
    it('resolves after specified ms', async () => {
      const promise = orchestrator._sleep(500);
      jest.advanceTimersByTime(500);
      await expect(promise).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // _getBaseUrl
  // =========================================================================

  describe('_getBaseUrl', () => {
    it('returns endpoint.getBackendURL() when available', () => {
      expect(orchestrator._getBaseUrl()).toBe('http://test-backend:9999');
    });

    it('falls back to DEFAULTS when endpoint is null', () => {
      orchestrator.endpoint = null;
      expect(orchestrator._getBaseUrl()).toBe(DEFAULTS.backend.baseUrl);
    });

    it('falls back to DEFAULTS when endpoint.getBackendURL throws', () => {
      orchestrator.endpoint = { getBackendURL: () => { throw new Error('broken'); } };
      expect(orchestrator._getBaseUrl()).toBe(DEFAULTS.backend.baseUrl);
    });

    it('falls back to DEFAULTS when endpoint lacks getBackendURL method', () => {
      orchestrator.endpoint = {};
      expect(orchestrator._getBaseUrl()).toBe(DEFAULTS.backend.baseUrl);
    });
  });

  // =========================================================================
  // _closeWebSocket
  // =========================================================================

  describe('_closeWebSocket', () => {
    beforeEach(() => {
      jest.spyOn(orchestrator, '_sleep').mockResolvedValue();
    });

    it('calls guruConnection.disconnect()', async () => {
      await orchestrator._closeWebSocket();
      expect(guruConnection.disconnect).toHaveBeenCalled();
    });

    it('falls back to guruConnection.close() when disconnect is not a function', async () => {
      orchestrator.guruConnection = { close: jest.fn() };
      await orchestrator._closeWebSocket();
      expect(orchestrator.guruConnection.close).toHaveBeenCalled();
    });

    it('handles null guruConnection', async () => {
      orchestrator.guruConnection = null;
      await expect(orchestrator._closeWebSocket()).resolves.not.toThrow();
    });

    it('also disconnects window.guruConnection if different instance', async () => {
      const windowGuru = { disconnect: jest.fn() };
      window.guruConnection = windowGuru;
      await orchestrator._closeWebSocket();
      expect(windowGuru.disconnect).toHaveBeenCalled();
    });

    it('does not disconnect window.guruConnection if same instance', async () => {
      window.guruConnection = guruConnection;
      await orchestrator._closeWebSocket();
      // disconnect called once (from orchestrator), not twice
      expect(guruConnection.disconnect).toHaveBeenCalledTimes(1);
    });

    it('catches disconnect error and logs warning', async () => {
      orchestrator.guruConnection = { disconnect: () => { throw new Error('WS error'); } };
      await orchestrator._closeWebSocket();
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('WebSocket close error'),
        expect.any(Error)
      );
    });

    it('handles guruConnection with neither disconnect nor close', async () => {
      orchestrator.guruConnection = {};
      await expect(orchestrator._closeWebSocket()).resolves.not.toThrow();
    });

    it('catches window.guruConnection.disconnect error gracefully', async () => {
      window.guruConnection = { disconnect: () => { throw new Error('win ws error'); } };
      await expect(orchestrator._closeWebSocket()).resolves.not.toThrow();
    });
  });

  // =========================================================================
  // _signalBackendShutdown
  // =========================================================================

  describe('_signalBackendShutdown', () => {
    beforeEach(() => {
      jest.spyOn(orchestrator, '_sleep').mockResolvedValue();
    });

    it('sends POST to /v1/system/shutdown', async () => {
      global.fetch.mockResolvedValue({ ok: true, json: async () => ({ status: 'shutting_down' }) });
      await orchestrator._signalBackendShutdown();
      expect(global.fetch).toHaveBeenCalledWith(
        'http://test-backend:9999/v1/system/shutdown',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('logs debug on successful response', async () => {
      global.fetch.mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) });
      await orchestrator._signalBackendShutdown();
      expect(mockLog.debug).toHaveBeenCalledWith(
        expect.stringContaining('Backend acknowledged shutdown'),
        expect.any(Object)
      );
    });

    it('handles non-ok response without error', async () => {
      global.fetch.mockResolvedValue({ ok: false });
      await expect(orchestrator._signalBackendShutdown()).resolves.not.toThrow();
    });

    it('catches fetch error and logs warning', async () => {
      global.fetch.mockRejectedValue(new Error('Network down'));
      await orchestrator._signalBackendShutdown();
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('Backend shutdown signal failed'),
        expect.any(String)
      );
    });
  });

  // =========================================================================
  // _sendIPC
  // =========================================================================

  describe('_sendIPC', () => {
    it('sends via window.aether.ipc.send', () => {
      orchestrator._sendIPC('app:quit');
      expect(window.aether.ipc.send).toHaveBeenCalledWith('app:quit', {});
    });

    it('falls back to window.close when IPC not available', () => {
      window.aether = null;
      orchestrator._sendIPC('app:quit');
      expect(window.close).toHaveBeenCalled();
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('IPC bridge not available')
      );
    });

    it('falls back to window.close when ipc.send throws', () => {
      window.aether.ipc.send = () => { throw new Error('IPC broken'); };
      orchestrator._sendIPC('app:quit');
      expect(window.close).toHaveBeenCalled();
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('IPC send failed'),
        expect.any(Error)
      );
    });

    it('falls back when window.aether.ipc is missing', () => {
      window.aether = {};
      orchestrator._sendIPC('app:quit');
      expect(window.close).toHaveBeenCalled();
    });

    it('falls back when window.aether.ipc.send is not a function', () => {
      window.aether = { ipc: { send: 'not-a-function' } };
      orchestrator._sendIPC('app:quit');
      expect(window.close).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // execute — full integration
  // =========================================================================

  describe('execute', () => {
    beforeEach(() => {
      jest.spyOn(orchestrator, '_sleep').mockResolvedValue();
      global.fetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ok' }) }) // shutdown signal
        .mockRejectedValueOnce(new Error('dead')); // health check = backend dead
    });

    it('runs full quit flow and sends app:quit IPC', async () => {
      await orchestrator.execute('quit');
      expect(window.aether.ipc.send).toHaveBeenCalledWith('app:quit', {});
    });

    it('runs full restart flow and sends app:relaunch IPC', async () => {
      await orchestrator.execute('restart');
      expect(window.aether.ipc.send).toHaveBeenCalledWith('app:relaunch', {});
    });

    it('sets _isRunning to true', async () => {
      const promise = orchestrator.execute('quit');
      expect(orchestrator._isRunning).toBe(true);
      await promise;
    });

    it('is idempotent — second call returns immediately', async () => {
      orchestrator._isRunning = true;
      await orchestrator.execute('quit');
      // No IPC sent because execute returned early
      expect(window.aether.ipc.send).not.toHaveBeenCalled();
    });

    it('defaults mode to quit', async () => {
      await orchestrator.execute();
      expect(window.aether.ipc.send).toHaveBeenCalledWith('app:quit', {});
    });

    it('calls guruConnection.disconnect during websocket step', async () => {
      await orchestrator.execute('quit');
      expect(guruConnection.disconnect).toHaveBeenCalled();
    });

    it('removes hidden class from overlay', async () => {
      await orchestrator.execute('quit');
      const overlay = document.getElementById('shutdown-overlay');
      expect(overlay.classList.contains('hidden')).toBe(false);
    });

    it('marks all 4 steps as done', async () => {
      await orchestrator.execute('quit');
      const steps = document.querySelectorAll('.shutdown-step.done');
      expect(steps.length).toBe(4);
    });

    it('sets progress to 100%', async () => {
      await orchestrator.execute('quit');
      const fill = document.getElementById('shutdown-progress-fill');
      expect(fill.style.width).toBe('100%');
    });

    it('handles error in shutdown flow and still sends IPC quit', async () => {
      orchestrator._resolveElements();
      jest.spyOn(orchestrator, '_closeWebSocket').mockRejectedValue(new Error('WS boom'));
      await orchestrator.execute('quit');
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('Error during shutdown'),
        expect.any(Error)
      );
      expect(window.aether.ipc.send).toHaveBeenCalledWith('app:quit', {});
    });

    it('handles error in shutdown flow and still sends IPC relaunch', async () => {
      orchestrator._resolveElements();
      jest.spyOn(orchestrator, '_closeWebSocket').mockRejectedValue(new Error('WS boom'));
      await orchestrator.execute('restart');
      expect(window.aether.ipc.send).toHaveBeenCalledWith('app:relaunch', {});
    });

    it('transitions to exiting state on error path', async () => {
      orchestrator._resolveElements();
      jest.spyOn(orchestrator, '_closeWebSocket').mockRejectedValue(new Error('Test error'));
      await orchestrator.execute('quit');
      // After error warning, transitions to exiting state
      const title = document.getElementById('shutdown-title');
      expect(title.textContent).toBe('Closing\u2026');
    });

    it('transitions to exiting state on error path for restart', async () => {
      orchestrator._resolveElements();
      jest.spyOn(orchestrator, '_closeWebSocket').mockRejectedValue(new Error('Test error'));
      await orchestrator.execute('restart');
      const title = document.getElementById('shutdown-title');
      expect(title.textContent).toBe('Relaunching\u2026');
    });

    it('stops timer on error path', async () => {
      orchestrator._resolveElements();
      jest.spyOn(orchestrator, '_closeWebSocket').mockRejectedValue(new Error('Test error'));
      await orchestrator.execute('quit');
      expect(orchestrator._elapsedInterval).toBeNull();
    });
  });

  // =========================================================================
  // Module exports
  // =========================================================================

  describe('module exports', () => {
    it('exports ShutdownOrchestrator constructor', () => {
      expect(typeof ShutdownOrchestrator).toBe('function');
    });

    it('instances have execute method', () => {
      expect(typeof orchestrator.execute).toBe('function');
    });
  });
});
