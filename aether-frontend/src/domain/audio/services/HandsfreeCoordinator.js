'use strict';

/**
 * @.architecture
 * 
 * Incoming: AudioManager events (audio:stt-final, audio:tts-queued, audio:tts-completed, audio:level-updated), User commands (enable/disable/toggle), Backend WebSocket events (stt results, llm responses) --- {EventBus.events | method_calls | ws_messages, object}
 * Processing: State machine (IDLE → LISTENING → PROCESSING → SPEAKING → IDLE, SPEAKING → INTERRUPTED → LISTENING on user speech), transition validation (check current state before transition), EventBus subscription management (track all subscriptions for cleanup), interruption detection (monitor audio:level-updated with source:'stt' during SPEAKING state, threshold comparison), auto-flow coordination (LISTENING: start mic via AudioManager, PROCESSING: wait for backend, SPEAKING: play TTS via AudioManager, loop back to LISTENING), state persistence (track previous state for recovery), cleanup (unsubscribe all EventBus listeners, stop mic/TTS, reset state) --- {8 jobs: JOB_DISPOSE, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_INITIALIZE, JOB_START, JOB_STOP, JOB_TRANSITION_STATE, JOB_VALIDATE_SCHEMA}
 * Outgoing: EventBus.emit() (handsfree:state-changed, handsfree:enabled/disabled, handsfree:interruption-detected, handsfree:mode-changed), AudioManager method calls (startMicrophone/stopMicrophone for LISTENING state, playNextTTS/stopTTS for SPEAKING state), return state/status --- {events | method_calls, object}
 * 
 * 
 * @module domain/audio/services/HandsfreeCoordinator
 * 
 * HandsfreeCoordinator - State machine for handsfree voice interaction
 * ========================================================================
 * Coordinates VAD-driven auto-flow: user speaks → backend processes → TTS responds → loop
 * 
 * State Machine:
 * - IDLE: Handsfree mode disabled
 * - LISTENING: Mic active, waiting for user speech (VAD running in backend)
 * - PROCESSING: Speech detected, waiting for LLM response
 * - SPEAKING: TTS playing agent response
 * - INTERRUPTED: User spoke during TTS, cancel TTS and return to LISTENING
 * 
 * Transitions:
 * - IDLE → LISTENING: User enables handsfree (calls enable())
 * - LISTENING → PROCESSING: Backend emits audio:stt-final (VAD detected speech end)
 * - PROCESSING → SPEAKING: Backend emits audio:tts-queued (LLM response ready)
 * - SPEAKING → LISTENING: TTS completes (audio:tts-completed), auto-loop back to listening
 * - SPEAKING → INTERRUPTED: User interrupts (audio:level-updated with source:'stt' spike during TTS)
 * - INTERRUPTED → LISTENING: Interruption handled, mic reactivated
 * - ANY → IDLE: User disables handsfree (calls disable())
 * 
 * Dependencies:
 * - EventBus: For state changes and cross-module communication
 * - AudioManager: For mic control and TTS playback
 */

const { EventTypes } = require('../../../core/events/EventTypes');

// Handsfree states
const HandsfreeState = {
  IDLE: 'idle',
  LISTENING: 'listening',
  PROCESSING: 'processing',
  SPEAKING: 'speaking',
  INTERRUPTED: 'interrupted',
};

