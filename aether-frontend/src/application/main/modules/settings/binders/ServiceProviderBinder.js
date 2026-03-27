'use strict';

/**
 * @.architecture
 * Incoming: SettingsManager delegation for per-service AI provider settings --- {service_providers, javascript_object}
 * Processing: Populate/collect provider/model/api_base for 6 services, display model info badges, debounced listeners --- {3 jobs: JOB_POPULATE, JOB_COLLECT, JOB_INFO_BADGES}
 * Outgoing: DOM mutations, endpoint.getModelCapabilities() --- {dom_mutation | http_request, void}
 *
 * @module application/main/modules/settings/binders/ServiceProviderBinder
 */

const config = require('../../../../../core/config');

class ServiceProviderBinder {
  constructor(deps = {}) {
    this._log = deps.log || { info() {}, warn() {}, error() {} };
    this._endpoint = deps.endpoint || null;
    this._enableLogging = false;
    this._svcModelInfoListenersBound = false;
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
    this._svcModelInfoListenersBound = false;
    this._endpoint = null;
  }

  set enableLogging(v) { this._enableLogging = v; }
  set endpoint(v) { this._endpoint = v; }

  static get UI_MAP() {
    return {
      'summary': 'summary',
      'query_generation': 'query-gen',
      'research': 'research',
      'vision_ocr': 'vision',
    };
  }

  static get SERVICE_KEY_MAP() {
    return {
      'summary': 'summary',
      'query-gen': 'query_generation',
      'research': 'research',
      'vision': 'vision_ocr',
    };
  }

  /**
   * Populate all service provider dropdowns dynamically from backend.
   * Backend is SSOT — frontend never hardcodes provider lists.
   * @private
   */
  async _populateServiceProviderDropdowns() {
    try {
      if (!this._endpoint) throw new Error('Endpoint not initialized');
      const providers = await this._endpoint.api.get('/v1/llm-providers/discover');
      
      if (!Array.isArray(providers)) return;

      // Populate each service provider dropdown
      for (const uiSuffix of Object.values(ServiceProviderBinder.UI_MAP)) {
        const providerEl = document.getElementById(`svc-${uiSuffix}-provider`);
        if (!providerEl) continue;

        const currentValue = providerEl.value;
        providerEl.innerHTML = '';

        // First option: "Aether Inference (Default)" with empty value
        const defaultOpt = document.createElement('option');
        defaultOpt.value = '';
        defaultOpt.textContent = 'Aether Inference (Default)';
        providerEl.appendChild(defaultOpt);

        for (const p of providers) {
          // Skip aether_inference since it's the default
          if (p.key === 'aether_inference') continue;
          const opt = document.createElement('option');
          opt.value = p.key;
          opt.textContent = p.displayName;
          if (!p.available) {
            opt.disabled = true;
            opt.textContent += ' (unavailable)';
          }
          providerEl.appendChild(opt);
        }

        // Restore previous value
        if (currentValue) providerEl.value = currentValue;
      }

      if (this._enableLogging) {
        this._log.info('[ServiceProviderBinder] Service provider dropdowns populated from backend', { count: providers.length });
      }
    } catch (err) {
      this._log.warn('[ServiceProviderBinder] Failed to fetch providers, keeping placeholders:', err.message);
    }
  }

  async populate(serviceProviders) {
    if (!serviceProviders || typeof serviceProviders !== 'object') return;

    // Dynamically populate provider dropdowns from backend (SSOT)
    await this._populateServiceProviderDropdowns();

    for (const [backendKey, uiSuffix] of Object.entries(ServiceProviderBinder.UI_MAP)) {
      const config = serviceProviders[backendKey];
      if (!config) continue;

      const providerEl = document.getElementById(`svc-${uiSuffix}-provider`);
      const modelEl = document.getElementById(`svc-${uiSuffix}-model`);
      const apiBaseEl = document.getElementById(`svc-${uiSuffix}-api-base`);
      const hintEl = document.getElementById(`svc-${uiSuffix}-hint`);

      if (providerEl) providerEl.value = config.provider || '';
      if (modelEl) modelEl.value = config.model || '';
      if (apiBaseEl) apiBaseEl.value = config.api_base || '';

      if (hintEl) {
        const provider = (config.provider || '').trim();
        hintEl.textContent = (!provider || provider === 'aether_inference')
          ? 'Default (Aether Inference)' : provider;
      }

      if (config.model) this.displayServiceModelInfo(uiSuffix);
    }

    this.attachModelInfoListeners(ServiceProviderBinder.UI_MAP);
  }

