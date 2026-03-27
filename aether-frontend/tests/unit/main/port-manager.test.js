'use strict';

jest.mock('../../../src/core/config/defaults', () => ({
  backend: { baseUrl: 'http://127.0.0.1:8765' },
  endpoints: Object.freeze({ health: '/v1/health' }),
}));

const EventEmitter = require('events');
const net = require('net');
const http = require('http');
const https = require('https');
const {
  PortManager,
  getManager,
  createManager,
  PORT_RANGES,
  HEALTH_ENDPOINTS,
  HEALTH_CHECK_TIMEOUT,
} = require('../../../src/main/services/PortManager');

// Helpers
function makeMockServer() {
  const server = new EventEmitter();
  server.listen = jest.fn();
  server.close = jest.fn();
  return server;
}

function makeMockRequest() {
  const req = new EventEmitter();
  req.destroy = jest.fn();
  return req;
}

describe('PortManager', () => {
  let manager;
  let consoleLogs;

  beforeEach(() => {
    consoleLogs = {
      log: jest.spyOn(console, 'log').mockImplementation(),
      warn: jest.spyOn(console, 'warn').mockImplementation(),
      error: jest.spyOn(console, 'error').mockImplementation(),
    };
    manager = new PortManager();
  });

  afterEach(() => {
    consoleLogs.log.mockRestore();
    consoleLogs.warn.mockRestore();
    consoleLogs.error.mockRestore();
    jest.restoreAllMocks();
  });

  // Constructor
  describe('constructor', () => {
    it('uses default options', () => {
      expect(manager.options.healthCheckTimeout).toBe(10000);
      expect(manager.options.maxConcurrentChecks).toBe(10);
      expect(manager.options.protocol).toBe('http');
      expect(manager.options.host).toBe('127.0.0.1');
    });

    it('accepts custom options', () => {
      const m = new PortManager({ healthCheckTimeout: 5000, maxConcurrentChecks: 5, protocol: 'https', host: 'localhost' });
      expect(m.options.healthCheckTimeout).toBe(5000);
      expect(m.options.maxConcurrentChecks).toBe(5);
      expect(m.options.protocol).toBe('https');
      expect(m.options.host).toBe('localhost');
    });

    it('merges custom portRanges', () => {
      const m = new PortManager({ portRanges: { custom: { start: 9000, end: 9010 } } });
      expect(m.options.portRanges.backend).toEqual(PORT_RANGES.backend);
      expect(m.options.portRanges.custom).toEqual({ start: 9000, end: 9010 });
    });

    it('merges custom healthEndpoints', () => {
      const m = new PortManager({ healthEndpoints: { custom: '/health' } });
      expect(m.options.healthEndpoints.backend).toBe('/v1/health');
      expect(m.options.healthEndpoints.custom).toBe('/health');
    });

    it('initializes empty services and allocatedPorts', () => {
      expect(manager.services.size).toBe(0);
      expect(manager.allocatedPorts.size).toBe(0);
    });

    it('logger.info writes to console.log', () => {
      manager.logger.info('test');
      expect(consoleLogs.log).toHaveBeenCalledWith('[PortManager:INFO]', 'test');
    });

    it('logger.warn writes to console.warn', () => {
      manager.logger.warn('test');
      expect(consoleLogs.warn).toHaveBeenCalledWith('[PortManager:WARN]', 'test');
    });

    it('logger.error writes to console.error', () => {
      manager.logger.error('test');
      expect(consoleLogs.error).toHaveBeenCalledWith('[PortManager:ERROR]', 'test');
    });

    it('logger.debug writes only when DEBUG is set', () => {
      const orig = process.env.DEBUG;
      delete process.env.DEBUG;
      manager.logger.debug('hidden');
      expect(consoleLogs.log).not.toHaveBeenCalledWith(expect.stringContaining('DEBUG'), 'hidden');
      process.env.DEBUG = '1';
      manager.logger.debug('shown');
      expect(consoleLogs.log).toHaveBeenCalledWith('[PortManager:DEBUG]', 'shown');
      if (orig === undefined) delete process.env.DEBUG; else process.env.DEBUG = orig;
    });
  });

  // _buildServiceUrl
  describe('_buildServiceUrl', () => {
    it('builds http URL', () => {
      expect(manager._buildServiceUrl(8765)).toBe('http://127.0.0.1:8765');
    });

    it('builds https URL', () => {
      const m = new PortManager({ protocol: 'https', host: 'example.com' });
      expect(m._buildServiceUrl(443)).toBe('https://example.com:443');
    });
  });

  // isPortAvailable — spy on net.createServer per test
  describe('isPortAvailable', () => {
    let netSpy;

    beforeEach(() => {
      netSpy = jest.spyOn(net, 'createServer');
    });

    afterEach(() => {
      netSpy.mockRestore();
    });

    it('returns true when port is available', async () => {
      netSpy.mockImplementationOnce(() => {
        const s = makeMockServer();
        process.nextTick(() => s.emit('listening'));
        return s;
      });
      expect(await manager.isPortAvailable(8765)).toBe(true);
    });

    it('calls listen with port and 127.0.0.1', async () => {
      let captured;
      netSpy.mockImplementationOnce(() => {
        captured = makeMockServer();
        process.nextTick(() => captured.emit('listening'));
        return captured;
      });
      await manager.isPortAvailable(9999);
      expect(captured.listen).toHaveBeenCalledWith(9999, '127.0.0.1');
      expect(captured.close).toHaveBeenCalled();
    });

    it('returns false for EADDRINUSE', async () => {
      netSpy.mockImplementationOnce(() => {
        const s = makeMockServer();
        process.nextTick(() => { const e = new Error(); e.code = 'EADDRINUSE'; s.emit('error', e); });
        return s;
      });
      expect(await manager.isPortAvailable(8765)).toBe(false);
    });

    it('returns false for EACCES', async () => {
      netSpy.mockImplementationOnce(() => {
        const s = makeMockServer();
        process.nextTick(() => { const e = new Error(); e.code = 'EACCES'; s.emit('error', e); });
        return s;
      });
      expect(await manager.isPortAvailable(80)).toBe(false);
    });

    it('returns false for other errors', async () => {
      netSpy.mockImplementationOnce(() => {
        const s = makeMockServer();
        process.nextTick(() => { const e = new Error(); e.code = 'ENOTFOUND'; s.emit('error', e); });
        return s;
      });
      expect(await manager.isPortAvailable(8765)).toBe(false);
    });
  });

  // findAvailablePort — mock isPortAvailable directly
  describe('findAvailablePort', () => {
    it('returns first available port', async () => {
      jest.spyOn(manager, 'isPortAvailable')
        .mockResolvedValueOnce(false) // 8765 busy
        .mockResolvedValueOnce(true); // 8766 available
      expect(await manager.findAvailablePort(8765, 8770)).toBe(8766);
    });

    it('excludes specified ports', async () => {
      jest.spyOn(manager, 'isPortAvailable').mockResolvedValueOnce(true);
      expect(await manager.findAvailablePort(8765, 8770, [8765])).toBe(8766);
    });

    it('excludes allocated ports', async () => {
      manager.allocatedPorts.add(8765);
      manager.allocatedPorts.add(8766);
      jest.spyOn(manager, 'isPortAvailable').mockResolvedValueOnce(true);
      expect(await manager.findAvailablePort(8765, 8770)).toBe(8767);
    });

    it('returns null when no port available', async () => {
      jest.spyOn(manager, 'isPortAvailable').mockResolvedValue(false);
      expect(await manager.findAvailablePort(8765, 8767)).toBeNull();
    });
  });

  // findServicePort
  describe('findServicePort', () => {
    it('returns available port and allocates it', async () => {
      jest.spyOn(manager, 'findAvailablePort').mockResolvedValue(8765);
      const port = await manager.findServicePort('backend');
      expect(port).toBe(8765);
      expect(manager.allocatedPorts.has(8765)).toBe(true);
    });

    it('returns null for unknown service', async () => {
      expect(await manager.findServicePort('nonexistent')).toBeNull();
    });

    it('does not allocate null when no port found', async () => {
      jest.spyOn(manager, 'findAvailablePort').mockResolvedValue(null);
      expect(await manager.findServicePort('backend')).toBeNull();
      expect(manager.allocatedPorts.size).toBe(0);
    });
  });

  // checkServiceHealth — spy on http.get per test
  describe('checkServiceHealth', () => {
    let httpSpy;

    beforeEach(() => {
      httpSpy = jest.spyOn(http, 'get');
    });

    afterEach(() => {
      httpSpy.mockRestore();
    });

    it('returns true for 200', async () => {
      httpSpy.mockImplementationOnce((_url, _opts, cb) => {
        const res = new EventEmitter(); res.statusCode = 200; res.resume = jest.fn();
        process.nextTick(() => cb(res));
        return makeMockRequest();
      });
      expect(await manager.checkServiceHealth('http://127.0.0.1:8765', '/v1/health')).toBe(true);
    });

    it('returns true for 301', async () => {
      httpSpy.mockImplementationOnce((_url, _opts, cb) => {
        const res = new EventEmitter(); res.statusCode = 301; res.resume = jest.fn();
        process.nextTick(() => cb(res));
        return makeMockRequest();
      });
      expect(await manager.checkServiceHealth('http://127.0.0.1:8765', '/v1/health')).toBe(true);
    });

    it('returns false for 404', async () => {
      httpSpy.mockImplementationOnce((_url, _opts, cb) => {
        const res = new EventEmitter(); res.statusCode = 404; res.resume = jest.fn();
        process.nextTick(() => cb(res));
        return makeMockRequest();
      });
      expect(await manager.checkServiceHealth('http://127.0.0.1:8765', '/v1/health')).toBe(false);
    });

    it('returns false for 500', async () => {
      httpSpy.mockImplementationOnce((_url, _opts, cb) => {
        const res = new EventEmitter(); res.statusCode = 500; res.resume = jest.fn();
        process.nextTick(() => cb(res));
        return makeMockRequest();
      });
      expect(await manager.checkServiceHealth('http://127.0.0.1:8765', '/v1/health')).toBe(false);
    });

    it('returns false on request error', async () => {
      httpSpy.mockImplementationOnce((_url, _opts, _cb) => {
        const req = makeMockRequest();
        process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')));
        return req;
      });
      expect(await manager.checkServiceHealth('http://127.0.0.1:8765', '/v1/health')).toBe(false);
    });

    it('returns false on timeout and destroys request', async () => {
      let capturedReq;
      httpSpy.mockImplementationOnce((_url, _opts, _cb) => {
        capturedReq = makeMockRequest();
        process.nextTick(() => capturedReq.emit('timeout'));
        return capturedReq;
      });
      expect(await manager.checkServiceHealth('http://127.0.0.1:8765', '/v1/health')).toBe(false);
      expect(capturedReq.destroy).toHaveBeenCalled();
    });

    it('returns false when http.get throws', async () => {
      httpSpy.mockImplementationOnce(() => { throw new Error('invalid'); });
      expect(await manager.checkServiceHealth('http://127.0.0.1:8765', '/v1/health')).toBe(false);
    });

    it('uses https for https URLs', async () => {
      const httpsSpy = jest.spyOn(https, 'get').mockImplementationOnce((_url, _opts, cb) => {
        const res = new EventEmitter(); res.statusCode = 200; res.resume = jest.fn();
        process.nextTick(() => cb(res));
        return makeMockRequest();
      });
      const m = new PortManager({ protocol: 'https' });
      expect(await m.checkServiceHealth('https://127.0.0.1:8765', '/v1/health')).toBe(true);
      expect(httpsSpy).toHaveBeenCalled();
      httpsSpy.mockRestore();
    });

    it('drains response via res.resume()', async () => {
      let capturedRes;
      httpSpy.mockImplementationOnce((_url, _opts, cb) => {
        capturedRes = new EventEmitter(); capturedRes.statusCode = 200; capturedRes.resume = jest.fn();
        process.nextTick(() => cb(capturedRes));
        return makeMockRequest();
      });
      await manager.checkServiceHealth('http://127.0.0.1:8765', '/v1/health');
      expect(capturedRes.resume).toHaveBeenCalled();
    });

    it('resolves false when overall timeout fires', async () => {
      jest.useFakeTimers();
      httpSpy.mockImplementationOnce(() => makeMockRequest()); // never calls back
      const promise = manager.checkServiceHealth('http://127.0.0.1:8765', '/v1/health');
      jest.advanceTimersByTime(HEALTH_CHECK_TIMEOUT + 100);
      expect(await promise).toBe(false);
      jest.useRealTimers();
    });
  });

  // discoverService — mock checkServiceHealth
  describe('discoverService', () => {
    let healthSpy;

    beforeEach(() => {
      healthSpy = jest.spyOn(manager, 'checkServiceHealth');
    });

    it('returns null for unknown service', async () => {
      expect(await manager.discoverService('unknown')).toBeNull();
    });

    it('discovers healthy service on first port', async () => {
      healthSpy.mockResolvedValueOnce(true);
      expect(await manager.discoverService('backend')).toEqual({
        port: 8765, url: 'http://127.0.0.1:8765', healthy: true,
      });
    });

    it('discovers service on later port', async () => {
      const m = new PortManager({
        portRanges: { test: { start: 9000, end: 9002 } },
        healthEndpoints: { test: '/health' },
      });
      jest.spyOn(m, 'checkServiceHealth')
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      expect(await m.discoverService('test')).toEqual({
        port: 9002, url: 'http://127.0.0.1:9002', healthy: true,
      });
    });

    it('returns null when all ports unhealthy', async () => {
      healthSpy.mockResolvedValue(false);
      expect(await manager.discoverService('backend')).toBeNull();
    });

    it('uses DEFAULTS health endpoint when service has none', async () => {
      const m = new PortManager({ portRanges: { custom: { start: 5000, end: 5000 } } });
      const spy = jest.spyOn(m, 'checkServiceHealth').mockResolvedValueOnce(true);
      await m.discoverService('custom');
      expect(spy).toHaveBeenCalledWith('http://127.0.0.1:5000', '/v1/health');
    });

    it('processes ports in batches', async () => {
      const m = new PortManager({
        portRanges: { test: { start: 9000, end: 9024 } },
        maxConcurrentChecks: 10,
      });
      const spy = jest.spyOn(m, 'checkServiceHealth').mockResolvedValue(false);
      await m.discoverService('test');
      expect(spy).toHaveBeenCalledTimes(25);
    });
  });

  // registerService / getService
  describe('registerService', () => {
    it('adds service with correct fields', () => {
      manager.registerService('backend', 8765, true);
      expect(manager.services.get('backend')).toEqual({
        port: 8765, url: 'http://127.0.0.1:8765', healthy: true, lastCheck: expect.any(Number),
      });
    });

    it('defaults healthy to false', () => {
      manager.registerService('backend', 8765);
      expect(manager.services.get('backend').healthy).toBe(false);
    });
  });

  describe('getService', () => {
    it('returns registered service', () => {
      manager.registerService('backend', 8765, true);
      expect(manager.getService('backend').port).toBe(8765);
    });

    it('returns null for unregistered', () => {
      expect(manager.getService('nonexistent')).toBeNull();
    });
  });

  // updateServiceHealth
  describe('updateServiceHealth', () => {
    it('updates health and lastCheck', () => {
      manager.registerService('backend', 8765, false);
      manager.updateServiceHealth('backend', true);
      expect(manager.services.get('backend').healthy).toBe(true);
    });

    it('does nothing for unregistered service', () => {
      manager.updateServiceHealth('nonexistent', true);
      expect(manager.services.size).toBe(0);
    });
  });

  // getServiceStatus
  describe('getServiceStatus', () => {
    it('returns discovered status for registered services', () => {
      manager.registerService('backend', 8765, true);
      const s = manager.getServiceStatus().find(x => x.name === 'backend');
      expect(s.status).toBe('discovered');
      expect(s.healthy).toBe(true);
    });

    it('returns not_running for unregistered services', () => {
      const s = manager.getServiceStatus().find(x => x.name === 'backend');
      expect(s.status).toBe('not_running');
      expect(s.healthy).toBe(false);
      expect(s.lastCheck).toBeNull();
    });

    it('includes all configured port ranges', () => {
      const names = manager.getServiceStatus().map(s => s.name);
      expect(names).toContain('backend');
      expect(names).toContain('perplexica');
    });

    it('shows perplexica with correct default port', () => {
      const p = manager.getServiceStatus().find(x => x.name === 'perplexica');
      expect(p.port).toBe(3000);
    });
  });

  // discoverAllServices — mock discoverService
  describe('discoverAllServices', () => {
    it('discovers and registers healthy services', async () => {
      jest.spyOn(manager, 'discoverService')
        .mockResolvedValueOnce({ port: 8765, url: 'http://127.0.0.1:8765', healthy: true })
        .mockResolvedValueOnce(null);

      const result = await manager.discoverAllServices();
      expect(result).toBeInstanceOf(Map);
      expect(manager.services.has('backend')).toBe(true);
    });

    it('returns empty map when none discovered', async () => {
      jest.spyOn(manager, 'discoverService').mockResolvedValue(null);
      const result = await manager.discoverAllServices();
      expect(result.size).toBe(0);
    });

    it('logs discovery counts', async () => {
      jest.spyOn(manager, 'discoverService')
        .mockResolvedValueOnce({ port: 8765, url: 'http://127.0.0.1:8765', healthy: true })
        .mockResolvedValueOnce(null);

      await manager.discoverAllServices();
      expect(consoleLogs.log).toHaveBeenCalledWith(
        '[PortManager:INFO]', 'Service discovery complete',
        expect.objectContaining({ total: 2, discovered: 1 }),
      );
    });
  });

  // getServiceUrl
  describe('getServiceUrl', () => {
    it('returns discovered URL for healthy service', () => {
      manager.registerService('backend', 8766, true);
      expect(manager.getServiceUrl('backend', 'http://fallback')).toBe('http://127.0.0.1:8766');
    });

    it('returns defaultUrl for unhealthy service', () => {
      manager.registerService('backend', 8766, false);
      expect(manager.getServiceUrl('backend', 'http://fallback')).toBe('http://fallback');
    });

    it('returns defaultUrl for unregistered service', () => {
      expect(manager.getServiceUrl('unknown', 'http://fallback')).toBe('http://fallback');
    });
  });

  // releasePort / clearRegistry
  describe('releasePort', () => {
    it('removes port from allocated set', () => {
      manager.allocatedPorts.add(8765);
      manager.releasePort(8765);
      expect(manager.allocatedPorts.has(8765)).toBe(false);
    });

    it('is safe on unallocated port', () => {
      expect(() => manager.releasePort(9999)).not.toThrow();
    });
  });

  describe('clearRegistry', () => {
    it('clears services and allocatedPorts', () => {
      manager.registerService('backend', 8765, true);
      manager.allocatedPorts.add(8765);
      manager.clearRegistry();
      expect(manager.services.size).toBe(0);
      expect(manager.allocatedPorts.size).toBe(0);
    });
  });

  // getHealthyServices
  describe('getHealthyServices', () => {
    it('returns only healthy services', () => {
      manager.registerService('backend', 8765, true);
      manager.registerService('perplexica', 3000, false);
      const healthy = manager.getHealthyServices();
      expect(healthy).toHaveLength(1);
      expect(healthy[0].name).toBe('backend');
    });

    it('returns empty when none healthy', () => {
      manager.registerService('backend', 8765, false);
      expect(manager.getHealthyServices()).toEqual([]);
    });

    it('returns empty when no services', () => {
      expect(manager.getHealthyServices()).toEqual([]);
    });
  });

  // startHealthMonitoring — mock checkServiceHealth, use fake timers
  describe('startHealthMonitoring', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('returns a stop function', () => {
      const stop = manager.startHealthMonitoring(5000);
      expect(typeof stop).toBe('function');
      stop();
    });

    it('runs initial health check immediately', async () => {
      manager.registerService('backend', 8765, true);
      const spy = jest.spyOn(manager, 'checkServiceHealth').mockResolvedValue(true);

      const stop = manager.startHealthMonitoring(60000);
      await jest.advanceTimersByTimeAsync(0);
      expect(spy).toHaveBeenCalledTimes(1);
      stop();
    });

    it('runs periodic checks', async () => {
      manager.registerService('backend', 8765, true);
      const spy = jest.spyOn(manager, 'checkServiceHealth').mockResolvedValue(true);

      const stop = manager.startHealthMonitoring(10000);
      await jest.advanceTimersByTimeAsync(0);
      expect(spy).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(10000);
      expect(spy).toHaveBeenCalledTimes(2);

      await jest.advanceTimersByTimeAsync(10000);
      expect(spy).toHaveBeenCalledTimes(3);
      stop();
    });

    it('stops checks when stop is called', async () => {
      manager.registerService('backend', 8765, true);
      const spy = jest.spyOn(manager, 'checkServiceHealth').mockResolvedValue(true);

      const stop = manager.startHealthMonitoring(10000);
      await jest.advanceTimersByTimeAsync(0);
      stop();

      await jest.advanceTimersByTimeAsync(10000);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('updates health on status change', async () => {
      manager.registerService('backend', 8765, true);
      jest.spyOn(manager, 'checkServiceHealth')
        .mockResolvedValueOnce(true)  // initial
        .mockResolvedValueOnce(false); // interval

      const stop = manager.startHealthMonitoring(10000);
      await jest.advanceTimersByTimeAsync(0);
      expect(manager.services.get('backend').healthy).toBe(true);

      await jest.advanceTimersByTimeAsync(10000);
      expect(manager.services.get('backend').healthy).toBe(false);
      stop();
    });

    it('logs health status changes', async () => {
      manager.registerService('backend', 8765, true);
      jest.spyOn(manager, 'checkServiceHealth').mockResolvedValueOnce(false);

      const stop = manager.startHealthMonitoring(10000);
      await jest.advanceTimersByTimeAsync(0);

      expect(consoleLogs.log).toHaveBeenCalledWith(
        '[PortManager:INFO]', 'Service health changed',
        expect.objectContaining({ serviceName: 'backend', healthy: false, previousHealth: true }),
      );
      stop();
    });

    it('catches errors in initial check', async () => {
      manager.registerService('backend', 8765, true);
      jest.spyOn(manager, 'checkServiceHealth').mockRejectedValueOnce(new Error('catastrophic'));

      const stop = manager.startHealthMonitoring(10000);
      await jest.advanceTimersByTimeAsync(0);

      expect(consoleLogs.error).toHaveBeenCalledWith(
        '[PortManager:ERROR]', 'Health check failed',
        expect.objectContaining({ error: 'catastrophic' }),
      );
      stop();
    });

    it('catches errors in periodic check', async () => {
      manager.registerService('backend', 8765, true);
      jest.spyOn(manager, 'checkServiceHealth')
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error('periodic failure'));

      const stop = manager.startHealthMonitoring(5000);
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(5000);

      expect(consoleLogs.error).toHaveBeenCalledWith(
        '[PortManager:ERROR]', 'Health check failed',
        expect.objectContaining({ error: 'periodic failure' }),
      );
      stop();
    });

    it('uses default 30s interval', () => {
      const stop = manager.startHealthMonitoring();
      expect(consoleLogs.log).toHaveBeenCalledWith(
        '[PortManager:INFO]', 'Starting health monitoring', { interval: 30000 },
      );
      stop();
    });

    it('uses custom health endpoint per service', async () => {
      const m = new PortManager({
        healthEndpoints: { backend: '/custom/health' },
        portRanges: { backend: { start: 8765, end: 8775 } },
      });
      m.registerService('backend', 8765, true);
      const spy = jest.spyOn(m, 'checkServiceHealth').mockResolvedValue(true);

      const stop = m.startHealthMonitoring(10000);
      await jest.advanceTimersByTimeAsync(0);
      expect(spy).toHaveBeenCalledWith('http://127.0.0.1:8765', '/custom/health');
      stop();
    });

    it('uses DEFAULTS endpoint when service has no custom', async () => {
      manager.registerService('backend', 8765, true);
      const spy = jest.spyOn(manager, 'checkServiceHealth').mockResolvedValue(true);

      const stop = manager.startHealthMonitoring(10000);
      await jest.advanceTimersByTimeAsync(0);
      expect(spy).toHaveBeenCalledWith('http://127.0.0.1:8765', '/v1/health');
      stop();
    });

    it('falls back to DEFAULTS endpoint for service not in healthEndpoints', async () => {
      // 'perplexica' has no entry in HEALTH_ENDPOINTS — triggers the || fallback
      manager.registerService('perplexica', 3000, true);
      const spy = jest.spyOn(manager, 'checkServiceHealth').mockResolvedValue(true);

      const stop = manager.startHealthMonitoring(10000);
      await jest.advanceTimersByTimeAsync(0);
      expect(spy).toHaveBeenCalledWith('http://127.0.0.1:3000', '/v1/health');
      stop();
    });
  });

  // Singleton / Factory
  describe('getManager', () => {
    it('returns same instance on repeated calls', () => {
      jest.resetModules();
      const mod = require('../../../src/main/services/PortManager');
      const m1 = mod.getManager();
      const m2 = mod.getManager();
      expect(m1).toBe(m2);
    });
  });

  describe('createManager', () => {
    it('creates new instance each time', () => {
      const m1 = createManager();
      const m2 = createManager();
      expect(m1).not.toBe(m2);
    });

    it('passes options', () => {
      const m = createManager({ protocol: 'https', host: 'example.com' });
      expect(m.options.protocol).toBe('https');
    });
  });

  // Module exports
  describe('module exports', () => {
    it('exports PortManager class', () => { expect(typeof PortManager).toBe('function'); });
    it('exports getManager function', () => { expect(typeof getManager).toBe('function'); });
    it('exports createManager function', () => { expect(typeof createManager).toBe('function'); });
    it('exports PORT_RANGES object', () => { expect(typeof PORT_RANGES).toBe('object'); });
    it('exports HEALTH_ENDPOINTS object', () => { expect(typeof HEALTH_ENDPOINTS).toBe('object'); });
    it('exports HEALTH_CHECK_TIMEOUT number', () => { expect(typeof HEALTH_CHECK_TIMEOUT).toBe('number'); });
  });

  // Constants values
  describe('exported constants', () => {
    it('PORT_RANGES is frozen', () => { expect(Object.isFrozen(PORT_RANGES)).toBe(true); });
    it('HEALTH_ENDPOINTS is frozen', () => { expect(Object.isFrozen(HEALTH_ENDPOINTS)).toBe(true); });
    it('HEALTH_CHECK_TIMEOUT is 10000', () => { expect(HEALTH_CHECK_TIMEOUT).toBe(10000); });
    it('backend range is 8765-8775', () => { expect(PORT_RANGES.backend).toEqual({ start: 8765, end: 8775 }); });
    it('perplexica range is 3000-3010', () => { expect(PORT_RANGES.perplexica).toEqual({ start: 3000, end: 3010 }); });
  });
});
