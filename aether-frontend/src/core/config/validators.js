'use strict';

/**
 * @.architecture
 * 
 * Incoming: resolvers.js, env-loader.js (validation calls for parsed config values) --- {config_value_types.*, any}
 * Processing: Validate/normalize URL (http/https only), parse boolean (true/1/yes/on), parse positive int with bounds, parse float with bounds, validate enum against allowed list, normalize URL (remove trailing slash), convert http→ws --- {3 jobs: JOB_VALIDATE_SCHEMA, JOB_PARSE_JSON, JOB_UPDATE_STATE}
 * Outgoing: Return validated/normalized value or throw Error --- {config_value_types.validated, any}
 * 
 * 
 * @module core/config/validators
 */

/**
 * Validate and normalize HTTP/HTTPS URL
 * @param {string} value - URL to validate
 * @returns {string} Normalized URL without trailing slash
 * @throws {Error} If URL is invalid or not HTTP/HTTPS
 */
function validateUrl(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('URL must be a non-empty string');
  }

  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('URL must use HTTP or HTTPS protocol');
    }
    // Remove trailing slash for consistency
    return url.toString().replace(/\/+$/, '');
  } catch (error) {
    throw new Error(`Invalid URL: ${value} - ${error.message}`);
  }
}

/**
 * Check if value is a valid HTTP/HTTPS URL (non-throwing)
 * @param {string} value - URL to check
 * @returns {boolean} True if valid
 */
function isValidUrl(value) {
  try {
    validateUrl(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate and parse boolean value
 * @param {any} value - Value to parse
 * @param {boolean} defaultValue - Default if parsing fails
 * @returns {boolean} Parsed boolean
 */
function validateBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return defaultValue;
  
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    if (lower === 'true' || lower === '1' || lower === 'yes' || lower === 'on') {
      return true;
    }
    if (lower === 'false' || lower === '0' || lower === 'no' || lower === 'off') {
      return false;
    }
  }
  
  // Truthy/falsy coercion as last resort
  return Boolean(value);
}

/**
 * Validate and parse positive integer
 * @param {any} value - Value to parse
 * @param {number} defaultValue - Default if parsing fails
 * @param {number} min - Minimum allowed value (default: 1)
 * @param {number} max - Maximum allowed value (default: Infinity)
 * @returns {number} Parsed integer
 */
function validatePositiveInt(value, defaultValue, min = 1, max = Infinity) {
  const parsed = parseInt(value, 10);
  
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return defaultValue;
  }
  
  return parsed;
}

/**
 * Validate and parse float
 * @param {any} value - Value to parse
 * @param {number} defaultValue - Default if parsing fails
 * @param {number} min - Minimum allowed value (default: -Infinity)
 * @param {number} max - Maximum allowed value (default: Infinity)
 * @returns {number} Parsed float
 */
function validateFloat(value, defaultValue, min = -Infinity, max = Infinity) {
  const parsed = parseFloat(value);
  
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return defaultValue;
  }
  
  return parsed;
}

/**
 * Validate enum value against allowed options
 * @param {any} value - Value to validate
 * @param {Array<string>} allowedValues - Allowed enum values
 * @param {string} defaultValue - Default if not in allowed list
 * @returns {string} Validated enum value
 */
function validateEnum(value, allowedValues, defaultValue) {
  if (!Array.isArray(allowedValues) || allowedValues.length === 0) {
    throw new Error('allowedValues must be a non-empty array');
  }
  
  const stringValue = String(value).toLowerCase();
  const normalized = allowedValues.find(v => String(v).toLowerCase() === stringValue);
  
  return normalized || defaultValue;
}

/**
 * Validate log level
 * @param {string} value - Log level to validate
 * @returns {string} Validated log level
 */
function validateLogLevel(value) {
  const validLevels = ['silent', 'error', 'warn', 'info', 'debug', 'trace'];
  return validateEnum(value, validLevels, 'info');
}

/**
 * Validate sanitizer profile
 * @param {string} value - Sanitizer profile to validate
 * @returns {string} Validated sanitizer profile
 */
