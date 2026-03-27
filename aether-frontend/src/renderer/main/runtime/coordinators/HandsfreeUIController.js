/**
 * @.architecture
 *
 * Incoming: EventBus handsfree/wake-word events, endpoint settings API, AudioServices factory --- {eventBus_types.event, api_types.response}
 * Processing: Initialize AudioManager + HandsfreeCoordinator, manage mic button visual state + LiveWaveform visualizer, load/persist preferences --- {4 jobs: JOB_INITIALIZE, JOB_UPDATE_STATE, JOB_PERSIST, JOB_MANAGE_WAVEFORM}
 * Outgoing: DOM class toggles on mic button, LiveWaveform bar height updates, global window exposures (audioManager, handsfreeCoordinator) --- {dom_types.classList, dom_types.style, window_types.global}
 *
 * Extracted from MainApp.js to reduce god-object size.
 * MainApp delegates all handsfree/audio UI concerns here.
 */

'use strict';

const { createRendererLogger } = require('../../../shared/utils/logger');
const LiveWaveform = require('../../modules/handsfree/LiveWaveform');

class HandsfreeUIController {
  /**
   * @param {Object} options
   * @param {Object} options.audioServices - AudioServices factory instance
   * @param {Object} options.eventBus - EventBus instance
   * @param {Object} options.endpoint - Endpoint instance
   * @param {Object} options.config - Renderer config (API_BASE_URL, etc.)
   * @param {HTMLElement} [options.micToggle] - Mic toggle button element
   * @param {HTMLElement} [options.micWaveform] - Waveform container element
   */
  constructor(options = {}) {
    this.log = createRendererLogger('HandsfreeUIController');
    this.audioServices = options.audioServices || null;
    this.eventBus = options.eventBus || null;
    this.endpoint = options.endpoint || null;
    this.config = options.config || {};
    this.micToggle = options.micToggle || null;
    this.micWaveform = options.micWaveform || null;

    this.audioManager = null;
    this.handsfreeCoordinator = null;
    this.handsfreeConversationDisplay = null;
    this._liveWaveform = null;

    this._eventBusCleanup = [];
    this._isDisposed = false;
  }

  /**
   * Initialize AudioManager, HandsfreeCoordinator, and UI event subscriptions.
   * Call after endpoint and eventBus are available.
   */
  async initialize() {
    if (this._isDisposed) {
      this.log.warn('initialize called on disposed HandsfreeUIController');
      return;
    }

    await this._initializeAudioManager();
    await this._initializeHandsfreeCoordinator();
    if (this._isDisposed) return;
    this._subscribeToEvents();
    this._initializeLiveWaveform();
    
    // Initial visibility state based on backend config
    if (this.handsfreeConfig) {
      this._updateMicVisibility(this.handsfreeConfig.enabled);
    } else {
      this._updateMicVisibility(false);
    }
  }

  // ── AudioManager ───────────────────────────────────────────

  async _initializeAudioManager() {
    if (window.audioManager) {
      this.log.debug('AudioManager already initialized');
      this.audioManager = window.audioManager;
      return;
    }

    if (!this.audioServices) {
      this.log.warn('AudioServices not available, skipping AudioManager');
      return;
    }

    try {
      const audioConfig = this.audioServices.createDefaultConfig();
      const audioManager = this.audioServices.createAudioManager({
        eventBus: this.eventBus,
        endpoint: this.endpoint,
        config: audioConfig,
      });

      // Await initialization so HandsfreeCoordinator gets a fully
      // initialized AudioManager. The previous fire-and-forget pattern
      // exposed the instance before init completed, causing silent
      // failures when handsfree features were used immediately.
      try {
        await audioManager.initialize();
        this.log.debug('AudioManager initialized');
      } catch (error) {
        this.log.error('AudioManager initialization failed:', error);
        // Continue — expose the instance anyway so handsfree can
        // degrade gracefully rather than NPE on null audioManager.
      }

      // Expose globally
      this.audioManager = audioManager;
      window.audioManager = audioManager;

      this.log.debug('AudioManager created and exposed');
    } catch (error) {
      this.log.error('Failed to create AudioManager:', error);
    }
  }

  // ── HandsfreeCoordinator ───────────────────────────────────

