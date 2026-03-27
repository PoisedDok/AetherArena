/**
 * @.architecture
 * 
 * Incoming: require() statements from Message/Chat/Conversation files --- {module_exports, class}
 * Processing: Aggregate and re-export 3 chat model classes (Message, Chat, Conversation) --- {1 jobs: JOB_ROUTE_BY_TYPE}
 * Outgoing: module.exports barrel export to parent modules (ChatService, domain/chat/index.js) --- {module_exports, class}
 * 
 * 
 * @module domain/chat/models/index
 * 
 * Chat Domain Models
 * Exports all chat domain model classes
 */

const { Message } = require('./Message');
const { Chat } = require('./Chat');
const { Conversation } = require('./Conversation');

module.exports = {
  Message,
  Chat,
  Conversation
};
