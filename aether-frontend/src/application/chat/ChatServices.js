'use strict';

/**
 * @.architecture
 *
 * Incoming: Presentation layer requesting chat/message services --- {storageAPI, logger}
 * Processing: Compose domain services behind application boundary --- {2 jobs: JOB_CREATE_INSTANCE, JOB_DELEGATE_TO_MODULE}
 * Outgoing: ChatService/MessageService instances, Message factory --- {object, javascript_api}
 *
 * @module application/chat/ChatServices
 */

const { ChatService } = require('../../domain/chat/services/ChatService');
const { MessageService } = require('../../domain/chat/services/MessageService');
const { Message } = require('../../domain/chat/models/Message');

class ChatServices {
  constructor(options = {}) {
    const deps = {
      storageAPI: options.storageAPI,
      logger: options.logger,
    };

    this.chatService = options.chatService || new ChatService(deps);
    this.messageService = options.messageService || new MessageService(deps);
  }

  createDomainMessage(payload, chatIdOverride = null) {
    if (payload instanceof Message) {
      return payload;
    }

    if (!payload || typeof payload !== 'object') {
      throw new Error('[ChatServices] Message payload must be an object');
    }

    return new Message({
      id: payload.id,
      chatId: payload.chatId || chatIdOverride,
      role: payload.role,
      content: payload.content,
      timestamp: payload.timestamp || Date.now(),
      correlationId: payload.correlation_id || payload.correlationId || null,
      parentMessageId: payload.parentMessageId || null,
      llmModel: payload.llm_model || payload.llmModel || null,
      llmProvider: payload.llm_provider || payload.llmProvider || null,
      tokensUsed: payload.tokens_used || payload.tokensUsed || null,
      metadata: payload.metadata || {},
      status: payload.status || (payload.role === 'assistant' ? 'streaming' : 'pending'),
    });
  }
}

module.exports = { ChatServices };
