/**
 * @.architecture
 * Incoming: EventBus (handsfree:state-changed, proactive:stream-chunk, proactive:stream-end), DOM overlay element --- {events | dom_element, object}
 * Processing: Display proactive agent notifications and responses, show/hide overlay based on proactive content, manage message lifecycle (create, update, append chunks), handle user feedback (click/timeout) --- {4 jobs: JOB_CREATE_DOM_ELEMENT, JOB_DISPOSE, JOB_EMIT_EVENT, JOB_INITIALIZE}
 * Outgoing: DOM updates (proactive-notifications container), visual conversation display --- {dom_mutation, void}
 */

'use strict';

const { EventTypes } = require('../../../../core/events/EventTypes');
const { createRendererLogger } = require('../../../shared/utils/logger');

/**
 * HandsfreeConversationDisplay - Visual overlay for proactive agent notifications
 * ============================================================================
 * Displays proactive agent responses in real-time with typing effects.
 * 
 * Features:
 * - Real-time proactive streaming display
 * - Typing effect animation
 * - Auto-hide with timeout or user engagement
 * - Feedback loop for proactive notifications (POST to backend)
 */
class HandsfreeConversationDisplay {
  /**
   * @param {Object} dependencies - Injected dependencies
   * @param {Object} dependencies.eventBus - EventBus instance
   */
  constructor(dependencies = {}) {
    this.log = createRendererLogger('HandsfreeConversationDisplay');
    this.eventBus = dependencies.eventBus;
    this.apiBaseUrl = dependencies.apiBaseUrl || '';
    this.apiClient = dependencies.apiClient || null;
    
    // Proactive TTS config (separate from handsfree TTS)
    this._proactiveTts = {
      enabled: false,
      voice: 'Ryan',
      language: '',
      ...(dependencies.proactiveTts || {}),
    };
    
    // DOM elements
    this.overlay = null;
    this.proactiveContainer = null;
    
    // State
    this._isVisible = false;
    this._currentProactiveMessage = null;
    this._lastState = 'idle';
    this._hideTimeout = null;
    this._proactiveTimeoutId = null;
    this._proactiveAudioCtx = null;  // AudioContext for proactive TTS playback
    this._proactiveAudioSource = null;  // Current audio source node
    
    // Accumulated text for TTS (built from stream chunks)
    this._proactiveTextAccumulator = '';
    
    // Guard: run_id of a notification the user already interacted with
    // (clicked/dismissed). If chunks for this run_id keep arriving after
    // interaction, they are silently dropped to prevent the notification
    // from reappearing mid-stream after the user already acted on it.
    this._consumedRunId = null;
    
    // Interaction gate: true only after stream-end fires.
    // Click handler and dismiss are blocked while false.
    this._proactiveStreamComplete = false;
    
    // Stream-stall safety net: if no chunk arrives within this period,
    // treat the stream as complete (enables interaction). Prevents a
    // frozen notification when the WebSocket drops mid-stream.
    this._streamStallTimerId = null;
    this._STREAM_STALL_MS = 30000; // 30s — generous for LLM latency
    
    // Welcome mode state
    this._welcomeActive = false;
    this._welcomeTimerId = null;      // setInterval ID for character-by-character typing
    this._welcomeHideTimerId = null;  // setTimeout ID for auto-hide after typing
    
    // Proactive typing animation state
    this._proactiveCharQueue = '';
    this._proactiveTypingTimerId = null;
    this._streamIntervals = [];
    
    // Track DOM listeners
    this._domListeners = [];
    
    // EventBus cleanup
    this._eventBusCleanups = [];
    
    // Lifecycle flags
    this._isInitialized = false;
    this._isDisposed = false;
    
    if (!this.eventBus) {
      this.log.error('[HandsfreeConversationDisplay] EventBus is required');
    }
  }
  
  /**
   * Initialize display
   */
  async initialize() {
    if (this._isInitialized) {
      this.log.warn('[HandsfreeConversationDisplay] Already initialized');
      return;
    }
    
    try {
      // Get DOM elements
      this.overlay = document.getElementById('handsfree-conversation');
      this.proactiveContainer = document.getElementById('proactive-notifications-container');
      
      if (!this.overlay || !this.proactiveContainer) {
        this.log.error('[HandsfreeConversationDisplay] Required DOM elements not found');
        return;
      }
      
      // Subscribe to events
      this._setupEventListeners();
      
      this._isInitialized = true;
      this.log.debug('[HandsfreeConversationDisplay] Initialized (Proactive Only Mode)');
      
      // Phase 3 Enhancement: Recover missed notifications
      this._recoverMissedNotification();
    } catch (error) {
      this.log.error('[HandsfreeConversationDisplay] Initialize failed:', error);
      throw error;
    }
  }
  
