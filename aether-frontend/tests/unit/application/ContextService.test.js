'use strict';

/**
 * ContextService Unit Tests
 * ============================================================================
 * Tests conversation context management: REST API integration for context
 * status, summarization, and export. Validates contract enforcement (apiClient
 * required), event emission, error propagation, and cleanup.
 *
 * @module tests/unit/application/ContextService.test
 */

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
}));

const { ContextService } = require('../../../src/application/chat/ContextService');

function createMockEventBus() {
  return { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
}

function createMockApiClient() {
  return { get: jest.fn(), post: jest.fn(), delete: jest.fn() };
}

describe('ContextService', () => {
  let service;
  let eventBus;
  let apiClient;

  beforeEach(() => {
    eventBus = createMockEventBus();
    apiClient = createMockApiClient();
    service = new ContextService({ apiClient, eventBus });
  });

  afterEach(() => {
    if (service) service.destroy();
  });

  // -----------------------------------------------------------
  // Constructor / CONTRACT validation
  // -----------------------------------------------------------
  describe('constructor', () => {
    it('requires apiClient -- throws CONTRACT VIOLATION when missing', () => {
      expect(() => new ContextService({ eventBus }))
        .toThrow('[ContextService] CONTRACT VIOLATION: apiClient is required.');
    });

    it('accepts valid apiClient without eventBus (logs warning, does not throw)', () => {
      expect(() => new ContextService({ apiClient })).not.toThrow();
    });

    it('stores configuration correctly', () => {
      expect(service.apiClient).toBe(apiClient);
      expect(service.eventBus).toBe(eventBus);
    });
  });

  // -----------------------------------------------------------
  // getContextStatus
  // -----------------------------------------------------------
  describe('getContextStatus()', () => {
    const mockStatus = {
      chat_id: 'chat-123',
      status: 'healthy',
      token_count: 5000,
      usage_percent: 25,
      needs_summarization: false,
      recommend_new_chat: false,
    };

    it('fetches context status from correct URL', async () => {
      apiClient.get.mockResolvedValue(mockStatus);
      await service.getContextStatus('chat-123');
      expect(apiClient.get).toHaveBeenCalledWith(
        `/v1/context/chats/chat-123/context/status`
      );
    });

    it('returns the parsed response', async () => {
      apiClient.get.mockResolvedValue(mockStatus);
      const result = await service.getContextStatus('chat-123');
      expect(result).toEqual(mockStatus);
    });

    it('emits context:status-changed event via emitContextUpdate', async () => {
      apiClient.get.mockResolvedValue(mockStatus);
      await service.getContextStatus('chat-123');
      expect(eventBus.emit).toHaveBeenCalledWith(
        'context:status-changed',
        expect.objectContaining({
          chatId: 'chat-123',
          status: 'healthy',
          tokenCount: 5000,
          usagePercent: 25,
          needsSummarization: false,
          recommendNewChat: false,
          timestamp: expect.any(Number),
        })
      );
    });

    it('throws when chatId is missing', async () => {
      await expect(service.getContextStatus(null)).rejects.toThrow('chatId is required');
      await expect(service.getContextStatus('')).rejects.toThrow('chatId is required');
    });

    it('throws on api failure', async () => {
      apiClient.get.mockRejectedValue(new Error('network timeout'));
      await expect(service.getContextStatus('chat-123')).rejects.toThrow('network timeout');
    });
  });

  // -----------------------------------------------------------
  // requestSummarization
  // -----------------------------------------------------------
  describe('requestSummarization()', () => {
    const mockResult = { success: true, tokens_saved: 1200 };

    it('sends POST to correct URL', async () => {
      apiClient.post.mockResolvedValue(mockResult);
      await service.requestSummarization('chat-abc');
      expect(apiClient.post).toHaveBeenCalledWith(
        `/v1/context/chats/chat-abc/context/summarize`
      );
    });

    it('returns the parsed result', async () => {
      apiClient.post.mockResolvedValue(mockResult);
      const result = await service.requestSummarization('chat-abc');
      expect(result).toEqual(mockResult);
    });

    it('emits context:summarized event', async () => {
      apiClient.post.mockResolvedValue(mockResult);
      await service.requestSummarization('chat-abc');
      expect(eventBus.emit).toHaveBeenCalledWith(
        'context:summarized',
        expect.objectContaining({
          chatId: 'chat-abc',
          result: mockResult,
          timestamp: expect.any(Number),
        })
      );
    });

    it('does not emit when eventBus is null', async () => {
      const svc = new ContextService({ apiClient });
      apiClient.post.mockResolvedValue(mockResult);
      await svc.requestSummarization('chat-abc');
      // Should not throw despite null eventBus
      svc.destroy();
    });

    it('throws when chatId is missing', async () => {
      await expect(service.requestSummarization(null)).rejects.toThrow('chatId is required');
    });

    it('throws on api error', async () => {
      apiClient.post.mockRejectedValue(new Error('HTTP 403'));
      await expect(service.requestSummarization('chat-abc')).rejects.toThrow('HTTP 403');
    });
  });

  // -----------------------------------------------------------
  // exportContext
  // -----------------------------------------------------------
  describe('exportContext()', () => {
    const mockExported = {
      title: 'Test Chat',
      message_count: 15,
      token_count: 3000,
    };

    it('fetches from correct URL', async () => {
      apiClient.get.mockResolvedValue(mockExported);
      await service.exportContext('chat-xyz');
      expect(apiClient.get).toHaveBeenCalledWith(
        `/v1/context/chats/chat-xyz/context/export`
      );
    });

    it('returns the parsed export', async () => {
      apiClient.get.mockResolvedValue(mockExported);
      const result = await service.exportContext('chat-xyz');
      expect(result).toEqual(mockExported);
    });

    it('emits context:exported event', async () => {
      apiClient.get.mockResolvedValue(mockExported);
      await service.exportContext('chat-xyz');
      expect(eventBus.emit).toHaveBeenCalledWith(
        'context:exported',
        expect.objectContaining({
          chatId: 'chat-xyz',
          exported: mockExported,
          timestamp: expect.any(Number),
        })
      );
    });

    it('throws when chatId is missing', async () => {
      await expect(service.exportContext('')).rejects.toThrow('chatId is required');
    });

    it('throws on api failure', async () => {
      apiClient.get.mockRejectedValue(new Error('connection refused'));
      await expect(service.exportContext('chat-xyz')).rejects.toThrow('connection refused');
    });
  });

  // -----------------------------------------------------------
  // emitContextUpdate
  // -----------------------------------------------------------
  describe('emitContextUpdate()', () => {
    it('does not throw when eventBus is null', () => {
      const svc = new ContextService({ apiClient });
      expect(() => svc.emitContextUpdate({ chat_id: '1' })).not.toThrow();
      svc.destroy();
    });

    it('emits with all mapped fields', () => {
      service.emitContextUpdate({
        chat_id: 'c-1',
        status: 'warning',
        token_count: 8000,
        usage_percent: 80,
        needs_summarization: true,
        recommend_new_chat: false,
      });
      expect(eventBus.emit).toHaveBeenCalledWith(
        'context:status-changed',
        expect.objectContaining({
          chatId: 'c-1',
          status: 'warning',
          tokenCount: 8000,
          usagePercent: 80,
          needsSummarization: true,
          recommendNewChat: false,
        })
      );
    });
  });

  // -----------------------------------------------------------
  // getStats
  // -----------------------------------------------------------
  describe('getStats()', () => {
    it('is safe to call after dispose()', () => {
      service.destroy();
      expect(() => service.getStats()).not.toThrow();
    });

    it('reflects missing eventBus', () => {
      const svc = new ContextService({ apiClient });
      expect(svc.getStats().hasEventBus).toBe(false);
      svc.destroy();
    });
  });

  // -----------------------------------------------------------
  // destroy
  // -----------------------------------------------------------
  describe('destroy()', () => {
    it('nulls eventBus reference', () => {
      service.destroy();
      expect(service.eventBus).toBeNull();
    });

    it('is safe to call twice', () => {
      expect(() => {
        service.destroy();
        service.destroy();
      }).not.toThrow();
      service = null;
    });
  });

  // -----------------------------------------------------------
  // enableLogging branches
  // -----------------------------------------------------------
  describe('enableLogging branches', () => {
    let logService;

    beforeEach(() => {
      logService = new ContextService({
        apiClient,
        eventBus,
        enableLogging: true,
      });
    });

    afterEach(() => {
      if (logService) logService.destroy();
    });

    it('logs during getContextStatus', async () => {
      apiClient.get.mockResolvedValue({
        chat_id: 'chat-1', status: 'ok', token_count: 100,
        usage_percent: 10, needs_summarization: false, recommend_new_chat: false,
      });
      await logService.getContextStatus('chat-1234');
    });

    it('logs during requestSummarization', async () => {
      apiClient.post.mockResolvedValue({ success: true, tokens_saved: 0 });
      await logService.requestSummarization('chat-1234');
    });

    it('logs during exportContext', async () => {
      apiClient.get.mockResolvedValue({ title: 'chat-1', message_count: 1 });
      await logService.exportContext('chat-1234');
    });
  });
});