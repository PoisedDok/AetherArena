'use strict';

/**
 * @.architecture
 * 
 * Incoming: All modal subclasses (ChatFilesModal, ChatLibraryModal, etc.) --- {constructor_call, inheritance}
 * Processing: Provide unified modal infrastructure with 40% glassmorphism, external CSS, event handling, animations --- {JOB_CREATE_DOM_ELEMENT, JOB_EMIT_EVENT, JOB_UPDATE_DOM_ELEMENT}
 * Outgoing: Document body (DOM), EventBus --- {dom_types.modal_element, HTMLElement}
 * 
 * @module renderer/shared/modals/BaseModal
 */

/**
 * BaseModal - UNIFIED Abstract Base Class for All Modals
 * 
 * Single source of truth for modal behavior across the entire application.
 * 
 * Features:
 * - Full-screen overlay with 40% glassmorphism backdrop
 * - Centered panel with 40% glassmorphism + enhanced blur
 * - Header with title and close button
 * - Scrollable body content
 * - Optional footer with actions
 * - Open/close animations with spring easing
 * - ESC key and outside-click handlers
 * - Single modal enforcement (auto-closes others)
 * - Uses external CSS (CSP-compliant, maintainable)
 * - 100% CSS variables (no hardcoded values)
 * 
 * Subclasses must implement:
 * - _renderContent() - Modal-specific body content
 * - _setupEventListeners() - Modal-specific event handlers (optional)
 * - _cleanup() - Modal-specific cleanup (optional)
 */

// Global registry for modal management (single modal enforcement)
const MODAL_REGISTRY = new Set();
let ACTIVE_MODAL = null;

class BaseModal {
  constructor(options = {}) {
    this.title = options.title || 'Modal';
    this.id = options.id || `modal-${Date.now()}`;
    // Panel sizing must be token-driven (no inline styles) for strict CSP compatibility.
    // size: sm|md|lg|xl (xl = default window width)
    this.size = options.size || 'xl';
    // heightPreset: default|compact|auto
    this.heightPreset = options.heightPreset || 'default';
    this.showFooter = options.showFooter !== undefined ? options.showFooter : false;
    // closable: gates user-initiated dismiss (ESC, backdrop click, close button).
    // Programmatic close() is always allowed (shutdown, navigation, etc.).
    this.closable = options.closable !== undefined ? options.closable : true;
    
    // State
    this.isOpen = false;
    
    // DOM elements
    this.container = options.container || null;
    this.overlay = null;
    this.panel = null;
    this.headerEl = null;
    this.bodyEl = null;
    this.footerEl = null;
    this.closeButton = null;
    
    // Accessibility: focus trap release function
    this._releaseFocusTrap = null;
    
    // Bind methods
    this._handleEscape = this._handleEscape.bind(this);
    this._handleBackdropClick = this._handleBackdropClick.bind(this);
    this._handleCloseClick = this._handleCloseClick.bind(this);
    this._handlePanelClick = this._handlePanelClick.bind(this);
    
    // Register modal
    MODAL_REGISTRY.add(this);
    
    // Create modal structure
    this._createElement();
  }