  /**
   * Fetch and display any unseen proactive notifications from the backend
   */
  async _recoverMissedNotification() {
    if (!this.apiClient || this._isDisposed) return;
    try {
      const data = await this.apiClient.get('/v1/proactive/latest-unseen');
      if (data && data.has_unseen && data.recommendation) {
        this.log.info('[HandsfreeConversationDisplay] Recovered missed notification', { runId: data.run_id });
        
        // Split into words to simulate streaming network chunks
        const words = data.recommendation.split(/(?<=\s+)/);
        let currentWord = 0;
        
        const streamInterval = this._trackTimer('interval', () => {
          if (currentWord >= words.length || this._isDisposed) {
            clearInterval(streamInterval);
            // Clean up tracked interval
            this._streamIntervals = (this._streamIntervals || []).filter(id => id !== streamInterval);
            this._handleProactiveEnd({
              run_id: data.run_id,
              context: data.context,
              trace_id: data.trace_id,
            });
            return;
          }
          
          this._handleProactiveChunk({
            content: words[currentWord],
            run_id: data.run_id,
            // Only pass full context/recommendation on the first chunk
            context: currentWord === 0 ? data.context : undefined,
            recommendation: currentWord === 0 ? data.recommendation : undefined,
            trace_id: data.trace_id,
          });
          
          currentWord++;
        }, 30); // Simulate network streaming delay
        
        if (!this._streamIntervals) this._streamIntervals = [];
        this._streamIntervals.push(streamInterval);
      }
    } catch (error) {
      this.log.error('[HandsfreeConversationDisplay] Failed to recover missed notifications:', error);
    }
  }
  
  /**
   * Setup EventBus listeners
   */
  _setupEventListeners() {
    if (!this.eventBus) return;
    
    // Handsfree state changes (show/hide overlay)
    const onStateChanged = (data) => {
      this._handleStateChanged(data);
    };
    this.eventBus.on(EventTypes.HANDSFREE.STATE_CHANGED, onStateChanged);
    this._eventBusCleanups.push(() => {
      this.eventBus.off(EventTypes.HANDSFREE.STATE_CHANGED, onStateChanged);
    });

    // Proactive Notification streaming
    const onProactiveChunk = (data) => {
      this._handleProactiveChunk(data);
    };
    this.eventBus.on('proactive:stream-chunk', onProactiveChunk);
    this._eventBusCleanups.push(() => {
      this.eventBus.off('proactive:stream-chunk', onProactiveChunk);
    });

    const onProactiveEnd = (data) => {
      this._handleProactiveEnd(data);
    };
    this.eventBus.on('proactive:stream-end', onProactiveEnd);
    this._eventBusCleanups.push(() => {
      this.eventBus.off('proactive:stream-end', onProactiveEnd);
    });

    // Listen for settings changes to update proactive TTS config at runtime
    const onSettingsSaved = (data) => {
      if (data?.handsfree) {
        this.updateProactiveTtsConfig({
          enabled: !!data.handsfree.proactive_tts_enabled,
          voice: data.handsfree.proactive_tts_voice || 'Ryan',
          language: data.handsfree.proactive_tts_language || '',
        });
      }
    };
    this.eventBus.on(EventTypes.UI.SETTINGS_SAVED, onSettingsSaved);
    this._eventBusCleanups.push(() => {
      this.eventBus.off(EventTypes.UI.SETTINGS_SAVED, onSettingsSaved);
    });

    // Welcome mode events (frontend-only, no backend dependency)
    const onWelcomeStart = (data) => {
      const message = data?.message || 'Ready when you are.';
      this.showWelcome(message);
    };
    this.eventBus.on(EventTypes.WELCOME.START, onWelcomeStart);
    this._eventBusCleanups.push(() => {
      this.eventBus.off(EventTypes.WELCOME.START, onWelcomeStart);
    });

    const onWelcomeDismiss = () => {
      this.dismissWelcome();
    };
    this.eventBus.on(EventTypes.WELCOME.DISMISS, onWelcomeDismiss);
    this._eventBusCleanups.push(() => {
      this.eventBus.off(EventTypes.WELCOME.DISMISS, onWelcomeDismiss);
    });
    
    this.log.debug('[HandsfreeConversationDisplay] Event listeners setup (Suppressed main chat)');
  }
  
