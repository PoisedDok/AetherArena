'use strict';

/**
 * @.architecture
 * 
 * Incoming: Orchestrators (MainOrchestrator.js, ChatOrchestrator.js, ArtifactsOrchestrator.js) --- {method_calls, javascript_api}
 * Processing: Generate request IDs (req_timestamp_random format), track request state, manage timeouts, handle cancellation, collect statistics, maintain request history, cleanup resources --- {5 jobs: JOB_CLEAR_STATE, JOB_DISPOSE, JOB_GET_STATE, JOB_TRACK_ENTITY, JOB_UPDATE_STATE}
 * Outgoing: Request context callbacks (onComplete, onTimeout, onCancel) → caller orchestrator --- {frozen_object, javascript_api}
 * 
 * 
 * @module application/shared/RequestLifecycleManager
 * 
 * RequestLifecycleManager - Request tracking and lifecycle management
 * ============================================================================
 * Production-grade request lifecycle coordination:
 * - Request ID generation and tracking
 * - Timeout management
 * - Cancellation support
 * - Request-response correlation
 * - Resource cleanup
 * - Performance tracking
 * 
 * Used by all three orchestrators (main, chat, artifacts) for consistent
 * request management across the application.
 */

const { freeze } = Object;

class RequestLifecycleManager {
  constructor(options = {}) {
    this.name = options.name || 'RequestLifecycleManager';
    this.enableLogging = options.enableLogging || false;
    this.defaultTimeout = options.defaultTimeout || 120000; // 2 minutes
    this.maxConcurrentRequests = options.maxConcurrentRequests || 10;
    
    // Active requests tracking
    this.activeRequests = new Map();
    this.requestHistory = [];
    this.maxHistorySize = options.maxHistorySize || 100;
    
    // Statistics
    this.stats = {
      total: 0,
      completed: 0,
      failed: 0,
      timeout: 0,
      cancelled: 0,
      active: 0
    };
    
    // Performance monitor integration
    this.performanceMonitor = options.performanceMonitor || null;
  }

  /**
   * Start new request
   * @param {Object} options - Request options
   * @returns {Object} Request context
   */
  startRequest(options = {}) {
    // Check concurrent limit
    if (this.activeRequests.size >= this.maxConcurrentRequests) {
      throw new Error(`Maximum concurrent requests (${this.maxConcurrentRequests}) exceeded`);
    }
    
    const requestId = options.requestId || this._generateRequestId();
    const timeout = options.timeout || this.defaultTimeout;
    
    // Create request context
    const context = {
      id: requestId,
      type: options.type || 'generic',
      startTime: Date.now(),
      timeout,
      timeoutHandle: null,
      cancelled: false,
      metadata: options.metadata || {},
      onCancel: options.onCancel || null,
      onTimeout: options.onTimeout || null,
      onComplete: options.onComplete || null
    };
    
    // Setup timeout
    if (timeout > 0) {
      context.timeoutHandle = setTimeout(() => {
        this._handleTimeout(requestId);
      }, timeout);
    }
    
    // Store request
    this.activeRequests.set(requestId, context);
    this.stats.total++;
    this.stats.active++;
    
    // Performance tracking
    if (this.performanceMonitor) {
      this.performanceMonitor.start(`request:${requestId}`);
    }
    
    if (this.enableLogging) {
      console.log(`[${this.name}] Started request ${requestId} (type: ${context.type})`);
    }
    
    return freeze({
      id: requestId,
      cancel: () => this.cancelRequest(requestId),
      complete: (result) => this.completeRequest(requestId, result),
      fail: (error) => this.failRequest(requestId, error)
    });
  }

