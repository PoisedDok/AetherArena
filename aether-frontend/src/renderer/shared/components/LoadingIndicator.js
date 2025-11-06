'use strict';

/**
 * @.architecture
 * 
 * Incoming: All UI modules (.show/.hide/.setProgress calls) --- {method_calls, javascript_api}
 * Processing: Create DOM with CSS animations (4 styles: spinner/pulse/dots/skeleton), inject styles, show/hide with fade, update progress bar (0-100), update message text, accessibility (aria-live polite) --- {5 jobs: JOB_CREATE_DOM_ELEMENT, JOB_UPDATE_STATE, JOB_UPDATE_STATE, JOB_UPDATE_STATE, JOB_UPDATE_STATE}
 * Outgoing: DOM container with loading indicators, return cleanup functions --- {dom_types.loading_element, HTMLElement}
 * 
 * 
 * @module renderer/shared/components/LoadingIndicator
 * 
 * LoadingIndicator - Production-Ready Loading State Component
 * ============================================================================
 * Provides loading indicator functionality with:
 * - Multiple styles (spinner, pulse, skeleton)
 * - Configurable size and color
 * - Overlay mode support
 * - Progress tracking
 * - Smooth animations
 * - Accessibility support
 * 
 * Responsibilities:
 * - Show/hide loading states
 * - Render appropriate loading style
 * - Track and display progress
 * - Provide accessibility labels
 * - Clean DOM management
 * 
 * Architecture:
 * - Lightweight component (no framework dependencies)
 * - CSS-based animations
 * - Flexible configuration
 * - Production-ready error handling
 */

const { freeze } = Object;

// Loading indicator configuration
const CONFIG = freeze({
  STYLES: freeze({
    SPINNER: 'spinner',
    PULSE: 'pulse',
    SKELETON: 'skeleton',
    DOTS: 'dots',
  }),
  SIZES: freeze({
    SMALL: 'small',
    MEDIUM: 'medium',
    LARGE: 'large',
  }),
  CLASS_NAMES: freeze({
    CONTAINER: 'loading-indicator',
    OVERLAY: 'loading-overlay',
    SPINNER: 'loading-spinner',
    PULSE: 'loading-pulse',
    SKELETON: 'loading-skeleton',
    DOTS: 'loading-dots',
    MESSAGE: 'loading-message',
    PROGRESS: 'loading-progress',
    PROGRESS_BAR: 'loading-progress-bar',
  }),
});

class LoadingIndicator {
  /**
   * Create loading indicator
   * @param {Object} options - Configuration options
   * @param {HTMLElement} options.container - Container element
   * @param {string} options.style - Loading style (spinner, pulse, skeleton, dots)
   * @param {string} options.size - Size (small, medium, large)
   * @param {string} options.message - Loading message
   * @param {boolean} options.overlay - Show as overlay (default: false)
   * @param {string} options.color - Custom color
   */
  constructor(options = {}) {
    // Configuration
    this.container = options.container || document.body;
    this.style = options.style || CONFIG.STYLES.SPINNER;
    this.size = options.size || CONFIG.SIZES.MEDIUM;
    this.message = options.message || '';
    this.overlay = options.overlay !== undefined ? options.overlay : false;
    this.color = options.color || 'rgba(255, 100, 0, 1)';

    // State
    this.isVisible = false;
    this.progress = null; // null = indeterminate, 0-100 = determinate

    // DOM references
    this.element = null;
    this.progressBar = null;
    this.messageElement = null;

    console.log('[LoadingIndicator] Constructed');
  }

  /**
   * Initialize loading indicator
   * Creates DOM structure and injects styles
   */
  init() {
    console.log('[LoadingIndicator] Initializing...');

    // Inject styles
    this._injectStyles();

    // Create element
    this._createElement();

    console.log('[LoadingIndicator] Initialized');
  }

  /**
   * Show loading indicator
   * @param {string} message - Optional message override
   * @param {number} progress - Optional progress value (0-100)
   */
  show(message = null, progress = null) {
    if (!this.element) {
      this.init();
    }

    // Update message
    if (message !== null && this.messageElement) {
      this.messageElement.textContent = message;
      this.message = message;
    }

    // Update progress
    if (progress !== null) {
      this.setProgress(progress);
    }

    // Show element
    this.element.style.display = 'flex';
    this.isVisible = true;

    // Trigger reflow for animation
    void this.element.offsetWidth;
    this.element.classList.add('visible');

    console.log('[LoadingIndicator] Shown');
  }

  /**
   * Hide loading indicator
   */
  hide() {
    if (!this.element) return;

    this.element.classList.remove('visible');
    
    // Wait for animation before hiding
    setTimeout(() => {
      if (this.element) {
        this.element.style.display = 'none';
        this.isVisible = false;
      }
    }, 300);

    console.log('[LoadingIndicator] Hidden');
  }