class HandsfreeCoordinator {
  /**
   * @param {Object} dependencies - Injected dependencies
   * @param {Object} dependencies.eventBus - EventBus instance
   * @param {Object} dependencies.audioManager - AudioManager instance
   * @param {Object} dependencies.endpoint - Backend endpoint for WebSocket commands (ADDED for cancel-tts)
   * @param {Object} dependencies.config - Handsfree configuration
   */
  constructor(dependencies = {}) {
    // Logger injected via DI (domain layer must not depend on renderer).
    // Fallback: no-op logger.
    const noop = () => {};
    this.log = dependencies.log || { info: noop, warn: noop, error: noop, debug: noop, trace: noop };
    this.eventBus = dependencies.eventBus;
    this.audioManager = dependencies.audioManager;
    this.endpoint = dependencies.endpoint;  // ADDED: For sending cancel-tts WebSocket command
    this.config = dependencies.config || {
      interruptionThreshold: 0.15,  // Audio level threshold for interruption detection
      autoLoop: true,                // Auto-return to LISTENING after TTS completes
      vadTimeout: 30000,             // Max time in LISTENING before timeout (ms)
    };

    // State
    this._currentState = HandsfreeState.IDLE;
    this._previousState = null;
    this._enabled = false;
    this._isDisposed = false;
    this._streamId = null;
    this._vadTimeoutId = null;
    this._autoLoopTimeoutId = null;  // TTS-completed debounce timer

    // EventBus subscriptions (tracked for cleanup)
    this._eventBusCleanups = [];

    // Conversational Filler
    this._fillerTimeoutId = null;
    this._fillerCache = null; // Can be populated with base64 PCM16 of "Hmm..." from Qwen3

    // Interruption detection
    this._ttsAudioLevel = 0;
    this._sttAudioLevel = 0;
    this._isMonitoringInterruption = false;

    if (!this.eventBus) {
      throw new Error('[HandsfreeCoordinator] eventBus required');
    }
    if (!this.audioManager) {
      throw new Error('[HandsfreeCoordinator] audioManager required');
    }
    // endpoint is optional (not required for basic functionality)

    this.log.info('HandsfreeCoordinator: Initialized');
  }

  /**
   * Initialize coordinator and setup EventBus subscriptions
   * @returns {Promise<void>}
   */
  async initialize() {
    try {
      this._setupEventBusListeners();
      this.log.info('HandsfreeCoordinator: Setup complete');
    } catch (error) {
      this.log.error('[HandsfreeCoordinator] initialize failed:', error);
      throw error;
    }
  }

  /**
   * Setup EventBus subscriptions
   * @private
   */
  _setupEventBusListeners() {
    if (!this.eventBus) return;

    // STT final: LISTENING → PROCESSING
    const sttFinalCleanup = this.eventBus.on(EventTypes.AUDIO.STT_FINAL, (data) => {
      this._handleSTTFinal(data);
    });
    this._eventBusCleanups.push(sttFinalCleanup);

    // TTS queued: PROCESSING → SPEAKING
    const ttsQueuedCleanup = this.eventBus.on(EventTypes.AUDIO.TTS_QUEUED, (data) => {
      this._handleTTSQueued(data);
    });
    this._eventBusCleanups.push(ttsQueuedCleanup);

    // TTS completed: SPEAKING → LISTENING (auto-loop)
    const ttsCompletedCleanup = this.eventBus.on(EventTypes.AUDIO.TTS_COMPLETED, (data) => {
      this._handleTTSCompleted(data);
    });
    this._eventBusCleanups.push(ttsCompletedCleanup);

    // Audio level updates: Monitor for interruption during TTS
    const levelUpdatedCleanup = this.eventBus.on(EventTypes.AUDIO.LEVEL_UPDATED, (data) => {
      this._handleAudioLevelUpdate(data);
    });
    this._eventBusCleanups.push(levelUpdatedCleanup);
    
    // Frontend TTS error: SPEAKING → LISTENING (recovery from AudioManager TTS failures)
    const ttsErrorCleanup = this.eventBus.on(EventTypes.AUDIO.TTS_ERROR, (data) => {
      this._handleTTSError(data);
    });
    this._eventBusCleanups.push(ttsErrorCleanup);
    
    // Backend TTS error: SPEAKING/PROCESSING → LISTENING (recovery from backend synthesis failures)
    const ttsBackendErrorCleanup = this.eventBus.on(EventTypes.AUDIO.TTS_BACKEND_ERROR, (data) => {
      this._handleTTSError(data);
    });
    this._eventBusCleanups.push(ttsBackendErrorCleanup);
    
    // Backend interruption detected: backend cleared TTS queues, frontend should transition
    const interruptionCleanup = this.eventBus.on(EventTypes.AUDIO.INTERRUPTION_DETECTED, (data) => {
      this._handleBackendInterruption(data);
    });
    this._eventBusCleanups.push(interruptionCleanup);
    
    // TTS audio chunk: Decode and play via AudioManager
    const ttsAudioCleanup = this.eventBus.on(EventTypes.AUDIO.TTS_AUDIO, async (data) => {
      await this._handleTTSAudio(data);
    });
    this._eventBusCleanups.push(ttsAudioCleanup);
    
    // Sleep word detected: Disable handsfree mode
    const sleepWordCleanup = this.eventBus.on(EventTypes.AUDIO.SLEEP_WORD_DETECTED, () => {
      this._handleSleepWordDetected();
    });
    this._eventBusCleanups.push(sleepWordCleanup);
  }

