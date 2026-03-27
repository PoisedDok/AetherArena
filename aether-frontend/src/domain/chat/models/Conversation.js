/**
 * @.architecture
 * 
 * Incoming: ConversationService.create(), ChatService.getConversation(), constructor data (id/chatId/messages/metadata/contextWindow/createdAt/updatedAt), Message instances, JSON data --- {method_calls | constructor_data | json, object | Message}
 * Processing: Initialize conversation with messages array, context window (default 20), build correlation Map (correlationId → {userMessageId, assistantMessageId}), build thread Map (parentMessageId → [childMessageIds]), add messages with automatic map updates, create correlated user-assistant pairs (generate correlationId, set parentMessageId), get correlated messages (user↔assistant lookup via correlationMap), get message threads (parent chain + recursive children), get context window (recent N messages via slice(-contextWindow)), format context for LLM (role/content pairs), set context window size, clear messages and maps, touch() updates updatedAt timestamp, serialize to JSON --- {9 jobs: JOB_GENERATE_SESSION_ID, JOB_GET_STATE, JOB_INITIALIZE, JOB_PARSE_JSON, JOB_STRINGIFY_JSON, JOB_TRACK_ENTITY, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA}
 * Outgoing: Return Message instances, thread arrays, context arrays, JSON representation --- {Message | array | object, javascript_object}
 * 
 * 
 * @module domain/chat/models/Conversation
 * 
 * Conversation.js
 * Domain model representing a conversation context with threading and correlation
 * Manages message relationships, context windows, and conversation flow
 */

const { Message } = require('./Message');

class Conversation {
  constructor(data = {}) {
    this.id = data.id || Conversation.generateId();
    this.chatId = data.chatId || null;
    this.messages = Array.isArray(data.messages)
      ? data.messages.map(m => m instanceof Message ? m : Message.fromJSON(m))
      : [];
    this.metadata = data.metadata ? { ...data.metadata } : {};
    this.contextWindow = data.contextWindow || 20; // Number of messages to maintain in context
    this.createdAt = data.createdAt || Date.now();
    this.updatedAt = data.updatedAt || Date.now();
    
    // Correlation tracking
    this.correlationMap = new Map(); // correlationId -> { userMessageId, assistantMessageId }
    this.threadMap = new Map(); // parentMessageId -> [childMessageIds]
    
    // Initialize maps from existing messages
    this._initializeMaps();
  }

  /**
   * Initialize correlation and thread maps from existing messages
   */
  _initializeMaps() {
    this.messages.forEach(message => {
      // Build correlation map
      if (message.correlationId) {
        const existing = this.correlationMap.get(message.correlationId) || {};
        if (message.isUser()) {
          existing.userMessageId = message.id;
        } else if (message.isAssistant()) {
          existing.assistantMessageId = message.id;
        }
        this.correlationMap.set(message.correlationId, existing);
      }
      
      // Build thread map
      if (message.parentMessageId) {
        const children = this.threadMap.get(message.parentMessageId) || [];
        if (!children.includes(message.id)) {
          children.push(message.id);
        }
        this.threadMap.set(message.parentMessageId, children);
      }
    });
  }

  /**
   * Add message to conversation with automatic correlation
   */
  addMessage(message) {
    if (!(message instanceof Message)) {
      throw new Error('Message must be an instance of Message class');
    }
    
    this.messages.push(message);
    
    // Update correlation map
    if (message.correlationId) {
      const existing = this.correlationMap.get(message.correlationId) || {};
      if (message.isUser()) {
        existing.userMessageId = message.id;
      } else if (message.isAssistant()) {
        existing.assistantMessageId = message.id;
      }
      this.correlationMap.set(message.correlationId, existing);
    }
    
    // Update thread map
    if (message.parentMessageId) {
      const children = this.threadMap.get(message.parentMessageId) || [];
      if (!children.includes(message.id)) {
        children.push(message.id);
      }
      this.threadMap.set(message.parentMessageId, children);
    }
    
    this.touch();
  }

