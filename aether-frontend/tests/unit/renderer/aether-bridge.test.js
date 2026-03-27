'use strict';

// AetherBridge uses console.debug directly (not logger) to avoid circular deps.
// No external mocks needed — just window.aether setup/teardown.

const { getAether, requireAether } = require('../../../src/renderer/shared/bridge/AetherBridge');

describe('AetherBridge', () => {
  afterEach(() => {
    delete window.aether;
  });

  // --------------------------------------------------------------------------
  // getAether()
  // --------------------------------------------------------------------------

  describe('getAether()', () => {
    it('returns window.aether when available', () => {
      const mockApi = { ipc: { send: jest.fn() }, config: {} };
      window.aether = mockApi;
      const result = getAether();
      expect(result).toBe(mockApi);
    });

    it('returns falsy when window.aether is not set', () => {
      const result = getAether();
      // In jsdom: window exists but window.aether is undefined
      // typeof window !== 'undefined' is true, so bridge = window.aether = undefined
      expect(result).toBeFalsy();
    });

    it('logs console.debug when bridge is not available', () => {
      const spy = jest.spyOn(console, 'debug').mockImplementation();
      getAether();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('[AetherBridge] window.aether not available');
      spy.mockRestore();
    });

    it('does NOT log when bridge is available', () => {
      window.aether = { ipc: {} };
      const spy = jest.spyOn(console, 'debug').mockImplementation();
      getAether();
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('returns the exact object reference from window.aether', () => {
      const specificObj = Object.freeze({ id: 'test-bridge-42' });
      window.aether = specificObj;
      expect(getAether()).toBe(specificObj);
    });
  });

  // --------------------------------------------------------------------------
  // requireAether()
  // --------------------------------------------------------------------------

  describe('requireAether()', () => {
    it('returns bridge when window.aether is set', () => {
      const mockApi = { ipc: { send: jest.fn() } };
      window.aether = mockApi;
      expect(requireAether()).toBe(mockApi);
    });

    it('throws Error instance when window.aether is not set', () => {
      let caught;
      try { requireAether(); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(Error);
    });

    it('throws with descriptive error message', () => {
      expect(() => requireAether()).toThrow(
        '[AetherBridge] window.aether is required but not available'
      );
    });

    it('does not throw when bridge exists', () => {
      window.aether = {};
      expect(() => requireAether()).not.toThrow();
    });
  });
});
