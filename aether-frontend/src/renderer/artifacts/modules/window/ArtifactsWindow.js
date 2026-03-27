'use strict';

/**
 * Incoming: ArtifactsController bootstrap, EventBus (chat+connection), DOM pointer/keyboard events --- {Dict, json}
 * Processing: Manage artifacts workspace shell in standalone mode (fills Electron window), track interaction state, delegate drag/resize to Electron in standalone mode --- {6 jobs: JOB_CACHE_LOCALLY, JOB_CREATE_DOM_ELEMENT, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_INITIALIZE, JOB_UPDATE_STATE}
 * Outgoing: TabManager panes, windowControl bridge, EventBus WINDOW_* notifications --- {HTMLElement, dom.artifact_panel}
 */

const { EventTypes } = require('../../../../core/events/EventTypes');
const { getAether } = require('../../../shared/bridge/AetherBridge');
const { createRendererLogger } = require('../../../shared/utils/logger');
const { freeze } = Object;

const CONFIG = freeze({
  WINDOW: freeze({
    MIN_WIDTH: 520,
    MIN_HEIGHT: 360,
    DEFAULT_WIDTH: 960,
    DEFAULT_HEIGHT: 640,
    DEFAULT_POSITION: freeze({ x: 72, y: 72 }),
    EDGE_MARGIN: 24,
  }),
  STATE: freeze({
    KEY: 'aether.artifacts.window.state.v2',
    VERSION: 2,
  }),
  ANIMATION: freeze({
    DURATION: 300,
    EASING: 'cubic-bezier(0.4, 0, 0.2, 1)',
  }),
  INTERACTION: freeze({
    DRAG_ACTIVATION_PX: 6,
  }),
  ZINDEX: freeze({
    WINDOW: 1000,
    OVERLAY: 999,
  }),
  CLASS_NAMES: freeze({
    WINDOW: 'artifacts-window',
    CHROME: 'artifacts-chrome',
    HEADER: 'artifacts-header',
    BRANDING: 'artifacts-branding',
    TITLE: 'artifacts-title',
    TABS: 'artifacts-tabs',
    TAB_BUTTON: 'artifacts-tab',
    ACTIVE_TAB: 'active',
    CONTROLS: 'artifacts-controls',
    CONTROL_BTN: 'artifacts-control-btn',
    CONTENT: 'artifacts-content',
    PANE: 'artifacts-pane',
    ACTIVE_PANE: 'active',
    HIDDEN: 'hidden',
    VISIBLE: 'visible',
    DRAGGING: 'dragging',
    RESIZE_HANDLE: 'artifacts-resize-handle',
    PINNED: 'artifacts-window--pinned',
    RESIZING: 'artifacts-window--resizing',
  }),
});

class ArtifactsWindow {
  constructor(options = {}) {
    this.log = createRendererLogger('ArtifactsWindow');
    if (!options.controller) {
      throw new Error('[ArtifactsWindow] Controller required');
    }

    if (!options.eventBus) {
      throw new Error('[ArtifactsWindow] EventBus required');
    }

    this.controller = options.controller;
    this.eventBus = options.eventBus;
    this.aether = options.aether || getAether();

    this.element = null;
    this.chrome = null;
    this.header = null;
    this.tabsContainer = null;
    this.controlsContainer = null;
    this.contentContainer = null;
    this.closeButton = null;
    this.pinButton = null;
    this.resetButton = null;
    this.resizeHandle = null;

    this.visible = false;
    this.position = { ...CONFIG.WINDOW.DEFAULT_POSITION };
    this.size = {
      width: CONFIG.WINDOW.DEFAULT_WIDTH,
      height: CONFIG.WINDOW.DEFAULT_HEIGHT,
    };
    this.minimized = false;
    this.pinned = false;

    // In artifacts renderer, we're ALWAYS in a separate BrowserWindow.
    // Name this mode "standalone" to avoid confusion with Electron window concepts.
    this.isStandalone = true;

    this.jobTracer = null;
    this._jobTraceDefaults = { component: 'ArtifactsWindow' };

    // In standalone mode, we fill the entire viewport (Electron window)
    // Electron handles window dragging/resizing, not us
    if (this.isStandalone && typeof window !== 'undefined') {
      this.size.width = window.innerWidth;
      this.size.height = window.innerHeight;
      this.position = { x: 0, y: 0 };
    } else if (typeof window !== 'undefined') {
      const viewportWidth = window.innerWidth || CONFIG.WINDOW.DEFAULT_WIDTH;
      const viewportHeight = window.innerHeight || CONFIG.WINDOW.DEFAULT_HEIGHT;
      const usableWidth = Math.max(
        CONFIG.WINDOW.MIN_WIDTH,
        viewportWidth - CONFIG.WINDOW.EDGE_MARGIN * 2
      );
      const usableHeight = Math.max(
        CONFIG.WINDOW.MIN_HEIGHT,
        viewportHeight - CONFIG.WINDOW.EDGE_MARGIN * 2
      );
      this.size.width = usableWidth;
      this.size.height = usableHeight;
      this.position = {
        x: CONFIG.WINDOW.EDGE_MARGIN,
        y: CONFIG.WINDOW.EDGE_MARGIN,
      };
    }

    this._dragSession = null;
    this._dragRaf = null;
    this._resizeSession = null;
    this._resizeRaf = null;

    this._isDisposed = false;
    this._isInitialized = false;
    this._eventListeners = [];

    this._handleClose = this._handleClose.bind(this);
    this._handleDragStart = this._handleDragStart.bind(this);
    this._handleDragMove = this._handleDragMove.bind(this);
    this._handleDragEnd = this._handleDragEnd.bind(this);
    this._handlePinToggle = this._handlePinToggle.bind(this);
    this._handleResetFrame = this._handleResetFrame.bind(this);
    this._handleResizeStart = this._handleResizeStart.bind(this);
    this._handleResizeMove = this._handleResizeMove.bind(this);
    this._handleResizeEnd = this._handleResizeEnd.bind(this);
    this._handleViewportResize = this._handleViewportResize.bind(this);
    this._handleKeydown = this._handleKeydown.bind(this);
    this._suppressClickAfterDrag = this._suppressClickAfterDrag.bind(this);

    this._initializeJobTracer(options.jobTracer || null);
  }