  /**
   * Handle Proactive stream chunk
   */
  _handleProactiveChunk(data) {
    this.log.debug('[HandsfreeConversationDisplay] _handleProactiveChunk received data', {
      hasData: !!data,
      runId: data?.run_id,
      chunkLength: data?.content?.length || data?.chunk?.length || 0,
      hasContainer: !!this.proactiveContainer
    });

    // Backend sends "content", support legacy "chunk/text/delta" too
    const chunk = data?.content || data?.chunk || data?.text || data?.delta;
    if (!chunk || !this.proactiveContainer) {
      this.log.warn('[HandsfreeConversationDisplay] Ignoring chunk: missing chunk or proactiveContainer', {
        chunkValue: chunk,
        hasContainer: !!this.proactiveContainer
      });
      return;
    }

    // Proactive notifications always take priority over welcome messages.
    // Dismiss welcome (clears timers + DOM) before the proactive path creates its element.
    if (this._welcomeActive) {
      this.dismissWelcome();
    }

    // Guard: ignore chunks for a run_id the user already clicked/dismissed.
    // Without this, clicking mid-stream would remove the notification but
    // remaining chunks would recreate it (since _currentProactiveMessage is null).
    const incomingRunId = data?.run_id;
    if (incomingRunId && this._consumedRunId === incomingRunId) return;

    // EDGE CASE: New notification arriving while old is still displayed.
    // Detect run_id change → close old notification (send 'timeout' feedback)
    // and start fresh. Without this, new chunks append to the old message.
    if (this._currentProactiveMessage && incomingRunId) {
      const currentRunId = this._currentProactiveMessage.dataset.runId;
      if (currentRunId && currentRunId !== incomingRunId) {
        this.log.debug(`[HandsfreeConversationDisplay] New notification (${incomingRunId}) replacing old (${currentRunId})`);
        // Send timeout feedback for the old one (user never interacted)
        this._sendProactiveFeedback(currentRunId, 'timeout');
        if (this._proactiveTimeoutId) {
          clearTimeout(this._proactiveTimeoutId);
          this._proactiveTimeoutId = null;
        }
        if (this._streamStallTimerId) {
          clearTimeout(this._streamStallTimerId);
          this._streamStallTimerId = null;
        }
        if (this._proactiveTypingTimerId) {
          clearInterval(this._proactiveTypingTimerId);
          this._proactiveTypingTimerId = null;
        }
        this._stopProactiveAudio();
        this._clearListenersForElement(this._currentProactiveMessage);
        this._currentProactiveMessage.remove();
        this._currentProactiveMessage = null;
        this._proactiveTextAccumulator = '';
        this._proactiveCharQueue = '';
      }
    }

    // Accumulate text for TTS synthesis at stream-end
    this._proactiveTextAccumulator += chunk;

    if (!this._currentProactiveMessage) {
      // New notification stream — stop any playing TTS from prior notification
      this._stopProactiveAudio();
      this.proactiveContainer.innerHTML = ''; // Clear previous
      this._proactiveStreamComplete = false; // Gate interactions until stream-end
      this._currentProactiveMessage = this._createMessage('assistant', '', `proactive-${Date.now()}`);
      
      // Store run_id and context for feedback tracking and chat opening
      const runId = data?.run_id;
      const context = data?.context;
      const fullRecommendation = data?.recommendation;
      
      if (runId) {
        this._currentProactiveMessage.dataset.runId = runId;
      }
      
      // Store context for chat opening on click
      if (context) {
        this._currentProactiveMessage.dataset.context = JSON.stringify(context);
      }
      
      // Store full recommendation
      if (fullRecommendation) {
        this._currentProactiveMessage.dataset.recommendation = fullRecommendation;
      }

      if (data?.trace_id || data?.traceId) {
        this._currentProactiveMessage.dataset.traceId = data.trace_id || data.traceId;
      }
      
      // Phase 4 UX enhancement: Render source attribution tags
      if (context) {
        this._insertSourceTag(this._currentProactiveMessage, context);
      }
      
      // INTERACTION GATING: No clicks allowed until stream completes.
      // During streaming the notification is read-only — cursor stays default,
      // pointer events are disabled on clickable targets. Stream-end enables both
      // the click handler and the dismiss button simultaneously.
      this._currentProactiveMessage.style.cursor = 'default';
      
      const clickHandler = (event) => {
        // ANY touch/click on the notification area stops TTS immediately,
        // even mid-stream. User signalled they're reading — no need for audio.
        this._stopProactiveAudio();
        
        if (!this._proactiveStreamComplete) return; // Full action blocked until stream-end
        if (event.target.closest('.proactive-dismiss-btn')) return;
        event.stopPropagation();
        this._handleProactiveClick(runId, fullRecommendation);
      };
      
      // Attach listeners now but keep them inert via pointerEvents: none.
      // _handleProactiveEnd flips pointerEvents to 'auto' and cursor to 'pointer'.
      this._trackListener(this._currentProactiveMessage, 'click', clickHandler, { capture: true });
      
      const contentEl = this._currentProactiveMessage.querySelector('.handsfree-message-content');
      if (contentEl) {
        this._trackListener(contentEl, 'click', clickHandler, { capture: true });
      }

      // UX FIX: Pause auto-hide timeout on hover
      this._isMessageHovered = false;
      this._trackListener(this._currentProactiveMessage, 'mouseenter', () => {
        this._isMessageHovered = true;
        if (this._proactiveTimeoutId) {
          clearTimeout(this._proactiveTimeoutId);
          this._proactiveTimeoutId = null;
          this.log.debug('[HandsfreeConversationDisplay] Paused auto-hide timer due to hover');
        }
      });
      
      this._trackListener(this._currentProactiveMessage, 'mouseleave', () => {
        this._isMessageHovered = false;
        if (this._proactiveStreamComplete) {
          this.log.debug('[HandsfreeConversationDisplay] Resumed auto-hide timer after hover');
          this._startAutoHideTimer(runId, 5000); // give 5 seconds after mouse leave
        }
      });

      // Dismiss button — hidden until stream-end
      const dismissBtn = document.createElement('button');
      dismissBtn.className = 'proactive-dismiss-btn';
      dismissBtn.innerHTML = '<i class="fas fa-times"></i>';
      dismissBtn.title = 'Dismiss notification';
      dismissBtn.style.display = 'none';
      this._trackListener(dismissBtn, 'click', (event) => {
        event.stopPropagation();
        this._handleProactiveDismiss(runId);
      });
      this._currentProactiveMessage.appendChild(dismissBtn);
      
      this.proactiveContainer.appendChild(this._currentProactiveMessage);
      this.show();
    }

    const content = this._currentProactiveMessage.querySelector('.handsfree-message-content');
    if (content) {
      this._proactiveCharQueue += chunk;
      content.classList.add('typing');
      
      if (!this._proactiveTypingTimerId) {
        this._proactiveTypingTimerId = this._trackTimer('interval', () => {
          if (this._isDisposed || !this._currentProactiveMessage) {
            if (this._proactiveTypingTimerId) {
              clearInterval(this._proactiveTypingTimerId);
              this._proactiveTypingTimerId = null;
            }
            return;
          }
          const el = this._currentProactiveMessage.querySelector('.handsfree-message-content');
          if (el && this._proactiveCharQueue.length > 0) {
            // Accelerate typing if queue gets long to prevent lag
            const charsToType = Math.max(1, Math.floor(this._proactiveCharQueue.length / 10));
            el.textContent += this._proactiveCharQueue.slice(0, charsToType);
            this._proactiveCharQueue = this._proactiveCharQueue.slice(charsToType);
          } else if (this._proactiveStreamComplete && this._proactiveCharQueue.length === 0) {
            if (this._proactiveTypingTimerId) {
              clearInterval(this._proactiveTypingTimerId);
              this._proactiveTypingTimerId = null;
            }
            if (el) el.classList.remove('typing');
          }
        }, 15); // ~66 cycles/sec
      }
    }

    // Reset stream-stall timer on every chunk. If no chunk or stream-end
    // arrives within _STREAM_STALL_MS, auto-complete the stream so the
    // notification becomes interactive (prevents frozen UI on WS drop).
    if (this._streamStallTimerId) clearTimeout(this._streamStallTimerId);
    this._streamStallTimerId = this._trackTimer('timeout', () => {
      this._streamStallTimerId = null;
      if (!this._proactiveStreamComplete && this._currentProactiveMessage) {
        this.log.warn('[HandsfreeConversationDisplay] Stream stall detected — auto-completing');
        this._handleProactiveEnd({});
      }
    }, this._STREAM_STALL_MS);
  }

