'use strict';

/**
 * @.architecture
 * Incoming: MainOrchestrator.loadSettings(), MainOrchestrator.saveSettings(), Endpoint.getSettings() --- {method_call | http_request, json}
 * Processing: Thin orchestrator delegating settings state to domain/settings/services/SettingsService, UI binding to extracted binders --- {5 jobs: JOB_EMIT_EVENT, JOB_GET_STATE, JOB_HTTP_REQUEST, JOB_UPDATE_STATE, JOB_DELEGATE_TO_BINDER}
 * Outgoing: EventBus.emit('SETTINGS.*'|'UI.*'), Endpoint.setSettings() --- {custom_event | http_request, json}
 *
 * @.security innerHTML audit: SAFE
 * innerHTML usages render static settings UI (panels, selectors, input forms, dropdown options).
 * User-facing settings values are set via input.value, select.value, and textContent -- not interpolated into HTML.
 * Sanitizer.sanitizeHTML() is used for any rich content display paths.
 */

/**
 * @module application/main/modules/settings/SettingsManager
 */

const { EventTypes } = require('../../../../core/events/EventTypes');
const { createRendererLogger } = require('../../../../renderer/shared/utils/logger');
const { SettingsService } = require('../../../../domain/settings/services/SettingsService');
const { SettingsRepository } = require('../../../../domain/settings/repositories/SettingsRepository');
const { Settings } = require('../../../../domain/settings/models/Settings');
const DirtyTracker = require('./DirtyTracker');
const SimpleSettingsBinder = require('./binders/SimpleSettingsBinder');
const HandsfreeSettingsBinder = require('./binders/HandsfreeSettingsBinder');
const LocalSourcesBinder = require('./binders/LocalSourcesBinder');
const VisionSettingsBinder = require('./binders/VisionSettingsBinder');
const SummarySettingsBinder = require('./binders/SummarySettingsBinder');
const AdvancedSettingsBinder = require('./binders/AdvancedSettingsBinder');
const ServiceProviderBinder = require('./binders/ServiceProviderBinder');
const ServiceStatusBinder = require('./binders/ServiceStatusBinder');

class SettingsManager {
  constructor(options = {}) {
    this.log = createRendererLogger('SettingsManager');

    // Dependencies
    this.endpoint = options.endpoint || null;
    this.eventBus = options.eventBus || null;
    this.llmProviderSettings = options.llmProviderSettings || null;

    // Configuration
    this.enableLogging = options.enableLogging !== undefined ? options.enableLogging : false;

    this._isPopulating = false;

    // Validation
    if (!this.endpoint) {
      throw new Error('[SettingsManager] endpoint required');
    }

    if (!this.eventBus) {
      throw new Error('[SettingsManager] eventBus required');
    }

    // Domain service: owns settings state + utility operations
    // Settings flow: Backend → Endpoint → SettingsRepository → SettingsService
    this._settingsService = new SettingsService({
      repository: new SettingsRepository({ endpoint: this.endpoint }),
      eventBus: this.eventBus,
    });

    // Dirty tracking via extracted DirtyTracker
    this._dirtyTracker = new DirtyTracker({
      isPopulating: () => this._isPopulating,
      onTtsEngineChange: (value) => this._updateTtsVoiceVisibility(value),
      onQwen3VoiceChange: (value) => this._autoSetLanguageFromVoice(value),
      onProactiveTtsToggle: (checked) => this._updateProactiveTtsVisibility(checked),
    });
    this._dirtyTracker.attach();

    // Simple settings binder (database, memory, monitoring, UI, embedding)
    this._simpleBinder = new SimpleSettingsBinder({
      log: this.log,
      setDirty: (dirty) => this._setDirty(dirty),
      endpoint: this.endpoint,
    });
    this._simpleBinder.enableLogging = this.enableLogging;

    // Handsfree settings binder (TTS, STT, VAD, wake word, voice preview, etc.)
    this._handsfreeBinder = new HandsfreeSettingsBinder({
      log: this.log,
      endpoint: this.endpoint,
    });
    this._handsfreeBinder.enableLogging = this.enableLogging;

    // Local sources binder
    this._localSourcesBinder = new LocalSourcesBinder({
      log: this.log,
      endpoint: this.endpoint,
    });

    // Vision settings binder
    this._visionBinder = new VisionSettingsBinder({
      log: this.log,
      endpoint: this.endpoint,
    });

    // Summary settings binder
    this._summaryBinder = new SummarySettingsBinder({
      log: this.log,
    });

    // Advanced settings binder (models, profiles, capabilities)
    this._advancedBinder = new AdvancedSettingsBinder({
      log: this.log,
      endpoint: this.endpoint,
    });

    // Service provider binder
    this._serviceProviderBinder = new ServiceProviderBinder({
      log: this.log,
      endpoint: this.endpoint,
    });

    // Service status binder (health cards)
    this._serviceStatusBinder = new ServiceStatusBinder({
      log: this.log,
      endpoint: this.endpoint,
    });
  }

