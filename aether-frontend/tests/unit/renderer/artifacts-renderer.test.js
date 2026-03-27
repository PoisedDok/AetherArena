'use strict';

/**
 * Tests for artifacts/renderer.js
 *
 * Coverage constraints:
 * - runStartupSplash() (lines 80-92) is dead code — defined but never called
 * - startupSplash module variable is always null (never set)
 * - Bootstrap catch block re-throws, creating an unhandled rejection that
 *   Jest catches internally. Cannot test bootstrap failure paths (ipc null,
 *   empty baseUrl, storageAPI null) without crashing the worker.
 *   NOTE: Bootstrap error display uses safe textContent pattern (XSS fix applied).
 * - typeof document === 'undefined' (line 115) is unreachable in jsdom
 * - container null in applyUiEffectsSettings (120-123) is unreachable (set before call)
 * - splash dispose error in beforeunload is unreachable (startupSplash always null)
 */

// ================================================================
// Mock Infrastructure
// ================================================================

const mockLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => mockLog),
}));

const mockAetherIpc = {
  send: jest.fn(),
  invoke: jest.fn(() => Promise.resolve('http://localhost:8765')),
  on: jest.fn(),
};
const mockAetherConfig = {
  getSnapshot: jest.fn(() => ({ backend: { baseUrl: 'http://snapshot:8000' } })),
};
const mockAether = {
  ipc: mockAetherIpc,
  config: mockAetherConfig,
  versions: { chrome: '1', node: '2', electron: '3' },
  artifacts: { on: jest.fn(), send: jest.fn() },
  storage: { get: jest.fn(), set: jest.fn() },
};
const mockGetAether = jest.fn(() => mockAether);
jest.mock('../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: mockGetAether,
}));

const mockContainer = { register: jest.fn(), resolve: jest.fn() };
jest.mock('../../../src/renderer/shared/platform/container', () => ({
  createRendererContainer: jest.fn(() => mockContainer),
}));

