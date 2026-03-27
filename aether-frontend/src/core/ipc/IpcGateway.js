'use strict';

/**
 * @.architecture
 *
 * Incoming: Renderer modules (SendController, MessageManager, FileManager, etc.) request IPC operations --- {method_calls, javascript_api}
 * Processing: Centralize access to Electron IPC bridge (window.aether.ipc or injected bridge), validate availability, expose safe wrappers for send/on/once/invoke/removeAllListeners --- {4 jobs: JOB_INITIALIZE, JOB_VALIDATE_SCHEMA, JOB_DELEGATE_TO_MODULE, JOB_SEND_IPC}
 * Outgoing: ipcBridge.send/on/once/invoke/removeListener calls routed through a single gateway --- {ipc_message, javascript_api}
 *
 * @module core/ipc/IpcGateway
 */

const NOOP = () => {};

class IpcGateway {
  constructor(options = {}) {
    this.bridge = options.bridge || IpcGateway._resolveBridge();

    if (!this.bridge) {
      throw new Error('[IpcGateway] IPC bridge not available');
    }
  }

  static _resolveBridge() {
    if (typeof window === 'undefined') {
      return null;
    }

    if (window.aether && window.aether.ipc) {
      return window.aether.ipc;
    }

    return null;
  }

  _require(method) {
    if (!this.bridge || typeof this.bridge[method] !== 'function') {
      throw new Error(`[IpcGateway] IPC bridge missing method: ${method}`);
    }
    return this.bridge[method].bind(this.bridge);
  }

  send(channel, payload) {
    this._require('send')(channel, payload);
  }

  invoke(channel, payload) {
    return this._require('invoke')(channel, payload);
  }

  on(channel, handler) {
    const onMethod = this._require('on');
    const cleanup = onMethod(channel, handler);

    if (typeof cleanup === 'function') {
      return cleanup;
    }

    return () => this.off(channel, handler);
  }

  once(channel, handler) {
    const onceMethod = this._require('once');
    onceMethod(channel, handler);
  }

  off(channel, handler) {
    if (this.bridge && typeof this.bridge.removeListener === 'function') {
      this.bridge.removeListener(channel, handler);
    }
  }

  removeAllListeners(pattern) {
    if (this.bridge && typeof this.bridge.removeAllListeners === 'function') {
      this.bridge.removeAllListeners(pattern);
    }
  }

  getMetadata() {
    if (this.bridge && typeof this.bridge.getMetadata === 'function') {
      return this.bridge.getMetadata();
    }
    return {};
  }

  getStats() {
    if (this.bridge && typeof this.bridge.getStats === 'function') {
      return this.bridge.getStats();
    }
    return {};
  }

  static noop() {
    return NOOP;
  }
}

module.exports = { IpcGateway };