function validateSanitizerProfile(value) {
  const validProfiles = ['strict', 'default', 'permissive'];
  return validateEnum(value, validProfiles, 'strict');
}

/**
 * Validate storage backend type
 * @param {string} value - Storage backend to validate
 * @returns {string} Validated storage backend
 */
function validateStorageBackend(value) {
  const validBackends = ['postgresql', 'sqlite', 'memory'];
  return validateEnum(value, validBackends, 'postgresql');
}

/**
 * Validate port number
 * @param {any} value - Port to validate
 * @param {number} defaultValue - Default port
 * @returns {number} Validated port
 */
function validatePort(value, defaultValue) {
  return validatePositiveInt(value, defaultValue, 1, 65535);
}

/**
 * Validate timeout in milliseconds
 * @param {any} value - Timeout to validate
 * @param {number} defaultValue - Default timeout
 * @returns {number} Validated timeout
 */
function validateTimeout(value, defaultValue) {
  return validatePositiveInt(value, defaultValue, 100, 600000); // 100ms to 10min
}

/**
 * Validate file size in bytes
 * @param {any} value - Size to validate
 * @param {number} defaultValue - Default size
 * @returns {number} Validated size
 */
function validateFileSize(value, defaultValue) {
  return validatePositiveInt(value, defaultValue, 1024, 1073741824); // 1KB to 1GB
}

/**
 * Normalize URL by removing trailing slashes
 * @param {string} url - URL to normalize
 * @returns {string} Normalized URL
 */
function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return '';
  return url.replace(/\/+$/, '');
}

/**
 * Convert HTTP URL to WebSocket URL
 * @param {string} httpUrl - HTTP(S) URL
 * @returns {string} WS(S) URL
 */
function httpToWs(httpUrl) {
  if (!httpUrl || typeof httpUrl !== 'string') {
    throw new Error('Invalid HTTP URL provided for WS conversion');
  }
  
  return httpUrl.replace(/^http/, 'ws');
}

/**
 * Validate and sanitize string
 * @param {any} value - Value to validate
 * @param {string} defaultValue - Default value
 * @param {number} maxLength - Maximum allowed length
 * @returns {string} Validated string
 */
function validateString(value, defaultValue = '', maxLength = Infinity) {
  if (value === null || value === undefined) return defaultValue;
  
  const stringValue = String(value);
  
  if (maxLength !== Infinity && stringValue.length > maxLength) {
    return stringValue.substring(0, maxLength);
  }
  
  return stringValue;
}

/**
 * Validate object has required keys
 * @param {object} obj - Object to validate
 * @param {Array<string>} requiredKeys - Required keys
 * @throws {Error} If required keys are missing
 */
function validateRequiredKeys(obj, requiredKeys) {
  if (!obj || typeof obj !== 'object') {
    throw new Error('Value must be an object');
  }
  
  const missingKeys = requiredKeys.filter(key => !(key in obj));
  
  if (missingKeys.length > 0) {
    throw new Error(`Missing required keys: ${missingKeys.join(', ')}`);
  }
}

/**
 * Validate array contains only specific types
 * @param {any} value - Value to validate
 * @param {string} type - Expected type ('string' | 'number' | 'boolean')
 * @param {Array} defaultValue - Default value
 * @returns {Array} Validated array
 */
function validateArrayOfType(value, type, defaultValue = []) {
  if (!Array.isArray(value)) return defaultValue;
  
  const isValid = value.every(item => typeof item === type);
  
  return isValid ? value : defaultValue;
}

module.exports = {
  validateUrl,
  isValidUrl,
  validateBoolean,
  validatePositiveInt,
  validateFloat,
  validateEnum,
  validateLogLevel,
  validateSanitizerProfile,
  validateStorageBackend,
  validatePort,
  validateTimeout,
  validateFileSize,
  normalizeUrl,
  httpToWs,
  validateString,
  validateRequiredKeys,
  validateArrayOfType,
};

