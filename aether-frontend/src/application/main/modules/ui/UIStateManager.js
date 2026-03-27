'use strict';

/**
 * @.architecture
 * 
 * Incoming: .openSettings() calls, .setActiveTab(name) calls, .showStatus(message) calls --- {method_calls, javascript_api}
 * Processing: Maintain UI state (modal/tabs/theme) and broadcast renderer-facing events; no direct DOM access --- {4 jobs: JOB_EMIT_EVENT, JOB_INITIALIZE, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA}
 * Outgoing: EventBus.emit (UI.SETTINGS_OPENED/UI.SETTINGS_CLOSED/UI.TAB_CHANGED/UI.NOTIFICATION) --- {event_types.ui_*, json}
 * 
 * 
 * @module application/main/modules/ui/UIStateManager
 * 
 * UIStateManager - Manages UI state and modal/tab visibility
 * ============================================================================
 * Production-ready UI state management service.
 * 
 * Features:
 * - Settings modal management
 * - Tab switching
 * - Status/notification broadcasting
 */

const { EventTypes } = require('../../../../core/events/EventTypes');
const { createRendererLogger } = require('../../../../renderer/shared/utils/logger');
const _log = createRendererLogger('UIStateManager');

class UIStateManager {
  constructor(options = {}) {
    // Dependencies
    this.eventBus = options.eventBus || null;
    
    // Configuration
    this.enableLogging = options.enableLogging !== undefined ? options.enableLogging : false;
    
    // State
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
   * Open settings modal
   * @returns {boolean} Success status
   */
  openSettings() {
    this.state.modalOpen = true;
    this.state.activeTab = 'assistant'; // Default tab

    // Emit event
    this.eventBus.emit(EventTypes.UI.SETTINGS_OPENED, {
      timestamp: Date.now()
    });

    if (this.enableLogging) {
      _log.debug('[UIStateManager] Settings opened');
    }

    return true;
  }

  /**
   * Close settings modal
   * @returns {boolean} Success status
   */
  closeSettings() {
    this.state.modalOpen = false;

    // Emit event
    this.eventBus.emit(EventTypes.UI.SETTINGS_CLOSED, {
      timestamp: Date.now()
    });

    if (this.enableLogging) {
      _log.debug('[UIStateManager] Settings closed');
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
    const previousTab = this.state.activeTab;
    this.state.activeTab = tabName;

    // Emit event
    this.eventBus.emit(EventTypes.UI.TAB_CHANGED, {
      tab: tabName,
      previousTab,
      timestamp: Date.now()
    });

    if (this.enableLogging) {
      _log.debug(`[UIStateManager] Tab changed: ${previousTab} → ${tabName}`);
    }

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
    this.eventBus.emit(EventTypes.UI.NOTIFICATION, {
      message,
      type,
      duration,
      timestamp: Date.now()
    });
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
      modalOpen: this.state.modalOpen,
      activeTab: this.state.activeTab
    });
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    this.state = {
      modalOpen: false,
      activeTab: null,
      theme: 'dark'
    };
    this.eventBus = null;

    if (this.enableLogging) {
      _log.debug('[UIStateManager] Disposed');
    }
  }
}

// Export
module.exports = UIStateManager;

if (typeof window !== 'undefined') {
  window.UIStateManager = UIStateManager;
  _log.debug('UIStateManager loaded');
}