  /**
   * Set progress value
   * @param {number} value - Progress value (0-100), null for indeterminate
   */
  setProgress(value) {
    this.progress = value;

    if (this.progressBar) {
      if (value === null) {
        this.progressBar.style.display = 'none';
      } else {
        this.progressBar.style.display = 'block';
        const bar = this.progressBar.querySelector(`.${CONFIG.CLASS_NAMES.PROGRESS_BAR}`);
        if (bar) {
          bar.style.width = `${Math.max(0, Math.min(100, value))}%`;
        }
      }
    }
  }

  /**
   * Update loading message
   * @param {string} message - New message
   */
  setMessage(message) {
    this.message = message;
    if (this.messageElement) {
      this.messageElement.textContent = message;
    }
  }

  /**
   * Toggle loading indicator
   * @param {boolean} visible - Visibility state
   */
  toggle(visible) {
    if (visible) {
      this.show();
    } else {
      this.hide();
    }
  }

  /**
   * Check if loading indicator is visible
   * @returns {boolean}
   */
  isShowing() {
    return this.isVisible;
  }

  /**
   * Create DOM element structure
   * @private
   */
  _createElement() {
    // Create container
    this.element = document.createElement('div');
    this.element.className = CONFIG.CLASS_NAMES.CONTAINER;
    this.element.setAttribute('role', 'status');
    this.element.setAttribute('aria-live', 'polite');
    this.element.setAttribute('aria-label', 'Loading');

    // Add size class
    this.element.classList.add(`size-${this.size}`);

    // Add overlay class if needed
    if (this.overlay) {
      this.element.classList.add(CONFIG.CLASS_NAMES.OVERLAY);
    }

    // Create loading content
    const content = document.createElement('div');
    content.className = 'loading-content';

    // Create style-specific element
    const loader = this._createLoader();
    content.appendChild(loader);

    // Create message element
    if (this.message) {
      this.messageElement = document.createElement('div');
      this.messageElement.className = CONFIG.CLASS_NAMES.MESSAGE;
      this.messageElement.textContent = this.message;
      content.appendChild(this.messageElement);
    }

    // Create progress bar
    this.progressBar = document.createElement('div');
    this.progressBar.className = CONFIG.CLASS_NAMES.PROGRESS;
    this.progressBar.style.display = this.progress !== null ? 'block' : 'none';
    this.progressBar.innerHTML = `
      <div class="${CONFIG.CLASS_NAMES.PROGRESS_BAR}" style="width: ${this.progress || 0}%"></div>
    `;
    content.appendChild(this.progressBar);

    this.element.appendChild(content);

    // Append to container
    this.container.appendChild(this.element);

    // Initially hidden
    this.element.style.display = 'none';
  }

  /**
   * Create loader element based on style
   * @private
   */
  _createLoader() {
    const loader = document.createElement('div');

    switch (this.style) {
      case CONFIG.STYLES.SPINNER:
        loader.className = CONFIG.CLASS_NAMES.SPINNER;
        loader.innerHTML = '<div></div><div></div><div></div><div></div>';
        break;

      case CONFIG.STYLES.PULSE:
        loader.className = CONFIG.CLASS_NAMES.PULSE;
        break;

      case CONFIG.STYLES.DOTS:
        loader.className = CONFIG.CLASS_NAMES.DOTS;
        loader.innerHTML = '<div></div><div></div><div></div>';
        break;

      case CONFIG.STYLES.SKELETON:
        loader.className = CONFIG.CLASS_NAMES.SKELETON;
        break;

      default:
        loader.className = CONFIG.CLASS_NAMES.SPINNER;
        loader.innerHTML = '<div></div><div></div><div></div><div></div>';
    }

    return loader;
  }

  /**
   * Inject loading indicator styles
   * @private
   */
  _injectStyles() {
    const styleId = 'loading-indicator-styles';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      .${CONFIG.CLASS_NAMES.CONTAINER} {
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        transition: opacity 0.3s ease;
      }

      .${CONFIG.CLASS_NAMES.CONTAINER}.visible {
        opacity: 1;
      }

      .${CONFIG.CLASS_NAMES.OVERLAY} {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.7);
        backdrop-filter: blur(8px);
        z-index: 99999;
      }

      .loading-content {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 15px;
      }

      /* Spinner Style */
      .${CONFIG.CLASS_NAMES.SPINNER} {
        display: inline-block;
        position: relative;
        width: 80px;
        height: 80px;
      }

      .${CONFIG.CLASS_NAMES.SPINNER} div {
        box-sizing: border-box;
        display: block;
        position: absolute;
        width: 64px;
        height: 64px;
        margin: 8px;
        border: 8px solid ${this.color};
        border-radius: 50%;
        animation: spinner-ring 1.2s cubic-bezier(0.5, 0, 0.5, 1) infinite;
        border-color: ${this.color} transparent transparent transparent;
      }

      .${CONFIG.CLASS_NAMES.SPINNER} div:nth-child(1) {
        animation-delay: -0.45s;
      }

      .${CONFIG.CLASS_NAMES.SPINNER} div:nth-child(2) {
        animation-delay: -0.3s;
      }

