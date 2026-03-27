'use strict';

const { AudioStream } = require('../../../../../src/domain/audio/models/AudioStream');

describe('AudioStream Domain Model', () => {
  describe('Constructor', () => {
    it('should create with provided data', () => {
      const as = new AudioStream({ id: 'stream-1' });
      expect(as.id).toBe('stream-1');
      expect(as.isActive).toBe(false);
      expect(as.mediaStream).toBeNull();
      expect(as.mediaRecorder).toBeNull();
      expect(as.audioContext).toBeNull();
      expect(as.audioLevel).toBe(0);
      expect(as.startedAt).toBeNull();
      expect(as.endedAt).toBeNull();
      expect(as.config.sampleRate).toBe(16000);
      expect(as._analyser).toBeNull();
      expect(as._source).toBeNull();
    });

    it('should accept custom config', () => {
      const as = new AudioStream({
        id: 's1', config: { sampleRate: 44100, mimeType: 'audio/ogg' }
      });
      expect(as.config.sampleRate).toBe(44100);
      expect(as.config.mimeType).toBe('audio/ogg');
    });
  });

  describe('create factory', () => {
    it('should create with id and default config', () => {
      const as = AudioStream.create('test-stream');
      expect(as.id).toBe('test-stream');
      expect(as.isActive).toBe(false);
      expect(as.startedAt).toBeInstanceOf(Date);
      expect(as.config.sampleRate).toBe(16000);
    });

    it('should accept config overrides', () => {
      const as = AudioStream.create('s1', { sampleRate: 48000 });
      expect(as.config.sampleRate).toBe(48000);
      expect(as.config.mimeType).toBe('audio/webm'); // default preserved
    });
  });

  describe('Lifecycle', () => {
    it('should start stream', () => {
      const as = new AudioStream({ id: 's1' });
      const mockStream = { getTracks: () => [] };
      const mockRecorder = {};
      const mockContext = {};
      as.start(mockStream, mockRecorder, mockContext);
      expect(as.isActive).toBe(true);
      expect(as.mediaStream).toBe(mockStream);
      expect(as.mediaRecorder).toBe(mockRecorder);
      expect(as.audioContext).toBe(mockContext);
      expect(as.startedAt).toBeInstanceOf(Date);
      expect(as.endedAt).toBeNull();
    });

    it('should stop stream', () => {
      const as = new AudioStream({ id: 's1', isActive: true, audioLevel: 0.7 });
      as.stop();
      expect(as.isActive).toBe(false);
      expect(as.endedAt).toBeInstanceOf(Date);
      expect(as.audioLevel).toBe(0);
    });
  });

  describe('Audio level', () => {
    it('should update level within valid range', () => {
      const as = new AudioStream({ id: 's1' });
      as.updateLevel(0.5);
      expect(as.audioLevel).toBe(0.5);
      as.updateLevel(0);
      expect(as.audioLevel).toBe(0);
      as.updateLevel(1);
      expect(as.audioLevel).toBe(1);
    });

    it('should reject out-of-range levels', () => {
      const as = new AudioStream({ id: 's1' });
      as.updateLevel(0.5);
      as.updateLevel(-0.1);
      expect(as.audioLevel).toBe(0.5); // unchanged
      as.updateLevel(1.1);
      expect(as.audioLevel).toBe(0.5); // unchanged
    });
  });

  describe('Duration', () => {
    it('should return 0 when not started', () => {
      expect(new AudioStream({ id: 's1' }).getDuration()).toBe(0);
    });

    it('should compute duration from start to end', () => {
      const start = new Date(Date.now() - 5000);
      const end = new Date(Date.now() - 2000);
      const as = new AudioStream({ id: 's1', startedAt: start, endedAt: end });
      expect(as.getDuration()).toBeCloseTo(3000, -2);
    });

    it('should compute running duration when not ended', () => {
      const start = new Date(Date.now() - 1000);
      const as = new AudioStream({ id: 's1', startedAt: start });
      expect(as.getDuration()).toBeGreaterThanOrEqual(1000);
    });
  });

  describe('Validation', () => {
    it('should validate complete stream', () => {
      const as = AudioStream.create('s1');
      expect(as.isValid()).toBe(true);
    });

    it('should reject stream without id', () => {
      const as = new AudioStream({});
      expect(as.isValid()).toBe(false);
    });
  });

  describe('Analyser', () => {
    it('should set and get analyser', () => {
      const as = new AudioStream({ id: 's1' });
      const mockAnalyser = { fftSize: 256 };
      const mockSource = {};
      as.setAnalyser(mockAnalyser, mockSource);
      expect(as.getAnalyser()).toBe(mockAnalyser);
      expect(as._source).toBe(mockSource);
    });
  });

  describe('Cleanup', () => {
    it('should clean up all resources', () => {
      const mockTrack = { stop: jest.fn() };
      const mockStream = { getTracks: () => [mockTrack] };
      const mockRecorder = { state: 'recording', stop: jest.fn() };
      const mockSource = { disconnect: jest.fn() };
      const mockAnalyser = { disconnect: jest.fn() };
      const mockContext = { state: 'running', close: jest.fn() };
      const mockCaptureNode = { disconnect: jest.fn(), onaudioprocess: jest.fn() };

      const as = new AudioStream({ id: 's1', isActive: true });
      as.mediaStream = mockStream;
      as.mediaRecorder = mockRecorder;
      as.audioContext = mockContext;
      as.captureNode = mockCaptureNode;
      as._source = mockSource;
      as._analyser = mockAnalyser;

      as.cleanup();

      expect(mockRecorder.stop).toHaveBeenCalled();
      expect(mockCaptureNode.disconnect).toHaveBeenCalled();
      expect(mockTrack.stop).toHaveBeenCalled();
      expect(mockSource.disconnect).toHaveBeenCalled();
      expect(mockAnalyser.disconnect).toHaveBeenCalled();
      expect(mockContext.close).toHaveBeenCalled();
      expect(as.mediaStream).toBeNull();
      expect(as.mediaRecorder).toBeNull();
      expect(as.audioContext).toBeNull();
      expect(as._analyser).toBeNull();
      expect(as._source).toBeNull();
      expect(as.isActive).toBe(false);
    });

    it('should handle cleanup when resources already stopped', () => {
      const as = new AudioStream({ id: 's1' });
      as.mediaRecorder = { state: 'inactive', stop: jest.fn() };
      as.audioContext = { state: 'closed', close: jest.fn() };
      as.cleanup(); // should not throw
      expect(as.mediaRecorder).toBeNull();
    });

    it('should handle cleanup errors gracefully', () => {
      const as = new AudioStream({ id: 's1' });
      as.mediaRecorder = {
        state: 'recording',
        stop: () => { throw new Error('already stopped'); }
      };
      as.mediaStream = {
        getTracks: () => [{ stop: () => { throw new Error('fail'); } }]
      };
      expect(() => as.cleanup()).not.toThrow();
    });
  });

  describe('Serialization', () => {
    it('should serialize to JSON', () => {
      const as = AudioStream.create('s1');
      as.audioLevel = 0.5;
      const json = as.toJSON();
      expect(json.id).toBe('s1');
      expect(json.isActive).toBe(false);
      expect(json.audioLevel).toBe(0.5);
      expect(typeof json.duration).toBe('number');
      expect(json.config).toBeDefined();
      // Should not include browser APIs
      expect(json.mediaStream).toBeUndefined();
      expect(json.audioContext).toBeUndefined();
    });

    it('should round-trip through fromJSON', () => {
      const original = AudioStream.create('s1');
      const json = original.toJSON();
      const restored = AudioStream.fromJSON(json);
      expect(restored.id).toBe('s1');
      expect(restored.config.sampleRate).toBe(16000);
    });

    it('should handle null timestamps in fromJSON', () => {
      const restored = AudioStream.fromJSON({ id: 's1', startedAt: null, endedAt: null });
      expect(restored.startedAt).toBeNull();
      expect(restored.endedAt).toBeNull();
    });
  });
});
