'use strict';

/**
 * @.architecture
 * Incoming: SettingsManager delegation for advanced settings (LLM, interpreter) --- {llm+interpreter, javascript_object}
 * Processing: Fetch models + profiles from backend, populate selects, display model capability badges, sync context window slider --- {4 jobs: JOB_FETCH_MODELS, JOB_POPULATE, JOB_CAPABILITIES, JOB_PROFILES}
 * Outgoing: DOM mutations, endpoint.api.get(), endpoint.getModelCapabilities() --- {dom_mutation | http_request, void}
 *
 * @module application/main/modules/settings/binders/AdvancedSettingsBinder
 */

class AdvancedSettingsBinder {
  constructor(deps = {}) {
    this._log = deps.log || { info() {}, warn() {}, error() {} };
    this._endpoint = deps.endpoint || null;
    this._enableLogging = false;
    this._currentModelSupportsVision = false;
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
    this._endpoint = null;
  }

  set enableLogging(v) { this._enableLogging = v; }
  set endpoint(v) { this._endpoint = v; }

  get currentModelSupportsVision() { return this._currentModelSupportsVision; }

  /**
   * Dynamically populate the LLM provider dropdown from backend discovery.
   * Backend is SSOT — frontend never hardcodes provider lists.
   * @private
   */
  async _populateProviderDropdown(selectedProvider) {
    const providerEl = document.getElementById('llm-provider');
    if (!providerEl) return;

    try {
      const response = await this._endpoint.api.get('/v1/llm-providers/discover');
      const providers = Array.isArray(response) ? response : [];

      providerEl.innerHTML = '';
      for (const p of providers) {
        const opt = document.createElement('option');
        opt.value = p.key;
        opt.textContent = p.displayName;
        if (!p.available) {
          opt.disabled = true;
          opt.textContent += ' (unavailable)';
        }
        providerEl.appendChild(opt);
      }

      if (selectedProvider) {
        providerEl.value = selectedProvider;
        // If selected provider isn't in list, fall back to first available
        if (providerEl.value !== selectedProvider) {
          const first = providers.find(p => p.available);
          if (first) providerEl.value = first.key;
        }
      }

      if (this._enableLogging) {
        this._log.info('[AdvancedSettingsBinder] Providers populated from backend', { count: providers.length, selected: providerEl.value });
      }
    } catch (err) {
      this._log.warn('[AdvancedSettingsBinder] Failed to fetch providers, keeping placeholder:', err.message);
    }
  }

  async populate(llm, interpreter) {
    // Provider — dynamically from backend (SSOT)
    await this._populateProviderDropdown(llm?.provider);

    const apiBaseEl = document.getElementById('llm-api-base');
    if (apiBaseEl && llm && llm.api_base) apiBaseEl.value = llm.api_base;

    // Models
    const modelEl = document.getElementById('llm-model');
    if (modelEl) {
      try {
        const modelsResponse = await this._endpoint.api.get('/v1/models');
        const models = modelsResponse?.models || [];
        this._log.info(`[AdvancedSettingsBinder] Fetched ${models.length} models from provider`);
        while (modelEl.options.length > 1) modelEl.remove(1);
        models.forEach(modelName => {
          const option = document.createElement('option');
          option.value = modelName;
          option.textContent = modelName;
          modelEl.appendChild(option);
        });
        if (llm && llm.model) {
          modelEl.value = llm.model;
          await this.displayModelCapabilities(llm.model);
        }
        if (!modelEl.dataset.listenerAdded) {
          this._trackListener(modelEl, 'change', async (e) => {
            if (e.target.value) await this.displayModelCapabilities(e.target.value);
            else this.hideModelDetails();
          });
          modelEl.dataset.listenerAdded = 'true';
        }
      } catch (error) {
        this._log.error('[AdvancedSettingsBinder] Failed to fetch models:', error);
        if (llm && llm.model) {
          const option = document.createElement('option');
          option.value = llm.model;
          option.textContent = llm.model;
          modelEl.appendChild(option);
          modelEl.value = llm.model;
          await this.displayModelCapabilities(llm.model);
        }
      } finally {
        const modelHelp = document.getElementById('llm-model-help');
        if (modelHelp) modelHelp.textContent = 'Select your language model';
      }
    }

    // Profiles
    const profileEl = document.getElementById('oi-profile');
    if (profileEl) {
      try {
        const profilesResponse = await this._endpoint.api.get('/v1/settings/profiles');
        const profiles = profilesResponse?.profiles || [];
        while (profileEl.options.length > 1) profileEl.remove(1);
        profiles.forEach(profile => {
          const option = document.createElement('option');
          option.value = profile;
          option.textContent = profile.replace(/\.(py|yaml|yml)$/, '');
          profileEl.appendChild(option);
        });
        if (interpreter && interpreter.profile) {
          profileEl.value = interpreter.profile;
          if (profileEl.selectedIndex < 0 || profileEl.value !== interpreter.profile) {
            const settingStem = interpreter.profile.replace(/\.(py|yaml|yml)$/i, '').toLowerCase();
            for (const opt of profileEl.options) {
              if (!opt.value) continue;
              const optStem = opt.value.replace(/\.(py|yaml|yml)$/i, '').toLowerCase();
              if (optStem === settingStem) {
                profileEl.value = opt.value;
                break;
              }
            }
          }
        }
      } catch (error) {
        this._log.error('[AdvancedSettingsBinder] Failed to fetch profiles:', error);
        if (interpreter && interpreter.profile) {
          const option = document.createElement('option');
          option.value = interpreter.profile;
          option.textContent = interpreter.profile;
          profileEl.appendChild(option);
          profileEl.value = interpreter.profile;
        }
      } finally {
        const profileHelp = document.getElementById('oi-profile-help');
        if (profileHelp) profileHelp.textContent = 'Choose your AI assistant profile';
      }
    }

    const showThinkingEl = document.getElementById('llm-show-thinking');
    if (showThinkingEl && llm && llm.show_thinking !== undefined) {
      showThinkingEl.checked = llm.show_thinking;
    }

    if (this._enableLogging) {
      this._log.info('[AdvancedSettingsBinder] Advanced settings populated', { llm, interpreter });
    }
  }

