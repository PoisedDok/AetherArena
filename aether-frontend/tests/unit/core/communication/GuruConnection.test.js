'use strict';

/**
 * GuruConnection Unit Tests
 * Tests WebSocket lifecycle, reconnect timer tracking, state transitions,
 * message routing, and resource cleanup.
 */

const GuruConnection = require('../../../../src/core/communication/GuruConnection');
const { CONNECTION_STATES } = GuruConnection;

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.binaryType = '';
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    this._sent = [];
  }

  send(data) {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this._sent.push(data);
  }

  close(code, reason) {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose({ code: code || 1000, reason: reason || '' });
    }
  }

  // Test helpers
  _simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    if (this.onopen) this.onopen();
  }

  _simulateMessage(data) {
    if (this.onmessage) {
      this.onmessage({ data: typeof data === 'string' ? data : JSON.stringify(data) });
    }
  }

  _simulateError(error) {
    if (this.onerror) this.onerror(error || new Error('mock ws error'));
  }

  _simulateClose(code = 1006, reason = '') {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) this.onclose({ code, reason });
  }
}

// Expose OPEN/CLOSED on globalThis for GuruConnection's `WebSocket.OPEN` references
global.WebSocket = MockWebSocket;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createConnection(overrides = {}) {
  return new GuruConnection({
    url: 'ws://localhost:8765/ws',
    deferConnect: true,
    WebSocketClass: MockWebSocket,
    reconnectDelay: 100,
    pingInterval: 5000,
    healthInterval: 1000,
    maxReconnectAttempts: 5,
    enableLogging: false,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GuruConnection', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // =========================================================================
  // Construction & Configuration
  // =========================================================================

  describe('Construction', () => {
    test('should initialize with correct defaults', () => {
      const conn = createConnection();

      expect(conn.url).toBe('ws://localhost:8765/ws');
      expect(conn.connectionState).toBe(CONNECTION_STATES.DISCONNECTED);
      expect(conn.isDestroyed).toBe(false);
      expect(conn.isConnecting).toBe(false);
      expect(conn.reconnecting).toBe(false);
      expect(conn.reconnectAttempts).toBe(0);
      expect(conn.messageQueue).toEqual([]);
      expect(conn.ws).toBeNull();
      expect(conn.pingTimer).toBeNull();
      expect(conn.healthTimer).toBeNull();
      expect(conn.reconnectTimer).toBeNull();
      expect(conn.state.assistant).toBe('idle');

      conn.dispose();
    });

    test('should auto-connect when url provided and deferConnect is false', () => {
      const conn = new GuruConnection({
        url: 'ws://localhost:8765/ws',
        WebSocketClass: MockWebSocket,
        enableLogging: false,
      });

      // Should have created a WebSocket
      expect(conn.ws).toBeInstanceOf(MockWebSocket);
      expect(conn.isConnecting).toBe(true);

      conn.dispose();
    });

    test('should NOT auto-connect when deferConnect is true', () => {
      const conn = createConnection({ deferConnect: true });

      expect(conn.ws).toBeNull();
      expect(conn.isConnecting).toBe(false);

      conn.dispose();
    });

    test('should throw if connect called after destruction', () => {
      const conn = createConnection();
      conn.dispose();

      expect(() => conn.connect()).toThrow('[GuruConnection] Cannot connect after destruction');
    });

    test('should throw if connect called without URL', () => {
      const conn = createConnection({ url: undefined });

      expect(() => conn.connect()).toThrow('[GuruConnection] No WebSocket URL configured');

      conn.dispose();
    });
  });

  // =========================================================================
  // Connection Lifecycle
  // =========================================================================

  describe('Connection Lifecycle', () => {
    test('should transition through CONNECTING -> CONNECTED on successful open', () => {
      const conn = createConnection();
      const stateChanges = [];
      conn.on('connectionState', (e) => stateChanges.push(e.state));

      conn.connect();
      expect(conn.connectionState).toBe(CONNECTION_STATES.CONNECTING);

      conn.ws._simulateOpen();
      expect(conn.connectionState).toBe(CONNECTION_STATES.CONNECTED);
      expect(conn.isConnecting).toBe(false);
      expect(conn.reconnectAttempts).toBe(0);

      conn.dispose();
    });

    test('should emit open and connected events on successful connection', () => {
      const conn = createConnection();
      const openSpy = jest.fn();
      const connectedSpy = jest.fn();
      conn.on('open', openSpy);
      conn.on('connected', connectedSpy);

      conn.connect();
      conn.ws._simulateOpen();

      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(connectedSpy).toHaveBeenCalledTimes(1);

      conn.dispose();
    });

    test('should start ping timer after connection opens', () => {
      const conn = createConnection();
      conn.connect();

      expect(conn.pingTimer).toBeNull();
      conn.ws._simulateOpen();
      expect(conn.pingTimer).not.toBeNull();

      conn.dispose();
    });

    test('should handle WebSocket error and transition to WAITING', () => {
      const conn = createConnection();
      const errorSpy = jest.fn();
      conn.on('error', errorSpy);

      conn.connect();
      conn.ws._simulateError(new Error('network failure'));

      expect(conn.connectionState).toBe(CONNECTION_STATES.WAITING);
      expect(conn.isConnecting).toBe(false);
      // Default error handler + our spy = 2 listeners, error propagated
      expect(errorSpy).toHaveBeenCalledTimes(1);

      conn.dispose();
    });

    test('should auto-reconnect on abnormal close', () => {
      const conn = createConnection();
      conn.connect();
      conn.ws._simulateOpen();

      // Abnormal close (code !== 1000)
      conn.ws._simulateClose(1006, 'abnormal');

      expect(conn.reconnecting).toBe(true);
      expect(conn.reconnectAttempts).toBe(1);
      expect(conn.reconnectTimer).not.toBeNull();

      conn.dispose();
    });

    test('should NOT auto-reconnect on normal close (1000)', () => {
      const conn = createConnection();
      conn.connect();
      conn.ws._simulateOpen();

      conn.ws._simulateClose(1000, 'normal');

      expect(conn.reconnecting).toBe(false);
      expect(conn.reconnectTimer).toBeNull();
      expect(conn.connectionState).toBe(CONNECTION_STATES.DISCONNECTED);

      conn.dispose();
    });

    test('should respect maxReconnectAttempts', () => {
      const conn = createConnection({ maxReconnectAttempts: 2 });
      const maxSpy = jest.fn();
      conn.on('max_reconnect_attempts', maxSpy);

      conn.reconnectAttempts = 2;
      conn.connect();

      expect(maxSpy).toHaveBeenCalledTimes(1);
      expect(conn.ws).toBeNull();

      conn.dispose();
    });
  });

  // =========================================================================
  // REGRESSION: Reconnect Timer Leak (Bug #1)
  // =========================================================================

  describe('Reconnect Timer Tracking', () => {
    test('should store reconnect timer ID in reconnectTimer property', () => {
      const conn = createConnection();
      conn.connect();
      conn.ws._simulateOpen();

      // Force abnormal close to trigger reconnect scheduling
      conn.ws._simulateClose(1006, 'lost');

      expect(conn.reconnectTimer).not.toBeNull();
      expect(typeof conn.reconnectTimer).toBe('object'); // fake timer returns object

      conn.dispose();
    });

    test('should clear reconnect timer on close()', () => {
      const conn = createConnection();
      conn.connect();
      conn.ws._simulateOpen();

      // Trigger reconnect
      conn.ws._simulateClose(1006, 'lost');
      expect(conn.reconnectTimer).not.toBeNull();

      // close() should clear it
      conn.close();
      expect(conn.reconnectTimer).toBeNull();

      conn.dispose();
    });

    test('should clear reconnect timer on dispose()', () => {
      const conn = createConnection();
      conn.connect();
      conn.ws._simulateOpen();

      // Trigger reconnect
      conn.ws._simulateClose(1006, 'lost');
      expect(conn.reconnectTimer).not.toBeNull();

      // dispose() calls close() which clears the timer
      conn.dispose();
      expect(conn.reconnectTimer).toBeNull();
    });

    test('should not fire reconnect callback after dispose during backoff', () => {
      const conn = createConnection({ reconnectDelay: 5000 });
      conn.connect();
      conn.ws._simulateOpen();

      // Trigger reconnect with long backoff
      conn.ws._simulateClose(1006, 'lost');
      expect(conn.reconnectTimer).not.toBeNull();

      // Dispose during backoff window
      conn.dispose();

      // Advance past the backoff — callback should NOT fire connect()
      // because the timer was cleared in dispose()
      const connectSpy = jest.spyOn(conn, 'connect');
      jest.advanceTimersByTime(60000);

      expect(connectSpy).not.toHaveBeenCalled();
    });

    test('should clear previous reconnect timer when scheduling a new one', () => {
      const conn = createConnection({ reconnectDelay: 100 });
      const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

      conn.connect();
      conn.ws._simulateOpen();

      // Trigger first reconnect
      conn.ws._simulateClose(1006, 'lost');
      const firstTimer = conn.reconnectTimer;
      expect(firstTimer).not.toBeNull();

      // Manually trigger another _scheduleReconnect (simulating rapid close events)
      conn._scheduleReconnect();

      // The first timer should have been cleared
      expect(clearTimeoutSpy).toHaveBeenCalled();
      // New timer should be different
      expect(conn.reconnectTimer).not.toBeNull();

      conn.dispose();
    });

    test('should use exponential backoff for reconnect delays', () => {
      const conn = createConnection({ reconnectDelay: 100 });
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

      // Call _scheduleReconnect directly to test backoff growth
      // without a successful connection resetting reconnectAttempts.
      // First reconnect: reconnectAttempts goes 0->1, backoff = min(30000, 100 * 2^0) = 100
      conn._scheduleReconnect();
      expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 100);
      expect(conn.reconnectAttempts).toBe(1);

      // Second reconnect: reconnectAttempts goes 1->2, backoff = min(30000, 100 * 2^1) = 200
      conn._scheduleReconnect();
      expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 200);
      expect(conn.reconnectAttempts).toBe(2);

      // Third reconnect: reconnectAttempts goes 2->3, backoff = min(30000, 100 * 2^2) = 400
      conn._scheduleReconnect();
      expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 400);
      expect(conn.reconnectAttempts).toBe(3);

      conn.dispose();
    });

    test('should cap backoff at 30 seconds', () => {
      const conn = createConnection({ reconnectDelay: 10000 });
      conn.reconnectAttempts = 10; // High attempt count

      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
      conn._scheduleReconnect();

      // backoff = min(30000, 10000 * 2^10) = 30000
      expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 30000);

      conn.dispose();
    });

    test('should not schedule reconnect when already destroyed', () => {
      const conn = createConnection();
      conn.dispose();

      conn._scheduleReconnect();
      expect(conn.reconnectTimer).toBeNull();
    });
  });

  // =========================================================================
  // Message Handling
  // =========================================================================

  describe('Message Handling', () => {
    test('should parse JSON messages and emit them', () => {
      const conn = createConnection();
      const msgSpy = jest.fn();
      conn.on('message', msgSpy);

      conn.connect();
      conn.ws._simulateOpen();

      conn.ws._simulateMessage({ type: 'response', content: 'hello' });

      expect(msgSpy).toHaveBeenCalledTimes(1);
      expect(msgSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'response', content: 'hello' })
      );

      conn.dispose();
    });

    test('should emit type-specific events', () => {
      const conn = createConnection();
      const typeSpy = jest.fn();
      conn.on('response', typeSpy);

      conn.connect();
      conn.ws._simulateOpen();

      conn.ws._simulateMessage({ type: 'response', content: 'test' });

      expect(typeSpy).toHaveBeenCalledTimes(1);

      conn.dispose();
    });

    test('should respond to heartbeat/ping with pong', () => {
      const conn = createConnection();
      conn.connect();
      conn.ws._simulateOpen();

      conn.ws._simulateMessage({ type: 'heartbeat', timestamp: 12345 });

      // Should have sent a pong
      const sent = conn.ws._sent;
      expect(sent.length).toBe(1);
      const pong = JSON.parse(sent[0]);
      expect(pong.type).toBe('pong');
      expect(pong.echo).toBe(12345);

      conn.dispose();
    });

    test('should bridge backend event names to EventBus conventions', () => {
      const conn = createConnection();
      const bridgeSpy = jest.fn();
      conn.on('audio:stt-final', bridgeSpy);

      conn.connect();
      conn.ws._simulateOpen();

      conn.ws._simulateMessage({ type: 'stt-final', text: 'hello world' });

      expect(bridgeSpy).toHaveBeenCalledTimes(1);
      expect(bridgeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'stt-final', text: 'hello world' })
      );

      conn.dispose();
    });

    test('should normalize correlation identifiers', () => {
      const conn = createConnection();
      const msgSpy = jest.fn();
      conn.on('message', msgSpy);

      conn.connect();
      conn.ws._simulateOpen();

      conn.ws._simulateMessage({
        type: 'response',
        request_id: 'req-123',
        frontend_id: 'fe-456',
      });

      const payload = msgSpy.mock.calls[0][0];
      expect(payload.correlationId).toBe('fe-456');
      expect(payload.requestId).toBe('req-123');
      // frontend_id should be cleaned up
      expect(payload.frontend_id).toBeUndefined();

      conn.dispose();
    });

    test('should update assistant status from message state field', () => {
      const conn = createConnection();
      const statusSpy = jest.fn();
      conn.on('statusChange', statusSpy);

      conn.connect();
      conn.ws._simulateOpen();

      conn.ws._simulateMessage({ type: 'status', state: 'thinking' });

      expect(conn.state.assistant).toBe('thinking');
      expect(statusSpy).toHaveBeenCalledWith('thinking');

      conn.dispose();
    });

    test('should emit lmc event for artifact types', () => {
      const conn = createConnection();
      const lmcSpy = jest.fn();
      conn.on('lmc', lmcSpy);

      conn.connect();
      conn.ws._simulateOpen();

      conn.ws._simulateMessage({ type: 'code', content: 'console.log("hi")' });

      expect(lmcSpy).toHaveBeenCalledTimes(1);

      conn.dispose();
    });
  });

  // =========================================================================
  // Send & Queue
  // =========================================================================

  describe('Send and Queue', () => {
    test('should send messages when connected', () => {
      const conn = createConnection();
      conn.connect();
      conn.ws._simulateOpen();

      conn.send({ type: 'chat', content: 'hello' });

      expect(conn.ws._sent.length).toBe(1);
      expect(JSON.parse(conn.ws._sent[0])).toEqual({ type: 'chat', content: 'hello' });

      conn.dispose();
    });

    test('should queue messages when not connected', () => {
      const conn = createConnection();

      conn.send({ type: 'chat', content: 'queued' });

      expect(conn.messageQueue.length).toBe(1);
      expect(conn.messageQueue[0]).toEqual({ type: 'chat', content: 'queued' });

      conn.dispose();
    });

    test('should flush queue on connection open', () => {
      const conn = createConnection();

      // Queue messages before connecting
      conn.send({ type: 'msg1' });
      conn.send({ type: 'msg2' });
      expect(conn.messageQueue.length).toBe(2);

      conn.connect();
      conn.ws._simulateOpen();

      // Queue should be flushed
      expect(conn.messageQueue.length).toBe(0);
      expect(conn.ws._sent.length).toBe(2);

      conn.dispose();
    });

    test('should not send after disposal', () => {
      const conn = createConnection();
      conn.connect();
      conn.ws._simulateOpen();

      conn.dispose();
      conn.send({ type: 'late' });

      // messageQueue should be empty (cleared on dispose), nothing sent
      expect(conn.messageQueue.length).toBe(0);

      conn.dispose();
    });

    test('should send string data as-is', () => {
      const conn = createConnection();
      conn.connect();
      conn.ws._simulateOpen();

      conn.send('raw string');

      expect(conn.ws._sent[0]).toBe('raw string');

      conn.dispose();
    });
  });

  // =========================================================================
  // Ping/Pong & Health Check
  // =========================================================================

  describe('Ping and Health Check', () => {
    test('should send periodic pings', () => {
      const conn = createConnection({ pingInterval: 1000 });
      conn.connect();
      conn.ws._simulateOpen();

      // Advance past one ping interval
      jest.advanceTimersByTime(1000);

      const sent = conn.ws._sent;
      expect(sent.length).toBeGreaterThanOrEqual(1);
      const ping = JSON.parse(sent[sent.length - 1]);
      expect(ping.type).toBe('ping');

      conn.dispose();
    });

    test('should stop ping timer on close', () => {
      const conn = createConnection();
      conn.connect();
      conn.ws._simulateOpen();
      expect(conn.pingTimer).not.toBeNull();

      conn.close();
      expect(conn.pingTimer).toBeNull();

      conn.dispose();
    });

    test('should detect stale connection after missed pongs', () => {
      const conn = createConnection({
        pingInterval: 1000,
        maxMissedPongs: 2,
      });
      const staleSpy = jest.fn();
      conn.on('connectionState', (e) => {
        if (e.state === CONNECTION_STATES.STALE) staleSpy();
      });

      conn.connect();
      conn.ws._simulateOpen();

      // Set lastPong far in the past to simulate missed pongs
      conn.lastPong = Date.now() - 10000;

      // Advance through enough ping cycles to trigger stale detection
      jest.advanceTimersByTime(1000);
      jest.advanceTimersByTime(1000);

      expect(staleSpy).toHaveBeenCalled();

      conn.dispose();
    });

    test('should start health check on error', () => {
      const conn = createConnection();
      conn.connect();

      conn.ws._simulateError(new Error('fail'));

      expect(conn.healthTimer).not.toBeNull();

      conn.dispose();
    });

    test('should stop health check when connection is open', () => {
      const conn = createConnection({ healthInterval: 500 });
      conn.connect();

      // Simulate error to start health check
      conn.ws._simulateError(new Error('fail'));
      expect(conn.healthTimer).not.toBeNull();

      // Reconnect succeeds
      conn.connect();
      conn.ws._simulateOpen();

      expect(conn.healthTimer).toBeNull();

      conn.dispose();
    });
  });

  // =========================================================================
  // Disposal
  // =========================================================================

  describe('Disposal', () => {
    test('should clean up all resources on dispose', () => {
      const conn = createConnection();
      conn.connect();
      conn.ws._simulateOpen();

      // Queue a message and trigger health check
      conn.send({ type: 'test' });

      conn.dispose();

      expect(conn.isDestroyed).toBe(true);
      expect(conn.ws).toBeNull();
      expect(conn.pingTimer).toBeNull();
      expect(conn.healthTimer).toBeNull();
      expect(conn.reconnectTimer).toBeNull();
      expect(conn.messageQueue).toEqual([]);
      expect(conn.listenerCount('message')).toBe(0);
      expect(conn.listenerCount('error')).toBe(0);
    });

    test('should be idempotent (double dispose is safe)', () => {
      const conn = createConnection();
      conn.connect();
      conn.ws._simulateOpen();

      conn.dispose();
      expect(() => conn.dispose()).not.toThrow();
    });

    test('should remove default error handler on dispose', () => {
      const conn = createConnection();

      // Before dispose, should have default error handler
      expect(conn.listenerCount('error')).toBe(1);

      conn.dispose();

      expect(conn.listenerCount('error')).toBe(0);
      expect(conn._defaultErrorHandler).toBeNull();
    });
  });

  // =========================================================================
  // State Transitions
  // =========================================================================

  describe('State Transitions', () => {
    test('should emit connectionState events with previous and new state', () => {
      const conn = createConnection();
      const transitions = [];
      conn.on('connectionState', (e) => {
        transitions.push({ from: e.previous, to: e.state });
      });

      conn.connect();
      conn.ws._simulateOpen();

      expect(transitions).toEqual([
        { from: CONNECTION_STATES.DISCONNECTED, to: CONNECTION_STATES.CONNECTING },
        { from: CONNECTION_STATES.CONNECTING, to: CONNECTION_STATES.CONNECTED },
      ]);

      conn.dispose();
    });

    test('should throw on invalid state transition', () => {
      const conn = createConnection();

      expect(() => {
        conn._transitionConnectionState('INVALID_STATE');
      }).toThrow('Invalid connection state transition target');

      conn.dispose();
    });

    test('should not emit duplicate state if already in target state', () => {
      const conn = createConnection();
      const spy = jest.fn();
      conn.on('connectionState', spy);

      conn._transitionConnectionState(CONNECTION_STATES.WAITING);
      conn._transitionConnectionState(CONNECTION_STATES.WAITING);

      expect(spy).toHaveBeenCalledTimes(1);

      conn.dispose();
    });
  });

  // =========================================================================
  // getStats
  // =========================================================================

  describe('getStats', () => {
    test('should return frozen stats object', () => {
      const conn = createConnection();
      conn.connect();
      conn.ws._simulateOpen();

      const stats = conn.getStats();

      expect(Object.isFrozen(stats)).toBe(true);
      expect(stats.connected).toBe(true);
      expect(stats.reconnectAttempts).toBe(0);
      expect(stats.queuedMessages).toBe(0);
      expect(stats.state).toBe('idle');
      expect(stats.connectionState).toBe(CONNECTION_STATES.CONNECTED);

      conn.dispose();
    });

    test('should report disconnected when no WebSocket', () => {
      const conn = createConnection();
      const stats = conn.getStats();

      expect(stats.connected).toBeFalsy();

      conn.dispose();
    });
  });

  // =========================================================================
  // stopRequest
  // =========================================================================

  describe('stopRequest', () => {
    test('should send stop message with request ID', () => {
      const conn = createConnection();
      conn.connect();
      conn.ws._simulateOpen();

      conn.stopRequest('req-abc');

      const sent = JSON.parse(conn.ws._sent[0]);
      expect(sent).toEqual({ type: 'stop', id: 'req-abc' });

      conn.dispose();
    });

    test('should warn and return if no request ID provided', () => {
      const conn = createConnection();
      conn.connect();
      conn.ws._simulateOpen();

      conn.stopRequest(null);
      conn.stopRequest(undefined);
      conn.stopRequest('');

      expect(conn.ws._sent.length).toBe(0);

      conn.dispose();
    });
  });

  // =========================================================================
  // streamAudio
  // =========================================================================

  describe('streamAudio', () => {
    test('should send audio data as base64 JSON message', () => {
      const conn = createConnection();
      conn.connect();
      conn.ws._simulateOpen();

      // Create a small ArrayBuffer
      const buffer = new ArrayBuffer(4);
      const view = new Uint8Array(buffer);
      view[0] = 65; // 'A'
      view[1] = 66; // 'B'
      view[2] = 67; // 'C'
      view[3] = 68; // 'D'

      conn.streamAudio(buffer);

      expect(conn.ws._sent.length).toBe(1);
      const msg = JSON.parse(conn.ws._sent[0]);
      expect(msg.role).toBe('user');
      expect(msg.type).toBe('audio');
      expect(msg.audio).toBe(btoa('ABCD'));
      expect(msg.timestamp).toBeDefined();

      conn.dispose();
    });

    test('should not stream when connection is not open', () => {
      const conn = createConnection();
      // Not connected

      conn.streamAudio(new ArrayBuffer(4));

      // No crash, no data sent
      expect(conn.ws).toBeNull();

      conn.dispose();
    });
  });

  // =========================================================================
  // Edge Cases
  // =========================================================================

  describe('Edge Cases', () => {
    test('should handle non-JSON message data gracefully', () => {
      const conn = createConnection();
      const msgSpy = jest.fn();
      conn.on('message', msgSpy);

      conn.connect();
      conn.ws._simulateOpen();

      // Send invalid JSON
      conn.ws._simulateMessage('not json {{{');

      expect(msgSpy).toHaveBeenCalledTimes(1);
      // Should receive raw string when JSON parse fails
      expect(msgSpy).toHaveBeenCalledWith('not json {{{');

      conn.dispose();
    });

    test('should skip connect if already connecting', () => {
      const conn = createConnection();

      conn.connect();
      expect(conn.isConnecting).toBe(true);

      const firstWs = conn.ws;
      conn.connect(); // Should be a no-op

      expect(conn.ws).toBe(firstWs); // Same WebSocket instance

      conn.dispose();
    });

    test('should handle WebSocket constructor throwing', () => {
      const ThrowingWS = function() {
        throw new Error('WS construction failed');
      };
      ThrowingWS.OPEN = 1;
      ThrowingWS.CLOSED = 3;

      const conn = createConnection({ WebSocketClass: ThrowingWS });
      const errorSpy = jest.fn();
      conn.on('error', errorSpy);

      conn.connect();

      expect(conn.isConnecting).toBe(false);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({
        message: 'WS construction failed',
      }));

      conn.dispose();
    });

    test('should handle send failure by requeuing message', () => {
      const conn = createConnection();
      conn.connect();
      conn.ws._simulateOpen();

      // Override send to throw
      const origSend = conn.ws.send;
      conn.ws.send = () => { throw new Error('send failed'); };

      conn.send({ type: 'test' });

      // Message should be requeued
      expect(conn.messageQueue.length).toBe(1);
      expect(conn.messageQueue[0]).toEqual({ type: 'test' });

      conn.ws.send = origSend;
      conn.dispose();
    });

    test('should handle close() when ws is already null', () => {
      const conn = createConnection();

      // No connection established, ws is null
      expect(() => conn.close()).not.toThrow();

      conn.dispose();
    });
  });

  // =========================================================================
  // Backend Availability Gate
  // =========================================================================

  describe('Backend Availability Gate', () => {
    test('should default _backendAvailable to true', () => {
      const conn = createConnection();
      expect(conn.isBackendAvailable()).toBe(true);
      conn.dispose();
    });

    test('setBackendAvailable(false) should prevent connect()', () => {
      const conn = createConnection();
      conn.setBackendAvailable(false);

      conn.connect();

      expect(conn.ws).toBeNull();
      expect(conn.isConnecting).toBe(false);

      conn.dispose();
    });

    test('connect() should return silently (no throw) when backend unavailable', () => {
      const conn = createConnection();
      conn.setBackendAvailable(false);

      expect(() => conn.connect()).not.toThrow();

      conn.dispose();
    });

    test('_scheduleReconnect should be skipped when backend unavailable', () => {
      const conn = createConnection();
      conn.setBackendAvailable(false);

      conn._scheduleReconnect();

      expect(conn.reconnectTimer).toBeNull();
      expect(conn.reconnectAttempts).toBe(0);

      conn.dispose();
    });

    test('_startHealthCheck should be skipped when backend unavailable', () => {
      const conn = createConnection();
      conn.setBackendAvailable(false);

      conn._startHealthCheck();

      expect(conn.healthTimer).toBeNull();

      conn.dispose();
    });

    test('setBackendAvailable(true) should auto-connect when URL is configured', () => {
      const conn = createConnection();
      conn.setBackendAvailable(false);

      // Should not connect
      conn.connect();
      expect(conn.ws).toBeNull();

      // Restore availability — should auto-connect
      conn.setBackendAvailable(true);
      expect(conn.ws).toBeInstanceOf(MockWebSocket);
      expect(conn.isConnecting).toBe(true);

      conn.dispose();
    });

    test('setBackendAvailable(true) should reset reconnect attempts', () => {
      const conn = createConnection();
      conn.setBackendAvailable(false);
      conn.reconnectAttempts = 5;

      conn.setBackendAvailable(true);
      expect(conn.reconnectAttempts).toBe(0);

      conn.dispose();
    });

    test('setBackendAvailable(true) should NOT connect if already connected', () => {
      const conn = createConnection();
      conn.connect();
      conn.ws._simulateOpen();

      const wsBefore = conn.ws;
      conn.setBackendAvailable(true);

      // Same WebSocket, no reconnect
      expect(conn.ws).toBe(wsBefore);

      conn.dispose();
    });

    test('setBackendAvailable(true) should NOT connect if destroyed', () => {
      const conn = createConnection();
      conn.setBackendAvailable(false);
      conn.dispose();

      // Should not throw or connect
      expect(() => conn.setBackendAvailable(true)).not.toThrow();
      expect(conn.ws).toBeNull();
    });

    test('should suppress reconnect loop after error when backend unavailable', () => {
      const conn = createConnection();
      conn.connect();
      conn.ws._simulateOpen();

      // Set backend unavailable while connected
      conn.setBackendAvailable(false);

      // Simulate abnormal close — should NOT trigger reconnect
      conn.ws._simulateClose(1006, 'lost');

      expect(conn.reconnectTimer).toBeNull();
      expect(conn.reconnecting).toBe(false);

      conn.dispose();
    });

    test('constructor backendAvailable: false should prevent auto-connect', () => {
      const conn = new GuruConnection({
        url: 'ws://localhost:8765',
        WebSocketClass: MockWebSocket,
        backendAvailable: false
      });
      // deferConnect defaults to false, so auto-connect would fire — but gate blocks it
      expect(conn.ws).toBeNull();
      expect(conn.isConnecting).toBe(false);
      expect(conn.isBackendAvailable()).toBe(false);
      conn.dispose();
    });

    test('constructor should default backendAvailable to true (auto-connects)', () => {
      const conn = new GuruConnection({
        url: 'ws://localhost:8765',
        WebSocketClass: MockWebSocket
      });
      // Without backendAvailable: false, auto-connect fires
      expect(conn.ws).not.toBeNull();
      expect(conn.isBackendAvailable()).toBe(true);
      conn.dispose();
    });
  });
});