      .${CONFIG.CLASS_NAMES.SPINNER} div:nth-child(3) {
        animation-delay: -0.15s;
      }

      @keyframes spinner-ring {
        0% {
          transform: rotate(0deg);
        }
        100% {
          transform: rotate(360deg);
        }
      }

      /* Pulse Style */
      .${CONFIG.CLASS_NAMES.PULSE} {
        width: 60px;
        height: 60px;
        border-radius: 50%;
        background: ${this.color};
        animation: pulse 1.5s ease-in-out infinite;
      }

      @keyframes pulse {
        0%, 100% {
          transform: scale(1);
          opacity: 0.8;
        }
        50% {
          transform: scale(1.2);
          opacity: 0.4;
        }
      }

      /* Dots Style */
      .${CONFIG.CLASS_NAMES.DOTS} {
        display: flex;
        gap: 10px;
      }

      .${CONFIG.CLASS_NAMES.DOTS} div {
        width: 15px;
        height: 15px;
        border-radius: 50%;
        background: ${this.color};
        animation: dot-bounce 1.4s infinite ease-in-out both;
      }

      .${CONFIG.CLASS_NAMES.DOTS} div:nth-child(1) {
        animation-delay: -0.32s;
      }

      .${CONFIG.CLASS_NAMES.DOTS} div:nth-child(2) {
        animation-delay: -0.16s;
      }

      @keyframes dot-bounce {
        0%, 80%, 100% {
          transform: scale(0);
        }
        40% {
          transform: scale(1);
        }
      }

      /* Skeleton Style */
      .${CONFIG.CLASS_NAMES.SKELETON} {
        width: 200px;
        height: 20px;
        background: linear-gradient(90deg, rgba(255,255,255,0.1) 25%, rgba(255,255,255,0.2) 50%, rgba(255,255,255,0.1) 75%);
        background-size: 200% 100%;
        animation: skeleton-loading 1.5s ease-in-out infinite;
        border-radius: 4px;
      }

      @keyframes skeleton-loading {
        0% {
          background-position: 200% 0;
        }
        100% {
          background-position: -200% 0;
        }
      }

      /* Message */
      .${CONFIG.CLASS_NAMES.MESSAGE} {
        color: white;
        font-size: 16px;
        text-align: center;
        max-width: 300px;
      }

      /* Progress Bar */
      .${CONFIG.CLASS_NAMES.PROGRESS} {
        width: 200px;
        height: 6px;
        background: rgba(255, 255, 255, 0.2);
        border-radius: 3px;
        overflow: hidden;
      }

      .${CONFIG.CLASS_NAMES.PROGRESS_BAR} {
        height: 100%;
        background: ${this.color};
        transition: width 0.3s ease;
        border-radius: 3px;
      }

      /* Size Variants */
      .${CONFIG.CLASS_NAMES.CONTAINER}.size-small .${CONFIG.CLASS_NAMES.SPINNER} {
        width: 40px;
        height: 40px;
      }

      .${CONFIG.CLASS_NAMES.CONTAINER}.size-small .${CONFIG.CLASS_NAMES.SPINNER} div {
        width: 32px;
        height: 32px;
        margin: 4px;
        border-width: 4px;
      }

      .${CONFIG.CLASS_NAMES.CONTAINER}.size-small .${CONFIG.CLASS_NAMES.PULSE} {
        width: 30px;
        height: 30px;
      }

      .${CONFIG.CLASS_NAMES.CONTAINER}.size-small .${CONFIG.CLASS_NAMES.DOTS} div {
        width: 10px;
        height: 10px;
      }

      .${CONFIG.CLASS_NAMES.CONTAINER}.size-large .${CONFIG.CLASS_NAMES.SPINNER} {
        width: 120px;
        height: 120px;
      }

      .${CONFIG.CLASS_NAMES.CONTAINER}.size-large .${CONFIG.CLASS_NAMES.SPINNER} div {
        width: 96px;
        height: 96px;
        margin: 12px;
        border-width: 12px;
      }

      .${CONFIG.CLASS_NAMES.CONTAINER}.size-large .${CONFIG.CLASS_NAMES.PULSE} {
        width: 90px;
        height: 90px;
      }

      .${CONFIG.CLASS_NAMES.CONTAINER}.size-large .${CONFIG.CLASS_NAMES.DOTS} div {
        width: 20px;
        height: 20px;
      }
    `;

    document.head.appendChild(style);
  }

  /**
   * Dispose loading indicator
   * Removes element and clears references
   */
  dispose() {
    console.log('[LoadingIndicator] Disposing...');

    if (this.element) {
      this.element.remove();
      this.element = null;
    }

    this.progressBar = null;
    this.messageElement = null;
    this.container = null;

    console.log('[LoadingIndicator] Disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = LoadingIndicator;
}

if (typeof window !== 'undefined') {
  window.LoadingIndicator = LoadingIndicator;
  console.log('📦 LoadingIndicator loaded');
}

