'use strict';

/**
 * Incoming: ArtifactsWindow containers, user tab interactions --- {event.dom, Event}
 * Processing: Build tabstrip, manage focusable tabs, emit selection changes --- {4 jobs: JOB_CREATE_DOM_ELEMENT, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_UPDATE_STATE}
 * Outgoing: Pane elements for Code/Output/Files, EventBus ARTIFACTS.TAB_CHANGED --- {dom.artifact_panel, HTMLElement}
 */

const { EventTypes } = require('../../../../core/events/EventTypes');
const { createRendererLogger } = require('../../../shared/utils/logger');
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
    this.log = createRendererLogger('TabManager');
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
    this._scrollPositions = new Map(); // tabId -> scrollTop (BUG TM-5 FIX: Persistent scroll memory)

    // State
    this.activeTab = CONFIG.DEFAULT_TAB;
    this._tabOrder = [];

    // Lifecycle flags — BUG TM-1 FIX
    this._isDisposed = false;
    this._initialized = false; // BUG TM-3 FIX: Guard against double-init

    // Event handlers (for cleanup)
    this._eventListeners = [];

    // Bind methods
    this._handleTabClick = this._handleTabClick.bind(this);
    this._handleTabKeydown = this._handleTabKeydown.bind(this);
  }

  /**
   * Initialize tab manager
   */
  async init() {
    // BUG TM-3 FIX: Prevent zombie resurrection after dispose and double-init
    if (this._isDisposed) return;
    if (this._initialized) return;
    this.log.debug('[TabManager] Initializing...');

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

      this._initialized = true; // BUG TM-3 FIX: Mark initialized

      // Emit ready event
      this.eventBus.emit(EventTypes.UI.COMPONENT_READY, { 
        component: 'TabManager',
        timestamp: Date.now()
      });

      this.log.debug('[TabManager] Initialized');

    } catch (error) {
      this.log.error('[TabManager] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Dispose tab manager and cleanup
   */
  dispose() {
    if (this._isDisposed) return; // BUG TM-1 FIX: Guard against double-dispose
    this._isDisposed = true; // BUG TM-6 FIX: Set FIRST to prevent re-entry during cleanup
    this.log.debug('[TabManager] Disposing...');

    // Remove event listeners
    for (const cleanup of this._eventListeners) {
      try {
        cleanup();
      } catch (error) {
        this.log.error('[TabManager] Failed to cleanup event listener:', error);
      }
    }
    this._eventListeners = [];

    // Clear tabs
    for (const [id, { button, pane }] of this.tabs.entries()) {
      if (button && button.parentNode) button.remove();
      if (pane && pane.parentNode) pane.remove();
    }
    this.tabs.clear();

    // BUG TM-6 FIX: Clear scroll positions to prevent memory leak
    this._scrollPositions.clear();

    // BUG TM-2 FIX: Reset state to prevent stale data from getActiveTab/getState
    this.activeTab = null;
    this._tabOrder = [];

    // Clear references
    this.tabsContainer = null;
    this.contentContainer = null;
    this.artifactsWindow = null;
    this.eventBus = null;

    this._initialized = false; // BUG TM-3 FIX: Reset init flag
    this.log.debug('[TabManager] Disposed');
  }

  /**
   * Set active tab
   * @param {string} tabId - Tab ID to activate
   */
  setActiveTab(tabId, options = {}) {
    if (this._isDisposed) return; // BUG TM-1 FIX: No-op after dispose
    this.log.debug('[TabManager] setActiveTab START', {
      tabId,
      currentActiveTab: this.activeTab,
      options,
      hasTab: this.tabs.has(tabId),
      timestamp: Date.now()
    });

    if (!this.tabs.has(tabId)) {
      this.log.warn(`[TabManager] Invalid tab ID: ${tabId}`, {
        requestedTab: tabId,
        availableTabs: Array.from(this.tabs.keys())
      });
      return;
    }

    const { focus = false } = options;
    const startTime = Date.now();

    // BUG TM-5 FIX: Save scroll position of previous tab BEFORE switching
    if (this.activeTab && this.activeTab !== tabId) {
      this._saveScrollPosition(this.activeTab);
    }

    this.log.debug('[TabManager] Updating tab UI states', { tabCount: this.tabs.size });

    for (const [id, { button, pane }] of this.tabs.entries()) {
      const isActive = id === tabId;
      button.classList.toggle(CONFIG.CLASS_NAMES.ACTIVE_TAB, isActive);
      pane.classList.toggle(CONFIG.CLASS_NAMES.ACTIVE_PANE, isActive);
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
      button.tabIndex = isActive ? 0 : -1;
      pane.setAttribute('aria-hidden', isActive ? 'false' : 'true');
    }

    const uiUpdateDuration = Date.now() - startTime;
    this.log.debug('[TabManager] Tab UI states updated', {
      duration: uiUpdateDuration + 'ms',
      activeTab: tabId
    });

    const target = this.tabs.get(tabId);
    if (focus && target?.button) {
      target.button.focus();
      this.log.debug('[TabManager] Focused tab button', { tabId });
    }

    this.activeTab = tabId;

    // BUG TM-5 FIX: Restore scroll position of new tab AFTER switching
    this._restoreScrollPosition(tabId);

    this.log.debug('[TabManager] Emitting TAB_CHANGED event', { tabId });
    this.eventBus.emit(EventTypes.ARTIFACTS.TAB_CHANGED, { 
      tab: tabId,
      timestamp: Date.now()
    });

    const totalDuration = Date.now() - startTime;
    this.log.debug('[TabManager] setActiveTab COMPLETE', {
      tabId,
      totalDuration: totalDuration + 'ms'
    });
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
    if (this._isDisposed) return; // BUG TM-1 FIX
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
    if (this._isDisposed) return; // BUG TM-1 FIX
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
    this._tabOrder = [];

    // Define tabs in order
    const tabConfigs = [
      CONFIG.TABS.CODE,
      CONFIG.TABS.OUTPUT,
      CONFIG.TABS.FILES,
    ];

    for (const tabConfig of tabConfigs) {
      this._createTab(tabConfig);
    }

    this.log.debug('[TabManager] Tabs created');
  }

  /**
   * Create a single tab
   * @param {Object} config - Tab configuration
   * @private
   */
  _createTab(config) {
    const paneId = `artifacts-pane-${config.id}`;
    const tabId = `artifacts-tab-${config.id}`;

    const button = document.createElement('button');
    button.className = CONFIG.CLASS_NAMES.TAB_BUTTON;
    button.dataset.tab = config.id;
    button.type = 'button';
    button.id = tabId;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', paneId);
    button.setAttribute('aria-selected', 'false');
    button.setAttribute('tabindex', '-1');
    button.innerHTML = `<span class="tab-label">${config.label}</span>`;
    button.title = config.label;

    const handleClick = () => this._handleTabClick(config.id);
    button.addEventListener('click', handleClick);
    button.addEventListener('keydown', this._handleTabKeydown);
    this._eventListeners.push(() => {
      button.removeEventListener('click', handleClick);
      button.removeEventListener('keydown', this._handleTabKeydown);
    });

    this.tabsContainer.appendChild(button);

    const pane = document.createElement('div');
    pane.className = `${CONFIG.CLASS_NAMES.PANE} ${this._getPaneClassName(config.id)}`;
    pane.dataset.tab = config.id;
    pane.id = paneId;
    pane.setAttribute('role', 'tabpanel');
    pane.setAttribute('aria-labelledby', tabId);
    pane.setAttribute('tabindex', '0');
    pane.setAttribute('aria-hidden', 'true');

    this.contentContainer.appendChild(pane);

    this.tabs.set(config.id, { button, pane });
    this._tabOrder.push(config.id);

    this.log.debug(`[TabManager] Created tab: ${config.id}`);
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

  _handleTabKeydown(event) {
    const tabId = event.currentTarget?.dataset?.tab;
    if (!tabId) {
      return;
    }

    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        this._focusRelativeTab(1, tabId);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        this._focusRelativeTab(-1, tabId);
        break;
      case 'Home':
        event.preventDefault();
        this._focusEdgeTab('first');
        break;
      case 'End':
        event.preventDefault();
        this._focusEdgeTab('last');
        break;
      case ' ':
      case 'Enter':
        event.preventDefault();
        this.setActiveTab(tabId, { focus: true });
        break;
      default:
        break;
    }
  }

  _focusRelativeTab(delta, originTab) {
    if (this._tabOrder.length === 0) {
      return;
    }

    const currentIndex = this._tabOrder.indexOf(originTab);
    if (currentIndex === -1) {
      return;
    }

    const nextIndex = (currentIndex + delta + this._tabOrder.length) % this._tabOrder.length;
    const nextTabId = this._tabOrder[nextIndex];
    this.setActiveTab(nextTabId, { focus: true });
  }

  _focusEdgeTab(position) {
    if (this._tabOrder.length === 0) {
      return;
    }

    const nextTabId = position === 'first'
      ? this._tabOrder[0]
      : this._tabOrder[this._tabOrder.length - 1];

    this.setActiveTab(nextTabId, { focus: true });
  }

  /**
   * Save scroll position for a tab (BUG TM-5 FIX)
   * @param {string} tabId 
   * @private
   */
  _saveScrollPosition(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab || !tab.pane) return;
    
    // Find the scrollable container within the pane
    const scrollable = tab.pane.querySelector('.output-content, .code-content, .file-list, .file-manager-container');
    if (scrollable) {
      this._scrollPositions.set(tabId, scrollable.scrollTop);
      this.log.debug(`[TabManager] Saved scroll position for ${tabId}: ${scrollable.scrollTop}`);
    }
  }

  /**
   * Restore scroll position for a tab (BUG TM-5 FIX)
   * @param {string} tabId
   * @private
   */
  _restoreScrollPosition(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab || !tab.pane) return;

    const scrollable = tab.pane.querySelector('.output-content, .code-content, .file-list, .file-manager-container');
    if (scrollable) {
      const pos = this._scrollPositions.get(tabId) || 0;

      // Use requestAnimationFrame to ensure DOM/styles are settled before restoring scroll
      requestAnimationFrame(() => {
        // BUG TM-6 FIX: Guard against disposed state in async callback
        if (this._isDisposed) return;
        if (scrollable && this.activeTab === tabId) {
          scrollable.scrollTop = pos;
          this.log.debug(`[TabManager] Restored scroll position for ${tabId}: ${pos}`);
        }
      });
    }
  }
}

// Export
module.exports = TabManager;

if (typeof window !== 'undefined') {
  window.TabManager = TabManager;
}
