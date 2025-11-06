/**
 * @.architecture
 * 
 * Incoming: none --- {none, none}
 * Processing: Re-export Message/Chat/Conversation (models), MessageValidator/ChatValidator (validators), ChatRepository/MessageRepository (repositories), MessageService/ChatService/ChatSessionService (services) for centralized import path --- {1 job: JOB_DELEGATE_TO_MODULE}
 * Outgoing: application/*, renderer/* (chat domain layer) --- {module_exports, javascript_object}
 * 
 * 
 * @module domain/chat/index
 * 
 * Chat Domain
 * Exports all chat domain components
 */

const models = require('./models');
const validators = require('./validators');
const repositories = require('./repositories');
const services = require('./services');

module.exports = {
  // Models
  Message: models.Message,
  Chat: models.Chat,
  Conversation: models.Conversation,
  
  // Validators
  MessageValidator: validators.MessageValidator,
  ChatValidator: validators.ChatValidator,
  
  // Repositories
  ChatRepository: repositories.ChatRepository,
  MessageRepository: repositories.MessageRepository,
  
  // Services
  MessageService: services.MessageService,
  ChatService: services.ChatService,
  ChatSessionService: services.ChatSessionService
};

