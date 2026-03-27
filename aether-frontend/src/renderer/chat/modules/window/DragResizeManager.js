'use strict';

const { createRendererLogger } = require('../../../shared/utils/logger');

/**
 * @.architecture
 * 
 * Incoming: ChatController (init call), User drag/resize interactions (pointerdown/pointermove/pointerup on header/handles) --- {dom_types.dom_event, PointerEvent}
 * Processing: In attached mode create 8 resize handles (n/s/e/w/ne/nw/se/sw) & setup drag on header, RAF-batched position/size updates for 60fps, viewport constraint (50px minimum visible), maximize/restore state management, detached mode delegates to OS --- {4 jobs: JOB_CREATE_DOM_ELEMENT, JOB_GET_STATE, JOB_UPDATE_DOM_ELEMENT, JOB_EMIT_EVENT}
 * Outgoing: DOM (window position/size via inline styles, resize handle elements), window CSS classes (dragging/resizing/maximized) --- {dom_types.chat_entry_element, HTMLElement}
 * 
 * 
 * @module renderer/chat/modules/window/DragResizeManager
 */

class DragResizeManager {
  constructor(options = {}) {
    // Dependencies
    this.chatWindow = options.chatWindow || null;
    this.eventBus = options.eventBus || null;

    // State
    this.isDetached = false;
    this.isDragging = false;
    this.isResizing = false;
    this.isMaximized = false;

    // DOM references (populated on initialize)
    this.element = null;
    this.header = null;

    // Drag state
    this.dragState = {
      pointerId: null,
      startX: 0,
      startY: 0,
      initialLeft: 0,
      initialTop: 0
    };

    // Resize state
    this.resizeState = {
      pointerId: null,
      handle: null,
      direction: null,
      startX: 0,
      startY: 0,
      initialBounds: null
    };

    // Saved states
    this.savedPosition = { left: 30, top: 30 };
    this.savedSize = { width: 500, height: 600 };
    this.normalBounds = null; // For maximize/restore

    // Animation frames
    this._dragRaf = null;
    this._resizeRaf = null;
    this._pendingDragEvent = null;
    this._pendingResizeEvent = null;

    // Cleanup tracking
    this._listeners = [];

    // Bind methods
    this.handleDrag = this.handleDrag.bind(this);
    this.endDrag = this.endDrag.bind(this);
    this.handleResize = this.handleResize.bind(this);
    this.endResize = this.endResize.bind(this);
    this.onWindowResize = this.onWindowResize.bind(this);
    this.onViewportResize = this.onViewportResize.bind(this);

    this.log = createRendererLogger('DragResizeManager');
    this.log.trace('constructed');
  }

  /**
   * Initialize with ChatWindow reference
   * Sets up drag/resize based on mode
   * @param {Object} options - { isDetached }
   */
  async init(options = {}) {
    this.log.debug('initializing drag/resize manager');

    if (!this.chatWindow) {
      throw new Error('[DragResizeManager] ChatWindow reference required');
    }

    // Get DOM elements
    const elements = this.chatWindow.getElements();
    this.element = elements.window;
    this.header = elements.header;

    if (!this.element || !this.header) {
      throw new Error('[DragResizeManager] Required DOM elements not found');
    }

    // Detect mode
    this.isDetached = options.isDetached !== undefined
      ? options.isDetached
      : this.chatWindow.isDetached;

    this.log.trace('mode detected', { mode: this.isDetached ? 'detached' : 'attached' });

    // Setup based on mode
    if (this.isDetached) {
      this.setupDetachedMode();
    } else {
      this.setupAttachedMode();
      this.position(); // Initial positioning
      
      // ARCHITECTURAL FIX: Listen for viewport resize to ensure window stays visible
      window.removeEventListener('resize', this.onViewportResize);
      window.addEventListener('resize', this.onViewportResize, { passive: true });
      this._listeners.push({ 
        target: window, 
        event: 'resize', 
        handler: this.onViewportResize,
        options: { passive: true }
      });
    }

    this.log.debug('initialization complete');
  }

  /**
   * Handle viewport resize for attached mode
   * @private
   */
  onViewportResize() {
    if (this.isDetached || !this.element) return;
    this.constrainToViewport();
  }