  /**
   * Handle Proactive stream end
   */
  _handleProactiveEnd(data) {
    this.log.debug('[HandsfreeConversationDisplay] _handleProactiveEnd called', { runId: data?.run_id });
    // Cancel stall timer — stream ended normally (or stall already fired)
    if (this._streamStallTimerId) {
      clearTimeout(this._streamStallTimerId);
      this._streamStallTimerId = null;
    }

    // Guard: if the stall timer already auto-completed this stream,
    // skip the real stream-end to prevent duplicate TTS synthesis
    // and leaked auto-hide timers. Context was provided in the first
    // chunk (FIX 4), so nothing useful is lost.
    if (this._proactiveStreamComplete) return;

    // Capture accumulated text and reset for next notification
    const fullText = this._proactiveTextAccumulator.trim();
    this._proactiveTextAccumulator = '';

    // Synthesize and play TTS if enabled
    if (this._proactiveTts.enabled && fullText.length > 0) {
      this._synthesizeAndPlayProactiveTts(fullText);
    }

    if (this._currentProactiveMessage) {
      // STREAM COMPLETE → enable all interaction (click + dismiss).
      // During streaming, cursor was 'default', dismiss hidden, clicks blocked.
      this._proactiveStreamComplete = true;
      this._currentProactiveMessage.style.cursor = 'pointer';
      const contentEl = this._currentProactiveMessage.querySelector('.handsfree-message-content');
      if (contentEl) contentEl.style.cursor = 'pointer';
      
      const dismissBtn = this._currentProactiveMessage.querySelector('.proactive-dismiss-btn');
      if (dismissBtn) dismissBtn.style.display = '';
      
      const runId = this._currentProactiveMessage.dataset.runId;
      
      // Update stored context if provided in stream-end
      if (data?.context && this._currentProactiveMessage) {
        this._currentProactiveMessage.dataset.context = JSON.stringify(data.context);
      }
      if (data?.trace_id || data?.traceId) {
        this._currentProactiveMessage.dataset.traceId = data.trace_id || data.traceId;
      }
      
      // Auto-hide timeout: reading time OR estimated TTS duration, whichever is longer.
      // Reading speed: ~80 words/min (chars * 50ms).
      // TTS duration: ~150 words/min → ~5 chars/s → ~200ms/char + 3s synth latency.
      const contentLength = contentEl?.textContent?.length || 0;
      const estimatedReadTime = Math.max(15000, Math.min(contentLength * 50, 30000)); // 15-30s
      let estimatedTtsDuration = 0;
      if (this._proactiveTts.enabled && contentLength > 0) {
        estimatedTtsDuration = Math.ceil(contentLength * 200) + 5000; // ~200ms/char + 5s overhead
      }
      const duration = data?.duration || Math.max(estimatedReadTime, estimatedTtsDuration);
      
      this.log.debug(`[HandsfreeConversationDisplay] Proactive notification will auto-hide in ${duration/1000}s`);
      
      if (duration > 0) {
        this._proactiveDefaultDuration = duration;
        if (!this._isMessageHovered) {
          this._startAutoHideTimer(runId, duration);
        } else {
          this.log.debug(`[HandsfreeConversationDisplay] Auto-hide timer deferred due to hover`);
        }
      } else {
        this._currentProactiveMessage = null;
      }
    }
  }

