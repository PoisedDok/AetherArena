'use strict';

/**
 * @.architecture
 * 
 * Incoming: none --- {none, none}
 * Processing: Re-export ChatOrchestrator for centralized import path --- {1 job: JOB_DELEGATE_TO_MODULE}
 * Outgoing: renderer/chat/* (ChatOrchestrator) --- {module_exports, javascript_object}
 * 
 * 
 * @module application/chat/index
 * 
 * Chat Window Application Services
 * ============================================================================
 * Application layer services for the chat window renderer.
 * 
 * @module application/chat
 */

const { ChatOrchestrator } = require('./ChatOrchestrator');

module.exports = {
  ChatOrchestrator
};

