'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactsWindow (getTabsContainer, getContentContainer), User tab clicks --- {dom_types.dom_event, Event}
 * Processing: Create 3 tabs (Code/Output/Files), manage active state, emit tab change events, show/hide tabs dynamically, return pane elements to controller --- {4 jobs: JOB_CREATE_DOM_ELEMENT, JOB_GET_STATE, JOB_UPDATE_STATE, JOB_EMIT_EVENT}
 * Outgoing: DOM (tab buttons & panes), EventBus (ARTIFACTS.TAB_CHANGED), CodeViewer/OutputViewer/FileManager (via pane elements) --- {dom_types.chat_entry_element, HTMLElement}
 * 
 * 
 * @module renderer/artifacts/modules/tabs/TabManager
 */

const { EventTypes } = require('../../../../core/events/EventTypes');
const { freeze } = Object;

// Tab configuration
const CONFIG = freeze({
  TABS: freeze({
    CODE: freeze({ id: 'code', label: 'Code', icon: '' }),
    OUTPUT: freeze({ id: 'output', label: 'Output', icon: '' }),
    FILES: freeze({ id: 'files', label: 'Files', icon: '' }),
  }),
  DEFAULT_TAB: 'output',
  CLASS_NAMES: freeze({
    TAB_BUTTON: 'artifacts-tab',
    ACTIVE_TAB: 'active',
    PANE: 'artifacts-pane',
    ACTIVE_PANE: 'active',
    CODE_PANE: 'artifacts-code-pane',
    OUTPUT_PANE: 'artifacts-output-pane',
    FILES_PANE: 'artifacts-files-pane',
  }),
});

class TabManager {
  /**
   * Create tab manager
   * @param {Object} options - Configuration options
   * @param {Object} options.artifactsWindow - Artifacts window instance
   * @param {Object} options.eventBus - Event bus for communication
   */
  constructor(options = {}) {
    if (!options.artifactsWindow) {
      throw new Error('[TabManager] ArtifactsWindow required');
    }

    if (!options.eventBus) {
      throw new Error('[TabManager] EventBus required');
    }

    this.artifactsWindow = options.artifactsWindow;
    this.eventBus = options.eventBus;

    // DOM elements
    this.tabsContainer = null;
    this.contentContainer = null;
    this.tabs = new Map(); // tabId -> { button, pane }

    // State
    this.activeTab = CONFIG.DEFAULT_TAB;

    // Event handlers (for cleanup)
    this._eventListeners = [];

    // Bind methods
    this._handleTabClick = this._handleTabClick.bind(this);
  }

