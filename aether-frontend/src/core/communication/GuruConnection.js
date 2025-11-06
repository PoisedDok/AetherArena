'use strict';

/**
 * @.architecture
 * 
 * Incoming: Backend WebSocket (ws://localhost:8765 via backend/ws/handlers.py StreamRelay, pre-validated by backend/ws/protocols.py Pydantic schemas) --- {websocket_types.websocket_stream_chunk, json | binary}
 * Processing: Establish connection, parse incoming JSON, restore frontend_id→id mapping, route by type, emit typed events, manage lifecycle, queue messages --- {11 jobs: JOB_DISPOSE, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_PARSE_JSON, JOB_RESTORE_ID, JOB_ROUTE_BY_TYPE, JOB_START, JOB_STOP, JOB_UPDATE_STATE, JOB_WS_CONNECT, JOB_WS_SEND}
 * Outgoing: EventEmitter 'message'/'lmc' → MainOrchestrator/ArtifactsStreamHandler, WebSocket send() → backend/ws/hub.py --- {event_types.custom_event, json | binary}
 * 
 * @module core/communication/GuruConnection
 */

const EventEmitter = require('events');
const { freeze } = Object;

class GuruConnection extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.url = options.url;
    this.reconnectDelay = options.reconnectDelay || 2000;
    this.pingInterval = options.pingInterval || 30000;
    this.healthInterval = options.healthInterval || 5000;
    this.maxReconnectAttempts = options.maxReconnectAttempts || Infinity;
    this.enableLogging = options.enableLogging || false;
    
    // Connection state
    this.ws = null;
    this.connectionId = 0;
    this.reconnectAttempts = 0;
    this.messageQueue = [];
    this.state = {
      assistant: 'idle', // idle | listening | thinking | speaking | error | waiting
      audioLevel: 0
    };
    
    // Timers
    this.pingTimer = null;
    this.healthTimer = null;
    this.lastPong = Date.now();
    
    // Flags
    this.isDestroyed = false;
    this.isConnecting = false;
    
    // Prevent EventEmitter from throwing on unhandled 'error' events
    // This is a production-safe default - errors are logged but don't crash
    this.on('error', (error) => {
      if (this.listenerCount('error') === 1) {
        // Only this default listener exists - log error silently
        if (this.enableLogging) {
          console.warn('[GuruConnection] Unhandled error event:', error);
        }
      }
    });
    
    if (this.url) {
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

    if (!this.url) {
      throw new Error('[GuruConnection] No WebSocket URL configured');
    }

    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      if (this.enableLogging) {
        console.log('[GuruConnection] Already connecting/connected');
      }
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[GuruConnection] Max reconnection attempts reached');
      this.emit('max_reconnect_attempts');
      return;
    }

    try {
      this.isConnecting = true;
      this.connectionId++;
      const currentConnectionId = this.connectionId;

      if (this.enableLogging) {
        console.log(`[GuruConnection] Connecting to ${this.url} (attempt #${currentConnectionId})`);
      }

      this.ws = new WebSocket(this.url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => this._handleOpen(currentConnectionId);
      this.ws.onmessage = (event) => this._handleMessage(event);
      this.ws.onerror = (error) => this._handleError(error);
      this.ws.onclose = (event) => this._handleClose(event);

    } catch (error) {
      console.error('[GuruConnection] WebSocket creation failed:', error);
      this.isConnecting = false;
      this._setStatus('waiting');
      this._startHealthCheck();
      this._scheduleReconnect();
    }
  }

  /**
   * Send message through WebSocket
   * @param {*} data - Data to send (will be JSON stringified if object)
   */
  send(data) {
    if (this.isDestroyed) {
      console.warn('[GuruConnection] Cannot send after destruction');
      return;
    }

    // Queue message if not connected
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[GuruConnection] Queueing message (not connected):', {
        hasWs: !!this.ws,
        readyState: this.ws?.readyState,
        messageType: typeof data === 'object' ? data.type : 'unknown'
      });
      this.messageQueue.push(data);
      return;
    }

    try {
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      this.ws.send(payload);

      const msgType = typeof data === 'object' ? data.type || 'message' : 'binary';
      const msgId = typeof data === 'object' && data.id ? data.id.substring(0, 12) : '';
      console.log(`[GuruConnection] ✅ Sent ${msgType} ${msgId}`);
    } catch (error) {
      console.error('[GuruConnection] Send failed:', error);
      this.messageQueue.push(data);
    }
  }

  /**
   * Stream audio data (binary)
   * @param {ArrayBuffer} arrayBuffer - Audio data
   */
  streamAudio(arrayBuffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[GuruConnection] Cannot stream audio - not connected');
      return;
    }

    try {
      this.ws.send(arrayBuffer);
    } catch (error) {
      console.error('[GuruConnection] Audio stream failed:', error);
    }
  }

  /**
   * Stop/cancel a request
   * @param {string} requestId - Request ID to stop
   */
  stopRequest(requestId) {
    if (!requestId) {
      console.warn('[GuruConnection] Stop request requires a request ID');
      return;
    }

    this.send({
      type: 'stop',
      id: requestId
    });

    if (this.enableLogging) {
      console.log(`[GuruConnection] Sent stop request for: ${requestId}`);
    }
  }

  /**
   * Close connection
   * @param {number} code - Close code
   * @param {string} reason - Close reason
   */
  close(code = 1000, reason = 'Client close') {
    if (this.enableLogging) {
      console.log(`[GuruConnection] Closing connection: ${reason}`);
    }

    this._stopPing();
    this._stopHealthCheck();

    if (this.ws) {
      try {
        this.ws.close(code, reason);
      } catch (error) {
        console.error('[GuruConnection] Close failed:', error);
      }
      this.ws = null;
    }

    this.isConnecting = false;
  }

  /**
   * Dispose connection
   */
  dispose() {
    if (this.isDestroyed) return;

    if (this.enableLogging) {
      console.log('[GuruConnection] Disposing...');
    }

    this.isDestroyed = true;
    this.close(1000, 'Dispose');
    this.messageQueue = [];
    this.removeAllListeners();

    if (this.enableLogging) {
      console.log('[GuruConnection] Disposed');
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
      lastPong: this.lastPong,
      connectionId: this.connectionId
    });
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
    this.reconnectAttempts = 0;

    if (this.enableLogging) {
      console.log(`[GuruConnection] Connected (connection #${connectionId})`);
    }

    this._setStatus('idle');
    this._stopHealthCheck();
    this._flushQueue(connectionId);
    this._startPing();

    this.emit('open');
  }

  /**
   * Handle WebSocket message
   * @private
   */
  _handleMessage(event) {
    this.lastPong = Date.now();

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
      const backend_id = payload.id;
      const frontend_id = payload.frontend_id || null;
      
      console.log('[GuruConnection] 📥 ENTRY POINT: Received from backend:', {
        backend_id,
        frontend_id,
        role: payload.role,
        type: payload.type,
        hasContent: !!payload.content,
        start: payload.start || false,
        end: payload.end || false
      });
      
      // Strip backend-specific fields and preserve frontend ID
      if (payload.frontend_id) {
        // Backend echoed our frontend_id back, use it as primary ID
        payload.id = payload.frontend_id;
        payload._backend_id = backend_id;  // Keep backend ID for debugging
        delete payload.frontend_id;  // Clean up
      }
    }

    // Emit message events
    this.emit('message', payload);

    if (payload && typeof payload === 'object' && payload.type) {
      this.emit(payload.type, payload);
      
      // Emit 'lmc' events for artifact-related message types
      // This enables ArtifactsStreamHandler to detect and route artifacts
      const artifactTypes = ['code', 'console', 'output', 'html', 'image', 'video'];
      if (artifactTypes.includes(payload.type) || payload.format === 'html') {
        this.emit('lmc', payload);
      }
    }
  }

  /**
   * Handle WebSocket error
   * @private
   */
  _handleError(error) {
    console.error('[GuruConnection] WebSocket error:', error);
    this.isConnecting = false;
    this._setStatus('waiting');
    this._stopPing();
    this._startHealthCheck();
    this.emit('error', error);
  }

  /**
   * Handle WebSocket close
   * @private
   */
  _handleClose(event) {
    if (this.enableLogging) {
      console.log(`[GuruConnection] Closed: code=${event.code}, reason=${event.reason || 'None'}`);
    }

    this.isConnecting = false;
    this._setStatus('waiting');
    this._stopPing();

    this.emit('close', event);

    // Auto-reconnect on abnormal close
    if (event.code !== 1000 && !this.isDestroyed) {
      this._scheduleReconnect();
    }
  }

  /**
   * Flush queued messages
   * @private
   */
  _flushQueue(connectionId) {
    if (connectionId !== this.connectionId) {
      if (this.enableLogging) {
        console.log('[GuruConnection] Skipping flush - connection ID mismatch');
      }
      return;
    }

    if (this.messageQueue.length === 0) return;

    if (this.enableLogging) {
      console.log(`[GuruConnection] Flushing ${this.messageQueue.length} queued messages`);
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
      const elapsed = Date.now() - this.lastPong;
      
      // Check if connection is stale
      if (elapsed > this.pingInterval * 2) {
        console.warn('[GuruConnection] Connection appears stale, reconnecting...');
        this.close(1000, 'Stale connection');
        this._scheduleReconnect();
        return;
      }

      // Send ping
      this.send({ type: 'ping', timestamp: Date.now() });
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
    this._stopHealthCheck();

    this.healthTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this._stopHealthCheck();
        return;
      }

      // Try to reconnect
      this.connect();
    }, this.healthInterval);
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

    this.reconnectAttempts++;
    const backoff = Math.min(30000, this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1));

    if (this.enableLogging) {
      console.log(`[GuruConnection] Reconnecting in ${backoff}ms (attempt ${this.reconnectAttempts})`);
    }

    setTimeout(() => {
      if (!this.isDestroyed) {
        this.connect();
      }
    }, backoff);
  }
}

// Export
module.exports = GuruConnection;

if (typeof window !== 'undefined') {
  window.GuruConnection = GuruConnection;
  console.log('📦 GuruConnection loaded');
}