  /**
   * Enable handsfree mode: IDLE → LISTENING
   * @returns {Promise<void>}
   */
  async enable() {
    if (this._isDisposed) return;
    if (this._enabled) {
      this.log.warn('[HandsfreeCoordinator] Already enabled');
      return;
    }

    try {
      this._enabled = true;
      await this._transition(HandsfreeState.LISTENING);
      
      if (this.eventBus) {
        this.eventBus.emit(EventTypes.HANDSFREE.ENABLED, {
          timestamp: Date.now(),
        });
      }

      this.log.info('HandsfreeCoordinator: Enabled');
    } catch (error) {
      this.log.error('[HandsfreeCoordinator] Failed to enable:', error);
      this._enabled = false;
      throw error;
    }
  }

  /**
   * Disable handsfree mode: ANY → IDLE
   * @returns {Promise<void>}
   */
  async disable() {
    if (!this._enabled) {
      return;
    }

    try {
      this._enabled = false;
      await this._transition(HandsfreeState.IDLE);
      
      if (this.eventBus) {
        this.eventBus.emit(EventTypes.HANDSFREE.DISABLED, {
          timestamp: Date.now(),
        });
      }

      this.log.info('HandsfreeCoordinator: Disabled');
    } catch (error) {
      this.log.error('[HandsfreeCoordinator] Failed to disable:', error);
      throw error;
    }
  }

  /**
   * Toggle handsfree mode
   * @returns {Promise<void>}
   */
  async toggle() {
    if (this._enabled) {
      await this.disable();
    } else {
      await this.enable();
    }
  }

  /**
   * Get current state
   * @returns {string}
   */
  getState() {
    return this._currentState;
  }

  /**
   * Check if handsfree is enabled
   * @returns {boolean}
   */
  isEnabled() {
    return this._enabled;
  }

  /**
   * Get current status
   * @returns {Object}
   */
  getStatus() {
    return {
      enabled: this._enabled,
      state: this._currentState,
      previousState: this._previousState,
      streamId: this._streamId,
      monitoring: this._isMonitoringInterruption,
    };
  }

  /**
   * State transition with validation
   * @private
   * @param {string} newState - Target state
   * @returns {Promise<void>}
   */
  async _transition(newState) {
    const oldState = this._currentState;

    // Validate transition
    if (!this._isValidTransition(oldState, newState)) {
      this.log.warn(`[HandsfreeCoordinator] Invalid transition: ${oldState} → ${newState}`);
      return;
    }

    this._previousState = oldState;
    this._currentState = newState;

    // Execute state entry actions
    await this._onStateEnter(newState);

    // Emit state change event
    if (this.eventBus) {
      this.eventBus.emit(EventTypes.HANDSFREE.STATE_CHANGED, {
        state: newState,
        previousState: oldState,
        timestamp: Date.now(),
      });
      
      // JARVIS-level: Emit visualizer state change for dramatic visual feedback
      // Map handsfree states to visualizer states
      const visualizerState = this._mapHandsfreeToVisualizerState(newState);
      if (visualizerState) {
        this.eventBus.emit(EventTypes.VISUALIZER.STATE_CHANGED, {
          state: visualizerState,
          source: 'handsfree',
          previousState: oldState,
          timestamp: Date.now(),
        });
      }
    }

    this.log.info(`HandsfreeCoordinator: ${oldState} → ${newState}`);
  }

