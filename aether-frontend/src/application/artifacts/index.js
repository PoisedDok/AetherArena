'use strict';

/**
 * @.architecture
 * 
 * Incoming: none --- {none, none}
 * Processing: Re-export ArtifactsOrchestrator for centralized import path --- {1 job: JOB_DELEGATE_TO_MODULE}
 * Outgoing: renderer/artifacts/* (ArtifactsOrchestrator) --- {module_exports, javascript_object}
 * 
 * 
 * @module application/artifacts/index
 * 
 * Artifacts Window Application Services
 * ============================================================================
 * Application layer services for the artifacts window renderer.
 * 
 * @module application/artifacts
 */

const { ArtifactsOrchestrator } = require('./ArtifactsOrchestrator');

module.exports = {
  ArtifactsOrchestrator
};

