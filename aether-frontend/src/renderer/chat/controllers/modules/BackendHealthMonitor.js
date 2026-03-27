'use strict';

/**
 * @.architecture
 * 
 * Incoming: Health check requests, storage API health probes, system stats --- {method_call, void}
 * Processing: Probe backend health via multiple strategies, emit connection events --- {3 jobs: JOB_PROBE_HEALTH, JOB_EMIT_EVENT, JOB_UPDATE_STATE}
 * Outgoing: EventBus connection events (BACKEND_ONLINE/OFFLINE) --- {event, object}
 * 
 * @module renderer/chat/controllers/modules/BackendHealthMonitor
 */

const { EventTypes } = require('../../../../core/events/EventTypes');
const { createRendererLogger } = require('../../../shared/utils/logger');
const { getAether } = require('../../../shared/bridge/AetherBridge');

const monitorLogger = createRendererLogger('BackendHealthMonitor');

/**
 * BackendHealthMonitor - Backend Health Monitoring
 * ================================================
 * 
 * SINGLE RESPONSIBILITY: Monitor and report backend health status
 * 
 * RESPONSIBILITIES:
 * - Probe backend health via multiple strategies
 * - Emit connection status events
 * - Track connection state
 * 
 * CONTRACTS:
 * - NO business logic
 * - NO UI updates (delegates via events)
 * - FAIL FAST on configuration errors
 * 
 * @module renderer/chat/controllers/modules/BackendHealthMonitor
 */
class BackendHealthMonitor {
  constructor(options = {}) {
    this.storageAPI = options.storageAPI || null;
    this.eventBus = options.eventBus || null;
    this.log = monitorLogger.child({ scope: 'backend-health-monitor' });
    this.aether = options.aether || getAether();

    if (!this.eventBus) {
      throw new Error('[BackendHealthMonitor] eventBus is REQUIRED');
    }

    this.connected = false;
    this.monitoringInterval = null;
    this._isDisposed = false;

    this.log.info('BackendHealthMonitor initialized');
  }

  /**
   * Probe backend health via multiple strategies
   * @returns {Promise<Object>} Health status object
   */
  async probeHealth() {
    // Strategy 1: Storage API health check
    if (this.storageAPI && typeof this.storageAPI.healthCheck === 'function') {
      try {
        const result = await this.storageAPI.healthCheck();
        if (result) {
          return { healthy: result.healthy !== false, ...result, strategy: 'storage' };
        }
      } catch (error) {
        this.log.warn('Storage health check failed', { error: error?.message });
        return { healthy: false, error, strategy: 'storage' };
      }
    }

    // Strategy 2: System stats probe
    if (this.aether?.system?.getStats) {
      try {
        const stats = await this.aether.system.getStats();
        if (stats) {
          return { healthy: true, stats, strategy: 'system' };
        }
      } catch (error) {
        this.log.warn('System stats probe failed', { error: error?.message });
        return { healthy: false, error, strategy: 'system' };
      }
    }

    // No probe available
    return { healthy: false, error: new Error('No health probe available'), strategy: 'none' };
  }

  /**
   * Check health and emit appropriate event
   * @returns {Promise<boolean>} Connection status
   */
  async checkAndEmit() {
    if (this._isDisposed) return false;
    try {
      const health = await this.probeHealth();
      const isHealthy = health?.healthy !== false;

      // Only emit if state changed
      if (isHealthy !== this.connected) {
        this.connected = isHealthy;

        if (isHealthy) {
          this.log.info('Backend health check succeeded', health || {});
          this.eventBus.emit(EventTypes.CONNECTION.BACKEND_ONLINE, { health });
        } else {
          this.log.warn('Backend health check failed', { error: health?.error || 'unknown' });
          this.eventBus.emit(EventTypes.CONNECTION.BACKEND_OFFLINE, { 
            error: health?.error || new Error('backend offline') 
          });
        }
      }

      return isHealthy;
    } catch (error) {
      this.log.error('Health check failed with exception', { error });
      return false;
    }
  }

  /**
   * Start periodic health monitoring
   * @param {number} interval - Check interval in milliseconds (default: 30000)
   */
  startMonitoring(interval = 30000) {
    if (this._isDisposed) return;
    if (this.monitoringInterval) {
      this.log.warn('Monitoring already started');
      return;
    }

    // Initial check
    this.checkAndEmit();

    // Periodic checks
    this.monitoringInterval = setInterval(() => {
      this.checkAndEmit();
    }, interval);

    this.log.info('Periodic health monitoring started', { interval });
  }

  /**
   * Stop periodic health monitoring
   */
  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
      this.log.info('Periodic health monitoring stopped');
    }
  }

  /**
   * Get current connection status
   * @returns {boolean}
   */
  isConnected() {
    return this.connected;
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this.stopMonitoring();
    this.storageAPI = null;
    this.eventBus = null;
    this.log.info('BackendHealthMonitor disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BackendHealthMonitor;
}

if (typeof window !== 'undefined') {
  window.BackendHealthMonitor = BackendHealthMonitor;
}
