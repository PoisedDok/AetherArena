'use strict';

/**
 * @.architecture
 * 
 * Incoming: Application layer stream chunk data --- {chunk_object, object}
 * Processing: Buffer chat message stream chunks, accumulate content, manage stream lifecycle --- {4 jobs: JOB_ACCUMULATE_TEXT, JOB_CLEAR_STATE, JOB_TRACK_ENTITY, JOB_VALIDATE_SCHEMA}
 * Outgoing: Accumulated content string, buffer state --- {string | buffer_state, primitive}
 * 
 * @module domain/chat/services/StreamBuffer
 */

const { createLogger } = require('../../../core/utils/logger');

/**
 * StreamBuffer - Pure Domain Service for Chat Message Stream Buffering
 * =====================================================================
 * 
 * SINGLE RESPONSIBILITY: Buffer and accumulate streaming chat message chunks
 * 
 * ARCHITECTURE:
 * - Domain layer (NO I/O, NO frameworks)
 * - Pure business logic for stream accumulation
 * - Fail-fast contract enforcement
 * 
 * CONTRACTS:
 * - requestId REQUIRED (no fallbacks)
 * - chunk.content MUST be string if present
 * - NO implicit state - explicit buffer management
 * 
 * RESPONSIBILITIES:
 * - Initialize stream buffer for request
 * - Accumulate chunks by content
 * - Provide accumulated text
 * - Clear buffers
 * - Track active streams
 * 
 * NOT RESPONSIBLE FOR:
 * - UI rendering (that's renderer layer)
 * - Persistence (that's repository layer)
 * - Event emission (that's application layer)
 * - Chunk validation (backend responsibility)
 */
class StreamBuffer {
  constructor(options = {}) {
    this.enableLogging = options.enableLogging || false;
    this.logger = options.logger || createLogger({ component: 'StreamBuffer' });
    
    // Active stream buffers: requestId -> { chunks: [], startTime: number, metadata: {} }
    this._buffers = new Map();
    
    // Active stream tracking
    this._activeStreams = new Set();
  }

  // Default logger removed -- createLogger({ component }) used in constructor fallback

  /**
   * Start new stream buffer
   * CONTRACT: requestId REQUIRED, NO fallbacks
   * 
   * @param {string} requestId - Request identifier (REQUIRED)
   * @param {Object} metadata - Optional metadata (chatId, userId, etc.)
   * @throws {Error} If requestId missing or invalid
   */
  startStream(requestId, metadata = {}) {
    // STRICT CONTRACT ENFORCEMENT
    if (!requestId || typeof requestId !== 'string') {
      throw new Error(
        '[StreamBuffer] CONTRACT VIOLATION: requestId REQUIRED as non-empty string. ' +
        `Received: ${typeof requestId} "${requestId}"`
      );
    }

    // FAIL FAST: Don't overwrite existing buffer
    if (this._buffers.has(requestId)) {
      throw new Error(
        `[StreamBuffer] CONTRACT VIOLATION: Stream ${requestId} already active. ` +
        'Call endStream() or clearStream() before starting new stream with same requestId.'
      );
    }

    const buffer = {
      chunks: [],
      startTime: Date.now(),
      metadata: { ...metadata },
      chunkCount: 0
    };

    this._buffers.set(requestId, buffer);
    this._activeStreams.add(requestId);

    this.logger.debug(`Stream started: ${requestId}`);
  }

  /**
   * Add chunk to stream buffer
   * CONTRACT: requestId and chunk REQUIRED
   * 
   * @param {string} requestId - Request identifier (REQUIRED)
   * @param {Object} chunk - Chunk object with content property (REQUIRED)
   * @throws {Error} If requestId missing, stream not started, or chunk invalid
   */
  addChunk(requestId, chunk) {
    // STRICT CONTRACT ENFORCEMENT
    if (!requestId || typeof requestId !== 'string') {
      throw new Error(
        '[StreamBuffer] CONTRACT VIOLATION: requestId REQUIRED as non-empty string. ' +
        `Received: ${typeof requestId} "${requestId}"`
      );
    }

    if (!chunk || typeof chunk !== 'object') {
      throw new Error(
        `[StreamBuffer] CONTRACT VIOLATION: chunk REQUIRED as object. ` +
        `requestId=${requestId}, received: ${typeof chunk}`
      );
    }

    // FAIL FAST: Stream must be started
    const buffer = this._buffers.get(requestId);
    if (!buffer) {
      throw new Error(
        `[StreamBuffer] CONTRACT VIOLATION: Stream ${requestId} not started. ` +
        'Call startStream() before adding chunks.'
      );
    }

    // Store chunk (with or without content - backend may send control chunks)
    buffer.chunks.push(chunk);
    buffer.chunkCount++;

    this.logger.debug(`Chunk added to ${requestId}: ${buffer.chunkCount} chunks total`);
  }

