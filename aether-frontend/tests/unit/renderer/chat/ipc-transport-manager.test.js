'use strict';

// ---------------------------------------------------------------------------
// Mocks — plain functions survive resetMocks: true
// ---------------------------------------------------------------------------

const mockLog = {
  info: () => {},
  warn: () => {},
  error: jest.fn(),
  debug: () => {},
  trace: jest.fn(),
};
mockLog.child = () => mockLog;

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

const IPCTransportManager = require(
  '../../../../src/renderer/chat/modules/messaging/transport/IPCTransportManager'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createIPC() {
  return { send: jest.fn() };
}

function createManager(overrides = {}) {
  const ipc = createIPC();
  return {
    manager: new IPCTransportManager({ ipc, ...overrides }),
    ipc,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IPCTransportManager', () => {
  beforeEach(() => {
    mockLog.error.mockClear();
    mockLog.trace.mockClear();
  });

  // =========================================================================
  // Constructor
  // =========================================================================
  describe('constructor', () => {
    test('throws when options.ipc is not provided', () => {
      expect(() => new IPCTransportManager()).toThrow(
        '[IPCTransportManager] ipc is REQUIRED'
      );
    });

    test('throws when options.ipc is null', () => {
      expect(() => new IPCTransportManager({ ipc: null })).toThrow(
        '[IPCTransportManager] ipc is REQUIRED'
      );
    });

    test('throws when options.ipc is undefined', () => {
      expect(() => new IPCTransportManager({ ipc: undefined })).toThrow(
        '[IPCTransportManager] ipc is REQUIRED'
      );
    });

    test('throws when options is empty object (no ipc key)', () => {
      expect(() => new IPCTransportManager({})).toThrow(
        '[IPCTransportManager] ipc is REQUIRED'
      );
    });

    test('succeeds with valid ipc object', () => {
      const ipc = createIPC();
      const manager = new IPCTransportManager({ ipc });
      expect(manager.ipc).toBe(ipc);
    });

    test('stores reference to injected ipc bridge', () => {
      const ipc = createIPC();
      const manager = new IPCTransportManager({ ipc });
      expect(manager.ipc).toBe(ipc);
    });

    test('accepts ipc that has send as a function', () => {
      const ipc = { send: jest.fn() };
      expect(() => new IPCTransportManager({ ipc })).not.toThrow();
    });

    test('accepts ipc without send function (validates at send time)', () => {
      // Constructor only checks truthiness, not shape
      const ipc = { notSend: jest.fn() };
      expect(() => new IPCTransportManager({ ipc })).not.toThrow();
    });
  });

  // =========================================================================
  // send()
  // =========================================================================
  describe('send', () => {
    test('sends to IPC bridge with correct channel and payload', () => {
      const { manager, ipc } = createManager();
      const payload = { foo: 'bar', num: 42 };

      const result = manager.send('test:channel', payload);

      expect(result).toBe(true);
      expect(ipc.send).toHaveBeenCalledTimes(1);
      expect(ipc.send).toHaveBeenCalledWith('test:channel', payload);
    });

    test('returns true on successful send', () => {
      const { manager } = createManager();
      expect(manager.send('ch', {})).toBe(true);
    });

    test('returns false when ipc is null', () => {
      const { manager } = createManager();
      manager.ipc = null;

      const result = manager.send('ch', {});

      expect(result).toBe(false);
    });

    test('returns false when ipc.send is not a function', () => {
      const { manager } = createManager();
      manager.ipc = { send: 'not-a-function' };

      const result = manager.send('ch', {});

      expect(result).toBe(false);
    });

    test('returns false when ipc is an empty object', () => {
      const { manager } = createManager();
      manager.ipc = {};

      const result = manager.send('ch', {});

      expect(result).toBe(false);
    });

    test('logs error when IPC bridge is unavailable', () => {
      const { manager } = createManager();
      manager.ipc = null;

      manager.send('test:ch', {});

      expect(mockLog.error).toHaveBeenCalledWith(
        'IPC bridge unavailable',
        { channel: 'test:ch' }
      );
    });

    test('logs trace on successful send', () => {
      const { manager } = createManager();

      manager.send('my:channel', { data: 1 });

      expect(mockLog.trace).toHaveBeenCalledWith(
        'IPC sent',
        { channel: 'my:channel' }
      );
    });

    test('does not call ipc.send when bridge is unavailable', () => {
      const { manager, ipc } = createManager();
      manager.ipc = null;

      manager.send('ch', {});

      expect(ipc.send).not.toHaveBeenCalled();
    });

    test('passes payload by reference (no cloning)', () => {
      const { manager, ipc } = createManager();
      const payload = { nested: { deep: true } };

      manager.send('ch', payload);

      expect(ipc.send.mock.calls[0][1]).toBe(payload);
    });

    test('handles undefined payload', () => {
      const { manager, ipc } = createManager();

      const result = manager.send('ch', undefined);

      expect(result).toBe(true);
      expect(ipc.send).toHaveBeenCalledWith('ch', undefined);
    });

    test('handles null payload', () => {
      const { manager, ipc } = createManager();

      const result = manager.send('ch', null);

      expect(result).toBe(true);
      expect(ipc.send).toHaveBeenCalledWith('ch', null);
    });

    test('handles empty string channel', () => {
      const { manager, ipc } = createManager();

      const result = manager.send('', { a: 1 });

      expect(result).toBe(true);
      expect(ipc.send).toHaveBeenCalledWith('', { a: 1 });
    });

    test('returns false and logs error when ipc.send throws', () => {
      // Regression: send() now catches ipc.send() errors and returns false
      // instead of propagating exception (violating boolean return contract)
      const { manager } = createManager();
      manager.ipc.send.mockImplementation(() => {
        throw new Error('IPC channel closed');
      });

      const result = manager.send('err:ch', {});

      expect(result).toBe(false);
      expect(mockLog.error).toHaveBeenCalledWith(
        'IPC send failed',
        { channel: 'err:ch', error: 'IPC channel closed' }
      );
    });

    test('does not propagate exception from ipc.send', () => {
      const { manager } = createManager();
      manager.ipc.send.mockImplementation(() => {
        throw new TypeError('Cannot serialize payload');
      });

      expect(() => manager.send('ch', {})).not.toThrow();
    });
  });

  // =========================================================================
  // isAvailable()
  // =========================================================================
  describe('isAvailable', () => {
    test('returns true when ipc has send function', () => {
      const { manager } = createManager();
      expect(manager.isAvailable()).toBe(true);
    });

    test('returns false when ipc is null', () => {
      const { manager } = createManager();
      manager.ipc = null;
      expect(manager.isAvailable()).toBe(false);
    });

    test('returns false when ipc.send is not a function', () => {
      const { manager } = createManager();
      manager.ipc = { send: 42 };
      expect(manager.isAvailable()).toBe(false);
    });

    test('returns false when ipc is empty object', () => {
      const { manager } = createManager();
      manager.ipc = {};
      expect(manager.isAvailable()).toBe(false);
    });

    test('returns false after dispose()', () => {
      const { manager } = createManager();
      expect(manager.isAvailable()).toBe(true);

      manager.dispose();

      expect(manager.isAvailable()).toBe(false);
    });

    test('returns true with custom ipc that has send method', () => {
      const customIpc = { send: () => {}, otherMethod: () => {} };
      const manager = new IPCTransportManager({ ipc: customIpc });
      expect(manager.isAvailable()).toBe(true);
    });

    test('returns false when ipc.send is undefined', () => {
      const { manager } = createManager();
      manager.ipc = { send: undefined };
      expect(manager.isAvailable()).toBe(false);
    });
  });

  // =========================================================================
  // sendChatMessage()
  // =========================================================================
  describe('sendChatMessage', () => {
    test('sends correct payload on chat:send channel', () => {
      const { manager, ipc } = createManager();
      const metadata = {
        requestId: 'req-1',
        correlationId: 'corr-1',
        chatId: 'chat-42',
      };

      const result = manager.sendChatMessage('Hello world', metadata);

      expect(result).toBe(true);
      expect(ipc.send).toHaveBeenCalledTimes(1);
      expect(ipc.send).toHaveBeenCalledWith('chat:send', {
        message: 'Hello world',
        requestId: 'req-1',
        correlationId: 'corr-1',
        chatId: 'chat-42',
      });
    });

    test('uses chat:send as the IPC channel', () => {
      const { manager, ipc } = createManager();

      manager.sendChatMessage('msg', {});

      expect(ipc.send.mock.calls[0][0]).toBe('chat:send');
    });

    test('destructures metadata fields into payload', () => {
      const { manager, ipc } = createManager();

      manager.sendChatMessage('content', {
        requestId: 'r1',
        correlationId: 'c1',
        chatId: 'ch1',
      });

      const payload = ipc.send.mock.calls[0][1];
      expect(payload).toEqual({
        message: 'content',
        requestId: 'r1',
        correlationId: 'c1',
        chatId: 'ch1',
      });
    });

    test('sets undefined for missing metadata fields', () => {
      const { manager, ipc } = createManager();

      manager.sendChatMessage('hello', {});

      const payload = ipc.send.mock.calls[0][1];
      expect(payload).toEqual({
        message: 'hello',
        requestId: undefined,
        correlationId: undefined,
        chatId: undefined,
      });
    });

    test('defaults metadata to empty object when not provided', () => {
      const { manager, ipc } = createManager();

      const result = manager.sendChatMessage('test');

      expect(result).toBe(true);
      const payload = ipc.send.mock.calls[0][1];
      expect(payload).toEqual({
        message: 'test',
        requestId: undefined,
        correlationId: undefined,
        chatId: undefined,
      });
    });

    test('ignores extra metadata fields (only requestId, correlationId, chatId)', () => {
      const { manager, ipc } = createManager();

      manager.sendChatMessage('msg', {
        requestId: 'r1',
        correlationId: 'c1',
        chatId: 'ch1',
        extraField: 'should-not-appear',
        another: 999,
      });

      const payload = ipc.send.mock.calls[0][1];
      expect(payload).toEqual({
        message: 'msg',
        requestId: 'r1',
        correlationId: 'c1',
        chatId: 'ch1',
      });
      expect(payload).not.toHaveProperty('extraField');
      expect(payload).not.toHaveProperty('another');
    });

    test('forwards explicit message metadata when provided', () => {
      const { manager, ipc } = createManager();

      manager.sendChatMessage('msg', {
        requestId: 'r1',
        correlationId: 'c1',
        chatId: 'ch1',
        metadata: { source: 'proactive', context: { hidden: true } },
      });

      const payload = ipc.send.mock.calls[0][1];
      expect(payload).toEqual({
        message: 'msg',
        requestId: 'r1',
        correlationId: 'c1',
        chatId: 'ch1',
        metadata: { source: 'proactive', context: { hidden: true } },
      });
    });

    test('handles empty string content', () => {
      const { manager, ipc } = createManager();

      const result = manager.sendChatMessage('', { requestId: 'r1' });

      expect(result).toBe(true);
      expect(ipc.send.mock.calls[0][1].message).toBe('');
    });

    test('returns false after dispose', () => {
      const { manager } = createManager();
      manager.dispose();

      const result = manager.sendChatMessage('hello', { requestId: 'r1' });

      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // sendStopRequest()
  // =========================================================================
  describe('sendStopRequest', () => {
    test('sends on chat:stop channel with requestId', () => {
      const { manager, ipc } = createManager();

      const result = manager.sendStopRequest('req-123');

      expect(result).toBe(true);
      expect(ipc.send).toHaveBeenCalledTimes(1);
      expect(ipc.send).toHaveBeenCalledWith('chat:stop', {
        requestId: 'req-123',
      });
    });

    test('uses chat:stop as the IPC channel', () => {
      const { manager, ipc } = createManager();

      manager.sendStopRequest('x');

      expect(ipc.send.mock.calls[0][0]).toBe('chat:stop');
    });

    test('wraps requestId in object payload', () => {
      const { manager, ipc } = createManager();

      manager.sendStopRequest('stop-me');

      expect(ipc.send.mock.calls[0][1]).toEqual({ requestId: 'stop-me' });
    });

    test('handles undefined requestId', () => {
      const { manager, ipc } = createManager();

      const result = manager.sendStopRequest(undefined);

      expect(result).toBe(true);
      expect(ipc.send.mock.calls[0][1]).toEqual({ requestId: undefined });
    });

    test('handles null requestId', () => {
      const { manager, ipc } = createManager();

      const result = manager.sendStopRequest(null);

      expect(result).toBe(true);
      expect(ipc.send.mock.calls[0][1]).toEqual({ requestId: null });
    });

    test('returns false after dispose', () => {
      const { manager } = createManager();
      manager.dispose();

      const result = manager.sendStopRequest('req-1');

      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // dispose()
  // =========================================================================
  describe('dispose', () => {
    test('nulls the ipc reference', () => {
      const { manager } = createManager();
      expect(manager.ipc).not.toBeNull();

      manager.dispose();

      expect(manager.ipc).toBeNull();
    });

    test('subsequent send returns false', () => {
      const { manager } = createManager();

      manager.dispose();
      const result = manager.send('ch', {});

      expect(result).toBe(false);
    });

    test('subsequent isAvailable returns false', () => {
      const { manager } = createManager();

      manager.dispose();

      expect(manager.isAvailable()).toBe(false);
    });

    test('subsequent sendChatMessage returns false', () => {
      const { manager } = createManager();

      manager.dispose();

      expect(manager.sendChatMessage('x', {})).toBe(false);
    });

    test('subsequent sendStopRequest returns false', () => {
      const { manager } = createManager();

      manager.dispose();

      expect(manager.sendStopRequest('r1')).toBe(false);
    });

    test('can be called multiple times without error', () => {
      const { manager } = createManager();

      expect(() => {
        manager.dispose();
        manager.dispose();
        manager.dispose();
      }).not.toThrow();
    });

    test('ipc remains null after double dispose', () => {
      const { manager } = createManager();

      manager.dispose();
      manager.dispose();

      expect(manager.ipc).toBeNull();
    });
  });

  // =========================================================================
  // Lifecycle integration
  // =========================================================================
  describe('lifecycle integration', () => {
    test('full lifecycle: create → use → dispose → use fails', () => {
      const ipc = createIPC();
      const manager = new IPCTransportManager({ ipc });

      // Phase 1: use
      expect(manager.isAvailable()).toBe(true);
      expect(manager.send('ch', { a: 1 })).toBe(true);
      expect(manager.sendChatMessage('hello', { requestId: 'r1' })).toBe(true);
      expect(manager.sendStopRequest('r1')).toBe(true);
      expect(ipc.send).toHaveBeenCalledTimes(3);

      // Phase 2: dispose
      manager.dispose();
      expect(manager.isAvailable()).toBe(false);

      // Phase 3: use after dispose — all return false
      expect(manager.send('ch', {})).toBe(false);
      expect(manager.sendChatMessage('x', {})).toBe(false);
      expect(manager.sendStopRequest('r1')).toBe(false);

      // ipc.send should NOT have been called after dispose
      expect(ipc.send).toHaveBeenCalledTimes(3);
    });

    test('multiple sends accumulate correctly', () => {
      const { manager, ipc } = createManager();

      manager.send('a', { v: 1 });
      manager.send('b', { v: 2 });
      manager.send('c', { v: 3 });

      expect(ipc.send).toHaveBeenCalledTimes(3);
      expect(ipc.send).toHaveBeenNthCalledWith(1, 'a', { v: 1 });
      expect(ipc.send).toHaveBeenNthCalledWith(2, 'b', { v: 2 });
      expect(ipc.send).toHaveBeenNthCalledWith(3, 'c', { v: 3 });
    });
  });

  // =========================================================================
  // Module exports
  // =========================================================================
  describe('module exports', () => {
    test('exports IPCTransportManager constructor', () => {
      expect(typeof IPCTransportManager).toBe('function');
    });

    test('instances have expected methods', () => {
      const { manager } = createManager();
      expect(typeof manager.send).toBe('function');
      expect(typeof manager.isAvailable).toBe('function');
      expect(typeof manager.sendChatMessage).toBe('function');
      expect(typeof manager.sendStopRequest).toBe('function');
      expect(typeof manager.dispose).toBe('function');
    });
  });
});
