'use strict';

const { STTResult } = require('../../../../../src/domain/audio/models/STTResult');

describe('STTResult', () => {
  describe('constructor', () => {
    it('sets defaults', () => {
      const r = new STTResult({});
      expect(r.id).toBeNull();
      expect(r.text).toBe('');
      expect(r.isFinal).toBe(false);
      expect(r.confidence).toBe(0);
      expect(r.timestamp).toBeInstanceOf(Date);
      expect(r.streamId).toBeNull();
      expect(r.metadata).toBeNull();
    });

    it('sets provided values', () => {
      const ts = new Date('2025-01-01');
      const r = new STTResult({
        id: 'stt-1', text: 'hello', isFinal: true,
        confidence: 0.95, timestamp: ts, streamId: 's1', metadata: { lang: 'en' }
      });
      expect(r.id).toBe('stt-1');
      expect(r.text).toBe('hello');
      expect(r.isFinal).toBe(true);
      expect(r.confidence).toBe(0.95);
      expect(r.timestamp).toBe(ts);
      expect(r.streamId).toBe('s1');
      expect(r.metadata).toEqual({ lang: 'en' });
    });
  });

  describe('createPartial()', () => {
    it('creates partial result', () => {
      const r = STTResult.createPartial('partial text', 'stream-1');
      expect(r.id).toMatch(/^stt-partial-/);
      expect(r.text).toBe('partial text');
      expect(r.isFinal).toBe(false);
      expect(r.confidence).toBe(0);
      expect(r.streamId).toBe('stream-1');
    });

    it('uses custom options', () => {
      const r = STTResult.createPartial('text', 's1', { id: 'custom', confidence: 0.5, metadata: { x: 1 } });
      expect(r.id).toBe('custom');
      expect(r.confidence).toBe(0.5);
      expect(r.metadata).toEqual({ x: 1 });
    });
  });

  describe('createFinal()', () => {
    it('creates final result', () => {
      const r = STTResult.createFinal('final text', 'stream-1');
      expect(r.id).toMatch(/^stt-final-/);
      expect(r.text).toBe('final text');
      expect(r.isFinal).toBe(true);
      expect(r.confidence).toBe(1);
      expect(r.streamId).toBe('stream-1');
    });

    it('uses custom confidence', () => {
      const r = STTResult.createFinal('text', 's1', { confidence: 0.85 });
      expect(r.confidence).toBe(0.85);
    });
  });

  describe('isValid()', () => {
    it('returns true for valid result', () => {
      expect(STTResult.createFinal('hello', 's1').isValid()).toBe(true);
    });

    it('returns false for empty text', () => {
      expect(new STTResult({ text: '' }).isValid()).toBe(false);
    });

    it('returns false for null text', () => {
      expect(new STTResult({ text: null }).isValid()).toBe(false);
    });

    it('returns false for confidence out of range', () => {
      expect(new STTResult({ text: 'x', confidence: 1.5 }).isValid()).toBe(false);
      expect(new STTResult({ text: 'x', confidence: -0.1 }).isValid()).toBe(false);
    });
  });

  describe('getTrimmedText()', () => {
    it('trims whitespace', () => {
      expect(new STTResult({ text: '  hello  ' }).getTrimmedText()).toBe('hello');
    });
  });

  describe('isEmpty()', () => {
    it('returns true for whitespace-only', () => {
      expect(new STTResult({ text: '   ' }).isEmpty()).toBe(true);
    });

    it('returns false for non-empty text', () => {
      expect(new STTResult({ text: 'hi' }).isEmpty()).toBe(false);
    });
  });

  describe('getConfidencePercent()', () => {
    it('converts 0-1 to 0-100', () => {
      expect(new STTResult({ confidence: 0.85 }).getConfidencePercent()).toBe(85);
      expect(new STTResult({ confidence: 1 }).getConfidencePercent()).toBe(100);
      expect(new STTResult({ confidence: 0 }).getConfidencePercent()).toBe(0);
    });
  });

  describe('isHighConfidence()', () => {
    it('uses default threshold of 0.8', () => {
      expect(new STTResult({ confidence: 0.9 }).isHighConfidence()).toBe(true);
      expect(new STTResult({ confidence: 0.7 }).isHighConfidence()).toBe(false);
    });

    it('accepts custom threshold', () => {
      expect(new STTResult({ confidence: 0.6 }).isHighConfidence(0.5)).toBe(true);
    });
  });

  describe('toJSON() / fromJSON()', () => {
    it('round-trips correctly', () => {
      const original = STTResult.createFinal('hello world', 'stream-1', { confidence: 0.95 });
      const json = original.toJSON();
      const restored = STTResult.fromJSON(json);

      expect(restored.id).toBe(original.id);
      expect(restored.text).toBe('hello world');
      expect(restored.isFinal).toBe(true);
      expect(restored.confidence).toBe(0.95);
      expect(restored.streamId).toBe('stream-1');
    });

    it('fromJSON with no timestamp yields Date (constructor defaults null→new Date())', () => {
      // fromJSON passes null for missing timestamp → constructor: null || new Date()
      const r = STTResult.fromJSON({ text: 'x' });
      expect(r.timestamp).toBeInstanceOf(Date);
    });

    it('fromJSON with explicit timestamp preserves it', () => {
      const iso = '2025-06-15T10:00:00.000Z';
      const r = STTResult.fromJSON({ text: 'x', timestamp: iso });
      expect(r.timestamp.toISOString()).toBe(iso);
    });
  });
});
