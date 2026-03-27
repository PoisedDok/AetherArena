'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

jest.mock('../../../../src/core/events/EventTypes', () => ({
  EventTypes: {
    AUDIO: { LEVEL_UPDATED: 'audio:level-updated' },
  },
}));

const LiveWaveform = require(
  '../../../../src/renderer/main/modules/handsfree/LiveWaveform'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEventBus() {
  const listeners = {};
  return {
    on: jest.fn((event, handler) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(handler);
      return jest.fn(); // cleanup function
    }),
    emit: jest.fn((event, data) => {
      (listeners[event] || []).forEach(fn => fn(data));
    }),
    _listeners: listeners,
  };
}

function createContainer() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return container;
}

// ---------------------------------------------------------------------------
// requestAnimationFrame polyfill (jsdom does not implement rAF)
// ---------------------------------------------------------------------------

let rafCallbacks = [];
let rafId = 0;

beforeAll(() => {
  global.requestAnimationFrame = jest.fn((cb) => {
    const id = ++rafId;
    rafCallbacks.push({ id, cb });
    return id;
  });
  global.cancelAnimationFrame = jest.fn((id) => {
    rafCallbacks = rafCallbacks.filter(r => r.id !== id);
  });
});

afterAll(() => {
  delete global.requestAnimationFrame;
  delete global.cancelAnimationFrame;
});

