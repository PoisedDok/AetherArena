'use strict';

/**
 * @.architecture
 * Incoming: Endpoint facade, ContextViewerModal --- {method_call, javascript_api}
 * Processing: Dispatch context management HTTP requests --- {2 jobs: JOB_HTTP_REQUEST, JOB_VALIDATE_SCHEMA}
 * Outgoing: ApiClient -> /v1/context/chats/* --- {http_request, json}
 *
 * @module core/communication/api/ContextApi
 */

const BaseApi = require('./BaseApi');

class ContextApi extends BaseApi {
  /**
   * Get current context messages for a chat.
   * @param {string} chatId - Chat UUID (REQUIRED)
   * @returns {Promise<Object>} Context messages with metadata
   */
  async getContextMessages(chatId) {
    this._requireParam(chatId, 'chatId', 'getContextMessages');
    const path = this._encodePath('/v1/context/chats/:id/context/messages', { id: chatId });
    return this._request('GET', path, { logContext: { chatId } });
  }

  /**
   * Get context status for a chat.
   * @param {string} chatId - Chat UUID (REQUIRED)
   * @returns {Promise<Object>} Context status with token usage
   */
  async getContextStatus(chatId) {
    this._requireParam(chatId, 'chatId', 'getContextStatus');
    const path = this._encodePath('/v1/context/chats/:id/context/status', { id: chatId });
    return this._request('GET', path, { logContext: { chatId } });
  }

  /**
   * Delete message group (user message + assistant response + artifacts).
   * @param {string} chatId - Chat UUID (REQUIRED)
   * @param {string} messageId - User message UUID (REQUIRED)
   * @returns {Promise<Object>} Deletion summary
   */
  async deleteMessageGroup(chatId, messageId) {
    if (!chatId || !messageId) {
      throw new Error('[Endpoint] chatId and messageId are required for deleteMessageGroup');
    }
    const path = `/v1/context/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`;
    return this._request('DELETE', path, { logContext: { chatId, messageId } });
  }
}

module.exports = ContextApi;