  // ---------------------------------------------------------------------------
  // Settings state: delegated to domain SettingsService
  // ---------------------------------------------------------------------------

  /**
   * Current settings as a plain object.
   * Delegated to SettingsService. Callers get a deep copy (safe to read, mutations do not propagate).
   * Use setSetting(path, value) or the setter to modify state.
   */
  get currentSettings() {
    if (!this._settingsService) return {};
    return this._settingsService.getSettings().toJSON();
  }

  set currentSettings(v) {
    if (!this._settingsService) return;
    this._settingsService._currentSettings = Settings.fromJSON(v || {});
  }

  // ---------------------------------------------------------------------------
  // DirtyTracker proxies (backward compatibility)
  // ---------------------------------------------------------------------------

  get _isDirty() { return this._dirtyTracker ? this._dirtyTracker.isDirty() : false; }
  set _isDirty(v) { /* no-op: dirty state owned by DirtyTracker */ }

  _setDirty(dirty) {
    if (this._dirtyTracker) {
      this._dirtyTracker.setDirty(dirty);
    }
  }

  get _inputHandler() { return this._dirtyTracker ? this._dirtyTracker._inputHandler : null; }
  set _inputHandler(v) { /* no-op: owned by DirtyTracker */ }
  get _changeHandler() { return this._dirtyTracker ? this._dirtyTracker._changeHandler : null; }
  set _changeHandler(v) { /* no-op: owned by DirtyTracker */ }

  // ---------------------------------------------------------------------------
  // Core orchestration: loadSettings / saveSettings
  // ---------------------------------------------------------------------------

