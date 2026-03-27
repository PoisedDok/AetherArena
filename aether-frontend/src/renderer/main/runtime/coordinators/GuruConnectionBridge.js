/**
 * @.architecture
 *
 * Incoming: GuruConnection WebSocket events (open, close, error, message), IPC chat:send/chat:stop --- {ws_types.event, ipc_types.payload}
 * Processing: Bridge guru events to EventBus, route messages to chat window via IPC, manage guru state --- {4 jobs: JOB_BRIDGE_EVENT, JOB_ROUTE_MESSAGE, JOB_UPDATE_STATE, JOB_HANDLE_CHAT}
 * Outgoing: EventBus emissions (audio, proactive), IPC forwards to chat window, guru state patches --- {eventBus_types.event, ipc_types.send}
 *
 * Extracted from MainApp.js to reduce god-object size.
 * MainApp delegates all WebSocket/guru concerns here.
 */

'use strict';

const { EventTypes } = require('../../../../core/events/EventTypes');
const Toast = require('../../../shared/components/Toast');
const { createRendererLogger } = require('../../../shared/utils/logger');

class GuruConnectionBridge {
  /**
   * @param {Object} options
   * @param {Object} options.guru - GuruConnection instance
   * @param {Object} options.endpoint - Endpoint instance
   * @param {Object} options.eventBus - EventBus instance
   * @param {Object} options.ipc - IPC bridge (aether.ipc)
   * @param {Object} [options.aether] - Aether bridge (fallback IPC)
   */
  constructor(options = {}) {
    this.log = createRendererLogger('GuruConnectionBridge');
    this.guru = options.guru || null;
    this.endpoint = options.endpoint || null;
    this.eventBus = options.eventBus || null;
    this.ipc = options.ipc || null;
    this.aether = options.aether || null;

    this._isDisposed = false;
    this._guruListeners = [];
    this._errorRecoveryTimer = null;
  }

  /**
   * Set up all guru event listeners and bridges.
   * Call after guru is available.
   */
  initialize() {
    if (this._isDisposed) return;
    if (!this.guru || typeof this.guru.on !== 'function') {
      this.log.warn('GuruConnection not available, skipping event listeners');
      return;
    }

    const track = (event, handler) => {
      this.guru.on(event, handler);
      this._guruListeners.push({ event, handler });
    };

    track('open', () => this._handleGuruOpen());
    track('close', (event) => this._handleGuruClose(event));
    track('error', (error) => this._handleGuruError(error));
    track('message', (payload) => this._handleGuruMessage(payload));

    // CRITICAL FIX: Bridge GuruConnection events to EventBus for HandsfreeConversationDisplay
    // GuruConnection emits on itself, but UI components listen to EventBus
    if (this.eventBus) {
      // Bridge 'audio:stt-final' events (already converted from 'stt-final' in GuruConnection)
      track('audio:stt-final', (payload) => {
        this.log.debug('[GuruConnectionBridge] Bridging audio:stt-final to EventBus:', payload);
        this.eventBus.emit(EventTypes.AUDIO.STT_FINAL, payload);
      });

      // Bridge 'audio:stt-partial' events
      track('audio:stt-partial', (payload) => {
        this.eventBus.emit(EventTypes.AUDIO.STT_PARTIAL, payload);
      });

      // Bridge 'audio:tts-queued' events
      track('audio:tts-queued', (payload) => {
        this.eventBus.emit(EventTypes.AUDIO.TTS_QUEUED, payload);
      });

      // Bridge 'audio:tts-completed' events
      track('audio:tts-completed', (payload) => {
        this.eventBus.emit(EventTypes.AUDIO.TTS_COMPLETED, payload);
      });

      // Bridge 'audio:tts-audio' events (handsfree TTS audio chunks)
      track('audio:tts-audio', (payload) => {
        this.eventBus.emit(EventTypes.AUDIO.TTS_AUDIO, payload);
      });

      // Bridge 'audio:tts-error' events (backend TTS generation failure)
      track('audio:tts-error', (payload) => {
        this.eventBus.emit(EventTypes.AUDIO.TTS_BACKEND_ERROR, payload);
        // Surface TTS errors as user-visible toasts
        const msg = payload.message || payload.error_type || 'Voice synthesis failed';
        Toast.warning(`Voice: ${msg}`, 4000);
      });

      // Bridge 'audio:sleep-word-detected' events (disable handsfree)
      track('audio:sleep-word-detected', (payload) => {
        this.eventBus.emit(EventTypes.AUDIO.SLEEP_WORD_DETECTED, payload);
        Toast.info('Hands-free mode paused (sleep word detected)', 3000);
      });

      // Bridge 'audio:interruption-detected' events (backend detected user speech during TTS)
      track('audio:interruption-detected', (payload) => {
        this.eventBus.emit(EventTypes.AUDIO.INTERRUPTION_DETECTED, payload);
      });

      // Bridge 'proactive:stream-chunk' events (proactive agent streaming)
      track('proactive:stream-chunk', (payload) => {
        this.log.debug('[GuruConnectionBridge] Bridging proactive:stream-chunk to EventBus:', payload);
        this.eventBus.emit('proactive:stream-chunk', payload);
      });

      // Bridge 'proactive:stream-end' events (proactive agent completion)
      track('proactive:stream-end', (payload) => {
        this.log.debug('[GuruConnectionBridge] Bridging proactive:stream-end to EventBus:', payload);
        this.eventBus.emit('proactive:stream-end', payload);
      });

      // Bridge 'proactive:intervention' events (non-streaming fallback)
      track('proactive:intervention', (payload) => {
        this.log.debug('[GuruConnectionBridge] Bridging proactive:intervention to EventBus:', payload);
        this.eventBus.emit('proactive:intervention', payload);
      });

      this.log.debug('GuruConnection -> EventBus bridge established (Audio + Proactive)');
    }
  }

