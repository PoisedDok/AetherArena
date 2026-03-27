'use strict';

/**
 * @.architecture
 * 
 * Incoming: ChatLifecycleManager (session restoration requests), backend REST API (/api/storage/chats/{chatId}/session-map) --- {event | http_response, json}
 * Processing: Fetch session map from backend, emit EventBus events for renderer to consume --- {2 jobs: JOB_HTTP_REQUEST, JOB_EMIT_EVENT}
 * Outgoing: EventBus EventTypes.TRAIL.SESSION_MAP_LOADED with complete session map --- {event, json}
 * 
 * @module application/chat/TrailRestorationService
 * 
 * TrailRestorationService - Unified Session Restoration
 * =====================================================
 * 
 * Responsibilities:
 * - Fetch complete session map from backend REST API
 * - Emit EventBus events for renderer consumption
 * - Handle errors gracefully (non-fatal)
 * 
 * Architecture:
 * - Application layer (orchestrates HTTP requests)
 * - NO rendering, NO DOM manipulation
 * - Single source of truth: session map
 * - Backend is authoritative
 * - Frontend = pure UI renderer
 */

const { EventTypes } = require('../../core/events/EventTypes');
const { createRendererLogger } = require('../../renderer/shared/utils/logger');
const _log = createRendererLogger('TrailRestorationService');

class TrailRestorationService {
  constructor(options = {}) {
    // Dependencies
    this.eventBus = options.eventBus || null;
    
    // Configuration
    this.enableLogging = options.enableLogging !== undefined ? options.enableLogging : false;
    this.apiClient = options.apiClient;
    
    // CONTRACT: apiClient is required.
    if (!this.apiClient) {
      throw new Error('[TrailRestorationService] CONTRACT VIOLATION: apiClient is required.');
    }
    
    // Validation
    if (!this.eventBus) {
      throw new Error('[TrailRestorationService] eventBus required');
    }
  }
  
  /**
   * Restore complete chat session using session map
   * Single source of truth for messages, artifacts, and trails
   * 
   * @param {string} chatId - Chat identifier
   * @returns {Promise<void>}
   */
  async restoreSessionMap(chatId) {
    if (!chatId) {
      throw new Error('[TrailRestorationService] chatId is required');
    }
    
    if (this.enableLogging) {
      _log.debug(`[TrailRestorationService] Restoring session map for chat ${chatId.substring(0, 8)}`);
    }
    
    try {
      // Fetch complete session map from backend
      const sessionMap = await this.apiClient.get(`/v1/storage/trail/session-map/${chatId}`);
      
      if (!sessionMap || !Array.isArray(sessionMap.timeline)) {
        throw new Error('Invalid session map response: expected timeline array');
      }
      
      if (this.enableLogging) {
        _log.debug(`[TrailRestorationService] Loaded session map for chat ${chatId.substring(0, 8)}`, {
          timelineEvents: sessionMap.timeline.length,
          messages: sessionMap.metadata?.total_messages || 0,
          artifacts: sessionMap.metadata?.total_artifacts || 0,
          trails: sessionMap.metadata?.total_trails || 0
        });
      }
      
      // Emit session map loaded event
      this.eventBus.emit(EventTypes.TRAIL.SESSION_MAP_LOADED, {
        chatId,
        sessionMap,
        timestamp: Date.now()
      });
      
    } catch (error) {
      if (error.status === 404) {
        if (this.enableLogging) {
          _log.debug(`[TrailRestorationService] No session map found for chat ${chatId.substring(0, 8)}`);
        }
        this.eventBus.emit(EventTypes.TRAIL.SESSION_MAP_LOADED, {
          chatId,
          sessionMap: { timeline: [], metadata: {}, indexes: {} },
          timestamp: Date.now()
        });
        return;
      }
      _log.error('[TrailRestorationService] Failed to restore session map:', error);
      this.eventBus.emit(EventTypes.TRAIL.RESTORATION_ERROR, {
        chatId,
        error: error.message,
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
      _log.debug('[TrailRestorationService] Destroyed');
    }
    
    this.eventBus = null;
  }
}

module.exports = { TrailRestorationService };
