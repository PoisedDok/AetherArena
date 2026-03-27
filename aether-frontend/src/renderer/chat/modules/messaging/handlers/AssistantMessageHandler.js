'use strict';

/**
 * @.architecture
 *
 * Incoming: Normalized assistant message chunks from router --- {normalized_message, json}
 * Processing: Delegate to StreamHandler for processing --- {1 job: JOB_DELEGATE_TO_MODULE}
 * Outgoing: StreamHandler.processChunk() calls --- {method_call, void}
 *
 * @module renderer/chat/modules/messaging/handlers/AssistantMessageHandler
 */

const { createRendererLogger } = require('../../../../shared/utils/logger');

const messageHandlerLogger = createRendererLogger('AssistantMessageHandler');

/**
 * AssistantMessageHandler - Assistant Message Stream Handler
 * ===========================================================
 * 
 * SINGLE RESPONSIBILITY: Handle assistant text message streams
 * 
 * DELEGATION:
 * Pure delegation to StreamHandler—no business logic here.
 * This provides clean separation between routing and stream processing.
 * 
 * CONTRACTS:
 * - NO business logic
 * - Pure delegation
 * 
 * @module renderer/chat/modules/messaging/handlers/AssistantMessageHandler
 */
class AssistantMessageHandler {
  constructor(options = {}) {
    this.streamHandler = options.streamHandler || null;
    this.log = messageHandlerLogger.child({ scope: 'assistant-message-handler' });

    if (!this.streamHandler) {
      throw new Error('[AssistantMessageHandler] streamHandler is REQUIRED');
    }

    // Lifecycle
    this._isDisposed = false;

    this.log.info('AssistantMessageHandler initialized');
  }

  /**
   * Handle assistant message
   * @param {Object} normalized - Normalized message
   */
  async handleMessage(normalized) {
    if (this._isDisposed) return;

    const { requestId, content, start, end, type, sequenceInChat, messageId } = normalized;

    // Handle assistant.message_flushed event (positioned message)
    if (type === 'assistant.message_flushed') {
      this.log.debug('Assistant message flush received', { sequenceInChat, messageId, contentLength: normalized.content?.length });
      
      // ARCHITECTURAL FIX: Guard against NaN or invalid sequences
      if (!Number.isFinite(sequenceInChat) || sequenceInChat < 1) {
        this.log.error('ARCHITECTURAL FAILURE: Invalid sequence for flushed message', { sequenceInChat });
        throw new Error(`Invalid sequence ${sequenceInChat} for flushed assistant message`);
      }

      // CRITICAL FIX: Remove old streaming message element to prevent duplicates
      // The flushed message REPLACES the streaming text, not adds to it
      if (this.streamHandler) {
        const oldMessageId = this.streamHandler.currentMessageId;
        
        // Remove the streaming message element from DOM
        if (oldMessageId && this.streamHandler.messageView) {
          this.streamHandler.messageView.removeMessage(oldMessageId);
          this.log.debug('Removed old streaming message', { oldMessageId });
        }
        
        // Clear streaming state
        this.streamHandler.accumulatedText = '';
        this.streamHandler.currentMessageId = null;
        this.streamHandler.currentRequestId = null;
      }
      
      // Create NEW positioned message element with provided content and sequence
      if (this.streamHandler && this.streamHandler.messageView && normalized.content) {
        const messageView = this.streamHandler.messageView;
        
        // Render message - this creates the DOM element
        const messageElement = messageView.renderMessage({
          id: messageId,
          role: 'assistant',
          content: normalized.content,
          sequence_in_chat: sequenceInChat,
          timestamp: new Date().toISOString(),
        });
        
        if (messageElement) {
          messageElement.classList.add('positioned-message');
          
          // ARCHITECTURAL FIX: Robust sort-based positioning (Zero Drift)
          const contentEl = messageView.contentElement;
          const allEntries = Array.from(contentEl.querySelectorAll('.chat-entry'));
          
          const sequencedEntries = allEntries
            .map(el => ({
              element: el,
              sequence: parseInt(el.dataset.sequence, 10)
            }))
            .filter(({ sequence }) => Number.isFinite(sequence) && sequence > 0)
            .sort((a, b) => a.sequence - b.sequence);
          
          // Find insertion point: after the element with highest sequence < our sequence
          let insertAfter = null;
          for (const { element, sequence } of sequencedEntries) {
            if (sequence < sequenceInChat) {
              insertAfter = element;
            } else {
              break;
            }
          }
          
          // Reposition if needed
          if (insertAfter && insertAfter.nextSibling !== messageElement) {
            contentEl.insertBefore(messageElement, insertAfter.nextSibling);
          } else if (!insertAfter && allEntries.length > 1) {
            // If no insertAfter found but entries exist, it means this message is the EARLIEST
            contentEl.insertBefore(messageElement, contentEl.firstChild);
          }
          
          this.log.debug('Assistant message created and positioned', {
            messageId,
            sequence: sequenceInChat,
            insertedAfterSeq: insertAfter?.dataset.sequence
          });
        } else {
          this.log.error('Failed to create message element for flush event', { messageId, sequenceInChat });
        }
      }
      return;
    }

    // CONTRACT: Backend sends request_id (snake_case) - use it for request identification
    // Frontend generates its own message IDs for rendering via StreamHandler._generateMessageId()
    if (!requestId || typeof requestId !== 'string') {
      throw new Error(`[AssistantMessageHandler] CONTRACT VIOLATION: normalized.requestId is required. Received: ${JSON.stringify(Object.keys(normalized))}`);
    }

    // Start marker
    if (start) {
      this.log.debug('Assistant stream started', { requestId });
      await this.streamHandler.processChunk({
        request_id: requestId,
        chunk: '',
        start: true
      });
      return;
    }

    // End marker
    if (end) {
      this.log.debug('Assistant stream ended', { requestId });
      await this.streamHandler.processChunk({
        request_id: requestId,
        chunk: '',
        done: true
      });
      return;
    }

    // Content delta
    if (content) {
      this.log.trace('Assistant chunk received', {
        requestId,
        length: content.length
      });

      await this.streamHandler.processChunk({
        request_id: requestId,
        chunk: content
      });
    }
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;

    this.streamHandler = null;
    this.log.info('AssistantMessageHandler disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AssistantMessageHandler;
}

if (typeof window !== 'undefined') {
  window.AssistantMessageHandler = AssistantMessageHandler;
}
