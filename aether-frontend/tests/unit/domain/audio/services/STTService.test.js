'use strict';

const { STTService } = require('../../../../../src/domain/audio/services/STTService');
const { STTResult } = require('../../../../../src/domain/audio/models/STTResult');

describe('STTService', () => {
  let service;

  beforeEach(() => {
    service = new STTService();
  });

  afterEach(() => {
    service.cleanup();
  });

  describe('processPartial()', () => {
    it('creates and stores partial result', () => {
      const result = service.processPartial('s1', 'hello');
      expect(result).toBeInstanceOf(STTResult);
      expect(result.text).toBe('hello');
      expect(result.isFinal).toBe(false);
      expect(result.streamId).toBe('s1');
    });

    it('stores as current partial', () => {
      service.processPartial('s1', 'hello');
      expect(service.hasPartial('s1')).toBe(true);
      expect(service.getCurrentPartial('s1').text).toBe('hello');
    });

    it('overwrites previous partial for same stream', () => {
      service.processPartial('s1', 'first');
      service.processPartial('s1', 'second');
      expect(service.getCurrentPartial('s1').text).toBe('second');
    });

    it('adds to results history', () => {
      service.processPartial('s1', 'hello');
      expect(service.getResults('s1')).toHaveLength(1);
    });
  });

  describe('processFinal()', () => {
    it('creates and stores final result', () => {
      const result = service.processFinal('s1', 'final text');
      expect(result).toBeInstanceOf(STTResult);
      expect(result.text).toBe('final text');
      expect(result.isFinal).toBe(true);
    });

    it('clears current partial on finalization', () => {
      service.processPartial('s1', 'partial');
      service.processFinal('s1', 'final');
      expect(service.hasPartial('s1')).toBe(false);
    });

    it('stores as final result', () => {
      service.processFinal('s1', 'final');
      expect(service.hasFinal('s1')).toBe(true);
      expect(service.getFinalResult('s1').text).toBe('final');
    });
  });

  describe('getCurrentPartial()', () => {
    it('returns null for non-existent stream', () => {
      expect(service.getCurrentPartial('unknown')).toBeNull();
    });
  });

  describe('getFinalResult()', () => {
    it('returns null for non-existent stream', () => {
      expect(service.getFinalResult('unknown')).toBeNull();
    });
  });

  describe('getResults()', () => {
    it('returns empty array for non-existent stream', () => {
      expect(service.getResults('unknown')).toEqual([]);
    });

    it('returns all results for stream', () => {
      service.processPartial('s1', 'a');
      service.processPartial('s1', 'b');
      service.processFinal('s1', 'c');
      expect(service.getResults('s1')).toHaveLength(3);
    });
  });

  describe('getAllFinalResults()', () => {
    it('returns finals across all streams', () => {
      service.processFinal('s1', 'text 1');
      service.processFinal('s2', 'text 2');
      const finals = service.getAllFinalResults();
      expect(finals).toHaveLength(2);
    });

    it('returns empty array when no finals', () => {
      service.processPartial('s1', 'partial');
      expect(service.getAllFinalResults()).toEqual([]);
    });
  });

  describe('clearResults()', () => {
    it('clears all data for stream', () => {
      service.processPartial('s1', 'a');
      service.processFinal('s1', 'b');
      service.clearResults('s1');
      expect(service.hasPartial('s1')).toBe(false);
      expect(service.hasFinal('s1')).toBe(false);
      expect(service.getResults('s1')).toEqual([]);
    });
  });

  describe('clearAllResults()', () => {
    it('clears everything', () => {
      service.processPartial('s1', 'a');
      service.processFinal('s2', 'b');
      service.clearAllResults();
      expect(service.getResults('s1')).toEqual([]);
      expect(service.getResults('s2')).toEqual([]);
    });
  });

  describe('getConcatenatedText()', () => {
    it('joins all results with space', () => {
      service.processPartial('s1', 'hello');
      service.processFinal('s1', 'world');
      expect(service.getConcatenatedText('s1')).toBe('hello world');
    });

    it('filters to finals only', () => {
      service.processPartial('s1', 'partial');
      service.processFinal('s1', 'final');
      expect(service.getConcatenatedText('s1', true)).toBe('final');
    });

    it('returns empty for unknown stream', () => {
      expect(service.getConcatenatedText('unknown')).toBe('');
    });
  });

  describe('getAverageConfidence()', () => {
    it('calculates average', () => {
      service.processPartial('s1', 'a', { confidence: 0.4 });
      service.processFinal('s1', 'b', { confidence: 0.8 });
      expect(service.getAverageConfidence('s1')).toBeCloseTo(0.6);
    });

    it('returns 0 for no results', () => {
      expect(service.getAverageConfidence('unknown')).toBe(0);
    });

    it('filters to finals only', () => {
      service.processPartial('s1', 'a', { confidence: 0.2 });
      service.processFinal('s1', 'b', { confidence: 0.9 });
      expect(service.getAverageConfidence('s1', true)).toBe(0.9);
    });
  });

  describe('getStreamStatistics()', () => {
    it('returns comprehensive stats', () => {
      service.processPartial('s1', 'partial');
      service.processFinal('s1', 'final', { confidence: 0.95 });

      const stats = service.getStreamStatistics('s1');
      expect(stats.totalResults).toBe(2);
      expect(stats.finalResults).toBe(1);
      expect(stats.partialResults).toBe(1);
      expect(stats.hasCurrentPartial).toBe(false); // cleared by final
      expect(stats.hasFinalResult).toBe(true);
      expect(stats.concatenatedText).toBe('partial final');
      expect(stats.finalText).toBe('final');
    });
  });

  describe('getGlobalStatistics()', () => {
    it('returns zero stats when empty', () => {
      const stats = service.getGlobalStatistics();
      expect(stats.activeStreams).toBe(0);
      expect(stats.totalResults).toBe(0);
    });

    it('aggregates across streams', () => {
      service.processPartial('s1', 'a');
      service.processFinal('s2', 'b');

      const stats = service.getGlobalStatistics();
      expect(stats.activeStreams).toBe(2);
      expect(stats.streamsWithPartial).toBe(1);
      expect(stats.streamsWithFinal).toBe(1);
      expect(stats.totalResults).toBe(2);
      expect(stats.totalFinals).toBe(1);
      expect(stats.totalPartials).toBe(1);
    });
  });

  describe('getResultsMetadata()', () => {
    it('returns JSON representations', () => {
      service.processFinal('s1', 'hello');
      const meta = service.getResultsMetadata('s1');
      expect(meta).toHaveLength(1);
      expect(meta[0].text).toBe('hello');
      expect(meta[0].isFinal).toBe(true);
    });
  });

  describe('cleanup()', () => {
    it('clears all maps', () => {
      service.processPartial('s1', 'a');
      service.processFinal('s2', 'b');
      service.cleanup();
      expect(service.getGlobalStatistics().activeStreams).toBe(0);
    });
  });

  describe('result history trimming', () => {
    it('enforces maxResultsPerStream', () => {
      // Default max is 50
      for (let i = 0; i < 55; i++) {
        service.processPartial('s1', `text-${i}`);
      }
      expect(service.getResults('s1')).toHaveLength(50);
    });
  });
});
