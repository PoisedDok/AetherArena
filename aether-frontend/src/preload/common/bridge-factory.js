'use strict';

/**
 * @.architecture
 * 
 * Incoming: Preload scripts (main-preload.js, chat-preload.js, artifacts-preload.js) --- {preload_types.createBridge_options, object}
 * Processing: Create secure IPC bridge with 4-layer validation (channel whitelist, rate limit, size check, payload schema), manage listener registry, freeze bridge object --- {5 jobs: JOB_CREATE_BRIDGE, JOB_GET_STATE, JOB_INITIALIZE, JOB_SEND_IPC, JOB_VALIDATE_SCHEMA}
 * Outgoing: IPC bridge object (frozen) with send, invoke, on, once, removeListener, off, removeAllListeners, getMetadata, getStats --- {ipc_types.secure_bridge, frozen_object}
 * 
 * @module preload/common/bridge-factory
 * 
 * Bridge Factory
 * ============================================================================
 * Creates secure IPC bridges with validation, rate limiting, and size checks.
 * Combines channel whitelisting, payload validation, rate limiting, and size enforcement.
 * 
 * Security Features:
 * - Channel whitelisting (send/receive separation)
 * - Payload schema validation
 * - Rate limiting (prevents IPC flooding)
 * - Size validation (prevents memory exhaustion)
 * - Listener registry (proper cleanup)
 * 
 * @module preload/common/bridge-factory
 */

const { freeze, defineProperty } = Object;
const { getChannelConfig, canSend, canReceive } = require('../ipc/channels');
const { validatePayload } = require('../ipc/payload-schemas');
const { createRateLimiter } = require('./rate-limiter');
const { createSizeValidator } = require('./size-validator');

/**
 * Listener registry for proper cleanup
 */
function createListenerRegistry() {
  const registry = new Map();

  function remember(channel, original, wrapped) {
    if (!registry.has(channel)) {
      registry.set(channel, new Map());
    }
    registry.get(channel).set(original, wrapped);
  }

  function recall(channel, original) {
    const channelMap = registry.get(channel);
    if (!channelMap) return undefined;
    
    const wrapped = channelMap.get(original);
    if (wrapped) {
      channelMap.delete(original);
      if (channelMap.size === 0) {
        registry.delete(channel);
      }
    }
    return wrapped;
  }

  function dropChannel(channel) {
    registry.delete(channel);
  }

  return { remember, recall, dropChannel };
}

/**
 * Create secure IPC bridge
 * 
 * @param {Object} options - Bridge configuration
 * @param {Object} options.ipcRenderer - Electron ipcRenderer instance
 * @param {string} options.context - Window context name (mainWindow, chatWindow, artifactsWindow)
 * @param {Object} [options.rateLimiter] - Custom rate limiter options
 * @param {Object} [options.sizeValidator] - Custom size validator options
 * @param {boolean} [options.enableRateLimiting=true] - Enable rate limiting
 * @param {boolean} [options.enableSizeValidation=true] - Enable size validation
 * @param {boolean} [options.enablePayloadValidation=true] - Enable payload schema validation
 * @param {Function} [options.onError] - Error handler callback
 * @returns {Object} - Secure IPC bridge
 */
