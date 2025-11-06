'use strict';

/**
 * @.architecture
 * 
 * Incoming: window.addEventListener('error' | 'unhandledrejection'), explicit .captureError() calls --- {event_types.window_error | promise_rejection, Error}
 * Processing: Capture errors, classify (render/network/validation/unknown), assign severity (low/medium/high/critical), log to console, call custom handler, emit via EventBus, render UI (toast for non-critical, overlay for critical), track history (max 50) --- {6 jobs: JOB_TRACK_ENTITY, JOB_ROUTE_BY_TYPE, JOB_EMIT_EVENT, JOB_EMIT_EVENT, JOB_RENDER_MARKDOWN, JOB_TRACK_ENTITY}
 * Outgoing: EventBus.emit('error:captured'), DOM overlay/toast, call onError handler --- {event_types.error_captured | dom_types.error_ui, json | HTMLElement}
 * 
 * 
 * @module renderer/shared/components/ErrorBoundary
 * 
 * ErrorBoundary - Production-Ready Error Handler
 * ============================================================================
 * Provides error boundary functionality for renderer processes with:
 * - Graceful error recovery
 * - Error logging and reporting
 * - Fallback UI rendering
 * - Error state management
 * - Event-driven error propagation
 * 
 * Responsibilities:
 * - Catch and handle unhandled errors
 * - Render fallback UI on error
 * - Log errors to console and backend
 * - Emit error events via EventBus
 * - Provide error recovery mechanisms
 * 
 * Architecture:
 * - Singleton pattern (one per window)
 * - Event-driven with EventBus integration
 * - Clean separation of error capture and UI
 * - Production-ready error handling
 */

const { freeze } = Object;

// Error boundary configuration
const CONFIG = freeze({
  MAX_ERROR_HISTORY: 50,
  ERROR_DISPLAY_DURATION: 5000,
  ERROR_TYPES: freeze({
    RENDER: 'render',
    NETWORK: 'network',
    VALIDATION: 'validation',
    UNKNOWN: 'unknown',
  }),
  SEVERITY: freeze({
    LOW: 'low',
    MEDIUM: 'medium',
    HIGH: 'high',
    CRITICAL: 'critical',
  }),
  CLASS_NAMES: freeze({
    CONTAINER: 'error-boundary-container',
    TOAST: 'error-toast',
    OVERLAY: 'error-overlay',
    MESSAGE: 'error-message',
    STACK: 'error-stack',
    ACTIONS: 'error-actions',
  }),
});

class ErrorBoundary {
  /**
   * Create error boundary
   * @param {Object} options - Configuration options
   * @param {Object} options.eventBus - Event bus for error propagation
   * @param {HTMLElement} options.container - Container element for error UI
   * @param {Function} options.onError - Custom error handler
   * @param {boolean} options.showUI - Whether to show error UI (default: true)
   */
  constructor(options = {}) {
    // Configuration
    this.eventBus = options.eventBus || null;
    this.container = options.container || document.body;
    this.onError = options.onError || null;
    this.showUI = options.showUI !== undefined ? options.showUI : true;

    // State
    this.errorHistory = [];
    this.isActive = true;
    this.hasRenderedUI = false;

    // DOM references
    this.errorContainer = null;
    this.toastContainer = null;

    // Cleanup tracking
    this._listeners = [];
    this._timers = [];

    // Bind methods
    this._handleWindowError = this._handleWindowError.bind(this);
    this._handleUnhandledRejection = this._handleUnhandledRejection.bind(this);

    console.log('[ErrorBoundary] Constructed');
  }

  /**
   * Initialize error boundary
   * Attaches global error handlers
   */
  init() {
    console.log('[ErrorBoundary] Initializing...');

    // Attach global error handlers
    window.addEventListener('error', this._handleWindowError);
    window.addEventListener('unhandledrejection', this._handleUnhandledRejection);

    this._listeners.push(
      () => window.removeEventListener('error', this._handleWindowError),
      () => window.removeEventListener('unhandledrejection', this._handleUnhandledRejection)
    );

    // Inject styles if showing UI
    if (this.showUI) {
      this._injectStyles();
    }

    console.log('[ErrorBoundary] Initialized');
  }

  /**
   * Handle window error events
   * @private
   */
  _handleWindowError(event) {
    if (!this.isActive) return;

    const error = {
      type: CONFIG.ERROR_TYPES.UNKNOWN,
      severity: CONFIG.SEVERITY.MEDIUM,
      message: event.message || 'Unknown error',
      filename: event.filename || 'unknown',
      lineno: event.lineno || 0,
      colno: event.colno || 0,
      stack: event.error?.stack || '',
      timestamp: Date.now(),
    };

    this._processError(error);
  }

