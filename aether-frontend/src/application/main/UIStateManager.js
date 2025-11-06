'use strict';

/**
 * @.architecture
 * 
 * Incoming: .openSettings() calls, .setActiveTab(name) calls, .setElementText(key, text) calls --- {method_calls, javascript_api}
 * Processing: Manage elements Map (key → HTMLElement), toggle modal visibility (add/remove 'hidden' class), switch tabs (update active classes on tabs + sections), set element text/HTML, add/remove/toggle CSS classes, show status messages with auto-hide, track state (modalOpen/activeTab/theme), emit EventBus events --- {9 jobs: JOB_INITIALIZE, JOB_UPDATE_STATE, JOB_UPDATE_STATE, JOB_UPDATE_STATE, JOB_UPDATE_STATE, JOB_UPDATE_STATE, JOB_UPDATE_STATE, JOB_UPDATE_STATE, JOB_EMIT_EVENT}
 * Outgoing: DOM manipulations (classList/textContent/innerHTML/style), EventBus.emit (UI.SETTINGS_OPENED/UI.SETTINGS_CLOSED/UI.TAB_CHANGED) --- {dom_update | event_types.ui_*, none | json}
 * 
 * 
 * @module application/main/UIStateManager
 * 
 * UIStateManager - Manages UI state and modal/tab visibility
 * ============================================================================
 * Production-ready UI state management service.
 * 
 * Features:
 * - Settings modal management
 * - Tab switching
 * - Element visibility control
 * - Status message display
 * - Element text/HTML manipulation
 */

const { EventTypes } = require('../../core/events/EventTypes');

class UIStateManager {
  constructor(options = {}) {
    // Dependencies
    this.eventBus = options.eventBus || null;
    
    // Configuration
    this.enableLogging = options.enableLogging !== undefined ? options.enableLogging : false;
    
    // State
    this.elements = options.elements || {};
    this.state = {
      modalOpen: false,
      activeTab: null,
      theme: 'dark'
    };
    
    // Validation
    if (!this.eventBus) {
      throw new Error('[UIStateManager] eventBus required');
    }
  }

  /**
   * Register UI elements
   * @param {Object} elements - Map of element identifiers to DOM elements
   */
  registerElements(elements) {
    this.elements = { ...this.elements, ...elements };

    if (this.enableLogging) {
      console.log('[UIStateManager] Registered', Object.keys(elements).length, 'elements');
    }
  }

  /**
   * Get element by key
   * @param {string} key - Element key
   * @returns {HTMLElement|null}
   */
  getElement(key) {
    return this.elements[key] || null;
  }

  /**
   * Open settings modal
   * @returns {boolean} Success status
   */
  openSettings() {
    const modal = this.elements.settingsModal;
    if (!modal) return false;

    modal.classList.remove('hidden');
    this.state.modalOpen = true;
    this.state.activeTab = 'assistant'; // Default tab

    // Emit event
    this.eventBus.emit(EventTypes.UI.SETTINGS_OPENED, {
      timestamp: Date.now()
    });

    if (this.enableLogging) {
      console.log('[UIStateManager] Settings opened');
    }

    return true;
  }

  /**
   * Close settings modal
   * @returns {boolean} Success status
   */
  closeSettings() {
    const modal = this.elements.settingsModal;
    if (!modal) return false;

    modal.classList.add('hidden');
    this.state.modalOpen = false;

    // Emit event
    this.eventBus.emit(EventTypes.UI.SETTINGS_CLOSED, {
      timestamp: Date.now()
    });

    if (this.enableLogging) {
      console.log('[UIStateManager] Settings closed');
    }

    return true;
  }

  /**
   * Set active tab
   * @param {string} tabName - Tab identifier
   * @returns {boolean} Success status
   */
  setActiveTab(tabName) {
    if (!tabName) return false;

    // Update tab buttons
    if (this.elements.tabs && Array.isArray(this.elements.tabs)) {
      this.elements.tabs.forEach(tab => {
        const isActive = tab.dataset.tab === tabName;
        tab.classList.toggle('active', isActive);
      });
    }

    // Update tab sections
    if (this.elements.sections) {
      Object.entries(this.elements.sections).forEach(([name, section]) => {
        if (section) {
          const isActive = name === tabName;
          section.classList.toggle('active', isActive);
        }
      });
    }

    const previousTab = this.state.activeTab;
    this.state.activeTab = tabName;

    // Emit event
    this.eventBus.emit(EventTypes.UI.TAB_CHANGED, {
      tab: tabName,
      previousTab,
      timestamp: Date.now()
    });

    if (this.enableLogging) {
      console.log(`[UIStateManager] Tab changed: ${previousTab} → ${tabName}`);
    }

    return true;
  }

