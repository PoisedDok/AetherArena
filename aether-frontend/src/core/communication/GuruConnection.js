'use strict';

/**
 * @.architecture
 * Incoming: aether-backend/ws/handlers.py::StreamRelay, src/core/communication/GuruConnection.connect() --- {websocket_types.stream_chunk, json}
 * Processing: manage WebSocket lifecycle, parse payloads, restore frontend identifiers, emit typed events, queue outbound messages --- {12 jobs: JOB_DISPOSE, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_PARSE_JSON, JOB_RESTORE_ID, JOB_ROUTE_BY_TYPE, JOB_STOP, JOB_STRINGIFY_JSON, JOB_UPDATE_STATE, JOB_WS_CONNECT, JOB_WS_RECEIVE, JOB_WS_SEND}
 * Outgoing: src/core/events/EventEmitter, aether-backend/ws/hub.py --- {event_types.custom_event, json}
 */

const EventEmitter = require('events');
const { logger } = require('../utils/logger');
const { freeze } = Object;

const CONNECTION_STATES = freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  STALE: 'stale',
  RECONNECTING: 'reconnecting',
  WAITING: 'waiting',
  CLOSED: 'closed'
});

const resolveWebSocketImplementation = () => {
  if (typeof globalThis !== 'undefined' && globalThis.WebSocket) {
    return globalThis.WebSocket;
  }

  try {
    // eslint-disable-next-line global-require
    return require('ws');
  } catch {
    return null;
  }
};

