'use strict';

const { Message } = require('../../../../../src/domain/chat/models/Message');

describe('Message Domain Model', () => {
  describe('Constructor', () => {
    it('should create message with defaults', () => {
      const msg = new Message();
      expect(msg.id).toBeNull();
      expect(msg.chatId).toBeNull();
      expect(msg.role).toBe('user');
      expect(msg.content).toBe('');
      expect(msg.status).toBe('pending');
      expect(msg.artifactIds).toEqual([]);
      expect(msg.metadata).toEqual({});
      expect(msg.llmModel).toBeNull();
      expect(msg.llmProvider).toBeNull();
      expect(msg.tokensUsed).toBeNull();
      expect(typeof msg.timestamp).toBe('number');
    });

    it('should create message with provided data', () => {
      const data = {
        id: 'msg-1',
        chatId: 'chat-1',
        role: 'assistant',
        content: 'Hello',
        status: 'complete',
        correlationId: 'corr-1',
        parentMessageId: 'msg-0',
        artifactIds: ['art-1', 'art-2'],
        metadata: { source: 'test' },
        llmModel: 'gpt-4',
        llmProvider: 'openai',
        tokensUsed: 150,
        timestamp: 1000
      };
      const msg = new Message(data);
      expect(msg.id).toBe('msg-1');
      expect(msg.chatId).toBe('chat-1');
      expect(msg.role).toBe('assistant');
      expect(msg.content).toBe('Hello');
      expect(msg.status).toBe('complete');
      expect(msg.correlationId).toBe('corr-1');
      expect(msg.parentMessageId).toBe('msg-0');
      expect(msg.artifactIds).toEqual(['art-1', 'art-2']);
      expect(msg.metadata).toEqual({ source: 'test' });
      expect(msg.llmModel).toBe('gpt-4');
      expect(msg.llmProvider).toBe('openai');
      expect(msg.tokensUsed).toBe(150);
    });

    it('should accept snake_case PostgreSQL fields', () => {
      const msg = new Message({
        llm_model: 'claude-3',
        llm_provider: 'anthropic',
        tokens_used: 200,
        created_at: 5000
      });
      expect(msg.llmModel).toBe('claude-3');
      expect(msg.llmProvider).toBe('anthropic');
      expect(msg.tokensUsed).toBe(200);
      expect(msg.createdAt).toBe(5000);
    });

    it('should deep copy artifactIds and metadata', () => {
      const ids = ['a1'];
      const meta = { key: 'val' };
      const msg = new Message({ artifactIds: ids, metadata: meta });
      ids.push('a2');
      meta.key = 'changed';
      expect(msg.artifactIds).toEqual(['a1']);
      expect(msg.metadata).toEqual({ key: 'val' });
    });
  });

  describe('Artifact management', () => {
    it('should add artifact', () => {
      const msg = new Message();
      msg.addArtifact('art-1');
      expect(msg.artifactIds).toEqual(['art-1']);
    });

    it('should not add duplicate artifact', () => {
      const msg = new Message({ artifactIds: ['art-1'] });
      msg.addArtifact('art-1');
      expect(msg.artifactIds).toEqual(['art-1']);
    });

    it('should throw on invalid artifact id', () => {
      const msg = new Message();
      expect(() => msg.addArtifact('')).toThrow('non-empty string');
      expect(() => msg.addArtifact(null)).toThrow('non-empty string');
      expect(() => msg.addArtifact(123)).toThrow('non-empty string');
    });

    it('should remove artifact', () => {
      const msg = new Message({ artifactIds: ['art-1', 'art-2'] });
      msg.removeArtifact('art-1');
      expect(msg.artifactIds).toEqual(['art-2']);
    });

    it('should handle removing non-existent artifact', () => {
      const msg = new Message();
      msg.removeArtifact('nonexistent'); // should not throw
      expect(msg.artifactIds).toEqual([]);
    });

    it('should check artifact existence', () => {
      const msg = new Message({ artifactIds: ['art-1'] });
      expect(msg.hasArtifact('art-1')).toBe(true);
      expect(msg.hasArtifact('art-2')).toBe(false);
    });
  });

  describe('Status management', () => {
    it('should set valid status', () => {
      const msg = new Message();
      msg.setStatus('streaming');
      expect(msg.status).toBe('streaming');
      msg.setStatus('complete');
      expect(msg.status).toBe('complete');
    });

    it('should throw on invalid status', () => {
      const msg = new Message();
      expect(() => msg.setStatus('invalid')).toThrow('Invalid status');
    });

    it('should check status correctly', () => {
      expect(new Message({ status: 'complete' }).isComplete()).toBe(true);
      expect(new Message({ status: 'streaming' }).isStreaming()).toBe(true);
      expect(new Message({ status: 'error' }).hasError()).toBe(true);
      expect(new Message({ status: 'pending' }).isComplete()).toBe(false);
    });
  });

  describe('Role checks', () => {
    it('should identify user messages', () => {
      expect(new Message({ role: 'user' }).isUser()).toBe(true);
      expect(new Message({ role: 'assistant' }).isUser()).toBe(false);
    });

    it('should identify assistant messages', () => {
      expect(new Message({ role: 'assistant' }).isAssistant()).toBe(true);
      expect(new Message({ role: 'user' }).isAssistant()).toBe(false);
    });

    it('should identify system messages', () => {
      expect(new Message({ role: 'system' }).isSystem()).toBe(true);
      expect(new Message({ role: 'user' }).isSystem()).toBe(false);
    });
  });

  describe('Utility methods', () => {
    it('should return content length', () => {
      expect(new Message({ content: 'hello' }).getLength()).toBe(5);
      expect(new Message({ content: '' }).getLength()).toBe(0);
    });

    it('should return age', () => {
      const msg = new Message({ timestamp: Date.now() - 1000 });
      expect(msg.getAge()).toBeGreaterThanOrEqual(1000);
    });

    it('should handle string timestamps for age', () => {
      const msg = new Message({ timestamp: new Date(Date.now() - 500).toISOString() });
      expect(msg.getAge()).toBeGreaterThanOrEqual(400);
    });
  });

  describe('Serialization', () => {
    it('should serialize to JSON and back', () => {
      const original = new Message({
        id: 'msg-1', chatId: 'chat-1', role: 'assistant',
        content: 'Hello', status: 'complete', artifactIds: ['a1'],
        metadata: { k: 'v' }, llmModel: 'gpt-4', tokensUsed: 100
      });
      const json = original.toJSON();
      const restored = Message.fromJSON(json);
      expect(restored.id).toBe(original.id);
      expect(restored.content).toBe(original.content);
      expect(restored.artifactIds).toEqual(original.artifactIds);
      expect(restored.llmModel).toBe(original.llmModel);
    });

    it('should serialize to PostgreSQL format', () => {
      const msg = new Message({
        id: 'msg-1', role: 'user', content: 'Hi',
        llmModel: 'gpt-4', llmProvider: 'openai', tokensUsed: 50,
        correlationId: 'corr-1', timestamp: 1000
      });
      const pg = msg.toPostgresFormat();
      expect(pg.llm_model).toBe('gpt-4');
      expect(pg.llm_provider).toBe('openai');
      expect(pg.tokens_used).toBe(50);
      expect(pg.correlation_id).toBe('corr-1');
    });

    it('should create from PostgreSQL row', () => {
      const row = {
        id: 'pg-1', chat_id: 'chat-1', role: 'assistant',
        content: 'Response', llm_model: 'claude', llm_provider: 'anthropic',
        tokens_used: 300, correlation_id: 'c1', created_at: 2000, status: 'complete'
      };
      const msg = Message.fromPostgresRow(row);
      expect(msg.id).toBe('pg-1');
      expect(msg.chatId).toBe('chat-1');
      expect(msg.llmModel).toBe('claude');
      expect(msg.status).toBe('complete');
    });

    it('should throw on invalid fromJSON input', () => {
      expect(() => Message.fromJSON(null)).toThrow('must be an object');
      expect(() => Message.fromJSON('string')).toThrow('must be an object');
    });

    it('should throw on invalid fromPostgresRow input', () => {
      expect(() => Message.fromPostgresRow(null)).toThrow('must be an object');
    });
  });

  describe('Clone', () => {
    it('should clone with overrides', () => {
      const msg = new Message({ id: 'msg-1', content: 'original' });
      const cloned = msg.clone({ content: 'modified' });
      expect(cloned.id).toBe('msg-1');
      expect(cloned.content).toBe('modified');
      expect(msg.content).toBe('original');
    });
  });

  describe('Factory methods', () => {
    it('should generate unique IDs', () => {
      const id1 = Message.generateId();
      const id2 = Message.generateId();
      expect(id1).toMatch(/^(msg_|corr_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(id2).toMatch(/^(msg_|corr_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(id1).not.toBe(id2);
    });

    it('should generate correlation IDs', () => {
      const id = Message.generateCorrelationId();
      expect(id).toMatch(/^(msg_|corr_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it('should create user message', () => {
      const msg = Message.createUser('Hello', 'chat-1');
      expect(msg.role).toBe('user');
      expect(msg.content).toBe('Hello');
      expect(msg.chatId).toBe('chat-1');
      expect(msg.status).toBe('pending');
      expect(msg.id).toMatch(/^(msg_|corr_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it('should create assistant message', () => {
      const msg = Message.createAssistant('Reply', 'chat-1', 'corr-1');
      expect(msg.role).toBe('assistant');
      expect(msg.content).toBe('Reply');
      expect(msg.correlationId).toBe('corr-1');
      expect(msg.status).toBe('streaming');
    });

    it('should create system message', () => {
      const msg = Message.createSystem('System info', 'chat-1');
      expect(msg.role).toBe('system');
      expect(msg.content).toBe('System info');
      expect(msg.status).toBe('complete');
    });
  });
});