  /**
   * Load settings from backend
   * CONTRACT: Backend MUST provide settings via /v1/settings/ endpoint.
   * Fail-fast: throws on backend failure, no defaults fallback.
   * @returns {Promise<Object>} Loaded settings with source
   */
  async loadSettings() {
    const correlationId = this._generateCorrelationId('load');

    if (this.enableLogging) {
      this.log.info(`[SettingsManager] Loading settings (correlation: ${correlationId})...`);
    }

    // CONTRACT: Backend MUST provide settings - no fallbacks
    let settings;
    try {
      settings = await this.endpoint.getSettings({ correlationId });
    } catch (error) {
      // BackendUnavailableError is expected when skipHealthCheck=true — downgrade to warn.
      if (error.isBackendUnavailableError) {
        this.log.warn('Backend unavailable — settings load skipped', { correlationId });
      } else {
        this.log.error('Failed to load settings from backend', { error, correlationId });
      }
      this._emitSettingsLoadError(correlationId, error);
      throw error;
    }

    if (!settings || typeof settings !== 'object') {
      const err = new Error(`[SettingsManager] CONTRACT VIOLATION: Backend returned invalid settings. correlationId=${correlationId}`);
      this._emitSettingsLoadError(correlationId, err);
      throw err;
    }

    this._isPopulating = true;
    try {
      // Store in domain service (merges with defaults for known categories, passes through extras)
      this._settingsService._currentSettings = Settings.mergeWithDefaults(settings);
      const merged = this._settingsService.getSettings().toJSON();

      // Populate all UI sections immediately after load
      this._applyUiSettings(merged.ui);
      this._populateSummarySettings(merged);

      const { llm, interpreter, vision_document, handsfree, database, memory, monitoring, integrations } = merged;

      // Await ALL async UI populations in parallel so selects are filled
      // BEFORE loadSettings() returns. The previous fire-and-forget pattern
      // caused a race: LLMProviderSettings.initialize() ran after
      // loadSettings() returned, clearing and repopulating the model
      // select before AdvancedSettingsBinder could finish setting the value.
      const populationPromises = [];

      if (llm || interpreter) {
        populationPromises.push(
          this._populateAdvancedSettings(llm, interpreter).catch(err => {
            this.log.error('[SettingsManager] Failed to populate advanced settings after load:', err);
          })
        );
      }

      if (vision_document) {
        populationPromises.push(
          this._populateVisionSettings(vision_document).catch(err => {
            this.log.error('[SettingsManager] Failed to populate vision settings after load:', err);
          })
        );
      }

      if (handsfree) {
        populationPromises.push(
          this._populateHandsfreeSettings(handsfree).catch(err => {
            this.log.error('[SettingsManager] Failed to populate handsfree settings after load:', err);
          })
        );
      }

      if (populationPromises.length > 0) {
        await Promise.allSettled(populationPromises);
      }

      if (database) { this._populateDatabaseSettings(database); }
      if (memory) { this._populateMemorySettings(memory); }
      if (monitoring) { this._populateMonitoringSettings(monitoring); }
      if (merged.user_profile) {
        const nameEl = document.getElementById('user-profile-name');
        if (nameEl) nameEl.value = merged.user_profile.name || '';
        const usernameEl = document.getElementById('user-profile-username');
        if (usernameEl) usernameEl.value = merged.user_profile.username || '';
      }

      // Async binder populations (fetch from backend)
      const asyncPopulations = [];

      asyncPopulations.push(
        this._populateEmbeddingModelSettings(merged.embedding_service).catch(err => {
          this.log.error('[SettingsManager] Failed to populate embedding model settings:', err);
        })
      );

      if (merged.service_providers) {
        asyncPopulations.push(
          this._populateServiceProviderSettings(merged.service_providers).catch(err => {
            this.log.error('[SettingsManager] Failed to populate service provider settings:', err);
          })
        );
      }

      if (integrations?.local_sources) {
        asyncPopulations.push(
          this._populateLocalSourcesSettings(integrations.local_sources).catch(err => {
            this.log.error('[SettingsManager] Failed to populate local sources settings:', err);
          })
        );
      }

      if (asyncPopulations.length > 0) {
        await Promise.allSettled(asyncPopulations);
      }

      this.eventBus.emit(EventTypes.SETTINGS.LLM_UPDATED, {
        settings: merged,
        source: 'backend',
        timestamp: Date.now(),
        correlationId
      });

      if (this.enableLogging) {
        this.log.info(`[SettingsManager] Loaded settings from backend (correlation: ${correlationId})`);
      }
    } finally {
      this._isPopulating = false;
    }

    this._setDirty(false);

    return { settings: this.currentSettings, source: 'backend' };
  }

