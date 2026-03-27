'use strict';

const Toast = require('../../../shared/components/Toast');
const ConfirmDialog = require('../../../shared/components/ConfirmDialog');
const DaemonConfigModal = require('./DaemonConfigModal');

/**
 * @.architecture
 * Incoming: MainApp, SettingsManager, Endpoint --- {daemon configuration, user interactions}
 * Processing: Manage proactive master switch + individual daemon states within Knowledge tab
 *             --- {4 jobs: JOB_SYNC_MASTER, JOB_SYNC_DAEMONS, JOB_HANDLE_TOGGLE, JOB_SHOW_CONFIG}
 * Outgoing: endpoint.getProactiveConfig, endpoint.updateProactiveConfig, endpoint.updateFileIndexingDaemonConfig, DOM updates
 *           --- {HTTP requests, status indicators, toast notifications}
 */

class ProactiveDaemonManager {
  constructor(options = {}) {
    this.endpoint = options.endpoint;
    this.eventBus = options.eventBus;
    this.aether = options.aether || (typeof window !== 'undefined' ? window.aether : null);
    this.logger = this.aether?.logger || console;
    
    this.daemons = [
      'browser', 'email', 'filesystem', 'file_indexing', 'query_generation'
    ];
    
    this.currentConfig = {};
    this._masterEnabled = false;   // Proactive master switch state (SSOT: /v1/proactive/config)
    this._proactiveDaemonStates = {}; // Per-daemon enabled (SSOT: proactive_config.json)
    this._masterToggling = false;  // Guard: prevent rapid double-toggle during API flight
    this._daemonToggling = new Set(); // Per-daemon in-flight guard (mirrors _masterToggling)
    this._isInitialized = false;
    this._isDisposed = false;
    // Deterministic cleanup tracking
    this._cleanups = [];   // Array of () => void (listener removals, etc.)
    this._timers = [];     // Track setTimeout IDs
  }

  async initialize() {
    if (this._isInitialized) return;
    
    this.logger.info('[ProactiveDaemonManager] Initializing');
    
    try {
      // 1. Load proactive master switch state (controls daemons; inference is independent)
      await this._fetchProactiveConfig();
      
      // 2. Load individual daemon config
      await this.refreshConfig();
      
      // 3. Attach listeners (master toggle + individual daemon toggles)
      this._attachEventListeners();
      
      this._isInitialized = true;
    } catch (error) {
      this.logger.error('[ProactiveDaemonManager] Initialization failed:', error);
    }
  }

  async refreshConfig() {
    try {
      this.currentConfig = await this.endpoint.getFileIndexingDaemonConfig();
      this._updateUI();
    } catch (error) {
      this.logger.error('[ProactiveDaemonManager] Failed to fetch daemon config:', error);
    }
  }

  _updateUI() {
    this.daemons.forEach(daemon => {
      // Enabled state comes from proactive_config.json (SSOT for daemon_manager),
      // NOT from config_override.json / user_preferences. The in-memory
      // currentConfig[daemon].enabled is kept in sync via optimistic updates
      // in _handleToggle, but _proactiveDaemonStates is authoritative on load.
      const proactiveEnabled = this._proactiveDaemonStates?.[daemon];
      const configEnabled = this.currentConfig[daemon]?.enabled;
      const isEnabled = proactiveEnabled !== undefined ? proactiveEnabled : !!configEnabled;
      
      const toggle = document.getElementById(`daemon-${daemon.replace('_', '-')}-enabled`) || 
                     document.getElementById(`${daemon.replace('_', '-')}-enabled`);
      
      if (toggle) {
        toggle.checked = isEnabled;
      }
      
      const badge = document.querySelector(`.daemon-status-badge[data-daemon="${daemon}"]`);
      if (badge) {
        badge.textContent = isEnabled ? 'Running' : 'Stopped';
        badge.classList.toggle('running', isEnabled);
      }
    });
  }

