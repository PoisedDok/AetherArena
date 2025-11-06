'use strict';

/**
 * @.architecture
 * 
 * Incoming: MainOrchestrator.loadSettings calls, MainOrchestrator.saveSettings calls, MainOrchestrator.getSetting calls --- {lifecycle_types.method_call, settings_types.settings_object}
 * Processing: Load via Endpoint HTTP methods (TOML with JSON fallback), parse/merge with defaults, validate schemas, persist, emit EventBus events (LLM_UPDATED), update state, provide getters, reset to defaults, dispose resources --- {8 jobs: JOB_CLEAR_STATE, JOB_DISPOSE, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_HTTP_REQUEST, JOB_PARSE_JSON, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA}
 * Outgoing: EventBus.emit (SETTINGS.* events), Endpoint.setTOMLSettings request, return settings objects --- {event_types.settings_updated, settings_types.settings_object}
 * 
 * @module application/main/SettingsManager
 * 
 * SettingsManager - Manages application settings and persistence
 * ============================================================================
 * Production-ready settings management service.
 * 
 * Features:
 * - Settings loading from backend (TOML/JSON fallback)
 * - Settings persistence to backend
 * - Default settings with deep merging
 * - Settings validation
 * - Path-based setting access (dot notation)
 * - Import/export functionality
 */

const { EventTypes } = require('../../core/events/EventTypes');

class SettingsManager {
  constructor(options = {}) {
    // Dependencies
    this.endpoint = options.endpoint || null;
    this.eventBus = options.eventBus || null;
    
    // Configuration
    this.enableLogging = options.enableLogging !== undefined ? options.enableLogging : false;
    
    // Default settings - use centralized config
    this.defaults = {
      interpreter: {
        auto_run: false,
        loop: false,
        loop_message: '',
        safe_mode: 'off',
        profile: 'guru_integration.py',
        system_message: '',
        computer: {
          import_computer_api: true,
          import_skills: true,
          skills: { path: config.paths.skillsDir },
          os_control_enabled: false
        }
      },
      llm: {
        provider: 'openai-compatible',
        api_base: config.llm.baseUrl,
        model: 'qwen3-8b-instruct',
        supports_vision: false,
        context_window: 131072,
        max_tokens: 4096
      },
      voice: {
        mic_button_enabled: true,
        stt: { 
          provider: 'dsm', 
          language: 'auto', 
          sample_rate_hz: 16000, 
          vad: { enabled: true, threshold: 0.5, min_speech_ms: 200, min_silence_ms: 300 }
        },
        tts: { 
          provider: 'dsm', 
          voice: 'en_US/jenny', 
          sample_rate_hz: 16000, 
          format: 'pcm_s16le', 
          buffer_ms: 40 
        },
        wakeword: { enabled: false, engine: 'raven', sensitivity: 0.5 }
      },
      memory: { 
        enabled: true, 
        type: 'sqlite', 
        path: config.paths.memoryDb, 
        embedder: 'local-minilm', 
        retrieval: { enabled: true, top_k: 5 } 
      },
      security: { 
        bind_host: '127.0.0.1', 
        auth: { enabled: false, token: '' }, 
        allowed_origins: ['http://localhost:*'] 
      }
    };

    this.currentSettings = { ...this.defaults };
    
    // Validation
    if (!this.endpoint) {
      throw new Error('[SettingsManager] endpoint required');
    }
    
    if (!this.eventBus) {
      throw new Error('[SettingsManager] eventBus required');
    }
  }

  /**
   * Load settings from backend
   * @returns {Promise<Object>} Loaded settings with source
   */
  async loadSettings() {
    if (this.enableLogging) {
      console.log('[SettingsManager] Loading settings...');
    }

    try {
      let settings;
      let source = 'json';

      try {
        settings = await this.endpoint.getTOMLSettings();
        source = 'toml';
      } catch (tomlError) {
        if (this.enableLogging) {
          console.warn('[SettingsManager] TOML load failed, falling back to JSON');
        }
        settings = await this.endpoint.getSettings();
      }

      this.currentSettings = this._mergeWithDefaults(settings || {});

      // Emit event
      this.eventBus.emit(EventTypes.SETTINGS.LLM_UPDATED, {
        settings: this.currentSettings,
        source,
        timestamp: Date.now()
      });

      if (this.enableLogging) {
        console.log(`[SettingsManager] Loaded from ${source.toUpperCase()}`);
      }

      return { settings: this.currentSettings, source };
    } catch (error) {
      console.error('[SettingsManager] Error loading settings:', error);
      this.currentSettings = { ...this.defaults };
      return { settings: this.currentSettings, source: 'defaults' };
    }
  }

