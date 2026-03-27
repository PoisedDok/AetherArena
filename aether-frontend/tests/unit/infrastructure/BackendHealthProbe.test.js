'use strict';

/**
 * BackendHealthProbe Unit Tests
 * ============================================================================
 * Tests the backend health probe: storage API strategy, system API strategy,
 * fallback, timeout, available strategies, and dependency updates.
 *
 * @module tests/unit/infrastructure/BackendHealthProbe.test
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock('../../../src/core/utils/logger', () => ({
  createLogger: jest.fn(() => mockLog),
}));

const { BackendHealthProbe } = require('../../../src/infrastructure/monitoring/BackendHealthProbe');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BackendHealthProbe', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('initialises with no dependencies', () => {
      const probe = new BackendHealthProbe();
      expect(probe.storageAPI).toBeNull();
      expect(probe.systemAPI).toBeNull();
    });

    it('accepts storageAPI dependency', () => {
      const storageAPI = { healthCheck: jest.fn() };
      const probe = new BackendHealthProbe({ storageAPI });
      expect(probe.storageAPI).toBe(storageAPI);
    });

    it('accepts systemAPI dependency', () => {
      const systemAPI = { getStats: jest.fn() };
      const probe = new BackendHealthProbe({ systemAPI });
      expect(probe.systemAPI).toBe(systemAPI);
    });
  });

  // =========================================================================
  // probe() - Strategy 1: storageAPI
  // =========================================================================

  describe('probe() - storageAPI strategy', () => {
    it('returns healthy when healthCheck returns ok status', async () => {
      const storageAPI = { healthCheck: jest.fn().mockResolvedValue({ status: 'ok' }) };
      const probe = new BackendHealthProbe({ storageAPI });

      const result = await probe.probe();

      expect(result.healthy).toBe(true);
      expect(result.strategy).toBe('storageAPI.healthCheck');
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('returns healthy when healthCheck returns healthy status', async () => {
      const storageAPI = { healthCheck: jest.fn().mockResolvedValue({ status: 'healthy' }) };
      const probe = new BackendHealthProbe({ storageAPI });
      const result = await probe.probe();
      expect(result.healthy).toBe(true);
    });

    it('returns healthy when healthCheck returns healthy: true', async () => {
      const storageAPI = { healthCheck: jest.fn().mockResolvedValue({ healthy: true }) };
      const probe = new BackendHealthProbe({ storageAPI });
      const result = await probe.probe();
      expect(result.healthy).toBe(true);
    });

    it('falls back to strategy 2 when healthCheck returns null', async () => {
      const storageAPI = { healthCheck: jest.fn().mockResolvedValue(null) };
      const probe = new BackendHealthProbe({ storageAPI });
      const result = await probe.probe();
      // Falls through to 'none' since no systemAPI
      expect(result.strategy).toBe('none');
      expect(result.healthy).toBe(false);
    });

    it('falls back on healthCheck error', async () => {
      const storageAPI = { healthCheck: jest.fn().mockRejectedValue(new Error('network')) };
      const probe = new BackendHealthProbe({ storageAPI });
      const result = await probe.probe();
      expect(result.strategy).toBe('none');
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('health check failed'),
        expect.any(Object)
      );
    });
  });

  // =========================================================================
  // probe() - Strategy 2: systemAPI
  // =========================================================================

  describe('probe() - systemAPI strategy', () => {
    it('returns healthy when getStats returns data', async () => {
      const systemAPI = { getStats: jest.fn().mockResolvedValue({ cpu: 50, mem: 40 }) };
      const probe = new BackendHealthProbe({ systemAPI });
      const result = await probe.probe();
      expect(result.healthy).toBe(true);
      expect(result.strategy).toBe('systemAPI.getStats');
      expect(result.stats).toEqual({ cpu: 50, mem: 40 });
    });

    it('returns unhealthy when getStats returns null', async () => {
      const systemAPI = { getStats: jest.fn().mockResolvedValue(null) };
      const probe = new BackendHealthProbe({ systemAPI });
      const result = await probe.probe();
      expect(result.strategy).toBe('none');
      expect(result.healthy).toBe(false);
    });

    it('falls back on getStats error', async () => {
      const systemAPI = { getStats: jest.fn().mockRejectedValue(new Error('fail')) };
      const probe = new BackendHealthProbe({ systemAPI });
      const result = await probe.probe();
      expect(result.strategy).toBe('none');
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('System stats probe failed'),
        expect.any(Object)
      );
    });
  });

  // =========================================================================
  // probe() - No strategies
  // =========================================================================

  describe('probe() - no strategies', () => {
    it('returns unhealthy with none strategy', async () => {
      const probe = new BackendHealthProbe();
      const result = await probe.probe();
      expect(result.healthy).toBe(false);
      expect(result.strategy).toBe('none');
      expect(result.error).toBeInstanceOf(Error);
    });
  });

  // =========================================================================
  // isHealthy()
  // =========================================================================

  describe('isHealthy()', () => {
    it('returns true when probe is healthy', async () => {
      const storageAPI = { healthCheck: jest.fn().mockResolvedValue({ status: 'ok' }) };
      const probe = new BackendHealthProbe({ storageAPI });
      expect(await probe.isHealthy()).toBe(true);
    });

    it('returns false when probe is unhealthy', async () => {
      const probe = new BackendHealthProbe();
      expect(await probe.isHealthy()).toBe(false);
    });

    it('returns false on probe exception', async () => {
      const probe = new BackendHealthProbe();
      jest.spyOn(probe, 'probe').mockRejectedValue(new Error('boom'));
      expect(await probe.isHealthy()).toBe(false);
    });
  });

  // =========================================================================
  // probeWithTimeout()
  // =========================================================================

  describe('probeWithTimeout()', () => {
    it('returns probe result within timeout', async () => {
      const storageAPI = { healthCheck: jest.fn().mockResolvedValue({ status: 'ok' }) };
      const probe = new BackendHealthProbe({ storageAPI });
      const result = await probe.probeWithTimeout(5000);
      expect(result.healthy).toBe(true);
    });

    it('returns unhealthy on timeout', async () => {
      const storageAPI = {
        healthCheck: jest.fn().mockImplementation(() => new Promise(() => {})) // never resolves
      };
      const probe = new BackendHealthProbe({ storageAPI });
      const result = await probe.probeWithTimeout(50); // 50ms timeout
      expect(result.healthy).toBe(false);
      expect(result.strategy).toBe('timeout');
      expect(result.timeout).toBe(50);
    });
  });

  // =========================================================================
  // getAvailableStrategies()
  // =========================================================================

  describe('getAvailableStrategies()', () => {
    it('returns empty when no dependencies', () => {
      const probe = new BackendHealthProbe();
      expect(probe.getAvailableStrategies()).toEqual([]);
    });

    it('includes storageAPI when available', () => {
      const probe = new BackendHealthProbe({ storageAPI: { healthCheck: jest.fn() } });
      expect(probe.getAvailableStrategies()).toContain('storageAPI.healthCheck');
    });

    it('includes systemAPI when available', () => {
      const probe = new BackendHealthProbe({ systemAPI: { getStats: jest.fn() } });
      expect(probe.getAvailableStrategies()).toContain('systemAPI.getStats');
    });

    it('includes both when both available', () => {
      const probe = new BackendHealthProbe({
        storageAPI: { healthCheck: jest.fn() },
        systemAPI: { getStats: jest.fn() }
      });
      expect(probe.getAvailableStrategies()).toHaveLength(2);
    });
  });

  // =========================================================================
  // updateDependencies()
  // =========================================================================

  describe('updateDependencies()', () => {
    it('updates storageAPI', () => {
      const probe = new BackendHealthProbe();
      const api = { healthCheck: jest.fn() };
      probe.updateDependencies({ storageAPI: api });
      expect(probe.storageAPI).toBe(api);
    });

    it('updates systemAPI', () => {
      const probe = new BackendHealthProbe();
      const api = { getStats: jest.fn() };
      probe.updateDependencies({ systemAPI: api });
      expect(probe.systemAPI).toBe(api);
    });

    it('does not clear unspecified dependencies', () => {
      const api = { healthCheck: jest.fn() };
      const probe = new BackendHealthProbe({ storageAPI: api });
      probe.updateDependencies({ systemAPI: { getStats: jest.fn() } });
      expect(probe.storageAPI).toBe(api); // unchanged
    });
  });
});