  async displayModelCapabilities(modelName) {
    if (!modelName) { this.hideModelDetails(); return; }

    const detailsSection = document.getElementById('model-details-section');
    const detailsContent = document.getElementById('model-details-content');
    if (!detailsSection || !detailsContent) return;

    try {
      detailsSection.style.display = 'block';
      detailsContent.innerHTML = '<div class="capability-loading">Loading capabilities...</div>';

      const capabilities = await this._endpoint.getModelCapabilities(modelName);
      if (!capabilities) { this.hideModelDetails(); return; }

      const badges = [];
      if (capabilities.supports_vision !== undefined) {
        badges.push(capabilities.supports_vision
          ? '<span class="capability-badge supported">Vision</span>'
          : '<span class="capability-badge unsupported">No Vision</span>');
      }
      if (capabilities.supports_functions !== undefined) {
        badges.push(capabilities.supports_functions
          ? '<span class="capability-badge supported">Tool Use</span>'
          : '<span class="capability-badge unsupported">No Tools</span>');
      }
      if (capabilities.supports_streaming) {
        badges.push('<span class="capability-badge supported">Streaming</span>');
      }
      if (capabilities.max_tokens) {
        badges.push(`<span class="capability-badge info">${capabilities.max_tokens.toLocaleString()} max output</span>`);
      }

      detailsContent.innerHTML = badges.length === 0
        ? '<div class="capability-empty">No capability information available</div>'
        : `<div class="capability-badges-wrap">${badges.join('')}</div>`;

      this._currentModelSupportsVision = capabilities.supports_vision || false;

      // Context window slider sync
      const physicalMax = capabilities.context_window_max || capabilities.context_window;
      const userValue = capabilities.context_window || physicalMax;
      if (physicalMax || userValue) {
        const ctxSlider = document.getElementById('llm-context-window-adv-slider');
        const ctxHidden = document.getElementById('llm-context-window-adv');
        const ctxDisplay = document.getElementById('llm-context-window-display');
        if (ctxSlider) {
          if (physicalMax) ctxSlider.max = physicalMax;
          const eff = physicalMax ? Math.min(userValue, physicalMax) : userValue;
          ctxSlider.value = eff;
        }
        const eff = physicalMax ? Math.min(userValue, physicalMax) : userValue;
        if (ctxHidden) ctxHidden.value = eff;
        if (ctxDisplay) ctxDisplay.textContent = eff.toLocaleString() + ' tokens';
      }

      // Auto-sync temperature and max_tokens from inference server defaults
      if (capabilities.default_temperature !== undefined && capabilities.default_temperature !== null) {
        const tempEl = document.getElementById('llm-temperature-adv');
        if (tempEl && parseFloat(tempEl.value) === 0.7) tempEl.value = capabilities.default_temperature;
      }
      if (capabilities.default_max_tokens) {
        const maxTokEl = document.getElementById('llm-max-tokens-adv');
        if (maxTokEl && parseInt(maxTokEl.value, 10) === 4096) maxTokEl.value = capabilities.default_max_tokens;
      }

      // Auto-set vision hidden checkbox + read-only badge
      const visionToggle = document.getElementById('llm-supports-vision');
      if (visionToggle && capabilities.supports_vision !== undefined) {
        visionToggle.checked = capabilities.supports_vision;
      }
      const visionBadge = document.getElementById('llm-vision-status-badge');
      if (visionBadge) {
        const supported = capabilities.supports_vision === true;
        visionBadge.textContent = supported ? 'Supported' : 'Not Supported';
        visionBadge.className = 'vision-status-badge ' + (supported ? 'vision-supported' : 'vision-not-supported');
      }
    } catch (error) {
      this._log.error('[AdvancedSettingsBinder] Failed to fetch model capabilities:', error);
      detailsContent.innerHTML = '<div class="capability-error">Failed to load capabilities</div>';
    }
  }

  hideModelDetails() {
    const detailsSection = document.getElementById('model-details-section');
    if (detailsSection) detailsSection.style.display = 'none';
    this._currentModelSupportsVision = false;
  }
}

module.exports = AdvancedSettingsBinder;
