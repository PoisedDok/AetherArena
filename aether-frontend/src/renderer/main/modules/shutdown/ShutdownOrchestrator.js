/**
 * @.architecture
 * Incoming: MainApp (user click on Quit/Restart), DOM shutdown-overlay element --- {method_call, dom_element}
 * Processing: Orchestrate graceful shutdown (close WS, signal backend, immediately exit) --- {3 jobs: JOB_HTTP_REQUEST, JOB_IPC_SEND, JOB_UPDATE_DOM}
 * Outgoing: DOM updates (shutdown dialog), IPC bridge (app:quit / app:relaunch) --- {dom_mutation, ipc_message}
 *
 * ShutdownOrchestrator — Graceful shutdown with real-time progress feedback
 * ==========================================================================
 * Coordinates the shutdown sequence:
 *   1. Close WebSocket connections
 *   2. Signal backend to shut down (POST /v1/system/shutdown)
 *   3. Instantly quit the app (background process handles full teardown)
 *
 * The user sees a premium, fast shutdown experience.
 */

'use strict';

const { createRendererLogger } = require('../../../shared/utils/logger');
const DEFAULTS = require('../../../../core/config/defaults');

class ShutdownOrchestrator {
  /**
   * @param {Object} deps
   * @param {Object} deps.endpoint - Endpoint instance for API calls
   * @param {Object} deps.guruConnection - GuruConnection for WebSocket teardown
   */
  constructor(deps = {}) {
    this.log = createRendererLogger('ShutdownOrchestrator');
    this.endpoint = deps.endpoint || null;
    this.guruConnection = deps.guruConnection || null;

    // DOM elements (lazily resolved)
    this._overlay = null;
    this._title = null;
    this._subtitle = null;
    this._icon = null;
    this._progressFill = null;
    this._elapsedEl = null;
    this._stepsContainer = null;

    // State
    this._isRunning = false;
    this._startTime = null;
    this._elapsedInterval = null;
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Execute graceful shutdown with progress dialog.
   * @param {'quit'|'restart'} mode
   */
  async execute(mode = 'quit') {
    if (this._isRunning) return;
    this._isRunning = true;

    this._resolveElements();
    this._show(mode);
    this._startTimer();

    const isRestart = mode === 'restart';
    const steps = ['websocket', 'backend', 'docker', 'cleanup'];

    try {
      // Step 1: Close WebSocket
      this._activateStep('websocket');
      await this._closeWebSocket();
      this._completeStep('websocket');
      this._setProgress(25);

      // Step 2: Signal backend shutdown
      this._activateStep('backend');
      await this._signalBackendShutdown();
      this._completeStep('backend');
      this._setProgress(50);

      // Step 3 & 4: Fast-forward docker and cleanup visually (background will handle them)
      this._activateStep('docker');
      this._completeStep('docker');
      this._setProgress(75);

      this._activateStep('cleanup');
      this._completeStep('cleanup');
      this._setProgress(100);

      // Transition to "exiting" state immediately, then send IPC
      this._showExitingState(isRestart);
      if (isRestart) {
        this._sendIPC('app:relaunch');
      } else {
        this._sendIPC('app:quit');
      }

    } catch (error) {
      this.log.error('[ShutdownOrchestrator] Error during shutdown:', error);
      // Even on error, still quit/relaunch — don't leave user stuck
      this._stopTimer();
      if (this._subtitle) {
        this._subtitle.textContent = `Warning: ${error.message || 'Partial shutdown'}. Proceeding...`;
      }
      await this._sleep(1500);

      this._showExitingState(isRestart);
      if (isRestart) {
        this._sendIPC('app:relaunch');
      } else {
        this._sendIPC('app:quit');
      }
    }
  }

  // ── Private: Shutdown Steps ─────────────────────────────────

  async _closeWebSocket() {
    try {
      if (this.guruConnection) {
        if (typeof this.guruConnection.disconnect === 'function') {
          this.guruConnection.disconnect();
        } else if (typeof this.guruConnection.close === 'function') {
          this.guruConnection.close();
        }
      }
      // Also attempt to close any global WS
      if (window.guruConnection && window.guruConnection !== this.guruConnection) {
        try { window.guruConnection.disconnect(); } catch (_) { /* ignore */ }
      }
      await this._sleep(300);
    } catch (e) {
      this.log.warn('[ShutdownOrchestrator] WebSocket close error (non-fatal):', e);
    }
  }

  _getBaseUrl() {
    // Prefer endpoint.getBackendURL() (central config), fall back to well-known default
    try {
      if (this.endpoint && typeof this.endpoint.getBackendURL === 'function') {
        return this.endpoint.getBackendURL();
      }
    } catch (_) { /* ignore */ }
    return DEFAULTS.backend.baseUrl;
  }

  async _signalBackendShutdown() {
    try {
      const baseUrl = this._getBaseUrl();
      const resp = await fetch(`${baseUrl}/v1/system/shutdown`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const data = await resp.json();
        this.log.debug('[ShutdownOrchestrator] Backend acknowledged shutdown:', data);
      }
    } catch (e) {
      // Backend might already be down or unreachable — that's fine
      this.log.warn('[ShutdownOrchestrator] Backend shutdown signal failed (may already be down):', e.message);
    }
    await this._sleep(500);
  }


  // ── Private: IPC ────────────────────────────────────────────

  _sendIPC(channel) {
    try {
      if (window.aether && window.aether.ipc && typeof window.aether.ipc.send === 'function') {
        window.aether.ipc.send(channel, {});
      } else {
        this.log.error('[ShutdownOrchestrator] IPC bridge not available, falling back to window.close');
        window.close();
      }
    } catch (e) {
      this.log.error('[ShutdownOrchestrator] IPC send failed:', e);
      window.close();
    }
  }

  // ── Private: DOM Updates ────────────────────────────────────

  _resolveElements() {
    this._overlay = document.getElementById('shutdown-overlay');
    this._title = document.getElementById('shutdown-title');
    this._subtitle = document.getElementById('shutdown-subtitle');
    this._icon = document.getElementById('shutdown-icon');
    this._progressFill = document.getElementById('shutdown-progress-fill');
    this._elapsedEl = document.getElementById('shutdown-elapsed');
    this._stepsContainer = document.getElementById('shutdown-steps');
  }

  _show(mode) {
    if (!this._overlay) return;

    const isRestart = mode === 'restart';

    // Update title/icon for mode
    if (this._title) {
      this._title.textContent = isRestart ? 'Restarting Aether' : 'Shutting Down';
    }
    if (this._subtitle) {
      this._subtitle.textContent = isRestart
        ? 'Restarting services — this will take a moment...'
        : 'Please wait while services are stopped safely...';
    }
    if (this._icon) {
      this._icon.classList.toggle('is-restart', isRestart);
      if (isRestart) {
        // Swap SVG to restart icon
        this._icon.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M1 4v6h6"></path>
          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
        </svg>`;
      }
    }
    if (this._progressFill) {
      this._progressFill.classList.toggle('is-restart', isRestart);
    }

    // Reset all steps
    if (this._stepsContainer) {
      const steps = this._stepsContainer.querySelectorAll('.shutdown-step');
      steps.forEach(s => {
        s.classList.remove('active', 'done', 'error');
        const statusEl = s.querySelector('.step-status');
        if (statusEl) statusEl.textContent = '';
      });
    }

    // Show overlay
    this._overlay.classList.remove('hidden');
  }

  _showComplete(isRestart) {
    // Stop the elapsed timer — all steps are done, a running counter contradicts "complete"
    this._stopTimer();

    if (this._icon) {
      this._icon.classList.remove('is-restart');
      this._icon.classList.add('is-complete');
      this._icon.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
        <polyline points="22 4 12 14.01 9 11.01"></polyline>
      </svg>`;
    }
    if (this._title) {
      this._title.textContent = isRestart ? 'Restarting...' : 'Shutdown Complete';
    }
    if (this._subtitle) {
      this._subtitle.textContent = isRestart ? 'Relaunching Aether now.' : 'All services stopped. Goodbye.';
    }
    if (this._progressFill) {
      this._progressFill.classList.add('is-complete');
    }

    // Show final elapsed time (frozen, not ticking)
    if (this._elapsedEl && this._startTime) {
      const totalSeconds = ((Date.now() - this._startTime) / 1000).toFixed(1);
      this._elapsedEl.textContent = `Completed in ${totalSeconds}s`;
    }
  }

  /**
   * Transition UI to "process exit" state after IPC has been sent.
   * Covers the delay between IPC send and actual Electron process termination.
   * @param {boolean} isRestart
   */
  _showExitingState(isRestart) {
    if (this._icon) {
      this._icon.classList.remove('is-complete');
      this._icon.classList.add('is-exiting');
      this._icon.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin-slow">
        <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
      </svg>`;
    }
    if (this._title) {
      this._title.textContent = isRestart ? 'Relaunching\u2026' : 'Closing\u2026';
    }
    if (this._subtitle) {
      this._subtitle.textContent = isRestart
        ? 'Waiting for process to restart \u2014 please wait'
        : 'Waiting for process to exit \u2014 please wait';
    }
    if (this._elapsedEl) {
      this._elapsedEl.textContent = '';
    }

    // Dim the completed steps — they're done, the focus is now on process exit
    if (this._stepsContainer) {
      this._stepsContainer.classList.add('is-dimmed');
    }
  }

  _activateStep(stepName) {
    if (!this._stepsContainer) return;
    const step = this._stepsContainer.querySelector(`[data-step="${stepName}"]`);
    if (step) {
      step.classList.add('active');
    }
  }

  _completeStep(stepName) {
    if (!this._stepsContainer) return;
    const step = this._stepsContainer.querySelector(`[data-step="${stepName}"]`);
    if (step) {
      step.classList.remove('active');
      step.classList.add('done');
      const statusEl = step.querySelector('.step-status');
      if (statusEl && !statusEl.textContent) statusEl.textContent = 'done';
    }
  }

  _setStepStatus(stepName, text) {
    if (!this._stepsContainer) return;
    const step = this._stepsContainer.querySelector(`[data-step="${stepName}"]`);
    if (step) {
      const statusEl = step.querySelector('.step-status');
      if (statusEl) statusEl.textContent = text;
    }
  }

  _setProgress(percent) {
    if (this._progressFill) {
      this._progressFill.style.width = `${percent}%`;
    }
  }

  _startTimer() {
    this._startTime = Date.now();
    this._elapsedInterval = setInterval(() => {
      if (this._elapsedEl) {
        const elapsed = ((Date.now() - this._startTime) / 1000).toFixed(1);
        this._elapsedEl.textContent = `${elapsed}s elapsed`;
      }
    }, 100);
  }

  _stopTimer() {
    if (this._elapsedInterval) {
      clearInterval(this._elapsedInterval);
      this._elapsedInterval = null;
    }
  }

  // ── Utility ─────────────────────────────────────────────────

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    this.log.info('disposing');
    
    // Clean up timers
    this._stopTimer();
    
    // Clear references
    this.endpoint = null;
    this.guruConnection = null;
    
    // Clear DOM references
    this._overlay = null;
    this._title = null;
    this._subtitle = null;
    this._icon = null;
    this._progressFill = null;
    this._elapsedEl = null;
    this._stepsContainer = null;
    
    this._isRunning = false;
  }
}

module.exports = ShutdownOrchestrator;
