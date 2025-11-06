'use strict';

/**
 * @.architecture
 * 
 * Incoming: MainOrchestrator.start() call, periodic setInterval timer --- {method_call, javascript_api}
 * Processing: Poll GuruConnection.ws.readyState every 2s, detect state changes, emit EventBus events, update status DOM element --- {8 jobs: JOB_DISPOSE, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_INITIALIZE, JOB_START, JOB_STOP, JOB_UPDATE_DOM_ELEMENT, JOB_UPDATE_STATE}
 * Outgoing: EventBus.emit() (CONNECTION.* events), DOM updates (#status-indicator text/color) --- {event_types.custom_event, dom_types.chat_entry_element}
 * 
 * @module application/main/ConnectionMonitor
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

const { EventTypes, EventPriority } = require('../../core/events/EventTypes');

class ConnectionMonitor {
  constructor(options = {}) {
    // Dependencies
    this.guru = options.guruConnection || null;
    this.eventBus = options.eventBus || null;
    
    // Configuration
    this.statusElement = options.statusElement || null;
    this.checkInterval = options.checkInterval || 2000;
    this.enableLogging = options.enableLogging !== undefined ? options.enableLogging : false;
    
    // State
    this.intervalId = null;
    this.lastStatus = null;
    
    // Validation
    if (!this.guru) {
      throw new Error('[ConnectionMonitor] guru connection required');
    }
    
    if (!this.eventBus) {
      throw new Error('[ConnectionMonitor] eventBus required');
    }
  }

  /**
   * Start monitoring
   */
  start() {
    if (this.intervalId) {
      console.warn('[ConnectionMonitor] Already started');
      return;
    }

    // Initial check
    this.check();

    // Start interval
    this.intervalId = setInterval(() => this.check(), this.checkInterval);

    if (this.enableLogging) {
      console.log(`[ConnectionMonitor] Started (interval: ${this.checkInterval}ms)`);
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
        console.log('[ConnectionMonitor] Stopped');
      }
    }
  }

  /**
   * Check connection status
   * @returns {Object} Current status
   */
  check() {
    const status = this.getStatus();
    
    // Detect status change
    if (status.connected !== this.lastStatus?.connected) {
      this._onStatusChange(status);
    }

    this.lastStatus = status;
    this._updateUI(status);
    
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
      console.error('[ConnectionMonitor] Error checking status:', error);
    }

    return {
      connected,
      timestamp: Date.now(),
      details
    };
  }

  /**
   * Handle status change
   * @private
   */
  _onStatusChange(status) {
    if (this.enableLogging) {
      console.log('[ConnectionMonitor] Status changed:', status.connected ? 'ONLINE' : 'OFFLINE');
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
   * Update UI element
   * @private
   */
  _updateUI(status) {
    if (!this.statusElement) return;

    try {
      this.statusElement.textContent = status.connected ? 'ONLINE' : 'OFFLINE';
      this.statusElement.style.color = status.connected ? 'rgba(255, 255, 255, 0.9)' : '#ef4444';
    } catch (error) {
      console.error('[ConnectionMonitor] Error updating UI:', error);
    }
  }

  /**
   * Set status element
   * @param {HTMLElement} element - Status display element
   */
  setStatusElement(element) {
    this.statusElement = element;
    if (this.lastStatus) {
      this._updateUI(this.lastStatus);
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
      uptime: this.lastStatus ? Date.now() - this.lastStatus.timestamp : 0
    });
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    this.stop();
    this.statusElement = null;
    this.lastStatus = null;
    this.guru = null;
    this.eventBus = null;

    if (this.enableLogging) {
      console.log('[ConnectionMonitor] Disposed');
    }
  }
}

// Export
module.exports = ConnectionMonitor;

if (typeof window !== 'undefined') {
  window.ConnectionMonitor = ConnectionMonitor;
  console.log('📦 ConnectionMonitor loaded');
}

