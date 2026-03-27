'use strict';

/**
 * @.architecture
 *
 * Incoming: Selected chat objects from ChatSelectorModal --- {chat_objects[], object}
 * Processing: Download summaries via aether.chatSummaries, build JSON file content, create File blobs, add to FileManager queue --- {4 jobs: JOB_DOWNLOAD_SUMMARY, JOB_BUILD_JSON, JOB_CREATE_FILE, JOB_ADD_TO_QUEUE}
 * Outgoing: File attachments added to FileManager queue, preview UI updated --- {file_queue_mutation | dom_update, void}
 *
 * @module renderer/chat/controllers/modules/ChatSummaryAttacher
 *
 * ChatSummaryAttacher - Chat Summary File Attachment
 * ============================================================================
 * Extracted from ChatController monolith. Handles downloading chat summaries
 * and attaching them as JSON files to the FileManager queue.
 *
 * SINGLE RESPONSIBILITY: Convert chat summaries into file attachments.
 */

const { createRendererLogger } = require('../../../shared/utils/logger');

const logger = createRendererLogger('ChatSummaryAttacher');

class ChatSummaryAttacher {
  constructor(options = {}) {
    this.aether = options.aether || null;
    this.log = logger.child({ scope: 'chat-summary-attacher' });

    this.log.debug('ChatSummaryAttacher initialized');
  }

  /**
   * Attach chat summaries as regular file attachments.
   * Downloads summaries from the backend and creates JSON File blobs.
   * @param {Array} selectedChats - Array of chat objects to attach summaries for
   * @param {Object} fileManager - FileManager module instance
   */
  async attach(selectedChats, fileManager) {
    if (!fileManager) {
      this.log.error('FileManager not initialized');
      return;
    }

    this.log.info('Attaching chat summaries as files', { count: selectedChats.length });

    for (const chat of selectedChats) {
      try {
        // Get summary
        let summaries = [];
        const chatSummaries = this.aether?.chatSummaries || null;
        if (chatSummaries) {
          summaries = await chatSummaries.list(chat.id);
        }

        let summary = summaries && summaries.length > 0 ? summaries[0] : null;

        if (!summary) {
          this.log.warn('No summary available for chat - skipping attachment', { chatId: chat.id });
          continue;
        }

        // Create file content
        const keyPoints = Array.isArray(summary.key_points)
          ? summary.key_points
          : Array.isArray(summary.keyPoints)
            ? summary.keyPoints
            : Array.isArray(summary.key_topics)
              ? summary.key_topics
              : [];
        const summaryText = summary.summary_text
          || summary.summary
          || summary.content
          || (keyPoints.length > 0 ? keyPoints.map(point => `- ${point}`).join('\n') : 'No summary available');

        const summaryContent = {
          type: 'chat_summary',
          chat_id: chat.id,
          chat_title: chat.title || 'Untitled Chat',
          summary: summaryText,
          key_points: keyPoints,
          entities: summary.entities || {},
          summary_id: summary.id || null,
          summary_type: summary.summary_type || 'full',
          summary_model: summary.llm_model || null,
          summary_created_at: summary.created_at || null,
          chat_created_at: chat.created_at || null,
          chat_updated_at: chat.updated_at || null,
          metadata: {
            chat_id: chat.id,
            api_paths: {
              chat: `/v1/storage/chat/get/${chat.id}`,
              messages: `/v1/storage/message/list/${chat.id}`,
              artifacts: `/v1/storage/artifact/list/${chat.id}`,
              summaries: `/v1/storage/summary/list/${chat.id}`,
              context_messages: `/v1/context/chats/${chat.id}/context/messages`
            }
          }
        };

        const jsonContent = JSON.stringify(summaryContent, null, 2);
        const blob = new Blob([jsonContent], { type: 'application/json' });
        const fileName = `${(chat.title || 'chat').replace(/[^a-z0-9]/gi, '_')}_summary.json`;
        const file = new File([blob], fileName, { type: 'application/json' });

        // Add to FileManager queue
        await fileManager._addFileToQueue(file);

        this.log.info('Chat summary attached as file', {
          chatId: chat.id,
          chatTitle: chat.title,
          fileName
        });

      } catch (error) {
        this.log.error('Failed to attach summary for chat', {
          chatId: chat.id,
          error: error.message || error
        });
      }
    }

    // Update preview UI
    if (fileManager._updatePreviewUI) {
      fileManager._updatePreviewUI();
    }
  }

  /**
   * Dispose and cleanup.
   */
  dispose() {
    this.aether = null;
    this.log.debug('ChatSummaryAttacher disposed');
  }
}

module.exports = ChatSummaryAttacher;
