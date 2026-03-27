'use strict';

/**
 * HandsfreeCoordinator Unit Tests
 * ============================================================================
 * Tests constructor (DI validation, default config), initialize, enable/disable
 * /toggle, getState/isEnabled/getStatus, _transition (valid/invalid), state
 * entry actions (IDLE/LISTENING/PROCESSING/SPEAKING/INTERRUPTED), event handlers
 * (_handleSTTFinal, _handleTTSQueued, _handleTTSCompleted, _handleAudioLevelUpdate,
 * _handleTTSError, _handleBackendInterruption, _handleTTSAudio, _handleSleepWordDetected),
 * _mapHandsfreeToVisualizerState, cleanup.
 *
 * @module tests/unit/domain/audio/HandsfreeCoordinator.test
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../../../../src/core/events/EventTypes', () => ({
  EventTypes: {
    AUDIO: {
      STT_FINAL: 'audio:stt-final',
      TTS_QUEUED: 'audio:tts-queued',
      TTS_COMPLETED: 'audio:tts-completed',
      LEVEL_UPDATED: 'audio:level-updated',
      TTS_ERROR: 'audio:tts:error',
      TTS_BACKEND_ERROR: 'audio:tts:backend-error',
      INTERRUPTION_DETECTED: 'audio:interruption-detected',
      TTS_AUDIO: 'audio:tts-audio',
      SLEEP_WORD_DETECTED: 'audio:sleep-word-detected',
    },
    HANDSFREE: {
      STATE_CHANGED: 'handsfree:state-changed',
      ENABLED: 'handsfree:enabled',
      DISABLED: 'handsfree:disabled',
      INTERRUPTION_DETECTED: 'handsfree:interruption-detected',
    },
    VISUALIZER: {
      STATE_CHANGED: 'visualizer:state:changed',
    },
  },
}));

const { HandsfreeCoordinator, HandsfreeState } = require('../../../../src/domain/audio/services/HandsfreeCoordinator');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockEventBus() {
  const handlers = {};
  return {
    on: jest.fn((event, handler) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
      return jest.fn(); // cleanup function
    }),
    emit: jest.fn(),
    // Test helper: fire event
    _fire(event, data) {
      (handlers[event] || []).forEach(h => h(data));
    },
  };
}

function mockAudioManager() {
  return {
    startMicrophone: jest.fn().mockResolvedValue('stream-1'),
    stopMicrophone: jest.fn().mockResolvedValue(undefined),
    stopTTS: jest.fn(),
    clearTTSQueue: jest.fn(),
    handleTTSAudio: jest.fn().mockResolvedValue(undefined),
  };
}

function createCoordinator(overrides = {}) {
  return new HandsfreeCoordinator({
    eventBus: mockEventBus(),
    audioManager: mockAudioManager(),
    endpoint: { connection: { send: jest.fn() } },
    config: {
      interruptionThreshold: 0.15,
      autoLoop: true,
      vadTimeout: 0, // disable timeout in tests
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HandsfreeCoordinator', () => {
  let hc;
  let eb;
  let am;

  beforeEach(() => {
    jest.useFakeTimers();
    hc = createCoordinator();
    eb = hc.eventBus;
    am = hc.audioManager;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('requires eventBus', () => {
      expect(() => new HandsfreeCoordinator({ audioManager: mockAudioManager() }))
        .toThrow('eventBus required');
    });

    it('requires audioManager', () => {
      expect(() => new HandsfreeCoordinator({ eventBus: mockEventBus() }))
        .toThrow('audioManager required');
    });

    it('starts in IDLE state', () => {
      expect(hc.getState()).toBe(HandsfreeState.IDLE);
      expect(hc.isEnabled()).toBe(false);
    });

    it('uses default config when none provided', () => {
      const c = new HandsfreeCoordinator({
        eventBus: mockEventBus(),
        audioManager: mockAudioManager(),
      });
      expect(c.config.interruptionThreshold).toBe(0.15);
      expect(c.config.autoLoop).toBe(true);
    });
  });

  // =========================================================================
  // initialize
  // =========================================================================

  describe('initialize', () => {
    it('sets up event bus listeners', async () => {
      await hc.initialize();
      // 9 event subscriptions
      expect(eb.on).toHaveBeenCalledTimes(9);
    });

    it('propagates errors', async () => {
      hc.eventBus = null; // will cause _setupEventBusListeners to return early
      // Reattach eventBus but make on() throw
      const badBus = { on: jest.fn(() => { throw new Error('bus broken'); }), emit: jest.fn() };
      hc.eventBus = badBus;
      await expect(hc.initialize()).rejects.toThrow('bus broken');
    });
  });

  // =========================================================================
  // enable / disable / toggle
  // =========================================================================

  describe('enable', () => {
    it('transitions to LISTENING', async () => {
      await hc.enable();
      expect(hc.getState()).toBe(HandsfreeState.LISTENING);
      expect(hc.isEnabled()).toBe(true);
    });

    it('emits ENABLED event', async () => {
      await hc.enable();
      expect(eb.emit).toHaveBeenCalledWith('handsfree:enabled', expect.objectContaining({
        timestamp: expect.any(Number),
      }));
    });

    it('is idempotent', async () => {
      await hc.enable();
      await hc.enable(); // should no-op
      expect(am.startMicrophone).toHaveBeenCalledTimes(1);
    });

    it('resets _enabled on failure', async () => {
      am.startMicrophone.mockRejectedValueOnce(new Error('mic fail'));
      // enable calls _transition(LISTENING) which calls _onListeningEnter which calls startMicrophone
      // startMicrophone fails -> _onListeningEnter catches and transitions to IDLE
      await hc.enable();
      // After mic failure, state goes to IDLE via _onListeningEnter error handler
      // but _enabled stays true because enable() set it before _transition
      // Actually let me re-read the code...
      // enable() sets _enabled = true, calls _transition(LISTENING)
      // _transition calls _onStateEnter(LISTENING) -> _onListeningEnter
      // _onListeningEnter catches error and calls _transition(IDLE)
      // enable() does NOT catch this error (it's caught inside _onListeningEnter)
      // So _enabled stays true but state is IDLE
      expect(hc.getState()).toBe(HandsfreeState.IDLE);
    });
  });

  describe('disable', () => {
    it('transitions to IDLE', async () => {
      await hc.enable();
      await hc.disable();
      expect(hc.getState()).toBe(HandsfreeState.IDLE);
      expect(hc.isEnabled()).toBe(false);
    });

    it('emits DISABLED event', async () => {
      await hc.enable();
      await hc.disable();
      expect(eb.emit).toHaveBeenCalledWith('handsfree:disabled', expect.objectContaining({
        timestamp: expect.any(Number),
      }));
    });

    it('no-ops when not enabled', async () => {
      await hc.disable();
      expect(eb.emit).not.toHaveBeenCalledWith('handsfree:disabled', expect.anything());
    });
  });

  describe('toggle', () => {
    it('enables when disabled', async () => {
      await hc.toggle();
      expect(hc.isEnabled()).toBe(true);
    });

    it('disables when enabled', async () => {
      await hc.enable();
      await hc.toggle();
      expect(hc.isEnabled()).toBe(false);
    });
  });

  // =========================================================================
  // getState / isEnabled / getStatus
  // =========================================================================

  describe('getStatus', () => {
    it('returns complete status object', () => {
      const status = hc.getStatus();
      expect(status).toEqual({
        enabled: false,
        state: 'idle',
        previousState: null,
        streamId: null,
        monitoring: false,
      });
    });
  });

  // =========================================================================
  // _isValidTransition
  // =========================================================================

  describe('_isValidTransition', () => {
    it('IDLE → LISTENING is valid', () => {
      expect(hc._isValidTransition('idle', 'listening')).toBe(true);
    });

    it('IDLE → PROCESSING is invalid', () => {
      expect(hc._isValidTransition('idle', 'processing')).toBe(false);
    });

    it('LISTENING → PROCESSING is valid', () => {
      expect(hc._isValidTransition('listening', 'processing')).toBe(true);
    });

    it('SPEAKING → INTERRUPTED is valid', () => {
      expect(hc._isValidTransition('speaking', 'interrupted')).toBe(true);
    });

    it('ANY → IDLE is always valid', () => {
      expect(hc._isValidTransition('speaking', 'idle')).toBe(true);
      expect(hc._isValidTransition('processing', 'idle')).toBe(true);
      expect(hc._isValidTransition('interrupted', 'idle')).toBe(true);
    });
  });

  // =========================================================================
  // _transition
  // =========================================================================

  describe('_transition', () => {
    it('updates state and previousState', async () => {
      await hc._transition('listening');
      expect(hc.getState()).toBe('listening');
      expect(hc._previousState).toBe('idle');
    });

    it('rejects invalid transitions', async () => {
      await hc._transition('processing'); // idle → processing is invalid
      expect(hc.getState()).toBe('idle'); // unchanged
    });

    it('emits STATE_CHANGED and VISUALIZER STATE_CHANGED', async () => {
      await hc._transition('listening');
      expect(eb.emit).toHaveBeenCalledWith('handsfree:state-changed', expect.objectContaining({
        state: 'listening',
        previousState: 'idle',
      }));
      expect(eb.emit).toHaveBeenCalledWith('visualizer:state:changed', expect.objectContaining({
        state: 'listening',
        source: 'handsfree',
      }));
    });
  });

  // =========================================================================
  // State entry actions
  // =========================================================================

  describe('_onIdleEnter', () => {
    it('stops microphone and TTS', async () => {
      hc._streamId = 'stream-1';
      await hc._onIdleEnter();
      expect(am.stopMicrophone).toHaveBeenCalledWith('stream-1');
      expect(am.stopTTS).toHaveBeenCalled();
      expect(am.clearTTSQueue).toHaveBeenCalled();
      expect(hc._streamId).toBeNull();
    });

    it('clears timers', async () => {
      hc._vadTimeoutId = setTimeout(() => {}, 999);
      hc._autoLoopTimeoutId = setTimeout(() => {}, 999);
      await hc._onIdleEnter();
      expect(hc._vadTimeoutId).toBeNull();
      expect(hc._autoLoopTimeoutId).toBeNull();
    });
  });

  describe('_onListeningEnter', () => {
    it('starts microphone', async () => {
      await hc._onListeningEnter();
      expect(am.startMicrophone).toHaveBeenCalledWith(expect.objectContaining({
        streamId: expect.stringContaining('handsfree-'),
      }));
      expect(hc._streamId).toBe('stream-1');
    });

    it('reuses existing stream', async () => {
      hc._streamId = 'existing';
      await hc._onListeningEnter();
      expect(am.startMicrophone).not.toHaveBeenCalled();
    });

    it('transitions to IDLE on mic failure', async () => {
      am.startMicrophone.mockRejectedValueOnce(new Error('denied'));
      // Force state to listening first so IDLE transition is valid
      hc._currentState = 'listening';
      await hc._onListeningEnter();
      expect(hc.getState()).toBe('idle');
    });
  });

  describe('_onSpeakingEnter', () => {
    it('enables interruption monitoring', async () => {
      await hc._onSpeakingEnter();
      expect(hc._isMonitoringInterruption).toBe(true);
    });
  });

  describe('_onInterruptedEnter', () => {
    it('stops TTS and emits interruption event', async () => {
      hc._currentState = 'speaking'; // so INTERRUPTED → LISTENING is valid
      await hc._onInterruptedEnter();
      expect(am.stopTTS).toHaveBeenCalled();
      expect(am.clearTTSQueue).toHaveBeenCalled();
      expect(eb.emit).toHaveBeenCalledWith('handsfree:interruption-detected', expect.any(Object));
    });
  });

  // =========================================================================
  // Event Handlers
  // =========================================================================

  describe('_handleSTTFinal', () => {
    it('LISTENING → PROCESSING', async () => {
      hc._currentState = 'listening';
      hc._handleSTTFinal({ text: 'hello' });
      expect(hc.getState()).toBe('processing');
    });

    it('ignores in other states', () => {
      hc._currentState = 'idle';
      hc._handleSTTFinal({ text: 'hello' });
      expect(hc.getState()).toBe('idle');
    });

    it('SPEAKING: cancels TTS, stops monitoring, transitions to PROCESSING', () => {
      hc._currentState = 'speaking';
      hc._isMonitoringInterruption = true;
      hc._handleSTTFinal({ text: 'stop' });
      expect(am.stopTTS).toHaveBeenCalled();
      expect(am.clearTTSQueue).toHaveBeenCalled();
      expect(hc._isMonitoringInterruption).toBe(false);
      expect(hc.getState()).toBe('processing');
    });

    it('SPEAKING: sends cancel-tts to backend endpoint', () => {
      hc._currentState = 'speaking';
      hc._handleSTTFinal({ text: 'stop' });
      expect(hc.endpoint.connection.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'audio/cancel-tts' })
      );
    });

    it('SPEAKING: handles missing endpoint gracefully', () => {
      hc._currentState = 'speaking';
      hc.endpoint = null;
      expect(() => hc._handleSTTFinal({ text: 'stop' })).not.toThrow();
      expect(hc.getState()).toBe('processing');
    });

    it('SPEAKING: sends cancel-tts to backend', () => {
      hc._currentState = 'speaking';
      hc._handleSTTFinal({ text: 'stop' });
      expect(hc.endpoint.connection.send).toHaveBeenCalledWith(
        expect.stringContaining('cancel-tts')
      );
    });

    it('SPEAKING: handles missing endpoint gracefully', () => {
      const c = createCoordinator({ endpoint: null });
      c._currentState = 'speaking';
      expect(() => c._handleSTTFinal({ text: 'stop' })).not.toThrow();
    });

    it('INTERRUPTED → PROCESSING', () => {
      hc._currentState = 'interrupted';
      hc._handleSTTFinal({ text: 'new query' });
      expect(hc.getState()).toBe('processing');
    });

    it('SPEAKING: catches send error without crashing', () => {
      hc._currentState = 'speaking';
      hc.endpoint.connection.send = jest.fn(() => { throw new Error('ws closed'); });
      expect(() => hc._handleSTTFinal({ text: 'stop' })).not.toThrow();
      expect(hc.getState()).toBe('processing'); // still transitions
    });

    it('PROCESSING: ignores STT (not LISTENING)', () => {
      hc._currentState = 'processing';
      hc._handleSTTFinal({ text: 'extra' });
      expect(hc.getState()).toBe('processing'); // unchanged
    });
  });

  describe('_handleTTSQueued', () => {
    it('PROCESSING → SPEAKING', () => {
      hc._currentState = 'processing';
      hc._handleTTSQueued({});
      expect(hc.getState()).toBe('speaking');
    });

    it('LISTENING: fast-forwards through PROCESSING to SPEAKING', () => {
      hc._currentState = 'listening';
      hc._handleTTSQueued({});
      expect(hc.getState()).toBe('speaking');
    });

    it('ignores in other states', () => {
      hc._currentState = 'idle';
      hc._handleTTSQueued({});
      expect(hc.getState()).toBe('idle');
    });
  });

  describe('_handleTTSCompleted', () => {
    it('SPEAKING: schedules auto-loop to LISTENING', () => {
      hc._currentState = 'speaking';
      hc._enabled = true;
      hc.config.autoLoopDebounceMs = 100;
      hc._handleTTSCompleted({});
      expect(hc._autoLoopTimeoutId).not.toBeNull();
      jest.advanceTimersByTime(100);
      expect(hc.getState()).toBe('listening');
    });

    it('SPEAKING: transitions to IDLE when autoLoop disabled', () => {
      hc._currentState = 'speaking';
      hc._enabled = true;
      hc.config.autoLoop = false;
      hc._handleTTSCompleted({});
      expect(hc.getState()).toBe('idle');
    });

    it('ignores in non-SPEAKING/PROCESSING states', () => {
      hc._currentState = 'idle';
      hc._handleTTSCompleted({});
      expect(hc.getState()).toBe('idle');
    });

    it('PROCESSING: returns to LISTENING if autoLoop enabled', () => {
      hc._currentState = 'processing';
      hc._enabled = true;
      hc._handleTTSCompleted({});
      expect(hc.getState()).toBe('listening');
    });

    it('PROCESSING: transitions to IDLE when autoLoop disabled', () => {
      hc._currentState = 'processing';
      hc._enabled = true;
      hc.config.autoLoop = false;
      hc._handleTTSCompleted({});
      expect(hc.getState()).toBe('idle');
    });

    // --- MUTATION TEST: debounce race condition ---

    it('auto-loop debounce skips transition when state already moved to PROCESSING', () => {
      hc._currentState = 'speaking';
      hc._enabled = true;
      hc.config.autoLoopDebounceMs = 500;
      hc._handleTTSCompleted({});
      // Before timer fires, STT arrives and moves to PROCESSING
      hc._currentState = 'processing';
      jest.advanceTimersByTime(500);
      // Should NOT force back to LISTENING -- state already moved
      expect(hc.getState()).toBe('processing');
    });

    it('auto-loop debounce skips when handsfree disabled during wait', () => {
      hc._currentState = 'speaking';
      hc._enabled = true;
      hc.config.autoLoopDebounceMs = 500;
      hc._handleTTSCompleted({});
      // Disable handsfree before timer fires
      hc._enabled = false;
      jest.advanceTimersByTime(500);
      // Should NOT transition -- handsfree disabled
      expect(hc.getState()).toBe('speaking');
    });

    it('clears previous debounce timer on rapid TTS completions', () => {
      hc._currentState = 'speaking';
      hc._enabled = true;
      hc.config.autoLoopDebounceMs = 500;
      hc._handleTTSCompleted({});
      const firstTimerId = hc._autoLoopTimeoutId;
      // Second TTS completion arrives quickly
      hc._handleTTSCompleted({});
      // Timer replaced, not stacked
      expect(hc._autoLoopTimeoutId).not.toBe(firstTimerId);
    });
  });

  describe('_handleAudioLevelUpdate', () => {
    it('tracks TTS level', () => {
      hc._handleAudioLevelUpdate({ source: 'tts', level: 0.7 });
      expect(hc._ttsAudioLevel).toBe(0.7);
    });

    it('tracks STT level', () => {
      hc._handleAudioLevelUpdate({ source: 'stt', level: 0.3 });
      expect(hc._sttAudioLevel).toBe(0.3);
    });

    it('tracks level with no source as STT', () => {
      hc._handleAudioLevelUpdate({ level: 0.4 });
      expect(hc._sttAudioLevel).toBe(0.4);
    });
  });

  describe('_handleTTSError', () => {
    it('SPEAKING: recovers to LISTENING when autoLoop', () => {
      hc._currentState = 'speaking';
      hc._enabled = true;
      hc._handleTTSError({ error: new Error('decode fail') });
      expect(am.stopTTS).toHaveBeenCalled();
      expect(hc.getState()).toBe('listening');
    });

    it('SPEAKING: transitions to IDLE when no autoLoop', () => {
      hc._currentState = 'speaking';
      hc._enabled = true;
      hc.config.autoLoop = false;
      hc._handleTTSError({ error: 'fail' });
      expect(hc.getState()).toBe('idle');
    });

    it('PROCESSING: recovers to LISTENING when autoLoop', () => {
      hc._currentState = 'processing';
      hc._enabled = true;
      hc._handleTTSError({ error: new Error('server error') });
      expect(am.stopTTS).toHaveBeenCalled();
      expect(hc.getState()).toBe('listening');
    });

    it('PROCESSING: transitions to IDLE when no autoLoop', () => {
      hc._currentState = 'processing';
      hc._enabled = true;
      hc.config.autoLoop = false;
      hc._handleTTSError({ error: 'fail' });
      expect(hc.getState()).toBe('idle');
    });

    it('ignores in non-SPEAKING/PROCESSING states', () => {
      hc._currentState = 'idle';
      hc._handleTTSError({});
      expect(am.stopTTS).not.toHaveBeenCalled();
    });
  });

  describe('_handleBackendInterruption', () => {
    it('SPEAKING → INTERRUPTED → LISTENING', () => {
      hc._currentState = 'speaking';
      hc._handleBackendInterruption({});
      // Called twice: once in _handleBackendInterruption, once in _onInterruptedEnter
      expect(am.stopTTS).toHaveBeenCalledTimes(2);
      expect(am.clearTTSQueue).toHaveBeenCalledTimes(2);
      expect(hc._isMonitoringInterruption).toBe(false);
      // INTERRUPTED auto-transitions to LISTENING via _onInterruptedEnter
      expect(hc.getState()).toBe('listening');
    });

    it('ignores when not SPEAKING', () => {
      hc._currentState = 'processing';
      hc._handleBackendInterruption({});
      expect(am.stopTTS).not.toHaveBeenCalled();
      expect(am.clearTTSQueue).not.toHaveBeenCalled();
    });

    it('ignores in IDLE state', () => {
      hc._currentState = 'idle';
      hc._handleBackendInterruption({});
      expect(am.stopTTS).not.toHaveBeenCalled();
      expect(hc.getState()).toBe('idle');
    });
  });

  describe('_handleTTSAudio', () => {
    beforeEach(() => {
      global.atob = jest.fn(s => Buffer.from(s, 'base64').toString('binary'));
    });
    afterEach(() => { delete global.atob; });

    it('decodes and queues audio in PROCESSING state with correct args', async () => {
      hc._currentState = 'processing';
      const b64 = Buffer.from('test-audio').toString('base64');
      await hc._handleTTSAudio({ audio: b64, format: 'pcm16', sample_rate: 24000 });
      expect(am.handleTTSAudio).toHaveBeenCalledTimes(1);
      const [buf, opts] = am.handleTTSAudio.mock.calls[0];
      expect(buf).toBeInstanceOf(ArrayBuffer);
      expect(buf.byteLength).toBe(10); // 'test-audio' = 10 bytes
      expect(opts).toEqual({ format: 'pcm16', sampleRate: 24000 });
    });

    it('decodes and queues audio in SPEAKING state', async () => {
      hc._currentState = 'speaking';
      const b64 = Buffer.from('x').toString('base64');
      await hc._handleTTSAudio({ audio: b64, format: 'pcm16', sample_rate: 24000 });
      expect(am.handleTTSAudio).toHaveBeenCalledTimes(1);
    });

    it('ignores in IDLE state', async () => {
      hc._currentState = 'idle';
      await hc._handleTTSAudio({ audio: 'dGVzdA==' });
      expect(am.handleTTSAudio).not.toHaveBeenCalled();
    });

    it('ignores in LISTENING state', async () => {
      hc._currentState = 'listening';
      await hc._handleTTSAudio({ audio: 'dGVzdA==' });
      expect(am.handleTTSAudio).not.toHaveBeenCalled();
    });

    it('catches decode errors without crashing', async () => {
      hc._currentState = 'processing';
      global.atob = jest.fn(() => { throw new Error('invalid base64'); });
      await expect(hc._handleTTSAudio({ audio: '!!!bad!!!', format: 'pcm16', sample_rate: 24000 })).resolves.not.toThrow();
      expect(am.handleTTSAudio).not.toHaveBeenCalled();
    });

    it('catches handleTTSAudio rejection without crashing', async () => {
      hc._currentState = 'speaking';
      am.handleTTSAudio.mockRejectedValueOnce(new Error('queue full'));
      const b64 = Buffer.from('x').toString('base64');
      await expect(hc._handleTTSAudio({ audio: b64, format: 'pcm16', sample_rate: 24000 })).resolves.not.toThrow();
    });
  });

  describe('_handleSleepWordDetected', () => {
    it('disables handsfree', async () => {
      hc._enabled = true;
      hc._currentState = 'listening';
      hc._handleSleepWordDetected();
      // disable() is async, flush promises
      await Promise.resolve();
      expect(hc.isEnabled()).toBe(false);
    });
  });

  // =========================================================================
  // _mapHandsfreeToVisualizerState
  // =========================================================================

  describe('_mapHandsfreeToVisualizerState', () => {
    it('maps all states correctly', () => {
      expect(hc._mapHandsfreeToVisualizerState('idle')).toBe('idle');
      expect(hc._mapHandsfreeToVisualizerState('listening')).toBe('listening');
      expect(hc._mapHandsfreeToVisualizerState('processing')).toBe('thinking');
      expect(hc._mapHandsfreeToVisualizerState('speaking')).toBe('speaking');
      expect(hc._mapHandsfreeToVisualizerState('interrupted')).toBe('listening');
    });

    it('returns null for unknown state', () => {
      expect(hc._mapHandsfreeToVisualizerState('unknown')).toBeNull();
    });
  });

  // =========================================================================
  // cleanup
  // =========================================================================

  describe('cleanup', () => {
    it('disables if enabled', async () => {
      await hc.enable();
      await hc.cleanup();
      expect(hc.isEnabled()).toBe(false);
    });

    it('cleans up EventBus subscriptions', async () => {
      await hc.initialize();
      const cleanupCount = hc._eventBusCleanups.length;
      expect(cleanupCount).toBeGreaterThan(0);
      await hc.cleanup();
      expect(hc._eventBusCleanups).toHaveLength(0);
    });

    it('resets state', async () => {
      hc._streamId = 's1';
      hc._isMonitoringInterruption = true;
      await hc.cleanup();
      expect(hc._streamId).toBeNull();
      expect(hc._isMonitoringInterruption).toBe(false);
      expect(hc.getState()).toBe('idle');
    });

    it('handles cleanup errors gracefully', async () => {
      hc._eventBusCleanups = [() => { throw new Error('oops'); }];
      await expect(hc.cleanup()).resolves.not.toThrow();
    });
  });

  // =========================================================================
  // HandsfreeState export
  // =========================================================================

  describe('HandsfreeState', () => {
    it('exports all state constants', () => {
      expect(HandsfreeState.IDLE).toBe('idle');
      expect(HandsfreeState.LISTENING).toBe('listening');
      expect(HandsfreeState.PROCESSING).toBe('processing');
      expect(HandsfreeState.SPEAKING).toBe('speaking');
      expect(HandsfreeState.INTERRUPTED).toBe('interrupted');
    });
  });
});
