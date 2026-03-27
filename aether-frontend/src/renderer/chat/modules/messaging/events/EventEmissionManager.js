'use strict';

/**
 * @.architecture
 *
 * Incoming: Event emission requests with type and payload --- {event_request, object}
 * Processing: Emit events to EventBus, handle modern/legacy event types --- {2 jobs: JOB_EMIT_EVENT, JOB_MAP_EVENT_TYPE}
 * Outgoing: EventBus event emissions --- {event.custom, void}
 *
 * @module renderer/chat/modules/messaging/events/EventEmissionManager
 */

const { createRendererLogger } = require('../../../../shared/utils/logger');
const { EventTypes } = require('../../../../../core/events/EventTypes');

const eventLogger = createRendererLogger('EventEmissionManager');

/**
 * EventEmissionManager - EventBus Emission Abstraction
 * =====================================================
 * 
 * SINGLE RESPONSIBILITY: Abstract EventBus emission logic
 * 
 * ELIMINATING DUPLICATION:
 * SendController and StopController both emit events.
 * This extracts shared logic into single module.
 * 
 * EVENT EMISSION:
 * Uses modern EventTypes only. NO legacy events.
 * 
 * CONTRACTS:
 * - NO business logic
 * - Pure event emission
 * - Graceful no-op if EventBus unavailable
 * 
 * @module renderer/chat/modules/messaging/events/EventEmissionManager
 */
class EventEmissionManager {
  constructor(options = {}) {
    this.eventBus = options.eventBus || null;
    this.log = eventLogger.child({ scope: 'event-emission-manager' });

    this.log.info('EventEmissionManager initialized', {
      hasEventBus: Boolean(this.eventBus)
    });
  }

  /**
   * Emit event to EventBus
   * @param {string} eventType - Event type
   * @param {Object} payload - Event payload
   */
  emit(eventType, payload) {
    if (!this.eventBus) {
      this.log.trace('EventBus unavailable - skipping emission');
      return;
    }

    if (!eventType) {
      this.log.warn('Invalid event type');
      return;
    }

    this.eventBus.emit(eventType, payload);
    this.log.trace('Event emitted', { event: eventType });
  }

  /**
   * Emit chat message sending event
   * @param {Object} payload - Event payload
   */
  emitMessageSending(payload) {
    this.emit(EventTypes.CHAT.MESSAGE_SENDING, payload);
  }

  /**
   * Emit chat message sent event
   * @param {Object} payload - Event payload
   */
  emitMessageSent(payload) {
    this.emit(EventTypes.CHAT.MESSAGE_SENT, payload);
  }

  /**
   * Emit chat message error event
   * @param {Object} payload - Event payload
   */
  emitMessageError(payload) {
    this.emit(EventTypes.CHAT.MESSAGE_ERROR, payload);
  }

  /**
   * Emit stop requested event
   * @param {Object} payload - Event payload
   */
  emitStopRequested(payload) {
    this.emit(EventTypes?.CHAT?.STOP_REQUESTED || 'chat:stop:requested', payload);
  }

  /**
   * Emit stop completed event
   * @param {Object} payload - Event payload
   */
  emitStopCompleted(payload) {
    this.emit(EventTypes?.CHAT?.REQUEST_STOPPED || 'chat:request:stopped', payload);
  }

  /**
   * Emit stop error event
   * @param {Object} payload - Event payload
   */
  emitStopError(payload) {
    this.emit(EventTypes?.CHAT?.MESSAGE_ERROR || 'chat:message:error', payload);
  }

  /**
   * Emit processing state change
   * @param {boolean} processing - Processing state
   */
  emitProcessingState(processing) {
    if (!this.eventBus) return;
    this.eventBus.emit('message:processing', { processing });
  }

  /**
   * Emit stop mode state change
   * @param {boolean} enabled - Stop mode state
   */
  emitStopModeState(enabled) {
    if (!this.eventBus) return;
    this.eventBus.emit('message:stop-mode', { enabled });
  }

  /**
   * Check if EventBus available
   * @returns {boolean}
   */
  isAvailable() {
    return Boolean(this.eventBus);
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    this.eventBus = null;
    this.log.info('EventEmissionManager disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = EventEmissionManager;
}

if (typeof window !== 'undefined') {
  window.EventEmissionManager = EventEmissionManager;
}
