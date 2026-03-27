'use strict';

/**
 * @.architecture
 * Incoming: SettingsManager delegation for summary/auto-summarize settings --- {settings, javascript_object}
 * Processing: Populate from merged summary_service + summary prefs, collect with fallbacks, toggle listener --- {3 jobs: JOB_POPULATE, JOB_COLLECT, JOB_TOGGLE}
 * Outgoing: DOM mutations (input values, panel visibility) --- {dom_mutation, void}
 *
 * @module application/main/modules/settings/binders/SummarySettingsBinder
 */

class SummarySettingsBinder {
  constructor(deps = {}) {
    this._log = deps.log || { info() {}, warn() {}, error() {} };
    this._enableLogging = false;
    this._summaryUiBound = false;
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
    this._summaryUiBound = false;
  }

  set enableLogging(v) { this._enableLogging = v; }

  populate(settings) {
    try {
      const toggleEl = document.getElementById('auto-summarize-enabled');
      const panelEl = document.getElementById('auto-summarize-config');
      if (!toggleEl) return;

      const svc = settings?.summary_service && typeof settings.summary_service === 'object'
        ? settings.summary_service : {};
      const prefs = settings?.summary && typeof settings.summary === 'object'
        ? settings.summary : {};

      const enabled = Boolean(
        svc.auto_summarize !== undefined ? svc.auto_summarize
          : (prefs.auto_summarize !== undefined ? prefs.auto_summarize : false)
      );

      toggleEl.checked = enabled;
      if (panelEl) panelEl.style.display = enabled ? 'block' : 'none';

      // Sync toggle label text with actual state
      const labelEl = document.getElementById('auto-summarize-label');
      if (labelEl) labelEl.textContent = enabled ? 'Enabled' : 'Disabled';

      this._setVal('summary-model', prefs.model || settings?.llm?.summarizer_model || '');
      this._setValFrom('summary-temperature', prefs.temperature, svc.temperature);
      this._setValFrom('summary-max-tokens', prefs.max_tokens, svc.max_tokens);
      this._setValFrom('summary-title-max-length', prefs.title_max_length, svc.title_max_length);
      this._setValFrom('summary-key-points-max', prefs.key_points_max, svc.key_points_max);
      this._setValFrom('summary-default-search-limit', prefs.default_search_limit, svc.default_search_limit);

      const validTypesEl = document.getElementById('summary-valid-types');
      if (validTypesEl) {
        const types = Array.isArray(svc.valid_summary_types) ? svc.valid_summary_types : [];
        validTypesEl.textContent = types.length ? types.join(', ') : '(none)';
      }

      this._setValFrom('summary-system-prompt', prefs.system_prompt_template, svc.system_prompt_template);

      this.attachListenersOnce();
    } catch (error) {
      this._log.error('[SummarySettingsBinder] Failed to populate summary settings:', error);
    }
  }

  attachListenersOnce() {
    const toggleEl = document.getElementById('auto-summarize-enabled');
    const panelEl = document.getElementById('auto-summarize-config');
    if (!toggleEl || this._summaryUiBound) return;
    this._trackListener(toggleEl, 'change', () => {
      if (panelEl) panelEl.style.display = toggleEl.checked ? 'block' : 'none';
      // Update toggle label to reflect actual state
      const labelEl = document.getElementById('auto-summarize-label');
      if (labelEl) labelEl.textContent = toggleEl.checked ? 'Enabled' : 'Disabled';
    });
    this._summaryUiBound = true;
  }

  collect(baselineSvc, baselinePrefs, currentSettings) {
    const toggleEl = document.getElementById('auto-summarize-enabled');
    if (!toggleEl) return null;

    if (!baselineSvc || typeof baselineSvc !== 'object') {
      throw new Error('[SummarySettingsBinder] CONTRACT VIOLATION: summary_service baseline required');
    }

    const prefs = baselinePrefs && typeof baselinePrefs === 'object' ? baselinePrefs : {};

    const modelEl = document.getElementById('summary-model');
    const tempEl = document.getElementById('summary-temperature');
    const maxTokensEl = document.getElementById('summary-max-tokens');
    const titleMaxEl = document.getElementById('summary-title-max-length');
    const kpMaxEl = document.getElementById('summary-key-points-max');
    const defaultSearchEl = document.getElementById('summary-default-search-limit');
    const promptEl = document.getElementById('summary-system-prompt');

    const modelRaw = modelEl?.value;
    const temperatureRaw = tempEl?.value;
    const maxTokensRaw = maxTokensEl?.value;
    const titleMaxRaw = titleMaxEl?.value;
    const kpMaxRaw = kpMaxEl?.value;
    const defaultSearchRaw = defaultSearchEl?.value;
    const promptRaw = promptEl?.value;

    const modelFallback = prefs.model || currentSettings?.llm?.summarizer_model || '';

    return {
      enabled: true,
      auto_summarize: Boolean(toggleEl.checked),
      model: (modelRaw && String(modelRaw).trim().length) ? String(modelRaw).trim() : modelFallback,
      temperature: (temperatureRaw && String(temperatureRaw).trim().length) ? parseFloat(temperatureRaw) : (prefs.temperature ?? baselineSvc.temperature),
      max_tokens: (maxTokensRaw && String(maxTokensRaw).trim().length) ? parseInt(maxTokensRaw, 10) : (prefs.max_tokens ?? baselineSvc.max_tokens),
      title_max_length: (titleMaxRaw && String(titleMaxRaw).trim().length) ? parseInt(titleMaxRaw, 10) : (prefs.title_max_length ?? baselineSvc.title_max_length),
      key_points_max: (kpMaxRaw && String(kpMaxRaw).trim().length) ? parseInt(kpMaxRaw, 10) : (prefs.key_points_max ?? baselineSvc.key_points_max),
      default_search_limit: (defaultSearchRaw && String(defaultSearchRaw).trim().length) ? parseInt(defaultSearchRaw, 10) : (prefs.default_search_limit ?? baselineSvc.default_search_limit),
      system_prompt_template: (promptRaw && String(promptRaw).trim().length) ? String(promptRaw) : (prefs.system_prompt_template ?? baselineSvc.system_prompt_template),
    };
  }

  _setVal(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value !== undefined && value !== null ? String(value) : '';
  }

  _setValFrom(id, pref, svc) {
    const v = (pref !== undefined ? pref : svc);
    this._setVal(id, v);
  }
}

module.exports = SummarySettingsBinder;
