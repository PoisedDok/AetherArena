'use strict';

const { normalizeArtifactPayload } = require('../../../../../src/domain/artifacts/utils/ArtifactNormalizer');

// --- Helpers ---

/** Minimal valid streaming artifact */
function streamingArtifact(overrides = {}) {
  return {
    artifact_id: 'art-001',
    request_id: 'req-001',
    role: 'assistant',
    type: 'code',
    chat_id: 'chat-001',
    format: 'javascript',
    execution_group: 'eg-001',
    timestamp: Date.now(),
    content: 'const x = 1;',
    ...overrides
  };
}

/** Minimal valid persisted artifact (PostgreSQL row) */
function persistedArtifact(overrides = {}) {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    artifact_id: '550e8400-e29b-41d4-a716-446655440000:code:1',
    type: 'code',
    chat_id: 'chat-001',
    created_at: '2025-01-01T00:00:00Z',
    content: 'print("hello")',
    ...overrides
  };
}

describe('normalizeArtifactPayload', () => {
  // --- Streaming artifacts ---
  describe('streaming artifacts', () => {
    it('normalizes a valid streaming artifact', () => {
      const raw = streamingArtifact();
      const n = normalizeArtifactPayload(raw);

      expect(n.id).toBe('art-001');
      expect(n.artifactId).toBe('art-001');
      expect(n.requestId).toBe('req-001');
      expect(n.role).toBe('assistant');
      expect(n.type).toBe('code');
      expect(n.chatId).toBe('chat-001');
      expect(n.format).toBe('javascript');
      expect(n.executionGroup).toBe('eg-001');
      expect(n.content).toBe('const x = 1;');
    });

    it('uses fallbackChatId when chat_id is absent', () => {
      const raw = streamingArtifact({ chat_id: null });
      const n = normalizeArtifactPayload(raw, 'fallback-chat');
      expect(n.chatId).toBe('fallback-chat');
    });

    it('throws when both chat_id and fallbackChatId are absent', () => {
      const raw = streamingArtifact({ chat_id: null });
      expect(() => normalizeArtifactPayload(raw)).toThrow('chatId is required');
    });

    it('throws on missing role for streaming', () => {
      const raw = streamingArtifact({ role: null });
      expect(() => normalizeArtifactPayload(raw)).toThrow('role is required for streaming');
    });

    it('throws on missing request_id for streaming', () => {
      const raw = streamingArtifact({ request_id: null });
      expect(() => normalizeArtifactPayload(raw)).toThrow('request_id is required for streaming');
    });

    it('throws on missing format for streaming', () => {
      const raw = streamingArtifact({ format: null });
      expect(() => normalizeArtifactPayload(raw)).toThrow('format is required for streaming');
    });

    it('throws on missing execution_group for streaming non-file', () => {
      const raw = streamingArtifact({ execution_group: null });
      expect(() => normalizeArtifactPayload(raw)).toThrow('executionGroup is required for streaming');
    });

    it('throws on missing timestamp for streaming', () => {
      const raw = streamingArtifact({ timestamp: null });
      expect(() => normalizeArtifactPayload(raw)).toThrow('timestamp must be a positive number');
    });

    it('extracts optional fields (messageId, parentId, correlationId)', () => {
      const raw = streamingArtifact({
        message_id: 'msg-1', parent_id: 'parent-1', correlation_id: 'corr-1'
      });
      const n = normalizeArtifactPayload(raw);
      expect(n.messageId).toBe('msg-1');
      expect(n.parentId).toBe('parent-1');
      expect(n.correlationId).toBe('corr-1');
    });

    it('normalizes role to lowercase', () => {
      const n = normalizeArtifactPayload(streamingArtifact({ role: 'ASSISTANT' }));
      expect(n.role).toBe('assistant');
    });

    it('normalizes type to lowercase', () => {
      const n = normalizeArtifactPayload(streamingArtifact({ type: 'CODE' }));
      expect(n.type).toBe('code');
    });
  });

  // --- Persisted artifacts ---
  describe('persisted artifacts', () => {
    it('normalizes a valid persisted artifact', () => {
      const raw = persistedArtifact();
      const n = normalizeArtifactPayload(raw);

      expect(n.postgresqlId).toBe('550e8400-e29b-41d4-a716-446655440000');
      expect(n.artifactId).toBe('550e8400-e29b-41d4-a716-446655440000:code:1');
      expect(n.chatId).toBe('chat-001');
    });

    it('derives role from type for persisted artifacts', () => {
      expect(normalizeArtifactPayload(persistedArtifact({ type: 'code' })).role).toBe('assistant');
      expect(normalizeArtifactPayload(persistedArtifact({ type: 'output' })).role).toBe('computer');
      expect(normalizeArtifactPayload(persistedArtifact({ type: 'console' })).role).toBe('computer');
      // file type requires filename
      expect(normalizeArtifactPayload(persistedArtifact({ type: 'file', filename: 'data.csv' })).role).toBe('user');
    });

    it('derives request_id from artifact_id UUID prefix', () => {
      const n = normalizeArtifactPayload(persistedArtifact());
      expect(n.requestId).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('derives format from type for persisted artifacts', () => {
      expect(normalizeArtifactPayload(persistedArtifact({ type: 'html' })).format).toBe('html');
      expect(normalizeArtifactPayload(persistedArtifact({ type: 'markdown' })).format).toBe('markdown');
      expect(normalizeArtifactPayload(persistedArtifact({ type: 'output' })).format).toBe('text');
    });

    it('derives format from language for code type', () => {
      const n = normalizeArtifactPayload(persistedArtifact({ type: 'code', language: 'python' }));
      expect(n.format).toBe('python');
    });

    it('converts created_at ISO string to timestamp', () => {
      const n = normalizeArtifactPayload(persistedArtifact({ created_at: '2025-06-15T10:00:00Z' }));
      expect(n.timestamp).toBe(Date.parse('2025-06-15T10:00:00Z'));
    });

    it('handles createdAt (camelCase) too', () => {
      const raw = persistedArtifact({ created_at: undefined, createdAt: '2025-06-15T10:00:00Z' });
      const n = normalizeArtifactPayload(raw);
      expect(n.timestamp).toBe(Date.parse('2025-06-15T10:00:00Z'));
    });

    it('derives executionGroup from requestId for persisted', () => {
      const n = normalizeArtifactPayload(persistedArtifact());
      expect(n.executionGroup).toBeTruthy();
    });
  });

  // --- Filename derivation ---
  describe('filename derivation', () => {
    it('derives filename for assistant:code', () => {
      const n = normalizeArtifactPayload(streamingArtifact({ role: 'assistant', type: 'code', format: 'py' }));
      expect(n.filename).toBe('code.py');
    });

    it('derives filename for computer:output', () => {
      const n = normalizeArtifactPayload(streamingArtifact({ role: 'computer', type: 'output', format: 'text' }));
      expect(n.filename).toBe('output.text');
    });

    it('preserves explicit filename', () => {
      const n = normalizeArtifactPayload(streamingArtifact({ filename: 'custom.py' }));
      expect(n.filename).toBe('custom.py');
    });

    it('throws when file type lacks filename', () => {
      const raw = streamingArtifact({ type: 'file', filename: null });
      expect(() => normalizeArtifactPayload(raw)).toThrow('filename is required for file artifacts');
    });
  });

  // --- Contract violations ---
  describe('contract violations', () => {
    it('throws on null input', () => {
      expect(() => normalizeArtifactPayload(null)).toThrow('CONTRACT VIOLATION');
    });

    it('throws on non-object input', () => {
      expect(() => normalizeArtifactPayload('string')).toThrow('CONTRACT VIOLATION');
    });

    it('throws on missing type', () => {
      expect(() => normalizeArtifactPayload({ artifact_id: 'a1', request_id: 'r1' })).toThrow('type is required');
    });

    it('throws on missing artifact_id AND id', () => {
      expect(() => normalizeArtifactPayload(streamingArtifact({ artifact_id: null })))
        .toThrow('artifact_id or id is required');
    });

    it('content defaults to empty string when not provided', () => {
      const raw = streamingArtifact({ content: undefined });
      const n = normalizeArtifactPayload(raw);
      expect(n.content).toBe('');
    });

    it('preserves metadata object', () => {
      const raw = streamingArtifact({ metadata: { custom: 'val' } });
      const n = normalizeArtifactPayload(raw);
      expect(n.metadata.custom).toBe('val');
    });

    it('creates empty metadata when not provided', () => {
      const raw = streamingArtifact({ metadata: null });
      const n = normalizeArtifactPayload(raw);
      expect(n.metadata).toEqual({});
    });
  });
});
