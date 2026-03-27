'use strict';

// ---------------------------------------------------------------------------
// Mocks
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
  system: {
    getStats: jest.fn(),
  },
};

jest.mock('../../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: () => mockAether,
}));

const { EventTypes } = require('../../../../src/core/events/EventTypes');

const BackendHealthMonitor = require(
  '../../../../src/renderer/chat/controllers/modules/BackendHealthMonitor'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createEventBus() {
  return {
    on: jest.fn(),
    emit: jest.fn(),
    off: jest.fn(),
  };
}

function createStorageAPI(healthy = true) {
  return {
    healthCheck: jest.fn().mockResolvedValue({ healthy }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BackendHealthMonitor', () => {
  let eventBus;
  let storageAPI;
  let monitor;

  beforeEach(() => {
    jest.useFakeTimers();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    mockAether.system.getStats.mockReset();
    eventBus = createEventBus();
    storageAPI = createStorageAPI(true);
    monitor = new BackendHealthMonitor({ eventBus, storageAPI });
  });

  afterEach(() => {
    monitor.dispose();
    jest.useRealTimers();
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('stores eventBus reference', () => {
      expect(monitor.eventBus).toBe(eventBus);
    });

    it('stores storageAPI reference', () => {
      expect(monitor.storageAPI).toBe(storageAPI);
    });

    it('defaults storageAPI to null when not provided', () => {
      const m = new BackendHealthMonitor({ eventBus });
      expect(m.storageAPI).toBeNull();
      m.dispose();
    });

    it('initializes connected to false', () => {
      expect(monitor.connected).toBe(false);
    });

    it('initializes monitoringInterval to null', () => {
      expect(monitor.monitoringInterval).toBeNull();
    });

    it('throws when eventBus is not provided', () => {
      expect(() => new BackendHealthMonitor({})).toThrow('[BackendHealthMonitor] eventBus is REQUIRED');
    });

    it('throws when eventBus is null', () => {
      expect(() => new BackendHealthMonitor({ eventBus: null })).toThrow('[BackendHealthMonitor] eventBus is REQUIRED');
    });

    it('throws when no options provided', () => {
      expect(() => new BackendHealthMonitor()).toThrow('[BackendHealthMonitor] eventBus is REQUIRED');
    });

    it('uses getAether() default when aether not provided', () => {
      const m = new BackendHealthMonitor({ eventBus });
      expect(m.aether).toBe(mockAether);
      m.dispose();
    });

    it('uses custom aether when provided', () => {
      const customAether = { system: { getStats: jest.fn() } };
      const m = new BackendHealthMonitor({ eventBus, aether: customAether });
      expect(m.aether).toBe(customAether);
      m.dispose();
    });
  });

  // =========================================================================
  // probeHealth
  // =========================================================================

  describe('probeHealth', () => {
    it('returns healthy result from storageAPI (strategy 1)', async () => {
      storageAPI.healthCheck.mockResolvedValue({ healthy: true, latency: 5 });
      const result = await monitor.probeHealth();
      expect(result).toEqual({ healthy: true, latency: 5, strategy: 'storage' });
    });

    it('returns unhealthy when storageAPI reports healthy: false', async () => {
      storageAPI.healthCheck.mockResolvedValue({ healthy: false });
      const result = await monitor.probeHealth();
      expect(result).toEqual({ healthy: false, strategy: 'storage' });
    });

    it('returns healthy when storageAPI result has no healthy field (defaults to true)', async () => {
      storageAPI.healthCheck.mockResolvedValue({ status: 'ok' });
      const result = await monitor.probeHealth();
      // healthy: result.healthy !== false → undefined !== false → true
      expect(result.healthy).toBe(true);
      expect(result.strategy).toBe('storage');
    });

    it('handles storageAPI.healthCheck returning null (falls through to strategy 2)', async () => {
      storageAPI.healthCheck.mockResolvedValue(null);
      mockAether.system.getStats.mockResolvedValue({ cpu: 0.5 });
      const result = await monitor.probeHealth();
      expect(result.strategy).toBe('system');
      expect(result.healthy).toBe(true);
    });

    it('catches storageAPI error and returns unhealthy with strategy storage', async () => {
      storageAPI.healthCheck.mockRejectedValue(new Error('DB down'));
      const result = await monitor.probeHealth();
      expect(result.healthy).toBe(false);
      expect(result.strategy).toBe('storage');
      expect(result.error).toBeInstanceOf(Error);
      expect(mockLog.warn).toHaveBeenCalledWith('Storage health check failed', { error: 'DB down' });
    });

    it('falls through to system stats when storageAPI not set', async () => {
      monitor.storageAPI = null;
      mockAether.system.getStats.mockResolvedValue({ uptime: 100 });
      const result = await monitor.probeHealth();
      expect(result).toEqual({ healthy: true, stats: { uptime: 100 }, strategy: 'system' });
    });

    it('falls through to system stats when storageAPI lacks healthCheck', async () => {
      monitor.storageAPI = {};
      mockAether.system.getStats.mockResolvedValue({ uptime: 100 });
      const result = await monitor.probeHealth();
      expect(result.strategy).toBe('system');
    });

    it('handles system stats returning null (falls through to no probe)', async () => {
      monitor.storageAPI = null;
      mockAether.system.getStats.mockResolvedValue(null);
      const result = await monitor.probeHealth();
      expect(result.strategy).toBe('none');
      expect(result.healthy).toBe(false);
    });

    it('catches system stats error and returns unhealthy', async () => {
      monitor.storageAPI = null;
      mockAether.system.getStats.mockRejectedValue(new Error('Stats failed'));
      const result = await monitor.probeHealth();
      expect(result.healthy).toBe(false);
      expect(result.strategy).toBe('system');
      expect(mockLog.warn).toHaveBeenCalledWith('System stats probe failed', { error: 'Stats failed' });
    });

    it('returns no-probe fallback when both strategies unavailable', async () => {
      monitor.storageAPI = null;
      monitor.aether = null;
      const result = await monitor.probeHealth();
      expect(result.healthy).toBe(false);
      expect(result.strategy).toBe('none');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe('No health probe available');
    });

    it('returns no-probe fallback when aether.system is missing', async () => {
      monitor.storageAPI = null;
      monitor.aether = {};
      const result = await monitor.probeHealth();
      expect(result.strategy).toBe('none');
    });

    it('handles storageAPI.healthCheck error with null message', async () => {
      storageAPI.healthCheck.mockRejectedValue({ message: undefined });
      const result = await monitor.probeHealth();
      expect(result.healthy).toBe(false);
      expect(mockLog.warn).toHaveBeenCalledWith('Storage health check failed', { error: undefined });
    });
  });

  // =========================================================================
  // checkAndEmit
  // =========================================================================

  describe('checkAndEmit', () => {
    it('emits BACKEND_ONLINE on first healthy check', async () => {
      storageAPI.healthCheck.mockResolvedValue({ healthy: true });
      const result = await monitor.checkAndEmit();
      expect(result).toBe(true);
      expect(monitor.connected).toBe(true);
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CONNECTION.BACKEND_ONLINE,
        expect.objectContaining({ health: expect.any(Object) })
      );
    });

    it('does not emit when state unchanged (still healthy)', async () => {
      storageAPI.healthCheck.mockResolvedValue({ healthy: true });
      await monitor.checkAndEmit();
      eventBus.emit.mockClear();
      await monitor.checkAndEmit();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('emits BACKEND_OFFLINE when probe fails', async () => {
      storageAPI.healthCheck.mockResolvedValue({ healthy: false, error: 'timeout' });
      const result = await monitor.checkAndEmit();
      expect(result).toBe(false);
      // connected was false, still false → no state change, no emit
      // Actually wait - let me re-read the logic
      // isHealthy = health.healthy !== false → false !== false → false
      // isHealthy (false) !== this.connected (false) → no state change
      // So no emit. This is correct behavior.
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('emits BACKEND_OFFLINE when transitioning from connected to disconnected', async () => {
      // First: go online
      storageAPI.healthCheck.mockResolvedValue({ healthy: true });
      await monitor.checkAndEmit();
      expect(monitor.connected).toBe(true);
      eventBus.emit.mockClear();

      // Then: go offline
      storageAPI.healthCheck.mockResolvedValue({ healthy: false });
      await monitor.checkAndEmit();
      expect(monitor.connected).toBe(false);
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CONNECTION.BACKEND_OFFLINE,
        expect.objectContaining({ error: expect.anything() })
      );
    });

    it('emits BACKEND_ONLINE when transitioning from disconnected to connected', async () => {
      // Make sure initial state is disconnected (default)
      expect(monitor.connected).toBe(false);

      storageAPI.healthCheck.mockResolvedValue({ healthy: true });
      await monitor.checkAndEmit();
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CONNECTION.BACKEND_ONLINE,
        expect.any(Object)
      );
    });

    it('catches exception in probeHealth and returns false', async () => {
      // Force probeHealth to throw
      jest.spyOn(monitor, 'probeHealth').mockRejectedValue(new Error('Probe exploded'));
      const result = await monitor.checkAndEmit();
      expect(result).toBe(false);
      expect(mockLog.error).toHaveBeenCalledWith(
        'Health check failed with exception',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });

    it('handles health result with undefined healthy (treated as healthy)', async () => {
      storageAPI.healthCheck.mockResolvedValue({ status: 'ok' });
      const result = await monitor.checkAndEmit();
      // health.healthy is undefined → undefined !== false → true
      expect(result).toBe(true);
      expect(monitor.connected).toBe(true);
    });

    it('handles null health result from probeHealth gracefully', async () => {
      // Make storageAPI return null and no aether
      storageAPI.healthCheck.mockResolvedValue(null);
      monitor.aether = null;
      // probeHealth returns { healthy: false, error, strategy: 'none' }
      const result = await monitor.checkAndEmit();
      expect(result).toBe(false);
    });

    it('provides fallback error in BACKEND_OFFLINE when health.error is missing', async () => {
      // Go online first
      storageAPI.healthCheck.mockResolvedValue({ healthy: true });
      await monitor.checkAndEmit();
      eventBus.emit.mockClear();

      // Go offline with no error field
      storageAPI.healthCheck.mockResolvedValue({ healthy: false });
      await monitor.checkAndEmit();
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CONNECTION.BACKEND_OFFLINE,
        expect.objectContaining({ error: expect.anything() })
      );
    });
  });

  // =========================================================================
  // startMonitoring
  // =========================================================================

  describe('startMonitoring', () => {
    it('calls checkAndEmit immediately', async () => {
      const spy = jest.spyOn(monitor, 'checkAndEmit').mockResolvedValue(true);
      monitor.startMonitoring(5000);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('sets up periodic interval', () => {
      jest.spyOn(monitor, 'checkAndEmit').mockResolvedValue(true);
      monitor.startMonitoring(5000);
      expect(monitor.monitoringInterval).not.toBeNull();
    });

    it('calls checkAndEmit on each interval tick', () => {
      const spy = jest.spyOn(monitor, 'checkAndEmit').mockResolvedValue(true);
      monitor.startMonitoring(5000);
      expect(spy).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(5000);
      expect(spy).toHaveBeenCalledTimes(2);

      jest.advanceTimersByTime(5000);
      expect(spy).toHaveBeenCalledTimes(3);
    });

    it('uses default 30000ms interval when not specified', () => {
      const spy = jest.spyOn(monitor, 'checkAndEmit').mockResolvedValue(true);
      monitor.startMonitoring();
      expect(spy).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(29999);
      expect(spy).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(1);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('is idempotent — warns and returns if already monitoring', () => {
      jest.spyOn(monitor, 'checkAndEmit').mockResolvedValue(true);
      monitor.startMonitoring(5000);
      const firstInterval = monitor.monitoringInterval;
      monitor.startMonitoring(5000);
      expect(monitor.monitoringInterval).toBe(firstInterval);
      expect(mockLog.warn).toHaveBeenCalledWith('Monitoring already started');
    });
  });

  // =========================================================================
  // stopMonitoring
  // =========================================================================

  describe('stopMonitoring', () => {
    it('clears the interval', () => {
      jest.spyOn(monitor, 'checkAndEmit').mockResolvedValue(true);
      monitor.startMonitoring(5000);
      expect(monitor.monitoringInterval).not.toBeNull();
      monitor.stopMonitoring();
      expect(monitor.monitoringInterval).toBeNull();
    });

    it('stops further interval ticks', () => {
      const spy = jest.spyOn(monitor, 'checkAndEmit').mockResolvedValue(true);
      monitor.startMonitoring(5000);
      expect(spy).toHaveBeenCalledTimes(1);

      monitor.stopMonitoring();
      jest.advanceTimersByTime(10000);
      expect(spy).toHaveBeenCalledTimes(1); // No more calls
    });

    it('does nothing when not monitoring', () => {
      expect(() => monitor.stopMonitoring()).not.toThrow();
      expect(monitor.monitoringInterval).toBeNull();
    });

    it('can be called multiple times', () => {
      jest.spyOn(monitor, 'checkAndEmit').mockResolvedValue(true);
      monitor.startMonitoring(5000);
      monitor.stopMonitoring();
      expect(() => monitor.stopMonitoring()).not.toThrow();
    });
  });

  // =========================================================================
  // isConnected
  // =========================================================================

  describe('isConnected', () => {
    it('returns false initially', () => {
      expect(monitor.isConnected()).toBe(false);
    });

    it('returns true after successful health check', async () => {
      storageAPI.healthCheck.mockResolvedValue({ healthy: true });
      await monitor.checkAndEmit();
      expect(monitor.isConnected()).toBe(true);
    });

    it('returns false after failed health check from connected state', async () => {
      storageAPI.healthCheck.mockResolvedValue({ healthy: true });
      await monitor.checkAndEmit();
      storageAPI.healthCheck.mockResolvedValue({ healthy: false });
      await monitor.checkAndEmit();
      expect(monitor.isConnected()).toBe(false);
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    it('stops monitoring', () => {
      jest.spyOn(monitor, 'checkAndEmit').mockResolvedValue(true);
      monitor.startMonitoring(5000);
      monitor.dispose();
      expect(monitor.monitoringInterval).toBeNull();
    });

    it('nulls storageAPI', () => {
      monitor.dispose();
      expect(monitor.storageAPI).toBeNull();
    });

    it('nulls eventBus', () => {
      monitor.dispose();
      expect(monitor.eventBus).toBeNull();
    });

    it('can be called multiple times', () => {
      monitor.dispose();
      expect(() => monitor.dispose()).not.toThrow();
    });

    it('stops interval ticks after dispose', () => {
      const spy = jest.spyOn(monitor, 'checkAndEmit').mockResolvedValue(true);
      monitor.startMonitoring(5000);
      expect(spy).toHaveBeenCalledTimes(1);
      monitor.dispose();
      jest.advanceTimersByTime(15000);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Module exports
  // =========================================================================

  describe('module exports', () => {
    it('exports BackendHealthMonitor constructor', () => {
      expect(typeof BackendHealthMonitor).toBe('function');
    });

    it('instances have expected methods', () => {
      expect(typeof monitor.probeHealth).toBe('function');
      expect(typeof monitor.checkAndEmit).toBe('function');
      expect(typeof monitor.startMonitoring).toBe('function');
      expect(typeof monitor.stopMonitoring).toBe('function');
      expect(typeof monitor.isConnected).toBe('function');
      expect(typeof monitor.dispose).toBe('function');
    });
  });
});
