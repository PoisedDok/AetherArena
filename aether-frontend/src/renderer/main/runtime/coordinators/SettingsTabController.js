/**
 * @.architecture
 *
 * Incoming: MainApp (thin passthrough calls), DOM elements, SettingsManager --- {function_invoke, dom_types.element, settings_object}
 * Processing: Manage settings modal open/close/animate, tab switching with lazy initializers, save with UI apply --- {4 jobs: JOB_OPEN, JOB_CLOSE, JOB_SWITCH_TAB, JOB_SAVE}
 * Outgoing: DOM class toggles, settings persistence via SettingsManager, lazy module initialization --- {dom_types.classList, http_request, module_init}
 *
 * Extracted from MainApp.js to reduce god-object size.
 * MainApp delegates all settings tab orchestration here.
 */

'use strict';

const { createRendererLogger } = require('../../../shared/utils/logger');
const Toast = require('../../../shared/components/Toast');
const ConfirmDialog = require('../../../shared/components/ConfirmDialog');
const ShutdownOrchestrator = require('../../modules/shutdown/ShutdownOrchestrator');

class SettingsTabController {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.settingsModal - The settings modal DOM element
   * @param {Object} options.settingsManager - SettingsManager instance
   * @param {Object} [options.llmProviderSettings] - LLMProviderSettings instance
   * @param {Object} [options.fileIndexingManager] - FileIndexingManager instance
   * @param {Object} [options.proactiveDaemonManager] - ProactiveDaemonManager instance
   * @param {Object} [options.browserHistoryManager] - BrowserHistoryManager instance
   * @param {Function} options.applyUiSettings - Callback to apply UI settings (effects, visualizer)
   * @param {Function} options.onClose - Callback for close (used by save-then-close)
   */
  constructor(options = {}) {
    this.log = createRendererLogger('SettingsTabController');

    this._settingsModal = options.settingsModal || null;
    this._settingsManager = options.settingsManager || null;
    this._llmProviderSettings = options.llmProviderSettings || null;
    this._fileIndexingManager = options.fileIndexingManager || null;
    this._proactiveDaemonManager = options.proactiveDaemonManager || null;
    this._browserHistoryManager = options.browserHistoryManager || null;
    this._applyUiSettings = options.applyUiSettings || null;
    this.endpoint = options.endpoint || null;

    // Lazy-init flags (each tab initializes its heavy module once)
    this._llmProviderInitialized = false;
    this._proactiveDaemonsInitialized = false;
    this._fileIndexingInitialized = false;
    this._browserHistoryInitialized = false;
    this._userCredentialsInitialized = false;
    this._aboutInitialized = false;

    // Timer for close animation
    this._settingsHideTimer = null;
    this._isDisposed = false;
  }

  /**
   * Open the settings modal and load current settings.
   */
  async open() {
    if (this._isDisposed || !this._settingsModal) return;

    this._settingsModal.classList.remove('hidden');
    // Trigger enter transition on next frame so the browser registers the display change first
    requestAnimationFrame(() => {
      this._settingsModal.classList.add('is-visible');
    });
    this.switchTab('assistant');

    // Load settings from backend. backendReachable tracks whether the
    // backend responded so downstream initialisers (LLMProviderSettings)
    // that use raw fetch() can be skipped — preventing ERR_CONNECTION_REFUSED
    // console spam in dev mode.
    let backendReachable = true;
    if (this._settingsManager) {
      try {
        await this._settingsManager.loadSettings();

        if (this._settingsManager.currentSettings?.ui && this._applyUiSettings) {
          this._applyUiSettings(this._settingsManager.currentSettings.ui);
        }
      } catch (error) {
        if (error.isBackendUnavailableError) {
          // Already logged as WARN by SettingsManager — no double-log.
          backendReachable = false;
        } else {
          this.log.error('[SettingsTabController] Failed to load settings:', error);
        }
      }
    }

    // Initialize LLM Provider Settings on first open.
    // Skip when backend is unreachable: LLMProviderSettings uses raw fetch(),
    // bypassing ApiClient's availability gate — would generate network errors.
    // Flag stays false so initialization is retried when backend becomes available.
    if (backendReachable && this._llmProviderSettings && !this._llmProviderInitialized) {
      this._llmProviderInitialized = true;
      try {
        await this._llmProviderSettings.initialize();
      } catch (error) {
        this.log.error('[SettingsTabController] Failed to initialize LLM provider settings:', error);
      }
    }
  }