  /**
   * Track a DOM listener for deterministic cleanup in dispose().
   * @param {Element} element - DOM element
   * @param {string} event - Event name
   * @param {Function} handler - Event handler
   */
  _trackListener(element, event, handler) {
    element.addEventListener(event, handler);
    this._cleanups.push(() => element.removeEventListener(event, handler));
  }

  // ===========================================================================
  // Proactive Master Switch (PATCH /v1/proactive/config)
  // ===========================================================================

  /**
   * Fetch the proactive config from GET /v1/proactive/config.
   * Sets _masterEnabled, per-daemon enabled states, and updates UI.
   *
   * The proactive config (proactive_config.json) is the SINGLE SOURCE OF TRUTH
   * for enabled/disabled state. The daemon_manager reads ONLY this file.
   * GET /file/daemon/config returns enabled from user_preferences which is a
   * stale mirror — we override it with the proactive config values.
   */
  async _fetchProactiveConfig() {
    try {
      const data = await this.endpoint.getProactiveConfig();
      this._masterEnabled = !!data.enabled;
      
      // Store per-daemon enabled states from proactive_config.json.
      // These override the `enabled` fields from GET /file/daemon/config
      // (which reads from user_preferences — not the daemon_manager's source of truth).
      this._proactiveDaemonStates = {
        browser: !!data.browser_enabled,
        email: !!data.email_enabled,
        filesystem: !!data.file_system_enabled,
        file_indexing: !!data.file_indexing_enabled,
        query_generation: !!data.query_generation_enabled,
      };
      
      this._updateMasterUI();
    } catch (error) {
      this.logger.error('[ProactiveDaemonManager] Failed to fetch proactive config:', error);
      // Default to disabled state — safe fallback
      this._masterEnabled = false;
      this._proactiveDaemonStates = {};
      this._updateMasterUI();
    }
  }

  /**
   * Set status element content: icon + text, XSS-safe via DOM API.
   * @param {HTMLElement} el - Status container
   * @param {string} iconClass - FontAwesome class (e.g. 'fas fa-circle-check')
   * @param {string} text - Status text
   */
  _setStatusContent(el, iconClass, text) {
    el.replaceChildren();
    const icon = document.createElement('i');
    icon.className = iconClass;
    el.appendChild(icon);
    el.append(` ${text}`);
  }

  /**
   * Sync the master toggle checkbox, status banner, and card disabled state
   * with the current _masterEnabled value.
   * @param {'idle'|'loading'} mode - 'loading' shows transition text during API call
   */
  _updateMasterUI(mode = 'idle') {
    const masterCheckbox = document.getElementById('proactive-master-enabled');
    const masterToggle = masterCheckbox?.closest('.proactive-master-toggle');
    const statusEl = document.getElementById('proactive-master-status');
    const card = document.querySelector('.daemon-master-card');

    if (masterCheckbox) {
      masterCheckbox.checked = this._masterEnabled;
    }

    // Toggle loading state on the pill toggle itself
    if (masterToggle) {
      masterToggle.classList.toggle('is-loading', mode === 'loading');
    }

    if (statusEl) {
      statusEl.classList.add('is-visible');

      if (mode === 'loading') {
        // Transition state: pulsing banner while API is in flight
        statusEl.classList.remove('status-on', 'status-off');
        statusEl.classList.add('status-loading');
        this._setStatusContent(
          statusEl,
          'fas fa-spinner fa-spin',
          this._masterEnabled ? 'Starting background tasks\u2026' : 'Stopping background tasks\u2026'
        );
      } else {
        // Settled state
        statusEl.classList.remove('status-loading');
        statusEl.classList.toggle('status-on', this._masterEnabled);
        statusEl.classList.toggle('status-off', !this._masterEnabled);
        if (this._masterEnabled) {
          this._setStatusContent(statusEl, 'fas fa-circle-check', 'Background tasks active');
        } else {
          this._setStatusContent(statusEl, 'fas fa-pause-circle', 'All background tasks paused');
        }
      }
    }

    if (card) {
      card.classList.toggle('master-disabled', !this._masterEnabled);
    }
  }

