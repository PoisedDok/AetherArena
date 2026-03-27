'use strict';

/**
 * @.architecture
 * Domain Service - Manages stream lifecycle (finalization, cancellation, timeout)
 * 
 * Incoming: ChatOrchestrator._handleStreamEnd/Cancel/Timeout (method calls with stream context) --- {stream_context, object}
 * Processing: Accumulate buffered chunks, create Message models, persist via MessageRepository, link artifacts via TraceabilityService, complete request lifecycle, emit lifecycle events, cleanup stream state --- {7 jobs: JOB_ACCUMULATE_TEXT, JOB_SAVE_TO_DB, JOB_UPDATE_STATE, JOB_EMIT_EVENT, JOB_CLEAR_STATE, JOB_DELEGATE_TO_MODULE, JOB_SEND_IPC}
 * Outgoing: MessageRepository.save(), TraceabilityService.linkArtifactsToMessage/registerMessage(), RequestLifecycleManager.completeRequest(), EventBus.emit() --- {database_types.message_record, event, json}
 * 
 * CONTRACTS:
 * - chatId: REQUIRED (UUID string)
 * - requestId: REQUIRED (correlation ID)
 * - streamBuffer: REQUIRED (array of chunks)
 * - Fail-fast on missing dependencies
 * - NO fallbacks, strict validation
 * 
 * @module domain/chat/services/StreamLifecycleManager
 */

const { createDomainLogger } = require('../../../core/utils/logger');
const { Message } = require('../models/Message');

const streamLifecycleLogger = createDomainLogger('StreamLifecycleManager');

class StreamLifecycleManager {
  constructor(options = {}) {
    this.messageRepository = options.messageRepository;
    this.traceabilityService = options.traceabilityService;
    this.requestLifecycle = options.requestLifecycle;
    this.eventBus = options.eventBus;
    this.errorTracker = options.errorTracker;
    this.logger = options.logger || streamLifecycleLogger.child({ scope: 'instance' });
    
    // Validate required dependencies - FAIL FAST
    if (!this.messageRepository) throw new Error('[StreamLifecycleManager] MessageRepository is required');
    if (!this.requestLifecycle) throw new Error('[StreamLifecycleManager] RequestLifecycleManager is required');
    if (!this.eventBus) throw new Error('[StreamLifecycleManager] EventBus is required');
    
    this.logger.info('StreamLifecycleManager initialized');
  }
  