  /**
   * Complete request successfully
   * @param {string} requestId - Request ID
   * @param {*} result - Request result
   */
  completeRequest(requestId, result = null) {
    const context = this.activeRequests.get(requestId);
    if (!context) {
      console.warn(`[${this.name}] Cannot complete unknown request: ${requestId}`);
      return;
    }
    
    // Clear timeout
    if (context.timeoutHandle) {
      clearTimeout(context.timeoutHandle);
    }
    
    // Update statistics
    this.stats.completed++;
    this.stats.active--;
    
    // Calculate duration
    const duration = Date.now() - context.startTime;
    
    // Performance tracking
    if (this.performanceMonitor) {
      this.performanceMonitor.end(`request:${requestId}`);
    }
    
    // Store in history
    this._addToHistory({
      id: requestId,
      type: context.type,
      status: 'completed',
      duration,
      result,
      timestamp: Date.now()
    });
    
    // Call completion callback
    if (context.onComplete) {
      try {
        context.onComplete(result);
      } catch (error) {
        console.error(`[${this.name}] onComplete callback failed for ${requestId}:`, error);
      }
    }
    
    // Remove from active requests
    this.activeRequests.delete(requestId);
    
    if (this.enableLogging) {
      console.log(`[${this.name}] Completed request ${requestId} (${duration}ms)`);
    }
  }

  /**
   * Fail request with error
   * @param {string} requestId - Request ID
   * @param {Error|string} error - Error
   */
  failRequest(requestId, error) {
    const context = this.activeRequests.get(requestId);
    if (!context) {
      console.warn(`[${this.name}] Cannot fail unknown request: ${requestId}`);
      return;
    }
    
    // Clear timeout
    if (context.timeoutHandle) {
      clearTimeout(context.timeoutHandle);
    }
    
    // Update statistics
    this.stats.failed++;
    this.stats.active--;
    
    // Calculate duration
    const duration = Date.now() - context.startTime;
    
    // Performance tracking
    if (this.performanceMonitor) {
      this.performanceMonitor.end(`request:${requestId}`);
    }
    
    // Store in history
    this._addToHistory({
      id: requestId,
      type: context.type,
      status: 'failed',
      duration,
      error: error instanceof Error ? error.message : String(error),
      timestamp: Date.now()
    });
    
    // Remove from active requests
    this.activeRequests.delete(requestId);
    
    console.error(`[${this.name}] Failed request ${requestId} (${duration}ms):`, error);
  }

  /**
   * Cancel request
   * @param {string} requestId - Request ID
   * @returns {boolean} Success
   */
  cancelRequest(requestId) {
    const context = this.activeRequests.get(requestId);
    if (!context) {
      console.warn(`[${this.name}] Cannot cancel unknown request: ${requestId}`);
      return false;
    }
    
    // Mark as cancelled
    context.cancelled = true;
    
    // Clear timeout
    if (context.timeoutHandle) {
      clearTimeout(context.timeoutHandle);
    }
    
    // Update statistics
    this.stats.cancelled++;
    this.stats.active--;
    
    // Calculate duration
    const duration = Date.now() - context.startTime;
    
    // Performance tracking
    if (this.performanceMonitor) {
      this.performanceMonitor.end(`request:${requestId}`);
    }
    
    // Store in history
    this._addToHistory({
      id: requestId,
      type: context.type,
      status: 'cancelled',
      duration,
      timestamp: Date.now()
    });
    
    // Call cancellation callback
    if (context.onCancel) {
      try {
        context.onCancel();
      } catch (error) {
        console.error(`[${this.name}] onCancel callback failed for ${requestId}:`, error);
      }
    }
    
    // Remove from active requests
    this.activeRequests.delete(requestId);
    
    if (this.enableLogging) {
      console.log(`[${this.name}] Cancelled request ${requestId} (${duration}ms)`);
    }
    
    return true;
  }

  /**
   * Check if request is active
   * @param {string} requestId - Request ID
   * @returns {boolean}
   */
  isActive(requestId) {
    return this.activeRequests.has(requestId);
  }