  /**
   * Create modal DOM structure using CSS classes (NO inline styles)
   * @private
   */
  _createElement() {
    // Create overlay - Uses modal-overlay class from modal-base.css
    this.overlay = document.createElement('div');
    this.overlay.className = 'modal-overlay hidden';
    this.overlay.id = `${this.id}-overlay`;
    
    // Create panel - Uses modal-panel class with 40% glassmorphism
    this.panel = document.createElement('div');
    this.panel.className = 'modal-panel';
    // Ensure clicks inside panel don't drag the window
    this.panel.style.webkitAppRegion = 'no-drag';
    // Accessibility: dialog role and ARIA attributes
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-modal', 'true');
    if (this.size === 'sm') this.panel.classList.add('modal-panel--sm');
    if (this.size === 'md') this.panel.classList.add('modal-panel--md');
    if (this.size === 'lg') this.panel.classList.add('modal-panel--lg');
    if (this.heightPreset === 'compact') this.panel.classList.add('modal-panel--h-compact');
    if (this.heightPreset === 'auto') this.panel.classList.add('modal-panel--h-auto');
    
    // Create header
    this.headerEl = document.createElement('div');
    this.headerEl.className = 'modal-header';
    
    const titleEl = document.createElement('div');
    titleEl.className = 'modal-title';
    titleEl.id = `${this.id}-title`;
    titleEl.textContent = this.title;
    
    // Link panel to its title for screen readers
    this.panel.setAttribute('aria-labelledby', titleEl.id);
    
    this.closeButton = document.createElement('button');
    this.closeButton.className = 'modal-close';
    this.closeButton.setAttribute('aria-label', 'Close dialog');
    this.closeButton.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    `;
    this.closeButton.title = 'Close';
    this.closeButton.addEventListener('click', this._handleCloseClick);
    // Hide close button when modal is not user-dismissible
    if (!this.closable) {
      this.closeButton.classList.add('hidden');
    }
    
    this.headerEl.appendChild(titleEl);
    this.headerEl.appendChild(this.closeButton);
    
    // Create body
    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'modal-body';
    // Let subclass specific elements handle their own dragging rules 
    this.bodyEl.style.webkitAppRegion = 'no-drag';
    
    // Create footer (if needed)
    if (this.showFooter) {
      this.footerEl = document.createElement('div');
      this.footerEl.className = 'modal-footer';
      this.footerEl.style.webkitAppRegion = 'no-drag';
    }
    
    // Assemble panel
    this.panel.appendChild(this.headerEl);
    this.panel.appendChild(this.bodyEl);
    if (this.footerEl) {
      this.panel.appendChild(this.footerEl);
    }
    
    // Assemble overlay
    this.overlay.appendChild(this.panel);
    
    // Add to DOM
    // For standalone windows (like index browser), body is correct. 
    // If container option is provided, use it.
    const mountPoint = this.container || document.getElementById('app') || document.body;
    mountPoint.appendChild(this.overlay);
    
    // Setup backdrop click handler
    this.overlay.addEventListener('click', this._handleBackdropClick);
    
    // Prevent double-clicks on the modal from minimizing the main window
    this.overlay.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      e.preventDefault();
    });
    
    // Prevent clicks on panel from closing modal
    this.panel.addEventListener('click', this._handlePanelClick);
  }

  /**
   * Open modal
   */
  async open() {
    if (this.isOpen) return;
    
    // Close any other active modal (single modal enforcement)
    // NOTE: In detached windows (IndexBrowser), we don't want the parent modal (IndexBrowserModal itself)
    // to be closed if we are opening a child modal (FileViewerModal) over it.
    if (ACTIVE_MODAL && ACTIVE_MODAL !== this && !this.isChildModal) {
      ACTIVE_MODAL.close();
    }
    
    // Safety check - use explicit container if provided, otherwise fallback
    const mountPoint = this.container || document.getElementById('app') || document.body;
    if (mountPoint && !mountPoint.contains(this.overlay)) {
      mountPoint.appendChild(this.overlay);
    }
    
    // In standalone windows, ensure the overlay covers the whole window 
    // and doesn't conflict with app layout
    if (mountPoint === document.getElementById('app')) {
      this.overlay.style.position = 'absolute';
      this.overlay.style.zIndex = '9999'; // Ensure it's above everything
    } else {
      this.overlay.style.position = 'fixed';
      this.overlay.style.zIndex = '9999';
    }
    
    this.isOpen = true;
    ACTIVE_MODAL = this;
    
    // Show overlay FIRST so subclass skeletons are visible during async fetches
    this.overlay.classList.remove('hidden');
    document.addEventListener('keydown', this._handleEscape);
    
    requestAnimationFrame(() => {
      this.overlay.classList.add('is-visible');
      
      const a11y = typeof window !== 'undefined' && window.accessibilityManager;
      if (a11y) {
        const currentFocus = document.activeElement;
        if (currentFocus && currentFocus !== document.body) {
          a11y.focusHistory.push(currentFocus);
        }
        this._releaseFocusTrap = a11y.trapFocus(this.panel);
        a11y.announce(`${this.title} dialog opened`);
      }
    });
    
    // Render content (may be async — skeleton is already visible above)
    await this._renderContent();
    
    // Guard: modal may have been closed while _renderContent() was fetching
    if (!this.isOpen) return;
    
    if (this._setupEventListeners) {
      this._setupEventListeners();
    }
  }

  /**
   * Bring an already-open modal to the front.
   * Handles single-modal enforcement and ensures visibility.
   * Safe to call when not open (no-op).
   */
  bringToFront() {
    if (!this.isOpen) return;

    // Close any other active modal (single modal enforcement)
    if (ACTIVE_MODAL && ACTIVE_MODAL !== this) {
      ACTIVE_MODAL.close();
    }
    ACTIVE_MODAL = this;

    // Ensure visible (defensive — should already be visible if isOpen)
    this.overlay.classList.remove('hidden');
    this.overlay.classList.add('is-visible');
  }

  /**
   * Close modal
   */
  close() {
    if (!this.isOpen) return;
    
    this.isOpen = false;
    
    // Remove escape key listener
    document.removeEventListener('keydown', this._handleEscape);
    
    // Accessibility: release focus trap and restore previous focus
    if (this._releaseFocusTrap) {
      this._releaseFocusTrap();
      this._releaseFocusTrap = null;
    }
    const a11y = typeof window !== 'undefined' && window.accessibilityManager;
    if (a11y) {
      a11y.restoreFocus?.();
      a11y.announce(`${this.title} dialog closed`);
    }
    
    // Animate out (class-driven; avoids CSP-blocked inline styles)
    this.overlay.classList.remove('is-visible');
    
    // Hide after animation
    setTimeout(() => {
      // LIFECYCLE GUARD: if the modal was reopened during the 300ms animation delay,
      // do NOT run cleanup — it would wipe the freshly rendered content and listeners.
      if (this.isOpen) return;

      // LIFECYCLE GUARD: overlay may have been destroyed during the 300ms animation delay
      // (e.g., destroy() called immediately after close())
      if (this.overlay) {
        this.overlay.classList.add('hidden');
      }
      
      // Clear content
      if (this._cleanup) {
        this._cleanup();
      }
      
      // Clear active modal reference ONLY if it is still pointing to this modal
      if (ACTIVE_MODAL === this) {
        ACTIVE_MODAL = null;
      }
    }, 300);
  }

  /**
   * Handle ESC key press
   * @private
   */
  _handleEscape(e) {
    if (!this.closable) return;
    if (e.key === 'Escape' || e.key === 'Esc') {
      this.close();
    }
  }

  /**
   * Handle backdrop click
   * @private
   */
  _handleBackdropClick(e) {
    if (!this.closable) return;
    if (e.target === this.overlay) {
      this.close();
    }
  }

  /**
   * Handle close button click
   * @private
   */
  _handleCloseClick() {
    if (!this.closable) return;
    this.close();
  }

  /**
   * Handle panel click (stop propagation to prevent backdrop close)
   * @private
   */
  _handlePanelClick(e) {
    e.stopPropagation();
  }

  /**
   * Render modal content - MUST be implemented by subclasses
   * @private
   * @abstract
   */
  async _renderContent() {
    throw new Error('_renderContent() must be implemented by subclass');
  }

  /**
   * Setup event listeners - Optional, can be implemented by subclasses
   * @private
   * @abstract
   */
  // _setupEventListeners() {}

  /**
   * Cleanup - Optional, can be implemented by subclasses
   * @private
   * @abstract
   */
  // _cleanup() {}

  /**
   * Destroy modal and remove from DOM
   */
  destroy() {
    
    this.close();
    
    // Unregister from global registry
    MODAL_REGISTRY.delete(this);
    
    // Remove DOM listeners BEFORE removing from DOM
    if (this.closeButton) {
      this.closeButton.removeEventListener('click', this._handleCloseClick);
    }
    if (this.overlay) {
      this.overlay.removeEventListener('click', this._handleBackdropClick);
    }
    if (this.panel) {
      this.panel.removeEventListener('click', this._handlePanelClick);
    }
    
    // Remove from DOM
    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }
    
    // Clear references
    this.overlay = null;
    this.panel = null;
    this.headerEl = null;
    this.bodyEl = null;
    this.footerEl = null;
    this.closeButton = null;
  }

  /**
   * Shutdown (alias for destroy, for backwards compatibility)
   */
  shutdown() {
    this.destroy();
  }
}

/**
 * Utility to close all modals
 */
BaseModal.closeAll = function() {
  MODAL_REGISTRY.forEach(modal => {
    if (modal.isOpen) {
      modal.close();
    }
  });
};

module.exports = BaseModal;
