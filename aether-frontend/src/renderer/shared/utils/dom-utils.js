'use strict';

/**
 * @.architecture
 *
 * Incoming: All UI components (DOM manipulation calls) --- {method_calls, javascript_api}
 * Processing: DOM utilities - create/query/manipulate elements, event listeners, class/visibility helpers, scroll, dimensions, wait for elements --- {5 jobs: JOB_CREATE_DOM_ELEMENT, JOB_ESCAPE_HTML, JOB_GET_STATE, JOB_INITIALIZE, JOB_SCROLL_TO_BOTTOM, JOB_UPDATE_DOM_ELEMENT}
 * Outgoing: Return elements, cleanup functions, booleans, dimensions --- {dom_types.* | Function | boolean | object, HTMLElement | Function | boolean | {width,height,...}}
 *
 *
 * @module renderer/shared/utils/dom-utils
 */

/**
 * DOMUtils - DOM Manipulation Utilities
 * ============================================================================
 * Production-ready DOM utility functions with:
 * - Safe element creation and manipulation
 * - Event listener management
 * - CSS class utilities
 * - Visibility and display controls
 * - Smooth scroll operations
 * - Element query helpers
 * 
 * Responsibilities:
 * - Provide DOM manipulation helpers
 * - Safe event listener management
 * - Element state queries
 * - Scroll and animation utilities
 * - XSS-safe content insertion
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

/**
 * DOM Utility Functions
 */
const DOMUtils = freeze({
  /**
   * Create element with attributes and children
   * @param {string} tag - Element tag name
   * @param {Object} attrs - Attributes object
   * @param {Array|string|HTMLElement} children - Children elements or text
   * @returns {HTMLElement}
   */
  createElement(tag, attrs = {}, children = []) {
    try {
      const element = document.createElement(tag);

      // Set attributes
      for (const [key, value] of Object.entries(attrs)) {
        if (key === 'className') {
          element.className = value;
        } else if (key === 'style' && typeof value === 'object') {
          Object.assign(element.style, value);
        } else if (key.startsWith('on') && typeof value === 'function') {
          const eventName = key.slice(2).toLowerCase();
          element.addEventListener(eventName, value);
        } else {
          element.setAttribute(key, value);
        }
      }

      // Append children
      const childArray = Array.isArray(children) ? children : [children];
      for (const child of childArray) {
        if (typeof child === 'string') {
          element.appendChild(document.createTextNode(child));
        } else if (child instanceof HTMLElement) {
          element.appendChild(child);
        }
      }

      return element;
    } catch (error) {
      console.error('[DOMUtils] createElement failed:', error);
      return document.createElement('div');
    }
  },

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
      console.error('[DOMUtils] query failed:', error);
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
      console.error('[DOMUtils] queryAll failed:', error);
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
      console.warn('[DOMUtils] addEventListener: invalid parameters');
      return () => {};
    }

    try {
      element.addEventListener(event, handler, options);
      return () => element.removeEventListener(event, handler, options);
    } catch (error) {
      console.error('[DOMUtils] addEventListener failed:', error);
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
      return element && element.classList.contains(className);
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
      console.error('[DOMUtils] addClass failed:', error);
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
      console.error('[DOMUtils] removeClass failed:', error);
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
      return element && element.classList.toggle(className, force);
    } catch (error) {
      console.error('[DOMUtils] toggleClass failed:', error);
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
   * Set HTML content safely (use with caution)
   * @param {HTMLElement} element - Target element
   * @param {string} html - HTML content (should be sanitized)
   */
  setHTML(element, html) {
    if (!element) return;
    element.innerHTML = html;
  },

  /**
   * Clear element content
   * @param {HTMLElement} element - Target element
   */
  clear(element) {
    if (!element) return;
    element.innerHTML = '';
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
      console.error('[DOMUtils] scrollTo failed:', error);
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
      console.error('[DOMUtils] scrollToBottom failed:', error);
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
      console.error('[DOMUtils] getDimensions failed:', error);
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
   * Escape HTML to prevent XSS
   * @param {string} str - String to escape
   * @returns {string} Escaped string
   */
  escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
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
      console.error('[DOMUtils] copyToClipboard failed:', error);
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
  console.log('📦 DOMUtils loaded');
}

