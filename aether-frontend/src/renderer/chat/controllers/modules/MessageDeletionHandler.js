'use strict';

/**
 * @.architecture
 *
 * Incoming: EventBus CHAT.MESSAGE_DELETED | ARTIFACTS.ARTIFACT_DELETED events --- {event.custom, object}
 * Processing: Find and remove DOM entries for deleted messages (user + trail + assistant), refresh context display --- {3 jobs: JOB_FIND_DOM_ENTRY, JOB_REMOVE_DOM_ENTRY, JOB_REFRESH_CONTEXT}
 * Outgoing: DOM mutations (entry removal), context display refresh --- {dom_mutation | method_call, void}
 *
 * @module renderer/chat/controllers/modules/MessageDeletionHandler
 *
 * MessageDeletionHandler - Message & Artifact Deletion
 * ============================================================================
 * Extracted from ChatController monolith. Handles DOM cleanup when messages
 * or artifacts are deleted via ContextViewerModal/ChatFilesModal.
 *
 * SINGLE RESPONSIBILITY: Process deletion events and remove corresponding
 * DOM elements from the chat view.
 */

const { createRendererLogger } = require('../../../shared/utils/logger');

const logger = createRendererLogger('MessageDeletionHandler');

class MessageDeletionHandler {
  constructor() {
    this.log = logger.child({ scope: 'deletion-handler' });
    this.log.debug('MessageDeletionHandler initialized');
  }

  /**
   * Handle message deletion (from ContextViewerModal).
   * Removes user message, trail containers, and assistant message from DOM.
   * @param {Object} data - Deletion data
   * @param {string} data.chatId - Chat ID
   * @param {string} data.messageId - Deleted user message ID
   * @param {number} [data.deletedMessages] - Count of deleted messages
   * @param {number} [data.deletedArtifacts] - Count of deleted artifacts
   * @param {Object} deps - Runtime dependencies
   * @param {Object} [deps.messageView] - MessageView module with contentElement
   * @param {Object} [deps.messageState] - MessageState module
   * @param {Object} [deps.chatWindow] - ChatWindow module with refreshContextDisplay
   */
  handleMessageDeleted(data, deps) {
    try {
      const { chatId, messageId, deletedMessages, deletedArtifacts } = data;

      // Delegate deletion to domain state and view layer
      const { messageState, messageView, chatWindow } = deps;

      if (messageState && typeof messageState.removeMessageSequence === 'function') {
        messageState.removeMessageSequence(messageId);
      }

      if (messageView && typeof messageView.removeMessageSequence === 'function') {
        const removed = messageView.removeMessageSequence(messageId);
        if (removed) {
          this.log.info('Removed deleted messages from DOM via MessageView', {
            chatId,
            messageId,
            deletedMessages,
            deletedArtifacts
          });
        }
      }

      // Refresh context display after deletion
      // This updates the circular ring button with new token counts
      if (chatWindow && typeof chatWindow.refreshContextDisplay === 'function') {
        chatWindow.refreshContextDisplay();
      }

    } catch (error) {
      this.log.error('Failed to handle message deletion', { error, data });
    }
  }

  /**
   * Handle artifact deletion (from ChatFilesModal or ArtifactsLibraryModal).
   * @param {Object} data - Deletion data
   * @param {string} data.chatId - Chat ID
   * @param {string} data.artifactId - Deleted artifact ID
   */
  handleArtifactDeleted(data) {
    try {
      const { chatId, artifactId } = data;

      this.log.info('Artifact deleted, local state updated by modal', {
        chatId,
        artifactId
      });

      // No DOM changes needed - artifacts are not directly rendered in message view
      // FileManager and other components handle their own state updates

    } catch (error) {
      this.log.error('Failed to handle artifact deletion', { error, data });
    }
  }

  /**
   * Dispose (no-op for stateless handler, included for interface consistency).
   */
  dispose() {
    this.log.debug('MessageDeletionHandler disposed');
  }
}

module.exports = MessageDeletionHandler;
