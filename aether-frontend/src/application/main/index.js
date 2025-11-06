'use strict';

/**
 * @.architecture
 * 
 * Incoming: none --- {none, none}
 * Processing: Re-export MainOrchestrator for centralized import path --- {1 job: JOB_DELEGATE_TO_MODULE}
 * Outgoing: renderer/main/* (MainOrchestrator) --- {module_exports, javascript_object}
 * 
 * 
 * @module application/main/index
 * 
 * Main Window Application Services
 * ============================================================================
 * Application layer services for the main window renderer.
 * 
 * @module application/main
 */

const { MainOrchestrator } = require('./MainOrchestrator');

module.exports = {
  MainOrchestrator
};

