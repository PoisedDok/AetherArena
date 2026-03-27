'use strict';

/**
 * @.architecture
 *
 * Incoming: WebSocket message payloads from EventBus --- {websocket.message, json}
 * Processing: Enqueue messages, process sequentially, prevent race conditions --- {2 jobs: JOB_ENQUEUE_MESSAGE, JOB_PROCESS_QUEUE}
 * Outgoing: Router.route() calls with sequential guarantee --- {method_call, void}
 *
 * @module renderer/chat/modules/messaging/queue/MessageQueueProcessor
 */

const { createRendererLogger } = require('../../../../shared/utils/logger');

const queueLogger = createRendererLogger('MessageQueueProcessor');

/**
 * MessageQueueProcessor - Sequential Message Processing
 * ======================================================
 * 
 * SINGLE RESPONSIBILITY: Ensure messages are processed sequentially
 * 
 * CRITICAL RACE CONDITION FIX:
 * WebSocket messages arrive faster than processing completes.
 * Without queueing, rapid messages cause race conditions:
 * - State corruption (concurrent state updates)
 * - Out-of-order processing
 * - Lost messages
 * 
 * ARCHITECTURE:
 * 1. Messages enqueued immediately
 * 2. Single async processor drains queue
 * 3. Processor keeps running until queue empty
 * 4. If messages arrive during processing, processor continues
 * 
 * CONTRACTS:
 * - FIFO processing order
 * - NO concurrent processing
 * - Delegates actual work to router
 * 
 * @module renderer/chat/modules/messaging/queue/MessageQueueProcessor
 */
class MessageQueueProcessor {
  constructor(options = {}) {
    this.router = options.router || null;
    this.log = queueLogger.child({ scope: 'message-queue-processor' });

    if (!this.router) {
      throw new Error('[MessageQueueProcessor] router is REQUIRED');
    }

    this._queue = [];
    this._isProcessing = false;
    this._isDisposed = false;

    this.log.info('MessageQueueProcessor initialized');
  }

  /**
   * Enqueue message for processing
   * @param {Object} payload - WebSocket message payload
   */
  enqueue(payload) {
    if (this._isDisposed) {
      this.log.warn('enqueue called on disposed MessageQueueProcessor');
      return;
    }

    this._queue.push(payload);

    this.log.trace('Message enqueued', {
      queueSize: this._queue.length,
      isProcessing: this._isProcessing
    });

    // Start processor if not already running
    if (!this._isProcessing) {
      this._processQueue();
    }
  }

  /**
   * Process message queue sequentially
   * CRITICAL: Keeps looping until queue is COMPLETELY empty
   * @private
   */
  async _processQueue() {
    // Prevent concurrent processors
    if (this._isProcessing) {
      return;
    }

    this._isProcessing = true;

    try {
      // CRITICAL: Keep looping until queue is COMPLETELY empty
      // This handles messages added during processing
      while (this._queue.length > 0 && !this._isDisposed) {
        const payload = this._queue.shift();

        this.log.trace('Processing queued message', {
          remainingInQueue: this._queue.length
        });

        try {
          await this.router.route(payload);
        } catch (error) {
          this.log.error('Error processing queued message', {
            error: error.message,
            stack: error.stack
          });
          // Continue processing queue despite error
        }
      }
    } catch (error) {
      this.log.error('Fatal error in queue processor', {
        error: error.message,
        stack: error.stack
      });
    } finally {
      this._isProcessing = false;

      // CRITICAL: Double-check for race condition
      // If messages arrived between while-check and flag-clear
      if (this._queue.length > 0 && !this._isDisposed) {
        this.log.trace('Race condition detected - restarting processor', {
          queueSize: this._queue.length
        });
        // Restart processor immediately (no setTimeout delay)
        this._processQueue();
      }
    }
  }

  /**
   * Get current queue size
   * @returns {number}
   */
  getQueueSize() {
    return this._queue.length;
  }

  /**
   * Check if currently processing
   * @returns {boolean}
   */
  isProcessing() {
    return this._isProcessing;
  }

  /**
   * Clear queue (emergency only)
   */
  clear() {
    const previousSize = this._queue.length;
    this._queue = [];
    this.log.warn('Queue cleared', { previousSize });
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    if (this._isDisposed) return;

    this._isDisposed = true;
    this._queue = [];
    this._isProcessing = false;
    this.router = null;
    this.log.info('MessageQueueProcessor disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MessageQueueProcessor;
}

if (typeof window !== 'undefined') {
  window.MessageQueueProcessor = MessageQueueProcessor;
}
