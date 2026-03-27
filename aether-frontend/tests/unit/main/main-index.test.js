'use strict';

// ================================================================
// Mock Infrastructure (hoisted by Jest)
// ================================================================

// Capture lifecycle callbacks registered at module level
const appOnHandlers = {};
const whenReadyCallbacks = [];

jest.mock('electron', () => ({
  app: {
    whenReady: jest.fn(() => ({
      then: jest.fn((cb) => {
        whenReadyCallbacks.push(cb);
        return { catch: jest.fn() };
      }),
    })),
    on: jest.fn((event, handler) => {
      if (!appOnHandlers[event]) appOnHandlers[event] = [];
      appOnHandlers[event].push(handler);
    }),
    quit: jest.fn(),
    exit: jest.fn(),
    getPath: jest.fn(() => '/tmp/test'),
    relaunch: jest.fn(),
  },
  BrowserWindow: jest.fn(),
  ipcMain: { on: jest.fn(), handle: jest.fn(), removeHandler: jest.fn() },
  shell: { openExternal: jest.fn() },
}));

jest.mock('dotenv', () => ({ config: jest.fn() }));

const mockSpawnProcess = {
  once: jest.fn((event, handler) => {
    if (event === 'exit') {
      setTimeout(() => handler(0, null), 10);
    }
  }),
  kill: jest.fn(),
};
jest.mock('child_process', () => ({
  spawn: jest.fn(() => mockSpawnProcess),
}));

const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  flush: jest.fn(() => Promise.resolve()),
};
jest.mock('../../../src/core/utils/logger', () => ({ logger: mockLog }));

// Config with dynamic overrides via getters
let mockCfgOverrides = {};
jest.mock('../../../src/core/config', () => ({
  backend: {
    get shouldSpawn() { return mockCfgOverrides.shouldSpawn !== undefined ? mockCfgOverrides.shouldSpawn : false; },
    get backendDir() { return '/fake/backend'; },
    get entryScript() { return 'start.py'; },
    get baseUrl() { return 'http://localhost:8765'; },
    get wsUrl() { return 'ws://localhost:8765/ws'; },
    get healthCheckInterval() { return 5000; },
    get startupTimeout() { return mockCfgOverrides.startupTimeout !== undefined ? mockCfgOverrides.startupTimeout : 10000; },
  },
  dev: {
    get debugMode() { return mockCfgOverrides.debugMode || false; },
  },
  ui: { normalWidth: 800, normalHeight: 600, widgetSize: 200 },
}));

// --- Service mocks ---
const mockSecMgr = { initialize: jest.fn(), shutdown: jest.fn() };
jest.mock('../../../src/main/security/SecurityManager', () => ({
  getManager: jest.fn(() => mockSecMgr),
}));

const mockHealthStop = jest.fn();
const mockPortMgr = {
  discoverService: jest.fn(() => Promise.resolve({ port: 8765, healthy: true, url: 'http://localhost:8765' })),
  registerService: jest.fn(),
  getHealthyServices: jest.fn(() => [{ name: 'backend', url: 'http://localhost:8765' }]),
  startHealthMonitoring: jest.fn(() => mockHealthStop),
  getService: jest.fn(() => null),
  clearRegistry: jest.fn(),
};
jest.mock('../../../src/main/services/PortManager', () => ({
  getManager: jest.fn(() => mockPortMgr),
}));

const mockWinMgr = {
  initialize: jest.fn(() => Promise.resolve()),
  setQuitting: jest.fn(),
  shutdown: jest.fn(),
  getMainWindow: jest.fn(() => ({})),
};
jest.mock('../../../src/main/windows/WindowManager', () => ({
  getManager: jest.fn(() => mockWinMgr),
}));

const mockIpcRtr = { initialize: jest.fn(), shutdown: jest.fn() };
jest.mock('../../../src/main/services/IpcRouter', () => ({
  getRouter: jest.fn(() => mockIpcRtr),
}));

const mockShortMgr = { initialize: jest.fn(), shutdown: jest.fn() };
jest.mock('../../../src/main/services/ShortcutManager', () => ({
  getManager: jest.fn(() => mockShortMgr),
}));

