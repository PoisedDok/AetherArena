'use strict';

jest.mock('../../../../../src/core/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
  })
}));

const { TraceabilityService } = require('../../../../../src/domain/artifacts/services/TraceabilityService');

describe('TraceabilityService', () => {
  let service;

  beforeEach(() => {
    service = new TraceabilityService();
  });

  describe('constructor', () => {
    it('initializes with empty indexes', () => {
      const stats = service.getStats();
      expect(stats.cachedMessages).toBe(0);
      expect(stats.cachedArtifacts).toBe(0);
    });

    it('accepts custom dependencies', () => {
      const s = new TraceabilityService({ storageAPI: {}, logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() } });
      expect(s.storageAPI).toBeTruthy();
    });
  });

  describe('linkArtifactToMessage()', () => {
    it('links artifact to message and returns true', () => {
      expect(service.linkArtifactToMessage('art-1', 'msg-1')).toBe(true);
    });

    it('creates forward index (message → artifacts)', () => {
      service.linkArtifactToMessage('art-1', 'msg-1');
      service.linkArtifactToMessage('art-2', 'msg-1');
      const artifacts = service.getArtifactsForMessage('msg-1');
      expect(artifacts).toEqual(['art-1', 'art-2']);
    });

    it('creates reverse index (artifact → message)', () => {
      service.linkArtifactToMessage('art-1', 'msg-1');
      expect(service.getMessageForArtifact('art-1')).toBe('msg-1');
    });

    it('returns false when artifactId is missing', () => {
      expect(service.linkArtifactToMessage(null, 'msg-1')).toBe(false);
      expect(service.linkArtifactToMessage('', 'msg-1')).toBe(false);
    });

    it('returns false when messageId is missing', () => {
      expect(service.linkArtifactToMessage('art-1', null)).toBe(false);
      expect(service.linkArtifactToMessage('art-1', '')).toBe(false);
    });
  });

  describe('linkArtifactsToMessage()', () => {
    it('throws when correlationId is missing', async () => {
      await expect(service.linkArtifactsToMessage(null, 'msg-1'))
        .rejects.toThrow('Correlation ID and message ID are required');
    });

    it('throws when messageId is missing', async () => {
      await expect(service.linkArtifactsToMessage('corr-1', null))
        .rejects.toThrow('Correlation ID and message ID are required');
    });

    it('returns empty array (not yet wired to backend)', async () => {
      const result = await service.linkArtifactsToMessage('corr-1', 'msg-1');
      expect(result).toEqual([]);
    });
  });

  describe('getArtifactsForMessage()', () => {
    it('returns empty array for unknown message', () => {
      expect(service.getArtifactsForMessage('unknown')).toEqual([]);
    });

    it('returns cached artifact IDs', () => {
      service.linkArtifactToMessage('art-1', 'msg-1');
      expect(service.getArtifactsForMessage('msg-1')).toEqual(['art-1']);
    });
  });

  describe('getMessageForArtifact()', () => {
    it('returns null for unknown artifact', () => {
      expect(service.getMessageForArtifact('unknown')).toBeNull();
    });
  });

  describe('updateArtifactMessageLink()', () => {
    it('moves artifact from old message to new message', () => {
      service.linkArtifactToMessage('art-1', 'msg-old');
      expect(service.updateArtifactMessageLink('art-1', 'msg-new')).toBe(true);

      expect(service.getMessageForArtifact('art-1')).toBe('msg-new');
      // Old message should no longer have this artifact
      expect(service.getArtifactsForMessage('msg-old')).not.toContain('art-1');
      expect(service.getArtifactsForMessage('msg-new')).toContain('art-1');
    });

    it('returns false when artifactId missing', () => {
      expect(service.updateArtifactMessageLink(null, 'msg-1')).toBe(false);
    });

    it('returns false when newMessageId missing', () => {
      expect(service.updateArtifactMessageLink('art-1', null)).toBe(false);
    });
  });

  describe('getStats()', () => {
    it('returns accurate counts', () => {
      service.linkArtifactToMessage('art-1', 'msg-1');
      service.linkArtifactToMessage('art-2', 'msg-1');
      service.linkArtifactToMessage('art-3', 'msg-2');

      const stats = service.getStats();
      expect(stats.cachedMessages).toBe(2);
      expect(stats.cachedArtifacts).toBe(3);
      expect(stats.note).toContain('Session cache');
    });
  });

  describe('clear()', () => {
    it('clears all indexes', () => {
      service.linkArtifactToMessage('art-1', 'msg-1');
      service.clear();
      expect(service.getStats().cachedMessages).toBe(0);
      expect(service.getStats().cachedArtifacts).toBe(0);
    });
  });

  describe('legacy compatibility methods', () => {
    it('registerMessage returns input', () => {
      expect(service.registerMessage({ id: 'm1' })).toEqual({ id: 'm1' });
    });

    it('registerArtifact returns input', () => {
      expect(service.registerArtifact({ id: 'a1' })).toEqual({ id: 'a1' });
    });

    it('getMessage returns null', () => {
      expect(service.getMessage('m1')).toBeNull();
    });

    it('getArtifact returns null', () => {
      expect(service.getArtifact('a1')).toBeNull();
    });

    it('getMessagesByCorrelation returns empty structure', () => {
      expect(service.getMessagesByCorrelation('c1')).toEqual({ request: null, response: null });
    });

    it('getMessagesForChat returns empty array', () => {
      expect(service.getMessagesForChat('chat-1')).toEqual([]);
    });

    it('getArtifactsForChat returns empty array', () => {
      expect(service.getArtifactsForChat('chat-1')).toEqual([]);
    });

    it('getTrace returns null', () => {
      expect(service.getTrace('m1')).toBeNull();
    });

    it('exportAuditTrail returns empty trail', () => {
      expect(service.exportAuditTrail()).toEqual({ trail: [] });
    });

    it('prune returns zero counts', () => {
      expect(service.prune(1000)).toEqual({ prunedMessages: 0, prunedArtifacts: 0 });
    });

    it('forceSave is a no-op', async () => {
      await expect(service.forceSave()).resolves.toBeUndefined();
    });

    it('loadForChat is a no-op', async () => {
      await expect(service.loadForChat('chat-1')).resolves.toBeUndefined();
    });

    it('clearChat logs warning', () => {
      service.clearChat('chat-1'); // no-op, just ensure no throw
    });
  });
});
