'use strict';

/**
 * Incoming: EventBus subscriptions --- trail, session, chat, connection, deletion, artifact, attach events --- {EventBus.on callbacks}
 * Processing: Register all event handlers, coordinate event routing to ChatController delegates --- {2 jobs: JOB_REGISTER_HANDLER, JOB_ROUTE_EVENT}
 * Outgoing: Registered cleanup functions for teardown --- {Array<Function>}
 * 
 * EventCoordinator - Centralized Event Management
 * ===============================================
 * 
 * Extracts ALL EventBus event listener registration from ChatController.
 * Every EventBus subscription is centralized here for clarity and testing.
 * 
 * Handles:
 * - Trail events (node clicks, restoration)
 * - Session events (restoration requests)
 * - Chat events (new chat, clear, loaded, switched)
 * - Connection events (backend online/offline)
 * - Deletion events (message deleted, artifact deleted)
 * - Stream events (artifact stream from EventBus)
 * - Attach events (chat reference attach workflow)
 */

const { EventTypes, EventPriority } = require('../../../../core/events/EventTypes');
const { createRendererLogger } = require('../../../shared/utils/logger');

const logger = createRendererLogger('EventCoordinator');

class EventCoordinator {
  constructor(options = {}) {
    this.eventBus = options.eventBus;
    this.trailRestorationService = options.trailRestorationService;
    this.modules = options.modules;
    this.chatController = options.chatController; // Reference for callbacks
    this.log = logger.child({ scope: 'coordinator' });
    
    if (!this.eventBus) {
      throw new Error('[EventCoordinator] eventBus required');
    }
    
    this.listeners = [];
  }
  
  /**
   * Register all event listeners
   * @returns {Array<Function>} Cleanup functions
   */
  registerAll() {
    this.log.debug('Registering all event listeners');
    
    this._registerTrailEvents();
    this._registerSessionEvents();
    this._registerChatEvents();
    this._registerConnectionEvents();
    this._registerDeletionEvents();
    this._registerStreamEvents();
    this._registerAttachEvents();
    
    this.log.debug('Event listeners registered', { count: this.listeners.length });
    return this.listeners;
  }
  
  /**
   * Register trail-related events
   * @private
   */
  _registerTrailEvents() {
    // Trail node clicked
    const cleanupTrailNodeClicked = this.eventBus.on(
      EventTypes.TRAIL.NODE_CLICKED,
      (data) => {
        if (this.chatController && typeof this.chatController._handleTrailNodeClicked === 'function') {
          this.chatController._handleTrailNodeClicked(data);
        }
      }
    );
    this.listeners.push(cleanupTrailNodeClicked);
    
    // Session map loaded
    const cleanupSessionMapLoaded = this.eventBus.on(
      EventTypes.TRAIL.SESSION_MAP_LOADED,
      (payload) => {
        if (this.chatController && typeof this.chatController._restoreFromSessionMap === 'function') {
          try {
            if (!payload || !payload.chatId || !payload.sessionMap) {
              this.log.warn('SESSION_MAP_LOADED event missing required fields');
              return;
            }
            
            const { chatId, sessionMap } = payload;
            this.log.info('Session map loaded - processing timeline', {
              chatId: chatId.substring(0, 8),
              timelineEvents: sessionMap.timeline?.length || 0,
              metadata: sessionMap.metadata
            });
            
            this.chatController._restoreFromSessionMap(chatId, sessionMap);
            
          } catch (error) {
            this.log.error('Failed to handle SESSION_MAP_LOADED event', { 
              error: error.message, 
              stack: error.stack 
            });
          }
        } else {
        }
      },
      { priority: EventPriority.HIGH }
    );
    this.listeners.push(cleanupSessionMapLoaded);
  }
  
