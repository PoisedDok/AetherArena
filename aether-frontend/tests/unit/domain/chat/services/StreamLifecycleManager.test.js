'use strict';

jest.mock('../../../../../src/core/utils/logger', () => ({
  createDomainLogger: () => ({ child: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }) })
}));

jest.mock('../../../../../src/domain/chat/models/Message', () => ({
  Message: class Message {
    constructor(data) { Object.assign(this, data); }
  }
}));

const { StreamLifecycleManager } = require('../../../../../src/domain/chat/services/StreamLifecycleManager');

function createDeps(overrides = {}) {
  return {
    messageRepository: { save: jest.fn().mockResolvedValue({ id: 'msg-saved', timestamp: Date.now() }) },
    traceabilityService: {
      registerMessage: jest.fn(),
      linkArtifactsToMessage: jest.fn().mockResolvedValue([])
    },
    requestLifecycle: { isActive: jest.fn(() => true), completeRequest: jest.fn() },
    eventBus: { emit: jest.fn() },
    errorTracker: { captureException: jest.fn() },
    ...overrides
  };
}

describe('StreamLifecycleManager', () => {
  describe('constructor', () => {
    it('throws without messageRepository', () => {
      expect(() => new StreamLifecycleManager({
        requestLifecycle: {}, eventBus: {}
      })).toThrow('MessageRepository is required');
    });

    it('throws without requestLifecycle', () => {
      expect(() => new StreamLifecycleManager({
        messageRepository: {}, eventBus: {}
      })).toThrow('RequestLifecycleManager is required');
    });

    it('throws without eventBus', () => {
      expect(() => new StreamLifecycleManager({
        messageRepository: {}, requestLifecycle: {}
      })).toThrow('EventBus is required');
    });

    it('initializes with all dependencies', () => {
      const mgr = new StreamLifecycleManager(createDeps());
      expect(mgr.getStats().hasMessageRepository).toBe(true);
      expect(mgr.getStats().hasEventBus).toBe(true);
    });
  });

  describe('finalizeStream()', () => {
    let mgr, deps;

    beforeEach(() => {
      deps = createDeps();
      mgr = new StreamLifecycleManager(deps);
    });

    it('accumulates chunks, saves message, emits event', async () => {
      const result = await mgr.finalizeStream({
        chatId: 'c1', requestId: 'r1',
        streamBuffer: [{ content: 'hello ' }, { content: 'world' }],
        endChunk: { model: 'gpt-4' }
      });

      expect(result.id).toBe('msg-saved');
      expect(deps.messageRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'assistant', content: 'hello world', status: 'complete' }),
        'c1'
      );
      expect(deps.eventBus.emit).toHaveBeenCalledWith('chat:stream:complete', expect.objectContaining({
        chatId: 'c1', requestId: 'r1', messageId: 'msg-saved'
      }));
    });

    it('links artifacts via traceabilityService', async () => {
      await mgr.finalizeStream({
        chatId: 'c1', requestId: 'r1', streamBuffer: []
      });
      expect(deps.traceabilityService.registerMessage).toHaveBeenCalled();
      expect(deps.traceabilityService.linkArtifactsToMessage).toHaveBeenCalledWith('r1', 'msg-saved', expect.any(Object));
    });

    it('completes request lifecycle', async () => {
      await mgr.finalizeStream({
        chatId: 'c1', requestId: 'r1', streamBuffer: []
      });
      expect(deps.requestLifecycle.completeRequest).toHaveBeenCalledWith('r1', { messageId: 'msg-saved' });
    });

    it('handles traceability errors gracefully', async () => {
      deps.traceabilityService.linkArtifactsToMessage.mockRejectedValue(new Error('trace fail'));
      const result = await mgr.finalizeStream({
        chatId: 'c1', requestId: 'r1', streamBuffer: []
      });
      expect(result.id).toBe('msg-saved'); // still succeeds
    });

    it('throws on null context', async () => {
      await expect(mgr.finalizeStream(null)).rejects.toThrow('Context is required');
    });

    it('throws on missing chatId', async () => {
      await expect(mgr.finalizeStream({ requestId: 'r1', streamBuffer: [] }))
        .rejects.toThrow('chatId is required');
    });

    it('throws on missing requestId', async () => {
      await expect(mgr.finalizeStream({ chatId: 'c1', streamBuffer: [] }))
        .rejects.toThrow('requestId is required');
    });

    it('throws on missing streamBuffer', async () => {
      await expect(mgr.finalizeStream({ chatId: 'c1', requestId: 'r1' }))
        .rejects.toThrow('streamBuffer is required');
    });

    it('reports to errorTracker on save failure', async () => {
      deps.messageRepository.save.mockRejectedValue(new Error('DB fail'));
      await expect(mgr.finalizeStream({ chatId: 'c1', requestId: 'r1', streamBuffer: [] }))
        .rejects.toThrow('DB fail');
      expect(deps.errorTracker.captureException).toHaveBeenCalled();
    });
  });

  describe('cancelStream()', () => {
    it('emits cancellation event', () => {
      const deps = createDeps();
      const mgr = new StreamLifecycleManager(deps);
      mgr.cancelStream({ requestId: 'r1' });
      expect(deps.eventBus.emit).toHaveBeenCalledWith('chat:stream:cancelled', { requestId: 'r1' });
    });

    it('throws on missing requestId', () => {
      const mgr = new StreamLifecycleManager(createDeps());
      expect(() => mgr.cancelStream(null)).toThrow('requestId is required');
      expect(() => mgr.cancelStream({})).toThrow('requestId is required');
    });
  });

  describe('timeoutStream()', () => {
    it('emits timeout event', () => {
      const deps = createDeps();
      const mgr = new StreamLifecycleManager(deps);
      mgr.timeoutStream({ requestId: 'r1' });
      expect(deps.eventBus.emit).toHaveBeenCalledWith('chat:stream:timeout', { requestId: 'r1' });
    });

    it('throws on missing requestId', () => {
      const mgr = new StreamLifecycleManager(createDeps());
      expect(() => mgr.timeoutStream(null)).toThrow('requestId is required');
    });
  });

  describe('getStats()', () => {
    it('reports dependency status', () => {
      const deps = createDeps();
      const mgr = new StreamLifecycleManager(deps);
      const stats = mgr.getStats();
      expect(stats.hasMessageRepository).toBe(true);
      expect(stats.hasTraceabilityService).toBe(true);
      expect(stats.hasRequestLifecycle).toBe(true);
      expect(stats.hasEventBus).toBe(true);
      expect(stats.hasErrorTracker).toBe(true);
    });
  });
});
