'use strict';

/**
 * MainOrchestrator Unit Tests
 * ============================================================================
 * Tests the main window application orchestrator: init lifecycle, sendMessage
 * flow, stopCurrentRequest, updateModel/updateProfile, toggleAudio/Visualizer,
 * connection monitor integration, event listener wiring, state/stats getters,
 * initial state loading, and destroy cleanup.
 *
 * Bug found: _ensureInitialized checked !isInitialized before isDestroyed,
 * causing wrong error message after destroy(). Fixed in source.
 *
 * @module tests/unit/application/MainOrchestrator.test
 */

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

const mockRequestLifecycle = {
  startRequest: jest.fn().mockReturnValue(Object.freeze({
    id: 'req_001',
    cancel: jest.fn(),
    complete: jest.fn(),
    fail: jest.fn(),
  })),
  completeRequest: jest.fn(),
  failRequest: jest.fn(),
  cancelRequest: jest.fn().mockReturnValue(true),
  cancelAll: jest.fn().mockReturnValue(0),
  isActive: jest.fn().mockReturnValue(false),
  getStats: jest.fn().mockReturnValue({ active: 0, total: 0, completed: 0, failed: 0 }),
  getActiveRequests: jest.fn().mockReturnValue([]),
  getHistory: jest.fn().mockReturnValue([]),
  destroy: jest.fn(),
};

jest.mock('../../../src/application/shared/RequestLifecycleManager', () => ({
  RequestLifecycleManager: jest.fn().mockImplementation(() => mockRequestLifecycle),
}));

// ---------------------------------------------------------------------------
// Require after mocks
// ---------------------------------------------------------------------------

const { MainOrchestrator } = require('../../../src/application/main/MainOrchestrator');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDeps(overrides = {}) {
  return {
    eventBus: {
      emit: jest.fn(),
      on: jest.fn(),
      off: jest.fn(),
      removeAllListeners: jest.fn(),
    },
    guruConnection: {
      send: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      off: jest.fn(),
    },
    ipcBridge: {
      send: jest.fn(),
      on: jest.fn(),
      off: jest.fn(),
      removeAllListeners: jest.fn(),
    },
    container: {
      resolve: jest.fn().mockImplementation((name) => {
        const services = {
          ConnectionMonitor: {
            on: jest.fn(),
            off: jest.fn(),
            isConnected: jest.fn().mockReturnValue(false),
          },
          ModelManager: {
            selectModel: jest.fn().mockResolvedValue(undefined),
            getCurrentModel: jest.fn().mockResolvedValue('gpt-4'),
          },
          ProfileManager: {
            selectProfile: jest.fn().mockResolvedValue(undefined),
            getCurrentProfile: jest.fn().mockResolvedValue('default'),
          },
          SettingsManager: {},
          UIManager: {},
          UIStateManager: {},
          AudioManager: {
            enable: jest.fn(),
            disable: jest.fn(),
          },
          Visualizer: {
            start: jest.fn(),
            stop: jest.fn(),
          },
        };
        return services[name] || null;
      }),
    },
    endpoint: {},
    performanceMonitor: { start: jest.fn(), end: jest.fn() },
    metricsCollector: { recordCustom: jest.fn() },
    errorTracker: { captureException: jest.fn() },
    ...overrides,
  };
}

/** Create orchestrator and call init() */
async function createInitialized(overrides = {}) {
  const deps = createMockDeps(overrides);
  const orch = new MainOrchestrator(deps);
  await orch.init();
  return { orch, deps };
}

