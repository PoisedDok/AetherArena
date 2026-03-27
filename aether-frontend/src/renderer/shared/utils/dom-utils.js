'use strict';

/**
 * @.architecture
 *
 * Incoming: All UI components (DOM manipulation calls) --- {method_calls, javascript_api}
 * Processing: DOM utilities - query/manipulate elements, event listeners, class/visibility helpers, scroll, dimensions, wait for elements --- {4 jobs: JOB_GET_STATE, JOB_INITIALIZE, JOB_SCROLL_TO_BOTTOM, JOB_UPDATE_DOM_ELEMENT}
 * Outgoing: Return elements, cleanup functions, booleans, dimensions --- {dom_types.* | Function | boolean | object, HTMLElement | Function | boolean | {width,height,...}}
 *
 *
 * @module renderer/shared/utils/dom-utils
 */

/**
 * DOMUtils - DOM Manipulation Utilities
 * ============================================================================
 * Production-ready DOM utility functions with:
 * - Element querying and manipulation
 * - Event listener management with cleanup tracking
 * - CSS class utilities
 * - Visibility and display controls
 * - Smooth scroll operations
 * - Timing helpers (debounce, throttle, raf)
 * 
 * Responsibilities:
 * - Provide DOM manipulation helpers
 * - Safe event listener management (returns cleanup functions)
 * - Element state queries
 * - Scroll and animation utilities
 * 
 * Architecture:
 * - Pure utility functions
 * - No state management
 * - Framework-agnostic
 * - Production-ready error handling
 * 
 * @module renderer/shared/utils/dom-utils
 */

const { freeze } = Object;

// Configuration
const CONFIG = freeze({
  SCROLL_DURATION: 300,
  SCROLL_EASING: 'cubic-bezier(0.4, 0, 0.2, 1)',
});

// Structured logger (safe for both module and browser contexts)
const _domLog = (typeof require !== 'undefined')
  ? require('./logger').createRendererLogger('DOMUtils')
  : { debug: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };

/**
 * DOM Utility Functions
 */