  collect() {
    const services = ['summary', 'query-gen', 'research', 'vision'];
    const result = {};
    let anyFound = false;

    for (const svc of services) {
      const providerEl = document.getElementById(`svc-${svc}-provider`);
      if (!providerEl) continue;
      anyFound = true;

      const modelEl = document.getElementById(`svc-${svc}-model`);
      const apiBaseEl = document.getElementById(`svc-${svc}-api-base`);
      const backendKey = ServiceProviderBinder.SERVICE_KEY_MAP[svc];

      result[backendKey] = {
        provider: providerEl.value || '',
        model: modelEl ? (modelEl.value || '') : '',
        api_base: apiBaseEl ? (apiBaseEl.value || '') : '',
        api_key: 'not-needed',
      };
    }

    if (!anyFound) return null;

    if (this._enableLogging) {
      this._log.info('[ServiceProviderBinder] Service provider settings collected', Object.keys(result));
    }

    return result;
  }

  attachModelInfoListeners(uiMap) {
    if (this._svcModelInfoListenersBound) return;
    this._svcModelInfoListenersBound = true;

    for (const uiSuffix of Object.values(uiMap)) {
      const modelEl = document.getElementById(`svc-${uiSuffix}-model`);
      if (!modelEl) continue;

      let debounceTimer = null;
      const handler = () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => this.displayServiceModelInfo(uiSuffix), 400);
      };
      this._trackListener(modelEl, 'input', handler);
      this._trackListener(modelEl, 'change', handler);
    }
  }

  async displayServiceModelInfo(uiSuffix) {
    const modelEl = document.getElementById(`svc-${uiSuffix}-model`);
    const infoEl = document.getElementById(`svc-${uiSuffix}-model-info`);
    if (!infoEl) return;

    const modelName = modelEl ? modelEl.value.trim() : '';
    if (!modelName) {
      infoEl.classList.remove('visible');
      infoEl.innerHTML = '';
      return;
    }

    try {
      const capabilities = await this._endpoint.getModelCapabilities(modelName);
      if (!capabilities) {
        infoEl.classList.remove('visible');
        infoEl.innerHTML = '';
        return;
      }

      const parts = [];
      if (capabilities.context_window) {
        parts.push(`<div class="svc-info-row"><span class="svc-info-label">Context</span><span class="svc-info-value">${capabilities.context_window.toLocaleString()} tokens</span></div>`);
      }
      if (capabilities.supports_vision !== undefined) {
        const cls = capabilities.supports_vision ? 'supported' : 'unsupported';
        const label = capabilities.supports_vision ? 'Vision' : 'No Vision';
        parts.push(`<span class="svc-info-badge ${cls}">${label}</span>`);
      }
      if (capabilities.supports_functions !== undefined) {
        const cls = capabilities.supports_functions ? 'supported' : 'unsupported';
        const label = capabilities.supports_functions ? 'Tool Use' : 'No Tools';
        parts.push(`<span class="svc-info-badge ${cls}">${label}</span>`);
      }

      if (parts.length > 0) {
        infoEl.innerHTML = parts.join(' ');
        infoEl.classList.add('visible');
      } else {
        infoEl.classList.remove('visible');
        infoEl.innerHTML = '';
      }
    } catch (_) {
      infoEl.classList.remove('visible');
      infoEl.innerHTML = '';
    }
  }
}

module.exports = ServiceProviderBinder;
