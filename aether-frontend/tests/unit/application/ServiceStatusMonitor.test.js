'use strict';

/**
 * ServiceStatusMonitor Unit Tests
 * ============================================================================
 * Tests service health monitoring: service registration, periodic health
 * checks via endpoint, status change events, consecutive failure tracking,
 * health summary aggregation, query methods, and resource cleanup.
 *
 * @module tests/unit/application/ServiceStatusMonitor.test
 */

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
}));

const ServiceStatusMonitor = require('../../../src/application/main/modules/services/ServiceStatusMonitor');
const { EventTypes } = require('../../../src/core/events/EventTypes');

function createMockEndpoint() {
  return {
    getHealth: jest.fn().mockResolvedValue({ status: 'ok' }),
    api: {
      get: jest.fn().mockResolvedValue({ status: 'ok' }),
    },
  };
}

function createMockEventBus() {
  return { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
}

describe('ServiceStatusMonitor', () => {
  let monitor;
  let endpoint;
  let eventBus;

  beforeEach(() => {
    jest.useFakeTimers();
    endpoint = createMockEndpoint();
    eventBus = createMockEventBus();
    monitor = new ServiceStatusMonitor({
      endpoint,
      eventBus,
      checkInterval: 5000,
      timeout: 2000,
    });
  });

  afterEach(() => {
    if (monitor) monitor.dispose();
    jest.useRealTimers();
  });

  // -----------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------
  describe('constructor', () => {
    it('throws when endpoint not provided', () => {
      expect(() => new ServiceStatusMonitor({ eventBus })).toThrow('endpoint required');
    });

    it('throws when eventBus not provided', () => {
      expect(() => new ServiceStatusMonitor({ endpoint })).toThrow('eventBus required');
    });

    it('defaults checkInterval to 30000', () => {
      const m = new ServiceStatusMonitor({ endpoint, eventBus });
      expect(m.checkInterval).toBe(30000);
      m.dispose();
    });

    it('defaults timeout to 10000', () => {
      const m = new ServiceStatusMonitor({ endpoint, eventBus });
      expect(m.timeout).toBe(10000);
      m.dispose();
    });

    it('accepts custom checkInterval and timeout', () => {
      expect(monitor.checkInterval).toBe(5000);
      expect(monitor.timeout).toBe(2000);
    });

    it('initializes with empty services map', () => {
      expect(monitor.services.size).toBe(0);
    });

    it('initializes with no interval running', () => {
      expect(monitor.intervalId).toBeNull();
    });
  });

  // -----------------------------------------------------------
  // registerService
  // -----------------------------------------------------------
  describe('registerService()', () => {
    it('adds service to services map', () => {
      monitor.registerService('backend', { name: 'Backend', url: 'http://localhost:8765', useEndpoint: true });
      expect(monitor.services.size).toBe(1);
      expect(monitor.services.has('backend')).toBe(true);
    });

    it('stores service config with defaults', () => {
      monitor.registerService('svc', { name: 'Service', port: 3000 });
      const svc = monitor.services.get('svc');
      expect(svc.key).toBe('svc');
      expect(svc.name).toBe('Service');
      expect(svc.status).toBe('unknown');
      expect(svc.lastCheck).toBeNull();
      expect(svc.lastSuccess).toBeNull();
      expect(svc.consecutiveFailures).toBe(0);
      expect(svc.useEndpoint).toBe(false);
    });

    it('registers multiple services', () => {
      monitor.registerService('a', { name: 'A' });
      monitor.registerService('b', { name: 'B' });
      monitor.registerService('c', { name: 'C' });
      expect(monitor.services.size).toBe(3);
    });
  });

  // -----------------------------------------------------------
  // start / stop
  // -----------------------------------------------------------
  describe('start()', () => {
    it('runs initial check immediately', async () => {
      monitor.registerService('backend', { name: 'Backend', useEndpoint: true });
      monitor.start();
      // checkAll is async -- let promises resolve
      await Promise.resolve();
      expect(endpoint.getHealth).toHaveBeenCalled();
    });

    it('starts periodic interval', () => {
      monitor.start();
      expect(monitor.intervalId).not.toBeNull();
    });

    it('does not double-start', () => {
      monitor.start();
      const first = monitor.intervalId;
      monitor.start();
      expect(monitor.intervalId).toBe(first);
    });
  });

  describe('stop()', () => {
    it('clears interval', () => {
      monitor.start();
      expect(monitor.intervalId).not.toBeNull();
      monitor.stop();
      expect(monitor.intervalId).toBeNull();
    });

    it('is safe to call when not started', () => {
      expect(() => monitor.stop()).not.toThrow();
    });
  });

  // -----------------------------------------------------------
  // checkService
  // -----------------------------------------------------------
  describe('checkService()', () => {
    it('marks backend service as ok when getHealth succeeds', async () => {
      monitor.registerService('backend', { name: 'Backend', useEndpoint: true });
      await monitor.checkService('backend');
      const svc = monitor.services.get('backend');
      expect(svc.status).toBe('ok');
      expect(svc.lastCheck).toBeGreaterThan(0);
      expect(svc.lastSuccess).toBeGreaterThan(0);
      expect(svc.consecutiveFailures).toBe(0);
    });

    it('marks backend service as error when getHealth fails', async () => {
      endpoint.getHealth.mockRejectedValue(new Error('connection refused'));
      monitor.registerService('backend', { name: 'Backend', useEndpoint: true });
      await monitor.checkService('backend');
      const svc = monitor.services.get('backend');
      expect(svc.status).toBe('error');
      expect(svc.consecutiveFailures).toBe(1);
    });

    it('checks non-backend service via api.get proxy', async () => {
      monitor.registerService('tts', { name: 'TTS', url: 'http://tts:9000' });
      await monitor.checkService('tts');
      expect(endpoint.api.get).toHaveBeenCalledWith(
        '/v1/api/services/tts/health',
        { timeout: 2000 }
      );
    });

    it('marks non-backend service as ok when health response has ok status', async () => {
      monitor.registerService('tts', { name: 'TTS' });
      await monitor.checkService('tts');
      const svc = monitor.services.get('tts');
      expect(svc.status).toBe('ok');
    });

    it('marks non-backend service as warn when health status is not ok', async () => {
      endpoint.api.get.mockResolvedValue({ status: 'degraded' });
      monitor.registerService('tts', { name: 'TTS' });
      await monitor.checkService('tts');
      const svc = monitor.services.get('tts');
      expect(svc.status).toBe('warn');
    });

    it('marks non-backend service as error when api.get fails', async () => {
      endpoint.api.get.mockRejectedValue(new Error('timeout'));
      monitor.registerService('tts', { name: 'TTS' });
      await monitor.checkService('tts');
      const svc = monitor.services.get('tts');
      expect(svc.status).toBe('error');
      expect(svc.consecutiveFailures).toBe(1);
    });

    it('increments consecutiveFailures on repeated failures', async () => {
      endpoint.getHealth.mockRejectedValue(new Error('fail'));
      monitor.registerService('backend', { name: 'Backend', useEndpoint: true });
      await monitor.checkService('backend');
      await monitor.checkService('backend');
      await monitor.checkService('backend');
      expect(monitor.services.get('backend').consecutiveFailures).toBe(3);
    });

    it('resets consecutiveFailures on success', async () => {
      endpoint.getHealth.mockRejectedValue(new Error('fail'));
      monitor.registerService('backend', { name: 'Backend', useEndpoint: true });
      await monitor.checkService('backend');
      await monitor.checkService('backend');
      expect(monitor.services.get('backend').consecutiveFailures).toBe(2);

      endpoint.getHealth.mockResolvedValue({ status: 'ok' });
      await monitor.checkService('backend');
      expect(monitor.services.get('backend').consecutiveFailures).toBe(0);
    });

    it('silently ignores unknown service key', async () => {
      await expect(monitor.checkService('nonexistent')).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------
  // checkAll
  // -----------------------------------------------------------
  describe('checkAll()', () => {
    it('checks all registered services', async () => {
      monitor.registerService('a', { name: 'A', useEndpoint: true });
      monitor.registerService('b', { name: 'B' });
      await monitor.checkAll();
      expect(endpoint.getHealth).toHaveBeenCalled();
      expect(endpoint.api.get).toHaveBeenCalled();
    });

    it('handles mixed success/failure gracefully', async () => {
      endpoint.getHealth.mockResolvedValue({ status: 'ok' });
      endpoint.api.get.mockRejectedValue(new Error('fail'));
      monitor.registerService('backend', { name: 'Backend', useEndpoint: true });
      monitor.registerService('tts', { name: 'TTS' });
      await monitor.checkAll();
      expect(monitor.services.get('backend').status).toBe('ok');
      expect(monitor.services.get('tts').status).toBe('error');
    });
  });

  // -----------------------------------------------------------
  // Status change events
  // -----------------------------------------------------------
  describe('status change events', () => {
    it('emits STATUS_UPDATED on status change', async () => {
      monitor.registerService('backend', { name: 'Backend', useEndpoint: true });
      await monitor.checkService('backend'); // unknown -> ok
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.SERVICE.STATUS_UPDATED,
        expect.objectContaining({
          serviceName: 'backend',
          status: 'ok',
          previousStatus: 'unknown',
        })
      );
    });

    it('emits SERVICE.ONLINE when status becomes ok', async () => {
      monitor.registerService('backend', { name: 'Backend', useEndpoint: true });
      await monitor.checkService('backend');
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.SERVICE.ONLINE,
        expect.objectContaining({ serviceName: 'backend' })
      );
    });

    it('emits SERVICE.OFFLINE when status becomes error', async () => {
      endpoint.getHealth.mockRejectedValue(new Error('down'));
      monitor.registerService('backend', { name: 'Backend', useEndpoint: true });
      await monitor.checkService('backend');
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.SERVICE.OFFLINE,
        expect.objectContaining({
          serviceName: 'backend',
          consecutiveFailures: 1,
        })
      );
    });

    it('does NOT emit when status unchanged', async () => {
      monitor.registerService('backend', { name: 'Backend', useEndpoint: true });
      await monitor.checkService('backend'); // unknown -> ok
      eventBus.emit.mockClear();
      await monitor.checkService('backend'); // ok -> ok
      const updateCalls = eventBus.emit.mock.calls.filter(
        c => c[0] === EventTypes.SERVICE.STATUS_UPDATED
      );
      expect(updateCalls).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------
  // Query methods
  // -----------------------------------------------------------
  describe('getServiceStatus()', () => {
    it('returns copy of service status', async () => {
      monitor.registerService('backend', { name: 'Backend', useEndpoint: true });
      await monitor.checkService('backend');
      const status = monitor.getServiceStatus('backend');
      expect(status.status).toBe('ok');
      expect(status.name).toBe('Backend');
      // Verify it's a copy
      status.status = 'modified';
      expect(monitor.services.get('backend').status).toBe('ok');
    });

    it('returns null for unknown service', () => {
      expect(monitor.getServiceStatus('unknown')).toBeNull();
    });
  });

  describe('getAllStatus()', () => {
    it('returns status of all services', () => {
      monitor.registerService('a', { name: 'A' });
      monitor.registerService('b', { name: 'B' });
      const all = monitor.getAllStatus();
      expect(Object.keys(all)).toEqual(['a', 'b']);
    });
  });

  describe('getServicesByStatus()', () => {
    it('filters by status', async () => {
      endpoint.getHealth.mockResolvedValue({ status: 'ok' });
      endpoint.api.get.mockRejectedValue(new Error('fail'));
      monitor.registerService('backend', { name: 'Backend', useEndpoint: true });
      monitor.registerService('tts', { name: 'TTS' });
      await monitor.checkAll();
      const ok = monitor.getServicesByStatus('ok');
      const err = monitor.getServicesByStatus('error');
      expect(ok).toHaveLength(1);
      expect(ok[0].key).toBe('backend');
      expect(err).toHaveLength(1);
      expect(err[0].key).toBe('tts');
    });
  });

  describe('isServiceHealthy()', () => {
    it('returns true for ok service', async () => {
      monitor.registerService('backend', { name: 'Backend', useEndpoint: true });
      await monitor.checkService('backend');
      expect(monitor.isServiceHealthy('backend')).toBe(true);
    });

    it('returns false for non-ok service', async () => {
      endpoint.getHealth.mockRejectedValue(new Error('fail'));
      monitor.registerService('backend', { name: 'Backend', useEndpoint: true });
      await monitor.checkService('backend');
      expect(monitor.isServiceHealthy('backend')).toBe(false);
    });

    it('returns false for unknown service', () => {
      expect(monitor.isServiceHealthy('unknown')).toBe(false);
    });
  });

  // -----------------------------------------------------------
  // Health summary
  // -----------------------------------------------------------
  describe('getHealthSummary()', () => {
    it('returns zero counts with no services', () => {
      const summary = monitor.getHealthSummary();
      expect(summary.total).toBe(0);
      expect(summary.ok).toBe(0);
      expect(summary.healthy).toBe(true); // 0 === 0
    });

    it('aggregates status counts correctly', async () => {
      endpoint.getHealth.mockResolvedValue({ status: 'ok' });
      endpoint.api.get.mockRejectedValue(new Error('fail'));
      monitor.registerService('backend', { name: 'Backend', useEndpoint: true });
      monitor.registerService('tts', { name: 'TTS' });
      monitor.registerService('unchecked', { name: 'Unchecked' });
      await monitor.checkService('backend');
      await monitor.checkService('tts');
      const summary = monitor.getHealthSummary();
      expect(summary.total).toBe(3);
      expect(summary.ok).toBe(1);
      expect(summary.error).toBe(1);
      expect(summary.unknown).toBe(1);
      expect(summary.healthy).toBe(false);
    });

    it('reports healthy when all services are ok', async () => {
      monitor.registerService('a', { name: 'A', useEndpoint: true });
      monitor.registerService('b', { name: 'B', useEndpoint: true });
      await monitor.checkAll();
      const summary = monitor.getHealthSummary();
      expect(summary.healthy).toBe(true);
      expect(summary.ok).toBe(2);
    });
  });

  // -----------------------------------------------------------
  // getStats
  // -----------------------------------------------------------
  describe('getStats()', () => {
    it('returns frozen stats object', () => {
      monitor.start();
      const stats = monitor.getStats();
      expect(Object.isFrozen(stats)).toBe(true);
      expect(stats.isMonitoring).toBe(true);
      expect(stats.checkInterval).toBe(5000);
      expect(stats.timeout).toBe(2000);
      expect(stats.serviceCount).toBe(0);
    });

    it('reflects service count', () => {
      monitor.registerService('a', { name: 'A' });
      monitor.registerService('b', { name: 'B' });
      expect(monitor.getStats().serviceCount).toBe(2);
    });
  });

  // -----------------------------------------------------------
  // dispose
  // -----------------------------------------------------------
  describe('dispose()', () => {
    it('stops monitoring, clears services, nulls refs', () => {
      monitor.registerService('a', { name: 'A' });
      monitor.start();
      monitor.dispose();
      expect(monitor.intervalId).toBeNull();
      expect(monitor.services.size).toBe(0);
      expect(monitor.endpoint).toBeNull();
      expect(monitor.eventBus).toBeNull();
    });

    it('is safe to call twice', () => {
      expect(() => {
        monitor.dispose();
        monitor.dispose();
      }).not.toThrow();
      monitor = null;
    });
  });

  // -----------------------------------------------------------
  // enableLogging branches
  // -----------------------------------------------------------
  describe('enableLogging branches', () => {
    let logMonitor;

    beforeEach(() => {
      logMonitor = new ServiceStatusMonitor({
        endpoint,
        eventBus,
        checkInterval: 5000,
        enableLogging: true,
      });
    });

    afterEach(() => {
      if (logMonitor) logMonitor.dispose();
      logMonitor = null;
    });

    it('logs on registerService', () => {
      logMonitor.registerService('svc', { name: 'Svc' });
      expect(logMonitor.services.size).toBe(1);
    });

    it('logs on start', () => {
      logMonitor.start();
      expect(logMonitor.intervalId).not.toBeNull();
    });

    it('logs on stop', () => {
      logMonitor.start();
      logMonitor.stop();
      expect(logMonitor.intervalId).toBeNull();
    });

    it('logs on _updateServiceStatus when status changes', async () => {
      logMonitor.registerService('backend', { name: 'Backend', useEndpoint: true });
      await logMonitor.checkService('backend');
      expect(logMonitor.services.get('backend').status).toBe('ok');
    });

    it('logs on dispose', () => {
      logMonitor.dispose();
      expect(logMonitor.endpoint).toBeNull();
      logMonitor = null;
    });

    it('logs warn on non-backend service health check failure', async () => {
      endpoint.api.get.mockRejectedValue(new Error('health unavailable'));
      logMonitor.registerService('tts', { name: 'TTS' });
      await logMonitor.checkService('tts');
      expect(logMonitor.services.get('tts').status).toBe('error');
    });

    it('logs warn on checkService catch', async () => {
      endpoint.getHealth.mockRejectedValue(new Error('down'));
      logMonitor.registerService('backend', { name: 'Backend', useEndpoint: true });
      await logMonitor.checkService('backend');
      expect(logMonitor.services.get('backend').consecutiveFailures).toBe(1);
    });
  });

  // -----------------------------------------------------------
  // checkAll error handling
  // -----------------------------------------------------------
  describe('checkAll error path', () => {
    it('catches errors during service iteration (enableLogging=true)', async () => {
      const m = new ServiceStatusMonitor({ endpoint, eventBus, enableLogging: true });
      m.services = { [Symbol.iterator]: () => { throw new Error('iteration boom'); } };
      await expect(m.checkAll()).resolves.toBeUndefined();
      m.services = new Map();
      m.dispose();
    });

    it('catches errors during service iteration (enableLogging=false)', async () => {
      // Default monitor has enableLogging=false
      monitor.services = { [Symbol.iterator]: () => { throw new Error('iteration boom'); } };
      await expect(monitor.checkAll()).resolves.toBeUndefined();
      monitor.services = new Map();
    });
  });

  // -----------------------------------------------------------
  // checkService edge cases
  // -----------------------------------------------------------
  describe('checkService edge cases', () => {
    it('handles null endpoint during check', async () => {
      monitor.registerService('svc', { name: 'Svc', useEndpoint: true });
      monitor.endpoint = null;
      await monitor.checkService('svc');
      expect(monitor.services.get('svc').status).toBe('error');
      expect(monitor.services.get('svc').consecutiveFailures).toBe(1);
    });

    it('handles null/undefined response from api.get', async () => {
      endpoint.api.get.mockResolvedValue(null);
      monitor.registerService('tts', { name: 'TTS' });
      await monitor.checkService('tts');
      // null response: response && response.status === 'ok' is false -> warn
      expect(monitor.services.get('tts').status).toBe('warn');
    });
  });

  // -----------------------------------------------------------
  // _updateServiceStatus edge cases
  // -----------------------------------------------------------
  describe('_updateServiceStatus edge cases', () => {
    it('silently ignores unknown service key', () => {
      expect(() => monitor._updateServiceStatus('nonexistent', 'ok')).not.toThrow();
    });

    it('emits neither ONLINE nor OFFLINE for warn status change', async () => {
      endpoint.api.get.mockResolvedValue({ status: 'degraded' });
      monitor.registerService('svc', { name: 'Svc' });
      await monitor.checkService('svc'); // unknown -> warn
      const onlineCalls = eventBus.emit.mock.calls.filter(c => c[0] === EventTypes.SERVICE.ONLINE);
      const offlineCalls = eventBus.emit.mock.calls.filter(c => c[0] === EventTypes.SERVICE.OFFLINE);
      expect(onlineCalls).toHaveLength(0);
      expect(offlineCalls).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------
  // Periodic timer invocation
  // -----------------------------------------------------------
  describe('periodic timer', () => {
    it('invokes checkAll via setInterval when timer fires', async () => {
      monitor.registerService('backend', { name: 'Backend', useEndpoint: true });
      monitor.start();
      endpoint.getHealth.mockClear();
      // Advance past checkInterval to fire the setInterval arrow
      jest.advanceTimersByTime(5000);
      // Need to let async settle
      await Promise.resolve();
      expect(endpoint.getHealth).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------
  // Constructor default parameter
  // -----------------------------------------------------------
  describe('constructor default param', () => {
    it('uses default options when called with no arguments', () => {
      expect(() => new ServiceStatusMonitor()).toThrow('endpoint required');
    });
  });

  // -----------------------------------------------------------
  // window global export
  // -----------------------------------------------------------
  describe('window global export', () => {
    it('assigns ServiceStatusMonitor to window when window is defined', () => {
      global.window = {};
      jest.isolateModules(() => {
        jest.mock('../../../src/renderer/shared/utils/logger', () => ({
          createRendererLogger: () => ({
            info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn(),
          }),
        }));
        const SSM = require('../../../src/application/main/modules/services/ServiceStatusMonitor');
        expect(global.window.ServiceStatusMonitor).toBe(SSM);
      });
      delete global.window;
    });
  });

  // -----------------------------------------------------------
  // Full lifecycle
  // -----------------------------------------------------------
  describe('full lifecycle', () => {
    it('register -> start -> checkAll -> status change -> stop -> dispose', async () => {
      monitor.registerService('backend', { name: 'Backend', useEndpoint: true });
      monitor.registerService('tts', { name: 'TTS' });
      monitor.start();

      // Initial check
      await Promise.resolve();
      expect(monitor.services.get('backend').status).toBe('ok');

      // Service goes down
      endpoint.getHealth.mockRejectedValue(new Error('crash'));
      await monitor.checkService('backend');
      expect(monitor.services.get('backend').status).toBe('error');
      expect(monitor.services.get('backend').consecutiveFailures).toBe(1);

      // Service recovers
      endpoint.getHealth.mockResolvedValue({ status: 'ok' });
      await monitor.checkService('backend');
      expect(monitor.services.get('backend').status).toBe('ok');
      expect(monitor.services.get('backend').consecutiveFailures).toBe(0);

      // Stop and dispose
      monitor.stop();
      monitor.dispose();
      expect(monitor.services.size).toBe(0);
      monitor = null;
    });
  });
});