function flushRAF(count = 1) {
  for (let i = 0; i < count; i++) {
    const pending = rafCallbacks.splice(0, rafCallbacks.length);
    pending.forEach(({ cb }) => cb());
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('LiveWaveform', () => {
  let waveform;
  let container;
  let eventBus;

  beforeEach(() => {
    document.body.innerHTML = '';
    rafCallbacks = [];
    rafId = 0;
    mockLog.error.mockClear();
    mockLog.debug.mockClear();

    container = createContainer();
    eventBus = createMockEventBus();
  });

  afterEach(() => {
    if (waveform && !waveform._isDisposed) {
      waveform.dispose();
    }
    document.body.innerHTML = '';
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('stores container and eventBus', () => {
      waveform = new LiveWaveform({ container, eventBus });
      expect(waveform.container).toBe(container);
      expect(waveform.eventBus).toBe(eventBus);
    });

    it('defaults all options to null when omitted', () => {
      waveform = new LiveWaveform();
      expect(waveform.container).toBeNull();
      expect(waveform.eventBus).toBeNull();
    });

    it('initializes lifecycle flags correctly', () => {
      waveform = new LiveWaveform({ container, eventBus });
      expect(waveform._isActive).toBe(false);
      expect(waveform._isInitialized).toBe(false);
      expect(waveform._isDisposed).toBe(false);
    });

    it('logs error when container is missing', () => {
      waveform = new LiveWaveform({ eventBus });
      expect(mockLog.error).toHaveBeenCalledWith(
        '[LiveWaveform] container element required'
      );
    });

    it('initializes currentHeights to MIN_HEIGHT (2px)', () => {
      waveform = new LiveWaveform({ container, eventBus });
      for (let i = 0; i < 5; i++) {
        expect(waveform._currentHeights[i]).toBe(2);
      }
    });

    it('initializes targetHeights to 0', () => {
      waveform = new LiveWaveform({ container, eventBus });
      for (let i = 0; i < 5; i++) {
        expect(waveform._targetHeights[i]).toBe(0);
      }
    });
  });

  // =========================================================================
  // initialize
  // =========================================================================

  describe('initialize', () => {
    beforeEach(() => {
      waveform = new LiveWaveform({ container, eventBus });
    });

    it('creates 5 bar DOM elements', () => {
      waveform.initialize();
      const bars = container.querySelectorAll('.mic-waveform-bar');
      expect(bars.length).toBe(5);
    });

    it('sets initial height on each bar to MIN_HEIGHT', () => {
      waveform.initialize();
      for (const bar of container.querySelectorAll('.mic-waveform-bar')) {
        expect(bar.style.height).toBe('2px');
      }
    });

    it('subscribes to audio:level-updated event', () => {
      waveform.initialize();
      expect(eventBus.on).toHaveBeenCalledWith(
        'audio:level-updated',
        expect.any(Function)
      );
    });

    it('sets _isInitialized to true', () => {
      waveform.initialize();
      expect(waveform._isInitialized).toBe(true);
    });

    it('is idempotent (second call is no-op)', () => {
      waveform.initialize();
      const barCount = container.querySelectorAll('.mic-waveform-bar').length;
      waveform.initialize();
      expect(container.querySelectorAll('.mic-waveform-bar').length).toBe(barCount);
    });

    it('skips when container is null', () => {
      waveform.container = null;
      waveform.initialize();
      expect(waveform._isInitialized).toBe(false);
    });

    it('skips when already disposed', () => {
      waveform._isDisposed = true;
      waveform.initialize();
      expect(waveform._isInitialized).toBe(false);
    });

    it('works without eventBus (no subscription)', () => {
      waveform.eventBus = null;
      waveform.initialize();
      expect(waveform._isInitialized).toBe(true);
      expect(waveform._eventBusCleanup).toBeNull();
    });
  });

  // =========================================================================
  // start
  // =========================================================================

  describe('start', () => {
    beforeEach(() => {
      waveform = new LiveWaveform({ container, eventBus });
      waveform.initialize();
    });

    it('sets _isActive to true', () => {
      waveform.start();
      expect(waveform._isActive).toBe(true);
    });

    it('adds active class to container', () => {
      waveform.start();
      expect(container.classList.contains('active')).toBe(true);
    });

    it('defaults source filter to stt', () => {
      waveform.start();
      expect(waveform._sourceFilter).toBe('stt');
    });

    it('sets source filter to provided value', () => {
      waveform.start('tts');
      expect(waveform._sourceFilter).toBe('tts');
    });

    it('schedules animation frame', () => {
      waveform.start();
      expect(global.requestAnimationFrame).toHaveBeenCalled();
    });

    it('is no-op when disposed', () => {
      waveform._isDisposed = true;
      waveform.start();
      expect(waveform._isActive).toBe(false);
    });

    it('is no-op when not initialized', () => {
      const w = new LiveWaveform({ container, eventBus });
      // NOT calling w.initialize()
      w.start();
      expect(w._isActive).toBe(false);
    });
  });

  // =========================================================================
  // stop
  // =========================================================================

  describe('stop', () => {
    beforeEach(() => {
      waveform = new LiveWaveform({ container, eventBus });
      waveform.initialize();
      waveform.start();
    });

    it('sets _isActive to false', () => {
      waveform.stop();
      expect(waveform._isActive).toBe(false);
    });

    it('removes active class from container', () => {
      waveform.stop();
      expect(container.classList.contains('active')).toBe(false);
    });

    it('zeros all target heights', () => {
      waveform._targetHeights[0] = 0.8;
      waveform._targetHeights[2] = 0.5;
      waveform.stop();
      for (let i = 0; i < 5; i++) {
        expect(waveform._targetHeights[i]).toBe(0);
      }
    });

    it('starts decay cycle when animation loop not running', () => {
      // Simulate no animation loop running
      waveform._animFrameId = null;
      waveform._currentHeights[0] = 10; // Above MIN_HEIGHT
      waveform.stop();
      // Should have scheduled a decay frame
      expect(global.requestAnimationFrame).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _onAudioLevel
  // =========================================================================

  describe('_onAudioLevel', () => {
    beforeEach(() => {
      waveform = new LiveWaveform({ container, eventBus });
      waveform.initialize();
      waveform.start('stt');
    });

    it('maps FFT bands to target heights', () => {
      waveform._onAudioLevel({
        level: 0.5,
        bass: 0.8,
        lowMid: 0.6,
        highMid: 0.4,
        treble: 0.2,
      });
      // Float32Array has 32-bit precision — use toBeCloseTo
      expect(waveform._targetHeights[0]).toBeCloseTo(0.8, 5);   // bass
      expect(waveform._targetHeights[1]).toBeCloseTo(0.6, 5);   // lowMid
      expect(waveform._targetHeights[3]).toBeCloseTo(0.4, 5);   // highMid
      expect(waveform._targetHeights[4]).toBeCloseTo(0.2, 5);   // treble
    });

    it('center bar uses max of level and band average', () => {
      waveform._onAudioLevel({
        level: 0.9,
        bass: 0.2,
        lowMid: 0.2,
        highMid: 0.2,
        treble: 0.2,
      });
      // avg = (0.2+0.2+0.2+0.2)/4 = 0.2, max(0.9, 0.2) = 0.9
      expect(waveform._targetHeights[2]).toBeCloseTo(0.9, 5);
    });

    it('defaults missing fields to 0', () => {
      waveform._onAudioLevel({});
      for (let i = 0; i < 5; i++) {
        expect(waveform._targetHeights[i]).toBe(0);
      }
    });

    it('filters events by source', () => {
      // Source filter is 'stt', send 'tts' event
      const handler = eventBus.on.mock.calls[0][1];
      handler({ source: 'tts', level: 1, bass: 1, lowMid: 1, highMid: 1, treble: 1 });
      // Should be filtered out — targets unchanged
      expect(waveform._targetHeights[0]).toBe(0);
    });

    it('accepts events matching source filter', () => {
      const handler = eventBus.on.mock.calls[0][1];
      handler({ source: 'stt', level: 0.5, bass: 0.7, lowMid: 0, highMid: 0, treble: 0 });
      expect(waveform._targetHeights[0]).toBeCloseTo(0.7, 5);
    });

    it('accepts events with no source field (passthrough)', () => {
      const handler = eventBus.on.mock.calls[0][1];
      handler({ level: 0.5, bass: 0.3, lowMid: 0, highMid: 0, treble: 0 });
      expect(waveform._targetHeights[0]).toBeCloseTo(0.3, 5);
    });

    it('ignores events when not active', () => {
      waveform.stop();
      const handler = eventBus.on.mock.calls[0][1];
      handler({ source: 'stt', level: 1, bass: 1, lowMid: 1, highMid: 1, treble: 1 });
      // All targets were zeroed by stop()
      expect(waveform._targetHeights[0]).toBe(0);
    });
  });

  // =========================================================================
  // animation loop
  // =========================================================================

  describe('animation loop', () => {
    beforeEach(() => {
      waveform = new LiveWaveform({ container, eventBus });
      waveform.initialize();
    });

    it('interpolates bar heights toward targets when active', () => {
      waveform.start();
      waveform._onAudioLevel({ level: 1, bass: 1, lowMid: 1, highMid: 1, treble: 1 });

      // Flush a few animation frames
      flushRAF(3);

      // Heights should have risen from MIN_HEIGHT (2) toward MAX_HEIGHT (16)
      expect(waveform._currentHeights[0]).toBeGreaterThan(2);
    });

    it('decays bars toward MIN_HEIGHT when inactive', () => {
      waveform.start();
      waveform._onAudioLevel({ level: 1, bass: 1, lowMid: 0, highMid: 0, treble: 0 });
      flushRAF(5); // Rise
      const risenHeight = waveform._currentHeights[0];
      expect(risenHeight).toBeGreaterThan(2);

      waveform.stop();
      flushRAF(20); // Decay

      expect(waveform._currentHeights[0]).toBeLessThan(risenHeight);
    });

    it('does not start duplicate loop', () => {
      waveform.start();
      const firstCallCount = global.requestAnimationFrame.mock.calls.length;
      waveform._startAnimationLoop(); // Should be no-op
      expect(global.requestAnimationFrame.mock.calls.length).toBe(firstCallCount);
    });

    it('self-terminates when inactive and all bars settled', () => {
      waveform.start();
      flushRAF(1); // Start loop
      waveform.stop();
      // Flush enough frames for all bars to settle
      flushRAF(100);
      // After settling, no more frames should be scheduled
      const prevCount = global.requestAnimationFrame.mock.calls.length;
      flushRAF(1);
      expect(global.requestAnimationFrame.mock.calls.length).toBe(prevCount);
    });
  });

  // =========================================================================
  // _allBarsSettled
  // =========================================================================

  describe('_allBarsSettled', () => {
    beforeEach(() => {
      waveform = new LiveWaveform({ container, eventBus });
    });

    it('returns true when all bars at MIN_HEIGHT', () => {
      expect(waveform._allBarsSettled()).toBe(true);
    });

    it('returns false when any bar above threshold', () => {
      waveform._currentHeights[2] = 5;
      expect(waveform._allBarsSettled()).toBe(false);
    });

    it('returns true when bars within 0.3 of MIN_HEIGHT', () => {
      waveform._currentHeights[0] = 2.2;
      expect(waveform._allBarsSettled()).toBe(true);
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    beforeEach(() => {
      waveform = new LiveWaveform({ container, eventBus });
      waveform.initialize();
    });

    it('sets _isDisposed to true', () => {
      waveform.dispose();
      expect(waveform._isDisposed).toBe(true);
    });

    it('sets _isActive to false', () => {
      waveform.start();
      waveform.dispose();
      expect(waveform._isActive).toBe(false);
    });

    it('cancels animation frame', () => {
      waveform.start();
      const frameId = waveform._animFrameId;
      expect(frameId).not.toBeNull();
      waveform.dispose();
      expect(global.cancelAnimationFrame).toHaveBeenCalledWith(frameId);
      expect(waveform._animFrameId).toBeNull();
    });

    it('calls eventBus cleanup', () => {
      const cleanup = eventBus.on.mock.results[0].value;
      waveform.dispose();
      expect(cleanup).toHaveBeenCalled();
      expect(waveform._eventBusCleanup).toBeNull();
    });

    it('removes all bar elements from DOM', () => {
      expect(container.querySelectorAll('.mic-waveform-bar').length).toBe(5);
      waveform.dispose();
      expect(container.querySelectorAll('.mic-waveform-bar').length).toBe(0);
    });

    it('clears _bars array', () => {
      waveform.dispose();
      expect(waveform._bars).toEqual([]);
    });

    it('nulls container and eventBus references', () => {
      waveform.dispose();
      expect(waveform.container).toBeNull();
      expect(waveform.eventBus).toBeNull();
    });

    it('resets _isInitialized to false', () => {
      waveform.dispose();
      expect(waveform._isInitialized).toBe(false);
    });

    it('is idempotent (second call is no-op)', () => {
      waveform.dispose();
      expect(() => waveform.dispose()).not.toThrow();
    });
  });

  // =========================================================================
  // lifecycle edge cases
  // =========================================================================

  describe('lifecycle edge cases', () => {
    it('start after dispose is no-op', () => {
      waveform = new LiveWaveform({ container, eventBus });
      waveform.initialize();
      waveform.dispose();
      waveform.start();
      expect(waveform._isActive).toBe(false);
    });

    it('stop before start is safe', () => {
      waveform = new LiveWaveform({ container, eventBus });
      waveform.initialize();
      expect(() => waveform.stop()).not.toThrow();
    });

    it('rapid start-stop-start cycles', () => {
      waveform = new LiveWaveform({ container, eventBus });
      waveform.initialize();
      waveform.start('stt');
      waveform.stop();
      waveform.start('tts');
      expect(waveform._isActive).toBe(true);
      expect(waveform._sourceFilter).toBe('tts');
    });

    it('initialize without eventBus still creates bars', () => {
      waveform = new LiveWaveform({ container });
      waveform.initialize();
      expect(container.querySelectorAll('.mic-waveform-bar').length).toBe(5);
      expect(waveform._eventBusCleanup).toBeNull();
    });

    it('dispose without prior initialize is safe', () => {
      waveform = new LiveWaveform({ container, eventBus });
      expect(() => waveform.dispose()).not.toThrow();
    });
  });
});
