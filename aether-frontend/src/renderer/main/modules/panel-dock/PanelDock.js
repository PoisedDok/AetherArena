'use strict';

/**
 * @.architecture
 *
 * Incoming: main-preload.js (aether.panels.onVisibilityChange, aether.panels.getVisibility),
 *           MainApp.js (initialize, setWidgetMode, dispose) --- {ipc_events, method_call}
 * Processing: Cache dock DOM elements, track chat/artifacts window visibility via IPC,
 *             show/hide dock icons based on window state, handle hover-reveal animation
 *             (CSS-driven + JS-driven for widget mode), handle icon clicks (debounced)
 *             to toggle windows, adapt layout for widget/normal mode --- {5 jobs:
 *             JOB_ATTACH_TO_WINDOW, JOB_GET_STATE, JOB_UPDATE_STATE, JOB_DISPOSE,
 *             JOB_EMIT_EVENT}
 * Outgoing: aether.window.toggleChat(), aether.artifacts.open() (IPC calls),
 *           DOM class toggles for CSS-driven animations --- {ipc_types.send, dom_mutation}
 *
 *
 * @module renderer/main/modules/panel-dock/PanelDock
 *
 * Panel Dock — Hover-Reveal Minimized Window Indicators
 * ============================================================================
 * Two icon buttons representing minimized chat and artifacts windows.
 *
 * Normal mode: hidden at left edge, CSS hover-reveal on left-edge proximity.
 * Widget mode: hidden behind orb, JS-driven reveal on mouse activity in the
 *              widget window, auto-hides after 1.5s of inactivity. Icons slide
 *              UP from behind the orb to the top of the window.
 *
 * Lifecycle:
 * - Created by MainApp.initialize() after cacheElements + initializeDependencies
 * - Receives aether API reference for IPC access
 * - Disposed by MainApp.cleanup() — all listeners/IPC subscriptions removed
 *
 * Dock icon visibility logic:
 * - Icon shows when its window is NOT visible (minimized indicator)
 * - Entire dock hides when ALL windows are visible (nothing to indicate)
 */

const DEBOUNCE_MS = 200;
const WIDGET_HIDE_DELAY_MS = 900;

class PanelDock {
  constructor() {
    // State
    this._chatVisible = false;
    this._artifactsVisible = false;
    this._isWidgetMode = false;

    // Lifecycle
    this._isInitialized = false;
    this._isDisposed = false;

    // Resource tracking (DEVELOPMENT_PROTOCOL §2)
    this._listeners = [];
    this._ipcCleanups = [];
    this._timers = [];

    // Widget mode hover system
    this._widgetHoverCleanup = null;

    // Debounce timestamps
    this._lastChatClick = 0;
    this._lastArtifactsClick = 0;

    // DOM refs (populated in initialize)
    this._container = null;
    this._chatIcon = null;
    this._artifactsIcon = null;

    // API ref
    this._aether = null;
  }

  /**
   * Initialize the dock: cache DOM, wire IPC listeners, query initial state.
   * @param {Object} aether - The aetherAPI exposed via preload
   */
  async initialize(aether) {
    if (this._isDisposed) return;
    if (this._isInitialized) return;

    this._aether = aether;

    // Cache DOM elements (placed in index.html, outside #root for widget mode visibility)
    this._container = document.getElementById('panel-dock');
    this._chatIcon = document.getElementById('dock-chat');
    this._artifactsIcon = document.getElementById('dock-artifacts');

    if (!this._container || !this._chatIcon || !this._artifactsIcon) {
      console.error('[PanelDock] Required DOM elements not found — dock disabled');
      return;
    }

    // 1. Wire IPC: listen for visibility changes pushed from main process
    if (aether?.panels?.onVisibilityChange) {
      const cleanup = aether.panels.onVisibilityChange((data) => {
        this._onVisibilityChanged(data);
      });
      this._ipcCleanups.push(cleanup);
    }

    // NOTE: Widget mode is NOT subscribed here. MainApp coordinates widget mode
    // transitions and explicitly calls panelDock.setWidgetMode() — consistent
    // with how it forwards to visualizer.setWidgetMode(). Avoids double-fire.

    // 2. Query initial visibility state (one-shot; avoids stale UI on startup)
    if (aether?.panels?.getVisibility) {
      try {
        const state = await aether.panels.getVisibility();
        if (state) {
          this._chatVisible = !!state.chat;
          this._artifactsVisible = !!state.artifacts;
        }
      } catch (err) {
        // Aux windows may not exist yet — default both to hidden (dock icons visible)
        console.warn('[PanelDock] Initial visibility query failed:', err.message);
      }
    }

    // 3. Setup DOM event listeners
    this._setupClickHandlers();
    this._setupHoverHandlers();

    this._isInitialized = true;
    this._updateIconStates();

    // 4. Deferred reconciliation: re-query actual window state after platform
    //    events settle. Fixes macOS race where BrowserWindow transparent auto-show
    //    fires AFTER hide() was called in createAuxWindows, causing a stale
    //    'show' event to override the correct hidden state.
    if (aether?.panels?.getVisibility) {
      const reconcileId = setTimeout(async () => {
        if (this._isDisposed) return;
        try {
          const definitive = await aether.panels.getVisibility();
          if (definitive && !this._isDisposed) {
            this._chatVisible = !!definitive.chat;
            this._artifactsVisible = !!definitive.artifacts;
            this._updateIconStates();
          }
        } catch (_) { /* shutdown or no windows — ignore */ }
      }, 500);
      this._timers.push({ id: reconcileId, type: 'timeout' });
    }
  }

