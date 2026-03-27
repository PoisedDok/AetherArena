'use strict';

// ============================================================================
// Mocks
// ============================================================================

const mockIpcMain = {
  handle: jest.fn(),
  removeHandler: jest.fn(),
};

jest.mock('electron', () => ({
  app: { on: jest.fn(), whenReady: jest.fn(() => Promise.resolve()), getPath: jest.fn(() => '/tmp/test'), quit: jest.fn() },
  BrowserWindow: jest.fn(),
  ipcMain: mockIpcMain,
  ipcRenderer: { send: jest.fn(), invoke: jest.fn(), on: jest.fn() },
}), { virtual: true });

const mockSessionManager = {
  setActiveChat: jest.fn(),
  nextUserMessageId: jest.fn(() => 'user-msg-001'),
  nextAssistantMessageId: jest.fn(() => 'asst-msg-001'),
  nextCodeArtifactId: jest.fn(() => 'code-art-001'),
  nextOutputArtifactId: jest.fn(() => 'out-art-001'),
  nextHtmlArtifactId: jest.fn(() => 'html-art-001'),
  nextAttachmentId: jest.fn(() => 'attach-001'),
  currentChatId: 'chat-abc',
  getActiveSessions: jest.fn(() => ['chat-abc']),
  getAllStats: jest.fn(() => ({ totalIds: 10 })),
  clearSession: jest.fn(),
  clearAll: jest.fn(),
};

const mockParseSessionId = jest.fn(() => ({ type: 'user_message', chatId: 'chat-abc', seq: 1 }));
const mockIdTypes = { USER_MESSAGE: 'user_message', ASSISTANT_MESSAGE: 'assistant_message' };

jest.mock('../../../src/core/session/SessionManager', () => ({
  sessionManager: mockSessionManager,
  ID_TYPES: mockIdTypes,
  parseSessionId: mockParseSessionId,
}));

const mockChildLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};

jest.mock('../../../src/core/utils/logger', () => ({
  logger: {
    child: jest.fn(() => mockChildLogger),
  },
}));

// ============================================================================
// Import after mocks
// ============================================================================

const { SessionIpcHandler, getSessionHandler, CHANNELS } = require('../../../src/main/services/SessionIpcHandler');

// ============================================================================
// Test Suite
// ============================================================================

