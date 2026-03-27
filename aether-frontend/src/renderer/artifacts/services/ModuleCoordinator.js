'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactsController.loadArtifact(artifact, classification) --- {artifact_types.*, object}
 * Processing: Coordinate viewer module calls (codeViewer/outputViewer/fileManager), route artifacts to correct viewer, handle module availability, provide facade for module interactions --- {4 jobs: JOB_DELEGATE_TO_MODULE, JOB_ROUTE_BY_TYPE, JOB_VALIDATE_SCHEMA, JOB_LOG_EVENT}
 * Outgoing: Delegate to viewer modules (codeViewer.loadCode, outputViewer.loadOutput, fileManager.addFile) --- {none}
 * 
 * ARCHITECTURE:
 * - Facade pattern for viewer modules
 * - Decouples controller from direct module dependencies
 * - Provides clean API for artifact display
 * - Handles module availability gracefully
 * - Enables module swapping/mocking for testing
 * - Pure coordination, no business logic
 * 
 * BENEFITS:
 * - Single point of contact for viewer modules
 * - Easy to add new viewers
 * - Testable without real modules
 * - Clean separation of concerns
 * 
 * @module renderer/artifacts/services/ModuleCoordinator
 */

const { createRendererLogger } = require('../../shared/utils/logger');

const logger = createRendererLogger('ModuleCoordinator');

class ModuleCoordinator {
  /**
   * Create module coordinator
   * @param {Object} modules - Viewer modules
   * @param {Object} modules.codeViewer - Code viewer module
   * @param {Object} modules.outputViewer - Output viewer module
   * @param {Object} modules.fileManager - File manager module
   */
  constructor(modules = {}) {
    this.modules = modules;
  }

  /**
   * Load artifact to appropriate viewer
   * @param {Object} artifact - Artifact to load
   * @param {Object} classification - Routing classification
   * @returns {boolean} True if loaded, false if viewer unavailable
   */
  loadToViewer(artifact, classification) {
    // FAIL FAST: Validate inputs
    if (!artifact || typeof artifact !== 'object') {
      throw new Error('[ModuleCoordinator] Artifact must be an object');
    }

    if (!classification || typeof classification !== 'object') {
      throw new Error('[ModuleCoordinator] Classification must be an object');
    }

    if (!classification.viewer) {
      throw new Error('[ModuleCoordinator] Classification must have a viewer');
    }

    const viewer = classification.viewer.toLowerCase();

    switch (viewer) {
      case 'code':
        return this.loadToCodeViewer(artifact, classification);
      
      case 'files':
        return this.loadToFileManager(artifact, classification);
      
      case 'output':
      case 'console':
      default:
        return this.loadToOutputViewer(artifact, classification);
    }
  }

  /**
   * Load artifact to code viewer
   * @param {Object} artifact - Artifact to load
   * @param {Object} classification - Classification
   * @returns {boolean} True if loaded
   */
  loadToCodeViewer(artifact, classification) {
    if (!this.modules.codeViewer) {
      logger.warn('codeViewer not available', { artifactId: artifact.id });
      return false;
    }

    const content = artifact.content;
    const language = artifact.language || artifact.format || classification.format || 'text';
    const filename = artifact.filename || classification.filename || 'untitled';
    const artifactId = artifact.id || artifact.artifactId;

    logger.info('Loading to codeViewer', { 
      artifactId, 
      language, 
      filename, 
      contentLength: content?.length 
    });

    this.modules.codeViewer.loadCode(content, language, filename, artifactId);
    return true;
  }

  /**
   * Load artifact to output viewer
   * @param {Object} artifact - Artifact to load
   * @param {Object} classification - Classification
   * @returns {boolean} True if loaded
   */
  loadToOutputViewer(artifact, classification) {
    if (!this.modules.outputViewer) {
      logger.error('outputViewer not available (CRITICAL)', { artifactId: artifact.id });
      return false;
    }

    const content = classification.content !== undefined 
      ? classification.content 
      : artifact.content;
    let format = classification.format || artifact.format || 'text';
    const artifactId = artifact.id || artifact.artifactId;

    // SMART FORMAT DETECTION: Early HTML override only.
    // Backend sometimes sends HTML content with format='text' or 'markdown'.
    // HTML needs format set early so the correct renderer is selected.
    // JSON and search results detection is delegated to OutputViewer._detectFormat
    // which has the full priority matrix (search results > JSON > HTML > markdown > text).
    // Doing JSON detection here would prevent OutputViewer from recognizing search results.
    if ((format === 'text' || format === 'markdown') && typeof content === 'string' && content.trim().length > 0) {
      const trimmed = content.trim();

      // Detect HTML: starts with < and contains closing/self-closing tag
      if (trimmed.startsWith('<') && (trimmed.includes('</') || trimmed.endsWith('>'))) {
        const hasHtmlTags = /^<(!DOCTYPE|html|head|body|div|span|p|h\d|table|ul|ol|li|a|img|script|style)/i.test(trimmed);
        if (hasHtmlTags) {
          format = 'html';
          logger.info('Auto-detected HTML content, overriding format', {
            artifactId,
            originalFormat: classification.format || artifact.format || 'text',
            newFormat: 'html',
            contentPreview: content.substring(0, 100)
          });
        }
      }
    }

    logger.info('Loading to outputViewer', {
      artifactId,
      format,
      contentLength: content?.length,
      role: artifact.role,
      type: artifact.type
    });

    this.modules.outputViewer.loadOutput(content, format, artifactId);
    return true;
  }

  /**
   * Load artifact to file manager
   * @param {Object} artifact - Artifact to load
   * @param {Object} classification - Classification
   * @returns {boolean} True if loaded
   */
  loadToFileManager(artifact, classification) {
    if (!this.modules.fileManager || 
        typeof this.modules.fileManager.addFile !== 'function') {
      logger.warn('fileManager not available or addFile method missing', { 
        artifactId: artifact.id 
      });
      return false;
    }

    logger.info('Adding to fileManager', { artifactId: artifact.id });

    this.modules.fileManager.addFile(artifact);
    return true;
  }

  /**
   * Highlight artifact in file manager
   * @param {string} artifactId - Artifact ID to highlight
   * @returns {boolean} True if highlighted
   */
  highlightArtifact(artifactId) {
    if (!this.modules.fileManager || 
        typeof this.modules.fileManager.highlightArtifact !== 'function') {
      return false;
    }

    this.modules.fileManager.highlightArtifact(artifactId);
    return true;
  }

  /**
   * Check if viewer is available
   * @param {string} viewerName - Viewer name (code, output, files)
   * @returns {boolean} True if available
   */
  isViewerAvailable(viewerName) {
    switch (viewerName.toLowerCase()) {
      case 'code':
        return Boolean(this.modules.codeViewer);
      
      case 'output':
      case 'console':
        return Boolean(this.modules.outputViewer);
      
      case 'files':
        return Boolean(this.modules.fileManager);
      
      default:
        return false;
    }
  }

  /**
   * Get available viewers
   * @returns {Array<string>} Array of available viewer names
   */
  getAvailableViewers() {
    const available = [];

    if (this.modules.codeViewer) {
      available.push('code');
    }

    if (this.modules.outputViewer) {
      available.push('output');
    }

    if (this.modules.fileManager) {
      available.push('files');
    }

    return available;
  }

  /**
   * Update modules (for hot-swapping)
   * @param {Object} modules - New modules object
   */
  updateModules(modules) {
    this.modules = { ...this.modules, ...modules };
  }
}

// Export
module.exports = { ModuleCoordinator };
