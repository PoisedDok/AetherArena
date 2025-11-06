'use strict';

/**
 * @.architecture
 * 
 * Incoming: main/index.js (discoverAllServices, startHealthMonitoring, getServiceUrl), ServiceLauncher (findServicePort) --- {method_call, void}
 * Processing: Check port availability via net.createServer, find available ports in ranges (backend 8765-8775, perplexica 3000-3010, searxng 4000-4010, docling 8000-8010, xlwings 8001-8011, llm 1234-1244), health check via http.get (timeout 3s, accept 2xx-3xx), discover services by scanning port ranges (batches of 10 concurrent), maintain service registry Map (port, url, healthy, lastCheck), health monitoring via setInterval (30s default), provide getServiceUrl with fallback to config defaults --- {10 jobs: JOB_GET_STATE, JOB_DELEGATE_TO_MODULE, JOB_GET_STATE, JOB_GET_STATE, JOB_HTTP_REQUEST, JOB_EMIT_EVENT, JOB_INITIALIZE, JOB_GET_STATE, JOB_UPDATE_STATE, JOB_UPDATE_STATE}
 * Outgoing: Service registry Map, health monitoring interval handle --- {service_registry | interval_handle, Map | Function}
 * 
 * 
 * @module main/services/PortManager
 * 
 * Port Manager
 * ============================================================================
 * Manages dynamic port allocation and discovery for backend services.
 * Ensures no port conflicts and services can be discovered automatically.
 * 
 * Features:
 * - Find available ports dynamically
 * - Service discovery via health checks
 * - Port range management
 * - Concurrent port finding
 * - Service registry with health status
 * 
 * @module main/services/PortManager
 */

const net = require('net');
const http = require('http');
const https = require('https');
const { logger } = require('../../core/utils/logger');

// ============================================================================
// Constants
// ============================================================================

/**
 * Default port ranges for different services
 */
const PORT_RANGES = Object.freeze({
  backend: { start: 8765, end: 8775 },
  perplexica: { start: 3000, end: 3010 },
  searxng: { start: 4000, end: 4010 },
  docling: { start: 8000, end: 8010 },
  xlwings: { start: 8001, end: 8011 },
  llm: { start: 1234, end: 1244 },
});

/**
 * Health check endpoints for services
 */
const HEALTH_ENDPOINTS = Object.freeze({
  backend: '/health',
  perplexica: '/api/health',
  searxng: '/healthz',
  docling: '/health',
  xlwings: '/health',
  llm: '/v1/models',
});

/**
 * Health check timeout (ms)
 */
const HEALTH_CHECK_TIMEOUT = 3000;

/**
 * Max concurrent port checks
 */
const MAX_CONCURRENT_CHECKS = 10;

// ============================================================================
// PortManager Class
// ============================================================================

class PortManager {
  constructor(options = {}) {
    this.options = {
      healthCheckTimeout: options.healthCheckTimeout || HEALTH_CHECK_TIMEOUT,
      maxConcurrentChecks: options.maxConcurrentChecks || MAX_CONCURRENT_CHECKS,
      portRanges: { ...PORT_RANGES, ...options.portRanges },
      healthEndpoints: { ...HEALTH_ENDPOINTS, ...options.healthEndpoints },
      ...options,
    };
    
    this.logger = logger.child({ module: 'PortManager' });
    
    // Service registry: service name -> { port, url, healthy, lastCheck }
    this.services = new Map();
    
    // Port allocation tracking
    this.allocatedPorts = new Set();
  }

