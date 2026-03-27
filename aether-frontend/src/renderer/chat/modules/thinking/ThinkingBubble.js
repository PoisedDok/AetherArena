'use strict';

const { createRendererLogger } = require('../../../shared/utils/logger');

/**
 * @.architecture
 * 
 * Incoming: MessageView (create instance), Backend reasoning stream data --- {string, text}
 * Processing: Create collapsible UI widget (collapsed 36px → partial 150px → expanded auto), handle click-to-toggle state transitions, stream content updates with auto-scroll, animate chevron rotation (0°→90°→180°), observe content mutations for scroll --- {4 jobs: JOB_CREATE_DOM_ELEMENT, JOB_GET_STATE, JOB_UPDATE_DOM_ELEMENT, JOB_EMIT_EVENT}
 * Outgoing: DOM (animated thinking bubble with reasoning text) --- {dom_types.chat_entry_element, HTMLElement}
 * 
 * 
 * @module renderer/chat/modules/thinking/ThinkingBubble
 */

const { freeze } = Object;

/**
 * ThinkingBubble configuration constants
 */
const CONFIG = freeze({
  STATES: freeze({
    COLLAPSED: 'collapsed',
    PARTIAL: 'partial',
    EXPANDED: 'expanded',
  }),
  ANIMATION_DURATION: 500, // ms
  SCROLL_DELAY: 100, // ms
  HEIGHTS: freeze({
    COLLAPSED: 36,
    PARTIAL: 150,
  }),
  WIDTHS: freeze({
    COLLAPSED: 160,
  }),
});

/**
 * ThinkingBubble
 */
class ThinkingBubble {
  constructor(options = {}) {
    // Configuration
    this.parentElement = options.parentElement || document.body;
    this.initialState = options.initialState || CONFIG.STATES.PARTIAL;
    this.content = options.content || '';
    this.reasoningNumber = options.reasoningNumber || null;
    this.log = createRendererLogger('ThinkingBubble');

    // State
    this.currentState = this.initialState;
    this.isAnimating = false;
    this.isVisible = false;

    // DOM references
    this.container = null;
    this.header = null;
    this.headerText = null;
    this.chevronIcon = null;
    this.contentWrapper = null;
    this.contentContainer = null;

    // Observers
    this.mutationObserver = null;

    // Event listener cleanup
    this._eventListeners = [];

    // Timers cleanup
    this._timers = [];

    this.log.trace('constructed');
  }

  /**
   * Initialize bubble
   */
  init() {
    this.log.debug('initializing');

    try {
      // Inject styles
      this._injectStyles();

      // Create DOM elements
      this._createElements();

      // Setup event listeners
      this._setupEventListeners();

      // Apply initial state
      this._applyState(this.currentState, true);

      // Initially hidden
      this.setVisibility(false);

      this.log.debug('initialization complete');
    } catch (error) {
      this.log.error('initialization failed', { error });
      throw error;
    }
  }

  _injectStyles() {
    this.log.trace('styles loaded from external CSS');
  }

