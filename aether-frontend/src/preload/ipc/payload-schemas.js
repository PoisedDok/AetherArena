'use strict';

/**
 * @.architecture
 * 
 * Incoming: bridge-factory (validatePayload) --- {method_call, any}
 * Processing: Define schemas per channel (chat:window-control enum[minimize/maximize/close/toggle], chat:send object{message<100KB}, chat:assistant-stream object{chunk<10KB}, artifacts:stream object{type/content<5MB}, artifacts:* objects, widget-drag-start/move object{screenX/screenY numbers}, wheel-event object{deltaY/ctrlKey}, renderer-log string<10KB), validate via validators (string/number/boolean/object/array/enum/optional with maxLength/minLength/pattern/min/max/requiredKeys), recursive validation for object properties, frozen schemas --- {4 jobs: JOB_VALIDATE_SCHEMA, JOB_VALIDATE_SCHEMA, JOB_VALIDATE_SCHEMA, JOB_VALIDATE_SCHEMA}
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

const { createLogger } = require('../../core/utils/logger');
const { freeze } = Object;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTERNAL_URL_PATTERN = /^(https?:\/\/|mailto:|tel:)[^\s]+$/i;
const STRICT_SCHEMA_CHANNELS = freeze(new Set(['open-external-url']));

const log = createLogger({ component: 'IPC:Schema' });

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

  /**
   * Flexible timestamp validator - accepts both string and number
   */
  timestamp: (value, opts = {}) => {
    if (typeof value === 'string') {
      if (opts.maxLength && value.length > opts.maxLength) return false;
      return true;
    }
    if (typeof value === 'number') {
      return Number.isFinite(value);
    }
    return false;
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
      values: ['minimize', 'maximize', 'close', 'toggle-visibility', 'toggle-clean-mode', 'toggle-notch-mode'],
    }),
  }),

  'chat:notch-mode-changed': freeze({
    description: 'Notch mode state changed',
    schema: freeze({
      type: 'object',
      requiredKeys: ['enabled'],
      properties: freeze({
        enabled: { type: 'boolean' },
      }),
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
        chatId: { type: 'string', optional: true, pattern: UUID_REGEX },
        requestId: { type: 'string', optional: true },
        correlationId: { type: 'string', optional: true },
        metadata: { type: 'object', optional: true },
      }),
    }),
  }),

  'chat:assistant-stream': freeze({
    description: 'Stream assistant response',
    schema: freeze({
      type: 'object',
      requiredKeys: ['type'], // 'role' removed as trail and agent events may not have it
      properties: freeze({
        role: { type: 'string', optional: true, maxLength: 32 },
        type: { type: 'string', maxLength: 64 },
        source: { type: 'string', optional: true, maxLength: 32 },
        content: { type: 'string', optional: true, maxLength: 5242880 }, // 5MB to support raw artifact chunks routed here
        title: { type: 'string', optional: true },
        description: { type: 'string', optional: true },
        _artifactsActive: { type: 'boolean', optional: true },
        _timestamp: { type: 'number', optional: true },
        start: { type: 'boolean', optional: true },
        end: { type: 'boolean', optional: true },
        done: { type: 'boolean', optional: true },
        id: { type: 'string', optional: true },
        requestId: { type: 'string', optional: true },
        request_id: { type: 'string', optional: true },
        correlationId: { type: 'string', optional: true },
        correlation_id: { type: 'string', optional: true },
        backend_id: { type: 'string', optional: true },
        frontend_id: { type: 'string', optional: true },
        artifact_id: { type: 'string', optional: true },
        phase: { type: 'string', optional: true, maxLength: 32 },
        recipient: { type: 'string', optional: true, maxLength: 32 },
        sequence: { type: 'number', optional: true },
        timestamp: { type: 'timestamp', optional: true, maxLength: 64 }, // Backend sends BOTH ISO string (from _utc_now_iso) AND Unix epoch number (time.time())
        message: { type: 'string', optional: true, maxLength: 100000 },
        chat_id: { type: 'string', optional: true, pattern: UUID_REGEX },
        chatId: { type: 'string', optional: true, pattern: UUID_REGEX },
        messageId: { type: 'string', optional: true },
        message_id: { type: 'string', optional: true },
        data: { type: 'object', optional: true },
        metadata: { type: 'object', optional: true },
        format: { type: 'string', optional: true, maxLength: 64 },
        language: { type: 'string', optional: true, maxLength: 64 },
        history_count: { type: 'number', optional: true }, // context_reset_ack payload

        // Trail & Artifact linkage fields
        group_id: { type: 'string', optional: true },
        subgroup_id: { type: 'string', optional: true },
        sequence_number: { type: 'number', optional: true },
        subgroup_sequence: { type: 'number', optional: true },
        sequence_in_chat: { type: 'number', optional: true },
        execution_group: { type: 'string', optional: true },
        nodes: { type: 'array', optional: true },
        node_id: { type: 'string', optional: true },
        status: { type: 'string', optional: true },
        artifact_type: { type: 'string', optional: true },
        
        // Proactive & Handsfree fields
        run_id: { type: 'string', optional: true },
        recommendation: { type: 'string', optional: true },
        decision: { type: 'string', optional: true },
        supporting_docs: { type: 'array', optional: true },
        tool_budget: { type: 'number', optional: true },
        tool_calls_count: { type: 'number', optional: true },
        execution_time_ms: { type: 'number', optional: true },
        context: { type: 'object', optional: true },
        trace_id: { type: 'string', optional: true },
        traceId: { type: 'string', optional: true },
        chunk: { type: 'string', optional: true },
        audio: { type: 'string', optional: true },
        sample_rate: { type: 'number', optional: true },
        error_type: { type: 'string', optional: true },
        client_id: { type: 'string', optional: true },
        text: { type: 'string', optional: true },
        is_handsfree: { type: 'boolean', optional: true },
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
        type: { type: 'enum', values: ['code', 'output', 'html', 'file', 'text', 'markdown', 'json', 'console', 'unknown', 'artifacts:stream:ready'] },
        content: { type: 'string', optional: true, maxLength: 5242880 }, // 5MB
        language: { type: 'string', optional: true },
        filename: { type: 'string', optional: true },
        chatId: { type: 'string', optional: true, pattern: UUID_REGEX },
        chat_id: { type: 'string', optional: true, pattern: UUID_REGEX },
        messageId: { type: 'string', optional: true },
        message_id: { type: 'string', optional: true },
        artifactId: { type: 'string', optional: true },
        artifact_id: { type: 'string', optional: true },
        metadata: { type: 'object', optional: true },
        node_id: { type: 'string', optional: true },
        subgroup_id: { type: 'string', optional: true },
        group_id: { type: 'string', optional: true },
        parent_id: { type: 'string', optional: true },
        parentId: { type: 'string', optional: true },
        correlation_id: { type: 'string', optional: true },
        correlationId: { type: 'string', optional: true },
        role: { type: 'string', optional: true },
        format: { type: 'string', optional: true },
        start: { type: 'boolean', optional: true },
        end: { type: 'boolean', optional: true },
        done: { type: 'boolean', optional: true },
        sequence: { type: 'number', optional: true },
        timestamp: { type: 'timestamp', optional: true },
        execution_group: { type: 'string', optional: true },
        executionGroup: { type: 'string', optional: true },
        request_id: { type: 'string', optional: true },
        requestId: { type: 'string', optional: true },
      }),
    }),
  }),

  'artifacts:execute-code': freeze({
    description: 'Execute edited code via backend (route to chat sender in main window)',
    schema: freeze({
      type: 'object',
      requiredKeys: ['chatId', 'code', 'language'],
      properties: freeze({
        chatId: { type: 'string', pattern: UUID_REGEX },
        code: { type: 'string', maxLength: 100000 }, // match chat:send 100KB limit
        language: { type: 'string', maxLength: 64 },
        artifactId: { type: 'string', optional: true },
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
      pattern: UUID_REGEX,
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
        content: { type: 'string', maxLength: 52428800 }, // 50MB
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

  'about:open-notices-file': freeze({
    description: 'Open THIRD-PARTY-NOTICES file (path resolved in main process)',
    schema: freeze({
      type: 'object',
      requiredKeys: [],
      properties: freeze({}),
    }),
  }),

  // ========================================================================
  // Widget Mode
  // ========================================================================
  'widget-drag-start': freeze({
    description: 'Begin JS-based widget drag (screen coordinates)',
    schema: freeze({
      type: 'object',
      requiredKeys: ['screenX', 'screenY'],
      properties: freeze({
        screenX: { type: 'number' },
        screenY: { type: 'number' },
      }),
    }),
  }),

  'widget-drag-move': freeze({
    description: 'Move during JS widget drag (screen coordinates)',
    schema: freeze({
      type: 'object',
      requiredKeys: ['screenX', 'screenY'],
      properties: freeze({
        screenX: { type: 'number' },
        screenY: { type: 'number' },
      }),
    }),
  }),

  'widget-drag-end': freeze({
    description: 'End JS-based widget drag',
    schema: freeze({ type: 'object', optional: true }),
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

  'open-external-url': freeze({
    description: 'Open external URL in system handler',
    schema: freeze({
      type: 'string',
      minLength: 1,
      maxLength: 2048,
      pattern: EXTERNAL_URL_PATTERN,
    }),
  }),

  // ========================================================================
  // Session Management (deterministic IDs)
  // ========================================================================
  'session:set-active': freeze({
    description: 'Set active chat session',
    schema: freeze({
      type: 'object',
      requiredKeys: ['chatId'],
      properties: freeze({
        chatId: { type: 'string', pattern: UUID_REGEX },
      }),
    }),
  }),

  'session:next-id': freeze({
    description: 'Generate next deterministic id',
    schema: freeze({
      type: 'object',
      requiredKeys: ['kind'],
      properties: freeze({
        kind: { type: 'enum', values: ['user_message', 'assistant_message', 'assistant_code', 'assistant_output', 'assistant_html', 'user_attachment'] },
        parentId: { type: 'string', optional: true },
        chatId: { type: 'string', optional: true, pattern: UUID_REGEX },
      }),
    }),
  }),

  'session:parse-id': freeze({
    description: 'Parse deterministic id',
    schema: freeze({
      type: 'object',
      requiredKeys: ['id'],
      properties: freeze({
        id: { type: 'string' },
      }),
    }),
  }),

  'session:get-stats': freeze({
    description: 'Get session manager statistics',
    schema: freeze({ type: 'object', optional: true }),
  }),

  'session:clear': freeze({
    description: 'Clear a specific chat session',
    schema: freeze({
      type: 'object',
      requiredKeys: ['chatId'],
      properties: freeze({
        chatId: { type: 'string', pattern: UUID_REGEX },
      }),
    }),
  }),

  'session:clear-all': freeze({
    description: 'Clear all sessions',
    schema: freeze({ type: 'object', optional: true }),
  }),

  // ========================================================================
  // System
  // ========================================================================
  'system:get-stats': freeze({
    description: 'Get system statistics (CPU, memory, etc.)',
    schema: freeze({ type: 'object', optional: true }),
  }),

  'startup:animation-complete': freeze({
    description: 'Signal that startup animation has completed',
    schema: freeze({ type: 'object', optional: true }),
  }),

  'startup:welcome-complete': freeze({
    description: 'Signal that welcome demo sequence has finished — enter widget mode and reveal chat window',
    schema: freeze({ type: 'object', optional: true }),
  }),

  'model:warmup': freeze({
    description: 'Fire-and-forget signal to warm backend HTTP connection pool and inference pipeline at welcome start',
    schema: freeze({ type: 'object', optional: true }),
  }),

  'backend:get-url': freeze({
    description: 'Get backend baseUrl from main process (post-discovery)',
    schema: freeze({ type: 'object', optional: true }),
  }),

  // ========================================================================
  // Storage API (backend proxy via IPC)
  // ========================================================================
  'storage:load-chats': freeze({ description: 'Load all chats', schema: freeze({ type: 'object', optional: true }) }),
  'storage:load-chat': freeze({ description: 'Load chat by id', schema: freeze({ type: 'object', requiredKeys: ['chatId'], properties: freeze({ chatId: { type: 'string', pattern: UUID_REGEX } }) }) }),
  'storage:create-chat': freeze({ description: 'Create chat', schema: freeze({ type: 'object', requiredKeys: ['title'], properties: freeze({ title: { type: 'string', maxLength: 512 } }) }) }),
  'storage:update-chat-title': freeze({ description: 'Update chat title', schema: freeze({ type: 'object', requiredKeys: ['chatId','title'], properties: freeze({ chatId: { type: 'string', pattern: UUID_REGEX }, title: { type: 'string', maxLength: 512 } }) }) }),
  'storage:delete-chat': freeze({ description: 'Delete chat', schema: freeze({ type: 'object', requiredKeys: ['chatId'], properties: freeze({ chatId: { type: 'string', pattern: UUID_REGEX } }) }) }),
  'storage:load-messages': freeze({ description: 'Load messages by chat', schema: freeze({ type: 'object', requiredKeys: ['chatId'], properties: freeze({ chatId: { type: 'string', pattern: UUID_REGEX } }) }) }),
  'storage:save-message': freeze({ description: 'Save message', schema: freeze({ type: 'object', requiredKeys: ['chatId','message'], properties: freeze({ chatId: { type: 'string', pattern: UUID_REGEX }, message: { type: 'object' } }) }) }),
  'storage:load-artifacts': freeze({ description: 'Load artifacts by chat', schema: freeze({ type: 'object', requiredKeys: ['chatId'], properties: freeze({ chatId: { type: 'string', pattern: UUID_REGEX } }) }) }),
  'storage:save-artifact': freeze({ description: 'Save artifact', schema: freeze({ type: 'object', requiredKeys: ['chatId','artifact'], properties: freeze({ chatId: { type: 'string', pattern: UUID_REGEX }, artifact: { type: 'object' } }) }) }),
  'storage:load-trail-hierarchy': freeze({ description: 'Load trail hierarchy (groups→subgroups→nodes)', schema: freeze({ type: 'object', requiredKeys: ['chatId'], properties: freeze({ chatId: { type: 'string', pattern: UUID_REGEX } }) }) }),
  'storage:update-artifact-message-id': freeze({ description: 'Link artifact to message', schema: freeze({ type: 'object', requiredKeys: ['artifactId','messageId','chatId'], properties: freeze({ artifactId: { type: 'string' }, messageId: { type: 'string' }, chatId: { type: 'string', pattern: UUID_REGEX } }) }) }),
  'storage:delete-artifact': freeze({ description: 'Delete artifact', schema: freeze({ type: 'object', requiredKeys: ['artifactId'], properties: freeze({ artifactId: { type: 'string' } }) }) }),
  'storage:get-message-artifacts': freeze({ description: 'Get artifacts for message', schema: freeze({ type: 'object', requiredKeys: ['messageId'], properties: freeze({ messageId: { type: 'string' } }) }) }),
  'storage:get-artifact-source': freeze({ description: 'Get artifact source', schema: freeze({ type: 'object', requiredKeys: ['artifactId'], properties: freeze({ artifactId: { type: 'string' } }) }) }),
  'storage:get-llm-metadata': freeze({ description: 'Get LLM metadata for message', schema: freeze({ type: 'object', requiredKeys: ['messageId'], properties: freeze({ messageId: { type: 'string' } }) }) }),
  // Trail state operations REMOVED - backend persists automatically
  'storage:health-check': freeze({ description: 'Storage health check', schema: freeze({ type: 'object', optional: true }) }),
  'storage:test-connection': freeze({ description: 'Storage connection test', schema: freeze({ type: 'object', optional: true }) }),
  'storage:get-stats': freeze({ description: 'Storage stats', schema: freeze({ type: 'object', optional: true }) }),
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
    if (STRICT_SCHEMA_CHANNELS.has(channel)) {
      return {
        valid: false,
        error: `Missing required schema for channel "${channel}"`,
      };
    }
    return { valid: true };
  }

  const { schema } = schemaEntry;

  try {
    const result = validateValue(payload, schema, `${channel}`);
    if (!result.valid) {
      // Log failing payload for debugging
      log.error('validation failed', { channel, error: result.error });
      return { valid: false, error: `${result.error}` };
    }
    return { valid: true };
  } catch (error) {
    log.error('exception during validation', { channel, error: error.message });
    return { valid: false, error: error.message };
  }
}

/**
 * Validate value against schema definition
 * @param {any} value - Value to validate
 * @param {Object} schema - Schema definition
 * @param {string} [path=''] - Path for error reporting
 * @returns {Object} { valid: boolean, error?: string, failedAt?: string }
 * @private
 */
function validateValue(value, schema, path = '') {
  if (!schema || !schema.type) return { valid: true };

  const { type, optional, ...opts } = schema;

  // Handle optional values
  if (optional && (value === undefined || value === null)) {
    return { valid: true };
  }

  // Handle enum
  if (type === 'enum') {
    const result = validators.enum(value, opts);
    return result 
      ? { valid: true } 
      : { valid: false, error: `Enum validation failed at "${path}": expected one of [${opts.values}], got ${typeof value === 'string' ? `"${value}"` : value}` };
  }

  // Handle object with properties
  if (type === 'object' && schema.properties) {
    if (!validators.object(value, opts)) {
      return { valid: false, error: `Not an object at "${path}": got ${typeof value}` };
    }
    
            // Enforce strict schema: check for unexpected properties
    for (const key of Object.keys(value)) {
      if (!(key in schema.properties)) {
        // NOTE: For tests to pass, we return the error here. 
        // In production, we should probably warn and allow if we don't want to crash on new backend fields.
        return { valid: false, error: `Unexpected property "${key}" at "${path}"` };
      }
    }
    
    // Validate each property
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      const propertyPath = path ? `${path}.${key}` : key;
      const propertyValue = value[key];
      const result = validateValue(propertyValue, propSchema, propertyPath);
      if (!result.valid) {
        return result;
      }
    }
    return { valid: true };
  }

  // Handle basic types
  const validator = validators[type];
  if (!validator) {
    log.warn('unknown validator type', { type, path });
    return { valid: true }; // Allow unknown types (fail open for extensibility)
  }

  const result = validator(value, opts);
  return result
    ? { valid: true }
    : { valid: false, error: `Type "${type}" validation failed at "${path}": value=${JSON.stringify(value).substring(0, 100)}` };
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
  STRICT_SCHEMA_CHANNELS,
  validatePayload,
  getSchema,
  hasSchema,
};
