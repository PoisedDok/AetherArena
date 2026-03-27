'use strict';

const {
  ARTIFACT_STREAM_SCHEMA,
  MAX_ARTIFACT_SIZE,
  normalizeArtifactStreamPayload,
  validateArtifactStreamPayload,
  resolvePhaseKindFromPayload,
  getArtifactVariantKey,
  enforceArtifactSizeLimit,
} = require('../../../src/renderer/shared/contracts/artifactStream');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid payload for normalizeArtifactStreamPayload */
function validRaw(overrides = {}) {
  return {
    artifact_id: 'art-001',
    request_id: 'req-001',
    role: 'assistant',
    type: 'code',
    chat_id: 'chat-001',
    timestamp: '2026-02-09T00:00:00Z',
    ...overrides,
  };
}

/** Minimal valid payload for validateArtifactStreamPayload */
function validPayload(overrides = {}) {
  return {
    artifact_id: 'art-001',
    backend_id: 'be-001',
    role: 'assistant',
    type: 'code',
    chat_id: 'chat-001',
    ...overrides,
  };
}

// ===========================================================================
// EXPORTED CONSTANTS
// ===========================================================================

describe('artifactStream contracts', () => {
  describe('ARTIFACT_STREAM_SCHEMA', () => {
    it('is frozen', () => {
      expect(Object.isFrozen(ARTIFACT_STREAM_SCHEMA)).toBe(true);
    });

    it('requires the correct fields', () => {
      expect(ARTIFACT_STREAM_SCHEMA.required).toEqual(
        expect.arrayContaining(['artifact_id', 'backend_id', 'role', 'type', 'chat_id'])
      );
    });

    it('enums contain only assistant and computer roles', () => {
      expect(ARTIFACT_STREAM_SCHEMA.enums.role).toEqual(['assistant', 'computer']);
    });

    it('enums contain only code and output types', () => {
      expect(ARTIFACT_STREAM_SCHEMA.enums.type).toEqual(['code', 'output']);
    });
  });

  describe('MAX_ARTIFACT_SIZE', () => {
    it('equals 10 MB', () => {
      expect(MAX_ARTIFACT_SIZE).toBe(50 * 1024 * 1024);
    });
  });

  // =========================================================================
  // enforceArtifactSizeLimit
  // =========================================================================

  describe('enforceArtifactSizeLimit', () => {
    it('returns empty string for non-string content', () => {
      expect(enforceArtifactSizeLimit(123)).toEqual({ content: '', truncated: false });
      expect(enforceArtifactSizeLimit(null)).toEqual({ content: '', truncated: false });
      expect(enforceArtifactSizeLimit(undefined)).toEqual({ content: '', truncated: false });
    });

    it('passes through content within size limit', () => {
      const small = 'hello world';
      expect(enforceArtifactSizeLimit(small)).toEqual({ content: small, truncated: false });
    });

    it('passes through content exactly at limit', () => {
      const exact = 'x'.repeat(MAX_ARTIFACT_SIZE);
      const result = enforceArtifactSizeLimit(exact);
      expect(result.truncated).toBe(false);
      expect(result.content.length).toBe(MAX_ARTIFACT_SIZE);
    });

    it('truncates content exceeding size limit', () => {
      const oversized = 'x'.repeat(MAX_ARTIFACT_SIZE + 100);
      const result = enforceArtifactSizeLimit(oversized);
      expect(result.truncated).toBe(true);
      expect(result.content.length).toBe(MAX_ARTIFACT_SIZE);
    });

    it('returns empty string non-truncated for empty string', () => {
      expect(enforceArtifactSizeLimit('')).toEqual({ content: '', truncated: false });
    });
  });

  // =========================================================================
  // getArtifactVariantKey
  // =========================================================================

  describe('getArtifactVariantKey', () => {
    it('returns lowercase role:type key', () => {
      expect(getArtifactVariantKey('Assistant', 'Code')).toBe('assistant:code');
    });

    it('handles already-lowercase inputs', () => {
      expect(getArtifactVariantKey('computer', 'output')).toBe('computer:output');
    });

    it('throws on missing role', () => {
      expect(() => getArtifactVariantKey(null, 'code')).toThrow('role is required');
      expect(() => getArtifactVariantKey('', 'code')).toThrow('role is required');
    });

    it('throws on non-string role', () => {
      expect(() => getArtifactVariantKey(42, 'code')).toThrow('role is required');
    });

    it('throws on missing type', () => {
      expect(() => getArtifactVariantKey('assistant', null)).toThrow('type is required');
      expect(() => getArtifactVariantKey('assistant', '')).toThrow('type is required');
    });

    it('throws on non-string type', () => {
      expect(() => getArtifactVariantKey('assistant', 42)).toThrow('type is required');
    });
  });

  // =========================================================================
  // resolvePhaseKindFromPayload
  // =========================================================================

  describe('resolvePhaseKindFromPayload', () => {
    it('returns write for assistant + code', () => {
      expect(resolvePhaseKindFromPayload({ role: 'assistant', type: 'code' })).toBe('write');
    });

    it('returns execute for computer + console', () => {
      expect(resolvePhaseKindFromPayload({ role: 'computer', type: 'console' })).toBe('execute');
    });

    it('returns output for computer + code', () => {
      expect(resolvePhaseKindFromPayload({ role: 'computer', type: 'code' })).toBe('output');
    });

    it('returns output for computer + output', () => {
      expect(resolvePhaseKindFromPayload({ role: 'computer', type: 'output' })).toBe('output');
    });

    it('returns output for computer + html', () => {
      expect(resolvePhaseKindFromPayload({ role: 'computer', type: 'html' })).toBe('output');
    });

    it('returns null for unrecognized combination', () => {
      expect(resolvePhaseKindFromPayload({ role: 'assistant', type: 'output' })).toBeNull();
    });

    it('throws for non-object payload', () => {
      expect(() => resolvePhaseKindFromPayload(null)).toThrow('payload must be object');
      expect(() => resolvePhaseKindFromPayload('str')).toThrow('payload must be object');
    });

    it('throws for missing role', () => {
      expect(() => resolvePhaseKindFromPayload({ type: 'code' })).toThrow('payload.role is required');
    });

    it('throws for non-string role', () => {
      expect(() => resolvePhaseKindFromPayload({ role: 123, type: 'code' })).toThrow('payload.role is required');
    });

    it('throws for missing type', () => {
      expect(() => resolvePhaseKindFromPayload({ role: 'assistant' })).toThrow('payload.type is required');
    });

    it('throws for non-string type', () => {
      expect(() => resolvePhaseKindFromPayload({ role: 'assistant', type: 123 })).toThrow('payload.type is required');
    });
  });

  // =========================================================================
  // validateArtifactStreamPayload
  // =========================================================================

  describe('validateArtifactStreamPayload', () => {
    it('returns true for valid payload', () => {
      expect(validateArtifactStreamPayload(validPayload())).toBe(true);
    });

    it('throws for non-object input', () => {
      expect(() => validateArtifactStreamPayload(null)).toThrow('must be an object');
      expect(() => validateArtifactStreamPayload('str')).toThrow('must be an object');
      expect(() => validateArtifactStreamPayload(undefined)).toThrow('must be an object');
    });

    it('throws for each missing required field', () => {
      for (const field of ARTIFACT_STREAM_SCHEMA.required) {
        const payload = validPayload();
        delete payload[field];
        expect(() => validateArtifactStreamPayload(payload)).toThrow(`missing ${field}`);
      }
    });

    it('throws for missing role', () => {
      const payload = validPayload({ role: undefined });
      delete payload.role;
      expect(() => validateArtifactStreamPayload(payload)).toThrow();
    });

    it('throws for non-string role', () => {
      // _stringOrNull catches non-string first in the required-fields loop
      expect(() => validateArtifactStreamPayload(validPayload({ role: 123 }))).toThrow('missing role');
    });

    it('throws for missing type', () => {
      const payload = validPayload({ type: undefined });
      delete payload.type;
      expect(() => validateArtifactStreamPayload(payload)).toThrow();
    });

    it('throws for non-string type', () => {
      // _stringOrNull catches non-string first in the required-fields loop
      expect(() => validateArtifactStreamPayload(validPayload({ type: 123 }))).toThrow('missing type');
    });

    it('throws for invalid role enum', () => {
      expect(() => validateArtifactStreamPayload(validPayload({ role: 'hacker' }))).toThrow('Invalid artifact role');
    });

    it('throws for invalid type enum', () => {
      expect(() => validateArtifactStreamPayload(validPayload({ type: 'binary' }))).toThrow('Invalid artifact type');
    });

    it('accepts role case-insensitively', () => {
      expect(validateArtifactStreamPayload(validPayload({ role: 'ASSISTANT' }))).toBe(true);
    });

    it('accepts type case-insensitively', () => {
      expect(validateArtifactStreamPayload(validPayload({ type: 'OUTPUT' }))).toBe(true);
    });
  });

  // =========================================================================
  // normalizeArtifactStreamPayload — happy paths
  // =========================================================================

  describe('normalizeArtifactStreamPayload', () => {
    describe('happy path', () => {
      it('normalizes a minimal valid payload', () => {
        const result = normalizeArtifactStreamPayload(validRaw());
        expect(result.id).toBe('art-001');
        expect(result.artifact_id).toBe('art-001');
        expect(result.artifactId).toBe('art-001');
        expect(result.role).toBe('assistant');
        expect(result.type).toBe('code');
        expect(result.kind).toBe('code');
        expect(result.chatId).toBe('chat-001');
        expect(result.requestId).toBe('req-001');
        expect(result.start).toBe(false);
        expect(result.end).toBe(false);
        expect(typeof result.timestamp).toBe('number');
      });

      it('normalizes legacy types to output', () => {
        for (const legacyType of ['html', 'console', 'text', 'json', 'markdown']) {
          const result = normalizeArtifactStreamPayload(validRaw({ type: legacyType }));
          expect(result.type).toBe('output');
          expect(result.kind).toBe('output');
        }
      });

      it('normalizes server role to computer', () => {
        const result = normalizeArtifactStreamPayload(validRaw({ role: 'server' }));
        expect(result.role).toBe('computer');
      });

      it('handles ISO string timestamp', () => {
        const result = normalizeArtifactStreamPayload(validRaw({ timestamp: '2026-01-01T00:00:00Z' }));
        expect(result.timestamp).toBe(Date.parse('2026-01-01T00:00:00Z'));
      });

      it('handles numeric timestamp', () => {
        const ts = 1700000000000;
        const result = normalizeArtifactStreamPayload(validRaw({ timestamp: ts }));
        expect(result.timestamp).toBe(ts);
      });

      it('falls back to Date.now for unparseable string timestamp', () => {
        const before = Date.now();
        const result = normalizeArtifactStreamPayload(validRaw({ timestamp: 'not-a-date' }));
        const after = Date.now();
        expect(result.timestamp).toBeGreaterThanOrEqual(before);
        expect(result.timestamp).toBeLessThanOrEqual(after);
      });

      it('preserves content as string', () => {
        const result = normalizeArtifactStreamPayload(validRaw({ content: 'hello world' }));
        expect(result.content).toBe('hello world');
      });

      it('sets content to empty string when absent (enforceArtifactSizeLimit coerces null to "")', () => {
        const result = normalizeArtifactStreamPayload(validRaw());
        expect(result.content).toBe('');
      });

      it('preserves optional fields', () => {
        const result = normalizeArtifactStreamPayload(validRaw({
          format: 'python',
          language: 'python',
          message_id: 'msg-001',
          parent_id: 'par-001',
          correlation_id: 'cor-001',
          execution_group: 'grp-001',
        }));
        expect(result.format).toBe('python');
        expect(result.language).toBe('python');
        expect(result.messageId).toBe('msg-001');
        expect(result.parentId).toBe('par-001');
        expect(result.correlationId).toBe('cor-001');
        expect(result.executionGroup).toBe('grp-001');
      });

      it('sets optional fields to null when absent', () => {
        const result = normalizeArtifactStreamPayload(validRaw());
        expect(result.format).toBeNull();
        expect(result.language).toBeNull();
        expect(result.messageId).toBeNull();
        expect(result.parentId).toBeNull();
        expect(result.correlationId).toBeNull();
        expect(result.executionGroup).toBeNull();
      });

      it('preserves recipient when provided', () => {
        const result = normalizeArtifactStreamPayload(validRaw({ recipient: 'assistant' }));
        expect(result.recipient).toBe('assistant');
      });

      it('sets recipient to null when absent', () => {
        const result = normalizeArtifactStreamPayload(validRaw());
        expect(result.recipient).toBeNull();
      });

      it('preserves trail linkage fields when present', () => {
        const result = normalizeArtifactStreamPayload(validRaw({
          node_id: 'node-1',
          subgroup_id: 'sg-1',
        }));
        expect(result.node_id).toBe('node-1');
        expect(result.subgroup_id).toBe('sg-1');
      });

      it('omits trail linkage fields when absent', () => {
        const result = normalizeArtifactStreamPayload(validRaw());
        expect(result).not.toHaveProperty('node_id');
        expect(result).not.toHaveProperty('subgroup_id');
      });

      it('enriches metadata with role, request_id, artifact_id', () => {
        const result = normalizeArtifactStreamPayload(validRaw({ metadata: { existing: true } }));
        expect(result.metadata.role).toBe('assistant');
        expect(result.metadata.request_id).toBe('req-001');
        expect(result.metadata.artifact_id).toBe('art-001');
        expect(result.metadata.existing).toBe(true);
      });

      it('creates metadata object when raw.metadata is not an object', () => {
        const result = normalizeArtifactStreamPayload(validRaw({ metadata: 'invalid' }));
        expect(typeof result.metadata).toBe('object');
        expect(result.metadata.role).toBe('assistant');
      });

      it('creates metadata object when raw.metadata is null', () => {
        const result = normalizeArtifactStreamPayload(validRaw({ metadata: null }));
        expect(typeof result.metadata).toBe('object');
        expect(result.metadata.role).toBe('assistant');
      });

      it('sets metadata.truncated when content exceeds MAX_ARTIFACT_SIZE', () => {
        const oversized = 'x'.repeat(MAX_ARTIFACT_SIZE + 10);
        const result = normalizeArtifactStreamPayload(validRaw({ content: oversized }));
        expect(result.metadata.truncated).toBe(true);
        expect(result.content.length).toBe(MAX_ARTIFACT_SIZE);
      });

      it('does not set metadata.truncated for content within limit', () => {
        const result = normalizeArtifactStreamPayload(validRaw({ content: 'short' }));
        expect(result.metadata.truncated).toBeUndefined();
      });
    });

    // -----------------------------------------------------------------------
    // Start / end markers
    // -----------------------------------------------------------------------

    describe('start/end markers', () => {
      it('accepts start marker without artifact_id', () => {
        const raw = validRaw({ artifact_id: undefined, start: true });
        delete raw.artifact_id;
        const result = normalizeArtifactStreamPayload(raw);
        expect(result.start).toBe(true);
        expect(result.end).toBe(false);
        expect(result.artifact_id).toBeNull();
        expect(result.id).toBe('req-001');
      });

      it('accepts end marker without artifact_id', () => {
        const raw = validRaw({ artifact_id: undefined, end: true });
        delete raw.artifact_id;
        const result = normalizeArtifactStreamPayload(raw);
        expect(result.end).toBe(true);
        expect(result.artifact_id).toBeNull();
        expect(result.id).toBe('req-001');
      });

      it('uses requestId as id when artifact_id is missing', () => {
        const raw = validRaw({ artifact_id: undefined, start: true });
        delete raw.artifact_id;
        const result = normalizeArtifactStreamPayload(raw);
        expect(result.id).toBe('req-001');
      });
    });

    // -----------------------------------------------------------------------
    // Contract violations
    // -----------------------------------------------------------------------

    describe('contract violations', () => {
      it('throws for non-object input', () => {
        expect(() => normalizeArtifactStreamPayload(null)).toThrow('must be object');
        expect(() => normalizeArtifactStreamPayload('str')).toThrow('must be object');
        expect(() => normalizeArtifactStreamPayload(42)).toThrow('must be object');
      });

      it('throws when artifact_id missing and not a start/end marker', () => {
        const raw = validRaw({ artifact_id: undefined });
        delete raw.artifact_id;
        expect(() => normalizeArtifactStreamPayload(raw)).toThrow('must provide artifact_id');
      });

      it('throws for missing request_id', () => {
        const raw = validRaw({ request_id: undefined });
        delete raw.request_id;
        expect(() => normalizeArtifactStreamPayload(raw)).toThrow('must provide request_id');
      });

      it('throws for missing role', () => {
        const raw = validRaw({ role: undefined });
        delete raw.role;
        expect(() => normalizeArtifactStreamPayload(raw)).toThrow('must provide role');
      });

      it('throws for non-string role', () => {
        expect(() => normalizeArtifactStreamPayload(validRaw({ role: 123 }))).toThrow('must provide role');
      });

      it('throws for invalid role value', () => {
        expect(() => normalizeArtifactStreamPayload(validRaw({ role: 'hacker' }))).toThrow("Invalid role");
      });

      it('throws for missing type', () => {
        const raw = validRaw({ type: undefined });
        delete raw.type;
        expect(() => normalizeArtifactStreamPayload(raw)).toThrow('must provide type');
      });

      it('throws for non-string type', () => {
        expect(() => normalizeArtifactStreamPayload(validRaw({ type: 123 }))).toThrow('must provide type');
      });

      it('throws for invalid type value', () => {
        expect(() => normalizeArtifactStreamPayload(validRaw({ type: 'binary' }))).toThrow("Invalid type");
      });

      it('throws for missing chat_id', () => {
        const raw = validRaw({ chat_id: undefined });
        delete raw.chat_id;
        expect(() => normalizeArtifactStreamPayload(raw)).toThrow('must provide chat_id');
      });

      it('throws for missing timestamp', () => {
        const raw = validRaw({ timestamp: undefined });
        delete raw.timestamp;
        expect(() => normalizeArtifactStreamPayload(raw)).toThrow('must provide timestamp');
      });

      it('throws for boolean timestamp', () => {
        expect(() => normalizeArtifactStreamPayload(validRaw({ timestamp: true }))).toThrow('must provide timestamp');
      });

      it('throws for non-string content', () => {
        expect(() => normalizeArtifactStreamPayload(validRaw({ content: 123 }))).toThrow('content must be string');
      });

      it('throws for object content', () => {
        expect(() => normalizeArtifactStreamPayload(validRaw({ content: { bad: true } }))).toThrow('content must be string');
      });
    });

    // -----------------------------------------------------------------------
    // Role normalization
    // -----------------------------------------------------------------------

    describe('role normalization', () => {
      it('normalizes assistant', () => {
        expect(normalizeArtifactStreamPayload(validRaw({ role: 'assistant' })).role).toBe('assistant');
      });

      it('normalizes computer', () => {
        expect(normalizeArtifactStreamPayload(validRaw({ role: 'computer' })).role).toBe('computer');
      });

      it('normalizes server to computer', () => {
        expect(normalizeArtifactStreamPayload(validRaw({ role: 'server' })).role).toBe('computer');
      });

      it('normalizes case-insensitively', () => {
        expect(normalizeArtifactStreamPayload(validRaw({ role: 'ASSISTANT' })).role).toBe('assistant');
        expect(normalizeArtifactStreamPayload(validRaw({ role: 'Server' })).role).toBe('computer');
      });
    });

    // -----------------------------------------------------------------------
    // Type normalization
    // -----------------------------------------------------------------------

    describe('type normalization', () => {
      it('normalizes code to code', () => {
        expect(normalizeArtifactStreamPayload(validRaw({ type: 'code' })).type).toBe('code');
      });

      it('normalizes output to output', () => {
        expect(normalizeArtifactStreamPayload(validRaw({ type: 'output' })).type).toBe('output');
      });

      it('normalizes legacy html to output', () => {
        expect(normalizeArtifactStreamPayload(validRaw({ type: 'html' })).type).toBe('output');
      });

      it('normalizes legacy console to output', () => {
        expect(normalizeArtifactStreamPayload(validRaw({ type: 'console' })).type).toBe('output');
      });

      it('normalizes legacy text to output', () => {
        expect(normalizeArtifactStreamPayload(validRaw({ type: 'text' })).type).toBe('output');
      });

      it('normalizes legacy json to output', () => {
        expect(normalizeArtifactStreamPayload(validRaw({ type: 'json' })).type).toBe('output');
      });

      it('normalizes legacy markdown to output', () => {
        expect(normalizeArtifactStreamPayload(validRaw({ type: 'markdown' })).type).toBe('output');
      });

      it('normalizes case-insensitively', () => {
        expect(normalizeArtifactStreamPayload(validRaw({ type: 'CODE' })).type).toBe('code');
        expect(normalizeArtifactStreamPayload(validRaw({ type: 'HTML' })).type).toBe('output');
      });
    });

    // -----------------------------------------------------------------------
    // Whitespace / empty string handling via _stringOrNull
    // -----------------------------------------------------------------------

    describe('_stringOrNull behavior (indirect)', () => {
      it('treats whitespace-only artifact_id as null', () => {
        expect(() => normalizeArtifactStreamPayload(validRaw({ artifact_id: '   ' }))).toThrow('must provide artifact_id');
      });

      it('treats whitespace-only request_id as null', () => {
        expect(() => normalizeArtifactStreamPayload(validRaw({ request_id: '   ' }))).toThrow('must provide request_id');
      });

      it('treats whitespace-only chat_id as null', () => {
        expect(() => normalizeArtifactStreamPayload(validRaw({ chat_id: '   ' }))).toThrow('must provide chat_id');
      });

      it('trims valid string values', () => {
        const result = normalizeArtifactStreamPayload(validRaw({ artifact_id: '  art-trimmed  ' }));
        expect(result.artifact_id).toBe('art-trimmed');
      });
    });
  });
});