  // ==========================================================================
  // Visibility State
  // ==========================================================================

  /**
   * Handle visibility change event from main process.
   * @param {{ window: 'chat'|'artifacts', visible: boolean }} data
   * @private
   */
  _onVisibilityChanged(data) {
    if (this._isDisposed) return;
    if (!data || typeof data.visible !== 'boolean') return;

    const { window: windowName, visible } = data;

    if (windowName === 'chat') {
      this._chatVisible = visible;
    } else if (windowName === 'artifacts') {
      this._artifactsVisible = visible;
    }

    this._updateIconStates();
  }

  /**
   * Sync DOM classes to reflect current visibility state.
   * @private
   */
  _updateIconStates() {
    if (!this._chatIcon || !this._artifactsIcon || !this._container) return;

    // Icon shows when window is NOT visible (minimized indicator)
    this._chatIcon.classList.toggle('dock-icon--hidden', this._chatVisible);
    this._artifactsIcon.classList.toggle('dock-icon--hidden', this._artifactsVisible);

    // If both windows are visible, hide the entire dock (nothing to indicate)
    const anyMinimized = !this._chatVisible || !this._artifactsVisible;
    this._container.classList.toggle('dock--all-visible', !anyMinimized);
  }

  // ==========================================================================
  // Click Handlers (Debounced)
  // ==========================================================================

  /** @private */
  _setupClickHandlers() {
    const chatClickHandler = (e) => {
      e.stopPropagation();
      if (this._isDisposed) return;
      const now = Date.now();
      if (now - this._lastChatClick < DEBOUNCE_MS) return;
      this._lastChatClick = now;

      if (this._aether?.window?.toggleChat) {
        this._aether.window.toggleChat();
      }
    };

    const artifactsClickHandler = (e) => {
      e.stopPropagation();
      if (this._isDisposed) return;
      const now = Date.now();
      if (now - this._lastArtifactsClick < DEBOUNCE_MS) return;
      this._lastArtifactsClick = now;

      if (this._aether?.artifacts?.open) {
        this._aether.artifacts.open();
      }
    };

    this._trackListener(this._chatIcon, 'click', chatClickHandler);
    this._trackListener(this._artifactsIcon, 'click', artifactsClickHandler);
  }

  // ==========================================================================
  // Hover Handlers (Normal Mode — CSS-driven via dock hover zone)
  // ==========================================================================

  /** @private */
  _setupHoverHandlers() {
    // Normal mode: mouseenter/mouseleave on the dock container itself.
    // The dock has an extended invisible hitbox (CSS padding-left) that
    // reaches the left window edge, making it discoverable.
    const enterHandler = () => {
      if (this._isDisposed || this._isWidgetMode) return;
      this._container.classList.add('dock--hovered');
    };

    const leaveHandler = () => {
      if (this._isDisposed || this._isWidgetMode) return;
      this._container.classList.remove('dock--hovered');
    };

    this._trackListener(this._container, 'mouseenter', enterHandler);
    this._trackListener(this._container, 'mouseleave', leaveHandler);
  }