// Reset mock request lifecycle between tests
beforeEach(() => {
  Object.values(mockRequestLifecycle).forEach((fn) => {
    if (typeof fn === 'function' && fn.mockClear) fn.mockClear();
  });
  mockRequestLifecycle.startRequest.mockReturnValue(Object.freeze({
    id: 'req_001',
    cancel: jest.fn(),
    complete: jest.fn(),
    fail: jest.fn(),
  }));
  mockRequestLifecycle.getStats.mockReturnValue({ active: 0, total: 0, completed: 0, failed: 0 });
  mockRequestLifecycle.getActiveRequests.mockReturnValue([]);
  mockRequestLifecycle.isActive.mockReturnValue(false);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MainOrchestrator', () => {

  // -----------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------
  describe('constructor', () => {
    it('initializes with default state', () => {
      const deps = createMockDeps();
      const orch = new MainOrchestrator(deps);

      expect(orch.isInitialized).toBe(false);
      expect(orch.isDestroyed).toBe(false);
      expect(orch.state.backendConnected).toBe(false);
      expect(orch.state.currentProfile).toBeNull();
      expect(orch.state.currentModel).toBeNull();
      expect(orch.state.audioEnabled).toBe(false);
      expect(orch.state.visualizerActive).toBe(false);
    });

    it('stores provided dependencies', () => {
      const deps = createMockDeps();
      const orch = new MainOrchestrator(deps);

      expect(orch.eventBus).toBe(deps.eventBus);
      expect(orch.guruConnection).toBe(deps.guruConnection);
      expect(orch.ipcBridge).toBe(deps.ipcBridge);
      expect(orch.container).toBe(deps.container);
      expect(orch.endpoint).toBe(deps.endpoint);
      expect(orch.performanceMonitor).toBe(deps.performanceMonitor);
      expect(orch.metricsCollector).toBe(deps.metricsCollector);
      expect(orch.errorTracker).toBe(deps.errorTracker);
    });

    it('defaults all optional deps to null when not provided', () => {
      const orch = new MainOrchestrator();

      expect(orch.container).toBeNull();
      expect(orch.eventBus).toBeNull();
      expect(orch.guruConnection).toBeNull();
      expect(orch.ipcBridge).toBeNull();
      expect(orch.endpoint).toBeNull();
      expect(orch.performanceMonitor).toBeNull();
      expect(orch.metricsCollector).toBeNull();
      expect(orch.errorTracker).toBeNull();
    });

    it('application services are null before init', () => {
      const orch = new MainOrchestrator(createMockDeps());

      expect(orch.uiManager).toBeNull();
      expect(orch.audioManager).toBeNull();
      expect(orch.visualizer).toBeNull();
      expect(orch.eventHandler).toBeNull();
      expect(orch.connectionMonitor).toBeNull();
      expect(orch.modelManager).toBeNull();
      expect(orch.profileManager).toBeNull();
      expect(orch.settingsManager).toBeNull();
      expect(orch.uiStateManager).toBeNull();
      expect(orch.requestLifecycle).toBeNull();
    });

    it('accepts enableLogging option', () => {
      const orch = new MainOrchestrator({ enableLogging: true });
      expect(orch.enableLogging).toBe(true);
    });
  });

  // -----------------------------------------------------------------
  // init()
  // -----------------------------------------------------------------
  describe('init()', () => {
    it('initializes all services and sets initialized flag', async () => {
      const { orch } = await createInitialized();

      expect(orch.isInitialized).toBe(true);
      expect(orch.requestLifecycle).not.toBeNull();
      expect(orch.connectionMonitor).not.toBeNull();
      expect(orch.modelManager).not.toBeNull();
      expect(orch.profileManager).not.toBeNull();
      expect(orch.settingsManager).not.toBeNull();
      expect(orch.uiManager).not.toBeNull();
      expect(orch.uiStateManager).not.toBeNull();
      expect(orch.audioManager).not.toBeNull();
      expect(orch.visualizer).not.toBeNull();
    });

    it('resolves services from DI container', async () => {
      const { deps } = await createInitialized();

      expect(deps.container.resolve).toHaveBeenCalledWith('ConnectionMonitor');
      expect(deps.container.resolve).toHaveBeenCalledWith('ModelManager');
      expect(deps.container.resolve).toHaveBeenCalledWith('ProfileManager');
      expect(deps.container.resolve).toHaveBeenCalledWith('SettingsManager');
      expect(deps.container.resolve).toHaveBeenCalledWith('UIManager');
      expect(deps.container.resolve).toHaveBeenCalledWith('UIStateManager');
      expect(deps.container.resolve).toHaveBeenCalledWith('AudioManager');
      expect(deps.container.resolve).toHaveBeenCalledWith('Visualizer');
    });

    it('emits initialized event', async () => {
      const { deps } = await createInitialized();
      expect(deps.eventBus.emit).toHaveBeenCalledWith('main:orchestrator:initialized');
    });

    it('is idempotent -- second call is no-op', async () => {
      const { orch, deps } = await createInitialized();
      const prevCallCount = deps.container.resolve.mock.calls.length;
      await orch.init();
      expect(deps.container.resolve.mock.calls.length).toBe(prevCallCount);
    });

    it('skips container services when container not provided', async () => {
      const deps = createMockDeps({ container: null });
      const orch = new MainOrchestrator(deps);
      await orch.init();
      expect(orch.connectionMonitor).toBeNull();
      expect(orch.modelManager).toBeNull();
      expect(orch.profileManager).toBeNull();
      expect(orch.uiManager).toBeNull();
    });

    it('loads initial state from managers', async () => {
      const { orch } = await createInitialized();
      expect(orch.state.currentModel).toBe('gpt-4');
      expect(orch.state.currentProfile).toBe('default');
    });

    it('handles connection monitor registration', async () => {
      const { orch } = await createInitialized();
      // ConnectionMonitor.on should have been called for 'connected' and 'disconnected'
      expect(orch.connectionMonitor.on).toHaveBeenCalledWith('connected', expect.any(Function));
      expect(orch.connectionMonitor.on).toHaveBeenCalledWith('disconnected', expect.any(Function));
    });

    it('captures error and re-throws on init failure', async () => {
      const { RequestLifecycleManager } = require('../../../src/application/shared/RequestLifecycleManager');
      RequestLifecycleManager.mockImplementationOnce(() => {
        throw new Error('lifecycle init fail');
      });

      const deps = createMockDeps();
      const orch = new MainOrchestrator(deps);

      await expect(orch.init()).rejects.toThrow('lifecycle init fail');
      expect(deps.errorTracker.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        'MainOrchestrator.init'
      );
      expect(orch.isInitialized).toBe(false);
    });
  });

  // -----------------------------------------------------------------
  // _ensureInitialized()
  // -----------------------------------------------------------------
  describe('initialization guards', () => {
    it('throws when calling methods before init', () => {
      const orch = new MainOrchestrator(createMockDeps());
      expect(() => orch.getState()).not.toThrow(); // getState has no guard
      expect(orch.sendMessage('hi')).rejects.toThrow(/not initialized/);
    });

    it('throws "destroyed" when calling methods after destroy', async () => {
      const { orch } = await createInitialized();
      orch.destroy();
      await expect(orch.sendMessage('hi')).rejects.toThrow('has been destroyed');
    });
  });

  // -----------------------------------------------------------------
  // sendMessage()
  // -----------------------------------------------------------------
  describe('sendMessage()', () => {
    it('throws on empty/null message', async () => {
      const { orch } = await createInitialized();
      orch.state.backendConnected = true;

      await expect(orch.sendMessage(null)).rejects.toThrow('Invalid message');
      await expect(orch.sendMessage('')).rejects.toThrow('Invalid message');
      await expect(orch.sendMessage(123)).rejects.toThrow('Invalid message');
    });

    it('throws when backend not connected', async () => {
      const { orch } = await createInitialized();
      orch.state.backendConnected = false;

      await expect(orch.sendMessage('hello')).rejects.toThrow('Backend not connected');
    });

    it('starts request lifecycle and sends via guruConnection', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.backendConnected = true;

      const result = await orch.sendMessage('hello world');

      expect(mockRequestLifecycle.startRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'user-message',
          timeout: 120000,
          metadata: expect.objectContaining({
            message: 'hello world',
          }),
        })
      );

      expect(deps.guruConnection.send).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'user',
          type: 'message',
          id: 'req_001',
          content: 'hello world',
        })
      );

      expect(result.id).toBe('req_001');
    });

    it('uses custom timeout from options', async () => {
      const { orch } = await createInitialized();
      orch.state.backendConnected = true;

      await orch.sendMessage('test', { timeout: 5000 });

      expect(mockRequestLifecycle.startRequest).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 5000 })
      );
    });

    it('includes model and profile in payload', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.backendConnected = true;
      orch.state.currentModel = 'llama-3';
      orch.state.currentProfile = 'developer';

      await orch.sendMessage('hello');

      expect(deps.guruConnection.send).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'llama-3',
          profile: 'developer',
        })
      );
    });

    it('truncates message in metadata to 100 chars', async () => {
      const { orch } = await createInitialized();
      orch.state.backendConnected = true;
      const longMsg = 'x'.repeat(200);

      await orch.sendMessage(longMsg);

      expect(mockRequestLifecycle.startRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            message: 'x'.repeat(100),
          }),
        })
      );
    });

    it('calls performanceMonitor start/end', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.backendConnected = true;

      await orch.sendMessage('hello');

      expect(deps.performanceMonitor.start).toHaveBeenCalledWith('sendMessage:req_001');
      expect(deps.performanceMonitor.end).toHaveBeenCalledWith('sendMessage:req_001');
    });

    it('calls request.fail and captures error on failure', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.backendConnected = true;
      deps.guruConnection.send.mockImplementation(() => { throw new Error('send fail'); });

      await expect(orch.sendMessage('hello')).rejects.toThrow('send fail');
      expect(deps.errorTracker.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        'MainOrchestrator.sendMessage'
      );
    });

    it('ends performance monitor even on failure', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.backendConnected = true;
      deps.guruConnection.send.mockImplementation(() => { throw new Error('fail'); });

      await expect(orch.sendMessage('hello')).rejects.toThrow();
      expect(deps.performanceMonitor.end).toHaveBeenCalledWith('sendMessage:req_001');
    });

    it('skips performanceMonitor when not provided', async () => {
      const deps = createMockDeps({ performanceMonitor: null });
      const orch = new MainOrchestrator(deps);
      await orch.init();
      orch.state.backendConnected = true;

      await expect(orch.sendMessage('hello')).resolves.toBeDefined();
    });
  });

  // -----------------------------------------------------------------
  // stopCurrentRequest()
  // -----------------------------------------------------------------
  describe('stopCurrentRequest()', () => {
    it('is no-op when no active requests', async () => {
      const { orch, deps } = await createInitialized();
      mockRequestLifecycle.getActiveRequests.mockReturnValue([]);

      await orch.stopCurrentRequest();

      expect(mockRequestLifecycle.cancelRequest).not.toHaveBeenCalled();
      expect(deps.guruConnection.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'stop' })
      );
    });

    it('cancels all active requests and sends stop to backend', async () => {
      const { orch, deps } = await createInitialized();
      mockRequestLifecycle.getActiveRequests.mockReturnValue([
        { id: 'req_001' },
        { id: 'req_002' },
      ]);

      await orch.stopCurrentRequest();

      expect(mockRequestLifecycle.cancelRequest).toHaveBeenCalledWith('req_001');
      expect(mockRequestLifecycle.cancelRequest).toHaveBeenCalledWith('req_002');
      expect(deps.guruConnection.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'stop', id: 'req_001' })
      );
    });

    it('captures error and re-throws on failure', async () => {
      const { orch, deps } = await createInitialized();
      mockRequestLifecycle.getActiveRequests.mockReturnValue([{ id: 'req_001' }]);
      deps.guruConnection.send.mockRejectedValueOnce(new Error('stop fail'));

      await expect(orch.stopCurrentRequest()).rejects.toThrow('stop fail');
      expect(deps.errorTracker.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        'MainOrchestrator.stopCurrentRequest'
      );
    });
  });

  // -----------------------------------------------------------------
  // updateModel()
  // -----------------------------------------------------------------
  describe('updateModel()', () => {
    it('delegates to ModelManager and updates state', async () => {
      const { orch } = await createInitialized();

      await orch.updateModel('llama-3');

      expect(orch.modelManager.selectModel).toHaveBeenCalledWith('llama-3');
      expect(orch.state.currentModel).toBe('llama-3');
    });

    it('emits main:model:changed event', async () => {
      const { orch, deps } = await createInitialized();

      await orch.updateModel('qwen-2.5');

      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        'main:model:changed',
        { modelId: 'qwen-2.5' }
      );
    });

    it('throws when ModelManager not available', async () => {
      const { orch } = await createInitialized();
      orch.modelManager = null;

      await expect(orch.updateModel('gpt-4')).rejects.toThrow('ModelManager not available');
    });

    it('captures error on selectModel failure', async () => {
      const { orch, deps } = await createInitialized();
      orch.modelManager.selectModel.mockRejectedValueOnce(new Error('select fail'));

      await expect(orch.updateModel('bad')).rejects.toThrow('select fail');
      expect(deps.errorTracker.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        'MainOrchestrator.updateModel'
      );
    });
  });

  // -----------------------------------------------------------------
  // updateProfile()
  // -----------------------------------------------------------------
  describe('updateProfile()', () => {
    it('delegates to ProfileManager and updates state', async () => {
      const { orch } = await createInitialized();

      await orch.updateProfile('developer');

      expect(orch.profileManager.selectProfile).toHaveBeenCalledWith('developer');
      expect(orch.state.currentProfile).toBe('developer');
    });

    it('emits main:profile:changed event', async () => {
      const { orch, deps } = await createInitialized();

      await orch.updateProfile('developer');

      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        'main:profile:changed',
        { profileId: 'developer' }
      );
    });

    it('throws when ProfileManager not available', async () => {
      const { orch } = await createInitialized();
      orch.profileManager = null;

      await expect(orch.updateProfile('x')).rejects.toThrow('ProfileManager not available');
    });

    it('captures error on selectProfile failure', async () => {
      const { orch, deps } = await createInitialized();
      orch.profileManager.selectProfile.mockRejectedValueOnce(new Error('profile fail'));

      await expect(orch.updateProfile('bad')).rejects.toThrow('profile fail');
      expect(deps.errorTracker.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        'MainOrchestrator.updateProfile'
      );
    });
  });

  // -----------------------------------------------------------------
  // toggleAudio()
  // -----------------------------------------------------------------
  describe('toggleAudio()', () => {
    it('enables audio and updates state', async () => {
      const { orch } = await createInitialized();

      orch.toggleAudio(true);

      expect(orch.audioManager.enable).toHaveBeenCalled();
      expect(orch.state.audioEnabled).toBe(true);
    });

    it('disables audio and updates state', async () => {
      const { orch } = await createInitialized();
      orch.state.audioEnabled = true;

      orch.toggleAudio(false);

      expect(orch.audioManager.disable).toHaveBeenCalled();
      expect(orch.state.audioEnabled).toBe(false);
    });

    it('emits main:audio:toggled event', async () => {
      const { orch, deps } = await createInitialized();

      orch.toggleAudio(true);

      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        'main:audio:toggled',
        { enabled: true }
      );
    });

    it('throws when AudioManager not available', async () => {
      const { orch } = await createInitialized();
      orch.audioManager = null;

      expect(() => orch.toggleAudio(true)).toThrow('AudioManager not available');
    });
  });

  // -----------------------------------------------------------------
  // toggleVisualizer()
  // -----------------------------------------------------------------
  describe('toggleVisualizer()', () => {
    it('starts visualizer and updates state', async () => {
      const { orch } = await createInitialized();

      orch.toggleVisualizer(true);

      expect(orch.visualizer.start).toHaveBeenCalled();
      expect(orch.state.visualizerActive).toBe(true);
    });

    it('stops visualizer and updates state', async () => {
      const { orch } = await createInitialized();
      orch.state.visualizerActive = true;

      orch.toggleVisualizer(false);

      expect(orch.visualizer.stop).toHaveBeenCalled();
      expect(orch.state.visualizerActive).toBe(false);
    });

    it('emits main:visualizer:toggled event', async () => {
      const { orch, deps } = await createInitialized();

      orch.toggleVisualizer(true);

      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        'main:visualizer:toggled',
        { active: true }
      );
    });

    it('throws when Visualizer not available', async () => {
      const { orch } = await createInitialized();
      orch.visualizer = null;

      expect(() => orch.toggleVisualizer(true)).toThrow('Visualizer not available');
    });
  });

  // -----------------------------------------------------------------
  // getState() / getStats()
  // -----------------------------------------------------------------
  describe('getState()', () => {
    it('returns frozen copy of state', async () => {
      const { orch } = await createInitialized();
      orch.state.currentModel = 'gpt-4';

      const state = orch.getState();

      expect(Object.isFrozen(state)).toBe(true);
      expect(state.currentModel).toBe('gpt-4');

      // Modifying returned state does not affect internal state
      try { state.currentModel = 'modified'; } catch { /* frozen */ }
      expect(orch.state.currentModel).toBe('gpt-4');
    });
  });

  describe('getStats()', () => {
    it('returns frozen stats with request and manager info', async () => {
      const { orch } = await createInitialized();

      const stats = orch.getStats();

      expect(Object.isFrozen(stats)).toBe(true);
      expect(stats.initialized).toBe(true);
      expect(typeof stats.activeRequests).toBe('number');
      expect(stats.requestStats).not.toBeNull();
    });

    it('handles null requestLifecycle gracefully', () => {
      const orch = new MainOrchestrator(createMockDeps());
      const stats = orch.getStats();
      expect(stats.activeRequests).toBe(0);
      expect(stats.requestStats).toBeNull();
    });
  });

  // -----------------------------------------------------------------
  // Connection monitor integration
  // -----------------------------------------------------------------
  describe('connection monitor events', () => {
    it('updates state on connected event', async () => {
      const { orch } = await createInitialized();
      orch.state.backendConnected = false;

      // Get the 'connected' callback
      const connectedCall = orch.connectionMonitor.on.mock.calls.find(c => c[0] === 'connected');
      expect(connectedCall).toBeDefined();
      connectedCall[1]();

      expect(orch.state.backendConnected).toBe(true);
    });

    it('emits main:backend:connected event', async () => {
      const { orch, deps } = await createInitialized();
      deps.eventBus.emit.mockClear();

      const connectedCall = orch.connectionMonitor.on.mock.calls.find(c => c[0] === 'connected');
      connectedCall[1]();

      expect(deps.eventBus.emit).toHaveBeenCalledWith('main:backend:connected');
    });

    it('updates state on disconnected event', async () => {
      const { orch } = await createInitialized();
      orch.state.backendConnected = true;

      const disconnectedCall = orch.connectionMonitor.on.mock.calls.find(c => c[0] === 'disconnected');
      disconnectedCall[1]();

      expect(orch.state.backendConnected).toBe(false);
    });

    it('emits main:backend:disconnected event', async () => {
      const { orch, deps } = await createInitialized();
      deps.eventBus.emit.mockClear();

      const disconnectedCall = orch.connectionMonitor.on.mock.calls.find(c => c[0] === 'disconnected');
      disconnectedCall[1]();

      expect(deps.eventBus.emit).toHaveBeenCalledWith('main:backend:disconnected');
    });
  });

  // -----------------------------------------------------------------
  // Event listener wiring
  // -----------------------------------------------------------------
  describe('event listeners', () => {
    it('registers eventBus listeners for backend events', async () => {
      const { deps } = await createInitialized();

      const eventNames = deps.eventBus.on.mock.calls.map(c => c[0]);
      expect(eventNames).toContain('backend:message-complete');
      expect(eventNames).toContain('backend:message-error');
    });

    it('registers ipcBridge listeners for main commands', async () => {
      const { deps } = await createInitialized();

      const eventNames = deps.ipcBridge.on.mock.calls.map(c => c[0]);
      expect(eventNames).toContain('main:send-message');
      expect(eventNames).toContain('main:stop-request');
    });

    it('backend:message-complete completes active request', async () => {
      const { deps } = await createInitialized();
      mockRequestLifecycle.isActive.mockReturnValue(true);

      const call = deps.eventBus.on.mock.calls.find(c => c[0] === 'backend:message-complete');
      call[1]({ requestId: 'req_001', data: 'done' });

      expect(mockRequestLifecycle.completeRequest).toHaveBeenCalledWith('req_001', { requestId: 'req_001', data: 'done' });
    });

    it('backend:message-error fails active request', async () => {
      const { deps } = await createInitialized();
      mockRequestLifecycle.isActive.mockReturnValue(true);

      const call = deps.eventBus.on.mock.calls.find(c => c[0] === 'backend:message-error');
      call[1]({ requestId: 'req_001', error: 'exploded' });

      expect(mockRequestLifecycle.failRequest).toHaveBeenCalledWith('req_001', 'exploded');
    });

    it('does not complete/fail inactive requests', async () => {
      const { deps } = await createInitialized();
      mockRequestLifecycle.isActive.mockReturnValue(false);

      const completeCall = deps.eventBus.on.mock.calls.find(c => c[0] === 'backend:message-complete');
      completeCall[1]({ requestId: 'req_999' });

      expect(mockRequestLifecycle.completeRequest).not.toHaveBeenCalled();
    });

    it('skips event listeners when eventBus is null', async () => {
      const deps = createMockDeps({ eventBus: null });
      const orch = new MainOrchestrator(deps);

      await expect(orch.init()).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------
  // _loadInitialState()
  // -----------------------------------------------------------------
  describe('_loadInitialState()', () => {
    it('loads model and profile from managers', async () => {
      const { orch } = await createInitialized();

      expect(orch.state.currentModel).toBe('gpt-4');
      expect(orch.state.currentProfile).toBe('default');
    });

    it('checks connection status from monitor', async () => {
      const { orch } = await createInitialized();
      expect(orch.connectionMonitor.isConnected).toHaveBeenCalled();
    });

    it('handles manager errors gracefully (does not throw)', async () => {
      const deps = createMockDeps();
      deps.container.resolve.mockImplementation((name) => {
        if (name === 'ModelManager') {
          return {
            selectModel: jest.fn(),
            getCurrentModel: jest.fn().mockRejectedValue(new Error('model err')),
          };
        }
        if (name === 'ProfileManager') {
          return {
            selectProfile: jest.fn(),
            getCurrentProfile: jest.fn().mockRejectedValue(new Error('profile err')),
          };
        }
        if (name === 'ConnectionMonitor') {
          return {
            on: jest.fn(),
            isConnected: jest.fn().mockReturnValue(false),
          };
        }
        return {};
      });

      const orch = new MainOrchestrator(deps);
      // _loadInitialState catches errors internally
      await expect(orch.init()).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------
  // destroy()
  // -----------------------------------------------------------------
  describe('destroy()', () => {
    it('sets lifecycle flags', async () => {
      const { orch } = await createInitialized();

      orch.destroy();

      expect(orch.isDestroyed).toBe(true);
      expect(orch.isInitialized).toBe(false);
    });

    it('destroys requestLifecycle', async () => {
      const { orch } = await createInitialized();

      orch.destroy();

      expect(mockRequestLifecycle.destroy).toHaveBeenCalled();
    });

    it('cleans up eventBus listeners', async () => {
      const { orch, deps } = await createInitialized();

      orch.destroy();

      expect(deps.eventBus.removeAllListeners).toHaveBeenCalledWith('main:*');
    });

    it('stops visualizer and disables audio', async () => {
      const { orch } = await createInitialized();

      orch.destroy();

      expect(orch.visualizer.stop).toHaveBeenCalled();
      expect(orch.audioManager.disable).toHaveBeenCalled();
    });

    it('is idempotent -- safe to call twice', async () => {
      const { orch } = await createInitialized();

      orch.destroy();
      expect(() => orch.destroy()).not.toThrow();
    });

    it('handles null services gracefully', async () => {
      const orch = new MainOrchestrator({});
      expect(() => orch.destroy()).not.toThrow();
    });
  });

  // -----------------------------------------------------------------
  // Full lifecycle integration
  // -----------------------------------------------------------------
  describe('full lifecycle', () => {
    it('init -> updateModel -> sendMessage -> stop -> destroy', async () => {
      const { orch, deps } = await createInitialized();

      // 1. Verify init
      expect(orch.isInitialized).toBe(true);

      // 2. Update model
      await orch.updateModel('llama-3');
      expect(orch.state.currentModel).toBe('llama-3');

      // 3. Connect backend
      const connectedCall = orch.connectionMonitor.on.mock.calls.find(c => c[0] === 'connected');
      connectedCall[1]();
      expect(orch.state.backendConnected).toBe(true);

      // 4. Send message
      const request = await orch.sendMessage('Hello AI');
      expect(request.id).toBe('req_001');

      // 5. Stop request
      mockRequestLifecycle.getActiveRequests.mockReturnValue([{ id: 'req_001' }]);
      await orch.stopCurrentRequest();
      expect(mockRequestLifecycle.cancelRequest).toHaveBeenCalledWith('req_001');

      // 6. Destroy
      orch.destroy();
      expect(orch.isDestroyed).toBe(true);
      expect(orch.isInitialized).toBe(false);
    });
  });

  // -----------------------------------------------------------------
  // Constructor: event handler references
  // -----------------------------------------------------------------
  describe('constructor event handler refs', () => {
    it('initializes all event handler refs to null', () => {
      const orch = new MainOrchestrator(createMockDeps());

      expect(orch._onConnected).toBeNull();
      expect(orch._onDisconnected).toBeNull();
      expect(orch._onBackendMessageComplete).toBeNull();
      expect(orch._onBackendMessageError).toBeNull();
      expect(orch._onIpcSendMessage).toBeNull();
      expect(orch._onIpcStopRequest).toBeNull();
    });

    it('stores config option', () => {
      const config = { theme: 'dark', maxRetries: 3 };
      const orch = new MainOrchestrator({ config });
      expect(orch.config).toEqual(config);
    });

    it('defaults config to empty object', () => {
      const orch = new MainOrchestrator();
      expect(orch.config).toEqual({});
    });
  });

  // -----------------------------------------------------------------
  // Bug fix: sendMessage async rejection handling
  // -----------------------------------------------------------------
  describe('sendMessage() async rejection', () => {
    it('catches async (Promise) rejection from guruConnection.send', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.backendConnected = true;
      deps.guruConnection.send.mockRejectedValue(new Error('network failure'));

      await expect(orch.sendMessage('hello')).rejects.toThrow('network failure');
      expect(deps.errorTracker.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        'MainOrchestrator.sendMessage'
      );
    });

    it('calls request.fail on async rejection', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.backendConnected = true;
      const failFn = jest.fn();
      mockRequestLifecycle.startRequest.mockReturnValue(Object.freeze({
        id: 'req_async',
        cancel: jest.fn(),
        complete: jest.fn(),
        fail: failFn,
      }));
      deps.guruConnection.send.mockRejectedValue(new Error('timeout'));

      await expect(orch.sendMessage('hello')).rejects.toThrow('timeout');
      expect(failFn).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  // -----------------------------------------------------------------
  // Bug fix: comprehensive destroy cleanup (listener deregistration)
  // -----------------------------------------------------------------
  describe('destroy() comprehensive listener cleanup', () => {
    it('removes backend:message-complete listener from eventBus', async () => {
      const { orch, deps } = await createInitialized();
      orch.destroy();
      expect(deps.eventBus.off).toHaveBeenCalledWith(
        'backend:message-complete',
        expect.any(Function)
      );
    });

    it('removes backend:message-error listener from eventBus', async () => {
      const { orch, deps } = await createInitialized();
      orch.destroy();
      expect(deps.eventBus.off).toHaveBeenCalledWith(
        'backend:message-error',
        expect.any(Function)
      );
    });

    it('removes main:send-message listener from ipcBridge', async () => {
      const { orch, deps } = await createInitialized();
      orch.destroy();
      expect(deps.ipcBridge.off).toHaveBeenCalledWith(
        'main:send-message',
        expect.any(Function)
      );
    });

    it('removes main:stop-request listener from ipcBridge', async () => {
      const { orch, deps } = await createInitialized();
      orch.destroy();
      expect(deps.ipcBridge.off).toHaveBeenCalledWith(
        'main:stop-request',
        expect.any(Function)
      );
    });

    it('removes connected/disconnected listeners from connectionMonitor', async () => {
      const { orch } = await createInitialized();
      const cm = orch.connectionMonitor;
      orch.destroy();
      expect(cm.off).toHaveBeenCalledWith('connected', expect.any(Function));
      expect(cm.off).toHaveBeenCalledWith('disconnected', expect.any(Function));
    });

    it('passes same function ref to on() and off() for proper deregistration', async () => {
      const { orch, deps } = await createInitialized();

      // Capture refs registered via on()
      const onCompleteCall = deps.eventBus.on.mock.calls.find(
        c => c[0] === 'backend:message-complete'
      );
      const onErrorCall = deps.eventBus.on.mock.calls.find(
        c => c[0] === 'backend:message-error'
      );
      const registeredCompleteFn = onCompleteCall[1];
      const registeredErrorFn = onErrorCall[1];

      orch.destroy();

      // Verify off() receives the exact same function reference
      const offCompleteCall = deps.eventBus.off.mock.calls.find(
        c => c[0] === 'backend:message-complete'
      );
      const offErrorCall = deps.eventBus.off.mock.calls.find(
        c => c[0] === 'backend:message-error'
      );
      expect(offCompleteCall[1]).toBe(registeredCompleteFn);
      expect(offErrorCall[1]).toBe(registeredErrorFn);
    });

    it('skips ipcBridge cleanup when ipcBridge is null', async () => {
      const deps = createMockDeps({ ipcBridge: null });
      const orch = new MainOrchestrator(deps);
      await orch.init();
      expect(() => orch.destroy()).not.toThrow();
    });

    it('safely handles destroy after partial init (handler refs still null)', async () => {
      // Simulate init failing at RequestLifecycleManager -- handler refs stay null
      const { RequestLifecycleManager } = require('../../../src/application/shared/RequestLifecycleManager');
      RequestLifecycleManager.mockImplementationOnce(() => {
        throw new Error('partial init');
      });

      const deps = createMockDeps();
      const orch = new MainOrchestrator(deps);

      await expect(orch.init()).rejects.toThrow('partial init');

      // eventBus/ipcBridge/connectionMonitor are set (from constructor deps)
      // but handler refs (_onBackendMessageComplete etc.) are null (init failed before _setupEventListeners)
      expect(orch.eventBus).not.toBeNull();
      expect(orch._onBackendMessageComplete).toBeNull();
      expect(orch._onIpcSendMessage).toBeNull();
      expect(orch._onConnected).toBeNull();

      // destroy() should handle this gracefully -- false branches of handler ref checks
      expect(() => orch.destroy()).not.toThrow();
      expect(orch.isDestroyed).toBe(true);
    });
  });

  // -----------------------------------------------------------------
  // sendMessage: onCancel / onTimeout callbacks
  // -----------------------------------------------------------------
  describe('sendMessage() request callbacks', () => {
    it('provides onCancel callback to startRequest', async () => {
      const { orch } = await createInitialized();
      orch.state.backendConnected = true;

      await orch.sendMessage('hello');

      const opts = mockRequestLifecycle.startRequest.mock.calls[0][0];
      expect(typeof opts.onCancel).toBe('function');
      // Invoke it -- should not throw
      expect(() => opts.onCancel()).not.toThrow();
    });

    it('provides onTimeout callback to startRequest', async () => {
      const { orch } = await createInitialized();
      orch.state.backendConnected = true;

      await orch.sendMessage('hello');

      const opts = mockRequestLifecycle.startRequest.mock.calls[0][0];
      expect(typeof opts.onTimeout).toBe('function');
      // Invoke it -- should not throw
      expect(() => opts.onTimeout()).not.toThrow();
    });

    it('onCancel logs when enableLogging is true', async () => {
      const deps = createMockDeps();
      const orch = new MainOrchestrator({ ...deps, enableLogging: true });
      await orch.init();
      orch.state.backendConnected = true;

      await orch.sendMessage('hello');

      const opts = mockRequestLifecycle.startRequest.mock.calls[0][0];
      // Should not throw when invoked with logging enabled
      expect(() => opts.onCancel()).not.toThrow();
    });
  });

  // -----------------------------------------------------------------
  // ipcBridge callback invocation (functional, not just registration)
  // -----------------------------------------------------------------
  describe('ipcBridge callback execution', () => {
    it('main:send-message callback invokes sendMessage', async () => {
      const { orch, deps } = await createInitialized();
      orch.state.backendConnected = true;

      // Find the callback registered for main:send-message
      const call = deps.ipcBridge.on.mock.calls.find(c => c[0] === 'main:send-message');
      expect(call).toBeDefined();
      const callback = call[1];

      // Invoke it with a valid message
      callback('IPC hello');

      // Give the async sendMessage time to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(deps.guruConnection.send).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'IPC hello' })
      );
    });

    it('main:stop-request callback invokes stopCurrentRequest', async () => {
      const { orch, deps } = await createInitialized();
      mockRequestLifecycle.getActiveRequests.mockReturnValue([{ id: 'req_ipc' }]);

      // Find the callback
      const call = deps.ipcBridge.on.mock.calls.find(c => c[0] === 'main:stop-request');
      expect(call).toBeDefined();
      const callback = call[1];

      // Invoke it
      callback();

      // Give async stopCurrentRequest time to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockRequestLifecycle.cancelRequest).toHaveBeenCalledWith('req_ipc');
    });

    it('main:send-message callback catches and does not throw on error', async () => {
      const { orch, deps } = await createInitialized();
      // Backend not connected -- sendMessage will throw
      orch.state.backendConnected = false;

      const call = deps.ipcBridge.on.mock.calls.find(c => c[0] === 'main:send-message');
      const callback = call[1];

      // Should not throw (error is caught internally)
      expect(() => callback('fail message')).not.toThrow();
      await new Promise(resolve => setTimeout(resolve, 10));
    });

    it('main:stop-request callback catches and does not throw on error', async () => {
      const { orch, deps } = await createInitialized();
      mockRequestLifecycle.getActiveRequests.mockReturnValue([{ id: 'req_err' }]);
      deps.guruConnection.send.mockRejectedValue(new Error('stop fail'));

      const call = deps.ipcBridge.on.mock.calls.find(c => c[0] === 'main:stop-request');
      const callback = call[1];

      // Should not throw (error is caught internally)
      expect(() => callback()).not.toThrow();
      await new Promise(resolve => setTimeout(resolve, 10));
    });
  });

  // -----------------------------------------------------------------
  // Error recovery in private init methods
  // -----------------------------------------------------------------
  describe('private initialization error recovery', () => {
    it('_initializeConnectionMonitor catches resolve error gracefully', async () => {
      const deps = createMockDeps();
      deps.container.resolve.mockImplementation((name) => {
        if (name === 'ConnectionMonitor') throw new Error('CM not registered');
        return {};
      });

      const orch = new MainOrchestrator(deps);
      await expect(orch.init()).resolves.toBeUndefined();
      // ConnectionMonitor stays null (constructor default) since resolve threw
      expect(orch.connectionMonitor).toBeNull();
    });

    it('_initializeManagers catches resolve error gracefully', async () => {
      const deps = createMockDeps();
      deps.container.resolve.mockImplementation((name) => {
        if (name === 'ConnectionMonitor') {
          return { on: jest.fn(), off: jest.fn(), isConnected: jest.fn().mockReturnValue(false) };
        }
        if (name === 'ModelManager') throw new Error('MM not registered');
        return {};
      });

      const orch = new MainOrchestrator(deps);
      await expect(orch.init()).resolves.toBeUndefined();
      // ModelManager stays null (constructor default) since resolve threw
      expect(orch.modelManager).toBeNull();
    });

    it('_initializeUIServices catches resolve error gracefully', async () => {
      const deps = createMockDeps();
      deps.container.resolve.mockImplementation((name) => {
        if (name === 'ConnectionMonitor') {
          return { on: jest.fn(), off: jest.fn(), isConnected: jest.fn().mockReturnValue(false) };
        }
        if (name === 'ModelManager') {
          return { selectModel: jest.fn(), getCurrentModel: jest.fn().mockResolvedValue(null) };
        }
        if (name === 'ProfileManager') {
          return { selectProfile: jest.fn(), getCurrentProfile: jest.fn().mockResolvedValue(null) };
        }
        if (name === 'SettingsManager') return {};
        if (name === 'UIManager') throw new Error('UIManager not registered');
        return {};
      });

      const orch = new MainOrchestrator(deps);
      await expect(orch.init()).resolves.toBeUndefined();
      // uiManager stays null (constructor default) since resolve threw
      expect(orch.uiManager).toBeNull();
    });

    it('_setupEventListeners catches and tracks error when eventBus.on throws', async () => {
      const deps = createMockDeps();
      deps.eventBus.on.mockImplementation(() => {
        throw new Error('eventBus.on exploded');
      });

      const orch = new MainOrchestrator(deps);
      await expect(orch.init()).rejects.toThrow('eventBus.on exploded');
      expect(deps.errorTracker.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        'MainOrchestrator._setupEventListeners'
      );
    });

    it('_setupEventListeners error propagates even without errorTracker', async () => {
      const deps = createMockDeps({ errorTracker: null });
      deps.eventBus.on.mockImplementation(() => {
        throw new Error('eventBus failure');
      });

      const orch = new MainOrchestrator(deps);
      await expect(orch.init()).rejects.toThrow('eventBus failure');
    });
  });

  // -----------------------------------------------------------------
  // enableLogging branch coverage
  // -----------------------------------------------------------------
  describe('enableLogging paths', () => {
    /** Helper: create initialized orchestrator with logging enabled */
    async function createWithLogging(overrides = {}) {
      const deps = createMockDeps(overrides);
      const orch = new MainOrchestrator({ ...deps, enableLogging: true });
      await orch.init();
      return { orch, deps };
    }

    it('constructor logs when enableLogging is true', () => {
      // Just creating the instance covers the constructor log branch
      const orch = new MainOrchestrator({ enableLogging: true });
      expect(orch.enableLogging).toBe(true);
    });

    it('init() logs initialization start and completion', async () => {
      const { orch } = await createWithLogging();
      // If we got here without error, the logging branches were executed
      expect(orch.isInitialized).toBe(true);
    });

    it('sendMessage() logs on success', async () => {
      const { orch } = await createWithLogging();
      orch.state.backendConnected = true;

      const result = await orch.sendMessage('logged message');
      expect(result).toBeDefined();
    });

    it('stopCurrentRequest() logs when no active requests', async () => {
      const { orch } = await createWithLogging();
      mockRequestLifecycle.getActiveRequests.mockReturnValue([]);

      await orch.stopCurrentRequest();
      // Covers the "No active requests to stop" log branch
    });

    it('stopCurrentRequest() logs after stopping requests', async () => {
      const { orch } = await createWithLogging();
      mockRequestLifecycle.getActiveRequests.mockReturnValue([{ id: 'req_log' }]);

      await orch.stopCurrentRequest();
      // Covers the "Stopped all requests" log branch
    });

    it('updateModel() logs on success', async () => {
      const { orch } = await createWithLogging();
      await orch.updateModel('gpt-4-logged');
      expect(orch.state.currentModel).toBe('gpt-4-logged');
    });

    it('updateProfile() logs on success', async () => {
      const { orch } = await createWithLogging();
      await orch.updateProfile('logged-profile');
      expect(orch.state.currentProfile).toBe('logged-profile');
    });

    it('toggleAudio() logs on toggle', async () => {
      const { orch } = await createWithLogging();
      orch.toggleAudio(true);
      expect(orch.state.audioEnabled).toBe(true);
    });

    it('toggleVisualizer() logs on toggle', async () => {
      const { orch } = await createWithLogging();
      orch.toggleVisualizer(true);
      expect(orch.state.visualizerActive).toBe(true);
    });

    it('destroy() logs start and completion', async () => {
      const { orch } = await createWithLogging();
      orch.destroy();
      expect(orch.isDestroyed).toBe(true);
    });
  });

  // -----------------------------------------------------------------
  // Sync method guards after destroy
  // -----------------------------------------------------------------
  describe('sync method guards after destroy', () => {
    it('toggleAudio throws "destroyed" after destroy', async () => {
      const { orch } = await createInitialized();
      orch.destroy();
      expect(() => orch.toggleAudio(true)).toThrow('has been destroyed');
    });

    it('toggleVisualizer throws "destroyed" after destroy', async () => {
      const { orch } = await createInitialized();
      orch.destroy();
      expect(() => orch.toggleVisualizer(true)).toThrow('has been destroyed');
    });

    it('updateModel rejects with "destroyed" after destroy', async () => {
      const { orch } = await createInitialized();
      orch.destroy();
      await expect(orch.updateModel('x')).rejects.toThrow('has been destroyed');
    });

    it('updateProfile rejects with "destroyed" after destroy', async () => {
      const { orch } = await createInitialized();
      orch.destroy();
      await expect(orch.updateProfile('x')).rejects.toThrow('has been destroyed');
    });

    it('stopCurrentRequest rejects with "destroyed" after destroy', async () => {
      const { orch } = await createInitialized();
      orch.destroy();
      await expect(orch.stopCurrentRequest()).rejects.toThrow('has been destroyed');
    });
  });

  // -----------------------------------------------------------------
  // _ensureInitialized: exact error messages
  // -----------------------------------------------------------------
  describe('_ensureInitialized error specificity', () => {
    it('throws "not initialized" with hint when not yet initialized', () => {
      const orch = new MainOrchestrator(createMockDeps());
      expect(() => orch.toggleAudio(true)).toThrow('not initialized');
    });

    it('prioritizes "destroyed" over "not initialized"', async () => {
      const { orch } = await createInitialized();
      orch.destroy();
      // isDestroyed=true AND isInitialized=false -- should get destroyed msg
      expect(() => orch.toggleAudio(true)).toThrow('has been destroyed');
    });
  });

  // -----------------------------------------------------------------
  // getStats edge cases
  // -----------------------------------------------------------------
  describe('getStats() completeness', () => {
    it('returns all state fields in stats', async () => {
      const { orch } = await createInitialized();
      orch.state.currentModel = 'test-model';
      orch.state.currentProfile = 'test-profile';
      orch.state.audioEnabled = true;
      orch.state.visualizerActive = true;

      const stats = orch.getStats();

      expect(stats.initialized).toBe(true);
      expect(stats.backendConnected).toBe(false);
      expect(stats.currentModel).toBe('test-model');
      expect(stats.currentProfile).toBe('test-profile');
      expect(stats.audioEnabled).toBe(true);
      expect(stats.visualizerActive).toBe(true);
      expect(typeof stats.activeRequests).toBe('number');
      expect(stats.requestStats).toBeDefined();
    });
  });

  // -----------------------------------------------------------------
  // init() event handler refs populated after init
  // -----------------------------------------------------------------
  describe('init() populates event handler refs', () => {
    it('sets _onConnected and _onDisconnected after init', async () => {
      const { orch } = await createInitialized();
      expect(typeof orch._onConnected).toBe('function');
      expect(typeof orch._onDisconnected).toBe('function');
    });

    it('sets _onBackendMessageComplete and _onBackendMessageError after init', async () => {
      const { orch } = await createInitialized();
      expect(typeof orch._onBackendMessageComplete).toBe('function');
      expect(typeof orch._onBackendMessageError).toBe('function');
    });

    it('sets _onIpcSendMessage and _onIpcStopRequest after init with ipcBridge', async () => {
      const { orch } = await createInitialized();
      expect(typeof orch._onIpcSendMessage).toBe('function');
      expect(typeof orch._onIpcStopRequest).toBe('function');
    });

    it('leaves ipc handler refs null when ipcBridge not provided', async () => {
      const deps = createMockDeps({ ipcBridge: null });
      const orch = new MainOrchestrator(deps);
      await orch.init();
      expect(orch._onIpcSendMessage).toBeNull();
      expect(orch._onIpcStopRequest).toBeNull();
    });

    it('leaves connection handler refs null when container not provided', async () => {
      const deps = createMockDeps({ container: null });
      const orch = new MainOrchestrator(deps);
      await orch.init();
      expect(orch._onConnected).toBeNull();
      expect(orch._onDisconnected).toBeNull();
    });
  });

  // -----------------------------------------------------------------
  // Double error tracking in init failure path
  // -----------------------------------------------------------------
  describe('init() error tracking', () => {
    it('tracks error in both _initializeRequestLifecycle and init on lifecycle failure', async () => {
      const { RequestLifecycleManager } = require('../../../src/application/shared/RequestLifecycleManager');
      RequestLifecycleManager.mockImplementationOnce(() => {
        throw new Error('lifecycle boom');
      });

      const deps = createMockDeps();
      const orch = new MainOrchestrator(deps);

      await expect(orch.init()).rejects.toThrow('lifecycle boom');
      // Error tracked in both places
      expect(deps.errorTracker.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        'MainOrchestrator._initializeRequestLifecycle'
      );
      expect(deps.errorTracker.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        'MainOrchestrator.init'
      );
    });
  });
});
