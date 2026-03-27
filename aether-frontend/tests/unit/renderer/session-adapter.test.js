'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = {
  info: () => {},
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};
mockLog.child = () => mockLog;

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

jest.mock('../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: jest.fn(),
}));

const { getAether } = require('../../../src/renderer/shared/bridge/AetherBridge');
const session = require('../../../src/renderer/shared/adapters/session');

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SessionBridge adapter', () => {
  let mockBridge;

  beforeEach(() => {
    mockBridge = {
      setActiveChat: jest.fn().mockResolvedValue(undefined),
      nextUserMessageId: jest.fn().mockResolvedValue('msg-u-1'),
      nextAssistantMessageId: jest.fn().mockResolvedValue('msg-a-1'),
      nextCodeArtifactId: jest.fn().mockResolvedValue('art-c-1'),
      nextOutputArtifactId: jest.fn().mockResolvedValue('art-o-1'),
      nextHtmlArtifactId: jest.fn().mockResolvedValue('art-h-1'),
      nextAttachmentId: jest.fn().mockResolvedValue('att-1'),
      parseId: jest.fn().mockResolvedValue({ type: 'user', seq: 1 }),
      getStats: jest.fn().mockResolvedValue({ total: 10 }),
      clearChatSession: jest.fn().mockResolvedValue(undefined),
      clearAll: jest.fn().mockResolvedValue(undefined),
    };

    getAether.mockReturnValue({ session: mockBridge });
  });

  // =========================================================================
  // ensureBridge (tested indirectly through exported functions)
  // =========================================================================

  describe('ensureBridge', () => {
    it('throws when getAether returns null (no window.aether)', async () => {
      getAether.mockReturnValue(null);
      await expect(session.setActiveChat('chat-1'))
        .rejects.toThrow('[SessionBridge] Preload session API is unavailable');
    });

    it('throws when getAether returns object without session property', async () => {
      getAether.mockReturnValue({});
      await expect(session.nextUserMessageId())
        .rejects.toThrow('[SessionBridge] Preload session API is unavailable');
    });

    it('throws when getAether returns undefined', async () => {
      getAether.mockReturnValue(undefined);
      await expect(session.getStats())
        .rejects.toThrow('[SessionBridge] Preload session API is unavailable');
    });

    it('logs error message when bridge is unavailable', async () => {
      getAether.mockReturnValue(null);
      try { await session.clearAll(); } catch (_) { /* expected */ }
      expect(mockLog.error).toHaveBeenCalledWith(
        '[SessionBridge] Preload session API is unavailable. Ensure session bridge is exposed.'
      );
    });
  });

  // =========================================================================
  // setActiveChat
  // =========================================================================

  describe('setActiveChat', () => {
    it('delegates to bridge.setActiveChat with chatId', async () => {
      mockBridge.setActiveChat.mockResolvedValue('ok');
      const result = await session.setActiveChat('chat-42');
      expect(mockBridge.setActiveChat).toHaveBeenCalledWith('chat-42');
      expect(result).toBe('ok');
    });

    it('throws for empty string chatId', async () => {
      await expect(session.setActiveChat(''))
        .rejects.toThrow('[SessionBridge] chatId must be a non-empty string');
    });

    it('throws for null chatId', async () => {
      await expect(session.setActiveChat(null))
        .rejects.toThrow('[SessionBridge] chatId must be a non-empty string');
    });

    it('throws for undefined chatId', async () => {
      await expect(session.setActiveChat(undefined))
        .rejects.toThrow('[SessionBridge] chatId must be a non-empty string');
    });

    it('throws for numeric chatId', async () => {
      await expect(session.setActiveChat(123))
        .rejects.toThrow('[SessionBridge] chatId must be a non-empty string');
    });
  });

  // =========================================================================
  // nextUserMessageId
  // =========================================================================

  describe('nextUserMessageId', () => {
    it('delegates to bridge with chatId option', async () => {
      const result = await session.nextUserMessageId({ chatId: 'c-1' });
      expect(mockBridge.nextUserMessageId).toHaveBeenCalledWith({ chatId: 'c-1' });
      expect(result).toBe('msg-u-1');
    });

    it('works with no arguments (defaults to {})', async () => {
      const result = await session.nextUserMessageId();
      expect(mockBridge.nextUserMessageId).toHaveBeenCalledWith({ chatId: undefined });
      expect(result).toBe('msg-u-1');
    });
  });

  // =========================================================================
  // nextAssistantMessageId
  // =========================================================================

  describe('nextAssistantMessageId', () => {
    it('delegates to bridge with parentId and chatId', async () => {
      const result = await session.nextAssistantMessageId({ parentId: 'p-1', chatId: 'c-1' });
      expect(mockBridge.nextAssistantMessageId).toHaveBeenCalledWith({ parentId: 'p-1', chatId: 'c-1' });
      expect(result).toBe('msg-a-1');
    });

    it('works with no arguments', async () => {
      const result = await session.nextAssistantMessageId();
      expect(mockBridge.nextAssistantMessageId).toHaveBeenCalledWith({
        parentId: undefined,
        chatId: undefined,
      });
      expect(result).toBe('msg-a-1');
    });
  });

  // =========================================================================
  // nextCodeArtifactId
  // =========================================================================

  describe('nextCodeArtifactId', () => {
    it('delegates to bridge with parentId and chatId', async () => {
      const result = await session.nextCodeArtifactId({ parentId: 'p-2', chatId: 'c-2' });
      expect(mockBridge.nextCodeArtifactId).toHaveBeenCalledWith({ parentId: 'p-2', chatId: 'c-2' });
      expect(result).toBe('art-c-1');
    });

    it('works with no arguments (default parameter)', async () => {
      await session.nextCodeArtifactId();
      expect(mockBridge.nextCodeArtifactId).toHaveBeenCalledWith({
        parentId: undefined,
        chatId: undefined,
      });
    });
  });

  // =========================================================================
  // nextOutputArtifactId
  // =========================================================================

  describe('nextOutputArtifactId', () => {
    it('delegates to bridge with parentId and chatId', async () => {
      const result = await session.nextOutputArtifactId({ parentId: 'p-3', chatId: 'c-3' });
      expect(mockBridge.nextOutputArtifactId).toHaveBeenCalledWith({ parentId: 'p-3', chatId: 'c-3' });
      expect(result).toBe('art-o-1');
    });

    it('works with no arguments (default parameter)', async () => {
      await session.nextOutputArtifactId();
      expect(mockBridge.nextOutputArtifactId).toHaveBeenCalledWith({
        parentId: undefined,
        chatId: undefined,
      });
    });
  });

  // =========================================================================
  // nextHtmlArtifactId
  // =========================================================================

  describe('nextHtmlArtifactId', () => {
    it('delegates to bridge with parentId and chatId', async () => {
      const result = await session.nextHtmlArtifactId({ parentId: 'p-4', chatId: 'c-4' });
      expect(mockBridge.nextHtmlArtifactId).toHaveBeenCalledWith({ parentId: 'p-4', chatId: 'c-4' });
      expect(result).toBe('art-h-1');
    });

    it('works with no arguments (default parameter)', async () => {
      await session.nextHtmlArtifactId();
      expect(mockBridge.nextHtmlArtifactId).toHaveBeenCalledWith({
        parentId: undefined,
        chatId: undefined,
      });
    });
  });

  // =========================================================================
  // nextAttachmentId
  // =========================================================================

  describe('nextAttachmentId', () => {
    it('delegates to bridge with parentId and chatId', async () => {
      const result = await session.nextAttachmentId({ parentId: 'p-5', chatId: 'c-5' });
      expect(mockBridge.nextAttachmentId).toHaveBeenCalledWith({ parentId: 'p-5', chatId: 'c-5' });
      expect(result).toBe('att-1');
    });

    it('works with no arguments (default parameter)', async () => {
      await session.nextAttachmentId();
      expect(mockBridge.nextAttachmentId).toHaveBeenCalledWith({
        parentId: undefined,
        chatId: undefined,
      });
    });
  });

  // =========================================================================
  // parseId
  // =========================================================================

  describe('parseId', () => {
    it('delegates to bridge.parseId with valid id', async () => {
      const result = await session.parseId('msg-u-1');
      expect(mockBridge.parseId).toHaveBeenCalledWith('msg-u-1');
      expect(result).toEqual({ type: 'user', seq: 1 });
    });

    it('throws for empty string id', async () => {
      await expect(session.parseId(''))
        .rejects.toThrow('[SessionBridge] id must be a non-empty string');
    });

    it('throws for null id', async () => {
      await expect(session.parseId(null))
        .rejects.toThrow('[SessionBridge] id must be a non-empty string');
    });

    it('throws for numeric id', async () => {
      await expect(session.parseId(42))
        .rejects.toThrow('[SessionBridge] id must be a non-empty string');
    });
  });

  // =========================================================================
  // getStats
  // =========================================================================

  describe('getStats', () => {
    it('delegates to bridge.getStats and returns result', async () => {
      const result = await session.getStats();
      expect(mockBridge.getStats).toHaveBeenCalled();
      expect(result).toEqual({ total: 10 });
    });
  });

  // =========================================================================
  // clearChatSession
  // =========================================================================

  describe('clearChatSession', () => {
    it('delegates to bridge.clearChatSession with chatId', async () => {
      await session.clearChatSession('chat-99');
      expect(mockBridge.clearChatSession).toHaveBeenCalledWith('chat-99');
    });

    it('throws for empty string chatId', async () => {
      await expect(session.clearChatSession(''))
        .rejects.toThrow('[SessionBridge] chatId must be provided to clear session');
    });

    it('throws for null chatId', async () => {
      await expect(session.clearChatSession(null))
        .rejects.toThrow('[SessionBridge] chatId must be provided to clear session');
    });

    it('throws for non-string chatId', async () => {
      await expect(session.clearChatSession(100))
        .rejects.toThrow('[SessionBridge] chatId must be provided to clear session');
    });
  });

  // =========================================================================
  // clearAll
  // =========================================================================

  describe('clearAll', () => {
    it('delegates to bridge.clearAll and returns result', async () => {
      mockBridge.clearAll.mockResolvedValue('cleared');
      const result = await session.clearAll();
      expect(mockBridge.clearAll).toHaveBeenCalled();
      expect(result).toBe('cleared');
    });
  });
});