  // ==========================================================================
  // Widget Mode — Mouse-Activity-Driven Reveal
  // ==========================================================================

  /**
   * Adapt dock layout for widget vs normal mode.
   * Called by MainApp when widget mode transitions via IPC.
   * @param {boolean} isWidget
   */
  setWidgetMode(isWidget) {
    if (this._isDisposed) return;
    const wasWidget = this._isWidgetMode;
    this._isWidgetMode = !!isWidget;

    // Force-reset all hover states on mode transition
    if (this._container) {
      this._container.classList.remove('dock--hovered');
      this._container.classList.remove('dock--widget-active');
    }

    // Attach/detach widget hover system
    if (isWidget && !wasWidget) {
      this._attachWidgetHover();
    } else if (!isWidget && wasWidget) {
      this._detachWidgetHover();
    }
  }

  /**
   * Widget mode hover: show dock on ANY mouse activity in the widget window.
   * Auto-hides after WIDGET_HIDE_DELAY_MS of inactivity.
   *
   * Why mousemove on document instead of the interaction layer:
   * The dock has pointer-events:none in widget mode (so it doesn't block
   * orb drag), but its icon buttons get pointer-events:auto when active.
   * Using document.mousemove captures ALL mouse activity regardless of
   * which element is under the cursor.
   * @private
   */
  _attachWidgetHover() {
    if (this._widgetHoverCleanup) return; // Already attached

    let hideTimerId = null;

    const showDock = () => {
      if (this._isDisposed || !this._isWidgetMode || !this._container) return;

      // Clear any pending hide
      if (hideTimerId !== null) {
        clearTimeout(hideTimerId);
        hideTimerId = null;
      }

      this._container.classList.add('dock--widget-active');

      // Schedule auto-hide after inactivity
      hideTimerId = setTimeout(() => {
        hideTimerId = null;
        if (!this._isDisposed && this._container) {
          this._container.classList.remove('dock--widget-active');
        }
      }, WIDGET_HIDE_DELAY_MS);
    };

    document.addEventListener('mousemove', showDock, { passive: true });

    // Store cleanup function (called on mode exit or dispose)
    this._widgetHoverCleanup = () => {
      document.removeEventListener('mousemove', showDock);
      if (hideTimerId !== null) {
        clearTimeout(hideTimerId);
        hideTimerId = null;
      }
      if (this._container) {
        this._container.classList.remove('dock--widget-active');
      }
    };
  }

  /**
   * Remove widget hover listeners and hide the dock.
   * @private
   */
  _detachWidgetHover() {
    if (this._widgetHoverCleanup) {
      this._widgetHoverCleanup();
      this._widgetHoverCleanup = null;
    }
  }

  // ==========================================================================
  // Resource Tracking (DEVELOPMENT_PROTOCOL §2)
  // ==========================================================================

  /** @private */
  _trackListener(element, event, handler, options) {
    element.addEventListener(event, handler, options);
    this._listeners.push({ element, event, handler, options });
  }

  // ==========================================================================
  // Disposal
  // ==========================================================================

  /**
   * Full lifecycle cleanup. Idempotent — safe to call multiple times.
   * Called by MainApp.cleanup().
   */
  dispose() {
    if (this._isDisposed) return;

    // 1. Detach widget hover system (clears timer, removes document listener)
    this._detachWidgetHover();

    // 2. Remove IPC subscriptions
    for (const cleanup of this._ipcCleanups) {
      try { cleanup?.(); } catch (e) { /* ignore during shutdown */ }
    }
    this._ipcCleanups = [];

    // 3. Remove DOM listeners
    for (const { element, event, handler, options } of this._listeners) {
      try { element?.removeEventListener(event, handler, options); } catch (e) { /* ignore */ }
    }
    this._listeners = [];

    // 4. Clear tracked timers
    for (const { id, type } of this._timers) {
      type === 'interval' ? clearInterval(id) : clearTimeout(id);
    }
    this._timers = [];

    // 5. Null out references
    this._container = null;
    this._chatIcon = null;
    this._artifactsIcon = null;
    this._aether = null;

    // 6. Reset lifecycle flags
    this._isInitialized = false;
    this._isDisposed = true;
  }
}

module.exports = PanelDock;
