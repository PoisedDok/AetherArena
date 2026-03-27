'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactStreamHandler.handleStreamChunk() (backend-validated stream data), ArtifactsOrchestrator.loadArtifact() --- {artifact_types.code_artifact | artifact_types.output_artifact | artifact_types.html_artifact, json}
 * Processing: Create Artifact model instances from backend data, buffer in-flight streams ONLY, update accumulated content, finalize artifacts, persist to ArtifactRepository, load from repository --- {8 jobs: JOB_ACCUMULATE_TEXT, JOB_CLEAR_STATE, JOB_DELEGATE_TO_MODULE, JOB_FINALIZE_STREAM, JOB_GET_STATE, JOB_INITIALIZE, JOB_LOAD_FROM_DB, JOB_SAVE_TO_DB}
 * Outgoing: ArtifactRepository.create/update(), return Artifact instances --- {object, javascript_api}
 * 
 * ARCHITECTURE NOTE:
 * - Backend owns ALL validation and artifact storage
 * - Frontend maintains streaming artifacts ONLY (status='streaming')
 * - Once finalized, artifacts removed from cache - backend is source of truth
 * - NO general-purpose caching - query backend when needed
 * 
 * @module domain/artifacts/services/ArtifactService
 */

const { Artifact } = require('../models/Artifact');
const { createLogger } = require('../../../core/utils/logger');

/**
 * ArtifactService
 * Orchestrates artifact lifecycle with backend-validated data
 * 
 * ARCHITECTURE:
 * - Trusts backend validation - no redundant business logic
 * - Caches ONLY in-flight streaming artifacts
 * - Backend owns finalized artifact storage
 */

class ArtifactService {
  constructor(dependencies = {}) {
    this.repository = dependencies.repository; // ArtifactRepository
    this.traceabilityService = dependencies.traceabilityService;
    this.logger = dependencies.logger || createLogger({ component: 'ArtifactService' });
    
    // In-flight streaming artifacts ONLY (cleared after finalization)
    this.streamingArtifacts = new Map(); // artifactId -> Artifact (status='streaming')
    this.streamBuffers = new Map(); // streamId -> { artifact, buffer }
    
    this.logger.info('ArtifactService: Stream-only mode (backend owns finalized artifacts)');
  }

  // Default logger removed -- createLogger({ component }) used in constructor fallback

  /**
   * Create new artifact from backend-validated stream data
   * ARCHITECTURE: Backend already validated - frontend trusts the data
   */
  async createFromStream(streamData) {
    try {
      // Backend already validated - create artifact directly from trusted data
      const artifact = Artifact.fromStreamData(streamData);
      
      // Cache ONLY if streaming (in-flight)
      if (artifact.status === 'streaming') {
        this.streamingArtifacts.set(artifact.id, artifact);
        this.logger.debug(`Buffering streaming artifact: ${artifact.id}`);
      }

      return artifact;
    } catch (error) {
      this.logger.error('Failed to create artifact from stream:', error);
      throw error;
    }
  }

  /**
   * Update artifact content (for streaming)
   * ARCHITECTURE: Only works for in-flight streaming artifacts
   */
  updateContent(artifactId, additionalContent) {
    const artifact = this.streamingArtifacts.get(artifactId);
    if (!artifact) {
      this.logger.warn(`Streaming artifact not found for update: ${artifactId}`);
      return null;
    }

    // Create updated artifact with new content
    const updatedArtifact = artifact.update({
      content: artifact.content + additionalContent
    });

    // Update streaming cache
    this.streamingArtifacts.set(artifactId, updatedArtifact);

    return updatedArtifact;
  }

