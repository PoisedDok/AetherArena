/** @jest-environment jsdom */
'use strict';

/**
 * IpcBridge Unit Tests
 * ============================================================================
 * Tests the renderer IPC wrapper: send/on/once/removeListener/removeAllListeners,
 * message queueing when IPC is unavailable, queue flushing, stats, lifecycle,
 * and error paths.
 *
 * @module tests/unit/infrastructure/IpcBridge.test
 */

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const mockLog = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock('../../../src/core/utils/logger', () => ({
  createLogger: jest.fn(() => mockLog),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockIpc() {
  return {
    send: jest.fn(),
    on: jest.fn(),
    once: jest.fn(),
    removeListener: jest.fn(),
  };
}

function installIpc(mockIpc) {
  window.aether = { ipc: mockIpc };
}

function removeIpc() {
  delete window.aether;
}

// ---------------------------------------------------------------------------
// Import SUT (after mocks)
// ---------------------------------------------------------------------------

const { IpcBridge } = require('../../../src/infrastructure/ipc/IpcBridge');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IpcBridge', () => {
  let mockIpc;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIpc = createMockIpc();
  });

  afterEach(() => {
    removeIpc();
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('initialises with IPC available', () => {
      installIpc(mockIpc);
      const bridge = new IpcBridge();
      expect(bridge.ipc).toBe(mockIpc);
      expect(bridge.isReady).toBe(true);
      expect(bridge.context).toBe('renderer');
      expect(bridge.messageQueue).toEqual([]);
      expect(bridge.listeners).toBeInstanceOf(Map);
    });

    it('initialises without IPC (queues mode)', () => {
      removeIpc();
      const bridge = new IpcBridge();
      expect(bridge.ipc).toBeNull();
      expect(bridge.isReady).toBe(false);
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('not available'));
    });

    it('accepts custom context', () => {
      installIpc(mockIpc);
      const bridge = new IpcBridge({ context: 'worker' });
      expect(bridge.context).toBe('worker');
    });

    it('accepts enableLogging option', () => {
      installIpc(mockIpc);
      const bridge = new IpcBridge({ enableLogging: true });
      expect(bridge.enableLogging).toBe(true);
    });
  });

  // =========================================================================
  // send()
  // =========================================================================

  describe('send()', () => {
    it('sends via IPC when available', () => {
      installIpc(mockIpc);
      const bridge = new IpcBridge();
      const result = bridge.send('test-channel', { data: 1 });
      expect(result).toBe(true);
      expect(mockIpc.send).toHaveBeenCalledWith('test-channel', { data: 1 });
    });

    it('queues message when IPC unavailable', () => {
      removeIpc();
      const bridge = new IpcBridge();
      const result = bridge.send('ch', 'payload');
      expect(result).toBe(false);
      expect(bridge.messageQueue).toHaveLength(1);
      expect(bridge.messageQueue[0]).toEqual({ channel: 'ch', payload: 'payload' });
    });

    it('returns false on send error', () => {
      installIpc(mockIpc);
      mockIpc.send.mockImplementation(() => { throw new Error('boom'); });
      const bridge = new IpcBridge();
      const result = bridge.send('ch', {});
      expect(result).toBe(false);
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('failed to send'),
        expect.objectContaining({ error: 'boom' })
      );
    });
  });

  // =========================================================================
  // on()
  // =========================================================================

  describe('on()', () => {
    it('registers listener and returns unsubscribe fn', () => {
      installIpc(mockIpc);
      const bridge = new IpcBridge();
      const handler = jest.fn();
      const unsub = bridge.on('ch', handler);

      expect(typeof unsub).toBe('function');
      expect(mockIpc.on).toHaveBeenCalledWith('ch', expect.any(Function));
      expect(bridge.listeners.get('ch')).toHaveLength(1);
    });

    it('wrapped handler calls original and logs', () => {
      installIpc(mockIpc);
      const bridge = new IpcBridge();
      const handler = jest.fn();
      bridge.on('ch', handler);

      // Extract the wrapped handler passed to ipc.on
      const wrappedHandler = mockIpc.on.mock.calls[0][1];
      wrappedHandler('arg1', 'arg2');

      expect(handler).toHaveBeenCalledWith('arg1', 'arg2');
      expect(mockLog.debug).toHaveBeenCalledWith('received', { channel: 'ch' });
    });

    it('returns noop when IPC unavailable', () => {
      removeIpc();
      const bridge = new IpcBridge();
      const unsub = bridge.on('ch', jest.fn());
      expect(typeof unsub).toBe('function');
      unsub(); // should not throw
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('cannot register listener'));
    });

    it('returns noop on registration error', () => {
      installIpc(mockIpc);
      mockIpc.on.mockImplementation(() => { throw new Error('fail'); });
      const bridge = new IpcBridge();
      const unsub = bridge.on('ch', jest.fn());
      expect(typeof unsub).toBe('function');
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('failed to register listener'),
        expect.any(Object)
      );
    });

    it('tracks multiple listeners on same channel', () => {
      installIpc(mockIpc);
      const bridge = new IpcBridge();
      bridge.on('ch', jest.fn());
      bridge.on('ch', jest.fn());
      expect(bridge.listeners.get('ch')).toHaveLength(2);
    });
  });

  // =========================================================================
  // once()
  // =========================================================================

  describe('once()', () => {
    it('registers one-time listener', () => {
      installIpc(mockIpc);
      const bridge = new IpcBridge();
      const handler = jest.fn();
      const unsub = bridge.once('ch', handler);

      expect(typeof unsub).toBe('function');
      expect(mockIpc.once).toHaveBeenCalledWith('ch', expect.any(Function));
      expect(bridge.listeners.get('ch')).toHaveLength(1);
    });

    it('wrapped handler calls original, logs, and auto-removes from tracking', () => {
      installIpc(mockIpc);
      const bridge = new IpcBridge();
      const handler = jest.fn();
      bridge.once('ch', handler);

      const wrappedHandler = mockIpc.once.mock.calls[0][1];
      wrappedHandler('data');

      expect(handler).toHaveBeenCalledWith('data');
      expect(mockLog.debug).toHaveBeenCalledWith('received (once)', { channel: 'ch' });
      // After firing, the listener should be removed from tracking
      expect(bridge.listeners.has('ch')).toBe(false);
    });

    it('returns noop when IPC unavailable', () => {
      removeIpc();
      const bridge = new IpcBridge();
      const unsub = bridge.once('ch', jest.fn());
      expect(typeof unsub).toBe('function');
      unsub();
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('cannot register once listener'));
    });

    it('returns noop on registration error', () => {
      installIpc(mockIpc);
      mockIpc.once.mockImplementation(() => { throw new Error('fail'); });
      const bridge = new IpcBridge();
      const unsub = bridge.once('ch', jest.fn());
      expect(typeof unsub).toBe('function');
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('failed to register once listener'),
        expect.any(Object)
      );
    });
  });

  // =========================================================================
  // removeListener()
  // =========================================================================

  describe('removeListener()', () => {
    it('removes listener from IPC and tracking', () => {
      installIpc(mockIpc);
      const bridge = new IpcBridge();
      bridge.on('ch', jest.fn());
      const tracked = bridge.listeners.get('ch')[0];

      bridge.removeListener('ch', tracked);

      expect(mockIpc.removeListener).toHaveBeenCalledWith('ch', tracked);
      expect(bridge.listeners.has('ch')).toBe(false);
    });

    it('does nothing when IPC unavailable', () => {
      removeIpc();
      const bridge = new IpcBridge();
      // Should not throw
      bridge.removeListener('ch', jest.fn());
    });

    it('handles unknown handler gracefully', () => {
      installIpc(mockIpc);
      const bridge = new IpcBridge();
      bridge.on('ch', jest.fn());
      // Remove a handler that isn't tracked
      bridge.removeListener('ch', jest.fn());
      // Channel still exists because original is still tracked
      expect(bridge.listeners.get('ch')).toHaveLength(1);
    });

    it('handles unknown channel gracefully', () => {
      installIpc(mockIpc);
      const bridge = new IpcBridge();
      // No listeners registered, removeListener should not throw
      bridge.removeListener('nonexistent', jest.fn());
    });

    it('returns on error without throwing', () => {
      installIpc(mockIpc);
      mockIpc.removeListener.mockImplementation(() => { throw new Error('fail'); });
      const bridge = new IpcBridge();
      bridge.on('ch', jest.fn());
      const tracked = bridge.listeners.get('ch')[0];
      // Should not throw
      bridge.removeListener('ch', tracked);
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('failed to remove listener'),
        expect.any(Object)
      );
    });
  });

  // =========================================================================
  // removeAllListeners()
  // =========================================================================

  describe('removeAllListeners()', () => {
    it('removes all listeners for a channel', () => {
      installIpc(mockIpc);
      const bridge = new IpcBridge();
      bridge.on('ch', jest.fn());
      bridge.on('ch', jest.fn());
      expect(bridge.listeners.get('ch')).toHaveLength(2);

      bridge.removeAllListeners('ch');

      expect(bridge.listeners.has('ch')).toBe(false);
      expect(mockIpc.removeListener).toHaveBeenCalledTimes(2);
    });

    it('does nothing for unknown channel', () => {
      installIpc(mockIpc);
      const bridge = new IpcBridge();
      // Should not throw
      bridge.removeAllListeners('nonexistent');
    });
  });

  // =========================================================================
  // isAvailable()
  // =========================================================================

  describe('isAvailable()', () => {
    it('returns true when IPC exists', () => {
      installIpc(mockIpc);
      const bridge = new IpcBridge();
      expect(bridge.isAvailable()).toBe(true);
    });

    it('returns false when IPC absent', () => {
      removeIpc();
      const bridge = new IpcBridge();
      expect(bridge.isAvailable()).toBe(false);
    });
  });

  // =========================================================================
  // flushQueue()
  // =========================================================================

  describe('flushQueue()', () => {
    it('flushes queued messages when IPC becomes available', () => {
      removeIpc();
      const bridge = new IpcBridge();
      bridge.send('ch1', 'p1');
      bridge.send('ch2', 'p2');
      expect(bridge.messageQueue).toHaveLength(2);

      // Simulate IPC becoming available
      bridge.ipc = mockIpc;
      const flushed = bridge.flushQueue();

      expect(flushed).toBe(2);
      expect(mockIpc.send).toHaveBeenCalledTimes(2);
      expect(mockIpc.send).toHaveBeenCalledWith('ch1', 'p1');
      expect(mockIpc.send).toHaveBeenCalledWith('ch2', 'p2');
      expect(bridge.messageQueue).toEqual([]);
      expect(bridge.isReady).toBe(true);
    });

    it('returns 0 when queue is empty', () => {
      installIpc(mockIpc);
      const bridge = new IpcBridge();
      expect(bridge.flushQueue()).toBe(0);
    });

    it('returns 0 when IPC still unavailable', () => {
      removeIpc();
      const bridge = new IpcBridge();
      bridge.send('ch', 'p');
      expect(bridge.flushQueue()).toBe(0);
      expect(bridge.messageQueue).toHaveLength(1);
    });
  });

  // =========================================================================
  // getStats()
  // =========================================================================

  describe('getStats()', () => {
    it('returns frozen stats object', () => {
      installIpc(mockIpc);
      const bridge = new IpcBridge({ context: 'main' });
      bridge.on('ch1', jest.fn());
      bridge.on('ch1', jest.fn());
      bridge.on('ch2', jest.fn());

      const stats = bridge.getStats();

      expect(Object.isFrozen(stats)).toBe(true);
      expect(stats).toEqual({
        context: 'main',
        isReady: true,
        isAvailable: true,
        queuedMessages: 0,
        activeChannels: 2,
        totalListeners: 3,
      });
    });

    it('counts queued messages', () => {
      removeIpc();
      const bridge = new IpcBridge();
      bridge.send('ch', 'p1');
      bridge.send('ch', 'p2');
      const stats = bridge.getStats();
      expect(stats.queuedMessages).toBe(2);
      expect(stats.isReady).toBe(false);
      expect(stats.isAvailable).toBe(false);
    });
  });

  // =========================================================================
  // destroy()
  // =========================================================================

  describe('destroy()', () => {
    it('cleans up all resources', () => {
      installIpc(mockIpc);
      const bridge = new IpcBridge();
      bridge.on('ch1', jest.fn());
      bridge.on('ch2', jest.fn());
      bridge.send('ch3', 'queued'); // won't queue since IPC available

      bridge.destroy();

      expect(bridge.ipc).toBeNull();
      expect(bridge.isReady).toBe(false);
      expect(bridge.listeners.size).toBe(0);
      expect(bridge.messageQueue).toEqual([]);
      expect(mockIpc.removeListener).toHaveBeenCalledTimes(2);
      expect(mockLog.info).toHaveBeenCalledWith('destroyed');
    });

    it('handles destroy when IPC was never available', () => {
      removeIpc();
      const bridge = new IpcBridge();
      bridge.send('ch', 'p');
      bridge.destroy();
      expect(bridge.messageQueue).toEqual([]);
      expect(bridge.isReady).toBe(false);
    });
  });

  // =========================================================================
  // _getIpcAPI() (via constructor)
  // =========================================================================

  describe('_getIpcAPI()', () => {
    it('returns ipc from window.aether.ipc', () => {
      installIpc(mockIpc);
      const bridge = new IpcBridge();
      expect(bridge.ipc).toBe(mockIpc);
    });

    it('returns null when window.aether missing', () => {
      removeIpc();
      const bridge = new IpcBridge();
      expect(bridge.ipc).toBeNull();
    });

    it('returns null when window.aether exists but ipc is missing', () => {
      window.aether = {};
      const bridge = new IpcBridge();
      expect(bridge.ipc).toBeNull();
    });
  });

  // =========================================================================
  // _queueMessage() (via send without IPC)
  // =========================================================================

  describe('_queueMessage()', () => {
    it('queues message with channel and payload', () => {
      removeIpc();
      const bridge = new IpcBridge();
      bridge.send('event:test', { key: 'val' });
      expect(bridge.messageQueue).toEqual([
        { channel: 'event:test', payload: { key: 'val' } },
      ]);
      expect(mockLog.debug).toHaveBeenCalledWith(expect.stringContaining('queued message'));
    });
  });

  // =========================================================================
  // Integration: unsubscribe functions
  // =========================================================================

  describe('unsubscribe integration', () => {
    it('on() unsubscribe removes the listener', () => {
      installIpc(mockIpc);
      const bridge = new IpcBridge();
      const unsub = bridge.on('ch', jest.fn());
      expect(bridge.listeners.get('ch')).toHaveLength(1);
      unsub();
      expect(bridge.listeners.has('ch')).toBe(false);
    });

    it('once() unsubscribe removes the listener before it fires', () => {
      installIpc(mockIpc);
      const bridge = new IpcBridge();
      const unsub = bridge.once('ch', jest.fn());
      expect(bridge.listeners.get('ch')).toHaveLength(1);
      unsub();
      expect(bridge.listeners.has('ch')).toBe(false);
    });
  });

  // =========================================================================
  // Window global export
  // =========================================================================

  describe('window global', () => {
    it('exports IpcBridge to window', () => {
      expect(window.IpcBridge).toBe(IpcBridge);
    });
  });
});
