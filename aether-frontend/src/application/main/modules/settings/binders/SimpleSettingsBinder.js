'use strict';

/**
 * @.architecture
 * Incoming: SettingsManager.loadSettings/saveSettings (method calls with settings data) --- {settings_section, javascript_object}
 * Processing: Bind backend settings to DOM inputs (populate) and read DOM inputs back (collect) for database, memory, monitoring, UI, and embedding model panels --- {2 jobs: JOB_POPULATE_DOM, JOB_COLLECT_DOM}
 * Outgoing: DOM mutations (input.value, checkbox.checked, textContent) --- {dom_mutation, void}
 *
 * Extracted from SettingsManager monolith: _populateDatabaseSettings, _populateMemorySettings,
 * _populateMonitoringSettings, _populateUiSettings, _populateEmbeddingModelSettings, _collectUiSettings.
 * Pure DOM binding -- no async, no state beyond one-time wiring guards.
 *
 * @module application/main/modules/settings/binders/SimpleSettingsBinder
 */

const config = require('../../../../../core/config');

class SimpleSettingsBinder {
  /**
   * @param {Object} deps
   * @param {Object} deps.log - Logger instance
   * @param {Function} [deps.setDirty] - Callback to mark settings dirty (used by embedding change handler)
   */
  constructor(deps = {}) {
    this._log = deps.log || { info() {}, warn() {}, error() {} };
    this._setDirty = deps.setDirty || (() => {});
    this._endpoint = deps.endpoint || null;
    this._enableLogging = false;
    this._listeners = [];
  }

  _trackListener(el, event, handler) {
    if (!el) return;
    el.addEventListener(event, handler);
    this._listeners.push({ el, event, handler });
  }

  dispose() {
    for (const { el, event, handler } of this._listeners) {
      el.removeEventListener(event, handler);
    }
    this._listeners = [];
    this._setDirty = null;
    this._endpoint = null;
  }

  set endpoint(v) { this._endpoint = v; }

  /**
   * @param {boolean} v
   */
  set enableLogging(v) { this._enableLogging = v; }

  // =========================================================================
  // Database
  // =========================================================================

  /**
   * Populate database settings into DOM.
   * @param {Object} database
   */
  populateDatabase(database) {
    try {
      if (!database) return;

      const poolSizeEl = document.getElementById('db-pool-size');
      if (poolSizeEl && database.pool_size) {
        poolSizeEl.value = database.pool_size;
      }

      const maxOverflowEl = document.getElementById('db-max-overflow');
      if (maxOverflowEl && database.max_overflow !== undefined) {
        maxOverflowEl.value = database.max_overflow;
      }

      const poolTimeoutEl = document.getElementById('db-pool-timeout');
      if (poolTimeoutEl && database.pool_timeout) {
        poolTimeoutEl.value = database.pool_timeout;
      }

      const echoSqlEl = document.getElementById('db-echo-sql');
      if (echoSqlEl && database.echo_sql !== undefined) {
        echoSqlEl.checked = database.echo_sql;
      }

      if (this._enableLogging) {
        this._log.info('[SimpleSettingsBinder] Database settings populated', { database });
      }
    } catch (error) {
      this._log.error('[SimpleSettingsBinder] Failed to populate database settings:', error);
    }
  }

  // =========================================================================
  // Memory
  // =========================================================================

  /**
   * Populate memory settings into DOM.
   * @param {Object} memory
   */
  populateMemory(memory) {
    try {
      const memoryEnabledEl = document.getElementById('memory-enabled');
      if (memoryEnabledEl && memory) {
        memoryEnabledEl.checked = memory.enabled !== false;
      }

      const memoryTypeEl = document.getElementById('memory-type');
      if (memoryTypeEl && memory && memory.type) {
        memoryTypeEl.value = memory.type;
      }

      if (this._enableLogging) {
        this._log.info('[SimpleSettingsBinder] Memory settings populated', { memory });
      }
    } catch (error) {
      this._log.error('[SimpleSettingsBinder] Failed to populate memory settings:', error);
    }
  }

  // =========================================================================
  // Monitoring
  // =========================================================================

  /**
   * Populate monitoring settings into DOM.
   * @param {Object} monitoring
   */
  populateMonitoring(monitoring) {
    try {
      if (!monitoring) return;

      const logLevelEl = document.getElementById('monitoring-log-level');
      if (logLevelEl && monitoring.log_level) {
        logLevelEl.value = monitoring.log_level;
      }

      const logFormatEl = document.getElementById('monitoring-log-format');
      if (logFormatEl && monitoring.log_format) {
        logFormatEl.value = monitoring.log_format;
      }

      const metricsEnabledEl = document.getElementById('monitoring-metrics-enabled');
      if (metricsEnabledEl && monitoring.metrics_enabled !== undefined) {
        metricsEnabledEl.checked = monitoring.metrics_enabled;
      }

      const tracingEnabledEl = document.getElementById('monitoring-tracing-enabled');
      if (tracingEnabledEl && monitoring.tracing_enabled !== undefined) {
        tracingEnabledEl.checked = monitoring.tracing_enabled;
      }

      const healthCheckIntervalEl = document.getElementById('monitoring-health-check-interval');
      if (healthCheckIntervalEl && monitoring.health_check_interval) {
        healthCheckIntervalEl.value = monitoring.health_check_interval;
      }

      if (this._enableLogging) {
        this._log.info('[SimpleSettingsBinder] Monitoring settings populated', { monitoring });
      }
    } catch (error) {
      this._log.error('[SimpleSettingsBinder] Failed to populate monitoring settings:', error);
    }
  }