  /**
   * Validate state transition
   * @private
   * @param {string} from - Current state
   * @param {string} to - Target state
   * @returns {boolean}
   */
  _isValidTransition(from, to) {
    const validTransitions = {
      [HandsfreeState.IDLE]: [HandsfreeState.LISTENING],
      [HandsfreeState.LISTENING]: [HandsfreeState.PROCESSING, HandsfreeState.IDLE],
      [HandsfreeState.PROCESSING]: [HandsfreeState.SPEAKING, HandsfreeState.LISTENING, HandsfreeState.IDLE],
      [HandsfreeState.SPEAKING]: [HandsfreeState.LISTENING, HandsfreeState.INTERRUPTED, HandsfreeState.PROCESSING, HandsfreeState.IDLE],
      [HandsfreeState.INTERRUPTED]: [HandsfreeState.LISTENING, HandsfreeState.PROCESSING, HandsfreeState.IDLE],
    };

    return validTransitions[from]?.includes(to) || to === HandsfreeState.IDLE;
  }

  /**
   * Execute actions on state entry
   * @private
   * @param {string} state - New state
   * @returns {Promise<void>}
   */
  async _onStateEnter(state) {
    if (state !== HandsfreeState.PROCESSING && this._fillerTimeoutId) {
      clearTimeout(this._fillerTimeoutId);
      this._fillerTimeoutId = null;
    }

    switch (state) {
      case HandsfreeState.IDLE:
        await this._onIdleEnter();
        break;
      case HandsfreeState.LISTENING:
        await this._onListeningEnter();
        break;
      case HandsfreeState.PROCESSING:
        await this._onProcessingEnter();
        break;
      case HandsfreeState.SPEAKING:
        await this._onSpeakingEnter();
        break;
      case HandsfreeState.INTERRUPTED:
        await this._onInterruptedEnter();
        break;
    }
  }

  /**
   * IDLE state entry: Stop all audio operations
   * @private
   * @returns {Promise<void>}
   */
  async _onIdleEnter() {
    // Stop microphone
    if (this._streamId && this.audioManager) {
      await this.audioManager.stopMicrophone(this._streamId);
      this._streamId = null;
    }

    // Stop TTS
    if (this.audioManager) {
      this.audioManager.stopTTS();
      this.audioManager.clearTTSQueue();
    }

    // Clear all timers
    if (this._vadTimeoutId) {
      clearTimeout(this._vadTimeoutId);
      this._vadTimeoutId = null;
    }
    if (this._autoLoopTimeoutId) {
      clearTimeout(this._autoLoopTimeoutId);
      this._autoLoopTimeoutId = null;
    }

    // Stop interruption monitoring
    this._isMonitoringInterruption = false;
  }

  /**
   * LISTENING state entry: Start microphone
   * @private
   * @returns {Promise<void>}
   */
  async _onListeningEnter() {
    try {
      if (!this.audioManager) {
        throw new Error('AudioManager not available');
      }

      // CRITICAL FIX: Only start mic if not already running (prevents duplicate streams).
      // Mic stays active through LISTENING → PROCESSING → SPEAKING → INTERRUPTED → LISTENING cycle.
      // Starting a new stream without stopping the old one leaks the previous MediaStream.
      if (!this._streamId) {
        this._streamId = await this.audioManager.startMicrophone({
          streamId: `handsfree-${Date.now()}`,
        });
        this.log.info(`HandsfreeCoordinator: Mic started (${this._streamId})`);
      } else {
        this.log.info(`HandsfreeCoordinator: Mic already active (${this._streamId}), reusing stream`);
      }

      // Set VAD timeout (fallback if backend doesn't respond)
      if (this.config.vadTimeout > 0) {
        if (this._vadTimeoutId) {
          clearTimeout(this._vadTimeoutId);
        }
        this._vadTimeoutId = setTimeout(() => {
          this.log.warn('[HandsfreeCoordinator] VAD timeout, returning to LISTENING');
          // Could transition to IDLE or stay in LISTENING depending on requirements
        }, this.config.vadTimeout);
      }
    } catch (error) {
      this.log.error('[HandsfreeCoordinator] Failed to start microphone:', error);
      await this._transition(HandsfreeState.IDLE);
    }
  }

