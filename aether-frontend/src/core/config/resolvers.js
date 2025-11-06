'use strict';

/**
 * @.architecture
 * 
 * Incoming: Application bootstrap (config.js or similar), configuration consumers (ApiClient, Endpoint, etc.) --- {request_types.get_config, method_call}
 * Processing: Resolve config values with precedence (1. localStorage, 2. environment, 3. defaults), validate each source, normalize via validators.js, special resolvers for URL/boolean/int/timeout/port/fileSize/logLevel/sanitizerProfile/storageBackend --- {4 jobs: JOB_GET_STATE, JOB_VALIDATE_SCHEMA, JOB_UPDATE_STATE, JOB_DELEGATE_TO_MODULE}
 * Outgoing: Return resolved, validated, normalized config value --- {config_types.resolved_value, any}
 * 
 * 
 * @module core/config/resolvers
 */

const { envLoader } = require('./env-loader');
const {
  validateUrl,
  isValidUrl,
  validateBoolean,
  validatePositiveInt,
  validateLogLevel,
  validateSanitizerProfile,
  validateStorageBackend,
  validateTimeout,
  validatePort,
  validateFileSize,
  normalizeUrl,
  httpToWs,
} = require('./validators');

/**
 * Get value from localStorage with validation
 * @param {string} key - localStorage key
 * @param {Function} validator - Validation function
 * @returns {any|null} Validated value or null
 * @private
 */
function getLocalStorageValue(key, validator = null) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return null;
    }

    const value = window.localStorage.getItem(key);
    if (!value) return null;

    // Apply validator if provided
    if (validator && !validator(value)) {
      console.warn(`[Config] Invalid localStorage override for "${key}": ${value}`);
      return null;
    }

    return value;
  } catch (error) {
    console.warn(`[Config] Failed to read localStorage key "${key}":`, error.message);
    return null;
  }
}

/**
 * Resolve URL with precedence: localStorage > env > default
 * @param {string} envKey - Environment variable key
 * @param {string} localStorageKey - localStorage key
 * @param {string} defaultValue - Default URL
 * @returns {string} Resolved and normalized URL
 */
function resolveUrl(envKey, localStorageKey, defaultValue) {
  // 1. Try localStorage override
  const override = getLocalStorageValue(localStorageKey, isValidUrl);
  if (override) {
    return normalizeUrl(override);
  }

  // 2. Try environment variable
  const envValue = envLoader.getString(envKey);
  if (envValue && isValidUrl(envValue)) {
    return normalizeUrl(envValue);
  }

  // 3. Use default (already validated in defaults.js)
  return normalizeUrl(defaultValue);
}

/**
 * Resolve boolean with precedence: localStorage > env > default
 * @param {string} envKey - Environment variable key
 * @param {string} localStorageKey - localStorage key
 * @param {boolean} defaultValue - Default boolean
 * @returns {boolean} Resolved boolean
 */
function resolveBoolean(envKey, localStorageKey, defaultValue) {
  // 1. Try localStorage override
  const override = getLocalStorageValue(localStorageKey);
  if (override !== null) {
    return validateBoolean(override, defaultValue);
  }

  // 2. Try environment variable
  const envValue = envLoader.get(envKey);
  if (envValue !== undefined) {
    return validateBoolean(envValue, defaultValue);
  }

  // 3. Use default
  return defaultValue;
}

/**
 * Resolve integer with precedence: localStorage > env > default
 * @param {string} envKey - Environment variable key
 * @param {string} localStorageKey - localStorage key
 * @param {number} defaultValue - Default integer
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {number} Resolved integer
 */
function resolveInt(envKey, localStorageKey, defaultValue, min = 1, max = Infinity) {
  // 1. Try localStorage override
  const override = getLocalStorageValue(localStorageKey);
  if (override !== null) {
    const parsed = validatePositiveInt(override, defaultValue, min, max);
    if (parsed !== defaultValue) return parsed;
  }

  // 2. Try environment variable
  return envLoader.getInt(envKey, defaultValue, min, max);
}

/**
 * Resolve timeout with precedence: localStorage > env > default
 * @param {string} envKey - Environment variable key
 * @param {string} localStorageKey - localStorage key
 * @param {number} defaultValue - Default timeout
 * @returns {number} Resolved timeout
 */