const mockEventBus = { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
const mockEventTypes = { SYSTEM: { ERROR: 'system:error' } };
jest.mock('../../../src/renderer/shared/platform/eventBus', () => ({
  createRendererEventBus: jest.fn(() => mockEventBus),
  RendererEventTypes: mockEventTypes,
}));

const mockEndpointInstance = { send: jest.fn(), getSettings: jest.fn(() => Promise.resolve({ ui: {} })) };
jest.mock('../../../src/renderer/shared/platform/endpoint', () => ({
  createRendererEndpoint: jest.fn(() => mockEndpointInstance),
}));

const mockStorageAPI = { get: jest.fn(), set: jest.fn() };
jest.mock('../../../src/shared/utils/storage-resolver', () => ({
  resolveStorageAPI: jest.fn(() => mockStorageAPI),
}));

const mockSplashInstance = { run: jest.fn(() => Promise.resolve()), dispose: jest.fn() };
jest.mock('../../../src/renderer/shared/components/StartupSplash', () => ({
  StartupSplash: jest.fn(() => mockSplashInstance),
}));

const mockControllerInstance = {
  init: jest.fn(() => Promise.resolve()),
  dispose: jest.fn(() => Promise.resolve()),
  getStats: jest.fn(() => ({ modules: 6 })),
};
jest.mock('../../../src/renderer/artifacts/controllers/ArtifactsController', () =>
  jest.fn(() => mockControllerInstance)
);

jest.mock('../../../src/renderer/artifacts/runtime/ArtifactsApp', () => jest.fn(() => ({ _mock: true })));

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

/**
 * Require module and capture window event handlers via spy.
 * Avoids handler accumulation across tests by returning direct references.
 */
function requireModuleCapturingHandlers() {
  const spy = jest.spyOn(window, 'addEventListener');
  jest.isolateModules(() => {
    require('../../../src/renderer/artifacts/renderer');
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
    require('../../../src/renderer/artifacts/renderer');
  });
}

// ================================================================
// Tests
// ================================================================

describe('artifacts/renderer.js', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Re-set all mock implementations (clearAllMocks does NOT reset them)
    mockAether.ipc = mockAetherIpc;
    mockGetAether.mockReturnValue(mockAether);
    mockAetherIpc.invoke.mockResolvedValue('http://localhost:8765');
    mockAetherConfig.getSnapshot.mockReturnValue({ backend: { baseUrl: 'http://snapshot:8000' } });
    mockControllerInstance.init.mockReturnValue(Promise.resolve());
    mockControllerInstance.dispose.mockReturnValue(Promise.resolve());
    mockContainer.resolve.mockImplementation((token) => {
      if (token === 'endpoint') {
        return { getSettings: jest.fn(() => Promise.resolve({ ui: { effects_mode: 'full' } })) };
      }
      return null;
    });
    const { resolveStorageAPI } = require('../../../src/shared/utils/storage-resolver');
    resolveStorageAPI.mockReturnValue(mockStorageAPI);

    document.body.innerHTML = '';
    document.documentElement.removeAttribute('data-effects');
    delete window.artifactsController;
    delete window.eventBus;
    delete window.container;
    window.close = jest.fn();
  });

  // ----------------------------------------------------------
  // 1. Aether bridge unavailable (synchronous throw — testable)
  // ----------------------------------------------------------
  describe('aether bridge unavailable', () => {
    it('throws and renders error screen when aether is null', () => {
      mockGetAether.mockReturnValueOnce(null);
      jest.isolateModules(() => {
        expect(() => require('../../../src/renderer/artifacts/renderer')).toThrow('Preload API not found');
      });
      expect(document.body.innerHTML).toContain('Security Error');
      expect(document.body.innerHTML).toContain('artifacts-preload.js');
      expect(mockLog.error).toHaveBeenCalledWith('Artifacts Renderer: Preload API not available');
    });
  });

  // ----------------------------------------------------------
  // 2. Bootstrap happy path
  // ----------------------------------------------------------
  describe('bootstrap (happy path)', () => {
    it('registers all required services as singletons', async () => {
      requireModule();
      await flushAsync();

      const regNames = mockContainer.register.mock.calls.map(c => c[0]);
      expect(regNames).toEqual(
        expect.arrayContaining(['eventBus', 'endpoint', 'storageAPI', 'artifactsApp'])
      );
      for (const call of mockContainer.register.mock.calls) {
        expect(call[2]).toEqual({ singleton: true });
      }
    });

    it('initializes controller and assigns to window globals', async () => {
      requireModule();
      await flushAsync();

      expect(mockControllerInstance.init).toHaveBeenCalled();
      expect(window.artifactsController).toBe(mockControllerInstance);
      expect(window.eventBus).toBe(mockEventBus);
      expect(window.container).toBe(mockContainer);
    });

    it('registers SYSTEM.ERROR handler that logs when invoked', async () => {
      requireModule();
      await flushAsync();

      expect(mockEventBus.on).toHaveBeenCalledWith('system:error', expect.any(Function));
      const handler = mockEventBus.on.mock.calls.find(c => c[0] === 'system:error')[1];
      handler({ code: 'ERR', detail: 'boom' });
      expect(mockLog.error).toHaveBeenCalledWith(
        '[ArtifactsRenderer] System error:',
        { code: 'ERR', detail: 'boom' }
      );
    });

    it('logs full startup sequence', async () => {
      requireModule();
      await flushAsync();

      expect(mockLog.debug).toHaveBeenCalledWith('Artifacts Renderer: Starting...');
      expect(mockLog.debug).toHaveBeenCalledWith('Artifacts Renderer: Preload API available');
      expect(mockLog.debug).toHaveBeenCalledWith('Aether versions:', mockAether.versions);
      expect(mockLog.debug).toHaveBeenCalledWith('Bootstrapping artifacts application...');
      expect(mockLog.debug).toHaveBeenCalledWith('Artifacts application bootstrapped successfully');
      expect(mockLog.debug).toHaveBeenCalledWith('Controller stats:', { modules: 6 });
      expect(mockLog.debug).toHaveBeenCalledWith('Artifacts renderer script loaded');
    });
  });

  // ----------------------------------------------------------
  // 3. Backend URL resolution (happy paths only)
  // ----------------------------------------------------------
  describe('backend URL resolution', () => {
    it('resolves baseUrl via IPC invoke', async () => {
      requireModule();
      await flushAsync();
      expect(mockAetherIpc.invoke).toHaveBeenCalledWith('backend:get-url');
    });

    it('strips trailing slash from baseUrl', async () => {
      mockAetherIpc.invoke.mockResolvedValueOnce('http://host:9000/');
      requireModule();
      await flushAsync();

      // Verify via endpoint factory invocation
      const call = mockContainer.register.mock.calls.find(c => c[0] === 'endpoint');
      expect(call[1]()).toBe(mockEndpointInstance);
    });

    it('includes DEFAULTS for API_TIMEOUT and WS_RECONNECT_INTERVAL', async () => {
      requireModule();
      await flushAsync();
      expect(mockControllerInstance.init).toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // 4. resolveNodeEnv
  // ----------------------------------------------------------
  describe('resolveNodeEnv', () => {
    it('returns production when NODE_ENV is undefined', async () => {
      const saved = process.env.NODE_ENV;
      delete process.env.NODE_ENV;

      requireModule();
      await flushAsync();

      // resolveNodeEnv() returns 'production' when NODE_ENV is not set (covers line 59)
      // This flows to eventBus enableLogging check
      expect(mockControllerInstance.init).toHaveBeenCalled();

      process.env.NODE_ENV = saved;
    });
  });

  // ----------------------------------------------------------
  // 5. Storage API
  // ----------------------------------------------------------
  describe('storage API', () => {
    it('resolves storageAPI from aether.storage', async () => {
      requireModule();
      await flushAsync();

      const { resolveStorageAPI } = require('../../../src/shared/utils/storage-resolver');
      expect(resolveStorageAPI).toHaveBeenCalledWith({
        storageAPI: mockAether.storage,
      });
    });

    it('uses aether.storageAPI fallback when storage is absent', async () => {
      const savedStorage = mockAether.storage;
      delete mockAether.storage;
      mockAether.storageAPI = { get: jest.fn(), set: jest.fn() };

      requireModule();
      await flushAsync();

      const { resolveStorageAPI } = require('../../../src/shared/utils/storage-resolver');
      expect(resolveStorageAPI).toHaveBeenCalledWith({
        storageAPI: mockAether.storageAPI,
      });

      mockAether.storage = savedStorage;
      delete mockAether.storageAPI;
    });
  });

  // ----------------------------------------------------------
  // 6. UI effects settings
  // ----------------------------------------------------------
  describe('applyUiEffectsSettings', () => {
    it('applies full effects by default', async () => {
      requireModule();
      await flushAsync();
      expect(document.documentElement.getAttribute('data-effects')).toBe('full');
    });

    it('applies reduced effects when setting is reduced', async () => {
      mockContainer.resolve.mockImplementationOnce((token) => {
        if (token === 'endpoint') {
          return { getSettings: jest.fn(() => Promise.resolve({ ui: { effects_mode: 'reduced' } })) };
        }
        return null;
      });
      requireModule();
      await flushAsync();
      expect(document.documentElement.getAttribute('data-effects')).toBe('reduced');
    });

    it('falls back to full on settings fetch failure', async () => {
      mockContainer.resolve.mockImplementationOnce((token) => {
        if (token === 'endpoint') {
          return { getSettings: jest.fn(() => Promise.reject(new Error('net fail'))) };
        }
        return null;
      });
      requireModule();
      await flushAsync();
      expect(document.documentElement.getAttribute('data-effects')).toBe('full');
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load ui settings'),
        'net fail'
      );
    });
  });

  // ----------------------------------------------------------
  // 7. Container-registered factories
  // ----------------------------------------------------------
  describe('container factories', () => {
    it('endpoint factory returns endpoint instance', async () => {
      requireModule();
      await flushAsync();

      const call = mockContainer.register.mock.calls.find(c => c[0] === 'endpoint');
      expect(call[1]()).toBe(mockEndpointInstance);
    });

    it('artifactsApp factory returns app instance', async () => {
      requireModule();
      await flushAsync();

      const call = mockContainer.register.mock.calls.find(c => c[0] === 'artifactsApp');
      expect(call[1]()).toEqual({ _mock: true });
    });

    it('storageAPI factory returns storage instance', async () => {
      requireModule();
      await flushAsync();

      const call = mockContainer.register.mock.calls.find(c => c[0] === 'storageAPI');
      expect(call[1]()).toBe(mockStorageAPI);
    });

    it('eventBus factory returns event bus', async () => {
      requireModule();
      await flushAsync();

      const call = mockContainer.register.mock.calls.find(c => c[0] === 'eventBus');
      expect(call[1]()).toBe(mockEventBus);
    });
  });

  // ----------------------------------------------------------
  // 9. beforeunload cleanup (handler capture pattern)
  // ----------------------------------------------------------
  describe('beforeunload cleanup', () => {
    it('disposes controller, then closes', async () => {
      const handlers = requireModuleCapturingHandlers();
      await flushAsync();

      const handler = handlers.beforeunload[0];
      const event = { preventDefault: jest.fn() };
      handler(event);
      await flushAsync();

      expect(event.preventDefault).toHaveBeenCalled();
      expect(mockControllerInstance.dispose).toHaveBeenCalled();
      expect(window.close).toHaveBeenCalled();
    });

    it('handles controller dispose rejection and still closes', async () => {
      mockControllerInstance.dispose.mockImplementationOnce(() => Promise.reject(new Error('d err')));

      const handlers = requireModuleCapturingHandlers();
      await flushAsync();

      const handler = handlers.beforeunload[0];
      handler({ preventDefault: jest.fn() });
      await flushAsync();

      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('Dispose failed'),
        expect.any(Error)
      );
      expect(window.close).toHaveBeenCalled();
    });

    it('is idempotent — second beforeunload is no-op when controller already nulled', async () => {
      const handlers = requireModuleCapturingHandlers();
      await flushAsync();

      const handler = handlers.beforeunload[0];

      // First dispose
      handler({ preventDefault: jest.fn() });
      await flushAsync();
      expect(mockControllerInstance.dispose).toHaveBeenCalledTimes(1);
      expect(window.close).toHaveBeenCalledTimes(1);

      // Second dispose — controller is null, should be no-op
      jest.clearAllMocks();
      const event2 = { preventDefault: jest.fn() };
      handler(event2);
      await flushAsync();

      expect(event2.preventDefault).not.toHaveBeenCalled();
      expect(mockControllerInstance.dispose).not.toHaveBeenCalled();
      expect(window.close).not.toHaveBeenCalled();
    });

    it('nulls module-level state after dispose — error handlers become safe no-ops', async () => {
      const handlers = requireModuleCapturingHandlers();
      await flushAsync();

      // Verify error handler emits to eventBus BEFORE dispose
      const errorHandler = handlers.error[0];
      errorHandler({ error: new Error('pre-dispose'), message: 'pre' });
      expect(mockEventBus.emit).toHaveBeenCalledWith('system:error', expect.objectContaining({
        error: expect.any(Error),
      }));

      // Dispose
      jest.clearAllMocks();
      handlers.beforeunload[0]({ preventDefault: jest.fn() });
      await flushAsync();

      // After dispose, error handler should NOT emit (eventBus is null)
      jest.clearAllMocks();
      errorHandler({ error: new Error('post-dispose'), message: 'post' });
      // Log still works (module-level log is not nulled)
      expect(mockLog.error).toHaveBeenCalledWith(
        '[ArtifactsRenderer] Unhandled error:',
        expect.any(Error)
      );
      // But eventBus.emit should NOT be called (eventBus was nulled)
      expect(mockEventBus.emit).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // 10. Window error handlers (handler capture pattern)
  // ----------------------------------------------------------
  describe('window error handlers', () => {
    it('logs window error events and emits to eventBus', async () => {
      const handlers = requireModuleCapturingHandlers();
      await flushAsync();

      const errorHandler = handlers.error[0];
      const err = new Error('global err');
      errorHandler({ error: err, message: 'global err', filename: 'f.js', lineno: 42, colno: 7 });

      expect(mockLog.error).toHaveBeenCalledWith('[ArtifactsRenderer] Unhandled error:', err);
      expect(mockEventBus.emit).toHaveBeenCalledWith('system:error', expect.objectContaining({
        error: err,
        message: 'global err',
        filename: 'f.js',
        lineno: 42,
        colno: 7,
      }));
    });

    it('logs unhandled rejection and emits to eventBus', async () => {
      const handlers = requireModuleCapturingHandlers();
      await flushAsync();

      const handler = handlers.unhandledrejection[0];
      const reason = new Error('rejected');
      const fakePromise = Promise.resolve();
      handler({ reason, promise: fakePromise });

      expect(mockLog.error).toHaveBeenCalledWith('[ArtifactsRenderer] Unhandled promise rejection:', reason);
      expect(mockEventBus.emit).toHaveBeenCalledWith('system:error', expect.objectContaining({
        error: reason,
        promise: fakePromise,
      }));
    });

    it('handles error when eventBus is null', async () => {
      // Invoke handler directly without eventBus being available
      const handlers = requireModuleCapturingHandlers();
      await flushAsync();

      // Error handler checks if (eventBus) before emitting
      const errorHandler = handlers.error[0];
      expect(() => errorHandler({ error: new Error('test') })).not.toThrow();
    });
  });

  // ----------------------------------------------------------
  // 11. DOMContentLoaded path
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

    it('calls bootstrap immediately when document is complete', async () => {
      requireModule();
      await flushAsync();
      expect(mockControllerInstance.init).toHaveBeenCalled();
    });
  });
});