describe('SessionIpcHandler', () => {
  let handler;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset sessionManager state
    mockSessionManager.currentChatId = 'chat-abc';
    mockSessionManager.nextUserMessageId.mockReturnValue('user-msg-001');
    mockSessionManager.nextAssistantMessageId.mockReturnValue('asst-msg-001');
    mockSessionManager.nextCodeArtifactId.mockReturnValue('code-art-001');
    mockSessionManager.nextOutputArtifactId.mockReturnValue('out-art-001');
    mockSessionManager.nextHtmlArtifactId.mockReturnValue('html-art-001');
    mockSessionManager.nextAttachmentId.mockReturnValue('attach-001');
    mockSessionManager.getActiveSessions.mockReturnValue(['chat-abc']);
    mockSessionManager.getAllStats.mockReturnValue({ totalIds: 10 });
    mockParseSessionId.mockReturnValue({ type: 'user_message', chatId: 'chat-abc', seq: 1 });
    handler = new SessionIpcHandler();
  });

  // --------------------------------------------------------------------------
  // CHANNELS export
  // --------------------------------------------------------------------------

  describe('CHANNELS', () => {
    it('exports all 6 channel constants', () => {
      expect(CHANNELS).toEqual({
        SET_ACTIVE: 'session:set-active',
        NEXT_ID: 'session:next-id',
        PARSE_ID: 'session:parse-id',
        GET_STATS: 'session:get-stats',
        CLEAR_SESSION: 'session:clear',
        CLEAR_ALL: 'session:clear-all',
      });
    });

    it('CHANNELS object is frozen', () => {
      expect(Object.isFrozen(CHANNELS)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Constructor
  // --------------------------------------------------------------------------

  describe('constructor', () => {
    it('creates child logger with module name', () => {
      const { logger } = require('../../../src/core/utils/logger');
      expect(logger.child).toHaveBeenCalledWith({ module: 'SessionIpcHandler' });
    });

    it('initializes with isInitialized = false', () => {
      expect(handler.isInitialized).toBe(false);
    });

    it('initializes with empty handlers map', () => {
      expect(handler._handlers).toBeInstanceOf(Map);
      expect(handler._handlers.size).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // initialize()
  // --------------------------------------------------------------------------

  describe('initialize', () => {
    it('registers 6 IPC handlers via ipcMain.handle', () => {
      handler.initialize();
      expect(mockIpcMain.handle).toHaveBeenCalledTimes(6);
    });

    it('registers all expected channels', () => {
      handler.initialize();
      const registeredChannels = mockIpcMain.handle.mock.calls.map(c => c[0]);
      expect(registeredChannels).toEqual([
        'session:set-active',
        'session:next-id',
        'session:parse-id',
        'session:get-stats',
        'session:clear',
        'session:clear-all',
      ]);
    });

    it('tracks handlers in the _handlers map', () => {
      handler.initialize();
      expect(handler._handlers.size).toBe(6);
      expect(handler._handlers.has('session:set-active')).toBe(true);
      expect(handler._handlers.has('session:next-id')).toBe(true);
      expect(handler._handlers.has('session:parse-id')).toBe(true);
      expect(handler._handlers.has('session:get-stats')).toBe(true);
      expect(handler._handlers.has('session:clear')).toBe(true);
      expect(handler._handlers.has('session:clear-all')).toBe(true);
    });

    it('sets isInitialized to true', () => {
      handler.initialize();
      expect(handler.isInitialized).toBe(true);
    });

    it('logs initialization messages', () => {
      handler.initialize();
      expect(mockChildLogger.info).toHaveBeenCalledWith('Initializing Session IPC handler');
      expect(mockChildLogger.info).toHaveBeenCalledWith('Session IPC handler ready');
    });

    it('warns and returns early if already initialized', () => {
      handler.initialize();
      jest.clearAllMocks();
      handler.initialize();
      expect(mockChildLogger.warn).toHaveBeenCalledWith('Session IPC handler already initialized');
      expect(mockIpcMain.handle).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // shutdown()
  // --------------------------------------------------------------------------

  describe('shutdown', () => {
    it('removes all registered handlers via ipcMain.removeHandler', () => {
      handler.initialize();
      handler.shutdown();
      expect(mockIpcMain.removeHandler).toHaveBeenCalledTimes(6);
    });

    it('removes handlers for correct channels', () => {
      handler.initialize();
      handler.shutdown();
      const removedChannels = mockIpcMain.removeHandler.mock.calls.map(c => c[0]);
      expect(removedChannels).toContain('session:set-active');
      expect(removedChannels).toContain('session:next-id');
      expect(removedChannels).toContain('session:parse-id');
      expect(removedChannels).toContain('session:get-stats');
      expect(removedChannels).toContain('session:clear');
      expect(removedChannels).toContain('session:clear-all');
    });

    it('clears the handlers map', () => {
      handler.initialize();
      handler.shutdown();
      expect(handler._handlers.size).toBe(0);
    });

    it('sets isInitialized to false', () => {
      handler.initialize();
      expect(handler.isInitialized).toBe(true);
      handler.shutdown();
      expect(handler.isInitialized).toBe(false);
    });

    it('logs shutdown message', () => {
      handler.initialize();
      jest.clearAllMocks();
      handler.shutdown();
      expect(mockChildLogger.info).toHaveBeenCalledWith('Shutting down Session IPC handler');
    });

    it('does nothing if not initialized', () => {
      handler.shutdown();
      expect(mockIpcMain.removeHandler).not.toHaveBeenCalled();
      expect(mockChildLogger.info).not.toHaveBeenCalledWith('Shutting down Session IPC handler');
    });

    it('allows re-initialization after shutdown', () => {
      handler.initialize();
      handler.shutdown();
      jest.clearAllMocks();
      handler.initialize();
      expect(mockIpcMain.handle).toHaveBeenCalledTimes(6);
      expect(handler.isInitialized).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // _register()
  // --------------------------------------------------------------------------

  describe('_register', () => {
    it('replaces existing handler if channel already registered', () => {
      handler.initialize();
      const existingHandler = handler._handlers.get('session:set-active');
      jest.clearAllMocks();

      const newHandler = jest.fn();
      handler._register('session:set-active', newHandler);

      expect(mockChildLogger.warn).toHaveBeenCalledWith('Replacing existing session handler', {
        channel: 'session:set-active',
      });
      expect(mockIpcMain.removeHandler).toHaveBeenCalledWith('session:set-active');
      expect(mockIpcMain.handle).toHaveBeenCalledWith('session:set-active', expect.any(Function));
    });
  });

  // --------------------------------------------------------------------------
  // Handler method tests - extract handlers from ipcMain.handle calls
  // --------------------------------------------------------------------------

  describe('IPC handlers', () => {
    let handlers;

    beforeEach(() => {
      handler.initialize();
      // Capture registered handlers keyed by channel
      handlers = {};
      mockIpcMain.handle.mock.calls.forEach(([channel, fn]) => {
        handlers[channel] = fn;
      });
    });

    // ------------------------------------------------------------------------
    // _handleSetActive
    // ------------------------------------------------------------------------

    describe('session:set-active', () => {
      it('sets active chat and returns formatted stats', async () => {
        const result = await handlers['session:set-active']({}, { chatId: 'chat-xyz' });
        expect(mockSessionManager.setActiveChat).toHaveBeenCalledWith('chat-xyz');
        expect(mockChildLogger.debug).toHaveBeenCalledWith('Active session set via IPC', { chatId: 'chat-xyz' });
        expect(result).toEqual({
          activeChatId: 'chat-xyz',
          activeSessions: ['chat-abc'],
          stats: { totalIds: 10 },
          idTypes: mockIdTypes,
        });
      });

      it('throws if chatId is missing', async () => {
        await expect(handlers['session:set-active']({}, {})).rejects.toThrow(
          '[SessionIpcHandler] chatId is required to set active session'
        );
      });

      it('throws if chatId is null', async () => {
        await expect(handlers['session:set-active']({}, { chatId: null })).rejects.toThrow(
          '[SessionIpcHandler] chatId is required to set active session'
        );
      });

      it('throws if chatId is not a string', async () => {
        await expect(handlers['session:set-active']({}, { chatId: 123 })).rejects.toThrow(
          '[SessionIpcHandler] chatId is required to set active session'
        );
      });

      it('throws if payload is undefined (defaults to empty object)', async () => {
        await expect(handlers['session:set-active']({}, undefined)).rejects.toThrow(
          '[SessionIpcHandler] chatId is required to set active session'
        );
      });
    });

    // ------------------------------------------------------------------------
    // _handleNextId
    // ------------------------------------------------------------------------

    describe('session:next-id', () => {
      it('generates user_message id', async () => {
        const result = await handlers['session:next-id']({}, { kind: 'user_message', chatId: 'chat-1' });
        expect(mockSessionManager.setActiveChat).toHaveBeenCalledWith('chat-1');
        expect(mockSessionManager.nextUserMessageId).toHaveBeenCalled();
        expect(result).toEqual({
          id: 'user-msg-001',
          kind: 'user_message',
          chatId: 'chat-abc',
        });
      });

      it('generates assistant_message id with parentId', async () => {
        const result = await handlers['session:next-id']({}, {
          kind: 'assistant_message',
          parentId: 'parent-1',
        });
        expect(mockSessionManager.nextAssistantMessageId).toHaveBeenCalledWith('parent-1');
        expect(result.id).toBe('asst-msg-001');
      });

      it('generates assistant_message id falling back to userMessageId when parentId missing', async () => {
        await handlers['session:next-id']({}, {
          kind: 'assistant_message',
          userMessageId: 'usr-msg-1',
        });
        expect(mockSessionManager.nextAssistantMessageId).toHaveBeenCalledWith('usr-msg-1');
      });

      it('generates assistant_message id with null when no parentId or userMessageId', async () => {
        await handlers['session:next-id']({}, { kind: 'assistant_message' });
        expect(mockSessionManager.nextAssistantMessageId).toHaveBeenCalledWith(null);
      });

      it('generates assistant_code id with parentId', async () => {
        const result = await handlers['session:next-id']({}, {
          kind: 'assistant_code',
          parentId: 'parent-1',
        });
        expect(mockSessionManager.nextCodeArtifactId).toHaveBeenCalledWith('parent-1');
        expect(result.id).toBe('code-art-001');
      });

      it('generates assistant_code id falling back to messageId', async () => {
        await handlers['session:next-id']({}, {
          kind: 'assistant_code',
          messageId: 'msg-1',
        });
        expect(mockSessionManager.nextCodeArtifactId).toHaveBeenCalledWith('msg-1');
      });

      it('generates assistant_output id with parentId', async () => {
        const result = await handlers['session:next-id']({}, {
          kind: 'assistant_output',
          parentId: 'parent-1',
        });
        expect(mockSessionManager.nextOutputArtifactId).toHaveBeenCalledWith('parent-1');
        expect(result.id).toBe('out-art-001');
      });

      it('generates assistant_output id falling back to codeId', async () => {
        await handlers['session:next-id']({}, {
          kind: 'assistant_output',
          codeId: 'code-1',
        });
        expect(mockSessionManager.nextOutputArtifactId).toHaveBeenCalledWith('code-1');
      });

      it('generates assistant_code id with null when no parentId or messageId', async () => {
        await handlers['session:next-id']({}, { kind: 'assistant_code' });
        expect(mockSessionManager.nextCodeArtifactId).toHaveBeenCalledWith(null);
      });

      it('generates assistant_output id falling back to null when no parentId or codeId', async () => {
        await handlers['session:next-id']({}, { kind: 'assistant_output' });
        expect(mockSessionManager.nextOutputArtifactId).toHaveBeenCalledWith(null);
      });

      it('generates assistant_html id with parentId', async () => {
        const result = await handlers['session:next-id']({}, {
          kind: 'assistant_html',
          parentId: 'parent-1',
        });
        expect(mockSessionManager.nextHtmlArtifactId).toHaveBeenCalledWith('parent-1');
        expect(result.id).toBe('html-art-001');
      });

      it('generates assistant_html id falling back to messageId', async () => {
        await handlers['session:next-id']({}, {
          kind: 'assistant_html',
          messageId: 'msg-1',
        });
        expect(mockSessionManager.nextHtmlArtifactId).toHaveBeenCalledWith('msg-1');
      });

      it('generates assistant_html id with null when no parentId or messageId', async () => {
        await handlers['session:next-id']({}, { kind: 'assistant_html' });
        expect(mockSessionManager.nextHtmlArtifactId).toHaveBeenCalledWith(null);
      });

      it('generates user_attachment id with parentId', async () => {
        const result = await handlers['session:next-id']({}, {
          kind: 'user_attachment',
          parentId: 'parent-1',
        });
        expect(mockSessionManager.nextAttachmentId).toHaveBeenCalledWith('parent-1');
        expect(result.id).toBe('attach-001');
      });

      it('generates user_attachment id falling back to messageId', async () => {
        await handlers['session:next-id']({}, {
          kind: 'user_attachment',
          messageId: 'msg-1',
        });
        expect(mockSessionManager.nextAttachmentId).toHaveBeenCalledWith('msg-1');
      });

      it('generates user_attachment id with null when no parentId or messageId', async () => {
        await handlers['session:next-id']({}, { kind: 'user_attachment' });
        expect(mockSessionManager.nextAttachmentId).toHaveBeenCalledWith(null);
      });

      it('does not set active chat if chatId is not provided', async () => {
        await handlers['session:next-id']({}, { kind: 'user_message' });
        expect(mockSessionManager.setActiveChat).not.toHaveBeenCalled();
      });

      it('does not set active chat if chatId is non-string', async () => {
        await handlers['session:next-id']({}, { kind: 'user_message', chatId: 123 });
        expect(mockSessionManager.setActiveChat).not.toHaveBeenCalled();
      });

      it('throws for unsupported kind', async () => {
        await expect(
          handlers['session:next-id']({}, { kind: 'bogus_kind' })
        ).rejects.toThrow('[SessionIpcHandler] Unsupported session id kind: bogus_kind');
        expect(mockChildLogger.error).toHaveBeenCalledWith(
          '[SessionIpcHandler] Unsupported session id kind: bogus_kind'
        );
      });

      it('throws for undefined kind', async () => {
        await expect(
          handlers['session:next-id']({}, {})
        ).rejects.toThrow('[SessionIpcHandler] Unsupported session id kind: undefined');
      });

      it('returns chatId from sessionManager.currentChatId', async () => {
        mockSessionManager.currentChatId = 'active-chat-999';
        const result = await handlers['session:next-id']({}, { kind: 'user_message' });
        expect(result.chatId).toBe('active-chat-999');
      });

      it('logs trace with generated id details', async () => {
        await handlers['session:next-id']({}, { kind: 'user_message' });
        expect(mockChildLogger.trace).toHaveBeenCalledWith('Session ID generated', {
          kind: 'user_message',
          chatId: 'chat-abc',
          id: 'user-msg-001',
        });
      });
    });

    // ------------------------------------------------------------------------
    // _handleParseId
    // ------------------------------------------------------------------------

    describe('session:parse-id', () => {
      it('parses valid id and returns result', async () => {
        const result = await handlers['session:parse-id']({}, { id: 'user-msg-001' });
        expect(mockParseSessionId).toHaveBeenCalledWith('user-msg-001');
        expect(result).toEqual({ type: 'user_message', chatId: 'chat-abc', seq: 1 });
      });

      it('throws if id is missing', async () => {
        await expect(handlers['session:parse-id']({}, {})).rejects.toThrow(
          '[SessionIpcHandler] id must be provided for parse'
        );
      });

      it('throws if id is null', async () => {
        await expect(handlers['session:parse-id']({}, { id: null })).rejects.toThrow(
          '[SessionIpcHandler] id must be provided for parse'
        );
      });

      it('throws if id is not a string', async () => {
        await expect(handlers['session:parse-id']({}, { id: 42 })).rejects.toThrow(
          '[SessionIpcHandler] id must be provided for parse'
        );
      });

      it('throws when payload is undefined (defaults to empty object)', async () => {
        await expect(handlers['session:parse-id']({}, undefined)).rejects.toThrow(
          '[SessionIpcHandler] id must be provided for parse'
        );
      });
    });

    // ------------------------------------------------------------------------
    // _handleGetStats
    // ------------------------------------------------------------------------

    describe('session:get-stats', () => {
      it('returns formatted stats with active chat id', async () => {
        const result = await handlers['session:get-stats']({});
        expect(result).toEqual({
          activeChatId: 'chat-abc',
          activeSessions: ['chat-abc'],
          stats: { totalIds: 10 },
          idTypes: mockIdTypes,
        });
      });

      it('returns null activeChatId when no active chat', async () => {
        mockSessionManager.currentChatId = null;
        const result = await handlers['session:get-stats']({});
        expect(result.activeChatId).toBeNull();
      });

      it('returns null activeChatId when currentChatId is undefined', async () => {
        mockSessionManager.currentChatId = undefined;
        const result = await handlers['session:get-stats']({});
        expect(result.activeChatId).toBeNull();
      });
    });

    // ------------------------------------------------------------------------
    // _handleClearSession
    // ------------------------------------------------------------------------

    describe('session:clear', () => {
      it('clears session and returns stats', async () => {
        const result = await handlers['session:clear']({}, { chatId: 'chat-xyz' });
        expect(mockSessionManager.clearSession).toHaveBeenCalledWith('chat-xyz');
        expect(mockChildLogger.info).toHaveBeenCalledWith('Cleared session via IPC', { chatId: 'chat-xyz' });
        expect(result).toHaveProperty('activeChatId');
        expect(result).toHaveProperty('activeSessions');
        expect(result).toHaveProperty('stats');
        expect(result).toHaveProperty('idTypes');
      });

      it('throws if chatId is missing', async () => {
        await expect(handlers['session:clear']({}, {})).rejects.toThrow(
          '[SessionIpcHandler] chatId is required to clear session'
        );
      });

      it('throws if chatId is not a string', async () => {
        await expect(handlers['session:clear']({}, { chatId: 42 })).rejects.toThrow(
          '[SessionIpcHandler] chatId is required to clear session'
        );
      });

      it('uses currentChatId for stats after clearing (may be different)', async () => {
        mockSessionManager.currentChatId = 'remaining-chat';
        const result = await handlers['session:clear']({}, { chatId: 'old-chat' });
        expect(result.activeChatId).toBe('remaining-chat');
      });

      it('returns null activeChatId when currentChatId is falsy after clearing', async () => {
        mockSessionManager.currentChatId = null;
        const result = await handlers['session:clear']({}, { chatId: 'old-chat' });
        expect(result.activeChatId).toBeNull();
      });

      it('throws when payload is undefined (defaults to empty object)', async () => {
        await expect(handlers['session:clear']({}, undefined)).rejects.toThrow(
          '[SessionIpcHandler] chatId is required to clear session'
        );
      });
    });

    // ------------------------------------------------------------------------
    // _handleClearAll
    // ------------------------------------------------------------------------

    describe('session:clear-all', () => {
      it('clears all sessions and returns stats', async () => {
        const result = await handlers['session:clear-all']({});
        expect(mockSessionManager.clearAll).toHaveBeenCalled();
        expect(mockChildLogger.warn).toHaveBeenCalledWith('All sessions cleared via IPC');
        expect(result).toEqual({
          activeChatId: null,
          activeSessions: ['chat-abc'],
          stats: { totalIds: 10 },
          idTypes: mockIdTypes,
        });
      });
    });
  });

  // --------------------------------------------------------------------------
  // _formatSessionStats
  // --------------------------------------------------------------------------

  describe('_formatSessionStats', () => {
    it('returns correctly shaped stats object', () => {
      const result = handler._formatSessionStats('chat-xyz');
      expect(result).toEqual({
        activeChatId: 'chat-xyz',
        activeSessions: ['chat-abc'],
        stats: { totalIds: 10 },
        idTypes: mockIdTypes,
      });
    });

    it('returns null activeChatId when passed null', () => {
      const result = handler._formatSessionStats(null);
      expect(result.activeChatId).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // getSessionHandler singleton
  // --------------------------------------------------------------------------

  describe('getSessionHandler', () => {
    it('returns a SessionIpcHandler instance', () => {
      const instance = getSessionHandler();
      expect(instance).toBeInstanceOf(SessionIpcHandler);
    });

    it('returns the same instance on repeated calls', () => {
      const a = getSessionHandler();
      const b = getSessionHandler();
      expect(a).toBe(b);
    });
  });

  // --------------------------------------------------------------------------
  // Module exports
  // --------------------------------------------------------------------------

  describe('module exports', () => {
    it('exports SessionIpcHandler class', () => {
      expect(typeof SessionIpcHandler).toBe('function');
    });

    it('exports getSessionHandler function', () => {
      expect(typeof getSessionHandler).toBe('function');
    });

    it('exports CHANNELS object', () => {
      expect(CHANNELS).toBeDefined();
      expect(typeof CHANNELS).toBe('object');
    });
  });
});
