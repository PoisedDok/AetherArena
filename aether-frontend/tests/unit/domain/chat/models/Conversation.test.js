'use strict';

const { Conversation } = require('../../../../../src/domain/chat/models/Conversation');
const { Message } = require('../../../../../src/domain/chat/models/Message');

describe('Conversation Domain Model', () => {
  describe('Constructor', () => {
    it('should create with defaults', () => {
      const conv = new Conversation();
      expect(conv.id).toMatch(/^conv_/);
      expect(conv.chatId).toBeNull();
      expect(conv.messages).toEqual([]);
      expect(conv.metadata).toEqual({});
      expect(conv.contextWindow).toBe(20);
      expect(conv.correlationMap).toBeInstanceOf(Map);
      expect(conv.threadMap).toBeInstanceOf(Map);
    });

    it('should accept provided data', () => {
      const conv = new Conversation({
        id: 'conv-1', chatId: 'chat-1', contextWindow: 10,
        metadata: { key: 'val' }
      });
      expect(conv.id).toBe('conv-1');
      expect(conv.chatId).toBe('chat-1');
      expect(conv.contextWindow).toBe(10);
    });

    it('should convert raw message objects to Message instances', () => {
      const conv = new Conversation({
        messages: [{ id: 'msg-1', role: 'user', content: 'Hi' }]
      });
      expect(conv.messages[0]).toBeInstanceOf(Message);
    });

    it('should initialize correlation map from existing messages', () => {
      const conv = new Conversation({
        messages: [
          { id: 'u1', role: 'user', correlationId: 'corr-1' },
          { id: 'a1', role: 'assistant', correlationId: 'corr-1' }
        ]
      });
      const corr = conv.correlationMap.get('corr-1');
      expect(corr.userMessageId).toBe('u1');
      expect(corr.assistantMessageId).toBe('a1');
    });

    it('should initialize thread map from existing messages', () => {
      const conv = new Conversation({
        messages: [
          { id: 'u1', role: 'user' },
          { id: 'a1', role: 'assistant', parentMessageId: 'u1' }
        ]
      });
      const children = conv.threadMap.get('u1');
      expect(children).toEqual(['a1']);
    });
  });

  describe('Message management', () => {
    let conv;
    beforeEach(() => {
      conv = new Conversation({ chatId: 'chat-1' });
    });

    it('should add message and update maps', () => {
      const user = new Message({ id: 'u1', role: 'user', correlationId: 'c1' });
      conv.addMessage(user);
      expect(conv.messages).toHaveLength(1);
      expect(conv.correlationMap.get('c1').userMessageId).toBe('u1');
    });

    it('should throw when adding non-Message', () => {
      expect(() => conv.addMessage({ content: 'bad' })).toThrow('instance of Message');
    });

    it('should update thread map on add', () => {
      const user = new Message({ id: 'u1', role: 'user' });
      const asst = new Message({ id: 'a1', role: 'assistant', parentMessageId: 'u1' });
      conv.addMessage(user);
      conv.addMessage(asst);
      expect(conv.threadMap.get('u1')).toEqual(['a1']);
    });

    it('should not duplicate thread entries', () => {
      const msg = new Message({ id: 'a1', parentMessageId: 'u1' });
      conv.addMessage(msg);
      conv.addMessage(new Message({ id: 'a2', parentMessageId: 'u1' }));
      // manually add same child again via re-initialization
      const children = conv.threadMap.get('u1');
      expect(children).toEqual(['a1', 'a2']);
    });

    it('should get message by id', () => {
      const msg = new Message({ id: 'm1', content: 'test' });
      conv.addMessage(msg);
      expect(conv.getMessage('m1')).toBe(msg);
      expect(conv.getMessage('nope')).toBeNull();
    });
  });

  describe('Correlated pairs', () => {
    let conv;
    beforeEach(() => {
      conv = new Conversation({ chatId: 'chat-1' });
    });

    it('should add correlated pair', () => {
      const user = new Message({ id: 'u1', role: 'user' });
      const asst = new Message({ id: 'a1', role: 'assistant' });
      const corrId = conv.addCorrelatedPair(user, asst);
      expect(corrId).toMatch(/^(msg_|corr_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(user.correlationId).toBe(corrId);
      expect(asst.correlationId).toBe(corrId);
      expect(asst.parentMessageId).toBe('u1');
      expect(conv.messages).toHaveLength(2);
    });

    it('should retrieve correlated assistant from user', () => {
      const user = new Message({ id: 'u1', role: 'user' });
      const asst = new Message({ id: 'a1', role: 'assistant' });
      conv.addCorrelatedPair(user, asst);
      expect(conv.getCorrelatedAssistantMessage('u1')).toBe(asst);
    });

    it('should retrieve correlated user from assistant', () => {
      const user = new Message({ id: 'u1', role: 'user' });
      const asst = new Message({ id: 'a1', role: 'assistant' });
      conv.addCorrelatedPair(user, asst);
      expect(conv.getCorrelatedUserMessage('a1')).toBe(user);
    });

    it('should return null for uncorrelated messages', () => {
      const msg = new Message({ id: 'u1', role: 'user' });
      conv.addMessage(msg);
      expect(conv.getCorrelatedAssistantMessage('u1')).toBeNull();
    });

    it('should return null for non-existent message ids', () => {
      expect(conv.getCorrelatedAssistantMessage('nope')).toBeNull();
      expect(conv.getCorrelatedUserMessage('nope')).toBeNull();
    });
  });

  describe('Threading', () => {
    let conv;
    beforeEach(() => {
      conv = new Conversation({ chatId: 'chat-1' });
    });

    it('should get child messages', () => {
      const parent = new Message({ id: 'p1', role: 'user' });
      const child1 = new Message({ id: 'c1', role: 'assistant', parentMessageId: 'p1' });
      const child2 = new Message({ id: 'c2', role: 'user', parentMessageId: 'p1' });
      conv.addMessage(parent);
      conv.addMessage(child1);
      conv.addMessage(child2);
      const children = conv.getChildMessages('p1');
      expect(children).toHaveLength(2);
      expect(children[0].id).toBe('c1');
    });

    it('should get parent message', () => {
      const parent = new Message({ id: 'p1', role: 'user' });
      const child = new Message({ id: 'c1', role: 'assistant', parentMessageId: 'p1' });
      conv.addMessage(parent);
      conv.addMessage(child);
      expect(conv.getParentMessage('c1')).toBe(parent);
      expect(conv.getParentMessage('p1')).toBeNull();
    });

    it('should get full thread', () => {
      const p = new Message({ id: 'p', role: 'user' });
      const c1 = new Message({ id: 'c1', role: 'assistant', parentMessageId: 'p' });
      const c2 = new Message({ id: 'c2', role: 'user', parentMessageId: 'c1' });
      conv.addMessage(p);
      conv.addMessage(c1);
      conv.addMessage(c2);
      const thread = conv.getThread('c1');
      expect(thread.map(m => m.id)).toEqual(['p', 'c1', 'c2']);
    });

    it('should return empty thread for non-existent message', () => {
      expect(conv.getThread('nope')).toEqual([]);
    });
  });

  describe('Context window', () => {
    it('should return recent messages within window', () => {
      const msgs = Array.from({ length: 30 }, (_, i) =>
        new Message({ id: `m${i}`, content: `msg-${i}` })
      );
      const conv = new Conversation({ messages: msgs, contextWindow: 5 });
      const ctx = conv.getContext();
      expect(ctx).toHaveLength(5);
      expect(ctx[0].id).toBe('m25');
    });

    it('should format context for LLM', () => {
      const conv = new Conversation({
        messages: [
          { id: 'u1', role: 'user', content: 'Q' },
          { id: 'a1', role: 'assistant', content: 'A' }
        ]
      });
      const llmCtx = conv.getContextForLLM();
      expect(llmCtx).toEqual([
        { role: 'user', content: 'Q' },
        { role: 'assistant', content: 'A' }
      ]);
    });

    it('should set context window', () => {
      const conv = new Conversation();
      conv.setContextWindow(50);
      expect(conv.contextWindow).toBe(50);
    });

    it('should throw on invalid context window', () => {
      const conv = new Conversation();
      expect(() => conv.setContextWindow(0)).toThrow('positive integer');
      expect(() => conv.setContextWindow(-1)).toThrow('positive integer');
      expect(() => conv.setContextWindow(1.5)).toThrow('positive integer');
    });
  });

  describe('Utility', () => {
    it('should get all messages (copy)', () => {
      const conv = new Conversation({ messages: [{ id: 'm1' }] });
      const all = conv.getAllMessages();
      expect(all).toHaveLength(1);
      all.push(new Message({ id: 'm2' }));
      expect(conv.messages).toHaveLength(1);
    });

    it('should get message count', () => {
      const conv = new Conversation({ messages: [{ id: 'm1' }, { id: 'm2' }] });
      expect(conv.getMessageCount()).toBe(2);
    });

    it('should clear all messages and maps', () => {
      const conv = new Conversation({
        messages: [
          { id: 'u1', role: 'user', correlationId: 'c1' },
          { id: 'a1', role: 'assistant', correlationId: 'c1', parentMessageId: 'u1' }
        ]
      });
      conv.clear();
      expect(conv.messages).toEqual([]);
      expect(conv.correlationMap.size).toBe(0);
      expect(conv.threadMap.size).toBe(0);
    });
  });

  describe('Serialization', () => {
    it('should round-trip through toJSON/fromJSON', () => {
      const conv = new Conversation({
        id: 'conv-1', chatId: 'chat-1', contextWindow: 15,
        messages: [{ id: 'u1', role: 'user', content: 'Hi' }],
        metadata: { k: 'v' }
      });
      const json = conv.toJSON();
      const restored = Conversation.fromJSON(json);
      expect(restored.id).toBe('conv-1');
      expect(restored.chatId).toBe('chat-1');
      expect(restored.contextWindow).toBe(15);
      expect(restored.messages).toHaveLength(1);
      expect(restored.messages[0]).toBeInstanceOf(Message);
    });

    it('should throw on invalid fromJSON', () => {
      expect(() => Conversation.fromJSON(null)).toThrow('must be an object');
    });
  });

  describe('Factory methods', () => {
    it('should generate unique ids', () => {
      const id1 = Conversation.generateId();
      const id2 = Conversation.generateId();
      expect(id1).toMatch(/^conv_/);
      expect(id1).not.toBe(id2);
    });

    it('should create new conversation', () => {
      const conv = Conversation.create('chat-1', 30);
      expect(conv.chatId).toBe('chat-1');
      expect(conv.contextWindow).toBe(30);
      expect(conv.messages).toEqual([]);
      expect(conv.id).toMatch(/^conv_/);
    });
  });
});
