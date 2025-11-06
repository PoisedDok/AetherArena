'use strict';

/**
 * @.architecture
 * 
 * Incoming: bridge-factory (validatePayload) --- {method_call, any}
 * Processing: Define schemas per channel (chat:window-control enum[minimize/maximize/close/toggle], chat:send object{message<100KB}, chat:assistant-stream object{chunk<10KB}, artifacts:stream object{type/content<5MB}, artifacts:* objects, widget-position-update object{x/y numbers}, wheel-event object{deltaY/ctrlKey}, renderer-log string<10KB), validate via validators (string/number/boolean/object/array/enum/optional with maxLength/minLength/pattern/min/max/requiredKeys), recursive validation for object properties, frozen schemas --- {4 jobs: JOB_VALIDATE_SCHEMA, JOB_VALIDATE_SCHEMA, JOB_VALIDATE_SCHEMA, JOB_VALIDATE_SCHEMA}
 * Outgoing: Validation result {valid, error} --- {validation_result, javascript_object}
 * 
 * 
 * @module preload/ipc/payload-schemas
 * 
 * IPC Payload Schemas
 * ============================================================================
 * Schema definitions for IPC payload validation.
 * Ensures data integrity and prevents injection attacks.
 * 
 * @module preload/ipc/payload-schemas
 */

const { freeze } = Object;

/**
 * Schema validators
 */
const validators = {
  /**
   * Validate string type
   */
  string: (value, opts = {}) => {
    if (typeof value !== 'string') return false;
    if (opts.maxLength && value.length > opts.maxLength) return false;
    if (opts.minLength && value.length < opts.minLength) return false;
    if (opts.pattern && !opts.pattern.test(value)) return false;
    return true;
  },

  /**
   * Validate number type
   */
  number: (value, opts = {}) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    if (opts.min !== undefined && value < opts.min) return false;
    if (opts.max !== undefined && value > opts.max) return false;
    return true;
  },

  /**
   * Validate boolean type
   */
  boolean: (value) => {
    return typeof value === 'boolean';
  },

  /**
   * Validate object type
   */
  object: (value, opts = {}) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (opts.requiredKeys) {
      for (const key of opts.requiredKeys) {
        if (!(key in value)) return false;
      }
    }
    return true;
  },

  /**
   * Validate array type
   */
  array: (value, opts = {}) => {
    if (!Array.isArray(value)) return false;
    if (opts.maxLength && value.length > opts.maxLength) return false;
    if (opts.minLength && value.length < opts.minLength) return false;
    if (opts.itemValidator) {
      return value.every(item => opts.itemValidator(item));
    }
    return true;
  },

  /**
   * Validate enum value
   */
  enum: (value, opts = {}) => {
    if (!opts.values || !Array.isArray(opts.values)) return false;
    return opts.values.includes(value);
  },

  /**
   * Optional validator wrapper
   */
  optional: (value, validator, opts) => {
    if (value === undefined || value === null) return true;
    return validator(value, opts);
  },
};

/**
 * Payload schemas by channel
 * Format: { channel: { schema, description } }
 */
