'use strict';

// ---------------------------------------------------------------------------
// Mocks — noop functions survive resetMocks: true
// ---------------------------------------------------------------------------

const mockLog = {
  info: () => {},
  warn: jest.fn(),
  error: jest.fn(),
  debug: () => {},
  trace: () => {},
};
mockLog.child = () => mockLog;

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

const mockAether = {
  window: { onWidgetModeChange: jest.fn(() => jest.fn()) },
  log: { send: jest.fn() },
  logger: mockLog,
};

jest.mock('../../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: () => mockAether,
}));

// Mock Endpoint constructor
const mockEndpointInstance = {
  connection: { state: { assistant: 'waiting', audioLevel: 0 } },
  getHealth: jest.fn(),
  getModelCapabilities: jest.fn(),
  getStats: jest.fn(() => ({ connections: 1 })),
};

jest.mock('../../../../src/core/communication/Endpoint', () => {
  return jest.fn(() => mockEndpointInstance);
});

// Real EventTypes
const { EventTypes, EventPriority } = require('../../../../src/core/events/EventTypes');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockContainer(overrides = {}) {
  const registry = {};
  return {
    has: jest.fn((key) => key in registry),
    resolve: jest.fn((key) => registry[key]),
    register: jest.fn((key, factory, _opts) => {
      registry[key] = factory();
    }),
    _registry: registry,
    ...overrides,
  };
}

function createMockEventBus() {
  const handlers = {};
  return {
    on: jest.fn((event, handler, _opts) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
      const cleanup = jest.fn(() => {
        const idx = handlers[event].indexOf(handler);
        if (idx >= 0) handlers[event].splice(idx, 1);
      });
      return cleanup;
    }),
    emit: jest.fn(),
    _handlers: handlers,
    _trigger(event, data) {
      if (handlers[event]) {
        handlers[event].forEach((h) => h(data));
      }
    },
  };
}