  /**
   * Finalize streaming artifact
   * ARCHITECTURE: Backend validated content - frontend persists and REMOVES from cache
   */
  async finalizeArtifact(artifactId, options = {}) {
    try {
      let artifact = this.streamingArtifacts.get(artifactId);
      if (!artifact) {
        this.logger.warn(`Streaming artifact not found for finalization: ${artifactId}`);
        return null;
      }

      // Backend validated content - mark as active
      artifact = artifact.withStatus('active');

      // Persist to backend (source of truth)
      let persistSucceeded = true;
      if (this.repository) {
        try {
          const persistedArtifact = await this.repository.save(artifact);
          artifact = persistedArtifact;
          this.logger.info(`Artifact persisted: ${artifact.id}`);
        } catch (error) {
          this.logger.error(`Failed to persist artifact ${artifactId}:`, error);
          persistSucceeded = false;
        }
      }

      // Track relationships only if persistence succeeded
      if (persistSucceeded && this.traceabilityService) {
        try {
          this.traceabilityService.linkArtifactToMessage(artifactId, artifact.sourceMessageId);
          this.logger.debug(`Artifact linked via traceability: ${artifact.id}`);
        } catch (error) {
          this.logger.warn(`Failed to link artifact with traceability:`, error);
        }
      }

      // REMOVE from streaming cache ONLY if persistence succeeded (or no repository)
      // If persistence failed, keep in cache to prevent data loss
      if (persistSucceeded) {
        this.streamingArtifacts.delete(artifactId);
        this.logger.debug(`Removed finalized artifact from streaming cache: ${artifactId}`);
      } else {
        this.logger.warn(`Artifact ${artifactId} kept in streaming cache due to persistence failure`);
      }

      return artifact;
    } catch (error) {
      this.logger.error(`Failed to finalize artifact ${artifactId}:`, error);
      throw error;
    }
  }

  /**
   * Save artifact to backend
   * ARCHITECTURE: Accept payload (PostgreSQL format), convert to Artifact, persist via repository
   * @param {Object|Artifact} payloadOrArtifact - Artifact payload or Artifact instance
   * @returns {Promise<Artifact>} Saved artifact
   */
  async saveArtifact(payloadOrArtifact) {
    try {
      // Convert to Artifact instance if needed
      let artifact;
      if (payloadOrArtifact instanceof Artifact) {
        artifact = payloadOrArtifact;
      } else {
        // Convert PostgreSQL format payload to Artifact instance
        artifact = Artifact.fromPostgreSQLRow(payloadOrArtifact);
      }

      if (!this.repository) {
        throw new Error('Repository not available - cannot save artifact');
      }

      // Persist to backend
      const savedArtifact = await this.repository.save(artifact);
      this.logger.info(`Artifact saved: ${savedArtifact.id}`);

      return savedArtifact;
    } catch (error) {
      this.logger.error('Failed to save artifact:', error);
      throw error;
    }
  }

  /**
   * Get artifact by ID
   * ARCHITECTURE: Query backend - no general caching
   */
  async getById(artifactId) {
    try {
      // Check if in-flight streaming artifact
      const streaming = this.streamingArtifacts.get(artifactId);
      if (streaming) {
        return streaming;
      }

      // Query backend for finalized artifacts
      if (this.repository) {
        try {
          const artifact = await this.repository.findById(artifactId);
          return artifact || null;
        } catch (error) {
          this.logger.error(`Failed to load artifact ${artifactId}:`, error);
        }
      }

      return null;
    } catch (error) {
      this.logger.error(`ArtifactService.getById failed for ${artifactId}:`, error);
      throw error;
    }
  }

  /**
   * Get artifacts for chat
   * ARCHITECTURE: Query backend - no caching
   */
  async getByChat(chatId) {
    try {
      if (!this.repository) {
        this.logger.warn('Repository not available - cannot query artifacts');
        return [];
      }

      const artifacts = await this.repository.findByChatId(chatId);
      return artifacts;
    } catch (error) {
      this.logger.error(`Failed to load artifacts for chat ${chatId}:`, error);
      return [];
    }
  }

  /**
   * Get artifacts for message
   * ARCHITECTURE: Query backend - no caching
   */
  async getByMessage(messageId) {
    try {
      if (!this.repository) {
        this.logger.warn('Repository not available - cannot query artifacts');
        return [];
      }

      const artifacts = await this.repository.findByMessageId(messageId);
      return artifacts;
    } catch (error) {
      this.logger.error(`Failed to load artifacts for message ${messageId}:`, error);
      return [];
    }
  }

