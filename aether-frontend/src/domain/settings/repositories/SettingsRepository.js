'use strict';

/**
 * @.architecture
 * 
 * Incoming: SettingsService.loadSettings/saveSettings() (method calls with Settings models) --- {settings_model, javascript_object}
 * Processing: Try TOML then JSON fallback (endpoint.getTOMLSettings → endpoint.getSettings), transform Settings models to JSON (settings.toJSON()), call endpoint HTTP methods (getSettings/setSettings/getTOMLSettings/setTOMLSettings), transform JSON back to Settings models via Settings.fromJSON(), load profiles/models/capabilities from backend --- {6 jobs: JOB_HTTP_REQUEST, JOB_LOAD_FROM_DB, JOB_PARSE_JSON, JOB_SAVE_TO_DB, JOB_STRINGIFY_JSON, JOB_VALIDATE_SCHEMA}
 * Outgoing: Endpoint.getSettings/setSettings/getTOMLSettings/setTOMLSettings() (HTTP API → Backend Python), return Settings/ProfileSettings/ModelSettings model instances --- {settings_model | profile_model | model_settings, javascript_object}
 * 
 * 
 * @module domain/settings/repositories/SettingsRepository
 */

const { Settings } = require('../models/Settings');
const { ProfileSettings } = require('../models/ProfileSettings');
const { ModelSettings } = require('../models/ModelSettings');
const { ModelCapabilities } = require('../models/ModelCapabilities');

class SettingsRepository {
  /**
   * @param {Object} dependencies - Injected dependencies
   * @param {Object} dependencies.endpoint - Backend endpoint
   */
  constructor(dependencies = {}) {
    this.endpoint = dependencies.endpoint || null;
  }

  /**
   * Load settings from backend
   * @returns {Promise<{settings: Settings, source: string}>}
   */
  async loadSettings() {
    if (!this.endpoint) {
      throw new Error('Endpoint not configured');
    }

    let settings;
    let source = 'json';

    // Try TOML first, fallback to JSON
    try {
      settings = await this.endpoint.getTOMLSettings();
      source = 'toml';
    } catch (tomlError) {
      try {
        settings = await this.endpoint.getSettings();
        source = 'json';
      } catch (jsonError) {
        throw new Error(`Failed to load settings: ${jsonError.message}`);
      }
    }

    return {
      settings: Settings.fromJSON(settings || {}),
      source,
    };
  }

  /**
   * Save settings to backend
   * @param {Settings} settings - Settings to save
   * @returns {Promise<{success: boolean, source: string}>}
   */
  async saveSettings(settings) {
    if (!this.endpoint) {
      throw new Error('Endpoint not configured');
    }

    const data = settings.toJSON();
    let source = 'json';

    // Try TOML first, fallback to JSON
    try {
      await this.endpoint.setTOMLSettings(data);
      source = 'toml';
    } catch (tomlError) {
      try {
        await this.endpoint.setSettings(data);
        source = 'json';
      } catch (jsonError) {
        throw new Error(`Failed to save settings: ${jsonError.message}`);
      }
    }

    return {
      success: true,
      source,
    };
  }

  /**
   * Load profile list from backend
   * @returns {Promise<ProfileSettings>}
   */
  async loadProfiles() {
    if (!this.endpoint) {
      throw new Error('Endpoint not configured');
    }

    try {
      const response = await this.endpoint.getProfiles();
      const profiles = Array.isArray(response?.profiles) ? response.profiles : [];

      return ProfileSettings.create(profiles);
    } catch (error) {
      throw new Error(`Failed to load profiles: ${error.message}`);
    }
  }

  /**
   * Save profile selection to backend
   * @param {string} profileName - Profile name to set
   * @returns {Promise<boolean>}
   */
  async saveProfileSelection(profileName) {
    if (!this.endpoint) {
      throw new Error('Endpoint not configured');
    }

    try {
      const payload = {
        interpreter: {
          profile: profileName,
        },
      };

      await this.endpoint.setSettings(payload);
      return true;
    } catch (error) {
      throw new Error(`Failed to save profile selection: ${error.message}`);
    }
  }

  /**
   * Load model list from backend
   * @param {string} apiBase - API base URL
   * @returns {Promise<ModelSettings>}
   */
  async loadModels(apiBase = '') {
    if (!this.endpoint) {
      throw new Error('Endpoint not configured');
    }

    try {
      // Fetch from multiple sources in parallel
      const [tomlResult, providerResult, directResult] = await Promise.allSettled([
        this.endpoint.getTOMLModels(),
        this.endpoint.getModels(apiBase || null),
        this._fetchDirectModels(apiBase),
      ]);

      // Parse results
      const tomlModels = this._extractModels(tomlResult);
      const providerModels = this._extractModels(providerResult);
      const directModels = this._extractModels(directResult);

      // Merge and deduplicate
      const merged = Array.from(new Set([
        ...tomlModels,
        ...providerModels,
        ...directModels,
      ])).filter(Boolean).map(String);

      return ModelSettings.create(merged);
    } catch (error) {
      throw new Error(`Failed to load models: ${error.message}`);
    }
  }

  /**
   * Fetch models directly from API
   * @private
   * @param {string} apiBase - API base URL
   * @returns {Promise<string[]>}
   */
  async _fetchDirectModels(apiBase) {
    if (!apiBase) return [];

    try {
      const url = `${apiBase.replace(/\/$/, '')}/models`;
      const response = await fetch(url, {
        cache: 'no-cache',
        headers: { 'Accept': 'application/json' },
      });

      if (!response.ok) return [];

      const data = await response.json();

      // Handle different response formats
      if (Array.isArray(data)) {
        return data.map(item =>
          typeof item === 'string' ? item : (item?.id || item?.name)
        ).filter(Boolean);
      }

      if (data?.data && Array.isArray(data.data)) {
        return data.data.map(item => item?.id || item?.name).filter(Boolean);
      }

      return [];
    } catch (error) {
      console.warn('Direct model fetch failed:', error.message);
      return [];
    }
  }

  /**
   * Extract models from Promise result
   * @private
   * @param {Object} result - Promise.allSettled result
   * @returns {string[]}
   */
  _extractModels(result) {
    if (result.status !== 'fulfilled') return [];

    const value = result.value;

    // Handle array responses
    if (Array.isArray(value)) {
      return value.filter(Boolean).map(String);
    }

    // Handle object responses
    if (value && Array.isArray(value.models)) {
      return value.models.filter(Boolean).map(String);
    }

    return [];
  }

  /**
   * Load model capabilities from backend
   * @param {string} modelName - Model name
   * @returns {Promise<ModelCapabilities>}
   */
  async loadModelCapabilities(modelName) {
    if (!this.endpoint) {
      throw new Error('Endpoint not configured');
    }

    try {
      const capabilities = await this.endpoint.getModelCapabilities(modelName);
      return ModelCapabilities.create(modelName, capabilities);
    } catch (error) {
      throw new Error(`Failed to load model capabilities: ${error.message}`);
    }
  }
}

module.exports = { SettingsRepository };

