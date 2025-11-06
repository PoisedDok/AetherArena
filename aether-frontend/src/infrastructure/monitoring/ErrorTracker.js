'use strict';

/**
 * @.architecture
 * 
 * Incoming: .captureError() calls, window 'error' | 'unhandledrejection' events --- {method_calls | browser_event, Error | string}
 * Processing: Normalize error (Error object → {name, message, stack}), generate signature (name:message:stackFirstLine), deduplicate (1min window), rate limit (max 10 errors/min), store errors array (max 100), attach context (url/userAgent/timestamp), report to backend (fetch POST /monitoring/errors), track statistics (totalErrors/reportedErrors/deduplicatedErrors/rateLimitedErrors) --- {9 jobs: JOB_UPDATE_STATE, JOB_GENERATE_SESSION_ID, JOB_DEDUPLICATE_CHUNK, JOB_UPDATE_STATE, JOB_SAVE_TO_DB, JOB_UPDATE_STATE, JOB_EMIT_EVENT, JOB_TRACK_ENTITY, JOB_INITIALIZE}
 * Outgoing: Fetch POST to backendURL/monitoring/errors (optional), return errorId (err_timestamp_random) --- {http_request | string, json | string}
 * 
 * 
 * @module infrastructure/monitoring/ErrorTracker
 * 
 * ErrorTracker - Error capture and reporting
 * ============================================================================
 * Production-grade error tracking:
 * - Automatic error capture (uncaught exceptions, unhandled rejections)
 * - Error context and stack traces
 * - Error deduplication
 * - Reporting to backend monitoring endpoint
 * - Error rate limiting
 */

const { freeze } = Object;

class ErrorTracker {
  constructor(options = {}) {
    this.enableLogging = options.enableLogging || false;
    this.reportToBackend = options.reportToBackend || false;
    this.backendURL = options.backendURL || null;
    this.maxErrorsPerMinute = options.maxErrorsPerMinute || 10;
    this.deduplicationWindow = options.deduplicationWindow || 60000; // 1 minute
    
    // Error storage
    this.errors = [];
    this.maxStoredErrors = options.maxStoredErrors || 100;
    this.errorCounts = new Map();
    this.lastErrorTimes = new Map();
    this.rateLimitCounter = 0;
    this.rateLimitResetTime = Date.now() + 60000;
    
    // Statistics
    this.stats = {
      totalErrors: 0,
      reportedErrors: 0,
      deduplicatedErrors: 0,
      rateLimitedErrors: 0
    };
    
    // Auto-attach handlers
    if (options.autoAttach !== false && typeof window !== 'undefined') {
      this.attachHandlers();
    }
  }