  /**
   * Handle unhandled promise rejections
   * @private
   */
  _handleUnhandledRejection(event) {
    if (!this.isActive) return;

    const error = {
      type: CONFIG.ERROR_TYPES.UNKNOWN,
      severity: CONFIG.SEVERITY.MEDIUM,
      message: event.reason?.message || String(event.reason) || 'Unhandled rejection',
      stack: event.reason?.stack || '',
      timestamp: Date.now(),
    };

    this._processError(error);
  }

  /**
   * Capture and process error manually
   * @param {Error|Object} error - Error object or error data
   * @param {Object} context - Additional context
   */
  captureError(error, context = {}) {
    if (!this.isActive) return;

    const errorData = {
      type: context.type || CONFIG.ERROR_TYPES.UNKNOWN,
      severity: context.severity || CONFIG.SEVERITY.MEDIUM,
      message: error.message || String(error),
      stack: error.stack || '',
      context,
      timestamp: Date.now(),
    };

    this._processError(errorData);
  }

  /**
   * Process error
   * @private
   */
  _processError(error) {
    // Add to history
    this.errorHistory.push(error);
    if (this.errorHistory.length > CONFIG.MAX_ERROR_HISTORY) {
      this.errorHistory.shift();
    }

    // Log to console
    console.error('[ErrorBoundary] Error captured:', error);

    // Call custom handler
    if (this.onError) {
      try {
        this.onError(error);
      } catch (handlerError) {
        console.error('[ErrorBoundary] Error handler failed:', handlerError);
      }
    }

    // Emit event
    if (this.eventBus) {
      try {
        this.eventBus.emit('error:captured', error);
      } catch (emitError) {
        console.error('[ErrorBoundary] Event emission failed:', emitError);
      }
    }

    // Show UI
    if (this.showUI) {
      if (error.severity === CONFIG.SEVERITY.CRITICAL) {
        this._renderOverlay(error);
      } else {
        this._renderToast(error);
      }
    }
  }

  /**
   * Render error overlay (for critical errors)
   * @private
   */
  _renderOverlay(error) {
    // Remove existing overlay
    if (this.errorContainer) {
      this.errorContainer.remove();
    }

    // Create overlay
    this.errorContainer = document.createElement('div');
    this.errorContainer.className = CONFIG.CLASS_NAMES.OVERLAY;

    const showStack = window.__DEV__ || false;

    this.errorContainer.innerHTML = `
      <div class="${CONFIG.CLASS_NAMES.MESSAGE}">
        <h3>Application Error</h3>
        <p>${this._escapeHTML(error.message)}</p>
        ${showStack && error.stack ? `
          <details class="${CONFIG.CLASS_NAMES.STACK}">
            <summary>Stack Trace</summary>
            <pre>${this._escapeHTML(error.stack)}</pre>
          </details>
        ` : ''}
        <div class="${CONFIG.CLASS_NAMES.ACTIONS}">
          <button id="error-reload-btn">Reload</button>
          <button id="error-dismiss-btn">Dismiss</button>
        </div>
      </div>
    `;

    this.container.appendChild(this.errorContainer);
    this.hasRenderedUI = true;

    // Attach event listeners
    const reloadBtn = this.errorContainer.querySelector('#error-reload-btn');
    const dismissBtn = this.errorContainer.querySelector('#error-dismiss-btn');

    reloadBtn.addEventListener('click', () => window.location.reload());
    dismissBtn.addEventListener('click', () => this.clearUI());
  }

  /**
   * Render error toast (for non-critical errors)
   * @private
   */
  _renderToast(error) {
    // Create toast container if needed
    if (!this.toastContainer) {
      this.toastContainer = document.createElement('div');
      this.toastContainer.className = CONFIG.CLASS_NAMES.CONTAINER;
      this.container.appendChild(this.toastContainer);
    }

    // Create toast
    const toast = document.createElement('div');
    toast.className = CONFIG.CLASS_NAMES.TOAST;
    toast.textContent = error.message;

    this.toastContainer.appendChild(toast);

    // Auto-remove after duration
    const timer = setTimeout(() => {
      toast.remove();
    }, CONFIG.ERROR_DISPLAY_DURATION);

    this._timers.push(timer);

    // Manual dismiss
    toast.addEventListener('click', () => {
      clearTimeout(timer);
      toast.remove();
    });
  }

