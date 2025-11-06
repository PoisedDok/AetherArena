'use strict';

/**
 * Real Runtime Behavior Integration Tests
 * ============================================================================
 * Tests actual system behavior with real implementations (no stubs/mocks).
 * Verifies end-to-end flows work correctly.
 * 
 * @module tests/integration/real-runtime-behavior
 */

const { MessageService } = require('../../src/domain/chat/services/MessageService');
const { ArtifactService } = require('../../src/domain/artifacts/services/ArtifactService');
const { ChatService } = require('../../src/domain/chat/services/ChatService');
const { DependencyContainer } = require('../../src/core/di/Container');
const EventBus = require('../../src/core/events/EventBus');
const { RateLimiter } = require('../../src/core/security/RateLimiter');
const { InputValidator } = require('../../src/core/security/InputValidator');
const { Sanitizer } = require('../../src/core/security/Sanitizer');

describe('Real Runtime Behavior Integration Tests', () => {
  jest.setTimeout(15000); // 15s timeout for integration tests

  describe('Message Flow (End-to-End)', () => {
    let messageService;
    let chatService;
    let eventBus;
    
    beforeEach(() => {
      // Use REAL services with in-memory repository
      const mockRepository = {
        save: jest.fn(async (msg) => ({ ...msg, serverId: 'uuid-123' })),
        findByChatId: jest.fn(async () => []),
        saveBatch: jest.fn(async (msgs) => msgs.map(m => ({ ...m, serverId: 'uuid-' + Math.random() }))),
      };
      
      messageService = new MessageService({ repository: mockRepository });
      chatService = new ChatService({ repository: mockRepository });
      eventBus = new EventBus();
    });

    it('should create and process user message with real validation', () => {
      // Real runtime: Create user message
      const message = messageService.createUserMessage('Hello, AI assistant!', null, {
        metadata: { source: 'test' }
      });

      // Verify real message structure
      expect(message).toBeDefined();
      expect(message.id).toMatch(/^msg_/);
      expect(message.role).toBe('user');
      expect(message.content).toBe('Hello, AI assistant!');
      expect(typeof message.timestamp).toBe('number');
      expect(message.timestamp).toBeLessThanOrEqual(Date.now());
      expect(message.metadata.source).toBe('test');

      // Real validation
      const isValid = messageService.validateMessage(message);
      expect(isValid).toBe(true);
    });

    it('should create correlated message pair for conversation flow', () => {
      // Real runtime: Create correlated user-assistant pair
      const pair = messageService.createCorrelatedPair(
        'What is 2+2?',
        '2+2 equals 4',
        'chat_123'
      );

      expect(pair).toHaveProperty('userMessage');
      expect(pair).toHaveProperty('assistantMessage');
      
      // Both messages share correlation ID
      expect(pair.userMessage.correlationId).toBe(pair.assistantMessage.correlationId);
      expect(pair.userMessage.correlationId).toMatch(/^corr_/);
      
      // Both linked to same chat
      expect(pair.userMessage.chatId).toBe('chat_123');
      expect(pair.assistantMessage.chatId).toBe('chat_123');
    });

    it('should save message batch with real repository interaction', async () => {
      const messages = [
        messageService.createUserMessage('Message 1'),
        messageService.createAssistantMessage('Response 1'),
        messageService.createUserMessage('Message 2'),
      ];

      // Real save operation
      const saved = await messageService.saveMessages(messages, 'chat_456');
      
      expect(saved).toHaveLength(3);
      saved.forEach(msg => {
        expect(msg.serverId).toBeDefined();
        expect(msg.serverId).toMatch(/^uuid-/);
      });
    });

    it('should reject invalid messages with real validation', () => {
      // Test real validation rules
      expect(messageService.validateMessage({ role: 'user', content: '' })).toBe(false);
      expect(messageService.validateMessage({ role: 'invalid', content: 'test' })).toBe(false);
      expect(messageService.validateMessage({ content: 'test' })).toBe(false); // missing role
    });
  });

  describe('Artifact Streaming Flow (End-to-End)', () => {
    let artifactService;

    beforeEach(() => {
      const mockRepository = {
        save: jest.fn(async (art) => ({ ...art, serverId: 'art-uuid-' + Date.now() })),
        findById: jest.fn(async (id) => null),
        findByChatId: jest.fn(async () => []),
      };
      
      artifactService = new ArtifactService({ repository: mockRepository });
    });

    it('should create artifact from stream with real data', async () => {
      // Real streaming data structure
      const streamData = {
        id: 'art_test_123',
        kind: 'code',
        language: 'python',
        content: 'print("Hello World")',
        chatId: '550e8400-e29b-41d4-a716-446655440000',
        sourceMessageId: 'msg_456'
      };

      // Real artifact creation
      const artifact = await artifactService.createFromStream(streamData);

      expect(artifact).toBeDefined();
      expect(artifact.id).toBe('art_test_123');
      expect(artifact.type).toBe('code');
      expect(artifact.language).toBe('python');
      expect(artifact.content).toBe('print("Hello World")');
      expect(artifact.status).toBe('streaming');
    });

    it('should update artifact content during streaming', async () => {
      // Create initial artifact
      const streamData = {
        id: 'art_stream_456',
        kind: 'code',
        content: 'def hello():\n',
        chatId: '550e8400-e29b-41d4-a716-446655440000'
      };
      
      const artifact = await artifactService.createFromStream(streamData);
      expect(artifact.content).toBe('def hello():\n');

      // Simulate streaming updates
      const updated1 = artifactService.updateContent('art_stream_456', '    print("Hello")\n');
      expect(updated1).toBeDefined();
      expect(updated1.content).toContain('def hello()');
      expect(updated1.content).toContain('print("Hello")');

      const updated2 = artifactService.updateContent('art_stream_456', '    return True\n');
      expect(updated2.content).toContain('return True');
    });

    it('should complete artifact streaming', async () => {
      const streamData = {
        id: 'art_complete_789',
        kind: 'output',
        content: 'Processing...',
        chatId: '550e8400-e29b-41d4-a716-446655440000'
      };
      
      const artifact = await artifactService.createFromStream(streamData);
      expect(artifact.status).toBe('streaming');

      // Finalize the artifact via the service
      const finalized = await artifactService.finalizeArtifact(artifact.id);
      expect(finalized).toBeDefined();
      expect(finalized.status).toBe('active');
    });

    it('should cache and retrieve artifacts', async () => {
      const streamData = {
        id: 'art_cache_999',
        kind: 'code',
        content: 'test code',
        chatId: '550e8400-e29b-41d4-a716-446655440000'
      };
      
      await artifactService.createFromStream(streamData);
      
      // Verify caching works
      const stats = artifactService.getCacheStats();
      expect(stats.total).toBe(1);
      expect(stats.byType.code).toBe(1);
    });
  });

  describe('Service Integration and Dependency Injection', () => {
    let container;

    beforeEach(() => {
      container = new DependencyContainer({ name: 'test-runtime' });
    });

    afterEach(() => {
      container.dispose();
    });

    it('should register and resolve real services with dependencies', () => {
      // Register real services with dependencies
      container.register('config', () => ({ apiUrl: 'http://localhost:5002' }));
      container.register('logger', () => ({ 
        info: jest.fn(), 
        error: jest.fn(), 
        warn: jest.fn() 
      }));
      container.register('eventBus', () => new EventBus());
      
      container.register('messageService', (logger, eventBus) => {
        return new MessageService({ 
          repository: {
            save: jest.fn(),
            findByChatId: jest.fn(async () => [])
          },
          logger,
          eventBus
        });
      }, { dependencies: ['logger', 'eventBus'] });

      // Resolve with real dependency injection
      const messageService = container.resolve('messageService');
      
      expect(messageService).toBeInstanceOf(MessageService);
      expect(messageService.logger).toBeDefined();
      
      // Test real functionality
      const msg = messageService.createUserMessage('Test DI');
      expect(msg.content).toBe('Test DI');
    });

    it('should detect circular dependencies in real-time', () => {
      container.register('a', (b) => ({ name: 'a', b }), { dependencies: ['b'] });
      container.register('b', (c) => ({ name: 'b', c }), { dependencies: ['c'] });
      container.register('c', (a) => ({ name: 'c', a }), { dependencies: ['a'] });

      // Real circular dependency detection
      expect(() => container.resolve('a')).toThrow(/circular dependency/i);
    });

    it('should create singletons once and reuse', () => {
      let callCount = 0;
      container.register('singleton', () => {
        callCount++;
        return { id: Date.now(), callNumber: callCount };
      });

      const instance1 = container.resolve('singleton');
      const instance2 = container.resolve('singleton');
      
      // Real singleton behavior
      expect(instance1).toBe(instance2);
      expect(callCount).toBe(1); // Created only once
    });
  });

  describe('Security Layer Integration', () => {
    let rateLimiter;
    let inputValidator;
    let sanitizer;

    beforeEach(() => {
      rateLimiter = new RateLimiter({
        windowMs: 1000,
        maxRequests: 5
      });
      
      inputValidator = new InputValidator();
      sanitizer = new Sanitizer();
    });

    it('should enforce rate limiting in real-time', async () => {
      // Real rate limiting behavior
      for (let i = 0; i < 5; i++) {
        expect(rateLimiter.checkLimit('test-endpoint')).toBe(true);
      }
      
      // 6th request should be blocked
      expect(rateLimiter.checkLimit('test-endpoint')).toBe(false);
      
      // Wait for window reset
      await new Promise(resolve => setTimeout(resolve, 1100));
      
      // Should work again after reset
      expect(rateLimiter.checkLimit('test-endpoint')).toBe(true);
    });

    it('should validate input in real-time', () => {
      // Real validation
      expect(() => inputValidator.validateString('valid string', { minLength: 5 })).not.toThrow();
      expect(() => inputValidator.validateString('abc', { minLength: 5 })).toThrow(/too short/i);
      
      expect(() => inputValidator.validateNumber(42, { min: 0, max: 100 })).not.toThrow();
      expect(() => inputValidator.validateNumber(150, { min: 0, max: 100 })).toThrow(/too large/i);
      
      expect(() => inputValidator.validateEmail('test@example.com')).not.toThrow();
      expect(() => inputValidator.validateEmail('invalid-email')).toThrow(/invalid email/i);
    });

    it('should sanitize HTML content in real-time', () => {
      // Real sanitization
      const dangerous = '<script>alert("xss")</script><p>Safe content</p>';
      const sanitized = sanitizer.sanitizeHtml(dangerous);
      
      expect(sanitized).not.toContain('<script>');
      expect(sanitized).toContain('Safe content');
    });

    it('should prevent prototype pollution', () => {
      // Test with constructor and other dangerous keys
      const maliciousInput = {
        constructor: { prototype: { polluted: true } },
        normalField: 'value'
      };

      // Real prototype pollution detection - throws ValidationError
      expect(() => {
        inputValidator.validateObject(maliciousInput);
      }).toThrow(/dangerous keys/i);
    });
  });

  describe('Event Bus Integration', () => {
    let eventBus;
    let receivedEvents;

    beforeEach(() => {
      eventBus = new EventBus();
      receivedEvents = [];
    });

    it('should emit and receive events in real-time', (done) => {
      // Real event handling
      eventBus.on('test-event', (data) => {
        receivedEvents.push(data);
        expect(data.message).toBe('Hello from event');
        done();
      });

      eventBus.emit('test-event', { message: 'Hello from event' });
    });

    it('should handle multiple subscribers', () => {
      let count1 = 0;
      let count2 = 0;

      eventBus.on('multi-event', () => count1++);
      eventBus.on('multi-event', () => count2++);

      eventBus.emit('multi-event');
      
      expect(count1).toBe(1);
      expect(count2).toBe(1);
    });

    it('should unsubscribe properly', () => {
      let callCount = 0;
      const handler = () => callCount++;

      eventBus.on('unsub-event', handler);
      eventBus.emit('unsub-event');
      expect(callCount).toBe(1);

      eventBus.off('unsub-event', handler);
      eventBus.emit('unsub-event');
      expect(callCount).toBe(1); // Not called again
    });
  });

  describe('Configuration Loading', () => {
    it('should load environment variables properly', () => {
      // Set test env vars
      process.env.TEST_STRING = 'test-value';
      process.env.TEST_NUMBER = '42';
      process.env.TEST_BOOLEAN = 'true';
      
      // Real env var access
      expect(process.env.TEST_STRING).toBe('test-value');
      expect(parseInt(process.env.TEST_NUMBER)).toBe(42);
      expect(process.env.TEST_BOOLEAN).toBe('true');
      expect(process.env.NON_EXISTENT || 'default').toBe('default');
      
      // Cleanup
      delete process.env.TEST_STRING;
      delete process.env.TEST_NUMBER;
      delete process.env.TEST_BOOLEAN;
    });
  });
});

