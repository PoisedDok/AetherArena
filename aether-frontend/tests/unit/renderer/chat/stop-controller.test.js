'use strict';

/* ------------------------------------------------------------------ *
 *  tests/unit/renderer/chat/stop-controller.test.js
 *  Unit tests for StopController
 * ------------------------------------------------------------------ */

// ----- Mocks (top-level, before require) ----- //

const mockEventTypes = {
  CHAT: {
    MESSAGE_ERROR: 'chat:message:error',
    STOP_REQUESTED: 'chat:stop:requested',
    REQUEST_STOPPED: 'chat:request:stopped',
  },
};

jest.mock(
  '../../../../src/core/events/EventTypes',
  () => ({ EventTypes: mockEventTypes })
);

const noop = () => {};

const mockLogger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  child: () => mockLogger,
};

jest.mock(
  '../../../../src/core/utils/logger',
  () => ({ logger: mockLogger })
);

const mockParseSessionId = jest.fn();

jest.mock(
  '../../../../src/core/session/SessionManager',
  () => ({ parseSessionId: mockParseSessionId })
);

// ----- Require source after mocks ----- //

const StopController = require(
  '../../../../src/renderer/chat/modules/messaging/StopController'
);

// ----- Helpers ----- //

function createEventBus() {
  return { emit: jest.fn() };
}

function createSendController(requestId = 'req-123') {
  return {
    getPendingRequestId: jest.fn(() => requestId),
    clearPendingRequestId: jest.fn(),
  };
}

function createIpc() {
  return { send: jest.fn() };
}

function setupWebSocket(stopFn = jest.fn()) {
  return {
    connection: {
      stopRequest: stopFn,
    },
  };
}

function teardownWebSocket() {
  // no-op
}

// ----- Tests ----- //

