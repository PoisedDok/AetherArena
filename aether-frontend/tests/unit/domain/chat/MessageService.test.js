'use strict';

/**
 * MessageService Unit Tests
 * Tests the chat domain MessageService
 */

const { MessageService } = require('../../../../src/domain/chat/services/MessageService');
const { Message } = require('../../../../src/domain/chat/models/Message');

describe('MessageService', () => {
  let service;
  
  beforeEach(() => {
    service = new MessageService();
  });

  afterEach(() => {
    service = null;
  });

  describe('createUserMessage', () => {
    it('should create a user message with content', () => {
      const content = 'Hello, this is a test message';
      const message = service.createUserMessage(content);
      
      expect(message).toBeInstanceOf(Message);
      expect(message.role).toBe('user');
      expect(message.content).toBe(content);
      expect(message.id).toBeTruthy();
      expect(message.timestamp).toBeTruthy();
    });

    it('should create a user message with chatId', () => {
      const content = 'Test message';
      const chatId = 'chat_123';
      const message = service.createUserMessage(content, chatId);
      
      expect(message.chatId).toBe(chatId);
    });

    it('should create message with metadata', () => {
      const content = 'Test message';
      const metadata = { source: 'test', priority: 'high' };
      const message = service.createUserMessage(content, null, { metadata });
      
      expect(message.metadata).toEqual(metadata);
    });

    it('should throw error for invalid content', () => {
      expect(() => service.createUserMessage('')).toThrow();
      expect(() => service.createUserMessage(null)).toThrow();
      expect(() => service.createUserMessage(undefined)).toThrow();
    });

    it('should handle very long content', () => {
      const longContent = 'a'.repeat(100000);
      const message = service.createUserMessage(longContent);
      
      expect(message.content).toBe(longContent);
      expect(message.content.length).toBe(100000);
    });

    it('should preserve content with special characters', () => {
      const content = 'Test <script>alert("xss")</script> content';
      const message = service.createUserMessage(content);
      
      expect(message.content).toBe(content);
    });
  });

  describe('createAssistantMessage', () => {
    it('should create an assistant message', () => {
      const content = 'This is an assistant response';
      const message = service.createAssistantMessage(content);
      
      expect(message).toBeInstanceOf(Message);
      expect(message.role).toBe('assistant');
      expect(message.content).toBe(content);
    });

    it('should create message with model info', () => {
      const content = 'Response';
      const model = 'gpt-4';
      const message = service.createAssistantMessage(content, null, { model });
      
      expect(message.metadata.model).toBe(model);
    });
  });

  describe('createSystemMessage', () => {
    it('should create a system message', () => {
      const content = 'System notification';
      const message = service.createSystemMessage(content);
      
      expect(message.role).toBe('system');
      expect(message.content).toBe(content);
    });
  });

  describe('validateMessage', () => {
    it('should validate valid message', () => {
      const message = service.createUserMessage('Test');
      const isValid = service.validateMessage(message);
      
      expect(isValid).toBe(true);
    });

    it('should reject message without content', () => {
      const message = { role: 'user', content: '' };
      const isValid = service.validateMessage(message);
      
      expect(isValid).toBe(false);
    });

    it('should reject message without role', () => {
      const message = { content: 'test' };
      const isValid = service.validateMessage(message);
      
      expect(isValid).toBe(false);
    });

    it('should reject message with invalid role', () => {
      const message = { role: 'invalid', content: 'test' };
      const isValid = service.validateMessage(message);
      
      expect(isValid).toBe(false);
    });
  });

  describe('Message ID generation', () => {
    it('should generate unique IDs', () => {
      const msg1 = service.createUserMessage('Test 1');
      const msg2 = service.createUserMessage('Test 2');
      
      expect(msg1.id).not.toBe(msg2.id);
    });

    it('should generate IDs in correct format', () => {
      const message = service.createUserMessage('Test');
      
      expect(message.id).toMatch(/^msg_\d+_[a-z0-9]+$/);
    });
  });

  describe('Timestamp handling', () => {
    it('should set current timestamp', () => {
      const before = Date.now();
      const message = service.createUserMessage('Test');
      const after = Date.now();
      
      const messageTime = new Date(message.timestamp).getTime();
      expect(messageTime).toBeGreaterThanOrEqual(before);
      expect(messageTime).toBeLessThanOrEqual(after);
    });

    it('should use numeric timestamps', () => {
      const message = service.createUserMessage('Test');
      
      expect(typeof message.timestamp).toBe('number');
      expect(message.timestamp).toBeLessThanOrEqual(Date.now());
    });
  });
});