  /**
   * Get accumulated content from stream
   * CONTRACT: requestId REQUIRED
   * 
   * @param {string} requestId - Request identifier (REQUIRED)
   * @returns {string} Accumulated content (joined by chunk.content)
   * @throws {Error} If requestId missing or stream not found
   */
  getAccumulatedContent(requestId) {
    // STRICT CONTRACT ENFORCEMENT
    if (!requestId || typeof requestId !== 'string') {
      throw new Error(
        '[StreamBuffer] CONTRACT VIOLATION: requestId REQUIRED as non-empty string. ' +
        `Received: ${typeof requestId} "${requestId}"`
      );
    }

    const buffer = this._buffers.get(requestId);
    if (!buffer) {
      throw new Error(
        `[StreamBuffer] Stream ${requestId} not found. ` +
        'Stream may have ended or never started.'
      );
    }

    // Extract content from chunks (filter out chunks without content)
    const content = buffer.chunks
      .map(chunk => chunk.content || '')
      .join('');

    return content;
  }

  /**
   * Get buffer metadata
   * 
   * @param {string} requestId - Request identifier (REQUIRED)
   * @returns {Object} Buffer metadata and stats
   * @throws {Error} If requestId missing or stream not found
   */
  getBufferInfo(requestId) {
    // STRICT CONTRACT ENFORCEMENT
    if (!requestId || typeof requestId !== 'string') {
      throw new Error(
        '[StreamBuffer] CONTRACT VIOLATION: requestId REQUIRED as non-empty string. ' +
        `Received: ${typeof requestId} "${requestId}"`
      );
    }

    const buffer = this._buffers.get(requestId);
    if (!buffer) {
      throw new Error(
        `[StreamBuffer] Stream ${requestId} not found. ` +
        'Stream may have ended or never started.'
      );
    }

    return {
      requestId,
      chunkCount: buffer.chunkCount,
      startTime: buffer.startTime,
      duration: Date.now() - buffer.startTime,
      metadata: { ...buffer.metadata },
      contentLength: this.getAccumulatedContent(requestId).length
    };
  }

  /**
   * End stream and return accumulated content
   * CONTRACT: requestId REQUIRED
   * 
   * @param {string} requestId - Request identifier (REQUIRED)
   * @returns {string} Final accumulated content
   * @throws {Error} If requestId missing or stream not found
   */
  endStream(requestId) {
    // Get content before clearing (will validate requestId)
    const content = this.getAccumulatedContent(requestId);
    
    // Cleanup
    this._buffers.delete(requestId);
    this._activeStreams.delete(requestId);

    this.logger.debug(`Stream ended: ${requestId}, content length: ${content.length}`);

    return content;
  }

  /**
   * Clear stream buffer without returning content
   * Use for cancelled/errored streams
   * 
   * @param {string} requestId - Request identifier (REQUIRED)
   * @throws {Error} If requestId missing
   */
  clearStream(requestId) {
    // STRICT CONTRACT ENFORCEMENT
    if (!requestId || typeof requestId !== 'string') {
      throw new Error(
        '[StreamBuffer] CONTRACT VIOLATION: requestId REQUIRED as non-empty string. ' +
        `Received: ${typeof requestId} "${requestId}"`
      );
    }

    const existed = this._buffers.has(requestId);
    this._buffers.delete(requestId);
    this._activeStreams.delete(requestId);

    if (existed) {
      this.logger.debug(`Stream cleared: ${requestId}`);
    }
  }

  /**
   * Check if stream is active
   * 
   * @param {string} requestId - Request identifier
   * @returns {boolean} True if stream is active
   */
  isStreamActive(requestId) {
    return this._activeStreams.has(requestId);
  }

  /**
   * Get all active stream IDs
   * 
   * @returns {string[]} Array of active request IDs
   */
  getActiveStreams() {
    return Array.from(this._activeStreams);
  }

  /**
   * Clear all buffers (emergency cleanup)
   * Use for global reset scenarios
   */
  clearAll() {
    const count = this._buffers.size;
    this._buffers.clear();
    this._activeStreams.clear();
    
    this.logger.info(`All buffers cleared: ${count} streams`);
  }

  /**
   * Get statistics
   * 
   * @returns {Object} Buffer statistics
   */
  getStats() {
    return {
      activeStreams: this._activeStreams.size,
      totalBuffers: this._buffers.size,
      streams: Array.from(this._buffers.keys())
    };
  }
}

module.exports = { StreamBuffer };