  /**
   * Save settings to backend
   * CONTRACT: Backend MUST accept settings via /v1/settings endpoint.
   * Fail-fast: throws on backend failure, no silent failures.
   * @param {Object} settings - Settings to save
   * @returns {Promise<Object>} Result with success status
   */
  async saveSettings(settings = null) {
    const correlationId = this._generateCorrelationId('save');

    // If no settings provided, use currentSettings
    const settingsToSave = settings || this.currentSettings;

    if (this.enableLogging) {
      this.log.info(`[SettingsManager] Saving settings (correlation: ${correlationId})...`);
    }

    // CONTRACT: Settings must be valid object
    if (!settingsToSave || typeof settingsToSave !== 'object') {
      throw new Error(`[SettingsManager] CONTRACT VIOLATION: Settings must be a non-null object. correlationId=${correlationId}`);
    }

    // Collect LLM settings from UI
    const modelEl = document.getElementById('llm-model');
    if (modelEl && settingsToSave.llm) {
      settingsToSave.llm.model = modelEl.value;
    }

    const providerEl = document.getElementById('llm-provider');
    if (providerEl && settingsToSave.llm) {
      settingsToSave.llm.provider = providerEl.value;
    }

    const apiBaseEl = document.getElementById('llm-api-base');
    if (apiBaseEl && settingsToSave.llm) {
      settingsToSave.llm.api_base = apiBaseEl.value;
    }

    // Save LLM provider configuration to database (via new endpoint)
    if (this.llmProviderSettings) {
      try {
        const saved = await this.llmProviderSettings.saveConfiguration();
        if (!saved && this.enableLogging) {
          this.log.warn('[SettingsManager] LLM provider config save failed (non-fatal)');
        }
      } catch (error) {
        this.log.error('[SettingsManager] Failed to save LLM provider config:', error);
      }
    }

    // Collect Advanced LLM settings
    const tempAdvEl = document.getElementById('llm-temperature-adv');
    if (tempAdvEl && settingsToSave.llm) {
      settingsToSave.llm.temperature = parseFloat(tempAdvEl.value);
    }

    const maxTokensAdvEl = document.getElementById('llm-max-tokens-adv');
    if (maxTokensAdvEl && settingsToSave.llm) {
      settingsToSave.llm.max_tokens = parseInt(maxTokensAdvEl.value, 10);
    }

    const contextWindowAdvEl = document.getElementById('llm-context-window-adv');
    if (contextWindowAdvEl && settingsToSave.llm) {
      settingsToSave.llm.context_window = parseInt(contextWindowAdvEl.value, 10);
    }

    const supportsVisionAdvEl = document.getElementById('llm-supports-vision');
    if (supportsVisionAdvEl && settingsToSave.llm) {
      settingsToSave.llm.supports_vision = supportsVisionAdvEl.checked;
    }

    const showThinkingEl = document.getElementById('llm-show-thinking');
    if (showThinkingEl && settingsToSave.llm) {
      settingsToSave.llm.show_thinking = showThinkingEl.checked;
    }

    // Collect Interpreter settings
    const profileEl = document.getElementById('oi-profile');
    const systemMsgEl = document.getElementById('interpreter-system-message');
    if ((profileEl || systemMsgEl) && settingsToSave.interpreter) {
      if (profileEl) settingsToSave.interpreter.profile = profileEl.value;
      if (systemMsgEl) settingsToSave.interpreter.system_message = systemMsgEl.value;
    }

    // Collect indexing state
    const fileIndexingEl = document.getElementById('file-indexing-enabled');
    if (fileIndexingEl) {
      if (!settingsToSave.integrations) settingsToSave.integrations = {};
      if (!settingsToSave.integrations.file_indexing) settingsToSave.integrations.file_indexing = {};
      settingsToSave.integrations.file_indexing.enabled = fileIndexingEl.checked;
    }

    // Collect vision settings from UI
    const hasVisionUi = Boolean(
      document.getElementById('ocr-engine') ||
      document.getElementById('ocr-languages') ||
      document.getElementById('doc-output-format')
    );
    if (hasVisionUi && settingsToSave.vision_document) {
      const collectedVision = this._collectVisionSettings();
      settingsToSave.vision_document = {
        ...settingsToSave.vision_document,
        ...collectedVision
      };
    }

    // Collect handsfree settings from UI
    const hasHandsfreeUi = Boolean(
      document.getElementById('handsfree-enabled') ||
      document.getElementById('handsfree-stt-model') ||
      document.getElementById('handsfree-tts-enabled')
    );
    if (hasHandsfreeUi) {
      const collectedHandsfree = this._collectHandsfreeSettings();
      settingsToSave.handsfree = {
        ...settingsToSave.handsfree,
        ...collectedHandsfree
      };
    }

    // Collect Database settings
    const dbPoolSizeEl = document.getElementById('db-pool-size');
    if (dbPoolSizeEl && settingsToSave.database) {
      settingsToSave.database.pool_size = parseInt(dbPoolSizeEl.value, 10);
      const dbMaxOverflowEl = document.getElementById('db-max-overflow');
      if (dbMaxOverflowEl) settingsToSave.database.max_overflow = parseInt(dbMaxOverflowEl.value, 10);
      const dbPoolTimeoutEl = document.getElementById('db-pool-timeout');
      if (dbPoolTimeoutEl) settingsToSave.database.pool_timeout = parseInt(dbPoolTimeoutEl.value, 10);
      const dbEchoSqlEl = document.getElementById('db-echo-sql');
      if (dbEchoSqlEl) settingsToSave.database.echo_sql = dbEchoSqlEl.checked;
    }

    // Collect Memory settings
    const memEnabledEl = document.getElementById('memory-enabled');
    if (memEnabledEl && settingsToSave.memory) {
      settingsToSave.memory.enabled = memEnabledEl.checked;
      const memTypeEl = document.getElementById('memory-type');
      if (memTypeEl) settingsToSave.memory.type = memTypeEl.value;
      const memEmbedderEl = document.getElementById('memory-embedder');
      if (memEmbedderEl) settingsToSave.memory.embedder = memEmbedderEl.value;
      const memTopKEl = document.getElementById('memory-top-k');
      if (memTopKEl) settingsToSave.memory.top_k = parseInt(memTopKEl.value, 10);
    }

    // Collect Monitoring settings
    const monLogLevelEl = document.getElementById('monitoring-log-level');
    if (monLogLevelEl && settingsToSave.monitoring) {
      settingsToSave.monitoring.log_level = monLogLevelEl.value;
      const monLogFormatEl = document.getElementById('monitoring-log-format');
      if (monLogFormatEl) settingsToSave.monitoring.log_format = monLogFormatEl.value;
      const monMetricsEl = document.getElementById('monitoring-metrics-enabled');
      if (monMetricsEl) settingsToSave.monitoring.metrics_enabled = monMetricsEl.checked;
      const monTracingEl = document.getElementById('monitoring-tracing-enabled');
      if (monTracingEl) settingsToSave.monitoring.tracing_enabled = monTracingEl.checked;
      const monHealthIntervalEl = document.getElementById('monitoring-health-check-interval');
      if (monHealthIntervalEl) settingsToSave.monitoring.health_check_interval = parseInt(monHealthIntervalEl.value, 10);
    }

    // Collect UI settings from UI
    const hasUiSettings = Boolean(document.getElementById('ui-reduced-effects'));
    if (hasUiSettings) {
      const collectedUi = this._collectUiSettings();
      settingsToSave.ui = {
        ...settingsToSave.ui,
        ...collectedUi
      };
    }

    // Collect User Profile settings
    const nameEl = document.getElementById('user-profile-name');
    const usernameEl = document.getElementById('user-profile-username');
    if (nameEl || usernameEl) {
      settingsToSave.user_profile = settingsToSave.user_profile || {};
      if (nameEl) settingsToSave.user_profile.name = nameEl.value.trim();
      if (usernameEl) settingsToSave.user_profile.username = usernameEl.value.trim();
    }

    // Collect summarizer settings
    const summaryUpdate = this._collectSummarySettingsFromUi();
    if (summaryUpdate) {
      settingsToSave.summary = {
        ...(settingsToSave.summary || {}),
        ...summaryUpdate
      };
      if (this.enableLogging) {
        this.log.info('[SettingsManager] Updated summary settings before save', summaryUpdate);
      }
    }

    // Collect local sources from UI
    const localSources = this._collectLocalSourcesSettingsFromUi();
    if (localSources) {
      settingsToSave.integrations = {
        ...(settingsToSave.integrations || {}),
        local_sources: localSources
      };
      if (this.enableLogging) {
        this.log.info('[SettingsManager] Updated integrations.local_sources before save');
      }
    }

    // Collect embedding model selection
    const embeddingModelEl = document.getElementById('embedding-model-select');
    if (embeddingModelEl) {
      if (!settingsToSave.embedding_service) settingsToSave.embedding_service = {};
      settingsToSave.embedding_service.model = embeddingModelEl.value;
    }

    // Collect per-service AI provider overrides
    const svcProviders = this._collectServiceProviderSettings();
    if (svcProviders) {
      settingsToSave.service_providers = svcProviders;
    }

    // CONTRACT: Backend MUST accept settings - no fallbacks
    try {
      await this.endpoint.setSettings(settingsToSave, { correlationId });
    } catch (error) {
      this.log.error('Failed to save settings to backend', { error, correlationId });
      this._emitSettingsSaveError(correlationId, error);
      throw error;
    }

    // Update domain service state
    this._settingsService._currentSettings = Settings.mergeWithDefaults(settingsToSave);
    const saved = this._settingsService.getSettings().toJSON();
    this._applyUiSettings(saved.ui);

    // Emit events
    const timestamp = Date.now();
    this.eventBus.emit(EventTypes.SETTINGS.LLM_UPDATED, {
      settings: saved,
      source: 'backend',
      timestamp,
      correlationId
    });

    this.eventBus.emit(EventTypes.UI.SETTINGS_SAVED, {
      source: 'backend',
      timestamp,
      correlationId,
      handsfree: saved.handsfree || {},
    });

    if (this.enableLogging) {
      this.log.info(`[SettingsManager] Saved settings to backend (correlation: ${correlationId})`);
    }

    this._setDirty(false);

    return { success: true, source: 'backend' };
  }

