'use strict';

/**
 * @.architecture
 * Incoming: Endpoint facade, ChatLibraryModal, ChatWindow --- {method_call, javascript_api}
 * Processing: Dispatch chat management and cross-chat reference HTTP requests --- {2 jobs: JOB_HTTP_REQUEST, JOB_VALIDATE_SCHEMA}
 * Outgoing: ApiClient -> /v1/storage/chat/*, /v1/storage/summary/*, /v1/search/chats --- {http_request, json}
 *
 * @module core/communication/api/ChatApi
 */

const BaseApi = require('./BaseApi');

class ChatApi extends BaseApi {
  /**
   * List all chats.
   * @param {number} [skip=0] - Offset
   * @param {number} [limit=50] - Max results
   * @returns {Promise<Array>}
   */
  async listChats(skip = 0, limit = 50) {
    return this._request('GET', '/v1/storage/chat/list', { params: { skip, limit } });
  }

  /**
   * Update chat.
   * @param {string} chatId - Chat UUID (REQUIRED)
   * @param {Object} updates - Fields to update (e.g., { title: "New Title" })
   * @returns {Promise<Object>}
   */
  async updateChat(chatId, updates) {
    this._requireParam(chatId, 'chatId', 'updateChat');
    const path = this._encodePath('/v1/storage/chat/update/:id', { id: chatId });
    return this._request('PUT', path, { body: updates, logContext: { chatId } });
  }

  /**
   * Delete chat.
   * @param {string} chatId - Chat UUID (REQUIRED)
   * @returns {Promise<void>}
   */
  async deleteChat(chatId) {
    this._requireParam(chatId, 'chatId', 'deleteChat');
    const path = this._encodePath('/v1/storage/chat/delete/:id', { id: chatId });
    try {
      await this._api.delete(path);
    } catch (error) {
      if (!error.isBackendUnavailableError) {
        this._log.error(`DELETE /v1/storage/chat/delete/${chatId} failed`, {
          error: error?.message || error,
          chatId
        });
      }
      throw error;
    }
  }

  /**
   * List artifacts for a chat.
   * @param {string} chatId - Chat UUID (REQUIRED)
   * @param {string} [artifactType] - Optional type filter
   * @param {number} [limit=100] - Max results
   * @param {number} [offset=0] - Offset
   * @returns {Promise<Array>}
   */
  async listChatArtifacts(chatId, artifactType = null, limit = 100, offset = 0) {
    this._requireParam(chatId, 'chatId', 'listChatArtifacts');
    const path = this._encodePath('/v1/storage/artifact/list/:id', { id: chatId });
    const params = { limit, offset };
    if (artifactType) params.artifact_type = artifactType;
    return this._request('GET', path, { params, logContext: { chatId } });
  }

  /**
   * List all artifacts from recent chats (aggregated).
   * NOTE: This method contains application-layer aggregation logic.
   * It performs N+1 sequential API calls. Consider moving to an application service.
   * @param {number} [maxChats=50] - Max chats to fetch artifacts from
   * @returns {Promise<Array>}
   */
  async listAllArtifacts(maxChats = 50) {
    try {
      const chatsResponse = await this.listChats(0, maxChats);
      const chats = chatsResponse.data || chatsResponse;

      const allArtifacts = [];
      for (const chat of chats) {
        try {
          const artifactsResponse = await this.listChatArtifacts(chat.id);
          const artifacts = (artifactsResponse.data || artifactsResponse).map(a => ({
            ...a,
            chat_id: chat.id,
            chat_title: chat.title
          }));
          allArtifacts.push(...artifacts);
        } catch (error) {
          // Fail gracefully per-chat
          this._log.warn(`Failed to fetch artifacts for chat ${chat.id}`, { error: error?.message });
        }
      }

      return allArtifacts;
    } catch (error) {
      this._log.error('Failed to aggregate artifacts', { error: error?.message || error });
      throw error;
    }
  }

  /**
   * Generate chat summary.
   * @param {string} chatId - Chat UUID (REQUIRED)
   * @param {string} [summaryType='full'] - Type: 'full', 'brief', 'technical'
   * @returns {Promise<Object>} Chat summary with title, key_points, entities
   */
  async summarizeChat(chatId, summaryType = 'full') {
    this._requireParam(chatId, 'chatId', 'summarizeChat');
    const path = this._encodePath('/v1/storage/summary/create/:id', { id: chatId });
    return this._request('POST', path, {
      body: { summary_type: summaryType },
      logContext: { chatId, summaryType }
    });
  }

  /**
   * Get chat summaries.
   * @param {string} chatId - Chat UUID (REQUIRED)
   * @returns {Promise<Array>} List of chat summaries
   */
  async getChatSummaries(chatId) {
    this._requireParam(chatId, 'chatId', 'getChatSummaries');
    const path = this._encodePath('/v1/storage/summary/list/:id', { id: chatId });
    return this._request('GET', path, { logContext: { chatId } });
  }

  /**
   * Search chats (full-text + vector search).
   * @param {string} query - Search query (REQUIRED)
   * @param {Object} [options] - { limit, searchType, minScore }
   * @returns {Promise<Object>} Search results { query, results, total_count }
   */
  async searchChats(query, options = {}) {
    this._requireString(query, 'query', 'searchChats');
    const payload = {
      query,
      limit: options.limit || 20
    };
    return this._request('POST', '/v1/search/chats', {
      body: payload,
      logContext: { queryLength: query.length }
    });
  }
}

module.exports = ChatApi;
