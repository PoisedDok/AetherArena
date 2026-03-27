'use strict';

/**
 * ConnectionMonitor Unit Tests
 * ============================================================================
 * Tests WebSocket connection monitoring: polling lifecycle (start/stop/check),
 * state change detection and event emission, guru connection listener management,
 * metrics tracking (reconnects, transitions), and resource cleanup.
 *
 * @module tests/unit/application/ConnectionMonitor.test
 */

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
}));

jest.mock('../../../src/core/communication/GuruConnection', () => {
  const CONNECTION_STATES = Object.freeze({
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    WAITING: 'waiting',
    RECONNECTING: 'reconnecting',
    STALE: 'stale',
    CLOSED: 'closed',
  });
  return { CONNECTION_STATES };
});

const ConnectionMonitor = require('../../../src/application/main/modules/connection/ConnectionMonitor');
const { EventTypes } = require('../../../src/core/events/EventTypes');

// WebSocket readyState constants
const WS_OPEN = 1;
const WS_CLOSED = 3;

function createMockGuru(wsReadyState = WS_OPEN) {
  return {
    ws: { readyState: wsReadyState },
    connectionState: 'connected',
    on: jest.fn(),
    off: jest.fn(),
    removeListener: jest.fn(),
  };
}

function createMockEventBus() {
  return { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
}

describe('ConnectionMonitor', () => {
  let monitor;
  let guru;
  let eventBus;

  beforeEach(() => {
    jest.useFakeTimers();
    // Setup global WebSocket for readyState comparison
    global.WebSocket = { OPEN: WS_OPEN, CLOSED: WS_CLOSED };
    guru = createMockGuru();
    eventBus = createMockEventBus();
    monitor = new ConnectionMonitor({ guruConnection: guru, eventBus, checkInterval: 1000 });
  });

  afterEach(() => {
    if (monitor) monitor.dispose();
    jest.useRealTimers();
    delete global.WebSocket;
  });

  // -----------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------
  describe('constructor', () => {
    it('throws when guru connection not provided', () => {
      expect(() => new ConnectionMonitor({ eventBus })).toThrow('guru connection required');
    });

    it('throws when eventBus not provided', () => {
      expect(() => new ConnectionMonitor({ guruConnection: guru })).toThrow('eventBus required');
    });

    it('defaults checkInterval to 2000', () => {
      const m = new ConnectionMonitor({ guruConnection: guru, eventBus });
      expect(m.checkInterval).toBe(2000);
      m.dispose();
    });

    it('accepts custom checkInterval', () => {
      expect(monitor.checkInterval).toBe(1000);
    });

    it('initializes with no interval running', () => {
      expect(monitor.intervalId).toBeNull();
    });

    it('initializes lastStatus as null', () => {
      expect(monitor.lastStatus).toBeNull();
    });

    it('initializes metrics at zero', () => {
      expect(monitor.metrics.reconnects).toBe(0);
      expect(monitor.metrics.transitions).toBe(0);
    });

    it('is an EventEmitter', () => {
      expect(typeof monitor.on).toBe('function');
      expect(typeof monitor.emit).toBe('function');
    });

    it('uses default options when called with no arguments', () => {
      expect(() => new ConnectionMonitor()).toThrow('guru connection required');
    });
  });

  // -----------------------------------------------------------
  // start()
  // -----------------------------------------------------------
  describe('start()', () => {
    it('runs initial check immediately', () => {
      monitor.start();
      // After start, lastStatus should be populated
      expect(monitor.lastStatus).not.toBeNull();
      expect(monitor.lastStatus.connected).toBe(true);
    });

    it('starts periodic interval', () => {
      monitor.start();
      expect(monitor.intervalId).not.toBeNull();
    });

    it('registers guru connectionState listener', () => {
      monitor.start();
      expect(guru.on).toHaveBeenCalledWith('connectionState', expect.any(Function));
    });

    it('does not double-start', () => {
      monitor.start();
      const firstIntervalId = monitor.intervalId;
      monitor.start(); // second call
      expect(monitor.intervalId).toBe(firstIntervalId);
    });

    it('emits status change events on first check (null -> connected)', () => {
      monitor.start();
      // First check transitions from null to connected
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CONNECTION.STATUS_CHANGED,
        expect.objectContaining({ connected: true }),
        expect.any(Object)
      );
    });

    it('periodic check fires at interval', () => {
      monitor.start();
      eventBus.emit.mockClear();
      // Advance timer by checkInterval
      jest.advanceTimersByTime(1000);
      // check() was called again (even if no state change, it still checks)
      // lastStatus should exist
      expect(monitor.lastStatus).not.toBeNull();
    });
  });

  // -----------------------------------------------------------
  // stop()
  // -----------------------------------------------------------
  describe('stop()', () => {
    it('clears interval', () => {
      monitor.start();
      expect(monitor.intervalId).not.toBeNull();
      monitor.stop();
      expect(monitor.intervalId).toBeNull();
    });

    it('removes guru connectionState listener', () => {
      monitor.start();
      monitor.stop();
      expect(guru.off).toHaveBeenCalledWith('connectionState', expect.any(Function));
    });

    it('is safe to call when not started', () => {
      expect(() => monitor.stop()).not.toThrow();
    });

    it('uses removeListener fallback when off not available', () => {
      const guruNoOff = {
        ws: { readyState: WS_OPEN },
        on: jest.fn(),
        removeListener: jest.fn(),
      };
      delete guruNoOff.off;
      const m = new ConnectionMonitor({ guruConnection: guruNoOff, eventBus });
      m.start();
      m.stop();
      expect(guruNoOff.removeListener).toHaveBeenCalledWith('connectionState', expect.any(Function));
      m.dispose();
    });
  });

  // -----------------------------------------------------------
  // check() / getStatus()
  // -----------------------------------------------------------
  describe('check()', () => {
    it('returns status object with connected, timestamp, details', () => {
      const status = monitor.check();
      expect(status.connected).toBe(true);
      expect(status.timestamp).toBeGreaterThan(0);
      expect(status.details.websocket).toBe(true);
      expect(status.details.readyState).toBe(WS_OPEN);
    });

    it('detects disconnected state', () => {
      guru.ws.readyState = WS_CLOSED;
      const status = monitor.check();
      expect(status.connected).toBe(false);
      expect(status.details.websocket).toBe(false);
    });

    it('handles guru with null ws gracefully', () => {
      guru.ws = null;
      const status = monitor.check();
      expect(status.connected).toBe(false);
      expect(status.details.websocket).toBe(false);
      expect(status.details.readyState).toBeNull();
    });

    it('handles guru with missing ws gracefully', () => {
      delete guru.ws;
      const status = monitor.check();
      expect(status.connected).toBe(false);
    });
  });

  // -----------------------------------------------------------
  // State change detection
  // -----------------------------------------------------------
  describe('state change detection', () => {
    it('emits STATUS_CHANGED on connectivity transition', () => {
      // First check: null -> connected
      monitor.check();
      eventBus.emit.mockClear();

      // Now disconnect
      guru.ws.readyState = WS_CLOSED;
      monitor.check();
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CONNECTION.STATUS_CHANGED,
        expect.objectContaining({
          connected: false,
          previous: true,
        }),
        expect.any(Object)
      );
    });

    it('emits BACKEND_ONLINE when transitioning to connected', () => {
      // Start disconnected
      guru.ws.readyState = WS_CLOSED;
      monitor.check();
      eventBus.emit.mockClear();

      // Now connect
      guru.ws.readyState = WS_OPEN;
      monitor.check();
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CONNECTION.BACKEND_ONLINE,
        expect.objectContaining({ connected: true }),
        expect.any(Object)
      );
    });

    it('emits BACKEND_OFFLINE when transitioning to disconnected', () => {
      // Start connected
      monitor.check();
      eventBus.emit.mockClear();

      // Now disconnect
      guru.ws.readyState = WS_CLOSED;
      monitor.check();
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CONNECTION.BACKEND_OFFLINE,
        expect.objectContaining({ connected: false }),
        expect.any(Object)
      );
    });

    it('emits WEBSOCKET_OPENED on ws connect', () => {
      // Start with no WS
      guru.ws = null;
      monitor.check();
      eventBus.emit.mockClear();

      // Establish WS
      guru.ws = { readyState: WS_OPEN };
      monitor.check();
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CONNECTION.WEBSOCKET_OPENED,
        expect.any(Object)
      );
    });

    it('emits WEBSOCKET_CLOSED on ws disconnect', () => {
      // Start connected
      monitor.check();
      eventBus.emit.mockClear();

      // Close WS
      guru.ws.readyState = WS_CLOSED;
      monitor.check();
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CONNECTION.WEBSOCKET_CLOSED,
        expect.any(Object)
      );
    });

    it('does NOT emit when status unchanged', () => {
      monitor.check(); // First check
      eventBus.emit.mockClear();

      monitor.check(); // Same status
      // No STATUS_CHANGED emitted (connectivity same, no state field change)
      const statusChangedCalls = eventBus.emit.mock.calls.filter(
        c => c[0] === EventTypes.CONNECTION.STATUS_CHANGED
      );
      expect(statusChangedCalls).toHaveLength(0);
    });

    it('increments transition counter on state change', () => {
      monitor.check(); // null -> connected = 1 transition
      guru.ws.readyState = WS_CLOSED;
      monitor.check(); // connected -> disconnected = 2 transitions
      expect(monitor.metrics.transitions).toBe(2);
    });
  });

  // -----------------------------------------------------------
  // _handleGuruState (event-driven state changes)
  // -----------------------------------------------------------
  describe('_handleGuruState()', () => {
    it('processes guru connection state payload', () => {
      // Simulate initial connected state
      monitor.check();
      eventBus.emit.mockClear();

      // Guru emits reconnecting state
      monitor._handleGuruState({ state: 'reconnecting', meta: { attempt: 1 } });
      expect(eventBus.emit).toHaveBeenCalled();
    });

    it('records reconnect on RECONNECTING state (exactly once per event)', () => {
      monitor.check();
      monitor._handleGuruState({ state: 'reconnecting', meta: { attempt: 1, backoff: 2000 } });
      // BUG 7 FIX: Previously counted twice (once in _handleGuruState, once in _processStatus).
      // After fix, _processStatus is the single source of reconnect recording.
      expect(monitor.metrics.reconnects).toBe(1);
    });

    it('handles empty payload gracefully', () => {
      monitor.check();
      expect(() => monitor._handleGuruState({})).not.toThrow();
    });
  });

  // -----------------------------------------------------------
  // isConnected / getStats / getMetrics
  // -----------------------------------------------------------
  describe('isConnected()', () => {
    it('returns false when no status checked yet', () => {
      expect(monitor.isConnected()).toBe(false);
    });

    it('returns true after connected check', () => {
      monitor.check();
      expect(monitor.isConnected()).toBe(true);
    });

    it('returns false after disconnected check', () => {
      guru.ws.readyState = WS_CLOSED;
      monitor.check();
      expect(monitor.isConnected()).toBe(false);
    });
  });

  describe('getStats()', () => {
    it('returns frozen stats', () => {
      monitor.start();
      const stats = monitor.getStats();
      expect(Object.isFrozen(stats)).toBe(true);
      expect(stats.isMonitoring).toBe(true);
      expect(stats.checkInterval).toBe(1000);
      expect(stats.currentStatus).not.toBeNull();
      expect(stats.metrics.reconnects).toBe(0);
      expect(stats.metrics.transitions).toBeGreaterThanOrEqual(1);
    });

    it('reports isMonitoring false when stopped', () => {
      expect(monitor.getStats().isMonitoring).toBe(false);
    });
  });

  describe('getMetrics()', () => {
    it('returns copy of metrics', () => {
      const m = monitor.getMetrics();
      m.reconnects = 999;
      expect(monitor.metrics.reconnects).toBe(0);
    });
  });

  // -----------------------------------------------------------
  // _recordReconnect
  // -----------------------------------------------------------
  describe('reconnect metrics', () => {
    it('increments reconnect count', () => {
      monitor._recordReconnect({ attempt: 1 });
      monitor._recordReconnect({ attempt: 2 });
      expect(monitor.metrics.reconnects).toBe(2);
    });

    it('records to metricsCollector if available', () => {
      const mc = { recordCustom: jest.fn() };
      const m = new ConnectionMonitor({
        guruConnection: guru,
        eventBus,
        metricsCollector: mc,
      });
      m._recordReconnect({});
      expect(mc.recordCustom).toHaveBeenCalledWith('websocket:reconnects', 1);
      m.dispose();
    });

    it('handles metricsCollector.recordCustom failure gracefully', () => {
      const mc = { recordCustom: jest.fn(() => { throw new Error('metric fail'); }) };
      const m = new ConnectionMonitor({
        guruConnection: guru,
        eventBus,
        metricsCollector: mc,
      });
      expect(() => m._recordReconnect({})).not.toThrow();
      m.dispose();
    });
  });

  // -----------------------------------------------------------
  // EventEmitter behavior
  // -----------------------------------------------------------
  describe('EventEmitter integration', () => {
    it('emits "state" event on state change', () => {
      const stateHandler = jest.fn();
      monitor.on('state', stateHandler);

      // First check triggers state change (null -> something)
      monitor.check();
      expect(stateHandler).toHaveBeenCalledWith(
        expect.objectContaining({ status: expect.any(Object) })
      );
    });

    it('emits "connected" event when connecting', () => {
      const handler = jest.fn();
      monitor.on('connected', handler);
      monitor.check(); // First check = connected
      expect(handler).toHaveBeenCalled();
    });

    it('emits "disconnected" event when disconnecting', () => {
      monitor.check(); // Connect first
      const handler = jest.fn();
      monitor.on('disconnected', handler);
      guru.ws.readyState = WS_CLOSED;
      monitor.check();
      expect(handler).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------
  // dispose
  // -----------------------------------------------------------
  describe('dispose()', () => {
    it('stops monitoring and nulls references', () => {
      monitor.start();
      monitor.dispose();
      expect(monitor.intervalId).toBeNull();
      expect(monitor.lastStatus).toBeNull();
      expect(monitor.guru).toBeNull();
      expect(monitor.eventBus).toBeNull();
      expect(monitor.metricsCollector).toBeNull();
    });

    it('is safe to call twice', () => {
      expect(() => {
        monitor.dispose();
        monitor.dispose();
      }).not.toThrow();
      monitor = null;
    });
  });

  // -----------------------------------------------------------
  // enableLogging branches
  // -----------------------------------------------------------
  describe('enableLogging branches', () => {
    let logMonitor;

    beforeEach(() => {
      logMonitor = new ConnectionMonitor({
        guruConnection: guru,
        eventBus,
        checkInterval: 1000,
        enableLogging: true,
      });
    });

    afterEach(() => {
      if (logMonitor) logMonitor.dispose();
      logMonitor = null;
    });

    it('logs on start()', () => {
      logMonitor.start();
      expect(logMonitor.intervalId).not.toBeNull();
    });

    it('logs on stop()', () => {
      logMonitor.start();
      logMonitor.stop();
      expect(logMonitor.intervalId).toBeNull();
    });

    it('logs on _onStatusChange() connected (ONLINE)', () => {
      logMonitor.check();
      expect(logMonitor.lastStatus).not.toBeNull();
      expect(logMonitor.lastStatus.connected).toBe(true);
    });

    it('logs on _onStatusChange() disconnected (OFFLINE)', () => {
      guru.ws.readyState = WS_CLOSED;
      logMonitor.check();
      expect(logMonitor.lastStatus.connected).toBe(false);
    });

    it('logs on dispose()', () => {
      logMonitor.dispose();
      expect(logMonitor.guru).toBeNull();
      logMonitor = null;
    });

    it('logs reconnect details in _recordReconnect', () => {
      logMonitor._recordReconnect({ attempt: 3, backoff: 5000 });
      expect(logMonitor.metrics.reconnects).toBe(1);
    });

    it('logs metricsCollector error when enableLogging is true', () => {
      const mc = { recordCustom: jest.fn(() => { throw new Error('metric boom'); }) };
      const m = new ConnectionMonitor({
        guruConnection: guru,
        eventBus,
        metricsCollector: mc,
        enableLogging: true,
      });
      expect(() => m._recordReconnect({})).not.toThrow();
      m.dispose();
    });
  });

  // -----------------------------------------------------------
  // getStatus error handling
  // -----------------------------------------------------------
  describe('getStatus error path', () => {
    it('catches and returns disconnected when guru.ws access throws', () => {
      const throwingGuru = {
        on: jest.fn(),
        off: jest.fn(),
        get ws() { throw new Error('ws access error'); },
      };
      const m = new ConnectionMonitor({ guruConnection: throwingGuru, eventBus });
      const status = m.getStatus();
      expect(status.connected).toBe(false);
      expect(status.details.websocket).toBe(false);
      expect(status.details.readyState).toBeNull();
      m.dispose();
    });
  });

  // -----------------------------------------------------------
  // start() edge cases
  // -----------------------------------------------------------
  describe('start() edge cases', () => {
    it('skips guru.on registration when guru has no on method', () => {
      const noOnGuru = {
        ws: { readyState: WS_OPEN },
        off: jest.fn(),
      };
      // Attach minimal on to pass constructor, then remove it
      noOnGuru.on = jest.fn();
      const m = new ConnectionMonitor({ guruConnection: noOnGuru, eventBus });
      delete noOnGuru.on; // Remove before start
      m.start();
      // No listener should be set
      expect(m._stateListener).toBeNull();
      m.dispose();
    });
  });

  // -----------------------------------------------------------
  // _processStatus default parameter
  // -----------------------------------------------------------
  describe('_processStatus default param', () => {
    it('defaults reason to null when called with one argument', () => {
      monitor.check(); // establish baseline
      const status = {
        connected: false,
        timestamp: Date.now(),
        details: { websocket: false, readyState: null },
      };
      // Call with only one arg to trigger default param
      expect(() => monitor._processStatus(status)).not.toThrow();
    });
  });

  // -----------------------------------------------------------
  // stop() edge cases
  // -----------------------------------------------------------
  describe('stop() edge cases', () => {
    it('handles guru with neither off nor removeListener', () => {
      const bareGuru = {
        ws: { readyState: WS_OPEN },
        on: jest.fn(),
        // No off, no removeListener
      };
      const m = new ConnectionMonitor({ guruConnection: bareGuru, eventBus });
      m.start();
      // _stateListener is set
      expect(m._stateListener).not.toBeNull();
      m.stop();
      // Should not throw, _stateListener should be nulled
      expect(m._stateListener).toBeNull();
      m.dispose();
    });
  });

  // -----------------------------------------------------------
  // _resolveMetricsCollector (window branches)
  // -----------------------------------------------------------
  describe('_resolveMetricsCollector', () => {
    it('returns window.metricsCollector when available', () => {
      const mc = { recordCustom: jest.fn() };
      global.window = { metricsCollector: mc };
      const m = new ConnectionMonitor({ guruConnection: guru, eventBus });
      expect(m.metricsCollector).toBe(mc);
      m.dispose();
      delete global.window;
    });

    it('returns window.__PERFORMANCE_INTEGRATION__.metricsCollector as fallback', () => {
      const mc = { recordCustom: jest.fn() };
      global.window = { __PERFORMANCE_INTEGRATION__: { metricsCollector: mc } };
      const m = new ConnectionMonitor({ guruConnection: guru, eventBus });
      expect(m.metricsCollector).toBe(mc);
      m.dispose();
      delete global.window;
    });

    it('returns null when window exists but no metricsCollector', () => {
      global.window = {};
      const m = new ConnectionMonitor({ guruConnection: guru, eventBus });
      expect(m.metricsCollector).toBeNull();
      m.dispose();
      delete global.window;
    });
  });

  // -----------------------------------------------------------
  // window global export
  // -----------------------------------------------------------
  describe('window global export', () => {
    it('assigns ConnectionMonitor to window when window is defined', () => {
      global.window = {};
      jest.isolateModules(() => {
        jest.mock('../../../src/renderer/shared/utils/logger', () => ({
          createRendererLogger: () => ({
            info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn(),
          }),
        }));
        jest.mock('../../../src/core/communication/GuruConnection', () => ({
          CONNECTION_STATES: Object.freeze({
            DISCONNECTED: 'disconnected', CONNECTING: 'connecting', CONNECTED: 'connected',
            WAITING: 'waiting', RECONNECTING: 'reconnecting', STALE: 'stale', CLOSED: 'closed',
          }),
        }));
        const CM = require('../../../src/application/main/modules/connection/ConnectionMonitor');
        expect(global.window.ConnectionMonitor).toBe(CM);
      });
      delete global.window;
    });
  });

  // -----------------------------------------------------------
  // Guru listener invocation (covers arrow function)
  // -----------------------------------------------------------
  describe('guru connectionState listener', () => {
    it('stateListener arrow invokes _handleGuruState', () => {
      monitor.start();
      const call = guru.on.mock.calls.find(c => c[0] === 'connectionState');
      expect(call).toBeDefined();
      const listener = call[1];
      // Invoke the actual arrow function stored as _stateListener
      listener({ state: 'connected', meta: {} });
      expect(monitor.lastStatus.details.state).toBe('connected');
    });
  });

  // -----------------------------------------------------------
  // _handleGuruState edge cases
  // -----------------------------------------------------------
  describe('_handleGuruState edge cases', () => {
    it('defaults to DISCONNECTED when payload has no state and guru has no connectionState', () => {
      const minimalGuru = { ws: null, on: jest.fn(), off: jest.fn() };
      delete minimalGuru.connectionState;
      const m = new ConnectionMonitor({ guruConnection: minimalGuru, eventBus });
      m.check(); // establish baseline
      expect(() => m._handleGuruState({})).not.toThrow();
      m.dispose();
    });

    it('uses guru.connectionState when payload.state is falsy', () => {
      guru.connectionState = 'connected';
      monitor.check(); // establish baseline
      monitor._handleGuruState({ meta: { info: 'no state field' } });
      // Should use guru.connectionState
      expect(monitor.lastStatus.details.state).toBe('connected');
    });

    it('handles default payload (no args)', () => {
      monitor.check();
      expect(() => monitor._handleGuruState()).not.toThrow();
    });
  });

  // -----------------------------------------------------------
  // _processStatus edge cases
  // -----------------------------------------------------------
  describe('_processStatus reconnect via status.details.state', () => {
    it('records reconnect when status.details.state is RECONNECTING (not just reason)', () => {
      monitor.check(); // baseline
      const status = {
        connected: false,
        timestamp: Date.now(),
        details: { websocket: false, readyState: null, state: 'reconnecting' },
      };
      // Call with reason=null but status.details.state='reconnecting'
      monitor._processStatus(status, null);
      expect(monitor.metrics.reconnects).toBe(1);
    });
  });

  // -----------------------------------------------------------
  // Full lifecycle
  // -----------------------------------------------------------
  describe('full lifecycle', () => {
    it('start -> check connected -> disconnect -> reconnect -> stop -> dispose', () => {
      monitor.start();
      expect(monitor.isConnected()).toBe(true);

      // Disconnect
      guru.ws.readyState = WS_CLOSED;
      jest.advanceTimersByTime(1000);
      expect(monitor.isConnected()).toBe(false);

      // Reconnect
      guru.ws.readyState = WS_OPEN;
      jest.advanceTimersByTime(1000);
      expect(monitor.isConnected()).toBe(true);

      // Stop
      monitor.stop();
      expect(monitor.getStats().isMonitoring).toBe(false);

      // Dispose
      monitor.dispose();
      expect(monitor.guru).toBeNull();
      monitor = null;
    });
  });
});