  /**
   * Check if a port is available (not in use)
   * @param {number} port - Port to check
   * @returns {Promise<boolean>} True if available
   */
  async isPortAvailable(port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
          resolve(false);
        } else {
          // Other errors mean we can't determine, assume unavailable
          resolve(false);
        }
      });
      
      server.once('listening', () => {
        server.close();
        resolve(true);
      });
      
      server.listen(port, '127.0.0.1');
    });
  }

  /**
   * Find an available port in a range
   * @param {number} startPort - Start of range
   * @param {number} endPort - End of range
   * @param {Array<number>} exclude - Ports to exclude
   * @returns {Promise<number|null>} Available port or null
   */
  async findAvailablePort(startPort, endPort, exclude = []) {
    const excludeSet = new Set([...exclude, ...this.allocatedPorts]);
    
    // Try ports in order
    for (let port = startPort; port <= endPort; port++) {
      if (excludeSet.has(port)) continue;
      
      if (await this.isPortAvailable(port)) {
        this.logger.debug('Found available port', { port, range: [startPort, endPort] });
        return port;
      }
    }
    
    this.logger.warn('No available port in range', { startPort, endPort });
    return null;
  }

  /**
   * Find available port for a specific service
   * @param {string} serviceName - Service name
   * @returns {Promise<number|null>} Available port or null
   */
  async findServicePort(serviceName) {
    const range = this.options.portRanges[serviceName];
    
    if (!range) {
      this.logger.warn('No port range configured for service', { serviceName });
      return null;
    }
    
    const port = await this.findAvailablePort(range.start, range.end);
    
    if (port) {
      this.allocatedPorts.add(port);
      this.logger.info('Allocated port for service', { serviceName, port });
    }
    
    return port;
  }

  /**
   * Check if a service is healthy at a given URL
   * @param {string} url - Service URL
   * @param {string} healthEndpoint - Health check endpoint
   * @returns {Promise<boolean>} True if healthy
   */
  async checkServiceHealth(url, healthEndpoint) {
    return new Promise((resolve) => {
      const fullUrl = `${url}${healthEndpoint}`;
      const isHttps = fullUrl.startsWith('https://');
      const client = isHttps ? https : http;
      
      const timeout = setTimeout(() => {
        resolve(false);
      }, this.options.healthCheckTimeout);
      
      try {
        const req = client.get(fullUrl, { timeout: this.options.healthCheckTimeout }, (res) => {
          clearTimeout(timeout);
          
          // Accept 2xx and 3xx status codes as healthy
          const healthy = res.statusCode >= 200 && res.statusCode < 400;
          
          if (healthy) {
            this.logger.debug('Service health check passed', { url: fullUrl, status: res.statusCode });
          } else {
            this.logger.debug('Service health check failed', { url: fullUrl, status: res.statusCode });
          }
          
          resolve(healthy);
          
          // Drain response to free up socket
          res.resume();
        });
        
        req.on('error', (err) => {
          clearTimeout(timeout);
          this.logger.debug('Service health check error', { url: fullUrl, error: err.message });
          resolve(false);
        });
        
        req.on('timeout', () => {
          clearTimeout(timeout);
          req.destroy();
          this.logger.debug('Service health check timeout', { url: fullUrl });
          resolve(false);
        });
      } catch (err) {
        clearTimeout(timeout);
        this.logger.debug('Service health check exception', { url: fullUrl, error: err.message });
        resolve(false);
      }
    });
  }

  /**
   * Discover a service by scanning its port range
   * @param {string} serviceName - Service name
   * @returns {Promise<{port: number, url: string, healthy: boolean}|null>}
   */
  async discoverService(serviceName) {
    const range = this.options.portRanges[serviceName];
    const healthEndpoint = this.options.healthEndpoints[serviceName] || '/health';
    
    if (!range) {
      this.logger.warn('No port range configured for service', { serviceName });
      return null;
    }
    
    this.logger.info('Discovering service', { serviceName, range });
    
    // Check all ports in range concurrently (with limit)
    const ports = [];
    for (let port = range.start; port <= range.end; port++) {
      ports.push(port);
    }
    
    // Process ports in batches
    for (let i = 0; i < ports.length; i += this.options.maxConcurrentChecks) {
      const batch = ports.slice(i, i + this.options.maxConcurrentChecks);
      
      const results = await Promise.all(
        batch.map(async (port) => {
          const url = `http://localhost:${port}`;
          const healthy = await this.checkServiceHealth(url, healthEndpoint);
          return healthy ? { port, url, healthy: true } : null;
        })
      );
      
      // Return first healthy service found
      const found = results.find(result => result !== null);
      if (found) {
        this.logger.info('Service discovered', { serviceName, ...found });
        return found;
      }
    }
    
    this.logger.warn('Service not discovered', { serviceName, range });
    return null;
  }

  /**
   * Register a service in the registry
   * @param {string} serviceName - Service name
   * @param {number} port - Service port
   * @param {boolean} healthy - Health status
   */
  registerService(serviceName, port, healthy = false) {
    const url = `http://localhost:${port}`;
    
    this.services.set(serviceName, {
      port,
      url,
      healthy,
      lastCheck: Date.now(),
    });
    
    this.logger.info('Service registered', { serviceName, port, url, healthy });
  }

  /**
   * Get service info from registry
   * @param {string} serviceName - Service name
   * @returns {Object|null} Service info or null
   */
  getService(serviceName) {
    return this.services.get(serviceName) || null;
  }

  /**
   * Update service health status
   * @param {string} serviceName - Service name
   * @param {boolean} healthy - Health status
   */
  updateServiceHealth(serviceName, healthy) {
    const service = this.services.get(serviceName);
    
    if (service) {
      service.healthy = healthy;
      service.lastCheck = Date.now();
      
      this.logger.debug('Service health updated', { serviceName, healthy });
    }
  }

  /**
   * Discover and register all configured services
   * @returns {Promise<Map<string, Object>>} Service registry
   */
  async discoverAllServices() {
    this.logger.info('Discovering all services');
    
    const serviceNames = Object.keys(this.options.portRanges);
    
    const results = await Promise.all(
      serviceNames.map(async (serviceName) => {
        const discovered = await this.discoverService(serviceName);
        
        if (discovered) {
          this.registerService(serviceName, discovered.port, discovered.healthy);
          return { serviceName, ...discovered };
        }
        
        return { serviceName, discovered: false };
      })
    );
    
    this.logger.info('Service discovery complete', {
      total: serviceNames.length,
      discovered: results.filter(r => r.discovered !== false).length,
    });
    
    return this.services;
  }

  /**
   * Get service URL with fallback to configured defaults
   * @param {string} serviceName - Service name
   * @param {string} defaultUrl - Default URL if not discovered
   * @returns {string} Service URL
   */
  getServiceUrl(serviceName, defaultUrl) {
    const service = this.services.get(serviceName);
    
    if (service && service.healthy) {
      return service.url;
    }
    
    return defaultUrl;
  }

  /**
   * Release allocated port
   * @param {number} port - Port to release
   */
  releasePort(port) {
    this.allocatedPorts.delete(port);
    this.logger.debug('Released port', { port });
  }

  /**
   * Clear all registered services
   */
  clearRegistry() {
    this.services.clear();
    this.allocatedPorts.clear();
    this.logger.info('Service registry cleared');
  }

  /**
   * Get all healthy services
   * @returns {Array<Object>} Healthy services
   */
  getHealthyServices() {
    const healthy = [];
    
    for (const [name, service] of this.services.entries()) {
      if (service.healthy) {
        healthy.push({ name, ...service });
      }
    }
    
    return healthy;
  }

  /**
   * Monitor services health periodically
   * @param {number} interval - Check interval in ms
   * @returns {Function} Stop monitoring function
   */
  startHealthMonitoring(interval = 30000) {
    this.logger.info('Starting health monitoring', { interval });
    
    const checkHealth = async () => {
      for (const [serviceName, service] of this.services.entries()) {
        const healthEndpoint = this.options.healthEndpoints[serviceName] || '/health';
        const healthy = await this.checkServiceHealth(service.url, healthEndpoint);
        
        if (healthy !== service.healthy) {
          this.logger.info('Service health changed', { serviceName, healthy, previousHealth: service.healthy });
        }
        
        this.updateServiceHealth(serviceName, healthy);
      }
    };
    
    // Initial check
    checkHealth().catch(err => {
      this.logger.error('Health check failed', { error: err.message });
    });
    
    // Periodic checks
    const timerId = setInterval(() => {
      checkHealth().catch(err => {
        this.logger.error('Health check failed', { error: err.message });
      });
    }, interval);
    
    // Return stop function
    return () => {
      clearInterval(timerId);
      this.logger.info('Health monitoring stopped');
    };
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalManager = null;

/**
 * Get or create global manager instance
 */
function getManager(options = {}) {
  if (!globalManager) {
    globalManager = new PortManager(options);
  }
  return globalManager;
}

/**
 * Create a new manager instance
 */
function createManager(options = {}) {
  return new PortManager(options);
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  PortManager,
  getManager,
  createManager,
  
  // Constants
  PORT_RANGES,
  HEALTH_ENDPOINTS,
  HEALTH_CHECK_TIMEOUT,
};

