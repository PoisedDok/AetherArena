'use strict';

/**
 * @.architecture
 *
 * Incoming: EventBus ASSISTANT_STREAM events, normalized message objects --- {event.websocket, json}
 * Processing: Route messages by type to specialized handlers --- {1 job: JOB_ROUTE_BY_TYPE}
 * Outgoing: Handler method calls (artifact/stream/trail/control) --- {method_call, void}
 *
 * @module renderer/chat/modules/messaging/routing/MessageEventRouter
 */

const { createRendererLogger } = require('../../../../shared/utils/logger');
const MessageParser = require('../utils/MessageParser');

const routerLogger = createRendererLogger('MessageEventRouter');

/**
 * MessageEventRouter - Pure Event Router for WebSocket Messages
 * ==============================================================
 * 
 * SINGLE RESPONSIBILITY: Route WebSocket events to appropriate handlers
 * 
 * ARCHITECTURE PRINCIPLE:
 * Routes by message type. NO business logic, NO state, NO persistence.
 * 
 * ROUTING TABLE:
 * - Artifacts → artifactHandler
 * - Assistant messages → messageHandler
 * - Trail events → trailHandler
 * - Control messages → controlHandler
 * 
 * CONTRACTS:
 * - Stateless (pure router)
 * - Fail fast on missing handlers
 * - Log routing decisions (trace level)
 * 
 * @module renderer/chat/modules/messaging/routing/MessageEventRouter
 */
class MessageEventRouter {
  constructor(options = {}) {
    this.artifactHandler = options.artifactHandler || null;
    this.messageHandler = options.messageHandler || null;
    this.trailHandler = options.trailHandler || null;
    this.controlHandler = options.controlHandler || null;
    this.eventBus = options.eventBus || null;  // For proactive notifications
    this.log = routerLogger.child({ scope: 'message-event-router' });

    // Validate required handlers
    if (!this.artifactHandler) {
      throw new Error('[MessageEventRouter] artifactHandler is REQUIRED');
    }
    if (!this.messageHandler) {
      throw new Error('[MessageEventRouter] messageHandler is REQUIRED');
    }
    if (!this.trailHandler) {
      throw new Error('[MessageEventRouter] trailHandler is REQUIRED');
    }
    if (!this.controlHandler) {
      throw new Error('[MessageEventRouter] controlHandler is REQUIRED');
    }
    if (!this.eventBus) {
      throw new Error('[MessageEventRouter] eventBus is REQUIRED');
    }

    this._isDisposed = false;

    this.log.info('MessageEventRouter initialized');
  }

  /**
   * Route incoming WebSocket message
   * @param {Object} payload - Raw WebSocket payload
   * @returns {Promise<void>}
   */
  async route(payload) {
    if (this._isDisposed) {
      this.log.warn('route called on disposed MessageEventRouter');
      return;
    }

    // Parse payload
    const normalized = MessageParser.parse(payload);
    if (!normalized) {
      this.log.warn('Ignoring unparseable message', { payload });
      return;
    }

    // Route by type
    if (MessageParser.isArtifact(normalized)) {
      this.log.trace('Routing to artifact handler', {
        type: MessageParser.getArtifactType(normalized),
        artifactId: normalized.artifactId
      });
      await this.artifactHandler.handleArtifact(normalized);
      return;
    }

    if (MessageParser.isAssistantMessage(normalized)) {
      this.log.trace('Routing to message handler', {
        requestId: normalized.requestId,
        hasContent: Boolean(normalized.content)
      });
      await this.messageHandler.handleMessage(normalized);
      return;
    }

    if (MessageParser.isTrailEvent(normalized)) {
      this.log.trace('Routing to trail handler', {
        eventType: normalized.type
      });
      await this.trailHandler.handleTrailEvent(normalized);
      return;
    }

    if (MessageParser.isControlMessage(normalized)) {
      this.log.trace('Routing to control handler', {
        controlType: normalized.type
      });
      await this.controlHandler.handleControl(normalized);
      return;
    }
    
    // Proactive notifications (Phase 2: DeepPlanning) - emit to EventBus
    if (MessageParser.isProactiveNotification(normalized)) {
      this.log.trace('Routing to EventBus (proactive notification)', {
        type: normalized.type,
        hasContent: Boolean(normalized.content)
      });
      await this._handleProactiveNotification(normalized);
      return;
    }
    
    // Handsfree events (wake-word-detected, sleep-word-detected) - silently ignore (handled by MainApp EventBus)
    if (MessageParser.isHandsfreeEvent(normalized)) {
      this.log.trace('Handsfree event (handled by MainApp)', {
        type: normalized.type
      });
      return;
    }

    // Unknown message type
    this.log.warn('Unknown message type - no handler', {
      role: normalized.role,
      type: normalized.type
    });
  }