  /**
   * Finalize stream - accumulate chunks, save message, link artifacts
   * 
   * @param {Object} context - Stream context
   * @param {string} context.chatId - Chat ID (REQUIRED)
   * @param {string} context.requestId - Request correlation ID (REQUIRED)
   * @param {Array} context.streamBuffer - Buffered chunks (REQUIRED)
   * @param {Object} context.endChunk - Final chunk with metadata
   * @returns {Promise<Object>} Saved message
   */
  async finalizeStream(context) {
    // STRICT CONTRACT VALIDATION - NO FALLBACKS
    if (!context) throw new Error('[StreamLifecycleManager] Context is required');
    if (!context.chatId || typeof context.chatId !== 'string') {
      throw new Error('[StreamLifecycleManager] chatId is required (string)');
    }
    if (!context.requestId || typeof context.requestId !== 'string') {
      throw new Error('[StreamLifecycleManager] requestId is required (string)');
    }
    if (!Array.isArray(context.streamBuffer)) {
      throw new Error('[StreamLifecycleManager] streamBuffer is required (array)');
    }
    
    const { chatId, requestId, streamBuffer, endChunk } = context;
    
    try {
      this.logger.debug(`Finalizing stream for request ${requestId}`);
      
      // Step 1: Accumulate buffered chunks
      const fullContent = streamBuffer
        .map(c => c.content || '')
        .join('');
        
      this.logger.debug(`Accumulated ${fullContent.length} characters from ${streamBuffer.length} chunks`);
      
      // Step 2: Create assistant message model
      const assistantMessage = new Message({
        role: 'assistant',
        content: fullContent,
        correlationId: requestId,
        llmModel: endChunk?.model || null,
        llmProvider: endChunk?.provider || null,
        tokensUsed: endChunk?.tokens || null,
        status: 'complete'
      });
      
      // Step 3: Persist message
      const savedMessage = await this.messageRepository.save(assistantMessage, chatId);
      this.logger.info(`Saved assistant message ${savedMessage.id} for request ${requestId}`);
      
      // Step 4: Register with traceability service (if available)
      if (this.traceabilityService) {
        try {
          const timestamp = savedMessage.timestamp || savedMessage.createdAt || Date.now();
          
          // Register message
          this.traceabilityService.registerMessage({
            id: savedMessage.id,
            chatId,
            role: 'assistant',
            correlationId: requestId,
            timestamp,
            artifactIds: []
          });
          
          // Link artifacts to this message
          await this.traceabilityService.linkArtifactsToMessage(
            requestId,
            savedMessage.id,
            { chatId, timestamp }
          );
          
          this.logger.debug(`Linked artifacts to message ${savedMessage.id}`);
        } catch (traceError) {
          // Non-critical: log but don't fail the stream finalization
          this.logger.warn(`Traceability linkage failed for message ${savedMessage.id}:`, traceError);
        }
      }
      
      // Step 5: Complete request lifecycle
      if (this.requestLifecycle.isActive(requestId)) {
        this.requestLifecycle.completeRequest(requestId, {
          messageId: savedMessage.id
        });
        this.logger.debug(`Completed request ${requestId}`);
      }
      
      // Step 6: Emit completion event
      this.eventBus.emit('chat:stream:complete', {
        chatId,
        requestId,
        messageId: savedMessage.id,
        contentLength: fullContent.length
      });
      
      this.logger.info(`Stream finalized successfully for request ${requestId}`);
      
      return savedMessage;
    } catch (error) {
      this.logger.error(`Failed to finalize stream for request ${requestId}:`, error);
      
      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'StreamLifecycleManager.finalizeStream');
      }
      
      throw error;
    }
  }
  
  /**
   * Handle stream cancellation
   * 
   * @param {Object} context - Cancellation context
   * @param {string} context.requestId - Request correlation ID
   */
  cancelStream(context) {
    if (!context || !context.requestId) {
      throw new Error('[StreamLifecycleManager] requestId is required for cancellation');
    }
    
    const { requestId } = context;
    
    try {
      this.logger.info(`Stream cancelled for request ${requestId}`);
      
      // Emit cancellation event
      this.eventBus.emit('chat:stream:cancelled', { requestId });
      
      this.logger.debug(`Emitted cancellation event for request ${requestId}`);
    } catch (error) {
      this.logger.error(`Failed to handle stream cancellation for ${requestId}:`, error);
      
      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'StreamLifecycleManager.cancelStream');
      }
      
      throw error;
    }
  }
  
  /**
   * Handle stream timeout
   * 
   * @param {Object} context - Timeout context
   * @param {string} context.requestId - Request correlation ID
   */
  timeoutStream(context) {
    if (!context || !context.requestId) {
      throw new Error('[StreamLifecycleManager] requestId is required for timeout');
    }
    
    const { requestId } = context;
    
    try {
      this.logger.warn(`Stream timed out for request ${requestId}`);
      
      // Emit timeout event
      this.eventBus.emit('chat:stream:timeout', { requestId });
      
      this.logger.debug(`Emitted timeout event for request ${requestId}`);
    } catch (error) {
      this.logger.error(`Failed to handle stream timeout for ${requestId}:`, error);
      
      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'StreamLifecycleManager.timeoutStream');
      }
      
      throw error;
    }
  }
  
  /**
   * Get service statistics
   */
  getStats() {
    return {
      hasMessageRepository: Boolean(this.messageRepository),
      hasTraceabilityService: Boolean(this.traceabilityService),
      hasRequestLifecycle: Boolean(this.requestLifecycle),
      hasEventBus: Boolean(this.eventBus),
      hasErrorTracker: Boolean(this.errorTracker)
    };
  }
}

module.exports = { StreamLifecycleManager };
