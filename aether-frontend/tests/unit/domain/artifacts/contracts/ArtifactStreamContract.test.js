'use strict';

const {
  normalizeArtifactStreamPayload,
  resolvePhaseKindFromPayload,
  getArtifactVariantKey
} = require('../../../../../src/domain/artifacts/contracts/ArtifactStreamContract');

// --- Helpers ---

function validPayload(overrides = {}) {
  return {
    artifact_id: 'art-001',
    request_id: 'req-001',
    role: 'assistant',
    type: 'code',
    chat_id: 'chat-001',
    timestamp: Date.now(),
    ...overrides
  };
}

// --- normalizeArtifactStreamPayload ---

describe('normalizeArtifactStreamPayload', () => {
  describe('happy path', () => {
    it('normalizes a valid assistant:code payload', () => {
      const raw = validPayload({ content: 'const x = 1;', format: 'javascript', language: 'javascript' });
      const n = normalizeArtifactStreamPayload(raw);

      expect(n.artifact_id).toBe('art-001');
      expect(n.artifactId).toBe('art-001');
      expect(n.requestId).toBe('req-001');
      expect(n.id).toBe('req-001');
      expect(n.role).toBe('assistant');
      expect(n.type).toBe('code');
      expect(n.kind).toBe('code');
      expect(n.chatId).toBe('chat-001');
      expect(n.content).toBe('const x = 1;');
      expect(n.format).toBe('javascript');
      expect(n.language).toBe('javascript');
      expect(n.start).toBe(false);
      expect(n.end).toBe(false);
    });

    it('normalizes a computer:output payload', () => {
      const raw = validPayload({ role: 'computer', type: 'output', content: '42' });
      const n = normalizeArtifactStreamPayload(raw);

      expect(n.role).toBe('computer');
      expect(n.type).toBe('output');
    });

    it('maps server role to computer', () => {
      const raw = validPayload({ role: 'server', type: 'output' });
      const n = normalizeArtifactStreamPayload(raw);
      expect(n.role).toBe('computer');
    });

    it('maps html/console/text/json/markdown types to output', () => {
      for (const t of ['html', 'console', 'text', 'json', 'markdown']) {
        const n = normalizeArtifactStreamPayload(validPayload({ type: t }));
        expect(n.type).toBe('output');
      }
    });

    it('preserves start/end markers as booleans', () => {
      const start = normalizeArtifactStreamPayload(validPayload({ start: true, artifact_id: null }));
      expect(start.start).toBe(true);
      expect(start.end).toBe(false);

      const end = normalizeArtifactStreamPayload(validPayload({ end: true }));
      expect(end.end).toBe(true);
    });

    it('sets content to null when not provided', () => {
      const n = normalizeArtifactStreamPayload(validPayload());
      expect(n.content).toBeNull();
    });

    it('preserves optional fields (messageId, parentId, correlationId, executionGroup)', () => {
      const raw = validPayload({
        message_id: 'msg-1',
        parent_id: 'parent-1',
        correlation_id: 'corr-1',
        execution_group: 'eg-1'
      });
      const n = normalizeArtifactStreamPayload(raw);
      expect(n.messageId).toBe('msg-1');
      expect(n.parentId).toBe('parent-1');
      expect(n.correlationId).toBe('corr-1');
      expect(n.executionGroup).toBe('eg-1');
    });

    it('attaches node_id and subgroup_id when present', () => {
      const raw = validPayload({ node_id: 'node-1', subgroup_id: 'sg-1' });
      const n = normalizeArtifactStreamPayload(raw);
      expect(n.node_id).toBe('node-1');
      expect(n.subgroup_id).toBe('sg-1');
    });

    it('enriches metadata with role, request_id, artifact_id', () => {
      const n = normalizeArtifactStreamPayload(validPayload({ metadata: { custom: 'x' } }));
      expect(n.metadata.role).toBe('assistant');
      expect(n.metadata.request_id).toBe('req-001');
      expect(n.metadata.artifact_id).toBe('art-001');
      expect(n.metadata.custom).toBe('x');
    });

    it('parses ISO string timestamps', () => {
      const iso = '2025-06-15T10:00:00Z';
      const n = normalizeArtifactStreamPayload(validPayload({ timestamp: iso }));
      expect(n.timestamp).toBe(Date.parse(iso));
    });

    it('passes through numeric timestamps', () => {
      const ts = 1700000000000;
      const n = normalizeArtifactStreamPayload(validPayload({ timestamp: ts }));
      expect(n.timestamp).toBe(ts);
    });
  });

  describe('contract violations', () => {
    it('throws on null/undefined input', () => {
      expect(() => normalizeArtifactStreamPayload(null)).toThrow('CONTRACT VIOLATION');
      expect(() => normalizeArtifactStreamPayload(undefined)).toThrow('CONTRACT VIOLATION');
    });

    it('throws on non-object input', () => {
      expect(() => normalizeArtifactStreamPayload('string')).toThrow('CONTRACT VIOLATION');
      expect(() => normalizeArtifactStreamPayload(42)).toThrow('CONTRACT VIOLATION');
    });

    it('throws when artifact_id missing for content chunk', () => {
      expect(() => normalizeArtifactStreamPayload(validPayload({ artifact_id: null }))).toThrow('artifact_id');
    });

    it('allows missing artifact_id for start marker', () => {
      const raw = validPayload({ artifact_id: null, start: true });
      expect(() => normalizeArtifactStreamPayload(raw)).not.toThrow();
    });

    it('allows missing artifact_id for end marker', () => {
      const raw = validPayload({ artifact_id: null, end: true });
      expect(() => normalizeArtifactStreamPayload(raw)).not.toThrow();
    });

    it('throws when request_id missing', () => {
      expect(() => normalizeArtifactStreamPayload(validPayload({ request_id: null }))).toThrow('request_id');
    });

    it('throws when role missing', () => {
      expect(() => normalizeArtifactStreamPayload(validPayload({ role: null }))).toThrow('role');
    });

    it('throws on invalid role', () => {
      expect(() => normalizeArtifactStreamPayload(validPayload({ role: 'invalid' }))).toThrow('Invalid role');
    });

    it('throws when type missing', () => {
      expect(() => normalizeArtifactStreamPayload(validPayload({ type: null }))).toThrow('type');
    });

    it('throws on invalid type', () => {
      expect(() => normalizeArtifactStreamPayload(validPayload({ type: 'invalid' }))).toThrow('Invalid type');
    });

    it('throws when chat_id missing', () => {
      expect(() => normalizeArtifactStreamPayload(validPayload({ chat_id: null }))).toThrow('chat_id');
    });

    it('throws when timestamp missing', () => {
      expect(() => normalizeArtifactStreamPayload(validPayload({ timestamp: null }))).toThrow('timestamp');
    });

    it('throws when content is non-string', () => {
      expect(() => normalizeArtifactStreamPayload(validPayload({ content: 42 }))).toThrow('content must be string');
    });
  });
});

