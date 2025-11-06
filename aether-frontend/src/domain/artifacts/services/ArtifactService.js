'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactStreamHandler.handleStreamChunk(), ArtifactsOrchestrator.loadArtifact() (method calls with stream data) --- {artifact_types.*, json}
 * Processing: Validate stream data via ArtifactValidator, create Artifact model instances, maintain activeArtifacts Map cache, buffer streaming content, update accumulated content, finalize artifacts (mark active), persist to ArtifactRepository (PostgreSQL), load from repository, track with TraceabilityService, clear caches --- {10 jobs: JOB_ACCUMULATE_TEXT, JOB_CACHE_LOCALLY, JOB_CLEAR_STATE, JOB_FINALIZE_STREAM, JOB_GET_STATE, JOB_LOAD_FROM_DB, JOB_SAVE_TO_DB, JOB_TRACK_ENTITY, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA}
 * Outgoing: ArtifactRepository.create/update() (persistence), TraceabilityService.linkArtifact() (relationships), return Artifact instances --- {artifact_model, javascript_object}
 * 
 * 
 * @module domain/artifacts/services/ArtifactService
 */

const { Artifact } = require('../models/Artifact');
const { ArtifactValidator } = require('../validators/ArtifactValidator');

/**
 * ArtifactService
 * Core business logic for artifact management
 * 
 * Orchestrates artifact lifecycle: creation, validation, persistence, retrieval
 */

class ArtifactService {
  constructor(dependencies = {}) {
    this.repository = dependencies.repository; // ArtifactRepository
    this.traceabilityService = dependencies.traceabilityService;
    this.logger = dependencies.logger || this._createDefaultLogger();
    
    // In-memory cache for active artifacts
    this.activeArtifacts = new Map(); // artifactId -> Artifact
    this.streamBuffers = new Map(); // streamId -> { artifact, buffer }
  }

  _createDefaultLogger() {
    return {
      debug: () => {},
      info: () => {},
      warn: (...args) => console.warn('[ArtifactService]', ...args),
      error: (...args) => console.error('[ArtifactService]', ...args)
    };
  }

  /**
   * Create new artifact from stream data
   */
  async createFromStream(streamData) {
    // Validate stream data
    const validation = ArtifactValidator.validateStreamData(streamData);
    if (!validation.valid) {
      const error = new Error(`Invalid stream data: ${validation.errors.join(', ')}`);
      this.logger.error('Stream validation failed:', validation.errors);
      throw error;
    }

    // Create artifact
    const artifact = Artifact.fromStreamData(streamData);

    // Validate artifact
    const artifactValidation = ArtifactValidator.validate(artifact.toJSON());
    if (!artifactValidation.valid) {
      const error = new Error(`Invalid artifact: ${artifactValidation.errors.join(', ')}`);
      this.logger.error('Artifact validation failed:', artifactValidation.errors);
      throw error;
    }

    // Cache active artifact
    this.activeArtifacts.set(artifact.id, artifact);

    this.logger.debug(`Created artifact from stream: ${artifact.id}`);
    return artifact;
  }

  /**
   * Update artifact content (for streaming)
   */
  updateContent(artifactId, additionalContent) {
    const artifact = this.activeArtifacts.get(artifactId);
    if (!artifact) {
      this.logger.warn(`Artifact not found for update: ${artifactId}`);
      return null;
    }

    // Create updated artifact with new content
    const updatedArtifact = artifact.update({
      content: artifact.content + additionalContent
    });

    // Update cache
    this.activeArtifacts.set(artifactId, updatedArtifact);

    return updatedArtifact;
  }

  /**
   * Finalize streaming artifact
   */
  async finalizeArtifact(artifactId, options = {}) {
    let artifact = this.activeArtifacts.get(artifactId);
    if (!artifact) {
      this.logger.warn(`Artifact not found for finalization: ${artifactId}`);
      return null;
    }

    // Update status to active
    artifact = artifact.withStatus('active');

    // Validate content
    const contentValidation = ArtifactValidator.validateContent(
      artifact.content,
      { allowEmpty: artifact.type === 'output' }
    );

    if (!contentValidation.valid) {
      this.logger.warn(`Artifact content validation failed: ${contentValidation.errors.join(', ')}`);
      
      // For empty content (except output), mark as deleted
      if (artifact.isEmpty() && artifact.type !== 'output') {
        artifact = artifact.withStatus('deleted');
        this.activeArtifacts.delete(artifactId);
        return null;
      }
    }

    // Persist to repository if available
    if (this.repository) {
      try {
        const persistedArtifact = await this.repository.save(artifact);
        artifact = persistedArtifact;
        this.logger.info(`Artifact persisted: ${artifact.id}`);
      } catch (error) {
        this.logger.error(`Failed to persist artifact ${artifactId}:`, error);
        // Continue without persisting - artifact stays in memory
      }
    }

    // Register with traceability service
    if (this.traceabilityService) {
      try {
        this.traceabilityService.registerArtifact(artifact.toJSON());
        this.logger.debug(`Artifact registered with traceability: ${artifact.id}`);
      } catch (error) {
        this.logger.warn(`Failed to register artifact with traceability:`, error);
      }
    }

    // Update cache
    this.activeArtifacts.set(artifact.id, artifact);

    return artifact;
  }