  /**
   * Register session restoration events
   * @private
   */
  _registerSessionEvents() {
    // Session restoration requested
    const cleanupSessionRestorationRequested = this.eventBus.on(
      'session:restoration:requested',
      async (payload) => {
        try {
          if (!payload || !payload.chatId) {
            this.log.warn('Session restoration requested without chatId');
            return;
          }
          
          this.log.debug('Session map restoration requested', { 
            chatId: payload.chatId.substring(0, 8) 
          });
          
          // Delegate to application layer service for unified restoration
          if (this.trailRestorationService) {
            await this.trailRestorationService.restoreSessionMap(payload.chatId);
          } else {
            this.log.error('TrailRestorationService not initialized');
          }
        } catch (error) {
          this.log.error('Failed to handle session restoration request', { 
            error: error.message 
          });
        }
      }
    );
    this.listeners.push(cleanupSessionRestorationRequested);
  }
  
  /**
   * Register chat-related events (new chat, clear, loaded, switched)
   * @private
   */
  _registerChatEvents() {
    // New Chat button
    // Create chat + load chat (switch) to trigger all proper signals
    // This ensures context modal, icons, and other features refresh properly
    const cleanupNewChat = this.eventBus.on('chat:new-requested', async () => {
      try {
        if (this.chatController) {
          await this.chatController._handleNewChatRequest();
        } else {
          this.log.error('ChatController not available for new chat request');
        }
      } catch (error) {
        this.log.error('Failed to create new chat', { error });
      }
    });
    this.listeners.push(cleanupNewChat);

    // Clear Chat button
    const cleanupClearChat = this.eventBus.on('chat:clear-requested', () => {
      try {
        this.log.info('Clear chat requested');
        if (this.modules.messageOrchestrator) {
          this.modules.messageOrchestrator.messageState.clearMessages();
        }
      } catch (error) {
        this.log.error('Failed to clear chat', { error });
      }
    });
    this.listeners.push(cleanupClearChat);

    // Chat loaded - Update currentChatId when user switches chats
    // CRITICAL: Use HIGH priority to ensure this runs BEFORE ChatWindow refreshes context display
    const cleanupChatLoaded = this.eventBus.on('chat:loaded', (data) => {
      try {
        if (data && data.chatId && this.chatController) {
          this.chatController.setCurrentChatId(data.chatId);
        }
      } catch (error) {
        this.log.error('Failed to handle chat:loaded event', { error });
      }
    }, { priority: EventPriority.HIGH });
    this.listeners.push(cleanupChatLoaded);

    // Chat switched - Ensure currentChatId is updated on any switch event
    const cleanupChatSwitched = this.eventBus.on(EventTypes.CHAT.SWITCHED, (data) => {
      try {
        if (data && data.chatId && this.chatController) {
          this.chatController.setCurrentChatId(data.chatId);
        }
      } catch (error) {
        this.log.error('Failed to handle chat:switched event', { error });
      }
    }, { priority: EventPriority.HIGH });
    this.listeners.push(cleanupChatSwitched);

    // Message error - Update state and UI for failed messages
    const cleanupMessageError = this.eventBus.on(EventTypes.CHAT.MESSAGE_ERROR, (data) => {
      try {
        this.log.error('Message error event received', data);
        if (this.chatController && typeof this.chatController._handleMessageError === 'function') {
          this.chatController._handleMessageError(data);
        }
      } catch (error) {
        this.log.error('Failed to handle message error event', { error });
      }
    });
    this.listeners.push(cleanupMessageError);
  }

  /**
   * Register backend connection events
   * @private
   */
  _registerConnectionEvents() {
    const cleanupBackendOnline = this.eventBus.on(
      EventTypes.CONNECTION.BACKEND_ONLINE,
      (data) => {
        if (this.chatController) {
          this.chatController._handleBackendOnline(data);
        }
      },
      { priority: EventPriority.HIGH }
    );
    this.listeners.push(cleanupBackendOnline);

    const cleanupBackendOffline = this.eventBus.on(
      EventTypes.CONNECTION.BACKEND_OFFLINE,
      (data) => {
        if (this.chatController) {
          this.chatController._handleBackendOffline(data);
        }
      },
      { priority: EventPriority.HIGH }
    );
    this.listeners.push(cleanupBackendOffline);
  }