  /**
   * Start the auto-hide timer for proactive notifications
   * @param {string} runId 
   * @param {number} duration 
   */
  _startAutoHideTimer(runId, duration) {
    if (this._proactiveTimeoutId) {
      clearTimeout(this._proactiveTimeoutId);
    }
    this._proactiveTimeoutId = this._trackTimer('timeout', () => {
      if (this._currentProactiveMessage && this._currentProactiveMessage.dataset.runId === runId) {
        this._handleProactiveTimeout(runId);
        this._stopProactiveAudio(); // Stop TTS when notification auto-hides
        this._clearListenersForElement(this._currentProactiveMessage);
        this._currentProactiveMessage.remove();
        this._currentProactiveMessage = null;
        this._handleStateChanged(); // Re-evaluate visibility
      }
    }, duration);
  }
  
  /**
   * Handle proactive notification click (user engaged)
   */
  _handleProactiveClick(runId, recommendation) {
    if (!runId) {
      this.log.warn('[HandsfreeConversationDisplay] No run_id - cannot process click');
      return;
    }
    
    // Mark this run_id as consumed — remaining stream chunks will be dropped
    this._consumedRunId = runId;
    
    if (this._proactiveTimeoutId) {
      clearTimeout(this._proactiveTimeoutId);
      this._proactiveTimeoutId = null;
    }
    
    // Stop proactive TTS when user clicks (they're engaging, no need to keep reading)
    this._stopProactiveAudio();
    
    // Send feedback
    this._sendProactiveFeedback(runId, 'clicked');
    
    // Open chat with proactive context
    this._openChatWithProactiveContext(runId, recommendation);
    
    // Remove notification
    if (this._currentProactiveMessage) {
      this._clearListenersForElement(this._currentProactiveMessage);
      this._currentProactiveMessage.remove();
      this._currentProactiveMessage = null;
      this._handleStateChanged();
    }
  }
  
  /**
   * Handle proactive notification dismiss (user explicitly closed via X button)
   */
  _handleProactiveDismiss(runId) {
    if (this._proactiveTimeoutId) {
      clearTimeout(this._proactiveTimeoutId);
      this._proactiveTimeoutId = null;
    }

    // Mark this run_id as consumed to prevent stray delayed chunks from resurrecting it
    this._consumedRunId = runId;
    
    // Stop TTS
    this._stopProactiveAudio();
    
    // Send 'dismissed' feedback
    this._sendProactiveFeedback(runId, 'dismissed');
    
    // Remove notification
    if (this._currentProactiveMessage) {
      this._clearListenersForElement(this._currentProactiveMessage);
      this._currentProactiveMessage.remove();
      this._currentProactiveMessage = null;
      this._handleStateChanged();
    }
    
    this.log.debug(`[HandsfreeConversationDisplay] User dismissed notification (run_id: ${runId})`);
  }
  
  // ── Welcome Mode ──────────────────────────────────────────

