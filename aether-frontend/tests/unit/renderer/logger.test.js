'use strict';

// ---------------------------------------------------------------------------
// Mocks — only AetherBridge; we test the real logger
// ---------------------------------------------------------------------------

jest.mock('../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: jest.fn(),
}));

const { getAether } = require('../../../src/renderer/shared/bridge/AetherBridge');
const { createRendererLogger } = require('../../../src/renderer/shared/utils/logger');

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('createRendererLogger', () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn();
    getAether.mockReturnValue({ log: { send: mockSend } });

    // Suppress real console output during tests
    jest.spyOn(console, 'debug').mockImplementation(() => {});
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  // =========================================================================
  // factory
  // =========================================================================

  describe('factory', () => {
    it('returns object with all 5 log level methods', () => {
      const log = createRendererLogger('Test');
      expect(typeof log.trace).toBe('function');
      expect(typeof log.debug).toBe('function');
      expect(typeof log.info).toBe('function');
      expect(typeof log.warn).toBe('function');
      expect(typeof log.error).toBe('function');
    });

    it('returns object with child method', () => {
      const log = createRendererLogger('Test');
      expect(typeof log.child).toBe('function');
    });
  });

  // =========================================================================
  // level → console method mapping
  // =========================================================================

  describe('level → console mapping', () => {
    it('trace routes to console.debug', () => {
      const log = createRendererLogger('Comp');
      log.trace('t');
      expect(console.debug).toHaveBeenCalledWith('[Comp]', 't');
    });

    it('debug routes to console.debug', () => {
      const log = createRendererLogger('Comp');
      log.debug('d');
      expect(console.debug).toHaveBeenCalledWith('[Comp]', 'd');
    });

    it('info routes to console.info', () => {
      const log = createRendererLogger('Comp');
      log.info('i');
      expect(console.info).toHaveBeenCalledWith('[Comp]', 'i');
    });

    it('warn routes to console.warn', () => {
      const log = createRendererLogger('Comp');
      log.warn('w');
      expect(console.warn).toHaveBeenCalledWith('[Comp]', 'w');
    });

    it('error routes to console.error', () => {
      const log = createRendererLogger('Comp');
      log.error('e');
      expect(console.error).toHaveBeenCalledWith('[Comp]', 'e');
    });
  });

  // =========================================================================
  // emit — aether bridge payload
  // =========================================================================

  describe('emit — aether bridge', () => {
    it('sends structured payload to aether.log.send', () => {
      const log = createRendererLogger('Bridge');
      log.info('hello');
      const payload = JSON.parse(mockSend.mock.calls[0][0]);
      expect(payload).toEqual(
        expect.objectContaining({
          level: 'info',
          component: 'Bridge',
          context: {},
          message: 'hello',
          timestamp: expect.any(String),
        })
      );
    });

    it('payload timestamp is ISO 8601', () => {
      const log = createRendererLogger('Test');
      log.debug('ts');
      const payload = JSON.parse(mockSend.mock.calls[0][0]);
      expect(() => new Date(payload.timestamp).toISOString()).not.toThrow();
    });

    it('does not throw when getAether returns null', () => {
      getAether.mockReturnValue(null);
      const log = createRendererLogger('Test');
      expect(() => log.info('safe')).not.toThrow();
      expect(console.info).toHaveBeenCalledWith('[Test]', 'safe');
    });

    it('does not throw when aether.log is undefined', () => {
      getAether.mockReturnValue({});
      const log = createRendererLogger('Test');
      expect(() => log.info('safe')).not.toThrow();
    });

    it('does not throw when aether.log.send is missing', () => {
      getAether.mockReturnValue({ log: {} });
      const log = createRendererLogger('Test');
      expect(() => log.info('safe')).not.toThrow();
    });

    it('catches send error and logs console.warn', () => {
      const badSend = jest.fn(() => { throw new Error('IPC failure'); });
      getAether.mockReturnValue({ log: { send: badSend } });

      const log = createRendererLogger('Test');
      log.info('msg');

      expect(console.warn).toHaveBeenCalledWith(
        '[RendererLogger] Failed to send log payload to main process:',
        expect.any(Error)
      );
    });

    it('still calls console method after send failure', () => {
      getAether.mockReturnValue({
        log: { send: () => { throw new Error('broken'); } },
      });
      const log = createRendererLogger('Test');
      log.error('important');
      expect(console.error).toHaveBeenCalledWith('[Test]', 'important');
    });
  });

  // =========================================================================
  // serialize (verified through payload.message)
  // =========================================================================

  describe('serialize', () => {
    it('serializes Error using stack trace', () => {
      const log = createRendererLogger('Test');
      const err = new Error('boom');
      log.info(err);
      const msg = JSON.parse(mockSend.mock.calls[0][0]).message;
      expect(msg).toContain('Error: boom');
      expect(msg).toContain('logger.test.js'); // stack should reference this file
    });

    it('falls back to Error.message when stack is empty', () => {
      const log = createRendererLogger('Test');
      const err = new Error('no-stack');
      err.stack = '';
      log.info(err);
      expect(JSON.parse(mockSend.mock.calls[0][0]).message).toBe('no-stack');
    });

    it('serializes plain object as JSON', () => {
      const log = createRendererLogger('Test');
      log.info({ key: 'val', n: 1 });
      expect(JSON.parse(mockSend.mock.calls[0][0]).message).toBe('{"key":"val","n":1}');
    });

    it('serializes circular object as [unserializable]', () => {
      const log = createRendererLogger('Test');
      const circ = {};
      circ.self = circ;
      log.info(circ);
      expect(JSON.parse(mockSend.mock.calls[0][0]).message).toBe('[unserializable]');
    });

    it('serializes string primitive as-is', () => {
      const log = createRendererLogger('Test');
      log.info('hello');
      expect(JSON.parse(mockSend.mock.calls[0][0]).message).toBe('hello');
    });

    it('serializes number as String()', () => {
      const log = createRendererLogger('Test');
      log.info(42);
      expect(JSON.parse(mockSend.mock.calls[0][0]).message).toBe('42');
    });

    it('serializes boolean as String()', () => {
      const log = createRendererLogger('Test');
      log.info(true);
      expect(JSON.parse(mockSend.mock.calls[0][0]).message).toBe('true');
    });

    it('joins multiple args with space', () => {
      const log = createRendererLogger('Test');
      log.info('a', 'b', 'c');
      expect(JSON.parse(mockSend.mock.calls[0][0]).message).toBe('a b c');
    });

    it('serializes mixed args correctly', () => {
      const log = createRendererLogger('Test');
      log.info('prefix', { x: 1 }, 99);
      expect(JSON.parse(mockSend.mock.calls[0][0]).message).toBe('prefix {"x":1} 99');
    });
  });

  // =========================================================================
  // child
  // =========================================================================

  describe('child', () => {
    it('returns logger with merged context', () => {
      const log = createRendererLogger('Parent', { scope: 'top' });
      const child = log.child({ sub: 'detail' });
      child.info('from child');
      const payload = JSON.parse(mockSend.mock.calls[0][0]);
      expect(payload).toEqual(
        expect.objectContaining({
          component: 'Parent',
          context: { scope: 'top', sub: 'detail' },
        })
      );
    });

    it('child has all level methods and child method', () => {
      const child = createRendererLogger('Test').child({ x: 1 });
      expect(typeof child.trace).toBe('function');
      expect(typeof child.debug).toBe('function');
      expect(typeof child.info).toBe('function');
      expect(typeof child.warn).toBe('function');
      expect(typeof child.error).toBe('function');
      expect(typeof child.child).toBe('function');
    });

    it('child context does not mutate parent context', () => {
      const log = createRendererLogger('Test', { a: 1 });
      log.child({ b: 2 });
      log.info('parent');
      const payload = JSON.parse(mockSend.mock.calls[0][0]);
      expect(payload).toEqual(
        expect.objectContaining({ context: { a: 1 } })
      );
    });

    it('child override wins on key collision', () => {
      const log = createRendererLogger('Test', { mode: 'old' });
      const child = log.child({ mode: 'new' });
      child.info('override');
      const payload = JSON.parse(mockSend.mock.calls[0][0]);
      expect(payload).toEqual(
        expect.objectContaining({ context: { mode: 'new' } })
      );
    });

    it('chained children merge contexts cumulatively', () => {
      const root = createRendererLogger('Root', { a: 1 });
      const lvl1 = root.child({ b: 2 });
      const lvl2 = lvl1.child({ c: 3 });
      lvl2.info('deep');
      const payload = JSON.parse(mockSend.mock.calls[0][0]);
      expect(payload).toEqual(
        expect.objectContaining({ context: { a: 1, b: 2, c: 3 } })
      );
    });

    it('defaults extra context to empty object when omitted', () => {
      const log = createRendererLogger('Test', { base: true });
      const child = log.child();
      child.info('default');
      const payload = JSON.parse(mockSend.mock.calls[0][0]);
      expect(payload).toEqual(
        expect.objectContaining({ context: { base: true } })
      );
    });
  });

  // =========================================================================
  // baseContext default parameter
  // =========================================================================

  describe('baseContext default', () => {
    it('defaults baseContext to {} when not provided', () => {
      const log = createRendererLogger('Solo');
      log.info('no context');
      const payload = JSON.parse(mockSend.mock.calls[0][0]);
      expect(payload).toEqual(
        expect.objectContaining({ context: {} })
      );
    });
  });
});