class GuruConnection extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.url = options.url;
    this.reconnectDelay = options.reconnectDelay || 2000;
    this.pingInterval = options.pingInterval || 30000;
    this.healthInterval = options.healthInterval || 5000;
    this.maxReconnectAttempts = options.maxReconnectAttempts || Infinity;
    this.maxMissedPongs = options.maxMissedPongs || 3;
    this.enableLogging = options.enableLogging || false;
    this.log = logger.child({ module: 'GuruConnection' });
    this.WebSocketClass = options.WebSocketClass || resolveWebSocketImplementation();
    
    // Connection state
    this.ws = null;
    this.connectionId = 0;
    this.reconnectAttempts = 0;
    this.messageQueue = [];
    this.missedPongs = 0;
    this.state = {
      assistant: 'idle', // idle | listening | thinking | speaking | error | waiting
      audioLevel: 0
    };
    this.connectionState = CONNECTION_STATES.DISCONNECTED;
    this.connectionStateMeta = { since: Date.now() };
    
    // Timers
    this.pingTimer = null;
    this.healthTimer = null;
    this.reconnectTimer = null;
    this.lastPong = Date.now();
    
    // Flags
    this.isDestroyed = false;
    this.isConnecting = false;
    this.reconnecting = false;
    
    // Backend availability gate: when false, connect/reconnect/healthCheck
    // are silently skipped (no errors, no log spam).
    // Can be set at construction via options.backendAvailable (avoids timing race
    // where connect() fires before setBackendAvailable(false) is called).
    this._backendAvailable = options.backendAvailable !== undefined
      ? Boolean(options.backendAvailable)
      : true;
    
    // Prevent EventEmitter from throwing on unhandled 'error' events
    // This is a production-safe default - errors are logged but don't crash
    this._defaultErrorHandler = (error) => {
      // Check if there are other error listeners besides this default one
      const otherListeners = this.listenerCount('error') - 1;
      if (otherListeners === 0) {
        // Only this default listener exists - log error silently
        if (this.enableLogging) {
          this.log.warn('unhandled error event', { error });
        }
      }
    };
    this.on('error', this._defaultErrorHandler);
    
    if (!this.WebSocketClass) {
      this.log.warn('websocket implementation not available yet; connection attempts will defer until resolved');
    }
    
    // deferConnect: when true, skip auto-connect in constructor.
    // Caller must explicitly call connect() when ready (e.g. after onboarding gate).
    this.deferConnect = options.deferConnect || false;
    
    if (this.url && !this.deferConnect) {
      this.connect();
    }
  }

  /**
   * Connect to WebSocket
   */
  connect() {
    if (this.isDestroyed) {
      throw new Error('[GuruConnection] Cannot connect after destruction');
    }

    // Backend availability gate: silently skip connection when backend is unavailable.
    // setBackendAvailable(true) will auto-trigger connect() when backend comes online.
    if (!this._backendAvailable) {
      if (this.enableLogging) {
        this.log.debug('connect skipped (backend unavailable)');
      }
      return;
    }

    if (!this.url) {
      throw new Error('[GuruConnection] No WebSocket URL configured');
    }

    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      if (this.enableLogging) {
        this.log.debug('already connecting or connected');
      }
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log.error('max reconnection attempts reached');
      this.emit('max_reconnect_attempts');
      return;
    }

    const WebSocketCtor = this.WebSocketClass || resolveWebSocketImplementation();

    if (!WebSocketCtor) {
      const implError = new Error('[GuruConnection] No WebSocket implementation available');
      this.log.error('websocket creation failed', { error: implError });
      this.emit('error', implError);
      this._setStatus('waiting');
      this._startHealthCheck();
      return;
    }

    try {
      this.isConnecting = true;
      this.connectionId++;
      const currentConnectionId = this.connectionId;
      this.WebSocketClass = WebSocketCtor;
      this._transitionConnectionState(CONNECTION_STATES.CONNECTING, { attempt: this.reconnectAttempts + 1 });

      if (this.enableLogging) {
        this.log.debug('connecting to backend', {
          url: this.url,
          attempt: currentConnectionId
        });
      }

      this.ws = new WebSocketCtor(this.url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => this._handleOpen(currentConnectionId);
      this.ws.onmessage = (event) => this._handleMessage(event);
      this.ws.onerror = (error) => this._handleError(error);
      this.ws.onclose = (event) => this._handleClose(event);

    } catch (error) {
      this.log.error('websocket creation failed', { error });
      this.isConnecting = false;
      this.reconnecting = false;
      this._setStatus('waiting');
      this._startHealthCheck();
      this._scheduleReconnect();
      this.emit('error', error);
      return;
    }
  }

  /**
   * Send message through WebSocket
   * @param {*} data - Data to send (will be JSON stringified if object)
   */
  send(data) {
    if (this.isDestroyed) {
      this.log.warn('attempted to send after destruction');
      return;
    }

    // Queue message if not connected
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this.enableLogging) {
        this.log.debug('queueing message (not connected)', {
          hasWs: !!this.ws,
          readyState: this.ws?.readyState,
          messageType: typeof data === 'object' ? data.type : 'unknown'
        });
      }
      this.messageQueue.push(data);
      return;
    }

    try {
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      this.ws.send(payload);

      const msgType = typeof data === 'object' ? data.type || 'message' : 'binary';
      const msgId = typeof data === 'object' && data.id ? data.id.substring(0, 12) : '';
      if (this.enableLogging) {
        this.log.debug('message sent', { msgType, msgId });
      }
    } catch (error) {
      this.log.error('send failed', { error });
      this.messageQueue.push(data);
    }
  }

  /**
   * Stream audio data (binary)
   * @param {ArrayBuffer} arrayBuffer - Audio data
   */
  streamAudio(arrayBuffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log.warn('cannot stream audio when connection is not open');
      return;
    }

    try {
      // CRITICAL FIX: Convert ArrayBuffer to Base64 and send as JSON AudioMessage
      // Backend expects { role: 'user', type: 'audio', audio: '<base64>', ... }
      const uint8Array = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < uint8Array.length; i++) {
        binary += String.fromCharCode(uint8Array[i]);
      }
      const base64Audio = btoa(binary);

      const audioMessage = {
        role: 'user',
        type: 'audio',
        audio: base64Audio,
        timestamp: Date.now()
      };

      this.ws.send(JSON.stringify(audioMessage));
    } catch (error) {
      this.log.error('audio stream failed', { error });
    }
  }

  /**
   * Stop/cancel a request
   * @param {string} requestId - Request ID to stop
   */
  stopRequest(requestId) {
    if (!requestId) {
      this.log.warn('stop request requires a request ID');
      return;
    }

    this.send({
      type: 'stop',
      id: requestId
    });

    if (this.enableLogging) {
      this.log.debug('sent stop request', { requestId });
    }
  }

  /**
   * Close connection
   * @param {number} code - Close code
   * @param {string} reason - Close reason
   */
  close(code = 1000, reason = 'Client close') {
    if (this.enableLogging) {
      this.log.debug('closing connection', { reason, code });
    }

    this._stopPing();
    this._stopHealthCheck();
    this._clearReconnectTimer();
    if (this.connectionState !== CONNECTION_STATES.STALE) {
      const transitionReason = reason || 'manual_close';
      const targetState = this.isDestroyed ? CONNECTION_STATES.CLOSED : CONNECTION_STATES.WAITING;
      this._transitionConnectionState(targetState, { reason: transitionReason, code });
    }

    if (this.ws) {
      try {
        this.ws.close(code, reason);
      } catch (error) {
        this.log.error('close failed', { error });
      }
      this.ws = null;
    }

    this.isConnecting = false;
    this.reconnecting = false;
  }

  /**
   * Dispose connection
   */
  dispose() {
    if (this.isDestroyed) return;

    if (this.enableLogging) {
      this.log.debug('disposing connection');
    }

    this.isDestroyed = true;
    this.close(1000, 'Dispose');
    this.messageQueue = [];
    
    // Remove default error handler before removing all listeners
    if (this._defaultErrorHandler) {
      this.removeListener('error', this._defaultErrorHandler);
      this._defaultErrorHandler = null;
    }
    
    this.removeAllListeners();

    if (this.enableLogging) {
      this.log.debug('disposed');
    }
  }

  /**
   * Get connection statistics
   * @returns {Object}
   */
  getStats() {
    return freeze({
      connected: this.ws && this.ws.readyState === WebSocket.OPEN,
      reconnectAttempts: this.reconnectAttempts,
      queuedMessages: this.messageQueue.length,
      state: this.state.assistant,
      connectionState: this.connectionState,
      lastPong: this.lastPong,
      connectionId: this.connectionId
    });
  }

  /**
   * Set backend availability. When false, connect/reconnect/healthCheck are
   * silently skipped. When toggled to true and a URL is configured, auto-connects.
   * @param {boolean} available
   */
  setBackendAvailable(available) {
    const prev = this._backendAvailable;
    this._backendAvailable = Boolean(available);

    if (this.enableLogging) {
      this.log.debug('backend availability changed', { available: this._backendAvailable });
    }

    // Auto-connect when backend becomes available and we have a URL but no active connection
    if (!prev && this._backendAvailable && this.url && !this.isDestroyed) {
      const isOpen = this.ws && this.ws.readyState === WebSocket.OPEN;
      if (!this.isConnecting && !isOpen) {
        this.reconnectAttempts = 0;
        this.connect();
      }
    }
  }

  /**
   * @returns {boolean} Current backend availability state
   */
  isBackendAvailable() {
    return this._backendAvailable;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Handle WebSocket open
   * @private
   */
  _handleOpen(connectionId) {
    this.isConnecting = false;
    this.reconnecting = false;
    this.reconnectAttempts = 0;
    this.missedPongs = 0;

    if (this.enableLogging) {
      this.log.debug('connected to backend', { connectionId });
    }

    this._setStatus('idle');
    this._stopHealthCheck();
    this._flushQueue(connectionId);
    this._startPing();
    this._transitionConnectionState(CONNECTION_STATES.CONNECTED, { connectionId });

    this.emit('open');
    this.emit('connected');
  }

  /**
   * Handle WebSocket message
   * @private
   */
  _handleMessage(event) {
    this.lastPong = Date.now();
    this.missedPongs = 0;

    let payload;
    try {
      payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    } catch {
      payload = event.data;
    }

    // Handle ping/pong
    if (payload && typeof payload === 'object') {
      if (payload.type === 'heartbeat' || payload.type === 'ping') {
        this.send({ 
          type: 'pong', 
          timestamp: Date.now(),
          echo: payload.timestamp || Date.now()
        });
        return;
      }

      if (payload.type === 'pong') {
        return;
      }

      // Update state if provided
      if (payload.state && typeof payload.state === 'string') {
        this._setStatus(payload.state);
      }
    }

    // LOG ENTRY POINT: Data arriving from backend
    if (payload && typeof payload === 'object' && payload.type !== 'pong') {
      // CONTRACT: Backend sends request_id (snake_case) - canonical identifier
      // Backend NO LONGER sends 'id' field - removed for clean architecture
      const request_id = payload.request_id || null;
      const frontend_id = payload.frontend_id || null;
      const correlation_id =
        payload.correlationId ||
        payload.correlation_id ||
        frontend_id ||
        request_id ||
        null;      
      if (this.enableLogging) {
        this.log.trace('message received from backend', {
          requestId: request_id,
          frontendId: frontend_id,
          correlationId: correlation_id,
          role: payload.role,
          type: payload.type,
          hasContent: !!payload.content,
          start: payload.start || false,
          end: payload.end || false
        });
      }
      
      // Strip backend-specific fields and preserve frontend ID
      if (payload.frontend_id) {
        // Backend echoed our frontend_id back - keep it for correlation
        // Don't set payload.id (backend doesn't send it anymore)
        delete payload.frontend_id;  // Clean up
      }

      // Normalize correlation identifiers for downstream consistency
      if (correlation_id) {
        payload.correlationId = correlation_id;
        if (!payload.correlation_id) {
          payload.correlation_id = correlation_id;
        }
      }

      // CONTRACT: Backend sends request_id (snake_case) - ensure it's present
      // Frontend uses requestId (camelCase) internally, but preserves snake_case for consistency
      if (request_id && !payload.requestId) {
        payload.requestId = request_id;
      }
      if (!payload.request_id && request_id) {
        payload.request_id = request_id;
      }

      // Normalize trace metadata casing
      if (payload.session_id && !payload.sessionId) {
        payload.sessionId = payload.session_id;
      }
      if (payload.operator_id && !payload.operatorId) {
        payload.operatorId = payload.operator_id;
      }
      if (payload.user_id && !payload.userId) {
        payload.userId = payload.user_id;
      }
    }

    try {
      // Emit generic message event
      this.emit('message', payload);

      // Emit type-specific events (but not for 'message' type to avoid duplication)
      if (payload && typeof payload === 'object' && payload.type && payload.type !== 'message') {
        this.emit(payload.type, payload);
        
        // CRITICAL FIX: Bridge backend event names to EventBus conventions
        // Backend sends 'stt-final' but EventBus expects 'audio:stt-final'
        const eventBridgeMap = {
          'stt-final': 'audio:stt-final',
          'stt-partial': 'audio:stt-partial',
          'tts-queued': 'audio:tts-queued',
          'tts-completed': 'audio:tts-completed',
          'tts-audio': 'audio:tts-audio',  // HANDSFREE TTS audio chunks
          'tts-error': 'audio:tts-error',  // Backend TTS generation error
          'sleep-word-detected': 'audio:sleep-word-detected',  // Sleep word disable
          'wake-word-detected': 'audio:wake-word-detected',  // Wake word visual feedback
          'interruption-detected': 'audio:interruption-detected',  // Backend detected user speech during TTS
        };
        
        if (eventBridgeMap[payload.type]) {
          this.emit(eventBridgeMap[payload.type], payload);
        }
        
        // Emit 'lmc' events for artifact-related message types
        const artifactTypes = ['code', 'console', 'output', 'html', 'image', 'video'];
        if (artifactTypes.includes(payload.type) || payload.format === 'html') {
          this.emit('lmc', payload);
        }
      }
    } catch (error) {
      this.log.error('error emitting message events', { error });
    }
  }

  /**
   * Handle WebSocket error
   * @private
   */
  _handleError(error) {
    this.log.error('websocket error', { error });
    this.isConnecting = false;
    this._setStatus('waiting');
    this._stopPing();
    this._transitionConnectionState(CONNECTION_STATES.WAITING, { reason: 'error', detail: error?.message });
    this._startHealthCheck();
    this.emit('error', error);
  }

  /**
   * Handle WebSocket close
   * @private
   */
  _handleClose(event) {
    if (this.enableLogging) {
      this.log.debug('connection closed', {
        code: event.code,
        reason: event.reason || 'None'
      });
    }

    this.isConnecting = false;
    this._setStatus('waiting');
    this._stopPing();

    this.emit('close', event);

    // Auto-reconnect on abnormal close
    if (event.code !== 1000 && !this.isDestroyed) {
      this.emit('disconnected', event);
      this._transitionConnectionState(CONNECTION_STATES.WAITING, { reason: 'close', code: event.code });
      this._scheduleReconnect();
    } else if (!this.isDestroyed) {
      this._transitionConnectionState(CONNECTION_STATES.DISCONNECTED, { reason: 'normal_close', code: event.code });
    } else {
      this._transitionConnectionState(CONNECTION_STATES.CLOSED, { reason: 'disposed', code: event.code });
    }
  }

  /**
   * Flush queued messages
   * @private
   */
  _flushQueue(connectionId) {
    if (connectionId !== this.connectionId) {
      if (this.enableLogging) {
        this.log.trace('skipping message flush due to connection ID mismatch', {
          expected: this.connectionId,
          actual: connectionId
        });
      }
      return;
    }

    if (this.messageQueue.length === 0) return;

    if (this.enableLogging) {
      this.log.trace('flushing queued messages', { count: this.messageQueue.length });
    }

    const queue = [...this.messageQueue];
    this.messageQueue = [];

    for (const msg of queue) {
      this.send(msg);
    }
  }

  /**
   * Set assistant status
   * @private
   */
  _setStatus(status) {
    if (this.state.assistant !== status) {
      this.state.assistant = status;
      this.emit('statusChange', status);
    }
  }

  /**
   * Start ping timer
   * @private
   */
  _startPing() {
    this._stopPing();

    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }

      const now = Date.now();
      const elapsed = now - this.lastPong;

      // Track missed pong responses with tolerance
      if (elapsed > this.pingInterval * 1.5) {
        this.missedPongs += 1;

        if (this.missedPongs >= this.maxMissedPongs) {
          this.log.warn('connection appears stale; scheduling reconnect', {
            missedPongs: this.missedPongs,
            elapsed,
            pingInterval: this.pingInterval
          });
          this._transitionConnectionState(CONNECTION_STATES.STALE, { missedPongs: this.missedPongs });
          this.close(1000, 'Stale connection');
          this._scheduleReconnect();
          this.missedPongs = 0;
          this.lastPong = now;
          return;
        }
      } else {
        this.missedPongs = 0;
      }

      // Send ping
      this.send({ type: 'ping', timestamp: now });
    }, this.pingInterval);
  }

  /**
   * Stop ping timer
   * @private
   */
  _stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Start health check polling
   * @private
   */
  _startHealthCheck() {
    if (!this._backendAvailable) return;
    this._stopHealthCheck();

    this.healthTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this._stopHealthCheck();
        return;
      }

      // Try to reconnect
      this.connect();
    }, this.healthInterval);
    this._transitionConnectionState(CONNECTION_STATES.WAITING, { reason: 'health_check' });
  }

  /**
   * Stop health check polling
   * @private
   */
  _stopHealthCheck() {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   * @private
   */
  _scheduleReconnect() {
    if (this.isDestroyed) return;
    if (!this._backendAvailable) return;

    this.reconnectAttempts++;
    this.reconnecting = true;
    const backoff = Math.min(30000, this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1));

    if (this.enableLogging) {
      this.log.debug('scheduling reconnect', {
        backoff,
        attempt: this.reconnectAttempts
      });
    }

    this._transitionConnectionState(CONNECTION_STATES.RECONNECTING, {
      backoff,
      attempt: this.reconnectAttempts
    });

    this._clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isDestroyed) {
        this.connect();
      }
    }, backoff);
  }

  /**
   * Clear pending reconnect timer
   * @private
   */
  _clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Transition connection state and emit event
   * @private
   */
  _transitionConnectionState(nextState, context = {}) {
    if (!Object.values(CONNECTION_STATES).includes(nextState)) {
      throw new Error(`[GuruConnection] Invalid connection state transition target: ${nextState}`);
    }

    if (this.connectionState === nextState && !context.force) {
      return;
    }

    const previous = this.connectionState;
    this.connectionState = nextState;
    this.connectionStateMeta = {
      since: Date.now(),
      previous,
      ...context
    };

    if (this.enableLogging) {
      this.log.debug('connection state transition', {
        previous,
        state: nextState,
        context
      });
    }

    this.emit('connectionState', {
      previous,
      state: nextState,
      meta: this.connectionStateMeta
    });
  }
}

// Export
GuruConnection.CONNECTION_STATES = CONNECTION_STATES;
module.exports = GuruConnection;
module.exports.CONNECTION_STATES = CONNECTION_STATES;

if (typeof window !== 'undefined') {
  window.GuruConnection = GuruConnection;
  window.GuruConnectionStates = CONNECTION_STATES;
  logger.child({ module: 'GuruConnection' }).debug('module loaded');
}