  /**
   * Get request context
   * @param {string} requestId - Request ID
   * @returns {Object|null}
   */
  getRequest(requestId) {
    const context = this.activeRequests.get(requestId);
    return context ? freeze({ ...context }) : null;
  }

  /**
   * Get all active requests
   * @returns {Array<Object>}
   */
  getActiveRequests() {
    return Array.from(this.activeRequests.values()).map(ctx => freeze({ ...ctx }));
  }

  /**
   * Cancel all active requests
   * @returns {number} Number of requests cancelled
   */
  cancelAll() {
    const count = this.activeRequests.size;
    
    for (const requestId of Array.from(this.activeRequests.keys())) {
      this.cancelRequest(requestId);
    }
    
    if (this.enableLogging) {
      console.log(`[${this.name}] Cancelled all requests (${count})`);
    }
    
    return count;
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    return freeze({
      ...this.stats,
      avgDuration: this._calculateAvgDuration(),
      successRate: this.stats.total > 0 
        ? ((this.stats.completed / this.stats.total) * 100).toFixed(2)
        : 0
    });
  }

  /**
   * Get request history
   * @param {number} limit - Max number of entries
   * @returns {Array<Object>}
   */
  getHistory(limit = 50) {
    return freeze(this.requestHistory.slice(-limit));
  }

  /**
   * Clear history
   */
  clearHistory() {
    this.requestHistory = [];
  }

  /**
   * Reset statistics
   */
  reset() {
    this.stats = {
      total: 0,
      completed: 0,
      failed: 0,
      timeout: 0,
      cancelled: 0,
      active: this.activeRequests.size
    };
    
    if (this.enableLogging) {
      console.log(`[${this.name}] Reset statistics`);
    }
  }

  /**
   * Cleanup and destroy
   */
  destroy() {
    // Cancel all active requests
    this.cancelAll();
    
    // Clear history
    this.clearHistory();
    
    // Reset stats
    this.reset();
    
    if (this.enableLogging) {
      console.log(`[${this.name}] Destroyed`);
    }
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Generate unique request ID
   * @private
   */
  _generateRequestId() {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Handle request timeout
   * @private
   */
  _handleTimeout(requestId) {
    const context = this.activeRequests.get(requestId);
    if (!context) return;
    
    // Update statistics
    this.stats.timeout++;
    this.stats.active--;
    
    // Calculate duration
    const duration = Date.now() - context.startTime;
    
    // Performance tracking
    if (this.performanceMonitor) {
      this.performanceMonitor.end(`request:${requestId}`);
    }
    
    // Store in history
    this._addToHistory({
      id: requestId,
      type: context.type,
      status: 'timeout',
      duration,
      timestamp: Date.now()
    });
    
    // Call timeout callback
    if (context.onTimeout) {
      try {
        context.onTimeout();
      } catch (error) {
        console.error(`[${this.name}] onTimeout callback failed for ${requestId}:`, error);
      }
    }
    
    // Remove from active requests
    this.activeRequests.delete(requestId);
    
    console.warn(`[${this.name}] Request ${requestId} timed out after ${duration}ms`);
  }

  /**
   * Add entry to history
   * @private
   */
  _addToHistory(entry) {
    this.requestHistory.push(entry);
    
    // Trim history if needed
    if (this.requestHistory.length > this.maxHistorySize) {
      this.requestHistory.shift();
    }
  }

  /**
   * Calculate average duration from history
   * @private
   */
  _calculateAvgDuration() {
    if (this.requestHistory.length === 0) return 0;
    
    const totalDuration = this.requestHistory.reduce((sum, entry) => sum + (entry.duration || 0), 0);
    return Math.round(totalDuration / this.requestHistory.length);
  }
}

// Export
module.exports = { RequestLifecycleManager };

if (typeof window !== 'undefined') {
  window.RequestLifecycleManager = RequestLifecycleManager;
  console.log('📦 RequestLifecycleManager loaded');
}