  async _initializeHandsfreeCoordinator() {
    if (!this.audioManager) {
      this.log.warn('AudioManager not available, skipping HandsfreeCoordinator');
      return;
    }

    if (!this.eventBus) {
      this.log.warn('EventBus not available, skipping HandsfreeCoordinator');
      return;
    }

    try {
      const HandsfreeConversationDisplay = require('../../modules/handsfree/HandsfreeConversationDisplay');

      // Load handsfree settings from backend (single call, reuse for proactive TTS)
      let handsfreeConfig = {
        enabled: false,
        interruptionThreshold: 0.03,
        autoLoop: true,
        vadTimeout: 30000,
        autoLoopDebounceMs: 800,
      };
      let proactiveTtsConfig = { enabled: false, voice: 'Ryan', language: '' };

      try {
        const settings = await this.endpoint.getSettings();
        if (this._isDisposed) return;
        if (settings && settings.handsfree) {
          const hf = settings.handsfree;
          handsfreeConfig = {
            enabled: hf.enabled === true,
            interruptionThreshold: hf.interruption_threshold !== undefined ? hf.interruption_threshold : 0.03,
            autoLoop: hf.auto_loop !== undefined ? hf.auto_loop : true,
            vadTimeout: hf.vad_timeout_ms !== undefined ? hf.vad_timeout_ms : 30000,
            autoLoopDebounceMs: hf.auto_loop_debounce_ms !== undefined ? hf.auto_loop_debounce_ms : 800,
          };
          proactiveTtsConfig = {
            enabled: !!hf.proactive_tts_enabled,
            voice: hf.proactive_tts_voice || 'Ryan',
            language: hf.proactive_tts_language || '',
          };
          this.log.debug('Loaded handsfree config from backend:', handsfreeConfig);
        }
      } catch (error) {
        this.log.warn('Failed to load handsfree settings, using defaults:', error);
      }
      
      this.handsfreeConfig = handsfreeConfig;

      // Initialize conversation display (with proactive TTS config)
      this.handsfreeConversationDisplay = new HandsfreeConversationDisplay({
        eventBus: this.eventBus,
        apiBaseUrl: this.config.API_BASE_URL || '',
        apiClient: this.endpoint ? this.endpoint.api : null,
        proactiveTts: proactiveTtsConfig,
      });
      this.handsfreeConversationDisplay.initialize();

      // Initialize coordinator with backend config
      // CRITICAL FIX: Inject endpoint for cancel-tts WebSocket command
      this.handsfreeCoordinator = this.audioServices.createHandsfreeCoordinator({
        audioManager: this.audioManager,
        eventBus: this.eventBus,
        endpoint: this.endpoint, // For sending cancel-tts on interruption
        config: handsfreeConfig,
      });

      // Initialize coordinator
      this.handsfreeCoordinator.initialize();

      // Expose globally for UI access
      window.handsfreeCoordinator = this.handsfreeCoordinator;
      window.handsfreeConversationDisplay = this.handsfreeConversationDisplay;

      this.log.debug('HandsfreeCoordinator + ConversationDisplay initialized');
    } catch (error) {
      this.log.error('Failed to initialize HandsfreeCoordinator:', error);
    }
  }

  // ── EventBus Subscriptions ─────────────────────────────────

  _subscribeToEvents() {
    if (!this.eventBus || !this.micToggle) return;

    // Use window.EventTypes if available, otherwise attempt require, or fallback
    let EventTypes = window.EventTypes;
    if (!EventTypes) {
      try {
        EventTypes = require('../../../../core/events/EventTypes').EventTypes;
      } catch (e) {
        EventTypes = {
          HANDSFREE: { STATE_CHANGED: 'handsfree:state-changed' },
          UI: { SETTINGS_SAVED: 'ui:settings-saved' }
        };
      }
    }
    
    // Fallbacks if EventTypes doesn't have what we need
    const STATE_CHANGED = EventTypes?.HANDSFREE?.STATE_CHANGED || 'handsfree:state-changed';
    const SETTINGS_SAVED = EventTypes?.UI?.SETTINGS_SAVED || 'ui:settings-saved';

    // Subscribe to handsfree:state-changed to update mic button visual state
    const cleanupHandsfreeState = this.eventBus.on(STATE_CHANGED, (data) => {
      this._updateMicButtonState(data.state);
    });
    this._eventBusCleanup.push(cleanupHandsfreeState);

    // GAP 6 FIX: Subscribe to wake word detection for visual feedback
    const cleanupWakeWord = this.eventBus.on('handsfree:wake-word-detected', () => {
      this._flashMicButtonWakeWord();
    });
    this._eventBusCleanup.push(cleanupWakeWord);

    // Subscribe to settings updates to toggle the mic visibility dynamically
    const cleanupSettingsUpdate = this.eventBus.on(SETTINGS_SAVED, (data) => {
      if (data && data.handsfree) {
        const enabled = data.handsfree.enabled === true;
        this._updateMicVisibility(enabled);
      }
    });
    this._eventBusCleanup.push(cleanupSettingsUpdate);
  }

