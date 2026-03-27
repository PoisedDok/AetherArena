'use strict';

/**
 * @.architecture
 * 
 * Incoming: MainOrchestrator.start() call, periodic setInterval timer --- {method_call, javascript_api}
 * Processing: Poll GuruConnection.ws.readyState every 2s, detect state changes, emit EventBus events --- {7 jobs: JOB_DISPOSE, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_INITIALIZE, JOB_START, JOB_STOP, JOB_UPDATE_STATE}
 * Outgoing: EventBus.emit() (CONNECTION.* events) --- {event_types.custom_event, json}
 * 
 * @module application/main/modules/connection/ConnectionMonitor
 * 
 * ConnectionMonitor - Monitors WebSocket and backend connection status
 * ============================================================================
 * Production-ready connection monitoring service.
 * 
 * Features:
 * - Periodic WebSocket status checking
 * - Connection state change detection
 * - EventBus integration for status broadcasts
 * - UI element updates
 * - Configurable check interval
 */

const EventEmitter = require('events');
const { EventTypes, EventPriority } = require('../../../../core/events/EventTypes');
const GuruConnection = require('../../../../core/communication/GuruConnection');
const { createRendererLogger } = require('../../../../renderer/shared/utils/logger');
const _log = createRendererLogger('ConnectionMonitor');

const { CONNECTION_STATES } = GuruConnection;

class ConnectionMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    // Dependencies
    this.guru = options.guruConnection || null;
    this.eventBus = options.eventBus || null;
    
    // Configuration
    this.checkInterval = options.checkInterval || 2000;
    this.enableLogging = options.enableLogging !== undefined ? options.enableLogging : false;
    
    // Telemetry
    this.metricsCollector = options.metricsCollector || this._resolveMetricsCollector();
    this.metrics = {
      reconnects: 0,
      transitions: 0,
    };

    // State
    this.intervalId = null;
    this.lastStatus = null;
    this._stateListener = null;
    this._timers = [];
    
    // Validation
    if (!this.guru) {
      throw new Error('[ConnectionMonitor] guru connection required');
    }
    
    if (!this.eventBus) {
      throw new Error('[ConnectionMonitor] eventBus required');
    }
  }

  _trackTimer(type, fn, ms) {
    const id = type === 'interval'
      ? setInterval(fn, ms)
      : setTimeout(fn, ms);
    this._timers.push({ id, type });
    return id;
  }

  /**
   * Start monitoring
   */
  start() {
    if (this.intervalId) {
      _log.warn('[ConnectionMonitor] Already started');
      return;
    }

    // Initial check
    this.check();

    if (typeof this.guru.on === 'function' && !this._stateListener) {
      this._stateListener = (payload) => this._handleGuruState(payload);
      this.guru.on('connectionState', this._stateListener);
    }

    // Start interval
    this.intervalId = this._trackTimer('interval', () => this.check(), this.checkInterval);

    if (this.enableLogging) {
      _log.debug(`[ConnectionMonitor] Started (interval: ${this.checkInterval}ms)`);
    }
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this.intervalId) {
      for (const { id, type } of this._timers) {
        type === 'interval' ? clearInterval(id) : clearTimeout(id);
      }
      this._timers = [];
      this.intervalId = null;

      if (this.enableLogging) {
        _log.debug('[ConnectionMonitor] Stopped');
      }
    }

    if (this._stateListener) {
      if (typeof this.guru?.off === 'function') {
        this.guru.off('connectionState', this._stateListener);
      } else if (typeof this.guru?.removeListener === 'function') {
        this.guru.removeListener('connectionState', this._stateListener);
      }
      this._stateListener = null;
    }
  }

  /**
   * Check connection status
   * @returns {Object} Current status
   */
  check() {
    const status = this.getStatus();
    this._processStatus(status, status.details?.state || null);
    return status;
  }

  /**
   * Get current connection status
   * @returns {Object} Status object
   */
  getStatus() {
    let connected = false;
    const details = {
      websocket: false,
      readyState: null
    };

    try {
      if (this.guru && this.guru.ws) {
        const ws = this.guru.ws;
        details.readyState = ws.readyState;
        details.websocket = ws.readyState === WebSocket.OPEN;
        connected = details.websocket;
      }
    } catch (error) {
      _log.error('[ConnectionMonitor] Error checking status:', error);
    }

    return {
      connected,
      timestamp: Date.now(),
      details
    };
  }

  _handleGuruState(payload = {}) {
    const state = payload.state || this.guru?.connectionState || CONNECTION_STATES.DISCONNECTED;
    const meta = payload.meta || {};
    const connected = state === CONNECTION_STATES.CONNECTED;
    const status = {
      connected,
      timestamp: Date.now(),
      details: {
        websocket: connected,
        readyState: this.guru?.ws?.readyState ?? null,
        state,
        meta,
      },
    };

    this._processStatus(status, state);
    // NOTE: _processStatus already handles _recordReconnect for RECONNECTING state
    // (lines 198-203). Calling it here too caused double-count in metrics.reconnects.
  }

  _processStatus(status, reason = null) {
    const prev = this.lastStatus;
    const stateChanged =
      status.details?.state && status.details.state !== prev?.details?.state;
    const connectivityChanged = status.connected !== prev?.connected;

    if (connectivityChanged || stateChanged) {
      this.metrics.transitions += 1;
      this._onStatusChange(status);
      this.emit('state', {
        state: status.details?.state || null,
        reason,
        status,
      });

      if (status.connected) {
        this.emit('connected', { reason, status });
      } else {
        this.emit('disconnected', { reason, status });
      }
    }

    this.lastStatus = status;

    if (
      reason === CONNECTION_STATES.RECONNECTING ||
      status.details?.state === CONNECTION_STATES.RECONNECTING
    ) {
      this._recordReconnect(status.details?.meta);
    }
  }

  /**
   * Handle status change
   * @private
   */
  _onStatusChange(status) {
    if (this.enableLogging) {
      _log.debug('[ConnectionMonitor] Status changed:', status.connected ? 'ONLINE' : 'OFFLINE', {
        state: status.details?.state || 'unknown',
      });
    }

    // Emit status change event
    this.eventBus.emit(EventTypes.CONNECTION.STATUS_CHANGED, {
      connected: status.connected,
      previous: this.lastStatus?.connected || false,
      timestamp: status.timestamp,
      details: status.details
    }, { priority: EventPriority.HIGH });

    // Emit specific WebSocket events
    if (status.details.websocket && !this.lastStatus?.details?.websocket) {
      this.eventBus.emit(EventTypes.CONNECTION.WEBSOCKET_OPENED, status);
    } else if (!status.details.websocket && this.lastStatus?.details?.websocket) {
      this.eventBus.emit(EventTypes.CONNECTION.WEBSOCKET_CLOSED, status);
    }

    // Emit backend events
    if (status.connected && !this.lastStatus?.connected) {
      this.eventBus.emit(EventTypes.CONNECTION.BACKEND_ONLINE, status, { 
        priority: EventPriority.HIGH 
      });
    } else if (!status.connected && this.lastStatus?.connected) {
      this.eventBus.emit(EventTypes.CONNECTION.BACKEND_OFFLINE, status, { 
        priority: EventPriority.HIGH 
      });
    }
  }

  /**
   * Is currently connected
   * @returns {boolean}
   */
  isConnected() {
    return this.lastStatus?.connected || false;
  }

  /**
   * Get statistics
   * @returns {Object} Statistics
   */
  getStats() {
    return Object.freeze({
      isMonitoring: !!this.intervalId,
      checkInterval: this.checkInterval,
      currentStatus: this.lastStatus,
      uptime: this.lastStatus ? Date.now() - this.lastStatus.timestamp : 0,
      metrics: { ...this.metrics },
    });
  }

  getMetrics() {
    return { ...this.metrics };
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    this.stop();
    this.lastStatus = null;
    this.guru = null;
    this.eventBus = null;
    this.metricsCollector = null;

    if (this.enableLogging) {
      _log.debug('[ConnectionMonitor] Disposed');
    }
  }

  _recordReconnect(meta = {}) {
    this.metrics.reconnects += 1;

    if (this.metricsCollector && typeof this.metricsCollector.recordCustom === 'function') {
      try {
        this.metricsCollector.recordCustom('websocket:reconnects', 1);
      } catch (error) {
        if (this.enableLogging) {
          _log.warn('[ConnectionMonitor] Failed to record reconnect metric', {
            error: error?.message,
          });
        }
      }
    }

    if (this.enableLogging) {
      _log.debug('[ConnectionMonitor] Reconnect detected', {
        attempt: meta?.attempt,
        backoff: meta?.backoff,
        total: this.metrics.reconnects,
      });
    }
  }

  _resolveMetricsCollector() {
    if (typeof window === 'undefined') {
      return null;
    }

    if (window.metricsCollector) {
      return window.metricsCollector;
    }

    if (window.__PERFORMANCE_INTEGRATION__?.metricsCollector) {
      return window.__PERFORMANCE_INTEGRATION__.metricsCollector;
    }

    return null;
  }
}

// Export
module.exports = ConnectionMonitor;

if (typeof window !== 'undefined') {
  window.ConnectionMonitor = ConnectionMonitor;
  _log.debug('ConnectionMonitor loaded');
}