  // ---------------------------------------------------------------------------
  // Public API: delegated to SettingsService
  // ---------------------------------------------------------------------------

  /**
   * Get current settings (plain object copy)
   * @returns {Object}
   */
  getSettings() {
    return this.currentSettings;
  }

  /**
   * Get setting by dot-separated path
   * @param {string} path - e.g. 'llm.model'
   * @returns {*}
   */
  getSetting(path) {
    return this._settingsService.getSetting(path);
  }

  /**
   * Set setting by dot-separated path
   * @param {string} path
   * @param {*} value
   */
  setSetting(path, value) {
    this._settingsService.setSetting(path, value);

    if (this.enableLogging) {
      this.log.info(`[SettingsManager] Set ${path} = ${value}`);
    }
  }

  /**
   * Get default settings (plain object)
   * @returns {Object}
   */
  getDefaults() {
    return this._settingsService.getDefaults().toJSON();
  }

  /**
   * Reset to defaults
   */
  resetToDefaults() {
    this._settingsService.resetToDefaults();

    if (this.enableLogging) {
      this.log.info('[SettingsManager] Reset to defaults');
    }
  }

  /**
   * Validate settings (delegates to domain SettingsValidator via SettingsService)
   * @param {Object} settings
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  validateSettings(settings) {
    return this._settingsService.validateSettings(settings, { throwOnError: false });
  }

  /**
   * Export settings as JSON string
   * @returns {string}
   */
  exportSettings() {
    return this._settingsService.exportSettings();
  }

