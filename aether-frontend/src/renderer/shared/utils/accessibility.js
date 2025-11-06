'use strict';

/**
 * @.architecture
 *
 * Incoming: UI components (.announce/.trapFocus/.setAria calls) --- {method_calls, javascript_api}
 * Processing: Accessibility management - screen reader announcements via aria-live region, focus history stack (save/restore), focus trap for modals (Tab/Shift+Tab loop), ARIA attribute setting (camelCase→aria-kebab-case), accessible button enhancement (role/tabindex/keyboard), skip links for main content, keyboard navigation (Escape event dispatch), roving tabindex for lists --- {5 jobs: JOB_EMIT_EVENT, JOB_UPDATE_STATE, JOB_UPDATE_DOM_ELEMENT, JOB_UPDATE_STATE, JOB_UPDATE_STATE}
 * Outgoing: Modify DOM (aria attributes, focus, listeners), return cleanup functions --- {dom_update | method_call, none | Function}
 *
 *
 * @module renderer/shared/utils/accessibility
 */

/**
 * Accessibility Utilities
 * ============================================================================
 * Accessibility helpers for WCAG 2.1 compliance:
 * - ARIA attribute management
 * - Focus management
 * - Keyboard navigation
 * - Screen reader announcements
 * - Skip links
 * - Focus trap for modals
 * 
 * Architecture:
 * - Framework-agnostic
 * - Event-driven
 * - Production-ready
 * 
 * @module renderer/shared/utils/accessibility
 */

const { freeze } = Object;

/**
 * Accessibility manager
 */
class AccessibilityManager {
  constructor() {
    this.announceElement = null;
    this.focusHistory = [];
    this.trapStack = [];
    
    this._init();
  }

  /**
   * Initialize accessibility manager
   * @private
   */
  _init() {
    if (typeof document === 'undefined') return;

    // Create live region for announcements
    this._createAnnounceElement();

    // Setup global keyboard navigation
    this._setupKeyboardNavigation();

    console.log('[Accessibility] Initialized');
  }

  /**
   * Announce message to screen readers
   * @param {string} message - Message to announce
   * @param {string} priority - 'polite' or 'assertive'
   */
  announce(message, priority = 'polite') {
    if (!this.announceElement) return;

    // Set priority
    this.announceElement.setAttribute('aria-live', priority);

    // Clear and set message (forces announcement)
    this.announceElement.textContent = '';
    setTimeout(() => {
      this.announceElement.textContent = message;
    }, 100);

    console.log(`[Accessibility] Announced: "${message}" (${priority})`);
  }

  /**
   * Save current focus and move to element
   * @param {HTMLElement} element - Element to focus
   */
  moveFocus(element) {
    if (!element || typeof element.focus !== 'function') {
      console.warn('[Accessibility] Invalid focus element');
      return;
    }

    // Save current focus
    const currentFocus = document.activeElement;
    if (currentFocus && currentFocus !== document.body) {
      this.focusHistory.push(currentFocus);
    }

    // Move focus
    element.focus();

    console.log('[Accessibility] Focus moved to:', element);
  }

  /**
   * Restore previous focus
   */
  restoreFocus() {
    if (this.focusHistory.length === 0) return;

    const element = this.focusHistory.pop();
    if (element && typeof element.focus === 'function') {
      element.focus();
      console.log('[Accessibility] Focus restored to:', element);
    }
  }