  /**
   * Register message/artifact deletion events
   * @private
   */
  _registerDeletionEvents() {
    // Message deletion (from ContextViewerModal)
    const cleanupMessageDeleted = this.eventBus.on(EventTypes.CHAT.MESSAGE_DELETED, (data) => {
      try {
        this.log.info('Message deleted event received', {
          chatId: data.chatId,
          messageId: data.messageId,
          deletedMessages: data.deletedMessages,
          deletedArtifacts: data.deletedArtifacts
        });
        if (this.chatController) {
          this.chatController._handleMessageDeleted(data);
        }
      } catch (error) {
        this.log.error('Failed to handle message deletion', { error });
      }
    });
    this.listeners.push(cleanupMessageDeleted);

    // Artifact deletion (from ChatFilesModal or ArtifactsLibraryModal)
    const cleanupArtifactDeleted = this.eventBus.on(EventTypes.ARTIFACTS.ARTIFACT_DELETED, (data) => {
      try {
        this.log.info('Artifact deleted event received', {
          chatId: data.chatId,
          artifactId: data.artifactId
        });
        if (this.chatController) {
          this.chatController._handleArtifactDeleted(data);
        }
      } catch (error) {
        this.log.error('Failed to handle artifact deletion', { error });
      }
    });
    this.listeners.push(cleanupArtifactDeleted);
  }

  /**
   * Register artifact stream events from EventBus (WebSocket artifacts)
   * @private
   */
  _registerStreamEvents() {
    const cleanupArtifactStream = this.eventBus.on('artifact:stream', (payload) => {
      try {
        this.log.debug('Artifact stream event received, forwarding to coordinator', { type: payload?.type });
        if (this.chatController) {
          this.chatController._handleArtifactStream(payload);
        }
      } catch (error) {
        this.log.error('Failed to handle artifact stream', { error });
      }
    });
    this.listeners.push(cleanupArtifactStream);
  }

  /**
   * Register chat attach workflow events (Phase 9C - attach chat summaries as files)
   * @private
   */
  _registerAttachEvents() {
    // Chat attach requested from input
    const cleanupChatAttachRequest = this.eventBus.on('chat-reference:attach-requested-from-input', async (data) => {
      try {
        this.log.debug('Chat attach requested', { sourceChatId: data.sourceChatId });

        if (!this.modules.chatSelectorModal) {
          // Lazy initialize ChatSelectorModal
          const ChatSelectorModal = require('../../modals/ChatSelectorModal');
          this.modules.chatSelectorModal = new ChatSelectorModal({
            eventBus: this.eventBus,
            chatService: this.modules.messageOrchestrator?.messageState?.chatService
          });
        }

        this.modules.chatSelectorModal.open(data.sourceChatId, []);
      } catch (error) {
        this.log.error('Failed to open chat selector modal', { error });
      }
    });
    this.listeners.push(cleanupChatAttachRequest);

    // Handle chat selection - download summaries and attach as files
    const cleanupChatSelection = this.eventBus.on('chat-reference:chats-selected', async (data) => {
      try {
        this.log.debug('Chats selected for attachment', {
          count: data.selectedChats?.length,
          chats: data.selectedChats
        });

        if (!data.selectedChats || data.selectedChats.length === 0) {
          this.log.warn('No chats selected');
          return;
        }

        if (this.chatController) {
          await this.chatController._attachChatSummariesAsFiles(data.selectedChats);
        }
      } catch (error) {
        this.log.error('Failed to attach chat summaries', { error });
      }
    });
    this.listeners.push(cleanupChatSelection);
  }
  
  /**
   * Cleanup all registered listeners
   */
  cleanup() {
    this.log.debug('Cleaning up event listeners', { count: this.listeners.length });
    
    for (const cleanup of this.listeners) {
      if (typeof cleanup === 'function') {
        cleanup();
      }
    }
    
    this.listeners = [];
  }
}

module.exports = EventCoordinator;
