'use strict';

/**
 * Tests for StartupSplash — premium startup overlay with brand animation + backend health gate.
 *
 * Source: src/renderer/shared/components/StartupSplash.js
 * Architecture: Presentation layer. DOM overlay + async health polling.
 * Dependencies: createRendererLogger (mocked).
 */

// ---------------------------------------------------------------------------
// Mocks — must be before require
// ---------------------------------------------------------------------------

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    child: jest.fn(function () { return this; }),
  })),
}));

const { StartupSplash } = require('../../../src/renderer/shared/components/StartupSplash');

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('StartupSplash', () => {
  let splash;
  const savedRAF = global.requestAnimationFrame;

  beforeEach(() => {
    jest.useFakeTimers();
    document.body.innerHTML = '';
    document.body.className = '';

    // Override rAF so it's controlled by fake timers (jsdom's rAF is NOT)
    global.requestAnimationFrame = window.requestAnimationFrame = (cb) => setTimeout(cb, 0);

    // Re-establish mock implementations (resetMocks clears them)
    const { createRendererLogger } = require('../../../src/renderer/shared/utils/logger');
    createRendererLogger.mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
      child: jest.fn(function () { return this; }),
    });

    // Mock global fetch
    global.fetch = jest.fn();

    // Mock AbortSignal.timeout (not available in jsdom)
    if (!AbortSignal.timeout) {
      AbortSignal.timeout = jest.fn(() => new AbortController().signal);
    }

    // Mock window.aether for _resolveBackendUrl
    window.aether = {
      ipc: {
        invoke: jest.fn(),
      },
    };

    splash = null;
  });

  afterEach(() => {
    if (splash) {
      try { splash.dispose(); } catch (_) { /* already disposed */ }
    }
    jest.useRealTimers();
    global.requestAnimationFrame = window.requestAnimationFrame = savedRAF;
    delete global.fetch;
    delete window.aether;
  });

  function createSplash(opts = {}) {
    splash = new StartupSplash({
      windowName: 'test',
      configSnapshot: opts.configSnapshot || null,
      ...opts,
    });
    return splash;
  }

  // Helper: advance fake timers with proper microtask flushing (Jest 29+)
  async function advance(ms) {
    await jest.advanceTimersByTimeAsync(ms);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // constructor
  // ═══════════════════════════════════════════════════════════════════════════

  describe('constructor', () => {
    it('sets default windowName to renderer', () => {
      const s = new StartupSplash();
      expect(s.windowName).toBe('renderer');
      s.dispose();
    });

    it('uses provided windowName', () => {
      const s = createSplash({ windowName: 'artifacts' });
      expect(s.windowName).toBe('artifacts');
    });

    it('stores configSnapshot', () => {
      const cfg = { ui: { startupAnimation: { enabled: true } } };
      const s = createSplash({ configSnapshot: cfg });
      expect(s.configSnapshot).toBe(cfg);
    });

    it('defaults configSnapshot to null', () => {
      const s = new StartupSplash();
      expect(s.configSnapshot).toBeNull();
      s.dispose();
    });

    it('initializes lifecycle properties', () => {
      const s = createSplash();
      expect(s._root).toBeNull();
      expect(s._statusEl).toBeNull();
      expect(s._progressBarEl).toBeNull();
      expect(s._timers).toEqual([]);
      expect(s._isDisposed).toBe(false);
      expect(s._healthPollStop).toBe(false);
    });

    it('creates logger with child context', () => {
      const { createRendererLogger } = require('../../../src/renderer/shared/utils/logger');
      const childSpy = jest.fn(function () { return this; });
      createRendererLogger.mockReturnValue({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        trace: jest.fn(),
        child: childSpy,
      });
      createSplash({ windowName: 'chat' });
      expect(createRendererLogger).toHaveBeenCalledWith('StartupSplash');
      expect(childSpy).toHaveBeenCalledWith({ window: 'chat' });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // attach()
  // ═══════════════════════════════════════════════════════════════════════════

  describe('attach()', () => {
    it('creates root element with correct class and aria attributes', () => {
      const s = createSplash();
      s.attach();

      expect(s._root).not.toBeNull();
      expect(s._root.className).toBe('aether-startup-splash');
      expect(s._root.getAttribute('role')).toBe('presentation');
      expect(s._root.getAttribute('aria-hidden')).toBe('true');
    });

    it('creates full DOM structure (inner, mark, wordmark, letters, suffixes, status, progress)', () => {
      const s = createSplash();
      s.attach();

      const root = s._root;
      // Inner container
      const inner = root.querySelector('.aether-startup-splash__inner');
      expect(inner).not.toBeNull();

      // Mark > Wordmark with letters and suffixes
      const mark = inner.querySelector('.aether-startup-splash__mark');
      expect(mark).not.toBeNull();
      const wordmark = mark.querySelector('.aether-startup-splash__wordmark');
      expect(wordmark).not.toBeNull();

      const aLetter = wordmark.querySelector('.aether-startup-splash__letter--a');
      expect(aLetter).not.toBeNull();
      expect(aLetter.textContent).toBe('A');

      const aetherSuffix = wordmark.querySelector('.aether-startup-splash__suffix--aether');
      expect(aetherSuffix).not.toBeNull();
      expect(aetherSuffix.textContent).toBe('ether');

      const iLetter = wordmark.querySelector('.aether-startup-splash__letter--i');
      expect(iLetter).not.toBeNull();
      expect(iLetter.textContent).toBe('I');

      const incSuffix = wordmark.querySelector('.aether-startup-splash__suffix--inc');
      expect(incSuffix).not.toBeNull();
      expect(incSuffix.textContent).toBe('nc');

      // Status element
      const status = inner.querySelector('.aether-startup-splash__status');
      expect(status).not.toBeNull();
      expect(status.textContent).toBe('');

      // Progress bar
      const progressWrap = inner.querySelector('.aether-startup-splash__progress-wrap');
      expect(progressWrap).not.toBeNull();
      const progressBar = progressWrap.querySelector('.aether-startup-splash__progress-bar');
      expect(progressBar).not.toBeNull();
    });

    it('appends root to document.body and adds body class', () => {
      const s = createSplash();
      s.attach();

      expect(document.body.contains(s._root)).toBe(true);
      expect(document.body.classList.contains('is-startup-splash-active')).toBe(true);
    });

    it('stores references to status and progress bar elements', () => {
      const s = createSplash();
      s.attach();

      expect(s._statusEl).not.toBeNull();
      expect(s._statusEl.className).toBe('aether-startup-splash__status');
      expect(s._progressBarEl).not.toBeNull();
      expect(s._progressBarEl.className).toBe('aether-startup-splash__progress-bar');
    });

    it('no-ops when already attached (idempotent)', () => {
      const s = createSplash();
      s.attach();
      const firstRoot = s._root;

      s.attach(); // second call
      expect(s._root).toBe(firstRoot); // same reference
      expect(document.querySelectorAll('.aether-startup-splash').length).toBe(1);
    });

    it('throws when document.body is not available', () => {
      const s = createSplash();
      const origBody = document.body;

      // Temporarily remove body
      Object.defineProperty(document, 'body', { value: null, configurable: true });
      expect(() => s.attach()).toThrow('[StartupSplash] DOM not ready');
      Object.defineProperty(document, 'body', { value: origBody, configurable: true });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // dispose()
  // ═══════════════════════════════════════════════════════════════════════════

  describe('dispose()', () => {
    it('sets lifecycle flags', () => {
      const s = createSplash();
      s.attach();
      s.dispose();

      expect(s._isDisposed).toBe(true);
      expect(s._healthPollStop).toBe(true);
    });

    it('clears all tracked timers', () => {
      const s = createSplash();
      // Manually add timers
      const t1 = setTimeout(() => {}, 1000);
      const t2 = setTimeout(() => {}, 2000);
      s._timers.push(t1, t2);

      s.dispose();
      expect(s._timers).toEqual([]);
    });

    it('removes root from DOM', () => {
      const s = createSplash();
      s.attach();
      expect(document.body.contains(s._root)).toBe(true);

      const root = s._root;
      s.dispose();
      expect(document.body.contains(root)).toBe(false);
    });

    it('nulls out element references', () => {
      const s = createSplash();
      s.attach();
      s.dispose();

      expect(s._root).toBeNull();
      expect(s._statusEl).toBeNull();
      expect(s._progressBarEl).toBeNull();
    });

    it('removes body class', () => {
      const s = createSplash();
      s.attach();
      expect(document.body.classList.contains('is-startup-splash-active')).toBe(true);

      s.dispose();
      expect(document.body.classList.contains('is-startup-splash-active')).toBe(false);
    });

    it('handles dispose when never attached', () => {
      const s = createSplash();
      expect(() => s.dispose()).not.toThrow();
      expect(s._isDisposed).toBe(true);
    });

    it('handles double dispose gracefully', () => {
      const s = createSplash();
      s.attach();
      s.dispose();
      expect(() => s.dispose()).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // _getCfg()
  // ═══════════════════════════════════════════════════════════════════════════

  describe('_getCfg()', () => {
    it('returns fallback config when configSnapshot is null', () => {
      const s = createSplash({ configSnapshot: null });
      const cfg = s._getCfg();

      expect(cfg).toEqual({
        enabled: true,
        minDurationMs: 3200,
        separationDelayMs: 1200,
        expandDelayMs: 2000,
        fadeOutDurationMs: 400,
        holdAfterExpandMs: 500,
      });
    });

    it('returns fallback config when ui.startupAnimation is missing', () => {
      const s = createSplash({ configSnapshot: { ui: {} } });
      const cfg = s._getCfg();
      expect(cfg.enabled).toBe(true);
      expect(cfg.minDurationMs).toBe(3200);
    });

    it('returns fallback config when ui.startupAnimation is not an object', () => {
      const s = createSplash({ configSnapshot: { ui: { startupAnimation: 'invalid' } } });
      const cfg = s._getCfg();
      expect(cfg.enabled).toBe(true);
      expect(cfg.minDurationMs).toBe(3200);
    });

    it('uses config values when valid', () => {
      const s = createSplash({
        configSnapshot: {
          ui: {
            startupAnimation: {
              enabled: true,
              minDurationMs: 1000,
              separationDelayMs: 500,
              expandDelayMs: 800,
              fadeOutDurationMs: 200,
              holdAfterExpandMs: 300,
            },
          },
        },
      });
      const cfg = s._getCfg();
      expect(cfg.minDurationMs).toBe(1000);
      expect(cfg.separationDelayMs).toBe(500);
      expect(cfg.expandDelayMs).toBe(800);
      expect(cfg.fadeOutDurationMs).toBe(200);
      expect(cfg.holdAfterExpandMs).toBe(300);
    });

    it('uses fallback for non-positive minDurationMs', () => {
      const s = createSplash({
        configSnapshot: { ui: { startupAnimation: { minDurationMs: 0 } } },
      });
      expect(s._getCfg().minDurationMs).toBe(3200);
    });

    it('uses fallback for negative minDurationMs', () => {
      const s = createSplash({
        configSnapshot: { ui: { startupAnimation: { minDurationMs: -100 } } },
      });
      expect(s._getCfg().minDurationMs).toBe(3200);
    });

    it('uses fallback for NaN minDurationMs', () => {
      const s = createSplash({
        configSnapshot: { ui: { startupAnimation: { minDurationMs: 'abc' } } },
      });
      expect(s._getCfg().minDurationMs).toBe(3200);
    });

    it('allows zero for separationDelayMs', () => {
      const s = createSplash({
        configSnapshot: { ui: { startupAnimation: { separationDelayMs: 0 } } },
      });
      expect(s._getCfg().separationDelayMs).toBe(0);
    });

    it('uses fallback for negative separationDelayMs', () => {
      const s = createSplash({
        configSnapshot: { ui: { startupAnimation: { separationDelayMs: -1 } } },
      });
      expect(s._getCfg().separationDelayMs).toBe(1200);
    });

    it('allows zero for expandDelayMs', () => {
      const s = createSplash({
        configSnapshot: { ui: { startupAnimation: { expandDelayMs: 0 } } },
      });
      expect(s._getCfg().expandDelayMs).toBe(0);
    });

    it('uses fallback for non-positive fadeOutDurationMs', () => {
      const s = createSplash({
        configSnapshot: { ui: { startupAnimation: { fadeOutDurationMs: 0 } } },
      });
      expect(s._getCfg().fadeOutDurationMs).toBe(400);
    });

    it('allows zero for holdAfterExpandMs', () => {
      const s = createSplash({
        configSnapshot: { ui: { startupAnimation: { holdAfterExpandMs: 0 } } },
      });
      expect(s._getCfg().holdAfterExpandMs).toBe(0);
    });

    it('respects enabled: false', () => {
      const s = createSplash({
        configSnapshot: { ui: { startupAnimation: { enabled: false } } },
      });
      expect(s._getCfg().enabled).toBe(false);
    });

    it('defaults enabled to true when not explicitly false', () => {
      const s = createSplash({
        configSnapshot: { ui: { startupAnimation: { enabled: undefined } } },
      });
      expect(s._getCfg().enabled).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // _setStatus()
  // ═══════════════════════════════════════════════════════════════════════════

  describe('_setStatus()', () => {
    it('sets text content on status element', () => {
      const s = createSplash();
      s.attach();
      s._setStatus('Starting services');
      expect(s._statusEl.textContent).toBe('Starting services');
    });

    it('adds is-visible class on first call', () => {
      const s = createSplash();
      s.attach();
      expect(s._statusEl.classList.contains('is-visible')).toBe(false);

      s._setStatus('Test');
      expect(s._statusEl.classList.contains('is-visible')).toBe(true);
    });

    it('does not duplicate is-visible class on repeated calls', () => {
      const s = createSplash();
      s.attach();
      s._setStatus('First');
      s._setStatus('Second');
      // classList.add is idempotent, but we also test the guard
      expect(s._statusEl.classList.length).toBe(2); // aether-startup-splash__status + is-visible
      expect(s._statusEl.textContent).toBe('Second');
    });

    it('no-ops when statusEl is null (not attached)', () => {
      const s = createSplash();
      expect(() => s._setStatus('Test')).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // _setProgress()
  // ═══════════════════════════════════════════════════════════════════════════

  describe('_setProgress()', () => {
    it('sets width percentage on progress bar', () => {
      const s = createSplash();
      s.attach();
      s._setProgress(50);
      expect(s._progressBarEl.style.width).toBe('50%');
    });

    it('clamps at 0 for negative values', () => {
      const s = createSplash();
      s.attach();
      s._setProgress(-10);
      expect(s._progressBarEl.style.width).toBe('0%');
    });

    it('clamps at 100 for values over 100', () => {
      const s = createSplash();
      s.attach();
      s._setProgress(150);
      expect(s._progressBarEl.style.width).toBe('100%');
    });

    it('adds is-visible class to progress wrapper', () => {
      const s = createSplash();
      s.attach();
      const wrap = s._progressBarEl.parentElement;
      expect(wrap.classList.contains('is-visible')).toBe(false);

      s._setProgress(10);
      expect(wrap.classList.contains('is-visible')).toBe(true);
    });

    it('no-ops when progressBarEl is null (not attached)', () => {
      const s = createSplash();
      expect(() => s._setProgress(50)).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // _nextAnimationFrame()
  // ═══════════════════════════════════════════════════════════════════════════

  describe('_nextAnimationFrame()', () => {
    it('resolves via rAF when available', async () => {
      const s = createSplash();
      let resolved = false;
      s._nextAnimationFrame().then(() => { resolved = true; });

      await advance(0);
      expect(resolved).toBe(true);
    });

    it('falls back to setTimeout(16) when rAF is not a function', async () => {
      // Temporarily remove rAF
      const savedRaf = global.requestAnimationFrame;
      delete global.requestAnimationFrame;

      const s = createSplash();
      let resolved = false;
      s._nextAnimationFrame().then(() => { resolved = true; });

      // 15ms should not resolve
      await advance(15);
      expect(resolved).toBe(false);

      // 16ms should resolve and track timer
      await advance(1);
      expect(resolved).toBe(true);
      expect(s._timers.length).toBe(1);

      global.requestAnimationFrame = savedRaf;
      s.dispose();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // _sleep()
  // ═══════════════════════════════════════════════════════════════════════════

  describe('_sleep()', () => {
    it('resolves after specified milliseconds', async () => {
      const s = createSplash();
      let resolved = false;
      s._sleep(500).then(() => { resolved = true; });

      await advance(499);
      expect(resolved).toBe(false);

      await advance(1);
      expect(resolved).toBe(true);
    });

    it('tracks timer in _timers array', () => {
      const s = createSplash();
      s._sleep(100);
      expect(s._timers.length).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // _resolveBackendUrl()
  // ═══════════════════════════════════════════════════════════════════════════

  describe('_resolveBackendUrl()', () => {
    it('returns backend URL from IPC invoke', async () => {
      const s = createSplash();
      window.aether.ipc.invoke.mockResolvedValue('http://localhost:7090');

      const url = await s._resolveBackendUrl();
      expect(url).toBe('http://localhost:7090');
      expect(window.aether.ipc.invoke).toHaveBeenCalledWith('backend:get-url');
    });

    it('strips trailing slash from URL', async () => {
      const s = createSplash();
      window.aether.ipc.invoke.mockResolvedValue('http://localhost:7090/');

      const url = await s._resolveBackendUrl();
      expect(url).toBe('http://localhost:7090');
    });

    it('returns null when window.aether is not available', async () => {
      const s = createSplash();
      delete window.aether;

      const url = await s._resolveBackendUrl();
      expect(url).toBeNull();
    });

    it('returns null when IPC invoke is not available', async () => {
      const s = createSplash();
      window.aether = { ipc: {} };

      const url = await s._resolveBackendUrl();
      expect(url).toBeNull();
    });

    it('returns null when IPC returns empty string', async () => {
      const s = createSplash();
      window.aether.ipc.invoke.mockResolvedValue('');

      const url = await s._resolveBackendUrl();
      expect(url).toBeNull();
    });

    it('returns null when IPC returns whitespace-only string', async () => {
      const s = createSplash();
      window.aether.ipc.invoke.mockResolvedValue('   ');

      const url = await s._resolveBackendUrl();
      expect(url).toBeNull();
    });

    it('returns null when IPC returns non-string', async () => {
      const s = createSplash();
      window.aether.ipc.invoke.mockResolvedValue(42);

      const url = await s._resolveBackendUrl();
      expect(url).toBeNull();
    });

    it('returns null on IPC error (does not throw)', async () => {
      const s = createSplash();
      window.aether.ipc.invoke.mockRejectedValue(new Error('IPC timeout'));

      const url = await s._resolveBackendUrl();
      expect(url).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // _waitForBackendHealth()
  // ═══════════════════════════════════════════════════════════════════════════

  describe('_waitForBackendHealth()', () => {
    it('returns true when health check succeeds on first attempt', async () => {
      const s = createSplash();
      s.attach();
      window.aether.ipc.invoke.mockResolvedValue('http://localhost:7090');
      global.fetch.mockResolvedValue({ ok: true });

      const promise = s._waitForBackendHealth();

      // Wait for one microtask cycle to let the async loop run
      // The loop: resolveBackendUrl -> fetch -> return true
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const result = await promise;
      expect(result).toBe(true);
      expect(s._statusEl.textContent).toBe('Ready');
      expect(s._progressBarEl.style.width).toBe('100%');
    });

    it('retries when backend URL is not yet resolved', async () => {
      const s = createSplash();
      s.attach();

      // First call: no URL. Second call: URL available.
      window.aether.ipc.invoke
        .mockResolvedValueOnce(null)
        .mockResolvedValue('http://localhost:7090');
      global.fetch.mockResolvedValue({ ok: true });

      const promise = s._waitForBackendHealth();

      // First attempt: no URL → _sleep(3000) → advance timer
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      // Now waiting on _sleep(3000)
      await advance(3000);
      // Second attempt: URL resolved → fetch → success
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const result = await promise;
      expect(result).toBe(true);
      expect(window.aether.ipc.invoke).toHaveBeenCalledTimes(2);
    });

    it('retries when fetch fails (backend not ready)', async () => {
      const s = createSplash();
      s.attach();
      window.aether.ipc.invoke.mockResolvedValue('http://localhost:7090');

      // First fetch fails, second succeeds
      global.fetch
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValue({ ok: true });

      const promise = s._waitForBackendHealth();

      // First attempt: fetch fails → catch → _sleep(3000)
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await advance(3000);
      // Second attempt: fetch succeeds
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const result = await promise;
      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('returns false when disposed mid-poll', async () => {
      const s = createSplash();
      s.attach();
      window.aether.ipc.invoke.mockResolvedValue(null);

      const promise = s._waitForBackendHealth();

      // Let first attempt run (URL not resolved)
      await Promise.resolve();
      await Promise.resolve();

      // Dispose while waiting
      s._isDisposed = true;
      await advance(3000);

      const result = await promise;
      expect(result).toBe(false);
    });

    it('returns false when healthPollStop is set', async () => {
      const s = createSplash();
      s.attach();
      window.aether.ipc.invoke.mockResolvedValue(null);

      const promise = s._waitForBackendHealth();

      await Promise.resolve();
      await Promise.resolve();

      s._healthPollStop = true;
      await advance(3000);

      const result = await promise;
      expect(result).toBe(false);
    });

    it('times out after 300 seconds', async () => {
      const s = createSplash();
      s.attach();
      window.aether.ipc.invoke.mockResolvedValue('http://localhost:7090');
      // Fetch always returns non-ok
      global.fetch.mockResolvedValue({ ok: false });

      const promise = s._waitForBackendHealth();

      // Advance past timeout (300 seconds)
      for (let i = 0; i < 102; i++) {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        jest.advanceTimersByTime(3000);
        await Promise.resolve();
        await Promise.resolve();
      }

      const result = await promise;
      expect(result).toBe(false);
    });

    it('sets status text based on elapsed time', async () => {
      const s = createSplash();
      s.attach();
      window.aether.ipc.invoke.mockResolvedValue('http://localhost:7090');
      // Fetch always fails
      global.fetch.mockRejectedValue(new Error('fail'));

      s._waitForBackendHealth();

      // First cycle: < 15s → "Starting services"
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(s._statusEl.textContent).toBe('Starting services');

      // Advance to 16s → "Loading backend"
      for (let i = 0; i < 6; i++) {
        await advance(3000);
        await Promise.resolve();
        await Promise.resolve();
      }
      expect(s._statusEl.textContent).toBe('Loading backend');

      // Advance to 46s → "Almost ready"
      for (let i = 0; i < 10; i++) {
        await advance(3000);
        await Promise.resolve();
        await Promise.resolve();
      }
      expect(s._statusEl.textContent).toBe('Almost ready');

      // Cleanup
      s.dispose();
    });

    it('calls fetch with correct URL and headers', async () => {
      const s = createSplash();
      s.attach();
      window.aether.ipc.invoke.mockResolvedValue('http://localhost:7090');
      global.fetch.mockResolvedValue({ ok: true });

      await s._waitForBackendHealth();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:7090/v1/health',
        expect.objectContaining({
          method: 'GET',
          headers: { 'Accept': 'application/json' },
        })
      );
    });

    it('sets initial status and progress', () => {
      const s = createSplash();
      s.attach();
      window.aether.ipc.invoke.mockResolvedValue(null);

      s._waitForBackendHealth();
      expect(s._statusEl.textContent).toBe('Starting services');
      expect(s._progressBarEl.style.width).toBe('15%');

      s.dispose();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // _yieldToPaint()
  // ═══════════════════════════════════════════════════════════════════════════

  describe('_yieldToPaint()', () => {
    it('resolves after rAF + setTimeout(0)', async () => {
      const s = createSplash();
      let resolved = false;
      s._yieldToPaint().then(() => { resolved = true; });

      // advance(1) fires both: rAF-as-setTimeout(0) and the nested setTimeout(0)
      await advance(1);
      expect(resolved).toBe(true);
    });

    it('tracks the inner setTimeout in _timers', async () => {
      const s = createSplash();
      s._yieldToPaint();
      // After full yield, the inner setTimeout was tracked
      await advance(1);
      expect(s._timers.length).toBe(1);
      s.dispose();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // run() — full lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  describe('run()', () => {
    it('returns immediately when animation is disabled', async () => {
      const s = createSplash({
        configSnapshot: { ui: { startupAnimation: { enabled: false } } },
      });

      await s.run();
      expect(s._root).toBeNull(); // Never attached
    });

    it('completes full lifecycle with skipHealthCheck (dev mode)', async () => {
      const s = createSplash({
        configSnapshot: {
          dev: { skipHealthCheck: true },
          ui: {
            startupAnimation: {
              enabled: true,
              minDurationMs: 100,
              separationDelayMs: 30,
              expandDelayMs: 60,
              fadeOutDurationMs: 50,
              holdAfterExpandMs: 20,
            },
          },
        },
      });

      const promise = s.run();

      // Advance through entire lifecycle in one shot.
      // Total: yieldToPaint(~0) + sleep(100) + sleep(20) + sleep(200) + sleep(50) = ~370ms
      // Plus separation(30ms) and expand(60ms) fire independently.
      await advance(500);

      await promise;
      expect(s._isDisposed).toBe(true);
      expect(s._root).toBeNull();
    });

    it('completes full lifecycle with backend health check (production mode)', async () => {
      window.aether.ipc.invoke.mockResolvedValue('http://localhost:7090');
      global.fetch.mockResolvedValue({ ok: true });

      const s = createSplash({
        configSnapshot: {
          ui: {
            startupAnimation: {
              enabled: true,
              minDurationMs: 100,
              separationDelayMs: 30,
              expandDelayMs: 60,
              fadeOutDurationMs: 50,
              holdAfterExpandMs: 20,
            },
          },
        },
      });

      const promise = s.run();

      // Total: yieldToPaint(~0) + sleep(100) + sleep(20) + healthCheck(~0 async)
      //   + sleep(600) + sleep(50) = ~770ms
      await advance(1000);

      await promise;
      expect(s._isDisposed).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:7090/v1/health',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('disposes correctly when disposed during brand animation phase', async () => {
      const s = createSplash({
        configSnapshot: {
          ui: {
            startupAnimation: {
              enabled: true,
              minDurationMs: 5000,
              separationDelayMs: 1000,
              expandDelayMs: 2000,
              fadeOutDurationMs: 400,
              holdAfterExpandMs: 500,
            },
          },
        },
      });

      s.run(); // Don't await — dispose will prevent completion

      // Advance past yieldToPaint so run() is blocked on sleep(5000)
      await advance(1);

      // Dispose mid-animation
      s.dispose();
      expect(s._isDisposed).toBe(true);
      expect(s._root).toBeNull();
    });

    it('applies is-separated class during separation phase', async () => {
      const s = createSplash({
        configSnapshot: {
          ui: {
            startupAnimation: {
              enabled: true,
              minDurationMs: 5000,
              separationDelayMs: 500,
              expandDelayMs: 2000,
              fadeOutDurationMs: 400,
              holdAfterExpandMs: 500,
            },
          },
        },
      });

      s.run();

      // Advance past yieldToPaint
      await advance(1);

      // Before separation at 500ms
      expect(s._root.classList.contains('is-separated')).toBe(false);

      // After separation delay (500ms from run start)
      await advance(500);
      expect(s._root.classList.contains('is-separated')).toBe(true);

      // After expand delay (2000ms from run start) — separated removed, expanded added
      await advance(1500);
      expect(s._root.classList.contains('is-separated')).toBe(false);
      expect(s._root.classList.contains('is-expanded')).toBe(true);

      s.dispose();
    });

    it('skips separation timer when separationDelayMs >= expandDelayMs', async () => {
      const s = createSplash({
        configSnapshot: {
          dev: { skipHealthCheck: true },
          ui: {
            startupAnimation: {
              enabled: true,
              minDurationMs: 100,
              separationDelayMs: 200, // >= expandDelayMs
              expandDelayMs: 100,
              fadeOutDurationMs: 50,
              holdAfterExpandMs: 20,
            },
          },
        },
      });

      const promise = s.run();

      // Advance past yieldToPaint and into brand animation
      await advance(1);

      // separationDelayMs is clamped to min(200, 100) = 100 which equals expandDelayMs
      // So the guard `if (separationDelayMs < cfg.expandDelayMs)` is FALSE
      // No separation timer is scheduled

      // Advance past expand timer
      await advance(100);
      expect(s._root.classList.contains('is-expanded')).toBe(true);

      // Complete the run
      await advance(500);
      await promise;
      expect(s._isDisposed).toBe(true);
    });

    it('sets is-fading class and CSS custom property during fade out', async () => {
      const s = createSplash({
        configSnapshot: {
          dev: { skipHealthCheck: true },
          ui: {
            startupAnimation: {
              enabled: true,
              minDurationMs: 50,
              separationDelayMs: 10,
              expandDelayMs: 20,
              fadeOutDurationMs: 300,
              holdAfterExpandMs: 10,
            },
          },
        },
      });

      const promise = s.run();

      // Advance through brand + hold + skipHealth pause (50+10+200 = 260ms) + yieldToPaint
      await advance(270);

      // Now in fade phase — check is-fading class and CSS property
      const root = s._root;
      expect(root).not.toBeNull();
      expect(root.classList.contains('is-fading')).toBe(true);
      expect(root.style.getPropertyValue('--startup-fade-ms')).toBe('300ms');

      // Complete fade
      await advance(300);
      await promise;
      expect(s._isDisposed).toBe(true);
    });

    it('does not add separation class when disposed before timeout fires', async () => {
      const s = createSplash({
        configSnapshot: {
          ui: {
            startupAnimation: {
              enabled: true,
              minDurationMs: 5000,
              separationDelayMs: 1000,
              expandDelayMs: 2000,
              fadeOutDurationMs: 400,
              holdAfterExpandMs: 500,
            },
          },
        },
      });

      s.run();
      await advance(1); // yieldToPaint

      // Dispose before separation at 1000ms
      s.dispose();
      expect(s._isDisposed).toBe(true);
      expect(s._root).toBeNull();
    });

    it('does not add expand class when disposed before timeout fires', async () => {
      const s = createSplash({
        configSnapshot: {
          ui: {
            startupAnimation: {
              enabled: true,
              minDurationMs: 5000,
              separationDelayMs: 500,
              expandDelayMs: 2000,
              fadeOutDurationMs: 400,
              holdAfterExpandMs: 500,
            },
          },
        },
      });

      s.run();
      await advance(1); // yieldToPaint

      // Let separation fire, then dispose before expand at 2000ms
      await advance(500);
      expect(s._root.classList.contains('is-separated')).toBe(true);

      s.dispose();
      expect(s._isDisposed).toBe(true);
      expect(s._root).toBeNull();
    });

    it('handles unhealthy backend by failing closed and rendering error UI instead of disposing', async () => {
      window.aether.ipc.invoke.mockResolvedValue('http://localhost:7090');
      global.fetch.mockResolvedValue({ ok: false });

      const s = createSplash({
        configSnapshot: {
          ui: {
            startupAnimation: {
              enabled: true,
              minDurationMs: 50,
              separationDelayMs: 10,
              expandDelayMs: 20,
              fadeOutDurationMs: 30,
              holdAfterExpandMs: 10,
            },
          },
        },
      });

      // Start run (but do not await it yet, it will loop indefinitely until healthy)
      s.run();

      // Brand animation phase
      await advance(100);

      // Health poll starts and eventually times out
      // 5 minutes timeout = 300,000 ms = 100 cycles of 3000ms
      for (let i = 0; i <= 101; i++) {
        await advance(3000);
      }

      // After unhealthy exit, it should NOT dispose, but show fatal error UI
      await advance(100);

      expect(s._isDisposed).toBe(false);
      expect(s._root.classList.contains('is-fatal-error')).toBe(true);
      
      const errorUi = s._root.querySelector('.fatal-startup-error');
      expect(errorUi).not.toBeNull();
      expect(errorUi.textContent).toContain('Service Unreachable');

      // Verify fetch was attempted
      expect(global.fetch).toHaveBeenCalled();
      
      // Cleanup
      s.dispose();
    });

    it('retries health check when backend URL not yet available', async () => {
      // First call: no URL. Second call: URL + healthy.
      window.aether.ipc.invoke
        .mockResolvedValueOnce(null)
        .mockResolvedValue('http://localhost:7090');
      global.fetch.mockResolvedValue({ ok: true });

      const s = createSplash({
        configSnapshot: {
          ui: {
            startupAnimation: {
              enabled: true,
              minDurationMs: 50,
              separationDelayMs: 10,
              expandDelayMs: 20,
              fadeOutDurationMs: 30,
              holdAfterExpandMs: 10,
            },
          },
        },
      });

      const promise = s.run();

      // Brand animation
      await advance(100);

      // First health attempt: no URL → sleep(3000)
      // Second health attempt: URL → fetch succeeds
      await advance(4000);

      // Healthy pause (600ms) + fade (30ms)
      await advance(700);

      await promise;
      expect(s._isDisposed).toBe(true);
      expect(window.aether.ipc.invoke).toHaveBeenCalledTimes(2);
    });

    it('shows dev mode status when skipHealthCheck is true', async () => {
      const s = createSplash({
        configSnapshot: {
          dev: { skipHealthCheck: true },
          ui: {
            startupAnimation: {
              enabled: true,
              minDurationMs: 50,
              separationDelayMs: 10,
              expandDelayMs: 20,
              fadeOutDurationMs: 30,
              holdAfterExpandMs: 10,
            },
          },
        },
      });

      const promise = s.run();

      // Advance past brand animation phase
      await advance(100);

      // In dev mode, status should show 'Dev mode' and progress 100%
      expect(s._statusEl.textContent).toBe('Dev mode');
      expect(s._progressBarEl.style.width).toBe('100%');

      // Complete
      await advance(300);
      await promise;
    });

    it('exits early when disposed after yieldToPaint', async () => {
      const s = createSplash({
        configSnapshot: {
          dev: { skipHealthCheck: true },
          ui: {
            startupAnimation: {
              enabled: true,
              minDurationMs: 5000,
              separationDelayMs: 1000,
              expandDelayMs: 2000,
              fadeOutDurationMs: 400,
              holdAfterExpandMs: 500,
            },
          },
        },
      });

      s.run();
      // Let yieldToPaint resolve, then immediately dispose
      await advance(0);
      await advance(0);
      s._isDisposed = true;

      // Advance — run() should have exited at the first isDisposed check
      await advance(10000);
      expect(s._isDisposed).toBe(true);
    });
  });
});
