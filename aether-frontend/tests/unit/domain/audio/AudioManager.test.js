'use strict';

/**
 * AudioManager Unit Tests
 * ============================================================================
 * Tests constructor (defaults, DI), initialize (idempotent, invalid config),
 * stopMicrophone (stream cleanup, no stream, event emission), _handleAudioData,
 * _handleRawPCM, _downsampleAudio, handleTTSAudio, playNextTTS (empty queue,
 * PCM format, error path), stopTTS, clearTTSQueue, handleSTTPartial/Final,
 * getCurrentStreamStatus, getTTSStatus, getSTTStatistics, updateConfig, cleanup.
 *
 * startMicrophone requires heavy browser APIs (getUserMedia, AudioContext,
 * ScriptProcessorNode). Tested at integration level. Here we test the
 * pre-condition checks and delegation.
 *
 * @module tests/unit/domain/audio/AudioManager.test
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockStreamService = {
  startStream: jest.fn().mockReturnValue({
    setAnalyser: jest.fn(),
    captureNode: null,
    getDuration: jest.fn().mockReturnValue(5000),
  }),
  stopStream: jest.fn().mockReturnValue({
    getDuration: jest.fn().mockReturnValue(5000),
  }),
  cleanupStream: jest.fn(),
  cleanupAllStreams: jest.fn(),
  isStreamActive: jest.fn().mockReturnValue(true),
  validateChunk: jest.fn().mockReturnValue(true),
  getStream: jest.fn(),
  getStreamMetadata: jest.fn().mockReturnValue({ id: 's1', active: true }),
  calculateAudioLevel: jest.fn().mockReturnValue(0.5),
  updateAudioLevel: jest.fn(),
};

const mockTTSService = {
  enqueue: jest.fn().mockReturnValue({ id: 'tts-1' }),
  dequeue: jest.fn(),
  isPlaying: jest.fn().mockReturnValue(false),
  startPlayback: jest.fn(),
  completePlayback: jest.fn(),
  failPlayback: jest.fn(),
  stopCurrent: jest.fn(),
  clearQueue: jest.fn(),
  cleanup: jest.fn(),
  getStatistics: jest.fn().mockReturnValue({ queued: 0, played: 0 }),
};

const mockSTTService = {
  processPartial: jest.fn().mockReturnValue({
    getTrimmedText: () => 'hello',
    confidence: 0.9,
  }),
  processFinal: jest.fn().mockReturnValue({
    getTrimmedText: () => 'hello world',
    confidence: 0.95,
  }),
  cleanup: jest.fn(),
  getStreamStatistics: jest.fn().mockReturnValue({ partials: 5 }),
  getGlobalStatistics: jest.fn().mockReturnValue({ total: 10 }),
};

jest.mock('../../../../src/domain/audio/services/AudioStreamService', () => ({
  AudioStreamService: jest.fn(() => mockStreamService),
}));

jest.mock('../../../../src/domain/audio/services/TTSService', () => ({
  TTSService: jest.fn(() => mockTTSService),
}));

jest.mock('../../../../src/domain/audio/services/STTService', () => ({
  STTService: jest.fn(() => mockSTTService),
}));

// Mock AudioConfig with controllable behaviour
const mockConfig = {
  validate: jest.fn().mockReturnValue({ valid: true, errors: [] }),
  isMicrophoneEnabled: jest.fn().mockReturnValue(true),
  isTTSEnabled: jest.fn().mockReturnValue(true),
  isVisualizationEnabled: jest.fn().mockReturnValue(false),
  getMicrophoneConstraints: jest.fn().mockReturnValue({ audio: true }),
  getAudioContextOptions: jest.fn().mockReturnValue({}),
  microphone: { fftSize: 2048, enabled: true },
  tts: { autoPlay: true, volume: 1.0, queueEnabled: true },
  updateMicrophone: jest.fn(),
  updateTTS: jest.fn(),
  updateGeneral: jest.fn(),
  toJSON: jest.fn().mockReturnValue({}),
};

jest.mock('../../../../src/domain/audio/models/AudioConfig', () => ({
  AudioConfig: {
    createDefault: jest.fn(() => mockConfig),
  },
}));

const { AudioManager } = require('../../../../src/domain/audio/services/AudioManager');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createManager(overrides = {}) {
  return new AudioManager({
    eventBus: { emit: jest.fn() },
    endpoint: { connection: { send: jest.fn() }, streamAudio: jest.fn() },
    config: mockConfig,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AudioManager', () => {
  let am;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig.validate.mockReturnValue({ valid: true, errors: [] });
    mockConfig.isTTSEnabled.mockReturnValue(true);
    mockConfig.isMicrophoneEnabled.mockReturnValue(true);
    mockTTSService.isPlaying.mockReturnValue(false);
    mockStreamService.isStreamActive.mockReturnValue(true);
    mockStreamService.validateChunk.mockReturnValue(true);
    global.cancelAnimationFrame = jest.fn();
    global.requestAnimationFrame = jest.fn(() => 42); // return frame ID, don't auto-execute
    am = createManager();
  });

  afterEach(() => {
    delete global.cancelAnimationFrame;
    delete global.requestAnimationFrame;
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('accepts injected dependencies', () => {
      expect(am.eventBus).toBeDefined();
      expect(am.endpoint).toBeDefined();
      expect(am.config).toBe(mockConfig);
    });

    it('creates default config when none provided', () => {
      const m = new AudioManager();
      expect(m.config).toBe(mockConfig); // createDefault mock
    });

    it('initialises sub-services', () => {
      expect(am.streamService).toBeDefined();
      expect(am.ttsService).toBeDefined();
      expect(am.sttService).toBeDefined();
    });

    it('starts un-initialized', () => {
      expect(am._initialized).toBe(false);
      expect(am._currentStreamId).toBeNull();
    });
  });

  // =========================================================================
  // initialize
  // =========================================================================

  describe('initialize', () => {
    it('sets _initialized to true', async () => {
      await am.initialize();
      expect(am._initialized).toBe(true);
    });

    it('is idempotent', async () => {
      await am.initialize();
      await am.initialize(); // second call should no-op
      expect(mockConfig.validate).toHaveBeenCalledTimes(1);
    });

    it('throws on invalid config', async () => {
      mockConfig.validate.mockReturnValue({ valid: false, errors: ['bad sample rate'] });
      await expect(am.initialize()).rejects.toThrow('Invalid audio configuration');
    });

    it('does not set _initialized on failure', async () => {
      mockConfig.validate.mockReturnValue({ valid: false, errors: ['err'] });
      try { await am.initialize(); } catch (e) { /* expected */ }
      expect(am._initialized).toBe(false);
    });
  });

  // =========================================================================
  // checkMicrophoneAvailability
  // =========================================================================

  describe('checkMicrophoneAvailability', () => {
    it('returns true when getUserMedia succeeds', async () => {
      const mockTrack = { stop: jest.fn() };
      global.navigator = {
        mediaDevices: {
          getUserMedia: jest.fn().mockResolvedValue({ getTracks: () => [mockTrack] }),
        },
      };
      const result = await am.checkMicrophoneAvailability();
      expect(result).toBe(true);
      expect(mockTrack.stop).toHaveBeenCalledTimes(1);
      delete global.navigator;
    });

    it('returns false when mediaDevices is undefined', async () => {
      global.navigator = {};
      const result = await am.checkMicrophoneAvailability();
      expect(result).toBe(false);
      delete global.navigator;
    });

    it('returns false when getUserMedia throws', async () => {
      global.navigator = {
        mediaDevices: {
          getUserMedia: jest.fn().mockRejectedValue(new Error('denied')),
        },
      };
      const result = await am.checkMicrophoneAvailability();
      expect(result).toBe(false);
      delete global.navigator;
    });
  });

  // =========================================================================
  // startMicrophone
  // =========================================================================

  describe('startMicrophone', () => {
    it('throws when not initialized', async () => {
      await expect(am.startMicrophone()).rejects.toThrow('AudioManager not initialized');
    });

    it('throws when microphone disabled in config', async () => {
      await am.initialize();
      mockConfig.isMicrophoneEnabled.mockReturnValue(false);
      await expect(am.startMicrophone()).rejects.toThrow('Microphone is disabled');
    });

    it('throws when AudioContext is not available', async () => {
      await am.initialize();
      const mockTrack = { stop: jest.fn() };
      const mockStream = { getTracks: () => [mockTrack], active: true };
      global.navigator = {
        mediaDevices: { getUserMedia: jest.fn().mockResolvedValue(mockStream) },
      };
      // No AudioContext
      delete globalThis.AudioContext;
      delete globalThis.webkitAudioContext;
      await expect(am.startMicrophone()).rejects.toThrow('AudioContext is not available');
      delete global.navigator;
    });

    it('full path: starts stream with ScriptProcessorNode', async () => {
      await am.initialize();
      const mockTrack = { stop: jest.fn() };
      const mockMediaStream = { getTracks: () => [mockTrack], active: true };
      global.navigator = {
        mediaDevices: { getUserMedia: jest.fn().mockResolvedValue(mockMediaStream) },
      };

      const mockAnalyser = { fftSize: 2048, connect: jest.fn(), frequencyBinCount: 128, getByteFrequencyData: jest.fn() };
      const mockSource = { connect: jest.fn() };
      const mockScriptNode = { onaudioprocess: null, connect: jest.fn() };
      const mockAudioCtx = {
        sampleRate: 48000,
        state: 'running',
        createMediaStreamSource: jest.fn().mockReturnValue(mockSource),
        createAnalyser: jest.fn().mockReturnValue(mockAnalyser),
        createScriptProcessor: jest.fn().mockReturnValue(mockScriptNode),
        destination: {},
      };
      globalThis.AudioContext = jest.fn().mockReturnValue(mockAudioCtx);

      const streamId = await am.startMicrophone({ streamId: 'test-id' });
      expect(streamId).toBe('test-id');
      expect(mockStreamService.startStream).toHaveBeenCalledWith(
        'test-id',
        mockMediaStream,
        null,
        expect.any(Object)
      );
      expect(am._currentStreamId).toBe('test-id');
      expect(am.eventBus.emit).toHaveBeenCalledWith('audio:stream-started', { streamId: 'test-id' });
      expect(am.endpoint.connection.send).toHaveBeenCalledWith({ role: 'user', start: true });

      delete global.navigator;
      delete globalThis.AudioContext;
    });
  });

  // =========================================================================
  // stopMicrophone
  // =========================================================================

  describe('stopMicrophone', () => {
    it('no-ops when no current stream', async () => {
      await am.stopMicrophone();
      expect(mockStreamService.stopStream).not.toHaveBeenCalled();
    });

    it('stops and cleans up stream', async () => {
      am._currentStreamId = 'test-stream';
      await am.stopMicrophone();
      expect(mockStreamService.stopStream).toHaveBeenCalledWith('test-stream');
      expect(mockStreamService.cleanupStream).toHaveBeenCalledWith('test-stream');
      expect(am._currentStreamId).toBeNull();
    });

    it('emits stream-stopped event', async () => {
      am._currentStreamId = 'test-stream';
      await am.stopMicrophone();
      expect(am.eventBus.emit).toHaveBeenCalledWith('audio:stream-stopped', expect.objectContaining({
        streamId: 'test-stream',
      }));
    });

    it('sends end notification to endpoint', async () => {
      am._currentStreamId = 'test-stream';
      await am.stopMicrophone();
      expect(am.endpoint.connection.send).toHaveBeenCalledWith({ role: 'user', end: true });
    });

    it('cancels visualization frame', async () => {
      am._currentStreamId = 'test-stream';
      am._visualizationFrameId = 42;
      await am.stopMicrophone();
      expect(global.cancelAnimationFrame).toHaveBeenCalledWith(42);
      expect(am._visualizationFrameId).toBeNull();
    });

    it('uses explicit streamId over current', async () => {
      am._currentStreamId = 'current';
      await am.stopMicrophone('explicit');
      expect(mockStreamService.stopStream).toHaveBeenCalledWith('explicit');
      // _currentStreamId not nulled because 'current' !== 'explicit'
      expect(am._currentStreamId).toBe('current');
    });

    it('handles null stream from stopStream gracefully', async () => {
      am._currentStreamId = 'test-stream';
      mockStreamService.stopStream.mockReturnValueOnce(null);
      await am.stopMicrophone();
      expect(mockStreamService.cleanupStream).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _handleAudioData
  // =========================================================================

  describe('_handleAudioData', () => {
    it('sends valid chunk to endpoint', async () => {
      const blob = { arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(100)) };
      await am._handleAudioData('s1', blob);
      expect(am.endpoint.streamAudio).toHaveBeenCalledTimes(1);
      expect(am.eventBus.emit).toHaveBeenCalledWith('audio:chunk-sent', expect.objectContaining({
        streamId: 's1',
        size: 100,
      }));
    });

    it('skips invalid chunk', async () => {
      mockStreamService.validateChunk.mockReturnValueOnce(false);
      const blob = { arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)) };
      await am._handleAudioData('s1', blob);
      expect(am.endpoint.streamAudio).not.toHaveBeenCalled();
    });

    it('does not send when stream not active', async () => {
      mockStreamService.isStreamActive.mockReturnValueOnce(false);
      const blob = { arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)) };
      await am._handleAudioData('s1', blob);
      expect(am.endpoint.streamAudio).not.toHaveBeenCalled();
    });

    it('emits error event on failure', async () => {
      const blob = { arrayBuffer: jest.fn().mockRejectedValue(new Error('boom')) };
      await am._handleAudioData('s1', blob);
      expect(am.eventBus.emit).toHaveBeenCalledWith('audio:error', expect.objectContaining({
        streamId: 's1',
      }));
    });
  });

  // =========================================================================
  // _handleRawPCM
  // =========================================================================

  describe('_handleRawPCM', () => {
    beforeEach(() => {
      global.btoa = jest.fn(s => Buffer.from(s, 'binary').toString('base64'));
    });
    afterEach(() => { delete global.btoa; });

    it('sends base64-encoded PCM to endpoint', async () => {
      const pcm = new Int16Array([100, -100]).buffer;
      await am._handleRawPCM('s1', pcm, 16000);
      expect(am.endpoint.connection.send).toHaveBeenCalledWith(expect.objectContaining({
        role: 'user',
        type: 'audio',
        format: 'pcm16',
        sampleRate: 16000,
      }));
    });

    it('emits chunk-sent with pcm16 format', async () => {
      const pcm = new Int16Array([1]).buffer;
      await am._handleRawPCM('s1', pcm, 16000);
      expect(am.eventBus.emit).toHaveBeenCalledWith('audio:chunk-sent', expect.objectContaining({
        format: 'pcm16',
      }));
    });

    it('skips when stream not active', async () => {
      mockStreamService.isStreamActive.mockReturnValueOnce(false);
      await am._handleRawPCM('s1', new ArrayBuffer(4), 16000);
      expect(am.endpoint.connection.send).not.toHaveBeenCalled();
    });

    it('skips when no endpoint', async () => {
      const m = createManager({ endpoint: null });
      await m._handleRawPCM('s1', new ArrayBuffer(4), 16000);
      // No throw, just early return
    });
  });

  // =========================================================================
  // _downsampleAudio
  // =========================================================================

  describe('_downsampleAudio', () => {
    it('returns same buffer when sample rates match', () => {
      const buf = new Float32Array([0.1, 0.2, 0.3]);
      expect(am._downsampleAudio(buf, 16000, 16000)).toBe(buf);
    });

    it('downsamples from 48kHz to 16kHz (3:1 ratio)', () => {
      // 6 samples at 48kHz → ~2 samples at 16kHz
      const input = new Float32Array([0.3, 0.6, 0.9, 0.3, 0.6, 0.9]);
      const result = am._downsampleAudio(input, 48000, 16000);
      expect(result.length).toBe(2);
      expect(result).toBeInstanceOf(Float32Array);
    });

    it('output values are averages of input groups', () => {
      // 3 samples averaged: (0.3+0.6+0.9)/3 = 0.6
      const input = new Float32Array([0.3, 0.6, 0.9]);
      const result = am._downsampleAudio(input, 48000, 16000);
      expect(result[0]).toBeCloseTo(0.6, 5);
    });
  });

  // =========================================================================
  // _startVisualization
  // =========================================================================

  describe('_startVisualization', () => {
    it('no-ops when stream not found', () => {
      mockStreamService.getStream.mockReturnValueOnce(null);
      am._startVisualization('s1');
      expect(global.requestAnimationFrame).not.toHaveBeenCalled();
    });

    it('no-ops when no analyser', () => {
      mockStreamService.getStream.mockReturnValueOnce({ getAnalyser: () => null });
      am._startVisualization('s1');
      expect(global.requestAnimationFrame).not.toHaveBeenCalled();
    });

    it('starts animation loop when analyser available', () => {
      const mockAnalyser = {
        frequencyBinCount: 4,
        getByteFrequencyData: jest.fn(),
      };
      mockStreamService.getStream.mockReturnValueOnce({ getAnalyser: () => mockAnalyser });
      // First call to isStreamActive in the loop
      mockStreamService.isStreamActive.mockReturnValueOnce(true);
      am._startVisualization('s1');
      // getByteFrequencyData called
      expect(mockAnalyser.getByteFrequencyData).toHaveBeenCalledTimes(1);
      expect(mockStreamService.calculateAudioLevel).toHaveBeenCalledTimes(1);
      expect(am.eventBus.emit).toHaveBeenCalledWith('audio:level-updated', expect.objectContaining({
        streamId: 's1',
        source: 'stt',
      }));
    });
  });

  // =========================================================================
  // handleTTSAudio
  // =========================================================================

  describe('handleTTSAudio', () => {
    it('enqueues audio and emits tts-queued', async () => {
      await am.handleTTSAudio(new ArrayBuffer(100));
      expect(mockTTSService.enqueue).toHaveBeenCalledTimes(1);
      expect(am.eventBus.emit).toHaveBeenCalledWith('audio:tts-queued', { audioId: 'tts-1' });
    });

    it('does nothing when TTS disabled', async () => {
      mockConfig.isTTSEnabled.mockReturnValueOnce(false);
      await am.handleTTSAudio(new ArrayBuffer(100));
      expect(mockTTSService.enqueue).not.toHaveBeenCalled();
    });

    it('emits error event on failure', async () => {
      mockTTSService.enqueue.mockImplementationOnce(() => { throw new Error('boom'); });
      await am.handleTTSAudio(new ArrayBuffer(100));
      expect(am.eventBus.emit).toHaveBeenCalledWith('audio:error', expect.objectContaining({ error: expect.any(Error) }));
    });
  });

  // =========================================================================
  // playNextTTS
  // =========================================================================

  describe('playNextTTS', () => {
    it('no-ops when already playing', async () => {
      mockTTSService.isPlaying.mockReturnValueOnce(true);
      await am.playNextTTS();
      expect(mockTTSService.dequeue).not.toHaveBeenCalled();
    });

    it('emits tts-queue-empty when no audio in queue', async () => {
      mockTTSService.dequeue.mockReturnValueOnce(null);
      await am.playNextTTS();
      expect(am.eventBus.emit).toHaveBeenCalledWith('audio:tts-queue-empty');
    });

    it('plays PCM16 audio without decodeAudioData', async () => {
      const mockAudio = {
        id: 'tts-pcm',
        format: 'pcm16',
        sampleRate: 24000,
        getArrayBuffer: () => new Int16Array([100, -100, 50]).buffer,
        setDecodedBuffer: jest.fn(),
      };
      mockTTSService.dequeue.mockReturnValueOnce(mockAudio);

      const mockGainNode = { gain: { value: 1 }, connect: jest.fn() };
      const mockAnalyser = {
        fftSize: 256,
        frequencyBinCount: 128,
        connect: jest.fn(),
        getByteFrequencyData: jest.fn(),
      };
      const mockSource = {
        buffer: null,
        connect: jest.fn(),
        start: jest.fn(),
        onended: null,
      };
      const mockAudioBuffer = { getChannelData: jest.fn().mockReturnValue(new Float32Array(3)) };
      const mockAudioCtx = {
        state: 'running',
        createBufferSource: jest.fn().mockReturnValue(mockSource),
        createAnalyser: jest.fn().mockReturnValue(mockAnalyser),
        createGain: jest.fn().mockReturnValue(mockGainNode),
        createBuffer: jest.fn().mockReturnValue(mockAudioBuffer),
        destination: {},
        close: jest.fn().mockResolvedValue(undefined),
      };
      globalThis.AudioContext = jest.fn().mockReturnValue(mockAudioCtx);
      // isPlaying returns true during monitor loop check to prevent infinite loop
      mockTTSService.isPlaying.mockReturnValue(false);

      await am.playNextTTS();

      expect(mockTTSService.startPlayback).toHaveBeenCalledWith(mockAudio);
      expect(am.eventBus.emit).toHaveBeenCalledWith('audio:tts-started', { audioId: 'tts-pcm' });
      expect(mockAudioCtx.createBuffer).toHaveBeenCalledWith(1, 3, 24000);
      expect(mockSource.start).toHaveBeenCalledWith(0);

      delete globalThis.AudioContext;
    });

    it('plays container format audio via decodeAudioData', async () => {
      const mockAudio = {
        id: 'tts-wav',
        format: 'wav',
        getArrayBuffer: () => new ArrayBuffer(100),
        setDecodedBuffer: jest.fn(),
      };
      mockTTSService.dequeue.mockReturnValueOnce(mockAudio);

      const decodedBuffer = { duration: 2.0 };
      const mockAnalyser = { fftSize: 256, frequencyBinCount: 128, connect: jest.fn(), getByteFrequencyData: jest.fn() };
      const mockSource = { buffer: null, connect: jest.fn(), start: jest.fn(), onended: null };
      const mockAudioCtx = {
        state: 'running',
        createBufferSource: jest.fn().mockReturnValue(mockSource),
        createAnalyser: jest.fn().mockReturnValue(mockAnalyser),
        createGain: jest.fn(),
        decodeAudioData: jest.fn().mockResolvedValue(decodedBuffer),
        destination: {},
        close: jest.fn().mockResolvedValue(undefined),
      };
      globalThis.AudioContext = jest.fn().mockReturnValue(mockAudioCtx);
      mockTTSService.isPlaying.mockReturnValue(false);

      await am.playNextTTS();

      expect(mockAudioCtx.decodeAudioData).toHaveBeenCalledTimes(1);
      expect(mockAudio.setDecodedBuffer).toHaveBeenCalledWith(decodedBuffer);
      expect(mockSource.start).toHaveBeenCalledWith(0);

      delete globalThis.AudioContext;
    });

    it('applies gain node when volume is not 1.0', async () => {
      mockConfig.tts.volume = 0.5;
      const mockAudio = {
        id: 'tts-vol', format: 'pcm16', sampleRate: 24000,
        getArrayBuffer: () => new Int16Array([1]).buffer,
        setDecodedBuffer: jest.fn(),
      };
      mockTTSService.dequeue.mockReturnValueOnce(mockAudio);

      const mockGainNode = { gain: { value: 1 }, connect: jest.fn() };
      const mockAnalyser = { fftSize: 256, frequencyBinCount: 128, connect: jest.fn(), getByteFrequencyData: jest.fn() };
      const mockSource = { buffer: null, connect: jest.fn(), start: jest.fn(), onended: null };
      const mockAudioBuffer = { getChannelData: jest.fn().mockReturnValue(new Float32Array(1)) };
      const mockAudioCtx = {
        state: 'running',
        createBufferSource: jest.fn().mockReturnValue(mockSource),
        createAnalyser: jest.fn().mockReturnValue(mockAnalyser),
        createGain: jest.fn().mockReturnValue(mockGainNode),
        createBuffer: jest.fn().mockReturnValue(mockAudioBuffer),
        destination: {},
        close: jest.fn().mockResolvedValue(undefined),
      };
      globalThis.AudioContext = jest.fn().mockReturnValue(mockAudioCtx);
      mockTTSService.isPlaying.mockReturnValue(false);

      await am.playNextTTS();

      expect(mockAudioCtx.createGain).toHaveBeenCalledTimes(1);
      expect(mockGainNode.gain.value).toBe(0.5);
      expect(mockGainNode.connect).toHaveBeenCalledWith(mockAudioCtx.destination);

      mockConfig.tts.volume = 1.0; // restore
      delete globalThis.AudioContext;
    });

    it('handles decode error and calls failPlayback', async () => {
      const mockAudio = {
        id: 'tts-err', format: 'wav',
        getArrayBuffer: () => new ArrayBuffer(10),
        setDecodedBuffer: jest.fn(),
      };
      mockTTSService.dequeue.mockReturnValueOnce(mockAudio);

      const mockAudioCtx = {
        state: 'running',
        createBufferSource: jest.fn(),
        createAnalyser: jest.fn(),
        decodeAudioData: jest.fn().mockRejectedValue(new Error('decode fail')),
        destination: {},
        close: jest.fn().mockResolvedValue(undefined),
      };
      globalThis.AudioContext = jest.fn().mockReturnValue(mockAudioCtx);
      mockTTSService.isPlaying.mockReturnValue(false);
      mockConfig.tts.queueEnabled = false; // prevent recursive call

      await am.playNextTTS();

      expect(mockTTSService.failPlayback).toHaveBeenCalledWith(mockAudio, expect.any(Error));
      expect(am.eventBus.emit).toHaveBeenCalledWith('audio:tts-error', expect.objectContaining({
        audioId: 'tts-err',
      }));

      mockConfig.tts.queueEnabled = true; // restore
      delete globalThis.AudioContext;
    });

    it('throws when AudioContext not available', async () => {
      const mockAudio = { id: 'x', format: 'wav', getArrayBuffer: jest.fn() };
      mockTTSService.dequeue.mockReturnValueOnce(mockAudio);
      delete globalThis.AudioContext;
      delete globalThis.webkitAudioContext;
      mockConfig.tts.queueEnabled = false;

      await am.playNextTTS();

      expect(mockTTSService.failPlayback).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'x' }),
        expect.any(Error)
      );
      expect(am.eventBus.emit).toHaveBeenCalledWith('audio:tts-error', expect.any(Object));

      mockConfig.tts.queueEnabled = true;
    });
  });

  // =========================================================================
  // stopTTS
  // =========================================================================

  describe('stopTTS', () => {
    it('delegates to ttsService.stopCurrent', () => {
      mockTTSService.stopCurrent.mockReturnValueOnce({ id: 'tts-1' });
      am.stopTTS();
      expect(mockTTSService.stopCurrent).toHaveBeenCalledTimes(1);
      expect(am.eventBus.emit).toHaveBeenCalledWith('audio:tts-stopped', { audioId: 'tts-1' });
    });

    it('does not emit when stopCurrent returns null', () => {
      mockTTSService.stopCurrent.mockReturnValueOnce(null);
      am.stopTTS();
      expect(am.eventBus.emit).not.toHaveBeenCalledWith('audio:tts-stopped', expect.anything());
    });
  });

  // =========================================================================
  // clearTTSQueue
  // =========================================================================

  describe('clearTTSQueue', () => {
    it('delegates and emits tts-queue-cleared', () => {
      am.clearTTSQueue();
      expect(mockTTSService.clearQueue).toHaveBeenCalledTimes(1);
      expect(am.eventBus.emit).toHaveBeenCalledWith('audio:tts-queue-cleared');
    });
  });

  // =========================================================================
  // handleSTTPartial
  // =========================================================================

  describe('handleSTTPartial', () => {
    it('delegates to sttService and emits stt-partial', () => {
      am.handleSTTPartial('s1', 'hello');
      expect(mockSTTService.processPartial).toHaveBeenCalledWith('s1', 'hello', {});
      expect(am.eventBus.emit).toHaveBeenCalledWith('audio:stt-partial', {
        streamId: 's1',
        text: 'hello',
        confidence: 0.9,
      });
    });

    it('catches errors without throwing', () => {
      mockSTTService.processPartial.mockImplementationOnce(() => { throw new Error('fail'); });
      expect(() => am.handleSTTPartial('s1', 'x')).not.toThrow();
    });
  });

  // =========================================================================
  // handleSTTFinal
  // =========================================================================

  describe('handleSTTFinal', () => {
    it('delegates to sttService and emits stt-final', () => {
      am.handleSTTFinal('s1', 'hello world');
      expect(mockSTTService.processFinal).toHaveBeenCalledWith('s1', 'hello world', {});
      expect(am.eventBus.emit).toHaveBeenCalledWith('audio:stt-final', {
        streamId: 's1',
        text: 'hello world',
        confidence: 0.95,
      });
    });

    it('catches errors without throwing', () => {
      mockSTTService.processFinal.mockImplementationOnce(() => { throw new Error('fail'); });
      expect(() => am.handleSTTFinal('s1', 'x')).not.toThrow();
    });
  });

  // =========================================================================
  // getCurrentStreamStatus
  // =========================================================================

  describe('getCurrentStreamStatus', () => {
    it('returns null when no current stream', () => {
      expect(am.getCurrentStreamStatus()).toBeNull();
    });

    it('delegates to streamService', () => {
      am._currentStreamId = 's1';
      expect(am.getCurrentStreamStatus()).toEqual({ id: 's1', active: true });
    });
  });

  // =========================================================================
  // getTTSStatus / getSTTStatistics
  // =========================================================================

  describe('getTTSStatus', () => {
    it('delegates to ttsService', () => {
      expect(am.getTTSStatus()).toEqual({ queued: 0, played: 0 });
    });
  });

  describe('getSTTStatistics', () => {
    it('returns stream stats when streamId provided', () => {
      expect(am.getSTTStatistics('s1')).toEqual({ partials: 5 });
    });

    it('returns global stats when no streamId', () => {
      expect(am.getSTTStatistics()).toEqual({ total: 10 });
    });
  });

  // =========================================================================
  // updateConfig
  // =========================================================================

  describe('updateConfig', () => {
    it('updates microphone config', () => {
      am.updateConfig({ microphone: { sampleRate: 44100 } });
      expect(mockConfig.updateMicrophone).toHaveBeenCalledWith({ sampleRate: 44100 });
    });

    it('updates TTS config', () => {
      am.updateConfig({ tts: { volume: 0.5 } });
      expect(mockConfig.updateTTS).toHaveBeenCalledWith({ volume: 0.5 });
    });

    it('updates general config', () => {
      am.updateConfig({ general: { debug: true } });
      expect(mockConfig.updateGeneral).toHaveBeenCalledWith({ debug: true });
    });

    it('validates after update and throws on invalid', () => {
      mockConfig.validate.mockReturnValueOnce({ valid: false, errors: ['bad'] });
      expect(() => am.updateConfig({ microphone: {} })).toThrow('Invalid configuration update');
    });

    it('emits config-updated on success', () => {
      am.updateConfig({ tts: { volume: 0.8 } });
      expect(am.eventBus.emit).toHaveBeenCalledWith('audio:config-updated', expect.any(Object));
    });
  });

  // =========================================================================
  // cleanup
  // =========================================================================

  describe('cleanup', () => {
    it('cleans up all services', () => {
      am.cleanup();
      expect(mockStreamService.cleanupAllStreams).toHaveBeenCalledTimes(1);
      expect(mockTTSService.cleanup).toHaveBeenCalledTimes(1);
      expect(mockSTTService.cleanup).toHaveBeenCalledTimes(1);
    });

    it('cancels visualization frame', () => {
      am._visualizationFrameId = 99;
      am.cleanup();
      expect(global.cancelAnimationFrame).toHaveBeenCalledWith(99);
      expect(am._visualizationFrameId).toBeNull();
    });

    it('resets state', () => {
      am._currentStreamId = 's1';
      am._initialized = true;
      am.cleanup();
      expect(am._currentStreamId).toBeNull();
      expect(am._initialized).toBe(false);
    });

    it('emits cleanup-complete', () => {
      am.cleanup();
      expect(am.eventBus.emit).toHaveBeenCalledWith('audio:cleanup-complete');
    });

    it('works without eventBus', () => {
      const m = createManager({ eventBus: null });
      expect(() => m.cleanup()).not.toThrow();
    });
  });

  // =========================================================================
  // Additional branch coverage — onaudioprocess callback
  // =========================================================================

  describe('startMicrophone — onaudioprocess callback', () => {
    const mLog = { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    let scriptNode;

    function setupMic(ctxOverrides = {}) {
      const trk = { stop: jest.fn() };
      global.navigator = {
        mediaDevices: { getUserMedia: jest.fn().mockResolvedValue({ getTracks: () => [trk], active: true }) },
      };
      const analyser = { fftSize: 2048, connect: jest.fn(), frequencyBinCount: 128, getByteFrequencyData: jest.fn() };
      scriptNode = { onaudioprocess: null, connect: jest.fn() };
      globalThis.AudioContext = jest.fn().mockReturnValue({
        sampleRate: 48000, state: 'running',
        createMediaStreamSource: jest.fn().mockReturnValue({ connect: jest.fn() }),
        createAnalyser: jest.fn().mockReturnValue(analyser),
        createScriptProcessor: jest.fn().mockReturnValue(scriptNode),
        destination: {},
        ...ctxOverrides,
      });
    }

    beforeEach(() => {
      mLog.trace.mockClear(); mLog.debug.mockClear(); mLog.info.mockClear(); mLog.warn.mockClear(); mLog.error.mockClear();
      mockConfig.validate.mockReturnValue({ valid: true, errors: [] });
      mockConfig.isMicrophoneEnabled.mockReturnValue(true);
      mockConfig.isVisualizationEnabled.mockReturnValue(false);
      mockStreamService.isStreamActive.mockReturnValue(true);
    });

    afterEach(() => {
      delete global.navigator;
      delete globalThis.AudioContext;
      delete globalThis.webkitAudioContext;
    });

    it('processes audio, downsamples, and calls _handleRawPCM', async () => {
      setupMic();
      const m = new AudioManager({ eventBus: { emit: jest.fn() }, endpoint: { connection: { send: jest.fn() } }, config: mockConfig, logger: mLog });
      await m.initialize();
      const spy = jest.spyOn(m, '_handleRawPCM').mockResolvedValue();

      await m.startMicrophone({ streamId: 'oap-1' });
      expect(scriptNode.onaudioprocess).toBeInstanceOf(Function);

      scriptNode.onaudioprocess({
        inputBuffer: { getChannelData: jest.fn().mockReturnValue(new Float32Array([0.5, -0.5, 0.3, 0.1, 0.8, -0.2])) },
      });

      expect(spy).toHaveBeenCalledTimes(1);
      const [sid, buf, rate] = spy.mock.calls[0];
      expect(sid).toBe('oap-1');
      expect(rate).toBe(16000);
      expect(buf.byteLength).toBeGreaterThan(0);
      expect(mLog.debug).toHaveBeenCalledWith('onaudioprocess first call', expect.any(Object));
      spy.mockRestore();
    });

    it('early-returns when stream inactive', async () => {
      setupMic();
      const m = new AudioManager({ eventBus: { emit: jest.fn() }, endpoint: { connection: { send: jest.fn() } }, config: mockConfig, logger: mLog });
      await m.initialize();
      const spy = jest.spyOn(m, '_handleRawPCM').mockResolvedValue();

      await m.startMicrophone({ streamId: 'oap-2' });
      mockStreamService.isStreamActive.mockReturnValue(false);

      scriptNode.onaudioprocess({
        inputBuffer: { getChannelData: jest.fn().mockReturnValue(new Float32Array(6)) },
      });
      expect(spy).not.toHaveBeenCalled();
      mockStreamService.isStreamActive.mockReturnValue(true);
      spy.mockRestore();
    });

    it('skips downsample when sample rates match', async () => {
      setupMic({ sampleRate: 16000 });
      const m = new AudioManager({ eventBus: { emit: jest.fn() }, endpoint: { connection: { send: jest.fn() } }, config: mockConfig, logger: mLog });
      await m.initialize();
      const rawSpy = jest.spyOn(m, '_handleRawPCM').mockResolvedValue();
      const dsSpy = jest.spyOn(m, '_downsampleAudio');

      await m.startMicrophone({ streamId: 'oap-3' });
      scriptNode.onaudioprocess({
        inputBuffer: { getChannelData: jest.fn().mockReturnValue(new Float32Array([0.1, 0.2])) },
      });

      expect(dsSpy).not.toHaveBeenCalled();
      expect(rawSpy).toHaveBeenCalledTimes(1);
      const [sid, buf, rate] = rawSpy.mock.calls[0];
      expect(sid).toBe('oap-3');
      expect(rate).toBe(16000);
      rawSpy.mockRestore();
      dsSpy.mockRestore();
    });

    it('logs every 50th chunk', async () => {
      setupMic();
      const m = new AudioManager({ eventBus: { emit: jest.fn() }, endpoint: { connection: { send: jest.fn() } }, config: mockConfig, logger: mLog });
      await m.initialize();
      jest.spyOn(m, '_handleRawPCM').mockResolvedValue();

      await m.startMicrophone({ streamId: 'oap-4' });
      mLog.debug.mockClear();

      const evt = { inputBuffer: { getChannelData: jest.fn().mockReturnValue(new Float32Array(6)) } };
      for (let i = 0; i < 51; i++) {
        scriptNode.onaudioprocess(evt);
      }
      // chunk 0 first-call debug + chunk 50 modulo debug
      expect(mLog.debug.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('throws on ScriptProcessorNode creation failure', async () => {
      setupMic({ createScriptProcessor: jest.fn(() => { throw new Error('node fail'); }) });
      const m = new AudioManager({ eventBus: { emit: jest.fn() }, endpoint: { connection: { send: jest.fn() } }, config: mockConfig, logger: mLog });
      await m.initialize();

      await expect(m.startMicrophone()).rejects.toThrow('ScriptProcessorNode initialization failed');
      expect(mLog.error).toHaveBeenCalledWith('ScriptProcessorNode initialization failed', expect.any(Object));
    });

    it('starts visualization when enabled', async () => {
      setupMic();
      const m = new AudioManager({ eventBus: { emit: jest.fn() }, endpoint: { connection: { send: jest.fn() } }, config: mockConfig, logger: mLog });
      await m.initialize();
      mockConfig.isVisualizationEnabled.mockReturnValueOnce(true);
      const spy = jest.spyOn(m, '_startVisualization').mockImplementation(() => {});

      await m.startMicrophone({ streamId: 'viz-1' });
      expect(spy).toHaveBeenCalledWith('viz-1');
      spy.mockRestore();
    });

    it('works without eventBus and endpoint', async () => {
      setupMic();
      const m = new AudioManager({ config: mockConfig, logger: mLog });
      await m.initialize();

      const id = await m.startMicrophone({ streamId: 'no-deps' });
      expect(id).toBe('no-deps');
    });

    it('generates streamId when not provided', async () => {
      setupMic();
      const m = new AudioManager({ eventBus: { emit: jest.fn() }, endpoint: { connection: { send: jest.fn() } }, config: mockConfig });
      await m.initialize();

      const id = await m.startMicrophone();
      expect(id).toMatch(/^stream-\d+$/);
    });

    it('uses webkitAudioContext when AudioContext unavailable', async () => {
      const trk = { stop: jest.fn() };
      global.navigator = {
        mediaDevices: { getUserMedia: jest.fn().mockResolvedValue({ getTracks: () => [trk], active: true }) },
      };
      delete globalThis.AudioContext;
      scriptNode = { onaudioprocess: null, connect: jest.fn() };
      globalThis.webkitAudioContext = jest.fn().mockReturnValue({
        sampleRate: 48000, state: 'running',
        createMediaStreamSource: jest.fn().mockReturnValue({ connect: jest.fn() }),
        createAnalyser: jest.fn().mockReturnValue({ fftSize: 2048, connect: jest.fn() }),
        createScriptProcessor: jest.fn().mockReturnValue(scriptNode),
        destination: {},
      });

      const m = new AudioManager({ eventBus: { emit: jest.fn() }, endpoint: { connection: { send: jest.fn() } }, config: mockConfig });
      await m.initialize();
      const id = await m.startMicrophone({ streamId: 'webkit-1' });
      expect(globalThis.webkitAudioContext).toHaveBeenCalledTimes(1);
      expect(id).toBe('webkit-1');
    });
  });

  // =========================================================================
  // Additional branch coverage — stopMicrophone
  // =========================================================================

  describe('stopMicrophone — additional edges', () => {
    it('error path throws and logs', async () => {
      const mLog = { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      const m = new AudioManager({ eventBus: { emit: jest.fn() }, endpoint: { connection: { send: jest.fn() } }, config: mockConfig, logger: mLog });
      m._currentStreamId = 's1';
      mockStreamService.stopStream.mockImplementationOnce(() => { throw new Error('stop fail'); });

      await expect(m.stopMicrophone()).rejects.toThrow('stop fail');
      expect(mLog.error).toHaveBeenCalledWith('stopMicrophone failed', expect.any(Object));
    });

    it('skips event emit without eventBus', async () => {
      const m = createManager({ eventBus: null });
      m._currentStreamId = 's1';
      await m.stopMicrophone();
      expect(mockStreamService.stopStream).toHaveBeenCalledWith('s1');
    });

    it('skips endpoint send without endpoint', async () => {
      const m = createManager({ endpoint: null });
      m._currentStreamId = 's1';
      await m.stopMicrophone();
      expect(mockStreamService.stopStream).toHaveBeenCalledWith('s1');
    });
  });

  // =========================================================================
  // Additional branch coverage — _handleAudioData
  // =========================================================================

  describe('_handleAudioData — additional edges', () => {
    it('skips chunk-sent emit without eventBus', async () => {
      const m = createManager({ eventBus: null });
      const blob = { arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(100)) };
      await m._handleAudioData('s1', blob);
      expect(m.endpoint.streamAudio).toHaveBeenCalledTimes(1);
    });

    it('skips error emit without eventBus', async () => {
      const mLog = { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      const m = new AudioManager({ endpoint: { streamAudio: jest.fn() }, config: mockConfig, logger: mLog });
      const blob = { arrayBuffer: jest.fn().mockRejectedValue(new Error('fail')) };
      await m._handleAudioData('s1', blob);
      expect(mLog.error).toHaveBeenCalledWith('error handling audio data', expect.objectContaining({ error: 'fail' }));
    });

    it('skips send when endpoint null but stream active', async () => {
      const m = createManager({ endpoint: null });
      const blob = { arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(100)) };
      await m._handleAudioData('s1', blob);
      // No error, no streamAudio call
    });
  });

  // =========================================================================
  // Additional branch coverage — _handleRawPCM error
  // =========================================================================

  describe('_handleRawPCM — error path', () => {
    beforeEach(() => {
      global.btoa = jest.fn(s => Buffer.from(s, 'binary').toString('base64'));
    });
    afterEach(() => { delete global.btoa; });

    it('emits error event on send failure', async () => {
      const m = createManager();
      m.endpoint.connection.send = jest.fn(() => { throw new Error('send fail'); });
      await m._handleRawPCM('s1', new Int16Array([1]).buffer, 16000);
      expect(m.eventBus.emit).toHaveBeenCalledWith('audio:error', expect.objectContaining({ streamId: 's1' }));
    });

    it('logs without eventBus on error', async () => {
      const mLog = { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      const m = new AudioManager({ endpoint: { connection: { send: jest.fn(() => { throw new Error('fail'); }) } }, config: mockConfig, logger: mLog });
      await m._handleRawPCM('s1', new Int16Array([1]).buffer, 16000);
      expect(mLog.error).toHaveBeenCalledWith('error handling raw PCM', expect.any(Object));
    });
  });

  // =========================================================================
  // Additional branch coverage — _startVisualization
  // =========================================================================

  describe('_startVisualization — additional edges', () => {
    it('returns early when stream becomes inactive in callback', () => {
      const mockAnalyser = { frequencyBinCount: 4, getByteFrequencyData: jest.fn() };
      mockStreamService.getStream.mockReturnValueOnce({ getAnalyser: () => mockAnalyser });
      mockStreamService.isStreamActive.mockReturnValueOnce(false);

      am._startVisualization('s1');
      expect(mockAnalyser.getByteFrequencyData).not.toHaveBeenCalled();
      expect(global.requestAnimationFrame).not.toHaveBeenCalled();
    });

    it('runs without eventBus', () => {
      const m = createManager({ eventBus: null });
      const mockAnalyser = { frequencyBinCount: 4, getByteFrequencyData: jest.fn() };
      mockStreamService.getStream.mockReturnValueOnce({ getAnalyser: () => mockAnalyser });
      mockStreamService.isStreamActive.mockReturnValueOnce(true);

      m._startVisualization('s1');
      expect(mockAnalyser.getByteFrequencyData).toHaveBeenCalledTimes(1);
      expect(global.requestAnimationFrame).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Additional branch coverage — handleTTSAudio
  // =========================================================================

  describe('handleTTSAudio — additional edges', () => {
    it('does not auto-play when autoPlay disabled', async () => {
      const orig = mockConfig.tts.autoPlay;
      mockConfig.tts.autoPlay = false;
      const spy = jest.spyOn(am, 'playNextTTS');

      await am.handleTTSAudio(new ArrayBuffer(10));
      expect(mockTTSService.enqueue).toHaveBeenCalledTimes(1);
      expect(spy).not.toHaveBeenCalled();

      mockConfig.tts.autoPlay = orig;
      spy.mockRestore();
    });

    it('does not auto-play when already playing', async () => {
      mockTTSService.isPlaying.mockReturnValue(true);
      const spy = jest.spyOn(am, 'playNextTTS');

      await am.handleTTSAudio(new ArrayBuffer(10));
      expect(spy).not.toHaveBeenCalled();

      mockTTSService.isPlaying.mockReturnValue(false);
      spy.mockRestore();
    });

    it('works without eventBus', async () => {
      const m = createManager({ eventBus: null });
      await m.handleTTSAudio(new ArrayBuffer(10));
      expect(mockTTSService.enqueue).toHaveBeenCalledTimes(1);
    });

    it('error without eventBus does not throw', async () => {
      const m = createManager({ eventBus: null });
      mockTTSService.enqueue.mockImplementationOnce(() => { throw new Error('boom'); });
      await expect(m.handleTTSAudio(new ArrayBuffer(10))).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // Additional branch coverage — playNextTTS callbacks
  // =========================================================================

  describe('playNextTTS — monitorTTSLevel & onended callbacks', () => {
    function setupTTS(format = 'pcm16') {
      const audio = {
        id: 'tts-cb', format, sampleRate: 24000,
        getArrayBuffer: () => new Int16Array([100, -100, 50]).buffer,
        setDecodedBuffer: jest.fn(),
      };
      mockTTSService.dequeue.mockReturnValueOnce(audio);

      const analyser = { fftSize: 256, frequencyBinCount: 128, connect: jest.fn(), getByteFrequencyData: jest.fn() };
      const src = { buffer: null, connect: jest.fn(), start: jest.fn(), onended: null };
      const audioBuf = { getChannelData: jest.fn().mockReturnValue(new Float32Array(3)) };
      const ctx = {
        state: 'running',
        createBufferSource: jest.fn().mockReturnValue(src),
        createAnalyser: jest.fn().mockReturnValue(analyser),
        createGain: jest.fn().mockReturnValue({ gain: { value: 1 }, connect: jest.fn() }),
        createBuffer: jest.fn().mockReturnValue(audioBuf),
        destination: {},
        close: jest.fn().mockResolvedValue(undefined),
      };
      globalThis.AudioContext = jest.fn().mockReturnValue(ctx);
      return { audio, analyser, src, ctx };
    }

    afterEach(() => {
      delete globalThis.AudioContext;
      delete globalThis.webkitAudioContext;
      delete globalThis.guru;
      mockConfig.tts.queueEnabled = true;
      mockConfig.tts.volume = 1.0;
    });

    it('monitorTTSLevel emits level events when playing', async () => {
      const { analyser } = setupTTS();
      mockTTSService.isPlaying
        .mockReturnValueOnce(false)   // playNextTTS guard
        .mockReturnValueOnce(true)    // first monitor: process
        .mockReturnValue(false);      // second monitor: stop
      global.requestAnimationFrame = jest.fn((cb) => { cb(); return 42; });

      await am.playNextTTS();

      expect(analyser.getByteFrequencyData).toHaveBeenCalledTimes(1);
      expect(am.eventBus.emit).toHaveBeenCalledWith('audio:level-updated', expect.objectContaining({
        streamId: 'tts-playback', source: 'tts',
      }));
    });

    it('monitorTTSLevel updates guru state when present', async () => {
      setupTTS();
      globalThis.guru = { state: { audioLevel: 0 } };
      mockTTSService.isPlaying
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true)
        .mockReturnValue(false);
      global.requestAnimationFrame = jest.fn((cb) => { cb(); return 42; });

      await am.playNextTTS();
      expect(typeof globalThis.guru.state.audioLevel).toBe('number');
    });

    it('source.onended completes playback and closes context', async () => {
      const { audio, src, ctx } = setupTTS();
      mockTTSService.isPlaying.mockReturnValue(false);
      mockConfig.tts.queueEnabled = false;

      await am.playNextTTS();
      expect(src.onended).toBeInstanceOf(Function);

      src.onended();
      expect(mockTTSService.completePlayback).toHaveBeenCalledWith(audio);
      expect(am.eventBus.emit).toHaveBeenCalledWith('audio:tts-completed', { audioId: 'tts-cb' });

      await new Promise(r => setTimeout(r, 20));
      expect(ctx.close).toHaveBeenCalledTimes(1);
    });

    it('source.onended logs warning on close failure', async () => {
      const mLog = { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      const m = new AudioManager({ eventBus: { emit: jest.fn() }, config: mockConfig, logger: mLog });
      const { src, ctx } = setupTTS();
      ctx.close.mockRejectedValueOnce(new Error('close fail'));
      mockTTSService.isPlaying.mockReturnValue(false);
      mockConfig.tts.queueEnabled = false;

      await m.playNextTTS();
      src.onended();

      await new Promise(r => setTimeout(r, 20));
      expect(mLog.warn).toHaveBeenCalledWith('playNextTTS cleanup failed', expect.any(Object));
    });

    it('source.onended continues queue when enabled', async () => {
      const { src } = setupTTS();
      mockTTSService.isPlaying.mockReturnValue(false);
      mockConfig.tts.queueEnabled = true;
      // Recursive playNextTTS call finds empty queue
      mockTTSService.dequeue.mockReturnValueOnce(null);

      await am.playNextTTS();
      src.onended();

      await new Promise(r => setTimeout(r, 20));
      expect(am.eventBus.emit).toHaveBeenCalledWith('audio:tts-queue-empty');
    });

    it('source.onended skips close when context already closed', async () => {
      const { src, ctx } = setupTTS();
      ctx.state = 'closed';
      mockTTSService.isPlaying.mockReturnValue(false);
      mockConfig.tts.queueEnabled = false;

      await am.playNextTTS();
      src.onended();

      await new Promise(r => setTimeout(r, 20));
      expect(ctx.close).not.toHaveBeenCalled();
    });

    it('error path with audioContext.close failure logs warning', async () => {
      const mLog = { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      const m = new AudioManager({ eventBus: { emit: jest.fn() }, config: mockConfig, logger: mLog });
      const audio = { id: 'tts-cf', format: 'wav', getArrayBuffer: () => new ArrayBuffer(10), setDecodedBuffer: jest.fn() };
      mockTTSService.dequeue.mockReturnValueOnce(audio);

      const ctx = {
        state: 'running', createBufferSource: jest.fn(), createAnalyser: jest.fn(),
        decodeAudioData: jest.fn().mockRejectedValue(new Error('decode')),
        destination: {}, close: jest.fn().mockRejectedValue(new Error('close also fails')),
      };
      globalThis.AudioContext = jest.fn().mockReturnValue(ctx);
      mockTTSService.isPlaying.mockReturnValue(false);
      mockConfig.tts.queueEnabled = false;

      await m.playNextTTS();

      expect(mLog.error).toHaveBeenCalledWith('error playing TTS audio', expect.any(Object));
      expect(mLog.warn).toHaveBeenCalledWith('playNextTTS close failed', expect.any(Object));
    });

    it('error path continues queue when enabled', async () => {
      const audio = { id: 'tts-eq', format: 'wav', getArrayBuffer: () => new ArrayBuffer(10), setDecodedBuffer: jest.fn() };
      mockTTSService.dequeue
        .mockReturnValueOnce(audio)
        .mockReturnValueOnce(null); // recursive: empty

      const ctx = {
        state: 'running', createBufferSource: jest.fn(), createAnalyser: jest.fn(),
        decodeAudioData: jest.fn().mockRejectedValue(new Error('decode')),
        destination: {}, close: jest.fn().mockResolvedValue(undefined),
      };
      globalThis.AudioContext = jest.fn().mockReturnValue(ctx);
      mockTTSService.isPlaying.mockReturnValue(false);
      mockConfig.tts.queueEnabled = true;

      await am.playNextTTS();
      expect(am.eventBus.emit).toHaveBeenCalledWith('audio:tts-queue-empty');
    });

    it('error path skips close when context already closed', async () => {
      const audio = { id: 'tts-cc', format: 'wav', getArrayBuffer: () => new ArrayBuffer(10), setDecodedBuffer: jest.fn() };
      mockTTSService.dequeue.mockReturnValueOnce(audio);

      const ctx = {
        state: 'closed', createBufferSource: jest.fn(), createAnalyser: jest.fn(),
        decodeAudioData: jest.fn().mockRejectedValue(new Error('decode')),
        destination: {}, close: jest.fn(),
      };
      globalThis.AudioContext = jest.fn().mockReturnValue(ctx);
      mockTTSService.isPlaying.mockReturnValue(false);
      mockConfig.tts.queueEnabled = false;

      await am.playNextTTS();
      expect(ctx.close).not.toHaveBeenCalled();
    });

    it('error path with no eventBus', async () => {
      const audio = { id: 'tts-ne', format: 'wav', getArrayBuffer: () => new ArrayBuffer(10), setDecodedBuffer: jest.fn() };
      mockTTSService.dequeue.mockReturnValueOnce(audio);

      const ctx = {
        state: 'running', createBufferSource: jest.fn(), createAnalyser: jest.fn(),
        decodeAudioData: jest.fn().mockRejectedValue(new Error('decode')),
        destination: {}, close: jest.fn().mockResolvedValue(undefined),
      };
      globalThis.AudioContext = jest.fn().mockReturnValue(ctx);
      mockTTSService.isPlaying.mockReturnValue(false);
      mockConfig.tts.queueEnabled = false;

      const m = createManager({ eventBus: null });
      await m.playNextTTS();
      expect(mockTTSService.failPlayback).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tts-ne' }),
        expect.any(Error)
      );
    });

    it('pcm format uses default sampleRate 24000', async () => {
      const audio = {
        id: 'tts-pcm2', format: 'pcm', sampleRate: undefined,
        getArrayBuffer: () => new Int16Array([1]).buffer,
        setDecodedBuffer: jest.fn(),
      };
      mockTTSService.dequeue.mockReturnValueOnce(audio);

      const audioBuf = { getChannelData: jest.fn().mockReturnValue(new Float32Array(1)) };
      const analyser = { fftSize: 256, frequencyBinCount: 128, connect: jest.fn(), getByteFrequencyData: jest.fn() };
      const src = { buffer: null, connect: jest.fn(), start: jest.fn(), onended: null };
      const ctx = {
        state: 'running',
        createBufferSource: jest.fn().mockReturnValue(src),
        createAnalyser: jest.fn().mockReturnValue(analyser),
        createGain: jest.fn(),
        createBuffer: jest.fn().mockReturnValue(audioBuf),
        destination: {},
        close: jest.fn().mockResolvedValue(undefined),
      };
      globalThis.AudioContext = jest.fn().mockReturnValue(ctx);
      mockTTSService.isPlaying.mockReturnValue(false);

      await am.playNextTTS();
      // createBuffer called with (channels=1, length=1, sampleRate=24000)
      expect(ctx.createBuffer).toHaveBeenCalledWith(1, 1, 24000);
      expect(src.start).toHaveBeenCalledWith(0);
    });

    it('webkitAudioContext fallback in playNextTTS', async () => {
      const audio = {
        id: 'tts-wk', format: 'pcm16', sampleRate: 24000,
        getArrayBuffer: () => new Int16Array([1]).buffer,
        setDecodedBuffer: jest.fn(),
      };
      mockTTSService.dequeue.mockReturnValueOnce(audio);
      delete globalThis.AudioContext;

      const audioBuf = { getChannelData: jest.fn().mockReturnValue(new Float32Array(1)) };
      const analyser = { fftSize: 256, frequencyBinCount: 128, connect: jest.fn(), getByteFrequencyData: jest.fn() };
      const src = { buffer: null, connect: jest.fn(), start: jest.fn(), onended: null };
      globalThis.webkitAudioContext = jest.fn().mockReturnValue({
        state: 'running',
        createBufferSource: jest.fn().mockReturnValue(src),
        createAnalyser: jest.fn().mockReturnValue(analyser),
        createGain: jest.fn(),
        createBuffer: jest.fn().mockReturnValue(audioBuf),
        destination: {},
        close: jest.fn().mockResolvedValue(undefined),
      });
      mockTTSService.isPlaying.mockReturnValue(false);

      await am.playNextTTS();
      expect(globalThis.webkitAudioContext).toHaveBeenCalledTimes(1);
      expect(src.start).toHaveBeenCalledWith(0);
    });

    it('source.onended queue error logs but does not throw', async () => {
      const mLog = { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      const m = new AudioManager({ eventBus: { emit: jest.fn() }, config: mockConfig, logger: mLog });

      const { src, ctx } = setupTTS();
      mockTTSService.isPlaying.mockReturnValue(false);
      mockConfig.tts.queueEnabled = true;
      // Make recursive playNextTTS throw
      mockTTSService.dequeue.mockReturnValueOnce(null);

      await m.playNextTTS();

      // Mock playNextTTS to reject on next call
      const origPlay = m.playNextTTS.bind(m);
      jest.spyOn(m, 'playNextTTS').mockRejectedValueOnce(new Error('queue fail'));

      src.onended();
      await new Promise(r => setTimeout(r, 20));
      expect(mLog.error).toHaveBeenCalledWith('playNextTTS queue error', expect.any(Object));
      m.playNextTTS.mockRestore();
    });
  });

  // =========================================================================
  // Additional branch coverage — updateConfig / STT / TTS without eventBus
  // =========================================================================

  describe('miscellaneous null-guard branches', () => {
    it('updateConfig without eventBus applies config change silently', () => {
      const m = createManager({ eventBus: null });
      m.updateConfig({ microphone: { sampleRate: 44100 } });
      expect(mockConfig.updateMicrophone).toHaveBeenCalledWith({ sampleRate: 44100 });
    });

    it('updateConfig with no applicable keys does nothing', () => {
      am.updateConfig({});
      expect(mockConfig.updateMicrophone).not.toHaveBeenCalled();
      expect(mockConfig.updateTTS).not.toHaveBeenCalled();
      expect(mockConfig.updateGeneral).not.toHaveBeenCalled();
    });

    it('handleSTTPartial without eventBus processes partial silently', () => {
      const m = createManager({ eventBus: null });
      m.handleSTTPartial('s1', 'hi');
      expect(mockSTTService.processPartial).toHaveBeenCalledWith('s1', 'hi', {});
    });

    it('handleSTTFinal without eventBus processes final silently', () => {
      const m = createManager({ eventBus: null });
      m.handleSTTFinal('s1', 'hi');
      expect(mockSTTService.processFinal).toHaveBeenCalledWith('s1', 'hi', {});
    });

    it('clearTTSQueue without eventBus clears queue silently', () => {
      const m = createManager({ eventBus: null });
      m.clearTTSQueue();
      expect(mockTTSService.clearQueue).toHaveBeenCalledTimes(1);
    });

    it('stopTTS without eventBus stops playback silently', () => {
      const m = createManager({ eventBus: null });
      mockTTSService.stopCurrent.mockReturnValueOnce({ id: 'x' });
      m.stopTTS();
      expect(mockTTSService.stopCurrent).toHaveBeenCalledTimes(1);
    });

    it('checkMicrophoneAvailability — mediaDevices present but getUserMedia missing', async () => {
      global.navigator = { mediaDevices: {} };
      const result = await am.checkMicrophoneAvailability();
      expect(result).toBe(false);
      delete global.navigator;
    });

    it('playNextTTS — no eventBus for queue-empty', async () => {
      const m = createManager({ eventBus: null });
      mockTTSService.dequeue.mockReturnValueOnce(null);
      await m.playNextTTS();
      // No throw, just returns
    });

    it('playNextTTS — no eventBus for tts-started', async () => {
      // Explicit reset to avoid stale mockReturnValueOnce queue from prior tests
      mockTTSService.isPlaying.mockReset();
      mockTTSService.dequeue.mockReset();
      mockTTSService.startPlayback.mockReset();
      mockTTSService.isPlaying.mockReturnValue(false);

      const audio = {
        id: 'tts-neb', format: 'pcm16', sampleRate: 24000,
        getArrayBuffer: () => new Int16Array([1]).buffer,
        setDecodedBuffer: jest.fn(),
      };
      mockTTSService.dequeue.mockReturnValueOnce(audio);

      const audioBuf = { getChannelData: jest.fn().mockReturnValue(new Float32Array(1)) };
      const analyser = { fftSize: 256, frequencyBinCount: 128, connect: jest.fn(), getByteFrequencyData: jest.fn() };
      const src = { buffer: null, connect: jest.fn(), start: jest.fn(), onended: null };
      const ctx = {
        state: 'running',
        createBufferSource: jest.fn().mockReturnValue(src),
        createAnalyser: jest.fn().mockReturnValue(analyser),
        createGain: jest.fn(),
        createBuffer: jest.fn().mockReturnValue(audioBuf),
        destination: {},
        close: jest.fn().mockResolvedValue(undefined),
      };
      globalThis.AudioContext = jest.fn(() => ctx);

      const mLog = { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      const m = new AudioManager({ config: mockConfig, logger: mLog });
      await m.playNextTTS();

      // Verify no error was caught silently
      expect(mockTTSService.failPlayback).not.toHaveBeenCalled();
      expect(globalThis.AudioContext).toHaveBeenCalledTimes(1);
      expect(ctx.createBufferSource).toHaveBeenCalledTimes(1);
      expect(src.start).toHaveBeenCalledWith(0);
      delete globalThis.AudioContext;
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // OFFENSIVE TESTS — These expose real bugs found via adversarial source reading.
  // Each test MUST FAIL if the corresponding fix is reverted.
  // ──────────────────────────────────────────────────────────────────────────

  describe('Bug: stopTTS does not actually stop audio output', () => {
    /*
     * Root cause: source (AudioBufferSourceNode) and audioContext were local
     * variables in playNextTTS(), unreachable from stopTTS(). Calling stopTTS()
     * only updated TTSService state (_isPlaying = false) but the audio kept
     * playing. When the buffer finished, onended fired → playNextTTS() started
     * the NEXT queued audio. User said "stop" but heard MORE audio.
     *
     * Fix: AudioManager now tracks _ttsSource and _ttsAudioContext on the
     * instance. stopTTS() calls source.stop() and audioContext.close().
     * onended checks _ttsStoppedByUser to skip queue continuation.
     */

    let ctx, src, analyser, m;

    function setupTTSPlayback() {
      const audio = {
        id: 'tts-1', format: 'pcm16', sampleRate: 24000,
        getArrayBuffer: () => new Int16Array([100]).buffer,
        setDecodedBuffer: jest.fn(), status: 'pending',
      };
      mockTTSService.isPlaying.mockReturnValue(false);
      mockTTSService.dequeue.mockReturnValueOnce(audio);

      const audioBuf = { getChannelData: jest.fn().mockReturnValue(new Float32Array(1)) };
      analyser = {
        fftSize: 256, frequencyBinCount: 128,
        connect: jest.fn(), getByteFrequencyData: jest.fn(),
      };
      src = {
        buffer: null, connect: jest.fn(), start: jest.fn(), onended: null,
        stop: jest.fn(),
      };
      ctx = {
        state: 'running',
        createBufferSource: jest.fn().mockReturnValue(src),
        createAnalyser: jest.fn().mockReturnValue(analyser),
        createGain: jest.fn(),
        createBuffer: jest.fn().mockReturnValue(audioBuf),
        destination: {},
        close: jest.fn().mockResolvedValue(undefined),
      };
      globalThis.AudioContext = jest.fn(() => ctx);

      const localEventBus = { emit: jest.fn(), on: jest.fn() };
      m = new AudioManager({
        config: mockConfig,
        eventBus: localEventBus,
        logger: { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      });

      return audio;
    }

    afterEach(() => { delete globalThis.AudioContext; });

    it('stopTTS calls source.stop() on the AudioBufferSourceNode', async () => {
      setupTTSPlayback();
      await m.playNextTTS();
      expect(src.start).toHaveBeenCalledWith(0);

      // Now stop — this MUST actually stop the audio output
      m.stopTTS();

      expect(src.stop).toHaveBeenCalledTimes(1);
    });

    it('stopTTS closes the AudioContext to release hardware resources', async () => {
      setupTTSPlayback();
      await m.playNextTTS();

      m.stopTTS();

      expect(ctx.close).toHaveBeenCalledTimes(1);
    });

    it('onended does NOT start next queued audio after user stop', async () => {
      const audio = setupTTSPlayback();
      mockConfig.tts.queueEnabled = true;
      await m.playNextTTS();

      // User stops TTS
      m.stopTTS();

      // Simulate onended firing (browser fires this after source.stop())
      expect(src.onended).toBeInstanceOf(Function);
      src.onended();

      // Allow microtask chain in onended to complete
      await new Promise(r => setTimeout(r, 10));

      // playNextTTS should NOT have been called again for queue continuation
      // dequeue was called once (the initial playback) — not a second time
      expect(mockTTSService.dequeue).toHaveBeenCalledTimes(1);
    });

    it('onended DOES continue queue for natural playback completion', async () => {
      const audio = setupTTSPlayback();
      mockConfig.tts.queueEnabled = true;
      // Second dequeue returns null (queue empty) — no infinite recursion
      mockTTSService.dequeue.mockReturnValueOnce(null);
      await m.playNextTTS();

      // Natural completion — user did NOT call stopTTS
      expect(src.onended).toBeInstanceOf(Function);
      src.onended();

      await new Promise(r => setTimeout(r, 10));

      // Queue continuation should have called dequeue again (returned null → queue-empty event)
      expect(mockTTSService.dequeue).toHaveBeenCalledTimes(2);
    });

    it('cleanup() stops TTS source and closes context', async () => {
      setupTTSPlayback();
      await m.playNextTTS();

      m.cleanup();

      expect(src.stop).toHaveBeenCalledTimes(1);
      expect(ctx.close).toHaveBeenCalledTimes(1);
    });
  });
});
