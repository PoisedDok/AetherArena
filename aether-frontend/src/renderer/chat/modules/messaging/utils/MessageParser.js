'use strict';

/**
 * @.architecture
 *
 * Incoming: Raw WebSocket payload objects --- {websocket.message, json}
 * Processing: Parse and normalize payload fields, extract identifiers --- {2 jobs: JOB_PARSE_PAYLOAD, JOB_VALIDATE_SCHEMA}
 * Outgoing: Normalized message objects with consistent field names --- {normalized_message, object}
 *
 * @module renderer/chat/modules/messaging/utils/MessageParser
 */

/**
 * MessageParser - Pure WebSocket Message Parsing
 * ===============================================
 * 
 * SINGLE RESPONSIBILITY: Parse and normalize WebSocket payloads
 * 
 * CONTRACTS:
 * - NO business logic
 * - NO state
 * - Pure functions only
 * - Fail fast on invalid payloads
 * 
 * @module renderer/chat/modules/messaging/utils/MessageParser
 */
class MessageParser {
  /**
   * Parse WebSocket message payload
   * @param {Object} payload - Raw WebSocket payload
   * @returns {Object|null} Normalized message or null if invalid
   */
  static parse(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('[MessageParser] CONTRACT VIOLATION: Payload must be a non-null object');
    }

    const { role, type, content, start, end, format, artifact_id, node_id, subgroup_id, sequence_in_chat, message_id } = payload;

    // CONTRACT: Backend sends request_id for stream messages (assistant, computer with content)
    // Control/trail/server messages may not have request_id
    const isProactive = typeof type === 'string' && type.startsWith('proactive');
    const isStreamMessage = !isProactive && (role === 'assistant' || role === 'computer') && (start || end || content);
    
    if (isStreamMessage && type !== 'assistant.message_flushed' && (!payload.request_id || typeof payload.request_id !== 'string')) {
      throw new Error(`[MessageParser] CONTRACT VIOLATION: Backend must provide request_id for stream messages. Received: ${JSON.stringify(Object.keys(payload))}`);
    }

    return {
      role,
      type,
      content,
      start: Boolean(start),
      end: Boolean(end),
      format,
      requestId: payload.request_id || null, // Backend sends request_id (snake_case) - required for stream messages only
      artifactId: artifact_id || null, // Backend sends artifact_id (snake_case)
      nodeId: node_id || null, // Backend sends node_id (snake_case)
      subgroupId: subgroup_id || null, // Backend sends subgroup_id (snake_case)
      sequenceInChat: sequence_in_chat || null, // Backend sends sequence_in_chat for positioned messages
      messageId: message_id || null, // Backend sends message_id for persisted messages
      raw: payload // Preserve original for debugging
    };
  }

  /**
   * Check if message is artifact (code/console/output)
   * @param {Object} normalized - Normalized message
   * @returns {boolean}
   */
  static isArtifact(normalized) {
    const { role, type, format } = normalized;

    // Code artifacts (assistant writes code)
    if (role === 'assistant' && type === 'code') {
      return true;
    }

    // Console output (computer execution results)
    if (role === 'computer' && (type === 'console' || type === 'output')) {
      return true;
    }

    // HTML artifacts (rendered output)
    if (role === 'computer' && type === 'code' && format === 'html') {
      return true;
    }

    return false;
  }

  /**
   * Check if message is assistant text stream or message flush
   * @param {Object} normalized - Normalized message
   * @returns {boolean}
   */
  static isAssistantMessage(normalized) {
    // Assistant text messages with streaming protocol (requires requestId)
    if (normalized.role === 'assistant' && (
      normalized.type === 'message' ||
      normalized.type === 'assistant.message_flushed'
    )) {
      return true;
    }
    
    return false;
  }

  /**
   * Check if message is handsfree event (wake-word-detected, sleep-word-detected)
   * @param {Object} normalized - Normalized message
   * @returns {boolean}
   */
  static isHandsfreeEvent(normalized) {
    const handsfreeTypes = [
      'wake-word-detected',
      'sleep-word-detected',
      'stt-final',
      'stt-partial',
      'tts-queued',
      'tts-completed',
      'tts-audio',
      'tts-error',
      'interruption-detected',
    ];
    return normalized.role === 'assistant' && handsfreeTypes.includes(normalized.type);
  }

  /**
   * Check if message is proactive notification
   * @param {Object} normalized - Normalized message
   * @returns {boolean}
   */
  static isProactiveNotification(normalized) {
    return normalized.role === 'proactive' || 
           (typeof normalized.type === 'string' && normalized.type.startsWith('proactive'));
  }

  /**
   * Check if message is trail event
   * @param {Object} normalized - Normalized message
   * @returns {boolean}
   */
  static isTrailEvent(normalized) {
    return normalized.role === 'server' && typeof normalized.type === 'string' && normalized.type.startsWith('trail.');
  }

  /**
   * Check if message is control message (completion/stopped/error/context_reset_ack/path/user.message_persisted)
   * @param {Object} normalized - Normalized message
   * @returns {boolean}
   */
  static isControlMessage(normalized) {
    if (normalized.role === 'server' && normalized.type === 'completion') {
      return true;
    }
    if (normalized.role === 'server' && normalized.type === 'stopped') {
      return true;
    }
    if (normalized.role === 'server' && normalized.type === 'context_reset_ack') {
      return true;
    }
    if (normalized.role === 'server' && normalized.type === 'info') {
      return true;
    }
    if (normalized.role === 'server' && normalized.type === 'path') {
      return true;
    }
    if (normalized.role === 'system') {
      return true;
    }
    if (typeof normalized.type === 'string' && normalized.type.startsWith('system.')) {
      return true;
    }
    if (normalized.type === 'error') {
      return true;
    }
    // User message persisted notification (UUID update)
    if (normalized.type === 'user.message_persisted') {
      return true;
    }
    return false;
  }

  /**
   * Get artifact type for logging
   * @param {Object} normalized - Normalized message
   * @returns {string|null}
   */
  static getArtifactType(normalized) {
    const { role, type, format } = normalized;

    if (role === 'assistant' && type === 'code') {
      return 'code';
    }

    if (role === 'computer' && (type === 'console' || type === 'output')) {
      return 'console';
    }

    if (role === 'computer' && type === 'code' && format === 'html') {
      return 'html';
    }

    return null;
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MessageParser;
}

if (typeof window !== 'undefined') {
  window.MessageParser = MessageParser;
}
