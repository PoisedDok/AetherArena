'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactsController._probeBackendHealth() --- {none}
 * Processing: Probe backend health via storageAPI.healthCheck() or window.aether.system.getStats(), return health status --- {2 jobs: JOB_CALL_API, JOB_VALIDATE_SCHEMA}
 * Outgoing: Return {healthy: boolean, stats?: object, error?: Error} --- {health_status, object}
 * 
 * ARCHITECTURE:
 * - Infrastructure layer (I/O operations)
 * - Abstracts health check mechanisms
 * - Provides multiple probe strategies
 * - Graceful fallback on failure
 * - Testable with mocks
 * - No business logic
 * 
 * PROBE STRATEGIES:
 * 1. storageAPI.healthCheck() (preferred)
 * 2. window.aether.system.getStats() (fallback)
 * 3. Return unhealthy if no probe available
 * 
 * @module infrastructure/monitoring/BackendHealthProbe
 */

const { createLogger } = require('../../core/utils/logger');
const { freeze } = Object;

class BackendHealthProbe {
  /**
   * Create health probe
   * @param {Object} dependencies - Probe dependencies
   * @param {Object} dependencies.storageAPI - Storage API (optional)
   * @param {Object} dependencies.systemAPI - System API (optional, via window.aether.system)
   */
  constructor(dependencies = {}) {
    this.storageAPI = dependencies.storageAPI || null;
    this.systemAPI = dependencies.systemAPI || (typeof window !== 'undefined' ? window?.aether?.system : null);
    this.log = createLogger({ component: 'BackendHealthProbe' });
  }

  /**
   * Probe backend health
   * @returns {Promise<Object>} Health status {healthy: boolean, stats?: object, error?: Error}
   */
  async probe() {
    // Strategy 1: Try storageAPI health check
    if (this.storageAPI && typeof this.storageAPI.healthCheck === 'function') {
      try {
        const result = await this.storageAPI.healthCheck();
        
        if (result) {
          // Health check returns {status: 'ok'} or {status: 'healthy'} or {healthy: true}
          const isHealthy = result.status === 'ok' || 
                           result.status === 'healthy' || 
                           result.healthy === true ||
                           result.healthy !== false;
          
          return freeze({
            healthy: isHealthy,
            strategy: 'storageAPI.healthCheck',
            ...result
          });
        }
      } catch (error) {
        // Continue to fallback strategy
        this.log.warn('storageAPI health check failed', {
          error: error?.message
        });
      }
    }

    // Strategy 2: Try system stats probe
    if (this.systemAPI && typeof this.systemAPI.getStats === 'function') {
      try {
        const stats = await this.systemAPI.getStats();
        
        if (stats) {
          return freeze({
            healthy: true,
            strategy: 'systemAPI.getStats',
            stats
          });
        }
      } catch (error) {
        // Continue to fallback
        this.log.warn('System stats probe failed', {
          error: error?.message
        });
      }
    }

    // No probe available or all failed
    return freeze({
      healthy: false,
      strategy: 'none',
      error: new Error('No health probe available or all probes failed')
    });
  }

  /**
   * Quick health check (non-throwing)
   * @returns {Promise<boolean>} True if healthy, false otherwise
   */
  async isHealthy() {
    try {
      const result = await this.probe();
      return result.healthy === true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Probe with timeout
   * @param {number} timeoutMs - Timeout in milliseconds (default: 5000)
   * @returns {Promise<Object>} Health status
   */
  async probeWithTimeout(timeoutMs = 5000) {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Health probe timeout')), timeoutMs);
    });

    try {
      const result = await Promise.race([
        this.probe(),
        timeoutPromise
      ]);

      return result;
    } catch (error) {
      return freeze({
        healthy: false,
        strategy: 'timeout',
        error,
        timeout: timeoutMs
      });
    }
  }

  /**
   * Get available probe strategies
   * @returns {Array<string>} Available strategies
   */
  getAvailableStrategies() {
    const strategies = [];

    if (this.storageAPI && typeof this.storageAPI.healthCheck === 'function') {
      strategies.push('storageAPI.healthCheck');
    }

    if (this.systemAPI && typeof this.systemAPI.getStats === 'function') {
      strategies.push('systemAPI.getStats');
    }

    return strategies;
  }

  /**
   * Update dependencies (for testing/hot-swap)
   * @param {Object} dependencies - New dependencies
   */
  updateDependencies(dependencies) {
    if (dependencies.storageAPI !== undefined) {
      this.storageAPI = dependencies.storageAPI;
    }

    if (dependencies.systemAPI !== undefined) {
      this.systemAPI = dependencies.systemAPI;
    }
  }
}

// Export
module.exports = { BackendHealthProbe };
