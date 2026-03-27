'use strict';

const { TTSAudio } = require('../../../../../src/domain/audio/models/TTSAudio');

describe('TTSAudio', () => {
  describe('constructor', () => {
    it('sets defaults', () => {
      const audio = new TTSAudio({});
      expect(audio.id).toBeNull();
      expect(audio.audioData).toBeNull();
      expect(audio.text).toBe('');
      expect(audio.sampleRate).toBe(16000);
      expect(audio.format).toBe('pcm');
      expect(audio.status).toBe('pending');
      expect(audio.decodedBuffer).toBeNull();
      expect(audio.error).toBeNull();
      expect(audio.receivedAt).toBeInstanceOf(Date);
    });

    it('sets provided values', () => {
      const data = new ArrayBuffer(100);
      const audio = new TTSAudio({
        id: 'tts-1', audioData: data, text: 'hello',
        sampleRate: 44100, format: 'wav', status: 'playing'
      });
      expect(audio.id).toBe('tts-1');
      expect(audio.audioData).toBe(data);
      expect(audio.text).toBe('hello');
      expect(audio.sampleRate).toBe(44100);
      expect(audio.format).toBe('wav');
      expect(audio.status).toBe('playing');
    });
  });

  describe('create()', () => {
    it('creates with auto-generated ID', () => {
      const data = new ArrayBuffer(10);
      const audio = TTSAudio.create(data);
      expect(audio.id).toMatch(/^tts-/);
      expect(audio.audioData).toBe(data);
      expect(audio.status).toBe('pending');
    });

    it('uses provided options', () => {
      const audio = TTSAudio.create(new ArrayBuffer(10), {
        id: 'custom-id', text: 'hello world', sampleRate: 22050, format: 'mp3'
      });
      expect(audio.id).toBe('custom-id');
      expect(audio.text).toBe('hello world');
      expect(audio.sampleRate).toBe(22050);
      expect(audio.format).toBe('mp3');
    });
  });

  describe('getArrayBuffer()', () => {
    it('returns ArrayBuffer directly', () => {
      const buf = new ArrayBuffer(10);
      const audio = new TTSAudio({ audioData: buf });
      expect(audio.getArrayBuffer()).toBe(buf);
    });

    it('returns buffer from Uint8Array', () => {
      const arr = new Uint8Array([1, 2, 3]);
      const audio = new TTSAudio({ audioData: arr });
      expect(audio.getArrayBuffer()).toBe(arr.buffer);
    });

    it('throws on invalid data', () => {
      const audio = new TTSAudio({});
      expect(() => audio.getArrayBuffer()).toThrow('Invalid audio data format');
    });
  });

  describe('getSize()', () => {
    it('returns ArrayBuffer byte length', () => {
      const audio = new TTSAudio({ audioData: new ArrayBuffer(256) });
      expect(audio.getSize()).toBe(256);
    });

    it('returns Uint8Array byte length', () => {
      const audio = new TTSAudio({ audioData: new Uint8Array(128) });
      expect(audio.getSize()).toBe(128);
    });

    it('returns 0 for no data', () => {
      expect(new TTSAudio({}).getSize()).toBe(0);
    });
  });

  describe('status lifecycle', () => {
    let audio;
    beforeEach(() => {
      audio = TTSAudio.create(new ArrayBuffer(10));
    });

    it('starts as pending', () => {
      expect(audio.status).toBe('pending');
      expect(audio.isReadyToPlay()).toBe(true);
      expect(audio.isPlaying()).toBe(false);
      expect(audio.hasPlayed()).toBe(false);
      expect(audio.hasError()).toBe(false);
    });

    it('transitions to playing', () => {
      audio.markPlaying();
      expect(audio.status).toBe('playing');
      expect(audio.isPlaying()).toBe(true);
      expect(audio.isReadyToPlay()).toBe(false);
    });

    it('transitions to played', () => {
      audio.markPlayed();
      expect(audio.status).toBe('played');
      expect(audio.hasPlayed()).toBe(true);
    });

    it('transitions to error', () => {
      const err = new Error('decode failed');
      audio.markError(err);
      expect(audio.status).toBe('error');
      expect(audio.hasError()).toBe(true);
      expect(audio.error).toBe(err);
      expect(audio.isReadyToPlay()).toBe(false);
    });
  });

  describe('setDecodedBuffer()', () => {
    it('stores decoded buffer', () => {
      const audio = new TTSAudio({});
      const mockBuffer = { duration: 1.5 };
      audio.setDecodedBuffer(mockBuffer);
      expect(audio.decodedBuffer).toBe(mockBuffer);
    });
  });

  describe('estimateDuration()', () => {
    it('calculates based on size and sample rate', () => {
      // 32000 bytes at 16000Hz, 16-bit mono = 32000 / (2*1) / 16000 = 1.0 second
      const audio = new TTSAudio({ audioData: new ArrayBuffer(32000), sampleRate: 16000 });
      expect(audio.estimateDuration()).toBe(1.0);
    });

    it('returns 0 for no data', () => {
      expect(new TTSAudio({}).estimateDuration()).toBe(0);
    });
  });

  describe('toJSON()', () => {
    it('serializes without binary data', () => {
      const audio = TTSAudio.create(new ArrayBuffer(100), { text: 'hello' });
      const json = audio.toJSON();
      expect(json.id).toMatch(/^tts-/);
      expect(json.text).toBe('hello');
      expect(json.size).toBe(100);
      expect(json.duration).toBeGreaterThan(0);
      expect(json.hasError).toBe(false);
      expect(json.audioData).toBeUndefined();
    });
  });

  describe('fromJSON()', () => {
    it('restores metadata (no binary data)', () => {
      const json = { id: 'tts-1', text: 'hi', sampleRate: 22050, format: 'wav', status: 'played' };
      const audio = TTSAudio.fromJSON(json);
      expect(audio.id).toBe('tts-1');
      expect(audio.text).toBe('hi');
      expect(audio.sampleRate).toBe(22050);
      expect(audio.audioData).toBeNull();
    });

    it('restores error from errorMessage', () => {
      const audio = TTSAudio.fromJSON({ errorMessage: 'decode fail' });
      expect(audio.error).toBeInstanceOf(Error);
      expect(audio.error.message).toBe('decode fail');
    });
  });

  describe('cleanup()', () => {
    it('nulls out all resources', () => {
      const audio = TTSAudio.create(new ArrayBuffer(10));
      audio.setDecodedBuffer({ duration: 1 });
      audio.markError(new Error('x'));

      audio.cleanup();
      expect(audio.audioData).toBeNull();
      expect(audio.decodedBuffer).toBeNull();
      expect(audio.error).toBeNull();
    });
  });
});