  // ── Guru Event Handlers ────────────────────────────────────

  _handleGuruOpen() {
    // Clear any pending error recovery timer (connection recovered)
    if (this._errorRecoveryTimer) {
      clearTimeout(this._errorRecoveryTimer);
      this._errorRecoveryTimer = null;
    }
    this._setGuruState({ assistant: 'idle' });
  }

  _handleGuruClose(event) {
    // Clear any pending error recovery timer (connection closing)
    if (this._errorRecoveryTimer) {
      clearTimeout(this._errorRecoveryTimer);
      this._errorRecoveryTimer = null;
    }
    this._setGuruState({ assistant: 'waiting' });
    if (event && event.code && event.code !== 1000) {
      this.log.warn('GuruConnection closed', event.code, event.reason || '');
    }
  }

  _handleGuruError(error) {
    this.log.error('GuruConnection error:', error);
    this._setGuruState({ assistant: 'error' });
    
    // Auto-recover from error state after 3 seconds if no other state change occurs.
    // Error states are transient visual feedback, not permanent conditions.
    // If the connection is truly broken, _handleGuruClose will be called and clear this timer.
    // If a new message arrives, _handleGuruMessage will override the state.
    if (this._errorRecoveryTimer) {
      clearTimeout(this._errorRecoveryTimer);
    }
    this._errorRecoveryTimer = setTimeout(() => {
      if (!this._isDisposed && this.guru && this.guru.state && this.guru.state.assistant === 'error') {
        this.log.debug('[GuruConnectionBridge] Auto-recovering from error state to idle');
        this._setGuruState({ assistant: 'idle' });
      }
      this._errorRecoveryTimer = null;
    }, 3000);
  }

