'use strict';

/**
 * @.architecture
 *
 * Incoming: ipcMain.handle('session:*') from preload bridges --- {Dict, json}
 * Processing: Delegate to core SessionManager for deterministic ID issuance and active-session coordination --- {3 jobs: JOB_DELEGATE_TO_MODULE, JOB_GENERATE_SESSION_ID, JOB_GET_STATE}
 * Outgoing: Deterministic identifiers, session statistics --- {Dict, json}
 */

const { ipcMain } = require('electron');
const { sessionManager, ID_TYPES, parseSessionId } = require('../../core/session/SessionManager');
const { logger } = require('../../core/utils/logger');

const CHANNELS = Object.freeze({
  SET_ACTIVE: 'session:set-active',
  NEXT_ID: 'session:next-id',
  PARSE_ID: 'session:parse-id',
  GET_STATS: 'session:get-stats',
  CLEAR_SESSION: 'session:clear',
  CLEAR_ALL: 'session:clear-all'
});

const KIND_TO_GENERATOR = Object.freeze({
  user_message: () => sessionManager.nextUserMessageId(),
  assistant_message: (payload = {}) => sessionManager.nextAssistantMessageId(payload.parentId || payload.userMessageId || null),
  assistant_code: (payload = {}) => sessionManager.nextCodeArtifactId(payload.parentId || payload.messageId || null),
  assistant_output: (payload = {}) => sessionManager.nextOutputArtifactId(payload.parentId || payload.codeId || null),
  assistant_html: (payload = {}) => sessionManager.nextHtmlArtifactId(payload.parentId || payload.messageId || null),
  user_attachment: (payload = {}) => sessionManager.nextAttachmentId(payload.parentId || payload.messageId || null)
});

class SessionIpcHandler {
  constructor(options = {}) {
    this.logger = logger.child({ module: 'SessionIpcHandler' });
    this.isInitialized = false;
    this._handlers = new Map();
    this.windowManager = options.windowManager || null;
  }

  initialize() {
    if (this.isInitialized) {
      this.logger.warn('Session IPC handler already initialized');
      return;
    }

    this.logger.info('Initializing Session IPC handler');

    this._register(CHANNELS.SET_ACTIVE, this._handleSetActive.bind(this));
    this._register(CHANNELS.NEXT_ID, this._handleNextId.bind(this));
    this._register(CHANNELS.PARSE_ID, this._handleParseId.bind(this));
    this._register(CHANNELS.GET_STATS, this._handleGetStats.bind(this));
    this._register(CHANNELS.CLEAR_SESSION, this._handleClearSession.bind(this));
    this._register(CHANNELS.CLEAR_ALL, this._handleClearAll.bind(this));

    this.isInitialized = true;
    this.logger.info('Session IPC handler ready');
  }

  shutdown() {
    if (!this.isInitialized) {
      return;
    }

    this.logger.info('Shutting down Session IPC handler');

    this._handlers.forEach((handler, channel) => {
      ipcMain.removeHandler(channel);
    });
    this._handlers.clear();
    this.isInitialized = false;
  }

  _register(channel, handler) {
    if (this._handlers.has(channel)) {
      this.logger.warn('Replacing existing session handler', { channel });
      ipcMain.removeHandler(channel);
    }
    
    const wrappedHandler = async (event, ...args) => {
      if (this.windowManager) {
        if (!this.windowManager.isValidWebContents(event.sender)) {
          this.logger.warn('IPC handle from unauthorized source', { channel });
          throw new Error('Unauthorized IPC source');
        }
      }
      return handler(event, ...args);
    };
    
    ipcMain.handle(channel, wrappedHandler);
    this._handlers.set(channel, wrappedHandler);
  }

  async _handleSetActive(_event, payload = {}) {
    const { chatId } = payload;
    if (!chatId || typeof chatId !== 'string') {
      throw new Error('[SessionIpcHandler] chatId is required to set active session');
    }
    sessionManager.setActiveChat(chatId);
    this.logger.debug('Active session set via IPC', { chatId });
    return this._formatSessionStats(chatId);
  }

  async _handleNextId(_event, payload = {}) {
    const { kind, chatId } = payload;
    if (chatId && typeof chatId === 'string') {
      sessionManager.setActiveChat(chatId);
    }
    const generator = KIND_TO_GENERATOR[kind];
    if (!generator) {
      const message = `[SessionIpcHandler] Unsupported session id kind: ${kind}`;
      this.logger.error(message);
      throw new Error(message);
    }
    const id = generator(payload);
    this.logger.trace('Session ID generated', { kind, chatId: sessionManager.currentChatId, id });
    return { id, kind, chatId: sessionManager.currentChatId };
  }

  async _handleParseId(_event, payload = {}) {
    const { id } = payload;
    if (!id || typeof id !== 'string') {
      throw new Error('[SessionIpcHandler] id must be provided for parse');
    }
    const parsed = parseSessionId(id);
    return parsed;
  }

  async _handleGetStats() {
    const activeChatId = sessionManager.currentChatId || null;
    return this._formatSessionStats(activeChatId);
  }

  async _handleClearSession(_event, payload = {}) {
    const { chatId } = payload;
    if (!chatId || typeof chatId !== 'string') {
      throw new Error('[SessionIpcHandler] chatId is required to clear session');
    }
    sessionManager.clearSession(chatId);
    this.logger.info('Cleared session via IPC', { chatId });
    return this._formatSessionStats(sessionManager.currentChatId || null);
  }

  async _handleClearAll() {
    sessionManager.clearAll();
    this.logger.warn('All sessions cleared via IPC');
    return this._formatSessionStats(null);
  }

  _formatSessionStats(activeChatId) {
    return {
      activeChatId,
      activeSessions: sessionManager.getActiveSessions(),
      stats: sessionManager.getAllStats(),
      idTypes: ID_TYPES
    };
  }
}

let singleton = null;

function getSessionHandler(options = {}) {
  if (!singleton) {
    singleton = new SessionIpcHandler(options);
  }
  return singleton;
}

module.exports = {
  SessionIpcHandler,
  getSessionHandler,
  CHANNELS
};