  /**
   * PROCESSING state entry: Wait for backend response
   * @private
   * @returns {Promise<void>}
   */
  async _onProcessingEnter() {
    // CRITICAL FIX: Keep mic running for continuous conversation (like kokoro_conversational)
    // Backend VAD handles speech detection, no need to stop/restart mic
    // Mic stays active: LISTENING → PROCESSING → SPEAKING → LISTENING (continuous loop)
    
    // Clear VAD timeout
    if (this._vadTimeoutId) {
      clearTimeout(this._vadTimeoutId);
      this._vadTimeoutId = null;
    }

    this.log.info('HandsfreeCoordinator: Processing user speech (mic stays active)...');

    // NEW FIX: Fast-path conversational fillers to acknowledge turn immediately
    // If the system takes > 1000ms to transition to SPEAKING (i.e. waiting for LLM + TTS),
    // we inject a pre-synthesized/cached filler ("Hmm...") to cover dead air.
    this._fillerTimeoutId = setTimeout(() => {
      if (this._currentState === HandsfreeState.PROCESSING && this._enabled) {
        this.log.info('[HandsfreeCoordinator] Processing >1s, injecting conversational filler...');
        if (this._fillerCache) {
          try {
            // Play cached PCM16 filler (base64 string)
            this._handleTTSAudio({
              audio: this._fillerCache,
              format: 'pcm16',
              sample_rate: 24000
            });
          } catch (e) {
            this.log.error('Failed to play conversational filler:', e);
          }
        } else {
          // If no cache, emit a UI sound event as fallback
          if (this.eventBus) {
            this.eventBus.emit('ui:play-sound', { sound: 'thinking' });
          }
        }
      }
    }, 1000);
  }

  /**
   * SPEAKING state entry: Start interruption monitoring
   * @private
   * @returns {Promise<void>}
   */
  async _onSpeakingEnter() {
    // Start interruption monitoring
    this._isMonitoringInterruption = true;
    this._ttsAudioLevel = 0;
    this._sttAudioLevel = 0;

    this.log.info('HandsfreeCoordinator: Agent speaking, monitoring for interruption...');
  }

  /**
   * INTERRUPTED state entry: Handle user interruption
   * @private
   * @returns {Promise<void>}
   */
  async _onInterruptedEnter() {
    // Stop TTS immediately
    if (this.audioManager) {
      this.audioManager.stopTTS();
      this.audioManager.clearTTSQueue();
    }

    // Stop interruption monitoring
    this._isMonitoringInterruption = false;

    // Emit interruption event
    if (this.eventBus) {
      this.eventBus.emit(EventTypes.HANDSFREE.INTERRUPTION_DETECTED, {
        timestamp: Date.now(),
        ttsLevel: this._ttsAudioLevel,
        sttLevel: this._sttAudioLevel,
      });
    }

    this.log.info('HandsfreeCoordinator: User interrupted agent');

    // Transition back to LISTENING
    await this._transition(HandsfreeState.LISTENING);
  }