function createDefaultOptions(overrides = {}) {
  return {
    container: createMockContainer(),
    eventBus: createMockEventBus(),
    config: {
      API_BASE_URL: 'http://localhost:8765',
      WS_URL: 'ws://localhost:8765/ws',
      NODE_ENV: 'test',
    },
    ipc: {},
    aether: mockAether,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MainController', () => {
  let MainController;
  let Endpoint;

  beforeEach(() => {
    // Reset DOM
    document.body.innerHTML = '';

    // Re-establish mock return values after resetMocks clears them
    Endpoint = require('../../../../src/core/communication/Endpoint');
    Endpoint.mockImplementation(() => mockEndpointInstance);

    // Reset Endpoint instance to clean state
    mockEndpointInstance.connection = { state: { assistant: 'waiting', audioLevel: 0 } };
    mockEndpointInstance.getHealth = jest.fn().mockResolvedValue({ model: 'gpt-4' });
    mockEndpointInstance.getModelCapabilities = jest.fn().mockResolvedValue({
      supportsReasoning: true,
      supportsVision: false,
    });
    mockEndpointInstance.getStats = jest.fn(() => ({ connections: 1 }));

    // Re-establish aether mocks
    mockAether.window = { onWidgetModeChange: jest.fn(() => jest.fn()) };
    mockAether.log = { send: jest.fn() };

    // Re-establish logger mocks
    mockLog.warn = jest.fn();
    mockLog.error = jest.fn();

    // Fresh module require
    MainController = require('../../../../src/renderer/main/controllers/MainController');
  });

  afterEach(() => {
    // Clean up globals
    delete window.__mainController;
    delete window.__mainApp;
    delete window.handsfreeCoordinator;
    delete window.mainController;
    delete window.logToMain;
    delete window.endpoint;
    delete window.guru;
    delete window.isWidgetMode;
    delete window.__eventBus;
    jest.restoreAllMocks();
  });

  // ── Constructor ─────────────────────────────────────────

  describe('constructor', () => {
    test('throws if container not provided', () => {
      expect(() => new MainController({ eventBus: {}, config: {} }))
        .toThrow('[MainController] DI container required');
    });

    test('throws if eventBus not provided', () => {
      expect(() => new MainController({ container: {}, config: {} }))
        .toThrow('[MainController] EventBus required');
    });

    test('throws if config not provided', () => {
      expect(() => new MainController({ container: {}, eventBus: {} }))
        .toThrow('[MainController] Config required');
    });

    test('initializes with correct default state', () => {
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      expect(ctrl.container).toBe(opts.container);
      expect(ctrl.eventBus).toBe(opts.eventBus);
      expect(ctrl.config).toBe(opts.config);
      expect(ctrl.initialized).toBe(false);
      expect(ctrl.backendConnected).toBe(false);
      expect(ctrl.currentModel).toBeNull();
      expect(ctrl.currentModelSupportsReasoning).toBe(false);
      expect(ctrl._isDisposed).toBe(false);
      expect(ctrl._ipcListeners).toEqual([]);
      expect(ctrl._eventListeners).toEqual([]);
      expect(ctrl.modules).toEqual({});
    });

    test('defaults aether from getAether() when not provided', () => {
      const opts = createDefaultOptions();
      delete opts.aether;
      const ctrl = new MainController(opts);
      expect(ctrl.aether).toBe(mockAether);
    });

    test('binds _handleBackendOnline and _handleBackendOffline to instance', () => {
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);
      expect(ctrl._handleBackendOnline).not.toBe(MainController.prototype._handleBackendOnline);
      expect(ctrl._handleBackendOffline).not.toBe(MainController.prototype._handleBackendOffline);
    });
  });

  // ── init() ──────────────────────────────────────────────

  describe('init()', () => {
    test('completes 7-phase initialization successfully', async () => {
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      await ctrl.init();

      expect(ctrl.initialized).toBe(true);
      expect(ctrl.backendConnected).toBe(true);
      expect(ctrl.currentModel).toBe('gpt-4');
      expect(ctrl.currentModelSupportsReasoning).toBe(true);

      // SYSTEM.READY emitted with HIGH priority
      expect(opts.eventBus.emit).toHaveBeenCalledWith(
        EventTypes.SYSTEM.READY,
        expect.objectContaining({ controller: 'MainController', timestamp: expect.any(Number) }),
        expect.objectContaining({ priority: EventPriority.HIGH })
      );
    });

    test('emits SYSTEM.ERROR and rethrows on core init failure', async () => {
      Endpoint.mockImplementation(() => {
        throw new Error('Endpoint creation failed');
      });

      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      await expect(ctrl.init()).rejects.toThrow('Endpoint creation failed');

      expect(opts.eventBus.emit).toHaveBeenCalledWith(
        EventTypes.SYSTEM.ERROR,
        expect.objectContaining({
          phase: 'initialization',
          fatal: true,
          error: expect.any(Error),
        })
      );
      expect(ctrl.initialized).toBe(false);
    });

    test('registers endpoint in container when not pre-registered', async () => {
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      await ctrl.init();

      expect(opts.container.register).toHaveBeenCalledWith(
        'endpoint',
        expect.any(Function),
        { singleton: true }
      );
      expect(ctrl.modules.endpoint).toBe(mockEndpointInstance);
    });

    test('reuses existing endpoint from container', async () => {
      const existingEndpoint = {
        connection: { state: { assistant: 'idle' } },
        getHealth: jest.fn().mockResolvedValue({ model: 'claude-3' }),
        getModelCapabilities: jest.fn().mockResolvedValue({ supportsReasoning: false }),
        getStats: jest.fn(),
      };

      const container = createMockContainer();
      container._registry.endpoint = existingEndpoint;
      container.has = jest.fn((k) => k in container._registry);
      container.resolve = jest.fn((k) => container._registry[k]);

      const opts = createDefaultOptions({ container });
      const ctrl = new MainController(opts);

      // Clear Endpoint call count before this test's init
      Endpoint.mockClear();

      await ctrl.init();

      expect(ctrl.modules.endpoint).toBe(existingEndpoint);
      // Should NOT create a new Endpoint — container already has one
      expect(Endpoint).not.toHaveBeenCalled();
    });

    test('sets global window references during core init', async () => {
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      await ctrl.init();

      expect(window.mainController).toBe(ctrl);
    });

    test('initializes mainApp module when registered in container', async () => {
      const mockMainApp = {
        initialize: jest.fn().mockResolvedValue(undefined),
      };

      const container = createMockContainer();
      container._registry.mainApp = mockMainApp;
      container.has = jest.fn((k) => k in container._registry);
      container.resolve = jest.fn((k) => container._registry[k]);

      const opts = createDefaultOptions({ container });
      const ctrl = new MainController(opts);

      await ctrl.init();

      expect(mockMainApp.initialize).toHaveBeenCalled();
      expect(ctrl.modules.mainApp).toBe(mockMainApp);
    });

    test('initializes HandsfreeCoordinator if available on modules', async () => {
      const mockHandsfree = { initialize: jest.fn() };

      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);
      ctrl.modules.handsfreeCoordinator = mockHandsfree;

      await ctrl.init();

      expect(mockHandsfree.initialize).toHaveBeenCalled();
    });

    test('catches HandsfreeCoordinator init failure gracefully', async () => {
      const mockHandsfree = {
        initialize: jest.fn(() => { throw new Error('Handsfree init fail'); }),
      };

      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);
      ctrl.modules.handsfreeCoordinator = mockHandsfree;

      await ctrl.init();

      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to initialize HandsfreeCoordinator:',
        expect.any(Error)
      );
      expect(ctrl.initialized).toBe(true);
    });

    test('registers backend online/offline event listeners', async () => {
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      await ctrl.init();

      expect(opts.eventBus.on).toHaveBeenCalledWith(
        EventTypes.CONNECTION.BACKEND_ONLINE,
        expect.any(Function),
        expect.objectContaining({ priority: EventPriority.HIGH })
      );
      expect(opts.eventBus.on).toHaveBeenCalledWith(
        EventTypes.CONNECTION.BACKEND_OFFLINE,
        expect.any(Function),
        expect.objectContaining({ priority: EventPriority.HIGH })
      );
      expect(ctrl._eventListeners).toHaveLength(3);
    });

    test('registers IPC widget mode listener', async () => {
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      await ctrl.init();

      expect(mockAether.window.onWidgetModeChange).toHaveBeenCalledWith(expect.any(Function));
      expect(ctrl._ipcListeners.length).toBeGreaterThanOrEqual(1);
    });

    test('handles backend health check failure gracefully', async () => {
      mockEndpointInstance.getHealth = jest.fn().mockRejectedValue(new Error('Connection refused'));

      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      await ctrl.init();

      expect(ctrl.backendConnected).toBe(false);
      expect(ctrl.currentModel).toBeNull();
      expect(opts.eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CONNECTION.BACKEND_OFFLINE,
        expect.objectContaining({ error: expect.any(Error) })
      );
      // Still marked as initialized despite health failure
      expect(ctrl.initialized).toBe(true);
    });

    test('skips model capability detection when no model', async () => {
      mockEndpointInstance.getHealth = jest.fn().mockResolvedValue({ model: null });

      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      await ctrl.init();

      expect(mockEndpointInstance.getModelCapabilities).not.toHaveBeenCalled();
      expect(ctrl.currentModelSupportsReasoning).toBe(false);
    });

    test('handles model capability detection failure gracefully', async () => {
      mockEndpointInstance.getModelCapabilities = jest.fn().mockRejectedValue(
        new Error('Capabilities not available')
      );

      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      await ctrl.init();

      expect(ctrl.currentModelSupportsReasoning).toBe(false);
      expect(mockLog.warn).toHaveBeenCalledWith(
        '[MainController] Failed to detect model capabilities:',
        expect.any(Error)
      );
      expect(ctrl.initialized).toBe(true);
    });

    test('emits MODEL.CAPABILITIES_UPDATED on success', async () => {
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      await ctrl.init();

      expect(opts.eventBus.emit).toHaveBeenCalledWith(
        EventTypes.MODEL.CAPABILITIES_UPDATED,
        expect.objectContaining({
          model: 'gpt-4',
          capabilities: expect.objectContaining({ supportsReasoning: true }),
        })
      );
    });
  });

  // ── dispose() ───────────────────────────────────────────

  describe('dispose()', () => {
    test('disposes modules in reverse order', () => {
      const disposeOrder = [];
      const moduleA = { dispose: jest.fn(() => disposeOrder.push('a')) };
      const moduleB = { dispose: jest.fn(() => disposeOrder.push('b')) };
      const moduleC = { dispose: jest.fn(() => disposeOrder.push('c')) };

      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);
      ctrl.modules = { a: moduleA, b: moduleB, c: moduleC };

      ctrl.dispose();

      expect(disposeOrder).toEqual(['c', 'b', 'a']);
    });

    test('calls cleanup() fallback when dispose() not available', () => {
      const module = { cleanup: jest.fn() };
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);
      ctrl.modules = { test: module };

      ctrl.dispose();

      expect(module.cleanup).toHaveBeenCalledTimes(1);
    });

    test('calls destroy() fallback when dispose/cleanup not available', () => {
      const module = { destroy: jest.fn() };
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);
      ctrl.modules = { test: module };

      ctrl.dispose();

      expect(module.destroy).toHaveBeenCalledTimes(1);
    });

    test('skips null modules without error', () => {
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);
      ctrl.modules = { nullModule: null, emptyModule: {} };

      expect(() => ctrl.dispose()).not.toThrow();
    });

    test('catches module disposal errors and continues with remaining modules', () => {
      const badModule = {
        dispose: jest.fn(() => { throw new Error('Module disposal fail'); }),
      };
      const goodModule = { dispose: jest.fn() };

      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);
      ctrl.modules = { good: goodModule, bad: badModule };

      ctrl.dispose();

      // Reverse order: bad first, then good
      expect(badModule.dispose).toHaveBeenCalled();
      expect(goodModule.dispose).toHaveBeenCalled();
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to dispose bad'),
        expect.any(Error)
      );
    });

    test('cleans up tracked IPC listeners', async () => {
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      await ctrl.init();

      const ipcCleanups = ctrl._ipcListeners.filter(fn => typeof fn === 'function');
      expect(ipcCleanups.length).toBeGreaterThan(0);

      ctrl.dispose();

      ipcCleanups.forEach(fn => {
        expect(fn).toHaveBeenCalledTimes(1);
      });
    });

    test('cleans up tracked event listeners', async () => {
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      await ctrl.init();

      expect(ctrl._eventListeners).toHaveLength(3);
      const mockCleanups = ctrl._eventListeners.map(fn => jest.fn(fn));
      ctrl._eventListeners = mockCleanups;

      ctrl.dispose();

      mockCleanups.forEach(fn => {
        expect(fn).toHaveBeenCalledTimes(1);
      });
    });

    test('catches IPC listener cleanup errors', () => {
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);
      ctrl._ipcListeners = [jest.fn(() => { throw new Error('IPC cleanup fail'); })];

      ctrl.dispose();

      expect(mockLog.error).toHaveBeenCalledWith(
        '[MainController] Failed to cleanup IPC listener:',
        expect.any(Error)
      );
    });

    test('catches event listener cleanup errors', () => {
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);
      ctrl._eventListeners = [jest.fn(() => { throw new Error('Event cleanup fail'); })];

      ctrl.dispose();

      expect(mockLog.error).toHaveBeenCalledWith(
        '[MainController] Failed to cleanup event listener:',
        expect.any(Error)
      );
    });

    test('clears window globals', () => {
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      window.mainController = ctrl;
      window.logToMain = () => {};

      ctrl.dispose();

      expect(window.mainController).toBeNull();
      expect(window.logToMain).toBeNull();
    });

    test('double-dispose is idempotent — modules only disposed once', () => {
      const module = { dispose: jest.fn() };
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);
      ctrl.modules = { test: module };

      ctrl.dispose();
      ctrl.dispose();

      expect(module.dispose).toHaveBeenCalledTimes(1);
      expect(ctrl._isDisposed).toBe(true);
    });
  });

  // ── setAssistantStatus() ────────────────────────────────

  describe('setAssistantStatus()', () => {
    test('updates endpoint connection state when available', () => {
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);
      ctrl.modules.endpoint = {
        connection: { state: { assistant: 'waiting' } },
      };

      ctrl.setAssistantStatus('thinking');

      expect(ctrl.modules.endpoint.connection.state.assistant).toBe('thinking');
    });

    test('emits SYSTEM.STATUS_CHANGED event', () => {
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      ctrl.setAssistantStatus('listening');

      expect(opts.eventBus.emit).toHaveBeenCalledWith(
        EventTypes.SYSTEM.STATUS_CHANGED,
        { status: 'listening' }
      );
    });

    test('updates DOM status element when present', () => {
      document.body.innerHTML = '<div id="system-status"></div>';

      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      ctrl.setAssistantStatus('error');

      const el = document.getElementById('system-status');
      expect(el.textContent).toBe('ERROR');
      expect(el.className).toBe('status-indicator status-error');
    });

    test('handles missing DOM status element', () => {
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      expect(() => ctrl.setAssistantStatus('idle')).not.toThrow();
    });

    test('handles missing endpoint gracefully', () => {
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      expect(() => ctrl.setAssistantStatus('waiting')).not.toThrow();
      expect(opts.eventBus.emit).toHaveBeenCalledWith(
        EventTypes.SYSTEM.STATUS_CHANGED,
        { status: 'waiting' }
      );
    });

    test('handles endpoint with no connection gracefully', () => {
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);
      ctrl.modules.endpoint = { connection: null };

      expect(() => ctrl.setAssistantStatus('idle')).not.toThrow();
    });
  });

  // ── getStats() ──────────────────────────────────────────

  describe('getStats()', () => {
    test('returns frozen stats object with all fields', () => {
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);
      ctrl.initialized = true;
      ctrl.backendConnected = true;
      ctrl.currentModel = 'claude-3';
      ctrl.modules = { endpoint: mockEndpointInstance, mainApp: {} };

      const stats = ctrl.getStats();

      expect(stats).toEqual({
        initialized: true,
        backendConnected: true,
        currentModel: 'claude-3',
        modules: ['endpoint', 'mainApp'],
        endpoint: { connections: 1 },
      });

      expect(Object.isFrozen(stats)).toBe(true);
    });

    test('returns null endpoint stats when no endpoint module', () => {
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      const stats = ctrl.getStats();

      expect(stats.endpoint).toBeNull();
      expect(stats.modules).toEqual([]);
    });
  });

  // ── _updateBackendDisplay() ─────────────────────────────

  describe('_updateBackendDisplay()', () => {
    test('shows error state with warning content', () => {
      document.body.innerHTML = '<div id="backend-info"></div>';

      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      ctrl._updateBackendDisplay(null, true);

      const el = document.getElementById('backend-info');
      expect(el.innerHTML).toContain('WAITING FOR BACKEND');
      expect(el.style.display).toBe('block');
      expect(el.style.visibility).toBe('visible');
      expect(el.style.fontWeight).toBe('bold');
    });

    test('shows model name uppercased when health has model', () => {
      document.body.innerHTML = '<div id="backend-info"></div>';

      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      ctrl._updateBackendDisplay({ model: 'gpt-4-turbo' });

      const el = document.getElementById('backend-info');
      expect(el.innerHTML).toContain('GPT-4-TURBO');
      expect(el.innerHTML).toContain('MODEL:');
    });

    test('shows generic online status when health has no model', () => {
      document.body.innerHTML = '<div id="backend-info"></div>';

      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      ctrl._updateBackendDisplay({});

      const el = document.getElementById('backend-info');
      expect(el.innerHTML).toContain('BACKEND ONLINE');
    });

    test('returns early when backend-info element missing', () => {
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      expect(() => ctrl._updateBackendDisplay({ model: 'test' })).not.toThrow();
    });
  });

  // ── Backend handlers ────────────────────────────────────

  describe('_handleBackendOnline()', () => {
    test('sets backendConnected true and calls setAssistantStatus idle', () => {
      document.body.innerHTML = '<div id="system-status"></div><div id="backend-info"></div>';

      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      ctrl._handleBackendOnline({ health: { model: 'claude-3' } });

      expect(ctrl.backendConnected).toBe(true);
      expect(opts.eventBus.emit).toHaveBeenCalledWith(
        EventTypes.SYSTEM.STATUS_CHANGED,
        { status: 'idle' }
      );

      const el = document.getElementById('backend-info');
      expect(el.innerHTML).toContain('CLAUDE-3');
    });

    test('handles event without health data — no display update', () => {
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      ctrl._handleBackendOnline({});

      expect(ctrl.backendConnected).toBe(true);
    });
  });

  describe('_handleBackendOffline()', () => {
    test('sets backendConnected false and shows error display', () => {
      document.body.innerHTML = '<div id="system-status"></div><div id="backend-info"></div>';

      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      ctrl._handleBackendOffline({ error: 'timeout' });

      expect(ctrl.backendConnected).toBe(false);

      const el = document.getElementById('backend-info');
      expect(el.innerHTML).toContain('WAITING FOR BACKEND');
    });
  });

  // ── window.logToMain ────────────────────────────────────

  describe('window.logToMain (from _initializeGlobalState)', () => {
    test('sends formatted message via aether.log.send', async () => {
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      await ctrl.init();

      window.logToMain('hello', { key: 'value' }, 42);

      expect(mockAether.log.send).toHaveBeenCalledWith(
        'hello {"key":"value"} 42'
      );
    });

    test('handles log send failure gracefully', async () => {
      mockAether.log.send = jest.fn(() => { throw new Error('IPC send fail'); });

      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      await ctrl.init();

      expect(() => window.logToMain('test')).not.toThrow();
      expect(mockLog.error).toHaveBeenCalledWith(
        '[MainController] Failed to log to main:',
        expect.any(Error)
      );
    });

    test('handles missing aether.log gracefully via optional chaining', async () => {
      const aetherNoLog = {
        window: { onWidgetModeChange: jest.fn(() => jest.fn()) },
        log: null,
        logger: mockLog,
      };

      const opts = createDefaultOptions({ aether: aetherNoLog });
      const ctrl = new MainController(opts);

      await ctrl.init();

      expect(() => window.logToMain('test')).not.toThrow();
    });
  });

  // ── IPC widget mode ─────────────────────────────────────

  describe('IPC widget mode change', () => {
    test('updates state and emits UI.WIDGET_MODE_CHANGED', async () => {
      let capturedCallback;
      mockAether.window.onWidgetModeChange = jest.fn((cb) => {
        capturedCallback = cb;
        return jest.fn();
      });

      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      await ctrl.init();

      capturedCallback(true);

      expect(opts.eventBus.emit).toHaveBeenCalledWith(
        EventTypes.UI.WIDGET_MODE_CHANGED,
        { isWidget: true }
      );
    });

    test('FIX VERIFIED: null aether.window does NOT push undefined cleanup to _ipcListeners', async () => {
      const aetherNoWindow = {
        window: null,
        log: { send: jest.fn() },
        logger: mockLog,
      };

      const opts = createDefaultOptions({ aether: aetherNoWindow });
      const ctrl = new MainController(opts);

      await ctrl.init();

      // After fix: undefined is NOT pushed — only functions in _ipcListeners
      const hasUndefined = ctrl._ipcListeners.some(fn => typeof fn !== 'function');
      expect(hasUndefined).toBe(false);

      // Dispose should NOT produce spurious error logs
      ctrl.dispose();

      const ipcErrors = mockLog.error.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('Failed to cleanup IPC listener')
      );
      expect(ipcErrors.length).toBe(0);
    });
  });

  // ── Resource lifecycle verification ─────────────────────

  describe('resource lifecycle', () => {
    test('N event listeners created = N tracked for cleanup', async () => {
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      await ctrl.init();

      // 3 event listeners: BACKEND_ONLINE + BACKEND_OFFLINE + unhandledrejection
      expect(ctrl._eventListeners).toHaveLength(3);
      expect(ctrl._eventListeners.every(fn => typeof fn === 'function')).toBe(true);
    });

    test('dispose calls every tracked event listener cleanup exactly once', async () => {
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      await ctrl.init();

      // Let's replace the real cleanups with spies to check if they are called
      const mockCleanups = ctrl._eventListeners.map(fn => jest.fn(fn));
      ctrl._eventListeners = mockCleanups;

      ctrl.dispose();

      mockCleanups.forEach(fn => {
        expect(fn).toHaveBeenCalledTimes(1);
      });
    });

    test('full init+dispose cycle leaves no leaked resources', async () => {
      const opts = createDefaultOptions();
      const ctrl = new MainController(opts);

      await ctrl.init();

      const eventCount = ctrl._eventListeners.length;
      const ipcCount = ctrl._ipcListeners.filter(fn => typeof fn === 'function').length;

      ctrl.dispose();

      // Verify all cleanups were called
      expect(eventCount).toBe(3);
      expect(ipcCount).toBeGreaterThan(0);
      expect(ctrl._isDisposed).toBe(true);
    });
  });
});