  /**
   * Clear error UI
   */
  clearUI() {
    if (this.errorContainer) {
      this.errorContainer.remove();
      this.errorContainer = null;
    }

    if (this.toastContainer) {
      this.toastContainer.innerHTML = '';
    }

    this.hasRenderedUI = false;
  }

  /**
   * Get error history
   * @returns {Array} Error history
   */
  getErrorHistory() {
    return [...this.errorHistory];
  }

  /**
   * Clear error history
   */
  clearHistory() {
    this.errorHistory = [];
  }

  /**
   * Deactivate error boundary
   */
  deactivate() {
    this.isActive = false;
    console.log('[ErrorBoundary] Deactivated');
  }

  /**
   * Activate error boundary
   */
  activate() {
    this.isActive = true;
    console.log('[ErrorBoundary] Activated');
  }

  /**
   * Escape HTML to prevent XSS
   * @private
   */
  _escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * Inject error boundary styles
   * @private
   */
  _injectStyles() {
    const styleId = 'error-boundary-styles';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      .${CONFIG.CLASS_NAMES.OVERLAY} {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.9);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 999999;
        backdrop-filter: blur(10px);
      }

      .${CONFIG.CLASS_NAMES.MESSAGE} {
        background: rgba(255, 0, 0, 0.1);
        border: 2px solid rgba(255, 0, 0, 0.5);
        border-radius: 12px;
        padding: 30px;
        max-width: 600px;
        color: white;
        text-align: center;
      }

      .${CONFIG.CLASS_NAMES.MESSAGE} h3 {
        margin: 0 0 15px 0;
        color: rgba(255, 100, 100, 1);
      }

      .${CONFIG.CLASS_NAMES.MESSAGE} p {
        margin: 0 0 20px 0;
        line-height: 1.5;
      }

      .${CONFIG.CLASS_NAMES.STACK} {
        text-align: left;
        margin: 20px 0;
        background: rgba(0, 0, 0, 0.5);
        border-radius: 8px;
        padding: 10px;
      }

      .${CONFIG.CLASS_NAMES.STACK} summary {
        cursor: pointer;
        padding: 5px;
        font-weight: bold;
      }

      .${CONFIG.CLASS_NAMES.STACK} pre {
        margin: 10px 0 0 0;
        padding: 10px;
        overflow: auto;
        max-height: 300px;
        font-family: 'Courier New', monospace;
        font-size: 12px;
        line-height: 1.4;
      }

      .${CONFIG.CLASS_NAMES.ACTIONS} {
        display: flex;
        gap: 10px;
        justify-content: center;
      }

      .${CONFIG.CLASS_NAMES.ACTIONS} button {
        padding: 10px 20px;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-weight: bold;
        transition: all 0.2s;
      }

      .${CONFIG.CLASS_NAMES.ACTIONS} button:first-child {
        background: rgba(255, 100, 100, 1);
        color: white;
      }

      .${CONFIG.CLASS_NAMES.ACTIONS} button:last-child {
        background: rgba(100, 100, 100, 1);
        color: white;
      }

      .${CONFIG.CLASS_NAMES.ACTIONS} button:hover {
        transform: scale(1.05);
      }

      .${CONFIG.CLASS_NAMES.CONTAINER} {
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 999998;
        display: flex;
        flex-direction: column;
        gap: 10px;
        max-width: 400px;
      }

      .${CONFIG.CLASS_NAMES.TOAST} {
        background: rgba(255, 100, 0, 0.9);
        color: white;
        padding: 15px 20px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        cursor: pointer;
        animation: slideIn 0.3s ease;
        border-left: 4px solid rgba(255, 150, 0, 1);
      }

      @keyframes slideIn {
        from {
          transform: translateX(100%);
          opacity: 0;
        }
        to {
          transform: translateX(0);
          opacity: 1;
        }
      }
    `;

    document.head.appendChild(style);
  }

  /**
   * Dispose error boundary
   * Removes listeners and clears state
   */
  dispose() {
    console.log('[ErrorBoundary] Disposing...');

    // Clear timers
    for (const timer of this._timers) {
      clearTimeout(timer);
    }
    this._timers = [];

    // Remove listeners
    for (const cleanup of this._listeners) {
      cleanup();
    }
    this._listeners = [];

    // Clear UI
    this.clearUI();

    // Clear references
    this.eventBus = null;
    this.container = null;
    this.onError = null;
    this.errorHistory = [];

    console.log('[ErrorBoundary] Disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ErrorBoundary;
}

if (typeof window !== 'undefined') {
  window.ErrorBoundary = ErrorBoundary;
  console.log('📦 ErrorBoundary loaded');
}

