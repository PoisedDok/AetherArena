'use strict';

/**
 * @.architecture
 * 
 * Incoming: ChatController (context requests), backend REST API (/v1/context/chats/{id}/context/*) --- {event | http_response, json}
 * Processing: Fetch context status/summarization/export, emit EventBus events --- {3 jobs: JOB_HTTP_REQUEST, JOB_EMIT_EVENT, JOB_TRANSFORM_DATA}
 * Outgoing: EventBus context events, HTTP responses --- {event | http_response, json}
 * 
 * @module application/chat/ContextService
 * 
 * ContextService - Conversation Context Management
 * ================================================
 * 
 * Responsibilities:
 * - Fetch context status from backend REST API
 * - Request manual summarization
 * - Export context for cross-chat reasoning
 * - Emit EventBus events for UI updates
 * 
 * Architecture:
 * - Application layer (orchestrates HTTP requests)
 * - NO rendering, NO DOM manipulation
 * - Backend is authoritative for context data
 * - Frontend = pure UI renderer
 */

const { createRendererLogger } = require('../../renderer/shared/utils/logger');
const _log = createRendererLogger('ContextService');

class ContextService {
  constructor(options = {}) {
    // Dependencies
    this.eventBus = options.eventBus || null;
    
    // Configuration
    this.enableLogging = options.enableLogging !== undefined ? options.enableLogging : false;
    this.apiClient = options.apiClient;
    
    // CONTRACT: apiClient is required
    if (!this.apiClient) {
      throw new Error('[ContextService] CONTRACT VIOLATION: apiClient is required.');
    }
    
    // Validation
    if (!this.eventBus) {
      _log.warn('[ContextService] eventBus not provided - event emission disabled');
    }
  }
  
  /**
   * Get context status for chat
   * @param {string} chatId - Chat identifier
   * @returns {Promise<Object>} Context status object
   */
  async getContextStatus(chatId) {
    if (!chatId) {
      throw new Error('[ContextService] chatId is required');
    }

    if (this.enableLogging) {
      _log.debug(`[ContextService] Getting context status for chat ${chatId.substring(0, 8)}`);
    }

    try {
      const status = await this.apiClient.get(`/v1/context/chats/${chatId}/context/status`);
      
      if (this.enableLogging) {
        _log.debug(`[ContextService] Context status for chat ${chatId.substring(0, 8)}:`, {
          status: status.status,
          tokenCount: status.token_count,
          usagePercent: status.usage_percent
        });
      }
      
      // Emit event for UI updates
      this.emitContextUpdate(status);
      
      return status;
      
    } catch (error) {
      _log.error('[ContextService] Failed to get context status:', error);
      throw error;
    }
  }
  
  /**
   * Request manual summarization for chat
   * @param {string} chatId - Chat identifier
   * @returns {Promise<Object>} Summarization result
   */
  async requestSummarization(chatId) {
    if (!chatId) {
      throw new Error('[ContextService] chatId is required');
    }
    
    if (this.enableLogging) {
      _log.debug(`[ContextService] Requesting summarization for chat ${chatId.substring(0, 8)}`);
    }
    
    try {
      const result = await this.apiClient.post(`/v1/context/chats/${chatId}/context/summarize`);
      
      if (this.enableLogging) {
        _log.debug(`[ContextService] Summarization result for chat ${chatId.substring(0, 8)}:`, {
          success: result.success,
          tokensSaved: result.tokens_saved
        });
      }
      
      // Emit event for UI updates
      if (this.eventBus) {
        this.eventBus.emit('context:summarized', {
          chatId,
          result,
          timestamp: Date.now()
        });
      }
      
      return result;
      
    } catch (error) {
      _log.error('[ContextService] Failed to summarize context:', error);
      throw error;
    }
  }
  
  /**
   * Export context for cross-chat use
   * @param {string} chatId - Chat identifier
   * @returns {Promise<Object>} Exported context
   */
  async exportContext(chatId) {
    if (!chatId) {
      throw new Error('[ContextService] chatId is required');
    }
    
    if (this.enableLogging) {
      _log.debug(`[ContextService] Exporting context for chat ${chatId.substring(0, 8)}`);
    }
    
    try {
      const exported = await this.apiClient.get(`/v1/context/chats/${chatId}/context/export`);
      
      if (this.enableLogging) {
        _log.debug(`[ContextService] Exported context for chat ${chatId.substring(0, 8)}:`, {
          title: exported.title,
          messageCount: exported.message_count,
          tokenCount: exported.token_count
        });
      }
      
      // Emit event for UI updates
      if (this.eventBus) {
        this.eventBus.emit('context:exported', {
          chatId,
          exported,
          timestamp: Date.now()
        });
      }
      
      return exported;
      
    } catch (error) {
      _log.error('[ContextService] Failed to export context:', error);
      throw error;
    }
  }
  
  /**
   * Emit context update event
   * @param {Object} status - Context status object
   * @private
   */
  emitContextUpdate(status) {
    if (this.eventBus) {
      this.eventBus.emit('context:status-changed', {
        chatId: status.chat_id,
        status: status.status,
        tokenCount: status.token_count,
        usagePercent: status.usage_percent,
        needsSummarization: status.needs_summarization,
        recommendNewChat: status.recommend_new_chat,
        timestamp: Date.now()
      });
    }
  }
  
  /**
   * Get statistics
   * @returns {Object} Service statistics
   */
  getStats() {
    return {
      enabled: true,
      hasEventBus: !!this.eventBus,
      hasApiClient: !!this.apiClient
    };
  }
  
  /**
   * Cleanup
   */
  destroy() {
    if (this.enableLogging) {
      _log.debug('[ContextService] Destroyed');
    }
    
    this.eventBus = null;
  }
}

module.exports = { ContextService };
