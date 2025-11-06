'use strict';

/**
 * @.architecture
 * 
 * Incoming: MainOrchestrator.registerService() calls, periodic setInterval timer --- {lifecycle_types.method_call, timer_event}
 * Processing: Track services in Map, check health via Endpoint.getHealth or fetch, update status, emit EventBus events, aggregate health summary --- {5 jobs: JOB_EMIT_EVENT, JOB_GET_STATE, JOB_HTTP_REQUEST, JOB_TRACK_ENTITY, JOB_UPDATE_STATE}
 * Outgoing: EventBus.emit (SERVICE.* events), getHealthSummary() → caller --- {event_types.service_status_updated, service_types.health_summary}
 * 
 * @module application/main/ServiceStatusMonitor
 * 
 * ServiceStatusMonitor - Monitors health of backend services
 * ============================================================================
 * Production-ready service monitoring with periodic health checks.
 * 
 * Features:
 * - Service registration and tracking
 * - Periodic health checks with timeout
 * - Consecutive failure tracking
 * - Status change events
 * - Health summary aggregation
 */

const { EventTypes } = require('../../core/events/EventTypes');

class ServiceStatusMonitor {
  constructor(options = {}) {
    // Dependencies
    this.endpoint = options.endpoint || null;
    this.eventBus = options.eventBus || null;
    
    // Configuration
    this.checkInterval = options.checkInterval || 4000;
    this.timeout = options.timeout || 2500;
    this.enableLogging = options.enableLogging !== undefined ? options.enableLogging : false;
    
    // State
    this.services = new Map();
    this.intervalId = null;
    
    // Validation
    if (!this.endpoint) {
      throw new Error('[ServiceStatusMonitor] endpoint required');
    }
    
    if (!this.eventBus) {
      throw new Error('[ServiceStatusMonitor] eventBus required');
    }
  }

  /**
   * Register a service to monitor
   * @param {string} key - Service identifier
   * @param {Object} config - Service configuration
   */
  registerService(key, config) {
    this.services.set(key, {
      key,
      name: config.name,
      url: config.url,
      port: config.port,
      useEndpoint: config.useEndpoint || false,
      status: 'unknown',
      lastCheck: null,
      lastSuccess: null,
      consecutiveFailures: 0
    });

    if (this.enableLogging) {
      console.log(`[ServiceStatusMonitor] Registered service: ${key}`);
    }
  }

  /**
   * Start monitoring
   */
  start() {
    if (this.intervalId) {
      console.warn('[ServiceStatusMonitor] Already started');
      return;
    }

    // Initial check
    this.checkAll();

    // Start interval
    this.intervalId = setInterval(() => this.checkAll(), this.checkInterval);

    if (this.enableLogging) {
      console.log(`[ServiceStatusMonitor] Started (interval: ${this.checkInterval}ms)`);
    }
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;

      if (this.enableLogging) {
        console.log('[ServiceStatusMonitor] Stopped');
      }
    }
  }

  /**
   * Check all registered services
   * @returns {Promise<void>}
   */
  async checkAll() {
    const checks = [];
    
    for (const [key, service] of this.services) {
      checks.push(this.checkService(key));
    }

    await Promise.allSettled(checks);
  }

  /**
   * Check specific service
   * @param {string} key - Service key
   * @returns {Promise<void>}
   */
  async checkService(key) {
    const service = this.services.get(key);
    if (!service) return;

    service.lastCheck = Date.now();
    let newStatus = 'error';

    try {
      if (service.useEndpoint) {
        // Use endpoint method (for Aether backend)
        await this.endpoint.getHealth();
        newStatus = 'ok';
      } else {
        // Direct fetch with timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        try {
          const response = await fetch(service.url, { 
            signal: controller.signal,
            mode: 'cors',
            cache: 'no-cache'
          });
          clearTimeout(timeoutId);

          newStatus = response.ok ? 'ok' : 'warn';
        } catch (fetchError) {
          clearTimeout(timeoutId);
          throw fetchError;
        }
      }

      service.lastSuccess = Date.now();
      service.consecutiveFailures = 0;
    } catch (error) {
      service.consecutiveFailures++;
      newStatus = 'error';

      if (this.enableLogging) {
        console.warn(`[ServiceStatusMonitor] Check failed for ${key}:`, error.message);
      }
    }

    // Update status
    this._updateServiceStatus(key, newStatus);
  }

  /**
   * Update service status
   * @private
   */
  _updateServiceStatus(key, newStatus) {
    const service = this.services.get(key);
    if (!service) return;

    const oldStatus = service.status;
    service.status = newStatus;

    // Emit event if status changed
    if (oldStatus !== newStatus) {
      this.eventBus.emit(EventTypes.SERVICE.STATUS_UPDATED, {
        serviceName: key,
        status: newStatus,
        previousStatus: oldStatus,
        timestamp: Date.now(),
        consecutiveFailures: service.consecutiveFailures,
        lastSuccess: service.lastSuccess
      });

      // Emit specific events
      if (newStatus === 'ok') {
        this.eventBus.emit(EventTypes.SERVICE.ONLINE, {
          serviceName: key,
          timestamp: Date.now()
        });
      } else if (newStatus === 'error') {
        this.eventBus.emit(EventTypes.SERVICE.OFFLINE, {
          serviceName: key,
          timestamp: Date.now(),
          consecutiveFailures: service.consecutiveFailures
        });
      }
    }

    if (this.enableLogging && oldStatus !== newStatus) {
      console.log(`[ServiceStatusMonitor] ${key}: ${oldStatus} → ${newStatus}`);
    }
  }

  /**
   * Get service status
   * @param {string} key - Service key
   * @returns {Object|null}
   */
  getServiceStatus(key) {
    const service = this.services.get(key);
    return service ? { ...service } : null;
  }

  /**
   * Get all services status
   * @returns {Object}
   */
  getAllStatus() {
    const result = {};
    for (const [key, service] of this.services) {
      result[key] = { ...service };
    }
    return result;
  }

  /**
   * Get services by status
   * @param {string} status - Status filter
   * @returns {Array}
   */
  getServicesByStatus(status) {
    const result = [];
    for (const [key, service] of this.services) {
      if (service.status === status) {
        result.push({ key, ...service });
      }
    }
    return result;
  }

  /**
   * Is service healthy
   * @param {string} key - Service key
   * @returns {boolean}
   */
  isServiceHealthy(key) {
    const service = this.services.get(key);
    return service ? service.status === 'ok' : false;
  }

  /**
   * Get health summary
   * @returns {Object}
   */
  getHealthSummary() {
    const summary = {
      total: this.services.size,
      ok: 0,
      warn: 0,
      error: 0,
      unknown: 0,
      healthy: false
    };

    for (const service of this.services.values()) {
      summary[service.status]++;
    }

    summary.healthy = summary.ok === summary.total;

    return summary;
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    return Object.freeze({
      isMonitoring: !!this.intervalId,
      checkInterval: this.checkInterval,
      timeout: this.timeout,
      serviceCount: this.services.size,
      healthSummary: this.getHealthSummary()
    });
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    this.stop();
    this.services.clear();
    this.endpoint = null;
    this.eventBus = null;

    if (this.enableLogging) {
      console.log('[ServiceStatusMonitor] Disposed');
    }
  }
}

// Export
module.exports = ServiceStatusMonitor;

if (typeof window !== 'undefined') {
  window.ServiceStatusMonitor = ServiceStatusMonitor;
  console.log('📦 ServiceStatusMonitor loaded');
}

