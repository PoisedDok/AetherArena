/**
 * @.architecture
 * 
 * Incoming: ChatOrchestrator/MessageManager method calls (factory methods), StreamHandler/persistence layer calls (save/load operations) --- {method_call, javascript_api}
 * Processing: Validate content via MessageValidator, create Message models via factory methods (createUser/createAssistant/createSystem), apply metadata (attachments/llmModel/llmProvider/tokensUsed), set relationships (parentMessageId/correlationId), persist via MessageRepository, query via MessageRepository, generate correlation IDs --- {6 jobs: JOB_DELEGATE_TO_MODULE, JOB_GET_STATE, JOB_INITIALIZE, JOB_LOAD_FROM_DB, JOB_SAVE_TO_DB, JOB_VALIDATE_SCHEMA}
 * Outgoing: MessageRepository.save/saveBatch/findByChatId/findByRole/findByCorrelationId/findRecent/findWithArtifacts/getStatistics (persistence calls), return Message model instances --- {object, javascript_api}
 * 
 * 
 * @module domain/chat/services/MessageService
 */

const { Message } = require('../models/Message');
const { MessageValidator } = require('../validators/MessageValidator');
const { MessageRepository } = require('../repositories/MessageRepository');

class MessageService {
  constructor(dependencies = {}) {
    this.validator = dependencies.validator || new MessageValidator();
    this.repository = dependencies.repository || new MessageRepository(dependencies);
    this.logger = dependencies.logger || console;
  }

  /**
   * Create user message
   */
  createUserMessage(content, chatId = null, options = {}) {
    // Validate content
    this.validator.validateContentOrThrow(content);
    
    const message = Message.createUser(content, chatId);
    
    // Apply options
    if (options.metadata) {
      message.metadata = { ...message.metadata, ...options.metadata };
    }
    
    if (options.attachments) {
      message.metadata.attachments = options.attachments;
    }
    
    if (options.parentMessageId) {
      message.parentMessageId = options.parentMessageId;
    }
    
    if (options.correlationId) {
      message.correlationId = options.correlationId;
    }
    
    return message;
  }

  /**
   * Create assistant message
   */
  createAssistantMessage(content, chatId = null, options = {}) {
    // Validate content
    this.validator.validateContentOrThrow(content);
    
    // Extract correlationId from options or use null
    const correlationId = options.correlationId || null;
    
    const message = Message.createAssistant(content, chatId, correlationId);
    
    // Apply options
    if (options.metadata) {
      message.metadata = { ...options.metadata };
    }
    
    if (options.llmModel || options.model) {
      message.llmModel = options.llmModel || options.model;
      // Also set in metadata for compatibility
      message.metadata.model = options.llmModel || options.model;
    }
    
    if (options.llmProvider) {
      message.llmProvider = options.llmProvider;
      message.metadata.provider = options.llmProvider;
    }
    
    if (options.tokensUsed !== undefined) {
      message.tokensUsed = options.tokensUsed;
      message.metadata.tokensUsed = options.tokensUsed;
    }
    
    if (options.parentMessageId) {
      message.parentMessageId = options.parentMessageId;
    }
    
    return message;
  }

  /**
   * Create system message
   */
  createSystemMessage(content, chatId = null) {
    // Validate content
    this.validator.validateContentOrThrow(content);
    
    return Message.createSystem(content, chatId);
  }

  /**
   * Save message to database
   */
  async saveMessage(message, chatId = null) {
    // Validate message
    this.validator.validateOrThrow(message);
    
    try {
      return await this.repository.save(message, chatId);
    } catch (error) {
      this.logger.error('[MessageService] Failed to save message:', error);
      throw error;
    }
  }

  /**
   * Save multiple messages in batch
   */
  async saveMessages(messages, chatId) {
    // Validate all messages
    messages.forEach(message => {
      this.validator.validateOrThrow(message);
    });
    
    try {
      return await this.repository.saveBatch(messages, chatId);
    } catch (error) {
      this.logger.error('[MessageService] Failed to save message batch:', error);
      throw error;
    }
  }

  /**
   * Load messages for chat
   */
  async loadMessages(chatId) {
    try {
      return await this.repository.findByChatId(chatId);
    } catch (error) {
      this.logger.error(`[MessageService] Failed to load messages for chat ${chatId}:`, error);
      throw error;
    }
  }