  /**
   * Toggle element visibility
   * @param {string} key - Element key
   * @param {boolean} visible - Visibility state
   * @returns {boolean} Success status
   */
  setElementVisibility(key, visible) {
    const element = this.elements[key];
    if (!element) return false;

    if (visible) {
      element.style.display = 'block';
      element.classList.remove('hidden');
    } else {
      element.style.display = 'none';
      element.classList.add('hidden');
    }

    if (this.enableLogging) {
      console.log(`[UIStateManager] ${key} visibility: ${visible}`);
    }

    return true;
  }

  /**
   * Set element text content
   * @param {string} key - Element key
   * @param {string} text - Text content
   * @returns {boolean} Success status
   */
  setElementText(key, text) {
    const element = this.elements[key];
    if (!element) return false;

    element.textContent = text;
    return true;
  }

  /**
   * Set element HTML content
   * @param {string} key - Element key
   * @param {string} html - HTML content
   * @returns {boolean} Success status
   */
  setElementHTML(key, html) {
    const element = this.elements[key];
    if (!element) return false;

    element.innerHTML = html;
    return true;
  }

  /**
   * Add CSS class to element
   * @param {string} key - Element key
   * @param {string} className - Class name
   * @returns {boolean} Success status
   */
  addClass(key, className) {
    const element = this.elements[key];
    if (!element) return false;

    element.classList.add(className);
    return true;
  }

  /**
   * Remove CSS class from element
   * @param {string} key - Element key
   * @param {string} className - Class name
   * @returns {boolean} Success status
   */
  removeClass(key, className) {
    const element = this.elements[key];
    if (!element) return false;

    element.classList.remove(className);
    return true;
  }

  /**
   * Toggle CSS class on element
   * @param {string} key - Element key
   * @param {string} className - Class name
   * @param {boolean} [force] - Force state
   * @returns {boolean} Success status
   */
  toggleClass(key, className, force) {
    const element = this.elements[key];
    if (!element) return false;

    element.classList.toggle(className, force);
    return true;
  }

  /**
   * Show status message
   * @param {string} message - Status message
   * @param {string} [type='info'] - Message type (info, success, error, warning)
   * @param {number} [duration=3000] - Auto-hide duration in ms (0 = no auto-hide)
   * @returns {boolean} Success status
   */
  showStatus(message, type = 'info', duration = 3000) {
    const statusEl = this.elements.settingsStatus;
    if (!statusEl) return false;

    statusEl.textContent = message;
    statusEl.className = `status-message status-${type}`;

    if (duration > 0) {
      setTimeout(() => {
        statusEl.textContent = '';
        statusEl.className = 'status-message';
      }, duration);
    }

    return true;
  }

  /**
   * Is modal open
   * @returns {boolean}
   */
  isModalOpen() {
    return this.state.modalOpen;
  }

  /**
   * Get active tab
   * @returns {string|null}
   */
  getActiveTab() {
    return this.state.activeTab;
  }

  /**
   * Get current state
   * @returns {Object}
   */
  getState() {
    return { ...this.state };
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    return Object.freeze({
      registeredElements: Object.keys(this.elements).length,
      modalOpen: this.state.modalOpen,
      activeTab: this.state.activeTab
    });
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    this.elements = {};
    this.state = {
      modalOpen: false,
      activeTab: null,
      theme: 'dark'
    };
    this.eventBus = null;

    if (this.enableLogging) {
      console.log('[UIStateManager] Disposed');
    }
  }
}

// Export
module.exports = UIStateManager;

if (typeof window !== 'undefined') {
  window.UIStateManager = UIStateManager;
  console.log('📦 UIStateManager loaded');
}

