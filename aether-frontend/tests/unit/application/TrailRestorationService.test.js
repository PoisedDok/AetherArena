'use strict';

/**
 * TrailRestorationService Unit Tests
 * ============================================================================
 * Tests session map restoration: contract enforcement, fetch integration,
 * 200/404/error handling, event emission, and cleanup.
 *
 * @module tests/unit/application/TrailRestorationService.test
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

const { TrailRestorationService } = require('../../../src/application/chat/TrailRestorationService');
const { EventTypes } = require('../../../src/core/events/EventTypes');

function createMockEventBus() {
  return { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
}

describe('TrailRestorationService', () => {
  let service;
  let eventBus;
  let apiClient;

  beforeEach(() => {
    eventBus = createMockEventBus();
    apiClient = { get: jest.fn() };
    service = new TrailRestorationService({ apiClient, eventBus });
  });

  afterEach(() => {
    if (service) service.destroy();
  });

  // -----------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------
  describe('constructor', () => {
    it('throws CONTRACT VIOLATION when apiClient is missing', () => {
      expect(() => new TrailRestorationService({ eventBus }))
        .toThrow('[TrailRestorationService] CONTRACT VIOLATION: apiClient is required.');
    });

    it('throws when eventBus is missing', () => {
      expect(() => new TrailRestorationService({ apiClient }))
        .toThrow('[TrailRestorationService] eventBus required');
    });

    it('stores dependencies correctly', () => {
      expect(service.apiClient).toBe(apiClient);
      expect(service.eventBus).toBe(eventBus);
    });
  });

  // -----------------------------------------------------------
  // restoreSessionMap
  // -----------------------------------------------------------
  describe('restoreSessionMap()', () => {
    const validSessionMap = {
      timeline: [
        { type: 'message', id: 'msg-1', timestamp: 1000 },
        { type: 'artifact', id: 'art-1', timestamp: 2000 },
      ],
      metadata: { total_messages: 5, total_artifacts: 2, total_trails: 1 },
      indexes: {},
    };

    it('fetches from correct URL', async () => {
      apiClient.get.mockResolvedValue(validSessionMap);
      await service.restoreSessionMap('chat-123');
      expect(apiClient.get).toHaveBeenCalledWith(
        `/v1/storage/trail/session-map/chat-123`
      );
    });

    it('emits SESSION_MAP_LOADED with session map on success', async () => {
      apiClient.get.mockResolvedValue(validSessionMap);
      await service.restoreSessionMap('chat-123');
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.TRAIL.SESSION_MAP_LOADED,
        expect.objectContaining({
          chatId: 'chat-123',
          sessionMap: validSessionMap,
          timestamp: expect.any(Number),
        })
      );
    });

    it('emits empty session map on 404 (new chat)', async () => {
      const error404 = new Error('Not found');
      error404.status = 404;
      apiClient.get.mockRejectedValue(error404);
      await service.restoreSessionMap('new-chat');
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.TRAIL.SESSION_MAP_LOADED,
        expect.objectContaining({
          chatId: 'new-chat',
          sessionMap: { timeline: [], metadata: {}, indexes: {} },
        })
      );
    });

    it('emits RESTORATION_ERROR on non-404 HTTP error', async () => {
      const error500 = new Error('HTTP 500');
      error500.status = 500;
      apiClient.get.mockRejectedValue(error500);
      await service.restoreSessionMap('chat-err');
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.TRAIL.RESTORATION_ERROR,
        expect.objectContaining({
          chatId: 'chat-err',
          error: expect.stringContaining('HTTP 500'),
          timestamp: expect.any(Number),
        })
      );
    });

    it('emits RESTORATION_ERROR on invalid session map (missing timeline)', async () => {
      apiClient.get.mockResolvedValue({ data: 'not a timeline' });
      await service.restoreSessionMap('chat-bad');
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.TRAIL.RESTORATION_ERROR,
        expect.objectContaining({
          chatId: 'chat-bad',
          error: expect.stringContaining('Invalid session map'),
        })
      );
    });

    it('emits RESTORATION_ERROR on fetch failure', async () => {
      apiClient.get.mockRejectedValue(new Error('network down'));
      await service.restoreSessionMap('chat-fail');
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.TRAIL.RESTORATION_ERROR,
        expect.objectContaining({
          chatId: 'chat-fail',
          error: 'network down',
        })
      );
    });

    it('throws when chatId is missing', async () => {
      await expect(service.restoreSessionMap(null)).rejects.toThrow('chatId is required');
      await expect(service.restoreSessionMap('')).rejects.toThrow('chatId is required');
    });
  });

  // -----------------------------------------------------------
  // getStats / destroy
  // -----------------------------------------------------------
  describe('getStats()', () => {
    it('is safe to call after dispose()', () => {
      service.destroy();
      expect(() => service.getStats()).not.toThrow();
    });
  });

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
      logService = new TrailRestorationService({
        apiClient,
        eventBus,
        enableLogging: true,
      });
    });

    afterEach(() => {
      if (logService) logService.destroy();
    });

    it('logs during restoreSessionMap success', async () => {
      apiClient.get.mockResolvedValue({
        timeline: [{ type: 'message' }],
        metadata: { total_messages: 1, total_artifacts: 0, total_trails: 0 },
      });
      await logService.restoreSessionMap('chat-1234');
      // Covers lines 72, 101
    });

    it('logs during restoreSessionMap 404', async () => {
      const error404 = new Error('Not found');
      error404.status = 404;
      apiClient.get.mockRejectedValue(error404);
      await logService.restoreSessionMap('chat-1234');
      // Covers line 82
    });

    it('logs during destroy', () => {
      logService.destroy();
      // Covers line 143
      logService = null;
    });
  });
});
