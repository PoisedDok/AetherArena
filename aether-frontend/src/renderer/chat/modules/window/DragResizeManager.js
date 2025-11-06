'use strict';

/**
 * @.architecture
 * 
 * Incoming: ChatController (init call), User drag/resize interactions (mousedown/mousemove/mouseup on header/handles) --- {dom_types.dom_event, MouseEvent}
 * Processing: In attached mode create 8 resize handles (n/s/e/w/ne/nw/se/sw) & setup drag on header, RAF-batched position/size updates for 60fps, viewport constraint (50px minimum visible), maximize/restore state management, detached mode delegates to OS --- {5 jobs: JOB_CREATE_DOM_ELEMENT, JOB_GET_STATE, JOB_UPDATE_STATE, JOB_UPDATE_STATE, JOB_EMIT_EVENT}
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
      startX: 0,
      startY: 0,
      initialLeft: 0,
      initialTop: 0
    };

    // Resize state
    this.resizeState = {
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

    console.log('[DragResizeManager] Constructed');
  }

  /**
   * Initialize with ChatWindow reference
   * Sets up drag/resize based on mode
   * @param {Object} options - { isDetached }
   */
  async init(options = {}) {
    console.log('[DragResizeManager] Initializing...');

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

    console.log(`[DragResizeManager] Mode: ${this.isDetached ? 'detached' : 'attached'}`);

    // Setup based on mode
    if (this.isDetached) {
      this.setupDetachedMode();
    } else {
      this.setupAttachedMode();
      this.position(); // Initial positioning
    }

    console.log('[DragResizeManager] Initialization complete');
  }

  /**
   * Setup for detached mode (OS-managed window)
   * @private
   */
  setupDetachedMode() {
    console.log('[DragResizeManager] Setting up detached mode');

    // Fill entire window
    this.element.style.position = 'fixed';
    this.element.style.left = '0px';
    this.element.style.top = '0px';
    this.element.style.width = '100vw';
    this.element.style.height = '100vh';

    // Listen for window resize
    window.addEventListener('resize', this.onWindowResize, { passive: true });
    this._listeners.push({ target: window, event: 'resize', handler: this.onWindowResize });

    console.log('[DragResizeManager] Detached mode setup complete');
  }

  /**
   * Setup for attached mode (custom drag/resize)
   * @private
   */
  setupAttachedMode() {
    console.log('[DragResizeManager] Setting up attached mode');

    // Create resize handles
    this.createResizeHandles();

    // Setup drag on header
    this.setupDrag();

    console.log('[DragResizeManager] Attached mode setup complete');
  }

  /**
   * Create 8 resize handles
   * @private
   */
  createResizeHandles() {
    // Check if handles already exist
    if (this.element.querySelector('.resize-handle')) {
      console.log('[DragResizeManager] Resize handles already exist');
      return;
    }

    const directions = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];

    directions.forEach(direction => {
      const handle = document.createElement('div');
      handle.className = `resize-handle resize-${direction}`;
      handle.dataset.direction = direction;

      // Add mousedown listener
      const onMouseDown = (e) => this.startResize(e, direction);
      handle.addEventListener('mousedown', onMouseDown);
      this._listeners.push({ target: handle, event: 'mousedown', handler: onMouseDown });

      this.element.appendChild(handle);
    });

    console.log('[DragResizeManager] Created 8 resize handles');
  }

  /**
   * Setup drag functionality on header
   * @private
   */
  setupDrag() {
    if (!this.header) return;

    this.header.style.cursor = 'move';

    const onMouseDown = (e) => this.startDrag(e);
    this.header.addEventListener('mousedown', onMouseDown);
    this._listeners.push({ target: this.header, event: 'mousedown', handler: onMouseDown });

    console.log('[DragResizeManager] Drag functionality setup');
  }

  /**
   * Handle window resize in detached mode
   * @private
   */
  onWindowResize() {
    if (!this.isDetached || !this.element) return;

    // Update to fill window
    this.element.style.width = `${window.innerWidth}px`;
    this.element.style.height = `${window.innerHeight}px`;
  }

  /**
   * Start drag operation
   * @private
   */
  startDrag(e) {
    // Skip if detached, maximized, or clicking controls
    if (this.isDetached || this.isMaximized) return;
    if (e.target.closest('.aether-chat-controls')) return;
    if (e.target.closest('.resize-handle')) return;

    e.preventDefault();
    e.stopPropagation();

    this.isDragging = true;
    this.element.classList.add('dragging');

    const rect = this.element.getBoundingClientRect();
    this.dragState = {
      startX: e.clientX,
      startY: e.clientY,
      initialLeft: rect.left,
      initialTop: rect.top
    };

    this.header.style.cursor = 'grabbing';

    document.addEventListener('mousemove', this.handleDrag, { passive: true });
    document.addEventListener('mouseup', this.endDrag, { passive: true });
    this._listeners.push({ target: document, event: 'mousemove', handler: this.handleDrag });
    this._listeners.push({ target: document, event: 'mouseup', handler: this.endDrag });

    // Disable text selection
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';

    console.log('[DragResizeManager] Drag started');
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

    document.removeEventListener('mousemove', this.handleDrag);
    document.removeEventListener('mouseup', this.endDrag);

    // Re-enable text selection
    document.body.style.userSelect = '';
    document.body.style.webkitUserSelect = '';

    console.log('[DragResizeManager] Drag ended');
  }

  /**
   * Start resize operation
   * @private
   */
  startResize(e, direction) {
    if (this.isDetached || this.isMaximized) return;

    e.preventDefault();
    e.stopPropagation();

    this.isResizing = true;
    this.element.classList.add('resizing');

    const rect = this.element.getBoundingClientRect();
    this.resizeState = {
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

    document.addEventListener('mousemove', this.handleResize, { passive: true });
    document.addEventListener('mouseup', this.endResize, { passive: true });
    this._listeners.push({ target: document, event: 'mousemove', handler: this.handleResize });
    this._listeners.push({ target: document, event: 'mouseup', handler: this.endResize });

    // Disable text selection
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';

    console.log(`[DragResizeManager] Resize started: ${direction}`);
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

    document.removeEventListener('mousemove', this.handleResize);
    document.removeEventListener('mouseup', this.endResize);

    // Re-enable text selection
    document.body.style.userSelect = '';
    document.body.style.webkitUserSelect = '';

    console.log('[DragResizeManager] Resize ended');
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

      console.log('[DragResizeManager] Maximized');
    } else {
      // Restore
      this.element.classList.remove('maximized');

      if (this.normalBounds) {
        this.element.style.left = `${this.normalBounds.left}px`;
        this.element.style.top = `${this.normalBounds.top}px`;
        this.element.style.width = `${this.normalBounds.width}px`;
        this.element.style.height = `${this.normalBounds.height}px`;
      }

      console.log('[DragResizeManager] Restored');
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

    console.log('[DragResizeManager] Positioned:', this.savedPosition, this.savedSize);
  }

  /**
   * Constrain window to viewport
   */
  constrainToViewport() {
    if (this.isDetached || this.isMaximized) return;

    const rect = this.element.getBoundingClientRect();
    const minVisible = 50;

    let newLeft = rect.left;
    let newTop = rect.top;

    // Constrain horizontally
    if (rect.right < minVisible) {
      newLeft = minVisible - rect.width;
    } else if (rect.left > window.innerWidth - minVisible) {
      newLeft = window.innerWidth - minVisible;
    }

    // Constrain vertically
    if (rect.bottom < minVisible) {
      newTop = minVisible - rect.height;
    } else if (rect.top > window.innerHeight - minVisible) {
      newTop = window.innerHeight - minVisible;
    }

    // Apply if changed
    if (newLeft !== rect.left || newTop !== rect.top) {
      this.element.style.left = `${newLeft}px`;
      this.element.style.top = `${newTop}px`;
      this.savedPosition = { left: newLeft, top: newTop };
      console.log('[DragResizeManager] Constrained to viewport');
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
    console.log('[DragResizeManager] Disposing...');

    // Cancel pending RAF
    if (this._dragRaf) {
      cancelAnimationFrame(this._dragRaf);
      this._dragRaf = null;
    }
    if (this._resizeRaf) {
      cancelAnimationFrame(this._resizeRaf);
      this._resizeRaf = null;
    }

    // Remove all event listeners
    this._listeners.forEach(({ target, event, handler }) => {
      try {
        target.removeEventListener(event, handler);
      } catch (error) {
        console.warn('[DragResizeManager] Failed to remove listener:', error);
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

    console.log('[DragResizeManager] Disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DragResizeManager;
}

if (typeof window !== 'undefined') {
  window.DragResizeManager = DragResizeManager;
  console.log('📦 DragResizeManager loaded');
}

