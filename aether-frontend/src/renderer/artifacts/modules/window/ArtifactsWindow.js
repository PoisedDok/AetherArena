'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactsController (init calls), User interactions (drag header, click close button, keyboard Escape) --- {dom_types.dom_event, Event}
 * Processing: Create window DOM structure (header with tabs+controls, content area for panes), manage visibility state (show/hide/toggle with CSS transitions), implement drag-to-move via mousedown/mousemove/mouseup, emit window lifecycle events --- {5 jobs: JOB_CREATE_DOM_ELEMENT, JOB_GET_STATE, JOB_UPDATE_STATE, JOB_EMIT_EVENT, JOB_UPDATE_STATE}
 * Outgoing: DOM (floating window with glassmorphism effect), EventBus (WINDOW_SHOWN/HIDDEN/MOVED), TabManager/CodeViewer/OutputViewer (via container elements) --- {dom_types.chat_entry_element, HTMLElement}
 * 
 * 
 * @module renderer/artifacts/modules/window/ArtifactsWindow
 */

const { EventTypes } = require('../../../../core/events/EventTypes');
const { freeze } = Object;

// Window configuration
const CONFIG = freeze({
  WINDOW: freeze({
    MIN_WIDTH: 400,
    MIN_HEIGHT: 300,
    DEFAULT_WIDTH: 800,
    DEFAULT_HEIGHT: 600,
    DEFAULT_POSITION: freeze({ x: 100, y: 100 }),
    DRAG_HANDLE_SELECTOR: '.artifacts-header',
  }),
  ANIMATION: freeze({
    DURATION: 300,
    EASING: 'cubic-bezier(0.4, 0, 0.2, 1)',
  }),
  ZINDEX: freeze({
    WINDOW: 1000,
    OVERLAY: 999,
  }),
  CLASS_NAMES: freeze({
    WINDOW: 'artifacts-window',
    HEADER: 'artifacts-header',
    TITLE: 'artifacts-title',
    TABS: 'artifacts-tabs',
    TAB_BUTTON: 'artifacts-tab',
    ACTIVE_TAB: 'active',
    CONTROLS: 'artifacts-controls',
    CONTROL_BTN: 'artifacts-control-btn',
    CONTENT: 'artifacts-content',
    PANE: 'artifacts-pane',
    ACTIVE_PANE: 'active',
    HIDDEN: 'hidden',
    VISIBLE: 'visible',
    DRAGGING: 'dragging',
  }),
});

class ArtifactsWindow {
  /**
   * Create artifacts window manager
   * @param {Object} options - Configuration options
   * @param {Object} options.controller - Artifacts controller instance
   * @param {Object} options.eventBus - Event bus for communication
   */
  constructor(options = {}) {
    if (!options.controller) {
      throw new Error('[ArtifactsWindow] Controller required');
    }

    if (!options.eventBus) {
      throw new Error('[ArtifactsWindow] EventBus required');
    }

    this.controller = options.controller;
    this.eventBus = options.eventBus;

    // DOM elements
    this.element = null;
    this.header = null;
    this.title = null;
    this.tabsContainer = null;
    this.controlsContainer = null;
    this.contentContainer = null;
    this.closeButton = null;

    // State
    this.visible = false;
    this.position = { ...CONFIG.WINDOW.DEFAULT_POSITION };
    this.size = { 
      width: CONFIG.WINDOW.DEFAULT_WIDTH, 
      height: CONFIG.WINDOW.DEFAULT_HEIGHT 
    };
    this.minimized = false;

    // Event handlers (for cleanup)
    this._eventListeners = [];

    // Bind methods
    this._handleClose = this._handleClose.bind(this);
    this._handleDragStart = this._handleDragStart.bind(this);
    this._handleDrag = this._handleDrag.bind(this);
    this._handleDragEnd = this._handleDragEnd.bind(this);
  }

