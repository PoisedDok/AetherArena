/**
 * @.architecture
 *
 * Incoming: EventBus audio:level-updated events with FFT band data (bass, lowMid, highMid, treble, level) --- {eventBus_types.event, object}
 * Processing: Map FFT band values to bar heights, smooth interpolation via rAF loop, manage active/inactive state --- {3 jobs: JOB_INITIALIZE, JOB_UPDATE_STATE, JOB_DISPOSE}
 * Outgoing: DOM style.height updates on waveform bar elements --- {dom_types.style}
 *
 * Lightweight inline waveform visualizer for the handsfree mic indicator.
 * Renders 5 frequency-reactive bars next to the mic button, replacing the
 * static "Listening" / "Speaking" text labels with live audio feedback.
 *
 * Design inspired by ElevenLabs VoiceButton LiveWaveform pattern:
 * - Bars map to FFT frequency bands (bass through treble)
 * - Smooth rise/decay via requestAnimationFrame interpolation
 * - Self-contained lifecycle: initialize → start → stop → dispose
 * - Zero external dependencies beyond EventBus
 */

'use strict';

const { createRendererLogger } = require('../../../shared/utils/logger');
const { EventTypes } = require('../../../../core/events/EventTypes');

const BAR_COUNT = 5;
const MIN_HEIGHT = 2;    // px — minimum bar height when silent
const MAX_HEIGHT = 16;   // px — maximum bar height at peak
const RISE_FACTOR = 0.35; // Interpolation speed for rising bars (higher = snappier)
const DECAY_FACTOR = 0.12; // Interpolation speed for falling bars (lower = smoother decay)

class LiveWaveform {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.container - Parent element to render bars into
   * @param {Object} options.eventBus - EventBus instance
   */
  constructor(options = {}) {
    this.log = createRendererLogger('LiveWaveform');
    this.container = options.container || null;
    this.eventBus = options.eventBus || null;

    // DOM elements
    this._bars = [];

    // Animation state
    this._currentHeights = new Float32Array(BAR_COUNT).fill(MIN_HEIGHT);
    this._targetHeights = new Float32Array(BAR_COUNT).fill(0);
    this._animFrameId = null;

    // EventBus cleanup
    this._eventBusCleanup = null;

    // Lifecycle
    this._isActive = false;
    this._isInitialized = false;
    this._isDisposed = false;

    // Which audio source to react to: 'stt' (mic) or 'tts' (agent speech)
    this._sourceFilter = 'stt';

    if (!this.container) {
      this.log.error('[LiveWaveform] container element required');
    }
  }

  /**
   * Create bar DOM elements and subscribe to audio level events.
   * Call once after construction.
   */
  initialize() {
    if (this._isDisposed || this._isInitialized) return;
    if (!this.container) return;

    // Create bar elements
    for (let i = 0; i < BAR_COUNT; i++) {
      const bar = document.createElement('div');
      bar.className = 'mic-waveform-bar';
      bar.style.height = `${MIN_HEIGHT}px`;
      this.container.appendChild(bar);
      this._bars.push(bar);
    }

    // Subscribe to audio level events from AudioManager
    if (this.eventBus) {
      this._eventBusCleanup = this.eventBus.on(EventTypes.AUDIO.LEVEL_UPDATED, (data) => {
        if (!this._isActive) return;
        // Filter by audio source: 'stt' for mic capture, 'tts' for agent speech
        if (data.source && data.source !== this._sourceFilter) return;
        this._onAudioLevel(data);
      });
    }

    this._isInitialized = true;
    this.log.debug('[LiveWaveform] Initialized with %d bars', BAR_COUNT);
  }

  /**
   * Start the waveform animation. Call when handsfree enters listening/speaking state.
   * @param {string} [source='stt'] - Audio source to react to: 'stt' (mic) or 'tts' (agent)
   */
  start(source = 'stt') {
    if (this._isDisposed || !this._isInitialized) return;
    this._sourceFilter = source;
    this._isActive = true;
    this.container?.classList.add('active');
    this._startAnimationLoop();
  }

  /**
   * Stop the waveform animation. Bars decay smoothly to minimum height.
   * Call when handsfree exits listening/speaking state.
   */
  stop() {
    this._isActive = false;
    this.container?.classList.remove('active');

    // Zero out targets — animation loop will decay bars to minimum
    this._targetHeights.fill(0);

    // If animation loop is not running (edge case), start a decay cycle
    if (!this._animFrameId) {
      this._runDecayCycle();
    }
  }

