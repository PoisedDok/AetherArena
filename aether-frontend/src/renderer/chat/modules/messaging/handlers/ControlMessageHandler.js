'use strict';

/**
 * @.architecture
 *
 * Incoming: Normalized control messages (completion/stopped/error) from router --- {control_message, json}
 * Processing: Update processing state, finalize streams, clear UI --- {3 jobs: JOB_UPDATE_STATE, JOB_FINALIZE_STREAM, JOB_CLEAR_UI}
 * Outgoing: StreamHandler finalization, state updates --- {method_call, void}
 *
 * @module renderer/chat/modules/messaging/handlers/ControlMessageHandler
 */

const { createRendererLogger } = require('../../../../shared/utils/logger');

const controlHandlerLogger = createRendererLogger('ControlMessageHandler');

/**
 * ControlMessageHandler - Control Message Processing
 * ===================================================
 * 
 * SINGLE RESPONSIBILITY: Handle control messages (completion, stop, error)
 * 
 * RESPONSIBILITIES:
 * - Process completion signals
 * - Handle stop confirmations
 * - Handle error messages
 * - Finalize active streams
 * - Update UI state
 * 
 * CONTRACTS:
 * - Delegates finalization to StreamHandler
 * - Updates processing/stop state via callbacks
 * - NO business logic
 * 
 * @module renderer/chat/modules/messaging/handlers/ControlMessageHandler
 */
class ControlMessageHandler {
  constructor(options = {}) {
    this.streamHandler = options.streamHandler || null;
    this.messageState = options.messageState || null;
    this.messageView = options.messageView || null;
    this.onProcessingChange = options.onProcessingChange || null;
    this.onStopModeChange = options.onStopModeChange || null;
    this.log = controlHandlerLogger.child({ scope: 'control-message-handler' });

    if (!this.streamHandler) {
      throw new Error('[ControlMessageHandler] streamHandler is REQUIRED');
    }

    // Lifecycle
    this._isDisposed = false;

    this.log.info('ControlMessageHandler initialized');
  }

  /**
   * Handle control message
   * @param {Object} normalized - Normalized control message
   */
  async handleControl(normalized) {
    if (this._isDisposed) return;

    const { type, id, role } = normalized;

    // Completion signal
    if (type === 'completion') {
      this.log.info('Request completion received', { messageId: id });
      await this._finalizeRequest();
      return;
    }

    // Stop confirmation
    if (type === 'stopped') {
      this.log.info('Request stop confirmation received', { messageId: id });
      await this._finalizeRequest();
      return;
    }

    // System-scoped messages (informational)
    if (typeof type === 'string' && type.startsWith('system.')) {
      if (type === 'system.error') {
        this.log.error('Backend system error received via WebSocket', normalized.raw);
        await this._handleErrorMessage(normalized);
        await this._finalizeRequest();
        return;
      }
      await this._handleSystemMessage(normalized);
      return;
    }

    if (role === 'system' || type === 'system' || type === 'info') {
      await this._handleSystemMessage(normalized);
      return;
    }

    // Error
    if (type === 'error') {
      this.log.error('Backend error received via WebSocket', normalized.raw);
      await this._handleErrorMessage(normalized);
      await this._finalizeRequest();
      return;
    }

    // Context reset acknowledgment (informational, no action needed)
    if (type === 'context_reset_ack') {
      this.log.trace('Context reset acknowledged by backend', { messageId: id });
      return;
    }

    // Path message (informational, no action needed)
    if (type === 'path') {
      this.log.trace('Path information received from backend', { messageId: id });
      return;
    }

    // User message persisted - update local message with backend UUID
    if (type === 'user.message_persisted') {
      await this._handleUserMessagePersisted(normalized);
      return;
    }

    this.log.warn('Unknown control message type', { type });
  }

  /**
   * Handle error message from backend
   * Display user-friendly error in chat UI
   * @private
   */
  async _handleErrorMessage(normalized) {
    const { raw } = normalized;
    
    // Extract error details
    const userMessage = raw.content || raw.message || raw?.data?.message || 'An error occurred while processing your request.';
    const errorDetails = raw.error_details || {};
    const category = errorDetails.category || 'unknown';
    const suggestions = errorDetails.suggestions || [];
    
    this.log.info('Displaying LLM error in chat', { 
      category, 
      userMessage: userMessage.substring(0, 100) 
    });
    
    // Create error message for display
    const errorMessageContent = this._formatErrorMessage(
      userMessage,
      category,
      errorDetails.technical_details,
      suggestions
    );
    
    // Display in chat via MessageView
    if (this.messageView) {
      const errorMessageId = `error_${Date.now()}`;
      this.messageView.renderMessage({
        id: errorMessageId,
        role: 'system',
        type: 'error',
        content: errorMessageContent,
        timestamp: Date.now(),
        error_category: category,
        error_details: errorDetails
      });
    }
  }

  /**
   * Handle system informational messages.
   * @private
   */
  async _handleSystemMessage(normalized) {
    const { raw } = normalized;
    const message = raw.content || raw.message || raw?.data?.message || 'System notification received.';
    const metadata = raw.metadata || raw.data || {};

    this.log.info('System message received', { type: raw.type, preview: message.substring(0, 80) });

    if (this.messageView) {
      const systemMessageId = `system_${Date.now()}`;
      this.messageView.renderMessage({
        id: systemMessageId,
        role: 'system',
        type: raw.type || 'system',
        content: message,
        timestamp: Date.now(),
        metadata
      });
    }
  }
  