  /**
   * Capture error
   * @param {Error|string} error - Error object or message
   * @param {Object} context - Additional context
   * @returns {string|null} Error ID if captured
   */
  captureError(error, context = {}) {
    // Normalize error
    const errorObj = this._normalizeError(error);
    
    // Generate error signature for deduplication
    const signature = this._getErrorSignature(errorObj);
    
    // Check deduplication
    const lastTime = this.lastErrorTimes.get(signature);
    const now = Date.now();
    
    if (lastTime && (now - lastTime) < this.deduplicationWindow) {
      this.stats.deduplicatedErrors++;
      this._incrementErrorCount(signature);
      return null;
    }
    
    // Check rate limiting
    if (this._isRateLimited()) {
      this.stats.rateLimitedErrors++;
      console.warn('[ErrorTracker] Rate limit exceeded, error not reported');
      return null;
    }
    
    // Create error entry
    const errorId = `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const errorEntry = {
      id: errorId,
      signature,
      message: errorObj.message,
      stack: errorObj.stack,
      name: errorObj.name,
      context: {
        ...context,
        url: typeof window !== 'undefined' ? window.location.href : null,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
        timestamp: now
      },
      count: 1
    };
    
    // Store error
    this.errors.push(errorEntry);
    if (this.errors.length > this.maxStoredErrors) {
      this.errors.shift();
    }
    
    // Update tracking
    this.lastErrorTimes.set(signature, now);
    this.stats.totalErrors++;
    this.rateLimitCounter++;
    
    // Log
    if (this.enableLogging) {
      console.error('[ErrorTracker] Captured error:', errorEntry);
    }
    
    // Report to backend
    if (this.reportToBackend && this.backendURL) {
      this._reportToBackend(errorEntry);
    }
    
    return errorId;
  }

  /**
   * Capture exception with automatic context
   * @param {Error} error - Error object
   * @param {string} source - Error source
   */
  captureException(error, source = 'unknown') {
    this.captureError(error, {
      source,
      type: 'exception'
    });
  }

  /**
   * Capture message
   * @param {string} message - Error message
   * @param {string} level - Error level (error, warning, info)
   * @param {Object} context - Additional context
   */
  captureMessage(message, level = 'error', context = {}) {
    this.captureError(new Error(message), {
      ...context,
      level,
      type: 'message'
    });
  }

  /**
   * Attach global error handlers
   */
  attachHandlers() {
    if (typeof window === 'undefined') {
      return;
    }
    
    // Uncaught exceptions
    window.addEventListener('error', (event) => {
      this.captureError(event.error || event.message, {
        source: 'window.onerror',
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno
      });
    });
    
    // Unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
      this.captureError(event.reason, {
        source: 'unhandledrejection',
        promise: String(event.promise)
      });
    });
    
    if (this.enableLogging) {
      console.log('[ErrorTracker] Attached global error handlers');
    }
  }

  /**
   * Detach global error handlers
   */
  detachHandlers() {
    // Note: Cannot easily detach without storing references
    // Consider implementing if needed
    console.warn('[ErrorTracker] detachHandlers not implemented');
  }

  /**
   * Get all captured errors
   * @returns {Array<Object>}
   */
  getErrors() {
    return freeze([...this.errors]);
  }

  /**
   * Get error by ID
   * @param {string} errorId - Error ID
   * @returns {Object|null}
   */
  getError(errorId) {
    const error = this.errors.find(e => e.id === errorId);
    return error ? freeze({ ...error }) : null;
  }

  /**
   * Get error statistics
   * @returns {Object}
   */
  getStats() {
    return freeze({
      ...this.stats,
      storedErrors: this.errors.length,
      uniqueSignatures: this.errorCounts.size
    });
  }

  /**
   * Clear all errors
   */
  clear() {
    this.errors = [];
    this.errorCounts.clear();
    this.lastErrorTimes.clear();
    this.stats = {
      totalErrors: 0,
      reportedErrors: 0,
      deduplicatedErrors: 0,
      rateLimitedErrors: 0
    };
    
    if (this.enableLogging) {
      console.log('[ErrorTracker] Cleared all errors');
    }
  }

  /**
   * Export errors to JSON
   * @returns {string}
   */
  exportJSON() {
    const data = {
      errors: this.errors,
      stats: this.getStats(),
      timestamp: Date.now()
    };
    
    return JSON.stringify(data, null, 2);
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Normalize error to consistent format
   * @private
   */
  _normalizeError(error) {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack || ''
      };
    }
    
    if (typeof error === 'string') {
      return {
        name: 'Error',
        message: error,
        stack: ''
      };
    }
    
    if (typeof error === 'object' && error !== null) {
      return {
        name: error.name || 'Error',
        message: error.message || String(error),
        stack: error.stack || ''
      };
    }
    
    return {
      name: 'Error',
      message: String(error),
      stack: ''
    };
  }

  /**
   * Get error signature for deduplication
   * @private
   */
  _getErrorSignature(errorObj) {
    // Use message and first line of stack trace
    const stackFirstLine = errorObj.stack.split('\n')[0] || '';
    return `${errorObj.name}:${errorObj.message}:${stackFirstLine}`;
  }

  /**
   * Increment error count for signature
   * @private
   */
  _incrementErrorCount(signature) {
    const count = this.errorCounts.get(signature) || 0;
    this.errorCounts.set(signature, count + 1);
  }

  /**
   * Check if rate limited
   * @private
   */
  _isRateLimited() {
    const now = Date.now();
    
    // Reset counter if window expired
    if (now > this.rateLimitResetTime) {
      this.rateLimitCounter = 0;
      this.rateLimitResetTime = now + 60000;
    }
    
    return this.rateLimitCounter >= this.maxErrorsPerMinute;
  }

  /**
   * Report error to backend
   * @private
   */
  async _reportToBackend(errorEntry) {
    if (!this.backendURL) return;
    
    try {
      await fetch(`${this.backendURL}/monitoring/errors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'frontend',
          error: errorEntry
        })
      });
      
      this.stats.reportedErrors++;
      
      if (this.enableLogging) {
        console.log('[ErrorTracker] Reported error to backend:', errorEntry.id);
      }
    } catch (error) {
      console.error('[ErrorTracker] Failed to report error to backend:', error);
    }
  }
}

// Export
module.exports = { ErrorTracker };

if (typeof window !== 'undefined') {
  window.ErrorTracker = ErrorTracker;
  console.log('📦 ErrorTracker loaded');
}