  /**
   * Initialize tab manager
   */
  async init() {
    console.log('📑 TabManager: Initializing...');

    try {
      // Get containers from artifacts window
      this.tabsContainer = this.artifactsWindow.getTabsContainer();
      this.contentContainer = this.artifactsWindow.getContentContainer();

      if (!this.tabsContainer || !this.contentContainer) {
        throw new Error('[TabManager] Containers not found');
      }

      // Create tabs
      this._createTabs();

      // Set default active tab
      this.setActiveTab(CONFIG.DEFAULT_TAB);

      // Emit ready event
      this.eventBus.emit(EventTypes.UI.COMPONENT_READY, { 
        component: 'TabManager',
        timestamp: Date.now()
      });

      console.log('✅ TabManager: Initialized');

    } catch (error) {
      console.error('❌ TabManager: Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Dispose tab manager and cleanup
   */
  dispose() {
    console.log('🛑 TabManager: Disposing...');

    // Remove event listeners
    for (const cleanup of this._eventListeners) {
      try {
        cleanup();
      } catch (error) {
        console.error('[TabManager] Failed to cleanup event listener:', error);
      }
    }
    this._eventListeners = [];

    // Clear tabs
    this.tabs.clear();

    // Clear references
    this.tabsContainer = null;
    this.contentContainer = null;

    console.log('✅ TabManager: Disposed');
  }

  /**
   * Set active tab
   * @param {string} tabId - Tab ID to activate
   */
  setActiveTab(tabId) {
    if (!this.tabs.has(tabId)) {
      console.warn(`[TabManager] Invalid tab ID: ${tabId}`);
      return;
    }

    // Deactivate all tabs
    for (const [id, { button, pane }] of this.tabs.entries()) {
      button.classList.remove(CONFIG.CLASS_NAMES.ACTIVE_TAB);
      pane.classList.remove(CONFIG.CLASS_NAMES.ACTIVE_PANE);
    }

    // Activate target tab
    const { button, pane } = this.tabs.get(tabId);
    button.classList.add(CONFIG.CLASS_NAMES.ACTIVE_TAB);
    pane.classList.add(CONFIG.CLASS_NAMES.ACTIVE_PANE);

    // Update state
    this.activeTab = tabId;

    // Emit event
    this.eventBus.emit(EventTypes.ARTIFACTS.TAB_CHANGED, { 
      tab: tabId,
      timestamp: Date.now()
    });

    console.log(`[TabManager] Active tab: ${tabId}`);
  }

  /**
   * Get active tab
   * @returns {string} Active tab ID
   */
  getActiveTab() {
    return this.activeTab;
  }

  /**
   * Get pane element for a tab
   * @param {string} tabId - Tab ID
   * @returns {HTMLElement|null}
   */
  getPane(tabId) {
    const tab = this.tabs.get(tabId);
    return tab ? tab.pane : null;
  }

  /**
   * Get all panes
   * @returns {Map<string, HTMLElement>}
   */
  getAllPanes() {
    const panes = new Map();
    for (const [id, { pane }] of this.tabs.entries()) {
      panes.set(id, pane);
    }
    return panes;
  }

  /**
   * Show tab (make it visible in tab bar)
   * @param {string} tabId - Tab ID
   */
  showTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (tab) {
      tab.button.style.display = '';
    }
  }

  /**
   * Hide tab (remove from tab bar)
   * @param {string} tabId - Tab ID
   */
  hideTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (tab) {
      tab.button.style.display = 'none';
      // If hiding active tab, switch to first visible tab
      if (this.activeTab === tabId) {
        const firstVisible = Array.from(this.tabs.keys()).find(id => {
          const t = this.tabs.get(id);
          return t.button.style.display !== 'none';
        });
        if (firstVisible) {
          this.setActiveTab(firstVisible);
        }
      }
    }
  }

  /**
   * Get tab manager state
   * @returns {Object}
   */
  getState() {
    return freeze({
      activeTab: this.activeTab,
      tabs: Array.from(this.tabs.keys()),
      visibleTabs: Array.from(this.tabs.entries())
        .filter(([, { button }]) => button.style.display !== 'none')
        .map(([id]) => id),
    });
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Create tabs
   * @private
   */
  _createTabs() {
    // Define tabs in order
    const tabConfigs = [
      CONFIG.TABS.CODE,
      CONFIG.TABS.OUTPUT,
      CONFIG.TABS.FILES,
    ];

    for (const tabConfig of tabConfigs) {
      this._createTab(tabConfig);
    }

    console.log('[TabManager] Tabs created');
  }

  /**
   * Create a single tab
   * @param {Object} config - Tab configuration
   * @private
   */
  _createTab(config) {
    // Create tab button
    const button = document.createElement('button');
    button.className = CONFIG.CLASS_NAMES.TAB_BUTTON;
    button.dataset.tab = config.id;
    button.innerHTML = `<span class="tab-label">${config.label}</span>`;
    button.title = config.label;

    // Add click handler
    const handleClick = () => this._handleTabClick(config.id);
    button.addEventListener('click', handleClick);
    this._eventListeners.push(() => {
      button.removeEventListener('click', handleClick);
    });

    // Append to tabs container
    this.tabsContainer.appendChild(button);

    // Create content pane
    const pane = document.createElement('div');
    pane.className = `${CONFIG.CLASS_NAMES.PANE} ${this._getPaneClassName(config.id)}`;
    pane.dataset.tab = config.id;

    // Append to content container
    this.contentContainer.appendChild(pane);

    // Store tab reference
    this.tabs.set(config.id, { button, pane });

    console.log(`[TabManager] Created tab: ${config.id}`);
  }

  /**
   * Get pane class name for a tab
   * @param {string} tabId - Tab ID
   * @returns {string}
   * @private
   */
  _getPaneClassName(tabId) {
    switch (tabId) {
      case 'code':
        return CONFIG.CLASS_NAMES.CODE_PANE;
      case 'output':
        return CONFIG.CLASS_NAMES.OUTPUT_PANE;
      case 'files':
        return CONFIG.CLASS_NAMES.FILES_PANE;
      default:
        return '';
    }
  }

  /**
   * Handle tab click
   * @param {string} tabId - Tab ID
   * @private
   */
  _handleTabClick(tabId) {
    this.setActiveTab(tabId);
  }
}

// Export
module.exports = TabManager;

if (typeof window !== 'undefined') {
  window.TabManager = TabManager;
  console.log('📦 TabManager loaded');
}

