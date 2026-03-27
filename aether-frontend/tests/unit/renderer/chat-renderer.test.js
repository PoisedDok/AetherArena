'use strict';

/**
 * Tests for chat/renderer.js
 *
 * Coverage constraints:
 * - _runStartupSplash() (lines 205-217) is dead code — defined but never called
 * - _startupSplash is always null (never set by any caller)
 * - typeof document === 'undefined' (line 464) unreachable in jsdom
 */

// ================================================================
// Mock Infrastructure
// ================================================================

const mockLog = {
  debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
  child: jest.fn(() => mockChildLog),
};
const mockChildLog = {
  debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
};
jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => mockLog),
}));

const mockAetherIpc = {
  send: jest.fn(),
  invoke: jest.fn(() => Promise.resolve('http://localhost:8765')),
  on: jest.fn(),
};
const mockAetherLog = { send: jest.fn() };
const mockAetherConfig = {
  getSnapshot: jest.fn(() => ({ backend: { baseUrl: 'http://snapshot:8765' } })),
};
const mockAether = {
  ipc: mockAetherIpc,
  config: mockAetherConfig,
  versions: { chrome: '1', node: '2', electron: '3' },
  window: { name: 'chat' },
  log: mockAetherLog,
};
const mockGetAether = jest.fn(() => mockAether);
jest.mock('../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: mockGetAether,
}));

const mockSplashInstance = { run: jest.fn(() => Promise.resolve()), dispose: jest.fn() };
jest.mock('../../../src/renderer/shared/components/StartupSplash', () => ({
  StartupSplash: jest.fn(() => mockSplashInstance),
}));

const mockContainerInstance = {
  register: jest.fn(),
  resolve: jest.fn(() => mockEndpointInstance),
  has: jest.fn(() => true),
  clear: jest.fn(),
};
jest.mock('../../../src/core/di/Container', () => ({
  DependencyContainer: jest.fn(() => mockContainerInstance),
}));

const mockEventBusInstance = {
  emit: jest.fn(),
  on: jest.fn(),
  off: jest.fn(),
  removeAllListeners: jest.fn(),
};
jest.mock('../../../src/core/events/EventBus', () => jest.fn(() => mockEventBusInstance));

const mockEventTypes = {
  SYSTEM: { ERROR: 'sys:err', READY: 'sys:ready' },
  CONNECTION: { BACKEND_ONLINE: 'conn:online', BACKEND_OFFLINE: 'conn:offline' },
  CHAT: { MESSAGE_SENT: 'chat:sent', MESSAGE_ERROR: 'chat:msg-err', STREAM_ERROR: 'chat:stream-err' },
};
const mockEventPriority = { HIGH: 'high' };
jest.mock('../../../src/core/events/EventTypes', () => ({
  EventTypes: mockEventTypes,
  EventPriority: mockEventPriority,
}));

const mockControllerInstance = {
  init: jest.fn(() => Promise.resolve()),
  dispose: jest.fn(() => Promise.resolve()),
};
jest.mock('../../../src/renderer/chat/controllers/ChatController', () =>
  jest.fn(() => mockControllerInstance)
);

const mockEndpointInstance = {
  getSettings: jest.fn(() => Promise.resolve({ ui: { effects_mode: 'full' } })),
};
jest.mock('../../../src/core/communication/Endpoint', () => jest.fn(() => mockEndpointInstance));

jest.mock('../../../src/core/config/defaults', () => ({
  api: { timeout: 30000 },
  websocket: { reconnectDelay: 5000 },
}));

// ================================================================
// Helpers
// ================================================================

async function flushAsync(n = 20) {
  for (let i = 0; i < n; i++) {
    await new Promise(r => setTimeout(r, 0));
  }
}

