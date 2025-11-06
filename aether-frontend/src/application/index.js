'use strict';

/**
 * @.architecture
 * 
 * Incoming: require() calls from consumers --- {none, module_import}
 * Processing: Re-export submodule exports for centralized access --- {1 job: JOB_DELEGATE_TO_MODULE}
 * Outgoing: module.exports object --- {module_types.exports, javascript_object}
 * 
 * @module application/index
 * 
 * Application Layer
 * ============================================================================
 * Application services (orchestrators) that tie domain services to renderers.
 * 
 * Architecture:
 * - Shared: RequestLifecycleManager (used by all orchestrators)
 * - Main: MainOrchestrator (main window coordination)
 * - Chat: ChatOrchestrator (chat window coordination)
 * - Artifacts: ArtifactsOrchestrator (artifacts window coordination)
 * 
 * Each orchestrator:
 * 1. Manages its window's application lifecycle
 * 2. Coordinates domain services and UI modules
 * 3. Handles request/response flows
 * 4. Manages state and transitions
 * 5. Provides cancellation and timeout support
 * 
 * @module application
 */

const shared = require('./shared');
const main = require('./main');
const chat = require('./chat');
const artifacts = require('./artifacts');

module.exports = {
  // Shared
  RequestLifecycleManager: shared.RequestLifecycleManager,
  
  // Main window
  MainOrchestrator: main.MainOrchestrator,
  
  // Chat window
  ChatOrchestrator: chat.ChatOrchestrator,
  
  // Artifacts window
  ArtifactsOrchestrator: artifacts.ArtifactsOrchestrator
};