  /**
   * Close the settings modal with exit animation.
   */
  close() {
    if (this._isDisposed || !this._settingsModal) return;

    // Animate out first, then hide after transition completes
    this._settingsModal.classList.remove('is-visible');
    // Guard: clear any prior pending hide timer to prevent stale callbacks
    if (this._settingsHideTimer) clearTimeout(this._settingsHideTimer);
    this._settingsHideTimer = setTimeout(() => {
      // Only hide if still not visible (guards against rapid open/close)
      if (this._settingsModal && !this._settingsModal.classList.contains('is-visible')) {
        this._settingsModal.classList.add('hidden');
      }
      this._settingsHideTimer = null;
    }, 250);
  }

  /**
   * Switch active settings tab, lazily initializing heavy modules on first visit.
   * @param {string} tabName - Tab identifier
   */
  switchTab(tabName) {
    if (this._isDisposed) return;

    const allTabs = document.querySelectorAll('.settings-tab');
    allTabs.forEach(tab => tab.classList.remove('active'));

    const allSections = document.querySelectorAll('.settings-section');
    allSections.forEach(section => section.classList.remove('active'));

    const selectedTab = document.querySelector(`.settings-tab[data-tab="${tabName}"]`);
    const selectedSection = document.getElementById(`tab-${tabName}`);

    if (selectedTab) selectedTab.classList.add('active');
    if (selectedSection) selectedSection.classList.add('active');

    // UX FIX: Removed immediate population from settingsManager.currentSettings
    // This ensures that changes made in one tab are preserved when switching to another
    // tab and back, until the user explicitly clicks "Save Changes".
    // Initial population is now handled by open() -> loadSettings().

    if (tabName === 'connections' && this._settingsManager) {
      this._settingsManager.loadServicesStatus().catch(err => {
        this.log.error('[SettingsTabController] Failed to load services status:', err);
      });
    }

    if (tabName === 'documents' && this._fileIndexingManager) {
      // Initialize proactive daemon manager
      if (!this._proactiveDaemonsInitialized && this._proactiveDaemonManager) {
        this._proactiveDaemonsInitialized = true;
        this._proactiveDaemonManager.initialize().catch(err => {
          this.log.error('[SettingsTabController] Failed to initialize proactive daemon manager:', err);
        });
      }

      // Initialize file indexing UI once (tab may be opened repeatedly)
      if (!this._fileIndexingInitialized) {
        this._fileIndexingInitialized = true;
        this._fileIndexingManager.initialize().catch(err => {
          this.log.error('[SettingsTabController] Failed to initialize file indexing manager:', err);
        });
      }

      // Browser history manager: no longer eagerly initialized here.
      // BrowserHistoryManager is now created fresh inside DaemonConfigModal
      // when the user clicks the browser daemon settings button.
    }

    if (tabName === 'apikeys') {
      // Initialize user credentials UI once
      if (!this._userCredentialsInitialized) {
        this._userCredentialsInitialized = true;
        const UserCredentialsSettings = require('../../modules/settings/UserCredentialsSettings');
        const container = document.getElementById('user-credentials-container');
        if (container) {
          UserCredentialsSettings.initialize(container, this.endpoint?.api).catch(err => {
            this.log.error('[SettingsTabController] Failed to initialize user credentials:', err);
          });
        }
      }
    }

    if (tabName === 'about' && !this._aboutInitialized) {
      this._aboutInitialized = true;
      const noticesBtn = document.getElementById('about-open-notices');
      if (noticesBtn) {
        this._aboutNoticesBtnHandler = () => {
          if (window.aether?.about?.openNoticesFile) {
            window.aether.about.openNoticesFile();
          } else {
            this.log.error('[SettingsTabController] aether.about.openNoticesFile not available');
          }
        };
        noticesBtn.addEventListener('click', this._aboutNoticesBtnHandler);
      }

      // Populate diagnostics log paths
      this._initDiagnostics();
    }
  }

