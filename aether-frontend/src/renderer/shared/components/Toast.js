'use strict';

/**
 * @.architecture
 *
 * Incoming: Application components (method calls) --- {message_string, javascript}
 * Processing: Create glassmorphism toast notifications matching app theme, auto-dismiss after timeout, stack multiple toasts --- {3 jobs: JOB_CREATE_DOM_ELEMENT, JOB_INITIALIZE, JOB_UPDATE_DOM_ELEMENT}
 * Outgoing: DOM (fixed position toast container) --- {HTMLElement, dom}
 *
 * Premium Toast Notification System
 * ============================================================================
 * Glassmorphism-styled toast notifications matching Aether's dark theme.
 * Features:
 * - Dark glassmorphism aesthetic with backdrop blur
 * - Auto-stacking with smooth animations
 * - Auto-dismiss with configurable timeout
 * - Success/Error/Info/Warning variants
 * - Icon support with semantic colors
 */

class Toast {
  /**
   * Show a success toast notification
   * @param {string} message - Toast message
   * @param {number} duration - Duration in ms (default 3000)
   */
  static success(message, duration = 3000) {
    return this._show({
      message,
      type: 'success',
      icon: '\u2713',
      duration
    });
  }

  /**
   * Show an error toast notification
   * @param {string} message - Toast message
   * @param {number} duration - Duration in ms (default 4000)
   */
  static error(message, duration = 4000) {
    return this._show({
      message,
      type: 'error',
      icon: '\u2717',
      duration
    });
  }

  /**
   * Show an info toast notification
   * @param {string} message - Toast message
   * @param {number} duration - Duration in ms (default 3000)
   */
  static info(message, duration = 3000) {
    return this._show({
      message,
      type: 'info',
      icon: '\u2139',
      duration
    });
  }

  /**
   * Show a warning toast notification
   * @param {string} message - Toast message
   * @param {number} duration - Duration in ms (default 3500)
   */
  static warning(message, duration = 3500) {
    return this._show({
      message,
      type: 'warning',
      icon: '\u26A0',
      duration
    });
  }

  /**
   * Internal show method
   * @private
   */
  static _show({ message, type, icon, duration }) {
    // Ensure container exists
    let container = document.getElementById('aether-toast-container');
    if (!container) {
      container = this._createContainer();
    }

    // "Popover Bump" to ensure the container is at the top of the Top Layer stack
    try {
      if (container.matches(':popover-open')) {
        container.hidePopover();
      }
      container.showPopover();
    } catch (err) {
      // jsdom does not support :popover-open pseudo-class or full popover API
      if (typeof container.showPopover === 'function') {
        try { container.showPopover(); } catch (e) {}
      }
    }

    // Create toast element
    const toast = this._createToast({ message, type, icon });

    // Add to container
    container.appendChild(toast);

    // Trigger entrance animation via CSS class
    requestAnimationFrame(() => {
      toast.classList.add('aether-toast--visible');
    });

    // Auto-dismiss
    setTimeout(() => {
      this._dismissToast(toast);
    }, duration);

    return toast;
  }

  /**
   * Create toast container
   * @private
   */
  static _createContainer() {
    const container = document.createElement('div');
    container.id = 'aether-toast-container';
    container.popover = 'manual';
    document.body.appendChild(container);
    return container;
  }

  /**
   * Create toast element
   * @private
   */
  static _createToast({ message, type, icon }) {
    const toast = document.createElement('div');
    const validType = ['success', 'error', 'warning', 'info'].includes(type) ? type : 'info';
    toast.className = `aether-toast aether-toast--${validType}`;

    // Icon container
    const iconEl = document.createElement('div');
    iconEl.className = 'aether-toast-icon';
    iconEl.textContent = icon;

    // Message
    const messageEl = document.createElement('div');
    messageEl.className = 'aether-toast-message';
    messageEl.textContent = message;

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'aether-toast-close';
    closeBtn.textContent = '\u00D7';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._dismissToast(toast);
    });

    // Click to dismiss
    toast.addEventListener('click', () => {
      this._dismissToast(toast);
    });

    toast.appendChild(iconEl);
    toast.appendChild(messageEl);
    toast.appendChild(closeBtn);

    return toast;
  }

  /**
   * Public method to dismiss a specific toast
   * @param {HTMLElement} toast - The toast element returned by show methods
   */
  static dismiss(toast) {
    if (toast && toast.classList) {
      this._dismissToast(toast);
    }
  }

  /**
   * Dismiss toast with animation
   * @private
   */
  static _dismissToast(toast) {
    toast.classList.remove('aether-toast--visible');
    
    setTimeout(() => {
      toast.remove();
      
      // Remove container if empty
      const container = document.getElementById('aether-toast-container');
      if (container && container.children.length === 0) {
        container.remove();
      }
    }, 300);
  }
}

module.exports = Toast;
