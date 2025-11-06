'use strict';

/**
 * @.architecture
 * 
 * Incoming: Preload API functions (validation calls) --- {method_call, any}
 * Processing: Validate primitive types (string/number/boolean/function/object/array), validate complex types (enum/uuid/url), validate ranges (numberInRange/positiveNumber), validate constraints (nonEmptyString/minLength/maxLength/pattern regex), validate object schemas (required fields/type checks/additional validations), provide createValidator factory, throw TypeError/Error on validation failure --- {1 job: JOB_VALIDATE_SCHEMA}
 * Outgoing: Validation result {valid, error} or throws Error --- {validation_result | Error, javascript_object | Error}
 * 
 * 
 * @module preload/common/api-validators
 * 
 * API Validators
 * ============================================================================
 * Type and value validators for preload API functions.
 * Ensures type safety and prevents invalid arguments.
 * 
 * @module preload/common/api-validators
 */

/**
 * Type validators
 */
const validators = {
  /**
   * Validate string
   */
  string(value, fieldName = 'value') {
    if (typeof value !== 'string') {
      throw new TypeError(`${fieldName} must be a string, got ${typeof value}`);
    }
  },

  /**
   * Validate number
   */
  number(value, fieldName = 'value') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`${fieldName} must be a finite number, got ${typeof value}`);
    }
  },

  /**
   * Validate boolean
   */
  boolean(value, fieldName = 'value') {
    if (typeof value !== 'boolean') {
      throw new TypeError(`${fieldName} must be a boolean, got ${typeof value}`);
    }
  },

  /**
   * Validate function
   */
  function(value, fieldName = 'value') {
    if (typeof value !== 'function') {
      throw new TypeError(`${fieldName} must be a function, got ${typeof value}`);
    }
  },

  /**
   * Validate object
   */
  object(value, fieldName = 'value') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(`${fieldName} must be an object, got ${typeof value}`);
    }
  },

  /**
   * Validate array
   */
  array(value, fieldName = 'value') {
    if (!Array.isArray(value)) {
      throw new TypeError(`${fieldName} must be an array, got ${typeof value}`);
    }
  },

  /**
   * Validate enum value
   */
  enum(value, allowedValues, fieldName = 'value') {
    if (!allowedValues.includes(value)) {
      throw new Error(
        `${fieldName} must be one of [${allowedValues.join(', ')}], got "${value}"`
      );
    }
  },

  /**
   * Validate optional value (undefined allowed)
   */
  optional(value, validator, ...args) {
    if (value !== undefined) {
      validator(value, ...args);
    }
  },

  /**
   * Validate non-empty string
   */
  nonEmptyString(value, fieldName = 'value') {
    this.string(value, fieldName);
    if (value.length === 0) {
      throw new Error(`${fieldName} must not be empty`);
    }
  },

  /**
   * Validate positive number
   */
  positiveNumber(value, fieldName = 'value') {
    this.number(value, fieldName);
    if (value <= 0) {
      throw new Error(`${fieldName} must be positive, got ${value}`);
    }
  },

  /**
   * Validate number in range
   */
  numberInRange(value, min, max, fieldName = 'value') {
    this.number(value, fieldName);
    if (value < min || value > max) {
      throw new Error(`${fieldName} must be between ${min} and ${max}, got ${value}`);
    }
  },

  /**
   * Validate URL
   */
  url(value, fieldName = 'value') {
    this.nonEmptyString(value, fieldName);
    try {
      new URL(value);
    } catch {
      throw new Error(`${fieldName} must be a valid URL, got "${value}"`);
    }
  },

  /**
   * Validate UUID
   */
  uuid(value, fieldName = 'value') {
    this.nonEmptyString(value, fieldName);
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(value)) {
      throw new Error(`${fieldName} must be a valid UUID, got "${value}"`);
    }
  },
};

/**
 * Create validator for specific type
 * @param {string} type - Validator type
 * @param {any} options - Validator options
 * @returns {Function} - Validator function
 */
function createValidator(type, options = {}) {
  const validator = validators[type];
  if (!validator) {
    throw new Error(`Unknown validator type: ${type}`);
  }
  
  return (value, fieldName) => {
    try {
      validator.call(validators, value, fieldName, options);
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  };
}

/**
 * Validate object against schema
 * @param {Object} obj - Object to validate
 * @param {Object} schema - Schema definition
 * @param {string} contextName - Context name for error messages
 * @throws {Error} If validation fails
 */
function validateSchema(obj, schema, contextName = 'object') {
  for (const [key, config] of Object.entries(schema)) {
    const value = obj[key];
    const fieldName = `${contextName}.${key}`;
    
    // Check required
    if (config.required && (value === undefined || value === null)) {
      throw new Error(`${fieldName} is required`);
    }
    
    // Skip validation if optional and not provided
    if (!config.required && (value === undefined || value === null)) {
      continue;
    }
    
    // Validate type
    const validatorType = config.type || 'string';
    const validator = validators[validatorType];
    
    if (!validator) {
      console.warn(`Unknown validator type: ${validatorType} for ${fieldName}`);
      continue;
    }
    
    // Apply validator
    if (config.type === 'enum') {
      validator.call(validators, value, config.values, fieldName);
    } else if (config.type === 'numberInRange') {
      validator.call(validators, value, config.min, config.max, fieldName);
    } else {
      validator.call(validators, value, fieldName);
    }
    
    // Additional validations
    if (config.minLength !== undefined && value.length < config.minLength) {
      throw new Error(`${fieldName} length must be at least ${config.minLength}`);
    }
    
    if (config.maxLength !== undefined && value.length > config.maxLength) {
      throw new Error(`${fieldName} length must not exceed ${config.maxLength}`);
    }
    
    if (config.pattern && !config.pattern.test(value)) {
      throw new Error(`${fieldName} does not match required pattern`);
    }
  }
}

module.exports = {
  validators,
  createValidator,
  validateSchema,
};

