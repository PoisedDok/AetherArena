'use strict';

/**
 * @.architecture
 *
 * Incoming: Proactive context data from main window notifications (via IPC) --- {ipc.proactive_context, object}
 * Processing: Create new chat, persist recommendation as assistant message, attach proactive context in metadata --- {4 jobs: JOB_CREATE_CHAT, JOB_BUILD_CONTENT, JOB_PERSIST_MESSAGE, JOB_RENDER_MESSAGE}
 * Outgoing: New chat created, assistant message rendered, EventBus context:refresh-requested --- {state_mutation | dom_update | event.custom, void | void | json}
 *
 * @module renderer/chat/controllers/modules/ProactiveContextHandler
 *
 * ProactiveContextHandler - Proactive Notification Chat Hydration
 * ============================================================================
 * Extracted from ChatController monolith. Creates a new chat and hydrates it
 * with the proactive assistant recommendation and hidden proactive context.
 *
 * SINGLE RESPONSIBILITY: Handle proactive context arrival by creating a new
 * chat, persisting the recommendation message, and attaching context metadata.
 */

const { createRendererLogger } = require('../../../shared/utils/logger');

const logger = createRendererLogger('ProactiveContextHandler');

class ProactiveContextHandler {
  constructor(options = {}) {
    this.eventBus = options.eventBus || null;
    this.log = logger.child({ scope: 'proactive-context' });

    this.log.debug('ProactiveContextHandler initialized');
  }

  /**
   * Handle proactive context from main window proactive notification.
   * Creates NEW chat and hydrates with:
   *   1. Assistant message = clean recommendation (same as notification)
   *   2. Hidden metadata = full proactive context for follow-up agent turns.
   *
   * ARCHITECTURE: The agent loads chat history from persisted messages.
   * Proactive doc-research context is stored in message metadata (not visible
   * chat text) and injected by normal chat hydration paths.
   *
   * @param {Object} data - Proactive context data
   * @param {string} data.initialMessage - The recommendation text
   * @param {Object} [data.context] - Source context with sources and queries
   * @param {Object} deps - Runtime dependencies
   * @param {boolean} deps.initialized - Whether the controller is initialized
   * @param {Object} deps.modules - Controller modules (messageOrchestrator required)
   * @param {Function} deps.onQueue - Callback to queue data if not initialized: (data) => void
   */
  async handle(data, deps) {
    try {
      if (!data?.initialMessage) {
        this.log.warn('Proactive context called without initialMessage');
        return;
      }

      // If not initialized yet, queue for later processing
      if (!deps.initialized) {
        this.log.info('ChatController not initialized yet, queueing proactive context');
        if (deps.onQueue) {
          deps.onQueue(data);
        }
        return;
      }

      const messageOrchestrator = deps.modules?.messageOrchestrator;
      const messageState = messageOrchestrator?.messageState;
      const messageView = messageOrchestrator?.messageView;

      if (!messageOrchestrator || !messageState || !messageView) {
        this.log.error('Required modules not available', {
          hasOrchestrator: !!messageOrchestrator,
          hasState: !!messageState,
          hasView: !!messageView
        });
        return;
      }

      this.log.info('Setting up lazy chat for proactive context', {
        hasContext: !!data.context,
        messageLength: data.initialMessage.length
      });

      // Keep chat-visible content identical to notification recommendation.
      const messageContent = this._buildMessageContent(data.initialMessage);

      // Build a dynamic chat title from the recommendation
      let chatTitle = 'Proactive Suggestion';
      if (messageContent) {
        // Strip markdown and take first ~40 chars
        const plainText = messageContent.replace(/[*_#`[\]()]/g, '').trim();
        if (plainText) {
          chatTitle = plainText.length > 40 ? `${plainText.substring(0, 37)}...` : plainText;
        }
      }

      // 1. Inject hidden system context message FIRST to properly boot the conversation state
      const seedMessage = {
        id: typeof globalThis.crypto !== 'undefined' && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : `msg_proactive_seed_${Date.now()}`,
        role: 'system',
        content: 'The following is a proactive recommendation based on background context. Respond to follow-up questions using this context.',
        timestamp: new Date().toISOString(),
        metadata: {
          source: 'proactive_seed',
          hidden: true // Keep it invisible in the UI, but present for tokenization/state
        }
      };

      // 2. Create assistant message object
      const assistantMessage = {
        id: typeof globalThis.crypto !== 'undefined' && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : `msg_proactive_${Date.now()}`,
        role: 'assistant',
        content: messageContent,
        timestamp: new Date(Date.now() + 10).toISOString(), // Ensure chronological order after seed
        metadata: {
          source: 'proactive',
          run_id: data.runId
        }
      };

      // Explicitly create a new chat so it persists in the database.
      // Pass seedMessages to ensure they are saved atomically before the backend context reset is sent.
      const newChatId = await messageOrchestrator.createChat(chatTitle, {
        seedMessages: [seedMessage, assistantMessage]
      });

      if (!newChatId) {
        throw new Error('Failed to create chat for proactive context');
      }

      this.log.info('Proactive context hydrated and persisted', {
        chatId: newChatId
      });

      // Trigger UI updates (title is handled by createChat)
      if (this.eventBus) {
        this.eventBus.emit('chat:switched', { chatId: newChatId });
      }
    } catch (error) {
      this.log.error('Failed to hydrate proactive context', { error });
    }
  }

  /**
   * Build message content: recommendation text only.
   * Proactive context stays in metadata and is intentionally not rendered.
   * @private
   * @param {string} initialMessage - The recommendation text
   * @returns {string} Formatted message content
   */
  _buildMessageContent(initialMessage) {
    return typeof initialMessage === 'string' ? initialMessage : '';
  }

  /**
   * Dispose and cleanup.
   */
  dispose() {
    this.eventBus = null;
    this.log.debug('ProactiveContextHandler disposed');
  }
}

module.exports = ProactiveContextHandler;
