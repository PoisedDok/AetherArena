'use strict';

/**
 * @.architecture
 *
 * Incoming: IPC send/stop requests with payloads --- {ipc_request, object}
 * Processing: Route to IPC bridge, handle fallback chains --- {2 jobs: JOB_SEND_IPC, JOB_VALIDATE_TRANSPORT}
 * Outgoing: IPC channel messages (chat:send, chat:stop) --- {ipc.message, void}
 *
 * @module renderer/chat/modules/messaging/transport/IPCTransportManager
 */

const { createRendererLogger } = require('../../../../shared/utils/logger');

const transportLogger = createRendererLogger('IPCTransportManager');

/**
 * IPCTransportManager - IPC Communication Abstraction
 * ====================================================
 * 
 * SINGLE RESPONSIBILITY: Abstract IPC transport logic
 * 
 * TRANSPORT REQUIREMENT:
 * Injected IPC bridge is REQUIRED. NO fallbacks, NO window globals.
 * 
 * CONTRACTS:
 * - NO business logic
 * - Pure IPC abstraction
 * - Fail fast if no transport available
 * 
 * @module renderer/chat/modules/messaging/transport/IPCTransportManager
 */
class IPCTransportManager {
  constructor(options = {}) {
    this.ipc = options.ipc || null;
    this.log = transportLogger.child({ scope: 'ipc-transport-manager' });

    if (!this.ipc) {
      throw new Error('[IPCTransportManager] ipc is REQUIRED');
    }

    this.log.info('IPCTransportManager initialized');
  }

  /**
   * Send IPC message
   * @param {string} channel - IPC channel
   * @param {Object} payload - Message payload
   * @returns {boolean} Success
   */
  send(channel, payload) {
    if (!this.ipc || typeof this.ipc.send !== 'function') {
      this.log.error('IPC bridge unavailable', { channel });
      return false;
    }

    try {
      this.ipc.send(channel, payload);
      this.log.trace('IPC sent', { channel });
      return true;
    } catch (err) {
      this.log.error('IPC send failed', { channel, error: err.message });
      return false;
    }
  }

  /**
   * Check if IPC is available
   * @returns {boolean}
   */
  isAvailable() {
    return Boolean(this.ipc && typeof this.ipc.send === 'function');
  }

  /**
   * Send chat message
   * @param {string} content - Message content
   * @param {Object} metadata - Request metadata
   * @returns {boolean} Success
   */
  sendChatMessage(content, metadata = {}) {
    const {
      requestId,
      correlationId,
      chatId,
      metadata: explicitMessageMetadata
    } = metadata;

    const derivedMessageMetadata = (
      explicitMessageMetadata &&
      typeof explicitMessageMetadata === 'object' &&
      !Array.isArray(explicitMessageMetadata) &&
      Object.keys(explicitMessageMetadata).length > 0
    )
      ? { ...explicitMessageMetadata }
      : null;

    const payload = {
      message: content,
      requestId,
      correlationId,
      chatId
    };
    if (derivedMessageMetadata) {
      payload.metadata = derivedMessageMetadata;
    }

    return this.send('chat:send', payload);
  }

  /**
   * Send stop request
   * @param {string} requestId - Request ID to stop
   * @returns {boolean} Success
   */
  sendStopRequest(requestId) {
    return this.send('chat:stop', { requestId });
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    this.ipc = null;
    this.log.info('IPCTransportManager disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = IPCTransportManager;
}

if (typeof window !== 'undefined') {
  window.IPCTransportManager = IPCTransportManager;
}