  _handleGuruMessage(payload) {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    try {
      const messageType = typeof payload.type === 'string' ? payload.type : null;
      const messageRole = typeof payload.role === 'string' ? payload.role : null;

      if (!messageType) {
        this.log.warn('[GuruConnectionBridge] Dropping guru payload without type', payload);
        return;
      }

      const normalizedType = messageType === 'done' ? 'completion' : messageType;

      if (messageRole === 'assistant' && messageType === 'message' && payload.content) {
        this._setGuruState({ assistant: 'speaking' });

        // Bridge LLM streaming to EventBus for handsfree conversation display
        if (this.eventBus && payload.content) {
          this.eventBus.emit('llm:stream-chunk', {
            chunk: payload.content,
            text: payload.content,
            delta: payload.content
          });
        }
      }

      // Handle completion/termination messages
      if (
        normalizedType === 'completion' ||
        normalizedType === 'stopped' ||
        normalizedType === 'error' ||
        payload.done === true
      ) {
        this._setGuruState({ assistant: normalizedType === 'error' ? 'error' : 'idle' });
        this._notifyChatRequestComplete({ ...payload, type: normalizedType });

        // Emit LLM stream end for handsfree conversation display
        if (this.eventBus) {
          this.eventBus.emit('llm:stream-end', { done: true });
        }

        // Completion messages don't need to be streamed to chat window
        return;
      }

      // CRITICAL FIX: Check messages that don't require role validation
      // These include handsfree messages, trail events, and artifact streams
      const handsfreeMessageTypes = ['stt-final', 'stt-partial', 'tts-queued', 'tts-completed', 'tts-audio', 'tts-error', 'sleep-word-detected', 'wake-word-detected', 'interruption-detected'];
      
      if (handsfreeMessageTypes.includes(messageType)) {
        this.log.debug(`[GuruConnectionBridge] Handsfree message (already bridged to EventBus): ${messageType}`);
        return;
      }

      // System events (trail orchestration, agent signals, proactive agents) do not have a role
      // but MUST be bridged to the chat window for UI updates
      const isSystemEvent = messageType.startsWith('trail.') || 
                            messageType.startsWith('agent.') || 
                            messageType.startsWith('artifacts:') ||
                            messageType.startsWith('proactive');

      // ARCHITECTURAL FIX: Artifacts are now handled centrally by ArtifactsStreamOrchestrator 
      // in the Main process. Do NOT forward them via legacy chat stream to prevent UI duplication.
      const artifactTypes = ['code', 'console', 'output', 'html', 'image', 'video'];
      if (artifactTypes.includes(messageType) || payload.format === 'html') {
        this.log.trace('[GuruConnectionBridge] Dropping artifact payload (handled by ArtifactsStreamOrchestrator)', { type: messageType });
        return;
      }

      // Validate role for standard chat messages
      if (!messageRole && !isSystemEvent) {
        this.log.warn('[GuruConnectionBridge] Dropping guru payload without role', payload);
        return;
      }

      // Forward to chat window
      if (this.ipc) {
        this.ipc.send('chat:assistant-stream', payload);
      } else {
        this.aether?.ipc?.send('chat:assistant-stream', payload);
      }
    } catch (error) {
      this.log.error('[GuruConnectionBridge] Failed to forward assistant stream:', error);
    }
  }

  // ── Chat Send / Stop ───────────────────────────────────────

  handleChatStop(payload = {}) {
    if (this._isDisposed) return;
    this.log.debug('[GuruConnectionBridge] chat:stop received', payload);

    if (!this.endpoint || !this.endpoint.connection) {
      this.log.error('[GuruConnectionBridge] Cannot stop - endpoint not initialized');
      return;
    }

    // Get the requestId to stop (from payload or from tracked request)
    const requestId = payload?.requestId;

    if (!requestId) {
      this.log.warn('[GuruConnectionBridge] chat:stop called without requestId');
      return;
    }

    try {
      // Call WebSocket stop
      this.endpoint.connection.stopRequest(requestId);
      this.log.debug('[GuruConnectionBridge] Stop request sent to WebSocket', { requestId });

      // Update guru state
      this._setGuruState({ assistant: 'idle' });
    } catch (error) {
      this.log.error('[GuruConnectionBridge] Failed to stop generation:', error);
    }
  }

  handleChatSend(payload = {}) {
    if (this._isDisposed) return;
    if (!payload || typeof payload !== 'object') {
      return;
    }

    const { message, requestId, correlationId, metadata = null, chatId } = payload;
    const safeMetadata = (
      metadata &&
      typeof metadata === 'object' &&
      !Array.isArray(metadata) &&
      Object.keys(metadata).length > 0
    )
      ? metadata
      : null;

    // ARCHITECTURE INSIGHT: Different message types have different contract requirements
    // 1. context_reset: Control message - NO requestId required (backend doesn't use it)
    // 2. user messages: Tracked requests - requestId/correlationId REQUIRED for response correlation

    // Handle context_reset (control message - no tracking needed)
    if (safeMetadata && safeMetadata.type === 'context_reset') {
      this._sendContextReset({
        chatId: safeMetadata.chatId || chatId,
        requestId: requestId || null, // OPTIONAL - backend doesn't use it
        timestamp: safeMetadata.timestamp,
      });
      return;
    }

    // CONTRACT: User messages REQUIRE requestId or correlationId for response tracking
    // IPC callers (SendController) must generate IDs before sending user messages
    if (!requestId && !correlationId) {
      this.log.error('[GuruConnectionBridge] CONTRACT VIOLATION: User message payload missing requestId and correlationId', { payload });
      return;
    }

    const frontendId = requestId || correlationId;

    const trimmed =
      typeof message === 'string' ? message.trim() : '';

    if (!trimmed) {
      return;
    }

    if (!this.endpoint) {
      this.log.error('[GuruConnectionBridge] Endpoint not initialized; dropping chat message');
      return;
    }

    try {
      if (!this.guru || !this.guru.ws || this.guru.ws.readyState !== 1) { // 1 = WebSocket.OPEN
        throw new Error('Backend is not connected');
      }

      this._setGuruState({ assistant: 'thinking' });
      // CRITICAL: Pass correlationId for backend message UUID linkage
      if (safeMetadata) {
        this.endpoint.sendUserMessage(trimmed, frontendId, chatId, correlationId, safeMetadata);
      } else {
        this.endpoint.sendUserMessage(trimmed, frontendId, chatId, correlationId);
      }
    } catch (error) {
      this.log.error('[GuruConnectionBridge] Failed to send chat message:', error);
      this._setGuruState({ assistant: 'error' });
      this._notifyChatRequestComplete({
        error: error.message || 'Failed to send message',
        requestId: frontendId,
      });
    }
  }

