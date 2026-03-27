'use strict';

/**
 * @.architecture
 *
 * Incoming: DOM '.stop-mode' button events, SendController.getPendingRequestId() --- {event.dom | state.chat_session, Event | object}
 * Processing: Resolve pending request ID, emit lifecycle telemetry, dispatch WebSocket stop (primary) or IPC (fallback) --- {3 jobs: JOB_EMIT_EVENT, JOB_SEND_WEBSOCKET, JOB_UPDATE_STATE}
 * Outgoing: GuruConnection.stopRequest() → Backend control_handler, EventBus EventTypes.CHAT.REQUEST_STOPPED --- {websocket.stop_message | event.custom, json | json}
 *
 * CRITICAL FIX: Now sends stop via WebSocket to backend (was IPC-only, which never reached backend).
 * Flow: Stop button → StopController.stop() → window.endpoint.connection.stopRequest(requestId) → Backend StopMessage
 *
 * @module renderer/chat/modules/messaging/StopController
 */

const { EventTypes } = require('../../../../core/events/EventTypes');
const { logger } = require('../../../../core/utils/logger');
const { parseSessionId } = require('../../../../core/session/SessionManager');

class StopController {
  constructor(options = {}) {
    this.ipc = options.ipc || null;
    this.eventBus = options.eventBus || null;
    this.sendController = options.sendController || null;
    this.endpoint = options.endpoint || null;

    // State
    this.isStopping = false;
    this.log = logger.child({ module: 'StopController' });
    this.metrics = {
      attempts: 0,
      failures: 0
    };

    // Lifecycle
    this._isDisposed = false;

    this.log.debug('constructed');
  }

  /**
   * Initialize stop controller
   */
  init() {
    if (this._isDisposed) return;
    this.log.info('initialized');
  }

  /**
   * Stop the current request
   * @param {string} [requestId] - Optional specific request ID to stop
   * @returns {Promise<boolean>} Whether stop was successful
   */
  async stop(requestId = null) {
    if (this._isDisposed) return false;

    if (this.isStopping) {
      this.log.warn('stop request ignored - already stopping');
      return false;
    }

    // Get request ID
    const targetRequestId = requestId || this._getPendingRequestId();

    if (!targetRequestId) {
      this.log.warn('no pending request to stop');
      return false;
    }

    const correlationId = this._deriveCorrelationId(targetRequestId);
    const channel = this._resolveStopChannel();

    this.metrics.attempts += 1;
    this.isStopping = true;

    try {
      if (!channel) {
        this.metrics.failures += 1;
        this._emitStopEvent(EventTypes?.CHAT?.MESSAGE_ERROR || 'chat:message:error', {
          requestId: targetRequestId,
          correlationId,
          error: 'No stop channel available (WebSocket or IPC)',
          timestamp: Date.now()
        });
        return false;
      }

      this._emitStopEvent(EventTypes?.CHAT?.STOP_REQUESTED || 'chat:stop:requested', {
        requestId: targetRequestId,
        correlationId,
        channel,
        timestamp: Date.now()
      });

      const success = await this._stopViaIPC(targetRequestId, channel);

      if (success && this.sendController) {
        this.sendController.clearPendingRequestId();
      }

      this._emitStopEvent(EventTypes?.CHAT?.REQUEST_STOPPED || 'chat:request:stopped', {
        requestId: targetRequestId,
        correlationId,
        success,
        channel,
        timestamp: Date.now()
      });

      if (!success) {
        this.metrics.failures += 1;
        this.log.warn('stop failed', { requestId: targetRequestId, channel });
      } else {
        this.log.info('stop succeeded', { requestId: targetRequestId, channel });
      }

      return success;
    } catch (error) {
      this.metrics.failures += 1;
      this.log.error('stop failed with error', { error: error.message, requestId: targetRequestId });
      this._emitStopEvent(EventTypes?.CHAT?.MESSAGE_ERROR || 'chat:message:error', {
        requestId: targetRequestId,
        correlationId,
        error: error.message,
        timestamp: Date.now()
      });
      return false;
    } finally {
      this.isStopping = false;
    }
  }

  /**
   * Stop via WebSocket (primary) with IPC fallback
   * @private
   * @param {string} requestId - Request ID to stop
   * @returns {Promise<boolean>}
   */
  async _stopViaIPC(requestId, channel = null) {
    try {
      // CRITICAL FIX: Use WebSocket to send stop command to backend
      // Frontend → GuruConnection.stopRequest() → Backend control_handler.handle_stop()
      // Previous bug: Only sent Electron IPC, which never reached backend
      
      const allowWebSocket = !channel || channel === 'websocket';
      const allowIPC = !channel || channel === 'ipc';

      // Try WebSocket first (primary method)
      if (
        allowWebSocket &&
        this.endpoint &&
        this.endpoint.connection &&
        typeof this.endpoint.connection.stopRequest === 'function'
      ) {
        this.endpoint.connection.stopRequest(requestId);
        this.log.debug('stop sent via WebSocket', { requestId });
        return true;
      }

      // Fallback to IPC (legacy, but kept for compatibility)
      if (allowIPC && this.ipc && typeof this.ipc.send === 'function') {
        this.ipc.send('chat:stop', { requestId });
        this.log.warn('stop sent via IPC fallback (WebSocket unavailable)', { requestId });
        return true;
      }

      throw new Error('No communication channel available (WebSocket or IPC)');
    } catch (error) {
      this.log.error('stop failed', { error: error.message });
      return false;
    }
  }

  /**
   * Get pending request ID from various sources
   * @private
   * @returns {string|null}
   */
  _getPendingRequestId() {
    // ONLY use SendController - NO global window pollution
    if (this.sendController && this.sendController.getPendingRequestId) {
      return this.sendController.getPendingRequestId();
    }
    return null;
  }

  /**
   * Resolve available stop channel.
   * @private
   * @returns {string|null}
   */
  _resolveStopChannel() {
    if (
      this.endpoint &&
      this.endpoint.connection &&
      typeof this.endpoint.connection.stopRequest === 'function'
    ) {
      return 'websocket';
    }
    if (this.ipc && typeof this.ipc.send === 'function') {
      return 'ipc';
    }
    return null;
  }

  /**
   * Check if currently stopping
   * @returns {boolean}
   */
  isStoppingRequest() {
    return this.isStopping;
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;

    this.log.info('disposing');

    this.isStopping = false;
    this.ipc = null;
    this.eventBus = null;
    this.sendController = null;

    this.log.info('disposed');
  }

  _deriveCorrelationId(requestId) {
    const parsed = typeof requestId === 'string' && parseSessionId ? parseSessionId(requestId) : null;
    return parsed ? requestId : null;
  }

  _emitStopEvent(eventType, payload) {
    if (!this.eventBus) return;
    this.eventBus.emit(eventType, payload);
  }

}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StopController;
}

if (typeof window !== 'undefined') {
  window.StopController = StopController;
  logger.child({ module: 'StopController' }).debug('StopController module loaded');
}