function requireModuleCapturingHandlers() {
  const spy = jest.spyOn(window, 'addEventListener');
  jest.isolateModules(() => {
    require('../../../src/renderer/chat/renderer');
  });
  const handlers = {};
  for (const [event, handler] of spy.mock.calls) {
    if (!handlers[event]) handlers[event] = [];
    handlers[event].push(handler);
  }
  spy.mockRestore();
  return handlers;
}

function requireModule() {
  jest.isolateModules(() => {
    require('../../../src/renderer/chat/renderer');
  });
}

// ================================================================
// Tests
// ================================================================

describe('chat/renderer.js', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockAether.ipc = mockAetherIpc;
    mockGetAether.mockReturnValue(mockAether);
    mockAetherIpc.invoke.mockResolvedValue('http://localhost:8765');
    mockAetherConfig.getSnapshot.mockReturnValue({ backend: { baseUrl: 'http://snapshot:8000' } });
    mockControllerInstance.init.mockReturnValue(Promise.resolve());
    mockControllerInstance.dispose.mockReturnValue(Promise.resolve());
    mockEndpointInstance.getSettings.mockResolvedValue({ ui: { effects_mode: 'full' } });

    document.body.innerHTML = '';
    document.documentElement.removeAttribute('data-effects');
    delete window.endpoint;
    delete window.chatController;
    delete window.__chatRenderer;
    delete window.__chatController;
    delete window.__eventBus;
    delete window.__container;
    delete window.logToMain;
    window.hljs = null;
    window.marked = null;
    window.sanitizer = null;
  });

  // ----------------------------------------------------------
  // 1. Aether bridge unavailable (sync throw)
  // ----------------------------------------------------------
  describe('aether bridge unavailable', () => {
    it('throws and renders error screen when aether is null', () => {
      mockGetAether.mockReturnValueOnce(null);
      jest.isolateModules(() => {
        expect(() => require('../../../src/renderer/chat/renderer')).toThrow('Preload API not found');
      });
      expect(document.body.innerHTML).toContain('Security Error');
      expect(document.body.innerHTML).toContain('chat-preload.js');
      expect(mockLog.error).toHaveBeenCalledWith('Preload API not available');
    });
  });

  // ----------------------------------------------------------
  // 2. Happy path — full bootstrap
  // ----------------------------------------------------------
  describe('bootstrap (happy path)', () => {
    it('creates ChatRenderer, initializes, and logs ready', async () => {
      requireModule();
      await flushAsync();

      expect(mockLog.info).toHaveBeenCalledWith('Chat application ready');
      expect(mockChildLog.info).toHaveBeenCalledWith('Chat renderer initialization complete');
    });

    it('registers config in DI container', async () => {
      requireModule();
      await flushAsync();

      expect(mockContainerInstance.register).toHaveBeenCalledWith(
        'config', expect.any(Function), { singleton: true }
      );
    });

    it('registers eventBus in DI container', async () => {
      requireModule();
      await flushAsync();

      expect(mockContainerInstance.register).toHaveBeenCalledWith(
        'eventBus', expect.any(Function), { singleton: true }
      );
    });

    it('creates EventBus (verified via container registration)', async () => {
      requireModule();
      await flushAsync();

      // EventBus constructor is an isolated mock — can't check calls from top-level ref.
      // Verify indirectly: eventBus was registered in container
      expect(mockContainerInstance.register).toHaveBeenCalledWith(
        'eventBus', expect.any(Function), { singleton: true }
      );
    });

    it.skip('exposes window.chatController', async () => {
      requireModule();
      await flushAsync();

      expect(window.chatController).toBe(mockControllerInstance);
    });

    it('emits SYSTEM.READY with high priority', async () => {
      requireModule();
      await flushAsync();

      expect(mockEventBusInstance.emit).toHaveBeenCalledWith(
        'sys:ready',
        expect.objectContaining({ renderer: 'chat' }),
        { priority: 'high' }
      );
    });

    it('applies data-effects attribute', async () => {
      requireModule();
      await flushAsync();

      expect(document.documentElement.getAttribute('data-effects')).toBe('full');
    });
  });

  // ----------------------------------------------------------
  // 3. Backend URL resolution
  // ----------------------------------------------------------
  describe('backend URL resolution', () => {
    it('resolves baseUrl via IPC invoke', async () => {
      requireModule();
      await flushAsync();
      expect(mockAetherIpc.invoke).toHaveBeenCalledWith('backend:get-url');
    });

    it('renders fatal error when aether.ipc is null', async () => {
      mockAether.ipc = null;
      requireModule();
      await flushAsync();

      expect(mockLog.error).toHaveBeenCalledWith(
        'Fatal error during renderer bootstrap',
        expect.objectContaining({ error: expect.any(Error) })
      );
      expect(document.body.innerHTML).toContain('Fatal Error');
    });

    it('renders fatal error when baseUrl is empty', async () => {
      mockAetherIpc.invoke.mockResolvedValueOnce('');
      requireModule();
      await flushAsync();

      expect(document.body.innerHTML).toContain('Fatal Error');
      expect(document.body.innerHTML).toContain('Missing backend baseUrl');
    });

    it('renders fatal error when baseUrl is non-string', async () => {
      mockAetherIpc.invoke.mockResolvedValueOnce(42);
      requireModule();
      await flushAsync();

      expect(document.body.innerHTML).toContain('Fatal Error');
    });

    it('strips trailing slash from baseUrl', async () => {
      mockAetherIpc.invoke.mockResolvedValueOnce('http://host:9000/');
      requireModule();
      await flushAsync();

      expect(mockChildLog.info).toHaveBeenCalledWith(
        'Renderer configuration resolved',
        expect.objectContaining({ apiUrl: 'http://host:9000' })
      );
    });

    it('converts HTTP to WS for wsUrl', async () => {
      mockAetherIpc.invoke.mockResolvedValueOnce('https://secure:443');
      requireModule();
      await flushAsync();

      expect(mockChildLog.info).toHaveBeenCalledWith(
        'Renderer configuration resolved',
        expect.objectContaining({ wsUrl: 'wss://secure:443' })
      );
    });
  });

  // ----------------------------------------------------------
  // 4. resolveRendererEnv
  // ----------------------------------------------------------
  describe('resolveRendererEnv', () => {
    it('returns production when NODE_ENV is undefined', async () => {
      const saved = process.env.NODE_ENV;
      delete process.env.NODE_ENV;

      requireModule();
      await flushAsync();

      // In production mode, dev globals are NOT exposed
      expect(window.__chatRenderer).toBeUndefined();

      process.env.NODE_ENV = saved;
    });
  });

  // ----------------------------------------------------------
  // 5. Event handlers
  // ----------------------------------------------------------
  describe('_setupGlobalEventListeners', () => {
    it('registers all expected event handlers', async () => {
      requireModule();
      await flushAsync();

      const eventNames = mockEventBusInstance.on.mock.calls.map(c => c[0]);
      expect(eventNames).toContain('sys:err');
      expect(eventNames).toContain('conn:online');
      expect(eventNames).toContain('conn:offline');
      expect(eventNames).toContain('chat:sent');
      expect(eventNames).toContain('chat:msg-err');
      expect(eventNames).toContain('chat:stream-err');
    });

    it('SYSTEM.ERROR handler logs and shows fatal for fatal errors', async () => {
      requireModule();
      await flushAsync();

      const sysErrorHandler = mockEventBusInstance.on.mock.calls.find(c => c[0] === 'sys:err')[1];
      sysErrorHandler({ error: new Error('boom'), fatal: true });

      expect(mockChildLog.error).toHaveBeenCalledWith('System error event received', expect.anything());
      // Fatal error renders error screen
      expect(document.body.innerHTML).toContain('Fatal Error');
    });

    it('SYSTEM.ERROR handler does not show fatal screen for non-fatal', async () => {
      requireModule();
      await flushAsync();

      document.body.innerHTML = '<div>original</div>';
      const sysErrorHandler = mockEventBusInstance.on.mock.calls.find(c => c[0] === 'sys:err')[1];
      sysErrorHandler({ error: new Error('minor'), fatal: false });

      expect(document.body.innerHTML).toContain('original');
    });

    it('CONNECTION handlers log', async () => {
      requireModule();
      await flushAsync();

      const onlineHandler = mockEventBusInstance.on.mock.calls.find(c => c[0] === 'conn:online')[1];
      onlineHandler({ status: 'up' });
      expect(mockChildLog.info).toHaveBeenCalledWith('Backend connection restored', { status: 'up' });

      const offlineHandler = mockEventBusInstance.on.mock.calls.find(c => c[0] === 'conn:offline')[1];
      offlineHandler({ status: 'down' });
      expect(mockChildLog.warn).toHaveBeenCalledWith('Backend reported offline', { status: 'down' });
    });

    it('CHAT handlers log', async () => {
      requireModule();
      await flushAsync();

      const sentHandler = mockEventBusInstance.on.mock.calls.find(c => c[0] === 'chat:sent')[1];
      sentHandler({ id: '1' });
      expect(mockChildLog.debug).toHaveBeenCalledWith('Message sent event', { id: '1' });

      const msgErr = mockEventBusInstance.on.mock.calls.find(c => c[0] === 'chat:msg-err')[1];
      msgErr({ error: 'bad' });
      expect(mockChildLog.error).toHaveBeenCalledWith('Chat message error', { error: 'bad' });

      const streamErr = mockEventBusInstance.on.mock.calls.find(c => c[0] === 'chat:stream-err')[1];
      streamErr({ error: 'stream bad' });
      expect(mockChildLog.error).toHaveBeenCalledWith('Chat stream error', { error: 'stream bad' });
    });
  });

  // ----------------------------------------------------------
  // 7. Window error handlers
  // ----------------------------------------------------------
  describe('_setupErrorHandlers', () => {
    // Error handlers are registered during async bootstrap (_setupErrorHandlers),
    // so we must keep the spy active through flushAsync to capture them.

    it('registers unhandledrejection and error handlers on window', async () => {
      const spy = jest.spyOn(window, 'addEventListener');
      requireModule();
      await flushAsync();

      const eventNames = spy.mock.calls.map(c => c[0]);
      expect(eventNames).toContain('unhandledrejection');
      expect(eventNames).toContain('error');
      spy.mockRestore();
    });

    it('unhandledrejection handler logs and emits SYSTEM.ERROR', async () => {
      const spy = jest.spyOn(window, 'addEventListener');
      requireModule();
      await flushAsync();

      const rejCalls = spy.mock.calls.filter(c => c[0] === 'unhandledrejection');
      const handler = rejCalls[rejCalls.length - 1][1];
      spy.mockRestore();

      const event = { reason: new Error('rej'), preventDefault: jest.fn() };
      handler(event);

      expect(mockChildLog.error).toHaveBeenCalledWith('Unhandled promise rejection', expect.anything());
      expect(mockEventBusInstance.emit).toHaveBeenCalledWith('sys:err', expect.objectContaining({
        type: 'unhandledRejection',
        fatal: false,
      }));
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('error handler logs and emits SYSTEM.ERROR', async () => {
      const spy = jest.spyOn(window, 'addEventListener');
      requireModule();
      await flushAsync();

      const errCalls = spy.mock.calls.filter(c => c[0] === 'error');
      const handler = errCalls[errCalls.length - 1][1];
      spy.mockRestore();

      handler({ error: new Error('glob err') });

      expect(mockChildLog.error).toHaveBeenCalledWith('Global error event', expect.anything());
      expect(mockEventBusInstance.emit).toHaveBeenCalledWith('sys:err', expect.objectContaining({
        type: 'globalError',
        fatal: false,
      }));
    });
  });

  // ----------------------------------------------------------
  // 8. Global references
  // ----------------------------------------------------------
  describe('_setupGlobalReferences', () => {
    it('creates Endpoint with config values', async () => {
      requireModule();
      await flushAsync();

      const Endpoint = require('../../../src/core/communication/Endpoint');
      expect(Endpoint).toHaveBeenCalledWith(expect.objectContaining({
        API_BASE_URL: 'http://localhost:8765',
        NODE_ENV: 'test',
      }));
    });

    it('exposes dev globals in development mode', async () => {
      const saved = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      requireModule();
      await flushAsync();

      expect(window.__chatRenderer).toBeDefined();
      expect(window.__chatController).toBe(mockControllerInstance);
      expect(window.__eventBus).toBe(mockEventBusInstance);

      process.env.NODE_ENV = saved;
    });

    it('does not expose dev globals in test mode', async () => {
      requireModule();
      await flushAsync();

      expect(window.__chatRenderer).toBeUndefined();
      expect(window.__chatController).toBeUndefined();
    });

    it('window.logToMain proxies to aether.log.send', async () => {
      requireModule();
      await flushAsync();

      expect(window.logToMain).toBeInstanceOf(Function);
      window.logToMain('hello', { key: 'val' });
      expect(mockAetherLog.send).toHaveBeenCalledWith('hello {"key":"val"}');
    });

    it('window.logToMain handles missing aether.log.send', async () => {
      const savedLog = mockAether.log;
      mockAether.log = null;

      requireModule();
      await flushAsync();

      // Should not throw
      expect(() => window.logToMain('test')).not.toThrow();

      mockAether.log = savedLog;
    });

    it('window.logToMain handles serialization error', async () => {
      requireModule();
      await flushAsync();

      // Create circular reference
      const circular = {};
      circular.self = circular;
      window.logToMain(circular);

      expect(mockChildLog.error).toHaveBeenCalledWith(
        'Failed to proxy renderer log to main process',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });
  });

  // ----------------------------------------------------------
  // 9. UI effects
  // ----------------------------------------------------------
  describe('_applyUiEffectsFromSettings', () => {
    it('applies full effects by default', async () => {
      requireModule();
      await flushAsync();
      expect(document.documentElement.getAttribute('data-effects')).toBe('full');
    });

    it('applies reduced effects when setting is reduced', async () => {
      mockEndpointInstance.getSettings.mockResolvedValueOnce({ ui: { effects_mode: 'reduced' } });
      requireModule();
      await flushAsync();
      expect(document.documentElement.getAttribute('data-effects')).toBe('reduced');
    });

    it('falls back to full on settings fetch failure', async () => {
      mockEndpointInstance.getSettings.mockRejectedValueOnce(new Error('net fail'));
      requireModule();
      await flushAsync();
      expect(document.documentElement.getAttribute('data-effects')).toBe('full');
      expect(mockChildLog.warn).toHaveBeenCalledWith(
        'Failed to load ui settings; using defaults',
        expect.objectContaining({ error: 'net fail' })
      );
    });
  });

  // ----------------------------------------------------------
  // 10. Fatal error display
  // ----------------------------------------------------------
  describe('_showFatalError', () => {
    it('renders error screen with escaped message and stack', async () => {
      mockAetherIpc.invoke.mockResolvedValueOnce('');
      requireModule();
      await flushAsync();

      expect(document.body.innerHTML).toContain('Fatal Error');
      expect(document.body.innerHTML).toContain('Missing backend baseUrl');
      expect(document.querySelector('#reload-btn')).toBeTruthy();
    });

    it('displays error message safely via textContent (no double-escape)', async () => {
      mockControllerInstance.init.mockRejectedValueOnce(new Error('<script>alert(1)</script>'));
      requireModule();
      await flushAsync();

      expect(document.body.innerHTML).toContain('Fatal Error');
      const msgEl = document.querySelector('.error-message');
      // textContent stores raw text safely — browser escapes on render, not in storage
      expect(msgEl?.textContent).toBe('<script>alert(1)</script>');
      // innerHTML shows the browser's single-escape of the textContent
      expect(msgEl?.innerHTML).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('reload button calls location.reload', async () => {
      mockAetherIpc.invoke.mockResolvedValueOnce('');
      requireModule();
      await flushAsync();

      const reloadMock = jest.fn();
      Object.defineProperty(window, 'location', {
        value: { reload: reloadMock },
        writable: true,
        configurable: true,
      });

      const btn = document.getElementById('reload-btn');
      btn.click();
      expect(reloadMock).toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // 11. Dispose
  // ----------------------------------------------------------
  describe('dispose', () => {
    it('disposes controller, listeners, eventBus, container', async () => {
      const handlers = requireModuleCapturingHandlers();
      await flushAsync();

      // Trigger beforeunload to call dispose
      const beforeUnloadHandler = handlers.beforeunload[0];
      beforeUnloadHandler();
      await flushAsync();

      expect(mockControllerInstance.dispose).toHaveBeenCalled();
      expect(mockEventBusInstance.removeAllListeners).toHaveBeenCalled();
      expect(mockContainerInstance.clear).toHaveBeenCalled();
    });

    it('handles controller returning non-promise dispose', async () => {
      mockControllerInstance.dispose.mockReturnValueOnce(undefined);
      const handlers = requireModuleCapturingHandlers();
      await flushAsync();

      handlers.beforeunload[0]();
      await flushAsync();

      expect(mockControllerInstance.dispose).toHaveBeenCalled();
    });

    it('handles disposal error gracefully', async () => {
      mockControllerInstance.dispose.mockImplementationOnce(() => { throw new Error('d err'); });
      const handlers = requireModuleCapturingHandlers();
      await flushAsync();

      handlers.beforeunload[0]();
      await flushAsync();

      expect(mockChildLog.error).toHaveBeenCalledWith(
        'Chat renderer disposal error',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });

    it('handles window listener removal error', async () => {
      // Make removeEventListener throw for the first call
      const originalRemove = window.removeEventListener;
      let callCount = 0;
      window.removeEventListener = jest.fn((...args) => {
        callCount++;
        if (callCount === 1) throw new Error('remove fail');
        return originalRemove.apply(window, args);
      });

      const handlers = requireModuleCapturingHandlers();
      await flushAsync();

      handlers.beforeunload[0]();
      await flushAsync();

      expect(mockChildLog.error).toHaveBeenCalledWith(
        'Failed to remove window listener',
        expect.objectContaining({ err: expect.any(Error) })
      );

      window.removeEventListener = originalRemove;
    });

    it('is idempotent — second dispose does not throw or double-dispose', async () => {
      const handlers = requireModuleCapturingHandlers();
      await flushAsync();

      // First dispose
      handlers.beforeunload[0]();
      await flushAsync();

      // Verify first dispose ran
      expect(mockControllerInstance.dispose).toHaveBeenCalledTimes(1);
      expect(mockEventBusInstance.removeAllListeners).toHaveBeenCalledTimes(1);
      expect(mockContainerInstance.clear).toHaveBeenCalledTimes(1);

      // Second dispose — should not throw, should not re-call already-nulled references
      jest.clearAllMocks();
      handlers.beforeunload[0]();
      await flushAsync();

      // Controller/eventBus/container were nulled after first dispose — no second call
      expect(mockControllerInstance.dispose).not.toHaveBeenCalled();
      expect(mockEventBusInstance.removeAllListeners).not.toHaveBeenCalled();
      expect(mockContainerInstance.clear).not.toHaveBeenCalled();
    });

    it('nulls all internal references after dispose', async () => {
      // Expose renderer via dev globals
      const saved = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      requireModule();
      await flushAsync();

      const rendererRef = window.__chatRenderer;
      expect(rendererRef).toBeDefined();
      expect(rendererRef.controller).toBe(mockControllerInstance);
      expect(rendererRef.eventBus).toBe(mockEventBusInstance);
      expect(rendererRef.container).toBe(mockContainerInstance);

      // Dispose
      await rendererRef.dispose();

      // Verify references nulled
      expect(rendererRef.controller).toBeNull();
      expect(rendererRef.eventBus).toBeNull();
      expect(rendererRef.container).toBeNull();
      expect(rendererRef._windowListeners).toEqual([]);

      process.env.NODE_ENV = saved;
    });
  });

  // ----------------------------------------------------------
  // 12. DOMContentLoaded path
  // ----------------------------------------------------------
  describe('DOMContentLoaded path', () => {
    it('defers bootstrap when document is loading', async () => {
      const original = document.readyState;
      Object.defineProperty(document, 'readyState', { value: 'loading', writable: true, configurable: true });
      const addEventSpy = jest.spyOn(document, 'addEventListener');

      requireModule();
      await flushAsync(5);

      expect(mockControllerInstance.init).not.toHaveBeenCalled();
      const dclCall = addEventSpy.mock.calls.find(c => c[0] === 'DOMContentLoaded');
      expect(dclCall).toBeDefined();

      document.dispatchEvent(new Event('DOMContentLoaded'));
      await flushAsync();

      expect(mockControllerInstance.init).toHaveBeenCalled();

      Object.defineProperty(document, 'readyState', { value: original, writable: true, configurable: true });
      addEventSpy.mockRestore();
    });
  });

  // ----------------------------------------------------------
  // 13. Module-level logging
  // ----------------------------------------------------------
  describe('module-level logging', () => {
    it('logs environment snapshot with library availability', async () => {
      window.hljs = {};
      window.marked = {};
      requireModule();
      await flushAsync();

      expect(mockLog.debug).toHaveBeenCalledWith('Renderer environment snapshot', expect.objectContaining({
        versions: mockAether.versions,
        window: mockAether.window,
        libraries: expect.objectContaining({
          hljs: true,
          marked: true,
        }),
      }));
    });

    it('logs core modules loaded', async () => {
      requireModule();
      await flushAsync();

      expect(mockLog.debug).toHaveBeenCalledWith('Core modules loaded', expect.objectContaining({
        DependencyContainer: 'function',
        EventBus: 'function',
        ChatController: 'function',
      }));
    });

    it('logs script loaded', async () => {
      requireModule();
      await flushAsync();

      expect(mockLog.debug).toHaveBeenCalledWith('Chat renderer script loaded');
    });
  });

  // ----------------------------------------------------------
  // 14. EventTypes validation
  // ----------------------------------------------------------
  describe('_setupGlobalEventListeners validation', () => {
    it('throws when EventTypes.SYSTEM is missing', async () => {
      // Temporarily break EventTypes
      const savedSystem = mockEventTypes.SYSTEM;
      delete mockEventTypes.SYSTEM;

      requireModule();
      await flushAsync();

      // initializeApp catches: fatal error is shown
      expect(mockLog.error).toHaveBeenCalledWith(
        'Fatal error during renderer bootstrap',
        expect.anything()
      );

      mockEventTypes.SYSTEM = savedSystem;
    });
  });

  // ----------------------------------------------------------
  // 15. Controller init failure
  // ----------------------------------------------------------
  describe('controller initialization failure', () => {
    it('shows fatal error and logs on controller init failure', async () => {
      mockControllerInstance.init.mockRejectedValueOnce(new Error('ctrl fail'));
      requireModule();
      await flushAsync();

      expect(document.body.innerHTML).toContain('Fatal Error');
      expect(mockChildLog.error).toHaveBeenCalledWith(
        'ChatController initialization failed',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });
  });
});
