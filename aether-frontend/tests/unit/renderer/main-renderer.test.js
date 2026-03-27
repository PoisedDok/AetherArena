'use strict';

// ================================================================
// Mock Infrastructure
// ================================================================

const mockLog = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => mockLog),
}));

const mockAetherIpc = { send: jest.fn(), invoke: jest.fn(), on: jest.fn() };
const mockAetherConfig = {
  getSnapshot: jest.fn(() => ({ backend: { baseUrl: 'http://snapshot:8765' } })),
};
const mockAether = { ipc: mockAetherIpc, config: mockAetherConfig };
const mockGetAether = jest.fn(() => mockAether);
jest.mock('../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: mockGetAether,
}));

const mockContainer = {
  register: jest.fn(),
  resolve: jest.fn((token) => {
    if (token === 'endpoint') return { send: jest.fn() };
    return null;
  }),
};
jest.mock('../../../src/renderer/shared/platform/container', () => ({
  createRendererContainer: jest.fn(() => mockContainer),
}));

const mockEventBus = { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
jest.mock('../../../src/renderer/shared/platform/eventBus', () => ({
  createRendererEventBus: jest.fn(() => mockEventBus),
}));

const mockEndpoint = { send: jest.fn() };
jest.mock('../../../src/renderer/shared/platform/endpoint', () => ({
  createRendererEndpoint: jest.fn(() => mockEndpoint),
}));

const mockSplashInstance = { run: jest.fn(() => Promise.resolve()), dispose: jest.fn() };
const MockStartupSplash = jest.fn(() => mockSplashInstance);
jest.mock('../../../src/renderer/shared/components/StartupSplash', () => ({
  StartupSplash: MockStartupSplash,
}));

const mockControllerInstance = {
  init: jest.fn(() => Promise.resolve()),
  dispose: jest.fn(() => Promise.resolve()),
};
const MockMainController = jest.fn(() => mockControllerInstance);
jest.mock('../../../src/renderer/main/controllers/MainController', () => MockMainController);

const mockMainAppInstance = {};
jest.mock('../../../src/renderer/main/runtime/MainApp', () => jest.fn(() => mockMainAppInstance));

const MockSettingsManager = jest.fn();
jest.mock('../../../src/application/main/modules/settings/SettingsManager', () => MockSettingsManager);

jest.mock('../../../src/core/config/defaults', () => ({
  backend: { baseUrl: 'http://default-backend:8765' },
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

function requireModule() {
  jest.isolateModules(() => {
    require('../../../src/renderer/main/main-renderer');
  });
}

// ================================================================
// Tests
// ================================================================

describe('main-renderer.js', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAether.mockReturnValue(mockAether);
    mockAetherConfig.getSnapshot.mockReturnValue({ backend: { baseUrl: 'http://snapshot:8000' } });
    mockSplashInstance.run.mockReturnValue(Promise.resolve());
    mockControllerInstance.init.mockReturnValue(Promise.resolve());
    mockControllerInstance.dispose.mockReturnValue(Promise.resolve());
    document.body.innerHTML = '';
    delete window.AETHER_CONFIG;
    delete window.__AETHER_CONFIG_READY__;
    delete window.__mainController;
    window.close = jest.fn();
  });

  // ----------------------------------------------------------
  // 1. Aether bridge unavailable
  // ----------------------------------------------------------
  describe('aether bridge unavailable', () => {
    it('throws and renders error screen when aether is null', () => {
      mockGetAether.mockReturnValueOnce(null);
      jest.isolateModules(() => {
        expect(() => {
          require('../../../src/renderer/main/main-renderer');
        }).toThrow('Preload API not found');
      });
      expect(document.body.innerHTML).toContain('Security Error');
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('Preload API not available')
      );
    });
  });

  // ----------------------------------------------------------
  // 2. Bootstrap happy path
  // ----------------------------------------------------------
  describe('bootstrap (happy path)', () => {
    it('registers config, eventBus, endpoint, mainApp in container', async () => {
      window.AETHER_CONFIG = { backend: { baseUrl: 'http://win-cfg:9000' } };
      requireModule();
      await flushAsync();

      expect(mockContainer.register).toHaveBeenCalledWith('config', expect.any(Function), { singleton: true });
      expect(mockContainer.register).toHaveBeenCalledWith('eventBus', expect.any(Function), { singleton: true });
      expect(mockContainer.register).toHaveBeenCalledWith('endpoint', expect.any(Function), { singleton: true });
      expect(mockContainer.register).toHaveBeenCalledWith('mainApp', expect.any(Function), { singleton: true });
    });

    it('creates MainController with correct dependencies', async () => {
      requireModule();
      await flushAsync();

      expect(MockMainController).toHaveBeenCalledWith(
        expect.objectContaining({
          container: mockContainer,
          eventBus: mockEventBus,
          ipc: mockAetherIpc,
        })
      );
    });

    it('runs startup splash and initializes controller', async () => {
      requireModule();
      await flushAsync();

      expect(MockStartupSplash).toHaveBeenCalled();
      expect(mockSplashInstance.run).toHaveBeenCalled();
      expect(mockControllerInstance.init).toHaveBeenCalled();
    });

    it('assigns controller to window.__mainController', async () => {
      requireModule();
      await flushAsync();

      expect(window.__mainController).toBe(mockControllerInstance);
    });

    it('logs script loaded at module level', async () => {
      requireModule();
      await flushAsync();

      expect(mockLog.debug).toHaveBeenCalledWith('Main renderer script loaded');
    });
  });

  // ----------------------------------------------------------
  // 3. Config resolution
  // ----------------------------------------------------------
  describe('config resolution', () => {
    it('uses window.AETHER_CONFIG baseUrl when available', async () => {
      window.AETHER_CONFIG = { backend: { baseUrl: 'http://custom:5000' } };
      requireModule();
      await flushAsync();

      // Verify config was registered — resolve the factory to check
      const configFactory = mockContainer.register.mock.calls.find(c => c[0] === 'config')[1];
      const config = configFactory();
      expect(config.API_BASE_URL).toBe('http://custom:5000');
      expect(config.WS_URL).toBe('ws://custom:5000');
    });

    it('falls back to DEFAULTS baseUrl when window config absent', async () => {
      // No window.AETHER_CONFIG set
      requireModule();
      await flushAsync();

      const configFactory = mockContainer.register.mock.calls.find(c => c[0] === 'config')[1];
      const config = configFactory();
      expect(config.API_BASE_URL).toBe('http://default-backend:8765');
    });

    it('awaits __AETHER_CONFIG_READY__ when present', async () => {
      let resolveReady;
      window.__AETHER_CONFIG_READY__ = new Promise(r => { resolveReady = r; });
      window.AETHER_CONFIG = { backend: { baseUrl: 'http://ready:7000' } };

      requireModule();
      // bootstrap is waiting for __AETHER_CONFIG_READY__
      await flushAsync(5);

      // Controller should NOT be init yet (blocked on ready gate)
      expect(mockControllerInstance.init).not.toHaveBeenCalled();

      // Resolve the ready gate
      resolveReady();
      await flushAsync();

      expect(mockControllerInstance.init).toHaveBeenCalled();
    });

    it('config is frozen', async () => {
      window.AETHER_CONFIG = { backend: { baseUrl: 'http://frozen:8000' } };
      requireModule();
      await flushAsync();

      const configFactory = mockContainer.register.mock.calls.find(c => c[0] === 'config')[1];
      const config = configFactory();
      expect(Object.isFrozen(config)).toBe(true);
    });

    it('includes deferConnect=true in config', async () => {
      requireModule();
      await flushAsync();

      const configFactory = mockContainer.register.mock.calls.find(c => c[0] === 'config')[1];
      const config = configFactory();
      expect(config.deferConnect).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // 4. Error handling
  // ----------------------------------------------------------
  describe('error handling', () => {
    it('handles config snapshot read failure gracefully', async () => {
      mockAetherConfig.getSnapshot.mockImplementation(() => {
        throw new Error('snapshot error');
      });
      requireModule();
      await flushAsync();

      // Should still bootstrap (snapshot failure is non-fatal)
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to read preload config snapshot'),
        expect.anything()
      );
      expect(mockControllerInstance.init).toHaveBeenCalled();
    });

    it('handles startup splash failure gracefully', async () => {
      mockSplashInstance.run.mockRejectedValueOnce(new Error('splash error'));
      requireModule();
      await flushAsync();

      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('Startup splash failed'),
        expect.anything()
      );
      // Controller should still init despite splash failure
      expect(mockControllerInstance.init).toHaveBeenCalled();
    });

    // Note: bootstrap().catch() re-throws errors, causing unhandled rejections
    // that crash the Jest worker. The error screen rendering (lines 200-204)
    // is not testable without modifying the source. Coverage impact: ~2 lines.
  });

  // ----------------------------------------------------------
  // 5. beforeunload cleanup
  // ----------------------------------------------------------
  describe('beforeunload cleanup', () => {
    it('disposes splash and controller on beforeunload', async () => {
      requireModule();
      await flushAsync();

      // Dispatch beforeunload
      const event = new Event('beforeunload', { cancelable: true });
      event.preventDefault = jest.fn();
      window.dispatchEvent(event);

      // Flush for controller.dispose().then(...)
      await flushAsync();

      expect(event.preventDefault).toHaveBeenCalled();
      expect(mockSplashInstance.dispose).toHaveBeenCalled();
      expect(mockControllerInstance.dispose).toHaveBeenCalled();
      expect(window.close).toHaveBeenCalled();
    });

    it('handles splash dispose error gracefully', async () => {
      mockSplashInstance.dispose.mockImplementationOnce(() => {
        throw new Error('splash dispose error');
      });
      requireModule();
      await flushAsync();

      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      await flushAsync();

      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to dispose StartupSplash'),
        expect.anything()
      );
      // Controller dispose should still be called
      expect(mockControllerInstance.dispose).toHaveBeenCalled();
    });

    it('handles controller dispose rejection', async () => {
      mockControllerInstance.dispose.mockImplementationOnce(
        () => Promise.reject(new Error('dispose failed'))
      );
      requireModule();
      await flushAsync();

      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      await flushAsync();

      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('Dispose failed'),
        expect.any(Error)
      );
      expect(window.close).toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // 6. DOMContentLoaded path
  // ----------------------------------------------------------
  describe('DOMContentLoaded path', () => {
    it('defers initialization when document is loading', async () => {
      // Override readyState to 'loading'
      const original = document.readyState;
      Object.defineProperty(document, 'readyState', {
        value: 'loading',
        writable: true,
        configurable: true,
      });

      const addEventSpy = jest.spyOn(document, 'addEventListener');

      requireModule();
      await flushAsync(5);

      // initialize() should NOT have been called yet
      expect(mockControllerInstance.init).not.toHaveBeenCalled();

      // DOMContentLoaded listener should be registered
      const dclCall = addEventSpy.mock.calls.find(c => c[0] === 'DOMContentLoaded');
      expect(dclCall).toBeDefined();

      // Trigger DOMContentLoaded
      document.dispatchEvent(new Event('DOMContentLoaded'));
      await flushAsync();

      expect(mockControllerInstance.init).toHaveBeenCalled();

      // Restore
      Object.defineProperty(document, 'readyState', {
        value: original,
        writable: true,
        configurable: true,
      });
      addEventSpy.mockRestore();
    });
  });

});