describe('StopController', () => {
  let eventBus;
  let sendController;
  let ipc;

  beforeEach(() => {
    // resetMocks: true clears implementations — re-establish
    mockParseSessionId.mockImplementation((id) =>
      typeof id === 'string' ? id : null
    );

    eventBus = createEventBus();
    sendController = createSendController();
    ipc = createIpc();

    teardownWebSocket();
  });

  afterEach(() => {
    teardownWebSocket();
  });

  // ================================================================
  // constructor
  // ================================================================
  describe('constructor', () => {
    it('stores ipc, eventBus, sendController from options', () => {
      const ctrl = new StopController({ ipc, eventBus, sendController });
      expect(ctrl.ipc).toBe(ipc);
      expect(ctrl.eventBus).toBe(eventBus);
      expect(ctrl.sendController).toBe(sendController);
    });

    it('defaults all dependencies to null when no options', () => {
      const ctrl = new StopController();
      expect(ctrl.ipc).toBeNull();
      expect(ctrl.eventBus).toBeNull();
      expect(ctrl.sendController).toBeNull();
    });

    it('defaults all dependencies to null with empty options', () => {
      const ctrl = new StopController({});
      expect(ctrl.ipc).toBeNull();
      expect(ctrl.eventBus).toBeNull();
      expect(ctrl.sendController).toBeNull();
    });

    it('initializes isStopping to false', () => {
      const ctrl = new StopController();
      expect(ctrl.isStopping).toBe(false);
    });

    it('initializes metrics with zero counts', () => {
      const ctrl = new StopController();
      expect(ctrl.metrics).toEqual({ attempts: 0, failures: 0 });
    });

    it('creates a child logger', () => {
      const ctrl = new StopController();
      expect(ctrl.log).toBeDefined();
      expect(ctrl.log.info).toBeDefined();
    });
  });

  // ================================================================
  // init
  // ================================================================
  describe('init()', () => {
    it('can be called without error', () => {
      const ctrl = new StopController();
      expect(() => ctrl.init()).not.toThrow();
    });
  });

  // ================================================================
  // isStoppingRequest
  // ================================================================
  describe('isStoppingRequest()', () => {
    it('returns false initially', () => {
      const ctrl = new StopController();
      expect(ctrl.isStoppingRequest()).toBe(false);
    });

    it('returns true while stop is in progress', async () => {
      const endpoint = setupWebSocket();
      const ctrl = new StopController({ endpoint, eventBus, sendController });

      const origStopViaIPC = ctrl._stopViaIPC.bind(ctrl);
      let stoppingDuringExec = false;
      ctrl._stopViaIPC = async (...args) => {
        stoppingDuringExec = ctrl.isStopping;
        return origStopViaIPC(...args);
      };

      await ctrl.stop('req-1');
      expect(stoppingDuringExec).toBe(true);
      expect(ctrl.isStoppingRequest()).toBe(false);
    });
  });

  // ================================================================
  // stop() — concurrency guard
  // ================================================================
  describe('stop() — concurrency guard', () => {
    it('returns false when already stopping', async () => {
      const ctrl = new StopController({ eventBus, sendController });
      ctrl.isStopping = true;
      const result = await ctrl.stop('req-1');
      expect(result).toBe(false);
    });

    it('does not increment metrics when already stopping', async () => {
      const ctrl = new StopController({ eventBus, sendController });
      ctrl.isStopping = true;
      await ctrl.stop('req-1');
      expect(ctrl.metrics.attempts).toBe(0);
    });

    it('does not emit any events when already stopping', async () => {
      const ctrl = new StopController({ eventBus, sendController });
      ctrl.isStopping = true;
      await ctrl.stop('req-1');
      expect(eventBus.emit).not.toHaveBeenCalled();
    });
  });

  // ================================================================
  // stop() — no request ID
  // ================================================================
  describe('stop() — no request ID', () => {
    it('returns false when no requestId provided and sendController returns null', async () => {
      sendController.getPendingRequestId.mockReturnValue(null);
      const ctrl = new StopController({ eventBus, sendController });
      const result = await ctrl.stop();
      expect(result).toBe(false);
    });

    it('returns false when no requestId and no sendController', async () => {
      const ctrl = new StopController({ eventBus });
      const result = await ctrl.stop();
      expect(result).toBe(false);
    });

    it('does not set isStopping when no requestId', async () => {
      sendController.getPendingRequestId.mockReturnValue(null);
      const ctrl = new StopController({ eventBus, sendController });
      await ctrl.stop();
      expect(ctrl.isStopping).toBe(false);
    });

    it('does not increment metrics when no requestId', async () => {
      sendController.getPendingRequestId.mockReturnValue(null);
      const ctrl = new StopController({ eventBus, sendController });
      await ctrl.stop();
      expect(ctrl.metrics.attempts).toBe(0);
    });
  });

  // ================================================================
  // stop() — no channel
  // ================================================================
  describe('stop() — no channel available', () => {
    it('returns false when neither WebSocket nor IPC available', async () => {
      const ctrl = new StopController({ eventBus, sendController });
      const result = await ctrl.stop('req-1');
      expect(result).toBe(false);
    });

    it('increments both attempts and failures', async () => {
      const ctrl = new StopController({ eventBus, sendController });
      await ctrl.stop('req-1');
      expect(ctrl.metrics.attempts).toBe(1);
      expect(ctrl.metrics.failures).toBe(1);
    });

    it('emits MESSAGE_ERROR event with descriptive error', async () => {
      const ctrl = new StopController({ eventBus, sendController });
      await ctrl.stop('req-1');
      expect(eventBus.emit).toHaveBeenCalledWith(
        'chat:message:error',
        expect.objectContaining({
          requestId: 'req-1',
          error: 'No stop channel available (WebSocket or IPC)',
        })
      );
    });

    it('resets isStopping after no-channel failure', async () => {
      const ctrl = new StopController({ eventBus, sendController });
      await ctrl.stop('req-1');
      expect(ctrl.isStopping).toBe(false);
    });

    it('does not emit STOP_REQUESTED', async () => {
      const ctrl = new StopController({ eventBus, sendController });
      await ctrl.stop('req-1');
      const stopReqCalls = eventBus.emit.mock.calls.filter(
        (c) => c[0] === 'chat:stop:requested'
      );
      expect(stopReqCalls).toHaveLength(0);
    });
  });

  // ================================================================
  // stop() — WebSocket channel (success path)
  // ================================================================
  describe('stop() — WebSocket channel', () => {
    it('calls endpoint.connection.stopRequest with requestId', async () => {
      const stopFn = jest.fn();
      const endpoint = setupWebSocket(stopFn);
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      const result = await ctrl.stop('req-1');
      expect(result).toBe(true);
      expect(stopFn).toHaveBeenCalledWith('req-1');
    });

    it('emits STOP_REQUESTED before calling stop', async () => {
      const endpoint = setupWebSocket();
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      await ctrl.stop('req-1');
      expect(eventBus.emit).toHaveBeenCalledWith(
        'chat:stop:requested',
        expect.objectContaining({
          requestId: 'req-1',
          channel: 'websocket',
        })
      );
    });

    it('emits REQUEST_STOPPED with success: true', async () => {
      const endpoint = setupWebSocket();
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      await ctrl.stop('req-1');
      expect(eventBus.emit).toHaveBeenCalledWith(
        'chat:request:stopped',
        expect.objectContaining({
          requestId: 'req-1',
          success: true,
          channel: 'websocket',
        })
      );
    });

    it('clears sendController pending ID on success', async () => {
      const endpoint = setupWebSocket();
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      await ctrl.stop('req-1');
      expect(sendController.clearPendingRequestId).toHaveBeenCalled();
    });

    it('does not clear pending ID when sendController is null', async () => {
      const endpoint = setupWebSocket();
      const ctrl = new StopController({ endpoint, eventBus });
      const result = await ctrl.stop('req-1');
      expect(result).toBe(true);
    });

    it('increments attempts but not failures', async () => {
      const endpoint = setupWebSocket();
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      await ctrl.stop('req-1');
      expect(ctrl.metrics.attempts).toBe(1);
      expect(ctrl.metrics.failures).toBe(0);
    });

    it('resets isStopping in finally', async () => {
      const endpoint = setupWebSocket();
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      await ctrl.stop('req-1');
      expect(ctrl.isStopping).toBe(false);
    });
  });

  // ================================================================
  // stop() — IPC fallback
  // ================================================================
  describe('stop() — IPC fallback', () => {
    it('falls back to IPC when WebSocket unavailable', async () => {
      const ctrl = new StopController({ eventBus, sendController, ipc });
      const result = await ctrl.stop('req-1');
      expect(result).toBe(true);
      expect(ipc.send).toHaveBeenCalledWith('chat:stop', { requestId: 'req-1' });
    });

    it('reports channel as "ipc" in events', async () => {
      const ctrl = new StopController({ eventBus, sendController, ipc });
      await ctrl.stop('req-1');
      expect(eventBus.emit).toHaveBeenCalledWith(
        'chat:stop:requested',
        expect.objectContaining({ channel: 'ipc' })
      );
    });

    it('clears pending request on IPC success', async () => {
      const ctrl = new StopController({ eventBus, sendController, ipc });
      await ctrl.stop('req-1');
      expect(sendController.clearPendingRequestId).toHaveBeenCalled();
    });
  });

  // ================================================================
  // stop() — requestId resolution
  // ================================================================
  describe('stop() — requestId resolution', () => {
    it('uses provided requestId over sendController', async () => {
      const endpoint = setupWebSocket();
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      await ctrl.stop('explicit-req');
      expect(sendController.getPendingRequestId).not.toHaveBeenCalled();
    });

    it('falls back to sendController when no requestId provided', async () => {
      const endpoint = setupWebSocket();
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      await ctrl.stop();
      expect(sendController.getPendingRequestId).toHaveBeenCalled();
    });

    it('uses sendController requestId in events when no explicit ID', async () => {
      const endpoint = setupWebSocket();
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      await ctrl.stop();
      expect(eventBus.emit).toHaveBeenCalledWith(
        'chat:stop:requested',
        expect.objectContaining({ requestId: 'req-123' })
      );
    });
  });

  // ================================================================
  // stop() — _stopViaIPC returns false (internal failure)
  // ================================================================
  describe('stop() — _stopViaIPC internal failure', () => {
    it('returns false when WebSocket stopRequest throws', async () => {
      const endpoint = setupWebSocket(() => {
        throw new Error('WS failure');
      });
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      const result = await ctrl.stop('req-1');
      expect(result).toBe(false);
    });

    it('increments failures when _stopViaIPC returns false', async () => {
      const endpoint = setupWebSocket(() => {
        throw new Error('WS failure');
      });
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      await ctrl.stop('req-1');
      expect(ctrl.metrics.failures).toBe(1);
    });

    it('emits REQUEST_STOPPED with success: false', async () => {
      const endpoint = setupWebSocket(() => {
        throw new Error('WS failure');
      });
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      await ctrl.stop('req-1');
      expect(eventBus.emit).toHaveBeenCalledWith(
        'chat:request:stopped',
        expect.objectContaining({ success: false })
      );
    });

    it('does not clear pending request on failure', async () => {
      const endpoint = setupWebSocket(() => {
        throw new Error('WS failure');
      });
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      await ctrl.stop('req-1');
      expect(sendController.clearPendingRequestId).not.toHaveBeenCalled();
    });

    it('resets isStopping after failure', async () => {
      const endpoint = setupWebSocket(() => {
        throw new Error('WS failure');
      });
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      await ctrl.stop('req-1');
      expect(ctrl.isStopping).toBe(false);
    });
  });

  // ================================================================
  // stop() — catch block (outer error paths)
  // ================================================================
  describe('stop() — catch block', () => {
    it('catches when clearPendingRequestId throws', async () => {
      const endpoint = setupWebSocket();
      sendController.clearPendingRequestId.mockImplementation(() => {
        throw new Error('clear failed');
      });
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      const result = await ctrl.stop('req-1');
      expect(result).toBe(false);
      expect(ctrl.metrics.failures).toBe(1);
    });

    it('emits MESSAGE_ERROR when catch fires', async () => {
      const endpoint = setupWebSocket();
      sendController.clearPendingRequestId.mockImplementation(() => {
        throw new Error('clear failed');
      });
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      await ctrl.stop('req-1');
      expect(eventBus.emit).toHaveBeenCalledWith(
        'chat:message:error',
        expect.objectContaining({
          requestId: 'req-1',
          error: 'clear failed',
        })
      );
    });

    it('resets isStopping in finally even on catch', async () => {
      const endpoint = setupWebSocket();
      sendController.clearPendingRequestId.mockImplementation(() => {
        throw new Error('clear failed');
      });
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      await ctrl.stop('req-1');
      expect(ctrl.isStopping).toBe(false);
    });
  });

  // ================================================================
  // REGRESSION: isStopping reset when _emitStopEvent throws
  // ================================================================
  describe('stop() — isStopping reset regression', () => {
    it('resets isStopping when STOP_REQUESTED emit throws', async () => {
      // First emit is STOP_REQUESTED — make it throw
      const endpoint = setupWebSocket();
      const throwingBus = {
        emit: jest.fn().mockImplementationOnce(() => {
          throw new Error('eventBus listener error');
        }),
      };
      const ctrl = new StopController({
        endpoint,
        eventBus: throwingBus,
        sendController,
      });
      const result = await ctrl.stop('req-1');
      // The catch block handles it and returns false
      expect(result).toBe(false);
      // Critically: isStopping is reset by finally
      expect(ctrl.isStopping).toBe(false);
    });

    it('increments failures when emit throws', async () => {
      const endpoint = setupWebSocket();
      const throwingBus = {
        emit: jest.fn().mockImplementationOnce(() => {
          throw new Error('boom');
        }),
      };
      const ctrl = new StopController({
        endpoint,
        eventBus: throwingBus,
        sendController,
      });
      await ctrl.stop('req-1');
      expect(ctrl.metrics.failures).toBe(1);
    });

    it('allows subsequent stop calls after emit-throw recovery', async () => {
      const endpoint = setupWebSocket();
      const throwingBus = {
        emit: jest
          .fn()
          .mockImplementationOnce(() => {
            throw new Error('first-emit-error');
          })
          // Subsequent emit calls succeed
          .mockImplementation(() => {}),
      };
      const ctrl = new StopController({
        endpoint,
        eventBus: throwingBus,
        sendController,
      });

      // First call: emit throws, caught, isStopping reset
      const first = await ctrl.stop('req-1');
      expect(first).toBe(false);
      expect(ctrl.isStopping).toBe(false);

      // Second call: should proceed normally
      const second = await ctrl.stop('req-2');
      expect(second).toBe(true);
    });
  });

  // ================================================================
  // _stopViaIPC (direct)
  // ================================================================
  describe('_stopViaIPC()', () => {
    it('prefers WebSocket when channel is null', async () => {
      const stopFn = jest.fn();
      const endpoint = setupWebSocket(stopFn);
      const ctrl = new StopController({ endpoint, ipc });
      const result = await ctrl._stopViaIPC('req-1', null);
      expect(result).toBe(true);
      expect(stopFn).toHaveBeenCalledWith('req-1');
      expect(ipc.send).not.toHaveBeenCalled();
    });

    it('uses only WebSocket when channel is "websocket"', async () => {
      const stopFn = jest.fn();
      const endpoint = setupWebSocket(stopFn);
      const ctrl = new StopController({ endpoint, ipc });
      const result = await ctrl._stopViaIPC('req-1', 'websocket');
      expect(result).toBe(true);
      expect(stopFn).toHaveBeenCalledWith('req-1');
    });

    it('uses only IPC when channel is "ipc"', async () => {
      const endpoint = setupWebSocket();
      const ctrl = new StopController({ endpoint, ipc });
      const result = await ctrl._stopViaIPC('req-1', 'ipc');
      expect(result).toBe(true);
      expect(ipc.send).toHaveBeenCalledWith('chat:stop', { requestId: 'req-1' });
    });

    it('skips WebSocket when channel is "ipc"', async () => {
      const stopFn = jest.fn();
      const endpoint = setupWebSocket(stopFn);
      const ctrl = new StopController({ endpoint, ipc });
      await ctrl._stopViaIPC('req-1', 'ipc');
      expect(stopFn).not.toHaveBeenCalled();
      expect(ipc.send).toHaveBeenCalled();
    });

    it('skips IPC when channel is "websocket"', async () => {
      const endpoint = setupWebSocket();
      const ctrl = new StopController({ endpoint, ipc });
      await ctrl._stopViaIPC('req-1', 'websocket');
      expect(ipc.send).not.toHaveBeenCalled();
    });

    it('falls back to IPC when WebSocket not available and channel is null', async () => {
      const ctrl = new StopController({ ipc });
      const result = await ctrl._stopViaIPC('req-1', null);
      expect(result).toBe(true);
      expect(ipc.send).toHaveBeenCalled();
    });

    it('returns false when no channel available', async () => {
      const ctrl = new StopController();
      const result = await ctrl._stopViaIPC('req-1', null);
      expect(result).toBe(false);
    });

    it('returns false when WebSocket stopRequest throws', async () => {
      setupWebSocket(() => {
        throw new Error('ws error');
      });
      const ctrl = new StopController();
      const result = await ctrl._stopViaIPC('req-1', 'websocket');
      expect(result).toBe(false);
    });

    it('returns false when IPC send throws', async () => {
      const badIpc = {
        send: jest.fn(() => {
          throw new Error('ipc error');
        }),
      };
      const ctrl = new StopController({ ipc: badIpc });
      const result = await ctrl._stopViaIPC('req-1', 'ipc');
      expect(result).toBe(false);
    });

    it('uses default channel=null when not provided', async () => {
      const stopFn = jest.fn();
      const endpoint = setupWebSocket(stopFn);
      const ctrl = new StopController({ endpoint, ipc });
      // Channel defaults to null — allows both WebSocket and IPC
      const result = await ctrl._stopViaIPC('req-1');
      expect(result).toBe(true);
      expect(stopFn).toHaveBeenCalledWith('req-1');
    });
  });

  // ================================================================
  // _getPendingRequestId
  // ================================================================
  describe('_getPendingRequestId()', () => {
    it('returns sendController requestId', () => {
      const ctrl = new StopController({ sendController });
      expect(ctrl._getPendingRequestId()).toBe('req-123');
    });

    it('returns null when sendController is null', () => {
      const ctrl = new StopController();
      expect(ctrl._getPendingRequestId()).toBeNull();
    });

    it('returns null when sendController lacks getPendingRequestId', () => {
      const ctrl = new StopController({ sendController: {} });
      expect(ctrl._getPendingRequestId()).toBeNull();
    });

    it('returns null when sendController.getPendingRequestId returns null', () => {
      sendController.getPendingRequestId.mockReturnValue(null);
      const ctrl = new StopController({ sendController });
      expect(ctrl._getPendingRequestId()).toBeNull();
    });
  });

  // ================================================================
  // _resolveStopChannel
  // ================================================================
  describe('_resolveStopChannel()', () => {
    it('returns "websocket" when endpoint.connection.stopRequest exists', () => {
      const endpoint = setupWebSocket();
      const ctrl = new StopController({ endpoint, ipc });
      expect(ctrl._resolveStopChannel()).toBe('websocket');
    });

    it('returns "ipc" when only IPC available', () => {
      const ctrl = new StopController({ ipc });
      expect(ctrl._resolveStopChannel()).toBe('ipc');
    });

    it('returns null when neither available', () => {
      const ctrl = new StopController();
      expect(ctrl._resolveStopChannel()).toBeNull();
    });

    it('prefers websocket over ipc', () => {
      const endpoint = setupWebSocket();
      const ctrl = new StopController({ endpoint, ipc });
      expect(ctrl._resolveStopChannel()).toBe('websocket');
    });

    it('returns null when endpoint exists but connection is missing', () => {
      const endpoint = {};
      const ctrl = new StopController({ endpoint });
      expect(ctrl._resolveStopChannel()).toBeNull();
    });

    it('returns null when endpoint.connection exists but stopRequest is not a function', () => {
      const endpoint = { connection: { stopRequest: 'not-a-function' } };
      const ctrl = new StopController({ endpoint });
      expect(ctrl._resolveStopChannel()).toBeNull();
    });

    it('returns null when ipc exists but send is not a function', () => {
      const ctrl = new StopController({ ipc: { send: 42 } });
      expect(ctrl._resolveStopChannel()).toBeNull();
    });
  });

  // ================================================================
  // _deriveCorrelationId
  // ================================================================
  describe('_deriveCorrelationId()', () => {
    it('returns requestId when parseSessionId returns truthy', () => {
      mockParseSessionId.mockReturnValue('parsed-session');
      const ctrl = new StopController();
      expect(ctrl._deriveCorrelationId('req-valid')).toBe('req-valid');
    });

    it('returns null when parseSessionId returns null', () => {
      mockParseSessionId.mockReturnValue(null);
      const ctrl = new StopController();
      expect(ctrl._deriveCorrelationId('req-invalid')).toBeNull();
    });

    it('returns null when parseSessionId returns empty string', () => {
      mockParseSessionId.mockReturnValue('');
      const ctrl = new StopController();
      expect(ctrl._deriveCorrelationId('req-empty')).toBeNull();
    });

    it('returns null when requestId is not a string', () => {
      const ctrl = new StopController();
      expect(ctrl._deriveCorrelationId(123)).toBeNull();
      expect(ctrl._deriveCorrelationId(null)).toBeNull();
      expect(ctrl._deriveCorrelationId(undefined)).toBeNull();
    });

    it('calls parseSessionId with the requestId', () => {
      const ctrl = new StopController();
      ctrl._deriveCorrelationId('test-id');
      expect(mockParseSessionId).toHaveBeenCalledWith('test-id');
    });

    it('does not call parseSessionId for non-string requestId', () => {
      mockParseSessionId.mockClear();
      const ctrl = new StopController();
      ctrl._deriveCorrelationId(42);
      expect(mockParseSessionId).not.toHaveBeenCalled();
    });
  });

  // ================================================================
  // _emitStopEvent
  // ================================================================
  describe('_emitStopEvent()', () => {
    it('emits event on eventBus', () => {
      const ctrl = new StopController({ eventBus });
      ctrl._emitStopEvent('test:event', { data: 1 });
      expect(eventBus.emit).toHaveBeenCalledWith('test:event', { data: 1 });
    });

    it('does nothing when eventBus is null', () => {
      const ctrl = new StopController();
      expect(() => ctrl._emitStopEvent('test:event', {})).not.toThrow();
    });
  });

  // ================================================================
  // dispose
  // ================================================================
  describe('dispose()', () => {
    it('nulls all dependency references', () => {
      const ctrl = new StopController({ ipc, eventBus, sendController });
      ctrl.dispose();
      expect(ctrl.ipc).toBeNull();
      expect(ctrl.eventBus).toBeNull();
      expect(ctrl.sendController).toBeNull();
    });

    it('resets isStopping to false', () => {
      const ctrl = new StopController();
      ctrl.isStopping = true;
      ctrl.dispose();
      expect(ctrl.isStopping).toBe(false);
    });

    it('safe to call twice', () => {
      const ctrl = new StopController({ ipc, eventBus, sendController });
      ctrl.dispose();
      expect(() => ctrl.dispose()).not.toThrow();
    });

    it('preserves metrics after dispose', () => {
      const ctrl = new StopController();
      ctrl.metrics.attempts = 5;
      ctrl.metrics.failures = 2;
      ctrl.dispose();
      expect(ctrl.metrics).toEqual({ attempts: 5, failures: 2 });
    });
  });

  // ================================================================
  // metrics tracking (integration)
  // ================================================================
  describe('metrics tracking', () => {
    it('increments attempts on each stop call', async () => {
      const endpoint = setupWebSocket();
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      await ctrl.stop('req-1');
      await ctrl.stop('req-2');
      expect(ctrl.metrics.attempts).toBe(2);
    });

    it('tracks failures separately from attempts', async () => {
      const endpoint = setupWebSocket();
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      await ctrl.stop('req-1'); // succeeds

      ctrl.endpoint = null;
      ctrl.ipc = null;
      const result = await ctrl.stop('req-2'); // fails (no channel)

      expect(ctrl.metrics.attempts).toBe(2);
      expect(ctrl.metrics.failures).toBe(1);
    });

    it('accumulates failures across multiple failed calls', async () => {
      const ctrl = new StopController({ eventBus, sendController });
      await ctrl.stop('req-1');
      await ctrl.stop('req-2');
      expect(ctrl.metrics.failures).toBe(2);
    });
  });

  // ================================================================
  // event payload structure
  // ================================================================
  describe('event payload structure', () => {
    it('includes correlationId in STOP_REQUESTED', async () => {
      const endpoint = setupWebSocket();
      mockParseSessionId.mockReturnValue('parsed');
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      await ctrl.stop('req-1');
      const call = eventBus.emit.mock.calls.find(
        (c) => c[0] === 'chat:stop:requested'
      );
      expect(call[1]).toHaveProperty('correlationId', 'req-1');
    });

    it('includes null correlationId when parseSessionId returns falsy', async () => {
      const endpoint = setupWebSocket();
      mockParseSessionId.mockReturnValue(null);
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      await ctrl.stop('req-1');
      const call = eventBus.emit.mock.calls.find(
        (c) => c[0] === 'chat:stop:requested'
      );
      expect(call[1]).toHaveProperty('correlationId', null);
    });

    it('includes timestamp in all events', async () => {
      const endpoint = setupWebSocket();
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      const before = Date.now();
      await ctrl.stop('req-1');
      const after = Date.now();

      for (const call of eventBus.emit.mock.calls) {
        expect(call[1].timestamp).toBeGreaterThanOrEqual(before);
        expect(call[1].timestamp).toBeLessThanOrEqual(after);
      }
    });

    it('includes requestId in REQUEST_STOPPED', async () => {
      const endpoint = setupWebSocket();
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      await ctrl.stop('req-42');
      const call = eventBus.emit.mock.calls.find(
        (c) => c[0] === 'chat:request:stopped'
      );
      expect(call[1]).toHaveProperty('requestId', 'req-42');
    });
  });

  // ================================================================
  // event ordering
  // ================================================================
  describe('event ordering', () => {
    it('emits STOP_REQUESTED before REQUEST_STOPPED on success', async () => {
      const endpoint = setupWebSocket();
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      await ctrl.stop('req-1');

      const eventNames = eventBus.emit.mock.calls.map((c) => c[0]);
      const reqIdx = eventNames.indexOf('chat:stop:requested');
      const stoppedIdx = eventNames.indexOf('chat:request:stopped');
      expect(reqIdx).toBeLessThan(stoppedIdx);
    });

    it('emits exactly 2 events on success (STOP_REQUESTED + REQUEST_STOPPED)', async () => {
      const endpoint = setupWebSocket();
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      await ctrl.stop('req-1');
      expect(eventBus.emit).toHaveBeenCalledTimes(2);
    });

    it('emits exactly 1 event on no-channel (MESSAGE_ERROR)', async () => {
      const ctrl = new StopController({ eventBus, sendController });
      await ctrl.stop('req-1');
      expect(eventBus.emit).toHaveBeenCalledTimes(1);
      expect(eventBus.emit).toHaveBeenCalledWith(
        'chat:message:error',
        expect.any(Object)
      );
    });
  });

  // ================================================================
  // EventTypes constant usage
  // ================================================================
  describe('EventTypes constant usage', () => {
    it('uses EventTypes.CHAT.MESSAGE_ERROR for no-channel error', async () => {
      const ctrl = new StopController({ eventBus, sendController });
      await ctrl.stop('req-1');
      expect(eventBus.emit).toHaveBeenCalledWith(
        mockEventTypes.CHAT.MESSAGE_ERROR,
        expect.any(Object)
      );
    });

    it('uses EventTypes.CHAT.STOP_REQUESTED for stop request', async () => {
      const endpoint = setupWebSocket();
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      await ctrl.stop('req-1');
      expect(eventBus.emit).toHaveBeenCalledWith(
        mockEventTypes.CHAT.STOP_REQUESTED,
        expect.any(Object)
      );
    });

    it('uses EventTypes.CHAT.REQUEST_STOPPED for completion', async () => {
      const endpoint = setupWebSocket();
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      await ctrl.stop('req-1');
      expect(eventBus.emit).toHaveBeenCalledWith(
        mockEventTypes.CHAT.REQUEST_STOPPED,
        expect.any(Object)
      );
    });
  });

  // ================================================================
  // module exports
  // ================================================================
  describe('module exports', () => {
    it('exports StopController class', () => {
      expect(StopController).toBeDefined();
      expect(typeof StopController).toBe('function');
    });
  });

  // ================================================================
  // BUG REGRESSIONS (ST-1)
  // ================================================================
  describe('bug regressions', () => {
    it('[ST-1] constructor initializes _isDisposed to false', () => {
      const ctrl = new StopController();
      expect(ctrl._isDisposed).toBe(false);
    });

    it('[ST-1] stop returns false after dispose', async () => {
      const endpoint = setupWebSocket();
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      ctrl.dispose();
      const result = await ctrl.stop('req-1');
      expect(result).toBe(false);
    });

    it('[ST-1] stop does not emit events after dispose', async () => {
      const endpoint = setupWebSocket();
      const ctrl = new StopController({ endpoint, eventBus, sendController });
      ctrl.dispose();
      await ctrl.stop('req-1');
      // eventBus was nulled by dispose, so no emit possible
      // No crash = success
    });

    it('[ST-1] init is no-op after dispose', () => {
      const ctrl = new StopController();
      ctrl.dispose();
      expect(() => ctrl.init()).not.toThrow();
    });

    it('[ST-1] dispose is idempotent (double-dispose safe)', () => {
      const ctrl = new StopController({ ipc, eventBus, sendController });
      ctrl.dispose();
      expect(() => ctrl.dispose()).not.toThrow();
      expect(ctrl._isDisposed).toBe(true);
    });
  });
});
