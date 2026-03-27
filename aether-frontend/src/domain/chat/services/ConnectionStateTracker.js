'use strict';

/**
 * @.architecture
 * 
 * Incoming: WebSocket connection events (open, close, error) --- {connection_event, object}
 * Processing: Track connection state, detect state changes, manage event handlers --- {3 jobs: JOB_TRACK_ENTITY, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA}
 * Outgoing: Connection state, state change notifications --- {boolean | state_object, primitive}
 * 
 * @module domain/chat/services/ConnectionStateTracker
 */

const { createLogger } = require('../../../core/utils/logger');

/**
 * ConnectionStateTracker - Pure Domain Service for Backend Connection State
 * ==========================================================================
 * 
 * SINGLE RESPONSIBILITY: Track and manage backend WebSocket connection state
 * 
 * ARCHITECTURE:
 * - Domain layer (NO I/O, NO direct WebSocket management)
 * - Pure state tracking logic
 * - Event handler registration/cleanup
 * 
 * CONTRACTS:
 * - WebSocket connection object REQUIRED for setup
 * - State changes trigger callbacks (application layer handles events)
 * - NO direct event emission (delegates to application)
 * 
 * RESPONSIBILITIES:
 * - Register WebSocket event listeners
 * - Track connection state (connected/disconnected)
 * - Detect state changes
 * - Cleanup event handlers
 * - Provide state queries
 * 
 * NOT RESPONSIBLE FOR:
 * - WebSocket creation/management (infrastructure layer)
 * - Event bus emission (application layer)
 * - IPC notifications (application layer)
 * - UI updates (renderer layer)
 */
class ConnectionStateTracker {
  constructor(options = {}) {
    this.enableLogging = options.enableLogging || false;
    this.logger = options.logger || createLogger({ component: 'ConnectionStateTracker' });
    
    // Connection state
    this._isConnected = false;
    this._lastReason = null;
    this._lastError = null;
    
    // Event handlers tracking for cleanup
    this._handlers = [];
    
    // WebSocket connection reference (for listener management)
    this._connection = null;
    
    // State change callback (application layer provides this)
    this._onStateChange = options.onStateChange || null;
  }

  // Default logger removed -- createLogger({ component }) used in constructor fallback

  /**
   * Setup connection listeners
   * CONTRACT: connection object REQUIRED with .on() method
   * 
   * @param {Object} connection - WebSocket connection object (REQUIRED)
   * @param {Function} onStateChange - Callback for state changes (optional, can be set later)
   * @throws {Error} If connection invalid
   */
  setup(connection, onStateChange = null) {
    // STRICT CONTRACT ENFORCEMENT
    if (!connection || typeof connection !== 'object') {
      throw new Error(
        '[ConnectionStateTracker] CONTRACT VIOLATION: connection REQUIRED as object. ' +
        `Received: ${typeof connection}`
      );
    }

    if (typeof connection.on !== 'function') {
      throw new Error(
        '[ConnectionStateTracker] CONTRACT VIOLATION: connection must have .on() method for event registration'
      );
    }

    this._connection = connection;
    
    if (onStateChange && typeof onStateChange === 'function') {
      this._onStateChange = onStateChange;
    }

    // Register event handlers
    this._registerHandler('open', () => {
      this._handleConnectionOpen();
    });

    this._registerHandler('close', () => {
      this._handleConnectionClose();
    });

    this._registerHandler('error', (error) => {
      this._handleConnectionError(error);
    });

    // Sync initial state if connection has getStats
    if (typeof connection.getStats === 'function') {
      const stats = connection.getStats();
      const initialState = Boolean(stats && stats.connected);
      this._updateState(initialState, 'websocket-sync', null);
    }

    this.logger.debug('Connection listeners registered');
  }

