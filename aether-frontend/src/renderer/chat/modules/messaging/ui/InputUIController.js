'use strict';

/**
 * @.architecture
 *
 * Incoming: DOM input element, user interactions, validation errors --- {dom.input_element | event.user | error.validation, HTMLElement|Event|Error}
 * Processing: Manage input state, auto-resize, validation UI, focus management --- {4 jobs: JOB_AUTO_RESIZE, JOB_CLEAR_VALIDATION, JOB_MARK_ERROR, JOB_UPDATE_DOM_ELEMENT}
 * Outgoing: DOM updates (classes, attributes, styles) --- {dom.mutation, void}
 *
 * @module renderer/chat/modules/messaging/ui/InputUIController
 */

const { createRendererLogger } = require('../../../../shared/utils/logger');

const inputLogger = createRendererLogger('InputUIController');

/**
 * InputUIController - Input Field State & Validation UI
 * ======================================================
 * 
 * SINGLE RESPONSIBILITY: Manage input element UI state
 * 
 * RESPONSIBILITIES:
 * - Auto-resize textarea as user types
 * - Show/clear validation errors
 * - Manage ARIA attributes for accessibility
 * - Focus management
 * 
 * CONTRACTS:
 * - NO business logic
 * - NO validation (delegates to SendController)
 * - Pure UI state management
 * 
 * @module renderer/chat/modules/messaging/ui/InputUIController
 */
class InputUIController {
  constructor(options = {}) {
    this.inputElement = options.inputElement || null;
    this.log = inputLogger.child({ scope: 'input-ui-controller' });

    if (!this.inputElement) {
      throw new Error('[InputUIController] inputElement is REQUIRED');
    }

    // Lifecycle
    this._isDisposed = false;
    this._listenersAttached = false;

    this.log.info('InputUIController initialized');
  }

  /**
   * Setup event listeners for input
   */
  setupListeners() {
    if (this._isDisposed || this._listenersAttached) return;
    this._listenersAttached = true;

    this._inputHandler = () => this.autoResize();
    this._focusHandler = () => this.clearValidation();
    this.inputElement.addEventListener('input', this._inputHandler);
    this.inputElement.addEventListener('focus', this._focusHandler);
    this.log.trace('Input listeners attached');
  }

  /**
   * Auto-resize textarea based on content
   */
  autoResize() {
    if (!this.inputElement) return;

    this.inputElement.style.height = 'auto';
    this.inputElement.style.height = `${Math.min(this.inputElement.scrollHeight, 150)}px`;
  }

  /**
   * Mark input as invalid with error message
   * @param {string} message - Error message
   */
  markError(message) {
    if (!this.inputElement) return;

    this.inputElement.classList.add('validation-error');
    this.inputElement.setAttribute('aria-invalid', 'true');
    this.inputElement.setAttribute('aria-errormessage', 'aether-chat-status');

    if (message) {
      this.inputElement.setAttribute('data-error', message);
    }

    this.log.trace('Input marked as invalid', { message });
  }

  /**
   * Clear validation state
   */
  clearValidation() {
    if (!this.inputElement) return;

    this.inputElement.classList.remove('validation-error');
    this.inputElement.removeAttribute('aria-invalid');
    this.inputElement.removeAttribute('aria-errormessage');
    this.inputElement.removeAttribute('data-error');

    this.log.trace('Validation state cleared');
  }

  /**
   * Clear input value
   */
  clear() {
    if (!this.inputElement) return;

    this.inputElement.value = '';
    this.autoResize();
  }

  /**
   * Get input value
   * @returns {string}
   */
  getValue() {
    return this.inputElement?.value?.trim() || '';
  }

  /**
   * Set connection state (disables input and shows offline banner if disconnected)
   * @param {boolean} isConnected 
   */
  setConnectedState(isConnected) {
    if (!this.inputElement) return;
    
    // Disable/enable input based on connection
    this.inputElement.disabled = !isConnected;
    
    if (!isConnected) {
      this.inputElement.classList.add('input-offline');
      this.inputElement.setAttribute('placeholder', 'Disconnected from backend...');
      
      // We could also show a global UI banner or attach a local warning here
      let offlineBanner = this.inputElement.parentElement.querySelector('.offline-banner');
      if (!offlineBanner) {
        offlineBanner = document.createElement('div');
        offlineBanner.className = 'offline-banner';
        offlineBanner.style.position = 'absolute';
        offlineBanner.style.top = '-30px';
        offlineBanner.style.left = '0';
        offlineBanner.style.right = '0';
        offlineBanner.style.background = 'var(--color-error-subtle, rgba(255, 69, 58, 0.1))';
        offlineBanner.style.color = 'var(--color-error, #ff453a)';
        offlineBanner.style.padding = '4px 8px';
        offlineBanner.style.fontSize = '12px';
        offlineBanner.style.borderRadius = '4px';
        offlineBanner.style.textAlign = 'center';
        offlineBanner.style.border = '1px solid var(--color-error, #ff453a)';
        offlineBanner.innerHTML = '⚠️ Backend is disconnected. Messages cannot be sent.';
        
        // Ensure parent has relative positioning for the absolute banner
        if (getComputedStyle(this.inputElement.parentElement).position === 'static') {
          this.inputElement.parentElement.style.position = 'relative';
        }
        
        this.inputElement.parentElement.appendChild(offlineBanner);
      }
      offlineBanner.style.display = 'block';
    } else {
      this.inputElement.classList.remove('input-offline');
      this.inputElement.setAttribute('placeholder', 'Message Aether... (Type / for commands)');
      
      const offlineBanner = this.inputElement.parentElement.querySelector('.offline-banner');
      if (offlineBanner) {
        offlineBanner.style.display = 'none';
      }
    }
  }

  /**
   * Focus input element
   */
  focus() {
    if (!this.inputElement) return;

    try {
      this.inputElement.focus();
    } catch (error) {
      this.log.trace('Unable to focus input', { error: error.message });
    }
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;

    if (this.inputElement) {
      if (this._inputHandler) {
        this.inputElement.removeEventListener('input', this._inputHandler);
      }
      if (this._focusHandler) {
        this.inputElement.removeEventListener('focus', this._focusHandler);
      }
    }
    this._inputHandler = null;
    this._focusHandler = null;
    this._listenersAttached = false;
    this.inputElement = null;
    this.log.info('InputUIController disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = InputUIController;
}

if (typeof window !== 'undefined') {
  window.InputUIController = InputUIController;
}
