'use strict';

/**
 * @.architecture
 *
 * Incoming: Content container DOM element, scroll requests --- {dom.container_element | scroll_request, HTMLElement|void}
 * Processing: Manage auto-scroll state, detect user scroll, observe mutations, scroll to bottom with RAF --- {JOB_MANAGE_SCROLL, JOB_OBSERVE_MUTATIONS}
 * Outgoing: DOM scroll position updates, scroll-to-bottom button visibility events --- {dom.scroll_mutation, void}
 *
 * @module renderer/chat/modules/messaging/ui/ScrollManager
 */

const { createRendererLogger } = require('../../../../shared/utils/logger');

const scrollLogger = createRendererLogger('ScrollManager');

/**
 * ScrollManager - Premium Auto-scroll Behavior Management
 * ========================================================
 * 
 * SINGLE RESPONSIBILITY: Manage scroll behavior for message container
 * 
 * FEATURES:
 * - Mutation observation for automatic scrolling on content additions (including trails)
 * - User scroll detection (sticky-to-bottom logic)
 * - Throttled RAF scrolling
 * - Support for smooth vs instant scrolling
 */
class ScrollManager {
  constructor(options = {}) {
    this.contentElement = options.contentElement || null;
    this.eventBus = options.eventBus || null;
    this.autoScroll = options.autoScroll !== false;
    this.log = scrollLogger.child({ scope: 'scroll-manager' });

    // Config
    this._scrollThreshold = options.scrollThreshold || 100; // px from bottom to consider "at bottom"
    this._smoothScroll = options.smoothScroll !== false;

    // State
    this._isSticky = true;
    this._userHasScrolledUp = false;
    this._scrollRaf = null;
    this._mutationObserver = null;
    this._isDisposed = false;
    this._listeners = [];

    if (!this.contentElement) {
      throw new Error('[ScrollManager] contentElement is REQUIRED');
    }

    this._setupListeners();
    this._setupMutationObserver();
    this._setupEventBusListeners();

    this.log.info('ScrollManager initialized', {
      autoScroll: this.autoScroll,
      sticky: this._isSticky
    });
  }

  /**
   * Set up EventBus listeners
   * @private
   */
  _setupEventBusListeners() {
    if (this.eventBus) {
      this._scrollRequestHandler = (options) => this.scrollToBottom(options);
      
      const cleanup = this.eventBus.on('scroll:request-bottom', this._scrollRequestHandler);
      if (typeof cleanup === 'function') {
        this._eventBusCleanup = cleanup;
      }
    }
  }

  /**
   * Track DOM event listeners for lifecycle management
   * @private
   */
  _trackListener(target, event, handler, options = {}) {
    target.addEventListener(event, handler, options);
    this._listeners.push({ target, event, handler, options });
  }

  /**
   * Set up scroll listeners
   * @private
   */
  _setupListeners() {
    this._handleScroll = this._handleScroll.bind(this);
    this._handleResize = this._handleResize.bind(this);
    this._trackListener(this.contentElement, 'scroll', this._handleScroll, { passive: true });
    this._trackListener(window, 'resize', this._handleResize, { passive: true });
  }

  /**
   * Handle window resize
   * @private
   */
  _handleResize() {
    if (this._isDisposed) return;
    if (this._isSticky && this.autoScroll) {
      this.scrollToBottom({ behavior: 'auto' });
    }
  }