  /**
   * Handle STT final result: LISTENING → PROCESSING, or PROCESSING/SPEAKING → cancel TTS
   * @private
   * @param {Object} data - STT data
   */
  _handleSTTFinal(data) {
    // CRITICAL FIX: If user speaks during SPEAKING or PROCESSING state, cancel TTS backend generation
    // User interrupted agent → backend needs to stop generating + clear queues
    if (this._currentState === HandsfreeState.SPEAKING || this._currentState === HandsfreeState.PROCESSING) {
      this.log.info(`[HandsfreeCoordinator] User interrupted TTS during ${this._currentState}, sending cancel command`);
      
      // Send cancel-tts command to backend
      if (this.endpoint && this.endpoint.connection) {
        try {
          this.endpoint.connection.send(JSON.stringify({
            type: 'audio/cancel-tts'
          }));
          this.log.info('[HandsfreeCoordinator] 🔴 Sent cancel-tts to backend');
        } catch (error) {
          this.log.error('[HandsfreeCoordinator] Failed to send cancel-tts:', error);
        }
      } else {
        this.log.warn('[HandsfreeCoordinator] Cannot send cancel-tts: endpoint not available');
      }
      
      // Stop TTS playback immediately
      if (this.audioManager) {
        this.audioManager.stopTTS();
        this.audioManager.clearTTSQueue();
      }
      this._isMonitoringInterruption = false;
      
      // Transition to PROCESSING (backend already processing new LLM response based on the new STT)
      // If already in PROCESSING, this will just re-enter the state cleanly
      this._transition(HandsfreeState.PROCESSING);
      return;
    }
    
    // Handle STT during INTERRUPTED state (backend interruption-detected arrived first)
    // Backend is already processing new query, so transition directly to PROCESSING
    if (this._currentState === HandsfreeState.INTERRUPTED) {
      this.log.info('[HandsfreeCoordinator] STT during INTERRUPTED state, transitioning to PROCESSING');
      this._transition(HandsfreeState.PROCESSING);
      return;
    }
    
    // Normal flow: LISTENING → PROCESSING
    if (this._currentState !== HandsfreeState.LISTENING) {
      return;
    }

    this.log.info('[HandsfreeCoordinator] STT Final:', data.text);
    this._transition(HandsfreeState.PROCESSING);
  }

  /**
   * Handle TTS queued: PROCESSING → SPEAKING
   * @private
   * @param {Object} data - TTS data
   */
  _handleTTSQueued(data) {
    // Normal flow: PROCESSING → SPEAKING
    if (this._currentState === HandsfreeState.PROCESSING) {
      this.log.info('[HandsfreeCoordinator] TTS queued, transitioning to SPEAKING');
      this._transition(HandsfreeState.SPEAKING);
      return;
    }
    
    // Interruption race recovery: LISTENING → PROCESSING → SPEAKING
    // When backend interruption-detected arrives before stt-final, coordinator
    // transitions to LISTENING while backend is already generating new response.
    // tts-queued arrives with state=LISTENING. Fast-forward through PROCESSING.
    if (this._currentState === HandsfreeState.LISTENING) {
      this.log.info('[HandsfreeCoordinator] TTS queued during LISTENING (interruption race), fast-forwarding to SPEAKING');
      this._transition(HandsfreeState.PROCESSING);
      this._transition(HandsfreeState.SPEAKING);
      return;
    }
    
    // Ignore tts-queued in other states
  }

  /**
   * Handle TTS completed: SPEAKING → LISTENING (auto-loop)
   * @private
   * @param {Object} data - TTS data
   */
  _handleTTSCompleted(data) {
    // Accept in SPEAKING (normal) or PROCESSING (edge case: tts-queued was missed/empty response)
    if (this._currentState !== HandsfreeState.SPEAKING && this._currentState !== HandsfreeState.PROCESSING) {
      return;
    }
    
    // If still in PROCESSING (no audio was ever generated), skip debounce and return to LISTENING
    if (this._currentState === HandsfreeState.PROCESSING) {
      this.log.info('[HandsfreeCoordinator] TTS completed during PROCESSING (no audio generated), returning to LISTENING');
      if (this.config.autoLoop && this._enabled) {
        this._transition(HandsfreeState.LISTENING);
      } else {
        this._transition(HandsfreeState.IDLE);
      }
      return;
    }

    this.log.info('[HandsfreeCoordinator] TTS completed');

    // Stop interruption monitoring
    this._isMonitoringInterruption = false;

    // CRITICAL FIX: Add debounce delay before re-enabling mic
    // Prevents race condition where new STT chunks arrive before TTS audio finishes playing
    if (this.config.autoLoop && this._enabled) {
      const debounceMs = this.config.autoLoopDebounceMs || 800;
      this.log.info(`[HandsfreeCoordinator] Scheduling auto-loop transition in ${debounceMs}ms`);
      // Clear previous debounce timer if any (prevent stacking)
      if (this._autoLoopTimeoutId) {
        clearTimeout(this._autoLoopTimeoutId);
      }
      this._autoLoopTimeoutId = setTimeout(() => {
        this._autoLoopTimeoutId = null;
        // Only transition if still in SPEAKING state (not disrupted by interruption/error)
        // If state already moved to PROCESSING/INTERRUPTED/etc, don't force back to LISTENING
        if (this._enabled && this._currentState === HandsfreeState.SPEAKING) {
          this.log.info(`[HandsfreeCoordinator] Auto-loop: SPEAKING → LISTENING`);
          this._transition(HandsfreeState.LISTENING);
        } else if (!this._enabled) {
          this.log.info(`[HandsfreeCoordinator] Auto-loop skipped: handsfree disabled`);
        } else {
          this.log.info(`[HandsfreeCoordinator] Auto-loop skipped: state already moved to ${this._currentState}`);
        }
      }, debounceMs);
    } else {
      this.log.info(`[HandsfreeCoordinator] No auto-loop: transitioning to IDLE`);
      this._transition(HandsfreeState.IDLE);
    }
  }