  /**
   * Register event handler and track for cleanup
   * PRIVATE: Internal handler management
   * 
   * @param {string} event - Event name
   * @param {Function} handler - Event handler function
   * @private
   */
  _registerHandler(event, handler) {
    if (!this._connection) {
      throw new Error('[ConnectionStateTracker] Connection not set. Call setup() first.');
    }

    this._connection.on(event, handler);
    this._handlers.push({ event, handler });
  }

  /**
   * Handle connection open event
   * @private
   */
  _handleConnectionOpen() {
    this._updateState(true, 'websocket-open', null);
  }

  /**
   * Handle connection close event
   * @private
   */
  _handleConnectionClose() {
    this._updateState(false, 'websocket-close', null);
  }

  /**
   * Handle connection error event
   * @private
   */
  _handleConnectionError(error) {
    this._updateState(false, 'websocket-error', error);
  }

  /**
   * Update connection state
   * PRIVATE: Core state management logic
   * 
   * @param {boolean} isConnected - New connection state
   * @param {string} reason - Reason for state change
   * @param {Error} error - Error object if applicable
   * @private
   */
  _updateState(isConnected, reason = null, error = null) {
    const normalized = Boolean(isConnected);
    const previous = this._isConnected;

    // No change - skip notification
    if (previous === normalized) {
      this.logger.debug(`Connection state unchanged: ${normalized}, reason: ${reason}`);
      return;
    }

    // Update state
    this._isConnected = normalized;
    this._lastReason = reason;
    this._lastError = error;

    this.logger.info(`Connection state changed: ${previous} → ${normalized}, reason: ${reason}`);

    // Notify application layer via callback
    if (this._onStateChange && typeof this._onStateChange === 'function') {
      try {
        this._onStateChange({
          isConnected: normalized,
          previousState: previous,
          reason,
          error,
          timestamp: Date.now()
        });
      } catch (callbackError) {
        this.logger.error('State change callback failed:', callbackError);
      }
    }
  }

  /**
   * Cleanup event handlers
   * Call when disposing orchestrator or switching connections
   */
  cleanup() {
    if (!this._connection) {
      return;
    }

    if (typeof this._connection.removeListener === 'function') {
      for (const { event, handler } of this._handlers) {
        try {
          this._connection.removeListener(event, handler);
        } catch (error) {
          this.logger.warn(`Failed to remove listener for ${event}:`, error);
        }
      }
    }

    this._handlers = [];
    this._connection = null;

    this.logger.debug('Connection listeners cleaned up');
  }

  /**
   * Get current connection state
   * 
   * @returns {boolean} True if connected
   */
  isConnected() {
    return this._isConnected;
  }

  /**
   * Get last connection reason
   * 
   * @returns {string|null} Last reason for state change
   */
  getLastReason() {
    return this._lastReason;
  }

  /**
   * Get last error
   * 
   * @returns {Error|null} Last error if any
   */
  getLastError() {
    return this._lastError;
  }

  /**
   * Get full state info
   * 
   * @returns {Object} Complete state information
   */
  getState() {
    return {
      isConnected: this._isConnected,
      lastReason: this._lastReason,
      lastError: this._lastError ? this._lastError.message : null,
      hasConnection: Boolean(this._connection),
      handlerCount: this._handlers.length
    };
  }

  /**
   * Set state change callback
   * Can be called after construction to set/update callback
   * 
   * @param {Function} callback - State change callback
   */
  setStateChangeCallback(callback) {
    if (callback && typeof callback !== 'function') {
      throw new Error('[ConnectionStateTracker] Callback must be a function');
    }
    this._onStateChange = callback;
  }

  /**
   * Get statistics
   * 
   * @returns {Object} Tracker statistics
   */
  getStats() {
    return {
      isConnected: this._isConnected,
      lastReason: this._lastReason,
      hasConnection: Boolean(this._connection),
      handlerCount: this._handlers.length,
      hasCallback: Boolean(this._onStateChange)
    };
  }
}

module.exports = { ConnectionStateTracker };
