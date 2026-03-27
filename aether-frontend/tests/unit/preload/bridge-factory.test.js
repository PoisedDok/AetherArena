'use strict';

// ============================================================================
// Mocks — all bridge-factory dependencies
// ============================================================================
jest.mock('../../../src/core/utils/logger', () => ({
  createLogger: jest.fn(),
}));
jest.mock('../../../src/preload/ipc/channels', () => ({
  getChannelConfig: jest.fn(),
  canSend: jest.fn(),
  canReceive: jest.fn(),
}));
jest.mock('../../../src/preload/ipc/payload-schemas', () => ({
  validatePayload: jest.fn(),
}));
jest.mock('../../../src/preload/common/rate-limiter', () => ({
  createRateLimiter: jest.fn(),
}));
jest.mock('../../../src/preload/common/size-validator', () => ({
  createSizeValidator: jest.fn(),
}));

const { createLogger } = require('../../../src/core/utils/logger');
const { getChannelConfig, canSend, canReceive } = require('../../../src/preload/ipc/channels');
const { validatePayload } = require('../../../src/preload/ipc/payload-schemas');
const { createRateLimiter } = require('../../../src/preload/common/rate-limiter');
const { createSizeValidator } = require('../../../src/preload/common/size-validator');
const { createBridge } = require('../../../src/preload/common/bridge-factory');

// ============================================================================
// Shared test state — rebuilt before each test
// ============================================================================
let mockLog, mockRateLimiter, mockSizeValidator, mockIpc;
let capturedRateLimiterOpts, capturedSizeValidatorOpts;

beforeEach(() => {
  // Projects in jest.config.js do not inherit top-level clearMocks/resetMocks.
  // Explicit clearing prevents mock.calls accumulation across tests.
  jest.clearAllMocks();

  mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  createLogger.mockReturnValue(mockLog);

  mockRateLimiter = {
    check: jest.fn().mockReturnValue(true),
    getStats: jest.fn().mockReturnValue({ totalCalls: 0, rateLimited: 0 }),
    enabled: true,
  };
  capturedRateLimiterOpts = null;
  createRateLimiter.mockImplementation((opts) => {
    capturedRateLimiterOpts = opts;
    return mockRateLimiter;
  });

  mockSizeValidator = {
    validate: jest.fn().mockReturnValue({ valid: true }),
    getStats: jest.fn().mockReturnValue({ totalChecks: 0, violations: 0 }),
    enabled: true,
  };
  capturedSizeValidatorOpts = null;
  createSizeValidator.mockImplementation((opts) => {
    capturedSizeValidatorOpts = opts;
    return mockSizeValidator;
  });

  getChannelConfig.mockReturnValue({
    send: ['test:send'],
    receive: ['test:receive'],
  });
  canSend.mockImplementation((ch) => ch === 'test:send');
  canReceive.mockImplementation((ch) => ch === 'test:receive');
  validatePayload.mockReturnValue({ valid: true });

  mockIpc = {
    send: jest.fn(),
    invoke: jest.fn().mockResolvedValue('ipc-result'),
    on: jest.fn(),
    once: jest.fn(),
    removeListener: jest.fn(),
    removeAllListeners: jest.fn(),
  };
});

/** Helper: create a bridge with defaults (DRY for tests that just need a working bridge). */
function makeBridge(overrides = {}) {
  return createBridge({ ipcRenderer: mockIpc, ...overrides });
}

