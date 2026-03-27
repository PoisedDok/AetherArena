'use strict';

/**
 * @.architecture
 *
 * Incoming: SettingsService.loadSettings(), SettingsRepository.get() (JSON data) --- {json, object}
 * Processing: Immutable settings model - 5 categories (interpreter/llm/voice/memory/security), deep merge with defaults, get/set by dot-path (e.g. 'llm.model'), clone with deep copy, factory methods (createDefault/mergeWithDefaults/fromJSON), export/import JSON --- {3 jobs: JOB_VALIDATE_SCHEMA, JOB_UPDATE_STATE, JOB_DELEGATE_TO_MODULE}
 * Outgoing: Export frozen settings instance or JSON string --- {settings_types.*, Settings | string}
 *
 *
 * @module domain/settings/models/Settings
 */

/**
 * Settings Model
 * Represents application settings
 * 
 * Central model for all application configuration
 */

class Settings {
  /**
   * @param {Object} data - Settings data
   * @param {Object} data.interpreter - Interpreter settings
   * @param {Object} data.llm - LLM settings
   * @param {Object} data.voice - Voice settings
   * @param {Object} data.memory - Memory settings
   * @param {Object} data.security - Security settings
   */
  constructor(data = {}) {
    // Known categories with typed defaults
    this.interpreter = data.interpreter || Settings.getDefaultInterpreter();
    this.llm = data.llm || Settings.getDefaultLLM();
    this.voice = data.voice || Settings.getDefaultVoice();
    this.memory = data.memory || Settings.getDefaultMemory();
    this.security = data.security || Settings.getDefaultSecurity();
    this.user_profile = data.user_profile || Settings.getDefaultUserProfile();

    // Pass through ALL other keys from data (handsfree, database, ui, monitoring, etc.)
    const knownKeys = Settings._knownKeys;
    for (const key of Object.keys(data)) {
      if (!knownKeys.has(key)) {
        this[key] = data[key];
      }
    }
  }

  /** @private */
  static get _knownKeys() {
    return new Set(['interpreter', 'llm', 'voice', 'memory', 'security', 'user_profile']);
  }

  /**
   * Get default interpreter settings
   * @returns {Object}
   */
  static getDefaultInterpreter() {
    // Import config dynamically to avoid circular dependencies
    const config = require('../../../core/config');
    return {
      auto_run: true,  // Must be true for external server mode (no OI-level confirmation protocol)
      loop: false,
      loop_message: '',
      safe_mode: 'off',
      profile: 'GURU.py',
      system_message: '',
      computer: {
        import_computer_api: true,
        import_skills: true,
        skills: { path: config.paths.skillsDir },
        os_control_enabled: false,
      },
    };
  }

  /**
   * Get default LLM settings
   * @returns {Object}
   */
  static getDefaultLLM() {
    return {
      provider: 'aether_inference',
      model: 'lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit',
      supports_vision: true,
      context_window: 131072,
      max_tokens: 51200,
    };
  }

  /**
   * Get default voice settings
   * @returns {Object}
   */
  static getDefaultVoice() {
    return {
      mic_button_enabled: true,
      stt: {
        provider: 'dsm',
        language: 'auto',
        sample_rate_hz: 16000,
        vad: {
          enabled: true,
          threshold: 0.5,
          min_speech_ms: 200,
          min_silence_ms: 300,
        },
      },
      tts: {
        provider: 'dsm',
        voice: 'en_US/jenny',
        sample_rate_hz: 16000,
        format: 'pcm_s16le',
        buffer_ms: 40,
      },
      wakeword: {
        enabled: false,
        engine: 'raven',
        sensitivity: 0.5,
      },
    };
  }

  /**
   * Get default memory settings
   * @returns {Object}
   */
  static getDefaultMemory() {
    // Import config dynamically to avoid circular dependencies
    const config = require('../../../core/config');
    return {
      enabled: true,
      type: 'supabase',
      path: config.paths.memoryDb,
      embedder: 'local-minilm',
      retrieval: {
        enabled: true,
        top_k: 5,
      },
    };
  }

  /**
   * Get default security settings
   * @returns {Object}
   */
  static getDefaultSecurity() {
    return {
      bind_host: '127.0.0.1',
      bind_port: 8765,
      auth_enabled: false,
      api_key_required: false,
      allow_anonymous: true,
      allow_local_os_tools: true,
      allow_notebook_exec: false,
      allowed_origins: ['http://localhost:*'],
    };
  }

  /**
   * Get default user profile settings
   * @returns {Object}
   */
  static getDefaultUserProfile() {
    return {
      name: '',
      username: '',
    };
  }

  /**
   * Create default settings
   * @returns {Settings}
   */
  static createDefault() {
    return new Settings();
  }

  /**
   * Get setting by path
   * @param {string} path - Dot-separated path (e.g., 'llm.model')
   * @returns {*}
   */
  get(path) {
    const keys = path.split('.');
    let value = this;

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
  set(path, value) {
    const keys = path.split('.');
    const lastKey = keys.pop();
    let target = this;

    for (const key of keys) {
      if (!target[key] || typeof target[key] !== 'object') {
        target[key] = {};
      }
      target = target[key];
    }

    target[lastKey] = value;
  }

  /**
   * Merge with defaults
   * @param {Object} data - Settings data to merge
   * @returns {Settings}
   */
  static mergeWithDefaults(data) {
    const merged = new Settings();
    
    merged.interpreter = deepMerge(Settings.getDefaultInterpreter(), data.interpreter || {});
    merged.llm = deepMerge(Settings.getDefaultLLM(), data.llm || {});
    merged.voice = deepMerge(Settings.getDefaultVoice(), data.voice || {});
    merged.memory = deepMerge(Settings.getDefaultMemory(), data.memory || {});
    merged.security = deepMerge(Settings.getDefaultSecurity(), data.security || {});
    merged.user_profile = deepMerge(Settings.getDefaultUserProfile(), data.user_profile || {});

    // Pass through arbitrary keys (handsfree, database, ui, monitoring, etc.)
    const knownKeys = Settings._knownKeys;
    for (const key of Object.keys(data)) {
      if (!knownKeys.has(key)) {
        merged[key] = deepClone(data[key]);
      }
    }

    return merged;
  }

  /**
   * Clone settings
   * @returns {Settings}
   */
  clone() {
    return Settings.fromJSON(deepClone(this.toJSON()));
  }

  /**
   * Convert to plain object
   * @returns {Object}
   */
  toJSON() {
    const json = {};
    for (const key of Object.keys(this)) {
      json[key] = this[key];
    }
    return json;
  }

  /**
   * Create from plain object
   * @param {Object} json - Plain object
   * @returns {Settings}
   */
  static fromJSON(json) {
    return new Settings(json);
  }

  /**
   * Export as JSON string
   * @returns {string}
   */
  exportJSON() {
    return JSON.stringify(this.toJSON(), null, 2);
  }

  /**
   * Import from JSON string
   * @param {string} jsonString - JSON string
   * @returns {Settings}
   */
  static importJSON(jsonString) {
    const data = JSON.parse(jsonString);
    return Settings.fromJSON(data);
  }
}

/**
 * Deep merge utility
 * @private
 */
function deepMerge(target, source) {
  const result = { ...target };

  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}

/**
 * Deep clone utility
 * @private
 */
function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => deepClone(item));
  }

  const cloned = {};
  for (const key in obj) {
    cloned[key] = deepClone(obj[key]);
  }

  return cloned;
}

module.exports = { Settings };
