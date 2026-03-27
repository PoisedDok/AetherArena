'use strict';

// ---------------------------------------------------------------------------
// config-init.js — Unit tests
// ---------------------------------------------------------------------------
// Source: src/renderer/main/scripts/config-init.js (42 lines)
// Side-effect module: sets window.__AETHER_CONFIG_READY__ and window.AETHER_CONFIG.
// Tests must re-require the module fresh for each scenario.
// ---------------------------------------------------------------------------

describe('config-init.js', () => {
  let consoleSpy;

  beforeEach(() => {
    jest.useFakeTimers();
    // Clean global state from previous runs
    delete window.__AETHER_CONFIG_READY__;
    delete window.AETHER_CONFIG;
    delete window.aether;
    // Spy on console (the module uses console.log / console.error)
    consoleSpy = {
      log: jest.spyOn(console, 'log').mockImplementation(() => {}),
      error: jest.spyOn(console, 'error').mockImplementation(() => {}),
    };
    // Clear module cache so re-require executes the IIFE again
    jest.resetModules();
  });

  afterEach(() => {
    jest.useRealTimers();
    consoleSpy.log.mockRestore();
    consoleSpy.error.mockRestore();
  });

  // =========================================================================
  // Happy path
  // =========================================================================

  describe('happy path (ipc.invoke returns valid URL)', () => {
    it('exposes window.__AETHER_CONFIG_READY__ as a Promise', () => {
      window.aether = { ipc: { invoke: jest.fn().mockResolvedValue('http://localhost:9000') } };
      require('../../../../src/renderer/main/scripts/config-init');

      expect(window.__AETHER_CONFIG_READY__).toBeInstanceOf(Promise);
    });

    it('resolves with frozen AETHER_CONFIG containing backend.baseUrl', async () => {
      const url = 'http://localhost:9000';
      window.aether = { ipc: { invoke: jest.fn().mockResolvedValue(url) } };
      require('../../../../src/renderer/main/scripts/config-init');

      const config = await window.__AETHER_CONFIG_READY__;
      expect(config).toEqual({ backend: { baseUrl: url } });
      expect(Object.isFrozen(config)).toBe(true);
      expect(Object.isFrozen(config.backend)).toBe(true);
    });

    it('sets window.AETHER_CONFIG after resolution', async () => {
      window.aether = { ipc: { invoke: jest.fn().mockResolvedValue('http://localhost:9000') } };
      require('../../../../src/renderer/main/scripts/config-init');

      await window.__AETHER_CONFIG_READY__;
      expect(window.AETHER_CONFIG.backend.baseUrl).toBe('http://localhost:9000');
    });

    it('calls aether.ipc.invoke with "backend:get-url"', async () => {
      const invoke = jest.fn().mockResolvedValue('http://localhost:9000');
      window.aether = { ipc: { invoke } };
      require('../../../../src/renderer/main/scripts/config-init');

      await window.__AETHER_CONFIG_READY__;
      expect(invoke).toHaveBeenCalledWith('backend:get-url');
      expect(invoke).toHaveBeenCalledTimes(1);
    });

    it('logs the resolved baseUrl', async () => {
      window.aether = { ipc: { invoke: jest.fn().mockResolvedValue('http://localhost:9000') } };
      require('../../../../src/renderer/main/scripts/config-init');

      await window.__AETHER_CONFIG_READY__;
      expect(consoleSpy.log).toHaveBeenCalledWith(
        '[ConfigInit] Exposed AETHER_CONFIG.backend.baseUrl:',
        'http://localhost:9000'
      );
    });
  });

  // =========================================================================
  // Missing preload bridge
  // =========================================================================

  describe('CONTRACT VIOLATION: missing preload bridge', () => {
    it('rejects when window.aether is undefined', async () => {
      // window.aether not set
      require('../../../../src/renderer/main/scripts/config-init');

      await expect(window.__AETHER_CONFIG_READY__).rejects.toThrow(
        '[ConfigInit] CONTRACT VIOLATION: preload ipc.invoke is required for backend discovery'
      );
    });

    it('rejects when aether exists but has no ipc', async () => {
      window.aether = {};
      require('../../../../src/renderer/main/scripts/config-init');

      await expect(window.__AETHER_CONFIG_READY__).rejects.toThrow(
        'preload ipc.invoke is required'
      );
    });

    it('rejects when aether.ipc exists but invoke is missing', async () => {
      window.aether = { ipc: {} };
      require('../../../../src/renderer/main/scripts/config-init');

      await expect(window.__AETHER_CONFIG_READY__).rejects.toThrow(
        'preload ipc.invoke is required'
      );
    });

    it('schedules the error as uncaught via setTimeout', async () => {
      // No aether => contract violation
      require('../../../../src/renderer/main/scripts/config-init');

      // Wait for the .catch handler to register the setTimeout
      await Promise.resolve(); // microtask
      await Promise.resolve(); // extra tick

      // The catch() handler does: setTimeout(() => { throw err; }, 0)
      // Advancing timers should trigger it. We intercept via jest.
      expect(() => jest.advanceTimersByTime(1)).toThrow(
        'preload ipc.invoke is required'
      );
    });

    it('logs the error via console.error', async () => {
      require('../../../../src/renderer/main/scripts/config-init');

      // Let promise rejection propagate
      try { await window.__AETHER_CONFIG_READY__; } catch (_e) { /* expected */ }

      // .catch handler fires asynchronously
      await Promise.resolve();
      expect(consoleSpy.error).toHaveBeenCalledWith(
        '[ConfigInit] Fatal config initialization error:',
        expect.stringContaining('preload ipc.invoke is required')
      );
    });
  });

  // =========================================================================
  // Invalid baseUrl response
  // =========================================================================

  describe('CONTRACT VIOLATION: invalid baseUrl', () => {
    it('rejects when invoke returns null', async () => {
      window.aether = { ipc: { invoke: jest.fn().mockResolvedValue(null) } };
      require('../../../../src/renderer/main/scripts/config-init');

      await expect(window.__AETHER_CONFIG_READY__).rejects.toThrow(
        'Backend baseUrl is required'
      );
    });

    it('rejects when invoke returns empty string', async () => {
      window.aether = { ipc: { invoke: jest.fn().mockResolvedValue('') } };
      require('../../../../src/renderer/main/scripts/config-init');

      await expect(window.__AETHER_CONFIG_READY__).rejects.toThrow(
        'Backend baseUrl is required'
      );
    });

    it('rejects when invoke returns a number', async () => {
      window.aether = { ipc: { invoke: jest.fn().mockResolvedValue(9000) } };
      require('../../../../src/renderer/main/scripts/config-init');

      await expect(window.__AETHER_CONFIG_READY__).rejects.toThrow(
        'Backend baseUrl is required'
      );
    });

    it('rejects when invoke returns undefined', async () => {
      window.aether = { ipc: { invoke: jest.fn().mockResolvedValue(undefined) } };
      require('../../../../src/renderer/main/scripts/config-init');

      await expect(window.__AETHER_CONFIG_READY__).rejects.toThrow(
        'Backend baseUrl is required'
      );
    });
  });

  // =========================================================================
  // IPC invoke rejects
  // =========================================================================

  describe('IPC invoke rejection', () => {
    it('propagates ipc.invoke rejection', async () => {
      window.aether = { ipc: { invoke: jest.fn().mockRejectedValue(new Error('IPC down')) } };
      require('../../../../src/renderer/main/scripts/config-init');

      await expect(window.__AETHER_CONFIG_READY__).rejects.toThrow('IPC down');
    });

    it('logs the propagated error message', async () => {
      window.aether = { ipc: { invoke: jest.fn().mockRejectedValue(new Error('IPC timeout')) } };
      require('../../../../src/renderer/main/scripts/config-init');

      try { await window.__AETHER_CONFIG_READY__; } catch (_e) { /* expected */ }
      await Promise.resolve();
      expect(consoleSpy.error).toHaveBeenCalledWith(
        '[ConfigInit] Fatal config initialization error:',
        'IPC timeout'
      );
    });

    it('logs the raw error when err.message is falsy (covers || err branch)', async () => {
      const rawError = 'raw string error';
      window.aether = { ipc: { invoke: jest.fn().mockRejectedValue(rawError) } };
      require('../../../../src/renderer/main/scripts/config-init');

      try { await window.__AETHER_CONFIG_READY__; } catch (_e) { /* expected */ }
      await Promise.resolve();
      expect(consoleSpy.error).toHaveBeenCalledWith(
        '[ConfigInit] Fatal config initialization error:',
        'raw string error'
      );
    });
  });
});