  /**
   * Import settings from JSON string
   * @param {string} jsonString
   * @returns {Object} { success: boolean, errors?: string[] }
   */
  importSettings(jsonString) {
    return this._settingsService.importSettings(jsonString);
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    const stats = this._settingsService.getStatistics();
    return Object.freeze({
      hasSettings: stats.hasSettings,
      settingsSize: stats.settingsSize,
    });
  }

  // ---------------------------------------------------------------------------
  // Endpoint wrappers (getUserPreferences, getUserSettingsMetadata, checkSettingsHealth)
  // ---------------------------------------------------------------------------

  async getUserPreferences() {
    const correlationId = this._generateCorrelationId('user-prefs');

    if (this.enableLogging) {
      this.log.info(`[SettingsManager] Loading user preferences (correlation: ${correlationId})...`);
    }

    const preferences = await this.endpoint.getUserPreferences({ correlationId });

    if (!preferences || typeof preferences !== 'object') {
      throw new Error(`[SettingsManager] Invalid user preferences response. correlationId=${correlationId}`);
    }

    if (this.enableLogging) {
      this.log.info(`[SettingsManager] Loaded user preferences (correlation: ${correlationId})`);
    }

    return preferences;
  }

  async getUserSettingsMetadata() {
    const correlationId = this._generateCorrelationId('metadata');

    if (this.enableLogging) {
      this.log.info(`[SettingsManager] Loading settings metadata (correlation: ${correlationId})...`);
    }

    const metadata = await this.endpoint.getUserSettingsMetadata({ correlationId });

    if (!Array.isArray(metadata)) {
      throw new Error(`[SettingsManager] Invalid metadata response. correlationId=${correlationId}`);
    }

    if (this.enableLogging) {
      this.log.info(`[SettingsManager] Loaded ${metadata.length} settings metadata items (correlation: ${correlationId})`);
    }

    return metadata;
  }

