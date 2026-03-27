'use strict';

// ---------------------------------------------------------------------------
// Mocks — plain functions survive resetMocks: true
// ---------------------------------------------------------------------------

const mockLog = {
  info: () => {},
  warn: jest.fn(),
  error: jest.fn(),
  debug: () => {},
  trace: jest.fn(),
};
mockLog.child = () => mockLog;

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

const { EventTypes } = require('../../../../src/core/events/EventTypes');
const EventEmissionManager = require(
  '../../../../src/renderer/chat/modules/messaging/events/EventEmissionManager'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createEventBus() {
  return { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
}

function createManager(overrides = {}) {
  const eventBus = createEventBus();
  const mgr = new EventEmissionManager({ eventBus, ...overrides });
  return { mgr, eventBus };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventEmissionManager', () => {
  beforeEach(() => {
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    mockLog.trace.mockClear();
  });

  // =========================================================================
  // Constructor
  // =========================================================================
  describe('constructor', () => {
    test('does NOT throw when eventBus is missing (graceful no-op mode)', () => {
      expect(() => new EventEmissionManager()).not.toThrow();
    });

    test('stores eventBus reference', () => {
      const eventBus = createEventBus();
      const mgr = new EventEmissionManager({ eventBus });
      expect(mgr.eventBus).toBe(eventBus);
    });

    test('defaults eventBus to null when not provided', () => {
      const mgr = new EventEmissionManager();
      expect(mgr.eventBus).toBeNull();
    });

    test('defaults eventBus to null when null is provided', () => {
      const mgr = new EventEmissionManager({ eventBus: null });
      expect(mgr.eventBus).toBeNull();
    });
  });

  // =========================================================================
  // emit()
  // =========================================================================
  describe('emit', () => {
    test('emits event to eventBus with correct type and payload', () => {
      const { mgr, eventBus } = createManager();
      const payload = { msg: 'hello', id: 1 };

      mgr.emit('test:event', payload);

      expect(eventBus.emit).toHaveBeenCalledTimes(1);
      expect(eventBus.emit).toHaveBeenCalledWith('test:event', payload);
    });

    test('logs trace on successful emission', () => {
      const { mgr } = createManager();

      mgr.emit('my:event', {});

      expect(mockLog.trace).toHaveBeenCalledWith(
        'Event emitted',
        { event: 'my:event' }
      );
    });

    test('skips emission when eventBus is null', () => {
      const mgr = new EventEmissionManager({ eventBus: null });

      mgr.emit('test:event', {});

      expect(mockLog.trace).toHaveBeenCalledWith(
        'EventBus unavailable - skipping emission'
      );
    });

    test('skips emission after dispose', () => {
      const { mgr, eventBus } = createManager();
      mgr.dispose();

      mgr.emit('test:event', {});

      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    test('warns and returns on empty string eventType', () => {
      const { mgr, eventBus } = createManager();

      mgr.emit('', {});

      expect(mockLog.warn).toHaveBeenCalledWith('Invalid event type');
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    test('warns and returns on null eventType', () => {
      const { mgr, eventBus } = createManager();

      mgr.emit(null, {});

      expect(mockLog.warn).toHaveBeenCalledWith('Invalid event type');
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    test('warns and returns on undefined eventType', () => {
      const { mgr, eventBus } = createManager();

      mgr.emit(undefined, {});

      expect(mockLog.warn).toHaveBeenCalledWith('Invalid event type');
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    test('passes payload by reference', () => {
      const { mgr, eventBus } = createManager();
      const payload = { nested: { deep: true } };

      mgr.emit('ev', payload);

      expect(eventBus.emit.mock.calls[0][1]).toBe(payload);
    });

    test('handles undefined payload', () => {
      const { mgr, eventBus } = createManager();

      mgr.emit('ev', undefined);

      expect(eventBus.emit).toHaveBeenCalledWith('ev', undefined);
    });

    test('handles null payload', () => {
      const { mgr, eventBus } = createManager();

      mgr.emit('ev', null);

      expect(eventBus.emit).toHaveBeenCalledWith('ev', null);
    });
  });

  // =========================================================================
  // emitMessageSending()
  // =========================================================================
  describe('emitMessageSending', () => {
    test('emits EventTypes.CHAT.MESSAGE_SENDING with payload', () => {
      const { mgr, eventBus } = createManager();
      const payload = { requestId: 'r1', content: 'msg' };

      mgr.emitMessageSending(payload);

      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CHAT.MESSAGE_SENDING,
        payload
      );
    });

    test('uses correct event type string', () => {
      const { mgr, eventBus } = createManager();

      mgr.emitMessageSending({});

      expect(eventBus.emit.mock.calls[0][0]).toBe('chat:message:sending');
    });

    test('no-ops when eventBus is null', () => {
      const mgr = new EventEmissionManager();

      expect(() => mgr.emitMessageSending({})).not.toThrow();
    });
  });

  // =========================================================================
  // emitMessageSent()
  // =========================================================================
  describe('emitMessageSent', () => {
    test('emits EventTypes.CHAT.MESSAGE_SENT with payload', () => {
      const { mgr, eventBus } = createManager();
      const payload = { requestId: 'r1' };

      mgr.emitMessageSent(payload);

      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CHAT.MESSAGE_SENT,
        payload
      );
    });

    test('uses correct event type string', () => {
      const { mgr, eventBus } = createManager();

      mgr.emitMessageSent({});

      expect(eventBus.emit.mock.calls[0][0]).toBe('chat:message:sent');
    });
  });

  // =========================================================================
  // emitMessageError()
  // =========================================================================
  describe('emitMessageError', () => {
    test('emits EventTypes.CHAT.MESSAGE_ERROR with payload', () => {
      const { mgr, eventBus } = createManager();
      const payload = { error: 'failed', requestId: 'r1' };

      mgr.emitMessageError(payload);

      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CHAT.MESSAGE_ERROR,
        payload
      );
    });

    test('uses correct event type string', () => {
      const { mgr, eventBus } = createManager();

      mgr.emitMessageError({});

      expect(eventBus.emit.mock.calls[0][0]).toBe('chat:message:error');
    });
  });

  // =========================================================================
  // emitStopRequested()
  // =========================================================================
  describe('emitStopRequested', () => {
    test('emits stop requested event with payload', () => {
      const { mgr, eventBus } = createManager();
      const payload = { requestId: 'stop-1' };

      mgr.emitStopRequested(payload);

      expect(eventBus.emit).toHaveBeenCalledWith(
        'chat:stop:requested',
        payload
      );
    });

    test('resolves to EventTypes.CHAT.STOP_REQUESTED when available', () => {
      const { mgr, eventBus } = createManager();

      mgr.emitStopRequested({});

      // EventTypes.CHAT.STOP_REQUESTED = 'chat:stop:requested'
      expect(eventBus.emit.mock.calls[0][0]).toBe(
        EventTypes.CHAT.STOP_REQUESTED
      );
    });
  });

  // =========================================================================
  // emitStopCompleted()
  // =========================================================================
  describe('emitStopCompleted', () => {
    test('emits stop completed event with payload', () => {
      const { mgr, eventBus } = createManager();
      const payload = { requestId: 'stop-1' };

      mgr.emitStopCompleted(payload);

      expect(eventBus.emit).toHaveBeenCalledWith(
        'chat:request:stopped',
        payload
      );
    });

    test('resolves to EventTypes.CHAT.REQUEST_STOPPED when available', () => {
      const { mgr, eventBus } = createManager();

      mgr.emitStopCompleted({});

      expect(eventBus.emit.mock.calls[0][0]).toBe(
        EventTypes.CHAT.REQUEST_STOPPED
      );
    });
  });

  // =========================================================================
  // emitStopError()
  // =========================================================================
  describe('emitStopError', () => {
    test('emits stop error event with payload', () => {
      const { mgr, eventBus } = createManager();
      const payload = { error: 'stop failed' };

      mgr.emitStopError(payload);

      expect(eventBus.emit).toHaveBeenCalledWith(
        'chat:message:error',
        payload
      );
    });

    test('uses same event type as emitMessageError (shared error channel)', () => {
      const { mgr, eventBus } = createManager();

      mgr.emitStopError({ type: 'stop' });
      mgr.emitMessageError({ type: 'message' });

      expect(eventBus.emit.mock.calls[0][0]).toBe(eventBus.emit.mock.calls[1][0]);
    });
  });

  // =========================================================================
  // emitProcessingState()
  // =========================================================================
  describe('emitProcessingState', () => {
    test('emits message:processing with processing flag true', () => {
      const { mgr, eventBus } = createManager();

      mgr.emitProcessingState(true);

      expect(eventBus.emit).toHaveBeenCalledWith('message:processing', {
        processing: true,
      });
    });

    test('emits message:processing with processing flag false', () => {
      const { mgr, eventBus } = createManager();

      mgr.emitProcessingState(false);

      expect(eventBus.emit).toHaveBeenCalledWith('message:processing', {
        processing: false,
      });
    });

    test('no-ops when eventBus is null', () => {
      const mgr = new EventEmissionManager();

      expect(() => mgr.emitProcessingState(true)).not.toThrow();
    });

    test('no-ops after dispose', () => {
      const { mgr, eventBus } = createManager();
      mgr.dispose();

      mgr.emitProcessingState(true);

      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    test('uses hardcoded event name (bypasses emit() method)', () => {
      const { mgr, eventBus } = createManager();

      mgr.emitProcessingState(true);

      // Only 1 call — direct to eventBus.emit, not through emit()
      expect(eventBus.emit).toHaveBeenCalledTimes(1);
      expect(eventBus.emit.mock.calls[0][0]).toBe('message:processing');
    });
  });

  // =========================================================================
  // emitStopModeState()
  // =========================================================================
  describe('emitStopModeState', () => {
    test('emits message:stop-mode with enabled flag true', () => {
      const { mgr, eventBus } = createManager();

      mgr.emitStopModeState(true);

      expect(eventBus.emit).toHaveBeenCalledWith('message:stop-mode', {
        enabled: true,
      });
    });

    test('emits message:stop-mode with enabled flag false', () => {
      const { mgr, eventBus } = createManager();

      mgr.emitStopModeState(false);

      expect(eventBus.emit).toHaveBeenCalledWith('message:stop-mode', {
        enabled: false,
      });
    });

    test('no-ops when eventBus is null', () => {
      const mgr = new EventEmissionManager();

      expect(() => mgr.emitStopModeState(true)).not.toThrow();
    });

    test('no-ops after dispose', () => {
      const { mgr, eventBus } = createManager();
      mgr.dispose();

      mgr.emitStopModeState(true);

      expect(eventBus.emit).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // isAvailable()
  // =========================================================================
  describe('isAvailable', () => {
    test('returns true when eventBus is present', () => {
      const { mgr } = createManager();
      expect(mgr.isAvailable()).toBe(true);
    });

    test('returns false when eventBus is null', () => {
      const mgr = new EventEmissionManager();
      expect(mgr.isAvailable()).toBe(false);
    });

    test('returns false after dispose', () => {
      const { mgr } = createManager();
      mgr.dispose();
      expect(mgr.isAvailable()).toBe(false);
    });
  });

  // =========================================================================
  // dispose()
  // =========================================================================
  describe('dispose', () => {
    test('nulls eventBus', () => {
      const { mgr } = createManager();

      mgr.dispose();

      expect(mgr.eventBus).toBeNull();
    });

    test('subsequent emit is no-op', () => {
      const { mgr, eventBus } = createManager();
      mgr.dispose();

      mgr.emit('test', {});

      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    test('can be called multiple times', () => {
      const { mgr } = createManager();

      expect(() => {
        mgr.dispose();
        mgr.dispose();
      }).not.toThrow();
    });
  });

  // =========================================================================
  // Lifecycle integration
  // =========================================================================
  describe('lifecycle integration', () => {
    test('full lifecycle: create → emit various → dispose → emit fails', () => {
      const { mgr, eventBus } = createManager();

      // Emit various types
      mgr.emitMessageSending({ r: 1 });
      mgr.emitMessageSent({ r: 1 });
      mgr.emitProcessingState(true);
      mgr.emitStopRequested({ r: 2 });
      mgr.emitStopCompleted({ r: 2 });
      mgr.emitStopModeState(false);

      expect(eventBus.emit).toHaveBeenCalledTimes(6);

      // Dispose
      mgr.dispose();

      // All emissions are now no-ops
      mgr.emitMessageSending({ r: 3 });
      mgr.emitProcessingState(true);
      mgr.emit('custom', {});

      expect(eventBus.emit).toHaveBeenCalledTimes(6);
    });

    test('all convenience methods route through emit() except processing/stopMode', () => {
      const { mgr, eventBus } = createManager();

      // These go through emit() — which validates eventType
      mgr.emitMessageSending({});
      mgr.emitMessageSent({});
      mgr.emitMessageError({});
      mgr.emitStopRequested({});
      mgr.emitStopCompleted({});
      mgr.emitStopError({});

      // These bypass emit() — direct eventBus.emit
      mgr.emitProcessingState(true);
      mgr.emitStopModeState(true);

      expect(eventBus.emit).toHaveBeenCalledTimes(8);
    });
  });

  // =========================================================================
  // Module exports
  // =========================================================================
  describe('module exports', () => {
    test('exports EventEmissionManager constructor', () => {
      expect(typeof EventEmissionManager).toBe('function');
    });

    test('instances have expected methods', () => {
      const { mgr } = createManager();
      expect(typeof mgr.emit).toBe('function');
      expect(typeof mgr.emitMessageSending).toBe('function');
      expect(typeof mgr.emitMessageSent).toBe('function');
      expect(typeof mgr.emitMessageError).toBe('function');
      expect(typeof mgr.emitStopRequested).toBe('function');
      expect(typeof mgr.emitStopCompleted).toBe('function');
      expect(typeof mgr.emitStopError).toBe('function');
      expect(typeof mgr.emitProcessingState).toBe('function');
      expect(typeof mgr.emitStopModeState).toBe('function');
      expect(typeof mgr.isAvailable).toBe('function');
      expect(typeof mgr.dispose).toBe('function');
    });
  });
});