  /**
   * Handle master toggle change: send PATCH /v1/proactive/config.
   * Destructive action (disable) prompts user via ConfirmDialog.
   * Shows loading state during API call, Toast on result, reverts on failure.
   * Guarded against rapid double-toggle.
   * @param {boolean} enabled
   */
  async _handleMasterToggle(enabled) {
    // Guard: ignore rapid clicks while API is in flight
    if (this._masterToggling) {
      this.logger.info('[ProactiveDaemonManager] Master toggle ignored (in flight)');
      // Browser already flipped the checkbox. Revert to known state.
      this._updateMasterUI('idle');
      return;
    }

    // Disabling stops all background data collection daemons.
    // Inference server keeps running (shared resource for chat + manual queries).
    if (!enabled) {
      const confirmed = await ConfirmDialog.confirm({
        title: 'Pause Background Tasks',
        message: 'Pause all background data collection?\n\nBrowser history, email monitoring, and file indexing will stop. Your AI assistant and local inference will continue working normally.',
        confirmText: 'Pause All',
        cancelText: 'Keep Running',
        variant: 'default',
      });
      if (!confirmed) {
        // User cancelled — revert the checkbox immediately
        const checkbox = document.getElementById('proactive-master-enabled');
        if (checkbox) checkbox.checked = true;
        return;
      }
    }

    this.logger.info(`[ProactiveDaemonManager] Master toggle: ${enabled}`);

    const prevState = this._masterEnabled;
    this._masterEnabled = enabled;
    this._masterToggling = true;
    this._updateMasterUI('loading');

    try {
      await this.endpoint.updateProactiveConfig({ enabled });

      this.logger.info(`[ProactiveDaemonManager] Proactive system ${enabled ? 'enabled' : 'disabled'}`);

      // Settle UI to final state
      this._updateMasterUI('idle');

      // Toast: confirm the action to the user
      if (enabled) {
        Toast.success('Background tasks enabled');
      } else {
        Toast.info('All background tasks stopped');
      }

      // Emit event for other UI components that may care
      if (this.eventBus) {
        this.eventBus.emit('proactive:master-toggled', { enabled });
      }
    } catch (error) {
      this.logger.error('[ProactiveDaemonManager] Failed to toggle master switch:', error);
      // Revert UI on failure
      this._masterEnabled = prevState;
      this._updateMasterUI('idle');
      Toast.error('Failed to update background tasks');
    } finally {
      this._masterToggling = false;
    }
  }

  // ===========================================================================
  // Event Listeners
  // ===========================================================================

  _attachEventListeners() {
    // 0. Master toggle listener
    const masterToggle = document.getElementById('proactive-master-enabled');
    if (masterToggle) {
      const handler = async (e) => {
        await this._handleMasterToggle(e.target.checked);
      };
      this._trackListener(masterToggle, 'change', handler);
    }

    // 1. Individual daemon toggle listeners
    this.daemons.forEach(daemon => {
      const id = `daemon-${daemon.replace('_', '-')}-enabled`;
      const toggle = document.getElementById(id) || document.getElementById(daemon.replace('_', '-') + '-enabled');
      
      if (toggle) {
        const handler = async (e) => {
          await this._handleToggle(daemon, e.target.checked);
        };
        this._trackListener(toggle, 'change', handler);
      }
      
      // 2. Settings button listeners (Open DaemonConfigModal)
      const settingsBtn = document.querySelector(`.daemon-settings-btn[data-daemon="${daemon}"]`);
      if (settingsBtn) {
        const handler = () => {
          const modal = new DaemonConfigModal({
            daemonName: daemon,
            daemonConfig: this.currentConfig[daemon] || {},
            endpoint: this.endpoint,
            onSave: () => this.refreshConfig()
          });
          modal.open();
        };
        this._trackListener(settingsBtn, 'click', handler);
      }
    });
  }

