'use strict';

const { Chat } = require('../../../../../src/domain/chat/models/Chat');
const { Message } = require('../../../../../src/domain/chat/models/Message');

describe('Chat Domain Model', () => {
  describe('Constructor', () => {
    it('should create chat with defaults', () => {
      const chat = new Chat();
      expect(chat.id).toBeNull();
      expect(chat.title).toBe('New Chat');
      expect(chat.messages).toEqual([]);
      expect(chat.metadata).toEqual({});
      expect(chat.isActive).toBe(true);
      expect(chat.isArchived).toBe(false);
      expect(chat.artifactIds).toEqual([]);
      expect(chat.sessionId).toBeNull();
    });

    it('should create chat with provided data', () => {
      const chat = new Chat({
        id: 'chat-1', title: 'Test Chat',
        sessionId: 'sess-1', artifactIds: ['a1'],
        isActive: false, isArchived: true
      });
      expect(chat.id).toBe('chat-1');
      expect(chat.title).toBe('Test Chat');
      expect(chat.sessionId).toBe('sess-1');
      expect(chat.artifactIds).toEqual(['a1']);
      expect(chat.isActive).toBe(false);
      expect(chat.isArchived).toBe(true);
    });

    it('should convert raw message objects to Message instances', () => {
      const chat = new Chat({
        messages: [{ id: 'msg-1', role: 'user', content: 'Hi' }]
      });
      expect(chat.messages[0]).toBeInstanceOf(Message);
      expect(chat.messages[0].content).toBe('Hi');
    });

    it('should keep existing Message instances', () => {
      const msg = new Message({ id: 'msg-1', content: 'Hi' });
      const chat = new Chat({ messages: [msg] });
      expect(chat.messages[0]).toBe(msg);
    });

    it('should handle snake_case fields', () => {
      const chat = new Chat({
        created_at: 1000, updated_at: 2000, message_count: 5
      });
      expect(chat.createdAt).toBe(1000);
      expect(chat.updatedAt).toBe(2000);
      expect(chat.messageCount).toBe(5);
    });

    it('should deep copy artifactIds', () => {
      const ids = ['a1'];
      const chat = new Chat({ artifactIds: ids });
      ids.push('a2');
      expect(chat.artifactIds).toEqual(['a1']);
    });
  });

  describe('Message management', () => {
    let chat;
    beforeEach(() => {
      chat = new Chat({ id: 'chat-1' });
    });

    it('should add a Message instance', () => {
      const msg = new Message({ id: 'msg-1', role: 'user', content: 'Hi' });
      chat.addMessage(msg);
      expect(chat.messages).toHaveLength(1);
      expect(msg.chatId).toBe('chat-1');
    });

    it('should throw when adding non-Message', () => {
      expect(() => chat.addMessage({ content: 'Hi' })).toThrow('instance of Message');
    });

    it('should throw when message chatId mismatches', () => {
      const msg = new Message({ id: 'msg-1', chatId: 'other-chat' });
      expect(() => chat.addMessage(msg)).toThrow('does not match');
    });

    it('should remove message by id', () => {
      const msg = new Message({ id: 'msg-1' });
      chat.addMessage(msg);
      expect(chat.removeMessage('msg-1')).toBe(true);
      expect(chat.messages).toHaveLength(0);
    });

    it('should return false when removing non-existent message', () => {
      expect(chat.removeMessage('nope')).toBe(false);
    });

    it('should get message by id', () => {
      const msg = new Message({ id: 'msg-1', content: 'Hi' });
      chat.addMessage(msg);
      expect(chat.getMessage('msg-1')).toBe(msg);
      expect(chat.getMessage('nope')).toBeNull();
    });

    it('should filter user and assistant messages', () => {
      chat.addMessage(new Message({ id: 'u1', role: 'user', content: 'Q' }));
      chat.addMessage(new Message({ id: 'a1', role: 'assistant', content: 'A' }));
      chat.addMessage(new Message({ id: 'u2', role: 'user', content: 'Q2' }));
      expect(chat.getUserMessages()).toHaveLength(2);
      expect(chat.getAssistantMessages()).toHaveLength(1);
    });

    it('should get last message', () => {
      expect(chat.getLastMessage()).toBeNull();
      chat.addMessage(new Message({ id: 'u1', content: 'first' }));
      chat.addMessage(new Message({ id: 'u2', content: 'second' }));
      expect(chat.getLastMessage().id).toBe('u2');
    });

    it('should get last user and assistant messages', () => {
      chat.addMessage(new Message({ id: 'u1', role: 'user', content: 'Q1' }));
      chat.addMessage(new Message({ id: 'a1', role: 'assistant', content: 'A1' }));
      chat.addMessage(new Message({ id: 'u2', role: 'user', content: 'Q2' }));
      expect(chat.getLastUserMessage().id).toBe('u2');
      expect(chat.getLastAssistantMessage().id).toBe('a1');
    });

    it('should return null for last user/assistant when none', () => {
      expect(chat.getLastUserMessage()).toBeNull();
      expect(chat.getLastAssistantMessage()).toBeNull();
    });

    it('should count messages', () => {
      expect(chat.getMessageCount()).toBe(0);
      chat.addMessage(new Message({ id: 'm1' }));
      expect(chat.getMessageCount()).toBe(1);
    });

    it('should calculate total tokens', () => {
      chat.addMessage(new Message({ id: 'm1', tokensUsed: 100 }));
      chat.addMessage(new Message({ id: 'm2', tokensUsed: 200 }));
      chat.addMessage(new Message({ id: 'm3' })); // null tokens
      expect(chat.getTotalTokens()).toBe(300);
    });

    it('should check isEmpty and hasUserMessages', () => {
      expect(chat.isEmpty()).toBe(true);
      expect(chat.hasUserMessages()).toBe(false);
      chat.addMessage(new Message({ id: 'm1', role: 'user', content: 'Hi' }));
      expect(chat.isEmpty()).toBe(false);
      expect(chat.hasUserMessages()).toBe(true);
    });

    it('should clear messages', () => {
      chat.addMessage(new Message({ id: 'm1' }));
      chat.clearMessages();
      expect(chat.messages).toEqual([]);
    });
  });

  describe('Title and metadata', () => {
    it('should set title', () => {
      const chat = new Chat();
      chat.setTitle('New Title');
      expect(chat.title).toBe('New Title');
    });

    it('should throw on invalid title', () => {
      const chat = new Chat();
      expect(() => chat.setTitle('')).toThrow('non-empty string');
      expect(() => chat.setTitle(null)).toThrow('non-empty string');
    });

    it('should set and get metadata', () => {
      const chat = new Chat();
      chat.setMetadata('key', 'value');
      expect(chat.getMetadata('key')).toBe('value');
      expect(chat.getMetadata('missing', 'default')).toBe('default');
    });
  });

  describe('Artifact management', () => {
    it('should add and check artifact', () => {
      const chat = new Chat();
      chat.addArtifact('art-1');
      expect(chat.hasArtifact('art-1')).toBe(true);
      expect(chat.hasArtifact('art-2')).toBe(false);
    });

    it('should not add duplicate artifact', () => {
      const chat = new Chat();
      chat.addArtifact('art-1');
      chat.addArtifact('art-1');
      expect(chat.artifactIds).toEqual(['art-1']);
    });

    it('should throw on invalid artifact id', () => {
      const chat = new Chat();
      expect(() => chat.addArtifact('')).toThrow('non-empty string');
    });

    it('should remove artifact', () => {
      const chat = new Chat({ artifactIds: ['a1', 'a2'] });
      expect(chat.removeArtifact('a1')).toBe(true);
      expect(chat.artifactIds).toEqual(['a2']);
      expect(chat.removeArtifact('nope')).toBe(false);
    });
  });

  describe('Archive lifecycle', () => {
    it('should archive and unarchive', () => {
      const chat = new Chat();
      chat.archive();
      expect(chat.isArchived).toBe(true);
      expect(chat.isActive).toBe(false);
      chat.unarchive();
      expect(chat.isArchived).toBe(false);
      expect(chat.isActive).toBe(true);
    });
  });

  describe('Timestamps', () => {
    it('should update timestamp on touch', () => {
      const chat = new Chat({ updatedAt: 1000 });
      chat.touch();
      expect(chat.updatedAt).toBeGreaterThan(1000);
    });

    it('should return age and time since update', () => {
      const chat = new Chat({ createdAt: Date.now() - 5000, updatedAt: Date.now() - 2000 });
      expect(chat.getAge()).toBeGreaterThanOrEqual(5000);
      expect(chat.getTimeSinceUpdate()).toBeGreaterThanOrEqual(2000);
    });
  });

  describe('Serialization', () => {
    it('should round-trip through toJSON/fromJSON', () => {
      const chat = new Chat({
        id: 'chat-1', title: 'Test',
        messages: [{ id: 'msg-1', role: 'user', content: 'Hi' }],
        artifactIds: ['a1'], sessionId: 's1', isArchived: true
      });
      const json = chat.toJSON();
      const restored = Chat.fromJSON(json);
      expect(restored.id).toBe('chat-1');
      expect(restored.title).toBe('Test');
      expect(restored.messages).toHaveLength(1);
      expect(restored.messages[0]).toBeInstanceOf(Message);
      expect(restored.artifactIds).toEqual(['a1']);
      expect(restored.isArchived).toBe(true);
    });

    it('should convert to PostgreSQL format', () => {
      const chat = new Chat({ id: 'c1', title: 'T', createdAt: 1000, updatedAt: 2000 });
      const pg = chat.toPostgresFormat();
      expect(pg.created_at).toBe(1000);
      expect(pg.updated_at).toBe(2000);
    });

    it('should create from PostgreSQL row', () => {
      const row = {
        id: 'c1', title: 'Chat', message_count: 5,
        created_at: 1000, updated_at: 2000, archived: true
      };
      const chat = Chat.fromPostgresRow(row, []);
      expect(chat.id).toBe('c1');
      expect(chat.messageCount).toBe(5);
      expect(chat.isArchived).toBe(true);
    });

    it('should throw on invalid fromJSON/fromPostgresRow', () => {
      expect(() => Chat.fromJSON(null)).toThrow('must be an object');
      expect(() => Chat.fromPostgresRow(null)).toThrow('must be an object');
    });
  });

  describe('Clone', () => {
    it('should clone with overrides', () => {
      const chat = new Chat({ id: 'c1', title: 'Original' });
      const cloned = chat.clone({ title: 'Cloned' });
      expect(cloned.id).toBe('c1');
      expect(cloned.title).toBe('Cloned');
      expect(chat.title).toBe('Original');
    });
  });
});
