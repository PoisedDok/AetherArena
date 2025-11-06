'use strict';

/**
 * @.architecture
 * 
 * Incoming: MessageView (create instance), Backend reasoning stream data --- {string, text}
 * Processing: Create collapsible UI widget (collapsed 36px → partial 150px → expanded auto), handle click-to-toggle state transitions, stream content updates with auto-scroll, animate chevron rotation (0°→90°→180°), observe content mutations for scroll --- {5 jobs: JOB_CREATE_DOM_ELEMENT, JOB_UPDATE_STATE, JOB_GET_STATE, JOB_UPDATE_STATE, JOB_EMIT_EVENT}
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

    console.log('[ThinkingBubble] Constructed');
  }

  /**
   * Initialize bubble
   */
  init() {
    console.log('[ThinkingBubble] Initializing...');

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

      console.log('[ThinkingBubble] Initialization complete');
    } catch (error) {
      console.error('[ThinkingBubble] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Inject styles
   * @private
   */
  _injectStyles() {
    if (document.getElementById('thinking-bubble-styles')) {
      console.log('[ThinkingBubble] Styles already injected');
      return;
    }

    const style = document.createElement('style');
    style.id = 'thinking-bubble-styles';
    style.textContent = `
      .aether-thinking-bubble {
        margin: 16px 0;
        border-radius: 16px;
        background-color: rgba(255, 100, 0, 0.1);
        border: 1px solid rgba(255, 100, 0, 0.3);
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
        overflow: hidden;
        max-width: 100%;
        opacity: 1;
        transition: height 0.5s cubic-bezier(0.2, 0, 0.2, 1),
                    opacity 0.3s ease,
                    width 0.5s cubic-bezier(0.2, 0, 0.2, 1),
                    box-shadow 0.3s ease;
      }
      
      .aether-thinking-bubble.animating {
        will-change: height, opacity, width;
      }
      
      .aether-thinking-bubble[data-state="collapsed"] {
        height: ${CONFIG.HEIGHTS.COLLAPSED}px;
        width: ${CONFIG.WIDTHS.COLLAPSED}px;
        opacity: 0.65;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
      }
      
      .aether-thinking-bubble[data-state="partial"] {
        height: ${CONFIG.HEIGHTS.PARTIAL}px;
        width: 100%;
      }
      
      .aether-thinking-bubble[data-state="expanded"] {
        height: auto;
        width: 100%;
        max-height: 80vh;
      }
      
      .aether-thinking-bubble-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 16px;
        cursor: pointer;
        user-select: none;
        -webkit-user-select: none;
      }
      
      .aether-thinking-bubble-title {
        font-weight: 600;
        font-size: 14px;
        color: #ff9500;
        letter-spacing: 0.5px;
      }
      
      .aether-thinking-bubble-chevron {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border-radius: 50%;
        background-color: rgba(255, 100, 0, 0.2);
        border: 1px solid rgba(255, 100, 0, 0.4);
        color: #ff9500;
        transition: transform 0.45s cubic-bezier(0.2, 0, 0.2, 1);
      }
      
      .aether-thinking-bubble[data-state="collapsed"] .aether-thinking-bubble-chevron {
        width: 20px;
        height: 20px;
      }
      
      .aether-thinking-bubble-chevron svg {
        transition: transform 0.45s cubic-bezier(0.2, 0, 0.2, 1);
      }
      
      .aether-thinking-bubble-chevron.rotate-0 {
        transform: rotate(0deg);
      }
      
      .aether-thinking-bubble-chevron.rotate-90 {
        transform: rotate(90deg);
      }
      
      .aether-thinking-bubble-chevron.rotate-180 {
        transform: rotate(180deg);
      }
      
      .aether-thinking-bubble-chevron.spring-animation {
        animation: thinking-spring-bounce 0.5s cubic-bezier(0.28, 0.84, 0.42, 1);
      }
      
      @keyframes thinking-spring-bounce {
        0% { transform: scale(1) rotate(0deg); }
        30% { transform: scale(1.2) rotate(0deg); }
        60% { transform: scale(0.9) rotate(0deg); }
        100% { transform: scale(1) rotate(0deg); }
      }
      
      .aether-thinking-bubble-content-wrapper {
        height: 100%;
        overflow-y: auto;
        overflow-x: hidden;
        position: relative;
      }
      
      .aether-thinking-bubble-content-wrapper::-webkit-scrollbar {
        width: 6px;
      }
      
      .aether-thinking-bubble-content-wrapper::-webkit-scrollbar-track {
        background: transparent;
      }
      
      .aether-thinking-bubble-content-wrapper::-webkit-scrollbar-thumb {
        background: rgba(255, 149, 0, 0.3);
        border-radius: 3px;
      }
      
      .aether-thinking-bubble-content-wrapper::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 149, 0, 0.5);
      }
      
      .aether-thinking-bubble-content-wrapper {
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 149, 0, 0.3) transparent;
      }
      
      .aether-thinking-bubble[data-state="partial"] .aether-thinking-bubble-content-wrapper {
        mask-image: linear-gradient(to bottom, transparent 0px, black 30px, black 100%);
        -webkit-mask-image: linear-gradient(to bottom, transparent 0px, black 30px, black 100%);
      }
      
      .aether-thinking-bubble[data-state="expanded"] .aether-thinking-bubble-content-wrapper {
        max-height: 70vh;
        overflow-y: auto;
      }
      
      .aether-thinking-bubble-content {
        padding: 0 16px 16px;
        line-height: 1.5;
        color: #ff9500;
        font-size: 14px;
        white-space: pre-wrap;
        font-family: 'Courier New', monospace;
        word-wrap: break-word;
      }
      
      .aether-thinking-bubble[data-state="collapsed"] .aether-thinking-bubble-content {
        display: none;
      }
      
      .aether-thinking-bubble.hidden {
        display: none;
      }
    `;

    document.head.appendChild(style);
    console.log('[ThinkingBubble] Styles injected');
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
    this.headerText = document.createElement('span');
    this.headerText.className = 'aether-thinking-bubble-title';
    this.headerText.textContent = this.reasoningNumber ? `Reasoning ${this.reasoningNumber}` : 'Reasoning';

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

    console.log('[ThinkingBubble] Elements created');
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

    console.log('[ThinkingBubble] Event listeners setup');
  }

  /**
   * Toggle between states
   */
  toggle() {
    if (this.isAnimating) {
      console.log('[ThinkingBubble] Animation in progress, ignoring toggle');
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

    console.log(`[ThinkingBubble] State: ${prevState} → ${state}`);

    if (!skipAnimation) {
      this.isAnimating = true;

      // Add animation classes
      this.container.classList.add('animating');
      this.container.classList.add(`transition-to-${state}`);

      // Animate chevron
      this._animateChevron(state, prevState);

      // Remove animation classes after animation completes
      setTimeout(() => {
        this.container.classList.remove('animating');
        this.container.classList.remove(`transition-to-${state}`);
        this.isAnimating = false;
      }, CONFIG.ANIMATION_DURATION);
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
      setTimeout(() => {
        this.chevronIcon.classList.remove('spring-animation');
      }, CONFIG.ANIMATION_DURATION);
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
    setTimeout(() => {
      if (this.currentState === CONFIG.STATES.PARTIAL || this.currentState === CONFIG.STATES.EXPANDED) {
        if (this.contentWrapper) {
          this.contentWrapper.scrollTop = this.contentWrapper.scrollHeight;
        }
      }
    }, CONFIG.SCROLL_DELAY);
  }

  /**
   * Set visibility
   * @param {boolean} isVisible
   */
  setVisibility(isVisible) {
    this.isVisible = isVisible;

    if (isVisible) {
      this.container.classList.remove('hidden');
      console.log('[ThinkingBubble] Visible');
    } else {
      this.container.classList.add('hidden');
      console.log('[ThinkingBubble] Hidden');
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
    console.log('[ThinkingBubble] Disposing...');

    // Disconnect mutation observer
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
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

    console.log('[ThinkingBubble] Disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ThinkingBubble;
}

if (typeof window !== 'undefined') {
  window.ThinkingBubble = ThinkingBubble;
  console.log('📦 ThinkingBubble loaded');
}