  /**
   * Create correlated user-assistant pair
   */
  createCorrelatedPair(userContent, assistantContent, chatId = null, options = {}) {
    const correlationId = Message.generateCorrelationId();
    
    const userMessage = this.createUserMessage(userContent, chatId, {
      metadata: options.userMetadata,
      correlationId
    });
    
    const assistantMessage = this.createAssistantMessage(
      assistantContent,
      chatId,
      {
        llmModel: options.llmModel,
        llmProvider: options.llmProvider,
        tokensUsed: options.tokensUsed,
        metadata: options.assistantMetadata,
        correlationId
      }
    );
    assistantMessage.parentMessageId = userMessage.id;
    
    return { userMessage, assistantMessage, correlationId };
  }

  /**
   * Save correlated pair
   */
  async saveCorrelatedPair(userMessage, assistantMessage, chatId) {
    try {
      const savedUser = await this.saveMessage(userMessage, chatId);
      const savedAssistant = await this.saveMessage(assistantMessage, chatId);
      
      return {
        userMessage: savedUser,
        assistantMessage: savedAssistant
      };
    } catch (error) {
      this.logger.error('[MessageService] Failed to save correlated pair:', error);
      throw error;
    }
  }

  /**
   * Get messages by role
   */
  async getMessagesByRole(chatId, role) {
    this.validator.validateRoleOrThrow(role);
    
    try {
      return await this.repository.findByRole(chatId, role);
    } catch (error) {
      this.logger.error(`[MessageService] Failed to get messages by role ${role}:`, error);
      throw error;
    }
  }

  /**
   * Get messages by correlation ID
   */
  async getMessagesByCorrelationId(chatId, correlationId) {
    this.validator.validateCorrelationId(correlationId);
    
    try {
      return await this.repository.findByCorrelationId(chatId, correlationId);
    } catch (error) {
      this.logger.error(`[MessageService] Failed to get messages by correlation ID:`, error);
      throw error;
    }
  }

  /**
   * Get recent messages
   */
  async getRecentMessages(chatId, limit = 20) {
    try {
      return await this.repository.findRecent(chatId, limit);
    } catch (error) {
      this.logger.error('[MessageService] Failed to get recent messages:', error);
      throw error;
    }
  }

  /**
   * Get messages with artifacts
   */
  async getMessagesWithArtifacts(chatId) {
    try {
      return await this.repository.findWithArtifacts(chatId);
    } catch (error) {
      this.logger.error('[MessageService] Failed to get messages with artifacts:', error);
      throw error;
    }
  }

  /**
   * Get message statistics
   */
  async getStatistics(chatId) {
    try {
      return await this.repository.getStatistics(chatId);
    } catch (error) {
      this.logger.error('[MessageService] Failed to get message statistics:', error);
      throw error;
    }
  }

  /**
   * Format messages for LLM context
   */
  formatForLLM(messages) {
    if (!Array.isArray(messages)) {
      throw new Error('Messages must be an array');
    }
    
    return messages
      .filter(m => m.role !== 'system') // Typically exclude system messages
      .map(m => ({
        role: m.role,
        content: m.content
      }));
  }

  /**
   * Extract thinking content from message
   */
  extractThinking(message) {
    if (!(message instanceof Message)) {
      throw new Error('Must provide Message instance');
    }
    
    const content = message.content;
    const startIdx = content.indexOf('<think>');
    const endIdx = content.indexOf('</think>');
    
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
      return { thinking: null, content: content };
    }
    
    const thinking = content.substring(startIdx + 7, endIdx).trim();
    const cleanContent = content.substring(0, startIdx) + content.substring(endIdx + 8);
    
    return {
      thinking: thinking,
      content: cleanContent.trim()
    };
  }

  /**
   * Check rate limit for session
   */
  checkRateLimit(sessionId) {
    return this.validator.checkRateLimit(sessionId);
  }

  /**
   * Check rate limit or throw
   */
  checkRateLimitOrThrow(sessionId) {
    return this.validator.checkRateLimitOrThrow(sessionId);
  }

  /**
   * Reset rate limit for session
   */
  resetRateLimit(sessionId) {
    this.validator.resetRateLimit(sessionId);
  }

  /**
   * Validate message (compatibility method for tests)
   */
  validateMessage(message) {
    try {
      this.validator.validateOrThrow(message);
      return true;
    } catch (error) {
      return false;
    }
  }
}

module.exports = { MessageService };

