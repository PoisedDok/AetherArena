'use strict';

// =============================================================================
// Mocks (before require)
// =============================================================================

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

const mockChildProcess = {
  pid: 1234,
  killed: false,
  kill: jest.fn(),
  once: jest.fn(),
  unref: jest.fn(),
};
const mockSpawn = jest.fn(() => mockChildProcess);

jest.mock('child_process', () => ({ spawn: mockSpawn }));

const mockFs = {
  existsSync: jest.fn(() => false),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  statSync: jest.fn(() => ({ mode: 0o644 })),  // default: not executable
  chmodSync: jest.fn(),
  mkdirSync: jest.fn(),
  openSync: jest.fn(() => 42),
};
jest.mock('fs', () => mockFs);

jest.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: jest.fn(() => '/mock/app'),
    getPath: jest.fn((key) => {
      if (key === 'home') return '/home/user';
      return '/tmp';
    }),
  },
}), { virtual: true });

jest.mock('../../../src/core/utils/logger', () => ({
  logger: { child: jest.fn(() => mockLog) },
}));

jest.mock('../../../src/core/config', () => ({
  backend: {
    entryScript: 'main.py',
    backendDir: '/mock/backend',
    baseUrl: 'http://localhost:8765',
  },
}));

const { ServiceLauncher, createLauncher, SERVICE_BINARIES } = require('../../../src/main/services/ServiceLauncher');

// =============================================================================
// Tests
// =============================================================================

