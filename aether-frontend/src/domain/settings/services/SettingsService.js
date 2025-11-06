'use strict';

/**
 * @.architecture
 * 
 * Incoming: SettingsManager.loadSettings/saveSettings(), UIManager.saveSettings() (method calls for settings operations) --- {settings_data, javascript_object}
 * Processing: Load via SettingsRepository (TOML/JSON fallback), validate via SettingsValidator, merge with defaults (Settings.mergeWithDefaults), persist via repository, emit events (settings:loaded/settings:saved), maintain _currentSettings state, get current settings --- {6 jobs: JOB_EMIT_EVENT, JOB_GET_STATE, JOB_LOAD_FROM_DB, JOB_SAVE_TO_DB, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA}
 * Outgoing: SettingsRepository.loadSettings/saveSettings() (persistence), EventBus.emit() (events), return Settings model instances --- {settings_model, javascript_object}
 * 
 * 
 * @module domain/settings/services/SettingsService
 */

const { Settings } = require('../models/Settings');
const { SettingsValidator } = require('../validators/SettingsValidator');

class SettingsService {
  /**
   * @param {Object} dependencies - Injected dependencies
   * @param {Object} dependencies.repository - Settings repository
   * @param {Object} dependencies.eventBus - Event bus for events
   */
  constructor(dependencies = {}) {
    this.repository = dependencies.repository || null;
    this.eventBus = dependencies.eventBus || null;
    this._currentSettings = Settings.createDefault();
    this._lastSource = 'defaults';
  }

  /**
   * Load settings from backend
   * @returns {Promise<{settings: Settings, source: string}>}
   */
  async loadSettings() {
    if (!this.repository) {
      throw new Error('Repository not configured');
    }

    try {
      const { settings, source } = await this.repository.loadSettings();
      
      // Merge with defaults to ensure all fields exist
      this._currentSettings = Settings.mergeWithDefaults(settings.toJSON());
      this._lastSource = source;

      // Emit event
      if (this.eventBus) {
        this.eventBus.emit('settings:loaded', {
          settings: this._currentSettings.toJSON(),
          source,
          timestamp: Date.now(),
        });
      }

      return { settings: this._currentSettings, source };
    } catch (error) {
      // On error, use defaults
      this._currentSettings = Settings.createDefault();
      this._lastSource = 'defaults';
      throw error;
    }
  }

  /**
   * Save settings to backend
   * @param {Settings|Object} settings - Settings to save
   * @returns {Promise<{success: boolean, source: string}>}
   */
  async saveSettings(settings) {
    if (!this.repository) {
      throw new Error('Repository not configured');
    }

    // Convert to Settings instance if plain object
    const settingsInstance = settings instanceof Settings
      ? settings
      : Settings.fromJSON(settings);

    // Validate
    this.validateSettings(settingsInstance.toJSON());

    try {
      const { success, source } = await this.repository.saveSettings(settingsInstance);

      // Update current settings
      this._currentSettings = settingsInstance.clone();
      this._lastSource = source;

      // Emit events
      if (this.eventBus) {
        this.eventBus.emit('settings:saved', {
          settings: this._currentSettings.toJSON(),
          source,
          timestamp: Date.now(),
        });
      }

      return { success, source };
    } catch (error) {
      throw new Error(`Failed to save settings: ${error.message}`);
    }
  }

  /**
   * Validate settings object
   * @param {Object} settings - Settings to validate
   * @throws {Error} If validation fails
   */
  validateSettings(settings) {
    const validation = SettingsValidator.validateSettings(settings);
    if (!validation.valid) {
      throw new Error(`Invalid settings: ${validation.errors.join(', ')}`);
    }
  }

  /**
   * Get current settings
   * @returns {Settings}
   */
  getSettings() {
    return this._currentSettings.clone();
  }

  /**
   * Get setting by path
   * @param {string} path - Dot-separated path (e.g., 'llm.model')
   * @returns {*}
   */
  getSetting(path) {
    return this._currentSettings.get(path);
  }

  /**
   * Set setting by path
   * @param {string} path - Dot-separated path
   * @param {*} value - Value to set
   */
  setSetting(path, value) {
    this._currentSettings.set(path, value);

    // Emit event
    if (this.eventBus) {
      this.eventBus.emit('settings:updated', {
        path,
        value,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Reset to defaults
   * @returns {Settings}
   */
  resetToDefaults() {
    this._currentSettings = Settings.createDefault();
    this._lastSource = 'defaults';

    // Emit event
    if (this.eventBus) {
      this.eventBus.emit('settings:reset', {
        settings: this._currentSettings.toJSON(),
        timestamp: Date.now(),
      });
    }

    return this._currentSettings.clone();
  }

  /**
   * Get default settings
   * @returns {Settings}
   */
  getDefaults() {
    return Settings.createDefault();
  }

  /**
   * Validate settings (used internally and in tests)
   * Now throws errors for backwards compatibility with tests
   * @param {Settings|Object} settings - Settings to validate
   * @throws {Error} If validation fails
   */
  validateSettings(settings) {
    const data = settings instanceof Settings ? settings.toJSON() : settings;
    const validation = SettingsValidator.validateSettings(data);
    
    if (!validation.valid) {
      throw new Error(`Invalid settings: ${validation.errors.join(', ')}`);
    }
  }

  /**
   * Export settings as JSON string
   * @returns {string}
   */
  exportSettings() {
    return this._currentSettings.exportJSON();
  }

  /**
   * Import settings from JSON string
   * @param {string} jsonString - JSON string
   * @returns {Object} { success: boolean, errors?: string[] }
   */
  importSettings(jsonString) {
    // Validate JSON
    const jsonValidation = SettingsValidator.validateJSON(jsonString);
    if (!jsonValidation.valid) {
      return { success: false, errors: jsonValidation.errors };
    }

    try {
      const settings = Settings.importJSON(jsonString);
      
      // Validate settings
      const validation = this.validateSettings(settings);
      if (!validation.valid) {
        return { success: false, errors: validation.errors };
      }

      // Update current settings
      this._currentSettings = settings.clone();

      // Emit event
      if (this.eventBus) {
        this.eventBus.emit('settings:imported', {
          settings: this._currentSettings.toJSON(),
          timestamp: Date.now(),
        });
      }

      return { success: true };
    } catch (error) {
      return { success: false, errors: [error.message] };
    }
  }

  /**
   * Get last source
   * @returns {string}
   */
  getLastSource() {
    return this._lastSource;
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStatistics() {
    return {
      hasSettings: true,
      settingsSize: JSON.stringify(this._currentSettings.toJSON()).length,
      lastSource: this._lastSource,
    };
  }

  /**
   * Cleanup
   */
  cleanup() {
    this._currentSettings = Settings.createDefault();
    this._lastSource = 'defaults';

    if (this.eventBus) {
      this.eventBus.emit('settings:cleanup', { timestamp: Date.now() });
    }
  }
}

module.exports = { SettingsService };

