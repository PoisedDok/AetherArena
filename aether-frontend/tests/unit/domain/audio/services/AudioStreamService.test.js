'use strict';

jest.mock('../../../../../src/core/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
  })
}));

const { AudioStreamService } = require('../../../../../src/domain/audio/services/AudioStreamService');
const { AudioValidator } = require('../../../../../src/domain/audio/validators/AudioValidator');
const { AudioStream } = require('../../../../../src/domain/audio/models/AudioStream');

describe('AudioStreamService', () => {
  let service;

  beforeEach(() => {
    service = new AudioStreamService();
  });

  afterEach(() => {
    service.cleanupAllStreams();
    jest.restoreAllMocks();
  });

  // ==================== createStream ====================

  describe('createStream()', () => {
    it('creates and stores a stream with correct id', () => {
      const stream = service.createStream('s1');
      expect(stream).toBeInstanceOf(AudioStream);
      expect(stream.id).toBe('s1');
      expect(service.getStream('s1')).toBe(stream);
    });

    it('stores multiple independent streams', () => {
      const s1 = service.createStream('s1');
      const s2 = service.createStream('s2');
      expect(service.getStream('s1')).toBe(s1);
      expect(service.getStream('s2')).toBe(s2);
      expect(s1).not.toBe(s2);
    });

    it('created stream should be inactive by default', () => {
      const stream = service.createStream('s1');
      expect(stream.isActive).toBe(false);
    });

    it('passes config to AudioStream.create', () => {
      const stream = service.createStream('s1', { sampleRate: 44100 });
      expect(stream.config.sampleRate).toBe(44100);
    });

    it('throws when validation fails', () => {
      jest.spyOn(AudioValidator, 'validateStreamData').mockReturnValue({
        valid: false,
        errors: ['Invalid stream id'],
      });

      expect(() => service.createStream('bad')).toThrow('Invalid stream data: Invalid stream id');
    });

    it('overwrites existing stream with same id', () => {
      const s1 = service.createStream('s1');
      const s1b = service.createStream('s1');
      expect(service.getStream('s1')).toBe(s1b);
      expect(s1).not.toBe(s1b);
    });
  });

  // ==================== startStream ====================

  describe('startStream()', () => {
    let mockMediaStream, mockMediaRecorder, mockAudioContext;

    beforeEach(() => {
      mockMediaStream = { getTracks: jest.fn(() => []) };
      mockMediaRecorder = { state: 'inactive', stream: { getAudioTracks: () => [] } };
      mockAudioContext = { state: 'running', close: jest.fn() };

      // Mock all validators to return valid (browser APIs don't exist in Node)
      jest.spyOn(AudioValidator, 'validateMediaStream').mockReturnValue({ valid: true, errors: [] });
      jest.spyOn(AudioValidator, 'validateMediaRecorder').mockReturnValue({ valid: true, errors: [] });
      jest.spyOn(AudioValidator, 'validateAudioContext').mockReturnValue({ valid: true, errors: [] });
    });

    it('creates stream if not exists and starts it', () => {
      const stream = service.startStream('s1', mockMediaStream, mockMediaRecorder, mockAudioContext);

      expect(stream).toBeInstanceOf(AudioStream);
      expect(stream.isActive).toBe(true);
      expect(stream.mediaStream).toBe(mockMediaStream);
      expect(stream.mediaRecorder).toBe(mockMediaRecorder);
      expect(stream.audioContext).toBe(mockAudioContext);
    });

    it('uses existing stream if already created', () => {
      const created = service.createStream('s1');
      const started = service.startStream('s1', mockMediaStream, mockMediaRecorder, mockAudioContext);

      expect(started).toBe(created);
      expect(started.isActive).toBe(true);
    });

    it('allows null mediaRecorder (ScriptProcessorNode mode)', () => {
      const stream = service.startStream('s1', mockMediaStream, null, mockAudioContext);

      expect(stream.isActive).toBe(true);
      expect(stream.mediaRecorder).toBeNull();
      expect(AudioValidator.validateMediaRecorder).not.toHaveBeenCalled();
    });

    it('throws on invalid MediaStream', () => {
      AudioValidator.validateMediaStream.mockReturnValue({
        valid: false,
        errors: ['MediaStream is required'],
      });

      expect(() => service.startStream('s1', null, mockMediaRecorder, mockAudioContext))
        .toThrow('Invalid MediaStream: MediaStream is required');
    });

    it('throws on invalid MediaRecorder', () => {
      AudioValidator.validateMediaRecorder.mockReturnValue({
        valid: false,
        errors: ['Invalid MediaRecorder object'],
      });

      expect(() => service.startStream('s1', mockMediaStream, mockMediaRecorder, mockAudioContext))
        .toThrow('Invalid MediaRecorder: Invalid MediaRecorder object');
    });

    it('throws on invalid AudioContext', () => {
      AudioValidator.validateAudioContext.mockReturnValue({
        valid: false,
        errors: ['AudioContext is closed'],
      });

      expect(() => service.startStream('s1', mockMediaStream, mockMediaRecorder, mockAudioContext))
        .toThrow('Invalid AudioContext: AudioContext is closed');
    });

    it('validates MediaStream before MediaRecorder and AudioContext', () => {
      const callOrder = [];
      AudioValidator.validateMediaStream.mockImplementation(() => {
        callOrder.push('mediaStream');
        return { valid: true, errors: [] };
      });
      AudioValidator.validateMediaRecorder.mockImplementation(() => {
        callOrder.push('mediaRecorder');
        return { valid: true, errors: [] };
      });
      AudioValidator.validateAudioContext.mockImplementation(() => {
        callOrder.push('audioContext');
        return { valid: true, errors: [] };
      });

      service.startStream('s1', mockMediaStream, mockMediaRecorder, mockAudioContext);

      expect(callOrder).toEqual(['mediaStream', 'mediaRecorder', 'audioContext']);
    });
  });

  // ==================== stopStream ====================

  describe('stopStream()', () => {
    it('stops an active stream and marks inactive', () => {
      jest.spyOn(AudioValidator, 'validateMediaStream').mockReturnValue({ valid: true, errors: [] });
      jest.spyOn(AudioValidator, 'validateAudioContext').mockReturnValue({ valid: true, errors: [] });

      const mockMediaStream = { getTracks: jest.fn(() => []) };
      const mockAudioContext = { state: 'running', close: jest.fn() };
      service.startStream('s1', mockMediaStream, null, mockAudioContext);

      const stopped = service.stopStream('s1');
      expect(stopped).toBeInstanceOf(AudioStream);
      expect(stopped.isActive).toBe(false);
      expect(stopped.audioLevel).toBe(0);
    });

    it('returns null for non-existent stream', () => {
      expect(service.stopStream('unknown')).toBeNull();
    });

    it('sets endedAt timestamp on stop', () => {
      service.createStream('s1');
      const stopped = service.stopStream('s1');
      expect(stopped.endedAt).toBeInstanceOf(Date);
    });
  });

  // ==================== updateAudioLevel ====================

  describe('updateAudioLevel()', () => {
    it('updates level on existing stream', () => {
      service.createStream('s1');
      const stream = service.updateAudioLevel('s1', 0.5);

      expect(stream).toBeInstanceOf(AudioStream);
      expect(stream.audioLevel).toBe(0.5);
    });

    it('returns null for non-existent stream', () => {
      expect(service.updateAudioLevel('unknown', 0.5)).toBeNull();
    });

    it('throws when validation fails', () => {
      jest.spyOn(AudioValidator, 'validateAudioLevel').mockReturnValue({
        valid: false,
        errors: ['Level out of range'],
      });

      service.createStream('s1');
      expect(() => service.updateAudioLevel('s1', -1))
        .toThrow('Invalid audio level: Level out of range');
    });

    it('updates to zero', () => {
      service.createStream('s1');
      service.updateAudioLevel('s1', 0.8);
      service.updateAudioLevel('s1', 0);
      expect(service.getStream('s1').audioLevel).toBe(0);
    });

    it('updates to max (1)', () => {
      service.createStream('s1');
      const stream = service.updateAudioLevel('s1', 1);
      expect(stream.audioLevel).toBe(1);
    });
  });

  // ==================== getStream ====================

  describe('getStream()', () => {
    it('returns null for non-existent', () => {
      expect(service.getStream('unknown')).toBeNull();
    });

    it('returns the exact stream instance', () => {
      const created = service.createStream('s1');
      expect(service.getStream('s1')).toBe(created);
    });
  });

  // ==================== isStreamActive ====================

  describe('isStreamActive()', () => {
    it('returns false for non-existent', () => {
      expect(service.isStreamActive('unknown')).toBe(false);
    });

    it('returns false for created but not started stream', () => {
      service.createStream('s1');
      expect(service.isStreamActive('s1')).toBe(false);
    });

    it('returns true for started stream', () => {
      jest.spyOn(AudioValidator, 'validateMediaStream').mockReturnValue({ valid: true, errors: [] });
      jest.spyOn(AudioValidator, 'validateAudioContext').mockReturnValue({ valid: true, errors: [] });

      service.startStream('s1', {}, null, { state: 'running' });
      expect(service.isStreamActive('s1')).toBe(true);
    });

    it('returns false after stopping', () => {
      jest.spyOn(AudioValidator, 'validateMediaStream').mockReturnValue({ valid: true, errors: [] });
      jest.spyOn(AudioValidator, 'validateAudioContext').mockReturnValue({ valid: true, errors: [] });

      service.startStream('s1', {}, null, { state: 'running' });
      service.stopStream('s1');
      expect(service.isStreamActive('s1')).toBe(false);
    });
  });

  // ==================== getActiveStreams ====================

  describe('getActiveStreams()', () => {
    it('returns empty array when none active', () => {
      service.createStream('s1');
      expect(service.getActiveStreams()).toEqual([]);
    });

    it('returns only active streams', () => {
      jest.spyOn(AudioValidator, 'validateMediaStream').mockReturnValue({ valid: true, errors: [] });
      jest.spyOn(AudioValidator, 'validateAudioContext').mockReturnValue({ valid: true, errors: [] });

      service.startStream('s1', {}, null, { state: 'running' });
      service.createStream('s2'); // inactive

      const active = service.getActiveStreams();
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe('s1');
    });
  });

  // ==================== cleanupStream ====================

  describe('cleanupStream()', () => {
    it('removes and cleans up stream', () => {
      service.createStream('s1');
      expect(service.cleanupStream('s1')).toBe(true);
      expect(service.getStream('s1')).toBeNull();
    });

    it('returns false for non-existent', () => {
      expect(service.cleanupStream('unknown')).toBe(false);
    });

    it('calls cleanup on the stream object', () => {
      const stream = service.createStream('s1');
      const cleanupSpy = jest.spyOn(stream, 'cleanup');

      service.cleanupStream('s1');
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ==================== cleanupAllStreams ====================

  describe('cleanupAllStreams()', () => {
    it('clears all streams', () => {
      service.createStream('s1');
      service.createStream('s2');
      service.cleanupAllStreams();
      expect(service.getStream('s1')).toBeNull();
      expect(service.getStream('s2')).toBeNull();
    });

    it('calls cleanup on each stream', () => {
      const s1 = service.createStream('s1');
      const s2 = service.createStream('s2');
      const spy1 = jest.spyOn(s1, 'cleanup');
      const spy2 = jest.spyOn(s2, 'cleanup');

      service.cleanupAllStreams();
      expect(spy1).toHaveBeenCalledTimes(1);
      expect(spy2).toHaveBeenCalledTimes(1);
    });

    it('handles errors during individual cleanup gracefully', () => {
      const s1 = service.createStream('s1');
      service.createStream('s2');
      jest.spyOn(s1, 'cleanup').mockImplementation(() => {
        throw new Error('cleanup failed');
      });

      // Should not throw — error is caught and logged
      expect(() => service.cleanupAllStreams()).not.toThrow();
      // s1 failed but map is still cleared
      expect(service.getStream('s1')).toBeNull();
      expect(service.getStream('s2')).toBeNull();
    });
  });

  // ==================== calculateAudioLevel ====================

  describe('calculateAudioLevel()', () => {
    it('returns 0 for null', () => {
      expect(service.calculateAudioLevel(null)).toBe(0);
    });

    it('returns 0 for empty array', () => {
      expect(service.calculateAudioLevel(new Uint8Array(0))).toBe(0);
    });

    it('returns 1 for all-max data', () => {
      const data = new Uint8Array([255, 255, 255, 255]);
      expect(service.calculateAudioLevel(data)).toBe(1);
    });

    it('calculates exact mid-range level', () => {
      // [0, 128, 0, 128] → sum=256, avg=64, normalized=64/255
      const data = new Uint8Array([0, 128, 0, 128]);
      expect(service.calculateAudioLevel(data)).toBeCloseTo(64 / 255, 10);
    });

    it('returns exactly 0 for silence', () => {
      expect(service.calculateAudioLevel(new Uint8Array([0, 0, 0, 0]))).toBe(0);
    });

    it('clamps to max 1', () => {
      const data = new Uint8Array(100).fill(255);
      expect(service.calculateAudioLevel(data)).toBe(1);
    });

    it('handles single element', () => {
      const data = new Uint8Array([128]);
      expect(service.calculateAudioLevel(data)).toBeCloseTo(128 / 255, 10);
    });

    it('returns 0 for undefined', () => {
      expect(service.calculateAudioLevel(undefined)).toBe(0);
    });
  });

  // ==================== validateChunk ====================

  describe('validateChunk()', () => {
    it('returns true for valid ArrayBuffer', () => {
      expect(service.validateChunk(new ArrayBuffer(100))).toBe(true);
    });

    it('returns true for valid Uint8Array', () => {
      expect(service.validateChunk(new Uint8Array(100))).toBe(true);
    });

    it('returns false for null', () => {
      expect(service.validateChunk(null)).toBe(false);
    });

    it('returns false for empty buffer', () => {
      expect(service.validateChunk(new ArrayBuffer(0))).toBe(false);
    });

    it('returns false for non-buffer types', () => {
      expect(service.validateChunk('string')).toBe(false);
      expect(service.validateChunk(123)).toBe(false);
    });
  });

  // ==================== getStreamDuration ====================

  describe('getStreamDuration()', () => {
    it('returns 0 for non-existent stream', () => {
      expect(service.getStreamDuration('unknown')).toBe(0);
    });

    it('returns non-negative duration for existing stream', () => {
      service.createStream('s1');
      expect(service.getStreamDuration('s1')).toBeGreaterThanOrEqual(0);
    });
  });

  // ==================== getStreamMetadata ====================

  describe('getStreamMetadata()', () => {
    it('returns null for non-existent', () => {
      expect(service.getStreamMetadata('unknown')).toBeNull();
    });

    it('returns complete metadata structure', () => {
      service.createStream('s1');
      const meta = service.getStreamMetadata('s1');

      expect(meta).toEqual(expect.objectContaining({
        id: 's1',
        isActive: false,
        audioLevel: 0,
        config: expect.objectContaining({
          sampleRate: expect.any(Number),
          mimeType: expect.any(String),
        }),
      }));
      expect(meta).toHaveProperty('startedAt');
      expect(meta).toHaveProperty('endedAt');
      expect(meta).toHaveProperty('duration');
    });
  });

  // ==================== getAllStreamsMetadata ====================

  describe('getAllStreamsMetadata()', () => {
    it('returns empty for no streams', () => {
      expect(service.getAllStreamsMetadata()).toEqual([]);
    });

    it('returns metadata for all streams with correct structure', () => {
      service.createStream('s1');
      service.createStream('s2');
      const all = service.getAllStreamsMetadata();

      expect(all).toHaveLength(2);
      expect(all[0].id).toBe('s1');
      expect(all[1].id).toBe('s2');
      all.forEach(meta => {
        expect(meta).toHaveProperty('id');
        expect(meta).toHaveProperty('isActive');
        expect(meta).toHaveProperty('config');
      });
    });
  });

  // ==================== Full lifecycle ====================

  describe('full streaming lifecycle', () => {
    it('create → start → update → stop → cleanup', () => {
      jest.spyOn(AudioValidator, 'validateMediaStream').mockReturnValue({ valid: true, errors: [] });
      jest.spyOn(AudioValidator, 'validateAudioContext').mockReturnValue({ valid: true, errors: [] });

      const mockMediaStream = { getTracks: jest.fn(() => []) };
      const mockAudioContext = { state: 'running', close: jest.fn() };

      // Create
      const stream = service.createStream('lifecycle');
      expect(stream.isActive).toBe(false);

      // Start
      service.startStream('lifecycle', mockMediaStream, null, mockAudioContext);
      expect(service.isStreamActive('lifecycle')).toBe(true);

      // Update level
      service.updateAudioLevel('lifecycle', 0.75);
      expect(service.getStream('lifecycle').audioLevel).toBe(0.75);

      // Active streams
      expect(service.getActiveStreams()).toHaveLength(1);

      // Stop
      service.stopStream('lifecycle');
      expect(service.isStreamActive('lifecycle')).toBe(false);
      expect(service.getStream('lifecycle').audioLevel).toBe(0);
      expect(service.getActiveStreams()).toHaveLength(0);

      // Cleanup
      expect(service.cleanupStream('lifecycle')).toBe(true);
      expect(service.getStream('lifecycle')).toBeNull();
    });
  });
});