  /**
   * Handle proactive notification (Phase 2: DeepPlanning)
   * Emits to EventBus for HandsfreeConversationDisplay to pick up
   * @param {Object} normalized - Normalized proactive message
   * @private
   */
  async _handleProactiveNotification(normalized) {
    if (!this.eventBus) {
      this.log.warn('EventBus not available for proactive notification');
      return;
    }

    try {
      // CRITICAL: Pass through ALL fields from the WS payload.
      // HandsfreeConversationDisplay needs: content, run_id, context,
      // recommendation, trace_id.
      // Previously this router stripped context/recommendation and
      // hardcoded duration:5000, breaking chat-opening and TTS timing.
      const raw = normalized.raw;
      const { type, content, run_id, recommendation, context } = raw;
      
      const normalizedType = type.replace('proactive-', 'proactive:');
      const text = content || recommendation || '';

      // Intervention (complete notification - non-streaming fallback)
      if (normalizedType === 'proactive:intervention') {
        // Emit as single chunk + end
        this.eventBus.emit('proactive:stream-chunk', {
          content: text,
          chunk: text,
          run_id,
          context,
          recommendation,
          trace_id: raw.trace_id || raw.traceId,
          timestamp: Date.now(),
        });
        
        this.eventBus.emit('proactive:stream-end', {
          run_id,
          context,
          trace_id: raw.trace_id || raw.traceId,
          timestamp: Date.now(),
        });
        
        this.log.info('Emitted proactive intervention', { run_id });
        return;
      }

      // Validation: Strict whitelist boundary for proactive subtypes
      // Only emit recognized proactive event types to prevent EventBus pollution
      const validSubtypes = ['proactive:stream-chunk', 'proactive:stream-end'];
      if (!validSubtypes.includes(normalizedType)) {
        this.log.warn('Ignored unknown proactive subtype', { type: normalizedType, run_id });
        return;
      }

      // Valid dynamic fallback for explicitly whitelisted proactive events
      this.log.debug(`[PROACTIVE ROUTER] ${normalizedType}`, { run_id, textLength: text.length });
      this.eventBus.emit(normalizedType, {
        content: text,           // Standard field name for HandsfreeConversationDisplay
        chunk: text,             // Legacy compat
        run_id,
        context,                 // Activity sources for chat opening
        recommendation,          // Full text for click handler
        trace_id: raw.trace_id || raw.traceId,
        timestamp: Date.now(),
        ...raw                   // Include raw fields in case downstream needs them
      });

    } catch (error) {
      this.log.error('Failed to handle proactive notification', { error });
    }
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    if (this._isDisposed) return;

    this._isDisposed = true;
    this.artifactHandler = null;
    this.messageHandler = null;
    this.trailHandler = null;
    this.controlHandler = null;
    this.eventBus = null;
    this.log.info('MessageEventRouter disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MessageEventRouter;
}

if (typeof window !== 'undefined') {
  window.MessageEventRouter = MessageEventRouter;
}
