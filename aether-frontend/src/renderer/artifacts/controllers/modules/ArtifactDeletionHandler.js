'use strict';

/**
 * @.architecture
 *
 * Incoming: EventBus ARTIFACTS.FILE_DELETED events --- {event.custom, object}
 * Processing: Mark deleted IDs, remove from cache, render deleted-artifact message --- {3 jobs: JOB_MARK_DELETED, JOB_REMOVE_CACHE, JOB_RENDER_MESSAGE}
 * Outgoing: UI notification event, viewer DOM updates --- {event.custom | dom_mutation, void}
 *
 * @module renderer/artifacts/controllers/modules/ArtifactDeletionHandler
 *
 * ArtifactDeletionHandler - Artifact Deletion
 * ============================================================================
 * Extracted from ArtifactsController monolith. Handles cache cleanup when
 * artifacts are deleted and renders a "deleted" message in the viewer.
 *
 * SINGLE RESPONSIBILITY: Process artifact deletion events, update tracking
 * state, remove from cache, and display deletion UI.
 */

const { EventTypes } = require('../../../../core/events/EventTypes');
const { createRendererLogger } = require('../../../shared/utils/logger');

const logger = createRendererLogger('ArtifactDeletionHandler');

class ArtifactDeletionHandler {
  /**
   * @param {Object} options
   * @param {Function} options.getDeletedArtifacts - () => Set<string>
   * @param {Function} options.getArtifactCache    - () => Map-like cache
   * @param {Function} options.getCurrentTab        - () => string
   * @param {Function} options.getModules           - () => controller.modules
   * @param {Object}   options.eventBus             - EventBus instance
   */
  constructor(options = {}) {
    this.getDeletedArtifacts = options.getDeletedArtifacts;
    this.getArtifactCache = options.getArtifactCache;
    this.getCurrentTab = options.getCurrentTab;
    this.getModules = options.getModules;
    this.eventBus = options.eventBus;
    this._isDisposed = false;

    this.log = logger.child({ scope: 'deletion-handler' });
    this.log.debug('ArtifactDeletionHandler initialized');
  }

  /**
   * Handle artifact deletion event from FileManager.
   * Marks artifact IDs as deleted and removes from cache.
   *
   * @param {Object} data
   * @param {string} [data.artifactId]
   * @param {string} [data.postgresqlId]
   * @param {string} [data.frontendId]
   * @param {string} [data.filename]
   */
  handleFileDeleted(data) {
    if (this._isDisposed) return;
    if (!data || typeof data !== 'object') {
      this.log.warn('handleFileDeleted called with invalid data', { data });
      return;
    }
    const { artifactId, postgresqlId, frontendId, filename } = data;
    const deletedArtifacts = this.getDeletedArtifacts();
    const artifactCache = this.getArtifactCache();

    this.log.info('Artifact deleted', {
      artifactId,
      postgresqlId,
      frontendId,
      filename
    });

    // Mark as deleted (track all IDs)
    if (artifactId) deletedArtifacts.add(artifactId);
    if (postgresqlId) deletedArtifacts.add(postgresqlId);
    if (frontendId) deletedArtifacts.add(frontendId);

    // Remove from cache
    if (artifactId && artifactCache.has(artifactId)) {
      artifactCache.delete(artifactId);
    }
    if (postgresqlId && artifactCache.has(postgresqlId)) {
      artifactCache.delete(postgresqlId);
    }
    if (frontendId && artifactCache.has(frontendId)) {
      artifactCache.delete(frontendId);
    }

    // Note: SessionStore will naturally not include deleted artifacts on next load
  }

  /**
   * Show a "deleted" placeholder message in the current viewer.
   *
   * @param {string} artifactId - The deleted artifact ID
   */
  showDeletedArtifactMessage(artifactId) {
    if (this._isDisposed) return;
    const currentTab = this.getCurrentTab();
    const modules = this.getModules();

    const message = `
      <div style="
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        padding: 40px;
        color: var(--color-text-secondary);
        text-align: center;
      ">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity: 0.4; margin-bottom: 20px;">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          <line x1="10" y1="11" x2="10" y2="17"></line>
          <line x1="14" y1="11" x2="14" y2="17"></line>
        </svg>
        <h3 style="margin: 0 0 10px 0; font-size: var(--font-size-lg); font-weight: var(--font-weight-medium);">Artifact Deleted</h3>
        <p style="margin: 0; opacity: 0.7; max-width: 400px;">
          This artifact has been permanently deleted and is no longer available.
        </p>
        <p style="margin: 10px 0 0 0; opacity: 0.5; font-size: var(--font-size-xs); font-family: monospace;">
          ${artifactId ? artifactId.substring(0, 60) : 'Unknown ID'}
        </p>
      </div>
    `;

    // Show in current tab's viewer
    if (currentTab === 'code' && modules.codeViewer) {
      modules.codeViewer.loadCode('', '', 'Deleted Artifact');
      // Show message in output viewer instead
      if (modules.outputViewer) {
        modules.outputViewer.loadOutput(message, 'html', artifactId);
      }
    } else if (modules.outputViewer) {
      modules.outputViewer.loadOutput(message, 'html', artifactId);
    }

    // Show notification
    this.eventBus.emit(EventTypes.UI.NOTIFICATION, {
      type: 'info',
      message: 'This artifact has been deleted'
    });
  }

  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;
    // Null out references
    this.getDeletedArtifacts = null;
    this.getArtifactCache = null;
    this.getCurrentTab = null;
    this.getModules = null;
    this.eventBus = null;
    this.log.debug('ArtifactDeletionHandler disposed');
  }
}

module.exports = { ArtifactDeletionHandler };