  /**
   * Set up MutationObserver to detect new content
   * @private
   */
  _setupMutationObserver() {
    this._mutationObserver = new MutationObserver(() => {
      if (this._isSticky && this.autoScroll) {
        // Use 'auto' (instant) during mutations (like streaming) to stay locked
        // 'smooth' can cause jitter when content arrives rapidly
        this.scrollToBottom({ behavior: 'auto' });
      }
    });

    this._mutationObserver.observe(this.contentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-state'] // Specifically for thinking bubble and trail collapses
    });
  }

  /**
   * Handle scroll events to detect if user has scrolled up
   * @private
   */
  _handleScroll() {
    if (this._isDisposed) return;

    const { scrollTop, scrollHeight, clientHeight } = this.contentElement;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const isAtBottom = distanceFromBottom <= this._scrollThreshold;

    if (isAtBottom) {
      if (!this._isSticky) {
        this._isSticky = true;
        this._userHasScrolledUp = false;
        this.log.trace('Sticky to bottom enabled');
        if (this.eventBus) {
          this.eventBus.emit('scroll:at-bottom');
        }
      }
    } else {
      if (this._isSticky) {
        this._isSticky = false;
        this._userHasScrolledUp = true;
        this.log.trace('Sticky to bottom disabled (user scrolled up)');
        if (this.eventBus) {
          this.eventBus.emit('scroll:scrolled-up');
        }
      }
    }
  }

  /**
   * Scroll to bottom
   * @param {Object} options - Scroll options
   * @param {string} options.behavior - 'smooth' or 'auto'
   * @param {boolean} options.force - Force scroll even if not sticky
   */
  scrollToBottom(options = {}) {
    if (!this.contentElement || this._isDisposed) return;
    
    const behavior = options.behavior || (this._smoothScroll ? 'smooth' : 'auto');
    const force = options.force === true;

    if (!force && !this.autoScroll) return;

    // Cancel pending scroll
    if (this._scrollRaf) {
      cancelAnimationFrame(this._scrollRaf);
    }

    // Schedule scroll
    this._scrollRaf = requestAnimationFrame(() => {
      this._scrollRaf = null;
      if (this.contentElement) {
        try {
          // ARCHITECTURAL FIX: Use scrollTo for better behavior control
          this.contentElement.scrollTo({
            top: this.contentElement.scrollHeight,
            behavior: behavior
          });
          
          if (force) {
            this._isSticky = true;
            this._userHasScrolledUp = false;
          }
          
          this.log.trace('Scrolled to bottom', { behavior, force });
        } catch (error) {
          // Fallback
          this.contentElement.scrollTop = this.contentElement.scrollHeight;
        }
      }
    });
  }

  /**
   * Manual scroll to bottom (e.g., from button click)
   */
  manualScrollToBottom() {
    this.scrollToBottom({ behavior: 'smooth', force: true });
  }

  /**
   * Enable auto-scroll
   */
  enable() {
    this.autoScroll = true;
    this.log.trace('Auto-scroll enabled');
  }

  /**
   * Disable auto-scroll
   */
  disable() {
    this.autoScroll = false;
    this.log.trace('Auto-scroll disabled');
  }

  /**
   * Toggle auto-scroll
   */
  toggle() {
    this.autoScroll = !this.autoScroll;
    this.log.trace('Auto-scroll toggled', { autoScroll: this.autoScroll });
  }

  /**
   * Check if sticky to bottom
   * @returns {boolean}
   */
  isSticky() {
    return this._isSticky;
  }

  /**
   * Check if auto-scroll is enabled
   * @returns {boolean}
   */
  isEnabled() {
    return this.autoScroll;
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    this._isDisposed = true;

    if (this._eventBusCleanup) {
      this._eventBusCleanup();
      this._eventBusCleanup = null;
    }

    if (this._scrollRaf) {
      cancelAnimationFrame(this._scrollRaf);
      this._scrollRaf = null;
    }

    if (this._mutationObserver) {
      this._mutationObserver.disconnect();
      this._mutationObserver = null;
    }

    if (this._listeners) {
      for (const { target, event, handler, options } of this._listeners) {
        try {
          target?.removeEventListener(event, handler, options);
        } catch (error) {
          this.log.warn('Failed to remove listener during dispose', { error });
        }
      }
      this._listeners = [];
    }

    if (this.contentElement) {
      this.contentElement = null;
    }

    this.log.info('ScrollManager disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScrollManager;
}

if (typeof window !== 'undefined') {
  window.ScrollManager = ScrollManager;
}
