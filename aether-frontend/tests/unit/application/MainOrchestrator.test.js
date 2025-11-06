'use strict';

/**
 * MainOrchestrator Unit Tests
 * Tests the application layer MainOrchestrator
 */

const { MainOrchestrator } = require('../../../src/application/main/MainOrchestrator');

describe('MainOrchestrator', () => {
  let orchestrator;
  let mockContainer;
  let mockEventBus;
  let mockGuruConnection;
  let mockEndpoint;
  
  beforeEach(() => {
    mockEventBus = {
      emit: jest.fn(),
      on: jest.fn(),
      off: jest.fn()
    };
    
    mockGuruConnection = {
      connect: jest.fn().mockResolvedValue(true),
      disconnect: jest.fn().mockResolvedValue(true),
      isConnected: jest.fn().mockReturnValue(true)
    };
    
    mockEndpoint = {
      getHealth: jest.fn().mockResolvedValue({ status: 'ok' }),
      sendUserMessage: jest.fn().mockReturnValue('request_123')
    };
    
    mockContainer = {
      resolve: jest.fn((name) => {
        const mocks = {
          'eventBus': mockEventBus,
          'guruConnection': mockGuruConnection,
          'endpoint': mockEndpoint
        };
        return mocks[name] || null;
      })
    };
    
    orchestrator = new MainOrchestrator({
      container: mockContainer,
      eventBus: mockEventBus,
      guruConnection: mockGuruConnection,
      endpoint: mockEndpoint,
      enableLogging: false
    });
  });

  afterEach(async () => {
    if (orchestrator && !orchestrator.isDestroyed) {
      await orchestrator.destroy();
    }
    orchestrator = null;
  });

  describe('Initialization', () => {
    it('should initialize successfully', async () => {
      await orchestrator.init();
      
      expect(orchestrator.isInitialized).toBe(true);
      expect(mockEventBus.emit).toHaveBeenCalledWith('main:orchestrator:initialized');
    });

    it('should not initialize twice', async () => {
      await orchestrator.init();
      const firstInit = orchestrator.isInitialized;
      
      await orchestrator.init();
      
      expect(orchestrator.isInitialized).toBe(firstInit);
    });

    it('should handle initialization failure', async () => {
      mockGuruConnection.connect.mockRejectedValue(new Error('Connection failed'));
      
      await expect(orchestrator.init()).rejects.toThrow('Connection failed');
      expect(orchestrator.isInitialized).toBe(false);
    });
  });

  describe('Lifecycle', () => {
    beforeEach(async () => {
      await orchestrator.init();
    });

    it('should destroy cleanly', async () => {
      await orchestrator.destroy();
      
      expect(orchestrator.isDestroyed).toBe(true);
      expect(mockGuruConnection.disconnect).toHaveBeenCalled();
    });

    it('should not destroy twice', async () => {
      await orchestrator.destroy();
      const destroyCount = mockGuruConnection.disconnect.mock.calls.length;
      
      await orchestrator.destroy();
      
      expect(mockGuruConnection.disconnect.mock.calls.length).toBe(destroyCount);
    });
  });

  describe('Message sending', () => {
    beforeEach(async () => {
      await orchestrator.init();
    });

    it('should send user message', async () => {
      const message = 'Hello, world!';
      const result = await orchestrator.sendMessage(message);
      
      expect(mockEndpoint.sendUserMessage).toHaveBeenCalledWith(message);
      expect(result.requestId).toBe('request_123');
    });

    it('should throw error for empty message', async () => {
      await expect(orchestrator.sendMessage('')).rejects.toThrow();
    });

    it('should throw error for null message', async () => {
      await expect(orchestrator.sendMessage(null)).rejects.toThrow();
    });

    it('should handle send failure', async () => {
      mockEndpoint.sendUserMessage.mockImplementation(() => {
        throw new Error('Send failed');
      });
      
      await expect(orchestrator.sendMessage('Test')).rejects.toThrow('Send failed');
    });
  });

  describe('Event handling', () => {
    beforeEach(async () => {
      await orchestrator.init();
    });

    it('should emit events through EventBus', () => {
      orchestrator._emitEvent('test:event', { data: 'test' });
      
      expect(mockEventBus.emit).toHaveBeenCalledWith('test:event', { data: 'test' });
    });

    it('should handle event subscription', () => {
      const handler = jest.fn();
      orchestrator._on('test:event', handler);
      
      expect(mockEventBus.on).toHaveBeenCalledWith('test:event', handler);
    });
  });

  describe('State management', () => {
    beforeEach(async () => {
      await orchestrator.init();
    });

    it('should track backend connection state', () => {
      expect(orchestrator.state.backendConnected).toBeDefined();
    });

    it('should update state on backend connection change', () => {
      mockGuruConnection.isConnected.mockReturnValue(false);
      orchestrator._updateConnectionState();
      
      expect(orchestrator.state.backendConnected).toBe(false);
    });
  });

  describe('Error handling', () => {
    it('should handle errors gracefully', async () => {
      await orchestrator.init();
      
      const error = new Error('Test error');
      orchestrator._handleError(error, 'testContext');
      
      // Should not throw
      expect(orchestrator.isInitialized).toBe(true);
    });

    it('should emit error events', async () => {
      await orchestrator.init();
      
      const error = new Error('Test error');
      orchestrator._handleError(error, 'testContext');
      
      expect(mockEventBus.emit).toHaveBeenCalledWith(
        'main:error',
        expect.objectContaining({ error })
      );
    });
  });

  describe('Request lifecycle', () => {
    beforeEach(async () => {
      await orchestrator.init();
    });

    it('should create request context', async () => {
      const message = 'Test message';
      const context = await orchestrator.sendMessage(message);
      
      expect(context).toBeTruthy();
      expect(context.requestId).toBeTruthy();
      expect(context.startTime).toBeTruthy();
    });

    it('should track pending requests', async () => {
      const context = await orchestrator.sendMessage('Test');
      
      expect(orchestrator._pendingRequests).toBeDefined();
      expect(orchestrator._pendingRequests.has(context.requestId)).toBe(true);
    });

    it('should clean up completed requests', async () => {
      const context = await orchestrator.sendMessage('Test');
      await orchestrator._completeRequest(context.requestId);
      
      expect(orchestrator._pendingRequests.has(context.requestId)).toBe(false);
    });
  });
});