  // ── Live Waveform ──────────────────────────────────────────

  /**
   * Create and initialize the LiveWaveform visualizer.
   * Renders frequency-reactive bars next to the mic button,
   * replacing static text labels during listening/speaking states.
   */
  _initializeLiveWaveform() {
    if (!this.micWaveform || !this.eventBus) {
      this.log.debug('[HandsfreeUIController] LiveWaveform skipped (missing container or eventBus)');
      return;
    }

    this._liveWaveform = new LiveWaveform({
      container: this.micWaveform,
      eventBus: this.eventBus,
    });
    this._liveWaveform.initialize();
    this.log.debug('[HandsfreeUIController] LiveWaveform initialized');
  }

  /**
   * Update LiveWaveform state: start with correct audio source filter,
   * or stop when transitioning to a non-audio state.
   * Also syncs state CSS class on the waveform container for color changes.
   * @param {string} state - Handsfree state
   * @private
   */
  _updateWaveformState(state) {
    if (!this._liveWaveform || !this.micWaveform) return;

    // Remove all state classes from waveform container
    this.micWaveform.classList.remove('state-listening', 'state-speaking');

    if (state === 'listening') {
      this.micWaveform.classList.add('state-listening');
      this._liveWaveform.start('stt');
    } else if (state === 'speaking') {
      this.micWaveform.classList.add('state-speaking');
      this._liveWaveform.start('tts');
    } else {
      this._liveWaveform.stop();
    }
  }

  // ── Mic Button Visual State ────────────────────────────────

  _updateMicButtonState(state) {
    const micBtn = this.micToggle;
    if (!micBtn) return;

    this.log.debug(`[HandsfreeUIController] Updating mic button state: ${state}`);

    // Remove all state classes
    micBtn.classList.remove('state-idle', 'state-listening', 'state-processing', 'state-speaking', 'state-interrupted');

    // Add current state class
    if (state) {
      micBtn.classList.add(`state-${state}`);
    }

    // Toggle 'active' class for visual styling (CSS uses .active, not state-*)
    if (state && state !== 'idle') {
      micBtn.classList.add('active');
    } else {
      micBtn.classList.remove('active');
    }

    // Update title for accessibility
    const stateLabels = {
      idle: 'Handsfree Mode: Off',
      listening: 'Listening... (Say "hey jarvis" to activate)',
      processing: 'Processing...',
      speaking: 'Speaking...',
      interrupted: 'Interrupted'
    };
    micBtn.title = stateLabels[state] || 'Toggle Hands-Free Voice';

    // Update waveform visualizer (listening/speaking) vs text label (processing/interrupted)
    this._updateWaveformState(state);

    // States with live audio show waveform; states without audio show text label.
    // listening → waveform (mic audio), speaking → waveform (TTS audio)
    // processing → "Thinking" text, interrupted → "Paused" text
    const waveformStates = new Set(['listening', 'speaking']);
    const showWaveform = this._liveWaveform && waveformStates.has(state);

    // Update inline state label. All 4 active states have labels for
    // graceful degradation: if LiveWaveform is not available (missing DOM,
    // missing EventBus), labels still show for listening/speaking states.
    const stateLabel = document.getElementById('mic-state-label');
    if (stateLabel) {
      const shortLabels = {
        listening: 'Listening',
        processing: 'Thinking',
        speaking: 'Speaking',
        interrupted: 'Paused',
      };
      stateLabel.classList.remove('visible', 'state-listening', 'state-processing', 'state-speaking', 'state-interrupted');

      // Show text label when: (a) waveform not available, OR (b) state has no waveform
      if (!showWaveform && state && state !== 'idle' && shortLabels[state]) {
        stateLabel.textContent = shortLabels[state];
        stateLabel.classList.add('visible', `state-${state}`);
      } else {
        stateLabel.textContent = '';
      }
    }

    // GAP 4 FIX: Update conversation overlay with status hint
    if (state === 'listening' && window.handsfreeConversationDisplay) {
      const overlay = document.getElementById('handsfree-conversation');
      if (overlay) {
        let hint = overlay.querySelector('.wake-word-hint');
        if (!hint) {
          hint = document.createElement('div');
          hint.className = 'wake-word-hint';
          hint.textContent = 'Say "hey jarvis" to start conversation';
          overlay.appendChild(hint);
        }
      }
    } else {
      const overlay = document.getElementById('handsfree-conversation');
      if (overlay) {
        const hint = overlay.querySelector('.wake-word-hint');
        if (hint) hint.remove();
      }
    }
  }