describe('ServiceLauncher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockChildProcess.killed = false;
    mockChildProcess.pid = 1234;
    mockFs.existsSync.mockReturnValue(false);
  });

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  describe('constructor', () => {
    it('uses config backend dir by default', () => {
      const sl = new ServiceLauncher();
      expect(sl.options.backendDir).toBe('/mock/backend');
      expect(sl.options.backendScript).toBe('main.py');
    });

    it('allows options overrides', () => {
      const sl = new ServiceLauncher({ backendDir: '/custom/dir', backendScript: 'run.py' });
      expect(sl.options.backendDir).toBe('/custom/dir');
      expect(sl.options.backendScript).toBe('run.py');
    });

    it('logs initialization info', () => {
      new ServiceLauncher();
      expect(mockLog.info).toHaveBeenCalledWith('ServiceLauncher initialized', expect.objectContaining({
        platform: expect.any(String),
      }));
    });
  });

  // ---------------------------------------------------------------------------
  // _detectPackagedMode
  // ---------------------------------------------------------------------------

  describe('_detectPackagedMode()', () => {
    it('returns falsy in test environment', () => {
      const sl = new ServiceLauncher();
      expect(sl.isPackaged).toBeFalsy();
    });
  });

  // ---------------------------------------------------------------------------
  // _detectPlatform
  // ---------------------------------------------------------------------------

  describe('_detectPlatform()', () => {
    it('returns current platform', () => {
      const sl = new ServiceLauncher();
      expect(['darwin', 'win32', 'linux']).toContain(sl.platform);
    });
  });

  // ---------------------------------------------------------------------------
  // _getBinaryName
  // ---------------------------------------------------------------------------

  describe('_getBinaryName()', () => {
    it('returns binary name from SERVICE_BINARIES map', () => {
      const sl = new ServiceLauncher();
      const name = sl._getBinaryName('integrated');
      const expected = sl.platform === 'win32' ? 'aether-hub.exe' : 'aether-hub';
      expect(name).toBe(expected);
    });

    it('returns serviceName as fallback if not in map', () => {
      const sl = new ServiceLauncher();
      const name = sl._getBinaryName('custom-service');
      const expected = sl.platform === 'win32' ? 'custom-service.exe' : 'custom-service';
      expect(name).toBe(expected);
    });
  });

  // ---------------------------------------------------------------------------
  // isServiceAvailable
  // ---------------------------------------------------------------------------

  describe('isServiceAvailable()', () => {
    it('returns false when no binDirectory', () => {
      const sl = new ServiceLauncher();
      sl.binDirectory = null;
      expect(sl.isServiceAvailable('integrated')).toBe(false);
    });

    it('returns true when binary exists', () => {
      const sl = new ServiceLauncher();
      sl.binDirectory = '/mock/bin';
      mockFs.existsSync.mockReturnValue(true);
      expect(sl.isServiceAvailable('integrated')).toBe(true);
    });

    it('returns false when binary does not exist', () => {
      const sl = new ServiceLauncher();
      sl.binDirectory = '/mock/bin';
      mockFs.existsSync.mockReturnValue(false);
      expect(sl.isServiceAvailable('integrated')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // getAvailableServices
  // ---------------------------------------------------------------------------

  describe('getAvailableServices()', () => {
    it('returns empty array when no binDirectory', () => {
      const sl = new ServiceLauncher();
      sl.binDirectory = null;
      expect(sl.getAvailableServices()).toEqual([]);
    });

    it('returns services whose binaries exist', () => {
      const sl = new ServiceLauncher();
      sl.binDirectory = '/mock/bin';
      mockFs.existsSync.mockReturnValue(true);
      expect(sl.getAvailableServices()).toEqual(['integrated']);
    });
  });

  // ---------------------------------------------------------------------------
  // _openTerminal
  // ---------------------------------------------------------------------------

  describe('_openTerminal()', () => {
    it('spawns osascript on darwin', () => {
      const sl = new ServiceLauncher();
      sl.platform = 'darwin';
      sl._openTerminal('/path/to/cmd', ['--arg1'], { cwd: '/work' });
      expect(mockSpawn).toHaveBeenCalledWith('osascript', expect.any(Array), expect.objectContaining({
        detached: true,
        stdio: 'ignore',
      }));
    });

    it('spawns cmd.exe on win32', () => {
      const sl = new ServiceLauncher();
      sl.platform = 'win32';
      sl._openTerminal('/path/to/cmd', ['--arg1'], { cwd: '/work' });
      expect(mockSpawn).toHaveBeenCalledWith('cmd.exe', expect.any(Array), expect.objectContaining({
        detached: true,
        shell: true,
      }));
    });

    it('spawns gnome-terminal on linux (default)', () => {
      const sl = new ServiceLauncher();
      sl.platform = 'linux';
      sl._openTerminal('/path/to/cmd', ['--arg1']);
      expect(mockSpawn).toHaveBeenCalledWith('gnome-terminal', expect.any(Array), expect.objectContaining({
        detached: true,
      }));
    });

    it('spawns without cwd on win32 when no cwd given', () => {
      const sl = new ServiceLauncher();
      sl.platform = 'win32';
      sl._openTerminal('/path/to/cmd', ['--flag']);
      const args = mockSpawn.mock.calls[0][1];
      expect(args).toContain('start');
    });
  });

  // ---------------------------------------------------------------------------
  // launchIntegratedBackend (dev mode)
  // ---------------------------------------------------------------------------

  describe('launchIntegratedBackend() dev mode', () => {
    it('throws when backendDir is null', () => {
      const sl = new ServiceLauncher({ backendDir: null, backendScript: 'main.py' });
      sl.isPackaged = false;
      expect(() => sl.launchIntegratedBackend()).toThrow('Backend directory not found');
    });

    it('launches Python script for .py backend', () => {
      const sl = new ServiceLauncher({ backendDir: '/mock/backend', backendScript: 'main.py' });
      sl.isPackaged = false;
      sl.launchIntegratedBackend();
      expect(mockSpawn).toHaveBeenCalledWith('python3', ['main.py'], expect.objectContaining({
        cwd: '/mock/backend',
      }));
    });

    it('launches shell script for .sh backend', () => {
      const sl = new ServiceLauncher({ backendDir: '/mock/backend', backendScript: 'start.sh' });
      sl.isPackaged = false;
      sl.launchIntegratedBackend();
      expect(mockSpawn).toHaveBeenCalledWith('bash', ['start.sh'], expect.objectContaining({
        cwd: '/mock/backend',
      }));
    });

    it('uses custom pythonPath when provided', () => {
      const sl = new ServiceLauncher({ backendDir: '/mock/backend', backendScript: 'main.py', pythonPath: '/usr/bin/python3.11' });
      sl.isPackaged = false;
      sl.launchIntegratedBackend();
      expect(mockSpawn).toHaveBeenCalledWith('/usr/bin/python3.11', ['main.py'], expect.any(Object));
    });
  });

  // ---------------------------------------------------------------------------
  // launchIntegratedBackend (packaged mode)
  // ---------------------------------------------------------------------------

  describe('launchIntegratedBackend() packaged mode', () => {
    it('throws if production script not found', () => {
      const sl = new ServiceLauncher();
      sl.isPackaged = true;
      process.resourcesPath = '/mock/resources';
      mockFs.existsSync.mockReturnValue(false);

      expect(() => sl.launchIntegratedBackend()).toThrow('Production script not found');
    });

    it('launches production script when found', () => {
      const sl = new ServiceLauncher();
      sl.isPackaged = true;
      process.resourcesPath = '/mock/resources';
      // existsSync: first for production script check, then for data dir check
      mockFs.existsSync.mockReturnValue(true);
      // readFileSync for setup_progress.json
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ current_phase: 'completed' }));

      const result = sl.launchIntegratedBackend();
      expect(mockSpawn).toHaveBeenCalledWith('bash', expect.any(Array), expect.objectContaining({
        detached: true,
      }));
      expect(mockChildProcess.unref).toHaveBeenCalled();
      expect(result).toBe(mockChildProcess);
    });

    it('sets AETHER_SKIP_SHELL_SETUP on first run', () => {
      const sl = new ServiceLauncher();
      sl.isPackaged = true;
      process.resourcesPath = '/mock/resources';
      mockFs.existsSync.mockImplementation((p) => {
        if (p.includes('start_production.sh')) return true;
        if (p.includes('setup_progress.json')) return false;
        return true;
      });

      sl.launchIntegratedBackend();
      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[2].env.AETHER_SKIP_SHELL_SETUP).toBe('true');
    });

    it('warns when production script is not executable', () => {
      const sl = new ServiceLauncher();
      sl.isPackaged = true;
      process.resourcesPath = '/mock/resources';
      mockFs.existsSync.mockReturnValue(true);
      mockFs.statSync.mockReturnValue({ mode: 0o644 });  // not executable
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ current_phase: 'completed' }));

      expect(() => sl.launchIntegratedBackend()).not.toThrow();
      expect(mockLog.warn).toHaveBeenCalledWith('Production script is not executable. This indicates a packaging error.', expect.any(Object));
    });

    it('handles stat failure gracefully', () => {
      const sl = new ServiceLauncher();
      sl.isPackaged = true;
      process.resourcesPath = '/mock/resources';
      mockFs.existsSync.mockReturnValue(true);
      mockFs.statSync.mockImplementation(() => { throw new Error('stat fail'); });
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ current_phase: 'completed' }));

      expect(() => sl.launchIntegratedBackend()).not.toThrow();
      expect(mockLog.error).toHaveBeenCalledWith('Failed to stat production script', expect.objectContaining({ error: 'stat fail' }));
    });
  });

  // ---------------------------------------------------------------------------
  // _isSetupComplete
  // ---------------------------------------------------------------------------

  describe('_isSetupComplete()', () => {
    it('returns false when progress file does not exist', () => {
      const sl = new ServiceLauncher();
      mockFs.existsSync.mockReturnValue(false);
      expect(sl._isSetupComplete('/data')).toBe(false);
    });

    it('returns true when current_phase is completed', () => {
      const sl = new ServiceLauncher();
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ current_phase: 'completed' }));
      expect(sl._isSetupComplete('/data')).toBe(true);
    });

    it('returns false when current_phase is skipped', () => {
      const sl = new ServiceLauncher();
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ current_phase: 'skipped' }));
      expect(sl._isSetupComplete('/data')).toBe(false);
    });

    it('returns false when current_phase is in_progress', () => {
      const sl = new ServiceLauncher();
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ current_phase: 'in_progress' }));
      expect(sl._isSetupComplete('/data')).toBe(false);
    });

    it('returns false and logs on read error', () => {
      const sl = new ServiceLauncher();
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation(() => { throw new Error('read fail'); });
      expect(sl._isSetupComplete('/data')).toBe(false);
      expect(mockLog.warn).toHaveBeenCalledWith('Failed to read setup progress file', { error: 'read fail' });
    });
  });

  // ---------------------------------------------------------------------------
  // launchService
  // ---------------------------------------------------------------------------

  describe('launchService()', () => {
    it('throws when binary not found', () => {
      const sl = new ServiceLauncher();
      sl.binDirectory = '/mock/bin';
      mockFs.existsSync.mockReturnValue(false);
      expect(() => sl.launchService('integrated')).toThrow('Service binary not found: integrated');
    });

    it('launches binary headless when not spawnInTerminal', () => {
      const sl = new ServiceLauncher({ spawnInTerminal: false });
      sl.binDirectory = '/mock/bin';
      mockFs.existsSync.mockReturnValue(true);
      const proc = sl.launchService('integrated', ['--port', '8080']);
      expect(mockSpawn).toHaveBeenCalledWith(
        expect.stringContaining('aether-hub'),
        ['--port', '8080'],
        expect.objectContaining({ detached: false, stdio: 'pipe' })
      );
      expect(proc).toBe(mockChildProcess);
    });

    it('launches binary in terminal when spawnInTerminal', () => {
      const sl = new ServiceLauncher({ spawnInTerminal: true });
      sl.binDirectory = '/mock/bin';
      sl.platform = 'darwin';
      mockFs.existsSync.mockReturnValue(true);
      sl.launchService('integrated');
      // On darwin, should call osascript
      expect(mockSpawn).toHaveBeenCalled();
    });

    it('warns when binary is not executable on non-Windows', () => {
      const sl = new ServiceLauncher({ spawnInTerminal: false });
      sl.binDirectory = '/mock/bin';
      sl.platform = 'darwin';
      mockFs.existsSync.mockReturnValue(true);
      mockFs.statSync.mockReturnValue({ mode: 0o644 });  // not executable
      sl.launchService('integrated');
      expect(mockLog.warn).toHaveBeenCalledWith('Binary is not executable. This indicates a packaging error.', expect.any(Object));
    });

    it('does not warn when binary is already executable', () => {
      const sl = new ServiceLauncher({ spawnInTerminal: false });
      sl.binDirectory = '/mock/bin';
      sl.platform = 'darwin';
      mockFs.existsSync.mockReturnValue(true);
      mockFs.statSync.mockReturnValue({ mode: 0o755 });  // already executable
      mockLog.warn.mockClear();
      sl.launchService('integrated');
      expect(mockLog.warn).not.toHaveBeenCalledWith('Binary is not executable. This indicates a packaging error.', expect.any(Object));
    });

    it('handles stat failure gracefully', () => {
      const sl = new ServiceLauncher({ spawnInTerminal: false });
      sl.binDirectory = '/mock/bin';
      sl.platform = 'linux';
      mockFs.existsSync.mockReturnValue(true);
      mockFs.statSync.mockImplementation(() => { throw new Error('stat fail'); });
      expect(() => sl.launchService('integrated')).not.toThrow();
      expect(mockLog.error).toHaveBeenCalledWith('Failed to stat binary', expect.objectContaining({ error: 'stat fail' }));
    });
  });

  // ---------------------------------------------------------------------------
  // killProcess
  // ---------------------------------------------------------------------------

  describe('killProcess()', () => {
    it('resolves immediately for null process', async () => {
      const sl = new ServiceLauncher();
      await sl.killProcess(null);
      expect(mockLog.debug).toHaveBeenCalledWith('Process already killed or invalid');
    });

    it('resolves immediately for already killed process', async () => {
      const sl = new ServiceLauncher();
      const proc = { ...mockChildProcess, killed: true };
      await sl.killProcess(proc);
      expect(mockLog.debug).toHaveBeenCalledWith('Process already killed or invalid');
    });

    it('sends SIGTERM and resolves on exit', async () => {
      const sl = new ServiceLauncher();
      const proc = {
        pid: 5678,
        killed: false,
        kill: jest.fn(),
        once: jest.fn((event, cb) => {
          if (event === 'exit') setTimeout(() => cb(0, 'SIGTERM'), 10);
        }),
      };
      await sl.killProcess(proc, 5000);
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('handles SIGTERM failure gracefully', async () => {
      const sl = new ServiceLauncher();
      const proc = {
        pid: 5678,
        killed: false,
        kill: jest.fn(() => { throw new Error('SIGTERM fail'); }),
        once: jest.fn((event, cb) => {
          if (event === 'exit') setTimeout(() => cb(1, null), 10);
        }),
      };
      await sl.killProcess(proc, 5000);
      expect(mockLog.warn).toHaveBeenCalledWith('SIGTERM failed', expect.objectContaining({ error: 'SIGTERM fail' }));
    });
  });

  // ---------------------------------------------------------------------------
  // killAll
  // ---------------------------------------------------------------------------

  describe('killAll()', () => {
    it('logs kill all', async () => {
      const sl = new ServiceLauncher();
      await sl.killAll();
      expect(mockLog.info).toHaveBeenCalledWith('Killing all processes');
    });
  });

  // ---------------------------------------------------------------------------
  // Singleton
  // ---------------------------------------------------------------------------

  describe('createLauncher()', () => {
    it('creates new instance', () => {
      const sl = createLauncher({ backendDir: '/test' });
      expect(sl).toBeInstanceOf(ServiceLauncher);
    });
  });

  describe('SERVICE_BINARIES', () => {
    it('is frozen', () => {
      expect(Object.isFrozen(SERVICE_BINARIES)).toBe(true);
    });

    it('has integrated key', () => {
      expect(SERVICE_BINARIES.integrated).toBe('aether-hub');
    });
  });
});