  /**
   * Create DOM elements
   * @private
   */
  _createElements() {
    // Create main container
    this.container = document.createElement('div');
    this.container.className = 'aether-thinking-bubble';
    this.container.dataset.state = this.currentState;

    // Create header
    this.header = document.createElement('div');
    this.header.className = 'aether-thinking-bubble-header';

    // Create header text
    this.headerText = document.createElement('div');
    this.headerText.className = 'aether-thinking-bubble-title';
    this.headerText.innerHTML = `
      <div class="trail-status-icon">
        <div class="trail-status-spinner"></div>
      </div>
      <span class="trail-title-text">${this.reasoningNumber ? `Reasoning ${this.reasoningNumber}` : 'Reasoning'}</span>
    `;

    // Create chevron icon
    this.chevronIcon = document.createElement('div');
    this.chevronIcon.className = 'aether-thinking-bubble-chevron';
    this.chevronIcon.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>
    `;

    // Assemble header
    this.header.appendChild(this.headerText);
    this.header.appendChild(this.chevronIcon);

    // Create content wrapper
    this.contentWrapper = document.createElement('div');
    this.contentWrapper.className = 'aether-thinking-bubble-content-wrapper';

    // Create content container
    this.contentContainer = document.createElement('div');
    this.contentContainer.className = 'aether-thinking-bubble-content';

    // Set initial content if provided
    if (this.content) {
      this.updateContent(this.content);
    }

    // Assemble content
    this.contentWrapper.appendChild(this.contentContainer);

    // Assemble bubble
    this.container.appendChild(this.header);
    this.container.appendChild(this.contentWrapper);

    // Add to parent
    this.parentElement.appendChild(this.container);

    this.log.trace('elements created');
  }

  /**
   * Setup event listeners
   * @private
   */
  _setupEventListeners() {
    // Header click to toggle state
    const headerClickHandler = () => this.toggle();
    this.header.addEventListener('click', headerClickHandler);
    this._eventListeners.push({ element: this.header, event: 'click', handler: headerClickHandler });

    // Observe content changes for auto-scroll
    this.mutationObserver = new MutationObserver(() => {
      if (this.currentState === CONFIG.STATES.PARTIAL || this.currentState === CONFIG.STATES.EXPANDED) {
        this._scrollToBottom();
      }
    });

    this.mutationObserver.observe(this.contentContainer, {
      childList: true,
      subtree: true,
      characterData: true
    });

    this.log.trace('event listeners setup');
  }

  /**
   * Toggle between states
   */
  toggle() {
    if (this.isAnimating) {
      this.log.trace('toggle ignored during animation');
      return;
    }

    // Determine next state
    let nextState;
    switch (this.currentState) {
      case CONFIG.STATES.COLLAPSED:
        nextState = CONFIG.STATES.PARTIAL;
        break;
      case CONFIG.STATES.PARTIAL:
        nextState = CONFIG.STATES.EXPANDED;
        break;
      case CONFIG.STATES.EXPANDED:
        nextState = CONFIG.STATES.COLLAPSED;
        break;
      default:
        nextState = CONFIG.STATES.PARTIAL;
    }

    this._applyState(nextState);
  }

  /**
   * Apply state
   * @private
   * @param {string} state
   * @param {boolean} [skipAnimation=false]
   */
  _applyState(state, skipAnimation = false) {
    const prevState = this.currentState;
    this.currentState = state;
    this.container.dataset.state = state;

    this.log.trace('state transition', { from: prevState, to: state });

    if (!skipAnimation) {
      this.isAnimating = true;

      // Add animation classes
      this.container.classList.add('animating');
      this.container.classList.add(`transition-to-${state}`);

      // Animate chevron
      this._animateChevron(state, prevState);

      // Remove animation classes after animation completes
      const timerId = setTimeout(() => {
        if (this.container) {
          this.container.classList.remove('animating');
          this.container.classList.remove(`transition-to-${state}`);
        }
        this.isAnimating = false;
      }, CONFIG.ANIMATION_DURATION);
      this._timers.push(timerId);
    }

    // Scroll to bottom for PARTIAL state
    if (state === CONFIG.STATES.PARTIAL) {
      this._scrollToBottom();
    }
  }

  /**
   * Animate chevron
   * @private
   * @param {string} toState
   * @param {string} fromState
   */
  _animateChevron(toState, fromState) {
    // Clear existing rotation classes
    this.chevronIcon.classList.remove('rotate-0', 'rotate-90', 'rotate-180');

    // Apply rotation based on state
    switch (toState) {
      case CONFIG.STATES.COLLAPSED:
        this.chevronIcon.classList.add('rotate-0');
        break;
      case CONFIG.STATES.PARTIAL:
        this.chevronIcon.classList.add('rotate-90');
        break;
      case CONFIG.STATES.EXPANDED:
        this.chevronIcon.classList.add('rotate-180');
        break;
    }

    // Add spring animation for collapse
    if (toState === CONFIG.STATES.COLLAPSED) {
      this.chevronIcon.classList.add('spring-animation');
      const timerId = setTimeout(() => {
        if (this.chevronIcon) {
          this.chevronIcon.classList.remove('spring-animation');
        }
      }, CONFIG.ANIMATION_DURATION);
      this._timers.push(timerId);
    }
  }

  /**
   * Update content (replaces existing content)
   * @param {string|Node} content
   */
  updateContent(content) {
    if (typeof content === 'string') {
      this.contentContainer.innerHTML = content;
    } else if (content instanceof Node) {
      this.contentContainer.innerHTML = '';
      this.contentContainer.appendChild(content);
    }

    this._scrollToBottom();
  }

  /**
   * Append content (adds to existing content)
   * @param {string|Node} content
   */
  appendContent(content) {
    if (typeof content === 'string') {
      const div = document.createElement('div');
      div.innerHTML = content;
      this.contentContainer.appendChild(div);
    } else if (content instanceof Node) {
      this.contentContainer.appendChild(content);
    }

    this._scrollToBottom();
  }

  /**
   * Scroll content to bottom
   * @private
   */
  _scrollToBottom() {
    const timerId = setTimeout(() => {
      if (this.currentState === CONFIG.STATES.PARTIAL || this.currentState === CONFIG.STATES.EXPANDED) {
        if (this.contentWrapper) {
          this.contentWrapper.scrollTop = this.contentWrapper.scrollHeight;
        }
      }
    }, CONFIG.SCROLL_DELAY);
    this._timers.push(timerId);
  }

  /**
   * Set visibility
   * @param {boolean} isVisible
   */
  setVisibility(isVisible) {
    this.isVisible = isVisible;

    if (isVisible) {
      this.container.classList.remove('hidden');
      this.log.trace('visible');
    } else {
      this.container.classList.add('hidden');
      this.log.trace('hidden');
    }
  }

  /**
   * Show bubble
   */
  show() {
    this.setVisibility(true);
  }

  /**
   * Hide bubble
   */
  hide() {
    this.setVisibility(false);
  }

  /**
   * Set state directly
   * @param {string} state
   */
  setState(state) {
    if (CONFIG.STATES[state.toUpperCase()]) {
      this._applyState(CONFIG.STATES[state.toUpperCase()]);
    }
  }

  /**
   * Get current state
   * @returns {Object}
   */
  getState() {
    return freeze({
      currentState: this.currentState,
      isVisible: this.isVisible,
      isAnimating: this.isAnimating
    });
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    this.log.info('disposing');

    // Disconnect mutation observer
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
    }

    // Clear timers
    if (this._timers) {
      for (const timerId of this._timers) {
        clearTimeout(timerId);
      }
      this._timers = [];
    }

    // Remove event listeners
    for (const { element, event, handler } of this._eventListeners) {
      element.removeEventListener(event, handler);
    }
    this._eventListeners = [];

    // Remove DOM element
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }

    // Clear references
    this.container = null;
    this.header = null;
    this.headerText = null;
    this.chevronIcon = null;
    this.contentWrapper = null;
    this.contentContainer = null;
    this.parentElement = null;

    this.log.debug('disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ThinkingBubble;
}

if (typeof window !== 'undefined') {
  window.ThinkingBubble = ThinkingBubble;
  createRendererLogger('ThinkingBubble').debug('module loaded');
}
