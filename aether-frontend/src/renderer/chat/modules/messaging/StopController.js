'use strict';

/**
 * @.architecture
 * 
 * Incoming: User stop button click, SendController (pending request ID) --- {string | null, requestId}
 * Processing: Get pending request ID from multiple sources, validate stop method availability, route to endpoint or IPC, clear state, emit events --- {4 jobs: JOB_GET_STATE, JOB_DELEGATE_TO_MODULE, JOB_UPDATE_STATE, JOB_EMIT_EVENT}
 * Outgoing: Endpoint.connection.stopRequest() → GuruConnection → Backend WebSocket stop message, OR IpcBridge → Main Process → GuruConnection --- {stop_request, json}
 * 
 * 
 * @module renderer/chat/modules/messaging/StopController
 */

class StopController {
  constructor(options = {}) {
    this.endpoint = options.endpoint || null;
    this.ipcBridge = options.ipcBridge || null;
    this.eventBus = options.eventBus || null;
    this.sendController = options.sendController || null;

    // State
    this.isStopping = false;

    console.log('[StopController] Constructed');
  }

  /**
   * Initialize stop controller
   */
  init() {
    console.log('[StopController] Initialized');
  }

  /**
   * Stop the current request
   * @param {string} [requestId] - Optional specific request ID to stop
   * @returns {Promise<boolean>} Whether stop was successful
   */
  async stop(requestId = null) {
    if (this.isStopping) {
      console.warn('[StopController] Already stopping');
      return false;
    }

    try {
      this.isStopping = true;

      // Get request ID
      const targetRequestId = requestId || this._getPendingRequestId();

      if (!targetRequestId) {
        console.warn('[StopController] No request ID to stop');
        return false;
      }

      console.log(`[StopController] Stopping request: ${targetRequestId}`);

      // Emit event
      if (this.eventBus) {
        this.eventBus.emit('request:stopping', {
          requestId: targetRequestId,
          timestamp: Date.now()
        });
      }

      let success = false;

      // Try direct endpoint first
      if (this._canUseDirectEndpoint()) {
        success = await this._stopViaEndpoint(targetRequestId);
      } else if (this._canUseIPC()) {
        // Fallback to IPC
        success = await this._stopViaIPC(targetRequestId);
      } else {
        console.warn('[StopController] No communication method available');
      }

      // Clear pending request
      if (this.sendController) {
        this.sendController.clearPendingRequestId();
      }

      // Emit event
      if (this.eventBus) {
        this.eventBus.emit('request:stopped', {
          requestId: targetRequestId,
          success,
          timestamp: Date.now()
        });
      }

      console.log(`[StopController] Stop ${success ? 'successful' : 'failed'}: ${targetRequestId}`);
      return success;
    } catch (error) {
      console.error('[StopController] Stop failed:', error);

      // Emit error event
      if (this.eventBus) {
        this.eventBus.emit('request:stop-error', {
          error: error.message,
          timestamp: Date.now()
        });
      }

      return false;
    } finally {
      this.isStopping = false;
    }
  }

  /**
   * Stop via direct endpoint
   * @private
   * @param {string} requestId - Request ID to stop
   * @returns {Promise<boolean>}
   */
  async _stopViaEndpoint(requestId) {
    try {
      const endpoint = this.endpoint || window.endpoint;

      if (!endpoint) {
        throw new Error('Endpoint not available');
      }

      // Try connection stopRequest method
      if (endpoint.connection && typeof endpoint.connection.stopRequest === 'function') {
        await endpoint.connection.stopRequest(requestId);
        console.log('[StopController] Stopped via endpoint.connection');
        return true;
      }

      // Try direct stopRequest method
      if (typeof endpoint.stopRequest === 'function') {
        await endpoint.stopRequest(requestId);
        console.log('[StopController] Stopped via endpoint');
        return true;
      }

      console.warn('[StopController] No stop method available on endpoint');
      return false;
    } catch (error) {
      console.error('[StopController] Endpoint stop failed:', error);
      return false;
    }
  }

  /**
   * Stop via IPC
   * @private
   * @param {string} requestId - Request ID to stop
   * @returns {Promise<boolean>}
   */
  async _stopViaIPC(requestId) {
    try {
      const ipc = this.ipcBridge || window.ipcBridge || window.ipc;

      if (!ipc || !ipc.send) {
        throw new Error('IPC not available');
      }

      // Send stop request via IPC
      ipc.send('chat:stop', { requestId });
      console.log('[StopController] Stop sent via IPC');
      return true;
    } catch (error) {
      console.error('[StopController] IPC stop failed:', error);
      return false;
    }
  }

  /**
   * Get pending request ID from various sources
   * @private
   * @returns {string|null}
   */
  _getPendingRequestId() {
    // Try SendController
    if (this.sendController && this.sendController.getPendingRequestId) {
      const id = this.sendController.getPendingRequestId();
      if (id) return id;
    }

    // Try global sources
    if (typeof window !== 'undefined') {
      if (window.pendingRequestId) return window.pendingRequestId;
      if (window.EventHandlerInstance && window.EventHandlerInstance.pendingRequestId) {
        return window.EventHandlerInstance.pendingRequestId;
      }
    }

    return null;
  }

  /**
   * Check if direct endpoint is available
   * @private
   * @returns {boolean}
   */
  _canUseDirectEndpoint() {
    const endpoint = this.endpoint || window.endpoint;
    return !!(endpoint && (
      (endpoint.connection && endpoint.connection.stopRequest) ||
      endpoint.stopRequest
    ));
  }

  /**
   * Check if IPC is available
   * @private
   * @returns {boolean}
   */
  _canUseIPC() {
    const ipc = this.ipcBridge || window.ipcBridge || window.ipc;
    return !!(ipc && ipc.send);
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
    console.log('[StopController] Disposing...');

    this.isStopping = false;
    this.endpoint = null;
    this.ipcBridge = null;
    this.eventBus = null;
    this.sendController = null;

    console.log('[StopController] Disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StopController;
}

if (typeof window !== 'undefined') {
  window.StopController = StopController;
  console.log('📦 StopController loaded');
}

