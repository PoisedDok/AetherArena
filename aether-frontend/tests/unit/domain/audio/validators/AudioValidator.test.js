'use strict';

jest.mock('../../../../../src/core/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
  })
}));

const { AudioValidator } = require('../../../../../src/domain/audio/validators/AudioValidator');

describe('AudioValidator', () => {
  // --- validateAudioChunk (pure, no browser API) ---
  describe('validateAudioChunk()', () => {
    it('validates ArrayBuffer', () => {
      const result = AudioValidator.validateAudioChunk(new ArrayBuffer(100));
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('validates Uint8Array', () => {
      const result = AudioValidator.validateAudioChunk(new Uint8Array(100));
      expect(result.valid).toBe(true);
    });

    it('rejects null', () => {
      const result = AudioValidator.validateAudioChunk(null);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Audio chunk is required');
    });

    it('rejects non-buffer types', () => {
      const result = AudioValidator.validateAudioChunk('string data');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Audio chunk must be ArrayBuffer or Uint8Array');
    });

    it('rejects empty ArrayBuffer', () => {
      const result = AudioValidator.validateAudioChunk(new ArrayBuffer(0));
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Audio chunk cannot be empty');
    });

    it('rejects oversized chunk (DoS protection)', () => {
      const huge = new ArrayBuffer(11 * 1024 * 1024); // 11MB
      const result = AudioValidator.validateAudioChunk(huge);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('too large');
    });

    it('accepts chunk at max boundary (10MB)', () => {
      const maxSize = new ArrayBuffer(10 * 1024 * 1024);
      const result = AudioValidator.validateAudioChunk(maxSize);
      expect(result.valid).toBe(true);
    });
  });

  // --- validateMediaStream (requires browser API polyfill) ---
  describe('validateMediaStream()', () => {
    it('rejects null', () => {
      const result = AudioValidator.validateMediaStream(null);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('MediaStream is required');
    });

    it('throws ReferenceError for non-MediaStream in Node env (no polyfill)', () => {
      if (typeof globalThis.MediaStream === 'undefined') {
        expect(() => AudioValidator.validateMediaStream({})).toThrow(ReferenceError);
      } else {
        const result = AudioValidator.validateMediaStream({});
        expect(result.valid).toBe(false);
      }
    });

    describe('with polyfilled MediaStream', () => {
      let OriginalMediaStream;

      beforeAll(() => {
        OriginalMediaStream = globalThis.MediaStream;
        globalThis.MediaStream = class MediaStream {
          constructor(tracks = []) { this._tracks = tracks; }
          getAudioTracks() { return this._tracks; }
        };
      });

      afterAll(() => {
        if (OriginalMediaStream) {
          globalThis.MediaStream = OriginalMediaStream;
        } else {
          delete globalThis.MediaStream;
        }
      });

      it('validates a proper MediaStream with active tracks', () => {
        const stream = new globalThis.MediaStream([
          { readyState: 'live', enabled: true },
        ]);
        const result = AudioValidator.validateMediaStream(stream);
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
      });

      it('rejects non-MediaStream object', () => {
        const result = AudioValidator.validateMediaStream({});
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Invalid MediaStream object');
      });

      it('rejects MediaStream with no audio tracks', () => {
        const stream = new globalThis.MediaStream([]);
        const result = AudioValidator.validateMediaStream(stream);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('MediaStream has no audio tracks');
      });

      it('rejects MediaStream with only inactive tracks', () => {
        const stream = new globalThis.MediaStream([
          { readyState: 'ended', enabled: true },
          { readyState: 'live', enabled: false },
        ]);
        const result = AudioValidator.validateMediaStream(stream);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('MediaStream has no active audio tracks');
      });
    });
  });

  // --- validateMediaRecorder ---
  describe('validateMediaRecorder()', () => {
    it('rejects null', () => {
      const result = AudioValidator.validateMediaRecorder(null);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('MediaRecorder is required');
    });

    it('throws ReferenceError for non-MediaRecorder in Node env (no polyfill)', () => {
      if (typeof globalThis.MediaRecorder === 'undefined') {
        expect(() => AudioValidator.validateMediaRecorder({})).toThrow(ReferenceError);
      } else {
        const result = AudioValidator.validateMediaRecorder({});
        expect(result.valid).toBe(false);
      }
    });

    describe('with polyfilled MediaRecorder', () => {
      let OriginalMediaRecorder;

      beforeAll(() => {
        OriginalMediaRecorder = globalThis.MediaRecorder;
        globalThis.MediaRecorder = class MediaRecorder {
          constructor(state, stream) {
            this.state = state || 'inactive';
            this.stream = stream || { getAudioTracks: () => [] };
          }
        };
      });

      afterAll(() => {
        if (OriginalMediaRecorder) {
          globalThis.MediaRecorder = OriginalMediaRecorder;
        } else {
          delete globalThis.MediaRecorder;
        }
      });

      it('validates a proper MediaRecorder', () => {
        const recorder = new globalThis.MediaRecorder('recording', {
          getAudioTracks: () => [{ readyState: 'live' }],
        });
        const result = AudioValidator.validateMediaRecorder(recorder);
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
      });

      it('rejects non-MediaRecorder object', () => {
        const result = AudioValidator.validateMediaRecorder({});
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Invalid MediaRecorder object');
      });

      it('rejects inactive recorder with no audio source', () => {
        const recorder = new globalThis.MediaRecorder('inactive', {
          getAudioTracks: () => [],
        });
        const result = AudioValidator.validateMediaRecorder(recorder);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('MediaRecorder has no valid audio source');
      });
    });
  });

  // --- validateAudioContext ---
  describe('validateAudioContext()', () => {
    it('rejects null', () => {
      const result = AudioValidator.validateAudioContext(null);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('AudioContext is required');
    });

    describe('with polyfilled AudioContext', () => {
      let OriginalAudioContext, OriginalWebkitAudioContext;

      beforeAll(() => {
        OriginalAudioContext = globalThis.AudioContext;
        OriginalWebkitAudioContext = globalThis.webkitAudioContext;
        globalThis.AudioContext = class AudioContext {
          constructor(state) { this.state = state || 'running'; }
        };
        globalThis.webkitAudioContext = globalThis.AudioContext;
      });

      afterAll(() => {
        if (OriginalAudioContext) {
          globalThis.AudioContext = OriginalAudioContext;
        } else {
          delete globalThis.AudioContext;
        }
        if (OriginalWebkitAudioContext) {
          globalThis.webkitAudioContext = OriginalWebkitAudioContext;
        } else {
          delete globalThis.webkitAudioContext;
        }
      });

      it('validates a running AudioContext', () => {
        const ctx = new globalThis.AudioContext('running');
        const result = AudioValidator.validateAudioContext(ctx);
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
      });

      it('rejects non-AudioContext object', () => {
        const result = AudioValidator.validateAudioContext({});
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Invalid AudioContext object');
      });

      it('rejects closed AudioContext', () => {
        const ctx = new globalThis.AudioContext('closed');
        const result = AudioValidator.validateAudioContext(ctx);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('AudioContext is closed');
      });
    });
  });

  // --- Legacy methods (deprecated, always return valid) ---
  describe('legacy deprecated methods', () => {
    it('validateStreamData returns valid', () => {
      expect(AudioValidator.validateStreamData({}).valid).toBe(true);
    });

    it('validateTTSData returns valid', () => {
      expect(AudioValidator.validateTTSData({}).valid).toBe(true);
    });

    it('validateSTTData returns valid', () => {
      expect(AudioValidator.validateSTTData({}).valid).toBe(true);
    });

    it('validateConfig returns valid', () => {
      expect(AudioValidator.validateConfig({}).valid).toBe(true);
    });

    it('validateAudioLevel returns valid', () => {
      expect(AudioValidator.validateAudioLevel(0.5).valid).toBe(true);
    });
  });
});