  /**
   * Setup for detached mode (OS-managed window)
   * @private
   */
  setupDetachedMode() {
    this.log.trace('setting up detached mode');

    // Fill entire window using viewport units for maximum responsiveness
    this.element.style.position = 'fixed';
    this.element.style.left = '0';
    this.element.style.top = '0';
    this.element.style.width = '100vw';
    this.element.style.height = '100vh';
    this.element.style.borderRadius = '0';

    // Listen for window resize to sync any internal pixel-based logic
    window.removeEventListener('resize', this.onWindowResize);
    window.addEventListener('resize', this.onWindowResize, { passive: true });
    this._listeners.push({
      target: window,
      event: 'resize',
      handler: this.onWindowResize,
      options: { passive: true }
    });
    this._listeners.push({ target: window, event: 'resize', handler: this.onWindowResize, options: { passive: true } });

    this.log.trace('detached mode setup complete');
  }

  /**
   * Setup for attached mode (custom drag/resize)
   * @private
   */
  setupAttachedMode() {
    this.log.trace('setting up attached mode');

    // Create resize handles
    this.createResizeHandles();

    // Setup drag on header
    this.setupDrag();

    this.log.trace('attached mode setup complete');
  }

  /**
   * Create 8 resize handles
   * @private
   */
  createResizeHandles() {
    // Check if handles already exist
    if (this.element.querySelector('.resize-handle')) {
      this.log.trace('resize handles already exist');
      return;
    }

    const directions = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];

    directions.forEach(direction => {
      const handle = document.createElement('div');
      handle.className = `resize-handle resize-${direction}`;
      handle.dataset.direction = direction;
      handle.style.touchAction = 'none'; // Required for pointer events on touch devices

      const onPointerDown = (e) => this.startResize(e, direction);
      handle.addEventListener('pointerdown', onPointerDown);
      this._listeners.push({ target: handle, event: 'pointerdown', handler: onPointerDown });

      this.element.appendChild(handle);
    });