  /**
   * Initialize window
   */
  async init() {
    if (this._isDisposed) {
      this.log.warn('[ArtifactsWindow] init() called on disposed instance — ignored');
      return;
    }
    if (this._isInitialized) {
      this.log.warn('[ArtifactsWindow] init() called on already-initialized instance — ignored');
      return;
    }

    this.log.debug('[ArtifactsWindow] Initializing...');

    try {
      this._createElement();
      this._injectStyles();
      this._setupEventListeners();
      this._restoreFrameFromState();
      this._isInitialized = true;
      this._traceJob('JOB_INITIALIZE', { stage: 'init:complete' });

      this.eventBus.emit(EventTypes.UI.COMPONENT_READY, { 
        component: 'ArtifactsWindow',
        timestamp: Date.now(),
      });
      this._traceJob('JOB_EMIT_EVENT', {
        stage: 'init:component-ready',
        event: EventTypes.UI.COMPONENT_READY,
      });

      this.log.debug('[ArtifactsWindow] Initialized');
    } catch (error) {
      this.log.error('[ArtifactsWindow] Initialization failed:', error);
      this._traceJob('JOB_INITIALIZE', { stage: 'init:error', error: error.message });
      throw error;
    }
  }

  /**
   * Dispose window and cleanup
   */
  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;

    this.log.debug('[ArtifactsWindow] Disposing...');

    this._cancelOngoingInteractions();

    for (const cleanup of this._eventListeners) {
      try {
        cleanup();
      } catch (error) {
        this.log.error('[ArtifactsWindow] Failed cleanup:', error);
      }
    }

    this._eventListeners = [];

    if (this.element?.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }

    this.element = null;
    this.chrome = null;
    this.header = null;
    this.tabsContainer = null;
    this.controlsContainer = null;
    this.contentContainer = null;
    this.closeButton = null;
    this.pinButton = null;
    this.resetButton = null;
    this.resizeHandle = null;
    this._isInitialized = false;

