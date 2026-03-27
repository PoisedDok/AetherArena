'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = {
  info: () => {},
  warn: jest.fn(),
  error: jest.fn(),
  debug: () => {},
  trace: () => {},
};

const mockAether = {
  chat: {
    streamUserInput: jest.fn(),
    sendMessage: jest.fn(),
  },
};

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

jest.mock('../../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: () => mockAether,
}));

// ---------------------------------------------------------------------------
// Web Audio API mocks
// ---------------------------------------------------------------------------

function createMockStream() {
  const track = { stop: jest.fn() };
  return { getTracks: jest.fn(() => [track]), _track: track };
}

function createMockAnalyser() {
  return {
    fftSize: 0,
    frequencyBinCount: 128,
    getByteFrequencyData: jest.fn((arr) => {
      // Fill with some audio data
      for (let i = 0; i < arr.length; i++) arr[i] = 64;
    }),
  };
}

function createMockAudioContext() {
  const analyser = createMockAnalyser();
  const source = { connect: jest.fn() };
  return {
    createMediaStreamSource: jest.fn(() => source),
    createAnalyser: jest.fn(() => analyser),
    close: jest.fn(),
    _analyser: analyser,
    _source: source,
  };
}

function createMockMediaRecorder() {
  const instance = {
    start: jest.fn(),
    stop: jest.fn(),
    state: 'inactive',
    ondataavailable: null,
    onerror: null,
  };
  return instance;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEndpoint() {
  return {
    connection: { send: jest.fn() },
  };
}

function createMockGuru() {
  const listeners = {};
  return {
    on: jest.fn((event, handler) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    off: jest.fn((event, handler) => {
      if (listeners[event]) {
        const idx = listeners[event].indexOf(handler);
        if (idx >= 0) listeners[event].splice(idx, 1);
      }
    }),
    emit: jest.fn(),
    state: { audioLevel: 0 },
    _listeners: listeners,
    _trigger(event, data) {
      if (listeners[event]) {
        listeners[event].forEach((h) => h(data));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HandsFreeMicManager', () => {
  let HandsFreeMicManager;
  let mockAudioContext;
  let originalNavigator;

  beforeEach(() => {
    jest.useFakeTimers();
    document.body.innerHTML = '<button id="mic-toggle"></button>';

    // Re-establish mock fns after resetMocks
    mockLog.warn = jest.fn();
    mockLog.error = jest.fn();
    mockAether.chat = {
      streamUserInput: jest.fn(),
      sendMessage: jest.fn(),
    };

    // Mock AudioContext globally
    mockAudioContext = createMockAudioContext();
    global.AudioContext = jest.fn(() => mockAudioContext);

    // Mock MediaRecorder globally
    global.MediaRecorder = jest.fn(() => createMockMediaRecorder());

    // Mock getUserMedia
    global.navigator.mediaDevices = {
      getUserMedia: jest.fn().mockResolvedValue(createMockStream()),
    };

    // Mock FileReader
    global.FileReader = jest.fn(() => ({
      readAsDataURL: jest.fn(function () {
        this.result = 'data:audio/webm;base64,dGVzdA==';
        if (this.onloadend) this.onloadend();
      }),
      onloadend: null,
      onerror: null,
    }));

    HandsFreeMicManager = require('../../../../src/renderer/main/modules/audio/HandsFreeMicManager');
  });

  afterEach(() => {
    jest.useRealTimers();
    document.body.innerHTML = '';
    delete global.AudioContext;
    delete global.MediaRecorder;
    delete global.FileReader;
    delete window.__eventBus;
    delete window.audioManager;
  });

  // ── Constructor ─────────────────────────────────────────

  describe('constructor', () => {
    test('throws if endpoint not provided', () => {
      expect(() => new HandsFreeMicManager(null, {}))
        .toThrow('[HandsFreeMicManager] endpoint required');
    });

    test('throws if guruConnection not provided', () => {
      expect(() => new HandsFreeMicManager({}, null))
        .toThrow('[HandsFreeMicManager] guruConnection required');
    });

    test('initializes with correct default state', () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);

      expect(mgr.endpoint).toBe(endpoint);
      expect(mgr.guru).toBe(guru);
      expect(mgr.isActive).toBe(false);
      expect(mgr._isDisposed).toBe(false);
      expect(mgr.mediaRecorder).toBeNull();
      expect(mgr.audioChunks).toEqual([]);
      expect(mgr.currentStream).toBeNull();
      expect(mgr.analyser).toBeNull();
      expect(mgr.audioContext).toBeNull();
      expect(mgr.audioLevelUpdateInterval).toBeNull();
      expect(mgr.transcriptionBuffer).toBe('');
    });

    test('binds event handler methods', () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);

      expect(typeof mgr._boundHandleSttPartial).toBe('function');
      expect(typeof mgr._boundHandleSttFinal).toBe('function');
      expect(typeof mgr._boundHandleTtsAudio).toBe('function');
      expect(typeof mgr._boundToggle).toBe('function');
    });
  });

  // ── init() ──────────────────────────────────────────────

  describe('init()', () => {
    test('registers click listener on mic-toggle element', () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);

      const el = document.getElementById('mic-toggle');
      const addSpy = jest.spyOn(el, 'addEventListener');

      mgr.init();

      expect(addSpy).toHaveBeenCalledWith('click', mgr._boundToggle);
    });

    test('handles missing mic-toggle element', () => {
      document.body.innerHTML = '';
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);

      expect(() => mgr.init()).not.toThrow();
      expect(mgr.micToggleEl).toBeNull();
    });

    test('registers guru event listeners', () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);

      mgr.init();

      expect(guru.on).toHaveBeenCalledWith('stt-partial', mgr._boundHandleSttPartial);
      expect(guru.on).toHaveBeenCalledWith('stt-final', mgr._boundHandleSttFinal);
      expect(guru.on).toHaveBeenCalledWith('tts-audio', mgr._boundHandleTtsAudio);
    });
  });

  // ── toggle() ────────────────────────────────────────────

  describe('toggle()', () => {
    test('calls start() when not active', async () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);
      mgr.start = jest.fn();

      mgr.toggle();

      expect(mgr.start).toHaveBeenCalled();
    });

    test('calls stop() when active', () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);
      mgr.isActive = true;
      mgr.stop = jest.fn();

      mgr.toggle();

      expect(mgr.stop).toHaveBeenCalled();
    });
  });

  // ── start() ─────────────────────────────────────────────

  describe('start()', () => {
    test('acquires mic, sets up audio monitoring and media recorder', async () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);
      mgr.init();

      await mgr.start();

      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      expect(mgr.isActive).toBe(true);
      expect(mgr.currentStream).toBeDefined();
      expect(mgr.audioContext).toBeDefined();
      expect(mgr.mediaRecorder).toBeDefined();
    });

    test('returns early if already active', async () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);
      mgr.isActive = true;

      await mgr.start();

      expect(mockLog.warn).toHaveBeenCalledWith('[HandsFreeMicManager] Already active');
      expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    });

    test('sends start marker via connection', async () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);
      mgr.init();

      await mgr.start();

      expect(endpoint.connection.send).toHaveBeenCalledWith(
        expect.stringContaining('"start":true')
      );
    });

    test('emits listening status to guru', async () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);
      mgr.init();

      await mgr.start();

      expect(guru.emit).toHaveBeenCalledWith('status', 'listening');
    });

    test('handles getUserMedia failure gracefully', async () => {
      navigator.mediaDevices.getUserMedia = jest.fn().mockRejectedValue(
        new Error('Permission denied')
      );

      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);

      await mgr.start();

      expect(mockLog.error).toHaveBeenCalledWith(
        '[HandsFreeMicManager] Failed to start:',
        expect.any(Error)
      );
      expect(mgr.isActive).toBe(false);
    });
  });

  // ── stop() ──────────────────────────────────────────────

  describe('stop()', () => {
    test('returns early if not active', () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);

      mgr.stop();

      expect(guru.emit).not.toHaveBeenCalled();
    });

    test('stops media recorder and stream tracks', async () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);
      mgr.init();

      await mgr.start();

      const stream = mgr.currentStream;
      const track = stream.getTracks()[0];

      mgr.stop();

      expect(mgr.isActive).toBe(false);
      expect(track.stop).toHaveBeenCalled();
      expect(mgr.currentStream).toBeNull();
    });

    test('clears audio level interval', async () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);
      mgr.init();

      await mgr.start();

      expect(mgr.audioLevelUpdateInterval).not.toBeNull();

      mgr.stop();

      expect(mgr.audioLevelUpdateInterval).toBeNull();
    });

    test('closes audio context', async () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);
      mgr.init();

      await mgr.start();

      mgr.stop();

      expect(mockAudioContext.close).toHaveBeenCalled();
      expect(mgr.audioContext).toBeNull();
    });

    test('sends end marker via connection', async () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);
      mgr.init();

      await mgr.start();
      endpoint.connection.send.mockClear();

      mgr.stop();

      expect(endpoint.connection.send).toHaveBeenCalledWith(
        expect.stringContaining('"end":true')
      );
    });

    test('flushes transcription buffer to chat on stop', async () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);
      mgr.init();

      await mgr.start();
      mgr.transcriptionBuffer = 'Hello world ';

      mgr.stop();

      expect(mockAether.chat.sendMessage).toHaveBeenCalledWith({
        text: 'Hello world',
        source: 'handsfree-stt-complete',
      });
    });

    test('does NOT flush empty transcription buffer', async () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);
      mgr.init();

      await mgr.start();
      mgr.transcriptionBuffer = '   ';

      mgr.stop();

      expect(mockAether.chat.sendMessage).not.toHaveBeenCalled();
    });

    test('emits idle status to guru', async () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);
      mgr.init();

      await mgr.start();
      guru.emit.mockClear();

      mgr.stop();

      expect(guru.emit).toHaveBeenCalledWith('status', 'idle');
    });
  });

  // ── Audio monitoring ────────────────────────────────────

  describe('_setupAudioMonitoring', () => {
    test('audio level update interval writes normalized level to guru.state', async () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);
      mgr.init();

      await mgr.start();

      // Advance timer to trigger audio level update (50ms interval)
      jest.advanceTimersByTime(50);

      // The mock fills with 64, normalized = 64/255 ≈ 0.251
      expect(guru.state.audioLevel).toBeCloseTo(64 / 255, 2);
    });

    test('audio level interval self-clears when not active', async () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);
      mgr.init();

      await mgr.start();

      // Force isActive to false without calling stop()
      mgr.isActive = false;

      jest.advanceTimersByTime(50);

      expect(mgr.audioLevelUpdateInterval).toBeNull();
    });
  });

  // ── STT handlers ────────────────────────────────────────

  describe('_handleSttPartial()', () => {
    test('streams partial text to chat window when active', () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);
      mgr.isActive = true;

      mgr._handleSttPartial({ text: 'Hello wo' });

      expect(mockAether.chat.streamUserInput).toHaveBeenCalledWith({
        text: 'Hello wo',
        isFinal: false,
        source: 'handsfree-stt',
      });
    });

    test('ignores partial text when not active', () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);
      mgr.isActive = false;

      mgr._handleSttPartial({ text: 'Hello wo' });

      expect(mockAether.chat.streamUserInput).not.toHaveBeenCalled();
    });
  });

  describe('_handleSttFinal()', () => {
    test('appends text to transcription buffer and streams to chat', () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);
      mgr.isActive = true;

      mgr._handleSttFinal({ text: 'Hello world' });

      expect(mgr.transcriptionBuffer).toBe('Hello world ');
      expect(mockAether.chat.streamUserInput).toHaveBeenCalledWith({
        text: 'Hello world',
        isFinal: true,
        source: 'handsfree-stt',
      });
    });

    test('emits audio:stt-final to EventBus when available', () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);
      mgr.isActive = true;

      mockAether.eventBus = { emit: jest.fn() };

      mgr._handleSttFinal({ text: 'test sentence' });

      expect(mockAether.eventBus.emit).toHaveBeenCalledWith('audio:stt-final', {
        text: 'test sentence',
        timestamp: expect.any(Number),
      });
    });

    test('handles wake word sentinel — does NOT stream to chat', () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);
      mgr.isActive = true;

      mockAether.eventBus = { emit: jest.fn() };

      mgr._handleSttFinal({ text: '__WAKE_WORD_DETECTED__' });

      expect(mockAether.chat.streamUserInput).not.toHaveBeenCalled();
      expect(mgr.transcriptionBuffer).toBe('');
      expect(mockAether.eventBus.emit).toHaveBeenCalledWith(
        'handsfree:wake-word-detected',
        expect.objectContaining({ timestamp: expect.any(Number) })
      );
    });

    test('ignores final text when not active', () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);
      mgr.isActive = false;

      mgr._handleSttFinal({ text: 'Hello' });

      expect(mgr.transcriptionBuffer).toBe('');
    });
  });

  // ── TTS handler ─────────────────────────────────────────

  describe('_handleTtsAudio()', () => {
    test('delegates to window.audioManager.handleTTSAudio', () => {
      window.audioManager = { handleTTSAudio: jest.fn() };

      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);

      mgr._handleTtsAudio({ audio: 'base64data', format: 'wav' });

      expect(window.audioManager.handleTTSAudio).toHaveBeenCalledWith('base64data', 'wav');
    });

    test('defaults format to wav when not provided', () => {
      window.audioManager = { handleTTSAudio: jest.fn() };

      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);

      mgr._handleTtsAudio({ audio: 'base64data' });

      expect(window.audioManager.handleTTSAudio).toHaveBeenCalledWith('base64data', 'wav');
    });

    test('logs warning when audioManager not available', () => {
      delete window.audioManager;

      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);

      mgr._handleTtsAudio({ audio: 'base64data' });

      expect(mockLog.warn).toHaveBeenCalledWith(
        '[HandsFreeMicManager] AudioManager not available or missing audio data'
      );
    });

    test('logs warning when audio data missing', () => {
      window.audioManager = { handleTTSAudio: jest.fn() };

      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);

      mgr._handleTtsAudio({});

      expect(mockLog.warn).toHaveBeenCalledWith(
        '[HandsFreeMicManager] AudioManager not available or missing audio data'
      );
    });

    test('catches audioManager errors', () => {
      window.audioManager = {
        handleTTSAudio: jest.fn(() => { throw new Error('Playback fail'); }),
      };

      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);

      mgr._handleTtsAudio({ audio: 'base64data', format: 'wav' });

      expect(mockLog.error).toHaveBeenCalledWith(
        '[HandsFreeMicManager] Failed to handle TTS audio:',
        expect.any(Error)
      );
    });
  });

  // ── Send markers ────────────────────────────────────────

  describe('_sendStartMarker / _sendEndMarker', () => {
    test('sends JSON start marker', () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);

      mgr._sendStartMarker();

      const sent = JSON.parse(endpoint.connection.send.mock.calls[0][0]);
      expect(sent).toEqual({
        role: 'user',
        type: 'audio',
        audio: '',
        format: 'opus',
        start: true,
      });
    });

    test('sends JSON end marker', () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);

      mgr._sendEndMarker();

      const sent = JSON.parse(endpoint.connection.send.mock.calls[0][0]);
      expect(sent).toEqual({
        role: 'user',
        type: 'audio',
        audio: '',
        format: 'opus',
        end: true,
      });
    });

    test('handles missing connection gracefully', () => {
      const endpoint = { connection: null };
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);

      expect(() => mgr._sendStartMarker()).not.toThrow();
      expect(() => mgr._sendEndMarker()).not.toThrow();
    });

    test('catches connection.send errors', () => {
      const endpoint = {
        connection: { send: jest.fn(() => { throw new Error('Send fail'); }) },
      };
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);

      mgr._sendStartMarker();

      expect(mockLog.error).toHaveBeenCalledWith(
        '[HandsFreeMicManager] Failed to send start marker:',
        expect.any(Error)
      );
    });
  });

  // ── MediaRecorder callbacks ─────────────────────────────

  describe('MediaRecorder callbacks', () => {
    test('ondataavailable sends audio chunk when active and data present', async () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);
      mgr.init();

      await mgr.start();

      // Simulate data available event
      const blob = new Blob(['audio data'], { type: 'audio/webm' });
      mgr.mediaRecorder.ondataavailable({ data: blob });

      // The _sendAudioChunk is async (uses FileReader), but with our sync mock it resolves
      await Promise.resolve(); // flush microtasks

      expect(endpoint.connection.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"audio"')
      );
    });

    test('onerror stops recording and logs error', async () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);
      mgr.init();

      await mgr.start();

      mgr.mediaRecorder.onerror(new Error('Recorder error'));

      expect(mockLog.error).toHaveBeenCalledWith(
        '[HandsFreeMicManager] MediaRecorder error:',
        expect.any(Error)
      );
      expect(mgr.isActive).toBe(false);
    });
  });

  // ── dispose() ───────────────────────────────────────────

  describe('dispose()', () => {
    test('calls stop() and removes guru listeners', async () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);
      mgr.init();

      await mgr.start();

      mgr.dispose();

      expect(mgr.isActive).toBe(false);
      expect(guru.off).toHaveBeenCalledWith('stt-partial', mgr._boundHandleSttPartial);
      expect(guru.off).toHaveBeenCalledWith('stt-final', mgr._boundHandleSttFinal);
      expect(guru.off).toHaveBeenCalledWith('tts-audio', mgr._boundHandleTtsAudio);
    });

    test('removes mic toggle click listener', () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);
      mgr.init();

      const el = mgr.micToggleEl;
      const removeSpy = jest.spyOn(el, 'removeEventListener');

      mgr.dispose();

      expect(removeSpy).toHaveBeenCalledWith('click', mgr._boundToggle);
    });

    test('double-dispose is idempotent', async () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);
      mgr.init();

      await mgr.start();

      mgr.dispose();
      guru.off.mockClear();

      mgr.dispose();

      // guru.off should NOT be called again
      expect(guru.off).not.toHaveBeenCalled();
      expect(mgr._isDisposed).toBe(true);
    });

    test('handles dispose without init — no crash', () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);

      // Never called init() or start()
      expect(() => mgr.dispose()).not.toThrow();
    });
  });

  // ── Resource lifecycle ──────────────────────────────────

  describe('resource lifecycle', () => {
    test('N guru listeners added in init = N guru listeners removed in dispose', () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);

      mgr.init();

      const addCount = guru.on.mock.calls.length;
      expect(addCount).toBe(3);

      mgr.dispose();

      const removeCount = guru.off.mock.calls.length;
      expect(removeCount).toBe(3);
    });

    test('full lifecycle: init -> start -> stop -> dispose leaves no leaks', async () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const mgr = new HandsFreeMicManager(endpoint, guru);

      mgr.init();
      await mgr.start();
      mgr.stop();
      mgr.dispose();

      expect(mgr.isActive).toBe(false);
      expect(mgr.currentStream).toBeNull();
      expect(mgr.audioContext).toBeNull();
      expect(mgr.audioLevelUpdateInterval).toBeNull();
      expect(mgr._isDisposed).toBe(true);
    });
  });
});
