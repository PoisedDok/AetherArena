'use strict';

/**
 * IpcGateway Unit Tests
 * ============================================================================
 * Tests constructor (injected bridge, _resolveBridge fallback, no bridge error),
 * _require (valid method, missing method), send, invoke, on (with cleanup return,
 * without cleanup return), once, off (present/absent removeListener),
 * removeAllListeners, getMetadata, getStats, static noop.
 *
 * @module tests/unit/core/ipc/IpcGateway.test
 */

const { IpcGateway } = require('../../../../src/core/ipc/IpcGateway');

// ---------------------------------------------------------------------------
// Helper: create a fake bridge with all methods
// ---------------------------------------------------------------------------

function fakeBridge(overrides = {}) {
  return {
    send: jest.fn(),
    invoke: jest.fn().mockResolvedValue('invoked'),
    on: jest.fn().mockReturnValue(jest.fn()), // returns cleanup function
    once: jest.fn(),
    removeListener: jest.fn(),
    removeAllListeners: jest.fn(),
    getMetadata: jest.fn().mockReturnValue({ version: '1.0' }),
    getStats: jest.fn().mockReturnValue({ calls: 5 }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IpcGateway', () => {
  let bridge;
  let gw;

  beforeEach(() => {
    bridge = fakeBridge();
    gw = new IpcGateway({ bridge });
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('accepts injected bridge', () => {
      expect(gw.bridge).toBe(bridge);
    });

    it('throws when no bridge available', () => {
      expect(() => new IpcGateway({ bridge: null })).toThrow('IPC bridge not available');
    });

    it('throws when bridge option is undefined and window is undefined', () => {
      // In Node, window is undefined, so _resolveBridge returns null
      expect(() => new IpcGateway()).toThrow('IPC bridge not available');
    });

    it('resolves bridge from window.aether.ipc if available', () => {
      const mockIpc = { send: jest.fn(), on: jest.fn(), once: jest.fn(), invoke: jest.fn() };
      global.window = { aether: { ipc: mockIpc } };
      const g = new IpcGateway();
      expect(g.bridge).toBe(mockIpc);
      delete global.window;
    });

    it('returns null from _resolveBridge when window.aether missing', () => {
      global.window = {};
      expect(() => new IpcGateway()).toThrow('IPC bridge not available');
      delete global.window;
    });
  });

  // =========================================================================
  // _require
  // =========================================================================

  describe('_require', () => {
    it('returns bound bridge method', () => {
      const fn = gw._require('send');
      expect(typeof fn).toBe('function');
    });

    it('throws when bridge has no such method', () => {
      expect(() => gw._require('nonexistent')).toThrow('IPC bridge missing method: nonexistent');
    });

    it('throws when bridge method is not a function', () => {
      bridge.badProp = 'not a function';
      expect(() => gw._require('badProp')).toThrow('IPC bridge missing method: badProp');
    });
  });

  // =========================================================================
  // send
  // =========================================================================

  describe('send', () => {
    it('calls bridge.send with channel and payload', () => {
      gw.send('test-channel', { data: 1 });
      expect(bridge.send).toHaveBeenCalledWith('test-channel', { data: 1 });
    });

    it('calls bridge.send with no payload', () => {
      gw.send('ping');
      expect(bridge.send).toHaveBeenCalledWith('ping', undefined);
    });
  });

  // =========================================================================
  // invoke
  // =========================================================================

  describe('invoke', () => {
    it('calls bridge.invoke and returns its result', async () => {
      bridge.invoke.mockResolvedValue({ status: 'ok' });
      const result = await gw.invoke('get-data', { id: 1 });
      expect(bridge.invoke).toHaveBeenCalledWith('get-data', { id: 1 });
      expect(result).toEqual({ status: 'ok' });
    });
  });

  // =========================================================================
  // on
  // =========================================================================

  describe('on', () => {
    it('calls bridge.on and returns the cleanup function when bridge.on returns one', () => {
      const cleanupFn = jest.fn();
      bridge.on.mockReturnValue(cleanupFn);
      const handler = jest.fn();
      const returned = gw.on('event', handler);
      expect(bridge.on).toHaveBeenCalledWith('event', handler);
      expect(returned).toBe(cleanupFn);
    });

    it('returns a fallback cleanup that calls off() when bridge.on returns non-function', () => {
      bridge.on.mockReturnValue(undefined);
      const handler = jest.fn();
      const cleanup = gw.on('event', handler);
      expect(typeof cleanup).toBe('function');
      // Calling the cleanup should call bridge.removeListener
      cleanup();
      expect(bridge.removeListener).toHaveBeenCalledWith('event', handler);
    });
  });

  // =========================================================================
  // once
  // =========================================================================

  describe('once', () => {
    it('calls bridge.once with channel and handler', () => {
      const handler = jest.fn();
      gw.once('one-time', handler);
      expect(bridge.once).toHaveBeenCalledWith('one-time', handler);
    });
  });

  // =========================================================================
  // off
  // =========================================================================

  describe('off', () => {
    it('calls bridge.removeListener when available', () => {
      const handler = jest.fn();
      gw.off('ch', handler);
      expect(bridge.removeListener).toHaveBeenCalledWith('ch', handler);
    });

    it('does nothing when bridge.removeListener is not a function', () => {
      const g = new IpcGateway({ bridge: { ...bridge, removeListener: undefined } });
      expect(() => g.off('ch', jest.fn())).not.toThrow();
    });
  });

  // =========================================================================
  // removeAllListeners
  // =========================================================================

  describe('removeAllListeners', () => {
    it('calls bridge.removeAllListeners with pattern', () => {
      gw.removeAllListeners('prefix:*');
      expect(bridge.removeAllListeners).toHaveBeenCalledWith('prefix:*');
    });

    it('does nothing when bridge.removeAllListeners is not a function', () => {
      const g = new IpcGateway({ bridge: { ...bridge, removeAllListeners: undefined } });
      expect(() => g.removeAllListeners('x')).not.toThrow();
    });
  });

  // =========================================================================
  // getMetadata
  // =========================================================================

  describe('getMetadata', () => {
    it('returns bridge metadata', () => {
      expect(gw.getMetadata()).toEqual({ version: '1.0' });
    });

    it('returns empty object when getMetadata not on bridge', () => {
      const g = new IpcGateway({ bridge: { ...bridge, getMetadata: undefined } });
      expect(g.getMetadata()).toEqual({});
    });
  });

  // =========================================================================
  // getStats
  // =========================================================================

  describe('getStats', () => {
    it('returns bridge stats', () => {
      expect(gw.getStats()).toEqual({ calls: 5 });
    });

    it('returns empty object when getStats not on bridge', () => {
      const g = new IpcGateway({ bridge: { ...bridge, getStats: undefined } });
      expect(g.getStats()).toEqual({});
    });
  });

  // =========================================================================
  // static noop
  // =========================================================================

  describe('static noop', () => {
    it('returns a function', () => {
      expect(typeof IpcGateway.noop()).toBe('function');
    });

    it('returns the same function every time', () => {
      expect(IpcGateway.noop()).toBe(IpcGateway.noop());
    });

    it('does nothing when called', () => {
      expect(IpcGateway.noop()()).toBeUndefined();
    });
  });
});
