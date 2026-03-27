/**
 * @.architecture
 *
 * Incoming: Renderer bootstraps (main/chat/artifacts) call StartupSplash.run() early --- {method_call, void}
 * Processing: Create premium startup overlay with brand animation ("A I" -> "AetherInc"),
 *   then transition to initialization status phase that polls backend health.
 *   Splash stays visible (blocking interaction) until backend is confirmed healthy.
 *   Shows clean stage text: "Initializing..." -> "Starting services..." -> "Ready".
 *   Only fades out after backend responds to /v1/health.
 *   When configSnapshot.dev.skipHealthCheck is true (dev mode), the backend health
 *   gate is bypassed entirely -- brand animation plays then splash fades out immediately.
 * --- {5 jobs: JOB_CREATE_DOM, JOB_SCHEDULE_TASK, JOB_UPDATE_DOM_ELEMENT, JOB_HTTP_REQUEST, JOB_EMIT_EVENT}
 * Outgoing: DOM overlay (non-interactive during startup), Promise resolving when backend is healthy --- {dom.overlay | Promise<void>, HTMLElement | Promise}
 *
 * @module renderer/shared/components/StartupSplash
 */

'use strict';

const { createRendererLogger } = require('../utils/logger');

class StartupSplash {
  constructor(options = {}) {
    this.windowName = options.windowName || 'renderer';
    this.configSnapshot = options.configSnapshot || null;

    this._log = createRendererLogger('StartupSplash').child({ window: this.windowName });

    this._root = null;
    this._statusEl = null;
    this._progressBarEl = null;
    this._timers = [];
    this._isDisposed = false;
    this._healthPollStop = false;
  }

  attach() {
    if (typeof document === 'undefined' || !document.body) {
      throw new Error('[StartupSplash] DOM not ready');
    }
    if (this._root) {
      return;
    }

    const root = document.createElement('div');
    root.className = 'aether-startup-splash';
    root.setAttribute('role', 'presentation');
    root.setAttribute('aria-hidden', 'true');

    const inner = document.createElement('div');
    inner.className = 'aether-startup-splash__inner';

    const mark = document.createElement('div');
    mark.className = 'aether-startup-splash__mark';

    const wordmark = document.createElement('div');
    wordmark.className = 'aether-startup-splash__wordmark';

    const aetherLetter = document.createElement('span');
    aetherLetter.className = 'aether-startup-splash__letter aether-startup-splash__letter--a';
    aetherLetter.textContent = 'A';
    const aetherSuffix = document.createElement('span');
    aetherSuffix.className = 'aether-startup-splash__suffix aether-startup-splash__suffix--aether';
    aetherSuffix.textContent = 'ether';

    const incLetter = document.createElement('span');
    incLetter.className = 'aether-startup-splash__letter aether-startup-splash__letter--i';
    incLetter.textContent = 'I';
    const incSuffix = document.createElement('span');
    incSuffix.className = 'aether-startup-splash__suffix aether-startup-splash__suffix--inc';
    incSuffix.textContent = 'nc';

    wordmark.appendChild(aetherLetter);
    wordmark.appendChild(aetherSuffix);
    wordmark.appendChild(incLetter);
    wordmark.appendChild(incSuffix);
    mark.appendChild(wordmark);

    // Status text (shown after brand animation completes)
    const status = document.createElement('div');
    status.className = 'aether-startup-splash__status';
    status.textContent = '';

    // Subtle progress bar
    const progressWrap = document.createElement('div');
    progressWrap.className = 'aether-startup-splash__progress-wrap';
    const progressBar = document.createElement('div');
    progressBar.className = 'aether-startup-splash__progress-bar';
    progressWrap.appendChild(progressBar);

    inner.appendChild(mark);
    inner.appendChild(status);
    inner.appendChild(progressWrap);
    root.appendChild(inner);

    document.body.classList.add('is-startup-splash-active');
    document.body.appendChild(root);
    this._root = root;
    this._statusEl = status;
    this._progressBarEl = progressBar;
  }

