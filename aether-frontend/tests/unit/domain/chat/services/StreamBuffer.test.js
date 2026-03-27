'use strict';

jest.mock('../../../../../src/core/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
  })
}));

const { StreamBuffer } = require('../../../../../src/domain/chat/services/StreamBuffer');

describe('StreamBuffer', () => {
  let buffer;

  beforeEach(() => {
    buffer = new StreamBuffer();
  });

  afterEach(() => {
    buffer.clearAll();
  });

  describe('startStream()', () => {
    it('creates a new stream buffer', () => {
      buffer.startStream('req-1');
      expect(buffer.isStreamActive('req-1')).toBe(true);
    });

    it('stores metadata', () => {
      buffer.startStream('req-1', { chatId: 'c1' });
      const info = buffer.getBufferInfo('req-1');
      expect(info.metadata.chatId).toBe('c1');
    });

    it('throws on null requestId', () => {
      expect(() => buffer.startStream(null)).toThrow('CONTRACT VIOLATION');
    });

    it('throws on empty requestId', () => {
      expect(() => buffer.startStream('')).toThrow('CONTRACT VIOLATION');
    });

    it('throws on non-string requestId', () => {
      expect(() => buffer.startStream(42)).toThrow('CONTRACT VIOLATION');
    });

    it('throws on duplicate requestId', () => {
      buffer.startStream('req-1');
      expect(() => buffer.startStream('req-1')).toThrow('already active');
    });
  });

  describe('addChunk()', () => {
    it('adds chunk to buffer', () => {
      buffer.startStream('req-1');
      buffer.addChunk('req-1', { content: 'hello' });
      expect(buffer.getAccumulatedContent('req-1')).toBe('hello');
    });

    it('accumulates multiple chunks', () => {
      buffer.startStream('req-1');
      buffer.addChunk('req-1', { content: 'hello ' });
      buffer.addChunk('req-1', { content: 'world' });
      expect(buffer.getAccumulatedContent('req-1')).toBe('hello world');
    });

    it('handles chunks without content', () => {
      buffer.startStream('req-1');
      buffer.addChunk('req-1', { type: 'control' });
      expect(buffer.getAccumulatedContent('req-1')).toBe('');
    });

    it('throws on null requestId', () => {
      expect(() => buffer.addChunk(null, {})).toThrow('CONTRACT VIOLATION');
    });

    it('throws on null chunk', () => {
      buffer.startStream('req-1');
      expect(() => buffer.addChunk('req-1', null)).toThrow('CONTRACT VIOLATION');
    });

    it('throws when stream not started', () => {
      expect(() => buffer.addChunk('nonexistent', { content: 'x' })).toThrow('not started');
    });
  });

  describe('getAccumulatedContent()', () => {
    it('returns joined content', () => {
      buffer.startStream('req-1');
      buffer.addChunk('req-1', { content: 'a' });
      buffer.addChunk('req-1', { content: 'b' });
      expect(buffer.getAccumulatedContent('req-1')).toBe('ab');
    });

    it('throws on invalid requestId', () => {
      expect(() => buffer.getAccumulatedContent(null)).toThrow('CONTRACT VIOLATION');
    });

    it('throws on non-existent stream', () => {
      expect(() => buffer.getAccumulatedContent('unknown')).toThrow('not found');
    });
  });

  describe('getBufferInfo()', () => {
    it('returns buffer statistics', () => {
      buffer.startStream('req-1');
      buffer.addChunk('req-1', { content: 'hello' });
      const info = buffer.getBufferInfo('req-1');

      expect(info.requestId).toBe('req-1');
      expect(info.chunkCount).toBe(1);
      expect(info.startTime).toBeGreaterThan(0);
      expect(info.duration).toBeGreaterThanOrEqual(0);
      expect(info.contentLength).toBe(5);
    });

    it('throws on non-existent stream', () => {
      expect(() => buffer.getBufferInfo('unknown')).toThrow('not found');
    });
  });

  describe('endStream()', () => {
    it('returns accumulated content and removes buffer', () => {
      buffer.startStream('req-1');
      buffer.addChunk('req-1', { content: 'result' });
      const content = buffer.endStream('req-1');

      expect(content).toBe('result');
      expect(buffer.isStreamActive('req-1')).toBe(false);
    });

    it('throws on non-existent stream', () => {
      expect(() => buffer.endStream('unknown')).toThrow('not found');
    });
  });

  describe('clearStream()', () => {
    it('removes buffer without returning content', () => {
      buffer.startStream('req-1');
      buffer.clearStream('req-1');
      expect(buffer.isStreamActive('req-1')).toBe(false);
    });

    it('is safe to call on non-existent stream', () => {
      expect(() => buffer.clearStream('nonexistent')).not.toThrow();
    });

    it('throws on invalid requestId', () => {
      expect(() => buffer.clearStream(null)).toThrow('CONTRACT VIOLATION');
    });
  });

  describe('isStreamActive()', () => {
    it('returns false for non-existent', () => {
      expect(buffer.isStreamActive('unknown')).toBe(false);
    });
  });

  describe('getActiveStreams()', () => {
    it('returns empty array when no streams', () => {
      expect(buffer.getActiveStreams()).toEqual([]);
    });

    it('returns all active IDs', () => {
      buffer.startStream('r1');
      buffer.startStream('r2');
      expect(buffer.getActiveStreams()).toEqual(['r1', 'r2']);
    });
  });

  describe('clearAll()', () => {
    it('removes all buffers', () => {
      buffer.startStream('r1');
      buffer.startStream('r2');
      buffer.clearAll();
      expect(buffer.getActiveStreams()).toEqual([]);
    });
  });

  describe('getStats()', () => {
    it('returns accurate stats', () => {
      buffer.startStream('r1');
      buffer.startStream('r2');
      const stats = buffer.getStats();
      expect(stats.activeStreams).toBe(2);
      expect(stats.totalBuffers).toBe(2);
      expect(stats.streams).toEqual(['r1', 'r2']);
    });
  });
});
