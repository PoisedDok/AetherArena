'use strict';

/**
 * @.architecture
 *
 * Incoming: preload/main-preload.js, preload/chat-preload.js, preload/artifacts-preload.js --- {ipcRenderer, javascript_api}
 * Processing: Create secure IPC bridge with channel whitelist, rate limiter, payload + size validators, listener registry, expose send/invoke helpers --- {5 jobs: JOB_CREATE_BRIDGE, JOB_DELEGATE_TO_MODULE, JOB_SEND_IPC, JOB_VALIDATE_SCHEMA, JOB_INITIALIZE}
 * Outgoing: Frozen IPC bridge surface (send/invoke/on/off) for renderer windows --- {ipc_types.secure_bridge, frozen_object}
 */

const { createLogger } = require('../../core/utils/logger');
const { freeze, defineProperty } = Object;
const { getChannelConfig, canSend, canReceive } = require('../ipc/channels');
const { validatePayload } = require('../ipc/payload-schemas');
const { createRateLimiter } = require('./rate-limiter');
const { createSizeValidator } = require('./size-validator');
const FORCE_PAYLOAD_VALIDATION_CHANNELS = new Set(['open-external-url']);

function createListenerRegistry() {
  const registry = new Map();

  return {
    remember(channel, original, wrapped) {
      if (!registry.has(channel)) {
        registry.set(channel, new Map());
      }
      registry.get(channel).set(original, wrapped);
    },
    recall(channel, original) {
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
    },
    dropChannel(channel) {
      registry.delete(channel);
    },
  };
}

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
    throw new Error('[SecureRendererBridge] ipcRenderer instance is required');
  }

  const log = createLogger({ component: `IPC:${context}` });
  const channelConfig = getChannelConfig(context);
  const rateLimiter = createRateLimiter({
    enabled: enableRateLimiting,
    ...rateLimiterOpts,
    onRateLimited: (channel, info) => {
      const error = new Error(`[IPC:${context}] Rate limited on channel "${channel}"`);
      log.warn('rate limited', { channel, ...info });
      if (onError) onError(error, { channel, reason: 'rate_limit', ...info });
    },
  });

  const sizeValidator = createSizeValidator({
    enabled: enableSizeValidation,
    ...sizeValidatorOpts,
    onViolation: (channel, error, info) => {
      log.error('size violation', { channel, error });
      if (onError) onError(new Error(error), { channel, reason: 'size_violation', ...info });
    },
  });

  const listeners = createListenerRegistry();

  function validateSend(channel, payload) {
    if (!canSend(channel, context)) {
      return { valid: false, error: `Channel "${channel}" not allowed for sending in ${context}` };
    }
    if (!rateLimiter.check(channel)) {
      return { valid: false, error: `Rate limited on channel "${channel}"` };
    }
    if (enableSizeValidation) {
      const sizeResult = sizeValidator.validate(channel, payload);
      if (!sizeResult.valid) {
        return sizeResult;
      }
    }
    if (enablePayloadValidation || FORCE_PAYLOAD_VALIDATION_CHANNELS.has(channel)) {
      const payloadResult = validatePayload(channel, payload);
      if (!payloadResult.valid) {
        return payloadResult;
      }
    }
    return { valid: true };
  }

  function validateReceive(channel) {
    if (!canReceive(channel, context)) {
      return { valid: false, error: `Channel "${channel}" not allowed for receiving in ${context}` };
    }
    return { valid: true };
  }

  const bridge = {
    send(channel, payload) {
      const validation = validateSend(channel, payload);
      if (!validation.valid) {
        const error = new Error(`[IPC:${context}] Send validation failed: ${validation.error}`);
        log.error('send validation failed', { channel, error: validation.error });
        if (onError) onError(error, { channel, payload });
        throw error;
      }
      ipcRenderer.send(channel, payload);
    },

    async invoke(channel, payload) {
      const validation = validateSend(channel, payload);
      if (!validation.valid) {
        const error = new Error(`[IPC:${context}] Invoke validation failed: ${validation.error}`);
        log.error('invoke validation failed', { channel, error: validation.error });
        if (onError) onError(error, { channel, payload });
        throw error;
      }

      if (typeof ipcRenderer.invoke !== 'function') {
        throw new Error('[IPC Bridge] ipcRenderer.invoke is not available in this context');
      }

      return ipcRenderer.invoke(channel, payload);
    },

    on(channel, listener) {
      const validation = validateReceive(channel);
      if (!validation.valid) {
        const error = new Error(`[IPC:${context}] Receive validation failed: ${validation.error}`);
        log.error('receive validation failed', { channel, error: validation.error });
        if (onError) onError(error, { channel });
        throw error;
      }
      if (typeof listener !== 'function') {
        throw new TypeError('Listener must be a function');
      }
      const wrapped = (event, ...args) => listener(...args);
      listeners.remember(channel, listener, wrapped);
      ipcRenderer.on(channel, wrapped);
      return () => {
        ipcRenderer.removeListener(channel, wrapped);
      };
    },

    once(channel, listener) {
      const validation = validateReceive(channel);
      if (!validation.valid) {
        const error = new Error(`[IPC:${context}] Receive validation failed: ${validation.error}`);
        log.error('receive validation failed', { channel, error: validation.error });
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

    removeListener(channel, listener) {
      const validation = validateReceive(channel);
      if (!validation.valid) {
        log.warn('cannot remove listener', { channel, error: validation.error });
        return;
      }
      const wrapped = listeners.recall(channel, listener);
      ipcRenderer.removeListener(channel, wrapped || listener);
    },

    off(channel, listener) {
      this.removeListener(channel, listener);
    },

    removeAllListeners(channel) {
      const validation = validateReceive(channel);
      if (!validation.valid) {
        log.warn('cannot remove listeners', { channel, error: validation.error });
        return;
      }
      listeners.dropChannel(channel);
      ipcRenderer.removeAllListeners(channel);
    },

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

    getStats() {
      return {
        rateLimiter: rateLimiter.getStats(),
        sizeValidator: sizeValidator.getStats(),
      };
    },
  };

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
