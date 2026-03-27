'use strict';

/**
 * @.architecture
 * 
 * Incoming: SettingsService.loadSettings/saveSettings() (method calls with Settings models) --- {settings_model, javascript_object}
 * Processing: Call endpoint HTTP methods (getSettings/setSettings), transform Settings models to JSON (settings.toJSON()), transform JSON back to Settings models via Settings.fromJSON(), load profiles/models/capabilities from backend --- {5 jobs: JOB_HTTP_REQUEST, JOB_PARSE_JSON, JOB_SAVE_TO_DB, JOB_STRINGIFY_JSON, JOB_VALIDATE_SCHEMA}
 * Outgoing: Endpoint.getSettings/setSettings() (HTTP API → Backend Python /v1/settings/), return Settings/ProfileSettings/ModelSettings model instances --- {settings_model | profile_model | model_settings, javascript_object}
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
   * CONTRACT: Backend MUST provide settings via /v1/settings/ endpoint.
   * Fail-fast: throws on backend failure, no fallbacks.
   * @returns {Promise<{settings: Settings, source: string}>}
   */
  async loadSettings() {
    if (!this.endpoint) {
      throw new Error('[SettingsRepository] CONTRACT VIOLATION: Endpoint not configured');
    }

    // CONTRACT: Backend MUST provide settings - no fallbacks
    // Backend endpoint: GET /v1/settings/ (SettingsResponse)
    const settings = await this.endpoint.getSettings();
    
    // CONTRACT: Backend response must be valid object
    if (!settings || typeof settings !== 'object') {
      throw new Error('[SettingsRepository] CONTRACT VIOLATION: Backend returned invalid settings');
    }

    return {
      settings: Settings.fromJSON(settings),
      source: 'backend',
    };
  }

  /**
   * Save settings to backend
   * CONTRACT: Backend MUST accept settings via /v1/settings endpoint.
   * Fail-fast: throws on backend failure, no silent failures.
   * @param {Settings} settings - Settings to save
   * @returns {Promise<{success: boolean, source: string}>}
   */
  async saveSettings(settings) {
    if (!this.endpoint) {
      throw new Error('[SettingsRepository] CONTRACT VIOLATION: Endpoint not configured');
    }

    // CONTRACT: Settings must be valid Settings model instance
    if (!settings || typeof settings.toJSON !== 'function') {
      throw new Error('[SettingsRepository] CONTRACT VIOLATION: Settings must be a valid Settings model instance');
    }

    const data = settings.toJSON();
    
    // CONTRACT: Settings data must be valid object
    if (!data || typeof data !== 'object') {
      throw new Error('[SettingsRepository] CONTRACT VIOLATION: Settings.toJSON() must return a non-null object');
    }

    // CONTRACT: Backend MUST accept settings - no fallbacks
    // Backend endpoint: POST /v1/settings/ (SettingsUpdateRequest -> SettingsResponse)
    await this.endpoint.setSettings(data);

    return {
      success: true,
      source: 'backend',
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
   * CONTRACT: Backend MUST provide models via /v1/models endpoint.
   * Fail-fast: throws on backend failure, no multi-source fallbacks.
   * @param {string} apiBase - API base URL
   * @returns {Promise<ModelSettings>}
   */
  async loadModels(apiBase = '') {
    if (!this.endpoint) {
      throw new Error('[SettingsRepository] CONTRACT VIOLATION: Endpoint not configured');
    }

    // CONTRACT: Backend MUST provide models - no multi-source fallbacks
    // Backend endpoint: GET /v1/models (ModelsListResponse)
    const response = await this.endpoint.getModels(apiBase || null);
    
    // CONTRACT: Backend response must be valid
    if (!response || typeof response !== 'object') {
      throw new Error('[SettingsRepository] CONTRACT VIOLATION: Backend returned invalid models response');
    }

    // Extract models from backend response
    const models = Array.isArray(response.models) 
      ? response.models 
      : (Array.isArray(response) ? response : []);
    
    const modelNames = models
      .filter(Boolean)
      .map(item => typeof item === 'string' ? item : (item?.id || item?.name))
      .filter(Boolean)
      .map(String);

    return ModelSettings.create(modelNames);
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