  /**
   * Trap focus within element (for modals, dialogs)
   * @param {HTMLElement} container - Container to trap focus in
   * @returns {Function} Release function
   */
  trapFocus(container) {
    if (!container) {
      console.warn('[Accessibility] Invalid trap container');
      return () => {};
    }

    // Get focusable elements
    const focusableElements = this._getFocusableElements(container);

    if (focusableElements.length === 0) {
      console.warn('[Accessibility] No focusable elements in trap container');
      return () => {};
    }

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    // Trap handler
    const trapHandler = (e) => {
      if (e.key !== 'Tab') return;

      // Shift + Tab
      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement.focus();
        }
      }
      // Tab
      else {
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement.focus();
        }
      }
    };

    // Add listener
    container.addEventListener('keydown', trapHandler);

    // Focus first element
    firstElement.focus();

    // Store trap
    const trap = { container, handler: trapHandler };
    this.trapStack.push(trap);

    console.log('[Accessibility] Focus trap activated');

    // Return release function
    return () => {
      container.removeEventListener('keydown', trapHandler);
      const index = this.trapStack.indexOf(trap);
      if (index > -1) {
        this.trapStack.splice(index, 1);
      }
      console.log('[Accessibility] Focus trap released');
    };
  }

  /**
   * Release all focus traps
   */
  releaseAllTraps() {
    this.trapStack.forEach(trap => {
      trap.container.removeEventListener('keydown', trap.handler);
    });
    this.trapStack = [];
    console.log('[Accessibility] All focus traps released');
  }

  /**
   * Add skip link to page
   * @param {HTMLElement} targetElement - Element to skip to
   * @param {string} label - Skip link label
   */
  addSkipLink(targetElement, label = 'Skip to main content') {
    if (!targetElement) return;

    const skipLink = document.createElement('a');
    skipLink.href = '#';
    skipLink.textContent = label;
    skipLink.className = 'skip-link';
    skipLink.style.cssText = `
      position: absolute;
      top: -40px;
      left: 0;
      background: var(--color-bg-elevated);
      color: var(--color-text-primary);
      padding: 8px;
      text-decoration: none;
      z-index: 10000;
    `;

    skipLink.addEventListener('focus', () => {
      skipLink.style.top = '0';
    });

    skipLink.addEventListener('blur', () => {
      skipLink.style.top = '-40px';
    });

    skipLink.addEventListener('click', (e) => {
      e.preventDefault();
      targetElement.focus();
      targetElement.scrollIntoView({ behavior: 'smooth' });
    });

    document.body.insertBefore(skipLink, document.body.firstChild);

    console.log('[Accessibility] Skip link added');
  }

  /**
   * Set ARIA attributes on element
   * @param {HTMLElement} element - Target element
   * @param {Object} attributes - ARIA attributes
   */
  setAria(element, attributes) {
    if (!element) return;

    Object.entries(attributes).forEach(([key, value]) => {
      // Convert camelCase to aria-kebab-case
      const ariaKey = `aria-${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`;
      
      if (value === null || value === undefined) {
        element.removeAttribute(ariaKey);
      } else {
        element.setAttribute(ariaKey, String(value));
      }
    });

    console.log('[Accessibility] ARIA attributes set:', attributes);
  }

  /**
   * Make element accessible button
   * @param {HTMLElement} element - Element to enhance
   * @param {Function} onClick - Click handler
   */
  makeAccessibleButton(element, onClick) {
    if (!element) return;

    element.setAttribute('role', 'button');
    element.setAttribute('tabindex', '0');

    const handleActivation = (e) => {
      if (e.type === 'click' || 
          (e.type === 'keydown' && (e.key === 'Enter' || e.key === ' '))) {
        e.preventDefault();
        onClick(e);
      }
    };

    element.addEventListener('click', handleActivation);
    element.addEventListener('keydown', handleActivation);

    console.log('[Accessibility] Accessible button created');
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Create announcement element
   * @private
   */
  _createAnnounceElement() {
    this.announceElement = document.createElement('div');
    this.announceElement.setAttribute('role', 'status');
    this.announceElement.setAttribute('aria-live', 'polite');
    this.announceElement.setAttribute('aria-atomic', 'true');
    this.announceElement.className = 'sr-only';
    
    document.body.appendChild(this.announceElement);
  }

  /**
   * Setup global keyboard navigation
   * @private
   */
  _setupKeyboardNavigation() {
    // Escape key handling for modals
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // Let the top-most trap or modal handle it
        const event = new CustomEvent('accessibility:escape');
        document.dispatchEvent(event);
      }
    });
  }

  /**
   * Get focusable elements in container
   * @private
   * @param {HTMLElement} container - Container element
   * @returns {Array<HTMLElement>}
   */
  _getFocusableElements(container) {
    const selector = [
      'a[href]',
      'button:not([disabled])',
      'textarea:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      '[tabindex]:not([tabindex="-1"])'
    ].join(', ');

    return Array.from(container.querySelectorAll(selector))
      .filter(el => {
        // Check if element is visible
        return el.offsetWidth > 0 && 
               el.offsetHeight > 0 && 
               getComputedStyle(el).visibility !== 'hidden';
      });
  }
}

/**
 * Keyboard navigation helper
 */
class KeyboardNavigationHelper {
  /**
   * Handle arrow key navigation
   * @param {Array<HTMLElement>} items - Items to navigate
   * @param {number} currentIndex - Current focused index
   * @param {KeyboardEvent} event - Keyboard event
   * @returns {number} New index
   */
  static handleArrowNavigation(items, currentIndex, event) {
    let newIndex = currentIndex;

    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowLeft':
        event.preventDefault();
        newIndex = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
        break;

      case 'ArrowDown':
      case 'ArrowRight':
        event.preventDefault();
        newIndex = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
        break;

      case 'Home':
        event.preventDefault();
        newIndex = 0;
        break;

      case 'End':
        event.preventDefault();
        newIndex = items.length - 1;
        break;
    }

    if (newIndex !== currentIndex && items[newIndex]) {
      items[newIndex].focus();
    }

    return newIndex;
  }

  /**
   * Add roving tabindex to list
   * @param {Array<HTMLElement>} items - Items in list
   * @param {number} activeIndex - Active item index
   */
  static setupRovingTabindex(items, activeIndex = 0) {
    items.forEach((item, index) => {
      item.setAttribute('tabindex', index === activeIndex ? '0' : '-1');
    });
  }
}

// Create singleton instance
const accessibilityManager = new AccessibilityManager();

// Export
module.exports = { 
  accessibilityManager, 
  AccessibilityManager,
  KeyboardNavigationHelper 
};

// Make available globally
if (typeof window !== 'undefined') {
  window.accessibilityManager = accessibilityManager;
  window.KeyboardNavigationHelper = KeyboardNavigationHelper;
  console.log('📦 Accessibility utilities loaded');
}