  async checkSettingsHealth() {
    try {
      return await this.endpoint.getSettingsHealth();
    } catch (error) {
      if (this.enableLogging) {
        this.log.error('[SettingsManager] Settings health check failed:', error);
      }
      return { status: 'unhealthy', error: error.message };
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  dispose() {
    if (this._dirtyTracker) {
      this._dirtyTracker.detach();
    }

    // Dispose all binders
    const binders = [
      this._simpleBinder,
      this._handsfreeBinder,
      this._localSourcesBinder,
      this._visionBinder,
      this._summaryBinder,
      this._advancedBinder,
      this._serviceProviderBinder,
      this._serviceStatusBinder,
    ];
    for (const binder of binders) {
      if (binder && typeof binder.dispose === 'function') {
        binder.dispose();
      }
    }

    // Reset service state (no events needed during dispose)
    if (this._settingsService) {
      this._settingsService._currentSettings = Settings.createDefault();
    }

    this.endpoint = null;
    this.eventBus = null;

    if (this.enableLogging) {
      this.log.info('[SettingsManager] Disposed');
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  _emitSettingsLoadError(correlationId, error) {
    if (!this.eventBus || !EventTypes || !EventTypes.UI || !EventTypes.UI.ERROR) {
      return;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    this.eventBus.emit(EventTypes.UI.ERROR, {
      message: 'Failed to load settings from backend',
      correlationId,
      error: errorMessage
    });
  }

  _emitSettingsSaveError(correlationId, error) {
    if (!this.eventBus || !EventTypes || !EventTypes.UI || !EventTypes.UI.ERROR) {
      return;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    this.eventBus.emit(EventTypes.UI.ERROR, {
      message: 'Failed to save settings to backend',
      correlationId,
      error: errorMessage
    });
  }

  _generateCorrelationId(stage = 'load') {
    if (typeof crypto === 'undefined' || !crypto.randomUUID) {
      throw new Error('[SettingsManager] CONTRACT VIOLATION: crypto.randomUUID is required for correlation ID generation. Browser environment must support Web Crypto API.');
    }

    try {
      return `settings-${stage}-${crypto.randomUUID()}`;
    } catch (error) {
      throw new Error(`[SettingsManager] CONTRACT VIOLATION: Failed to generate correlation ID: ${error.message}`);
    }
  }

  /**
   * Apply UI settings to the current document
   * @param {Object} ui - UI settings
   */
  _applyUiSettings(ui) {
    if (typeof document === 'undefined') {
      return;
    }
    const effectsMode = ui?.effects_mode === 'reduced' ? 'reduced' : 'full';
    document.documentElement.setAttribute('data-effects', effectsMode);
  }

  // ---------------------------------------------------------------------------
  // Service status
  // ---------------------------------------------------------------------------

  async loadServicesStatus() {
    return this._serviceStatusBinder.load();
  }

  // ---------------------------------------------------------------------------
  // Binder proxies: Advanced
  // ---------------------------------------------------------------------------

  async _populateAdvancedSettings(llm, interpreter) {
    this._isPopulating = true;
    try {
      await this._advancedBinder.populate(llm, interpreter);
    } finally {
      this._isPopulating = false;
    }
  }

  async _displayModelCapabilities(modelName) {
    return this._advancedBinder.displayModelCapabilities(modelName);
  }

  _hideModelDetails() {
    this._advancedBinder.hideModelDetails();
  }

  // ---------------------------------------------------------------------------
  // Binder proxies: Vision
  // ---------------------------------------------------------------------------

  async _populateVisionSettings(visionDocument) {
    if (!visionDocument) {
      if (this.enableLogging) this.log.warn('[SettingsManager] No vision_document in settings');
      return;
    }
    this._isPopulating = true;
    try {
      await this._visionBinder.populate(visionDocument, this.currentSettings);
    } finally {
      this._isPopulating = false;
    }
  }

  async _checkPrimaryModelVisionSupport() {
    return this._visionBinder.checkPrimaryModelVisionSupport(this.currentSettings);
  }

  _collectVisionSettings() {
    const baseline = this.currentSettings?.vision_document;
    if (!baseline || typeof baseline !== 'object') {
      throw new Error('[SettingsManager] CONTRACT VIOLATION: vision_document settings missing. Load settings from backend before collecting vision settings.');
    }
    return this._visionBinder.collect(baseline);
  }

  // ---------------------------------------------------------------------------
  // Binder proxies: Service Providers
  // ---------------------------------------------------------------------------

  _collectServiceProviderSettings() {
    return this._serviceProviderBinder.collect();
  }

  async _populateServiceProviderSettings(serviceProviders) {
    await this._serviceProviderBinder.populate(serviceProviders);
  }

  _attachServiceModelInfoListeners(uiMap) {
    this._serviceProviderBinder.attachModelInfoListeners(uiMap);
  }

  async _displayServiceModelInfo(uiSuffix) {
    return this._serviceProviderBinder.displayServiceModelInfo(uiSuffix);
  }

  // ---------------------------------------------------------------------------
  // Binder proxies: Local Sources
  // ---------------------------------------------------------------------------

  async _populateLocalSourcesSettings(localSources) {
    await this._localSourcesBinder.populate(localSources);
  }

  _collectLocalSourcesSettingsFromUi() {
    return this._localSourcesBinder.collect();
  }

  _setLocalSourcesText(elementId, text) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.textContent = text ? String(text) : '';
  }

  _lockLocalSourcesControls(reason = 'Disabled by backend configuration') {
    this._localSourcesBinder.lockControls(reason);
  }

  _attachLocalSourcesListenersOnce() {
    this._localSourcesBinder.attachListenersOnce();
  }

  async _refreshLocalSourcesStatus() {
    return this._localSourcesBinder.refreshStatus();
  }

  async _saveLocalSourcesPartial(localSources) {
    return this._localSourcesBinder.savePartial(localSources);
  }


  // ---------------------------------------------------------------------------
  // Binder proxies: Handsfree
  // ---------------------------------------------------------------------------

  async _populateHandsfreeSettings(handsfree) {
    if (!handsfree) {
      if (this.enableLogging) {
        this.log.warn('[SettingsManager] No handsfree settings provided');
      }
      return;
    }

    this._isPopulating = true;
    try {
      await this._handsfreeBinder.populate(handsfree);
    } finally {
      this._isPopulating = false;
    }
  }

  _updateTtsVoiceVisibility(engine) {
    this._handsfreeBinder.updateTtsVoiceVisibility(engine);
  }

  _updateProactiveTtsVisibility(enabled) {
    this._handsfreeBinder.updateProactiveTtsVisibility(enabled);
  }

  _autoSetLanguageFromVoice(voiceName) {
    this._handsfreeBinder.autoSetLanguageFromVoice(voiceName);
  }

  initVoicePreviewButtons() {
    this._handsfreeBinder.initVoicePreviewButtons();
  }

  _wireRangeSliderLiveUpdates() {
    this._handsfreeBinder.wireRangeSliderLiveUpdates();
  }

  async _previewVoice(engine, voice, btn) {
    return this._handsfreeBinder.previewVoice(engine, voice, btn);
  }

  _collectHandsfreeSettings() {
    const baseline = this.currentSettings?.handsfree;
    if (!baseline || typeof baseline !== 'object') {
      throw new Error('[SettingsManager] CONTRACT VIOLATION: handsfree settings missing. Load settings from backend before collecting handsfree settings.');
    }
    return this._handsfreeBinder.collect(baseline);
  }

  // ---------------------------------------------------------------------------
  // Binder proxies: Simple (database, memory, monitoring, UI, embedding)
  // ---------------------------------------------------------------------------

  _populateUiSettings(ui) {
    this._isPopulating = true;
    try {
      this._simpleBinder.populateUi(ui);
    } finally {
      this._isPopulating = false;
    }
  }

  _populateDatabaseSettings(database) {
    this._isPopulating = true;
    try {
      this._simpleBinder.populateDatabase(database);
    } finally {
      this._isPopulating = false;
    }
  }

  _populateMemorySettings(memory) {
    this._isPopulating = true;
    try {
      this._simpleBinder.populateMemory(memory);
    } finally {
      this._isPopulating = false;
    }
  }

  _populateMonitoringSettings(monitoring) {
    this._isPopulating = true;
    try {
      this._simpleBinder.populateMonitoring(monitoring);
    } finally {
      this._isPopulating = false;
    }
  }

  async _populateEmbeddingModelSettings(embeddingService) {
    this._isPopulating = true;
    try {
      await this._simpleBinder.populateEmbeddingModel(embeddingService);
    } finally {
      this._isPopulating = false;
    }
  }

  _collectUiSettings() {
    return this._simpleBinder.collectUiSettings();
  }

  // ---------------------------------------------------------------------------
  // Binder proxies: Summary
  // ---------------------------------------------------------------------------

  _populateSummarySettings(settings) {
    this._isPopulating = true;
    try {
      this._summaryBinder.populate(settings);
    } catch (error) {
      this.log.error('[SettingsManager] Failed to populate summary settings:', error);
    } finally {
      this._isPopulating = false;
    }
  }

  _attachSummaryListenersOnce() {
    this._summaryBinder.attachListenersOnce();
  }

  _collectSummarySettingsFromUi() {
    const current = this.currentSettings;
    const baselineSvc = current?.summary_service;
    if (!baselineSvc || typeof baselineSvc !== 'object') {
      throw new Error('[SettingsManager] CONTRACT VIOLATION: summary_service settings missing. Load settings from backend before collecting summary settings.');
    }
    const baselinePrefs = current?.summary && typeof current.summary === 'object'
      ? current.summary : {};
    return this._summaryBinder.collect(baselineSvc, baselinePrefs, current);
  }
}

// Export
module.exports = SettingsManager;

if (typeof window !== 'undefined') {
  window.SettingsManager = SettingsManager;
}
