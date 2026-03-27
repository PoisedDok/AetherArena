/**
 * @.architecture
 *
 * Incoming: DOM element references, callback map from MainApp --- {dom_types.element, function}
 * Processing: Wire click handlers to menu buttons, manage control panel toggle/close, track DOM listeners for cleanup --- {2 jobs: JOB_INITIALIZE, JOB_CLEANUP}
 * Outgoing: Callback invocations (openSettings, openModal, etc.), DOM class toggles --- {function_types.invoke, dom_types.classList}
 *
 * Extracted from MainApp.js to reduce god-object size.
 * MainApp delegates all control panel wiring here.
 */

'use strict';

const Toast = require('../../../shared/components/Toast');
const { createRendererLogger } = require('../../../shared/utils/logger');

class ControlPanelController {
  /**
   * @param {Object} options
   * @param {Object} options.elements - Cached DOM elements from MainApp
   * @param {Object} options.callbacks - Action callbacks from MainApp
   * @param {Object} [options.endpoint] - Endpoint instance (for preference persistence)
   * @param {Object} [options.settingsManager] - SettingsManager instance
   */
  constructor(options = {}) {
    this.log = createRendererLogger('ControlPanelController');
    this.elements = options.elements || {};
    this.callbacks = options.callbacks || {};
    this.endpoint = options.endpoint || null;
    this.settingsManager = options.settingsManager || null;

    this._isDisposed = false;
    this._domListeners = [];
  }

  /**
   * Wire all control panel button handlers.
   * Call after elements are cached and callbacks are provided.
   */
  initialize() {
    if (this._isDisposed) return;
    const el = this.elements;
    const cb = this.callbacks;

    // ── Menu Trigger ──
    if (el.menuTrigger) {
      this._track(el.menuTrigger, 'click', () => this.toggle());
    }

    // ── Chat Library ──
    if (el.chatToggle) {
      this._track(el.chatToggle, 'click', () => {
        if (cb.openChatLibrary) cb.openChatLibrary();
        this.close();
      });
    }

    // ── Settings ──
    if (el.settingsButton) {
      this._track(el.settingsButton, 'click', () => {
        if (cb.openSettings) cb.openSettings();
        this.close();
      });
    }

    if (el.settingsCancel) {
      this._track(el.settingsCancel, 'click', () => {
        if (cb.closeSettings) cb.closeSettings();
      });
    }

    // Settings save is owned by UIManager (application layer). Avoid double-binding.

    // ── Settings Tabs ──
    const settingsTabs = document.querySelectorAll('.settings-tab');
    this.log.debug(`Found ${settingsTabs.length} settings tabs`);
    settingsTabs.forEach(tab => {
      this._track(tab, 'click', () => {
        const targetTab = tab.dataset.tab;
        if (cb.switchSettingsTab) cb.switchSettingsTab(targetTab);
      });
    });

    // ── Handsfree Voice Toggle ──
    if (el.micToggle) {
      this._track(el.micToggle, 'click', async () => {
        if (window.handsfreeCoordinator) {
          const currentState = window.handsfreeCoordinator.getState();
          const isCurrentlyActive = currentState !== 'idle';

          // Toggle coordinator
          window.handsfreeCoordinator.toggle();

          // Show user-facing confirmation toast
          if (!isCurrentlyActive) {
            Toast.info('Hands-free mode enabled — loading voice engine...', 3000);
          } else {
            Toast.info('Hands-free mode disabled', 2000);
          }
        } else {
          this.log.warn('HandsfreeCoordinator not available');
          Toast.error('Voice engine not available. Check backend status.', 4000);
        }
      });
      this.log.debug('Mic toggle button wired');
    }

    // ── Artifacts Library ──
    if (el.artifactsToggle) {
      this._track(el.artifactsToggle, 'click', () => {
        if (cb.openArtifactsLibrary) cb.openArtifactsLibrary();
        this.close();
      });
    }

    // ── MCP Management ──
    if (el.mcpToggle) {
      this._track(el.mcpToggle, 'click', () => {
        if (cb.openMcpManagement) cb.openMcpManagement();
        this.close();
      });
    }

    // ── Memory Browser ──
    if (el.memoryToggle) {
      this._track(el.memoryToggle, 'click', () => {
        if (cb.openMemoryBrowser) cb.openMemoryBrowser();
        this.close();
      });
    }

    // ── Agents ──
    if (el.agentsToggle) {
      this._track(el.agentsToggle, 'click', () => {
        if (cb.openAgents) cb.openAgents();
        this.close();
      });
    }

    // ── Research Dashboard ──
    if (el.researchDashboardToggle) {
      this._track(el.researchDashboardToggle, 'click', () => {
        if (cb.openResearchDashboard) cb.openResearchDashboard();
        this.close();
      });
    }

    // ── Index Browser ──
    if (el.indexBrowserToggle) {
      this._track(el.indexBrowserToggle, 'click', () => {
        if (cb.openIndexBrowser) cb.openIndexBrowser();
        this.close();
      });
    }

    // ── Jobs ──
    if (el.jobsToggle) {
      this._track(el.jobsToggle, 'click', () => {
        if (cb.openJobs) cb.openJobs();
        this.close();
      });
    }

    // ── App Restart / Quit ──
    if (el.appRestart) {
      this._track(el.appRestart, 'click', () => {
        this.close();
        if (cb.initiateShutdown) cb.initiateShutdown('restart');
      });
    }

    if (el.appQuit) {
      this._track(el.appQuit, 'click', () => {
        this.close();
        if (cb.initiateShutdown) cb.initiateShutdown('quit');
      });
    }

    // ── Click-outside-to-close ──
    this._track(document, 'click', (e) => {
      if (el.controlPanel &&
          el.controlPanel.classList.contains('active') &&
          !el.controlPanel.contains(e.target) &&
          el.menuTrigger && !el.menuTrigger.contains(e.target)) {
        this.close();
      }
    });

    this.log.debug('Controls setup complete');
  }

  // ── Panel State ────────────────────────────────────────────

  toggle() {
    if (this._isDisposed) return;
    if (this.elements.controlPanel && this.elements.menuTrigger) {
      this.elements.controlPanel.classList.toggle('active');
      this.elements.menuTrigger.classList.toggle('active');
    }
  }

  close() {
    if (this._isDisposed) return;
    if (this.elements.controlPanel && this.elements.menuTrigger) {
      this.elements.controlPanel.classList.remove('active');
      this.elements.menuTrigger.classList.remove('active');
    }
  }

  // ── Listener Tracking ──────────────────────────────────────

  _track(element, event, handler, options) {
    if (!element) return;
    element.addEventListener(event, handler, options);
    this._domListeners.push({ element, event, handler, options });
  }

  // ── Lifecycle ──────────────────────────────────────────────

  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;
    for (const { element, event, handler, options } of this._domListeners) {
      try {
        if (element) {
          element.removeEventListener(event, handler, options);
        }
      } catch (error) {
        this.log.error('Failed to remove DOM listener:', error);
      }
    }
    this._domListeners = [];
    this.elements = {};
    this.callbacks = {};
    this.endpoint = null;
    this.settingsManager = null;
  }
}

module.exports = ControlPanelController;
