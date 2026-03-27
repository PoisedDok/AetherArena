'use strict';

/**
 * @.architecture
 * 
 * Incoming: none --- {none, none}
 * Processing: Re-export RequestLifecycleManager for centralized import path --- {1 job: JOB_DELEGATE_TO_MODULE}
 * Outgoing: application/main, application/chat (RequestLifecycleManager) --- {module_exports, javascript_object}
 * 
 * 
 * @module application/shared/index
 * 
 * Shared Application Services
 * ============================================================================
 * Services shared across orchestrators (main, chat).
 * NOTE: application/artifacts removed - functionality moved to ArtifactsStreamOrchestrator (main).
 * 
 * @module application/shared
 */

const { RequestLifecycleManager } = require('./RequestLifecycleManager');

module.exports = {
  RequestLifecycleManager
};