  /**
   * Display a warm welcome message with character-by-character typing effect.
   * Reuses the proactive overlay DOM. Purely frontend — no backend calls.
   *
   * @param {string} message - The welcome text to type out
   */
  showWelcome(message) {
    if (this._isDisposed || !this.proactiveContainer) return;

    // Do not clobber an active proactive notification — it has run_id tracking,
    // feedback loops, and TTS. The welcome is cosmetic; proactive is functional.
    if (this._currentProactiveMessage) return;

    // Clear any previous welcome that is still typing or visible
    this.dismissWelcome();

    const messageEl = this._createMessage('assistant', '', 'welcome-msg');
    messageEl.classList.add('welcome-message');
    this.proactiveContainer.innerHTML = '';
    this.proactiveContainer.appendChild(messageEl);

    const contentEl = messageEl.querySelector('.handsfree-message-content');
    if (!contentEl) return;

    contentEl.classList.add('typing');
    this._welcomeActive = true;
    this.show();

    // Type out character-by-character at ~30ms per char (~33 chars/sec).
    // Total for a 40-char message: ~1.2 seconds — fast but readable.
    let charIndex = 0;
    this._welcomeTimerId = this._trackTimer('interval', () => {
      if (this._isDisposed || !this._welcomeActive) {
        this._clearWelcomeTyping();
        return;
      }

      if (charIndex < message.length) {
        contentEl.textContent += message[charIndex];
        charIndex++;
      } else {
        // Typing complete — remove cursor, schedule auto-hide
        this._clearWelcomeTyping();
        contentEl.classList.remove('typing');

        // Auto-hide after 14 seconds — stays visible through most of the demo
        // sequence so the user has time to read and appreciate the orb showcase.
        this._welcomeHideTimerId = this._trackTimer('timeout', () => {
          this.dismissWelcome();
        }, 14000);
      }
    }, 42);

    this.log.debug(`[HandsfreeConversationDisplay] Welcome started: "${message}"`);
  }

  /**
   * Dismiss the active welcome message immediately.
   * Clears typing interval, auto-hide timeout, and removes DOM element.
   */
  dismissWelcome() {
    this._clearWelcomeTyping();

    if (this._welcomeHideTimerId) {
      clearTimeout(this._welcomeHideTimerId);
      this._welcomeHideTimerId = null;
    }

    if (this._welcomeActive) {
      const welcomeEl = this.proactiveContainer
        ? this.proactiveContainer.querySelector('#welcome-msg')
        : null;
      if (welcomeEl) {
        this._clearListenersForElement(welcomeEl);
        welcomeEl.remove();
      }
      this._welcomeActive = false;
      this._handleStateChanged(); // Re-evaluate overlay visibility
    }
  }

  /**
   * Clear the welcome typing interval (safe to call multiple times).
   */
  _clearWelcomeTyping() {
    if (this._welcomeTimerId) {
      clearInterval(this._welcomeTimerId);
      this._welcomeTimerId = null;
    }
  }

  /**
   * Whether the welcome overlay is currently displayed.
   * @returns {boolean}
   */
  get isWelcomeActive() {
    return this._welcomeActive;
  }

  // ── Proactive Chat ──────────────────────────────────────

  /**
   * Open chat window with proactive context pre-loaded
   */
  _openChatWithProactiveContext(runId, recommendation) {
    if (!this.eventBus) return;
    
    try {
      // ARCHITECTURE: Notification and seeded chat show recommendation text only.
      // Structured proactive context is persisted in backend via run_id.
      // We pass runId to allow backend hydration for follow-up turns without sending massive objects over IPC.
      
      this.eventBus.emit('proactive:open-chat', {
        initialMessage: recommendation || '',  // Clean recommendation only
        runId: runId,                          // Reference to backend context
        isProactive: true,
      });
      
      this.log.debug('[HandsfreeConversationDisplay] Opened chat with proactive context');
      
    } catch (error) {
      this.log.error('[HandsfreeConversationDisplay] Failed to open chat:', error);
    }
  }
  
  /**
   * Handle proactive notification timeout (user ignored)
   */
  _handleProactiveTimeout(runId) {
    if (!runId) return;

    // Mark this run_id as consumed to prevent stray delayed chunks from resurrecting it
    this._consumedRunId = runId;

    this._sendProactiveFeedback(runId, 'timeout');
  }
  
  /**
   * Send user feedback to backend API
   */
  _sendProactiveFeedback(runId, feedback) {
    if (!runId || !this.apiClient) return;
    
    try {
      this.apiClient.post(`/v1/proactive/${runId}/feedback?feedback=${feedback}`)
      .catch(error => this.log.error('[HandsfreeConversationDisplay] Feedback error:', error));
    } catch (error) {
      this.log.error('[HandsfreeConversationDisplay] Failed to send feedback:', error);
    }
  }
  
  /**
   * Update proactive TTS configuration at runtime (e.g. after settings save).
   * @param {Object} config - { enabled: bool, voice: string, language: string }
   */
  updateProactiveTtsConfig(config) {
    if (config && typeof config === 'object') {
      this._proactiveTts = { ...this._proactiveTts, ...config };
      this.log.debug('[HandsfreeConversationDisplay] Proactive TTS config updated:', this._proactiveTts);
    }
  }

