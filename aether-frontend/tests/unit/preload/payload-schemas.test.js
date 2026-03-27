'use strict';

jest.mock('../../../src/core/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

const {
  schemas,
  validators,
  STRICT_SCHEMA_CHANNELS,
  validatePayload,
  getSchema,
  hasSchema,
} = require('../../../src/preload/ipc/payload-schemas');

// ============================================================================
// validators — low-level type validators
// ============================================================================
describe('validators', () => {
  describe('string()', () => {
    it('should accept a plain string', () => {
      expect(validators.string('hello')).toBe(true);
    });

    it('should reject non-string', () => {
      expect(validators.string(42)).toBe(false);
      expect(validators.string(null)).toBe(false);
      expect(validators.string(undefined)).toBe(false);
    });

    it('should enforce maxLength', () => {
      expect(validators.string('abc', { maxLength: 5 })).toBe(true);
      expect(validators.string('abcdef', { maxLength: 5 })).toBe(false);
    });

    it('should enforce minLength', () => {
      expect(validators.string('abc', { minLength: 2 })).toBe(true);
      expect(validators.string('a', { minLength: 2 })).toBe(false);
    });

    it('should enforce pattern', () => {
      expect(validators.string('abc123', { pattern: /^[a-z0-9]+$/ })).toBe(true);
      expect(validators.string('ABC!', { pattern: /^[a-z0-9]+$/ })).toBe(false);
    });

    it('should accept empty string with no constraints', () => {
      expect(validators.string('')).toBe(true);
    });
  });

  describe('number()', () => {
    it('should accept finite numbers', () => {
      expect(validators.number(0)).toBe(true);
      expect(validators.number(42)).toBe(true);
      expect(validators.number(-3.14)).toBe(true);
    });

    it('should reject non-numbers', () => {
      expect(validators.number('42')).toBe(false);
      expect(validators.number(null)).toBe(false);
    });

    it('should reject NaN and Infinity', () => {
      expect(validators.number(NaN)).toBe(false);
      expect(validators.number(Infinity)).toBe(false);
      expect(validators.number(-Infinity)).toBe(false);
    });

    it('should enforce min', () => {
      expect(validators.number(5, { min: 0 })).toBe(true);
      expect(validators.number(-1, { min: 0 })).toBe(false);
      expect(validators.number(0, { min: 0 })).toBe(true); // boundary
    });

    it('should enforce max', () => {
      expect(validators.number(5, { max: 10 })).toBe(true);
      expect(validators.number(11, { max: 10 })).toBe(false);
      expect(validators.number(10, { max: 10 })).toBe(true); // boundary
    });

    it('should enforce min and max together', () => {
      expect(validators.number(5, { min: 1, max: 10 })).toBe(true);
      expect(validators.number(0, { min: 1, max: 10 })).toBe(false);
      expect(validators.number(11, { min: 1, max: 10 })).toBe(false);
    });
  });

  describe('boolean()', () => {
    it('should accept true/false', () => {
      expect(validators.boolean(true)).toBe(true);
      expect(validators.boolean(false)).toBe(true);
    });

    it('should reject non-booleans', () => {
      expect(validators.boolean(0)).toBe(false);
      expect(validators.boolean('true')).toBe(false);
      expect(validators.boolean(null)).toBe(false);
    });
  });

  describe('object()', () => {
    it('should accept plain objects', () => {
      expect(validators.object({})).toBe(true);
      expect(validators.object({ key: 'val' })).toBe(true);
    });

    it('should reject null, arrays, primitives', () => {
      expect(validators.object(null)).toBe(false);
      expect(validators.object([])).toBe(false);
      expect(validators.object('str')).toBe(false);
      expect(validators.object(42)).toBe(false);
    });

    it('should check requiredKeys', () => {
      expect(validators.object({ a: 1, b: 2 }, { requiredKeys: ['a', 'b'] })).toBe(true);
      expect(validators.object({ a: 1 }, { requiredKeys: ['a', 'b'] })).toBe(false);
    });
  });

  describe('array()', () => {
    it('should accept arrays', () => {
      expect(validators.array([])).toBe(true);
      expect(validators.array([1, 2, 3])).toBe(true);
    });

    it('should reject non-arrays', () => {
      expect(validators.array({})).toBe(false);
      expect(validators.array('abc')).toBe(false);
      expect(validators.array(null)).toBe(false);
    });

    it('should enforce maxLength', () => {
      expect(validators.array([1, 2], { maxLength: 3 })).toBe(true);
      expect(validators.array([1, 2, 3, 4], { maxLength: 3 })).toBe(false);
    });

    it('should enforce minLength', () => {
      expect(validators.array([1, 2, 3], { minLength: 2 })).toBe(true);
      expect(validators.array([1], { minLength: 2 })).toBe(false);
    });

    it('should enforce itemValidator', () => {
      const onlyStrings = (item) => typeof item === 'string';
      expect(validators.array(['a', 'b'], { itemValidator: onlyStrings })).toBe(true);
      expect(validators.array(['a', 1], { itemValidator: onlyStrings })).toBe(false);
    });
  });

  describe('enum()', () => {
    it('should accept values in the list', () => {
      expect(validators.enum('a', { values: ['a', 'b', 'c'] })).toBe(true);
    });

    it('should reject values not in the list', () => {
      expect(validators.enum('d', { values: ['a', 'b', 'c'] })).toBe(false);
    });

    it('should return false if values is missing or not an array', () => {
      expect(validators.enum('a', {})).toBe(false);
      expect(validators.enum('a', { values: 'not-array' })).toBe(false);
    });
  });

  describe('optional()', () => {
    it('should allow undefined', () => {
      expect(validators.optional(undefined, validators.string)).toBe(true);
    });

    it('should allow null', () => {
      expect(validators.optional(null, validators.string)).toBe(true);
    });

    it('should validate present values', () => {
      expect(validators.optional('hello', validators.string)).toBe(true);
      expect(validators.optional(42, validators.string)).toBe(false);
    });

    it('should pass options through', () => {
      expect(validators.optional('abc', validators.string, { maxLength: 2 })).toBe(false);
      expect(validators.optional('ab', validators.string, { maxLength: 2 })).toBe(true);
    });
  });

  describe('timestamp()', () => {
    it('should accept ISO date strings', () => {
      expect(validators.timestamp('2026-01-01T00:00:00Z')).toBe(true);
    });

    it('should accept Unix epoch numbers', () => {
      expect(validators.timestamp(1700000000)).toBe(true);
    });

    it('should enforce maxLength on strings', () => {
      expect(validators.timestamp('short', { maxLength: 10 })).toBe(true);
      expect(validators.timestamp('a'.repeat(100), { maxLength: 64 })).toBe(false);
    });

    it('should reject NaN/Infinity numbers', () => {
      expect(validators.timestamp(NaN)).toBe(false);
      expect(validators.timestamp(Infinity)).toBe(false);
    });

    it('should reject non-string non-number types', () => {
      expect(validators.timestamp(true)).toBe(false);
      expect(validators.timestamp(null)).toBe(false);
      expect(validators.timestamp({})).toBe(false);
      expect(validators.timestamp(undefined)).toBe(false);
    });
  });
});

// ============================================================================
// schemas — structural checks
// ============================================================================
describe('schemas', () => {
  it('should be a frozen object', () => {
    expect(Object.isFrozen(schemas)).toBe(true);
  });

  it('should define schemas for known channels', () => {
    const knownChannels = [
      'chat:window-control', 'artifacts:window-control',
      'chat:send', 'chat:assistant-stream', 'chat:scroll-to-message',
      'artifacts:stream', 'artifacts:execute-code', 'artifacts:focus-artifacts',
      'artifacts:switch-tab', 'artifacts:switch-chat',
      'artifacts:load-code', 'artifacts:load-output',
      'artifacts:file-export', 'artifacts:open-file',
      'wheel-event', 'renderer-log',
      'open-external-url',
      'session:set-active', 'session:next-id', 'session:parse-id',
      'session:get-stats', 'session:clear', 'session:clear-all',
      'storage:load-chats', 'storage:load-chat', 'storage:create-chat',
    ];
    for (const channel of knownChannels) {
      expect(schemas[channel]).toBeDefined();
      expect(schemas[channel].description).toBeTruthy();
      expect(schemas[channel].schema).toBeDefined();
    }
  });

  it('each schema entry should have description and schema', () => {
    for (const [channel, entry] of Object.entries(schemas)) {
      expect(entry).toHaveProperty('description');
      expect(entry).toHaveProperty('schema');
      expect(typeof entry.description).toBe('string');
    }
  });
});

// ============================================================================
// validatePayload()
// ============================================================================
describe('validatePayload()', () => {
  describe('unknown channel (no schema)', () => {
    it('should allow any payload for unknown channels', () => {
      const result = validatePayload('nonexistent:channel', { anything: true });
      expect(result).toEqual({ valid: true });
    });

    it('should allow null payload for unknown channels', () => {
      expect(validatePayload('nonexistent:channel', null)).toEqual({ valid: true });
    });
  });

  describe('chat:window-control (enum)', () => {
    it('should accept valid control actions', () => {
      expect(validatePayload('chat:window-control', 'minimize').valid).toBe(true);
      expect(validatePayload('chat:window-control', 'maximize').valid).toBe(true);
      expect(validatePayload('chat:window-control', 'close').valid).toBe(true);
      expect(validatePayload('chat:window-control', 'toggle-visibility').valid).toBe(true);
    });

    it('should reject invalid control actions', () => {
      const result = validatePayload('chat:window-control', 'destroy');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Enum validation failed');
    });

    it('should reject non-string values', () => {
      const result = validatePayload('chat:window-control', 42);
      expect(result.valid).toBe(false);
    });
  });

  describe('chat:send (object with required keys + properties)', () => {
    it('should accept valid message payload', () => {
      const result = validatePayload('chat:send', {
        message: 'Hello, world!',
      });
      expect(result.valid).toBe(true);
    });

    it('should accept message with optional fields', () => {
      const result = validatePayload('chat:send', {
        message: 'Hello',
        chatId: '550e8400-e29b-41d4-a716-446655440000',
        requestId: 'req-123',
        metadata: { source: 'test' },
      });
      expect(result.valid).toBe(true);
    });

    it('should reject missing required key "message"', () => {
      const result = validatePayload('chat:send', {});
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Not an object');
    });

    it('should reject non-object payload', () => {
      const result = validatePayload('chat:send', 'not an object');
      expect(result.valid).toBe(false);
    });

    it('should reject null payload', () => {
      const result = validatePayload('chat:send', null);
      expect(result.valid).toBe(false);
    });
  });

  describe('chat:assistant-stream (complex object)', () => {
    it('should accept minimal valid stream payload', () => {
      const result = validatePayload('chat:assistant-stream', {
        role: 'assistant',
        type: 'text',
      });
      expect(result.valid).toBe(true);
    });

    it('should accept stream payload with optional fields', () => {
      const result = validatePayload('chat:assistant-stream', {
        role: 'assistant',
        type: 'text',
        content: 'Hello',
        start: true,
        end: false,
        done: false,
        sequence: 1,
        timestamp: '2026-01-01T00:00:00Z',
      });
      expect(result.valid).toBe(true);
    });

    it('should accept timestamp as number', () => {
      const result = validatePayload('chat:assistant-stream', {
        role: 'assistant',
        type: 'text',
        timestamp: 1700000000,
      });
      expect(result.valid).toBe(true);
    });

    it('should accept missing role', () => {
      const result = validatePayload('chat:assistant-stream', {
        type: 'text',
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('artifacts:stream (object with enum property)', () => {
    it('should accept valid artifact stream', () => {
      const result = validatePayload('artifacts:stream', {
        type: 'code',
        content: 'console.log("hello")',
        language: 'javascript',
      });
      expect(result.valid).toBe(true);
    });

    it('should reject invalid type enum', () => {
      const result = validatePayload('artifacts:stream', {
        type: 'invalid-type',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Enum validation failed');
    });
  });

  describe('artifacts:switch-tab (simple enum)', () => {
    it('should accept valid tab names', () => {
      expect(validatePayload('artifacts:switch-tab', 'code').valid).toBe(true);
      expect(validatePayload('artifacts:switch-tab', 'output').valid).toBe(true);
      expect(validatePayload('artifacts:switch-tab', 'files').valid).toBe(true);
    });

    it('should reject invalid tab names', () => {
      expect(validatePayload('artifacts:switch-tab', 'settings').valid).toBe(false);
    });
  });

  describe('artifacts:switch-chat (string with UUID pattern)', () => {
    it('should accept valid UUID', () => {
      const result = validatePayload('artifacts:switch-chat', '550e8400-e29b-41d4-a716-446655440000');
      expect(result.valid).toBe(true);
    });

    it('should reject non-UUID string', () => {
      const result = validatePayload('artifacts:switch-chat', 'not-a-uuid');
      expect(result.valid).toBe(false);
    });
  });

  describe('wheel-event (object with optional boolean)', () => {
    it('should accept with required deltaY', () => {
      const result = validatePayload('wheel-event', { deltaY: -120 });
      expect(result.valid).toBe(true);
    });

    it('should accept with optional ctrlKey', () => {
      const result = validatePayload('wheel-event', { deltaY: 120, ctrlKey: true });
      expect(result.valid).toBe(true);
    });

    it('should reject non-number deltaY', () => {
      const result = validatePayload('wheel-event', { deltaY: 'up' });
      expect(result.valid).toBe(false);
    });
  });

  describe('renderer-log (simple string with maxLength)', () => {
    it('should accept normal log message', () => {
      expect(validatePayload('renderer-log', 'Log entry').valid).toBe(true);
    });

    it('should reject non-string', () => {
      expect(validatePayload('renderer-log', 42).valid).toBe(false);
    });

    it('should reject string exceeding maxLength', () => {
      const result = validatePayload('renderer-log', 'x'.repeat(10001));
      expect(result.valid).toBe(false);
    });

    it('should accept string at exactly maxLength boundary', () => {
      expect(validatePayload('renderer-log', 'x'.repeat(10000)).valid).toBe(true);
    });
  });

  describe('open-external-url (strict schema)', () => {
    it('should enforce strict-schema registry for external URL channel', () => {
      expect(STRICT_SCHEMA_CHANNELS.has('open-external-url')).toBe(true);
    });

    it('should accept valid http/https URLs', () => {
      expect(validatePayload('open-external-url', 'https://example.com').valid).toBe(true);
      expect(validatePayload('open-external-url', 'http://example.com/path?q=1').valid).toBe(true);
    });

    it('should accept valid mailto/tel URLs', () => {
      expect(validatePayload('open-external-url', 'mailto:test@example.com').valid).toBe(true);
      expect(validatePayload('open-external-url', 'tel:+123456789').valid).toBe(true);
    });

    it('should reject unsafe schemes', () => {
      expect(validatePayload('open-external-url', 'javascript:alert(1)').valid).toBe(false);
      expect(validatePayload('open-external-url', 'data:text/html,abc').valid).toBe(false);
      expect(validatePayload('open-external-url', 'file:///tmp/test.txt').valid).toBe(false);
    });

    it('should reject blank, non-string, or oversized payloads', () => {
      expect(validatePayload('open-external-url', '').valid).toBe(false);
      expect(validatePayload('open-external-url', null).valid).toBe(false);
      expect(validatePayload('open-external-url', 42).valid).toBe(false);
      expect(validatePayload('open-external-url', `https://example.com/${'x'.repeat(2050)}`).valid).toBe(false);
    });
  });

  describe('session:set-active (object with UUID pattern)', () => {
    it('should accept valid chatId UUID', () => {
      const result = validatePayload('session:set-active', {
        chatId: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result.valid).toBe(true);
    });

    it('should reject non-UUID chatId', () => {
      const result = validatePayload('session:set-active', {
        chatId: 'invalid-id',
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('session:next-id (object with enum property)', () => {
    it('should accept valid kind', () => {
      const result = validatePayload('session:next-id', {
        kind: 'user_message',
      });
      expect(result.valid).toBe(true);
    });

    it('should reject invalid kind', () => {
      const result = validatePayload('session:next-id', {
        kind: 'unknown_kind',
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('storage channels (require chatId UUID)', () => {
    it('should accept storage:load-chat with valid chatId', () => {
      const result = validatePayload('storage:load-chat', {
        chatId: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result.valid).toBe(true);
    });

    it('should reject storage:load-chat with invalid chatId', () => {
      const result = validatePayload('storage:load-chat', {
        chatId: 'bad',
      });
      expect(result.valid).toBe(false);
    });

    it('should accept storage:create-chat with title', () => {
      const result = validatePayload('storage:create-chat', {
        title: 'My Chat',
      });
      expect(result.valid).toBe(true);
    });

    it('should accept storage:save-message', () => {
      const result = validatePayload('storage:save-message', {
        chatId: '550e8400-e29b-41d4-a716-446655440000',
        message: { role: 'user', content: 'hi' },
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('optional-schema channels', () => {
    it('should accept null/undefined for session:get-stats', () => {
      expect(validatePayload('session:get-stats', undefined).valid).toBe(true);
      expect(validatePayload('session:get-stats', null).valid).toBe(true);
    });

    it('should accept empty object for storage:load-chats', () => {
      expect(validatePayload('storage:load-chats', {}).valid).toBe(true);
    });

    it('should accept null for storage:health-check', () => {
      expect(validatePayload('storage:health-check', null).valid).toBe(true);
    });
  });

  describe('exception handling', () => {
    it('should catch and return error for payloads that cause exceptions', () => {
      // Force an exception by passing a value that makes JSON.stringify throw
      // (circular reference)
      const circular = {};
      circular.self = circular;
      // validatePayload should not throw — it catches and returns { valid: false }
      // Actually, the circular reference wouldn't cause a throw in validateValue
      // because it only uses typeof, not JSON.stringify.
      // Let's test with a getter that throws.
      const nasty = {
        get type() { throw new Error('getter exploded'); },
      };
      const result = validatePayload('chat:window-control', nasty);
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});

// ============================================================================
// getSchema()
// ============================================================================
describe('getSchema()', () => {
  it('should return schema for known channel', () => {
    const schema = getSchema('chat:send');
    expect(schema).toBeDefined();
    expect(schema.description).toBe('Send chat message');
    expect(schema.schema.type).toBe('object');
  });

  it('should return null for unknown channel', () => {
    expect(getSchema('nonexistent:channel')).toBeNull();
  });
});

// ============================================================================
// hasSchema()
// ============================================================================
describe('hasSchema()', () => {
  it('should return true for known channels', () => {
    expect(hasSchema('chat:send')).toBe(true);
    expect(hasSchema('chat:window-control')).toBe(true);
    expect(hasSchema('renderer-log')).toBe(true);
  });

  it('should return false for unknown channels', () => {
    expect(hasSchema('nonexistent:channel')).toBe(false);
    expect(hasSchema('')).toBe(false);
  });
});
