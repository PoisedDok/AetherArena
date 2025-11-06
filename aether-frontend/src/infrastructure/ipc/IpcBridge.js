'use strict';

/**
 * @.architecture
 * 
 * Incoming: Renderer modules (UIManager.js, MessageManager.js, ChatController.js via .send/.on/.once methods), Main process (via window.aether.ipc from preload scripts) --- {method_calls | ipc_message, javascript_api}
 * Processing: Wraps window.aether.ipc, queues messages pre-initialization, tracks listeners for cleanup, flush queue, remove listeners, gather statistics --- {5 jobs: JOB_CLEAR_STATE, JOB_DISPOSE, JOB_GET_STATE, JOB_SEND_IPC, JOB_TRACK_ENTITY}
 * Outgoing: window.aether.ipc.send() → Main process (via preload contextBridge), Renderer callbacks (via wrapped .on/.once handlers) --- {ipc_message, any}
 * 
 * 
 * @module infrastructure/ipc/IpcBridge
 * 
 * IpcBridge - Renderer process IPC communication wrapper
 * ============================================================================
 * Production-grade IPC wrapper for renderer processes:
 * - Type-safe channel communication
 * - Automatic cleanup on destruction
 * - Event queueing during initialization
 * - Error handling
 * 
 * Uses the secure IPC API exposed by preload scripts via contextBridge.
 */

const { freeze } = Object;

class IpcBridge {
  constructor(options = {}) {
    this.context = options.context || 'renderer';
    this.enableLogging = options.enableLogging || false;
    
    // Get IPC API from preload (window.aether.ipc)
    this.ipc = this._getIpcAPI();
    
    // Message queue for early sends
    this.messageQueue = [];
    this.isReady = !!this.ipc;
    
    // Listener tracking for cleanup
    this.listeners = new Map();
    
    if (!this.ipc) {
      console.warn(`[IpcBridge:${this.context}] IPC API not available, queueing messages`);
    }
  }

  /**
   * Send message to main process
   * @param {string} channel - IPC channel
   * @param {*} payload - Message payload
   * @returns {boolean} Success status
   */
  send(channel, payload) {
    if (!this.ipc) {
      this._queueMessage(channel, payload);
      return false;
    }
    
    try {
      this.ipc.send(channel, payload);
      
      if (this.enableLogging) {
        console.log(`[IpcBridge:${this.context}] Sent:`, channel, payload);
      }
      
      return true;
    } catch (error) {
      console.error(`[IpcBridge:${this.context}] Failed to send on ${channel}:`, error);
      return false;
    }
  }

  /**
   * Register listener for channel
   * @param {string} channel - IPC channel
   * @param {Function} handler - Message handler
   * @returns {Function} Unsubscribe function
   */
  on(channel, handler) {
    if (!this.ipc) {
      console.warn(`[IpcBridge:${this.context}] Cannot register listener for ${channel} - IPC not available`);
      return () => {};
    }
    
    try {
      // Wrap handler to track it
      const wrappedHandler = (...args) => {
        if (this.enableLogging) {
          console.log(`[IpcBridge:${this.context}] Received:`, channel, args);
        }
        handler(...args);
      };
      
      this.ipc.on(channel, wrappedHandler);
      
      // Track listener
      if (!this.listeners.has(channel)) {
        this.listeners.set(channel, []);
      }
      this.listeners.get(channel).push(wrappedHandler);
      
      // Return unsubscribe function
      return () => this.removeListener(channel, wrappedHandler);
    } catch (error) {
      console.error(`[IpcBridge:${this.context}] Failed to register listener for ${channel}:`, error);
      return () => {};
    }
  }

  /**
   * Register one-time listener for channel
   * @param {string} channel - IPC channel
   * @param {Function} handler - Message handler
   * @returns {Function} Unsubscribe function
   */
  once(channel, handler) {
    if (!this.ipc) {
      console.warn(`[IpcBridge:${this.context}] Cannot register once listener for ${channel} - IPC not available`);
      return () => {};
    }
    
    try {
      const wrappedHandler = (...args) => {
        if (this.enableLogging) {
          console.log(`[IpcBridge:${this.context}] Received (once):`, channel, args);
        }
        handler(...args);
      };
      
      this.ipc.once(channel, wrappedHandler);
      
      // Return unsubscribe function
      return () => this.removeListener(channel, wrappedHandler);
    } catch (error) {
      console.error(`[IpcBridge:${this.context}] Failed to register once listener for ${channel}:`, error);
      return () => {};
    }
  }

  /**
   * Remove listener
   * @param {string} channel - IPC channel
   * @param {Function} handler - Handler to remove
   */
  removeListener(channel, handler) {
    if (!this.ipc) return;
    
    try {
      this.ipc.removeListener(channel, handler);
      
      // Update tracking
      const channelListeners = this.listeners.get(channel);
      if (channelListeners) {
        const index = channelListeners.indexOf(handler);
        if (index > -1) {
          channelListeners.splice(index, 1);
        }
        
        if (channelListeners.length === 0) {
          this.listeners.delete(channel);
        }
      }
    } catch (error) {
      console.error(`[IpcBridge:${this.context}] Failed to remove listener for ${channel}:`, error);
    }
  }

  /**
   * Remove all listeners for channel
   * @param {string} channel - IPC channel
   */
  removeAllListeners(channel) {
    const channelListeners = this.listeners.get(channel);
    if (!channelListeners) return;
    
    for (const handler of channelListeners) {
      this.removeListener(channel, handler);
    }
  }

  /**
   * Check if IPC is available
   * @returns {boolean}
   */
  isAvailable() {
    return !!this.ipc;
  }

  /**
   * Flush queued messages
   * @returns {number} Number of messages flushed
   */
  flushQueue() {
    if (!this.ipc || this.messageQueue.length === 0) {
      return 0;
    }
    
    const count = this.messageQueue.length;
    
    for (const { channel, payload } of this.messageQueue) {
      this.send(channel, payload);
    }
    
    this.messageQueue = [];
    this.isReady = true;
    
    if (this.enableLogging) {
      console.log(`[IpcBridge:${this.context}] Flushed ${count} queued messages`);
    }
    
    return count;
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    return freeze({
      context: this.context,
      isReady: this.isReady,
      isAvailable: this.isAvailable(),
      queuedMessages: this.messageQueue.length,
      activeChannels: this.listeners.size,
      totalListeners: Array.from(this.listeners.values()).reduce((sum, arr) => sum + arr.length, 0)
    });
  }

  /**
   * Cleanup and destroy
   */
  destroy() {
    // Remove all listeners
    for (const channel of this.listeners.keys()) {
      this.removeAllListeners(channel);
    }
    
    this.listeners.clear();
    this.messageQueue = [];
    this.ipc = null;
    this.isReady = false;
    
    if (this.enableLogging) {
      console.log(`[IpcBridge:${this.context}] Destroyed`);
    }
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Get IPC API from preload
   * @private
   */
  _getIpcAPI() {
    if (typeof window === 'undefined') {
      return null;
    }
    
    // Try window.aether.ipc (new preload structure)
    if (window.aether && window.aether.ipc) {
      return window.aether.ipc;
    }
    
  
    return null;
  }

  /**
   * Queue message for later sending
   * @private
   */
  _queueMessage(channel, payload) {
    this.messageQueue.push({ channel, payload });
    
    if (this.enableLogging) {
      console.log(`[IpcBridge:${this.context}] Queued message for ${channel}`);
    }
  }
}

// Export
module.exports = { IpcBridge };

if (typeof window !== 'undefined') {
  window.IpcBridge = IpcBridge;
  console.log('📦 IpcBridge loaded');
}