  /**
   * Format error message with details and suggestions
   * @private
   */
  _formatErrorMessage(userMessage, category, technicalDetails, suggestions) {
    let formatted = `**${this._getCategoryIcon(category)} Provider Error**\n\n`;
    formatted += `${userMessage}\n\n`;
    
    if (technicalDetails) {
      formatted += `**Technical Details:** ${technicalDetails}\n\n`;
    }
    
    if (suggestions && suggestions.length > 0) {
      formatted += `**Suggestions:**\n`;
      suggestions.forEach(suggestion => {
        formatted += `- ${suggestion}\n`;
      });
    }
    
    return formatted;
  }
  
  /**
   * Get icon for error category
   * @private
   */
  _getCategoryIcon(category) {
    const icons = {
      'context_length': '📏',
      'authentication': '🔑',
      'rate_limit': '⏱️',
      'connection': '🔌',
      'model_error': '🤖',
      'invalid_request': '❌',
      'unknown': '⚠️'
    };
    return icons[category] || icons['unknown'];
  }

  /**
   * Handle user message persistence notification from backend
   * ARCHITECTURAL FIX: Update frontend's live message with backend UUID
   * This allows artifact matching for live messages before chat reload
   * @private
   */
  async _handleUserMessagePersisted(normalized) {
    const { messageId, raw } = normalized;
    const { correlation_id, chat_id, sequence_in_chat } = raw || {};

    if (!messageId) {
      this.log.warn('Invalid user.message_persisted payload - missing messageId', { messageId, correlation_id });
      return;
    }
    
    // Handsfree messages may not have correlation_id (or have handsfree-* prefix)
    // Only log if we have a correlation_id to track
    if (correlation_id) {
      this.log.info('User message persisted - updating local state', { 
        frontendId: correlation_id, 
        backendId: messageId,
        sequence: sequence_in_chat
      });
    } else {
      this.log.debug('User message persisted (handsfree)', { backendId: messageId, sequence: sequence_in_chat });
    }

    let frontendMessageId = correlation_id || null;

    // Update or CREATE message (for handsfree backend-generated messages)
    if (this.messageState && correlation_id) {
      const message = this.messageState.messages.find(m => m.id === correlation_id || m.correlation_id === correlation_id);
      if (message) {
        // Existing message (normal text input flow) - update ID
        const oldId = message.id;
        message.id = messageId;
        message.backend_id = messageId;
        message.sequence_in_chat = sequence_in_chat; // Store sequence
        frontendMessageId = oldId;
        this.log.debug('Updated message ID and sequence in state', { oldId, newId: messageId, sequence: sequence_in_chat });
      } else if (raw.content && raw.is_handsfree) {
        // Handsfree message - CREATE new message with backend content
        const newMessage = {
          id: messageId,
          backend_id: messageId,
          correlation_id: correlation_id,
          role: 'user',
          content: raw.content,
          chat_id: chat_id,
          sequence_in_chat: sequence_in_chat, // Set sequence
          timestamp: new Date().toISOString(),
          isHandsfree: true
        };
        this.messageState.messages.push(newMessage);
        this.log.info('Created handsfree user message in state', { messageId, correlationId: correlation_id, sequence: sequence_in_chat });
        
        // Render message in chat window
        if (this.messageView) {
          this.messageView.renderMessage(newMessage);
        }
      } else {
        this.log.warn('Could not find message to update', { correlation_id, hasContent: !!raw.content });
      }
    }

    // Update DOM element (only for pre-existing messages from text input)
    if (this.messageView && frontendMessageId && !raw.is_handsfree) {
      const element = this.messageView.getMessageElement(frontendMessageId);
      if (element) {
        element.dataset.messageId = messageId;
        element.dataset.backendId = messageId;
        
        // ARCHITECTURAL FIX: Apply timeline sequence to DOM
        if (sequence_in_chat !== undefined) {
          element.dataset.sequence = sequence_in_chat;
        }
        
        this.messageView.messageElements.delete(frontendMessageId);
        this.messageView.messageElements.set(messageId, element);
        this.log.debug('Updated message element in DOM', { 
          oldId: frontendMessageId, 
          newId: messageId, 
          sequence: sequence_in_chat 
        });
      }
    }
  }

  /**
   * Finalize request (stop, completion, or error)
   * @private
   */
  async _finalizeRequest() {
    // Update state
    if (this.onProcessingChange) {
      this.onProcessingChange(false);
    }

    if (this.onStopModeChange) {
      this.onStopModeChange(false);
    }

    // Finalize active stream
    if (this.streamHandler) {
      await this.streamHandler.forceFinalize();
    }

    this.log.trace('Request finalized');
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;

    this.streamHandler = null;
    this.messageState = null;
    this.messageView = null;
    this.onProcessingChange = null;
    this.onStopModeChange = null;
    this.log.info('ControlMessageHandler disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ControlMessageHandler;
}

if (typeof window !== 'undefined') {
  window.ControlMessageHandler = ControlMessageHandler;
}
