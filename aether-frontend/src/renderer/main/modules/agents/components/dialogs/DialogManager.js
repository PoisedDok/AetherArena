/**
 * @.architecture
 * Incoming: Tool components, user actions --- {dialog open request, dialog close request}
 * Processing: Manage dialog lifecycle, track listeners --- {JOB_OPEN_DIALOG, JOB_CLOSE_DIALOG, JOB_TRACK_LISTENERS}
 * Outgoing: Dialog DOM element, event cleanup --- {DOM manipulation, listener removal}
 * 
 * DialogManager - Centralized Dialog Lifecycle Management
 * 
 * Responsibilities:
 * - Open/close dialogs
 * - Track dialog listeners for cleanup
 * - Ensure single active dialog (close previous before opening new)
 * - Manage dialog transitions/animations
 * - Cleanup resources on close
 * 
 * Extracted from AgentsModal.js lines 1693-1737
 */

'use strict';

class DialogManager {
  constructor(options = {}) {
    this.logger = options.logger || console;
    
    // Dialog stack for nested overlays
    this._dialogStack = [];
    
    // Dialog listeners tracking (mapped by dialog element)
    this._dialogListeners = new Map();
    
    // Timers for animations
    this._timers = [];
  }

  /**
   * Open a dialog (pushes to stack)
   * @param {HTMLElement} dialogElement - Dialog DOM element
   */
  open(dialogElement) {
    if (!dialogElement) {
      this.logger.error('DialogManager: Cannot open null dialog');
      return;
    }

    // Disable interaction on previous dialog if exists
    const current = this.getActiveDialog();
    if (current) {
      current.style.pointerEvents = 'none';
      current.style.filter = 'brightness(0.7) blur(2px)';
    }

    // Push to stack
    this._dialogStack.push(dialogElement);

    // Initialize listener array for this dialog
    this._dialogListeners.set(dialogElement, []);

    // Add to DOM
    document.body.appendChild(dialogElement);

    // Trigger animation
    requestAnimationFrame(() => {
      dialogElement.classList.add('visible');
    });

    this.logger.info('DialogManager: Dialog opened', { stackDepth: this._dialogStack.length });
  }

  /**
   * Close active dialog (pops from stack)
   */
  close() {
    if (this._dialogStack.length === 0) return;

    const dialog = this._dialogStack.pop();
    if (!dialog) return;
    
    // Remove visible class (triggers fade-out)
    dialog.classList.remove('visible');
    dialog.style.pointerEvents = 'none';

    // Clear listeners for THIS dialog
    this._clearDialogListeners(dialog);

    // Remove from DOM after animation
    const timerId = setTimeout(() => {
      dialog.remove();
      
      // Restore interaction on previous dialog if exists
      const previous = this.getActiveDialog();
      if (previous) {
        previous.style.pointerEvents = 'auto';
        previous.style.filter = '';
      }
    }, 200);

    this._trackTimer(timerId);

    this.logger.info('DialogManager: Dialog closed', { stackRemaining: this._dialogStack.length });
  }

  /**
   * Track dialog event listener for cleanup
   * @param {HTMLElement} element - DOM element
   * @param {string} event - Event name
   * @param {Function} handler - Event handler
   * @param {Object} options - Event listener options
   */
  trackListener(element, event, handler, options) {
    const activeDialog = this.getActiveDialog();
    if (!activeDialog) return;

    if (!element || !event || !handler) {
      this.logger.warn('DialogManager: Invalid listener parameters');
      return;
    }

    element.addEventListener(event, handler, options);
    
    const listeners = this._dialogListeners.get(activeDialog) || [];
    listeners.push({ element, event, handler, options });
    this._dialogListeners.set(activeDialog, listeners);
  }

  /**
   * Clear tracked dialog listeners for a specific dialog
   * @param {HTMLElement} dialog - Dialog element
   * @private
   */
  _clearDialogListeners(dialog) {
    const listeners = this._dialogListeners.get(dialog);
    if (!listeners) return;

    listeners.forEach(({ element, event, handler, options }) => {
      element?.removeEventListener(event, handler, options);
    });
    
    this._dialogListeners.delete(dialog);
  }

  /**
   * Track timer for cleanup
   * @param {number} timerId - Timer ID
   * @private
   */
  _trackTimer(timerId) {
    if (timerId) {
      this._timers.push(timerId);
    }
  }

  /**
   * Clear all timers
   * @private
   */
  _clearTimers() {
    this._timers.forEach(timerId => clearTimeout(timerId));
    this._timers = [];
  }

  /**
   * Check if any dialog is currently open
   * @returns {boolean}
   */
  isOpen() {
    return this._dialogStack.length > 0;
  }

  /**
   * Get active dialog element
   * @returns {HTMLElement|null}
   */
  getActiveDialog() {
    return this._dialogStack[this._dialogStack.length - 1] || null;
  }

  /**
   * Cleanup all resources
   */
  cleanup() {
    // Close all dialogs in stack
    while (this._dialogStack.length > 0) {
      const dialog = this._dialogStack.pop();
      this._clearDialogListeners(dialog);
      dialog.remove();
    }
    
    this._clearTimers();
    this._dialogListeners.clear();
  }
}

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DialogManager;
}

// Global registration
if (typeof window !== 'undefined') {
  window.DialogManager = DialogManager;
}