function resolveTimeout(envKey, localStorageKey, defaultValue) {
  const resolved = resolveInt(envKey, localStorageKey, defaultValue, 100, 600000);
  return validateTimeout(resolved, defaultValue);
}

/**
 * Resolve port with precedence: localStorage > env > default
 * @param {string} envKey - Environment variable key
 * @param {string} localStorageKey - localStorage key
 * @param {number} defaultValue - Default port
 * @returns {number} Resolved port
 */
function resolvePort(envKey, localStorageKey, defaultValue) {
  return resolveInt(envKey, localStorageKey, defaultValue, 1, 65535);
}

/**
 * Resolve file size with precedence: localStorage > env > default
 * @param {string} envKey - Environment variable key
 * @param {string} localStorageKey - localStorage key
 * @param {number} defaultValue - Default size
 * @returns {number} Resolved file size
 */
function resolveFileSize(envKey, localStorageKey, defaultValue) {
  const resolved = resolveInt(envKey, localStorageKey, defaultValue, 1024, 1073741824);
  return validateFileSize(resolved, defaultValue);
}

/**
 * Resolve log level with precedence: localStorage > env > default
 * @param {string} envKey - Environment variable key
 * @param {string} localStorageKey - localStorage key
 * @param {string} defaultValue - Default log level
 * @returns {string} Resolved log level
 */
function resolveLogLevel(envKey, localStorageKey, defaultValue) {
  // 1. Try localStorage override
  const override = getLocalStorageValue(localStorageKey);
  if (override) {
    return validateLogLevel(override);
  }

  // 2. Try environment variable
  const envValue = envLoader.getString(envKey);
  if (envValue) {
    return validateLogLevel(envValue);
  }

  // 3. Use default
  return validateLogLevel(defaultValue);
}

/**
 * Resolve sanitizer profile with precedence: localStorage > env > default
 * @param {string} envKey - Environment variable key
 * @param {string} localStorageKey - localStorage key
 * @param {string} defaultValue - Default sanitizer profile
 * @returns {string} Resolved sanitizer profile
 */
function resolveSanitizerProfile(envKey, localStorageKey, defaultValue) {
  // 1. Try localStorage override
  const override = getLocalStorageValue(localStorageKey);
  if (override) {
    return validateSanitizerProfile(override);
  }

  // 2. Try environment variable
  const envValue = envLoader.getString(envKey);
  if (envValue) {
    return validateSanitizerProfile(envValue);
  }

  // 3. Use default
  return validateSanitizerProfile(defaultValue);
}

/**
 * Resolve storage backend with precedence: localStorage > env > default
 * @param {string} envKey - Environment variable key
 * @param {string} localStorageKey - localStorage key
 * @param {string} defaultValue - Default storage backend
 * @returns {string} Resolved storage backend
 */
function resolveStorageBackend(envKey, localStorageKey, defaultValue) {
  // 1. Try localStorage override
  const override = getLocalStorageValue(localStorageKey);
  if (override) {
    return validateStorageBackend(override);
  }

  // 2. Try environment variable
  const envValue = envLoader.getString(envKey);
  if (envValue) {
    return validateStorageBackend(envValue);
  }

  // 3. Use default
  return validateStorageBackend(defaultValue);
}

/**
 * Resolve WebSocket URL from HTTP URL
 * @param {string} httpUrl - HTTP(S) URL
 * @returns {string} WS(S) URL
 */
function resolveWsUrl(httpUrl) {
  if (!httpUrl) {
    throw new Error('HTTP URL required for WebSocket URL resolution');
  }
  return httpToWs(httpUrl);
}

/**
 * Resolve full URL by combining base and endpoint
 * @param {string} baseUrl - Base URL
 * @param {string} endpoint - Endpoint path
 * @returns {string} Full URL
 */
function resolveFullUrl(baseUrl, endpoint) {
  if (!baseUrl || !endpoint) {
    throw new Error('Both baseUrl and endpoint are required');
  }

  const normalizedBase = normalizeUrl(baseUrl);
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;

  return `${normalizedBase}${normalizedEndpoint}`;
}

module.exports = {
  resolveUrl,
  resolveBoolean,
  resolveInt,
  resolveTimeout,
  resolvePort,
  resolveFileSize,
  resolveLogLevel,
  resolveSanitizerProfile,
  resolveStorageBackend,
  resolveWsUrl,
  resolveFullUrl,
};

