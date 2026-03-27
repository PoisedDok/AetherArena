'use strict';

jest.mock('../../../../../src/core/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
  })
}));

jest.mock('../../../../../src/domain/artifacts/models/Artifact', () => ({
  Artifact: {
    generateIdWithKind: jest.fn((id, kind) => `${id}_${kind || 'unknown'}`)
  }
}));

const { ArtifactStreamHandler } = require('../../../../../src/domain/artifacts/services/ArtifactStreamHandler');

// --- Helpers ---

function createMockArtifactService() {
  return {
    createFromStream: jest.fn().mockResolvedValue({ id: 'created-art' }),
    updateContent: jest.fn(),
    finalizeArtifact: jest.fn().mockResolvedValue({ id: 'finalized-art', content: 'final-content' })
  };
}

function streamData(overrides = {}) {
  return { id: 'stream-1', kind: 'code', chatId: 'chat-1', ...overrides };
}

describe('ArtifactStreamHandler', () => {
  let handler, mockService;

  beforeEach(() => {
    mockService = createMockArtifactService();
    handler = new ArtifactStreamHandler({ artifactService: mockService });
  });

  describe('constructor', () => {
    it('initializes with empty buffers and streams', () => {
      expect(handler.getActiveStreamCount()).toBe(0);
      expect(handler.streamBuffers.size).toBe(0);
    });
  });

  describe('handleStreamChunk()', () => {
    it('returns null when id is missing', async () => {
      const result = await handler.handleStreamChunk({ chatId: 'c1' });
      expect(result).toBeNull();
    });

    it('returns null when chatId is missing', async () => {
      const result = await handler.handleStreamChunk({ id: 's1' });
      expect(result).toBeNull();
    });

    it('initializes stream on start marker', async () => {
      await handler.handleStreamChunk(streamData({ start: true }));
      expect(handler.getActiveStreamCount()).toBe(1);
      expect(mockService.createFromStream).toHaveBeenCalled();
    });

    it('initializes stream on first chunk (no start marker)', async () => {
      await handler.handleStreamChunk(streamData({ content: 'chunk-1' }));
      expect(handler.getActiveStreamCount()).toBe(1);
    });

    it('accumulates content', async () => {
      await handler.handleStreamChunk(streamData({ content: 'line 1\n' }));
      await handler.handleStreamChunk(streamData({ content: 'line 2\n' }));
      const artifactId = 'stream-1_code';
      expect(handler.getBufferSize(artifactId)).toBe(14);
      expect(mockService.updateContent).toHaveBeenCalledTimes(2);
    });

    it('finalizes on end marker and returns artifact', async () => {
      await handler.handleStreamChunk(streamData({ content: 'code' }));
      const result = await handler.handleStreamChunk(streamData({ end: true }));
      expect(result).toBeTruthy();
      expect(result.id).toBe('finalized-art');
      expect(mockService.finalizeArtifact).toHaveBeenCalled();
    });

    it('cleans up after finalization', async () => {
      await handler.handleStreamChunk(streamData({ content: 'code' }));
      await handler.handleStreamChunk(streamData({ end: true }));
      expect(handler.getActiveStreamCount()).toBe(0);
    });

    it('returns null for content-only chunk (no end)', async () => {
      const result = await handler.handleStreamChunk(streamData({ content: 'partial' }));
      expect(result).toBeNull();
    });

    it('handles errors gracefully and cleans up', async () => {
      mockService.createFromStream.mockRejectedValue(new Error('service error'));
      const result = await handler.handleStreamChunk(streamData({ content: 'x' }));
      expect(result).toBeNull();
      expect(handler.getActiveStreamCount()).toBe(0);
    });

    it('returns null when finalization returns null', async () => {
      mockService.finalizeArtifact.mockResolvedValue(null);
      await handler.handleStreamChunk(streamData({ content: 'code' }));
      const result = await handler.handleStreamChunk(streamData({ end: true }));
      expect(result).toBeNull();
    });
  });

  describe('isStreamActive()', () => {
    it('returns false for inactive stream', () => {
      expect(handler.isStreamActive('nonexistent')).toBe(false);
    });

    it('returns true for active stream', async () => {
      await handler.handleStreamChunk(streamData({ content: 'x' }));
      expect(handler.isStreamActive('stream-1_code')).toBe(true);
    });
  });

  describe('getBufferSize()', () => {
    it('returns 0 for nonexistent buffer', () => {
      expect(handler.getBufferSize('nonexistent')).toBe(0);
    });
  });

  describe('abortStream()', () => {
    it('returns false for inactive stream', () => {
      expect(handler.abortStream('nonexistent')).toBe(false);
    });

    it('cleans up and returns true for active stream', async () => {
      await handler.handleStreamChunk(streamData({ content: 'x' }));
      expect(handler.abortStream('stream-1_code')).toBe(true);
      expect(handler.getActiveStreamCount()).toBe(0);
    });
  });

  describe('abortAllStreams()', () => {
    it('returns 0 when no streams active', () => {
      expect(handler.abortAllStreams()).toBe(0);
    });

    it('aborts all active streams and returns count', async () => {
      await handler.handleStreamChunk(streamData({ id: 's1', content: 'x' }));
      await handler.handleStreamChunk(streamData({ id: 's2', content: 'y' }));
      const count = handler.abortAllStreams();
      expect(count).toBe(2);
      expect(handler.getActiveStreamCount()).toBe(0);
    });
  });

  describe('getStats()', () => {
    it('returns zero stats when empty', () => {
      const stats = handler.getStats();
      expect(stats.active).toBe(0);
      expect(stats.totalBuffers).toBe(0);
      expect(stats.totalBufferSize).toBe(0);
      expect(stats.averageBufferSize).toBe(0);
      expect(stats.oldestStream).toBeNull();
    });

    it('returns accurate stats with active streams', async () => {
      await handler.handleStreamChunk(streamData({ content: 'hello' }));
      const stats = handler.getStats();
      expect(stats.active).toBe(1);
      expect(stats.totalBuffers).toBe(1);
      expect(stats.totalBufferSize).toBe(5);
      expect(stats.oldestStream).toBeGreaterThan(0);
    });
  });

  describe('clear()', () => {
    it('clears all buffers and streams', async () => {
      await handler.handleStreamChunk(streamData({ content: 'x' }));
      handler.clear();
      expect(handler.getActiveStreamCount()).toBe(0);
      expect(handler.streamBuffers.size).toBe(0);
    });
  });
});