const mockBkProcess = { pid: 1234, killed: false };
const mockSvcLauncher = {
  launchIntegratedBackend: jest.fn(() => mockBkProcess),
  getAvailableServices: jest.fn(() => ['integrated']),
};
jest.mock('../../../src/main/services/ServiceLauncher', () => ({
  getLauncher: jest.fn(() => mockSvcLauncher),
}));

const mockSysMon = { start: jest.fn(), stop: jest.fn() };
jest.mock('../../../src/main/services/SystemMonitor', () => jest.fn(() => mockSysMon));

const mockStoreHdlr = { initialize: jest.fn(), shutdown: jest.fn() };
jest.mock('../../../src/main/services/StorageIpcHandler', () => ({
  getStorageHandler: jest.fn(() => mockStoreHdlr),
}));

const mockMemHdlr = { initialize: jest.fn(), shutdown: jest.fn() };
jest.mock('../../../src/main/services/MemoryIpcHandler', () => ({
  getMemoryHandler: jest.fn(() => mockMemHdlr),
}));

const mockSessHdlr = { initialize: jest.fn(), shutdown: jest.fn() };
jest.mock('../../../src/main/services/SessionIpcHandler', () => ({
  getSessionHandler: jest.fn(() => mockSessHdlr),
}));

// ================================================================
// Process spies + module load
// ================================================================

const { app: mockApp } = require('electron');
const capturedProcessHandlers = {};
let mainIndex;

beforeAll(() => {
  // Spy on process.on BEFORE requiring the module so we intercept
  // uncaughtException/unhandledRejection registrations
  const origOn = process.on.bind(process);
  jest.spyOn(process, 'on').mockImplementation((event, handler) => {
    if (event === 'uncaughtException' || event === 'unhandledRejection') {
      if (!capturedProcessHandlers[event]) capturedProcessHandlers[event] = [];
      capturedProcessHandlers[event].push(handler);
      return process; // Don't actually register dangerous handlers
    }
    return origOn(event, handler);
  });
  jest.spyOn(process, 'kill').mockImplementation(() => {});
  jest.spyOn(process, 'exit').mockImplementation(() => {});

  // Require the module — triggers all module-level code
  mainIndex = require('../../../src/main/index');
});

afterAll(() => {
  process.on.mockRestore();
  process.kill.mockRestore();
  process.exit.mockRestore();
});

// ================================================================
// Tests
// ================================================================