const DOMUtils = freeze({
  /**
   * Query selector with error handling
   * @param {string} selector - CSS selector
   * @param {HTMLElement} context - Context element (default: document)
   * @returns {HTMLElement|null}
   */
  query(selector, context = document) {
    try {
      return context.querySelector(selector);
    } catch (error) {
      _domLog.error('[DOMUtils] query failed:', error);
      return null;
    }
  },

  /**
   * Query selector all with error handling
   * @param {string} selector - CSS selector
   * @param {HTMLElement} context - Context element (default: document)
   * @returns {Array<HTMLElement>}
   */
  queryAll(selector, context = document) {
    try {
      return Array.from(context.querySelectorAll(selector));
    } catch (error) {
      _domLog.error('[DOMUtils] queryAll failed:', error);
      return [];
    }
  },

  /**
   * Add event listener with cleanup tracking
   * @param {HTMLElement} element - Target element
   * @param {string} event - Event name
   * @param {Function} handler - Event handler
   * @param {Object} options - Event listener options
   * @returns {Function} Cleanup function
   */
  addEventListener(element, event, handler, options = {}) {
    if (!element || !event || typeof handler !== 'function') {
      _domLog.warn('[DOMUtils] addEventListener: invalid parameters');
      return () => {};
    }

    try {
      element.addEventListener(event, handler, options);
      return () => element.removeEventListener(event, handler, options);
    } catch (error) {
      _domLog.error('[DOMUtils] addEventListener failed:', error);
      return () => {};
    }
  },

  /**
   * Add multiple event listeners with cleanup
   * @param {HTMLElement} element - Target element
   * @param {Object} events - Event name to handler mapping
   * @returns {Function} Cleanup function for all listeners
   */
  addEventListeners(element, events) {
    const cleanups = [];

    for (const [event, handler] of Object.entries(events)) {
      const cleanup = this.addEventListener(element, event, handler);
      cleanups.push(cleanup);
    }

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  },

  /**
   * Check if element has class
   * @param {HTMLElement} element - Target element
   * @param {string} className - Class name to check
   * @returns {boolean}
   */
  hasClass(element, className) {
    try {
      return element ? element.classList.contains(className) : false;
    } catch (error) {
      return false;
    }
  },

  /**
   * Add class to element
   * @param {HTMLElement} element - Target element
   * @param {string|Array<string>} className - Class name(s) to add
   */
  addClass(element, className) {
    if (!element) return;

    try {
      const classes = Array.isArray(className) ? className : [className];
      element.classList.add(...classes);
    } catch (error) {
      _domLog.error('[DOMUtils] addClass failed:', error);
    }
  },

  /**
   * Remove class from element
   * @param {HTMLElement} element - Target element
   * @param {string|Array<string>} className - Class name(s) to remove
   */
  removeClass(element, className) {
    if (!element) return;

    try {
      const classes = Array.isArray(className) ? className : [className];
      element.classList.remove(...classes);
    } catch (error) {
      _domLog.error('[DOMUtils] removeClass failed:', error);
    }
  },

  /**
   * Toggle class on element
   * @param {HTMLElement} element - Target element
   * @param {string} className - Class name to toggle
   * @param {boolean} force - Force add/remove
   * @returns {boolean} Whether class is now present
   */
  toggleClass(element, className, force = undefined) {
    try {
      return element ? element.classList.toggle(className, force) : false;
    } catch (error) {
      _domLog.error('[DOMUtils] toggleClass failed:', error);
      return false;
    }
  },

  /**
   * Show element (display block)
   * @param {HTMLElement} element - Target element
   * @param {string} display - Display value (default: 'block')
   */
  show(element, display = 'block') {
    if (!element) return;
    element.style.display = display;
  },

  /**
   * Hide element (display none)
   * @param {HTMLElement} element - Target element
   */
  hide(element) {
    if (!element) return;
    element.style.display = 'none';
  },

  /**
   * Toggle element visibility
   * @param {HTMLElement} element - Target element
   * @param {boolean} visible - Force visibility
   */
  toggle(element, visible = undefined) {
    if (!element) return;

    const isVisible = element.style.display !== 'none';
    const shouldShow = visible !== undefined ? visible : !isVisible;

    if (shouldShow) {
      this.show(element);
    } else {
      this.hide(element);
    }
  },

  /**
   * Check if element is visible
   * @param {HTMLElement} element - Target element
   * @returns {boolean}
   */
  isVisible(element) {
    if (!element) return false;

    try {
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    } catch (error) {
      return false;
    }
  },

  /**
   * Set text content safely (escapes HTML)
   * @param {HTMLElement} element - Target element
   * @param {string} text - Text content
   */
  setText(element, text) {
    if (!element) return;
    element.textContent = text;
  },

  /**
   * Clear element content
   * @param {HTMLElement} element - Target element
   */
  clear(element) {
    if (!element) return;
    element.replaceChildren();
  },

  /**
   * Remove element from DOM
   * @param {HTMLElement} element - Target element
   */
  remove(element) {
    if (!element) return;
    element.remove();
  },

  /**
   * Smooth scroll to element
   * @param {HTMLElement} element - Target element
   * @param {Object} options - Scroll options
   */
  scrollTo(element, options = {}) {
    if (!element) return;

    try {
      element.scrollIntoView({
        behavior: options.behavior || 'smooth',
        block: options.block || 'start',
        inline: options.inline || 'nearest',
      });
    } catch (error) {
      _domLog.error('[DOMUtils] scrollTo failed:', error);
    }
  },

  /**
   * Scroll element to bottom
   * @param {HTMLElement} element - Target element
   * @param {boolean} smooth - Use smooth scrolling
   */
  scrollToBottom(element, smooth = true) {
    if (!element) return;

    try {
      element.scrollTop = element.scrollHeight;
    } catch (error) {
      _domLog.error('[DOMUtils] scrollToBottom failed:', error);
    }
  },

  /**
   * Get element dimensions and position
   * @param {HTMLElement} element - Target element
   * @returns {Object} Dimensions object
   */
  getDimensions(element) {
    if (!element) {
      return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    }

    try {
      const rect = element.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        top: rect.top,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
      };
    } catch (error) {
      _domLog.error('[DOMUtils] getDimensions failed:', error);
      return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    }
  },

  /**
   * Check if element is in viewport
   * @param {HTMLElement} element - Target element
   * @returns {boolean}
   */
  isInViewport(element) {
    if (!element) return false;

    try {
      const rect = element.getBoundingClientRect();
      return (
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
        rect.right <= (window.innerWidth || document.documentElement.clientWidth)
      );
    } catch (error) {
      return false;
    }
  },

  /**
   * Wait for element to appear in DOM
   * @param {string} selector - CSS selector
   * @param {number} timeout - Timeout in ms (default: 5000)
   * @returns {Promise<HTMLElement>}
   */
  waitForElement(selector, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const element = document.querySelector(selector);
      if (element) {
        resolve(element);
        return;
      }

      const observer = new MutationObserver(() => {
        const element = document.querySelector(selector);
        if (element) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(element);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });

      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Element ${selector} not found within ${timeout}ms`));
      }, timeout);
    });
  },

  /**
   * Debounce function calls
   * @param {Function} func - Function to debounce
   * @param {number} wait - Wait time in ms
   * @returns {Function} Debounced function
   */
  debounce(func, wait = 300) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },

  /**
   * Throttle function calls
   * @param {Function} func - Function to throttle
   * @param {number} limit - Limit time in ms
   * @returns {Function} Throttled function
   */
  throttle(func, limit = 300) {
    let inThrottle;
    return function executedFunction(...args) {
      if (!inThrottle) {
        func(...args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  },

  /**
   * Request animation frame helper
   * @param {Function} callback - Callback function
   * @returns {number} Request ID
   */
  raf(callback) {
    return requestAnimationFrame(callback);
  },

  /**
   * Cancel animation frame
   * @param {number} id - Request ID
   */
  cancelRaf(id) {
    cancelAnimationFrame(id);
  },

  /**
   * Copy text to clipboard
   * @param {string} text - Text to copy
   * @returns {Promise<boolean>} Success status
   */
  async copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      } else {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const success = document.execCommand('copy');
        document.body.removeChild(textarea);
        return success;
      }
    } catch (error) {
      _domLog.error('[DOMUtils] copyToClipboard failed:', error);
      return false;
    }
  },
});

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DOMUtils;
}

if (typeof window !== 'undefined') {
  window.DOMUtils = DOMUtils;
  _domLog.debug('📦 DOMUtils loaded');
}