  // ── Audio Data Handling ──────────────────────────────────────

  /**
   * Map incoming FFT band data to 5 bar target heights.
   * Bar layout: [bass | lowMid | overall | highMid | treble]
   * Center bar uses peak of overall level for visual emphasis.
   * @private
   * @param {Object} data - { level, bass, lowMid, highMid, treble }
   */
  _onAudioLevel(data) {
    const { level = 0, bass = 0, lowMid = 0, highMid = 0, treble = 0 } = data;

    this._targetHeights[0] = bass;
    this._targetHeights[1] = lowMid;
    this._targetHeights[2] = Math.max(level, (bass + lowMid + highMid + treble) / 4);
    this._targetHeights[3] = highMid;
    this._targetHeights[4] = treble;
  }

  // ── Animation Loop ───────────────────────────────────────────

  /**
   * Start the requestAnimationFrame loop for smooth bar interpolation.
   * Loop self-terminates when all bars reach minimum height and waveform is inactive.
   * @private
   */
  _startAnimationLoop() {
    if (this._animFrameId) return; // Already running

    const animate = () => {
      // If inactive and all bars settled, stop the loop
      if (!this._isActive && this._allBarsSettled()) {
        this._animFrameId = null;
        return;
      }

      for (let i = 0; i < BAR_COUNT; i++) {
        const target = this._isActive
          ? MIN_HEIGHT + this._targetHeights[i] * (MAX_HEIGHT - MIN_HEIGHT)
          : MIN_HEIGHT;

        const current = this._currentHeights[i];

        // Asymmetric interpolation: fast rise, slow decay for organic feel
        if (target > current) {
          this._currentHeights[i] += (target - current) * RISE_FACTOR;
        } else {
          this._currentHeights[i] += (target - current) * DECAY_FACTOR;
        }

        // Clamp to minimum
        if (this._currentHeights[i] < MIN_HEIGHT) {
          this._currentHeights[i] = MIN_HEIGHT;
        }

        // Apply to DOM (round to 1 decimal for sub-pixel smoothness)
        const h = Math.round(this._currentHeights[i] * 10) / 10;
        if (this._bars[i]) {
          this._bars[i].style.height = `${h}px`;
        }
      }

      this._animFrameId = requestAnimationFrame(animate);
    };

    this._animFrameId = requestAnimationFrame(animate);
  }

  /**
   * Run a single decay cycle when stop() is called while animation loop isn't running.
   * @private
   */
  _runDecayCycle() {
    const decay = () => {
      if (this._isActive) return; // start() was called, main loop takes over

      let settled = true;
      for (let i = 0; i < BAR_COUNT; i++) {
        this._currentHeights[i] += (MIN_HEIGHT - this._currentHeights[i]) * DECAY_FACTOR;
        if (this._currentHeights[i] < MIN_HEIGHT + 0.3) {
          this._currentHeights[i] = MIN_HEIGHT;
        } else {
          settled = false;
        }
        if (this._bars[i]) {
          this._bars[i].style.height = `${Math.round(this._currentHeights[i] * 10) / 10}px`;
        }
      }

      if (!settled) {
        requestAnimationFrame(decay);
      }
    };

    requestAnimationFrame(decay);
  }

  /**
   * Check if all bars have settled at minimum height (animation can stop).
   * @private
   * @returns {boolean}
   */
  _allBarsSettled() {
    for (let i = 0; i < BAR_COUNT; i++) {
      if (this._currentHeights[i] > MIN_HEIGHT + 0.3) return false;
    }
    return true;
  }

  // ── Lifecycle ────────────────────────────────────────────────

  /**
   * Dispose: stop animation, unsubscribe events, remove bar elements.
   * Safe to call multiple times (idempotent).
   */
  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this._isActive = false;

    // Cancel animation loop
    if (this._animFrameId) {
      cancelAnimationFrame(this._animFrameId);
      this._animFrameId = null;
    }

    // Unsubscribe EventBus listener
    if (this._eventBusCleanup) {
      this._eventBusCleanup();
      this._eventBusCleanup = null;
    }

    // Remove bar elements from DOM
    for (const bar of this._bars) {
      bar.remove();
    }
    this._bars = [];

    // Release references
    this.container = null;
    this.eventBus = null;
    this._isInitialized = false;
  }
}

module.exports = LiveWaveform;
