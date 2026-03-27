'use strict';

jest.mock('../../../../../src/core/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
  })
}));

const { ConnectionStateTracker } = require('../../../../../src/domain/chat/services/ConnectionStateTracker');

function createMockConnection() {
  const handlers = {};
  return {
    on: jest.fn((event, handler) => { handlers[event] = handler; }),
    removeListener: jest.fn(),
    getStats: jest.fn(() => ({ connected: false })),
    _handlers: handlers,
    _emit: (event, ...args) => { if (handlers[event]) handlers[event](...args); }
  };
}

describe('ConnectionStateTracker', () => {
  let tracker;

  beforeEach(() => {
    tracker = new ConnectionStateTracker();
  });

  afterEach(() => {
    tracker.cleanup();
  });

  describe('constructor', () => {
    it('starts disconnected', () => {
      expect(tracker.isConnected()).toBe(false);
      expect(tracker.getLastReason()).toBeNull();
      expect(tracker.getLastError()).toBeNull();
    });

    it('accepts onStateChange callback', () => {
      const cb = jest.fn();
      const t = new ConnectionStateTracker({ onStateChange: cb });
      expect(t.getStats().hasCallback).toBe(true);
      t.cleanup();
    });
  });

  describe('setup()', () => {
    it('registers event handlers on connection', () => {
      const conn = createMockConnection();
      tracker.setup(conn);
      expect(conn.on).toHaveBeenCalledWith('open', expect.any(Function));
      expect(conn.on).toHaveBeenCalledWith('close', expect.any(Function));
      expect(conn.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('throws on null connection', () => {
      expect(() => tracker.setup(null)).toThrow('CONTRACT VIOLATION');
    });

    it('throws on connection without .on()', () => {
      expect(() => tracker.setup({})).toThrow('.on() method');
    });

    it('syncs initial state from getStats()', () => {
      const conn = createMockConnection();
      conn.getStats.mockReturnValue({ connected: true });
      tracker.setup(conn);
      expect(tracker.isConnected()).toBe(true);
    });

    it('accepts onStateChange via setup()', () => {
      const cb = jest.fn();
      const conn = createMockConnection();
      tracker.setup(conn, cb);
      conn._emit('open');
      expect(cb).toHaveBeenCalledWith(expect.objectContaining({
        isConnected: true,
        previousState: false,
        reason: 'websocket-open'
      }));
    });
  });

  describe('connection events', () => {
    let conn, cb;

    beforeEach(() => {
      conn = createMockConnection();
      cb = jest.fn();
      tracker.setup(conn, cb);
    });

    it('open → connected', () => {
      conn._emit('open');
      expect(tracker.isConnected()).toBe(true);
      expect(tracker.getLastReason()).toBe('websocket-open');
    });

    it('close → disconnected', () => {
      conn._emit('open');
      conn._emit('close');
      expect(tracker.isConnected()).toBe(false);
      expect(tracker.getLastReason()).toBe('websocket-close');
    });

    it('error → disconnected with error', () => {
      conn._emit('open');
      const err = new Error('connection lost');
      conn._emit('error', err);
      expect(tracker.isConnected()).toBe(false);
      expect(tracker.getLastError()).toBe(err);
      expect(tracker.getLastReason()).toBe('websocket-error');
    });

    it('does not fire callback when state unchanged', () => {
      cb.mockClear();
      conn._emit('close'); // already disconnected
      expect(cb).not.toHaveBeenCalled();
    });

    it('handles callback errors gracefully', () => {
      cb.mockImplementation(() => { throw new Error('cb boom'); });
      expect(() => conn._emit('open')).not.toThrow();
    });
  });

  describe('cleanup()', () => {
    it('removes all event listeners', () => {
      const conn = createMockConnection();
      tracker.setup(conn);
      tracker.cleanup();
      expect(conn.removeListener).toHaveBeenCalledTimes(3);
    });

    it('is safe to call without setup', () => {
      expect(() => tracker.cleanup()).not.toThrow();
    });

    it('is safe to call twice', () => {
      const conn = createMockConnection();
      tracker.setup(conn);
      tracker.cleanup();
      expect(() => tracker.cleanup()).not.toThrow();
    });
  });

  describe('getState()', () => {
    it('returns full state', () => {
      const state = tracker.getState();
      expect(state).toHaveProperty('isConnected');
      expect(state).toHaveProperty('lastReason');
      expect(state).toHaveProperty('lastError');
      expect(state).toHaveProperty('hasConnection');
      expect(state).toHaveProperty('handlerCount');
    });
  });

  describe('setStateChangeCallback()', () => {
    it('sets callback', () => {
      tracker.setStateChangeCallback(jest.fn());
      expect(tracker.getStats().hasCallback).toBe(true);
    });

    it('throws on non-function', () => {
      expect(() => tracker.setStateChangeCallback('not fn')).toThrow('must be a function');
    });

    it('allows null to clear callback', () => {
      tracker.setStateChangeCallback(null);
      expect(tracker.getStats().hasCallback).toBe(false);
    });
  });

  describe('getStats()', () => {
    it('returns accurate stats', () => {
      const conn = createMockConnection();
      tracker.setup(conn);
      const stats = tracker.getStats();
      expect(stats.hasConnection).toBe(true);
      expect(stats.handlerCount).toBe(3);
    });
  });
});