  /**
   * Initialize window
   */
  async init() {
    console.log('🪟 ArtifactsWindow: Initializing...');

    try {
      // Create DOM structure
      this._createElement();

      // Inject styles
      this._injectStyles();

      // Setup event listeners
      this._setupEventListeners();

      // Emit ready event
      this.eventBus.emit(EventTypes.UI.COMPONENT_READY, { 
        component: 'ArtifactsWindow',
        timestamp: Date.now()
      });

      console.log('✅ ArtifactsWindow: Initialized');

    } catch (error) {
      console.error('❌ ArtifactsWindow: Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Dispose window and cleanup
   */
  dispose() {
    console.log('🛑 ArtifactsWindow: Disposing...');

    // Remove event listeners
    for (const cleanup of this._eventListeners) {
      try {
        cleanup();
      } catch (error) {
        console.error('[ArtifactsWindow] Failed to cleanup event listener:', error);
      }
    }
    this._eventListeners = [];

    // Remove element from DOM
    if (this.element && this.element.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }

    // Clear references
    this.element = null;
    this.header = null;
    this.title = null;
    this.tabsContainer = null;
    this.controlsContainer = null;
    this.contentContainer = null;
    this.closeButton = null;

    console.log('✅ ArtifactsWindow: Disposed');
  }

  /**
   * Show window
   */
  show() {
    if (this.visible) return;

    this.element.classList.remove(CONFIG.CLASS_NAMES.HIDDEN);
    this.element.classList.add(CONFIG.CLASS_NAMES.VISIBLE);
    this.visible = true;

    this.eventBus.emit(EventTypes.UI.WINDOW_SHOWN, { window: 'artifacts' });
    console.log('[ArtifactsWindow] Window shown');
  }

  /**
   * Hide window
   */
  hide() {
    if (!this.visible) return;

    this.element.classList.remove(CONFIG.CLASS_NAMES.VISIBLE);
    this.element.classList.add(CONFIG.CLASS_NAMES.HIDDEN);
    this.visible = false;

    this.eventBus.emit(EventTypes.UI.WINDOW_HIDDEN, { window: 'artifacts' });
    console.log('[ArtifactsWindow] Window hidden');
  }

  /**
   * Toggle window visibility
   */
  toggle() {
    if (this.visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  /**
   * Get window element (for tab/content injection)
   * @returns {HTMLElement}
   */
  getElement() {
    return this.element;
  }

  /**
   * Get tabs container
   * @returns {HTMLElement}
   */
  getTabsContainer() {
    return this.tabsContainer;
  }

  /**
   * Get content container
   * @returns {HTMLElement}
   */
  getContentContainer() {
    return this.contentContainer;
  }

  /**
   * Get window state
   * @returns {Object}
   */
  getState() {
    return freeze({
      visible: this.visible,
      position: { ...this.position },
      size: { ...this.size },
      minimized: this.minimized,
    });
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Create DOM element structure
   * @private
   */
  _createElement() {
    // Create main window container
    this.element = document.createElement('div');
    this.element.className = `${CONFIG.CLASS_NAMES.WINDOW} ${CONFIG.CLASS_NAMES.HIDDEN}`;

    // Create header
    this.header = document.createElement('div');
    this.header.className = CONFIG.CLASS_NAMES.HEADER;

    // Create title
    this.title = document.createElement('div');
    this.title.className = CONFIG.CLASS_NAMES.TITLE;
    this.title.textContent = 'ARTIFACTS';

    // Create tabs container
    this.tabsContainer = document.createElement('div');
    this.tabsContainer.className = CONFIG.CLASS_NAMES.TABS;

    // Create controls container
    this.controlsContainer = document.createElement('div');
    this.controlsContainer.className = CONFIG.CLASS_NAMES.CONTROLS;

    // Create close button
    this.closeButton = document.createElement('button');
    this.closeButton.className = CONFIG.CLASS_NAMES.CONTROL_BTN;
    this.closeButton.id = 'artifacts-close';
    this.closeButton.textContent = '×';
    this.closeButton.title = 'Close';

    // Assemble header
    this.controlsContainer.appendChild(this.closeButton);
    this.header.appendChild(this.title);
    this.header.appendChild(this.tabsContainer);
    this.header.appendChild(this.controlsContainer);

    // Create content container
    this.contentContainer = document.createElement('div');
    this.contentContainer.className = CONFIG.CLASS_NAMES.CONTENT;

    // Assemble window
    this.element.appendChild(this.header);
    this.element.appendChild(this.contentContainer);

    // Append to body
    document.body.appendChild(this.element);

    console.log('[ArtifactsWindow] DOM structure created');
  }

  /**
   * Setup event listeners
   * @private
   */
  _setupEventListeners() {
    // Close button
    if (this.closeButton) {
      this.closeButton.addEventListener('click', this._handleClose);
      this._eventListeners.push(() => {
        this.closeButton.removeEventListener('click', this._handleClose);
      });
    }

    // Drag handling
    if (this.header) {
      this.header.addEventListener('mousedown', this._handleDragStart);
      this._eventListeners.push(() => {
        this.header.removeEventListener('mousedown', this._handleDragStart);
      });
    }

    console.log('[ArtifactsWindow] Event listeners setup');
  }

  /**
   * Handle close button click
   * @private
   */
  _handleClose() {
    this.hide();
  }

  /**
   * Handle drag start
   * @private
   */
  _handleDragStart(e) {
    // Only start drag from header, not from tabs or buttons
    if (!e.target.matches(`.${CONFIG.CLASS_NAMES.HEADER}, .${CONFIG.CLASS_NAMES.TITLE}`)) {
      return;
    }

    e.preventDefault();

    // Store initial mouse position
    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = this.element.offsetLeft;
    const startTop = this.element.offsetTop;

    // Add dragging class
    this.element.classList.add(CONFIG.CLASS_NAMES.DRAGGING);

    // Mouse move handler
    const handleMove = (moveEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;

      const newLeft = startLeft + deltaX;
      const newTop = startTop + deltaY;

      // Update position
      this.element.style.left = `${newLeft}px`;
      this.element.style.top = `${newTop}px`;

      this.position.x = newLeft;
      this.position.y = newTop;
    };

    // Mouse up handler
    const handleUp = () => {
      // Remove dragging class
      this.element.classList.remove(CONFIG.CLASS_NAMES.DRAGGING);

      // Remove event listeners
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);

      // Emit position changed event
      this.eventBus.emit(EventTypes.UI.WINDOW_MOVED, { 
        window: 'artifacts',
        position: { ...this.position }
      });
    };

    // Add event listeners
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
  }

  /**
   * Handle drag move
   * @private
   */
  _handleDrag(e) {
    // Implemented in _handleDragStart for simplicity
  }

  /**
   * Handle drag end
   * @private
   */
  _handleDragEnd(e) {
    // Implemented in _handleDragStart for simplicity
  }

  _injectStyles() {
    console.log('[ArtifactsWindow] Global CSS loaded from artifacts.css using theme variables');
  }
}

// Export
module.exports = ArtifactsWindow;

if (typeof window !== 'undefined') {
  window.ArtifactsWindow = ArtifactsWindow;
  console.log('📦 ArtifactsWindow loaded');
}

