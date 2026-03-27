'use strict';

const { Artifact } = require('../../../../../src/domain/artifacts/models/Artifact');

describe('Artifact Domain Model', () => {
  describe('Constructor', () => {
    it('should create artifact with defaults', () => {
      const art = new Artifact();
      expect(art.id).toMatch(/^art_/);
      expect(art.type).toBe('code');
      expect(art.format).toBe('text');
      expect(art.content).toBe('');
      expect(art.status).toBe('active');
      expect(art.sourceMessageId).toBeNull();
      expect(art.chatId).toBeNull();
      expect(art.serverId).toBeNull();
      expect(art.subgroupId).toBeNull();
      expect(art.nodeId).toBeNull();
      expect(art.executionGroup).toBeNull();
    });

    it('should create artifact with provided data', () => {
      const art = new Artifact({
        id: 'art-1', type: 'html', format: 'html',
        content: '<div>Hello</div>', sourceMessageId: 'msg-1',
        chatId: 'chat-1', status: 'streaming'
      });
      expect(art.id).toBe('art-1');
      expect(art.type).toBe('html');
      expect(art.content).toBe('<div>Hello</div>');
      expect(art.status).toBe('streaming');
    });

    it('should be frozen (immutable)', () => {
      const art = new Artifact({ id: 'art-1' });
      expect(() => { art.content = 'changed'; }).toThrow();
    });

    it('should freeze metadata', () => {
      const art = new Artifact({ metadata: { key: 'val' } });
      expect(() => { art.metadata.key = 'changed'; }).toThrow();
    });

    it('should handle snake_case fields', () => {
      const art = new Artifact({
        subgroup_id: 'sg-1', node_id: 'n-1', execution_group: 'eg-1'
      });
      expect(art.subgroupId).toBe('sg-1');
      expect(art.nodeId).toBe('n-1');
      expect(art.executionGroup).toBe('eg-1');
    });
  });

  describe('ID generation', () => {
    it('should generate unique IDs', () => {
      const a1 = new Artifact();
      const a2 = new Artifact();
      expect(a1.id).not.toBe(a2.id);
      expect(a1.id).toMatch(/^art_\d+_[a-z0-9]+$/);
    });

    it('should generate ID with kind suffix', () => {
      const id = Artifact.generateIdWithKind('base-123', 'code');
      expect(id).toBe('base-123_code');
    });
  });

  describe('File operations', () => {
    it('should generate filename', () => {
      const art = new Artifact({ type: 'code', format: 'py', timestamp: 1704067200000 });
      const name = art.generateFileName();
      expect(name).toMatch(/^code_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.py$/);
    });

    it('should resolve extension by type', () => {
      expect(new Artifact({ type: 'output' }).generateFileName()).toMatch(/\.txt$/);
      expect(new Artifact({ type: 'html' }).generateFileName()).toMatch(/\.html$/);
      expect(new Artifact({ type: 'code', format: 'js' }).generateFileName()).toMatch(/\.js$/);
    });
  });

  describe('Language resolution', () => {
    it('should map format to language for code', () => {
      expect(new Artifact({ type: 'code', format: 'py' }).resolveLanguage()).toBe('python');
      expect(new Artifact({ type: 'code', format: 'js' }).resolveLanguage()).toBe('javascript');
      expect(new Artifact({ type: 'code', format: 'ts' }).resolveLanguage()).toBe('typescript');
      expect(new Artifact({ type: 'code', format: 'jsx' }).resolveLanguage()).toBe('javascript');
      expect(new Artifact({ type: 'code', format: 'tsx' }).resolveLanguage()).toBe('typescript');
      expect(new Artifact({ type: 'code', format: 'sh' }).resolveLanguage()).toBe('shell');
      expect(new Artifact({ type: 'code', format: 'rb' }).resolveLanguage()).toBe('ruby');
    });

    it('should return null for non-code types', () => {
      expect(new Artifact({ type: 'output' }).resolveLanguage()).toBeNull();
      expect(new Artifact({ type: 'html' }).resolveLanguage()).toBeNull();
    });

    it('should fall through to format for unknown mappings', () => {
      expect(new Artifact({ type: 'code', format: 'zig' }).resolveLanguage()).toBe('zig');
    });
  });

  describe('State checks', () => {
    it('should check message linkage', () => {
      expect(new Artifact({ sourceMessageId: 'msg-1' }).hasMessageLink()).toBe(true);
      expect(new Artifact().hasMessageLink()).toBe(false);
    });

    it('should check persistence', () => {
      expect(new Artifact({ serverId: 'uuid-1' }).isPersisted()).toBe(true);
      expect(new Artifact().isPersisted()).toBe(false);
    });

    it('should check emptiness', () => {
      expect(new Artifact({ content: '' }).isEmpty()).toBe(true);
      expect(new Artifact({ content: '   ' }).isEmpty()).toBe(true);
      expect(new Artifact({ content: 'code' }).isEmpty()).toBe(false);
    });

    it('should check streamable types', () => {
      expect(new Artifact({ type: 'code' }).isStreamable()).toBe(true);
      expect(new Artifact({ type: 'output' }).isStreamable()).toBe(true);
      expect(new Artifact({ type: 'html' }).isStreamable()).toBe(true);
      expect(new Artifact({ type: 'file' }).isStreamable()).toBe(false);
    });
  });

  describe('Immutable updates', () => {
    it('should create updated artifact', () => {
      const art = new Artifact({ id: 'a1', content: 'old' });
      const updated = art.update({ content: 'new' });
      expect(updated.content).toBe('new');
      expect(updated.id).toBe('a1');
      expect(updated.updatedAt).toBeTruthy();
      expect(art.content).toBe('old');
    });

    it('should create artifact with new status', () => {
      const art = new Artifact({ status: 'streaming' });
      const archived = art.withStatus('archived');
      expect(archived.status).toBe('archived');
    });

    it('should create artifact with server ID', () => {
      const art = new Artifact();
      const persisted = art.withServerId('uuid-1');
      expect(persisted.serverId).toBe('uuid-1');
    });

    it('should create artifact with message link', () => {
      const art = new Artifact();
      const linked = art.withMessageLink('msg-1', 'corr-1');
      expect(linked.sourceMessageId).toBe('msg-1');
      expect(linked.correlationId).toBe('corr-1');
    });
  });

  describe('Serialization', () => {
    it('should serialize to JSON', () => {
      const art = new Artifact({
        id: 'a1', type: 'code', content: 'hello', format: 'py',
        chatId: 'c1', sourceMessageId: 'm1', subgroupId: 'sg1', nodeId: 'n1'
      });
      const json = art.toJSON();
      expect(json.id).toBe('a1');
      expect(json.type).toBe('code');
      expect(json.subgroupId).toBe('sg1');
      expect(json.nodeId).toBe('n1');
    });

    it('should round-trip through JSON', () => {
      const original = new Artifact({
        id: 'a1', type: 'code', format: 'js', content: 'const x = 1;',
        chatId: 'c1', sourceMessageId: 'm1'
      });
      const restored = Artifact.fromJSON(original.toJSON());
      expect(restored.id).toBe(original.id);
      expect(restored.content).toBe(original.content);
    });

    it('should serialize to PostgreSQL format', () => {
      const art = new Artifact({
        id: 'a1', type: 'code', format: 'py', content: 'print()',
        sourceMessageId: 'm1', chatId: 'c1', subgroupId: 'sg1', nodeId: 'n1'
      });
      const pg = art.toPostgreSQLFormat();
      expect(pg.artifact_id).toBe('a1');
      expect(pg.message_id).toBe('m1');
      expect(pg.chat_id).toBe('c1');
      expect(pg.language).toBe('python');
      expect(pg.subgroup_id).toBe('sg1');
      expect(pg.node_id).toBe('n1');
    });

    it('should create from PostgreSQL row', () => {
      const row = {
        id: 'uuid-1', artifact_id: 'a1', type: 'code',
        content: 'code', language: 'python',
        message_id: 'm1', chat_id: 'c1',
        subgroup_id: 'sg1', node_id: 'n1',
        created_at: '2024-01-01T00:00:00Z',
        metadata: { format: 'py' }
      };
      const art = Artifact.fromPostgreSQLRow(row);
      expect(art.id).toBe('uuid-1');
      expect(art.artifact_id).toBe('a1');
      expect(art.serverId).toBe('uuid-1');
      expect(art.chatId).toBe('c1');
      expect(art.subgroupId).toBe('sg1');
    });
  });

  describe('Factory methods', () => {
    it('should create from stream data', () => {
      const art = Artifact.fromStreamData({
        id: 'a1', kind: 'code', content: 'x = 1',
        format: 'py', language: 'python',
        sourceMessageId: 'm1', correlationId: 'c1', chatId: 'ch1'
      });
      expect(art.id).toBe('a1');
      expect(art.type).toBe('code');
      expect(art.status).toBe('streaming');
    });

    it('should create placeholder', () => {
      const placeholder = Artifact.createPlaceholder('html');
      expect(placeholder.type).toBe('html');
      expect(placeholder.status).toBe('streaming');
      expect(placeholder.content).toBe('');
    });
  });
});
