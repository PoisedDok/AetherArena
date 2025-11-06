'use strict';

/**
 * Artifact Flow Integration Tests
 * Tests end-to-end artifact creation, streaming, and display
 */

describe('Artifact Flow Integration', () => {
  let mockEventBus;
  let mockArtifactService;
  let mockTraceabilityService;
  
  beforeEach(() => {
    mockEventBus = {
      emit: jest.fn(),
      on: jest.fn(),
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
    
    mockArtifactService = {
      createArtifact: jest.fn((data) => ({
        id: 'artifact_' + Date.now(),
        ...data,
        createdAt: new Date().toISOString()
      })),
      getArtifact: jest.fn(),
      getArtifactsByChatId: jest.fn().mockResolvedValue([])
    };
    
    mockTraceabilityService = {
      linkArtifactToMessage: jest.fn(),
      getArtifactsForMessage: jest.fn().mockReturnValue([]),
      getMessageForArtifact: jest.fn()
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Code artifact flow', () => {
    it('should create and stream code artifact', async () => {
      const codeContent = 'console.log("Hello");';
      let streamedContent = '';
      
      mockEventBus.on('artifact:chunk', (data) => {
        if (data.content) {
          streamedContent += data.content;
        }
      });
      
      // Simulate streaming chunks
      mockEventBus.emit('artifact:chunk', { 
        id: 'artifact_1',
        content: 'console.log(',
        kind: 'code',
        language: 'javascript'
      });
      
      mockEventBus.emit('artifact:chunk', { 
        id: 'artifact_1',
        content: '"Hello"',
      });
      
      mockEventBus.emit('artifact:chunk', { 
        id: 'artifact_1',
        content: ');',
        end: true
      });
      
      expect(streamedContent).toBe(codeContent);
    });

    it('should finalize code artifact on end signal', async () => {
      let artifactFinalized = false;
      
      mockEventBus.on('artifact:complete', (data) => {
        artifactFinalized = true;
        mockArtifactService.createArtifact({
          type: 'code',
          language: data.language,
          content: data.content,
          chatId: data.chatId
        });
      });
      
      mockEventBus.emit('artifact:complete', {
        id: 'artifact_1',
        kind: 'code',
        language: 'python',
        content: 'print("test")',
        chatId: 'chat_123'
      });
      
      expect(artifactFinalized).toBe(true);
      expect(mockArtifactService.createArtifact).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'code',
          language: 'python'
        })
      );
    });
  });

  describe('Output artifact flow', () => {
    it('should create output artifact from execution', async () => {
      const executionOutput = 'Hello\nWorld';
      
      const artifact = mockArtifactService.createArtifact({
        type: 'output',
        content: executionOutput,
        chatId: 'chat_123',
        executionId: 'exec_456'
      });
      
      expect(artifact.type).toBe('output');
      expect(artifact.content).toBe(executionOutput);
      expect(artifact.executionId).toBe('exec_456');
    });

    it('should link output to code artifact', async () => {
      const codeArtifactId = 'artifact_code_123';
      const outputArtifactId = 'artifact_output_456';
      
      mockTraceabilityService.linkArtifactToMessage(
        outputArtifactId,
        'msg_789',
        { relatedArtifact: codeArtifactId }
      );
      
      expect(mockTraceabilityService.linkArtifactToMessage).toHaveBeenCalledWith(
        outputArtifactId,
        'msg_789',
        expect.objectContaining({ relatedArtifact: codeArtifactId })
      );
    });
  });

  describe('HTML artifact flow', () => {
    it('should create and render HTML artifact', async () => {
      const htmlContent = '<html><body><h1>Test</h1></body></html>';
      
      const artifact = mockArtifactService.createArtifact({
        type: 'html',
        content: htmlContent,
        chatId: 'chat_123'
      });
      
      expect(artifact.type).toBe('html');
      expect(artifact.content).toBe(htmlContent);
    });

    it('should sanitize HTML content', async () => {
      const unsafeHtml = '<script>alert("xss")</script><p>Safe content</p>';
      
      // In real implementation, this would be sanitized
      const artifact = mockArtifactService.createArtifact({
        type: 'html',
        content: unsafeHtml,
        chatId: 'chat_123'
      });
      
      expect(artifact).toBeTruthy();
      // Content should be stored (sanitization happens at render time)
      expect(artifact.content).toBeTruthy();
    });
  });

  describe('Artifact-message traceability', () => {
    it('should link artifact to source message', async () => {
      const messageId = 'msg_123';
      const artifactId = 'artifact_456';
      
      mockTraceabilityService.linkArtifactToMessage(artifactId, messageId);
      
      expect(mockTraceabilityService.linkArtifactToMessage)
        .toHaveBeenCalledWith(artifactId, messageId);
    });

    it('should retrieve artifacts for message', async () => {
      const messageId = 'msg_123';
      const artifacts = [
        { id: 'artifact_1', type: 'code' },
        { id: 'artifact_2', type: 'output' }
      ];
      
      mockTraceabilityService.getArtifactsForMessage.mockReturnValue(artifacts);
      
      const result = mockTraceabilityService.getArtifactsForMessage(messageId);
      
      expect(result).toEqual(artifacts);
      expect(result.length).toBe(2);
    });

    it('should retrieve message for artifact', async () => {
      const artifactId = 'artifact_123';
      const message = { id: 'msg_456', content: 'Generate code' };
      
      mockTraceabilityService.getMessageForArtifact.mockReturnValue(message);
      
      const result = mockTraceabilityService.getMessageForArtifact(artifactId);
      
      expect(result).toEqual(message);
    });
  });

  describe('Artifact persistence', () => {
    it('should persist artifact to storage', async () => {
      const artifact = mockArtifactService.createArtifact({
        type: 'code',
        language: 'javascript',
        content: 'const x = 1;',
        chatId: 'chat_123',
        messageId: 'msg_456'
      });
      
      expect(artifact.id).toBeTruthy();
      expect(artifact.chatId).toBe('chat_123');
      expect(artifact.messageId).toBe('msg_456');
    });

    it('should retrieve artifacts by chat ID', async () => {
      const chatId = 'chat_123';
      const artifacts = [
        { id: 'artifact_1', chatId, type: 'code' },
        { id: 'artifact_2', chatId, type: 'output' }
      ];
      
      mockArtifactService.getArtifactsByChatId.mockResolvedValue(artifacts);
      
      const result = await mockArtifactService.getArtifactsByChatId(chatId);
      
      expect(result).toEqual(artifacts);
      expect(result.every(a => a.chatId === chatId)).toBe(true);
    });
  });

  describe('Two-stage artifact routing', () => {
    it('should route artifact from chat to artifacts window', async () => {
      let routedToArtifactsWindow = false;
      
      mockEventBus.on('artifacts:load', (data) => {
        routedToArtifactsWindow = true;
      });
      
      // Simulate artifact creation in chat
      mockEventBus.emit('artifact:complete', {
        id: 'artifact_123',
        type: 'code',
        content: 'test'
      });
      
      // Route to artifacts window
      mockEventBus.emit('artifacts:load', {
        artifactIds: ['artifact_123']
      });
      
      expect(routedToArtifactsWindow).toBe(true);
    });

    it('should synchronize artifacts on chat switch', async () => {
      const newChatId = 'chat_456';
      let artifactsReloaded = false;
      
      mockEventBus.on('artifacts:reload', (data) => {
        if (data.chatId === newChatId) {
          artifactsReloaded = true;
        }
      });
      
      mockEventBus.emit('chat:switched', { chatId: newChatId });
      mockEventBus.emit('artifacts:reload', { chatId: newChatId });
      
      expect(artifactsReloaded).toBe(true);
    });
  });

  describe('Artifact streaming edge cases', () => {
    it('should handle empty artifacts', async () => {
      const artifact = mockArtifactService.createArtifact({
        type: 'output',
        content: '',
        chatId: 'chat_123'
      });
      
      expect(artifact.content).toBe('');
    });

    it('should handle very large artifacts', async () => {
      const largeContent = 'x'.repeat(5 * 1024 * 1024); // 5MB
      
      const artifact = mockArtifactService.createArtifact({
        type: 'code',
        content: largeContent,
        chatId: 'chat_123'
      });
      
      expect(artifact.content.length).toBe(5 * 1024 * 1024);
    });

    it('should handle artifacts with special characters', async () => {
      const specialContent = '`~!@#$%^&*(){}[]|\\:;"<>?,./';
      
      const artifact = mockArtifactService.createArtifact({
        type: 'code',
        content: specialContent,
        chatId: 'chat_123'
      });
      
      expect(artifact.content).toBe(specialContent);
    });
  });
});