  /**
   * Handle audio level updates: Detect interruption during TTS
   * @private
   * @param {Object} data - Audio level data
   */
  _handleAudioLevelUpdate(data) {
    // CRITICAL FIX: Disable frontend audio level interruption
    // Backend handles interruption via STT detection (more accurate, no false positives)
    // Audio level monitoring was causing false interruptions from:
    // - Ambient noise
    // - TTS playback echo
    // - Mic self-noise
    // Result: TTS never played, mic constantly restarted
    
    // Only track levels for visualization, do NOT trigger state transitions
    if (data.source === 'tts') {
      this._ttsAudioLevel = data.level;
    }
    
    if (data.source === 'stt' || !data.source) {
      this._sttAudioLevel = data.level;
    }
    
    // Backend interruption (via STT "Thank you." detection) is sufficient
    // See: audio_processor.py L524-537 - clears TTS queues on new speech
    // See: HandsfreeCoordinator.js L473-495 - sends cancel-tts on STT during SPEAKING
  }
  
  /**
   * Handle TTS error: SPEAKING/PROCESSING → LISTENING (recovery)
   * @private
   * @param {Object} data - TTS error data
   */
  _handleTTSError(data) {
    // Only handle errors during SPEAKING or PROCESSING states
    if (this._currentState !== HandsfreeState.SPEAKING && this._currentState !== HandsfreeState.PROCESSING) {
      return;
    }
    
    // Support both frontend (data.error) and backend (data.error_type + data.message) error formats
    const errorDetail = data.error || data.message || data.error_type || 'unknown';
    this.log.error('[HandsfreeCoordinator] TTS error occurred:', errorDetail);
    
    // Stop TTS playback (if any audio was playing)
    if (this.audioManager) {
      this.audioManager.stopTTS();
      this.audioManager.clearTTSQueue();
    }
    
    // Stop interruption monitoring
    this._isMonitoringInterruption = false;
    
    // Recover by returning to LISTENING (auto-loop)
    if (this.config.autoLoop && this._enabled) {
      this.log.info('[HandsfreeCoordinator] Recovering from TTS error → LISTENING');
      this._transition(HandsfreeState.LISTENING);
    } else {
      this._transition(HandsfreeState.IDLE);
    }
  }
  
  /**
   * Handle backend interruption event: backend detected user speech during TTS
   * Backend already cleared TTS queues — frontend needs to stop playback and transition
   * @private
   * @param {Object} data - Interruption data from backend
   */
  _handleBackendInterruption(data) {
    // Only handle interruption during SPEAKING state
    if (this._currentState !== HandsfreeState.SPEAKING) {
      return;
    }
    
    this.log.info('[HandsfreeCoordinator] Backend interruption detected, stopping TTS');
    
    // Stop TTS playback immediately (backend already cleared generation queues)
    if (this.audioManager) {
      this.audioManager.stopTTS();
      this.audioManager.clearTTSQueue();
    }
    
    // Stop interruption monitoring
    this._isMonitoringInterruption = false;
    
    // Transition to INTERRUPTED → auto-transitions to LISTENING
    this._transition(HandsfreeState.INTERRUPTED);
  }
  
