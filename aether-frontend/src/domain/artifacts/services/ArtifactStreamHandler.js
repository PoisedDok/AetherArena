'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactService.createFromStream() (via handleStreamChunk method call) --- {artifact_types.* (code|output|html), json}
 * Processing: Buffer streamed artifact content, generate artifact IDs with kind suffix, accumulate text chunks, finalize artifacts on stream end --- {5 jobs: JOB_ACCUMULATE_TEXT, JOB_GENERATE_ARTIFACT_ID, JOB_UPDATE_STATE, JOB_TRACK_ENTITY, JOB_DELEGATE_TO_MODULE}
 * Outgoing: ArtifactService.finalizeArtifact() → ArtifactService.js --- {artifact_types.* (complete), json}
 * 
 * 
 * @module domain/artifacts/services/ArtifactStreamHandler
 */

const { Artifact } = require('../models/Artifact');

/**
 * ArtifactStreamHandler
 * Handles real-time artifact streaming from backend
 * 
 * Manages buffering, accumulation, and finalization of streamed artifacts
 */

class ArtifactStreamHandler {
  constructor(dependencies = {}) {
    this.artifactService = dependencies.artifactService; // ArtifactService
    this.logger = dependencies.logger || this._createDefaultLogger();
    
    // Stream buffers: streamId -> { artifactId, buffer, metadata }
    this.streamBuffers = new Map();
    
    // Active streams tracking
    this.activeStreams = new Set();
  }

  _createDefaultLogger() {
    return {
      debug: () => {},
      info: () => {},
      warn: (...args) => console.warn('[ArtifactStreamHandler]', ...args),
      error: (...args) => console.error('[ArtifactStreamHandler]', ...args)
    };
  }

  /**
   * Handle stream data chunk
   */
  async handleStreamChunk(streamData) {
    const { id, kind, content, start, end, format, sourceMessageId, correlationId, chatId } = streamData;

    if (!id) {
      this.logger.warn('Stream data missing id');
      return null;
    }

    // Validate chatId (required for all artifacts)
    if (!chatId) {
      this.logger.warn(`Stream data missing chatId for artifact ${id}`);
      return null;
    }

    // Generate artifact ID with kind suffix (ensures unique IDs per type)
    const artifactId = Artifact.generateIdWithKind(id, kind);

    try {
      // Handle stream start
      if (start || !this.streamBuffers.has(artifactId)) {
        await this._handleStreamStart(artifactId, {
          id: artifactId,
          kind,
          format: format || kind,
          sourceMessageId,
          correlationId,
          chatId
        });
      }

      // Accumulate content
      if (content) {
        this._appendContent(artifactId, content);
      }

      // Handle stream end
      if (end) {
        return await this._handleStreamEnd(artifactId);
      }

      return null;
    } catch (error) {
      this.logger.error(`Error handling stream chunk for ${artifactId}:`, error);
      this._cleanupStream(artifactId);
      return null;
    }
  }

  /**
   * Handle stream start - initialize buffer and artifact
   */
  async _handleStreamStart(artifactId, metadata) {
    this.logger.debug(`Stream started: ${artifactId}`);

    // Create artifact via service
    try {
      const artifact = await this.artifactService.createFromStream(metadata);
      
      // Initialize buffer
      this.streamBuffers.set(artifactId, {
        artifactId: artifact.id,
        buffer: '',
        metadata,
        startTime: Date.now()
      });

      this.activeStreams.add(artifactId);

      return artifact;
    } catch (error) {
      this.logger.error(`Failed to start stream for ${artifactId}:`, error);
      throw error;
    }
  }

  /**
   * Append content to stream buffer
   */
  _appendContent(artifactId, content) {
    const streamBuffer = this.streamBuffers.get(artifactId);
    if (!streamBuffer) {
      this.logger.warn(`No buffer found for artifact ${artifactId}`);
      return;
    }

    streamBuffer.buffer += content;

    // Update artifact in service
    if (this.artifactService) {
      this.artifactService.updateContent(artifactId, content);
    }
  }

  /**
   * Handle stream end - finalize artifact
   */
  async _handleStreamEnd(artifactId) {
    const streamBuffer = this.streamBuffers.get(artifactId);
    if (!streamBuffer) {
      this.logger.warn(`No buffer found for artifact ${artifactId}`);
      return null;
    }

    this.logger.debug(`Stream ended: ${artifactId}`);

    try {
      // Finalize artifact via service
      const artifact = await this.artifactService.finalizeArtifact(artifactId);

      if (!artifact) {
        this.logger.warn(`Artifact finalization returned null for ${artifactId}`);
        return null;
      }

      const duration = Date.now() - streamBuffer.startTime;
      this.logger.info(`Artifact finalized: ${artifactId} (${duration}ms, ${artifact.content.length} bytes)`);

      return artifact;
    } catch (error) {
      this.logger.error(`Failed to finalize artifact ${artifactId}:`, error);
      return null;
    } finally {
      this._cleanupStream(artifactId);
    }
  }

  /**
   * Cleanup stream buffer
   */
  _cleanupStream(artifactId) {
    this.streamBuffers.delete(artifactId);
    this.activeStreams.delete(artifactId);
  }

  /**
   * Check if stream is active
   */
  isStreamActive(artifactId) {
    return this.activeStreams.has(artifactId);
  }

  /**
   * Get active stream count
   */
  getActiveStreamCount() {
    return this.activeStreams.size;
  }

  /**
   * Get buffer size for artifact
   */
  getBufferSize(artifactId) {
    const buffer = this.streamBuffers.get(artifactId);
    return buffer ? buffer.buffer.length : 0;
  }

  /**
   * Abort stream
   */
  abortStream(artifactId) {
    if (this.activeStreams.has(artifactId)) {
      this.logger.info(`Aborting stream: ${artifactId}`);
      this._cleanupStream(artifactId);
      return true;
    }
    return false;
  }

  /**
   * Abort all active streams
   */
  abortAllStreams() {
    const count = this.activeStreams.size;
    for (const artifactId of this.activeStreams) {
      this._cleanupStream(artifactId);
    }
    this.logger.info(`Aborted ${count} active streams`);
    return count;
  }

  /**
   * Get stream statistics
   */
  getStats() {
    const buffers = Array.from(this.streamBuffers.values());
    
    return {
      active: this.activeStreams.size,
      totalBuffers: this.streamBuffers.size,
      totalBufferSize: buffers.reduce((sum, b) => sum + b.buffer.length, 0),
      averageBufferSize: buffers.length > 0 
        ? buffers.reduce((sum, b) => sum + b.buffer.length, 0) / buffers.length 
        : 0,
      oldestStream: buffers.length > 0 
        ? Math.min(...buffers.map(b => b.startTime)) 
        : null
    };
  }

  /**
   * Clear all buffers (cleanup)
   */
  clear() {
    const count = this.streamBuffers.size;
    this.streamBuffers.clear();
    this.activeStreams.clear();
    this.logger.info(`Cleared ${count} stream buffers`);
  }
}

module.exports = { ArtifactStreamHandler };