  /**
   * Save settings via SettingsManager and apply UI changes.
   */
  async save() {
    if (this._isDisposed || !this._settingsManager) return;

    const oldProfile = this._settingsManager.currentSettings?.interpreter?.profile;

    let saveSucceeded = false;
    try {
      await this._settingsManager.saveSettings();
      saveSucceeded = true;
    } catch (error) {
      this.log.error('[SettingsTabController] Failed to save settings:', error);
      Toast.error('Failed to save settings. Check your connection.');
    }

    // Apply UI settings (effects mode, visualizer hot-swap) regardless of backend
    // save outcome. saveSettings() collects form values into currentSettings.ui
    // synchronously before the network call, so data is available even on failure.
    if (this._settingsManager?.currentSettings?.ui && this._applyUiSettings) {
      this._applyUiSettings(this._settingsManager.currentSettings.ui);
    }

    if (saveSucceeded) {
      const newProfile = this._settingsManager.currentSettings?.interpreter?.profile;

      if (oldProfile && newProfile && oldProfile !== newProfile) {
        const confirmed = await ConfirmDialog.confirm({
          title: 'Restart Required',
          message: 'Changing the active profile requires restarting the application to load the new AI personality and tools. Restart now?',
          confirmText: 'Restart',
          cancelText: 'Later',
          variant: 'warning'
        });

        if (confirmed) {
          const orchestrator = new ShutdownOrchestrator();
          orchestrator.execute('restart');
          return; // prevent modal from closing, let shutdown UI take over
        }
      }

      Toast.success('Settings saved');
      setTimeout(() => this.close(), 600);
    }
    // On failure: keep modal open so user can retry
  }

  /**
   * Populate the Diagnostics card in the About tab with actual log paths.
   * Binds the "Open Logs Folder" button.
   */
  async _initDiagnostics() {
    try {
      const aether = typeof window !== 'undefined' ? window['aether'] : null;
      if (aether?.system?.getLogPaths) {
        const paths = await aether.system.getLogPaths();
        if (paths) {
          const logsDirEl = document.getElementById('about-logs-dir');
          const frontendLogEl = document.getElementById('about-frontend-log');
          const backendLogEl = document.getElementById('about-backend-log');
          const userDataEl = document.getElementById('about-user-data');

          if (logsDirEl) logsDirEl.textContent = paths.logsDirectory || 'N/A';
          if (frontendLogEl) frontendLogEl.textContent = paths.frontendLog || 'N/A';
          if (backendLogEl) backendLogEl.textContent = paths.backendSpawnLog || 'N/A';
          if (userDataEl) userDataEl.textContent = paths.userData || 'N/A';
        }
      } else {
        this.log.warn('[SettingsTabController] aether.system.getLogPaths not available');
        const logsDirEl = document.getElementById('about-logs-dir');
        if (logsDirEl) logsDirEl.textContent = 'Not available in this context';
      }
    } catch (err) {
      this.log.error('[SettingsTabController] Failed to load log paths:', err);
      const logsDirEl = document.getElementById('about-logs-dir');
      if (logsDirEl) logsDirEl.textContent = 'Error loading paths';
    }

    // Bind "Open Logs Folder" button
    const openLogsBtn = document.getElementById('about-open-logs');
    if (openLogsBtn) {
      this._openLogsBtnHandler = async () => {
        try {
          const aether = typeof window !== 'undefined' ? window['aether'] : null;
          if (aether?.system?.openLogDirectory) {
            await aether.system.openLogDirectory();
          } else {
            this.log.error('[SettingsTabController] aether.system.openLogDirectory not available');
          }
        } catch (err) {
          this.log.error('[SettingsTabController] Failed to open logs directory:', err);
        }
      };
      openLogsBtn.addEventListener('click', this._openLogsBtnHandler);
    }
  }

  /**
   * Dispose of all resources.
   */
  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;

    if (this._settingsHideTimer) {
      clearTimeout(this._settingsHideTimer);
      this._settingsHideTimer = null;
    }

    // Clean up About tab listeners
    if (this._aboutNoticesBtnHandler) {
      const noticesBtn = document.getElementById('about-open-notices');
      if (noticesBtn) {
        noticesBtn.removeEventListener('click', this._aboutNoticesBtnHandler);
      }
      this._aboutNoticesBtnHandler = null;
    }

    if (this._openLogsBtnHandler) {
      const openLogsBtn = document.getElementById('about-open-logs');
      if (openLogsBtn) {
        openLogsBtn.removeEventListener('click', this._openLogsBtnHandler);
      }
      this._openLogsBtnHandler = null;
    }

    this._settingsModal = null;
    this._settingsManager = null;
    this._llmProviderSettings = null;
    this._fileIndexingManager = null;
    this._proactiveDaemonManager = null;
    this._browserHistoryManager = null;
    this._applyUiSettings = null;
  }
}

module.exports = SettingsTabController;
