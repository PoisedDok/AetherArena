'use strict';

// ============================================================================
// Mocks
// ============================================================================

const mockCpuData = [
  { model: 'Mock CPU', speed: 2400, times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
  { model: 'Mock CPU', speed: 2400, times: { user: 120, nice: 0, sys: 60, idle: 820, irq: 0 } },
];

jest.mock('electron', () => ({
  app: { on: jest.fn(), whenReady: jest.fn(() => Promise.resolve()), getPath: jest.fn(() => '/tmp/test'), quit: jest.fn() },
  BrowserWindow: jest.fn(),
  ipcMain: { on: jest.fn(), handle: jest.fn(), removeHandler: jest.fn() },
  ipcRenderer: { send: jest.fn(), invoke: jest.fn(), on: jest.fn() },
}), { virtual: true });

const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../../../src/core/utils/logger', () => ({
  createLogger: jest.fn(() => mockLog),
}));

// ============================================================================
// Import after mocks
// ============================================================================

const os = require('os');
const SystemMonitor = require('../../../src/main/services/SystemMonitor');

// ============================================================================
// Test Suite
// ============================================================================

describe('SystemMonitor', () => {
  let monitor;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Deterministic os mocks
    jest.spyOn(os, 'cpus').mockReturnValue(mockCpuData);
    jest.spyOn(os, 'totalmem').mockReturnValue(16 * 1024 * 1024 * 1024); // 16 GB
    jest.spyOn(os, 'freemem').mockReturnValue(8 * 1024 * 1024 * 1024);   // 8 GB free
    jest.spyOn(os, 'platform').mockReturnValue('darwin');
    jest.spyOn(os, 'arch').mockReturnValue('arm64');
    jest.spyOn(os, 'hostname').mockReturnValue('test-host');
    jest.spyOn(os, 'uptime').mockReturnValue(3600);

    monitor = new SystemMonitor();
  });

  afterEach(() => {
    monitor.stop();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Constructor
  // --------------------------------------------------------------------------

  describe('constructor', () => {
    it('creates with default pollInterval of 250ms', () => {
      expect(monitor.pollInterval).toBe(250);
    });

    it('accepts custom pollInterval', () => {
      const custom = new SystemMonitor({ pollInterval: 1000 });
      expect(custom.pollInterval).toBe(1000);
    });

    it('creates with enableLogging defaulting to false', () => {
      expect(monitor.enableLogging).toBe(false);
    });

    it('accepts enableLogging option', () => {
      const custom = new SystemMonitor({ enableLogging: true });
      expect(custom.enableLogging).toBe(true);
    });

    it('creates logger with SystemMonitor component', () => {
      const { createLogger } = require('../../../src/core/utils/logger');
      expect(createLogger).toHaveBeenCalledWith({ component: 'SystemMonitor' });
    });

    it('initializes intervalId as null', () => {
      expect(monitor.intervalId).toBeNull();
    });

    it('initializes lastCpuInfo as null', () => {
      expect(monitor.lastCpuInfo).toBeNull();
    });

    it('initializes stats with correct shape', () => {
      expect(monitor.stats).toMatchObject({
        cpu: { percent: 0, count: 2 },
        memory: { used: 0, total: 16 * 1024 * 1024 * 1024, percent: 0 },
        process: { memory: 0, cpu: 0 },
        system: {
          platform: 'darwin',
          arch: 'arm64',
          hostname: 'test-host',
          uptime: 0,
        },
      });
      expect(typeof monitor.stats.timestamp).toBe('number');
    });
  });

  // --------------------------------------------------------------------------
  // start()
  // --------------------------------------------------------------------------

  describe('start', () => {
    it('starts the polling interval', () => {
      monitor.start();
      expect(monitor.intervalId).not.toBeNull();
    });

    it('captures initial CPU info', () => {
      monitor.start();
      expect(monitor.lastCpuInfo).not.toBeNull();
      expect(monitor.lastCpuInfo).toHaveProperty('idle');
      expect(monitor.lastCpuInfo).toHaveProperty('total');
    });

    it('performs initial stats update immediately', () => {
      monitor.start();
      // Memory should be updated from the mocked values
      expect(monitor.stats.memory.used).toBe(8 * 1024 * 1024 * 1024);
      expect(monitor.stats.memory.percent).toBe(50);
      expect(monitor.stats.system.uptime).toBe(3600);
    });

    it('updates stats on each interval tick', () => {
      monitor.start();
      const firstTimestamp = monitor.stats.timestamp;

      // Change mocked values
      os.freemem.mockReturnValue(4 * 1024 * 1024 * 1024); // 4 GB free → 75% used

      jest.advanceTimersByTime(250);

      expect(monitor.stats.memory.used).toBe(12 * 1024 * 1024 * 1024);
      expect(monitor.stats.memory.percent).toBe(75);
    });

    it('warns and returns if already running', () => {
      monitor.start();
      monitor.start();
      expect(mockLog.warn).toHaveBeenCalledWith('Already running');
    });

    it('does not create duplicate interval when called twice', () => {
      monitor.start();
      const firstId = monitor.intervalId;
      monitor.start();
      expect(monitor.intervalId).toBe(firstId);
    });

    it('logs debug when enableLogging is true', () => {
      const loggingMonitor = new SystemMonitor({ enableLogging: true });
      loggingMonitor.start();
      expect(mockLog.debug).toHaveBeenCalledWith('Started');
      loggingMonitor.stop();
    });

    it('does not log debug when enableLogging is false', () => {
      monitor.start();
      expect(mockLog.debug).not.toHaveBeenCalledWith('Started');
    });
  });

  // --------------------------------------------------------------------------
  // stop()
  // --------------------------------------------------------------------------

  describe('stop', () => {
    it('clears the polling interval', () => {
      monitor.start();
      expect(monitor.intervalId).not.toBeNull();
      monitor.stop();
      expect(monitor.intervalId).toBeNull();
    });

    it('does nothing if not running', () => {
      monitor.stop();
      expect(monitor.intervalId).toBeNull();
      expect(mockLog.debug).not.toHaveBeenCalledWith('Stopped');
    });

    it('stops further stat updates', () => {
      monitor.start();
      monitor.stop();

      const statsAfterStop = { ...monitor.stats };

      // Change mock and advance time
      os.freemem.mockReturnValue(2 * 1024 * 1024 * 1024);
      jest.advanceTimersByTime(1000);

      // Stats should NOT have changed
      expect(monitor.stats.memory.used).toBe(statsAfterStop.memory.used);
    });

    it('logs debug when enableLogging is true', () => {
      const loggingMonitor = new SystemMonitor({ enableLogging: true });
      loggingMonitor.start();
      jest.clearAllMocks();
      loggingMonitor.stop();
      expect(mockLog.debug).toHaveBeenCalledWith('Stopped');
    });

    it('does not log debug when enableLogging is false', () => {
      monitor.start();
      jest.clearAllMocks();
      monitor.stop();
      expect(mockLog.debug).not.toHaveBeenCalledWith('Stopped');
    });

    it('allows restart after stop', () => {
      monitor.start();
      monitor.stop();
      monitor.start();
      expect(monitor.intervalId).not.toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // getStats()
  // --------------------------------------------------------------------------

  describe('getStats', () => {
    it('returns a copy of stats (not the same reference)', () => {
      const stats = monitor.getStats();
      expect(stats).not.toBe(monitor.stats);
      expect(stats).toEqual(monitor.stats);
    });

    it('returns current stats after start', () => {
      monitor.start();
      const stats = monitor.getStats();
      expect(stats.memory.used).toBe(8 * 1024 * 1024 * 1024);
      expect(stats.memory.percent).toBe(50);
      expect(stats.cpu.count).toBe(2);
      expect(stats.system.platform).toBe('darwin');
      expect(stats.system.arch).toBe('arm64');
      expect(stats.system.hostname).toBe('test-host');
      expect(stats.system.uptime).toBe(3600);
    });
  });

  // --------------------------------------------------------------------------
  // _updateStats()
  // --------------------------------------------------------------------------

  describe('_updateStats', () => {
    it('calculates memory usage correctly', () => {
      monitor.lastCpuInfo = monitor._getCPUInfo();
      monitor._updateStats();
      // total 16GB, free 8GB → used 8GB, percent 50%
      expect(monitor.stats.memory.used).toBe(8 * 1024 * 1024 * 1024);
      expect(monitor.stats.memory.total).toBe(16 * 1024 * 1024 * 1024);
      expect(monitor.stats.memory.percent).toBe(50);
    });

    it('updates system uptime', () => {
      monitor.lastCpuInfo = monitor._getCPUInfo();
      os.uptime.mockReturnValue(7200.5);
      monitor._updateStats();
      expect(monitor.stats.system.uptime).toBe(7200);
    });

    it('captures process memory usage when available', () => {
      monitor.lastCpuInfo = monitor._getCPUInfo();
      monitor._updateStats();
      // process.memoryUsage exists in node — should populate heapUsed
      expect(typeof monitor.stats.process.memory).toBe('number');
      expect(monitor.stats.process.memory).toBeGreaterThan(0);
    });

    it('updates timestamp', () => {
      monitor.lastCpuInfo = monitor._getCPUInfo();
      const before = Date.now();
      monitor._updateStats();
      const after = Date.now();
      expect(monitor.stats.timestamp).toBeGreaterThanOrEqual(before);
      expect(monitor.stats.timestamp).toBeLessThanOrEqual(after);
    });

    it('updates CPU percent from delta', () => {
      // Set known start CPU info
      monitor.lastCpuInfo = { idle: 500, total: 1000 };
      // Set new CPU times that produce a deterministic diff
      os.cpus.mockReturnValue([
        { model: 'CPU', speed: 2400, times: { user: 300, nice: 0, sys: 400, idle: 600, irq: 0 } },
      ]);
      // New from _getCPUInfo: idle=600, total=1300
      // idleDiff=100, totalDiff=300 → 100 - floor(100*100/300) = 100-33 = 67
      monitor._updateStats();
      expect(monitor.stats.cpu.percent).toBe(67);
    });
  });

  // --------------------------------------------------------------------------
  // _getCPUInfo()
  // --------------------------------------------------------------------------

  describe('_getCPUInfo', () => {
    it('returns idle and total summed across all CPUs', () => {
      const info = monitor._getCPUInfo();
      // CPU 1: user=100, nice=0, sys=50, idle=850, irq=0 → total=1000, idle=850
      // CPU 2: user=120, nice=0, sys=60, idle=820, irq=0 → total=1000, idle=820
      // Combined: total=2000, idle=1670
      expect(info).toEqual({ idle: 1670, total: 2000 });
    });

    it('handles single CPU', () => {
      os.cpus.mockReturnValue([
        { model: 'CPU', speed: 2400, times: { user: 50, nice: 10, sys: 20, idle: 920, irq: 0 } },
      ]);
      const info = monitor._getCPUInfo();
      expect(info).toEqual({ idle: 920, total: 1000 });
    });
  });

  // --------------------------------------------------------------------------
  // _calculateCPUPercent()
  // --------------------------------------------------------------------------

  describe('_calculateCPUPercent', () => {
    it('returns 0 when start is null', () => {
      expect(monitor._calculateCPUPercent(null, { idle: 100, total: 200 })).toBe(0);
    });

    it('returns 0 when end is null', () => {
      expect(monitor._calculateCPUPercent({ idle: 100, total: 200 }, null)).toBe(0);
    });

    it('returns 0 when both are null', () => {
      expect(monitor._calculateCPUPercent(null, null)).toBe(0);
    });

    it('returns 0 when total diff is 0', () => {
      const same = { idle: 100, total: 200 };
      expect(monitor._calculateCPUPercent(same, same)).toBe(0);
    });

    it('calculates correct percentage for normal values', () => {
      const start = { idle: 800, total: 1000 };
      const end = { idle: 850, total: 1200 };
      // idleDiff=50, totalDiff=200 → 100 - floor(100*50/200) = 100 - floor(25) = 75
      expect(monitor._calculateCPUPercent(start, end)).toBe(75);
    });

    it('clamps to minimum of 0', () => {
      const start = { idle: 0, total: 1000 };
      const end = { idle: 2000, total: 1100 };
      // idleDiff=2000, totalDiff=100 → 100 - floor(100*2000/100) = 100-2000 = -1900
      // clamped to max(0, min(100, -1900)) = 0
      expect(monitor._calculateCPUPercent(start, end)).toBe(0);
    });

    it('clamps to maximum of 100', () => {
      const start = { idle: 1000, total: 1000 };
      const end = { idle: 1000, total: 2000 };
      // idleDiff=0, totalDiff=1000 → 100 - floor(0) = 100
      // clamped to min(100, 100) = 100
      expect(monitor._calculateCPUPercent(start, end)).toBe(100);
    });
  });

  // --------------------------------------------------------------------------
  // Module export
  // --------------------------------------------------------------------------

  describe('module export', () => {
    it('exports SystemMonitor class', () => {
      expect(typeof SystemMonitor).toBe('function');
      expect(new SystemMonitor()).toBeInstanceOf(SystemMonitor);
    });
  });
});