  /**
   * Synthesize proactive notification text via backend TTS API and play audio.
   * Uses the proactive-specific voice/language (independent of handsfree TTS).
   * @param {string} text - Full notification text to speak
   */
  async _synthesizeAndPlayProactiveTts(text) {
    if (!text || !this.apiClient) return;

    try {
      // Stop any currently playing proactive audio
      this._stopProactiveAudio();

      const audioData = await this.apiClient.post('/v1/tts/synthesize', {
        text: text,
        engine: 'qwen3',
        voice: this._proactiveTts.voice || 'Ryan',
        language: this._proactiveTts.language || '',
      }, { responseType: 'arraybuffer' });
      if (!audioData || audioData.byteLength < 100) {
        this.log.warn('[HandsfreeConversationDisplay] Proactive TTS returned empty audio');
        return;
      }

      // Encode ArrayBuffer to base64
      let binary = '';
      const bytes = new Uint8Array(audioData);
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64Audio = btoa(binary);

      // Play via AudioManager
      if (window.audioManager) {
        // Use a unique ID to identify this as proactive TTS (so we can stop it if needed)
        this._proactiveAudioSourceId = 'proactive-' + Date.now();
        
        // Pass base64 to handleTTSAudio
        await window.audioManager.handleTTSAudio(base64Audio, { format: 'wav' });
        this.log.debug(`[HandsfreeConversationDisplay] Playing proactive TTS via AudioManager (${text.length} chars, voice=${this._proactiveTts.voice})`);
      } else {
        this.log.warn('[HandsfreeConversationDisplay] window.audioManager not available, cannot play proactive TTS');
      }

    } catch (error) {
      this.log.error('[HandsfreeConversationDisplay] Proactive TTS error:', error);
    }
  }

  /**
   * Stop any currently playing proactive TTS audio.
   */
  _stopProactiveAudio() {
    if (window.audioManager) {
      // audioManager.stopTTS stops all TTS playback
      // Since proactive notifications preempt everything else, stopping all TTS is correct
      try {
        window.audioManager.stopTTS();
        if (typeof window.audioManager.clearTTSQueue === 'function') {
          window.audioManager.clearTTSQueue();
        }
      } catch (error) {
        this.log.error('[HandsfreeConversationDisplay] Error stopping proactive TTS via AudioManager:', error);
      }
    }
    
    // Cleanup old direct AudioContext references (if any)
    if (this._proactiveAudioSource) {
      try {
        this._proactiveAudioSource.stop();
      } catch (_) { /* already stopped */ }
      this._proactiveAudioSource = null;
    }
    if (this._proactiveAudioCtx) {
      try {
        this._proactiveAudioCtx.close();
      } catch (_) { /* already closed */ }
      this._proactiveAudioCtx = null;
    }
  }

  /**
   * Handle handsfree state changes
   */
  _handleStateChanged(data) {
    const state = data?.state || 'idle';
    this._lastState = state;
    
    if (this._hideTimeout) {
      clearTimeout(this._hideTimeout);
      this._hideTimeout = null;
    }

    // Check if there is anything to display
    const hasProactive = this.proactiveContainer && this.proactiveContainer.children.length > 0;

    if (!hasProactive) {
      this.hide();
    } else {
      this.show();
    }
  }
  
  /**
   * Create message element
   * @param {string} role - 'user' or 'assistant'
   * @param {string} text - Message text
   * @param {string} id - Message ID
   * @returns {HTMLElement}
   */
  _createMessage(role, text, id) {
    const message = document.createElement('div');
    message.className = `handsfree-message ${role}`;
    message.id = id;
    
    const content = document.createElement('div');
    content.className = 'handsfree-message-content';
    content.textContent = text;
    
    message.appendChild(content);
    
    return message;
  }
  
  /**
   * Insert a small source-type tag at the top of the notification.
   * Shows the user WHY this notification appeared (email, file change, etc.)
   * @param {HTMLElement} messageEl - The notification message element
   * @param {Object|null} context - Proactive context { sources: [...], queries: [...] }
   */
  _insertSourceTag(messageEl, context) {
    if (!context?.sources?.length) return;
    
    // Determine primary source type (first source)
    const sourceTypeMap = {
      email: { icon: 'fa-envelope', label: 'Email' },
      filesystem: { icon: 'fa-file-alt', label: 'File' },
      browser: { icon: 'fa-globe', label: 'Browser' },
      active_windows: { icon: 'fa-desktop', label: 'Activity' },
    };
    
    // Collect unique source types
    const uniqueTypes = [...new Set(context.sources.map(s => s.type))];
    
    const tagContainer = document.createElement('div');
    tagContainer.className = 'proactive-source-tags';
    
    for (const type of uniqueTypes) {
      const info = sourceTypeMap[type] || { icon: 'fa-bolt', label: type };
      const tag = document.createElement('span');
      tag.className = `proactive-source-tag proactive-source-${type}`;
      tag.innerHTML = `<i class="fas ${info.icon}"></i> ${info.label}`;
      tagContainer.appendChild(tag);
    }
    
    // Insert BEFORE the content element (so tag appears above the text)
    const contentEl = messageEl.querySelector('.handsfree-message-content');
    if (contentEl) {
      messageEl.insertBefore(tagContainer, contentEl);
    } else {
      messageEl.prepend(tagContainer);
    }
  }
  
  _clearListenersForElement(targetElement) {
    if (!targetElement || !this._domListeners) return;
    const remaining = [];
    for (const listener of this._domListeners) {
      if (listener.element && (listener.element === targetElement || targetElement.contains(listener.element))) {
        listener.element.removeEventListener(listener.event, listener.handler, listener.options);
      } else {
        remaining.push(listener);
      }
    }
    this._domListeners = remaining;
  }

