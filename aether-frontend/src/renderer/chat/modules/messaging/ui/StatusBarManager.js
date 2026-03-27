'use strict';

/**
 * @.architecture
 *
 * Incoming: Status messages with variants (error/processing/success) --- {status_message, object}
 * Processing: Update status bar DOM, manage visibility, auto-hide timers --- {3 jobs: JOB_SHOW_STATUS, JOB_CLEAR_STATUS, JOB_UPDATE_DOM_ELEMENT}
 * Outgoing: DOM updates (text content, classes, ARIA attributes) --- {dom.mutation, void}
 *
 * @module renderer/chat/modules/messaging/ui/StatusBarManager
 */

const { createRendererLogger } = require('../../../../shared/utils/logger');

const statusLogger = createRendererLogger('StatusBarManager');

/**
 * StatusBarManager - Status Bar UI Management
 * ============================================
 * 
 * SINGLE RESPONSIBILITY: Manage status bar display
 * 
 * RESPONSIBILITIES:
 * - Show/hide status messages
 * - Manage status variants (error/processing/success)
 * - Auto-hide non-critical messages
 * - ARIA live regions for accessibility
 * 
 * CONTRACTS:
 * - NO business logic
 * - Pure UI state management
 * 
 * @module renderer/chat/modules/messaging/ui/StatusBarManager
 */
class StatusBarManager {
  constructor(options = {}) {
    this.statusElement = options.statusElement || null;
    this.log = statusLogger.child({ scope: 'status-bar-manager' });

    this._timeout = null;
    this._currentVariant = null;

    // Lifecycle
    this._isDisposed = false;

    this.log.info('StatusBarManager initialized', {
      hasElement: Boolean(this.statusElement)
    });
  }

  /**
   * Show status message
   * @param {string} variant - Status variant (error/processing/success/info)
   * @param {string} message - Status message
   * @param {number} [duration] - Auto-hide duration in ms (0 = no auto-hide)
   */
  show(variant, message, duration = 6000) {
    if (this._isDisposed || !this.statusElement) {
      this.log.trace('Status element not available');
      return;
    }

    // Clear existing timeout
    if (this._timeout) {
      clearTimeout(this._timeout);
      this._timeout = null;
    }

    // Update DOM
    this.statusElement.textContent = message;
    this.statusElement.dataset.variant = variant;
    this.statusElement.classList.add('visible');
    this.statusElement.setAttribute('aria-hidden', 'false');
    this.statusElement.setAttribute('aria-live', variant === 'error' ? 'assertive' : 'polite');

    this._currentVariant = variant;

    this.log.trace('Status shown', { variant, message });

    // Auto-hide after duration (unless processing)
    if (duration > 0 && variant !== 'processing') {
      this._timeout = setTimeout(() => {
        this.clear();
      }, duration);
    }
  }

  /**
   * Clear status message
   */
  clear() {
    if (!this.statusElement) return;

    if (this._timeout) {
      clearTimeout(this._timeout);
      this._timeout = null;
    }

    this.statusElement.classList.remove('visible');
    this.statusElement.textContent = '';
    this.statusElement.removeAttribute('data-variant');
    this.statusElement.setAttribute('aria-hidden', 'true');
    this.statusElement.removeAttribute('aria-live');

    this._currentVariant = null;

    this.log.trace('Status cleared');
  }

  /**
   * Show error message
   * @param {string} message - Error message
   */
  showError(message) {
    this.show('error', message, 6000);
  }

  /**
   * Show processing message (no auto-hide)
   * @param {string} message - Processing message
   */
  showProcessing(message) {
    this.show('processing', message, 0);
  }

  /**
   * Show success message
   * @param {string} message - Success message
   */
  showSuccess(message) {
    this.show('success', message, 3000);
  }

  /**
   * Show info message
   * @param {string} message - Info message
   */
  showInfo(message) {
    this.show('info', message, 4000);
  }

  /**
   * Get current variant
   * @returns {string|null}
   */
  getCurrentVariant() {
    return this._currentVariant;
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;

    if (this._timeout) {
      clearTimeout(this._timeout);
      this._timeout = null;
    }

    this.statusElement = null;
    this._currentVariant = null;

    this.log.info('StatusBarManager disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StatusBarManager;
}

if (typeof window !== 'undefined') {
  window.StatusBarManager = StatusBarManager;
}