  async _handleToggle(daemon, enabled) {
    // Guard: ignore rapid clicks while this daemon's API call is in flight.
    // Mirrors _masterToggling pattern. Without this, rapid double-click
    // fires two API calls — the second may revert the first.
    if (this._daemonToggling.has(daemon)) {
      this.logger.info(`[ProactiveDaemonManager] Toggle ${daemon} ignored (in flight)`);
      // Browser already flipped the checkbox on click. Revert all toggles
      // to the current known state so the user sees correct feedback.
      this._updateUI();
      return;
    }

    this.logger.info(`[ProactiveDaemonManager] Toggling ${daemon}: ${enabled}`);
    
    // Map daemon name to proactive_config.json field name.
    // The daemon_manager reads enabled state from proactive_config.json
    // (via ProactiveConfigReader), NOT from config_override.json.
    const DAEMON_TO_PROACTIVE_FIELD = {
      browser: 'browser_enabled',
      email: 'email_enabled',
      filesystem: 'file_system_enabled',
      file_indexing: 'file_indexing_enabled',
      query_generation: 'query_generation_enabled',
    };
    
    const proactiveField = DAEMON_TO_PROACTIVE_FIELD[daemon];
    if (!proactiveField) {
      this.logger.error(`[ProactiveDaemonManager] Unknown daemon: ${daemon}`);
      return;
    }
    
    // Save previous state for revert on failure (mirrors _handleMasterToggle pattern).
    // Prefer proactive daemon states (SSOT), fall back to currentConfig for pre-fetch state.
    const prevEnabled = this._proactiveDaemonStates?.[daemon] !== undefined
      ? this._proactiveDaemonStates[daemon]
      : this.currentConfig[daemon]?.enabled;
    
    this._daemonToggling.add(daemon);
    
    try {
      // Optimistic update: set before API call for responsive UI
      if (!this.currentConfig[daemon]) this.currentConfig[daemon] = {};
      this.currentConfig[daemon].enabled = enabled;
      this._proactiveDaemonStates[daemon] = enabled;
      this._updateUI();
      
      // Write to proactive_config.json via PATCH /v1/proactive/config.
      // This is the SINGLE source of truth the daemon_manager reads.
      // Triggers daemon reload via SIGHUP.
      await this.endpoint.updateProactiveConfig({ [proactiveField]: enabled });
      
      // Show success with tracked timer
      const statusEl = document.getElementById('settings-status');
      if (statusEl) {
        statusEl.textContent = `${daemon.replace('_', ' ')} ${enabled ? 'enabled' : 'disabled'}`;
        statusEl.style.color = 'var(--color-success)';
        const timerId = setTimeout(() => { statusEl.textContent = ''; }, 3000);
        this._timers.push(timerId);
      }
    } catch (error) {
      this.logger.error(`[ProactiveDaemonManager] Failed to toggle ${daemon}:`, error);
      // Revert optimistic update on failure
      if (this.currentConfig[daemon]) {
        this.currentConfig[daemon].enabled = prevEnabled;
      }
      this._proactiveDaemonStates[daemon] = prevEnabled;
      this._updateUI();
    } finally {
      this._daemonToggling.delete(daemon);
    }
  }

  /**
   * Dispose all managed resources -- DOM listeners, timers, references.
   * Safe to call multiple times (disposed guard).
   */
  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;

    // Run all tracked cleanup functions (listener removals, etc.)
    for (const cleanup of this._cleanups) {
      try {
        cleanup();
      } catch (e) {
        // Element may have been removed from DOM
      }
    }
    this._cleanups = [];

    // Clear all tracked timers
    for (const timerId of this._timers) {
      clearTimeout(timerId);
    }
    this._timers = [];

    // Release references and reset state
    this.currentConfig = {};
    this._masterEnabled = false;
    this._proactiveDaemonStates = {};
    this._masterToggling = false;
    this._daemonToggling.clear();
    this.endpoint = null;
    this.eventBus = null;
    this._isInitialized = false;

    this.logger.info('[ProactiveDaemonManager] Disposed');
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ProactiveDaemonManager;
}
if (typeof window !== 'undefined') {
  window.ProactiveDaemonManager = ProactiveDaemonManager;
}