  /**
   * Track DOM listener for cleanup
   * @private
   */
  _trackListener(element, event, handler, options) {
    if (!element) return;
    element.addEventListener(event, handler, options);
    if (!this._domListeners) this._domListeners = [];
    this._domListeners.push({ element, event, handler, options });
  }

  /**
   * Track timer for cleanup
   * @private
   */
  _trackTimer(type, fn, ms) {
    const id = type === 'interval' ? setInterval(fn, ms) : setTimeout(fn, ms);
    if (!this._timers) this._timers = [];
    this._timers.push({ id, type });
    return id;
  }

  /**
   * Show overlay
   */
  show() {
    this.log.debug('[HandsfreeConversationDisplay] show() called', {
      hasOverlay: !!this.overlay,
      isVisible: this._isVisible,
      overlayClasses: this.overlay ? Array.from(this.overlay.classList).join(' ') : 'none'
    });

    if (this._hideTimeout) {
      clearTimeout(this._hideTimeout);
      this._hideTimeout = null;
    }
    if (!this.overlay || this._isVisible) {
      this.log.debug('[HandsfreeConversationDisplay] Skipped show()', { hasOverlay: !!this.overlay, isVisible: this._isVisible });
      return;
    }
    
    this.overlay.classList.remove('hidden');
    this._isVisible = true;
    this.log.debug('[HandsfreeConversationDisplay] Overlay made visible');
  }
  
  /**
   * Hide overlay
   */
  hide() {
    this.log.debug('[HandsfreeConversationDisplay] hide() called', {
      hasOverlay: !!this.overlay,
      isVisible: this._isVisible,
      overlayClasses: this.overlay ? Array.from(this.overlay.classList).join(' ') : 'none'
    });

    if (!this.overlay || !this._isVisible) {
      this.log.debug('[HandsfreeConversationDisplay] Skipped hide()', { hasOverlay: !!this.overlay, isVisible: this._isVisible });
      return;
    }
    
    this.overlay.classList.add('hidden');
    this._isVisible = false;
    this.log.debug('[HandsfreeConversationDisplay] Overlay hidden');
  }
  
  /**
   * Dispose display
   */
  dispose() {
    if (this._isDisposed) return;
    
    if (this._timers) {
      for (const { id, type } of this._timers) {
        type === 'interval' ? clearInterval(id) : clearTimeout(id);
      }
      this._timers = [];
    }

    if (this._hideTimeout) {
      clearTimeout(this._hideTimeout);
      this._hideTimeout = null;
    }
    
    if (this._proactiveTimeoutId) {
      clearTimeout(this._proactiveTimeoutId);
      this._proactiveTimeoutId = null;
    }
    
    if (this._streamStallTimerId) {
      clearTimeout(this._streamStallTimerId);
      this._streamStallTimerId = null;
    }
    
    // Clear proactive typing interval
    if (this._proactiveTypingTimerId) {
      clearInterval(this._proactiveTypingTimerId);
      this._proactiveTypingTimerId = null;
    }

    if (this._streamIntervals) {
      for (const interval of this._streamIntervals) {
        clearInterval(interval);
      }
      this._streamIntervals = [];
    }
    
    // Clean up welcome timers
    this._clearWelcomeTyping();
    if (this._welcomeHideTimerId) {
      clearTimeout(this._welcomeHideTimerId);
      this._welcomeHideTimerId = null;
    }
    this._welcomeActive = false;
    
    // Cleanup EventBus subscriptions
    for (const cleanup of this._eventBusCleanups) {
      try {
        cleanup();
      } catch (error) {
        this.log.error('[HandsfreeConversationDisplay] Cleanup error:', error);
      }
    }
    this._eventBusCleanups = [];
    
    // Stop proactive TTS audio
    this._stopProactiveAudio();
    this._proactiveTextAccumulator = '';

    // Remove active proactive message from DOM (prevents orphaned click handlers retaining 'this')
    if (this._currentProactiveMessage && this._currentProactiveMessage.parentNode) {
      this._clearListenersForElement(this._currentProactiveMessage);
      this._currentProactiveMessage.remove();
    }
    
    // Clear proactive container (removes any remaining DOM children with listeners)
    if (this.proactiveContainer) {
      this.proactiveContainer.innerHTML = '';
    }
    
    // Remove tracked DOM listeners
    if (this._domListeners) {
      for (const { element, event, handler, options } of this._domListeners) {
        try {
          if (element) element.removeEventListener(event, handler, options);
        } catch (e) {
          // Ignore errors during disposal
        }
      }
      this._domListeners = [];
    }
    
    // Null out references
    this.overlay = null;
    this.proactiveContainer = null;
    this._currentProactiveMessage = null;
    
    // Reset flags
    this._isInitialized = false;
    this._isDisposed = true;
  }
}

module.exports = HandsfreeConversationDisplay;
