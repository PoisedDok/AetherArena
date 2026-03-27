'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = {
  info: () => {},
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};
mockLog.child = () => mockLog;

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

const MockHandsfreeConversationDisplay = jest.fn();
jest.mock(
  '../../../../src/renderer/main/modules/handsfree/HandsfreeConversationDisplay',
  () => MockHandsfreeConversationDisplay
);

jest.mock('../../../../src/core/events/EventTypes', () => ({
  EventTypes: {
    HANDSFREE: { STATE_CHANGED: 'handsfree:state-changed' },
    AUDIO: { LEVEL_UPDATED: 'audio:level-updated' },
  },
}));

const MockLiveWaveform = jest.fn();
jest.mock(
  '../../../../src/renderer/main/modules/handsfree/LiveWaveform',
  () => MockLiveWaveform
);

const HandsfreeUIController = require(
  '../../../../src/renderer/main/runtime/coordinators/HandsfreeUIController'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAudioServices() {
  const audioManager = {
    initialize: jest.fn().mockResolvedValue(undefined),
    dispose: jest.fn(),
  };
  const coordinator = {
    initialize: jest.fn(),
    dispose: jest.fn(),
  };
  return {
    createDefaultConfig: jest.fn().mockReturnValue({ sampleRate: 16000 }),
    createAudioManager: jest.fn().mockReturnValue(audioManager),
    createHandsfreeCoordinator: jest.fn().mockReturnValue(coordinator),
    _am: audioManager,
    _coord: coordinator,
  };
}

function createMockEndpoint(overrides = {}) {
  return {
    getSettings: jest.fn().mockResolvedValue(overrides.settings || {}),
    getPreference: jest.fn().mockResolvedValue(overrides.preference || { enabled: false }),
    setPreference: jest.fn().mockResolvedValue(undefined),
  };
}

function createMockEventBus() {
  return {
    on: jest.fn().mockReturnValue(jest.fn()),
    emit: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('HandsfreeUIController', () => {
  let controller;
  let audioServices;
  let eventBus;
  let endpoint;
  let micToggle;
  let micWaveform;

  beforeEach(() => {
    document.body.innerHTML = '';
    delete window.audioManager;
    delete window.handsfreeCoordinator;
    delete window.handsfreeConversationDisplay;

    audioServices = createMockAudioServices();
    eventBus = createMockEventBus();
    endpoint = createMockEndpoint();
    micToggle = document.createElement('button');
    micWaveform = document.createElement('div');
    document.body.appendChild(micToggle);
    document.body.appendChild(micWaveform);

    MockHandsfreeConversationDisplay.mockClear();
    MockHandsfreeConversationDisplay.mockImplementation(() => ({
      initialize: jest.fn(),
      dispose: jest.fn(),
    }));

    MockLiveWaveform.mockClear();
    MockLiveWaveform.mockImplementation(() => ({
      initialize: jest.fn(),
      start: jest.fn(),
      stop: jest.fn(),
      dispose: jest.fn(),
    }));

    controller = new HandsfreeUIController({
      audioServices,
      eventBus,
      endpoint,
      config: { API_BASE_URL: 'http://test:3000' },
      micToggle,
      micWaveform,
    });
  });

  afterEach(() => {
    delete window.audioManager;
    delete window.handsfreeCoordinator;
    delete window.handsfreeConversationDisplay;
    document.body.innerHTML = '';
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('stores all provided options', () => {
      expect(controller.audioServices).toBe(audioServices);
      expect(controller.eventBus).toBe(eventBus);
      expect(controller.endpoint).toBe(endpoint);
      expect(controller.micToggle).toBe(micToggle);
      expect(controller.micWaveform).toBe(micWaveform);
      expect(controller.config).toEqual({ API_BASE_URL: 'http://test:3000' });
    });

    it('defaults all options to null/empty when omitted', () => {
      const c = new HandsfreeUIController();
      expect(c.audioServices).toBeNull();
      expect(c.eventBus).toBeNull();
      expect(c.endpoint).toBeNull();
      expect(c.config).toEqual({});
      expect(c.micToggle).toBeNull();
      expect(c.micWaveform).toBeNull();
    });

    it('initializes internal state to null', () => {
      expect(controller.audioManager).toBeNull();
      expect(controller.handsfreeCoordinator).toBeNull();
      expect(controller.handsfreeConversationDisplay).toBeNull();
      expect(controller._liveWaveform).toBeNull();
    });

    it('initializes empty _eventBusCleanup array', () => {
      expect(controller._eventBusCleanup).toEqual([]);
    });
  });

  // =========================================================================
  // _initializeAudioManager
  // =========================================================================

  describe('_initializeAudioManager', () => {
    it('reuses existing window.audioManager', () => {
      const existing = { existing: true };
      window.audioManager = existing;
      controller._initializeAudioManager();
      expect(controller.audioManager).toBe(existing);
      expect(audioServices.createAudioManager).not.toHaveBeenCalled();
      expect(mockLog.debug).toHaveBeenCalledWith('AudioManager already initialized');
    });

    it('skips when audioServices is null', () => {
      controller.audioServices = null;
      controller._initializeAudioManager();
      expect(controller.audioManager).toBeNull();
      expect(mockLog.warn).toHaveBeenCalledWith(
        'AudioServices not available, skipping AudioManager'
      );
    });

    it('creates AudioManager via audioServices factory', () => {
      controller._initializeAudioManager();
      expect(audioServices.createDefaultConfig).toHaveBeenCalled();
      expect(audioServices.createAudioManager).toHaveBeenCalledWith({
        eventBus,
        endpoint,
        config: { sampleRate: 16000 },
      });
    });

    it('exposes audioManager on instance and window', async () => {
      await controller._initializeAudioManager();
      expect(controller.audioManager).toBe(audioServices._am);
      expect(window.audioManager).toBe(audioServices._am);
    });

    it('calls audioManager.initialize() asynchronously', () => {
      controller._initializeAudioManager();
      expect(audioServices._am.initialize).toHaveBeenCalled();
    });

    it('logs debug on successful async initialization', async () => {
      controller._initializeAudioManager();
      await Promise.resolve();
      expect(mockLog.debug).toHaveBeenCalledWith('AudioManager initialized');
    });

    it('logs error when audioManager.initialize rejects', async () => {
      const err = new Error('init failed');
      audioServices._am.initialize.mockRejectedValue(err);
      controller._initializeAudioManager();
      // flush both .then and .catch microtasks
      await new Promise(r => setTimeout(r, 0));
      expect(mockLog.error).toHaveBeenCalledWith(
        'AudioManager initialization failed:', err
      );
    });

    it('catches error from audioServices factory', () => {
      audioServices.createAudioManager.mockImplementation(() => {
        throw new Error('factory error');
      });
      controller._initializeAudioManager();
      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to create AudioManager:', expect.any(Error)
      );
    });

    it('logs debug after creation', () => {
      controller._initializeAudioManager();
      expect(mockLog.debug).toHaveBeenCalledWith('AudioManager created and exposed');
    });
  });

  // =========================================================================
  // _initializeHandsfreeCoordinator
  // =========================================================================

  describe('_initializeHandsfreeCoordinator', () => {
    beforeEach(() => {
      controller.audioManager = audioServices._am;
    });

    it('skips when audioManager is null', async () => {
      controller.audioManager = null;
      await controller._initializeHandsfreeCoordinator();
      expect(mockLog.warn).toHaveBeenCalledWith(
        'AudioManager not available, skipping HandsfreeCoordinator'
      );
    });

    it('skips when eventBus is null', async () => {
      controller.eventBus = null;
      await controller._initializeHandsfreeCoordinator();
      expect(mockLog.warn).toHaveBeenCalledWith(
        'EventBus not available, skipping HandsfreeCoordinator'
      );
    });

    it('creates HandsfreeConversationDisplay with correct options', async () => {
      await controller._initializeHandsfreeCoordinator();
      expect(MockHandsfreeConversationDisplay).toHaveBeenCalledWith({
        eventBus,
        apiBaseUrl: 'http://test:3000',
        proactiveTts: { enabled: false, voice: 'Ryan', language: '' },
      });
    });

    it('initializes HandsfreeConversationDisplay', async () => {
      await controller._initializeHandsfreeCoordinator();
      expect(controller.handsfreeConversationDisplay.initialize).toHaveBeenCalled();
    });

    it('creates HandsfreeCoordinator via audioServices', async () => {
      await controller._initializeHandsfreeCoordinator();
      expect(audioServices.createHandsfreeCoordinator).toHaveBeenCalledWith({
        audioManager: audioServices._am,
        eventBus,
        endpoint,
        config: {
          enabled: false,
          interruptionThreshold: 0.03,
          autoLoop: true,
          vadTimeout: 30000,
          autoLoopDebounceMs: 800,
        },
      });
    });

    it('initializes HandsfreeCoordinator', async () => {
      await controller._initializeHandsfreeCoordinator();
      expect(audioServices._coord.initialize).toHaveBeenCalled();
    });

    it('exposes coordinator and display on window', async () => {
      await controller._initializeHandsfreeCoordinator();
      expect(window.handsfreeCoordinator).toBe(audioServices._coord);
      expect(window.handsfreeConversationDisplay).toBeDefined();
    });

    it('uses backend settings when handsfree config is available', async () => {
      endpoint.getSettings.mockResolvedValue({
        handsfree: {
          enabled: false,
          interruption_threshold: 0.05,
          auto_loop: false,
          vad_timeout_ms: 60000,
          auto_loop_debounce_ms: 1000,
          proactive_tts_enabled: true,
          proactive_tts_voice: 'Nova',
          proactive_tts_language: 'en-US',
        },
      });

      await controller._initializeHandsfreeCoordinator();

      expect(audioServices.createHandsfreeCoordinator).toHaveBeenCalledWith(
        expect.objectContaining({
          config: {
            enabled: false,
            interruptionThreshold: 0.05,
            autoLoop: false,
            vadTimeout: 60000,
            autoLoopDebounceMs: 1000,
          },
        })
      );
      expect(MockHandsfreeConversationDisplay).toHaveBeenCalledWith(
        expect.objectContaining({
          proactiveTts: { enabled: true, voice: 'Nova', language: 'en-US' },
        })
      );
    });

    it('uses defaults when settings.handsfree is absent', async () => {
      endpoint.getSettings.mockResolvedValue({ other: true });
      await controller._initializeHandsfreeCoordinator();
      expect(audioServices.createHandsfreeCoordinator).toHaveBeenCalledWith(
        expect.objectContaining({
          config: {
            enabled: false,
            interruptionThreshold: 0.03,
            autoLoop: true,
            vadTimeout: 30000,
            autoLoopDebounceMs: 800,
          },
        })
      );
    });

    it('falls back to defaults when getSettings rejects', async () => {
      endpoint.getSettings.mockRejectedValue(new Error('network'));
      await controller._initializeHandsfreeCoordinator();
      expect(mockLog.warn).toHaveBeenCalledWith(
        'Failed to load handsfree settings, using defaults:',
        expect.any(Error)
      );
      // Still creates coordinator with default config
      expect(audioServices.createHandsfreeCoordinator).toHaveBeenCalled();
    });

    it('catches outer error and logs', async () => {
      MockHandsfreeConversationDisplay.mockImplementation(() => {
        throw new Error('display error');
      });
      await controller._initializeHandsfreeCoordinator();
      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to initialize HandsfreeCoordinator:', expect.any(Error)
      );
    });

    it('uses fallback values for missing handsfree sub-fields', async () => {
      endpoint.getSettings.mockResolvedValue({
        handsfree: {}, // all sub-fields missing
      });
      await controller._initializeHandsfreeCoordinator();
      expect(audioServices.createHandsfreeCoordinator).toHaveBeenCalledWith(
        expect.objectContaining({
          config: {
            enabled: false,
            interruptionThreshold: 0.03,
            autoLoop: true,
            vadTimeout: 30000,
            autoLoopDebounceMs: 800,
          },
        })
      );
      expect(MockHandsfreeConversationDisplay).toHaveBeenCalledWith(
        expect.objectContaining({
          proactiveTts: { enabled: false, voice: 'Ryan', language: '' },
        })
      );
    });

    it('uses fallback API_BASE_URL when config is empty', async () => {
      controller.config = {};
      await controller._initializeHandsfreeCoordinator();
      expect(MockHandsfreeConversationDisplay).toHaveBeenCalledWith(
        expect.objectContaining({ apiBaseUrl: '' })
      );
    });
  });

  // =========================================================================
  // _subscribeToEvents
  // =========================================================================

  describe('_subscribeToEvents', () => {
    it('returns early when eventBus is null', () => {
      controller.eventBus = null;
      controller._subscribeToEvents();
      expect(controller._eventBusCleanup.length).toBe(0);
    });

    it('returns early when micToggle is null', () => {
      controller.micToggle = null;
      controller._subscribeToEvents();
      expect(controller._eventBusCleanup.length).toBe(0);
    });

    it('subscribes to STATE_CHANGED, wake-word-detected, and SETTINGS_SAVED', () => {
      controller._subscribeToEvents();
      expect(eventBus.on).toHaveBeenCalledTimes(3);
      expect(eventBus.on).toHaveBeenCalledWith(
        'handsfree:state-changed', expect.any(Function)
      );
      expect(eventBus.on).toHaveBeenCalledWith(
        'handsfree:wake-word-detected', expect.any(Function)
      );
      expect(eventBus.on).toHaveBeenCalledWith(
        'ui:settings-saved', expect.any(Function)
      );
    });

    it('pushes cleanup functions to _eventBusCleanup', () => {
      controller._subscribeToEvents();
      expect(controller._eventBusCleanup.length).toBe(3);
    });

    it('STATE_CHANGED handler calls _updateMicButtonState', () => {
      const spy = jest.spyOn(controller, '_updateMicButtonState');
      controller._subscribeToEvents();
      // Get the callback passed for STATE_CHANGED
      const handler = eventBus.on.mock.calls[0][1];
      handler({ state: 'listening' });
      expect(spy).toHaveBeenCalledWith('listening');
    });

    it('wake-word-detected handler calls _flashMicButtonWakeWord', () => {
      const spy = jest.spyOn(controller, '_flashMicButtonWakeWord');
      controller._subscribeToEvents();
      // Get the callback passed for wake-word-detected
      const handler = eventBus.on.mock.calls[1][1];
      handler();
      expect(spy).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _initializeLiveWaveform
  // =========================================================================

  describe('_initializeLiveWaveform', () => {
    it('creates LiveWaveform when container and eventBus are available', () => {
      controller._initializeLiveWaveform();
      expect(MockLiveWaveform).toHaveBeenCalledWith({
        container: micWaveform,
        eventBus,
      });
      expect(controller._liveWaveform).not.toBeNull();
      expect(controller._liveWaveform.initialize).toHaveBeenCalled();
    });

    it('skips when micWaveform is null', () => {
      controller.micWaveform = null;
      controller._initializeLiveWaveform();
      expect(MockLiveWaveform).not.toHaveBeenCalled();
      expect(controller._liveWaveform).toBeNull();
    });

    it('skips when eventBus is null', () => {
      controller.eventBus = null;
      controller._initializeLiveWaveform();
      expect(MockLiveWaveform).not.toHaveBeenCalled();
      expect(controller._liveWaveform).toBeNull();
    });
  });

  // =========================================================================
  // _updateWaveformState
  // =========================================================================

  describe('_updateWaveformState', () => {
    beforeEach(() => {
      controller._initializeLiveWaveform();
    });

    it('starts waveform with stt source for listening state', () => {
      controller._updateWaveformState('listening');
      expect(controller._liveWaveform.start).toHaveBeenCalledWith('stt');
      expect(micWaveform.classList.contains('state-listening')).toBe(true);
    });

    it('starts waveform with tts source for speaking state', () => {
      controller._updateWaveformState('speaking');
      expect(controller._liveWaveform.start).toHaveBeenCalledWith('tts');
      expect(micWaveform.classList.contains('state-speaking')).toBe(true);
    });

    it('stops waveform for processing state', () => {
      controller._updateWaveformState('processing');
      expect(controller._liveWaveform.stop).toHaveBeenCalled();
      expect(micWaveform.classList.contains('state-listening')).toBe(false);
      expect(micWaveform.classList.contains('state-speaking')).toBe(false);
    });

    it('stops waveform for idle state', () => {
      controller._updateWaveformState('idle');
      expect(controller._liveWaveform.stop).toHaveBeenCalled();
    });

    it('removes previous state class when switching states', () => {
      controller._updateWaveformState('listening');
      expect(micWaveform.classList.contains('state-listening')).toBe(true);
      controller._updateWaveformState('speaking');
      expect(micWaveform.classList.contains('state-listening')).toBe(false);
      expect(micWaveform.classList.contains('state-speaking')).toBe(true);
    });

    it('is no-op when _liveWaveform is null', () => {
      controller._liveWaveform = null;
      expect(() => controller._updateWaveformState('listening')).not.toThrow();
    });
  });

  // =========================================================================
  // _updateMicButtonState
  // =========================================================================

  describe('_updateMicButtonState', () => {
    it('returns early when micToggle is null', () => {
      controller.micToggle = null;
      expect(() => controller._updateMicButtonState('listening')).not.toThrow();
    });

    it('removes all previous state classes', () => {
      micToggle.classList.add('state-listening', 'state-speaking');
      controller._updateMicButtonState('processing');
      expect(micToggle.classList.contains('state-listening')).toBe(false);
      expect(micToggle.classList.contains('state-speaking')).toBe(false);
      expect(micToggle.classList.contains('state-processing')).toBe(true);
    });

    it('adds active class for non-idle state', () => {
      controller._updateMicButtonState('listening');
      expect(micToggle.classList.contains('active')).toBe(true);
    });

    it('removes active class for idle state', () => {
      micToggle.classList.add('active');
      controller._updateMicButtonState('idle');
      expect(micToggle.classList.contains('active')).toBe(false);
    });

    it('removes active class for falsy state', () => {
      micToggle.classList.add('active');
      controller._updateMicButtonState(null);
      expect(micToggle.classList.contains('active')).toBe(false);
    });

    it('does not add state class for falsy state', () => {
      controller._updateMicButtonState(null);
      expect(micToggle.classList.contains('state-null')).toBe(false);
    });

    it('sets title from stateLabels for known states', () => {
      controller._updateMicButtonState('listening');
      expect(micToggle.title).toBe('Listening... (Say "hey jarvis" to activate)');

      controller._updateMicButtonState('processing');
      expect(micToggle.title).toBe('Processing...');

      controller._updateMicButtonState('speaking');
      expect(micToggle.title).toBe('Speaking...');

      controller._updateMicButtonState('interrupted');
      expect(micToggle.title).toBe('Interrupted');

      controller._updateMicButtonState('idle');
      expect(micToggle.title).toBe('Handsfree Mode: Off');
    });

    it('sets default title for unknown state', () => {
      controller._updateMicButtonState('unknown');
      expect(micToggle.title).toBe('Toggle Hands-Free Voice');
    });

    // --- inline state label ---

    describe('with #mic-state-label element', () => {
      let stateLabel;

      beforeEach(() => {
        stateLabel = document.createElement('span');
        stateLabel.id = 'mic-state-label';
        document.body.appendChild(stateLabel);
      });

      it('sets text and visibility for active non-idle states', () => {
        controller._updateMicButtonState('speaking');
        expect(stateLabel.textContent).toBe('Speaking');
        expect(stateLabel.classList.contains('visible')).toBe(true);
        expect(stateLabel.classList.contains('state-speaking')).toBe(true);
      });

      it('clears text for idle state', () => {
        stateLabel.textContent = 'previous';
        stateLabel.classList.add('visible', 'state-listening');
        controller._updateMicButtonState('idle');
        expect(stateLabel.textContent).toBe('');
        expect(stateLabel.classList.contains('visible')).toBe(false);
      });

      it('removes old classes before adding new', () => {
        stateLabel.classList.add('visible', 'state-listening');
        controller._updateMicButtonState('processing');
        expect(stateLabel.classList.contains('state-listening')).toBe(false);
        expect(stateLabel.classList.contains('state-processing')).toBe(true);
      });

      it('clears text for falsy state', () => {
        controller._updateMicButtonState(null);
        expect(stateLabel.textContent).toBe('');
      });
    });

    // --- waveform vs label ---

    describe('waveform vs label interaction', () => {
      let stateLabel;

      beforeEach(() => {
        stateLabel = document.createElement('span');
        stateLabel.id = 'mic-state-label';
        document.body.appendChild(stateLabel);
        // Initialize LiveWaveform so _liveWaveform is available
        controller._initializeLiveWaveform();
      });

      it('hides label when waveform is active for listening state', () => {
        controller._updateMicButtonState('listening');
        expect(stateLabel.textContent).toBe('');
        expect(stateLabel.classList.contains('visible')).toBe(false);
        expect(controller._liveWaveform.start).toHaveBeenCalledWith('stt');
      });

      it('hides label when waveform is active for speaking state', () => {
        controller._updateMicButtonState('speaking');
        expect(stateLabel.textContent).toBe('');
        expect(stateLabel.classList.contains('visible')).toBe(false);
        expect(controller._liveWaveform.start).toHaveBeenCalledWith('tts');
      });

      it('shows label for processing state even when waveform exists', () => {
        controller._updateMicButtonState('processing');
        expect(stateLabel.textContent).toBe('Thinking');
        expect(stateLabel.classList.contains('visible')).toBe(true);
        expect(controller._liveWaveform.stop).toHaveBeenCalled();
      });

      it('shows label for interrupted state even when waveform exists', () => {
        controller._updateMicButtonState('interrupted');
        expect(stateLabel.textContent).toBe('Paused');
        expect(stateLabel.classList.contains('visible')).toBe(true);
        expect(controller._liveWaveform.stop).toHaveBeenCalled();
      });

      it('graceful degradation: shows label when waveform is null', () => {
        controller._liveWaveform = null;
        controller._updateMicButtonState('listening');
        expect(stateLabel.textContent).toBe('Listening');
        expect(stateLabel.classList.contains('visible')).toBe(true);
      });

      it('graceful degradation: shows Speaking label when waveform is null', () => {
        controller._liveWaveform = null;
        controller._updateMicButtonState('speaking');
        expect(stateLabel.textContent).toBe('Speaking');
        expect(stateLabel.classList.contains('visible')).toBe(true);
      });
    });

    // --- handsfree conversation overlay ---

    describe('handsfree conversation overlay', () => {
      let overlay;

      beforeEach(() => {
        overlay = document.createElement('div');
        overlay.id = 'handsfree-conversation';
        document.body.appendChild(overlay);
        window.handsfreeConversationDisplay = { mock: true };
      });

      it('creates wake-word-hint when listening and no hint exists', () => {
        controller._updateMicButtonState('listening');
        const hint = overlay.querySelector('.wake-word-hint');
        expect(hint).not.toBeNull();
        expect(hint.textContent).toContain('hey jarvis');
      });

      it('does not duplicate hint if already present', () => {
        const existing = document.createElement('div');
        existing.className = 'wake-word-hint';
        overlay.appendChild(existing);
        controller._updateMicButtonState('listening');
        expect(overlay.querySelectorAll('.wake-word-hint').length).toBe(1);
      });

      it('removes hint for non-listening states', () => {
        const hint = document.createElement('div');
        hint.className = 'wake-word-hint';
        overlay.appendChild(hint);
        controller._updateMicButtonState('speaking');
        expect(overlay.querySelector('.wake-word-hint')).toBeNull();
      });

      it('does nothing when overlay exists but no hint to remove', () => {
        controller._updateMicButtonState('processing');
        expect(overlay.querySelector('.wake-word-hint')).toBeNull();
      });
    });

    describe('overlay edge cases', () => {
      it('handles missing overlay when listening with display', () => {
        window.handsfreeConversationDisplay = { mock: true };
        // No overlay element exists
        expect(() => controller._updateMicButtonState('listening')).not.toThrow();
      });

      it('handles missing overlay when non-listening', () => {
        // No overlay, no display — else branch
        expect(() => controller._updateMicButtonState('processing')).not.toThrow();
      });
    });
  });

  // =========================================================================
  // _flashMicButtonWakeWord
  // =========================================================================

  describe('_flashMicButtonWakeWord', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('returns early when micToggle is null', () => {
      controller.micToggle = null;
      expect(() => controller._flashMicButtonWakeWord()).not.toThrow();
    });

    it('adds wake-word-detected class', () => {
      controller._flashMicButtonWakeWord();
      expect(micToggle.classList.contains('wake-word-detected')).toBe(true);
    });

    it('timeout removes class after 600ms', () => {
      controller._flashMicButtonWakeWord();
      jest.advanceTimersByTime(600);
      expect(micToggle.classList.contains('wake-word-detected')).toBe(false);
    });

    it('clears previous timeout when called again', () => {
      controller._flashMicButtonWakeWord();
      const firstTimeout = controller._wakeWordTimeout;
      expect(firstTimeout).not.toBeNull();

      controller._flashMicButtonWakeWord();
      const secondTimeout = controller._wakeWordTimeout;
      expect(secondTimeout).not.toBeNull();
      expect(secondTimeout).not.toBe(firstTimeout);
    });

    it('logs debug message', () => {
      controller._flashMicButtonWakeWord();
      expect(mockLog.debug).toHaveBeenCalledWith(
        '[HandsfreeUIController] Wake word visual feedback triggered via CSS'
      );
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    it('calls all eventBus cleanup functions', () => {
      const c1 = jest.fn();
      const c2 = jest.fn();
      controller._eventBusCleanup = [c1, c2];
      controller.dispose();
      expect(c1).toHaveBeenCalled();
      expect(c2).toHaveBeenCalled();
    });

    it('clears _eventBusCleanup array', () => {
      controller._eventBusCleanup = [jest.fn()];
      controller.dispose();
      expect(controller._eventBusCleanup).toEqual([]);
    });

    it('catches cleanup function that throws', () => {
      controller._eventBusCleanup = [() => { throw new Error('cleanup err'); }];
      expect(() => controller.dispose()).not.toThrow();
      expect(mockLog.error).toHaveBeenCalledWith(
        '[HandsfreeUIController] Failed to cleanup EventBus listener:',
        expect.any(Error)
      );
    });

    it('skips non-function cleanup entries', () => {
      controller._eventBusCleanup = [null, undefined, 'bad'];
      expect(() => controller.dispose()).not.toThrow();
    });

    it('disposes handsfreeCoordinator if it has dispose()', () => {
      const d = jest.fn();
      controller.handsfreeCoordinator = { dispose: d };
      controller.dispose();
      expect(d).toHaveBeenCalled();
      expect(controller.handsfreeCoordinator).toBeNull();
    });

    it('disposes handsfreeConversationDisplay if it has dispose()', () => {
      const d = jest.fn();
      controller.handsfreeConversationDisplay = { dispose: d };
      controller.dispose();
      expect(d).toHaveBeenCalled();
      expect(controller.handsfreeConversationDisplay).toBeNull();
    });

    it('handles coordinators without dispose method', () => {
      controller.handsfreeCoordinator = { noDispose: true };
      controller.handsfreeConversationDisplay = { noDispose: true };
      expect(() => controller.dispose()).not.toThrow();
    });

    it('disposes LiveWaveform if it exists', () => {
      controller._initializeLiveWaveform();
      expect(controller._liveWaveform).not.toBeNull();
      const d = controller._liveWaveform.dispose;
      controller.dispose();
      expect(d).toHaveBeenCalled();
      expect(controller._liveWaveform).toBeNull();
    });

    it('nulls out all references', () => {
      controller.dispose();
      expect(controller.audioManager).toBeNull();
      expect(controller.audioServices).toBeNull();
      expect(controller.eventBus).toBeNull();
      expect(controller.endpoint).toBeNull();
      expect(controller.micToggle).toBeNull();
      expect(controller.micWaveform).toBeNull();
    });

    it('is idempotent', () => {
      controller.dispose();
      expect(() => controller.dispose()).not.toThrow();
    });
  });

  // =========================================================================
  // initialize (integration)
  // =========================================================================

  describe('initialize', () => {
    it('calls all 4 initialization steps in sequence', async () => {
      const s1 = jest.spyOn(controller, '_initializeAudioManager');
      const s2 = jest.spyOn(controller, '_initializeHandsfreeCoordinator')
        .mockResolvedValue(undefined);
      const s3 = jest.spyOn(controller, '_subscribeToEvents');
      const s4 = jest.spyOn(controller, '_initializeLiveWaveform');

      await controller.initialize();

      expect(s1).toHaveBeenCalled();
      expect(s2).toHaveBeenCalled();
      expect(s3).toHaveBeenCalled();
      expect(s4).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // lifecycle
  // =========================================================================

  describe('lifecycle', () => {
    it('full create → initialize → dispose → recreate cycle', async () => {
      const c1 = new HandsfreeUIController({
        audioServices,
        eventBus,
        endpoint,
        config: {},
        micToggle,
      });

      // Mock to avoid full init
      jest.spyOn(c1, '_initializeHandsfreeCoordinator').mockResolvedValue(undefined);

      await c1.initialize();
      c1.dispose();

      expect(c1.audioManager).toBeNull();
      expect(c1.eventBus).toBeNull();

      // Recreate
      const c2 = new HandsfreeUIController({
        audioServices: createMockAudioServices(),
        eventBus: createMockEventBus(),
        endpoint: createMockEndpoint(),
        config: {},
        micToggle: document.createElement('button'),
      });
      expect(c2.audioServices).not.toBeNull();
      expect(c2.eventBus).not.toBeNull();
    });
  });
});
