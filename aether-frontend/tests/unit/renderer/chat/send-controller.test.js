'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    debug: jest.fn(), trace: jest.fn(),
    child: jest.fn(function () { return this; }),
  })),
}));

const mockValidateString = jest.fn();

jest.mock('../../../../src/renderer/shared/security/inputValidator', () => ({
  InputValidator: jest.fn().mockImplementation(() => ({
    validateString: mockValidateString,
  })),
}));

jest.mock('../../../../src/renderer/shared/adapters/session', () => ({}));

const { createRendererLogger } = require('../../../../src/renderer/shared/utils/logger');
const { EventTypes } = require('../../../../src/core/events/EventTypes');
const SendController = require('../../../../src/renderer/chat/modules/messaging/SendController');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLogger() {
  return {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    debug: jest.fn(), trace: jest.fn(),
    child: jest.fn(function () { return this; }),
  };
}

function createIpc() {
  return { send: jest.fn() };
}

function createEventBus() {
  return { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
}

function createController(overrides = {}) {
  const mockLog = createLogger();
  createRendererLogger.mockReturnValue(mockLog);

  const opts = {
    ipc: createIpc(),
    eventBus: createEventBus(),
    ...overrides,
  };

  const ctrl = new SendController(opts);
  ctrl.log = mockLog;
  return ctrl;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SendController', () => {
  let ctrl;

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: validation passes
    mockValidateString.mockImplementation(() => {});
    ctrl = createController();
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('initializes with null pendingRequestId', () => {
      expect(ctrl.pendingRequestId).toBeNull();
    });

    it('initializes with isSending false', () => {
      expect(ctrl.isSending).toBe(false);
    });

    it('stores ipc', () => {
      expect(ctrl.ipc).toBeDefined();
      expect(typeof ctrl.ipc.send).toBe('function');
    });

    it('stores eventBus', () => {
      expect(ctrl.eventBus).toBeDefined();
    });

    it('initializes metrics', () => {
      expect(ctrl.metrics).toEqual({ total: 0, failures: 0 });
    });

    it('creates InputValidator', () => {
      expect(ctrl.validator).toBeDefined();
    });
  });

  // =========================================================================
  // init
  // =========================================================================

  describe('init', () => {
    it('initializes without error', () => {
      expect(() => ctrl.init()).not.toThrow();
    });
  });

  // =========================================================================
  // send - happy path
  // =========================================================================

  describe('send - happy path', () => {
    it('sends message via IPC and returns requestId', async () => {
      const requestId = await ctrl.send('Hello world');

      expect(requestId).toBeDefined();
      expect(typeof requestId).toBe('string');
      expect(ctrl.ipc.send).toHaveBeenCalledWith('chat:send', expect.objectContaining({
        message: 'Hello world',
      }));
    });

    it('sets pendingRequestId after successful send', async () => {
      const requestId = await ctrl.send('test');

      expect(ctrl.pendingRequestId).toBe(requestId);
    });

    it('increments total metric', async () => {
      await ctrl.send('msg');

      expect(ctrl.metrics.total).toBe(1);
    });

    it('resets isSending after send completes', async () => {
      await ctrl.send('msg');

      expect(ctrl.isSending).toBe(false);
    });

    it('uses provided correlationId', async () => {
      const requestId = await ctrl.send('msg', { correlationId: 'corr-123' });

      expect(requestId).toBe('corr-123');
      expect(ctrl.ipc.send).toHaveBeenCalledWith('chat:send', expect.objectContaining({
        correlationId: 'corr-123',
      }));
    });

    it('passes chatId to IPC payload', async () => {
      await ctrl.send('msg', { chatId: 'chat-abc' });

      expect(ctrl.ipc.send).toHaveBeenCalledWith('chat:send', expect.objectContaining({
        chatId: 'chat-abc',
      }));
    });
  });

  // =========================================================================
  // send - events
  // =========================================================================

  describe('send - events', () => {
    it('emits MESSAGE_SENDING before IPC call', async () => {
      await ctrl.send('Hello');

      expect(ctrl.eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CHAT.MESSAGE_SENDING,
        expect.objectContaining({
          channel: 'ipc',
          content: 'Hello',
          contentLength: 5,
        })
      );
    });

    it('emits MESSAGE_SENT after successful IPC call', async () => {
      await ctrl.send('Hello');

      expect(ctrl.eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CHAT.MESSAGE_SENT,
        expect.objectContaining({
          channel: 'ipc',
        })
      );
    });

    it('does not throw when eventBus is null', async () => {
      const c = createController({ eventBus: null });

      const requestId = await c.send('test');

      expect(requestId).toBeDefined();
    });
  });

  // =========================================================================
  // send - validation
  // =========================================================================

  describe('send - validation', () => {
    it('trims whitespace from content', async () => {
      await ctrl.send('  Hello  ');

      expect(ctrl.ipc.send).toHaveBeenCalledWith('chat:send', expect.objectContaining({
        message: 'Hello',
      }));
    });

    it('throws validation error for empty content', async () => {
      mockValidateString.mockImplementation(() => {
        const e = new Error('Content too short');
        e.isValidationError = true;
        throw e;
      });

      await expect(ctrl.send('')).rejects.toThrow('Content too short');
      expect(ctrl.metrics.failures).toBe(1);
    });

    it('emits MESSAGE_ERROR on validation failure', async () => {
      mockValidateString.mockImplementation(() => {
        throw new Error('Invalid');
      });

      await expect(ctrl.send('bad')).rejects.toThrow('Invalid');

      expect(ctrl.eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CHAT.MESSAGE_ERROR,
        expect.objectContaining({
          error: 'Invalid',
        })
      );
    });

    it('normalizes non-string content to empty string', () => {
      const result = ctrl._normalizeContent(123);
      expect(result).toBe('');
    });

    it('normalizes null content to empty string', () => {
      const result = ctrl._normalizeContent(null);
      expect(result).toBe('');
    });
  });

  // =========================================================================
  // send - guards
  // =========================================================================

  describe('send - guards', () => {
    it('returns null when already sending', async () => {
      ctrl.isSending = true;

      const result = await ctrl.send('msg');

      expect(result).toBeNull();
      expect(ctrl.ipc.send).not.toHaveBeenCalled();
    });

    it('throws when no IPC available', async () => {
      const c = createController({ ipc: null });

      await expect(c.send('msg')).rejects.toThrow('No IPC communication channel');
      expect(c.metrics.failures).toBe(1);
    });

    it('throws when IPC has no send function', async () => {
      const c = createController({ ipc: {} });

      await expect(c.send('msg')).rejects.toThrow('No IPC communication channel');
    });
  });

  // =========================================================================
  // send - IPC failure
  // =========================================================================

  describe('send - IPC failure', () => {
    it('throws on IPC send failure', async () => {
      ctrl.ipc.send = jest.fn(() => { throw new Error('IPC broken'); });

      await expect(ctrl.send('msg')).rejects.toThrow('IPC broken');
      expect(ctrl.metrics.failures).toBe(1);
    });

    it('resets isSending on IPC failure', async () => {
      ctrl.ipc.send = jest.fn(() => { throw new Error('fail'); });

      try {
        await ctrl.send('msg');
      } catch (_) {}

      expect(ctrl.isSending).toBe(false);
    });

    it('emits MESSAGE_ERROR on IPC failure', async () => {
      ctrl.ipc.send = jest.fn(() => { throw new Error('IPC error'); });

      try {
        await ctrl.send('msg');
      } catch (_) {}

      expect(ctrl.eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CHAT.MESSAGE_ERROR,
        expect.objectContaining({
          error: 'IPC error',
        })
      );
    });
  });

  // =========================================================================
  // _sendViaIPC
  // =========================================================================

  describe('_sendViaIPC', () => {
    it('sends payload via ipc.send', async () => {
      await ctrl._sendViaIPC('content', 'corr-1', 'chat-1', 'req-1');

      expect(ctrl.ipc.send).toHaveBeenCalledWith('chat:send', {
        message: 'content',
        requestId: 'req-1',
        correlationId: 'corr-1',
        chatId: 'chat-1',
      });
    });

    it('throws CONTRACT VIOLATION when requestId is missing', async () => {
      await expect(ctrl._sendViaIPC('content', 'corr', 'chat', null))
        .rejects.toThrow('CONTRACT VIOLATION: requestId is required');
    });

    it('throws CONTRACT VIOLATION when requestId is empty string', async () => {
      await expect(ctrl._sendViaIPC('content', 'corr', 'chat', ''))
        .rejects.toThrow('CONTRACT VIOLATION');
    });

    it('throws CONTRACT VIOLATION when requestId is whitespace', async () => {
      await expect(ctrl._sendViaIPC('content', 'corr', 'chat', '   '))
        .rejects.toThrow('CONTRACT VIOLATION');
    });

    it('throws when ipc bridge is not available', async () => {
      ctrl.ipc = null;
      await expect(ctrl._sendViaIPC('content', 'corr', 'chat', 'req-1'))
        .rejects.toThrow('IPC bridge is REQUIRED');
    });
  });

  // =========================================================================
  // _canUseIPC
  // =========================================================================

  describe('_canUseIPC', () => {
    it('returns true when ipc has send function', () => {
      expect(ctrl._canUseIPC()).toBe(true);
    });

    it('returns false when ipc is null', () => {
      ctrl.ipc = null;
      expect(ctrl._canUseIPC()).toBe(false);
    });

    it('returns false when ipc has no send function', () => {
      ctrl.ipc = {};
      expect(ctrl._canUseIPC()).toBe(false);
    });
  });

  // =========================================================================
  // _resolveCorrelationId
  // =========================================================================

  describe('_resolveCorrelationId', () => {
    it('returns provided string correlationId', async () => {
      const id = await ctrl._resolveCorrelationId('my-corr-id');
      expect(id).toBe('my-corr-id');
    });

    it('generates UUID when no correlationId provided', async () => {
      const id = await ctrl._resolveCorrelationId(null);
      expect(typeof id).toBe('string');
      // UUID v4 format check
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('generates UUID for non-string input', async () => {
      const id = await ctrl._resolveCorrelationId(123);
      expect(typeof id).toBe('string');
    });
  });

  // =========================================================================
  // _generateUUID
  // =========================================================================

  describe('_generateUUID', () => {
    it('generates valid UUID v4 format', () => {
      const uuid = ctrl._generateUUID();
      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('generates unique UUIDs', () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) {
        ids.add(ctrl._generateUUID());
      }
      expect(ids.size).toBe(100);
    });
  });

  // =========================================================================
  // _generateRequestId
  // =========================================================================

  describe('_generateRequestId', () => {
    it('generates request ID with req_ prefix', () => {
      const id = ctrl._generateRequestId();
      expect(id).toMatch(/^req_\d+_[a-z0-9]+$/);
    });
  });

  // =========================================================================
  // _buildEventPayload
  // =========================================================================

  describe('_buildEventPayload', () => {
    it('builds payload with all fields', () => {
      const payload = ctrl._buildEventPayload({
        correlationId: 'corr',
        requestId: 'req',
        channel: 'ipc',
        content: 'Hello world',
      });

      expect(payload.correlationId).toBe('corr');
      expect(payload.requestId).toBe('req');
      expect(payload.channel).toBe('ipc');
      expect(payload.content).toBe('Hello world');
      expect(payload.contentLength).toBe(11);
      expect(typeof payload.timestamp).toBe('number');
    });

    it('truncates long content to preview length (160 chars)', () => {
      const longContent = 'A'.repeat(200);
      const payload = ctrl._buildEventPayload({
        correlationId: 'c',
        requestId: 'r',
        channel: 'ipc',
        content: longContent,
      });

      expect(payload.content).toBe('A'.repeat(160) + '...');
      expect(payload.contentLength).toBe(200);
    });

    it('does not truncate content at or below preview length', () => {
      const exactContent = 'A'.repeat(160);
      const payload = ctrl._buildEventPayload({
        correlationId: 'c',
        requestId: 'r',
        channel: 'ipc',
        content: exactContent,
      });

      expect(payload.content).toBe(exactContent);
    });
  });

  // =========================================================================
  // preflightValidate
  // =========================================================================

  describe('preflightValidate', () => {
    it('returns normalized content', () => {
      const result = ctrl.preflightValidate('  test  ');
      expect(result).toBe('test');
    });

    it('calls validator.validateString', () => {
      ctrl.preflightValidate('test');
      expect(mockValidateString).toHaveBeenCalledWith('test', expect.any(Object));
    });

    it('throws when validation fails', () => {
      mockValidateString.mockImplementation(() => {
        throw new Error('too long');
      });

      expect(() => ctrl.preflightValidate('x')).toThrow('too long');
    });
  });

  // =========================================================================
  // getters / setters
  // =========================================================================

  describe('getters', () => {
    it('getPendingRequestId returns current value', () => {
      ctrl.pendingRequestId = 'req-abc';
      expect(ctrl.getPendingRequestId()).toBe('req-abc');
    });

    it('clearPendingRequestId sets to null', () => {
      ctrl.pendingRequestId = 'req-abc';
      ctrl.clearPendingRequestId();
      expect(ctrl.pendingRequestId).toBeNull();
    });

    it('isSendingMessage returns isSending state', () => {
      expect(ctrl.isSendingMessage()).toBe(false);
      ctrl.isSending = true;
      expect(ctrl.isSendingMessage()).toBe(true);
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    it('nulls pendingRequestId', () => {
      ctrl.pendingRequestId = 'req';
      ctrl.dispose();
      expect(ctrl.pendingRequestId).toBeNull();
    });

    it('resets isSending', () => {
      ctrl.isSending = true;
      ctrl.dispose();
      expect(ctrl.isSending).toBe(false);
    });

    it('nulls ipc', () => {
      ctrl.dispose();
      expect(ctrl.ipc).toBeNull();
    });

    it('nulls eventBus', () => {
      ctrl.dispose();
      expect(ctrl.eventBus).toBeNull();
    });

    it('is idempotent', () => {
      ctrl.dispose();
      expect(() => ctrl.dispose()).not.toThrow();
    });
  });

  // =========================================================================
  // Lifecycle
  // =========================================================================

  describe('lifecycle', () => {
    it('full create-init-send-dispose cycle', async () => {
      const c = createController();
      c.init();

      const reqId = await c.send('Hello world');
      expect(reqId).toBeDefined();
      expect(c.pendingRequestId).toBe(reqId);
      expect(c.metrics.total).toBe(1);

      c.dispose();
      expect(c.pendingRequestId).toBeNull();
      expect(c.ipc).toBeNull();
    });
  });

  // =========================================================================
  // BUG REGRESSIONS (SC-1, SC-4)
  // =========================================================================

  describe('bug regressions', () => {
    // --- SC-1: _isDisposed flag + guards ---
    it('[SC-1] constructor initializes _isDisposed to false', () => {
      expect(ctrl._isDisposed).toBe(false);
    });

    it('[SC-1] send throws after dispose', async () => {
      ctrl.dispose();
      await expect(ctrl.send('Hello')).rejects.toThrow('Cannot send after dispose');
    });

    it('[SC-1] init is no-op after dispose', () => {
      ctrl.dispose();
      expect(() => ctrl.init()).not.toThrow();
    });

    it('[SC-1] dispose is idempotent (double-dispose safe)', () => {
      ctrl.dispose();
      expect(() => ctrl.dispose()).not.toThrow();
      expect(ctrl._isDisposed).toBe(true);
    });

    it('[SC-1] dispose nulls validator', () => {
      expect(ctrl.validator).not.toBeNull();
      ctrl.dispose();
      expect(ctrl.validator).toBeNull();
    });

    // --- SC-4: Dead code removal (duplicate isSending check) ---
    it('[SC-4] single isSending guard blocks concurrent sends', async () => {
      // Simulate slow send
      ctrl.ipc.send = jest.fn(() => {
        return new Promise(r => setTimeout(r, 50));
      });
      const p1 = ctrl.send('first');
      // isSending is now true after validation passes
      const p2 = ctrl.send('second');
      expect(await p2).toBeNull(); // Blocked by single guard
      await p1;
    });
  });
});
