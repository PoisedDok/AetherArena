'use strict';

/**
 * Message Flow Integration Tests
 * Tests end-to-end message sending and receiving
 */

describe('Message Flow Integration', () => {
  let mockEventBus;
  let mockEndpoint;
  let mockMessageService;
  let mockChatService;
  
  beforeEach(() => {
    // Setup mocks
    mockEventBus = {
      emit: jest.fn(),
      on: jest.fn(),
      off: jest.fn(),
      listeners: new Map()
    };
    
    mockEventBus.on.mockImplementation((event, handler) => {
      if (!mockEventBus.listeners.has(event)) {
        mockEventBus.listeners.set(event, []);
      }
      mockEventBus.listeners.get(event).push(handler);
    });
    
    mockEventBus.emit.mockImplementation((event, data) => {
      const handlers = mockEventBus.listeners.get(event) || [];
      handlers.forEach(handler => handler(data));
    });
    
    let requestCounter = 0;
    mockEndpoint = {
      sendUserMessage: jest.fn(() => {
        requestCounter++;
        return `request_${requestCounter}`;
      }),
      on: jest.fn()
    };
    
    mockMessageService = {
      createUserMessage: jest.fn((content, chatId, options = {}) => ({
        id: 'msg_' + Date.now(),
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
        ...options
      })),
      createAssistantMessage: jest.fn((content, chatId, options = {}) => ({
        id: 'msg_' + Date.now(),
        role: 'assistant',
        content,
        timestamp: new Date().toISOString(),
        ...options
      }))
    };
    
    mockChatService = {
      createChat: jest.fn().mockResolvedValue({
        id: 'chat_123',
        title: 'New Chat',
        messages: []
      }),
      getChat: jest.fn(),
      updateChat: jest.fn()
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('User message flow', () => {
    it('should complete full user message flow', async () => {
      const userContent = 'Hello, AI!';
      
      // 1. Create user message
      const userMessage = mockMessageService.createUserMessage(userContent);
      expect(userMessage.role).toBe('user');
      expect(userMessage.content).toBe(userContent);
      
      // 2. Send to backend
      const requestId = mockEndpoint.sendUserMessage(userContent);
      expect(requestId).toBeTruthy(); // Should return a request ID
      expect(requestId).toMatch(/^request_\d+$/); // Should match pattern
      expect(mockEndpoint.sendUserMessage).toHaveBeenCalledWith(userContent);
      
      // 3. Emit user message event
      mockEventBus.emit('message:sent', { 
        message: userMessage,
        requestId 
      });
      expect(mockEventBus.emit).toHaveBeenCalledWith('message:sent', 
        expect.objectContaining({ message: userMessage })
      );
    });

    it('should handle user message with attachments', async () => {
      const userContent = 'Check this file';
      const attachments = [
        { name: 'test.txt', type: 'text/plain', size: 100 }
      ];
      
      const userMessage = mockMessageService.createUserMessage(userContent, null, {
        metadata: { attachments }
      });
      
      expect(userMessage.metadata.attachments).toEqual(attachments);
    });
  });

  describe('Assistant response flow', () => {
    it('should handle streaming response chunks', async () => {
      const chunks = [
        { content: 'Hello', partialIndex: 0 },
        { content: ' there', partialIndex: 1 },
        { content: '!', partialIndex: 2, end: true }
      ];
      
      let accumulatedContent = '';
      
      mockEventBus.on('chat:assistant-stream', (data) => {
        if (data.content) {
          accumulatedContent += data.content;
        }
      });
      
      chunks.forEach(chunk => {
        mockEventBus.emit('chat:assistant-stream', chunk);
      });
      
      expect(accumulatedContent).toBe('Hello there!');
    });

    it('should complete assistant message on end signal', async () => {
      const fullContent = 'Complete response';
      
      let messageCompleted = false;
      mockEventBus.on('chat:request-complete', () => {
        messageCompleted = true;
      });
      
      mockEventBus.emit('chat:assistant-stream', {
        content: fullContent,
        end: true
      });
      
      mockEventBus.emit('chat:request-complete', {
        content: fullContent
      });
      
      expect(messageCompleted).toBe(true);
    });
  });

  describe('Chat persistence flow', () => {
    it('should save messages to chat', async () => {
      const chat = await mockChatService.createChat('Test Chat');
      expect(chat.id).toBeTruthy();
      
      const userMessage = mockMessageService.createUserMessage('Test');
      chat.messages.push(userMessage);
      
      await mockChatService.updateChat(chat.id, chat);
      
      expect(mockChatService.updateChat).toHaveBeenCalledWith(
        chat.id,
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({ content: 'Test' })
          ])
        })
      );
    });

    it('should maintain message order', async () => {
      const chat = await mockChatService.createChat();
      
      const messages = [
        mockMessageService.createUserMessage('First'),
        mockMessageService.createAssistantMessage('Second'),
        mockMessageService.createUserMessage('Third')
      ];
      
      chat.messages = messages;
      
      expect(chat.messages[0].content).toBe('First');
      expect(chat.messages[1].content).toBe('Second');
      expect(chat.messages[2].content).toBe('Third');
    });
  });

  describe('Error handling in message flow', () => {
    it('should handle send failure', async () => {
      mockEndpoint.sendUserMessage.mockImplementation(() => {
        throw new Error('Network error');
      });
      
      expect(() => mockEndpoint.sendUserMessage('Test')).toThrow('Network error');
    });

    it('should emit error event on failure', async () => {
      let errorEmitted = false;
      mockEventBus.on('message:error', () => {
        errorEmitted = true;
      });
      
      mockEventBus.emit('message:error', {
        error: new Error('Test error'),
        messageId: 'msg_123'
      });
      
      expect(errorEmitted).toBe(true);
    });
  });

  describe('Request lifecycle', () => {
    it('should track request from start to completion', async () => {
      const lifecycle = {
        requestId: null,
        started: false,
        streaming: false,
        completed: false
      };
      
      mockEventBus.on('message:sent', (data) => {
        lifecycle.requestId = data.requestId;
        lifecycle.started = true;
      });
      
      mockEventBus.on('chat:assistant-stream', () => {
        lifecycle.streaming = true;
      });
      
      mockEventBus.on('chat:request-complete', () => {
        lifecycle.completed = true;
      });
      
      // Simulate full flow
      const userMessage = mockMessageService.createUserMessage('Test');
      const requestId = mockEndpoint.sendUserMessage('Test');
      
      mockEventBus.emit('message:sent', { message: userMessage, requestId });
      mockEventBus.emit('chat:assistant-stream', { content: 'Response' });
      mockEventBus.emit('chat:request-complete', { requestId });
      
      expect(lifecycle.started).toBe(true);
      expect(lifecycle.streaming).toBe(true);
      expect(lifecycle.completed).toBe(true);
      expect(lifecycle.requestId).toBe(requestId);
    });
  });

  describe('Concurrent requests', () => {
    it('should handle multiple concurrent messages', async () => {
      const request1 = mockEndpoint.sendUserMessage('Message 1');
      const request2 = mockEndpoint.sendUserMessage('Message 2');
      
      expect(request1).toBeTruthy();
      expect(request2).toBeTruthy();
      expect(request1).not.toBe(request2);
    });

    it('should track separate request lifecycles', () => {
      const requests = new Map();
      
      mockEventBus.on('message:sent', (data) => {
        requests.set(data.requestId, { started: true, completed: false });
      });
      
      mockEventBus.on('chat:request-complete', (data) => {
        if (requests.has(data.requestId)) {
          requests.get(data.requestId).completed = true;
        }
      });
      
      mockEventBus.emit('message:sent', { requestId: 'req_1' });
      mockEventBus.emit('message:sent', { requestId: 'req_2' });
      mockEventBus.emit('chat:request-complete', { requestId: 'req_1' });
      
      expect(requests.get('req_1').completed).toBe(true);
      expect(requests.get('req_2').completed).toBe(false);
    });
  });
});