// --- resolvePhaseKindFromPayload ---

describe('resolvePhaseKindFromPayload', () => {
  it('returns "write" for assistant:code', () => {
    expect(resolvePhaseKindFromPayload({ role: 'assistant', type: 'code' })).toBe('write');
  });

  it('returns "execute" for computer:console', () => {
    expect(resolvePhaseKindFromPayload({ role: 'computer', type: 'console' })).toBe('execute');
  });

  it('returns "output" for computer:code', () => {
    expect(resolvePhaseKindFromPayload({ role: 'computer', type: 'code' })).toBe('output');
  });

  it('returns "output" for computer:output', () => {
    expect(resolvePhaseKindFromPayload({ role: 'computer', type: 'output' })).toBe('output');
  });

  it('returns "output" for computer:html', () => {
    expect(resolvePhaseKindFromPayload({ role: 'computer', type: 'html' })).toBe('output');
  });

  it('returns null for unrecognized combo', () => {
    expect(resolvePhaseKindFromPayload({ role: 'assistant', type: 'output' })).toBeNull();
  });

  it('throws on null payload', () => {
    expect(() => resolvePhaseKindFromPayload(null)).toThrow('CONTRACT VIOLATION');
  });

  it('throws on missing role', () => {
    expect(() => resolvePhaseKindFromPayload({ type: 'code' })).toThrow('role is required');
  });

  it('throws on missing type', () => {
    expect(() => resolvePhaseKindFromPayload({ role: 'assistant' })).toThrow('type is required');
  });
});

// --- getArtifactVariantKey ---

describe('getArtifactVariantKey', () => {
  it('returns "role:type" lowercase', () => {
    expect(getArtifactVariantKey('assistant', 'code')).toBe('assistant:code');
    expect(getArtifactVariantKey('Computer', 'Output')).toBe('computer:output');
    expect(getArtifactVariantKey('ASSISTANT', 'HTML')).toBe('assistant:html');
  });

  it('throws on missing role', () => {
    expect(() => getArtifactVariantKey(null, 'code')).toThrow('role is required');
    expect(() => getArtifactVariantKey('', 'code')).toThrow('role is required');
  });

  it('throws on missing type', () => {
    expect(() => getArtifactVariantKey('assistant', null)).toThrow('type is required');
    expect(() => getArtifactVariantKey('assistant', '')).toThrow('type is required');
  });
});