    this.log.trace('resize handles created');
  }

  /**
   * Setup drag functionality on header
   * @private
   */
  setupDrag() {
    if (!this.header) return;

    this.header.style.cursor = 'move';
    this.header.style.touchAction = 'none'; // Required for pointer events on touch devices

    const onPointerDown = (e) => this.startDrag(e);
    this.header.addEventListener('pointerdown', onPointerDown);
    this._listeners.push({ target: this.header, event: 'pointerdown', handler: onPointerDown });

    this.log.trace('drag functionality setup');
  }

  /**
   * Handle window resize in detached mode.
   * CSS viewport units (100vw/100vh) and .detached !important rules handle sizing.
   * No pixel overrides — they break DPI/zoom adaptation and are redundant.
   * @private
   */
  onWindowResize() {
    if (!this.isDetached || !this.element) return;
    // Intentionally empty: CSS handles detached mode sizing via viewport units.
  }

  /**
   * Start drag operation
   * @param {PointerEvent} e
   * @private
   */
  startDrag(e) {
    // Skip if detached, maximized, non-primary button, or clicking controls/handles
    if (this.isDetached || this.isMaximized) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (e.target.closest('.aether-chat-controls')) return;
    if (e.target.closest('.resize-handle')) return;

    e.preventDefault();
    e.stopPropagation();

    this.isDragging = true;
    this.element.classList.add('dragging');

    const rect = this.element.getBoundingClientRect();
    this.dragState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      initialLeft: rect.left,
      initialTop: rect.top
    };

    // Capture pointer for reliable tracking across window boundaries
    try {
      this.header.setPointerCapture(e.pointerId);
    } catch (err) {
      this.log.warn('failed to capture pointer for drag', { error: err });
    }

    this.header.style.cursor = 'grabbing';

    document.addEventListener('pointermove', this.handleDrag, { passive: true });
    document.addEventListener('pointerup', this.endDrag);
    document.addEventListener('pointercancel', this.endDrag);
    // NOTE: These temporary document listeners are NOT tracked in _listeners.
    // They are session-lived (startDrag → endDrag), removed in endDrag().

    // Disable text selection
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';

    this.log.trace('drag started', { pointerId: e.pointerId, pointerType: e.pointerType });
  }

  /**
   * Handle drag movement
   * @private
   */
  handleDrag(e) {
    if (!this.isDragging) return;

    // Queue event for RAF processing
    this._pendingDragEvent = e;

    if (this._dragRaf) return; // Already scheduled

    this._dragRaf = requestAnimationFrame(() => {
      this._dragRaf = null;
      const ev = this._pendingDragEvent;
      this._pendingDragEvent = null;

      if (!ev || !this.isDragging) return;

      const deltaX = ev.clientX - this.dragState.startX;
      const deltaY = ev.clientY - this.dragState.startY;

      let newLeft = this.dragState.initialLeft + deltaX;
      let newTop = this.dragState.initialTop + deltaY;

      // Constrain to viewport (keep at least 50px visible)
      const minVisible = 50;
      const maxLeft = window.innerWidth - minVisible;
      const maxTop = window.innerHeight - minVisible;
      const minLeft = -this.element.offsetWidth + minVisible;
      const minTop = -this.element.offsetHeight + minVisible;

      newLeft = Math.max(minLeft, Math.min(maxLeft, newLeft));
      newTop = Math.max(minTop, Math.min(maxTop, newTop));

      this.element.style.left = `${newLeft}px`;
      this.element.style.top = `${newTop}px`;

      this.savedPosition = { left: newLeft, top: newTop };
    });
  }

  /**
   * End drag operation
   * @private
   */
  endDrag() {
    if (!this.isDragging) return;

    this.isDragging = false;
    this.element.classList.remove('dragging');
    this.header.style.cursor = 'move';

    document.removeEventListener('pointermove', this.handleDrag, { passive: true });
    document.removeEventListener('pointerup', this.endDrag);
    document.removeEventListener('pointercancel', this.endDrag);

    // Release pointer capture (auto-released on pointerup, safety net for pointercancel)
    try {
      if (this.header && this.dragState.pointerId != null) {
        this.header.releasePointerCapture(this.dragState.pointerId);
      }
    } catch {
      // Pointer may already be released — safe to ignore
    }

    // Re-enable text selection
    document.body.style.userSelect = '';
    document.body.style.webkitUserSelect = '';

    this.log.trace('drag ended');
  }

  /**
   * Start resize operation
   * @param {PointerEvent} e
   * @param {string} direction
   * @private
   */
  startResize(e, direction) {
    if (this.isDetached || this.isMaximized) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;

    e.preventDefault();
    e.stopPropagation();

    this.isResizing = true;
    this.element.classList.add('resizing');

    const handle = e.currentTarget;
    const rect = this.element.getBoundingClientRect();
    this.resizeState = {
      pointerId: e.pointerId,
      handle,
      direction,
      startX: e.clientX,
      startY: e.clientY,
      initialBounds: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      }
    };

    // Capture pointer on the resize handle for reliable tracking
    try {
      handle.setPointerCapture(e.pointerId);
    } catch (err) {
      this.log.warn('failed to capture pointer for resize', { error: err });
    }

    document.addEventListener('pointermove', this.handleResize, { passive: true });
    document.addEventListener('pointerup', this.endResize);
    document.addEventListener('pointercancel', this.endResize);
    // NOTE: These temporary document listeners are NOT tracked in _listeners.
    // They are session-lived (startResize → endResize), removed in endResize().

    // Disable text selection
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';

    this.log.trace('resize started', { direction, pointerId: e.pointerId });
  }

  /**
   * Handle resize movement
   * @private
   */
  handleResize(e) {
    if (!this.isResizing) return;

    // Queue event for RAF processing
    this._pendingResizeEvent = e;

    if (this._resizeRaf) return; // Already scheduled

    this._resizeRaf = requestAnimationFrame(() => {
      this._resizeRaf = null;
      const ev = this._pendingResizeEvent;
      this._pendingResizeEvent = null;

      if (!ev || !this.isResizing) return;

      const { direction, startX, startY, initialBounds } = this.resizeState;
      const deltaX = ev.clientX - startX;
      const deltaY = ev.clientY - startY;

      const newBounds = { ...initialBounds };
      const minWidth = 350;
      const minHeight = 300;

      // Apply delta based on direction
      if (direction.includes('n')) {
        newBounds.top = initialBounds.top + deltaY;
        newBounds.height = initialBounds.height - deltaY;
      }
      if (direction.includes('s')) {
        newBounds.height = initialBounds.height + deltaY;
      }
      if (direction.includes('w')) {
        newBounds.left = initialBounds.left + deltaX;
        newBounds.width = initialBounds.width - deltaX;
      }
      if (direction.includes('e')) {
        newBounds.width = initialBounds.width + deltaX;
      }

      // Enforce minimum size
      newBounds.width = Math.max(minWidth, newBounds.width);
      newBounds.height = Math.max(minHeight, newBounds.height);

      // Adjust position if minimum size hit
      if (newBounds.width === minWidth && direction.includes('w')) {
        newBounds.left = initialBounds.left + initialBounds.width - minWidth;
      }
      if (newBounds.height === minHeight && direction.includes('n')) {
        newBounds.top = initialBounds.top + initialBounds.height - minHeight;
      }

      // Apply bounds
      this.element.style.left = `${Math.round(newBounds.left)}px`;
      this.element.style.top = `${Math.round(newBounds.top)}px`;
      this.element.style.width = `${Math.round(newBounds.width)}px`;
      this.element.style.height = `${Math.round(newBounds.height)}px`;

      // Save state
      this.savedSize = { width: newBounds.width, height: newBounds.height };
      this.savedPosition = { left: newBounds.left, top: newBounds.top };
    });
  }

  /**
   * End resize operation
   * @private
   */
  endResize() {
    if (!this.isResizing) return;

    this.isResizing = false;
    this.element.classList.remove('resizing');

    document.removeEventListener('pointermove', this.handleResize, { passive: true });
    document.removeEventListener('pointerup', this.endResize);
    document.removeEventListener('pointercancel', this.endResize);

    // Release pointer capture on the handle
    try {
      const { handle, pointerId } = this.resizeState;
      if (handle && pointerId != null && typeof handle.releasePointerCapture === 'function') {
        handle.releasePointerCapture(pointerId);
      }
    } catch {
      // Pointer may already be released — safe to ignore
    }

    // Re-enable text selection
    document.body.style.userSelect = '';
    document.body.style.webkitUserSelect = '';

    this.log.trace('resize ended');
  }

  /**
   * Toggle maximize/restore
   */
  toggleMaximize() {
    if (this.isDetached) return false;

    this.isMaximized = !this.isMaximized;

    if (this.isMaximized) {
      // Save current bounds
      const rect = this.element.getBoundingClientRect();
      this.normalBounds = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      };

      // Maximize
      this.element.classList.add('maximized');
      this.element.style.left = '20px';
      this.element.style.top = '20px';
      this.element.style.width = `${window.innerWidth - 40}px`;
      this.element.style.height = `${window.innerHeight - 40}px`;

      this.log.trace('window maximized');
    } else {
      // Restore
      this.element.classList.remove('maximized');

      if (this.normalBounds) {
        this.element.style.left = `${this.normalBounds.left}px`;
        this.element.style.top = `${this.normalBounds.top}px`;
        this.element.style.width = `${this.normalBounds.width}px`;
        this.element.style.height = `${this.normalBounds.height}px`;
      }

      // Constrain restored bounds to current viewport — prevents off-screen
      // window when viewport shrank while maximized.
      this.constrainToViewport();

      // Sync JS state with the constrained DOM values
      const restoredRect = this.element.getBoundingClientRect();
      this.savedPosition = { left: restoredRect.left, top: restoredRect.top };
      this.savedSize = { width: restoredRect.width, height: restoredRect.height };

      this.log.trace('window restored');
    }

    return this.isMaximized;
  }

  /**
   * Position window (attached mode only)
   */
  position() {
    if (this.isDetached) return;

    this.element.style.position = 'fixed';
    this.element.style.left = `${this.savedPosition.left}px`;
    this.element.style.top = `${this.savedPosition.top}px`;
    this.element.style.width = `${this.savedSize.width}px`;
    this.element.style.height = `${this.savedSize.height}px`;

    this.log.trace('window positioned', {
      position: this.savedPosition,
      size: this.savedSize
    });
  }

  /**
   * Constrain window size AND position to viewport.
   * Size is clamped first (min 350x300, max viewport - margin).
   * Position is then clamped using the (potentially reduced) size.
   */
  constrainToViewport() {
    if (this.isDetached || this.isMaximized) return;

    const rect = this.element.getBoundingClientRect();
    const minVisible = 50;
    const minWidth = 350;
    const minHeight = 300;
    const edgeMargin = 48; // matches CSS max-width: calc(100vw - 48px)

    let changed = false;

    // 1. Clamp size to viewport bounds (prevents window exceeding viewport on shrink)
    const maxWidth = Math.max(minWidth, window.innerWidth - edgeMargin);
    const maxHeight = Math.max(minHeight, window.innerHeight - edgeMargin);
    let newWidth = Math.max(minWidth, Math.min(rect.width, maxWidth));
    let newHeight = Math.max(minHeight, Math.min(rect.height, maxHeight));

    if (newWidth !== rect.width || newHeight !== rect.height) {
      this.element.style.width = `${newWidth}px`;
      this.element.style.height = `${newHeight}px`;
      this.savedSize = { width: newWidth, height: newHeight };
      changed = true;
    }

    // 2. Clamp position using the (potentially updated) size
    let newLeft = rect.left;
    let newTop = rect.top;

    if (rect.right < minVisible) {
      newLeft = minVisible - newWidth;
    } else if (rect.left > window.innerWidth - minVisible) {
      newLeft = window.innerWidth - minVisible;
    }

    if (rect.bottom < minVisible) {
      newTop = minVisible - newHeight;
    } else if (rect.top > window.innerHeight - minVisible) {
      newTop = window.innerHeight - minVisible;
    }

    if (newLeft !== rect.left || newTop !== rect.top) {
      this.element.style.left = `${newLeft}px`;
      this.element.style.top = `${newTop}px`;
      this.savedPosition = { left: newLeft, top: newTop };
      changed = true;
    }

    if (changed) {
      this.log.trace('constrained to viewport bounds');
    }
  }

  /**
   * Get current state
   */
  getState() {
    return Object.freeze({
      isDetached: this.isDetached,
      isDragging: this.isDragging,
      isResizing: this.isResizing,
      isMaximized: this.isMaximized,
      savedPosition: { ...this.savedPosition },
      savedSize: { ...this.savedSize }
    });
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    this.log.info('disposing');

    // Cancel pending RAF
    if (this._dragRaf) {
      cancelAnimationFrame(this._dragRaf);
      this._dragRaf = null;
    }
    if (this._resizeRaf) {
      cancelAnimationFrame(this._resizeRaf);
      this._resizeRaf = null;
    }

    // Clean up any active drag/resize pointer sessions
    if (this.isDragging) {
      document.removeEventListener('pointermove', this.handleDrag, { passive: true });
      document.removeEventListener('pointerup', this.endDrag);
      document.removeEventListener('pointercancel', this.endDrag);
      try {
        if (this.header && this.dragState.pointerId != null) {
          this.header.releasePointerCapture(this.dragState.pointerId);
        }
      } catch { /* ignore */ }
    }
    if (this.isResizing) {
      document.removeEventListener('pointermove', this.handleResize, { passive: true });
      document.removeEventListener('pointerup', this.endResize);
      document.removeEventListener('pointercancel', this.endResize);
      try {
        const { handle, pointerId } = this.resizeState;
        if (handle && pointerId != null && typeof handle.releasePointerCapture === 'function') {
          handle.releasePointerCapture(pointerId);
        }
      } catch { /* ignore */ }
    }

    // Remove all lifecycle event listeners
    this._listeners.forEach(({ target, event, handler, options }) => {
      try {
        target.removeEventListener(event, handler, options);
      } catch (error) {
        this.log.warn('failed to remove registered listener', { error });
      }
    });
    this._listeners = [];

    // Reset state
    this.isDragging = false;
    this.isResizing = false;

    // Re-enable text selection
    document.body.style.userSelect = '';
    document.body.style.webkitUserSelect = '';

    // Clear references
    this.element = null;
    this.header = null;
    this.chatWindow = null;
    this.eventBus = null;

    this.log.debug('disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DragResizeManager;
}

if (typeof window !== 'undefined') {
  window.DragResizeManager = DragResizeManager;
  createRendererLogger('DragResizeManager').debug('module loaded');
}