const schemas = freeze({
  // ========================================================================
  // Window Control
  // ========================================================================
  'chat:window-control': freeze({
    description: 'Chat window control actions',
    schema: freeze({
      type: 'enum',
      values: ['minimize', 'maximize', 'close', 'toggle-visibility'],
    }),
  }),

  'artifacts:window-control': freeze({
    description: 'Artifacts window control actions',
    schema: freeze({
      type: 'enum',
      values: ['minimize', 'maximize', 'close', 'toggle-visibility'],
    }),
  }),

  // ========================================================================
  // Chat Communication
  // ========================================================================
  'chat:send': freeze({
    description: 'Send chat message',
    schema: freeze({
      type: 'object',
      requiredKeys: ['message'],
      properties: freeze({
        message: { type: 'string', maxLength: 100000 },
        chatId: { type: 'string', optional: true },
        requestId: { type: 'string', optional: true },
        metadata: { type: 'object', optional: true },
      }),
    }),
  }),

  'chat:assistant-stream': freeze({
    description: 'Stream assistant response',
    schema: freeze({
      type: 'object',
      requiredKeys: ['chunk'],
      properties: freeze({
        chunk: { type: 'string', maxLength: 10000 },
        done: { type: 'boolean', optional: true },
        requestId: { type: 'string', optional: true },
        metadata: { type: 'object', optional: true },
      }),
    }),
  }),

  'chat:scroll-to-message': freeze({
    description: 'Scroll to specific message',
    schema: freeze({
      type: 'object',
      requiredKeys: ['messageId'],
      properties: freeze({
        messageId: { type: 'string' },
      }),
    }),
  }),

  // ========================================================================
  // Artifacts Communication
  // ========================================================================
  'artifacts:stream': freeze({
    description: 'Stream artifact data',
    schema: freeze({
      type: 'object',
      requiredKeys: ['type'],
      properties: freeze({
        type: { type: 'enum', values: ['code', 'output', 'html', 'file', 'text', 'markdown', 'json'] },
        content: { type: 'string', optional: true, maxLength: 5242880 }, // 5MB
        language: { type: 'string', optional: true },
        filename: { type: 'string', optional: true },
        chatId: { type: 'string', optional: true },
        messageId: { type: 'string', optional: true },
        artifactId: { type: 'string', optional: true },
        metadata: { type: 'object', optional: true },
      }),
    }),
  }),

  'artifacts:focus-artifacts': freeze({
    description: 'Focus specific artifact',
    schema: freeze({
      type: 'object',
      requiredKeys: ['artifactId'],
      properties: freeze({
        artifactId: { type: 'string' },
        tab: { type: 'string', optional: true },
      }),
    }),
  }),

  'artifacts:switch-tab': freeze({
    description: 'Switch artifacts tab',
    schema: freeze({
      type: 'enum',
      values: ['code', 'output', 'files', 'storage', 'legal-news'],
    }),
  }),

  'artifacts:switch-chat': freeze({
    description: 'Switch chat context in artifacts',
    schema: freeze({
      type: 'string',
    }),
  }),

  'artifacts:load-code': freeze({
    description: 'Load code into artifacts',
    schema: freeze({
      type: 'object',
      requiredKeys: ['code'],
      properties: freeze({
        code: { type: 'string', maxLength: 5242880 },
        language: { type: 'string', optional: true },
        filename: { type: 'string', optional: true },
      }),
    }),
  }),

  'artifacts:load-output': freeze({
    description: 'Load output into artifacts',
    schema: freeze({
      type: 'object',
      requiredKeys: ['output'],
      properties: freeze({
        output: { type: 'string', maxLength: 5242880 },
        format: { type: 'enum', values: ['text', 'html', 'json', 'markdown'], optional: true },
      }),
    }),
  }),

  'artifacts:file-export': freeze({
    description: 'Export artifact as file',
    schema: freeze({
      type: 'object',
      requiredKeys: ['content'],
      properties: freeze({
        content: { type: 'string', maxLength: 10485760 }, // 10MB
        name: { type: 'string', optional: true },
        extension: { type: 'string', optional: true },
      }),
    }),
  }),

  'artifacts:open-file': freeze({
    description: 'Open file with system app',
    schema: freeze({
      type: 'object',
      requiredKeys: ['path'],
      properties: freeze({
        path: { type: 'string' },
      }),
    }),
  }),

  // ========================================================================
  // Widget Mode
  // ========================================================================
  'widget-position-update': freeze({
    description: 'Update widget position',
    schema: freeze({
      type: 'object',
      requiredKeys: ['x', 'y'],
      properties: freeze({
        x: { type: 'number', min: 0 },
        y: { type: 'number', min: 0 },
      }),
    }),
  }),

  'wheel-event': freeze({
    description: 'Mouse wheel event for zooming',
    schema: freeze({
      type: 'object',
      requiredKeys: ['deltaY'],
      properties: freeze({
        deltaY: { type: 'number' },
        ctrlKey: { type: 'boolean', optional: true },
      }),
    }),
  }),

  // ========================================================================
  // Logging
  // ========================================================================
  'renderer-log': freeze({
    description: 'Log message from renderer',
    schema: freeze({
      type: 'string',
      maxLength: 10000,
    }),
  }),
});

/**
 * Validate payload against schema
 * @param {string} channel - Channel name
 * @param {any} payload - Payload to validate
 * @returns {Object} { valid: boolean, error?: string }
 */
function validatePayload(channel, payload) {
  const schemaEntry = schemas[channel];
  
  // No schema = allow any payload (legacy channels)
  if (!schemaEntry) {
    return { valid: true };
  }

  const { schema } = schemaEntry;

  try {
    const result = validateValue(payload, schema);
    return result 
      ? { valid: true }
      : { valid: false, error: `Payload validation failed for channel "${channel}"` };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

/**
 * Validate value against schema definition
 * @param {any} value - Value to validate
 * @param {Object} schema - Schema definition
 * @returns {boolean}
 * @private
 */
function validateValue(value, schema) {
  if (!schema || !schema.type) return true;

  const { type, optional, ...opts } = schema;

  // Handle optional values
  if (optional && (value === undefined || value === null)) {
    return true;
  }

  // Handle enum
  if (type === 'enum') {
    return validators.enum(value, opts);
  }

  // Handle object with properties
  if (type === 'object' && schema.properties) {
    if (!validators.object(value, opts)) return false;
    
    // Validate each property
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (!validateValue(value[key], propSchema)) {
        return false;
      }
    }
    return true;
  }

  // Handle basic types
  const validator = validators[type];
  if (!validator) {
    console.warn(`[IPC Schema] Unknown validator type: ${type}`);
    return true; // Allow unknown types (fail open for extensibility)
  }

  return validator(value, opts);
}

/**
 * Get schema for channel
 * @param {string} channel - Channel name
 * @returns {Object|null} Schema definition or null
 */
function getSchema(channel) {
  return schemas[channel] || null;
}

/**
 * Check if channel has schema
 * @param {string} channel - Channel name
 * @returns {boolean}
 */
function hasSchema(channel) {
  return channel in schemas;
}

module.exports = {
  schemas,
  validators,
  validatePayload,
  getSchema,
  hasSchema,
};