  _flashMicButtonWakeWord() {
    const micBtn = this.micToggle;
    if (!micBtn) return;

    // Use pure CSS animation for visual consistency with other button states.
    // Reset the animation by removing the class, forcing reflow, and re-adding.
    micBtn.classList.remove('wake-word-detected');
    void micBtn.offsetWidth; // Force DOM reflow to restart CSS animation
    micBtn.classList.add('wake-word-detected');

    // Clear any existing cleanup timeout
    if (this._wakeWordTimeout) {
      clearTimeout(this._wakeWordTimeout);
    }
    
    // Set a new timeout to clean up the class after the animation completes
    // (Animation duration is 500ms in CSS, use 600ms here as a buffer)
    this._wakeWordTimeout = setTimeout(() => {
      micBtn.classList.remove('wake-word-detected');
      this._wakeWordTimeout = null;
    }, 600);

    this.log.debug('[HandsfreeUIController] Wake word visual feedback triggered via CSS');
  }

  // ── Lifecycle ──────────────────────────────────────────────

  _updateMicVisibility(enabled) {
    if (!this.micToggle) return;
    
    // Disable coordinator if turning off
    if (!enabled && this.handsfreeCoordinator && this.handsfreeCoordinator.isEnabled()) {
      this.handsfreeCoordinator.disable().catch(err => {
        this.log.error('[HandsfreeUIController] Failed to disable handsfree coordinator when visibility turned off:', err);
      });
    }

    // Toggle main button
    this.micToggle.style.display = enabled ? 'flex' : 'none';
    
    // Toggle waveform
    if (this.micWaveform) {
      this.micWaveform.style.display = enabled ? 'flex' : 'none';
    }
    
    // Toggle state label
    const stateLabel = document.getElementById('mic-state-label');
    if (stateLabel) {
      stateLabel.style.display = enabled ? '' : 'none';
    }
    
    // Check global toggle consistency if the element exists
    const globalToggle = document.getElementById('handsfree-enabled');
    if (globalToggle && globalToggle.checked !== enabled) {
        globalToggle.checked = enabled;
    }
  }

  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;

    // Clean EventBus subscriptions
    for (const cleanup of this._eventBusCleanup) {
      try {
        if (typeof cleanup === 'function') cleanup();
      } catch (error) {
        this.log.error('[HandsfreeUIController] Failed to cleanup EventBus listener:', error);
      }
    }
    this._eventBusCleanup = [];

    // Clean up live waveform
    if (this._liveWaveform) {
      this._liveWaveform.dispose();
      this._liveWaveform = null;
    }

    if (this._wakeWordTimeout) {
      clearTimeout(this._wakeWordTimeout);
      this._wakeWordTimeout = null;
    }

    // Clean up handsfree coordinator
    if (this.handsfreeCoordinator && typeof this.handsfreeCoordinator.dispose === 'function') {
      this.handsfreeCoordinator.dispose();
      this.handsfreeCoordinator = null;
    }

    // Clean up handsfree conversation display
    if (this.handsfreeConversationDisplay && typeof this.handsfreeConversationDisplay.dispose === 'function') {
      this.handsfreeConversationDisplay.dispose();
      this.handsfreeConversationDisplay = null;
    }

    this.audioManager = null;
    this.audioServices = null;
    this.eventBus = null;
    this.endpoint = null;
    this.micToggle = null;
    this.micWaveform = null;
  }
}

module.exports = HandsfreeUIController;
