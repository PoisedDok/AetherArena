/**
 * @.architecture
 * 
 * Incoming: require() statements from ChatRepository/MessageRepository files --- {module_exports, class}
 * Processing: Aggregate and re-export 2 chat repository classes (ChatRepository, MessageRepository) --- {1 jobs: JOB_ROUTE_BY_TYPE}
 * Outgoing: module.exports barrel export to parent modules (ChatService, domain/chat/index.js) --- {module_exports, class}
 * 
 * 
 * @module domain/chat/repositories/index
 * 
 * Chat Domain Repositories
 * Exports all chat domain repository classes
 */

const { ChatRepository } = require('./ChatRepository');
const { MessageRepository } = require('./MessageRepository');

module.exports = {
  ChatRepository,
  MessageRepository
};