  // =========================================================================
  // UI (appearance/performance)
  // =========================================================================

  /**
   * Populate UI settings into DOM.
   * @param {Object} ui
   */
  populateUi(ui) {
    try {
      const effectsToggle = document.getElementById('ui-reduced-effects');
      if (effectsToggle) {
        effectsToggle.checked = ui?.effects_mode === 'reduced';
      }

      const vizModeSelect = document.getElementById('ui-visualizer-mode');
      if (vizModeSelect) {
        vizModeSelect.value = ui?.visualizer_mode || 'cosmos';
      }

      if (this._enableLogging) {
        this._log.info('[SimpleSettingsBinder] UI settings populated', ui);
      }
    } catch (error) {
      this._log.error('[SimpleSettingsBinder] Failed to populate UI settings:', error);
    }
  }

  /**
   * Collect UI settings from DOM.
   * @returns {Object}
   */
  collectUiSettings() {
    const effectsToggle = document.getElementById('ui-reduced-effects');
    const effectsMode = effectsToggle && effectsToggle.checked ? 'reduced' : 'full';
    const settings = { effects_mode: effectsMode };

    const vizModeSelect = document.getElementById('ui-visualizer-mode');
    if (vizModeSelect) {
      settings.visualizer_mode = vizModeSelect.value || 'cosmos';
    }

    if (this._enableLogging) {
      this._log.info('[SimpleSettingsBinder] UI settings collected', settings);
    }

    return settings;
  }

  // =========================================================================
  // Embedding model
  // =========================================================================

  /**
   * Fetch embedding model options from backend /v1/settings/infrastructure.
   * The main /v1/settings response does NOT include embedding_model_options —
   * they are only in the infrastructure endpoint. Binder must fetch directly.
   * @private
   */
  async _fetchEmbeddingModelOptions() {
    try {
      if (!this._endpoint) throw new Error('Endpoint not initialized');
      const infra = await this._endpoint.api.get('/v1/settings/infrastructure');
      return infra?.embedding_service?.embedding_model_options || [];
    } catch (err) {
      this._log.warn('[SimpleSettingsBinder] Failed to fetch embedding model options:', err.message);
      return [];
    }
  }

  /**
   * Populate embedding model settings into DOM.
   * Fetches model options from backend (SSOT) — never hardcoded.
   * @param {Object} embeddingService - embedding_service section from settings
   */
  async populateEmbeddingModel(embeddingService) {
    try {
      const selectEl = document.getElementById('embedding-model-select');
      const hintEl = document.getElementById('embedding-model-hint');
      if (!selectEl) return;

      const currentModel = embeddingService?.model || 'Xenova/bge-small-en-v1.5';

      // Fetch model options from infrastructure endpoint (SSOT)
      const modelOptions = await this._fetchEmbeddingModelOptions();
      if (modelOptions.length > 0) {
        selectEl.innerHTML = '';
        for (const m of modelOptions) {
          const opt = document.createElement('option');
          opt.value = m.value;
          opt.textContent = m.label;
          if (m.description) opt.title = m.description;
          selectEl.appendChild(opt);
        }
      }

      selectEl.value = currentModel;

      if (hintEl) {
        const matchedOpt = modelOptions.find(m => m.value === currentModel);
        const dims = matchedOpt?.dimensions || (currentModel.includes('nomic') ? 768 : 384);
        hintEl.textContent = `Active: ${currentModel} (${dims} dimensions)`;
      }

      // Wire change handler (one-time) — closure captures modelOptions
      if (!selectEl.dataset.wired) {
        const capturedOptions = modelOptions;
        this._trackListener(selectEl, 'change', () => {
          const chosen = selectEl.value;
          const matchedChangeOpt = capturedOptions.find(m => m.value === chosen);
          if (hintEl) {
            if (matchedChangeOpt) {
              hintEl.textContent = `${matchedChangeOpt.label} (${matchedChangeOpt.dimensions || '?'} dims). Existing indexes may need rebuild.`;
            } else {
              const isQuality = chosen.includes('nomic');
              hintEl.textContent = isQuality
                ? 'Higher quality (768 dims). Existing indexes may need rebuild.'
                : 'Fast default (384 dims). Compatible with existing indexes.';
            }
          }
          this._setDirty(true);
        });
        selectEl.dataset.wired = 'true';
      }
    } catch (error) {
      this._log.error('[SimpleSettingsBinder] Failed to populate embedding model settings:', error);
    }
  }
}

module.exports = SimpleSettingsBinder;
