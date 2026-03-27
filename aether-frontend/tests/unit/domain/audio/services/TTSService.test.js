'use strict';

const { TTSService } = require('../../../../../src/domain/audio/services/TTSService');
const { TTSAudio } = require('../../../../../src/domain/audio/models/TTSAudio');

describe('TTSService', () => {
  let service;

  beforeEach(() => {
    service = new TTSService();
  });

  afterEach(() => {
    service.cleanup();
  });

  describe('constructor', () => {
    it('starts empty', () => {
      expect(service.getQueueLength()).toBe(0);
      expect(service.isPlaying()).toBe(false);
      expect(service.getCurrentAudio()).toBeNull();
    });
  });

  describe('enqueue()', () => {
    it('adds audio to queue and returns TTSAudio', () => {
      const audio = service.enqueue(new ArrayBuffer(100), { text: 'hello' });
      expect(audio).toBeInstanceOf(TTSAudio);
      expect(audio.text).toBe('hello');
      expect(service.getQueueLength()).toBe(1);
    });

    it('maintains FIFO order', () => {
      service.enqueue(new ArrayBuffer(10), { text: 'first' });
      service.enqueue(new ArrayBuffer(10), { text: 'second' });
      expect(service.peek().text).toBe('first');
    });
  });

  describe('dequeue()', () => {
    it('returns and removes first item', () => {
      service.enqueue(new ArrayBuffer(10), { text: 'first' });
      service.enqueue(new ArrayBuffer(10), { text: 'second' });
      const audio = service.dequeue();
      expect(audio.text).toBe('first');
      expect(service.getQueueLength()).toBe(1);
    });

    it('returns null when empty', () => {
      expect(service.dequeue()).toBeNull();
    });
  });

  describe('peek()', () => {
    it('returns first without removing', () => {
      service.enqueue(new ArrayBuffer(10));
      service.peek();
      expect(service.getQueueLength()).toBe(1);
    });

    it('returns null when empty', () => {
      expect(service.peek()).toBeNull();
    });
  });

  describe('clearQueue()', () => {
    it('marks pending items as error and empties queue', () => {
      const a1 = service.enqueue(new ArrayBuffer(10));
      service.clearQueue();
      expect(service.isQueueEmpty()).toBe(true);
      expect(a1.hasError()).toBe(true);
    });
  });

  describe('playback lifecycle', () => {
    it('startPlayback → completePlayback', () => {
      const audio = TTSAudio.create(new ArrayBuffer(10));

      service.startPlayback(audio);
      expect(service.isPlaying()).toBe(true);
      expect(service.getCurrentAudio()).toBe(audio);
      expect(audio.isPlaying()).toBe(true);

      service.completePlayback(audio);
      expect(service.isPlaying()).toBe(false);
      expect(service.getCurrentAudio()).toBeNull();
      expect(audio.hasPlayed()).toBe(true);
    });

    it('startPlayback → failPlayback', () => {
      const audio = TTSAudio.create(new ArrayBuffer(10));
      const err = new Error('decode');

      service.startPlayback(audio);
      service.failPlayback(audio, err);
      expect(service.isPlaying()).toBe(false);
      expect(audio.hasError()).toBe(true);
      expect(audio.error).toBe(err);
    });

    it('startPlayback throws on null audio', () => {
      expect(() => service.startPlayback(null)).toThrow('Audio is required');
    });

    it('completePlayback throws on null audio', () => {
      expect(() => service.completePlayback(null)).toThrow('Audio is required');
    });

    it('failPlayback throws on null audio', () => {
      expect(() => service.failPlayback(null, new Error())).toThrow('Audio is required');
    });
  });

  describe('setDecodedBuffer()', () => {
    it('sets buffer on current audio', () => {
      const audio = TTSAudio.create(new ArrayBuffer(10));
      service.startPlayback(audio);
      const mockBuf = { duration: 1.5 };
      const result = service.setDecodedBuffer(audio.id, mockBuf);
      expect(result).toBe(audio);
      expect(audio.decodedBuffer).toBe(mockBuf);
    });

    it('sets buffer on queued audio', () => {
      const audio = service.enqueue(new ArrayBuffer(10));
      const result = service.setDecodedBuffer(audio.id, { duration: 1 });
      expect(result).toBe(audio);
    });

    it('returns null for unknown ID', () => {
      expect(service.setDecodedBuffer('unknown', {})).toBeNull();
    });
  });

  describe('getStatistics()', () => {
    it('returns zero stats initially', () => {
      const stats = service.getStatistics();
      expect(stats.queueLength).toBe(0);
      expect(stats.isPlaying).toBe(false);
      expect(stats.historySize).toBe(0);
      expect(stats.totalPlayed).toBe(0);
      expect(stats.totalErrors).toBe(0);
      expect(stats.totalDuration).toBe(0);
      expect(stats.currentAudioId).toBeNull();
    });

    it('tracks played and errors', () => {
      const a1 = TTSAudio.create(new ArrayBuffer(10));
      const a2 = TTSAudio.create(new ArrayBuffer(10));

      service.startPlayback(a1);
      service.completePlayback(a1);

      service.startPlayback(a2);
      service.failPlayback(a2, new Error('fail'));

      const stats = service.getStatistics();
      expect(stats.totalPlayed).toBe(1);
      expect(stats.totalErrors).toBe(1);
      expect(stats.historySize).toBe(2);
    });
  });

  describe('getHistory()', () => {
    it('returns most recent items in reverse order', () => {
      const a1 = TTSAudio.create(new ArrayBuffer(10), { text: 'first' });
      const a2 = TTSAudio.create(new ArrayBuffer(10), { text: 'second' });

      service.startPlayback(a1);
      service.completePlayback(a1);
      service.startPlayback(a2);
      service.completePlayback(a2);

      const history = service.getHistory(2);
      expect(history).toHaveLength(2);
      expect(history[0].text).toBe('second');
      expect(history[1].text).toBe('first');
    });
  });

  describe('getQueueMetadata()', () => {
    it('returns JSON representations of queued items', () => {
      service.enqueue(new ArrayBuffer(10), { text: 'a' });
      service.enqueue(new ArrayBuffer(10), { text: 'b' });
      const meta = service.getQueueMetadata();
      expect(meta).toHaveLength(2);
      expect(meta[0].text).toBe('a');
    });
  });

  describe('removeFromQueue()', () => {
    it('removes by ID and returns true', () => {
      const audio = service.enqueue(new ArrayBuffer(10));
      expect(service.removeFromQueue(audio.id)).toBe(true);
      expect(service.getQueueLength()).toBe(0);
    });

    it('returns false for unknown ID', () => {
      expect(service.removeFromQueue('unknown')).toBe(false);
    });
  });

  describe('stopCurrent()', () => {
    it('stops current playback', () => {
      const audio = TTSAudio.create(new ArrayBuffer(10));
      service.startPlayback(audio);
      const stopped = service.stopCurrent();
      expect(stopped).toBe(audio);
      expect(audio.hasError()).toBe(true);
      expect(service.isPlaying()).toBe(false);
      expect(service.getCurrentAudio()).toBeNull();
    });

    it('returns null when nothing playing', () => {
      expect(service.stopCurrent()).toBeNull();
    });
  });

  describe('cleanup()', () => {
    it('clears all state', () => {
      service.enqueue(new ArrayBuffer(10));
      const audio = TTSAudio.create(new ArrayBuffer(10));
      service.startPlayback(audio);
      service.completePlayback(audio);

      service.cleanup();
      expect(service.getQueueLength()).toBe(0);
      expect(service.isPlaying()).toBe(false);
      expect(service.getCurrentAudio()).toBeNull();
      expect(service.getStatistics().historySize).toBe(0);
    });
  });
});
