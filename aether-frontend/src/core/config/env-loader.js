'use strict';

/**
 * @.architecture
 * 
 * Incoming: process.env, window.env (preload-injected) --- {env_types.variable_map, object}
 * Processing: Load environment variables from process.env and window.env (precedence: process > window), filter by prefixes (AETHER_, GURU_, LM_STUDIO_, ELECTRON_), cache in Map, provide type-safe getters (getString, getInt, getBool, getFloat), validate via validators.js --- {4 jobs: JOB_INITIALIZE, JOB_GET_STATE, JOB_VALIDATE_SCHEMA, JOB_UPDATE_STATE}
 * Outgoing: Singleton envLoader instance with typed getters --- {env_types.loader, EnvLoader}
 * 
 * 
 * @module core/config/env-loader
 */

const DEFAULTS = require('./defaults');
const {
  validateBoolean,
  validatePositiveInt,
  validateFloat,
  validateString,
} = require('./validators');

class EnvLoader {
  constructor() {
    this._cache = new Map();
    this._initialized = false;
    this._prefixes = DEFAULTS.envPrefixes;
  }

  /**
   * Initialize the environment loader
   * Loads from process.env and window.env (if available)
   */
  init() {
    if (this._initialized) return;

    this._loadFromProcess();
    this._loadFromWindow();

    this._initialized = true;
    
    const count = this._cache.size;
    if (count > 0) {
      console.log(`[EnvLoader] Initialized with ${count} environment variables`);
    }
  }

  /**
   * Load environment variables from process.env (Node.js context)
   * @private
   */
  _loadFromProcess() {
    if (typeof process === 'undefined' || !process.env) return;

    Object.keys(process.env).forEach(key => {
      if (this._shouldInclude(key)) {
        this._cache.set(key, process.env[key]);
      }
    });
  }

  /**
   * Load environment variables from window.env (browser context)
   * @private
   */
  _loadFromWindow() {
    if (typeof window === 'undefined' || !window.env) return;

    Object.keys(window.env).forEach(key => {
      // Don't override values from process.env
      if (!this._cache.has(key) && this._shouldInclude(key)) {
        this._cache.set(key, window.env[key]);
      }
    });
  }

  /**
   * Check if environment variable should be included
   * @param {string} key - Environment variable name
   * @returns {boolean}
   * @private
   */
  _shouldInclude(key) {
    return this._prefixes.some(prefix => key.startsWith(prefix));
  }

  /**
   * Get environment variable value
   * @param {string} key - Environment variable name
   * @param {any} defaultValue - Default value if not found
   * @returns {any} Environment variable value or default
   */
  get(key, defaultValue = undefined) {
    // Ensure initialized
    if (!this._initialized) {
      this.init();
    }

    if (this._cache.has(key)) {
      return this._cache.get(key);
    }

    // Try direct access as fallback (for runtime changes)
    if (typeof process !== 'undefined' && process.env && key in process.env) {
      const value = process.env[key];
      this._cache.set(key, value);
      return value;
    }

    if (typeof window !== 'undefined' && window.env && key in window.env) {
      const value = window.env[key];
      this._cache.set(key, value);
      return value;
    }

    return defaultValue;
  }

  /**
   * Get string value with optional max length
   * @param {string} key - Environment variable name
   * @param {string} defaultValue - Default value
   * @param {number} maxLength - Maximum allowed length
   * @returns {string}
   */
  getString(key, defaultValue = '', maxLength = Infinity) {
    const value = this.get(key, defaultValue);
    return validateString(value, defaultValue, maxLength);
  }

  /**
   * Get integer value with optional min/max bounds
   * @param {string} key - Environment variable name
   * @param {number} defaultValue - Default value
   * @param {number} min - Minimum value
   * @param {number} max - Maximum value
   * @returns {number}
   */
  getInt(key, defaultValue = 0, min = 1, max = Infinity) {
    const value = this.get(key, defaultValue);
    return validatePositiveInt(value, defaultValue, min, max);
  }

  /**
   * Get boolean value
   * @param {string} key - Environment variable name
   * @param {boolean} defaultValue - Default value
   * @returns {boolean}
   */
  getBool(key, defaultValue = false) {
    const value = this.get(key, defaultValue);
    return validateBoolean(value, defaultValue);
  }

  /**
   * Get float value with optional min/max bounds
   * @param {string} key - Environment variable name
   * @param {number} defaultValue - Default value
   * @param {number} min - Minimum value
   * @param {number} max - Maximum value
   * @returns {number}
   */
  getFloat(key, defaultValue = 0.0, min = -Infinity, max = Infinity) {
    const value = this.get(key, defaultValue);
    return validateFloat(value, defaultValue, min, max);
  }

  /**
   * Check if environment variable exists
   * @param {string} key - Environment variable name
   * @returns {boolean}
   */
  has(key) {
    if (!this._initialized) {
      this.init();
    }

    return this._cache.has(key) ||
      (typeof process !== 'undefined' && process.env && key in process.env) ||
      (typeof window !== 'undefined' && window.env && key in window.env);
  }

  /**
   * Get all environment variables with a specific prefix
   * @param {string} prefix - Prefix to filter by
   * @returns {Object} Object with filtered environment variables
   */
  getWithPrefix(prefix) {
    if (!this._initialized) {
      this.init();
    }

    const result = {};
    this._cache.forEach((value, key) => {
      if (key.startsWith(prefix)) {
        result[key] = value;
      }
    });
    return result;
  }

  /**
   * Get all loaded environment variables
   * @returns {Object} All environment variables
   */
  getAll() {
    if (!this._initialized) {
      this.init();
    }

    const result = {};
    this._cache.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  /**
   * Reload environment variables (useful after hot reload)
   * Clears cache and re-initializes
   */
  reload() {
    this._cache.clear();
    this._initialized = false;
    this.init();
  }

  /**
   * Clear all cached values
   */
  clear() {
    this._cache.clear();
    this._initialized = false;
  }

  /**
   * Set environment variable (mainly for testing)
   * @param {string} key - Environment variable name
   * @param {any} value - Value to set
   */
  set(key, value) {
    this._cache.set(key, value);
  }

  /**
   * Get cache size
   * @returns {number} Number of cached variables
   */
  get size() {
    return this._cache.size;
  }
}

// Singleton instance
const envLoader = new EnvLoader();

// Export singleton and class
module.exports = {
  EnvLoader,
  envLoader,
};

