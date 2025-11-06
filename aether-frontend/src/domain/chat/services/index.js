/**
 * @.architecture
 * 
 * Incoming: require() statements from MessageService/ChatService files --- {module_exports, class}
 * Processing: Aggregate and re-export 2 chat service classes (MessageService, ChatService) --- {1 jobs: JOB_ROUTE_BY_TYPE}
 * Outgoing: module.exports barrel export to parent modules (ChatOrchestrator, domain/chat/index.js) --- {module_exports, class}
 * 
 * 
 * @module domain/chat/services/index
 * 
 * Chat Domain Services
 * Exports all chat domain service classes
 */

const { MessageService } = require('./MessageService');
const { ChatService } = require('./ChatService');

module.exports = {
  MessageService,
  ChatService
};