function createBridge(options = {}) {
  const {
    ipcRenderer,
    context = 'mainWindow',
    rateLimiter: rateLimiterOpts = {},
    sizeValidator: sizeValidatorOpts = {},
    enableRateLimiting = true,
    enableSizeValidation = true,
    enablePayloadValidation = true,
    onError = null,
  } = options;

  if (!ipcRenderer) {
    throw new Error('[Bridge Factory] ipcRenderer instance is required');
  }

  // Get channel configuration for this context
  const channelConfig = getChannelConfig(context);
  
  // Create rate limiter
  const rateLimiter = createRateLimiter({
    enabled: enableRateLimiting,
    ...rateLimiterOpts,
    onRateLimited: (channel, info) => {
      const error = new Error(`[IPC:${context}] Rate limited on channel "${channel}"`);
      console.warn(error.message, info);
      if (onError) onError(error, { channel, reason: 'rate_limit', ...info });
    },
  });
  
  // Create size validator
  const sizeValidator = createSizeValidator({
    enabled: enableSizeValidation,
    ...sizeValidatorOpts,
    onViolation: (channel, error, info) => {
      console.error(`[IPC:${context}] Size violation on channel "${channel}":`, error);
      if (onError) onError(new Error(error), { channel, reason: 'size_violation', ...info });
    },
  });
  
  // Create listener registry
  const listeners = createListenerRegistry();
  
  /**
   * Validate and prepare payload for sending
   * @param {string} channel - Channel name
   * @param {any} payload - Payload to send
   * @returns {Object} - { valid: boolean, error?: string }
   * @private
   */
  function validateSend(channel, payload) {
    // Check channel whitelist
    if (!canSend(channel, context)) {
      return {
        valid: false,
        error: `Channel "${channel}" not allowed for sending in ${context}`,
      };
    }
    
    // Check rate limit
    if (!rateLimiter.check(channel)) {
      return {
        valid: false,
        error: `Rate limited on channel "${channel}"`,
      };
    }
    
    // Check size
    if (enableSizeValidation) {
      const sizeResult = sizeValidator.validate(channel, payload);
      if (!sizeResult.valid) {
        return sizeResult;
      }
    }
    
    // Check payload schema
    if (enablePayloadValidation) {
      const payloadResult = validatePayload(channel, payload);
      if (!payloadResult.valid) {
        return payloadResult;
      }
    }
    
    return { valid: true };
  }
  
  /**
   * Validate channel for receiving
   * @param {string} channel - Channel name
   * @returns {Object} - { valid: boolean, error?: string }
   * @private
   */
  function validateReceive(channel) {
    if (!canReceive(channel, context)) {
      return {
        valid: false,
        error: `Channel "${channel}" not allowed for receiving in ${context}`,
      };
    }
    return { valid: true };
  }
  
  // Create bridge API
  const bridge = {
    /**
     * Send message to main process
     * @param {string} channel - Channel name
     * @param {any} payload - Payload to send
     * @throws {Error} If validation fails
     */
    send(channel, payload) {
      const validation = validateSend(channel, payload);
      if (!validation.valid) {
        const error = new Error(`[IPC:${context}] Send validation failed: ${validation.error}`);
        console.error(error.message);
        if (onError) onError(error, { channel, payload });
        throw error;
      }
      
      ipcRenderer.send(channel, payload);
    },

    /**
     * Invoke main process (request-response pattern)
     * @param {string} channel - Channel name
     * @param {any} payload - Payload to send
     * @returns {Promise<any>} - Response from main process
     * @throws {Error} If validation fails
     */
    async invoke(channel, payload) {
      const validation = validateSend(channel, payload);
      if (!validation.valid) {
        const error = new Error(`[IPC:${context}] Invoke validation failed: ${validation.error}`);
        console.error(error.message);
        if (onError) onError(error, { channel, payload });
        throw error;
      }
      
      if (typeof ipcRenderer.invoke !== 'function') {
        throw new Error('[IPC Bridge] ipcRenderer.invoke is not available in this context');
      }
      
      return ipcRenderer.invoke(channel, payload);
    },

    /**
     * Listen for messages from main process
     * @param {string} channel - Channel name
     * @param {Function} listener - Listener callback
     * @returns {Function} - Cleanup function
     * @throws {Error} If validation fails
     */
    on(channel, listener) {
      const validation = validateReceive(channel);
      if (!validation.valid) {
        const error = new Error(`[IPC:${context}] Receive validation failed: ${validation.error}`);
        console.error(error.message);
        if (onError) onError(error, { channel });
        throw error;
      }
      
      if (typeof listener !== 'function') {
        throw new TypeError('Listener must be a function');
      }
      
      // Wrap listener to strip event object
      const wrapped = (event, ...args) => listener(...args);
      listeners.remember(channel, listener, wrapped);
      ipcRenderer.on(channel, wrapped);
      
      // Return cleanup function
      return () => {
        ipcRenderer.removeListener(channel, wrapped);
      };
    },

    /**
     * Listen for single message from main process
     * @param {string} channel - Channel name
     * @param {Function} listener - Listener callback
     * @returns {Function} - Cleanup function
     * @throws {Error} If validation fails
     */
    once(channel, listener) {
      const validation = validateReceive(channel);
      if (!validation.valid) {
        const error = new Error(`[IPC:${context}] Receive validation failed: ${validation.error}`);
        console.error(error.message);
        if (onError) onError(error, { channel });
        throw error;
      }
      
      if (typeof listener !== 'function') {
        throw new TypeError('Listener must be a function');
      }
      
      const wrapped = (event, ...args) => listener(...args);
      listeners.remember(channel, listener, wrapped);
      ipcRenderer.once(channel, wrapped);
      
      return () => {
        ipcRenderer.removeListener(channel, wrapped);
      };
    },

    /**
     * Remove listener
     * @param {string} channel - Channel name
     * @param {Function} listener - Listener to remove
     */
    removeListener(channel, listener) {
      const validation = validateReceive(channel);
      if (!validation.valid) {
        console.warn(`[IPC:${context}] Cannot remove listener: ${validation.error}`);
        return;
      }
      
      const wrapped = listeners.recall(channel, listener);
      ipcRenderer.removeListener(channel, wrapped || listener);
    },

    /**
     * Alias for removeListener
     */
    off(channel, listener) {
      this.removeListener(channel, listener);
    },

    /**
     * Remove all listeners for channel
     * @param {string} channel - Channel name
     */
    removeAllListeners(channel) {
      const validation = validateReceive(channel);
      if (!validation.valid) {
        console.warn(`[IPC:${context}] Cannot remove listeners: ${validation.error}`);
        return;
      }
      
      listeners.dropChannel(channel);
      ipcRenderer.removeAllListeners(channel);
    },
    
    /**
     * Get bridge metadata
     * @returns {Object}
     */
    getMetadata() {
      return {
        context,
        sendChannels: Array.from(channelConfig.send),
        receiveChannels: Array.from(channelConfig.receive),
        rateLimiterEnabled: rateLimiter.enabled,
        sizeValidatorEnabled: sizeValidator.enabled,
        payloadValidationEnabled: enablePayloadValidation,
      };
    },
    
    /**
     * Get statistics
     * @returns {Object}
     */
    getStats() {
      return {
        rateLimiter: rateLimiter.getStats(),
        sizeValidator: sizeValidator.getStats(),
      };
    },
  };

  // Add non-enumerable metadata
  defineProperty(bridge, '__aetherGuarded', {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  defineProperty(bridge, '__aetherContext', {
    value: context,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  defineProperty(bridge, '__aetherRateLimiter', {
    value: rateLimiter,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  defineProperty(bridge, '__aetherSizeValidator', {
    value: sizeValidator,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return freeze(bridge);
}

module.exports = {
  createBridge,
};