  /**
   * Create user-assistant pair with correlation ID
   */
  addCorrelatedPair(userMessage, assistantMessage) {
    const correlationId = Message.generateCorrelationId();
    
    userMessage.correlationId = correlationId;
    assistantMessage.correlationId = correlationId;
    assistantMessage.parentMessageId = userMessage.id;
    
    this.addMessage(userMessage);
    this.addMessage(assistantMessage);
    
    return correlationId;
  }

  /**
   * Get correlated assistant message for user message
   */
  getCorrelatedAssistantMessage(userMessageId) {
    const userMessage = this.getMessage(userMessageId);
    if (!userMessage || !userMessage.correlationId) {
      return null;
    }
    
    const correlation = this.correlationMap.get(userMessage.correlationId);
    if (!correlation || !correlation.assistantMessageId) {
      return null;
    }
    
    return this.getMessage(correlation.assistantMessageId);
  }

  /**
   * Get correlated user message for assistant message
   */
  getCorrelatedUserMessage(assistantMessageId) {
    const assistantMessage = this.getMessage(assistantMessageId);
    if (!assistantMessage || !assistantMessage.correlationId) {
      return null;
    }
    
    const correlation = this.correlationMap.get(assistantMessage.correlationId);
    if (!correlation || !correlation.userMessageId) {
      return null;
    }
    
    return this.getMessage(correlation.userMessageId);
  }

  /**
   * Get message by ID
   */
  getMessage(messageId) {
    return this.messages.find(m => m.id === messageId) || null;
  }

  /**
   * Get children messages (threaded replies)
   */
  getChildMessages(parentMessageId) {
    const childIds = this.threadMap.get(parentMessageId) || [];
    return childIds.map(id => this.getMessage(id)).filter(Boolean);
  }

  /**
   * Get parent message
   */
  getParentMessage(messageId) {
    const message = this.getMessage(messageId);
    if (!message || !message.parentMessageId) {
      return null;
    }
    return this.getMessage(message.parentMessageId);
  }

  /**
   * Get message thread (parent and all children)
   */
  getThread(messageId) {
    const thread = [];
    const message = this.getMessage(messageId);
    
    if (!message) {
      return thread;
    }
    
    // Get parent chain
    let current = message;
    while (current.parentMessageId) {
      const parent = this.getParentMessage(current.id);
      if (!parent) break;
      thread.unshift(parent);
      current = parent;
    }
    
    // Add current message
    thread.push(message);
    
    // Get children recursively
    const addChildren = (parentId) => {
      const children = this.getChildMessages(parentId);
      children.forEach(child => {
        thread.push(child);
        addChildren(child.id);
      });
    };
    
    addChildren(message.id);
    
    return thread;
  }

  /**
   * Get conversation context (recent messages within window)
   */
  getContext() {
    return this.messages.slice(-this.contextWindow);
  }

  /**
   * Get context as formatted array for LLM
   */
  getContextForLLM() {
    return this.getContext().map(m => ({
      role: m.role,
      content: m.content
    }));
  }

  /**
   * Set context window size
   */
  setContextWindow(size) {
    if (!Number.isInteger(size) || size < 1) {
      throw new Error('Context window must be a positive integer');
    }
    this.contextWindow = size;
  }

  /**
   * Get all messages
   */
  getAllMessages() {
    return [...this.messages];
  }

  /**
   * Get message count
   */
  getMessageCount() {
    return this.messages.length;
  }

  /**
   * Clear all messages
   */
  clear() {
    this.messages = [];
    this.correlationMap.clear();
    this.threadMap.clear();
    this.touch();
  }

  /**
   * Update timestamp
   */
  touch() {
    this.updatedAt = Date.now();
  }

  /**
   * Serialize to plain object
   */
  toJSON() {
    return {
      id: this.id,
      chatId: this.chatId,
      messages: this.messages.map(m => m.toJSON()),
      metadata: { ...this.metadata },
      contextWindow: this.contextWindow,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }

  /**
   * Create from stored object
   */
  static fromJSON(data) {
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid data: must be an object');
    }
    return new Conversation(data);
  }

  /**
   * Generate unique conversation ID
   */
  static generateId() {
    return `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Create new conversation
   */
  static create(chatId = null, contextWindow = 20) {
    return new Conversation({
      id: Conversation.generateId(),
      chatId,
      contextWindow,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }
}

module.exports = { Conversation };
