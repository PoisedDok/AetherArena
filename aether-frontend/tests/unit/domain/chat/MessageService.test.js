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
      expect(message.id).toMatch(/^(msg_|corr_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(message.timestamp).toEqual(expect.any(Number));
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
      
      expect(message.id).toMatch(/^(msg_|corr_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
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

  // ==================== CONSTRUCTOR ====================

  describe('constructor', () => {
    it('should accept injected dependencies', () => {
      const mockValidator = { validateOrThrow: jest.fn() };
      const mockRepo = { save: jest.fn() };
      const mockLogger = { error: jest.fn() };
      const svc = new MessageService({
        validator: mockValidator,
        repository: mockRepo,
        logger: mockLogger,
      });
      expect(svc.validator).toBe(mockValidator);
      expect(svc.repository).toBe(mockRepo);
      expect(svc.logger).toBe(mockLogger);
    });

    it('should default logger to console', () => {
      expect(service.logger).toBe(console);
    });

    it('should create default validator and repository when no deps provided', () => {
      expect(service.validator).toBeDefined();
      expect(service.validator.constructor.name).toBe('MessageValidator');
      expect(service.repository).toBeDefined();
      expect(service.repository.constructor.name).toBe('MessageRepository');
    });
  });

  // ==================== createUserMessage — advanced options ====================

  describe('createUserMessage — advanced options', () => {
    it('should set attachments in metadata', () => {
      const attachments = [{ name: 'file.txt', size: 1024 }];
      const message = service.createUserMessage('test', null, { attachments });
      expect(message.metadata.attachments).toEqual(attachments);
      expect(message.metadata.attachments).toHaveLength(1);
      expect(message.metadata.attachments[0].name).toBe('file.txt');
    });

    it('should set parentMessageId', () => {
      const parentId = 'msg_parent_123';
      const message = service.createUserMessage('test', null, { parentMessageId: parentId });
      expect(message.parentMessageId).toBe(parentId);
    });

    it('should set correlationId', () => {
      const corrId = 'corr_test_123';
      const message = service.createUserMessage('test', null, { correlationId: corrId });
      expect(message.correlationId).toBe(corrId);
    });

    it('should merge metadata with defaults instead of replacing', () => {
      const message = service.createUserMessage('test', null, {
        metadata: { custom: 'value' },
      });
      expect(message.metadata.custom).toBe('value');
    });

    it('should apply attachments AND metadata together', () => {
      const message = service.createUserMessage('test', null, {
        metadata: { source: 'api' },
        attachments: [{ name: 'data.csv' }],
      });
      expect(message.metadata.source).toBe('api');
      expect(message.metadata.attachments).toEqual([{ name: 'data.csv' }]);
    });

    it('should apply all options simultaneously', () => {
      const message = service.createUserMessage('test', 'chat_1', {
        metadata: { source: 'web' },
        attachments: [{ name: 'img.png' }],
        parentMessageId: 'msg_parent',
        correlationId: 'corr_abc',
      });
      expect(message.chatId).toBe('chat_1');
      expect(message.role).toBe('user');
      expect(message.metadata.source).toBe('web');
      expect(message.metadata.attachments).toEqual([{ name: 'img.png' }]);
      expect(message.parentMessageId).toBe('msg_parent');
      expect(message.correlationId).toBe('corr_abc');
    });

    it('should throw for whitespace-only content', () => {
      expect(() => service.createUserMessage('   ')).toThrow('[MessageService] Invalid message content');
      expect(() => service.createUserMessage('\t\n')).toThrow('[MessageService] Invalid message content');
    });

    it('should throw for numeric content', () => {
      expect(() => service.createUserMessage(42)).toThrow('[MessageService] Invalid message content');
    });

    it('should create with pending status', () => {
      const message = service.createUserMessage('test');
      expect(message.status).toBe('pending');
    });
  });

  // ==================== createAssistantMessage — advanced options ====================

  describe('createAssistantMessage — advanced options', () => {
    it('should set llmModel directly', () => {
      const message = service.createAssistantMessage('response', null, { llmModel: 'gpt-4' });
      expect(message.llmModel).toBe('gpt-4');
      expect(message.metadata.model).toBe('gpt-4');
    });

    it('should fall back to model option when llmModel not provided', () => {
      const message = service.createAssistantMessage('response', null, { model: 'claude-3' });
      expect(message.llmModel).toBe('claude-3');
      expect(message.metadata.model).toBe('claude-3');
    });

    it('should prefer llmModel over model when both provided', () => {
      const message = service.createAssistantMessage('response', null, {
        llmModel: 'gpt-4',
        model: 'claude-3',
      });
      expect(message.llmModel).toBe('gpt-4');
      expect(message.metadata.model).toBe('gpt-4');
    });

    it('should set llmProvider in both fields', () => {
      const message = service.createAssistantMessage('response', null, { llmProvider: 'openai' });
      expect(message.llmProvider).toBe('openai');
      expect(message.metadata.provider).toBe('openai');
    });

    it('should set tokensUsed including zero', () => {
      const msg1 = service.createAssistantMessage('response', null, { tokensUsed: 150 });
      expect(msg1.tokensUsed).toBe(150);
      expect(msg1.metadata.tokensUsed).toBe(150);

      // Zero is a valid value — !== undefined check must pass
      const msg2 = service.createAssistantMessage('response', null, { tokensUsed: 0 });
      expect(msg2.tokensUsed).toBe(0);
      expect(msg2.metadata.tokensUsed).toBe(0);
    });

    it('should set parentMessageId', () => {
      const message = service.createAssistantMessage('response', null, { parentMessageId: 'msg_p' });
      expect(message.parentMessageId).toBe('msg_p');
    });

    it('should set correlationId via Message.createAssistant', () => {
      const message = service.createAssistantMessage('response', null, { correlationId: 'corr_x' });
      expect(message.correlationId).toBe('corr_x');
    });

    it('should merge metadata preserving existing keys (bug fix regression)', () => {
      // Before fix: metadata was REPLACED with options.metadata, losing any keys
      // set by Message.createAssistant. After fix: metadata is MERGED.
      const message = service.createAssistantMessage('response', null, {
        metadata: { custom: 'val' },
        llmModel: 'gpt-4',
      });
      expect(message.metadata.custom).toBe('val');
      expect(message.metadata.model).toBe('gpt-4');
    });

    it('should apply all options simultaneously', () => {
      const message = service.createAssistantMessage('response', 'chat_1', {
        llmModel: 'gpt-4',
        llmProvider: 'openai',
        tokensUsed: 500,
        parentMessageId: 'msg_user',
        correlationId: 'corr_123',
        metadata: { stream: true },
      });
      expect(message.role).toBe('assistant');
      expect(message.chatId).toBe('chat_1');
      expect(message.llmModel).toBe('gpt-4');
      expect(message.llmProvider).toBe('openai');
      expect(message.tokensUsed).toBe(500);
      expect(message.parentMessageId).toBe('msg_user');
      expect(message.correlationId).toBe('corr_123');
      expect(message.metadata.stream).toBe(true);
      expect(message.metadata.model).toBe('gpt-4');
      expect(message.metadata.provider).toBe('openai');
      expect(message.metadata.tokensUsed).toBe(500);
    });

    it('should throw for invalid content', () => {
      expect(() => service.createAssistantMessage('')).toThrow('[MessageService] Invalid message content');
      expect(() => service.createAssistantMessage(null)).toThrow();
      expect(() => service.createAssistantMessage('   ')).toThrow();
    });

    it('should create with streaming status', () => {
      const message = service.createAssistantMessage('response');
      expect(message.status).toBe('streaming');
    });

    it('should not set llmModel when neither llmModel nor model provided', () => {
      const message = service.createAssistantMessage('response');
      expect(message.llmModel).toBeNull();
      expect(message.metadata.model).toBeUndefined();
    });
  });

  // ==================== createSystemMessage — extended ====================

  describe('createSystemMessage — extended', () => {
    it('should propagate chatId', () => {
      const message = service.createSystemMessage('System init', 'chat_sys');
      expect(message.chatId).toBe('chat_sys');
      expect(message.role).toBe('system');
    });

    it('should throw for invalid content', () => {
      expect(() => service.createSystemMessage('')).toThrow();
      expect(() => service.createSystemMessage(null)).toThrow();
    });

    it('should create with complete status', () => {
      const message = service.createSystemMessage('System message');
      expect(message.status).toBe('complete');
    });

    it('should return a Message instance', () => {
      const message = service.createSystemMessage('sys');
      expect(message).toBeInstanceOf(Message);
    });
  });

  // ==================== ASYNC OPERATIONS ====================

  describe('async operations', () => {
    let mockRepo;
    let mockValidator;
    let mockLogger;
    let asyncService;

    beforeEach(() => {
      mockRepo = {
        save: jest.fn(),
        saveBatch: jest.fn(),
        findByChatId: jest.fn(),
        findByRole: jest.fn(),
        findByCorrelationId: jest.fn(),
        findRecent: jest.fn(),
        findWithArtifacts: jest.fn(),
        getStatistics: jest.fn(),
      };
      mockValidator = {
        validateOrThrow: jest.fn().mockReturnValue(true),
        checkRateLimit: jest.fn().mockReturnValue({ allowed: true }),
        checkRateLimitOrThrow: jest.fn().mockReturnValue({ allowed: true }),
        resetRateLimit: jest.fn(),
      };
      mockLogger = {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
      };
      asyncService = new MessageService({
        repository: mockRepo,
        validator: mockValidator,
        logger: mockLogger,
      });
    });

    // ---- saveMessage ----

    describe('saveMessage', () => {
      it('should validate and delegate to repository', async () => {
        const msg = Message.createUser('hello', 'chat_1');
        const savedMsg = msg.clone({ id: 'db_id_1' });
        mockRepo.save.mockResolvedValue(savedMsg);

        const result = await asyncService.saveMessage(msg, 'chat_1');

        expect(mockValidator.validateOrThrow).toHaveBeenCalledWith(msg);
        expect(mockRepo.save).toHaveBeenCalledWith(msg, 'chat_1');
        expect(result).toBe(savedMsg);
        expect(result.id).toBe('db_id_1');
      });

      it('should propagate repository errors and log them', async () => {
        const msg = Message.createUser('hello', 'chat_1');
        const dbError = new Error('DB connection failed');
        mockRepo.save.mockRejectedValue(dbError);

        await expect(asyncService.saveMessage(msg, 'chat_1')).rejects.toThrow('DB connection failed');
        expect(mockLogger.error).toHaveBeenCalledWith(
          '[MessageService] Failed to save message:',
          dbError
        );
      });

      it('should call validator before repository', async () => {
        const callOrder = [];
        mockValidator.validateOrThrow.mockImplementation(() => {
          callOrder.push('validate');
          return true;
        });
        mockRepo.save.mockImplementation(() => {
          callOrder.push('save');
          return Promise.resolve(Message.createUser('x'));
        });

        const msg = Message.createUser('hello', 'chat_1');
        await asyncService.saveMessage(msg, 'chat_1');

        expect(callOrder).toEqual(['validate', 'save']);
      });

      it('should pass chatId as null when not provided', async () => {
        const msg = Message.createUser('hello');
        mockRepo.save.mockResolvedValue(msg);

        await asyncService.saveMessage(msg);
        expect(mockRepo.save).toHaveBeenCalledWith(msg, null);
      });
    });

    // ---- saveMessages ----

    describe('saveMessages', () => {
      it('should validate all messages then delegate to repository', async () => {
        const msg1 = Message.createUser('first');
        const msg2 = Message.createUser('second');
        mockRepo.saveBatch.mockResolvedValue([msg1, msg2]);

        const result = await asyncService.saveMessages([msg1, msg2], 'chat_1');

        expect(mockValidator.validateOrThrow).toHaveBeenCalledTimes(2);
        expect(mockValidator.validateOrThrow).toHaveBeenCalledWith(msg1);
        expect(mockValidator.validateOrThrow).toHaveBeenCalledWith(msg2);
        expect(mockRepo.saveBatch).toHaveBeenCalledWith([msg1, msg2], 'chat_1');
        expect(result).toEqual([msg1, msg2]);
      });

      it('should propagate repository errors', async () => {
        const msg1 = Message.createUser('first');
        mockRepo.saveBatch.mockRejectedValue(new Error('Batch failed'));

        await expect(asyncService.saveMessages([msg1], 'chat_1')).rejects.toThrow('Batch failed');
        expect(mockLogger.error).toHaveBeenCalledWith(
          '[MessageService] Failed to save message batch:',
          expect.any(Error)
        );
      });

      it('should validate ALL messages before saving any', async () => {
        const callOrder = [];
        let validateCount = 0;
        mockValidator.validateOrThrow.mockImplementation(() => {
          validateCount++;
          callOrder.push('validate_' + validateCount);
          return true;
        });
        mockRepo.saveBatch.mockImplementation(() => {
          callOrder.push('saveBatch');
          return Promise.resolve([]);
        });

        const msgs = [Message.createUser('a'), Message.createUser('b'), Message.createUser('c')];
        await asyncService.saveMessages(msgs, 'chat_1');

        expect(callOrder).toEqual(['validate_1', 'validate_2', 'validate_3', 'saveBatch']);
      });
    });

    // ---- loadMessages ----

    describe('loadMessages', () => {
      it('should delegate to repository.findByChatId', async () => {
        const msgs = [Message.createUser('a'), Message.createAssistant('b')];
        mockRepo.findByChatId.mockResolvedValue(msgs);

        const result = await asyncService.loadMessages('chat_1');

        expect(mockRepo.findByChatId).toHaveBeenCalledWith('chat_1');
        expect(result).toBe(msgs);
        expect(result).toHaveLength(2);
      });

      it('should propagate errors and log them', async () => {
        mockRepo.findByChatId.mockRejectedValue(new Error('Load failed'));

        await expect(asyncService.loadMessages('chat_1')).rejects.toThrow('Load failed');
        expect(mockLogger.error).toHaveBeenCalledWith(
          expect.stringContaining('Failed to load messages for chat chat_1'),
          expect.any(Error)
        );
      });
    });

    // ---- getMessagesByRole (BUG FIX regression) ----

    describe('getMessagesByRole', () => {
      it('should delegate to repository.findByRole without broken validator call', async () => {
        const userMsgs = [Message.createUser('hello')];
        mockRepo.findByRole.mockResolvedValue(userMsgs);

        const result = await asyncService.getMessagesByRole('chat_1', 'user');

        expect(mockRepo.findByRole).toHaveBeenCalledWith('chat_1', 'user');
        expect(result).toBe(userMsgs);
        // Validator.validateOrThrow should NOT be called by this method
        expect(mockValidator.validateOrThrow).not.toHaveBeenCalled();
      });

      it('should propagate repository errors', async () => {
        mockRepo.findByRole.mockRejectedValue(new Error('Role query failed'));

        await expect(asyncService.getMessagesByRole('chat_1', 'user')).rejects.toThrow('Role query failed');
        expect(mockLogger.error).toHaveBeenCalledWith(
          expect.stringContaining('Failed to get messages by role user'),
          expect.any(Error)
        );
      });
    });

    // ---- getMessagesByCorrelationId (BUG FIX regression) ----

    describe('getMessagesByCorrelationId', () => {
      it('should delegate to repository without broken validator call', async () => {
        const correlated = [Message.createUser('q'), Message.createAssistant('a')];
        mockRepo.findByCorrelationId.mockResolvedValue(correlated);

        const result = await asyncService.getMessagesByCorrelationId('chat_1', 'corr_abc');

        expect(mockRepo.findByCorrelationId).toHaveBeenCalledWith('chat_1', 'corr_abc');
        expect(result).toBe(correlated);
      });

      it('should propagate repository errors', async () => {
        mockRepo.findByCorrelationId.mockRejectedValue(new Error('Corr query failed'));

        await expect(
          asyncService.getMessagesByCorrelationId('chat_1', 'corr_abc')
        ).rejects.toThrow('Corr query failed');
        expect(mockLogger.error).toHaveBeenCalled();
      });
    });

    // ---- getRecentMessages ----

    describe('getRecentMessages', () => {
      it('should delegate to repository.findRecent with default limit of 20', async () => {
        mockRepo.findRecent.mockResolvedValue([]);

        await asyncService.getRecentMessages('chat_1');

        expect(mockRepo.findRecent).toHaveBeenCalledWith('chat_1', 20);
      });

      it('should pass custom limit to repository', async () => {
        mockRepo.findRecent.mockResolvedValue([]);

        await asyncService.getRecentMessages('chat_1', 5);

        expect(mockRepo.findRecent).toHaveBeenCalledWith('chat_1', 5);
      });

      it('should propagate errors', async () => {
        mockRepo.findRecent.mockRejectedValue(new Error('Recent failed'));

        await expect(asyncService.getRecentMessages('chat_1')).rejects.toThrow('Recent failed');
        expect(mockLogger.error).toHaveBeenCalled();
      });
    });

    // ---- getMessagesWithArtifacts ----

    describe('getMessagesWithArtifacts', () => {
      it('should delegate to repository.findWithArtifacts', async () => {
        const withArtifacts = [Message.createUser('has artifact')];
        mockRepo.findWithArtifacts.mockResolvedValue(withArtifacts);

        const result = await asyncService.getMessagesWithArtifacts('chat_1');

        expect(mockRepo.findWithArtifacts).toHaveBeenCalledWith('chat_1');
        expect(result).toBe(withArtifacts);
      });

      it('should propagate errors', async () => {
        mockRepo.findWithArtifacts.mockRejectedValue(new Error('Artifacts failed'));

        await expect(asyncService.getMessagesWithArtifacts('chat_1')).rejects.toThrow('Artifacts failed');
        expect(mockLogger.error).toHaveBeenCalled();
      });
    });

    // ---- getStatistics ----

    describe('getStatistics', () => {
      it('should delegate to repository.getStatistics and return exact structure', async () => {
        const stats = {
          total: 10,
          user: 5,
          assistant: 4,
          system: 1,
          totalTokens: 2500,
          withArtifacts: 2,
        };
        mockRepo.getStatistics.mockResolvedValue(stats);

        const result = await asyncService.getStatistics('chat_1');

        expect(mockRepo.getStatistics).toHaveBeenCalledWith('chat_1');
        expect(result).toEqual(stats);
      });

      it('should propagate errors', async () => {
        mockRepo.getStatistics.mockRejectedValue(new Error('Stats failed'));

        await expect(asyncService.getStatistics('chat_1')).rejects.toThrow('Stats failed');
        expect(mockLogger.error).toHaveBeenCalled();
      });
    });

    // ---- saveCorrelatedPair ----

    describe('saveCorrelatedPair', () => {
      it('should save both messages and return both results', async () => {
        const userMsg = Message.createUser('question');
        const assistantMsg = Message.createAssistant('answer');
        const savedUser = userMsg.clone({ id: 'saved_u' });
        const savedAssistant = assistantMsg.clone({ id: 'saved_a' });

        mockRepo.save.mockResolvedValueOnce(savedUser).mockResolvedValueOnce(savedAssistant);

        const result = await asyncService.saveCorrelatedPair(userMsg, assistantMsg, 'chat_1');

        expect(mockRepo.save).toHaveBeenCalledTimes(2);
        expect(result.userMessage).toBe(savedUser);
        expect(result.assistantMessage).toBe(savedAssistant);
      });

      it('should save user message before assistant message (sequential)', async () => {
        const callOrder = [];
        mockRepo.save.mockImplementation((msg) => {
          callOrder.push(msg.role);
          return Promise.resolve(msg.clone({ id: 'saved_' + msg.role }));
        });

        const userMsg = Message.createUser('q');
        const assistantMsg = Message.createAssistant('a');
        await asyncService.saveCorrelatedPair(userMsg, assistantMsg, 'chat_1');

        expect(callOrder).toEqual(['user', 'assistant']);
      });

      it('should propagate error if user message save fails', async () => {
        mockRepo.save.mockRejectedValue(new Error('User save failed'));

        const userMsg = Message.createUser('q');
        const assistantMsg = Message.createAssistant('a');

        await expect(
          asyncService.saveCorrelatedPair(userMsg, assistantMsg, 'chat_1')
        ).rejects.toThrow('User save failed');
        // Logged by both saveMessage and saveCorrelatedPair
        expect(mockLogger.error).toHaveBeenCalled();
      });

      it('should propagate error if assistant message save fails', async () => {
        const userMsg = Message.createUser('q');
        const assistantMsg = Message.createAssistant('a');
        mockRepo.save
          .mockResolvedValueOnce(userMsg.clone({ id: 'saved_u' }))
          .mockRejectedValueOnce(new Error('Assistant save failed'));

        await expect(
          asyncService.saveCorrelatedPair(userMsg, assistantMsg, 'chat_1')
        ).rejects.toThrow('Assistant save failed');
      });

      it('should not attempt assistant save if user save fails', async () => {
        mockRepo.save.mockRejectedValueOnce(new Error('first fails'));

        const userMsg = Message.createUser('q');
        const assistantMsg = Message.createAssistant('a');

        await expect(
          asyncService.saveCorrelatedPair(userMsg, assistantMsg, 'chat_1')
        ).rejects.toThrow('first fails');
        // Only one save attempted because first threw
        expect(mockRepo.save).toHaveBeenCalledTimes(1);
      });
    });

    // ---- Rate limiting delegation ----

    describe('rate limiting delegation', () => {
      it('should delegate checkRateLimit to validator', () => {
        const result = asyncService.checkRateLimit('session_1');
        expect(mockValidator.checkRateLimit).toHaveBeenCalledWith('session_1');
        expect(result).toEqual({ allowed: true });
      });

      it('should delegate checkRateLimitOrThrow to validator', () => {
        const result = asyncService.checkRateLimitOrThrow('session_1');
        expect(mockValidator.checkRateLimitOrThrow).toHaveBeenCalledWith('session_1');
        expect(result).toEqual({ allowed: true });
      });

      it('should delegate resetRateLimit to validator (bug fix regression)', () => {
        asyncService.resetRateLimit('session_1');
        expect(mockValidator.resetRateLimit).toHaveBeenCalledWith('session_1');
      });
    });
  });

  // ==================== Rate limiting with real validator (integration) ====================

  describe('rate limiting with real validator', () => {
    it('should not throw when calling checkRateLimit', () => {
      const result = service.checkRateLimit('session_1');
      expect(result).toEqual({ allowed: true });
    });

    it('should not throw when calling checkRateLimitOrThrow', () => {
      const result = service.checkRateLimitOrThrow('session_1');
      expect(result).toEqual({ allowed: true });
    });

    it('should not throw when calling resetRateLimit (bug fix — stub was missing)', () => {
      // Before fix: MessageValidator was missing resetRateLimit deprecated stub.
      // Calling this would throw TypeError: this.validator.resetRateLimit is not a function
      expect(() => service.resetRateLimit('session_1')).not.toThrow();
    });
  });

  // ==================== createCorrelatedPair ====================

  describe('createCorrelatedPair', () => {
    it('should create user and assistant messages with shared correlationId', () => {
      const { userMessage, assistantMessage, correlationId } = service.createCorrelatedPair(
        'What is 2+2?',
        'The answer is 4.',
        'chat_1'
      );

      expect(userMessage).toBeInstanceOf(Message);
      expect(assistantMessage).toBeInstanceOf(Message);
      expect(userMessage.role).toBe('user');
      expect(assistantMessage.role).toBe('assistant');
      expect(userMessage.content).toBe('What is 2+2?');
      expect(assistantMessage.content).toBe('The answer is 4.');
      expect(correlationId).toMatch(/^(msg_|corr_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(userMessage.correlationId).toBe(correlationId);
      expect(assistantMessage.correlationId).toBe(correlationId);
    });

    it('should link assistant as child of user via parentMessageId', () => {
      const { userMessage, assistantMessage } = service.createCorrelatedPair(
        'question', 'answer'
      );

      expect(assistantMessage.parentMessageId).toBe(userMessage.id);
    });

    it('should forward LLM options to assistant message', () => {
      const { assistantMessage } = service.createCorrelatedPair(
        'question', 'answer', 'chat_1',
        { llmModel: 'gpt-4', llmProvider: 'openai', tokensUsed: 250 }
      );

      expect(assistantMessage.llmModel).toBe('gpt-4');
      expect(assistantMessage.llmProvider).toBe('openai');
      expect(assistantMessage.tokensUsed).toBe(250);
    });

    it('should forward user metadata to user message', () => {
      const { userMessage } = service.createCorrelatedPair(
        'question', 'answer', null,
        { userMetadata: { source: 'web' } }
      );

      expect(userMessage.metadata.source).toBe('web');
    });

    it('should forward assistant metadata to assistant message', () => {
      const { assistantMessage } = service.createCorrelatedPair(
        'question', 'answer', null,
        { assistantMetadata: { cached: true } }
      );

      expect(assistantMessage.metadata.cached).toBe(true);
    });

    it('should propagate chatId to both messages', () => {
      const { userMessage, assistantMessage } = service.createCorrelatedPair(
        'q', 'a', 'chat_xyz'
      );

      expect(userMessage.chatId).toBe('chat_xyz');
      expect(assistantMessage.chatId).toBe('chat_xyz');
    });

    it('should generate unique correlationIds across calls', () => {
      const pair1 = service.createCorrelatedPair('q1', 'a1');
      const pair2 = service.createCorrelatedPair('q2', 'a2');

      expect(pair1.correlationId).not.toBe(pair2.correlationId);
    });

    it('should throw if user content is invalid', () => {
      expect(() => service.createCorrelatedPair('', 'answer')).toThrow();
    });

    it('should throw if assistant content is invalid', () => {
      expect(() => service.createCorrelatedPair('question', '')).toThrow();
    });
  });

  // ==================== formatForLLM ====================

  describe('formatForLLM', () => {
    it('should format messages to role/content pairs only', () => {
      const messages = [
        new Message({ role: 'user', content: 'hello' }),
        new Message({ role: 'assistant', content: 'hi there' }),
      ];

      const result = service.formatForLLM(messages);

      expect(result).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ]);
    });

    it('should filter out system messages', () => {
      const messages = [
        new Message({ role: 'system', content: 'You are helpful' }),
        new Message({ role: 'user', content: 'hello' }),
        new Message({ role: 'assistant', content: 'hi' }),
      ];

      const result = service.formatForLLM(messages);

      expect(result).toHaveLength(2);
      expect(result.every(m => m.role !== 'system')).toBe(true);
      expect(result[0].role).toBe('user');
      expect(result[1].role).toBe('assistant');
    });

    it('should strip all extra fields — output has only role and content', () => {
      const msg = new Message({
        role: 'user',
        content: 'test',
        id: 'msg_123',
        chatId: 'chat_1',
        metadata: { source: 'web' },
        timestamp: Date.now(),
      });

      const result = service.formatForLLM([msg]);

      expect(Object.keys(result[0]).sort()).toEqual(['content', 'role']);
    });

    it('should throw for non-array input', () => {
      expect(() => service.formatForLLM('not an array')).toThrow('Messages must be an array');
      expect(() => service.formatForLLM(null)).toThrow('Messages must be an array');
      expect(() => service.formatForLLM({})).toThrow('Messages must be an array');
      expect(() => service.formatForLLM(undefined)).toThrow('Messages must be an array');
    });

    it('should return empty array for empty input', () => {
      expect(service.formatForLLM([])).toEqual([]);
    });

    it('should return empty array when all messages are system', () => {
      const messages = [
        new Message({ role: 'system', content: 'sys1' }),
        new Message({ role: 'system', content: 'sys2' }),
      ];
      expect(service.formatForLLM(messages)).toEqual([]);
    });

    it('should preserve message ordering', () => {
      const messages = [
        new Message({ role: 'user', content: 'first' }),
        new Message({ role: 'assistant', content: 'second' }),
        new Message({ role: 'user', content: 'third' }),
      ];

      const result = service.formatForLLM(messages);

      expect(result.map(m => m.content)).toEqual(['first', 'second', 'third']);
    });
  });

  // ==================== extractThinking ====================

  describe('extractThinking', () => {
    it('should extract thinking content from tags', () => {
      const msg = new Message({
        role: 'assistant',
        content: '<think>I should reason about this</think>The answer is 42.',
      });

      const result = service.extractThinking(msg);

      expect(result.thinking).toBe('I should reason about this');
      expect(result.content).toBe('The answer is 42.');
    });

    it('should return null thinking when no tags present', () => {
      const msg = new Message({ role: 'assistant', content: 'Plain answer' });

      const result = service.extractThinking(msg);

      expect(result.thinking).toBeNull();
      expect(result.content).toBe('Plain answer');
    });

    it('should handle thinking at the start of content', () => {
      const msg = new Message({
        role: 'assistant',
        content: '<think>reasoning</think>conclusion',
      });

      const result = service.extractThinking(msg);

      expect(result.thinking).toBe('reasoning');
      expect(result.content).toBe('conclusion');
    });

    it('should handle thinking in the middle of content', () => {
      const msg = new Message({
        role: 'assistant',
        content: 'Before <think>middle thought</think> After',
      });

      const result = service.extractThinking(msg);

      expect(result.thinking).toBe('middle thought');
      // Double space preserved between Before and After (both adjacent spaces remain)
      expect(result.content).toBe('Before  After');
    });

    it('should handle empty thinking tags', () => {
      const msg = new Message({
        role: 'assistant',
        content: '<think></think>Real content',
      });

      const result = service.extractThinking(msg);

      expect(result.thinking).toBe('');
      expect(result.content).toBe('Real content');
    });

    it('should return null thinking when only open tag exists', () => {
      const msg = new Message({
        role: 'assistant',
        content: '<think>orphaned open tag',
      });

      const result = service.extractThinking(msg);

      expect(result.thinking).toBeNull();
      expect(result.content).toBe('<think>orphaned open tag');
    });

    it('should return null thinking when only close tag exists', () => {
      const msg = new Message({
        role: 'assistant',
        content: 'orphaned close tag</think>',
      });

      const result = service.extractThinking(msg);

      expect(result.thinking).toBeNull();
      expect(result.content).toBe('orphaned close tag</think>');
    });

    it('should return null thinking when close tag appears before open tag', () => {
      const msg = new Message({
        role: 'assistant',
        content: '</think>backwards<think>',
      });

      const result = service.extractThinking(msg);

      expect(result.thinking).toBeNull();
      expect(result.content).toBe('</think>backwards<think>');
    });

    it('should throw for non-Message input', () => {
      expect(() => service.extractThinking({ content: 'test' })).toThrow('Must provide Message instance');
      expect(() => service.extractThinking('string')).toThrow('Must provide Message instance');
      expect(() => service.extractThinking(null)).toThrow('Must provide Message instance');
    });

    it('should trim whitespace from extracted thinking', () => {
      const msg = new Message({
        role: 'assistant',
        content: '<think>  padded thought  </think>answer',
      });

      const result = service.extractThinking(msg);

      expect(result.thinking).toBe('padded thought');
    });

    it('should handle multiline thinking content', () => {
      const msg = new Message({
        role: 'assistant',
        content: '<think>line1\nline2\nline3</think>Response',
      });

      const result = service.extractThinking(msg);

      expect(result.thinking).toBe('line1\nline2\nline3');
      expect(result.content).toBe('Response');
    });

    it('should handle content that is only thinking with no response', () => {
      const msg = new Message({
        role: 'assistant',
        content: '<think>just thinking</think>',
      });

      const result = service.extractThinking(msg);

      expect(result.thinking).toBe('just thinking');
      expect(result.content).toBe('');
    });
  });

  // ==================== _isValidMessageShape — edge cases ====================

  describe('_isValidMessageShape via validateMessage — edge cases', () => {
    it('should reject null', () => {
      expect(service.validateMessage(null)).toBe(false);
    });

    it('should reject undefined', () => {
      expect(service.validateMessage(undefined)).toBe(false);
    });

    it('should reject non-object types', () => {
      expect(service.validateMessage(42)).toBe(false);
      expect(service.validateMessage('string')).toBe(false);
      expect(service.validateMessage(true)).toBe(false);
    });

    it('should reject array (typeof array is object)', () => {
      // Arrays are objects but should not pass as valid messages
      expect(service.validateMessage([])).toBe(false);
      expect(service.validateMessage([{ role: 'user', content: 'test' }])).toBe(false);
    });

    it('should reject message with numeric content', () => {
      expect(service.validateMessage({ role: 'user', content: 123 })).toBe(false);
    });

    it('should reject message with whitespace-only content', () => {
      expect(service.validateMessage({ role: 'user', content: '   ' })).toBe(false);
      expect(service.validateMessage({ role: 'user', content: '\t\n' })).toBe(false);
    });

    it('should accept all three valid roles', () => {
      expect(service.validateMessage({ role: 'user', content: 'test' })).toBe(true);
      expect(service.validateMessage({ role: 'assistant', content: 'test' })).toBe(true);
      expect(service.validateMessage({ role: 'system', content: 'test' })).toBe(true);
    });

    it('should reject unknown roles', () => {
      expect(service.validateMessage({ role: 'admin', content: 'test' })).toBe(false);
      expect(service.validateMessage({ role: 'tool', content: 'test' })).toBe(false);
      expect(service.validateMessage({ role: '', content: 'test' })).toBe(false);
    });

    it('should reject message with numeric role', () => {
      expect(service.validateMessage({ role: 42, content: 'test' })).toBe(false);
    });

    it('should reject message with null role', () => {
      expect(service.validateMessage({ role: null, content: 'test' })).toBe(false);
    });
  });
});