// ============================================================================
// createBridge — parameter validation
// ============================================================================
describe('createBridge', () => {

  describe('parameter validation', () => {
    it('throws if ipcRenderer is not provided', () => {
      expect(() => createBridge({})).toThrow('[SecureRendererBridge] ipcRenderer instance is required');
    });

    it('throws with exact Error instance', () => {
      let caught;
      try { createBridge({}); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(Error);
      expect(caught.message).toBe('[SecureRendererBridge] ipcRenderer instance is required');
    });

    it('accepts minimal options with ipcRenderer', () => {
      expect(() => makeBridge()).not.toThrow();
    });

    it('passes context to createLogger component name', () => {
      makeBridge({ context: 'chatWindow' });
      expect(createLogger).toHaveBeenCalledWith({ component: 'IPC:chatWindow' });
    });

    it('defaults context to mainWindow', () => {
      makeBridge();
      expect(createLogger).toHaveBeenCalledWith({ component: 'IPC:mainWindow' });
    });
  });

  // --------------------------------------------------------------------------
  // Bridge object properties
  // --------------------------------------------------------------------------
  describe('bridge properties', () => {
    it('bridge is frozen', () => {
      const bridge = makeBridge();
      expect(Object.isFrozen(bridge)).toBe(true);
    });

    it('__aetherGuarded is true and non-enumerable', () => {
      const bridge = makeBridge();
      expect(bridge.__aetherGuarded).toBe(true);
      const desc = Object.getOwnPropertyDescriptor(bridge, '__aetherGuarded');
      expect(desc.enumerable).toBe(false);
      expect(desc.configurable).toBe(false);
      expect(desc.writable).toBe(false);
    });

    it('__aetherContext matches the context option', () => {
      const bridge = makeBridge({ context: 'artifactsWindow' });
      expect(bridge.__aetherContext).toBe('artifactsWindow');
      const desc = Object.getOwnPropertyDescriptor(bridge, '__aetherContext');
      expect(desc.enumerable).toBe(false);
    });

    it('__aetherRateLimiter references the rate limiter instance', () => {
      const bridge = makeBridge();
      expect(bridge.__aetherRateLimiter).toBe(mockRateLimiter);
    });

    it('__aetherSizeValidator references the size validator instance', () => {
      const bridge = makeBridge();
      expect(bridge.__aetherSizeValidator).toBe(mockSizeValidator);
    });

    it('bridge exposes expected methods', () => {
      const bridge = makeBridge();
      expect(typeof bridge.send).toBe('function');
      expect(typeof bridge.invoke).toBe('function');
      expect(typeof bridge.on).toBe('function');
      expect(typeof bridge.once).toBe('function');
      expect(typeof bridge.off).toBe('function');
      expect(typeof bridge.removeListener).toBe('function');
      expect(typeof bridge.removeAllListeners).toBe('function');
      expect(typeof bridge.getMetadata).toBe('function');
      expect(typeof bridge.getStats).toBe('function');
    });
  });

  // --------------------------------------------------------------------------
  // onRateLimited / onViolation callbacks (captured during construction)
  // --------------------------------------------------------------------------
  describe('construction callbacks', () => {
    it('onRateLimited logs warning and calls onError', () => {
      const onError = jest.fn();
      makeBridge({ onError });

      capturedRateLimiterOpts.onRateLimited('test:send', { tokens: 0 });

      expect(mockLog.warn).toHaveBeenCalledWith('rate limited', expect.objectContaining({ channel: 'test:send' }));
      expect(onError).toHaveBeenCalledTimes(1);
      const [err, info] = onError.mock.calls[0];
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('Rate limited');
      expect(err.message).toContain('test:send');
      expect(info.reason).toBe('rate_limit');
    });

    it('onRateLimited does not throw when onError is null', () => {
      makeBridge({ onError: null });
      expect(() => capturedRateLimiterOpts.onRateLimited('ch', {})).not.toThrow();
    });

    it('onViolation logs error and calls onError', () => {
      const onError = jest.fn();
      makeBridge({ onError });

      capturedSizeValidatorOpts.onViolation('test:send', 'Payload too large', { size: 999 });

      expect(mockLog.error).toHaveBeenCalledWith('size violation', expect.objectContaining({ channel: 'test:send' }));
      expect(onError).toHaveBeenCalledTimes(1);
      const [err, info] = onError.mock.calls[0];
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe('Payload too large');
      expect(info.reason).toBe('size_violation');
    });

    it('onViolation does not throw when onError is null', () => {
      makeBridge({ onError: null });
      expect(() => capturedSizeValidatorOpts.onViolation('ch', 'err', {})).not.toThrow();
    });

    it('passes rateLimiter options through', () => {
      makeBridge({ enableRateLimiting: false, rateLimiter: { burst: 100 } });
      expect(capturedRateLimiterOpts.enabled).toBe(false);
      expect(capturedRateLimiterOpts.burst).toBe(100);
    });

    it('passes sizeValidator options through', () => {
      makeBridge({ enableSizeValidation: false, sizeValidator: { maxDepth: 5 } });
      expect(capturedSizeValidatorOpts.enabled).toBe(false);
      expect(capturedSizeValidatorOpts.maxDepth).toBe(5);
    });
  });

  // --------------------------------------------------------------------------
  // send()
  // --------------------------------------------------------------------------
  describe('send()', () => {
    it('calls ipcRenderer.send on allowed channel', () => {
      const bridge = makeBridge();
      bridge.send('test:send', { data: 1 });
      expect(mockIpc.send).toHaveBeenCalledWith('test:send', { data: 1 });
    });

    it('throws on disallowed channel', () => {
      const bridge = makeBridge();
      expect(() => bridge.send('blocked:channel', {}))
        .toThrow(/Send validation failed/);
    });

    it('logs error on disallowed channel', () => {
      const bridge = makeBridge();
      try { bridge.send('blocked:channel', {}); } catch (_) {}
      expect(mockLog.error).toHaveBeenCalledWith('send validation failed', expect.objectContaining({ channel: 'blocked:channel' }));
    });

    it('calls onError on disallowed channel', () => {
      const onError = jest.fn();
      const bridge = makeBridge({ onError });
      try { bridge.send('blocked:channel', {}); } catch (_) {}
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
      expect(onError.mock.calls[0][1]).toEqual(expect.objectContaining({ channel: 'blocked:channel' }));
    });

    it('throws when rate limited', () => {
      mockRateLimiter.check.mockReturnValue(false);
      const bridge = makeBridge();
      expect(() => bridge.send('test:send', {}))
        .toThrow(/Rate limited/);
    });

    it('throws when size validation fails', () => {
      mockSizeValidator.validate.mockReturnValue({ valid: false, error: 'Too large' });
      const bridge = makeBridge();
      expect(() => bridge.send('test:send', {}))
        .toThrow(/Too large/);
    });

    it('throws when payload validation fails', () => {
      validatePayload.mockReturnValue({ valid: false, error: 'Invalid field "x"' });
      const bridge = makeBridge();
      expect(() => bridge.send('test:send', {}))
        .toThrow(/Invalid field "x"/);
    });

    it('does not call ipcRenderer.send when validation fails', () => {
      canSend.mockReturnValue(false);
      const bridge = makeBridge();
      try { bridge.send('blocked', {}); } catch (_) {}
      expect(mockIpc.send).not.toHaveBeenCalled();
    });

    it('error message includes context name', () => {
      const bridge = makeBridge({ context: 'chatWindow' });
      let caught;
      try { bridge.send('blocked', {}); } catch (e) { caught = e; }
      expect(caught.message).toContain('IPC:chatWindow');
    });
  });

  // --------------------------------------------------------------------------
  // invoke()
  // --------------------------------------------------------------------------
  describe('invoke()', () => {
    it('calls ipcRenderer.invoke on allowed channel and returns result', async () => {
      const bridge = makeBridge();
      const result = await bridge.invoke('test:send', { q: 'hello' });
      expect(mockIpc.invoke).toHaveBeenCalledWith('test:send', { q: 'hello' });
      expect(result).toBe('ipc-result');
    });

    it('throws on disallowed channel', async () => {
      const bridge = makeBridge();
      await expect(bridge.invoke('blocked', {})).rejects.toThrow(/Invoke validation failed/);
    });

    it('throws when ipcRenderer.invoke is not a function', async () => {
      mockIpc.invoke = undefined;
      const bridge = makeBridge();
      await expect(bridge.invoke('test:send', {}))
        .rejects.toThrow('[IPC Bridge] ipcRenderer.invoke is not available in this context');
    });

    it('calls onError on disallowed channel', async () => {
      const onError = jest.fn();
      const bridge = makeBridge({ onError });
      try { await bridge.invoke('blocked', {}); } catch (_) {}
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it('throws when rate limited', async () => {
      mockRateLimiter.check.mockReturnValue(false);
      const bridge = makeBridge();
      await expect(bridge.invoke('test:send', {})).rejects.toThrow(/Rate limited/);
    });
  });

  // --------------------------------------------------------------------------
  // on()
  // --------------------------------------------------------------------------
  describe('on()', () => {
    it('registers listener via ipcRenderer.on', () => {
      const bridge = makeBridge();
      const fn = jest.fn();
      bridge.on('test:receive', fn);
      expect(mockIpc.on).toHaveBeenCalledTimes(1);
      expect(mockIpc.on).toHaveBeenCalledWith('test:receive', expect.any(Function));
    });

    it('throws on disallowed channel', () => {
      const bridge = makeBridge();
      expect(() => bridge.on('blocked', jest.fn()))
        .toThrow(/Receive validation failed/);
    });

    it('calls onError on disallowed channel', () => {
      const onError = jest.fn();
      const bridge = makeBridge({ onError });
      try { bridge.on('blocked', jest.fn()); } catch (_) {}
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it('throws if listener is not a function', () => {
      const bridge = makeBridge();
      expect(() => bridge.on('test:receive', 'not-a-fn'))
        .toThrow('Listener must be a function');
    });

    it('wrapped listener strips event argument, passes remaining args', () => {
      const bridge = makeBridge();
      const fn = jest.fn();
      bridge.on('test:receive', fn);

      // Capture the wrapped listener passed to ipcRenderer.on
      const wrappedListener = mockIpc.on.mock.calls[0][1];
      const fakeEvent = { sender: {} };
      wrappedListener(fakeEvent, 'arg1', 'arg2', 'arg3');

      expect(fn).toHaveBeenCalledWith('arg1', 'arg2', 'arg3');
      expect(fn).not.toHaveBeenCalledWith(expect.objectContaining({ sender: {} }));
    });

    it('returns a cleanup function that removes the listener', () => {
      const bridge = makeBridge();
      const fn = jest.fn();
      const cleanup = bridge.on('test:receive', fn);

      expect(typeof cleanup).toBe('function');
      cleanup();

      const wrappedListener = mockIpc.on.mock.calls[0][1];
      expect(mockIpc.removeListener).toHaveBeenCalledWith('test:receive', wrappedListener);
    });
  });

  // --------------------------------------------------------------------------
  // once()
  // --------------------------------------------------------------------------
  describe('once()', () => {
    it('registers listener via ipcRenderer.once', () => {
      const bridge = makeBridge();
      bridge.once('test:receive', jest.fn());
      expect(mockIpc.once).toHaveBeenCalledTimes(1);
      expect(mockIpc.once).toHaveBeenCalledWith('test:receive', expect.any(Function));
    });

    it('throws on disallowed channel', () => {
      const bridge = makeBridge();
      expect(() => bridge.once('blocked', jest.fn()))
        .toThrow(/Receive validation failed/);
    });

    it('calls onError on disallowed channel', () => {
      const onError = jest.fn();
      const bridge = makeBridge({ onError });
      try { bridge.once('blocked', jest.fn()); } catch (_) {}
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it('throws if listener is not a function', () => {
      const bridge = makeBridge();
      expect(() => bridge.once('test:receive', null))
        .toThrow('Listener must be a function');
    });

    it('wrapped listener strips event argument', () => {
      const bridge = makeBridge();
      const fn = jest.fn();
      bridge.once('test:receive', fn);

      const wrappedListener = mockIpc.once.mock.calls[0][1];
      wrappedListener({ sender: {} }, 'data');
      expect(fn).toHaveBeenCalledWith('data');
    });

    it('returns a cleanup function', () => {
      const bridge = makeBridge();
      const fn = jest.fn();
      const cleanup = bridge.once('test:receive', fn);

      expect(typeof cleanup).toBe('function');
      cleanup();

      const wrappedListener = mockIpc.once.mock.calls[0][1];
      expect(mockIpc.removeListener).toHaveBeenCalledWith('test:receive', wrappedListener);
    });
  });

  // --------------------------------------------------------------------------
  // removeListener()
  // --------------------------------------------------------------------------
  describe('removeListener()', () => {
    it('removes a previously registered listener using the wrapped version', () => {
      const bridge = makeBridge();
      const fn = jest.fn();
      bridge.on('test:receive', fn);

      const wrappedListener = mockIpc.on.mock.calls[0][1];
      bridge.removeListener('test:receive', fn);

      expect(mockIpc.removeListener).toHaveBeenCalledWith('test:receive', wrappedListener);
    });

    it('falls back to original listener if not in registry', () => {
      const bridge = makeBridge();
      const fn = jest.fn();
      // fn was never registered via bridge.on — not in the listener registry
      bridge.removeListener('test:receive', fn);

      expect(mockIpc.removeListener).toHaveBeenCalledWith('test:receive', fn);
    });

    it('warns and returns on disallowed channel without throwing', () => {
      const bridge = makeBridge();
      expect(() => bridge.removeListener('blocked', jest.fn())).not.toThrow();
      expect(mockLog.warn).toHaveBeenCalledWith('cannot remove listener', expect.objectContaining({ channel: 'blocked' }));
    });
  });

  // --------------------------------------------------------------------------
  // off()
  // --------------------------------------------------------------------------
  describe('off()', () => {
    it('delegates to removeListener', () => {
      const bridge = makeBridge();
      const fn = jest.fn();
      bridge.on('test:receive', fn);

      const wrappedListener = mockIpc.on.mock.calls[0][1];
      bridge.off('test:receive', fn);

      expect(mockIpc.removeListener).toHaveBeenCalledWith('test:receive', wrappedListener);
    });
  });

  // --------------------------------------------------------------------------
  // removeAllListeners()
  // --------------------------------------------------------------------------
  describe('removeAllListeners()', () => {
    it('calls ipcRenderer.removeAllListeners on allowed channel', () => {
      const bridge = makeBridge();
      bridge.removeAllListeners('test:receive');
      expect(mockIpc.removeAllListeners).toHaveBeenCalledWith('test:receive');
    });

    it('warns and returns on disallowed channel without throwing', () => {
      const bridge = makeBridge();
      expect(() => bridge.removeAllListeners('blocked')).not.toThrow();
      expect(mockLog.warn).toHaveBeenCalledWith('cannot remove listeners', expect.objectContaining({ channel: 'blocked' }));
      expect(mockIpc.removeAllListeners).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // getMetadata()
  // --------------------------------------------------------------------------
  describe('getMetadata()', () => {
    it('returns correct metadata', () => {
      const bridge = makeBridge({ context: 'chatWindow' });
      const meta = bridge.getMetadata();
      expect(meta).toEqual({
        context: 'chatWindow',
        sendChannels: ['test:send'],
        receiveChannels: ['test:receive'],
        rateLimiterEnabled: true,
        sizeValidatorEnabled: true,
        payloadValidationEnabled: true,
      });
    });

    it('reflects disabled validators', () => {
      const bridge = makeBridge({
        enableRateLimiting: false,
        enableSizeValidation: false,
        enablePayloadValidation: false,
      });
      mockRateLimiter.enabled = false;
      mockSizeValidator.enabled = false;
      const meta = bridge.getMetadata();
      expect(meta.rateLimiterEnabled).toBe(false);
      expect(meta.sizeValidatorEnabled).toBe(false);
      expect(meta.payloadValidationEnabled).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // getStats()
  // --------------------------------------------------------------------------
  describe('getStats()', () => {
    it('returns combined stats from rateLimiter and sizeValidator', () => {
      mockRateLimiter.getStats.mockReturnValue({ totalCalls: 42, rateLimited: 3 });
      mockSizeValidator.getStats.mockReturnValue({ totalChecks: 42, violations: 1 });
      const bridge = makeBridge();
      const stats = bridge.getStats();
      expect(stats).toEqual({
        rateLimiter: { totalCalls: 42, rateLimited: 3 },
        sizeValidator: { totalChecks: 42, violations: 1 },
      });
    });
  });

  // --------------------------------------------------------------------------
  // Validation pipeline order
  // --------------------------------------------------------------------------
  describe('validation pipeline', () => {
    it('skips size validation when enableSizeValidation is false', () => {
      const bridge = makeBridge({ enableSizeValidation: false });
      bridge.send('test:send', { data: 'large' });
      expect(mockSizeValidator.validate).not.toHaveBeenCalled();
      expect(mockIpc.send).toHaveBeenCalled();
    });

    it('skips payload validation when enablePayloadValidation is false', () => {
      const bridge = makeBridge({ enablePayloadValidation: false });
      bridge.send('test:send', { data: 1 });
      expect(validatePayload).not.toHaveBeenCalled();
      expect(mockIpc.send).toHaveBeenCalled();
    });

    it('forces payload validation for open-external-url even when globally disabled', () => {
      canSend.mockImplementation((ch) => ch === 'open-external-url');
      const bridge = makeBridge({ enablePayloadValidation: false });
      const payload = 'https://example.com';
      bridge.send('open-external-url', payload);
      expect(validatePayload).toHaveBeenCalledWith('open-external-url', payload);
      expect(mockIpc.send).toHaveBeenCalledWith('open-external-url', payload);
    });

    it('fails closed for open-external-url when forced validation rejects payload', () => {
      canSend.mockImplementation((ch) => ch === 'open-external-url');
      validatePayload.mockReturnValue({ valid: false, error: 'Invalid external URL payload' });
      const bridge = makeBridge({ enablePayloadValidation: false });
      expect(() => bridge.send('open-external-url', 'javascript:alert(1)'))
        .toThrow(/Invalid external URL payload/);
      expect(mockIpc.send).not.toHaveBeenCalled();
    });

    it('enforces forced validation on invoke for open-external-url', async () => {
      canSend.mockImplementation((ch) => ch === 'open-external-url');
      const bridge = makeBridge({ enablePayloadValidation: false });
      const payload = 'https://example.com/docs';
      await bridge.invoke('open-external-url', payload);
      expect(validatePayload).toHaveBeenCalledWith('open-external-url', payload);
      expect(mockIpc.invoke).toHaveBeenCalledWith('open-external-url', payload);
    });

    it('checks canSend before rate limiter', () => {
      canSend.mockReturnValue(false);
      const bridge = makeBridge();
      try { bridge.send('blocked', {}); } catch (_) {}
      expect(mockRateLimiter.check).not.toHaveBeenCalled();
    });

    it('checks rate limiter before size validator', () => {
      mockRateLimiter.check.mockReturnValue(false);
      const bridge = makeBridge();
      try { bridge.send('test:send', {}); } catch (_) {}
      expect(mockSizeValidator.validate).not.toHaveBeenCalled();
    });

    it('checks size before payload validation', () => {
      mockSizeValidator.validate.mockReturnValue({ valid: false, error: 'too big' });
      const bridge = makeBridge();
      try { bridge.send('test:send', {}); } catch (_) {}
      expect(validatePayload).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Listener registry internal behavior (tested via bridge API)
  // --------------------------------------------------------------------------
  describe('listener registry (via bridge methods)', () => {
    it('recall cleans up channel map when last listener is removed', () => {
      const bridge = makeBridge();
      const fn = jest.fn();
      bridge.on('test:receive', fn);
      bridge.removeListener('test:receive', fn);

      // Second remove for the same function should fall back to original
      // (wrapped was already consumed by first recall)
      mockIpc.removeListener.mockClear();
      bridge.removeListener('test:receive', fn);
      expect(mockIpc.removeListener).toHaveBeenCalledWith('test:receive', fn);
    });

    it('multiple listeners on same channel each get their own wrapped version', () => {
      const bridge = makeBridge();
      const fn1 = jest.fn();
      const fn2 = jest.fn();
      bridge.on('test:receive', fn1);
      bridge.on('test:receive', fn2);

      const wrapped1 = mockIpc.on.mock.calls[0][1];
      const wrapped2 = mockIpc.on.mock.calls[1][1];
      expect(wrapped1).not.toBe(wrapped2);

      bridge.removeListener('test:receive', fn1);
      expect(mockIpc.removeListener).toHaveBeenCalledWith('test:receive', wrapped1);
    });

    it('recall returns undefined for unregistered listener when channel has other listeners', () => {
      const bridge = makeBridge();
      const fn1 = jest.fn();
      const fn2 = jest.fn();
      bridge.on('test:receive', fn1);

      // fn2 was never registered, but channel has a map (fn1 is there).
      // This exercises the `if (wrapped)` false branch in recall().
      bridge.removeListener('test:receive', fn2);
      expect(mockIpc.removeListener).toHaveBeenCalledWith('test:receive', fn2);
    });

    it('removeAllListeners drops the channel from the registry', () => {
      const bridge = makeBridge();
      const fn = jest.fn();
      bridge.on('test:receive', fn);
      bridge.removeAllListeners('test:receive');

      // After dropChannel, recall returns undefined -> falls back to original
      mockIpc.removeListener.mockClear();
      bridge.removeListener('test:receive', fn);
      expect(mockIpc.removeListener).toHaveBeenCalledWith('test:receive', fn);
    });
  });
});