  /**
   * Get artifacts by correlation ID
   * ARCHITECTURE: Query backend - no caching
   */
  async getByCorrelation(correlationId) {
    try {
      if (!this.repository) {
        this.logger.warn('Repository not available - cannot query artifacts');
        return [];
      }

      const artifacts = await this.repository.findByCorrelationId(correlationId);
      return artifacts;
    } catch (error) {
      this.logger.error(`Failed to load artifacts for correlation ${correlationId}:`, error);
      return [];
    }
  }

  /**
   * Link artifact to message
   * ARCHITECTURE: Backend provides valid IDs - frontend trusts them and persists
   */
  async linkToMessage(artifactId, messageId, correlationId = null) {
    try {
      let artifact = await this.getById(artifactId);
      if (!artifact) {
        this.logger.warn(`Artifact not found for linking: ${artifactId}`);
        return null;
      }

      // Backend validated IDs - trust and link
      artifact = artifact.withMessageLink(messageId, correlationId);

      if (this.repository) {
        try {
          await this.repository.updateMessageLink(artifactId, messageId);
          this.logger.info(`Artifact ${artifactId} linked to message ${messageId}`);
        } catch (error) {
          this.logger.error(`Failed to update message link:`, error);
        }
      }

      if (this.traceabilityService) {
        try {
          this.traceabilityService.linkArtifactToMessage(artifactId, messageId);
        } catch (error) {
          this.logger.warn(`Failed to update traceability:`, error);
        }
      }

      return artifact;
    } catch (error) {
      this.logger.error(`Failed to link artifact ${artifactId} to message ${messageId}:`, error);
      throw error;
    }
  }

  /**
   * Archive artifact
   * ARCHITECTURE: Backend owns - no caching
   */
  async archive(artifactId) {
    try {
      const artifact = await this.getById(artifactId);
      if (!artifact) {
        return null;
      }

      const archivedArtifact = artifact.withStatus('archived');

      // Persist to backend (no caching)
      if (this.repository) {
        await this.repository.save(archivedArtifact);
      }

      return archivedArtifact;
    } catch (error) {
      this.logger.error(`Failed to archive artifact ${artifactId}:`, error);
      throw error;
    }
  }

  /**
   * Delete artifact
   * ARCHITECTURE: Backend owns - no caching
   */
  async delete(artifactId) {
    try {
      const artifact = await this.getById(artifactId);
      if (!artifact) {
        return false;
      }

      const deletedArtifact = artifact.withStatus('deleted');

      // Persist to backend (no caching)
      if (this.repository) {
        await this.repository.save(deletedArtifact);
      }

      return true;
    } catch (error) {
      this.logger.error(`Failed to delete artifact ${artifactId}:`, error);
      throw error;
    }
  }

  /**
   * Clear streaming cache
   * ARCHITECTURE: Only clears in-flight streaming artifacts
   */
  clearCache() {
    const count = this.streamingArtifacts.size;
    this.streamingArtifacts.clear();
    this.streamBuffers.clear();
    this.logger.info(`Cleared ${count} streaming artifacts from cache`);
  }

  /**
   * Get streaming cache statistics
   * ARCHITECTURE: Only reflects in-flight streaming artifacts
   */
  getCacheStats() {
    const artifacts = Array.from(this.streamingArtifacts.values());
    
    return {
      streaming: artifacts.length,
      note: 'Only in-flight streaming artifacts - backend owns finalized artifacts',
      byType: {
        code: artifacts.filter(a => a.type === 'code').length,
        output: artifacts.filter(a => a.type === 'output').length,
        html: artifacts.filter(a => a.type === 'html').length,
        file: artifacts.filter(a => a.type === 'file').length
      }
    };
  }
}

module.exports = { ArtifactService };