  /**
   * Handle TTS audio chunk: Decode base64 PCM and play via AudioManager
   * @private
   * @param {Object} data - TTS audio data {audio, format, sample_rate}
   */
  async _handleTTSAudio(data) {
    // Only process audio during PROCESSING or SPEAKING states
    if (this._currentState !== HandsfreeState.PROCESSING && this._currentState !== HandsfreeState.SPEAKING) {
      this.log.warn('[HandsfreeCoordinator] Ignoring TTS audio in state:', this._currentState);
      return;
    }
    
    try {
      // Decode base64 PCM to ArrayBuffer
      const binaryString = atob(data.audio);  // data.audio is base64 string
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      // Queue via AudioManager (REUSE existing handleTTSAudio method)
      await this.audioManager.handleTTSAudio(bytes.buffer, {
        format: data.format,  // 'pcm16'
        sampleRate: data.sample_rate  // 24000
      });
      
      this.log.info(`[HandsfreeCoordinator] TTS audio queued (${bytes.length} bytes, ${data.sample_rate}Hz)`);
    } catch (error) {
      this.log.error('[HandsfreeCoordinator] Failed to process TTS audio:', error);
      // Don't crash handsfree mode on audio decode errors
    }
  }
  
  /**
   * Handle sleep word detected: Disable handsfree mode
   * @private
   */
  _handleSleepWordDetected() {
    this.log.info('[HandsfreeCoordinator] Sleep word detected, disabling handsfree');
    
    // Disable handsfree mode (transitions to IDLE, stops mic/TTS)
    this.disable().catch((error) => {
      this.log.error('[HandsfreeCoordinator] Failed to disable after sleep word:', error);
    });
  }

  /**
   * Map handsfree state to visualizer state for dramatic visual feedback
   * @private
   * @param {string} handsfreeState - HandsfreeState value
   * @returns {string|null} - Visualizer state ('listening', 'speaking', 'thinking', 'idle', etc.)
   */
  _mapHandsfreeToVisualizerState(handsfreeState) {
    const mapping = {
      [HandsfreeState.IDLE]: 'idle',
      [HandsfreeState.LISTENING]: 'listening',
      [HandsfreeState.PROCESSING]: 'thinking',
      [HandsfreeState.SPEAKING]: 'speaking',
      [HandsfreeState.INTERRUPTED]: 'listening',  // Transition back to listening visually
    };
    
    return mapping[handsfreeState] || null;
  }

  /**
   * Cleanup and release all resources
   */
  async cleanup() {
    if (this._isDisposed) return;
    this._isDisposed = true;

    // HIGH FIX: Await async disable() to ensure resources released before cleanup completes
    if (this._enabled) {
      try {
        await this.disable();
      } catch (error) {
        this.log.error('[HandsfreeCoordinator] cleanup disable failed:', error);
      }
    }

    // Cleanup EventBus subscriptions
    for (const cleanup of this._eventBusCleanups) {
      try {
        cleanup?.();
      } catch (error) {
        this.log.error('[HandsfreeCoordinator] EventBus cleanup failed:', error);
      }
    }
    this._eventBusCleanups = [];

    // Clear all timers
    if (this._vadTimeoutId) {
      clearTimeout(this._vadTimeoutId);
      this._vadTimeoutId = null;
    }
    if (this._autoLoopTimeoutId) {
      clearTimeout(this._autoLoopTimeoutId);
      this._autoLoopTimeoutId = null;
    }

    // Reset state
    this._currentState = HandsfreeState.IDLE;
    this._previousState = null;
    this._streamId = null;
    this._isMonitoringInterruption = false;

    // Release references
    this.eventBus = null;
    this.audioManager = null;
    this.endpoint = null;

    this.log.info('HandsfreeCoordinator: Cleanup complete');
  }
}

module.exports = { HandsfreeCoordinator, HandsfreeState };