  /**
   * Get artifact by ID
   */
  async getById(artifactId) {
    // Check memory cache first
    const cached = this.activeArtifacts.get(artifactId);
    if (cached) {
      return cached;
    }

    // Load from repository
    if (this.repository) {
      try {
        const artifact = await this.repository.findById(artifactId);
        if (artifact) {
          this.activeArtifacts.set(artifact.id, artifact);
          return artifact;
        }
      } catch (error) {
        this.logger.error(`Failed to load artifact ${artifactId}:`, error);
      }
    }

    return null;
  }

  /**
   * Get artifacts for chat
   */
  async getByChat(chatId) {
    if (!this.repository) {
      // Return from memory cache filtered by chatId
      const artifacts = Array.from(this.activeArtifacts.values())
        .filter(a => a.chatId === chatId);
      return artifacts;
    }

    try {
      const artifacts = await this.repository.findByChatId(chatId);
      
      // Update cache
      artifacts.forEach(artifact => {
        this.activeArtifacts.set(artifact.id, artifact);
      });
      
      return artifacts;
    } catch (error) {
      this.logger.error(`Failed to load artifacts for chat ${chatId}:`, error);
      return [];
    }
  }

  /**
   * Get artifacts for message
   */
  async getByMessage(messageId) {
    if (!this.repository) {
      // Return from memory cache filtered by messageId
      const artifacts = Array.from(this.activeArtifacts.values())
        .filter(a => a.sourceMessageId === messageId);
      return artifacts;
    }

    try {
      const artifacts = await this.repository.findByMessageId(messageId);
      
      // Update cache
      artifacts.forEach(artifact => {
        this.activeArtifacts.set(artifact.id, artifact);
      });
      
      return artifacts;
    } catch (error) {
      this.logger.error(`Failed to load artifacts for message ${messageId}:`, error);
      return [];
    }
  }

  /**
   * Get artifacts by correlation ID
   */
  async getByCorrelation(correlationId) {
    if (!this.repository) {
      // Return from memory cache filtered by correlationId
      const artifacts = Array.from(this.activeArtifacts.values())
        .filter(a => a.correlationId === correlationId);
      return artifacts;
    }

    try {
      const artifacts = await this.repository.findByCorrelationId(correlationId);
      
      // Update cache
      artifacts.forEach(artifact => {
        this.activeArtifacts.set(artifact.id, artifact);
      });
      
      return artifacts;
    } catch (error) {
      this.logger.error(`Failed to load artifacts for correlation ${correlationId}:`, error);
      return [];
    }
  }

  /**
   * Link artifact to message
   */
  async linkToMessage(artifactId, messageId, correlationId = null) {
    let artifact = await this.getById(artifactId);
    if (!artifact) {
      this.logger.warn(`Artifact not found for linking: ${artifactId}`);
      return null;
    }

    // Validate message ID is UUID
    if (!ArtifactValidator.isValidUUID(messageId)) {
      this.logger.warn(`Invalid message UUID for linking: ${messageId}`);
      return null;
    }

    // Update artifact with message link
    artifact = artifact.withMessageLink(messageId, correlationId);

    // Persist update
    if (this.repository) {
      try {
        await this.repository.updateMessageLink(artifactId, messageId);
        this.logger.info(`Artifact ${artifactId} linked to message ${messageId}`);
      } catch (error) {
        this.logger.error(`Failed to update message link:`, error);
      }
    }

    // Update cache
    this.activeArtifacts.set(artifact.id, artifact);

    // Update traceability
    if (this.traceabilityService) {
      try {
        this.traceabilityService.registerArtifact(artifact.toJSON());
      } catch (error) {
        this.logger.warn(`Failed to update traceability:`, error);
      }
    }

    return artifact;
  }

  /**
   * Archive artifact
   */
  async archive(artifactId) {
    const artifact = await this.getById(artifactId);
    if (!artifact) {
      return null;
    }

    const archivedArtifact = artifact.withStatus('archived');

    if (this.repository) {
      // Repository should handle status update
      // For now, just update cache
    }

    this.activeArtifacts.set(artifactId, archivedArtifact);
    return archivedArtifact;
  }

  /**
   * Delete artifact
   */
  async delete(artifactId) {
    const artifact = await this.getById(artifactId);
    if (!artifact) {
      return false;
    }

    // Soft delete - mark as deleted
    const deletedArtifact = artifact.withStatus('deleted');
    this.activeArtifacts.set(artifactId, deletedArtifact);

    // TODO: Implement hard delete in repository if needed

    return true;
  }

  /**
   * Clear memory cache
   */
  clearCache() {
    const count = this.activeArtifacts.size;
    this.activeArtifacts.clear();
    this.streamBuffers.clear();
    this.logger.info(`Cleared ${count} artifacts from cache`);
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    const artifacts = Array.from(this.activeArtifacts.values());
    
    return {
      total: artifacts.length,
      byType: {
        code: artifacts.filter(a => a.type === 'code').length,
        output: artifacts.filter(a => a.type === 'output').length,
        html: artifacts.filter(a => a.type === 'html').length,
        file: artifacts.filter(a => a.type === 'file').length
      },
      byStatus: {
        streaming: artifacts.filter(a => a.status === 'streaming').length,
        active: artifacts.filter(a => a.status === 'active').length,
        archived: artifacts.filter(a => a.status === 'archived').length,
        deleted: artifacts.filter(a => a.status === 'deleted').length
      },
      persisted: artifacts.filter(a => a.isPersisted()).length,
      linked: artifacts.filter(a => a.hasMessageLink()).length
    };
  }
}

module.exports = { ArtifactService };

