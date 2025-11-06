/**
 * @.architecture
 * 
 * Incoming: require() statements from MessageValidator/ChatValidator files --- {module_exports, class}
 * Processing: Aggregate and re-export 2 chat validator classes (MessageValidator, ChatValidator) --- {1 jobs: JOB_ROUTE_BY_TYPE}
 * Outgoing: module.exports barrel export to parent modules (ChatService, domain/chat/index.js) --- {module_exports, class}
 * 
 * 
 * @module domain/chat/validators/index
 * 
 * Chat Domain Validators
 * Exports all chat domain validator classes
 */

const { MessageValidator } = require('./MessageValidator');
const { ChatValidator } = require('./ChatValidator');

module.exports = {
  MessageValidator,
  ChatValidator
};

