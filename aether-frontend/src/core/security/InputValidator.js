'use strict';

/**
 * @.architecture
 * 
 * Incoming: All user inputs (messages, settings, URLs, file paths) --- {user_input_types.*, any}
 * Processing: Validate type/length/pattern/range, detect SQL injection patterns, detect command injection characters, detect XSS patterns, check prototype pollution (dangerous keys), enforce object depth limits, schema-based validation --- {5 jobs: JOB_VALIDATE_SCHEMA, JOB_VALIDATE_SCHEMA, JOB_UPDATE_STATE, JOB_TRACK_ENTITY, JOB_EMIT_EVENT}
 * Outgoing: Return true or throw ValidationError with field/rule details --- {validation_types.result, boolean | ValidationError}
 * 
 * 
 * @module core/security/InputValidator
 */

const { freeze } = Object;

/**
 * Validation rules
 */
const VALIDATION_RULES = freeze({
  // Common patterns
  email: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
  url: /^https?:\/\/[^\s/$.?#].[^\s]*$/i,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  hexColor: /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/,
  alphanumeric: /^[a-zA-Z0-9]+$/,
  numeric: /^[0-9]+$/,
  alpha: /^[a-zA-Z]+$/,
  
  // Security patterns (dangerous content)
  sqlInjection: /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|EXECUTE|UNION|DECLARE)\b|--|\/\*|\*\/|;|'|")/gi,
  commandInjection: /[;&|`$(){}[\]<>]/g,
  xssPatterns: /<script|javascript:|onerror=|onload=|<iframe|eval\(|expression\(/gi,
});

/**
 * Validation error
 */
class ValidationError extends Error {
  constructor(message, field, rule) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.rule = rule;
    this.isValidationError = true;
  }
}

/**
 * Input validator
 */
class InputValidator {
  constructor(options = {}) {
    this.maxStringLength = options.maxStringLength || 10000;
    this.maxArrayLength = options.maxArrayLength || 1000;
    this.maxObjectDepth = options.maxObjectDepth || 10;
    
    // Statistics
    this.stats = {
      totalValidations: 0,
      failures: 0,
      byType: new Map(),
    };
  }

  /**
   * Validate string
   * @param {string} value - Value to validate
   * @param {Object} constraints - Validation constraints
   * @returns {boolean}
   * @throws {ValidationError}
   */
  validateString(value, constraints = {}) {
    this._updateStats('string');
    
    // Type check
    if (typeof value !== 'string') {
      throw new ValidationError('Value must be a string', 'value', 'type');
    }

    // Length constraints
    const minLength = constraints.minLength || 0;
    const maxLength = constraints.maxLength || this.maxStringLength;
    
    if (value.length < minLength) {
      throw new ValidationError(
        `String too short: minimum ${minLength} characters`,
        'value',
        'minLength'
      );
    }
    
    if (value.length > maxLength) {
      throw new ValidationError(
        `String too long: maximum ${maxLength} characters`,
        'value',
        'maxLength'
      );
    }

    // Pattern matching
    if (constraints.pattern) {
      if (!constraints.pattern.test(value)) {
        throw new ValidationError(
          'String does not match required pattern',
          'value',
          'pattern'
        );
      }
    }

    // Security checks
    if (constraints.noSqlInjection) {
      // Reset regex state
      VALIDATION_RULES.sqlInjection.lastIndex = 0;
      if (VALIDATION_RULES.sqlInjection.test(value)) {
        this.stats.failures++;
        throw new ValidationError(
          'Potential SQL injection detected',
          'value',
          'security'
        );
      }
    }
    
    if (constraints.noCommandInjection) {
      // Reset regex state
      VALIDATION_RULES.commandInjection.lastIndex = 0;
      if (VALIDATION_RULES.commandInjection.test(value)) {
        this.stats.failures++;
        throw new ValidationError(
          'Potential command injection detected',
          'value',
          'security'
        );
      }
    }
    
    if (constraints.noXss) {
      // Reset regex state
      VALIDATION_RULES.xssPatterns.lastIndex = 0;
      if (VALIDATION_RULES.xssPatterns.test(value)) {
        this.stats.failures++;
        throw new ValidationError(
          'Potential XSS pattern detected',
          'value',
          'security'
        );
      }
    }

    return true;
  }

  /**
   * Validate number
   * @param {number} value - Value to validate
   * @param {Object} constraints - Validation constraints
   * @returns {boolean}
   * @throws {ValidationError}
   */
  validateNumber(value, constraints = {}) {
    this._updateStats('number');
    
    // Type check
    if (typeof value !== 'number' || isNaN(value) || !isFinite(value)) {
      throw new ValidationError('Value must be a valid number', 'value', 'type');
    }

    // Range constraints
    if (constraints.min !== undefined && value < constraints.min) {
      throw new ValidationError(
        `Number too small: minimum ${constraints.min}`,
        'value',
        'min'
      );
    }
    
    if (constraints.max !== undefined && value > constraints.max) {
      throw new ValidationError(
        `Number too large: maximum ${constraints.max}`,
        'value',
        'max'
      );
    }

    // Integer check
    if (constraints.integer && !Number.isInteger(value)) {
      throw new ValidationError('Value must be an integer', 'value', 'integer');
    }

    // Positive check
    if (constraints.positive && value <= 0) {
      throw new ValidationError('Value must be positive', 'value', 'positive');
    }

    return true;
  }

  /**
   * Validate email
   * @param {string} email - Email to validate
   * @returns {boolean}
   * @throws {ValidationError}
   */
  validateEmail(email) {
    this._updateStats('email');
    
    if (typeof email !== 'string') {
      throw new ValidationError('Email must be a string', 'email', 'type');
    }

    if (!VALIDATION_RULES.email.test(email)) {
      throw new ValidationError('Invalid email format', 'email', 'format');
    }

    return true;
  }

  /**
   * Validate URL
   * @param {string} url - URL to validate
   * @param {Object} constraints - Validation constraints
   * @returns {boolean}
   * @throws {ValidationError}
   */
  validateURL(url, constraints = {}) {
    this._updateStats('url');
    
    if (typeof url !== 'string') {
      throw new ValidationError('URL must be a string', 'url', 'type');
    }

    try {
      const parsed = new URL(url);
      
      // Block dangerous protocols first (higher priority)
      const dangerousProtocols = ['javascript:', 'data:', 'vbscript:', 'file:'];
      if (dangerousProtocols.includes(parsed.protocol)) {
        this.stats.failures++;
        throw new ValidationError(
          'Dangerous URL protocol detected',
          'url',
          'security'
        );
      }

      // Protocol check
      const allowedProtocols = constraints.protocols || ['http:', 'https:'];
      if (!allowedProtocols.includes(parsed.protocol)) {
        throw new ValidationError(
          `URL protocol not allowed: ${parsed.protocol}`,
          'url',
          'protocol'
        );
      }

      return true;
    } catch (error) {
      if (error.isValidationError) {
        throw error;
      }
      throw new ValidationError('Invalid URL format', 'url', 'format');
    }
  }

  /**
   * Validate object
   * @param {Object} obj - Object to validate
   * @param {Object} schema - Validation schema
   * @returns {boolean}
   * @throws {ValidationError}
   */
  validateObject(obj, schema = {}) {
    this._updateStats('object');
    
    // Type check
    if (typeof obj !== 'object' || obj === null) {
      throw new ValidationError('Value must be an object', 'value', 'type');
    }

    // Check for dangerous keys (prototype pollution) - only if not explicitly allowed
    if (schema.allowDangerousKeys !== true) {
      const dangerousKeys = ['__proto__', 'constructor', 'prototype'];
      if (this._hasDangerousKeys(obj, dangerousKeys)) {
        this.stats.failures++;
        throw new ValidationError(
          'Object contains dangerous keys',
          'value',
          'security'
        );
      }
    }

    // Depth check
    if (this._getObjectDepth(obj) > this.maxObjectDepth) {
      throw new ValidationError(
        `Object too deep: maximum depth ${this.maxObjectDepth}`,
        'value',
        'depth'
      );
    }

    // Schema validation
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in obj)) {
          throw new ValidationError(
            `Missing required field: ${key}`,
            key,
            'required'
          );
        }
      }
    }

    // Field validation
    if (schema.fields) {
      for (const [key, fieldSchema] of Object.entries(schema.fields)) {
        if (key in obj) {
          this._validateField(obj[key], fieldSchema, key);
        }
      }
    }

    return true;
  }

  /**
   * Validate array
   * @param {Array} arr - Array to validate
   * @param {Object} constraints - Validation constraints
   * @returns {boolean}
   * @throws {ValidationError}
   */
  validateArray(arr, constraints = {}) {
    this._updateStats('array');
    
    // Type check
    if (!Array.isArray(arr)) {
      throw new ValidationError('Value must be an array', 'value', 'type');
    }

    // Length constraints
    const minLength = constraints.minLength || 0;
    const maxLength = constraints.maxLength || this.maxArrayLength;
    
    if (arr.length < minLength) {
      throw new ValidationError(
        `Array too short: minimum ${minLength} elements`,
        'value',
        'minLength'
      );
    }
    
    if (arr.length > maxLength) {
      throw new ValidationError(
        `Array too long: maximum ${maxLength} elements`,
        'value',
        'maxLength'
      );
    }

    // Element validation
    if (constraints.elementSchema) {
      for (let i = 0; i < arr.length; i++) {
        try {
          this._validateField(arr[i], constraints.elementSchema, `[${i}]`);
        } catch (error) {
          if (error.isValidationError) {
            throw new ValidationError(
              `Invalid array element at index ${i}: ${error.message}`,
              `[${i}]`,
              error.rule
            );
          }
          throw error;
        }
      }
    }

    return true;
  }

  /**
   * Validate field based on schema
   * @param {*} value - Field value
   * @param {Object} schema - Field schema
   * @param {string} fieldName - Field name
   * @private
   */
  _validateField(value, schema, fieldName) {
    const type = schema.type || 'string';
    
    try {
      switch (type) {
        case 'string':
          this.validateString(value, schema);
          break;
        case 'number':
          this.validateNumber(value, schema);
          break;
        case 'email':
          this.validateEmail(value);
          break;
        case 'url':
          this.validateURL(value, schema);
          break;
        case 'array':
          this.validateArray(value, schema);
          break;
        case 'object':
          this.validateObject(value, schema);
          break;
        default:
          // Custom validator
          if (schema.validator) {
            if (!schema.validator(value)) {
              throw new ValidationError(
                `Custom validation failed for field ${fieldName}`,
                fieldName,
                'custom'
              );
            }
          }
      }
    } catch (error) {
      if (error.isValidationError) {
        error.field = fieldName;
      }
      throw error;
    }
  }

  /**
   * Check for dangerous keys in object
   * @param {Object} obj - Object to check
   * @param {Array<string>} dangerousKeys - List of dangerous keys
   * @returns {boolean}
   * @private
   */
  _hasDangerousKeys(obj, dangerousKeys) {
    if (typeof obj !== 'object' || obj === null) {
      return false;
    }

    // Check direct properties only (not inherited)
    for (const key of dangerousKeys) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        return true;
      }
    }

    // Check nested objects
    for (const value of Object.values(obj)) {
      if (typeof value === 'object' && value !== null) {
        if (this._hasDangerousKeys(value, dangerousKeys)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Get object depth
   * @param {Object} obj - Object to measure
   * @param {number} depth - Current depth
   * @returns {number}
   * @private
   */
  _getObjectDepth(obj, depth = 0) {
    if (typeof obj !== 'object' || obj === null) {
      return depth;
    }

    let maxDepth = depth;
    for (const value of Object.values(obj)) {
      if (typeof value === 'object' && value !== null) {
        const childDepth = this._getObjectDepth(value, depth + 1);
        maxDepth = Math.max(maxDepth, childDepth);
      }
    }

    return maxDepth;
  }

  /**
   * Update statistics
   * @param {string} type - Validation type
   * @private
   */
  _updateStats(type) {
    this.stats.totalValidations++;
    
    if (!this.stats.byType.has(type)) {
      this.stats.byType.set(type, 0);
    }
    
    this.stats.byType.set(
      type,
      this.stats.byType.get(type) + 1
    );
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    return {
      totalValidations: this.stats.totalValidations,
      failures: this.stats.failures,
      failureRate: this.stats.totalValidations > 0
        ? (this.stats.failures / this.stats.totalValidations * 100).toFixed(2) + '%'
        : '0%',
      byType: Object.fromEntries(this.stats.byType),
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      totalValidations: 0,
      failures: 0,
      byType: new Map(),
    };
  }

  // ============================================================================
  // Compatibility Methods (for tests)
  // ============================================================================

  isString(value) {
    return typeof value === 'string';
  }

  validateLength(value, min, max) {
    if (typeof value !== 'string') {
      return false;
    }
    return value.length >= min && value.length <= max;
  }

  isNumber(value) {
    return typeof value === 'number' && !isNaN(value);
  }

  validateRange(value, min, max) {
    if (typeof value !== 'number' || isNaN(value)) {
      return false;
    }
    return value >= min && value <= max;
  }

  isValidUrl(value) {
    if (typeof value !== 'string') {
      return false;
    }
    try {
      const url = new URL(value);
      const dangerousProtocols = ['javascript:', 'data:', 'vbscript:', 'file:'];
      return !dangerousProtocols.includes(url.protocol);
    } catch {
      return false;
    }
  }

  isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  validateMessageSize(message, maxSize) {
    if (typeof message !== 'string') {
      return false;
    }
    return message.length <= maxSize;
  }

  // Schema validation (for tests)
  validate(data, schema) {
    const errors = {};
    const errorList = [];
    
    // Check required fields
    for (const [field, rules] of Object.entries(schema)) {
      if (rules.required && !(field in data)) {
        const msg = `Missing required field: ${field}`;
        errors[field] = msg;
        errorList.push(msg);
        continue;
      }
      
      const value = data[field];
      if (value === undefined) continue;
      
      // Type validation
      if (rules.type) {
        const typeValid = this._validateFieldType(value, rules.type);
        if (!typeValid) {
          const msg = `Field ${field} must be of type ${rules.type}`;
          errors[field] = msg;
          errorList.push(msg);
          continue;
        }
      }
      
      // String length
      if (rules.type === 'string' && typeof value === 'string') {
        if (rules.minLength && value.length < rules.minLength) {
          const msg = `Field ${field} too short (min: ${rules.minLength})`;
          errors[field] = msg;
          errorList.push(msg);
          continue;
        }
        if (rules.maxLength && value.length > rules.maxLength) {
          const msg = `Field ${field} too long (max: ${rules.maxLength})`;
          errors[field] = msg;
          errorList.push(msg);
          continue;
        }
      }
      
      // Number range
      if (rules.type === 'number' && typeof value === 'number') {
        if (rules.min !== undefined && value < rules.min) {
          const msg = `Field ${field} below minimum (min: ${rules.min})`;
          errors[field] = msg;
          errorList.push(msg);
          continue;
        }
        if (rules.max !== undefined && value > rules.max) {
          const msg = `Field ${field} above maximum (max: ${rules.max})`;
          errors[field] = msg;
          errorList.push(msg);
          continue;
        }
      }
      
      // Email format
      if (rules.type === 'email' && typeof value === 'string') {
        if (!VALIDATION_RULES.email.test(value)) {
          const msg = `Field ${field} is not a valid email`;
          errors[field] = msg;
          errorList.push(msg);
          continue;
        }
      }
      
      // URL format
      if (rules.type === 'url' && typeof value === 'string') {
        try {
          this.validateURL(value, rules);
        } catch (error) {
          if (error.isValidationError) {
            const msg = `Field ${field} is not a valid URL`;
            errors[field] = msg;
            errorList.push(msg);
            continue;
          }
        }
      }
    }
    
    return {
      valid: errorList.length === 0,
      errors
    };
  }

  _validateFieldType(value, type) {
    switch (type) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number' && !isNaN(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'object':
        return typeof value === 'object' && value !== null && !Array.isArray(value);
      case 'array':
        return Array.isArray(value);
      case 'email':
        return typeof value === 'string' && VALIDATION_RULES.email.test(value);
      case 'url':
        return typeof value === 'string' && this.isValidUrl(value);
      default:
        return true;
    }
  }
}

// Export
module.exports = {
  InputValidator,
  ValidationError,
  VALIDATION_RULES,
};

if (typeof window !== 'undefined') {
  window.InputValidator = InputValidator;
  window.ValidationError = ValidationError;
  console.log('📦 InputValidator loaded');
}

