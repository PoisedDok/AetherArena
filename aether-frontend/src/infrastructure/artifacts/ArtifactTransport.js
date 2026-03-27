'use strict';

/**
Incoming: ArtifactsStreamOrchestrator (normalized artifact payloads) --- {object, json}
Processing: Send via IPC to renderer windows --- {1 job: JOB_SEND_IPC}
Outgoing: ipc.artifacts:stream --- {ipc.chat_stream_event, json}

ARCHITECTURAL NOTE: Pure I/O layer. No business logic. Infrastructure wrapper over IPC.
*/

/**
 * ArtifactTransport
 * 
 * Infrastructure layer for artifact transport via IPC.
 * Sends enriched artifacts to renderer windows (chat/artifacts).
 * 
 * ARCHITECTURE:
 * - Infrastructure service (pure I/O, no business logic)
 * - Transforms camelCase → snake_case for renderer contract
 * - Validates required fields before sending
 * - No state management
 * 
 * RENDERER CONTRACT:
 * Artifacts renderer expects snake_case fields:
 * - artifact_id, request_id, chat_id, message_id, parent_id
 * - node_id, subgroup_id (trail linkage)
 * - execution_group, correlation_id
 * 
 * @module infrastructure/artifacts/ArtifactTransport
 */

const { createLogger } = require('../../core/utils/logger');
class ArtifactTransport {
  constructor(options = {}) {
    this.ipc = options.ipc || null;
    this.enableLogging = options.enableLogging || false;
    this.log = createLogger({ component: 'ArtifactTransport' });
    
    if (!this.ipc) {
      throw new Error('[ArtifactTransport] IPC adapter required');
    }
  }

  /**
   * Send artifact to renderer windows via IPC
   * CONTRACT: streamData must contain required fields
   * 
   * @param {Object} streamData - Normalized artifact payload (camelCase internally)
   * @param {string} streamData.artifact_id - Artifact ID from backend
   * @param {string} streamData.requestId - Request ID (canonical identifier)
   * @param {string} streamData.chatId - Chat ID
   * @param {string} streamData.role - Role (assistant/computer)
   * @param {string} streamData.type - Type (code/output)
   * @param {string} streamData.executionGroup - Execution group ID
   * @param {string} streamData.node_id - Trail node ID (from registry)
   * @param {string} streamData.subgroup_id - Trail subgroup ID (from registry)
   * @throws {Error} If required fields missing
   */
  sendToArtifacts(streamData) {    
    // CONTRACT: Validate required fields
    if (!streamData || typeof streamData !== 'object') {
      throw new Error('[ArtifactTransport] CONTRACT VIOLATION: streamData must be object');
    }

    if (!streamData.artifact_id || typeof streamData.artifact_id !== 'string') {      throw new Error(
        `[ArtifactTransport] CONTRACT VIOLATION: artifact_id required. ` +
        `requestId=${streamData.requestId || 'unknown'}`
      );
    }

    if (!streamData.requestId || typeof streamData.requestId !== 'string') {      throw new Error(
        `[ArtifactTransport] CONTRACT VIOLATION: requestId required. ` +
        `artifact_id=${streamData.artifact_id ? streamData.artifact_id.substring(0, 40) : 'undefined'}`
      );
    }

    // CONTRACT: Trail metadata OPTIONAL for assistant:code, REQUIRED for computer:console/output
    // Backend only sends trail.artifact_linked for output artifacts, not code artifacts
    const requiresTrailLinkage = (streamData.role === 'computer' && (streamData.type === 'console' || streamData.type === 'output'));
    
    if (requiresTrailLinkage) {
      if (!streamData.node_id || typeof streamData.node_id !== 'string') {
        if (this.enableLogging) {
          this.log.warn('Missing metadata: node_id missing', {
            role: streamData.role, type: streamData.type, detail:
            `artifact_id=${streamData.artifact_id ? streamData.artifact_id.substring(0, 40) : 'undefined'}. ` +
            `Proceeding without trail linkage for this chunk.`
          });
        }
      }

      if (!streamData.subgroup_id || typeof streamData.subgroup_id !== 'string') {
        // Log warning instead of throwing to prevent crashing the stream
        if (this.enableLogging) {
          this.log.warn('Missing metadata: subgroup_id missing', {
            role: streamData.role, type: streamData.type,
            artifact_id: streamData.artifact_id ? streamData.artifact_id.substring(0, 40) : 'undefined'
          });
        }
      }
    }

    // CRITICAL: Transform to snake_case for artifacts renderer contract
    // Renderer expects snake_case but main process uses camelCase internally
    const ipcPayload = {
      artifact_id: streamData.artifact_id,
      request_id: streamData.requestId,
      role: streamData.role,
      type: streamData.type,
      format: streamData.format || null,
      language: streamData.language || null,
      content: streamData.content,
      chat_id: streamData.chatId,
      message_id: streamData.messageId || null,
      parent_id: streamData.parentId || null,
      correlation_id: streamData.correlationId || null,
      execution_group: streamData.executionGroup,
      start: streamData.start || false,
      end: streamData.end || false,
      timestamp: streamData.timestamp,
      metadata: streamData.metadata || {}
    };
    
    // Add trail linkage fields only if they exist (optional for assistant:code, required for computer:output/console)
    if (streamData.node_id) {
      ipcPayload.node_id = streamData.node_id;
    }
    if (streamData.subgroup_id) {
      ipcPayload.subgroup_id = streamData.subgroup_id;
    }

    // Send via IPC
    this.ipc.send('artifacts:stream', ipcPayload);

    // DIAGNOSTIC: Log transport
    if (this.enableLogging) {
      this.log.debug('Sent to artifacts window', {
        artifact_id: streamData.artifact_id ? streamData.artifact_id.substring(0, 40) : 'undefined',
        type: streamData.type,
        role: streamData.role,
        node_id: streamData.node_id ? streamData.node_id.substring(0, 16) : 'none',
        subgroup_id: streamData.subgroup_id ? streamData.subgroup_id.substring(0, 16) : 'none',
        hasStart: !!streamData.start,
        hasEnd: !!streamData.end
      });
    }
  }

  /**
   * Get transport statistics
   * 
   * @returns {Object} Statistics
   */
  getStats() {
    return {
      hasIpc: !!this.ipc
    };
  }
}

module.exports = { ArtifactTransport };