  // ── Internal Helpers ───────────────────────────────────────

  _notifyChatRequestComplete(payload) {
    try {
      if (this.ipc) {
        this.ipc.send('chat:request-complete', payload);
        if (payload.error) {
          this.ipc.send('chat:message:failed', payload);
        }
      } else {
        this.aether?.ipc?.send('chat:request-complete', payload);
        if (payload.error) {
          this.aether?.ipc?.send('chat:message:failed', payload);
        }
      }
    } catch (error) {
      this.log.error('[GuruConnectionBridge] Failed to notify chat window about completion:', error);
    }
  }

  _setGuruState(patch = {}) {
    if (!this.guru) {
      return;
    }
    const current = this.guru.state || {};

    // PERFORMANCE: Skip if assistant state hasn't actually changed.
    // During streaming, this method is called on every chunk with { assistant: 'speaking' }.
    // Without this guard, each call creates a new state object, emits a VISUALIZER.STATE_CHANGED
    // event, and forces a visualizer color recomputation — 50-100x/sec of pure waste when
    // the state is already 'speaking'.
    if (patch.assistant && current.assistant === patch.assistant) {
      return;
    }

    // Clear error recovery timer when transitioning to any new state (including error)
    // If we're transitioning TO error, _handleGuruError will set a new timer.
    // If we're transitioning FROM error, we want to clear the auto-recovery timer.
    if (patch.assistant && this._errorRecoveryTimer) {
      clearTimeout(this._errorRecoveryTimer);
      this._errorRecoveryTimer = null;
    }

    this.guru.state = { ...current, ...patch };

    // Emit visualizer state for text chat mode.
    // Without this, the cosmos visualizer stays stuck on 'idle' during text chat
    // because it reads state from EventBus events, not guru.state polling.
    // In handsfree mode, HandsfreeCoordinator also emits this event with
    // source:'handsfree'. Both sources converge to the same state — no conflict.
    if (patch.assistant && this.eventBus && !this._isDisposed) {
      this.eventBus.emit(EventTypes.VISUALIZER.STATE_CHANGED, {
        state: patch.assistant,
        source: 'chat',
      });
    }
  }

  _sendContextReset({ chatId, requestId, timestamp }) {
    if (!this.endpoint || !this.endpoint.connection || !chatId) {
      return;
    }
    const payload = {
      role: 'user',
      type: 'context_reset',
      chat_id: chatId,
      timestamp: timestamp || Date.now(),
    };
    // CONTRACT: Backend expects request_id (snake_case), not id
    if (requestId) {
      payload.request_id = requestId;
    }
    try {
      this.endpoint.connection.send(payload);
      this._setGuruState({ assistant: 'waiting' });
    } catch (error) {
      this.log.error('[GuruConnectionBridge] Failed to send context reset:', error);
    }
  }

  _generateRequestId() {
    try {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
      }
    } catch (error) {
      // ignore and use fallback
    }
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // ── Lifecycle ──────────────────────────────────────────────

  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;
    
    // Clear error recovery timer
    if (this._errorRecoveryTimer) {
      clearTimeout(this._errorRecoveryTimer);
      this._errorRecoveryTimer = null;
    }
    
    if (this.guru && typeof this.guru.off === 'function') {
      for (const { event, handler } of this._guruListeners) {
        this.guru.off(event, handler);
      }
    }
    this._guruListeners = [];
    this.guru = null;
    this.endpoint = null;
    this.eventBus = null;
    this.ipc = null;
    this.aether = null;
  }
}

module.exports = GuruConnectionBridge;