    this.log.debug('[ArtifactsWindow] Disposed');
  }

  /**
   * Show window
   */
  show() {
    if (this._isDisposed || this.visible) {
      return;
    }

    this.element.classList.remove(CONFIG.CLASS_NAMES.HIDDEN);
    this.element.classList.add(CONFIG.CLASS_NAMES.VISIBLE);
    this.element.setAttribute('aria-hidden', 'false');
    this.visible = true;
    this._traceJob('JOB_UPDATE_STATE', { stage: 'visibility:show' });

    this.eventBus.emit(EventTypes.UI.WINDOW_SHOWN, { window: 'artifacts' });
    this._traceJob('JOB_EMIT_EVENT', {
      stage: 'visibility:event',
      event: EventTypes.UI.WINDOW_SHOWN,
    });
    this.log.debug('[ArtifactsWindow] Window shown');
  }

  /**
   * Hide window
   */
  hide() {
    if (this._isDisposed || !this.visible) {
      return;
    }

    this.element.classList.remove(CONFIG.CLASS_NAMES.VISIBLE);
    this.element.classList.add(CONFIG.CLASS_NAMES.HIDDEN);
    this.element.setAttribute('aria-hidden', 'true');
    this.visible = false;
    this._traceJob('JOB_UPDATE_STATE', { stage: 'visibility:hide' });

    this.eventBus.emit(EventTypes.UI.WINDOW_HIDDEN, { window: 'artifacts' });
    this._traceJob('JOB_EMIT_EVENT', {
      stage: 'visibility:event',
      event: EventTypes.UI.WINDOW_HIDDEN,
    });
    this.log.debug('[ArtifactsWindow] Window hidden');
  }

  /**
   * Toggle window visibility
   */
  toggle() {
    if (this.visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  /**
   * Get window element (for tab/content injection)
   * @returns {HTMLElement}
   */
  getElement() {
    return this.element;
  }

  /**
   * Get tabs container
   * @returns {HTMLElement}
   */
  getTabsContainer() {
    return this.tabsContainer;
  }

  /**
   * Get content container
   * @returns {HTMLElement}
   */
  getContentContainer() {
    return this.contentContainer;
  }

  /**
   * Get window state
   * @returns {Object}
   */
  getState() {
    return freeze({
      visible: this.visible,
      position: { ...this.position },
      size: { ...this.size },
      minimized: this.minimized,
    });
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Create DOM element structure
   * @private
   */
  _createElement() {
    this.element = document.createElement('section');
    
    // Apply base class and standalone mode (artifacts renderer always runs in its own BrowserWindow)
    const classes = [CONFIG.CLASS_NAMES.WINDOW, CONFIG.CLASS_NAMES.HIDDEN];
    if (this.isStandalone) {
      classes.push('standalone');
    }
    this.element.className = classes.join(' ');
    
    this.element.dataset.windowId = 'artifacts';
    
    // In standalone mode, positioning is controlled by Electron window, not DOM
    if (!this.isStandalone) {
      this.element.style.width = `${this.size.width}px`;
      this.element.style.height = `${this.size.height}px`;
      this.element.style.left = `${this.position.x}px`;
      this.element.style.top = `${this.position.y}px`;
      this.element.style.zIndex = CONFIG.ZINDEX.WINDOW;
    }
    
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-label', 'Workbench');
    this.element.setAttribute('aria-modal', 'false');
    this.element.setAttribute('aria-hidden', 'true');

    this.chrome = document.createElement('div');
    this.chrome.className = CONFIG.CLASS_NAMES.CHROME;

    this.header = document.createElement('header');
    this.header.className = CONFIG.CLASS_NAMES.HEADER;
    
    // Only enable drag in attached (floating) mode - Electron handles dragging in standalone mode
    if (!this.isStandalone) {
      this.header.dataset.dragHandle = 'true';
    } else {
      // In standalone mode, use -webkit-app-region for Electron native dragging
      this.header.style.webkitAppRegion = 'drag';
    }

    const branding = document.createElement('div');
    branding.className = CONFIG.CLASS_NAMES.BRANDING;

    const title = document.createElement('span');
    title.className = CONFIG.CLASS_NAMES.TITLE;
    title.textContent = 'Workbench';

    branding.appendChild(title);

    this.tabsContainer = document.createElement('nav');
    this.tabsContainer.className = CONFIG.CLASS_NAMES.TABS;
    this.tabsContainer.setAttribute('role', 'tablist');

    this.controlsContainer = document.createElement('div');
    this.controlsContainer.className = CONFIG.CLASS_NAMES.CONTROLS;

    // Reset button only in attached (floating) mode — in standalone mode,
    // _handleResetFrame sets pixel values that CSS !important overrides,
    // creating a no-op that desyncs this.size/this.position state.
    if (!this.isStandalone) {
      this.resetButton = this._createControlButton('artifacts-reset', 'Reset layout', 'Reset', this._handleResetFrame);
      this.controlsContainer.appendChild(this.resetButton);
    }
    this.closeButton = this._createControlButton('artifacts-close', 'Close artifacts window', '×', this._handleClose);
    this.controlsContainer.appendChild(this.closeButton);

    this.header.appendChild(branding);
    this.header.appendChild(this.tabsContainer);
    this.header.appendChild(this.controlsContainer);

    this.contentContainer = document.createElement('div');
    this.contentContainer.className = CONFIG.CLASS_NAMES.CONTENT;

    // Resize handle only in attached (floating) mode - Electron handles resizing in standalone mode
    if (!this.isStandalone) {
      this.resizeHandle = document.createElement('button');
      this.resizeHandle.type = 'button';
      this.resizeHandle.className = CONFIG.CLASS_NAMES.RESIZE_HANDLE;
      this.resizeHandle.setAttribute('aria-label', 'Resize artifacts window');
      this.resizeHandle.setAttribute('tabindex', '-1');
    }

    this.chrome.appendChild(this.header);
    this.chrome.appendChild(this.contentContainer);

    this.element.appendChild(this.chrome);
    
    // Only append resize handle if it exists (attached mode)
    if (this.resizeHandle) {
      this.element.appendChild(this.resizeHandle);
    }

    document.body.appendChild(this.element);

    this.log.debug('[ArtifactsWindow] DOM structure created');
  }

  /**
   * Setup event listeners
   * @private
   */
  _setupEventListeners() {
    if (this.closeButton) {
      this.closeButton.addEventListener('click', this._handleClose);
      this._eventListeners.push(() => this.closeButton.removeEventListener('click', this._handleClose));
    }

    if (this.resetButton) {
      this.resetButton.addEventListener('click', this._handleResetFrame);
      this._eventListeners.push(() => this.resetButton.removeEventListener('click', this._handleResetFrame));
    }

    // Only setup custom drag/resize in attached mode - Electron handles it in standalone mode
    if (!this.isStandalone) {
      if (this.header) {
        this.header.addEventListener('mousedown', this._handleDragStart);
        this._eventListeners.push(() => this.header.removeEventListener('mousedown', this._handleDragStart));
      }

      if (this.resizeHandle) {
        this.resizeHandle.addEventListener('pointerdown', this._handleResizeStart);
        this._eventListeners.push(() => this.resizeHandle.removeEventListener('pointerdown', this._handleResizeStart));
      }

      window.addEventListener('resize', this._handleViewportResize);
      this._eventListeners.push(() => window.removeEventListener('resize', this._handleViewportResize));
    } else {
      // In standalone mode, sync size with Electron window resize
      const handleWindowResize = () => {
        this.size.width = window.innerWidth;
        this.size.height = window.innerHeight;
      };
      window.addEventListener('resize', handleWindowResize);
      this._eventListeners.push(() => window.removeEventListener('resize', handleWindowResize));
    }

    document.addEventListener('keydown', this._handleKeydown);
    this._eventListeners.push(() => document.removeEventListener('keydown', this._handleKeydown));

    // Listen for hide initiation
    if (this.aether && this.aether.windowControl && this.aether.windowControl.onInitiateHide) {
      const cleanupHide = this.aether.windowControl.onInitiateHide(() => {
        if (!this.element) return;
        
        // Clean up existing in-progress fade if any
        if (this._finishHideCallback) {
          this.element.removeEventListener('transitionend', this._finishHideCallback);
        }
        if (this._hideTimeoutFallback) {
          clearTimeout(this._hideTimeoutFallback);
          this._hideTimeoutFallback = null;
        }

        this.element.classList.add('hiding-transition');
        
        const finishHide = () => {
          this.element.removeEventListener('transitionend', finishHide);
          this._finishHideCallback = null;
          
          if (this._hideTimeoutFallback) {
            clearTimeout(this._hideTimeoutFallback);
            this._hideTimeoutFallback = null;
          }
          if (this.aether?.windowControl?.hideCompleted) {
            this.aether.windowControl.hideCompleted();
          }
          requestAnimationFrame(() => {
            if (this.element) {
              this.element.classList.remove('hiding-transition');
            }
          });
        };

        this._finishHideCallback = finishHide;
        this.element.addEventListener('transitionend', finishHide);
        
        // Fallback in case transitionend doesn't fire
        this._hideTimeoutFallback = setTimeout(finishHide, 350);
      });
      this._eventListeners.push(cleanupHide);
      this._eventListeners.push(() => {
        if (this._hideTimeoutFallback) {
          clearTimeout(this._hideTimeoutFallback);
          this._hideTimeoutFallback = null;
        }
        if (this._finishHideCallback && this.element) {
          this.element.removeEventListener('transitionend', this._finishHideCallback);
          this._finishHideCallback = null;
        }
      });
    }

    // Listen for hide cancellation
    if (this.aether && this.aether.windowControl && this.aether.windowControl.onCancelHide) {
      const cleanupCancel = this.aether.windowControl.onCancelHide(() => {
        if (!this.element) return;
        
        // Clear timeout
        if (this._hideTimeoutFallback) {
          clearTimeout(this._hideTimeoutFallback);
          this._hideTimeoutFallback = null;
        }
        
        // Remove listener
        if (this._finishHideCallback) {
          this.element.removeEventListener('transitionend', this._finishHideCallback);
          this._finishHideCallback = null;
        }
        
        // Remove CSS class to immediately restore opacity
        requestAnimationFrame(() => {
          if (this.element) {
            this.element.classList.remove('hiding-transition');
          }
        });
      });
      this._eventListeners.push(cleanupCancel);
    }

    this.log.debug('[ArtifactsWindow] Event listeners setup', {
      mode: this.isStandalone ? 'standalone' : 'attached',
    });
    this._traceJob('JOB_INITIALIZE', { 
      stage: 'listeners:bound',
      mode: this.isStandalone ? 'standalone' : 'attached',
    });
  }

  /**
   * Handle close button click
   * @private
   */
  _handleClose() {
    this.hide();
    
    if (this.aether?.windowControl) {
      try {
        this.aether.windowControl.control('close');
      } catch (error) {
        this.log.error('[ArtifactsWindow] Failed to notify main process:', error);
      }
    }
  }

  /**
   * Handle drag start
   * @private
   */
  _handleDragStart(event) {
    if (this.pinned || !this._isPrimaryPointer(event)) {
      return;
    }

    const fromControls = Boolean(event.target.closest(`.${CONFIG.CLASS_NAMES.CONTROLS}`));
    if (fromControls) {
      return;
    }

    const fromTab = Boolean(event.target.closest(`.${CONFIG.CLASS_NAMES.TAB_BUTTON}`));

    this._cancelDragSession();

    this._dragSession = {
      pointerId: this._resolvePointerId(event),
      startX: event.clientX,
      startY: event.clientY,
      originX: this.position.x,
      originY: this.position.y,
      started: false,
      fromTab,
    };

    window.addEventListener('pointermove', this._handleDragMove, { passive: false });
    window.addEventListener('pointerup', this._handleDragEnd);
    window.addEventListener('pointercancel', this._handleDragEnd);
  }

  _handleDragMove(event) {
    const session = this._dragSession;
    if (!session || !this._eventMatchesPointer(event, session.pointerId)) {
      return;
    }

    const deltaX = event.clientX - session.startX;
    const deltaY = event.clientY - session.startY;
    const distance = Math.hypot(deltaX, deltaY);

    if (!session.started) {
      if (distance < CONFIG.INTERACTION.DRAG_ACTIVATION_PX) {
        return;
      }
      session.started = true;
      if (session.fromTab) {
        this._suppressClickAfterDrag();
      }
      this.element.classList.add(CONFIG.CLASS_NAMES.DRAGGING);
      this._traceJob('JOB_UPDATE_STATE', {
        stage: 'drag:start',
        pointerType: event.pointerType || 'mouse',
      });
    }

    const nextX = session.originX + deltaX;
    const nextY = session.originY + deltaY;

    if (this._dragRaf !== null) {
      cancelAnimationFrame(this._dragRaf);
    }

    this._dragRaf = requestAnimationFrame(() => {
      this._applyPosition(nextX, nextY, { silently: true });
    });

    event.preventDefault();
  }

  _handleDragEnd(event) {
    const session = this._dragSession;
    if (!session || (event && !this._eventMatchesPointer(event, session.pointerId))) {
      return;
    }

    window.removeEventListener('pointermove', this._handleDragMove);
    window.removeEventListener('pointerup', this._handleDragEnd);
    window.removeEventListener('pointercancel', this._handleDragEnd);

    if (this._dragRaf !== null) {
      cancelAnimationFrame(this._dragRaf);
      this._dragRaf = null;
    }

    const wasDragging = session.started;

    if (wasDragging && event && typeof event.clientX === 'number' && typeof event.clientY === 'number') {
      const deltaX = event.clientX - session.startX;
      const deltaY = event.clientY - session.startY;
      const finalX = session.originX + deltaX;
      const finalY = session.originY + deltaY;
      this._applyPosition(finalX, finalY, { silently: true });
    }

    this._dragSession = null;
    this.element.classList.remove(CONFIG.CLASS_NAMES.DRAGGING);

    if (wasDragging) {
      this._persistState();
      this._emitWindowMoved('drag');
      this._traceJob('JOB_UPDATE_STATE', { stage: 'drag:end' });
    }
  }

  _handleResizeStart(event) {
    if (this.pinned || !this._isPrimaryPointer(event)) {
      return;
    }

    event.preventDefault();

    this._resizeSession = {
      pointerId: this._resolvePointerId(event),
      width: this.size.width,
      height: this.size.height,
      startX: event.clientX,
      startY: event.clientY,
    };

    try {
      if (this.resizeHandle?.setPointerCapture) {
        this.resizeHandle.setPointerCapture(this._resizeSession.pointerId);
      }
    } catch (error) {
      this.log.warn('[ArtifactsWindow] Failed to capture pointer for resize', error);
    }

    this.element.classList.add(CONFIG.CLASS_NAMES.RESIZING);
    window.addEventListener('pointermove', this._handleResizeMove, { passive: false });
    window.addEventListener('pointerup', this._handleResizeEnd);
    window.addEventListener('pointercancel', this._handleResizeEnd);
    this._traceJob('JOB_UPDATE_STATE', {
      stage: 'resize:start',
      width: this.size.width,
      height: this.size.height,
    });
  }

  _handleResizeMove(event) {
    if (!this._resizeSession || !this._eventMatchesPointer(event, this._resizeSession.pointerId)) {
      return;
    }

    const deltaX = event.clientX - this._resizeSession.startX;
    const deltaY = event.clientY - this._resizeSession.startY;
    const nextWidth = this._resizeSession.width + deltaX;
    const nextHeight = this._resizeSession.height + deltaY;

    if (this._resizeRaf !== null) {
      cancelAnimationFrame(this._resizeRaf);
    }

    this._resizeRaf = requestAnimationFrame(() => {
      this._applySize(nextWidth, nextHeight);
    });

    event.preventDefault();
  }

  _handleResizeEnd(event) {
    if (!this._resizeSession || (event && !this._eventMatchesPointer(event, this._resizeSession.pointerId))) {
      return;
    }

    window.removeEventListener('pointermove', this._handleResizeMove);
    window.removeEventListener('pointerup', this._handleResizeEnd);
    window.removeEventListener('pointercancel', this._handleResizeEnd);

    if (this._resizeRaf !== null) {
      cancelAnimationFrame(this._resizeRaf);
      this._resizeRaf = null;
    }

    if (this.resizeHandle && typeof this.resizeHandle.releasePointerCapture === 'function') {
      try {
        this.resizeHandle.releasePointerCapture(this._resizeSession.pointerId);
      } catch {
        // ignore release failure
      }
    }

    if (event && typeof event.clientX === 'number' && typeof event.clientY === 'number') {
      const deltaX = event.clientX - this._resizeSession.startX;
      const deltaY = event.clientY - this._resizeSession.startY;
      const nextWidth = this._resizeSession.width + deltaX;
      const nextHeight = this._resizeSession.height + deltaY;
      this._applySize(nextWidth, nextHeight);
    }

    this._resizeSession = null;
    this.element.classList.remove(CONFIG.CLASS_NAMES.RESIZING);

    this._persistState();
    this._emitWindowMoved('resize');
    this._traceJob('JOB_UPDATE_STATE', {
      stage: 'resize:end',
      width: this.size.width,
      height: this.size.height,
    });
  }

  _handlePinToggle() {
    this.pinned = !this.pinned;
    this.pinButton?.setAttribute('aria-pressed', this.pinned ? 'true' : 'false');
    this.element.classList.toggle(CONFIG.CLASS_NAMES.PINNED, this.pinned);

    if (this.pinned) {
      this.element.style.left = 'auto';
      this.element.style.right = `${CONFIG.WINDOW.EDGE_MARGIN}px`;
      this.element.style.top = `${CONFIG.WINDOW.EDGE_MARGIN}px`;
    } else {
      this.element.style.right = 'auto';
      this._applyPosition(this.position.x, this.position.y);
    }

    this._persistState();
    this._traceJob('JOB_UPDATE_STATE', {
      stage: 'pin-toggle',
      pinned: this.pinned,
      position: { ...this.position },
    });
  }

  _handleResetFrame() {
    this._applySize(CONFIG.WINDOW.DEFAULT_WIDTH, CONFIG.WINDOW.DEFAULT_HEIGHT);
    this._applyPosition(CONFIG.WINDOW.DEFAULT_POSITION.x, CONFIG.WINDOW.DEFAULT_POSITION.y);
    this._persistState();
    this._emitWindowMoved('reset');
    this._traceJob('JOB_UPDATE_STATE', {
      stage: 'reset-frame',
      position: { ...this.position },
      size: { ...this.size },
    });
  }

  _handleViewportResize() {
    this._applyPosition(this.position.x, this.position.y, { silently: true });
    this._applySize(this.size.width, this.size.height);
    this._traceJob('JOB_UPDATE_STATE', {
      stage: 'viewport-resize',
      position: { ...this.position },
      size: { ...this.size },
    });
  }

  _handleKeydown(event) {
    if (event.key === 'Escape' && this.visible) {
      event.preventDefault();
      this.hide();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      this.toggle();
    }
  }

  _isPrimaryPointer(event) {
    if (!event) {
      return false;
    }

    if (typeof event.pointerType === 'string' && event.pointerType !== 'mouse') {
      return true;
    }

    if (typeof event.button === 'number') {
      return event.button === 0;
    }

    if (typeof event.which === 'number') {
      return event.which === 1;
    }

    return true;
  }

  _resolvePointerId(event) {
    if (event && typeof event.pointerId === 'number') {
      return event.pointerId;
    }
    return 'mouse';
  }

  _eventMatchesPointer(event, pointerId) {
    if (!event) {
      return false;
    }

    if (pointerId === 'mouse') {
      return event.pointerType === 'mouse' || typeof event.pointerId !== 'number';
    }

    return event.pointerId === pointerId;
  }

  _suppressClickAfterDrag() {
    if (!this.header) {
      return;
    }

    const preventClick = (event) => {
      event.stopPropagation();
      event.preventDefault();
    };

    this.header.addEventListener('click', preventClick, true);
    requestAnimationFrame(() => {
      if (this.header) {
        this.header.removeEventListener('click', preventClick, true);
      }
    });
  }

  _createControlButton(id, label, text, handler, toggleable = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = id;
    button.className = CONFIG.CLASS_NAMES.CONTROL_BTN;
    button.setAttribute('aria-label', label);
    if (toggleable) {
      button.setAttribute('aria-pressed', 'false');
    }
    button.textContent = text;
    button.addEventListener('click', handler);
    this._eventListeners.push(() => button.removeEventListener('click', handler));
    return button;
  }

  _emitWindowMoved(reason = 'move') {
    this.eventBus.emit(EventTypes.UI.WINDOW_MOVED, {
      window: 'artifacts',
      position: { ...this.position },
      size: { ...this.size },
      reason,
    });
    this._traceJob('JOB_EMIT_EVENT', {
      stage: 'window:moved',
      reason,
      position: { ...this.position },
      size: { ...this.size },
    });
  }

  _cancelDragSession() {
    if (!this._dragSession) {
      return;
    }

    window.removeEventListener('pointermove', this._handleDragMove);
    window.removeEventListener('pointerup', this._handleDragEnd);
    window.removeEventListener('pointercancel', this._handleDragEnd);

    if (this._dragRaf !== null) {
      cancelAnimationFrame(this._dragRaf);
      this._dragRaf = null;
    }

    this._dragSession = null;
    if (this.element) {
      this.element.classList.remove(CONFIG.CLASS_NAMES.DRAGGING);
    }
  }

  _cancelOngoingInteractions() {
    this._cancelDragSession();

    if (this._resizeRaf !== null) {
      cancelAnimationFrame(this._resizeRaf);
      this._resizeRaf = null;
    }

    if (this._resizeSession) {
      window.removeEventListener('pointermove', this._handleResizeMove);
      window.removeEventListener('pointerup', this._handleResizeEnd);
      window.removeEventListener('pointercancel', this._handleResizeEnd);

      if (this.resizeHandle && typeof this.resizeHandle.releasePointerCapture === 'function') {
        try {
          this.resizeHandle.releasePointerCapture(this._resizeSession.pointerId);
        } catch {
          // ignore release failure
        }
      }
      this._resizeSession = null;
    }

    if (this.element) {
      this.element.classList.remove(CONFIG.CLASS_NAMES.RESIZING);
    }
  }

  _applySize(width, height) {
    const viewportWidth = window.innerWidth || CONFIG.WINDOW.DEFAULT_WIDTH;
    const viewportHeight = window.innerHeight || CONFIG.WINDOW.DEFAULT_HEIGHT;
    const maxWidth = Math.max(CONFIG.WINDOW.MIN_WIDTH, viewportWidth - this.position.x - CONFIG.WINDOW.EDGE_MARGIN);
    const maxHeight = Math.max(CONFIG.WINDOW.MIN_HEIGHT, viewportHeight - this.position.y - CONFIG.WINDOW.EDGE_MARGIN);

    const clampedWidth = Math.min(Math.max(width, CONFIG.WINDOW.MIN_WIDTH), maxWidth);
    const clampedHeight = Math.min(Math.max(height, CONFIG.WINDOW.MIN_HEIGHT), maxHeight);

    this.size.width = clampedWidth;
    this.size.height = clampedHeight;
    if (!this.pinned) {
      this.element.style.width = `${clampedWidth}px`;
      this.element.style.height = `${clampedHeight}px`;
    }
  }

  _applyPosition(x, y, options = {}) {
    if (this.pinned) {
      this.position.x = x;
      this.position.y = y;
      return;
    }

    const viewportWidth = window.innerWidth || (x + this.size.width);
    const viewportHeight = window.innerHeight || (y + this.size.height);

    const minX = CONFIG.WINDOW.EDGE_MARGIN;
    const minY = CONFIG.WINDOW.EDGE_MARGIN;
    const maxX = Math.max(minX, viewportWidth - this.size.width - CONFIG.WINDOW.EDGE_MARGIN);
    const maxY = Math.max(minY, viewportHeight - this.size.height - CONFIG.WINDOW.EDGE_MARGIN);

    const clampedX = Math.min(Math.max(x, minX), maxX);
    const clampedY = Math.min(Math.max(y, minY), maxY);

    this.position.x = clampedX;
    this.position.y = clampedY;

    this.element.style.left = `${clampedX}px`;
    this.element.style.top = `${clampedY}px`;

    if (!options.silently) {
      this._persistState();
    }
  }

  _restoreFrameFromState() {
    const state = this._loadPersistedState();
    if (state) {
      if (state.position) {
        this.position = { ...state.position };
      }
      if (state.size) {
        this.size = { ...state.size };
      }
      this.pinned = Boolean(state.pinned);
    }

    this._applySize(this.size.width, this.size.height);
    this._applyPosition(this.position.x, this.position.y, { silently: true });

    if (this.pinned) {
      this.element.classList.add(CONFIG.CLASS_NAMES.PINNED);
      this.pinButton?.setAttribute('aria-pressed', 'true');
      this.element.style.left = 'auto';
      this.element.style.right = `${CONFIG.WINDOW.EDGE_MARGIN}px`;
    }

    this._traceJob('JOB_UPDATE_STATE', {
      stage: 'state:restored',
      pinned: this.pinned,
      position: { ...this.position },
      size: { ...this.size },
    });
  }

  _persistState() {
    try {
      const payload = {
        version: CONFIG.STATE.VERSION,
        position: this.position,
        size: this.size,
        pinned: this.pinned,
      };
      window.localStorage?.setItem(CONFIG.STATE.KEY, JSON.stringify(payload));
      this._traceJob('JOB_CACHE_LOCALLY', {
        stage: 'state:persist',
        pinned: this.pinned,
        position: { ...this.position },
        size: { ...this.size },
      });
    } catch (error) {
      this.log.warn('[ArtifactsWindow] Failed to persist state', error);
      this._traceJob('JOB_CACHE_LOCALLY', {
        stage: 'state:persist:error',
        error: error.message,
      });
    }
  }

  _loadPersistedState() {
    try {
      const raw = window.localStorage?.getItem(CONFIG.STATE.KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw);
      if (parsed?.version !== CONFIG.STATE.VERSION) {
        return null;
      }
      return parsed;
    } catch (error) {
      this.log.warn('[ArtifactsWindow] Failed to load state', error);
      return null;
    }
  }

  _initializeJobTracer(providedTracer) {
    const fallbackCandidates = [
      providedTracer,
      this.aether?.jobTracer || null,
      typeof window !== 'undefined' ? window?.jobTracer : null,
    ];

    for (const candidate of fallbackCandidates) {
      if (candidate && typeof candidate.record === 'function') {
        this.jobTracer = candidate;
        this._traceJob('JOB_INITIALIZE', { stage: 'tracer:attached' });
        return;
      }
    }

    this.jobTracer = null;
    this.log.warn('[ArtifactsWindow] Job tracer unavailable: renderer must receive injected tracer');
  }

  _traceJob(jobType, context = {}) {
    if (!this.jobTracer || typeof this.jobTracer.record !== 'function') {
      return;
    }

    try {
      this.jobTracer.record(jobType, {
        ...this._jobTraceDefaults,
        ...context,
      });
    } catch (error) {
      this.log.warn('[ArtifactsWindow] Job tracing failed:', error);
    }
  }

  _injectStyles() {
    this.log.debug('[ArtifactsWindow] Global CSS loaded from artifacts.css using theme variables');
  }
}

// Export
module.exports = ArtifactsWindow;

if (typeof window !== 'undefined') {
  window.ArtifactsWindow = ArtifactsWindow;
}