describe('main/index.js', () => {

  // ----------------------------------------------------------
  // 1. Module-level registrations (run first, before clearMocks)
  // ----------------------------------------------------------
  describe('module-level registrations', () => {
    it('calls dotenv.config()', () => {
      expect(require('dotenv').config).toHaveBeenCalled();
    });

    it('registers whenReady handler', () => {
      expect(whenReadyCallbacks).toHaveLength(1);
      expect(typeof whenReadyCallbacks[0]).toBe('function');
    });

    it('registers before-quit handler', () => {
      expect(appOnHandlers['before-quit']).toHaveLength(1);
    });

    it('registers window-all-closed handler', () => {
      expect(appOnHandlers['window-all-closed']).toHaveLength(1);
    });

    it('registers uncaughtException handler', () => {
      expect(capturedProcessHandlers.uncaughtException).toHaveLength(1);
    });

    it('registers unhandledRejection handler', () => {
      expect(capturedProcessHandlers.unhandledRejection).toHaveLength(1);
    });

    it('exports expected public API', () => {
      expect(mainIndex.initialize).toBeInstanceOf(Function);
      expect(mainIndex.shutdown).toBeInstanceOf(Function);
      expect(mainIndex.getWindowManager).toBeInstanceOf(Function);
      expect(mainIndex.getIpcRouter).toBeInstanceOf(Function);
      expect(mainIndex.getShortcutManager).toBeInstanceOf(Function);
      expect(mainIndex.getServiceLauncher).toBeInstanceOf(Function);
      expect(mainIndex.getPortManager).toBeInstanceOf(Function);
      expect(mainIndex.getSecurityManager).toBeInstanceOf(Function);
    });
  });

  // ----------------------------------------------------------
  // 2. Getters before initialization
  // ----------------------------------------------------------
  describe('getters (pre-init)', () => {
    it('returns null for all services before init', () => {
      expect(mainIndex.getWindowManager()).toBeNull();
      expect(mainIndex.getIpcRouter()).toBeNull();
      expect(mainIndex.getShortcutManager()).toBeNull();
      expect(mainIndex.getServiceLauncher()).toBeNull();
      expect(mainIndex.getPortManager()).toBeNull();
      expect(mainIndex.getSecurityManager()).toBeNull();
    });
  });

  // ----------------------------------------------------------
  // 3. initialize()
  // ----------------------------------------------------------
  describe('initialize()', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockCfgOverrides = {};
      // Set killed=true so spawnBackend() proceeds past "already running" guard
      // when backendProcess is lingering from a previous test
      mockBkProcess.killed = true;
    });

    afterEach(async () => {
      mockBkProcess.killed = true; // Prevent 3s wait in shutdown's backend kill
      try { await mainIndex.shutdown(); } catch (e) { /* cleanup */ }
    });

    it('initializes all services in correct order', async () => {
      await mainIndex.initialize();

      expect(mockSecMgr.initialize).toHaveBeenCalledTimes(1);
      expect(mockPortMgr.discoverService).toHaveBeenCalledWith('backend');
      expect(mockPortMgr.registerService).toHaveBeenCalledWith('backend', 8765, true);
      expect(mockPortMgr.getHealthyServices).toHaveBeenCalled();
      expect(mockPortMgr.startHealthMonitoring).toHaveBeenCalledWith(5000);
      expect(mockWinMgr.initialize).toHaveBeenCalledTimes(1);
      expect(mockSysMon.start).toHaveBeenCalledTimes(1);
      expect(mockStoreHdlr.initialize).toHaveBeenCalledTimes(1);
      expect(mockMemHdlr.initialize).toHaveBeenCalledTimes(1);
      expect(mockSessHdlr.initialize).toHaveBeenCalledTimes(1);
      expect(mockIpcRtr.initialize).toHaveBeenCalledTimes(1);
      expect(mockShortMgr.initialize).toHaveBeenCalledTimes(1);
    });

    it('logs initialization start and completion', async () => {
      await mainIndex.initialize();
      expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('AetherArena Application Starting'));
      expect(mockLog.info).toHaveBeenCalledWith('Application initialization complete');
    });

    it('passes security mode based on NODE_ENV', async () => {
      const { getManager } = require('../../../src/main/security/SecurityManager');
      await mainIndex.initialize();
      // NODE_ENV is 'test', not 'production'
      expect(getManager).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'default',
      }));
    });

    it('registers discovered backend with port manager', async () => {
      mockPortMgr.discoverService.mockResolvedValueOnce({ port: 9000, healthy: false, url: 'http://localhost:9000' });
      await mainIndex.initialize();
      expect(mockPortMgr.registerService).toHaveBeenCalledWith('backend', 9000, false);
    });

    it('skips registration when discovery returns null', async () => {
      mockPortMgr.discoverService.mockResolvedValueOnce(null);
      await mainIndex.initialize();
      expect(mockPortMgr.registerService).not.toHaveBeenCalled();
    });

    it('skips registration when discovery returns no port', async () => {
      mockPortMgr.discoverService.mockResolvedValueOnce({ healthy: true });
      await mainIndex.initialize();
      expect(mockPortMgr.registerService).not.toHaveBeenCalled();
    });

    it('throws on discovery failure when no static URL and shouldSpawn=false', async () => {
      const savedGuru = process.env.GURU_API_URL;
      const savedBk = process.env.backend_url;
      const savedBK = process.env.BACKEND_URL;
      delete process.env.GURU_API_URL;
      delete process.env.backend_url;
      delete process.env.BACKEND_URL;

      mockPortMgr.discoverService.mockRejectedValueOnce(new Error('no backend'));
      mockCfgOverrides.shouldSpawn = false;

      await expect(mainIndex.initialize()).rejects.toThrow('no backend');

      // Restore env
      if (savedGuru !== undefined) process.env.GURU_API_URL = savedGuru;
      if (savedBk !== undefined) process.env.backend_url = savedBk;
      if (savedBK !== undefined) process.env.BACKEND_URL = savedBK;
    });

    it('continues on discovery failure when static URL exists (GURU_API_URL)', async () => {
      const savedGuru = process.env.GURU_API_URL;
      process.env.GURU_API_URL = 'http://external:8765';

      mockPortMgr.discoverService.mockRejectedValueOnce(new Error('no backend'));
      mockCfgOverrides.shouldSpawn = false;

      await mainIndex.initialize(); // should not throw
      expect(mockLog.warn).toHaveBeenCalledWith(
        'Service discovery failed; falling back to configured backend URL',
        expect.any(Object)
      );

      if (savedGuru !== undefined) process.env.GURU_API_URL = savedGuru;
      else delete process.env.GURU_API_URL;
    });

    it('continues on discovery failure when shouldSpawn is true', async () => {
      mockPortMgr.discoverService.mockRejectedValueOnce(new Error('no backend'));
      mockCfgOverrides.shouldSpawn = true;

      await mainIndex.initialize(); // shouldSpawn=true means hasStaticUrl check is bypassed
      expect(mockLog.warn).toHaveBeenCalledWith(
        'Service discovery failed; falling back to configured backend URL',
        expect.any(Object)
      );
    });

    it('spawns backend when shouldSpawn=true and no healthy service', async () => {
      mockCfgOverrides.shouldSpawn = true;
      mockPortMgr.getService.mockReturnValueOnce(null);

      await mainIndex.initialize();

      expect(mockSvcLauncher.launchIntegratedBackend).toHaveBeenCalledTimes(1);
      expect(mockLog.info).toHaveBeenCalledWith(
        'Integrated backend started',
        expect.objectContaining({ pid: 1234 })
      );
    });

    it('skips spawn when backend already healthy', async () => {
      mockCfgOverrides.shouldSpawn = true;
      mockPortMgr.getService.mockReturnValueOnce({ healthy: true, url: 'http://localhost:8765' });

      await mainIndex.initialize();
      expect(mockSvcLauncher.launchIntegratedBackend).not.toHaveBeenCalled();
      expect(mockLog.info).toHaveBeenCalledWith(
        'Backend already running, skipping spawn',
        expect.any(Object)
      );
    });

    it('logs when backend spawning is disabled', async () => {
      mockCfgOverrides.shouldSpawn = false;
      await mainIndex.initialize();
      expect(mockLog.info).toHaveBeenCalledWith('Backend spawning disabled, expecting external backend');
    });

    it('handles backend launch failure gracefully', async () => {
      mockCfgOverrides.shouldSpawn = true;
      mockPortMgr.getService.mockReturnValueOnce(null);
      mockSvcLauncher.launchIntegratedBackend.mockImplementationOnce(() => {
        throw new Error('spawn failed');
      });

      await mainIndex.initialize(); // should not throw (non-fatal)
      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to launch backend',
        expect.objectContaining({ error: 'spawn failed' })
      );
      expect(mockLog.warn).toHaveBeenCalledWith('Continuing without backend');
    });

    it('skips spawn when backend already running (process alive)', async () => {
      mockCfgOverrides.shouldSpawn = true;
      mockPortMgr.getService.mockReturnValueOnce(null);
      mockBkProcess.killed = true; // Allow first spawn to proceed

      // First init — spawns backend
      await mainIndex.initialize();
      expect(mockSvcLauncher.launchIntegratedBackend).toHaveBeenCalledTimes(1);
      jest.clearAllMocks();

      // Simulate backend still alive for second init
      mockBkProcess.killed = false;
      mockCfgOverrides.shouldSpawn = true;
      mockPortMgr.getService.mockReturnValueOnce(null);
      await mainIndex.initialize();
      // spawnBackend() sees backendProcess && !backendProcess.killed → skips
      expect(mockLog.warn).toHaveBeenCalledWith('Backend already running');
    });

    it('rethrows on critical initialization failure', async () => {
      mockSecMgr.initialize.mockRejectedValueOnce(new Error('security fail'));
      await expect(mainIndex.initialize()).rejects.toThrow('security fail');
      expect(mockLog.error).toHaveBeenCalledWith(
        'Application initialization failed',
        expect.objectContaining({ error: 'security fail' })
      );
    });
  });

  // ----------------------------------------------------------
  // 4. Getters after initialization
  // ----------------------------------------------------------
  describe('getters (post-init)', () => {
    beforeEach(async () => {
      jest.clearAllMocks();
      mockCfgOverrides = {};
      mockBkProcess.killed = true;
      await mainIndex.initialize();
    });

    afterEach(async () => {
      mockBkProcess.killed = true;
      try { await mainIndex.shutdown(); } catch (e) {}
    });

    it('returns service instances after init', () => {
      expect(mainIndex.getWindowManager()).toBe(mockWinMgr);
      expect(mainIndex.getIpcRouter()).toBe(mockIpcRtr);
      expect(mainIndex.getShortcutManager()).toBe(mockShortMgr);
      expect(mainIndex.getServiceLauncher()).toBe(mockSvcLauncher);
      expect(mainIndex.getPortManager()).toBe(mockPortMgr);
      expect(mainIndex.getSecurityManager()).toBe(mockSecMgr);
    });
  });

  // ----------------------------------------------------------
  // 5. shutdown()
  // ----------------------------------------------------------
  describe('shutdown()', () => {
    beforeEach(async () => {
      jest.clearAllMocks();
      mockCfgOverrides = {};
      mockBkProcess.killed = true; // Prevent "already running" guard
      // Initialize to populate module state
      await mainIndex.initialize();
      jest.clearAllMocks();
    });

    it('shuts down all services in order', async () => {
      await mainIndex.shutdown();

      expect(mockSysMon.stop).toHaveBeenCalledTimes(1);
      expect(mockWinMgr.setQuitting).toHaveBeenCalledWith(true);
      expect(mockStoreHdlr.shutdown).toHaveBeenCalledTimes(1);
      expect(mockMemHdlr.shutdown).toHaveBeenCalledTimes(1);
      expect(mockSessHdlr.shutdown).toHaveBeenCalledTimes(1);
      expect(mockIpcRtr.shutdown).toHaveBeenCalledTimes(1);
      expect(mockShortMgr.shutdown).toHaveBeenCalledTimes(1);
      expect(mockSecMgr.shutdown).toHaveBeenCalledTimes(1);
      expect(mockPortMgr.clearRegistry).toHaveBeenCalledTimes(1);
      expect(mockWinMgr.shutdown).toHaveBeenCalledTimes(1);
      expect(mockLog.flush).toHaveBeenCalledTimes(1);
    });

    it('logs shutdown start and completion', async () => {
      await mainIndex.shutdown();
      expect(mockLog.info).toHaveBeenCalledWith('Application shutting down');
      expect(mockLog.info).toHaveBeenCalledWith('Application shutdown complete');
    });

    it('stops health monitoring when present', async () => {
      await mainIndex.shutdown();
      expect(mockHealthStop).toHaveBeenCalledTimes(1);
    });

    it('handles shutdown with null state safely', async () => {
      // First shutdown clears state
      await mainIndex.shutdown();
      jest.clearAllMocks();

      // Second shutdown — most services are null
      await mainIndex.shutdown();
      expect(mockLog.info).toHaveBeenCalledWith('Application shutting down');
      expect(mockLog.flush).toHaveBeenCalled();
    });

    it('handles shutdown error gracefully', async () => {
      mockWinMgr.setQuitting.mockImplementationOnce(() => {
        throw new Error('quitting error');
      });

      await mainIndex.shutdown(); // should not throw
      expect(mockLog.error).toHaveBeenCalledWith(
        'Error during shutdown',
        expect.objectContaining({ error: 'quitting error' })
      );
    });
  });

  // ----------------------------------------------------------
  // 6. shutdown() with backend process
  // ----------------------------------------------------------
  describe('shutdown() backend process kill', () => {
    let dateNowValue;

    beforeEach(async () => {
      jest.useFakeTimers();
      jest.clearAllMocks();
      mockCfgOverrides = { shouldSpawn: true };
      mockBkProcess.killed = false;
      mockPortMgr.getService.mockReturnValue(null);

      // Mock Date.now() to return controlled values starting from current time
      dateNowValue = Date.now();
      jest.spyOn(global.Date, 'now').mockImplementation(() => dateNowValue);

      await mainIndex.initialize();
      jest.clearAllMocks();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('kills backend process group and confirms dead', async () => {
      // -pid SIGTERM succeeds, alive check throws (dead)
      process.kill
        .mockImplementationOnce(() => {})       // -pid SIGTERM
        .mockImplementationOnce(() => {          // -pid 0 check — dead
          throw new Error('ESRCH');
        });

      const p = mainIndex.shutdown();
      await jest.advanceTimersByTimeAsync(15000);
      await p;

      expect(process.kill).toHaveBeenCalledWith(-1234, 'SIGTERM');
      expect(mockLog.info).toHaveBeenCalledWith('Backend services terminated');
    });

    it('force kills backend when still alive after graceful wait + fallback', async () => {
      // -pid SIGTERM, then alive checks keep passing, then SIGKILL after fallback
      // Need many alive checks since loop runs every 500ms for 60s
      process.kill
        .mockImplementationOnce(() => {})       // -pid SIGTERM
        .mockImplementation(() => {});          // -pid 0 — always still alive

      const p = mainIndex.shutdown();

      // Advance time past graceful wait (60s) + fallback (30s) + buffer
      const advanceMs = 95000;
      dateNowValue += advanceMs;
      await jest.advanceTimersByTimeAsync(advanceMs);
      await p;

      expect(process.kill).toHaveBeenCalledWith(-1234, 'SIGKILL');
      expect(mockLog.warn).toHaveBeenCalledWith(
        'Backend still alive after fallback, force killing'
      );
    }, 60000); // Increased timeout for long timer advancement

    it('falls back to direct PID kill when group kill fails', async () => {
      // Group kill fails, direct kill succeeds, alive check throws (dead)
      process.kill
        .mockImplementationOnce(() => { throw new Error('EPERM'); }) // -pid SIGTERM fails
        .mockImplementationOnce(() => {})       // direct pid SIGTERM
        .mockImplementationOnce(() => {          // -pid 0 check — dead
          throw new Error('ESRCH');
        });

      const p = mainIndex.shutdown();
      await jest.advanceTimersByTimeAsync(15000);
      await p;

      expect(mockLog.warn).toHaveBeenCalledWith(
        'Process group kill failed, trying direct PID',
        expect.objectContaining({ error: 'EPERM' })
      );
      expect(process.kill).toHaveBeenCalledWith(1234, 'SIGTERM');
    });

    it('skips kill when backend process already killed', async () => {
      mockBkProcess.killed = true;

      const p = mainIndex.shutdown();
      await jest.advanceTimersByTimeAsync(100);
      await p;

      // process.kill should NOT be called for backend
      expect(process.kill).not.toHaveBeenCalledWith(-1234, 'SIGTERM');
    });
  });

  // ----------------------------------------------------------
  // 7. startBackgroundHealthMonitoring (via initialize)
  // ----------------------------------------------------------
  describe('startBackgroundHealthMonitoring()', () => {
    afterEach(async () => {
      jest.useRealTimers();
      mockBkProcess.killed = true;
      try { await mainIndex.shutdown(); } catch (e) {}
    });

    it('registers backend when poll discovers healthy service', async () => {
      jest.useFakeTimers();
      jest.clearAllMocks();
      mockCfgOverrides = { shouldSpawn: true };
      mockBkProcess.killed = false;
      mockPortMgr.getService.mockReturnValue(null);
      mockPortMgr.discoverService
        .mockResolvedValueOnce({ port: 8765, healthy: true, url: 'http://localhost:8765' }) // initial discovery in init
        .mockResolvedValueOnce({ port: 8765, healthy: true, url: 'http://localhost:8765' }); // background poll

      await mainIndex.initialize();
      jest.clearAllMocks();

      // Advance past first poll delay (2s)
      await jest.advanceTimersByTimeAsync(2500);

      expect(mockPortMgr.discoverService).toHaveBeenCalledWith('backend');
      expect(mockPortMgr.registerService).toHaveBeenCalledWith('backend', 8765, true);
    });

    it('retries when discovery fails silently', async () => {
      jest.useFakeTimers();
      jest.clearAllMocks();
      mockCfgOverrides = { shouldSpawn: true };
      mockBkProcess.killed = false;
      mockPortMgr.getService.mockReturnValue(null);
      mockPortMgr.discoverService
        .mockResolvedValueOnce({ port: 8765, healthy: true, url: 'http://localhost:8765' }) // initial
        .mockRejectedValueOnce(new Error('fail'))  // poll 1: fail
        .mockResolvedValueOnce({ port: 8765, healthy: true, url: 'http://localhost:8765' }); // poll 2: success

      await mainIndex.initialize();
      jest.clearAllMocks();

      // Poll 1 at 2s — fails
      await jest.advanceTimersByTimeAsync(2500);
      expect(mockPortMgr.registerService).not.toHaveBeenCalled();

      // Poll 2 at 4s — succeeds
      await jest.advanceTimersByTimeAsync(2000);
      expect(mockPortMgr.registerService).toHaveBeenCalledWith('backend', 8765, true);
    });

    it('stops polling after maxRetries exceeded', async () => {
      jest.useFakeTimers();
      jest.clearAllMocks();
      mockCfgOverrides = { shouldSpawn: true, startupTimeout: 4000 }; // 4 max retries
      mockBkProcess.killed = false;
      mockPortMgr.getService.mockReturnValue(null);
      mockPortMgr.discoverService
        .mockResolvedValueOnce({ port: 8765, healthy: true, url: 'http://localhost:8765' }) // initial
        .mockResolvedValue({ healthy: false }); // all polls: unhealthy

      await mainIndex.initialize();
      jest.clearAllMocks();

      // Advance through all retries
      for (let i = 0; i < 6; i++) {
        await jest.advanceTimersByTimeAsync(2500);
      }

      expect(mockLog.error).toHaveBeenCalledWith(
        'Backend failed to become healthy within timeout',
        expect.objectContaining({ timeout: 4000 })
      );
    });
  });

  // ----------------------------------------------------------
  // 8. window-all-closed handler (MUST run before before-quit)
  // ----------------------------------------------------------
  describe('window-all-closed handler', () => {
    it('calls app.quit when not quitting', () => {
      jest.clearAllMocks();
      const handler = appOnHandlers['window-all-closed'][0];
      handler();
      expect(mockApp.quit).toHaveBeenCalledTimes(1);
    });
  });

  // ----------------------------------------------------------
  // 9. unhandledRejection handler
  // ----------------------------------------------------------
  describe('unhandledRejection handler', () => {
    beforeEach(() => jest.clearAllMocks());

    it('logs Error reason with stack', () => {
      const handler = capturedProcessHandlers.unhandledRejection[0];
      const error = new Error('unhandled promise');
      handler(error, Promise.resolve());

      expect(mockLog.error).toHaveBeenCalledWith(
        'Unhandled rejection',
        expect.objectContaining({
          reason: 'unhandled promise',
          stack: expect.any(String),
        })
      );
    });

    it('logs non-Error reason as string', () => {
      const handler = capturedProcessHandlers.unhandledRejection[0];
      handler('string reason', Promise.resolve());

      expect(mockLog.error).toHaveBeenCalledWith(
        'Unhandled rejection',
        expect.objectContaining({
          reason: 'string reason',
          stack: undefined,
        })
      );
    });
  });

  // ----------------------------------------------------------
  // 10. uncaughtException handler
  // ----------------------------------------------------------
  describe('uncaughtException handler', () => {
    beforeEach(() => jest.clearAllMocks());

    it('logs error, calls shutdown, and exits with code 1', async () => {
      mockBkProcess.killed = true; // Prevent 3s wait in shutdown
      const handler = capturedProcessHandlers.uncaughtException[0];
      const error = new Error('unexpected crash');

      // The handler calls shutdown().finally(() => process.exit(1))
      // shutdown() is async; handler does NOT await it
      handler(error);

      // Flush microtask queue: shutdown() → then → finally → process.exit
      for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setImmediate(resolve));
      }

      expect(mockLog.error).toHaveBeenCalledWith(
        'Uncaught exception',
        expect.objectContaining({
          error: 'unexpected crash',
          stack: expect.any(String),
        })
      );
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });

  // ----------------------------------------------------------
  // 11. whenReady callback
  // ----------------------------------------------------------
  describe('whenReady callback', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockBkProcess.killed = true;
    });

    afterEach(async () => {
      mockBkProcess.killed = true;
      try { await mainIndex.shutdown(); } catch (e) {}
    });

    it('calls initialize and registers activate handler on success', async () => {
      const readyCallback = whenReadyCallbacks[0];
      await readyCallback();

      // initialize() ran successfully
      expect(mockSecMgr.initialize).toHaveBeenCalled();

      // activate handler registered inside the callback
      expect(mockApp.on).toHaveBeenCalledWith('activate', expect.any(Function));
    });

    it('calls app.quit on fatal initialization error', async () => {
      mockSecMgr.initialize.mockRejectedValueOnce(new Error('fatal'));

      const readyCallback = whenReadyCallbacks[0];
      await readyCallback();

      expect(mockLog.error).toHaveBeenCalledWith(
        'Fatal initialization error',
        expect.objectContaining({ error: 'fatal' })
      );
      expect(mockApp.quit).toHaveBeenCalled();
    });

    it('activate handler re-initializes when main window missing', async () => {
      const readyCallback = whenReadyCallbacks[0];
      await readyCallback();

      // Find the activate handler registered inside the whenReady callback
      const activateCall = mockApp.on.mock.calls.find(c => c[0] === 'activate');
      expect(activateCall).toBeDefined();
      const activateHandler = activateCall[1];

      // Simulate main window missing — getMainWindow returns null
      mockWinMgr.getMainWindow.mockReturnValueOnce(null);
      // Ensure initialize returns a promise (for .catch() chaining)
      mockWinMgr.initialize.mockReturnValueOnce(Promise.resolve());
      jest.clearAllMocks();

      activateHandler();

      expect(mockWinMgr.initialize).toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // 12. before-quit handler (LAST — sets isQuitting permanently)
  // ----------------------------------------------------------
  describe('before-quit handler', () => {
    it('prevents default, shuts down, and calls app.quit()', async () => {
      jest.clearAllMocks();
      mockBkProcess.killed = true;

      // Initialize so shutdown has work to do
      await mainIndex.initialize();
      jest.clearAllMocks();

      const handler = appOnHandlers['before-quit'][0];
      const event = { preventDefault: jest.fn() };

      await handler(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(mockLog.info).toHaveBeenCalledWith('App quit requested, cleaning up...');
      expect(mockApp.exit).toHaveBeenCalledWith(0);
    });

    it('is idempotent — second call is no-op', async () => {
      jest.clearAllMocks();
      const handler = appOnHandlers['before-quit'][0];
      const event = { preventDefault: jest.fn() };

      await handler(event);

      // isQuitting is now true — second call should not preventDefault
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(mockApp.exit).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // 13. window-all-closed when isQuitting=true (after before-quit)
  // ----------------------------------------------------------
  describe('window-all-closed handler (post-quit)', () => {
    it('does not call app.quit when already quitting', () => {
      jest.clearAllMocks();
      const handler = appOnHandlers['window-all-closed'][0];
      handler();
      // isQuitting is true from the before-quit test above
      expect(mockApp.quit).not.toHaveBeenCalled();
    });
  });
});