  dispose() {
    this._isDisposed = true;
    this._healthPollStop = true;

    for (const t of this._timers) {
      try {
        clearTimeout(t);
      } catch (e) {
        // ignore
      }
    }
    this._timers = [];

    if (this._root?.parentNode) {
      this._root.parentNode.removeChild(this._root);
    }
    this._root = null;
    this._statusEl = null;
    this._progressBarEl = null;

    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.remove('is-startup-splash-active');
    }
  }

  _getCfg() {
    const fallback = {
      enabled: true,
      minDurationMs: 3200,
      separationDelayMs: 1200,
      expandDelayMs: 2000,
      fadeOutDurationMs: 400,
      holdAfterExpandMs: 500,
    };

    const cfg = this.configSnapshot?.ui?.startupAnimation || null;
    if (!cfg || typeof cfg !== 'object') {
      return fallback;
    }

    return {
      enabled: cfg.enabled !== false,
      minDurationMs: Number(cfg.minDurationMs) > 0 ? Number(cfg.minDurationMs) : fallback.minDurationMs,
      separationDelayMs: Number(cfg.separationDelayMs) >= 0 ? Number(cfg.separationDelayMs) : fallback.separationDelayMs,
      expandDelayMs: Number(cfg.expandDelayMs) >= 0 ? Number(cfg.expandDelayMs) : fallback.expandDelayMs,
      fadeOutDurationMs: Number(cfg.fadeOutDurationMs) > 0 ? Number(cfg.fadeOutDurationMs) : fallback.fadeOutDurationMs,
      holdAfterExpandMs: Number(cfg.holdAfterExpandMs) >= 0 ? Number(cfg.holdAfterExpandMs) : fallback.holdAfterExpandMs,
    };
  }

  _nextAnimationFrame() {
    if (typeof requestAnimationFrame !== 'function') {
      return new Promise((resolve) => {
        const t = setTimeout(resolve, 16);
        this._timers.push(t);
      });
    }
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  _yieldToPaint() {
    return (async () => {
      await this._nextAnimationFrame();
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 0);
        this._timers.push(t);
      });
    })();
  }

  _setStatus(text) {
    if (this._statusEl) {
      this._statusEl.textContent = text;
      if (!this._statusEl.classList.contains('is-visible')) {
        this._statusEl.classList.add('is-visible');
      }
    }
  }

  _setProgress(pct) {
    if (this._progressBarEl) {
      this._progressBarEl.style.width = `${Math.min(100, Math.max(0, pct))}%`;
      const wrap = this._progressBarEl.parentElement;
      if (wrap && !wrap.classList.contains('is-visible')) {
        wrap.classList.add('is-visible');
      }
    }
  }

  /**
   * Resolve the backend base URL via IPC (same as config-init.js).
   * Returns null if unavailable.
   */
  async _resolveBackendUrl() {
    try {
      const aether = typeof window !== 'undefined' ? window['aether'] : null;
      if (aether?.ipc?.invoke) {
        const url = await aether.ipc.invoke('backend:get-url');
        if (typeof url === 'string' && url.trim().length > 0) {
          return url.replace(/\/$/, '');
        }
      }
    } catch (e) {
      // ignore - backend URL not yet available
    }
    return null;
  }

  /**
   * Poll backend /v1/health until it responds 2xx.
   * Returns when healthy or when disposed/timed-out (300s).
   * Updates status text and progress bar during the wait.
   */
  async _waitForBackendHealth() {
    const POLL_INTERVAL_MS = 3000;
    const TIMEOUT_MS = 300000; // 5 minutes max
    const startTime = Date.now();

    this._setStatus('Starting services');
    this._setProgress(15);

    let attempts = 0;

    while (!this._isDisposed && !this._healthPollStop) {
      const elapsed = Date.now() - startTime;
      if (elapsed > TIMEOUT_MS) {
        this._setStatus('Services taking longer than expected');
        this._log.warn('Backend health poll timed out after 5 minutes');
        break;
      }

      attempts++;
      const baseUrl = await this._resolveBackendUrl();

      if (!baseUrl) {
        // Backend URL not yet resolved via IPC, wait and retry
        this._setStatus('Preparing environment');
        this._setProgress(Math.min(30, 15 + attempts));
        await this._sleep(POLL_INTERVAL_MS);
        continue;
      }

      // Update status based on elapsed time to give user a sense of progress
      if (elapsed < 15000) {
        this._setStatus('Starting services');
      } else if (elapsed < 45000) {
        this._setStatus('Loading backend');
      } else {
        this._setStatus('Almost ready');
      }

      // Smooth progress: ramp from 15% to 85% over ~90 seconds
      const progressPct = Math.min(85, 15 + (elapsed / 90000) * 70);
      this._setProgress(progressPct);

      try {
        const healthUrl = `${baseUrl}/v1/health`;
        const response = await fetch(healthUrl, {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(3000),
        });

        if (response && response.ok) {
          this._setStatus('Ready');
          this._setProgress(100);
          this._log.info('Backend healthy, splash completing', { elapsed, attempts });
          return true;
        }
      } catch (e) {
        // Backend not ready yet - this is expected during cold start. No error logging.
      }

      await this._sleep(POLL_INTERVAL_MS);
    }

    return false;
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this._timers.push(t);
    });
  }

  async run() {
    const cfg = this._getCfg();
    if (!cfg.enabled) {
      return;
    }

    this.attach();
    if (!this._root) return;

    const startAt = Date.now();

    // Ensure initial styles are actually painted before we start transitions/timers.
    await this._yieldToPaint();

    if (this._isDisposed) return;

    // ── Phase 1: Brand animation (A I -> AetherInc) ──
    const separationDelayMs = Math.max(0, Math.min(cfg.separationDelayMs, cfg.expandDelayMs));
    if (separationDelayMs < cfg.expandDelayMs) {
      const tSeparate = setTimeout(() => {
        if (this._isDisposed || !this._root) return;
        this._root.classList.add('is-separated');
      }, separationDelayMs);
      this._timers.push(tSeparate);
    }

    const tExpand = setTimeout(() => {
      if (this._isDisposed || !this._root) return;
      this._root.classList.remove('is-separated');
      this._root.classList.add('is-expanded');
    }, cfg.expandDelayMs);
    this._timers.push(tExpand);

    // Hold for minimum brand animation duration
    const waitMs = Math.max(0, cfg.minDurationMs - (Date.now() - startAt));
    await this._sleep(waitMs);

    if (this._isDisposed || !this._root) return;

    await this._sleep(cfg.holdAfterExpandMs);

    if (this._isDisposed || !this._root) return;

    // ── Phase 2: Backend health gate ──
    // Skip health polling entirely when dev.skipHealthCheck is set (dev mode without backend).
    // This allows the full frontend to load immediately for UI development.
    // Production never sets SKIP_HEALTH_CHECK, so this gate is always active in prod.
    const skipHealth = this.configSnapshot?.dev?.skipHealthCheck === true;

    let healthy = false;
    if (skipHealth) {
      this._log.info('Skipping backend health gate (dev.skipHealthCheck=true)');
      this._setStatus('Dev mode');
      this._setProgress(100);
      healthy = true;
    } else {
      // Keep the splash visible and show initialization status.
      // The brand animation stays on screen; status text fades in below.
      this._setStatus('Initializing');
      this._setProgress(10);

      healthy = await this._waitForBackendHealth();
      
      while (!healthy && !this._isDisposed) {
        await new Promise(resolve => this._showFatalError(resolve));
        if (this._isDisposed || !this._root) return;
        healthy = await this._waitForBackendHealth();
      }
    }

    if (this._isDisposed || !this._root) return;

    // Brief pause so "Ready" is visible
    if (healthy) {
      await this._sleep(skipHealth ? 200 : 600);
    }

    if (this._isDisposed || !this._root) return;

    // ── Phase 3: Fade out ──
    this._root.style.setProperty('--startup-fade-ms', `${cfg.fadeOutDurationMs}ms`);
    this._root.classList.add('is-fading');

    await this._sleep(cfg.fadeOutDurationMs);

    this.dispose();
  }

  _showFatalError(onRetry) {
    this._setStatus('Startup failed');
    this._setProgress(0);
    this._root.classList.add('is-fatal-error');

    const inner = this._root.querySelector('.aether-startup-splash__inner');
    if (!inner) return;

    let errorUi = inner.querySelector('.fatal-startup-error');
    if (!errorUi) {
      errorUi = document.createElement('div');
      errorUi.className = 'fatal-startup-error';
      
      const title = document.createElement('h3');
      title.textContent = 'Service Unreachable';
      
      const desc = document.createElement('p');
      desc.textContent = 'AetherArena background services failed to start or respond in time.';
      
      const actions = document.createElement('div');
      actions.className = 'fatal-startup-actions';
      
      const retryBtn = document.createElement('button');
      retryBtn.className = 'btn-primary btn-sm';
      retryBtn.innerHTML = 'Retry Services';
      retryBtn.onclick = () => {
        errorUi.remove();
        this._root.classList.remove('is-fatal-error');
        this._healthPollStop = false;
        if (onRetry) onRetry();
      };
      
      const quitBtn = document.createElement('button');
      quitBtn.className = 'btn-premium-link btn-sm';
      quitBtn.textContent = 'Quit Application';
      quitBtn.onclick = () => {
        try {
          const aether = typeof window !== 'undefined' ? window['aether'] : null;
          if (aether?.ipc?.send) {
            aether.ipc.send('app:quit');
          }
        } catch (e) {
          this._log.error('Failed to trigger app quit:', e);
        }
      };
      
      actions.appendChild(retryBtn);
      actions.appendChild(quitBtn);
      
      errorUi.appendChild(title);
      errorUi.appendChild(desc);
      errorUi.appendChild(actions);
      
      inner.appendChild(errorUi);
    }
  }
}

module.exports = { StartupSplash };

