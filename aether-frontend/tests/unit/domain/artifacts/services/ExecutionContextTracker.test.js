'use strict';

jest.mock('../../../../../src/core/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
  })
}));

const { ExecutionContextTracker } = require('../../../../../src/domain/artifacts/services/ExecutionContextTracker');

describe('ExecutionContextTracker', () => {
  let tracker;

  beforeEach(() => {
    tracker = new ExecutionContextTracker({ enableLogging: true });
  });

  describe('constructor', () => {
    it('initializes with null state', () => {
      expect(tracker.getCurrentMessageId()).toBeNull();
      expect(tracker.getCurrentChatId()).toBeNull();
      expect(tracker.getLastCodeArtifactId()).toBeNull();
    });

    it('respects enableLogging option', () => {
      const t = new ExecutionContextTracker({ enableLogging: false });
      expect(t.enableLogging).toBe(false);
    });
  });

  describe('trackMessageStart()', () => {
    it('throws on non-object input', () => {
      expect(() => tracker.trackMessageStart(null)).toThrow('CONTRACT VIOLATION');
      expect(() => tracker.trackMessageStart('string')).toThrow('CONTRACT VIOLATION');
    });

    it('is no-op when start is falsy', () => {
      tracker.trackMessageStart({ chat_id: 'c1' });
      expect(tracker.getCurrentChatId()).toBeNull();
    });

    it('throws when start=true but chat_id is missing', () => {
      expect(() => tracker.trackMessageStart({ start: true })).toThrow('chat_id required');
    });

    it('throws when start=true but chat_id is empty string', () => {
      expect(() => tracker.trackMessageStart({ start: true, chat_id: '  ' })).toThrow('chat_id required');
    });

    it('sets currentChatId on valid start', () => {
      tracker.trackMessageStart({ start: true, chat_id: 'chat-001' });
      expect(tracker.getCurrentChatId()).toBe('chat-001');
    });

    it('sets currentStreamingMessageId when message_id is present', () => {
      tracker.trackMessageStart({ start: true, chat_id: 'c1', message_id: 'msg-1' });
      expect(tracker.getCurrentMessageId()).toBe('msg-1');
    });

    it('resets lastCodeArtifactId on new message start', () => {
      tracker._lastCodeArtifactId = 'old-code';
      tracker.trackMessageStart({ start: true, chat_id: 'c1', message_id: 'msg-1' });
      expect(tracker.getLastCodeArtifactId()).toBeNull();
    });

    it('trims chat_id whitespace', () => {
      tracker.trackMessageStart({ start: true, chat_id: '  chat-001  ' });
      expect(tracker.getCurrentChatId()).toBe('chat-001');
    });
  });

  describe('trackMessageEnd()', () => {
    it('is no-op on non-object input', () => {
      tracker._currentStreamingMessageId = 'msg-1';
      tracker.trackMessageEnd(null);
      expect(tracker.getCurrentMessageId()).toBe('msg-1');
    });

    it('is no-op when end is falsy', () => {
      tracker._currentStreamingMessageId = 'msg-1';
      tracker.trackMessageEnd({ end: false });
      expect(tracker.getCurrentMessageId()).toBe('msg-1');
    });

    it('clears streaming state on end marker', () => {
      tracker._currentStreamingMessageId = 'msg-1';
      tracker._lastCodeArtifactId = 'code-1';
      tracker.trackMessageEnd({ end: true });
      expect(tracker.getCurrentMessageId()).toBeNull();
      expect(tracker.getLastCodeArtifactId()).toBeNull();
    });
  });

  describe('trackCodeArtifact()', () => {
    it('is no-op on non-object', () => {
      tracker.trackCodeArtifact(null);
      expect(tracker.getLastCodeArtifactId()).toBeNull();
    });

    it('is no-op on start marker', () => {
      tracker.trackCodeArtifact({ start: true, artifact_id: 'art-1' });
      expect(tracker.getLastCodeArtifactId()).toBeNull();
    });

    it('tracks artifact_id', () => {
      tracker.trackCodeArtifact({ artifact_id: 'code-001' });
      expect(tracker.getLastCodeArtifactId()).toBe('code-001');
    });

    it('tracks artifactId (camelCase)', () => {
      tracker.trackCodeArtifact({ artifactId: 'code-002' });
      expect(tracker.getLastCodeArtifactId()).toBe('code-002');
    });

    it('ignores non-string artifact IDs', () => {
      tracker.trackCodeArtifact({ artifact_id: 42 });
      expect(tracker.getLastCodeArtifactId()).toBeNull();
    });
  });

  describe('recordArtifact()', () => {
    it('throws when artifact.id is missing', () => {
      expect(() => tracker.recordArtifact({})).toThrow('artifact.id required');
    });

    it('throws when artifact.requestId is missing', () => {
      expect(() => tracker.recordArtifact({ id: 'a1' })).toThrow('artifact.requestId required');
    });

    it('stores artifact metadata in registry', () => {
      tracker.recordArtifact({
        id: 'a1', requestId: 'r1', messageId: 'm1', parentId: 'p1'
      }, { kind: 'code' });

      const meta = tracker.getArtifactMetadata('a1');
      expect(meta).toBeTruthy();
      expect(meta.kind).toBe('code');
      expect(meta.requestId).toBe('r1');
      expect(meta.messageId).toBe('m1');
      expect(meta.parentId).toBe('p1');
      expect(meta.timestamp).toBeGreaterThan(0);
    });

    it('falls back to artifact.type when extras.kind is absent', () => {
      tracker.recordArtifact({ id: 'a1', requestId: 'r1', type: 'output' });
      expect(tracker.getArtifactMetadata('a1').kind).toBe('output');
    });
  });

  describe('hasArtifact()', () => {
    it('returns false for unregistered artifact', () => {
      expect(tracker.hasArtifact('nonexistent')).toBe(false);
    });

    it('returns true for registered artifact', () => {
      tracker.recordArtifact({ id: 'a1', requestId: 'r1' });
      expect(tracker.hasArtifact('a1')).toBe(true);
    });
  });

  describe('getStats()', () => {
    it('returns current state summary', () => {
      tracker._currentStreamingMessageId = 'msg-1';
      tracker._currentChatId = 'chat-1';
      tracker._lastCodeArtifactId = 'code-1';
      tracker.recordArtifact({ id: 'a1', requestId: 'r1' });

      const stats = tracker.getStats();
      expect(stats.currentMessageId).toBe('msg-1');
      expect(stats.currentChatId).toBe('chat-1');
      expect(stats.lastCodeArtifactId).toBe('code-1');
      expect(stats.registeredArtifacts).toBe(1);
    });
  });

  describe('clear()', () => {
    it('resets all state', () => {
      tracker._currentStreamingMessageId = 'msg-1';
      tracker._currentChatId = 'chat-1';
      tracker._lastCodeArtifactId = 'code-1';
      tracker.recordArtifact({ id: 'a1', requestId: 'r1' });

      tracker.clear();

      expect(tracker.getCurrentMessageId()).toBeNull();
      expect(tracker.getCurrentChatId()).toBeNull();
      expect(tracker.getLastCodeArtifactId()).toBeNull();
      expect(tracker.hasArtifact('a1')).toBe(false);
    });
  });
});