  /**
   * Save settings to backend
   * @param {Object} settings - Settings to save
   * @returns {Promise<Object>} Result with success status
   */
  async saveSettings(settings) {
    if (this.enableLogging) {
      console.log('[SettingsManager] Saving settings...');
    }

    try {
      let source = 'json';

      try {
        await this.endpoint.setTOMLSettings(settings);
        source = 'toml';
      } catch (tomlError) {
        if (this.enableLogging) {
          console.warn('[SettingsManager] TOML save failed, falling back to JSON');
        }
        await this.endpoint.setSettings(settings);
      }

      // Update current settings
      this.currentSettings = this._mergeWithDefaults(settings);

      // Emit events
      this.eventBus.emit(EventTypes.SETTINGS.LLM_UPDATED, {
        settings: this.currentSettings,
        source,
        timestamp: Date.now()
      });

      this.eventBus.emit(EventTypes.UI.SETTINGS_SAVED, {
        source,
        timestamp: Date.now()
      });

      if (this.enableLogging) {
        console.log(`[SettingsManager] Saved to ${source.toUpperCase()}`);
      }

      return { success: true, source };
    } catch (error) {
      console.error('[SettingsManager] Error saving settings:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get current settings
   * @returns {Object}
   */
  getSettings() {
    return { ...this.currentSettings };
  }

  /**
   * Get setting by path
   * @param {string} path - Dot-separated path (e.g., 'llm.model')
   * @returns {*}
   */
  getSetting(path) {
    const keys = path.split('.');
    let value = this.currentSettings;

    for (const key of keys) {
      if (value && typeof value === 'object' && key in value) {
        value = value[key];
      } else {
        return undefined;
      }
    }

    return value;
  }

  /**
   * Set setting by path
   * @param {string} path - Dot-separated path
   * @param {*} value - Value to set
   */
  setSetting(path, value) {
    const keys = path.split('.');
    const lastKey = keys.pop();
    let target = this.currentSettings;

    for (const key of keys) {
      if (!target[key] || typeof target[key] !== 'object') {
        target[key] = {};
      }
      target = target[key];
    }

    target[lastKey] = value;

    if (this.enableLogging) {
      console.log(`[SettingsManager] Set ${path} = ${value}`);
    }
  }

  /**
   * Get default settings
   * @returns {Object}
   */
  getDefaults() {
    return { ...this.defaults };
  }

  /**
   * Reset to defaults
   */
  resetToDefaults() {
    this.currentSettings = { ...this.defaults };

    if (this.enableLogging) {
      console.log('[SettingsManager] Reset to defaults');
    }
  }

  /**
   * Validate settings
   * @param {Object} settings - Settings to validate
   * @returns {Object} Validation result
   */
  validateSettings(settings) {
    const errors = [];

    // Validate LLM settings
    if (settings.llm) {
      if (settings.llm.api_base && !this._isValidUrl(settings.llm.api_base)) {
        errors.push('Invalid LLM API base URL');
      }

      if (settings.llm.context_window && settings.llm.context_window < 1000) {
        errors.push('Context window must be at least 1000');
      }

      if (settings.llm.max_tokens && settings.llm.max_tokens < 100) {
        errors.push('Max tokens must be at least 100');
      }
    }

    // Validate voice settings
    if (settings.voice?.stt?.sample_rate_hz) {
      if (settings.voice.stt.sample_rate_hz < 8000 || settings.voice.stt.sample_rate_hz > 48000) {
        errors.push('STT sample rate must be between 8000 and 48000');
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Merge settings with defaults
   * @private
   */
  _mergeWithDefaults(settings) {
    return this._deepMerge(this.defaults, settings);
  }

  /**
   * Deep merge objects
   * @private
   */
  _deepMerge(target, source) {
    const result = { ...target };

    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this._deepMerge(result[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }

    return result;
  }

  /**
   * Validate URL
   * @private
   */
  _isValidUrl(string) {
    try {
      new URL(string);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Export settings as JSON
   * @returns {string}
   */
  exportSettings() {
    return JSON.stringify(this.currentSettings, null, 2);
  }

  /**
   * Import settings from JSON
   * @param {string} jsonString - JSON string
   * @returns {Object} Result
   */
  importSettings(jsonString) {
    try {
      const settings = JSON.parse(jsonString);
      const validation = this.validateSettings(settings);

      if (!validation.valid) {
        return { success: false, errors: validation.errors };
      }

      this.currentSettings = this._mergeWithDefaults(settings);
      return { success: true };
    } catch (error) {
      return { success: false, errors: ['Invalid JSON'] };
    }
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    return Object.freeze({
      hasSettings: Object.keys(this.currentSettings).length > 0,
      settingsSize: JSON.stringify(this.currentSettings).length
    });
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    this.currentSettings = { ...this.defaults };
    this.endpoint = null;
    this.eventBus = null;

    if (this.enableLogging) {
      console.log('[SettingsManager] Disposed');
    }
  }
}

// Export
module.exports = SettingsManager;

if (typeof window !== 'undefined') {
  window.SettingsManager = SettingsManager;
  console.log('📦 SettingsManager loaded');
}

