'use strict';

/**
 * @.architecture
 * 
 * Incoming: User input from DOM (textarea), SessionManager (correlation IDs) --- {string, text}
 * Processing: Validate content, check connection status, route to endpoint or IPC, generate/track request ID, emit events --- {4 jobs: JOB_DELEGATE_TO_MODULE, JOB_GET_STATE, JOB_UPDATE_STATE, JOB_EMIT_EVENT}
 * Outgoing: Endpoint.sendUserMessage() → GuruConnection → Backend WebSocket, OR IpcBridge → Main Process → GuruConnection --- {user_message, json}
 * 
 * 
 * @module renderer/chat/modules/messaging/SendController
 */

class SendController {
  constructor(options = {}) {
    this.endpoint = options.endpoint || null;
    this.ipcBridge = options.ipcBridge || null;
    this.eventBus = options.eventBus || null;

    // State
    this.pendingRequestId = null;
    this.isSending = false;

    console.log('[SendController] Constructed');
  }

  /**
   * Initialize send controller
   */
  init() {
    console.log('[SendController] Initialized');
  }

  /**
   * Send a message
   * @param {string} content - Message content
   * @param {Object} options - Send options
   * @param {string} [options.correlationId] - Correlation ID for tracing
   * @returns {Promise<string|null>} Request ID if successful
   */
  async send(content, options = {}) {
    if (!content || typeof content !== 'string') {
      console.warn('[SendController] Invalid content:', content);
      return null;
    }

    if (this.isSending) {
      console.warn('[SendController] Already sending a message');
      return null;
    }

    try {
      this.isSending = true;

      // Emit event
      if (this.eventBus) {
        this.eventBus.emit('message:sending', {
          content,
          timestamp: Date.now()
        });
      }

      let requestId = null;

      // Determine communication method
      if (this._canUseDirectEndpoint()) {
        requestId = await this._sendViaEndpoint(content, options);
      } else if (this._canUseIPC()) {
        requestId = await this._sendViaIPC(content, options);
      } else {
        console.error('[SendController] No communication method available');
        throw new Error('No backend communication available');
      }

      // Track request ID
      this.pendingRequestId = requestId;

      // Emit event
      if (this.eventBus) {
        this.eventBus.emit('message:sent', {
          content,
          requestId,
          timestamp: Date.now()
        });
      }

      console.log(`[SendController] Message sent with requestId: ${requestId}`);
      return requestId;
    } catch (error) {
      console.error('[SendController] Send failed:', error);

      // Emit error event
      if (this.eventBus) {
        this.eventBus.emit('message:send-error', {
          content,
          error: error.message,
          timestamp: Date.now()
        });
      }

      throw error;
    } finally {
      this.isSending = false;
    }
  }

  /**
   * Send via direct endpoint (GuruConnection)
   * @private
   * @param {string} content - Message content
   * @param {Object} options - Send options
   * @returns {Promise<string|null>} Request ID
   */
  async _sendViaEndpoint(content, options) {
    try {
      // Get endpoint from window or options
      const endpoint = this.endpoint || window.endpoint;

      if (!endpoint || !endpoint.sendUserMessage) {
        throw new Error('Endpoint not available');
      }

      // Check connection
      if (!this._isEndpointConnected(endpoint)) {
        console.warn('[SendController] Endpoint not connected');
      }

      // Send message
      // Use correlationId as request ID if provided, otherwise endpoint will generate one
      const requestId = endpoint.sendUserMessage(content, options.correlationId);

      console.log(`[SendController] Sent via endpoint: ${requestId}`);
      return requestId;
    } catch (error) {
      console.error('[SendController] Endpoint send failed:', error);
      throw error;
    }
  }

  /**
   * Send via IPC (detached windows)
   * @private
   * @param {string} content - Message content
   * @param {Object} options - Send options
   * @returns {Promise<string|null>} Request ID
   */
  async _sendViaIPC(content, options) {
    try {
      const ipc = this.ipcBridge || window.ipcBridge || window.ipc;

      if (!ipc || !ipc.send) {
        throw new Error('IPC not available');
      }

      // Generate request ID
      const requestId = this._generateRequestId();

      // Send via IPC
      ipc.send('chat:send', {
        message: content,
        requestId,
        correlationId: options.correlationId
      });

      console.log(`[SendController] Sent via IPC: ${requestId}`);
      return requestId;
    } catch (error) {
      console.error('[SendController] IPC send failed:', error);
      throw error;
    }
  }

  /**
   * Check if direct endpoint is available and connected
   * @private
   * @returns {boolean}
   */
  _canUseDirectEndpoint() {
    const endpoint = this.endpoint || window.endpoint;
    return !!(endpoint && endpoint.sendUserMessage);
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
   * Check if endpoint is connected
   * @private
   * @param {Object} endpoint - Endpoint object
   * @returns {boolean}
   */
  _isEndpointConnected(endpoint) {
    if (!endpoint) return false;

    // Check GuruConnection
    if (endpoint.connection && typeof endpoint.connection.isConnected === 'boolean') {
      return endpoint.connection.isConnected;
    }

    // Check WebSocket
    if (endpoint.ws && endpoint.ws.readyState === 1) {
      return true;
    }

    // Assume connected if no clear status
    return true;
  }

  /**
   * Generate request ID
   * @private
   * @returns {string}
   */
  _generateRequestId() {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get pending request ID
   * @returns {string|null}
   */
  getPendingRequestId() {
    return this.pendingRequestId;
  }

  /**
   * Clear pending request ID
   */
  clearPendingRequestId() {
    this.pendingRequestId = null;
  }

  /**
   * Check if currently sending
   * @returns {boolean}
   */
  isSendingMessage() {
    return this.isSending;
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    console.log('[SendController] Disposing...');

    this.pendingRequestId = null;
    this.isSending = false;
    this.endpoint = null;
    this.ipcBridge = null;
    this.eventBus = null;

    console.log('[SendController] Disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SendController;
}

if (typeof window !== 'undefined') {
  window.SendController = SendController;
  console.log('📦 SendController loaded');
}

